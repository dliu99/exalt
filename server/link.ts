// Importing a book by link: someone pastes the address of an EPUB, PDF or TXT and the server
// downloads it, with safeguards: HTTPS only, a 50 MiB cap,
// timeouts, and a check that the bytes are a book file. It must not become a way to reach the
// server's own network, so every hop's host is resolved first and refused unless all of its
// addresses are public (no private, loopback, link-local, shared or reserved ones). The
// connection then goes to the address that was checked, not to a second lookup, so a name can't
// answer a public address to the check and a private one to the download. Redirects are
// followed by hand, each checked the same way.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { MAX_BOOK_BYTES } from './limits.ts';

const UA = 'Mozilla/5.0 (compatible; Exalt/0.1)';
const MAX_REDIRECTS = 5;
/** Refused for what the link is (its scheme, its host, what it answers): a 400. */
export class LinkRefused extends Error {}

type Resolve = (host: string) => Promise<string[]>;
const resolveHost: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function v4(ip: string): number[] | null {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}
// An IPv6 address as its eight 16-bit groups (an embedded IPv4 tail taken as two).
function v6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const q = v4(tail[1]);
    if (!q) return null;
    s = s.slice(0, -tail[1].length) + `${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const [head, rest] = s.split('::');
  if (s.split('::').length > 2) return null;
  const a = head ? head.split(':') : [], b = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const missing = 8 - a.length - b.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...a, ...Array(rest === undefined ? 0 : missing).fill('0'), ...b].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

/** Whether an address is on the public internet: not private, loopback, link-local, shared, multicast or reserved. */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = v4(ip)!;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 // this network, private, loopback, multicast and reserved
      || (a === 100 && b >= 64 && b <= 127) // shared (carrier-grade NAT)
      || (a === 169 && b === 254) // link-local, where cloud metadata lives
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) // private
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) // protocol assignments, documentation, 6to4 relay
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)); // benchmarking, documentation
  }
  const g = isIP(ip) === 6 ? v6(ip) : null;
  if (!g) return false;
  // An IPv4 address carried in IPv6 (mapped, compatible or NAT64) is judged as itself.
  const embedded = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 && g[6] === 0 ? false : isPublicAddress(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicAddress(embedded);
  // Only global unicast (2000::/3), less Teredo and other IETF assignments (2001::/23), documentation (2001:db8::/32) and 6to4 (2002::/16).
  if ((g[0] & 0xe000) !== 0x2000) return false;
  return !((g[0] === 0x2001 && g[1] < 0x200) || (g[0] === 0x2001 && g[1] === 0xdb8) || g[0] === 0x2002);
}

/** A pasted link as the address to download, or why it can't be. */
export function linkURL(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new LinkRefused('Paste the whole link, starting with https://.'); }
  if (url.protocol !== 'https:') throw new LinkRefused('Only https:// links can be imported.');
  if (url.username || url.password) throw new LinkRefused('Links with a user name or password can’t be imported.');
  if (url.port && url.port !== '443') throw new LinkRefused('Links on another port than HTTPS’s can’t be imported.');
  url.hash = '';
  return url;
}

/** The addresses a link's host has, checked: every one must be public. */
export async function checkedAddresses(url: URL, resolve: Resolve = resolveHost): Promise<string[]> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try { addresses = await resolve(host); } catch { throw new LinkRefused(`${host} couldn’t be found.`); }
  }
  if (!addresses.length) throw new LinkRefused(`${host} couldn’t be found.`);
  if (!addresses.every(isPublicAddress)) throw new LinkRefused('That link leads to a private or local address, so it can’t be imported.');
  return addresses;
}

// What the bytes are, by their first ones: a PDF, an EPUB (a ZIP), or plain text. A web page is not a book file.
function kindOf(bytes: Uint8Array, type: string): 'pdf' | 'epub' | 'txt' | null {
  const head = new TextDecoder().decode(bytes.subarray(0, 512));
  if (head.startsWith('%PDF-')) return 'pdf';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'epub';
  if (/^\s*<(!doctype|html|\?xml|head|body)/i.test(head) || /html|xml|json|javascript/.test(type)) return null;
  // Text has no NUL bytes; images, archives and other binaries do, early on.
  return bytes.subarray(0, 8192).includes(0) ? null : 'txt';
}
// The file's name: the link's last path segment (or a server's filename), with the extension of what it is.
function nameOf(url: URL, disposition: string, kind: string) {
  const given = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  let base = given ? decodeURIComponent(given) : decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
  base = base.replace(/\.(epub|pdf|txt|text)$/i, '').replace(/[/\\\x00-\x1f]/g, '_').trim().slice(0, 150) || url.hostname;
  return `${base}.${kind}`;
}

type Options = { resolve?: Resolve; fetch?: typeof fetch; timeoutMs?: number };

/** Downloads the book file at a pasted link. */
export async function fetchLink(raw: string, options: Options = {}): Promise<{ name: string; bytes: Uint8Array }> {
  const request = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 90000);
  let url = linkURL(raw);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const [address] = await checkedAddresses(url, options.resolve);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      // To the checked address; the name still goes in Host and TLS's server name, and the certificate must be for it.
      const pinned = new URL(url);
      pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
      const res = await request(pinned, { redirect: 'manual', signal, headers: { host: url.host, 'user-agent': UA, accept: 'application/epub+zip, application/pdf, text/plain;q=0.9, */*;q=0.1' },
        ...(isIP(host) ? {} : { tls: { serverName: host, checkServerIdentity: (_: string, cert: any) => checkServerIdentity(host, cert) } }) } as RequestInit);
      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
        await res.body?.cancel();
        url = linkURL(new URL(res.headers.get('location')!, url).href);
        continue;
      }
      if (!res.ok || !res.body) { await res.body?.cancel(); throw new LinkRefused(`That link answered ${res.status}, not a book file.`); }
      if (Number(res.headers.get('content-length')) > MAX_BOOK_BYTES) { await res.body.cancel(); throw new LinkRefused('Book files must be under 50 MB.'); }
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = res.body.getReader();
      // The time limit holds while reading too, whatever the body's own stream does.
      const late = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      late.catch(() => {});
      try {
        for (;;) {
          const { value, done } = await Promise.race([reader.read(), late]);
          if (done) break;
          size += value.length;
          if (size > MAX_BOOK_BYTES) throw new LinkRefused('Book files must be under 50 MB.');
          chunks.push(value);
        }
      } catch (e) { await reader.cancel().catch(() => {}); throw e; }
      const bytes = new Uint8Array(size); let at = 0;
      for (const c of chunks) { bytes.set(c, at); at += c.length; }
      const kind = kindOf(bytes, res.headers.get('content-type') ?? '');
      if (!kind || !bytes.length) throw new LinkRefused('That link isn’t an EPUB, PDF or TXT file.');
      return { name: nameOf(url, res.headers.get('content-disposition') ?? '', kind), bytes };
    }
    throw new LinkRefused('That link redirected too many times.');
  } catch (e) {
    if (e instanceof LinkRefused) throw e;
    if (signal.aborted) throw new LinkRefused('The book took too long to download.');
    throw new LinkRefused('That link couldn’t be reached.');
  }
}
