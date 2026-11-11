// Importing by link (link.ts): only public HTTPS hosts, checked at every redirect and connected
// to by the address checked; a 50 MiB cap and a check that it is a book file. Then the route,
// against the offline server, which imports only its sample link.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchLink, isPublicAddress, linkURL } from './link.ts';

test('only public addresses pass', () => {
  for (const ip of ['93.184.215.14', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808'])
    expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
  for (const ip of ['127.0.0.1', '127.8.9.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.254',
    '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9',
    '::1', '::', 'fe80::1', 'fe80::1%en0', 'fc00::1', 'fd12:3456:789a::1', 'ff02::1', 'fec0::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254',
    '::127.0.0.1', '64:ff9b::a00:5', '2001:db8::1', '2001::1', '2002:c0a8:101::1', '100::1', 'not-an-ip', '1.2.3', '1:2:3']) expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
});

test('a link must be https, with no credentials or other port', () => {
  expect(linkURL(' https://books.example/a.epub#x ').href).toBe('https://books.example/a.epub');
  for (const [raw, error] of [['http://books.example/a.epub', 'Only https://'], ['ftp://books.example/a', 'Only https://'], ['file:///etc/passwd', 'Only https://'],
    ['books.example/a.epub', 'Paste the whole link'], ['https://me:pw@books.example/a.epub', 'user name'], ['https://books.example:8443/a.epub', 'another port']])
    expect(() => linkURL(raw)).toThrow(error);
});

// A host table and a recording fetch in place of DNS and the network.
function world(hosts: Record<string, string[]>, answer: (url: URL, host: string) => Response) {
  const asked: { url: string; host: string; serverName?: string }[] = [];
  const resolve = async (h: string) => { if (!hosts[h]) throw new Error('ENOTFOUND'); return hosts[h]; };
  const fetch = (async (input: URL, init: RequestInit & { tls?: { serverName?: string } }) => {
    const host = (init.headers as Record<string, string>).host;
    asked.push({ url: String(input), host, serverName: init.tls?.serverName });
    return answer(new URL(String(input)), host);
  }) as unknown as typeof globalThis.fetch;
  return { asked, options: { resolve, fetch } };
}
const epub = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

test('a book file downloads from the address its name was checked at', async () => {
  const w = world({ 'books.example': ['93.184.215.14'], 'cdn.example': ['2606:4700::1'] }, (url, host) =>
    host === 'books.example' ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/files/Moby%20Dick.epub?sig=1' } })
      : new Response(epub, { headers: { 'content-type': 'application/epub+zip' } }));
  const file = await fetchLink('https://books.example/get/42', w.options);
  expect(file).toEqual({ name: 'Moby Dick.epub', bytes: epub });
  // Each hop goes to the checked address, the name in Host and as TLS's server name.
  expect(w.asked).toEqual([
    { url: 'https://93.184.215.14/get/42', host: 'books.example', serverName: 'books.example' },
    { url: 'https://[2606:4700::1]/files/Moby%20Dick.epub?sig=1', host: 'cdn.example', serverName: 'cdn.example' }]);
  // What it is decides its extension, whatever the link says; a server's filename is used.
  const pdf = world({ 'books.example': ['93.184.215.14'] }, () => new Response('%PDF-1.7 ...', { headers: { 'content-disposition': 'attachment; filename="Walden.pdf"' } }));
  expect((await fetchLink('https://books.example/download?id=7', pdf.options)).name).toBe('Walden.pdf');
  const txt = world({ 'books.example': ['93.184.215.14'] }, () => new Response('Chapter 1\nIt was a bright cold day.'));
  expect((await fetchLink('https://books.example/walden.epub', txt.options)).name).toBe('walden.txt');
});

test('private and local hosts are refused, before and after redirects', async () => {
  const hosts = { 'books.example': ['93.184.215.14'], 'inside.example': ['10.0.0.5'], 'mixed.example': ['93.184.215.14', '127.0.0.1'], 'meta.example': ['169.254.169.254'] };
  for (const link of ['https://127.0.0.1/a.epub', 'https://[::1]/a.epub', 'https://10.1.2.3/a.pdf', 'https://169.254.169.254/latest/meta-data/', 'https://inside.example/a.epub',
    'https://mixed.example/a.epub', 'https://[::ffff:127.0.0.1]/a.epub', 'https://0x7f000001/a.epub', 'https://2130706433/a.epub']) {
    const w = world(hosts, () => new Response(epub));
    await expect(fetchLink(link, w.options)).rejects.toThrow('private or local address');
    expect(w.asked).toEqual([]);
  }
  // A public host that redirects inside is refused at the redirect, before it is followed.
  for (const location of ['https://inside.example/a.epub', 'https://127.0.0.1/a.epub', 'https://meta.example/', 'http://books.example/a.epub']) {
    const w = world(hosts, (url) => (url.pathname === '/start' ? new Response(null, { status: 301, headers: { location } }) : new Response(epub)));
    await expect(fetchLink('https://books.example/start', w.options)).rejects.toThrow(location.startsWith('http:') ? 'Only https://' : 'private or local address');
    expect(w.asked.map((a) => a.host)).toEqual(['books.example']);
  }
  const unknown = world(hosts, () => new Response(epub));
  await expect(fetchLink('https://nowhere.example/a.epub', unknown.options)).rejects.toThrow('couldn’t be found');
});

test('what isn’t a book file under 50 MB is refused', async () => {
  const hosts = { 'books.example': ['93.184.215.14'] };
  const refuse = async (answer: () => Response, error: string) => {
    await expect(fetchLink('https://books.example/a', world(hosts, answer).options)).rejects.toThrow(error);
  };
  await refuse(() => new Response('<!doctype html><title>Sign in</title>', { headers: { 'content-type': 'text/html' } }), 'isn’t an EPUB, PDF or TXT');
  await refuse(() => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }), 'isn’t an EPUB, PDF or TXT');
  await refuse(() => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), 'isn’t an EPUB, PDF or TXT');
  await refuse(() => new Response(''), 'isn’t an EPUB, PDF or TXT');
  await refuse(() => new Response('gone', { status: 404 }), 'answered 404');
  await refuse(() => new Response(epub, { headers: { 'content-length': String(51 * 1024 * 1024) } }), 'under 50 MB');
  // A body larger than it said is cut off at the cap.
  await refuse(() => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(4 * 1024 * 1024)); } })), 'under 50 MB');
  await refuse(() => new Response(null, { status: 302, headers: { location: '/a' } }), 'redirected too many times');
  // A download that doesn't finish in time.
  await expect(fetchLink('https://books.example/a', { ...world(hosts, () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }))).options, timeoutMs: 100 }))
    .rejects.toThrow('took too long');
});

test('the route checks a link before reserving anything, and imports the offline sample', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-link-'));
  const child = Bun.spawn([process.execPath, 'server/index.ts', '--offline'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DB: join(dir, 'db.sqlite'), AUDIO_DIR: join(dir, 'audio'), AUDIO_S3_BUCKET: '', SIGN_IN_TEST_KEYS: '' },
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read(); reader.releaseLock();
    const address = new TextDecoder().decode(value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    const make = (link: string, extra = '') => fetch(`${address}/books/OL2W/generations?model=exalt%2Fsilence&rights=1&link=${encodeURIComponent(link)}${extra}`, { method: 'POST', headers: { authorization: 'Bearer ada' } });
    for (const [link, error] of [['http://books.example/a.txt', 'Only https://'], ['https://127.0.0.1/a.epub', 'private or local'], ['https://localhost/a.epub', 'private or local'],
      ['https://[::1]:443/a.pdf', 'private or local'], ['https://169.254.169.254/latest/meta-data/', 'private or local'],
      ['https://books.example/other.epub', 'only its sample link']]) {
      const res = await make(link);
      expect([link, res.status]).toEqual([link, 400]);
      expect((await res.json()).error).toContain(error);
    }
    expect((await make('https://books.example/a-quiet-harbour.txt', '&source=lg-00000000000000000000000000000001')).status).toBe(400);
    // Refused links leave nothing behind.
    const db = new Database(join(dir, 'db.sqlite'));
    expect(db.query('SELECT COUNT(*) AS n FROM generations').get()).toEqual({ n: 0 });
    const made = await make('https://books.example/a-quiet-harbour.txt');
    expect(made.status).toBe(202);
    const { id } = await made.json() as { id: string };
    let g: { status: string; active: number; chapters: { title: string; status: string }[] } | undefined;
    for (let i = 0; i < 200 && !(g?.status === 'ready' && g.active === 0); i++) { await Bun.sleep(20); g = await fetch(`${address}/generations/${id}`).then((r) => r.json()); }
    expect(g!.chapters.map((c) => [c.title, c.status])).toEqual([['Chapter One: The Harbour', 'ready'], ['Chapter Two: The River', 'idle'], ['Chapter Three: The Sea', 'idle']]);
    // The link itself isn't kept: only its hash, which finds this audiobook again.
    const row = db.query('SELECT source_name, source_ref FROM generations WHERE id = ?').get(id) as { source_name: string; source_ref: string };
    expect(row.source_name).toBe('A Quiet Harbour.txt');
    expect(row.source_ref).toMatch(/^link:[0-9a-f]{32}$/);
    const again = await make('https://books.example/a-quiet-harbour.txt');
    expect([again.status, (await again.json()).id]).toEqual([200, id]);
    db.close();
  } finally { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); }
}, 15000);
