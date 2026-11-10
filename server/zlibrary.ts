// Optional Z-Library EAPI client. Session cookies and file URLs stay on the server.
// Protocol reference: https://github.com/ZlibraryKO/zlibrary.koplugin
import { MAX_BOOK_BYTES } from './limits.ts';
export type ZBook = {
  id: string; title: string; author: string; year: number; cover: string;
  description: string; extension: string; language: string; size: string;
};
type RawBook = Record<string, unknown>;
type Envelope = { success?: number | boolean; books?: RawBook[]; book?: RawBook; file?: { downloadLink?: string; extension?: string; allowDownload?: boolean } };
const MAX_BYTES = MAX_BOOK_BYTES;
const ref = (id: string) => {
  const match = /^zl-(\d+)-([a-zA-Z0-9]+)$/.exec(id);
  if (!match) throw new Error('Invalid Z-Library file.');
  return `${match[1]}/${match[2]}`;
};
const normalize = (b: RawBook): ZBook | null => {
  const id = `zl-${b.id}-${b.hash}`, extension = String(b.extension ?? '').toLowerCase();
  if (!/^zl-\d+-[a-zA-Z0-9]+$/.test(id) || !b.title || !['epub', 'pdf'].includes(extension)) return null;
  return { id, title: String(b.title), author: String(b.author ?? ''), year: Number(b.year) || 0,
    cover: String(b.cover ?? ''), description: String(b.description ?? '').replace(/<[^>]+>/g, ''),
    extension, language: String(b.language ?? ''), size: String(b.filesizeString ?? '') };
};

export function zlibrary(options: { base?: string; userId?: string; userKey?: string; downloadOrigins?: string; fetch?: typeof fetch } = {}) {
  const base = options.base ?? process.env.ZLIBRARY_BASE_URL ?? '';
  const userId = options.userId ?? process.env.ZLIBRARY_USER_ID ?? '';
  const userKey = options.userKey ?? process.env.ZLIBRARY_USER_KEY ?? '';
  const request = options.fetch ?? fetch;
  const configured = !!(base && userId && userKey);
  const origin = () => {
    const u = new URL(base);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('ZLIBRARY_BASE_URL must be an HTTPS origin.');
    return u.origin;
  };
  const headers = () => ({ 'user-agent': 'Exalt/0.1', 'remix-userid': userId, 'remix-userkey': userKey,
    cookie: `remix_userid=${encodeURIComponent(userId)}; remix_userkey=${encodeURIComponent(userKey)}` });
  async function api(path: string, body?: URLSearchParams): Promise<Envelope> {
    if (!configured) throw new Error('Z-Library is not connected on this server.');
    const res = await request(`${origin()}/eapi/book/${path}`, { method: body ? 'POST' : 'GET',
      headers: headers(), body, signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!res.ok) throw new Error(`Z-Library answered ${res.status}. Check its connection and download allowance.`);
    const result = await res.json() as Envelope;
    if (!result.success) throw new Error('Z-Library refused the request. Check its session and download allowance.');
    return result;
  }
  return {
    configured,
    async search(q: string): Promise<ZBook[]> {
      if (!configured || !q.trim()) return [];
      const body = new URLSearchParams({ message: q.trim(), limit: '30', page: '1', order: 'bestmatch' });
      body.append('extensions[]', 'epub'); body.append('extensions[]', 'pdf');
      return ((await api('search', body)).books ?? []).flatMap((b) => normalize(b) ?? []);
    },
    async book(id: string): Promise<ZBook | null> {
      const b = (await api(ref(id))).book;
      return b ? normalize(b) : null;
    },
    async download(id: string): Promise<{ name: string; bytes: Uint8Array }> {
      const path = ref(id);
      const b = (await api(path)).book;
      const book = b && normalize(b);
      if (!book) throw new Error('This Z-Library file is not an EPUB or PDF.');
      const file = (await api(`${path}/file`)).file;
      if (!file?.downloadLink || file.allowDownload === false) throw new Error('Z-Library has no download available. Check your download allowance.');
      const allowed = new Set([origin(), ...(options.downloadOrigins ?? process.env.ZLIBRARY_DOWNLOAD_ORIGINS ?? '').split(',').filter(Boolean).map((s) => new URL(s.trim()).origin)]);
      let url = new URL(file.downloadLink, origin());
      const signal = AbortSignal.timeout(90000);
      for (let i = 0; i < 6; i++) {
        if (url.protocol !== 'https:' || url.username || url.password || !allowed.has(url.origin)) throw new Error('Z-Library download uses an unconfigured origin. Set ZLIBRARY_DOWNLOAD_ORIGINS on the server.');
        const res = await request(url, { headers: url.origin === origin() ? headers() : {}, redirect: 'manual', signal });
        if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
          await res.body?.cancel();
          url = new URL(res.headers.get('location')!, url); continue;
        }
        if (!res.ok) throw new Error(`Z-Library download failed (${res.status}).`);
        if (Number(res.headers.get('content-length')) > MAX_BYTES) { await res.body?.cancel(); throw new Error('Book files must be under 50 MB.'); }
        const reader = res.body?.getReader();
        if (!reader) throw new Error('Z-Library returned an empty download.');
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length;
            if (size > MAX_BYTES) throw new Error('Book files must be under 50 MB.');
            chunks.push(value);
          }
        } catch (e) { await reader.cancel(); throw e; }
        const bytes = new Uint8Array(size); let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
        const valid = book.extension === 'pdf' ? new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-' : bytes[0] === 0x50 && bytes[1] === 0x4b;
        if (!valid) throw new Error('Z-Library returned a page instead of a readable book file. Try another file or upload your own.');
        return { name: `${book.title.replace(/[\/\\\x00-\x1f]/g, '_').slice(0, 150)}.${book.extension}`, bytes };
      }
      throw new Error('Z-Library download redirected too many times.');
    },
  };
}
export const zlib = zlibrary();
