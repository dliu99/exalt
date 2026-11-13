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

type Reply = Result<'importBook'>;

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

async function get(path: string, timeout = 15000, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { exactTimeout: timeout, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `The server answered ${res.status}.`);
  return body;
}


// The lander's stack: the canon, Plato to Ray Peat, in the handsomest current editions
// (mostly Penguin Classics), covers in assets/covers named by ISBN.
const greats: [string, string, string][] = [
  ['9780141442433', 'The Republic', 'Plato'],
  ['9780140449334', 'Meditations', 'Marcus Aurelius'],
  ['9780140436327', 'Selected Writings', 'Thomas Aquinas'],
  ['9780140449150', 'The Prince', 'Niccolò Machiavelli'],
  ['9780140431957', 'Leviathan', 'Thomas Hobbes'],
  ['9780140442014', 'The Social Contract', 'Jean-Jacques Rousseau'],
  ['9780140432084', 'The Wealth of Nations', 'Adam Smith'],
  ['9780140447477', 'Critique of Pure Reason', 'Immanuel Kant'],
  ['9780140449013', 'Faust', 'Johann Wolfgang von Goethe'],
  ['9780140444490', 'Fear and Trembling', 'Søren Kierkegaard'],
  ['9780140447576', 'The Communist Manifesto', 'Karl Marx'],
  ['9781400079988', 'War and Peace', 'Leo Tolstoy'],
  ['9780140449136', 'Crime and Punishment', 'Fyodor Dostoevsky'],
  ['9780140441185', 'Thus Spoke Zarathustra', 'Friedrich Nietzsche'],
  ['9780140449235', 'Beyond Good and Evil', 'Friedrich Nietzsche'],
  ['9780679720201', 'The Stranger', 'Albert Camus'],
  ['9780970291363', 'Generative Energy', 'Ray Peat'],
];

// The server answers covers and audio by path ("/covers/…", "/audio/…", a private one's signed
// with ?exp=&sig=); a cover from elsewhere is already whole, and '' is none.
const abs = (src: string) => (!src ? '' : /^https?:\/\//.test(src) ? src : `${API}${src}`);
const str = (v: unknown) => (v == null ? '' : String(v));

// What a request the server refused says, or a fallback.
async function refusal(res: Response, fallback = 'The server had a problem. Try again.') {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error || fallback;
}
// A session the server no longer knows (signed out elsewhere, or expired): sign in again.
const SIGN_IN_AGAIN = 'Sign in again to change your library.';
const UNREACHABLE = 'Can’t reach the server. Check your connection, then try again.';

// One change to an audiobook of the person's own (PATCH or DELETE /me/audiobooks/:id).
async function change(store: Store, id: string, method: 'PATCH' | 'DELETE', body?: Record<string, unknown>): Promise<Reply> {
  if (!session(store)) return { ok: false, error: SIGN_IN_AGAIN };
  try {
    const res = await fetch(`${API}/me/audiobooks/${encodeURIComponent(id)}`, { method, exactTimeout: 15000,
      headers: { 'content-type': 'application/json', ...bearer(store) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) {
      store.forget(SESSION);
      return { ok: false, error: SIGN_IN_AGAIN };
    }
    return res.ok ? { ok: true, error: '' } : { ok: false, error: await refusal(res) };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

// Where the listener is in each audiobook, kept on this device (signed in or not), newest first.
type Place = Result<'loadPlaces'>[number];
const places = (store: Store): Place[] => {
  try {
    return (JSON.parse(store.get(PLACES) ?? '[]') as Place[]).map((p) => ({ gen: str(p.gen), title: str(p.title), author: str(p.author),
      cover: str(p.cover), track: Number(p.track) || 0, tracks: Number(p.tracks) || 0, time: Number(p.time) || 0,
      duration: Number(p.duration) || 0, at: Number(p.at) || 0 }));
  } catch { return []; }
};
// A signed-in listener's places are on the server too (GET and PUT /me/places), so the web and
// the phone carry over. The newest `at` wins; a book finished elsewhere (`finished`, newer than
// this device's place in it) leaves this device's list too. Signed out, or the server out of
// reach, they are this device's alone.
type Kept = Place & { finished: boolean };
let asking: { token: string; rows: Promise<Kept[]> } | null = null;
function serverPlaces(store: Store): Promise<Kept[]> {
  const s = session(store);
  if (!s) return Promise.resolve([]);
  // Several readers asking at once share one request.
  if (asking?.token === s.token) return asking.rows;
  const rows = (async () => {
    const res = await fetch(`${API}/me/places`, { exactTimeout: 8000, headers: bearer(store) });
    // A session the server no longer knows: signed out here too, so the view offers sign-in.
    if (res.status === 401) store.forget(SESSION);
    if (!res.ok) return [];
    return ((await res.json()) as Record<string, unknown>[]).map((p) => ({
      gen: str(p.gen), title: str(p.title), author: str(p.author), cover: abs(str(p.cover)),
      track: Number(p.track) || 0, tracks: Number(p.tracks) || 0, time: Number(p.time) || 0, duration: Number(p.duration) || 0,
      at: Number(p.at) || 0, finished: p.finished === true,
    }));
  })().catch(() => []).finally(() => { if (asking?.rows === rows) asking = null; });
  asking = { token: s.token, rows };
  return rows;
}
// The server's copy names the book as it is now (a renamed title, a freshly signed cover), so it
// gives the title, author and cover whichever copy's position is newer.
async function placesEverywhere(store: Store): Promise<Place[]> {
  const newest = new Map<string, Place & { finished?: boolean }>();
  const theirs = await serverPlaces(store);
  for (const p of [...places(store), ...theirs]) {
    const had = newest.get(p.gen);
    if (!had || p.at > had.at || (p.at === had.at && 'finished' in p)) newest.set(p.gen, p);
  }
  for (const s of theirs) {
    const kept = newest.get(s.gen);
    if (kept && kept !== s) newest.set(s.gen, { ...kept, title: s.title, author: s.author, cover: s.cover });
  }
  return [...newest.values()].filter((p) => !p.finished).sort((a, b) => b.at - a.at).slice(0, 24)
    .map(({ gen, title, author, cover, track, tracks, time, duration, at }) => ({ gen, title, author, cover, track, tracks, time, duration, at }));
}
// The voice the listener prefers, from Fish Audio's library (read through OpenRouter's Fish
// models); empty until they choose one.
type Pref = Result<'loadVoicePref'>;
const NO_VOICE: Pref = { id: '', title: '', cover: '' };
const NO_AUDIOBOOK: Result<'loadAudiobook'> = { id: '', title: '', author: '', cover: '', by: '', voice: '', public: false,
  status: '', done: 0, total: 0, error: '', tracks: [] };

const sources: Sources = {
  currentAccount: async (_a, store) => {
    if (!session(store)) {
      const res = await fetch(`${API}/sign-in/dev`, { method: 'POST', exactTimeout: 4000 }).catch(() => null);
      const done = res?.ok ? ((await res.json().catch(() => ({}))) as Record<string, unknown>) : null;
      if (done?.ok) store.set(SESSION, JSON.stringify({ token: String(done.token), name: String(done.name || 'Developer') }));
    }
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
  savePlace: async ([gen, title, author, cover, track, tracks, time, duration, at], store) => {
    const done = track >= tracks - 1 && duration > 0 && time >= duration - 30;
    const rest = places(store).filter((p) => p.gen !== gen);
    const kept = done ? rest : [{ gen, title, author, cover, track, tracks, time, duration, at }, ...rest];
    store.set(PLACES, JSON.stringify(kept.slice(0, 24)));
    if (session(store)) {
      await fetch(`${API}/me/places/${encodeURIComponent(gen)}`, { method: 'PUT', exactTimeout: 8000,
        headers: { 'content-type': 'application/json', ...bearer(store) },
        body: JSON.stringify({ track, tracks, time, duration, at: Math.round(at), finished: done }) }).catch(() => {});
    }
    return { ok: true, error: '' };
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
    id: str(v.id), title: str(v.title), description: str(v.description), cover: str(v.cover),
    sample: str(v.sample), languages: str(v.languages), uses: Number(v.uses) || 0,
  })),
  loadGreats: async () => greats.map(([isbn, title, author]) => ({ id: isbn, title, author, cover: `assets/covers/${isbn}.jpg` })),
  loadModels: async () => ((await get('/models')) as { id: string; name: string; voices?: string[] }[]).map((m) => ({ id: m.id, name: m.name, voices: m.voices ?? [] })),
  // The signed-in person's audiobooks, newest first, finished or not; nothing when signed out.
  loadLibrary: async (_a, store) => {
    if (!session(store)) return [];
    const res = await fetch(`${API}/me/audiobooks`, { exactTimeout: 15000, headers: bearer(store) });
    // A session the server no longer knows: signed out here too, so the view offers sign-in.
    if (res.status === 401) {
      store.forget(SESSION);
      return [];
    }
    if (!res.ok) throw new Error(await refusal(res));
    return ((await res.json()) as Record<string, unknown>[]).map((g) => ({
      id: str(g.id), title: str(g.title), author: str(g.author), cover: abs(str(g.cover)), status: str(g.status),
      done: Number(g.done) || 0, total: Number(g.total) || 0, error: str(g.error), public: g.public === true, voice: str(g.voice),
    }));
  },
  // Everyone's shared, finished audiobooks, newest first; `q` narrows to a title or author.
  loadBrowse: async ([q]) => ((await get(`/browse?q=${encodeURIComponent(q.trim())}`)) as Record<string, unknown>[]).map((g) => ({
    id: str(g.id), title: str(g.title), author: str(g.author), cover: abs(str(g.cover)), by: str(g.by), voice: str(g.voice),
    chapters: Number(g.chapters) || 0,
  })),
  // One audiobook to play: a shared one, or the person's own private one (hence the session).
  loadAudiobook: async ([id], store) => {
    if (!id) return NO_AUDIOBOOK;
    const g = (await get(`/generations/${encodeURIComponent(id)}`, 15000, bearer(store))) as Record<string, unknown>;
    return {
      id: str(g.id), title: str(g.title), author: str(g.author), cover: abs(str(g.cover)), by: str(g.by), voice: str(g.voice),
      public: g.public === true, status: str(g.status), done: Number(g.done) || 0, total: Number(g.total) || 0, error: str(g.error),
      tracks: ((g.tracks ?? []) as Record<string, unknown>[]).map((t) => ({ idx: Number(t.idx) || 0, title: str(t.title), src: abs(str(t.src)) })),
    };
  },
  // An import: the picked file's bytes go up as the request body, what to make of them in the query.
  importBook: async ([path, name, model, voice, voiceName, title, author, share, rights], store, storage): Promise<Reply> => {
    if (!session(store)) return { ok: false, error: 'Sign in to import a book.' };
    try {
      const bytes = await storage.fs.readFile(path);
      const query = new URLSearchParams({ name, model, voice, voiceName, title, author, public: share ? '1' : '0', rights: rights ? '1' : '0' });
      const res = await fetch(`${API}/audiobooks?${query}`, {
        method: 'POST', body: bytes, exactTimeout: 120000, headers: { 'content-type': 'application/octet-stream', ...bearer(store) },
      });
      if (res.status === 401) {
        store.forget(SESSION);
        return { ok: false, error: 'Sign in again to import a book.' };
      }
      return res.ok ? { ok: true, error: '' } : { ok: false, error: await refusal(res) };
    } catch (e) {
      if ((e as { code?: string }).code === 'bake') throw e;
      return { ok: false, error: UNREACHABLE };
    }
  },
  // Sharing on asks the person to confirm they have the right to share the book.
  setSharing: ([id, share, rights], store) => change(store, id, 'PATCH', share ? { public: true, rights } : { public: false }),
  // This device's place in the book follows: renamed, or gone with it.
  renameAudiobook: async ([id, title], store) => {
    const r = await change(store, id, 'PATCH', { title });
    if (r.ok) store.set(PLACES, JSON.stringify(places(store).map((p) => (p.gen === id ? { ...p, title } : p))));
    return r;
  },
  deleteAudiobook: async ([id], store) => {
    const r = await change(store, id, 'DELETE');
    if (r.ok) store.set(PLACES, JSON.stringify(places(store).filter((p) => p.gen !== id)));
    return r;
  },
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
