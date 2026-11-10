// LibGen.li: HTML discovery, JSON edition/file lookup, ads.php download resolution.
// The file MD5 is the stable identity; no account or session cookie is needed.
import { MAX_BOOK_BYTES } from './limits.ts';
import { createHash } from 'node:crypto';
export type SourceBook = { id: string; title: string; author: string; year: number; cover: string; description: string;
  extension: string; language: string; size: string };
const MAX_BYTES = MAX_BOOK_BYTES;
const UA = 'Mozilla/5.0 (compatible; Exalt/0.1)';
const tidy = (s: unknown) => String(s ?? '').replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, n) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[n]!))
  .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => { const c = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return c <= 0x10ffff ? String.fromCodePoint(c) : ''; })
  .replace(/\s+/g, ' ').trim();
const hashOf = (id: string) => {
  const m = /^lg-([a-f0-9]{32})$/.exec(id);
  if (!m) throw new Error('Invalid LibGen file.');
  return m[1];
};
export function parseSearch(html: string): SourceBook[] {
  const out: SourceBook[] = [];
  let captureTitle = false;
  let row: { cells: string[]; title: string; md5: string } | null = null, col = -1;
  new HTMLRewriter().on('tr', { element(e) {
    row = { cells: [], title: '', md5: '' }; col = -1; captureTitle = false;
    e.onEndTag(() => {
      if (!row || row.cells.length < 9 || !row.title || !/^[a-f0-9]{32}$/.test(row.md5)) return;
      const ext = tidy(row.cells[7]).toLowerCase();
      if (!['epub', 'pdf'].includes(ext)) return;
      out.push({ id: `lg-${row.md5}`, title: tidy(row.title), author: tidy(row.cells[1]), year: Number(tidy(row.cells[3]).match(/\d{4}/)?.[0]) || 0,
        cover: '', description: '', extension: ext, language: tidy(row.cells[4]), size: tidy(row.cells[6]) });
    });
  } }).on('td', { element() { if (row) { col++; row.cells[col] = ''; } }, text(t) { if (row && col >= 0) row.cells[col] += t.text; } })
    .on('td:first-child a[href*="edition.php"]', { element(e) { captureTitle = !!row && !row.title; e.onEndTag(() => { captureTitle = false; }); }, text(t) { if (row && captureTitle) row.title += t.text; } })
    .on('a[href*="ads.php"]', { element(e) { const md5 = e.getAttribute('href')?.match(/[?&]md5=([a-f0-9]{32})/i)?.[1]; if (row && md5) row.md5 = md5.toLowerCase(); } })
    .transform(html);
  return [...new Map(out.map((b) => [b.id, b])).values()];
}

export function libgen(options: { enabled?: boolean; base?: string; mirrors?: string[]; downloadOrigins?: string[]; fetch?: typeof fetch } = {}) {
  const enabled = options.enabled ?? process.env.LIBGEN_ENABLED !== '0';
  const bases = options.mirrors ?? (options.base ? [options.base] : (process.env.LIBGEN_MIRRORS ?? process.env.LIBGEN_BASE_URL ?? 'https://libgen.li,https://libgen.bz').split(','));
  const origins = bases.map((s) => {
    const u = new URL(s.trim());
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('LibGen mirrors must be HTTPS origins.');
    return u.origin;
  });
  const extras = options.downloadOrigins ?? (process.env.LIBGEN_DOWNLOAD_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const request = options.fetch ?? fetch;
  const recent = new Map<string, { at: number; books: SourceBook[] }>();
  const pending = new Map<string, Promise<SourceBook[]>>();
  let activeSearches = 0;
  const allowed = (url: URL) => !url.username && !url.password && url.protocol === 'https:' &&
    ((!url.port && /^cdn[0-9]+\.booksdl\.lc$/.test(url.hostname)) || extras.includes(url.origin) || origins.some((s) => { const u = new URL(s); return url.origin === u.origin || (url.port === u.port && url.hostname.endsWith(`.${u.hostname}`)); }));
  async function get(base: string, path: string): Promise<Response> {
    const res = await request(`${base}${path}`, { headers: { 'user-agent': UA }, redirect: 'error', signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`LibGen answered ${res.status}.`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('LibGen returned an empty page.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > 3 * 1024 * 1024) throw new Error('LibGen metadata exceeded the response limit.'); chunks.push(value); }
    } catch (e) { await reader.cancel(); throw e; }
    return new Response(new Blob(chunks), { headers: res.headers });
  }
  async function details(base: string, id: string): Promise<SourceBook> {
    const md5 = hashOf(id);
    const files = await (await get(base, `/json.php?object=f&md5=${md5}&addkeys=*`)).json() as Record<string, any>;
    const file = Object.values(files).find((f: any) => String(f.md5).toLowerCase() === md5);
    if (!file || !['epub', 'pdf'].includes(String(file.extension).toLowerCase())) throw new Error('LibGen has no EPUB or PDF for this file.');
    if (Number(file.filesize) > MAX_BYTES) throw new Error('Book files must be under 50 MB.');
    const eid = Object.values(file.editions ?? {}).map((e: any) => String(e.e_id)).find((e) => /^\d+$/.test(e));
    if (!eid) throw new Error('LibGen has no edition metadata for this file.');
    const editions = await (await get(base, `/json.php?object=e&ids=${eid}&addkeys=*`)).json() as Record<string, any>;
    const e = editions[eid];
    if (!e?.title) throw new Error('LibGen has no title for this edition.');
    return { id, title: tidy(e.title), author: tidy(e.author), year: Number(e.year) || 0, cover: '', description: '', extension: String(file.extension).toLowerCase(),
      language: tidy(Object.values(e.add ?? {}).find((a: any) => a.name_en === 'Language')?.value), size: `${(Number(file.filesize) / 1024 / 1024).toFixed(1)} MB` };
  }
  async function fallback<T>(fn: (base: string) => Promise<T>): Promise<T> {
    let error: unknown;
    for (const base of origins) { try { return await fn(base); } catch (e) { error = e; } }
    throw error ?? new Error('No LibGen mirror is configured.');
  }
  return {
    enabled,
    async search(q: string): Promise<SourceBook[]> {
      if (!enabled || !q.trim()) return [];
      const key = q.trim().toLowerCase().replace(/\s+/g, ' '), hit = recent.get(key);
      if (hit && Date.now() - hit.at < 600000) return hit.books;
      if (pending.has(key)) return pending.get(key)!;
      if (activeSearches >= 4) throw new Error('Book search is busy. Try again shortly.');
      const task = (async () => {
        activeSearches++;
        try {
          const books = await fallback(async (base) => {
            const html = await (await get(base, `/index.php?req=${encodeURIComponent(q.trim())}&res=25`)).text();
            if (!/id=["']tablelibgen/i.test(html)) throw new Error('LibGen search is unavailable.');
            return parseSearch(html);
          });
          recent.set(key, { at: Date.now(), books });
          if (recent.size > 200) recent.delete(recent.keys().next().value!);
          return books;
        } finally { activeSearches--; }
      })();
      pending.set(key, task);
      try { return await task; } finally { pending.delete(key); }
    },
    async book(id: string) { hashOf(id); return fallback((base) => details(base, id)); },
    async download(id: string): Promise<{ name: string; bytes: Uint8Array }> {
      const md5 = hashOf(id);
      // Resolve metadata and landing page on the same mirror. Never cache ephemeral keys.
      return fallback(async (base) => {
        const book = await details(base, id);
        const html = await (await get(base, `/ads.php?md5=${md5}`)).text();
        let link = '';
        new HTMLRewriter().on('a[href]', { element(e) { const href = tidy(e.getAttribute('href')); if (/(?:^|\/)get\.php\?/.test(href) && !link) link = href; } }).transform(html);
        if (!link) throw new Error('LibGen has no download link for this file.');
        let url = new URL(link, base);
        const signal = AbortSignal.timeout(90000);
        for (let i = 0; i < 6; i++) {
          if (!allowed(url)) throw new Error('LibGen returned an untrusted download host.');
          const res = await request(url, { redirect: 'manual', signal, headers: { 'user-agent': UA, referer: `${base}/ads.php?md5=${md5}` } });
          if (res.status >= 300 && res.status < 400 && res.headers.has('location')) { await res.body?.cancel(); url = new URL(res.headers.get('location')!, url); continue; }
          if (!res.ok || !res.body) throw new Error(`This LibGen copy is unavailable (${res.status}). Choose another file or upload your own.`);
          if (Number(res.headers.get('content-length')) > MAX_BYTES) { await res.body.cancel(); throw new Error('Book files must be under 50 MB.'); }
          const chunks: Uint8Array[] = []; let size = 0;
          const reader = res.body.getReader();
          try {
            for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length;
              if (size > MAX_BYTES) throw new Error('Book files must be under 50 MB.'); chunks.push(value); }
          } catch (e) { await reader.cancel(); throw e; }
          const bytes = new Uint8Array(size); let at = 0;
          for (const c of chunks) { bytes.set(c, at); at += c.length; }
          if (createHash('md5').update(bytes).digest('hex') !== md5) throw new Error('LibGen download was incomplete or did not match the selected file.');
          const valid = book.extension === 'pdf' ? new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-' : bytes[0] === 0x50 && bytes[1] === 0x4b;
          if (!valid) throw new Error('LibGen did not return a readable book file.');
          return { name: `${book.title.replace(/[\/\\\x00-\x1f]/g, '_').slice(0, 150)}.${book.extension}`, bytes };
        }
        throw new Error('LibGen download redirected too many times.');
      });
    },
  };
}
export const lg = libgen();
