import type { Answer, Result, Sources } from './app.contract.d.ts';

// The server's address, its one place: server/index.ts listens on it. A deployed server is
// API_BASE_URL (app.json `env`).
export const API: string = import.meta.env.API_BASE_URL ?? 'http://127.0.0.1:8787';
export const grants = `net.fetch ${API}\nfs.read app:/tmp/picked`;

type Reply = Result<'createAudiobook'>;
type Book = Result<'searchBooks'>[number];

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { exactTimeout: 15000 });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `The server answered ${res.status}.`);
  return body;
}

const book = (b: Record<string, unknown>): Book => ({
  id: String(b.id), title: String(b.title), author: String(b.author ?? ''), year: Number(b.year) || 0,
  cover: String(b.cover ?? ''), description: String(b.description ?? ''), versions: Number(b.versions) || 0,
});
const abs = (path: string) => (path ? `${API}${path}` : '');

const sources: Sources = {
  searchBooks: async ([q]) => (q.trim() === '' ? [] : ((await get(`/search?q=${encodeURIComponent(q)}`)) as Record<string, unknown>[]).map(book)),
  loadListening: async () => ((await get('/listening')) as Record<string, unknown>[]).map(book),
  loadModels: async () => ((await get('/models')) as { id: string; name: string }[]).map((m) => ({ id: m.id, name: m.name })),
  loadBook: async ([id]) => {
    if (!id) return { book: { id: '', title: '', author: '', year: 0, cover: '', description: '', versions: 0 }, versions: [] };
    const body = (await get(`/books/${encodeURIComponent(id)}`)) as { book: Record<string, unknown>; versions: Record<string, unknown>[] };
    return {
      book: book(body.book),
      versions: body.versions.map((v) => ({
        id: String(v.id), by: String(v.by), model: String(v.model), voice: String(v.voice), status: String(v.status),
        done: Number(v.done), total: Number(v.total), error: String(v.error), sample: abs(String(v.sample)),
      })),
    };
  },
  loadAudiobook: async ([id]) => {
    if (!id) return { id: '', title: '', author: '', cover: '', by: '', model: '', tracks: [] };
    const g = (await get(`/generations/${encodeURIComponent(id)}`)) as {
      id: string; by: string; model: string; book: { title: string; author: string; cover: string };
      tracks: { idx: number; title: string; src: string }[];
    };
    return {
      id: String(g.id), title: g.book.title, author: g.book.author, cover: g.book.cover, by: g.by, model: g.model,
      tracks: g.tracks.map((t) => ({ idx: t.idx, title: t.title, src: abs(t.src) })),
    };
  },
  // The picked file's bytes go up as the request body.
  createAudiobook: async ([bookId, path, name, model, voice, by, rights], _store, storage): Promise<Reply> => {
    try {
      const bytes = await storage.fs.readFile(path);
      const query = new URLSearchParams({ name, model, voice, by, rights: rights ? '1' : '0' });
      const res = await fetch(`${API}/books/${encodeURIComponent(bookId)}/generations?${query}`, {
        method: 'POST', body: bytes, exactTimeout: 120000, headers: { 'content-type': 'application/octet-stream' },
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return res.ok ? { ok: true, error: '' } : { ok: false, error: body.error ?? 'The server had a problem. Try again.' };
    } catch (e) {
      if ((e as { code?: string }).code === 'bake') throw e;
      return { ok: false, error: 'Can’t reach the server. Check that it’s running, then try again.' };
    }
  },
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
