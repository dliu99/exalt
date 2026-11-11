import type { Answer, Result, Sources, Store } from './app.contract.d.ts';
import { credentials } from '@exact/passkeys';
import { preventSilentAccess } from '@exact/sign-in';
import { oauth } from '@exact/oauth';

// The server's address, its one place: server/index.ts listens on it. A deployed server is
// API_BASE_URL (app.json `env`).
export const API: string = import.meta.env.API_BASE_URL ?? 'http://127.0.0.1:8787';
// The Google sign-in clients (app.json `env`; README "Accounts"); server/config.ts reads the same.
const GOOGLE_WEB_CLIENT_ID: string = import.meta.env.GOOGLE_WEB_CLIENT_ID ?? 'exalt-web.apps.googleusercontent.com';
const GOOGLE_IOS_CLIENT_ID: string = import.meta.env.GOOGLE_IOS_CLIENT_ID ?? 'exalt-ios.apps.googleusercontent.com';
const SESSION = 'exalt.session';
const PLACES = 'exalt.places';
const VOICE = 'exalt.voice';
const GOOGLE_NATIVE = 'exalt.google';
// Sign in with Apple's web client (a Services ID whose return URL is ${API}/sign-in/return).
const APPLE_SERVICES_ID: string = import.meta.env.APPLE_SERVICES_ID ?? 'app.exalt.audiobooks.web';
// Where the server sends the iPhone app's Apple sheet back to; server/config.ts names the same.
const APP_CALLBACK = 'app.exalt.audiobooks:/signed-in';
// The iOS client's callback: its "iOS URL scheme" in Google's console, the reversed client ID.
const GOOGLE_IOS_URL_SCHEME: string = import.meta.env.GOOGLE_IOS_URL_SCHEME ?? 'com.googleusercontent.apps.exalt-ios';
const GOOGLE_IOS_CALLBACK = `${GOOGLE_IOS_URL_SCHEME}:/oauth2redirect`;
export const grants = [`net.fetch ${API}`, 'fs.read app:/tmp/picked', `secret.keep ${SESSION}`, `secret.keep ${PLACES}`, `secret.keep ${VOICE}`,
  `auth.google ${GOOGLE_WEB_CLIENT_ID}`, `auth.google ${GOOGLE_IOS_CLIENT_ID}`,
  // The iPhone app signs in with Google through @exact/oauth (below).
  'net.fetch https://accounts.google.com', 'net.fetch https://oauth2.googleapis.com', 'auth.session https://accounts.google.com',
  `auth.callback ${GOOGLE_IOS_CALLBACK}`, `secret.keep ${GOOGLE_NATIVE}`,
  // …and with Apple through Apple's web sign-in in the same sheet, answered by the server.
  'auth.session https://appleid.apple.com', `auth.callback ${APP_CALLBACK}`].join('\n');

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
// The web has a callback address; a native host has none to ask for (and no grant for one).
const onWeb = () => { try { return /^https?:\/\//.test(authCallback()); } catch { return false; } };
let ready: { nonce: string; client: string } | null = null;
async function identityNonce() {
  ready = (await post('/sign-in/nonce', { client: ready?.client, callback: onWeb() ? authCallback() : APP_CALLBACK })) as { nonce: string; client: string };
  return { ok: true, error: '' };
}
const PROVIDERS = {
  google: { configURL: 'https://accounts.google.com/gsi/fedcm.json', clientId: GOOGLE_WEB_CLIENT_ID, apple: { clientId: GOOGLE_IOS_CLIENT_ID } },
} as const;
const errorName = (e: unknown) => String((e as { code?: string; name?: string })?.code ?? (e as { name?: string })?.name ?? 'error');

// In the iPhone app, Google through @exact/oauth: exact's native identity request for Google
// isn't built (it fails NotSupportedError). PKCE in the system browser with the iOS client; the
// server asks Google about the access token and answers a session, and the Google tokens are
// then let go.
const googleNative = oauth({ issuer: 'https://accounts.google.com', issuerAliases: ['accounts.google.com'],
  clientId: GOOGLE_IOS_CLIENT_ID, scopes: ['openid', 'email', 'profile'], key: GOOGLE_NATIVE, apis: [API], callback: GOOGLE_IOS_CALLBACK });

async function signInNative(store: Store) {
  try {
    const signed = await googleNative.signIn(store);
    if (!signed.ok) return { ok: false, error: signed.code === 'cancelled' || signed.code === 'access_denied' ? '' : 'Sign-in didn’t work. Try again.' };
    const res = await googleNative.fetch(store, `${API}/sign-in/google`, { method: 'POST' });
    const done = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!done.ok) return { ok: false, error: 'Sign-in didn’t work. Try again.' };
    store.set(SESSION, JSON.stringify({ token: String(done.token), name: String(done.name || done.email || 'You') }));
    return { ok: true, error: '' };
  } catch {
    return { ok: false, error: 'Can’t reach the server. Try again.' };
  } finally {
    await googleNative.signOut(store).catch(() => {});
    await googleNative.session(store).catch(() => {});
  }
}

// In the iPhone app, Apple's web sign-in in the system sheet: Apple posts to the server's return
// route, which keeps the ID token under a handle and sends the sheet back to the app; the app
// redeems the handle as the web does. exact's native Apple request isn't built.
const randomState = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
async function signInApple(store: Store) {
  const asked = ready;
  if (!asked) return { ok: false, error: 'Sign-in isn’t ready yet. Try again in a moment.' };
  ready = null;
  try {
    const state = randomState();
    const q = new URLSearchParams({ client_id: APPLE_SERVICES_ID, redirect_uri: `${API}/sign-in/return`, response_type: 'code id_token',
      response_mode: 'form_post', scope: 'name email', state, nonce: asked.nonce });
    let back: string;
    try {
      back = await openAuthSession(`https://appleid.apple.com/auth/authorize?${q}`, { callback: APP_CALLBACK, state });
    } catch (e) {
      // 499: the person closed the sheet.
      return { ok: false, error: (e as { status?: number })?.status === 499 ? '' : 'Sign-in didn’t work. Try again.' };
    }
    const answer = new URLSearchParams(back.split('?')[1] ?? '');
    const relay = answer.get('relay');
    if (!relay) return { ok: false, error: ['user_cancelled_authorize', 'access_denied'].includes(answer.get('error') ?? '') ? '' : 'Sign-in didn’t work. Try again.' };
    const done = await post('/sign-in/identity', { credential: { type: 'identity', configURL: 'https://appleid.apple.com', token: { relay } }, client: asked.client, nonce: asked.nonce });
    if (!done.ok) return { ok: false, error: 'Sign-in didn’t work. Try again.' };
    store.set(SESSION, JSON.stringify({ token: String(done.token), name: String(done.name || done.email || 'You') }));
    return { ok: true, error: '' };
  } catch {
    return { ok: false, error: 'Can’t reach the server. Try again.' };
  } finally {
    await identityNonce().catch(() => {});
  }
}

async function signInWith(store: Store, name: 'google' | 'apple') {
  if (!onWeb()) return name === 'apple' ? signInApple(store) : signInNative(store);
  if (name === 'apple') return { ok: false, error: '' };
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
  try { return (JSON.parse(store.get(PLACES) ?? '[]') as Place[]).map((p) => ({ ...p, at: Number(p.at) || 0 })); } catch { return []; }
};
// A signed-in listener's places are on the server too (GET and PUT /me/places), so the web and
// the phone carry over. The newest `at` wins; a book finished elsewhere (`finished`, newer than
// this device's place in it) leaves the shelf here too. Signed out, or the server out of reach,
// it is this device's alone.
type Kept = Place & { finished: boolean };
let asking: { token: string; rows: Promise<Kept[]> } | null = null;
function serverPlaces(store: Store): Promise<Kept[]> {
  const s = session(store);
  if (!s) return Promise.resolve([]);
  // The player's places and Home's shelf ask together: one request answers both.
  if (asking?.token === s.token) return asking.rows;
  const rows = (async () => {
    const res = await fetch(`${API}/me/places`, { exactTimeout: 8000, headers: bearer(store) });
    if (!res.ok) return [];
    return ((await res.json()) as Record<string, unknown>[]).map((p) => ({
      gen: String(p.gen), book: String(p.book), title: String(p.title), author: String(p.author ?? ''), cover: String(p.cover ?? ''),
      track: Number(p.track) || 0, tracks: Number(p.tracks) || 0, time: Number(p.time) || 0, duration: Number(p.duration) || 0,
      at: Number(p.at) || 0, finished: p.finished === true,
    }));
  })().catch(() => []).finally(() => { if (asking?.rows === rows) asking = null; });
  asking = { token: s.token, rows };
  return rows;
}
async function placesEverywhere(store: Store): Promise<Place[]> {
  const newest = new Map<string, Place & { finished?: boolean }>();
  for (const p of [...places(store), ...await serverPlaces(store)]) {
    const had = newest.get(p.gen);
    if (!had || p.at > had.at) newest.set(p.gen, p);
  }
  return [...newest.values()].filter((p) => !p.finished).sort((a, b) => b.at - a.at).slice(0, 24)
    .map(({ gen, book, title, author, cover, track, tracks, time, duration, at }) => ({ gen, book, title, author, cover, track, tracks, time, duration, at }));
}
// The shelf's words for a place: about how long is left (the chapters still to come taken to
// run as long as this one), and when it was last heard.
const span = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : `${Math.max(1, Math.round(s / 60))}m`);
const leftText = (p: Place) => (p.duration > 0
  ? `About ${span(p.duration - p.time + (p.tracks - p.track - 1) * p.duration)} left`
  : `${p.tracks - p.track} ${p.tracks - p.track === 1 ? 'chapter' : 'chapters'} left`);
const whenText = (at: number, now: number) => {
  if (!at) return '';
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
  return now - at < 3600000 ? 'Just now' : days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`;
};
const fraction = (p: Place) => (p.tracks ? Math.min(1, (p.track + (p.duration > 0 ? p.time / p.duration : 0)) / p.tracks) : 0);
// The voice the listener prefers, from Fish Audio's library (read through OpenRouter's Fish
// models); empty until they choose one.
type Pref = Result<'loadVoicePref'>;
const NO_VOICE: Pref = { id: '', title: '', cover: '' };

const sources: Sources = {
  currentAccount: async (_a, store) => {
    const s = session(store);
    return { signedIn: s != null, name: s?.name ?? '' };
  },
  // In the app it also readies the Google sign-in, so the press opens the sheet at once.
  identityNonce: (_a, store) => (onWeb() ? identityNonce()
    : Promise.all([identityNonce(), googleNative.session(store)]).then(() => ({ ok: true, error: '' }), () => ({ ok: true, error: '' }))),
  signInWith: ([name], store) => signInWith(store, name === 'apple' ? 'apple' : 'google'),
  signOut: (_a, store) => signOut(store),
  idle: async () => ({ ok: true, error: '' }),
  loadPlaces: async (_a, store) => placesEverywhere(store),
  // Keeps the place, unless the book is finished (the last chapter, within its last half minute).
  // The player saves every 15 seconds while it plays, at a pause and at a chapter's change, never
  // on every tick; a signed-in listener's place goes to the server each time too.
  savePlace: async ([gen, book, title, author, cover, track, tracks, time, duration, at], store) => {
    const done = track >= tracks - 1 && duration > 0 && time >= duration - 30;
    const rest = places(store).filter((p) => p.gen !== gen);
    const kept = done ? rest : [{ gen, book, title, author, cover, track, tracks, time, duration, at }, ...rest];
    store.set(PLACES, JSON.stringify(kept.slice(0, 24)));
    if (session(store)) {
      await fetch(`${API}/me/places/${encodeURIComponent(gen)}`, { method: 'PUT', exactTimeout: 8000,
        headers: { 'content-type': 'application/json', ...bearer(store) },
        body: JSON.stringify({ track, tracks, time, duration, at: Math.round(at), finished: done }) }).catch(() => {});
    }
    return { ok: true, error: '' };
  },
  // Home's shelf, six books: the ones in progress here, newest first, then the listener's own, then what is on Exalt.
  loadShelf: async ([now], store, storage) => {
    const shelf: Result<'loadShelf'> = [], seen = new Set<string>();
    const put = (s: Result<'loadShelf'>[number]) => { if (shelf.length < 6 && !seen.has(s.book)) { seen.add(s.book); shelf.push(s); } };
    for (const p of await placesEverywhere(store)) put({ book: p.book, gen: p.gen, title: p.title, author: p.author, cover: p.cover,
      chapter: `Chapter ${p.track + 1} of ${p.tracks}`, left: leftText(p), when: whenText(p.at, now), frac: fraction(p) });
    if (shelf.length < 6) for (const m of await Promise.resolve(sources.loadMine([], store, storage)).catch(() => [])) {
      const ready = m.status === 'ready';
      put({ book: m.book, gen: ready ? m.gen : '', title: m.title, author: m.author, cover: m.cover, frac: 0, when: '',
        chapter: ready ? `${m.total} ${m.total === 1 ? 'chapter' : 'chapters'}` : m.status === 'failed' ? 'Didn’t finish' : m.total ? `Voicing ${m.done} of ${m.total}…` : 'Preparing…', left: ready ? 'Not started' : '' });
    }
    if (shelf.length < 6) {
      // What is on Exalt plays its first finished audiobook.
      const on = (await Promise.resolve(sources.loadListening([], store, storage)).catch(() => [])).filter((b) => !seen.has(b.id)).slice(0, 6 - shelf.length);
      const first = await Promise.all(on.map((b) => Promise.resolve(sources.loadBook([b.id], store, storage)).then((d) => d.versions.find((v) => v.status === 'ready')).catch(() => undefined)));
      on.forEach((b, i) => put({ book: b.id, gen: first[i]?.id ?? '', title: b.title, author: b.author, cover: b.cover, frac: 0, when: '',
        chapter: first[i] ? `${first[i]!.total} ${first[i]!.total === 1 ? 'chapter' : 'chapters'}` : b.versions === 1 ? '1 audiobook' : `${b.versions} audiobooks`, left: first[i] ? 'Not started' : '' }));
    }
    return shelf;
  },
  // Whether the server keeps accounts: the offline one (tests, a first run) has no provider to sign in with, so its door stays open. A server that doesn't say keeps it shut.
  accountRequired: async () => ({ ok: (await get('/door').catch(() => ({})) as { required?: boolean }).required !== false, error: '' }),
  // Whether this is the app (a native host) rather than the site.
  isApp: async () => ({ ok: !onWeb(), error: '' }),
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
        done: Number(v.done) || 0, total: Number(v.total) || 0, active: Number(v.active) || 0, error: String(v.error),
        sample: abs(String(v.sample)), voiceName: String(v.voiceName ?? ''),
      })),
    };
  },
  loadBookSources: async ([id]) => {
    if (!id) return { available: false, files: [] };
    return await get(`/books/${encodeURIComponent(id)}/sources`, 30000) as Result<'loadBookSources'>;
  },
  // A version and its chapters. Asked with the session, the server also says how many chapters this
  // listener has narrating (of how many at once) and whether they made it.
  loadAudiobook: async ([id], store) => {
    if (!id) return { id: '', book: '', title: '', author: '', cover: '', by: '', model: '', status: '', error: '', chapters: [], mine: 0, limit: 0, owner: false };
    const res = await fetch(`${API}/generations/${encodeURIComponent(id)}`, { exactTimeout: 15000, headers: bearer(store) });
    const g = (await res.json().catch(() => ({}))) as {
      id: string; by: string; model: string; status: string; error: string; book: { id: string; title: string; author: string; cover: string };
      chapters: { idx: number; title: string; src: string; status: string; progress: number; error: string }[];
      mine?: number; limit?: number; owner?: boolean;
    };
    if (!res.ok) throw new Error(g.error ?? `The server answered ${res.status}.`);
    return {
      id: String(g.id), book: String(g.book.id), title: g.book.title, author: g.book.author, cover: g.book.cover, by: g.by, model: g.model,
      status: String(g.status), error: String(g.error ?? ''), mine: Number(g.mine) || 0, limit: Number(g.limit) || 0, owner: g.owner === true,
      chapters: g.chapters.map((c) => ({ idx: c.idx, title: c.title, src: abs(c.src), status: c.status, progress: Number(c.progress) || 0, error: String(c.error ?? '') })),
    };
  },
  // Narrate one chapter: anyone signed in may ask, a few at a time.
  generateChapter: async ([gen, idx], store): Promise<Reply> => {
    try {
      const res = await fetch(`${API}/generations/${encodeURIComponent(gen)}/chapters/${idx}`, { method: 'POST', exactTimeout: 15000, headers: bearer(store) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 401) {
        store.forget(SESSION);
        return { ok: false, error: 'Sign in again to narrate a chapter.' };
      }
      return res.ok ? { ok: true, error: '' } : { ok: false, error: body.error ?? 'The server had a problem. Try again.' };
    } catch (e) {
      if ((e as { code?: string }).code === 'bake') throw e;
      return { ok: false, error: 'Can’t reach the server. Try again.' };
    }
  },
  // Delete a version this listener made, its audio with it.
  deleteAudiobook: async ([gen], store): Promise<Reply> => {
    try {
      const res = await fetch(`${API}/generations/${encodeURIComponent(gen)}`, { method: 'DELETE', exactTimeout: 15000, headers: bearer(store) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return res.ok ? { ok: true, error: '' } : { ok: false, error: body.error ?? 'The server had a problem. Try again.' };
    } catch (e) {
      if ((e as { code?: string }).code === 'bake') throw e;
      return { ok: false, error: 'Can’t reach the server. Try again.' };
    }
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
