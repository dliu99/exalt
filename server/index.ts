// Exalt's server: a signed-in person imports their own EPUB, PDF or TXT, the server narrates it,
// and the audiobook joins their library, shared in the public Browse feed unless they keep it
// private. `bun server/index.ts` for development; `--offline` (what tests run) voices with
// silence, so nothing reaches the network.
import { createHash, randomBytes } from 'node:crypto';
import { join as pathJoin, normalize } from 'node:path';
import { API, CLIENTS } from './config.ts';
import { auth, type Provider } from './auth.ts';
import { browse, db, generationsBy, getAudiobook, getBook, getGeneration, tracksOf, type AudiobookRow } from './db.ts';
import { AUDIO_DIR, enqueue, reserve, removeAudiobook, QueueFull } from './jobs.ts';
import { bookMeta, parseBook } from './parse.ts';
import { listModels } from './tts.ts';
import { audioType, audioURL, coverPath, coverType, coverURL, saveCover, validateAudioFile, validateCoverFile } from './storage.ts';
import { listVoices } from './fish.ts';
import { keepPlace, placeFrom, placeJson, placesOf, type PlaceRow } from './places.ts';
import { sign, signed } from './signing.ts';

let uploading = 0;
const OFFLINE = process.argv.includes('--offline');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, range, authorization', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE', 'access-control-expose-headers': 'content-range, accept-ranges, content-length' };
const send = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const preflight = () => new Response(null, { status: 204, headers: CORS });
const fail = (e: unknown, status = 502) => send({ error: String((e as Error).message ?? e) }, status);
const json = (req: Request) => req.json().catch(() => ({})) as Promise<Record<string, any>>;
const RIGHTS = 'Confirm you may share this book publicly.';

// Accounts (auth.ts). Under --offline with SIGN_IN_TEST_KEYS, exact's fixture provider stands in
// for Apple and Google, so tests and drives sign in with no network.
const testKeys = OFFLINE ? process.env.SIGN_IN_TEST_KEYS : undefined;
const idp = testKeys ? await import(pathJoin(process.env.EXACT2 ?? pathJoin(import.meta.dir, '../../exact'), 'packages/sign-in/test/idp.mjs')) : null;
const accounts = auth({
  audiences: { apple: [CLIENTS.appId, CLIENTS.appleWeb], google: [CLIENTS.googleWeb, CLIENTS.googleIos] },
  publicUrl: process.env.PUBLIC_URL ?? API,
  webOrigins: (process.env.WEB_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  appCallbacks: [CLIENTS.appCallback],
  googleSecret: process.env.GOOGLE_CLIENT_SECRET,
  ...(idp ? { keys: async (_p: Provider) => (await idp.jwks(testKeys)).keys, exchange: (code: string) => idp.exchange(testKeys, code) } : {}),
});
const signedOut = () => send({ error: 'Not signed in.' }, 401);
const noSuch = () => send({ error: 'No such audiobook.' }, 404);

const back = (r: { status: number; location?: string; body?: string }) =>
  r.location ? new Response(null, { status: r.status, headers: { location: r.location } }) : new Response(r.body ?? '', { status: r.status });

// A private audiobook's cover and audio go out signed (signing.ts); a public one's as they are.
const coverOf = (g: { cover: string; public: number }) => (g.public ? g.cover : sign(g.cover));
const voiceOf = (g: AudiobookRow) => g.voice_name || g.model;
const mineJson = (g: AudiobookRow) => ({ id: String(g.id), title: g.title, author: g.author, cover: coverOf(g), status: g.status,
  done: g.done, total: g.total, error: g.error, public: g.public === 1, voice: voiceOf(g), created: g.created_at });
const placeOut = (r: PlaceRow) => placeJson(r, coverOf(r));
// The person's own audiobook, or null (someone else's answers the same as none).
const owned = (req: Request & { params: Record<string, string> }) => {
  const me = accounts.user(req), id = Number(req.params.id);
  const g = me && Number.isSafeInteger(id) ? getAudiobook(id) : null;
  return { me, g: g && g.user_id === me!.id ? g : null };
};
const newBookId = () => `up-${randomBytes(8).toString('hex')}`;

// Locally the server listens where the app looks for it (API_BASE_URL); a host such as Render
// says where instead (HOST, PORT), the public address being its proxy's.
const listen = new URL(API);
const hostname = process.env.HOST ?? listen.hostname, port = Number(process.env.PORT ?? listen.port);
const DEV_SIGN_IN = process.env.DEV_SIGN_IN === '1' && /^(127\.0\.0\.1|localhost|::1)$/.test(hostname);
if (process.env.DEV_SIGN_IN === '1' && !DEV_SIGN_IN) console.warn('DEV_SIGN_IN ignored: the server is not on a loopback address.');
const server = Bun.serve({ hostname, port, maxRequestBodySize: 50 * 1024 * 1024, routes: {
  '/health': () => new Response('ok'),

  // Skipping sign-in while developing: DEV_SIGN_IN=1 on a server listening on loopback only; otherwise no such route.
  '/sign-in/dev': { OPTIONS: preflight, POST: () => (DEV_SIGN_IN ? send(accounts.dev()) : send({ error: 'Not found.' }, 404)) },
  '/sign-in/nonce': { OPTIONS: preflight, POST: async (req) => send(accounts.nonce(await json(req))) },
  '/sign-in/identity': { OPTIONS: preflight, POST: async (req) => {
    try { return send(await accounts.identity(await json(req))); } catch (e) { return fail(e); }
  } },
  // The web's return: Google redirects here (GET), Apple posts a form (POST).
  '/sign-in/google': { OPTIONS: preflight, POST: async (req) => {
    try { return send(await accounts.google(req)); } catch (e) { return fail(e); }
  } },
  '/sign-in/return': {
    GET: async (req) => back(await accounts.back('GET', Object.fromEntries(new URL(req.url).searchParams))),
    POST: async (req) => {
      const form = await req.formData().catch(() => null);
      return back(await accounts.back('POST', Object.fromEntries([...(form?.entries() ?? [])].map(([k, v]) => [k, String(v)]))));
    },
  },
  // Whether the app asks for an account before anything else: not offline, where no provider can answer.
  '/door': { OPTIONS: preflight, GET: () => send({ required: !OFFLINE }) },
  '/me': { OPTIONS: preflight, GET: (req) => {
    const me = accounts.user(req);
    return me ? send({ name: me.name, email: me.email }) : signedOut();
  } },
  '/sign-out': { OPTIONS: preflight, POST: (req) => { accounts.signOut(req); return send({ ok: true }); } },

  // The signed-in person's library: everything they have imported, finished or not.
  '/me/audiobooks': { OPTIONS: preflight, GET: (req) => {
    const me = accounts.user(req);
    return me ? send(generationsBy(me.id).map(mineJson)) : signedOut();
  } },
  // Share or unshare one, or correct its title and author.
  '/me/audiobooks/:id': { OPTIONS: preflight,
    PATCH: async (req) => {
      const { me, g } = owned(req);
      if (!me) return signedOut();
      if (!g) return noSuch();
      const body = await json(req);
      if ('public' in body && typeof body.public !== 'boolean') return send({ error: 'Say whether to share this audiobook.' }, 400);
      if (body.public === true && !g.public && body.rights !== true) return send({ error: RIGHTS }, 400);
      const title = typeof body.title === 'string' ? body.title.trim() : undefined;
      const author = typeof body.author === 'string' ? body.author.trim() : undefined;
      if (title !== undefined && !title) return send({ error: 'Give the audiobook a title.' }, 400);
      if ((title?.length ?? 0) > 200 || (author?.length ?? 0) > 200) return send({ error: 'Titles and authors are at most 200 characters.' }, 400);
      db.transaction(() => {
        if (typeof body.public === 'boolean') db.query('UPDATE generations SET public = ? WHERE id = ?').run(body.public ? 1 : 0, g.id);
        if (title === undefined && author === undefined) return;
        // A book an older audiobook shares (the retired catalog's) is copied first, so only this one changes.
        let bookId = g.book_id;
        if (db.query('SELECT 1 FROM generations WHERE book_id = ? AND id != ? LIMIT 1').get(bookId, g.id)) {
          const book = getBook(bookId)!;
          bookId = newBookId();
          db.query('INSERT INTO books (id, title, author, year, cover, description) VALUES (?, ?, ?, ?, ?, ?)').run(bookId, book.title, book.author, book.year, book.cover, book.description);
          db.query('UPDATE generations SET book_id = ? WHERE id = ?').run(bookId, g.id);
        }
        if (title !== undefined) db.query('UPDATE books SET title = ? WHERE id = ?').run(title, bookId);
        if (author !== undefined) db.query('UPDATE books SET author = ? WHERE id = ?').run(author, bookId);
      })();
      return send(mineJson(getAudiobook(g.id)!));
    },
    // Gone for good, even mid-narration: the worker stops at its next chunk (jobs.ts).
    DELETE: async (req) => {
      const { me, g } = owned(req);
      if (!me) return signedOut();
      if (!g) return noSuch();
      await removeAudiobook(g.id);
      return send({ ok: true });
    },
  },
  // Where the signed-in person is in each audiobook (places.ts), so their devices carry over.
  '/me/places': { OPTIONS: preflight, GET: (req) => {
    const me = accounts.user(req);
    return me ? send(placesOf(me.id).map(placeOut)) : signedOut();
  } },
  // One place, kept unless the server already has a newer one; answers whichever it keeps.
  '/me/places/:gen': { OPTIONS: preflight, PUT: async (req) => {
    const me = accounts.user(req);
    if (!me) return signedOut();
    const gen = Number(req.params.gen);
    const g = Number.isSafeInteger(gen) ? getGeneration(gen) : null;
    if (!g || (!g.public && g.user_id !== me.id)) return noSuch();
    const place = placeFrom(await json(req));
    if (!place) return send({ error: 'Not a place in this audiobook.' }, 400);
    return send(placeOut(keepPlace(me.id, gen, place)));
  } },

  // Everyone's shared, finished audiobooks, newest first; `q` narrows to a title or author.
  '/browse': { OPTIONS: preflight, GET: (req) => {
    const q = (new URL(req.url).searchParams.get('q') ?? '').trim().slice(0, 200);
    return send(browse(q).map((g) => ({ id: String(g.id), title: g.title, author: g.author, cover: g.cover, by: g.made_by,
      voice: voiceOf(g), chapters: g.total, created: g.created_at })));
  } },

  '/models': { OPTIONS: preflight, GET: async () => {
    try { return send(await listModels(OFFLINE)); } catch (e) { return fail(e); }
  } },

  // Fish Audio's library of voices to choose from (read through OpenRouter's Fish models).
  '/voices': { OPTIONS: preflight, GET: async (req) => {
    try { return send(await listVoices(new URL(req.url).searchParams.get('q') ?? '', OFFLINE)); } catch (e) { return fail(e); }
  } },

  // An import: the file is the request body; what to make of it is in the query. Each import is
  // its own book, titled from the EPUB's metadata or the file's name unless the query names it.
  '/audiobooks': { OPTIONS: preflight, POST: async (req) => {
    const me = accounts.user(req);
    if (!me) return send({ error: 'Sign in to make an audiobook.' }, 401);
    const q = new URL(req.url).searchParams;
    const name = (q.get('name') ?? '').trim();
    const model = q.get('model') ?? '', voice = q.get('voice') ?? '', voiceName = (q.get('voiceName') ?? '').slice(0, 80);
    const by = q.get('by')?.trim() || me.name || me.email.split('@')[0] || 'Anonymous';
    const isPublic = q.get('public') !== '0';
    if (isPublic && q.get('rights') !== '1') return send({ error: RIGHTS }, 400);
    if (!model) return send({ error: 'Choose a voice model.' }, 400);
    if (model.length > 120 || voice.length > 200 || !(await listModels(OFFLINE)).some((m) => m.id === model)) return send({ error: 'Choose one of the available voice models.' }, 400);
    const bookId = newBookId();
    let id: number | undefined;
    try {
      id = reserve({ book: bookId, user: me.id, by, model, voice, voiceName, name, public: isPublic });
      // At most two uploads parse concurrently in this one-process deployment.
      if (uploading >= 2) throw new QueueFull('Uploads are busy. Try again shortly.');
      uploading++;
      try {
        const bytes = new Uint8Array(await req.arrayBuffer());
        const chapters = await parseBook(name, bytes);
        const meta = bookMeta(name, bytes);
        const title = (q.get('title')?.trim() || meta.title || name.replace(/\.[^.]*$/, '').trim() || 'Untitled').slice(0, 200);
        const author = (q.get('author')?.trim() || meta.author).slice(0, 200);
        let cover = '';
        if (meta.cover) {
          const file = `${bookId}.${meta.cover.ext}`;
          // A cover that can't be stored leaves the book without one, not the import failed.
          try { await saveCover(file, meta.cover.bytes); cover = `/covers/${file}`; } catch (e) { console.error(`cover ${file}: ${(e as Error).message}`); }
        }
        db.transaction(() => {
          db.query("INSERT INTO books (id, title, author, year, cover, description) VALUES (?, ?, ?, 0, ?, '')").run(bookId, title, author, cover);
          db.query('UPDATE generations SET source_hash = ? WHERE id = ?').run(createHash('sha256').update(bytes).digest('hex'), id!);
        })();
        enqueue(id, { chapters });
      } finally { uploading--; }
      return send({ ok: true, id: String(id) }, 202);
    } catch (e) {
      // A refused import leaves nothing behind; the answer says why.
      if (id !== undefined) await removeAudiobook(id).catch(() => {});
      return fail(e, e instanceof QueueFull ? 429 : 400);
    }
  } },

  // One audiobook to play: anyone's shared one, or the signed-in person's own private one.
  '/generations/:id': { OPTIONS: preflight, GET: (req) => {
    const id = Number(req.params.id);
    const g = Number.isSafeInteger(id) ? getAudiobook(id) : null;
    if (!g) return noSuch();
    if (!g.public && (!g.user_id || accounts.user(req)?.id !== g.user_id)) return noSuch();
    const src = (file: string) => (g.public ? `/audio/${file}` : sign(`/audio/${file}`));
    return send({ id: String(g.id), title: g.title, author: g.author, cover: coverOf(g), by: g.made_by, voice: voiceOf(g),
      public: g.public === 1, status: g.status, done: g.done, total: g.total, error: g.error,
      tracks: tracksOf(g.id).map((t) => ({ idx: t.idx, title: t.title, src: src(t.file) })) });
  } },

  // Audio files with byte ranges, so players can seek and stream; a private audiobook's only signed.
  '/audio/*': async (req) => {
    if (req.method === 'OPTIONS') return preflight();
    const url = new URL(req.url);
    const rel = normalize(decodeURIComponent(url.pathname.slice('/audio/'.length)));
    if (rel.startsWith('..') || rel.startsWith('/')) return new Response('Not found', { status: 404 });
    try { validateAudioFile(rel); } catch { return send({ error: 'No such audio.' }, 404); }
    const track = db.query('SELECT t.storage, g.public FROM tracks t JOIN generations g ON g.id = t.generation_id WHERE t.file = ? LIMIT 1').get(rel) as { storage: string; public: number } | null;
    if (!track || (!track.public && !signed(`/audio/${rel}`, url.searchParams))) return send({ error: 'No such audio.' }, 404);
    const cache = track.public ? 'public, max-age=3600' : 'private, max-age=3600';
    if (track.storage === 's3') {
      try { return new Response(null, { status: 302, headers: { ...CORS, location: audioURL(rel), 'cache-control': 'no-store' } }); }
      catch (e) { return fail(e, 503); }
    }
    const file = Bun.file(pathJoin(AUDIO_DIR, rel));
    if (!(await file.exists())) return new Response('Not found', { status: 404, headers: CORS });
    const common = { ...CORS, 'content-type': audioType(rel), 'accept-ranges': 'bytes', 'cache-control': cache };
    const rangeHeader = req.headers.get('range');
    if (!rangeHeader) return new Response(file, { headers: common });
    const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    const size = file.size;
    if (!range || (!range[1] && !range[2])) return new Response(null, { status: 416, headers: { ...CORS, 'content-range': `bytes */${size}` } });
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start < 0 || start > end) return new Response(null, { status: 416, headers: { ...CORS, 'content-range': `bytes */${size}` } });
    return new Response(file.slice(start, end + 1), { status: 206, headers: { ...common, 'content-range': `bytes ${start}-${end}/${size}` } });
  },

  // An import's cover; signed only when every audiobook with it is private.
  '/covers/*': async (req) => {
    if (req.method === 'OPTIONS') return preflight();
    const url = new URL(req.url);
    const key = url.pathname.slice('/covers/'.length);
    try { validateCoverFile(key); } catch { return send({ error: 'No such cover.' }, 404); }
    const path = `/covers/${key}`;
    const seen = db.query('SELECT MAX(g.public) AS open, COUNT(*) AS n FROM books b JOIN generations g ON g.book_id = b.id WHERE b.cover = ?').get(path) as { open: number | null; n: number };
    if (!seen.n || (!seen.open && !signed(path, url.searchParams))) return send({ error: 'No such cover.' }, 404);
    const file = Bun.file(coverPath(key));
    if (await file.exists()) return new Response(file, { headers: { ...CORS, 'content-type': coverType(key), 'cache-control': seen.open ? 'public, max-age=86400' : 'private, max-age=3600' } });
    const remote = coverURL(key);
    if (remote) return new Response(null, { status: 302, headers: { ...CORS, location: remote, 'cache-control': 'no-store' } });
    return send({ error: 'No such cover.' }, 404);
  },
} });
console.log(`server/index.ts: http://${hostname}:${server.port}${OFFLINE ? ' (offline)' : ''}`);
