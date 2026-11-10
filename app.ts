import type { Answer, Result, Sources, Store } from './app.contract.d.ts';
import { credentials } from '@exact/passkeys';
import { preventSilentAccess } from '@exact/sign-in';

// The server's address, its one place: server/index.ts listens on it. A deployed server is
// API_BASE_URL (app.json `env`).
export const API: string = import.meta.env.API_BASE_URL ?? 'http://127.0.0.1:8787';
// The Google sign-in clients (app.json `env`; README "Accounts"); server/config.ts reads the same.
const GOOGLE_WEB_CLIENT_ID: string = import.meta.env.GOOGLE_WEB_CLIENT_ID ?? 'exalt-web.apps.googleusercontent.com';
const GOOGLE_IOS_CLIENT_ID: string = import.meta.env.GOOGLE_IOS_CLIENT_ID ?? 'exalt-ios.apps.googleusercontent.com';
const SESSION = 'exalt.session';
const PLACES = 'exalt.places';
const VOICE = 'exalt.voice';
export const grants = [`net.fetch ${API}`, 'fs.read app:/tmp/picked', `secret.keep ${SESSION}`, `secret.keep ${PLACES}`, `secret.keep ${VOICE}`,
  `auth.google ${GOOGLE_WEB_CLIENT_ID}`, `auth.google ${GOOGLE_IOS_CLIENT_ID}`].join('\n');

type Reply = Result<'createAudiobook'>;
type Book = Result<'searchBooks'>[number];

// The session the server answered at sign-in: its bearer token and the name to show. The view
// sees only whether there is one and the name.
type Session = { token: string; name: string };
const session = (store: Store): Session | null => {
  try { return JSON.parse(store.get(SESSION) ?? 'null'); } catch { return null; }
};
const bearer = (store: Store): Record<string, string> => {
  const s = session(store);
  return s ? { authorization: `Bearer ${s.token}` } : {};
};

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, { method: 'POST', body: JSON.stringify(body), exactTimeout: 15000,
    headers: { 'content-type': 'application/json', ...headers } });
  return (await res.json().catch(() => ({}))) as Record<string, any>;
}

// Sign in with Google (../exact/docs/recipes/sign-in.md): a single-use nonce from the
// server, fetched before the press; at the press `get` runs with nothing awaited before it (on
// the web the button holds the popup for it); the server checks the provider's token and answers
// a session. Whatever happens, the next nonce is fetched.
const onWeb = () => /^https?:\/\//.test(authCallback());
let ready: { nonce: string; client: string } | null = null;
async function identityNonce() {
  ready = (await post('/sign-in/nonce', { client: ready?.client, callback: onWeb() ? authCallback() : '' })) as { nonce: string; client: string };
  return { ok: true, error: '' };
}
const PROVIDERS = {
  google: { configURL: 'https://accounts.google.com/gsi/fedcm.json', clientId: GOOGLE_WEB_CLIENT_ID, apple: { clientId: GOOGLE_IOS_CLIENT_ID } },
} as const;
const errorName = (e: unknown) => String((e as { code?: string; name?: string })?.code ?? (e as { name?: string })?.name ?? 'error');

async function signInWith(store: Store, name: 'google') {
  const asked = ready;
  if (!asked) return { ok: false, error: 'Sign-in isn’t ready yet. Try again in a moment.' };
  ready = null;
  try {
    let credential;
    try {
      credential = await credentials.get({ identity: { mode: 'active', providers: [{
        ...PROVIDERS[name], params: { nonce: asked.nonce }, ...(onWeb() ? { web: { redirectURI: `${API}/sign-in/return` } } : {}),
      }] } });
    } catch (e) {
      // A cancel, or a request a newer one replaced, shows nothing.
      const code = errorName(e);
      return ['NetworkError', 'NotAllowedError', 'AbortError'].includes(code) ? { ok: false, error: '' } : { ok: false, error: 'Sign-in didn’t work. Try again.' };
    }
    const { handle: _handle, ...posted } = credential as unknown as Record<string, unknown>;
    const done = await post('/sign-in/identity', { credential: posted, client: asked.client, nonce: asked.nonce });
    if (!done.ok) return { ok: false, error: 'Sign-in didn’t work. Try again.' };
    store.set(SESSION, JSON.stringify({ token: String(done.token), name: String(done.name || done.email || 'You') }));
    return { ok: true, error: '' };
  } catch {
    return { ok: false, error: 'Can’t reach the server. Try again.' };
  } finally {
    await identityNonce().catch(() => {});
  }
}

async function signOut(store: Store) {
  const headers = bearer(store);
  store.forget(SESSION);
  // The next sign-in shows the provider's sheet rather than signing straight back in.
  await preventSilentAccess().catch(() => {});
  await post('/sign-out', {}, headers).catch(() => {});
  return { ok: true, error: '' };
}

async function get(path: string, timeout = 15000): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { exactTimeout: timeout });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `The server answered ${res.status}.`);
  return body;
}

const book = (b: Record<string, unknown>): Book => ({
  id: String(b.id), title: String(b.title), author: String(b.author ?? ''), year: Number(b.year) || 0,
  cover: String(b.cover ?? ''), description: String(b.description ?? ''), versions: Number(b.versions) || 0,
});
const abs = (path: string) => (path ? `${API}${path}` : '');

// The lander's stack: the canon, Plato to Ray Peat, in the handsomest current editions
// (mostly Penguin Classics), covers in assets/covers named by ISBN.
const greats: [string, string, string, string][] = [
  ['9780141442433', 'The Republic', 'Plato', 'c. 375 BC'],
  ['9780140449334', 'Meditations', 'Marcus Aurelius', 'c. 180'],
  ['9780140436327', 'Selected Writings', 'Thomas Aquinas', 'c. 1270'],
  ['9780140449150', 'The Prince', 'Niccolò Machiavelli', '1532'],
  ['9780140431957', 'Leviathan', 'Thomas Hobbes', '1651'],
  ['9780140442014', 'The Social Contract', 'Jean-Jacques Rousseau', '1762'],
  ['9780140432084', 'The Wealth of Nations', 'Adam Smith', '1776'],
  ['9780140447477', 'Critique of Pure Reason', 'Immanuel Kant', '1781'],
  ['9780140449013', 'Faust', 'Johann Wolfgang von Goethe', '1808'],
  ['9780140444490', 'Fear and Trembling', 'Søren Kierkegaard', '1843'],
  ['9780140447576', 'The Communist Manifesto', 'Karl Marx', '1848'],
  ['9781400079988', 'War and Peace', 'Leo Tolstoy', '1869'],
  ['9780140449136', 'Crime and Punishment', 'Fyodor Dostoevsky', '1866'],
  ['9780140441185', 'Thus Spoke Zarathustra', 'Friedrich Nietzsche', '1883'],
  ['9780140449235', 'Beyond Good and Evil', 'Friedrich Nietzsche', '1886'],
  ['9780679720201', 'The Stranger', 'Albert Camus', '1942'],
  ['9780970291363', 'Generative Energy', 'Ray Peat', '1994'],
];

// Where the listener is in each audiobook, kept on this device (signed in or not), newest first.
type Place = Result<'loadPlaces'>[number];
const places = (store: Store): Place[] => {
  try { return JSON.parse(store.get(PLACES) ?? '[]'); } catch { return []; }
};
// The voice the listener prefers, from Fish Audio's library (read through OpenRouter's Fish
// models); empty until they choose one.
type Pref = Result<'loadVoicePref'>;
const NO_VOICE: Pref = { id: '', title: '', cover: '' };

const sources: Sources = {
  currentAccount: async (_a, store) => {
    const s = session(store);
    return { signedIn: s != null, name: s?.name ?? '' };
  },
  identityNonce: () => identityNonce(),
  signInWith: (_a, store) => signInWith(store, 'google'),
  signOut: (_a, store) => signOut(store),
  idle: async () => ({ ok: true, error: '' }),
  loadPlaces: async (_a, store) => places(store),
  // Keeps the place, unless the book is finished (the last chapter, within its last half minute).
  savePlace: async ([gen, book, title, author, cover, track, tracks, time, duration], store) => {
    const done = track >= tracks - 1 && duration > 0 && time >= duration - 30;
    const rest = places(store).filter((p) => p.gen !== gen);
    const kept = done ? rest : [{ gen, book, title, author, cover, track, tracks, time, duration }, ...rest];
    store.set(PLACES, JSON.stringify(kept.slice(0, 24)));
    return { ok: true, error: '' };
  },
  loadVoicePref: async (_a, store) => {
    try { return { ...NO_VOICE, ...JSON.parse(store.get(VOICE) ?? '{}') }; } catch { return NO_VOICE; }
  },
  setVoicePref: async ([id, title, cover], store) => {
    store.set(VOICE, JSON.stringify({ id, title, cover }));
    return { ok: true, error: '' };
  },
  loadVoices: async ([q]) => ((await get(`/voices?q=${encodeURIComponent(q.trim())}`)) as Record<string, unknown>[]).map((v) => ({
    id: String(v.id), title: String(v.title), description: String(v.description ?? ''), cover: String(v.cover ?? ''),
    sample: String(v.sample ?? ''), languages: String(v.languages ?? ''), uses: Number(v.uses) || 0,
  })),
  // What the signed-in listener has made; nothing when signed out.
  loadMine: async (_a, store) => {
    if (!session(store)) return [];
    const res = await fetch(`${API}/me/audiobooks`, { exactTimeout: 15000, headers: bearer(store) });
    if (res.status === 401) return [];
    const rows = (await res.json().catch(() => [])) as Record<string, unknown>[];
    return rows.map((g) => ({
      gen: String(g.id), book: String(g.book), title: String(g.title), author: String(g.author ?? ''), cover: String(g.cover ?? ''),
      status: String(g.status), done: Number(g.done) || 0, total: Number(g.total) || 0, model: String(g.model), voice: String(g.voice ?? ''),
    }));
  },
  loadGreats: async () => greats.map(([isbn, title, author, era]) => ({ id: isbn, title, author, era, cover: `assets/covers/${isbn}.jpg` })),
  searchBooks: async ([q]) => (q.trim() === '' ? [] : ((await get(`/search?q=${encodeURIComponent(q)}`)) as Record<string, unknown>[]).map(book)),
  suggestBooks: async ([q]) => (q.trim().length < 2 ? [] : ((await get(`/search?q=${encodeURIComponent(q)}&limit=6`)) as Record<string, unknown>[]).map(book)),
  loadListening: async () => ((await get('/listening')) as Record<string, unknown>[]).map(book),
  loadModels: async () => ((await get('/models')) as { id: string; name: string; voices?: string[] }[]).map((m) => ({ id: m.id, name: m.name, voices: m.voices ?? [] })),
  loadBook: async ([id]) => {
    if (!id) return { book: { id: '', title: '', author: '', year: 0, cover: '', description: '', versions: 0 }, versions: [] };
    const body = (await get(`/books/${encodeURIComponent(id)}`, 30000)) as { book: Record<string, unknown>; versions: Record<string, unknown>[] };
    return {
      book: book(body.book),
      versions: body.versions.map((v) => ({
        id: String(v.id), by: String(v.by), model: String(v.model), voice: String(v.voice), status: String(v.status),
        done: Number(v.done), total: Number(v.total), error: String(v.error), sample: abs(String(v.sample)), voiceName: String(v.voiceName ?? ''),
      })),
    };
  },
  loadBookSources: async ([id]) => {
    if (!id) return { available: false, files: [] };
    return await get(`/books/${encodeURIComponent(id)}/sources`, 30000) as Result<'loadBookSources'>;
  },
  loadAudiobook: async ([id]) => {
    if (!id) return { id: '', book: '', title: '', author: '', cover: '', by: '', model: '', tracks: [] };
    const g = (await get(`/generations/${encodeURIComponent(id)}`)) as {
      id: string; by: string; model: string; book: { id: string; title: string; author: string; cover: string };
      tracks: { idx: number; title: string; src: string }[];
    };
    return {
      id: String(g.id), book: String(g.book.id), title: g.book.title, author: g.book.author, cover: g.book.cover, by: g.by, model: g.model,
      tracks: g.tracks.map((t) => ({ idx: t.idx, title: t.title, src: abs(t.src) })),
    };
  },
  // The picked file's bytes go up as the request body.
  createAudiobook: async ([bookId, path, name, sourceId, model, voice, voiceName, by, rights], store, storage): Promise<Reply> => {
    try {
      const bytes = sourceId ? undefined : await storage.fs.readFile(path);
      const query = new URLSearchParams({ name, source: sourceId, model, voice, voiceName, by, rights: rights ? '1' : '0' });
      const res = await fetch(`${API}/books/${encodeURIComponent(bookId)}/generations?${query}`, {
        method: 'POST', body: bytes, exactTimeout: sourceId ? 180000 : 120000, headers: { 'content-type': 'application/octet-stream', ...bearer(store) },
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // A session the server no longer knows (signed out elsewhere, or expired): sign in again.
      if (res.status === 401) {
        store.forget(SESSION);
        return { ok: false, error: 'Sign in again to make an audiobook.' };
      }
      return res.ok ? { ok: true, error: '' } : { ok: false, error: body.error ?? 'The server had a problem. Try again.' };
    } catch (e) {
      if ((e as { code?: string }).code === 'bake') throw e;
      return { ok: false, error: 'Can’t reach the server. Check that it’s running, then try again.' };
    }
  },
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
