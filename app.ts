import type { Answer, Result, Sources, Storage, Store } from './app.contract.d.ts';
import { credentials } from '@exact/passkeys';
import { preventSilentAccess } from '@exact/sign-in';
import { oauth } from '@exact/oauth';
import { bookMeta, readBook } from './server/book.ts';

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
// Downloaded chapters, a folder per audiobook: `<idx>.<ext>` beside `book.json`, the audiobook as it was.
const OFFLINE = 'app:/cache/offline';
// Sign in with Apple's web client (a Services ID whose return URL is ${API}/sign-in/return).
const APPLE_SERVICES_ID: string = import.meta.env.APPLE_SERVICES_ID ?? 'app.exalt.audiobooks.web';
// Where the server sends the iPhone app's Apple sheet back to; server/config.ts names the same.
const APP_CALLBACK = 'app.exalt.audiobooks:/signed-in';
// The iOS client's callback: its "iOS URL scheme" in Google's console, the reversed client ID.
const GOOGLE_IOS_URL_SCHEME: string = import.meta.env.GOOGLE_IOS_URL_SCHEME ?? 'com.googleusercontent.apps.exalt-ios';
const GOOGLE_IOS_CALLBACK = `${GOOGLE_IOS_URL_SCHEME}:/oauth2redirect`;
export const grants = [`net.fetch ${API}`, 'fs.read app:/tmp/picked', `secret.keep ${SESSION}`, `secret.keep ${PLACES}`, `secret.keep ${VOICE}`,
  // Downloads, and the notice that a chapter asked for is narrated.
  `fs.read ${OFFLINE}`, `fs.write ${OFFLINE}`, 'device.notifications purpose.notifications',
  `auth.google ${GOOGLE_WEB_CLIENT_ID}`, `auth.google ${GOOGLE_IOS_CLIENT_ID}`,
  // The iPhone app signs in with Google through @exact/oauth (below).
  'net.fetch https://accounts.google.com', 'net.fetch https://oauth2.googleapis.com', 'auth.session https://accounts.google.com',
  `auth.callback ${GOOGLE_IOS_CALLBACK}`, `secret.keep ${GOOGLE_NATIVE}`,
  // …and with Apple through Apple's web sign-in in the same sheet, answered by the server.
  'auth.session https://appleid.apple.com', `auth.callback ${APP_CALLBACK}`].join('\n');

type Reply = { ok: boolean; error: string };
// What an import answers: a Reply, and the new audiobook's id (`gen`; empty on failure), to open its player.
type Imported = Result<'importBook'>;
// What a picked file or a pasted link is, before it is imported (previewImport).
type ImportPreview = Result<'previewImport'>;
// A preview's cover goes inline as a data: URL; the app's image takes one up to 1 MiB, base64 included.
const PREVIEW_COVER_BYTES = 700 * 1024;
const COVER_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' } as const;
const base64 = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
type Audiobook = Result<'loadAudiobook'>;
type Kind = { kind?: string; code?: string };

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
const NO_AUDIOBOOK: Audiobook = { id: '', title: '', author: '', cover: '', by: '', voice: '', public: false,
  status: '', done: 0, total: 0, active: 0, error: '', chapters: [], mine: 0, limit: 0, owner: false };

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
      done: Number(g.done) || 0, total: Number(g.total) || 0, active: Number(g.active) || 0, error: str(g.error),
      public: g.public === true, voice: str(g.voice),
    }));
  },
  // One audiobook to play: a shared one, or the person's own private one (hence the session), its
  // chapters, and how many chapters this listener has narrating (of how many at once). Out of
  // reach, a downloaded one answers with the copy kept beside its chapters.
  loadAudiobook: async ([id], store, storage) => {
    if (!id) return NO_AUDIOBOOK;
    const res = await fetch(`${API}/generations/${encodeURIComponent(id)}`, { exactTimeout: 15000, headers: bearer(store) })
      .catch(async (e) => ({ kept: await keptVersion(id, storage, e) }));
    if ('kept' in res) return res.kept;
    const g = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(str(g.error) || `The server answered ${res.status}.`);
    return {
      id: str(g.id), title: str(g.title), author: str(g.author), cover: abs(str(g.cover)), by: str(g.by), voice: str(g.voice),
      public: g.public === true, status: str(g.status), done: Number(g.done) || 0, total: Number(g.total) || 0,
      active: Number(g.active) || 0, error: str(g.error), mine: Number(g.mine) || 0, limit: Number(g.limit) || 0, owner: g.owner === true,
      chapters: ((g.chapters ?? []) as Record<string, unknown>[]).map((c) => ({ idx: Number(c.idx) || 0, title: str(c.title), src: abs(str(c.src)),
        status: str(c.status), progress: Number(c.progress) || 0, error: str(c.error) })),
    };
  },
  // Narrate one chapter: anyone signed in may ask of a shared audiobook, its owner of a private one, a few at a time.
  generateChapter: async ([gen, idx], store): Promise<Reply> => {
    try {
      const res = await fetch(`${API}/generations/${encodeURIComponent(gen)}/chapters/${idx}`, { method: 'POST', exactTimeout: 15000, headers: bearer(store) });
      if (res.status === 401) {
        store.forget(SESSION);
        return { ok: false, error: 'Sign in again to narrate a chapter.' };
      }
      return res.ok ? { ok: true, error: '' } : { ok: false, error: await refusal(res) };
    } catch (e) {
      if ((e as Kind).code === 'bake') throw e;
      return { ok: false, error: UNREACHABLE };
    }
  },
  // What a picked file (`path`, named `name`) or a pasted `link` is, before it is imported: its
  // title, author, cover (a data: URL, or "") and chapter titles. A picked EPUB or TXT is read here,
  // as the server reads it (server/book.ts), in the time it takes to unzip; a PDF or a link goes to
  // the server, which keeps what it read for Generate (`token`).
  previewImport: async ([path, name, link], store, storage): Promise<ImportPreview> => {
    const none = (error: string): ImportPreview => ({ ok: false, error, title: '', author: '', cover: '', chapters: [], token: '' });
    // Nothing picked or pasted yet: nothing to ask.
    if (!path && !link) return none('');
    try {
      if (!link && /\.(epub|txt)$/i.test(name)) {
        const read = await storage.fs.readFile(path);
        const bytes = read instanceof Uint8Array ? read : new Uint8Array(read);
        try {
          const chapters = readBook(name, bytes);
          const meta = bookMeta(name, bytes);
          const cover = meta.cover && meta.cover.bytes.length <= PREVIEW_COVER_BYTES ? `data:${COVER_TYPES[meta.cover.ext]};base64,${base64(meta.cover.bytes)}` : '';
          return { ok: true, error: '', title: meta.title || name.replace(/\.[^.]*$/, '').trim() || 'Untitled', author: meta.author, cover,
            chapters: chapters.map((c) => c.title), token: '' };
        } catch (e) { return none(String((e as Error)?.message ?? e)); }
      }
      const query = new URLSearchParams(link ? { link } : { name });
      const res = await fetch(`${API}/audiobooks/preview?${query}`, {
        method: 'POST', exactTimeout: link ? 180000 : 120000, headers: { 'content-type': 'application/octet-stream', ...bearer(store) },
        ...(link ? {} : { exactBodyFrom: path }),
      });
      if (res.status === 401) {
        store.forget(SESSION);
        return none('Sign in again to import a book.');
      }
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; title?: string; author?: string; cover?: string; chapters?: unknown[]; token?: string };
      if (!res.ok || !body.ok) return none(body.error || 'The server had a problem. Try again.');
      return { ok: true, error: '', title: String(body.title ?? ''), author: String(body.author ?? ''), cover: String(body.cover ?? ''),
        chapters: (body.chapters ?? []).map(String), token: String(body.token ?? '') };
    } catch (e) {
      if ((e as Kind).code === 'bake') throw e;
      return none(UNREACHABLE);
    }
  },
  // An import: the preview's kept file (`token`), else the picked file sent from disk (its bytes
  // never enter JavaScript) or a pasted link the server downloads itself; what to make of it in the
  // query. A token the server no longer has (410) is followed by the file or link itself. The answer
  // carries the new audiobook's id (`gen`), to open its player.
  importBook: async ([path, name, link, model, voice, voiceName, title, author, share, rights, token], store, storage): Promise<Imported> => {
    if (!session(store)) return { ok: false, error: 'Sign in to import a book.', gen: '' };
    try {
      const send = (kept: string) => {
        const query = new URLSearchParams({ name, model, voice, voiceName, title, author, public: share ? '1' : '0', rights: rights ? '1' : '0',
          ...(kept ? { token: kept } : link ? { link } : {}) });
        return fetch(`${API}/audiobooks?${query}`, {
          method: 'POST', exactTimeout: link && !kept ? 180000 : 120000, headers: { 'content-type': 'application/octet-stream', ...bearer(store) },
          ...(kept || link ? {} : { exactBodyFrom: path }),
        });
      };
      let res = await send(token);
      if (token && res.status === 410) res = await send('');
      if (res.status === 401) {
        store.forget(SESSION);
        return { ok: false, error: 'Sign in again to import a book.', gen: '' };
      }
      if (!res.ok) return { ok: false, error: await refusal(res), gen: '' };
      const body = (await res.json().catch(() => ({}))) as { id?: unknown };
      return { ok: true, error: '', gen: String(body.id ?? '') };
    } catch (e) {
      if ((e as Kind).code === 'bake') throw e;
      return { ok: false, error: UNREACHABLE, gen: '' };
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
  // Downloads and the chapters asked for (below).
  loadOffline: (_a, _store, storage) => keptChapters(storage),
  downloadVersion: ([gen], store, storage) => downloadVersion(gen, store, storage),
  removeDownload: ([gen], _store, storage) => removeDownload(gen, storage),
  chaptersReady: ([keys], store, storage) => chaptersReady(keys, store, storage),
};

// Downloads. Each chapter is fetched straight into its file (`exactBodyTo`: the host writes the
// body as it arrives, whole or not at all), so a long chapter never passes through JavaScript.
// A private audiobook's audio addresses are signed for a few hours, so each download asks for
// the audiobook afresh first.
const extOf = (src: string) => /\.(\w{2,5})(?:[?#]|$)/.exec(src)?.[1] ?? 'm4a';
const missing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes(String((e as Kind)?.code));
const encoder = new TextEncoder(), decoder = new TextDecoder();
async function listDir(storage: Storage, path: string): Promise<string[]> {
  try { return await storage.fs.readdir(path); } catch (e) { if (missing(e)) return []; throw e; }
}
async function makeDir(storage: Storage, path: string) {
  try { await storage.fs.mkdir(path); } catch (e) { if ((e as Kind)?.code !== 'EEXIST') throw e; }
}
// An audiobook the server can't be reached for: the copy kept with its download, else the fetch's own failure.
async function keptVersion(id: string, storage: Storage, failure: unknown): Promise<Audiobook> {
  if ((failure as Kind)?.code === 'bake') throw failure;
  try { return JSON.parse(decoder.decode(await storage.fs.readFile(`${OFFLINE}/${id}/book.json`))) as Audiobook; } catch { throw failure; }
}
async function keptChapters(storage: Storage): Promise<Result<'loadOffline'>> {
  const kept: Result<'loadOffline'> = [];
  for (const gen of await listDir(storage, OFFLINE)) {
    for (const name of await listDir(storage, `${OFFLINE}/${gen}`)) {
      const m = /^(\d+)\.\w+$/.exec(name);
      if (m) kept.push({ gen, idx: Number(m[1]), path: `${OFFLINE}/${gen}/${name}` });
    }
  }
  return kept;
}
async function downloadVersion(gen: string, store: Store, storage: Storage): Promise<Reply> {
  try {
    const a = await sources.loadAudiobook([gen], store, storage);
    const dir = `${OFFLINE}/${gen}`;
    await makeDir(storage, OFFLINE);
    await makeDir(storage, dir);
    // The audiobook as it is now, first, so what's downloaded plays without a connection even if the rest doesn't land.
    await storage.fs.atomicWriteFile(`${dir}/book.json`, encoder.encode(JSON.stringify(a)));
    const have = new Set(await listDir(storage, dir));
    for (const c of a.chapters) {
      const name = `${c.idx}.${extOf(c.src)}`;
      // Only a chapter narrated in full: one still narrating answers a live stream at the same address.
      if (!c.src || c.status !== 'ready' || have.has(name)) continue;
      const res = await fetch(c.src, { exactBodyTo: `${dir}/${name}`, exactTimeout: 900000 });
      if (!res.ok) return { ok: false, error: `Chapter ${c.idx + 1} didn’t download. Try again.` };
    }
    return { ok: true, error: '' };
  } catch (e) {
    if ((e as Kind)?.code === 'bake') throw e;
    return { ok: false, error: (e as Kind)?.code === 'full' || /space|quota/i.test(String((e as Error)?.message))
      ? 'There isn’t room on this device for the download.' : 'The download stopped. Check the connection, then try again.' };
  }
}
async function removeDownload(gen: string, storage: Storage): Promise<Reply> {
  const dir = `${OFFLINE}/${gen}`;
  try {
    for (const name of await listDir(storage, dir)) await storage.fs.rm(`${dir}/${name}`).catch((e) => { if (!missing(e)) throw e; });
    await storage.fs.rm(dir).catch((e) => { if (!missing(e)) throw e; });
    return { ok: true, error: '' };
  } catch (e) {
    if ((e as Kind)?.code === 'bake') throw e;
    return { ok: false, error: 'The download couldn’t be removed. Try again.' };
  }
}
// The chapters this listener asked for ("gen/idx", comma-separated) that can be heard now (a chapter
// plays from its first narrated part), failed, or went with their audiobook. Ones not started yet, or
// out of reach, are left for later (a copy kept offline may be old, so only what can't change counts).
async function chaptersReady(keys: string, store: Store, storage: Storage): Promise<Result<'chaptersReady'>> {
  const asked = keys.split(',').filter(Boolean).map((key) => ({ key, gen: key.split('/')[0], idx: Number(key.split('/')[1]) }));
  const done: Result<'chaptersReady'> = [];
  for (const gen of [...new Set(asked.map((a) => a.gen))]) {
    let a: Audiobook | null = null;
    try { a = await sources.loadAudiobook([gen], store, storage); } catch (e) {
      if ((e as Kind)?.code === 'bake') throw e;
      if ((e as Kind)?.kind) continue;
    }
    for (const k of asked.filter((x) => x.gen === gen)) {
      const c = a?.chapters.find((x) => x.idx === k.idx);
      if (!a || !c) done.push({ key: k.key, gen, idx: k.idx, title: '', book: a?.title ?? '', status: 'gone' });
      else if (c.src || ['ready', 'failed', 'unavailable'].includes(c.status)) done.push({ key: k.key, gen, idx: k.idx, title: c.title, book: a.title, status: c.src ? 'ready' : c.status });
    }
  }
  return done;
}
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
