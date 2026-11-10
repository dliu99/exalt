// Exalt's server: the shared catalog, uploads, and the audiobooks made from them.
// `bun server/index.ts` for development; `--offline` (what tests run) answers search from a
// fixture and voices with silence, so nothing reaches the network.
import { createHash } from 'node:crypto';
import { join as pathJoin, normalize } from 'node:path';
import { API, CLIENTS } from './config.ts';
import { auth, type Provider } from './auth.ts';
import { consolidate, ensureBook, isProvider, providerName, search } from './catalog.ts';
import { booksWithAudio, db, generationsBy, generationsOf, getGeneration, readyCounts, tracksOf, type BookRow, type GenerationRow } from './db.ts';
import { AUDIO_DIR, enqueue, reserve, failJob, QueueFull } from './jobs.ts';
import { parseBook } from './parse.ts';
import { listModels } from './tts.ts';
import { lg } from './libgen.ts';
import { audioURL, validateAudioFile } from './storage.ts';
import { zlib } from './zlibrary.ts';
import { listVoices } from './fish.ts';

let uploading = 0;
const OFFLINE = process.argv.includes('--offline');
consolidate();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, range, authorization', 'access-control-allow-methods': 'GET, POST', 'access-control-expose-headers': 'content-range, accept-ranges, content-length' };
const send = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const preflight = () => new Response(null, { status: 204, headers: CORS });
const fail = (e: unknown, status = 502) => send({ error: String((e as Error).message ?? e) }, status);
const json = (req: Request) => req.json().catch(() => ({})) as Promise<Record<string, any>>;

// Accounts (auth.ts). Under --offline with SIGN_IN_TEST_KEYS, exact's fixture provider stands in
// for Apple and Google, so tests and drives sign in with no network.
const testKeys = OFFLINE ? process.env.SIGN_IN_TEST_KEYS : undefined;
const idp = testKeys ? await import(pathJoin(process.env.EXACT2 ?? pathJoin(import.meta.dir, '../../exact'), 'packages/sign-in/test/idp.mjs')) : null;
const accounts = auth({
  audiences: { apple: [CLIENTS.appId, CLIENTS.appleWeb], google: [CLIENTS.googleWeb, CLIENTS.googleIos] },
  publicUrl: process.env.PUBLIC_URL ?? API,
  webOrigins: (process.env.WEB_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  googleSecret: process.env.GOOGLE_CLIENT_SECRET,
  ...(idp ? { keys: async (_p: Provider) => (await idp.jwks(testKeys)).keys, exchange: (code: string) => idp.exchange(testKeys, code) } : {}),
});
const signInRequired = () => send({ error: 'Sign in to make an audiobook.' }, 401);

const back = (r: { status: number; location?: string; body?: string }) =>
  r.location ? new Response(null, { status: r.status, headers: { location: r.location } }) : new Response(r.body ?? '', { status: r.status });
const bookJson = (b: BookRow, versions: number) => ({ id: b.id, title: b.title, author: b.author, year: b.year, cover: b.cover, description: b.description, versions });
const versionJson = (g: GenerationRow) => {
  const first = tracksOf(g.id)[0];
  return { id: String(g.id), by: g.made_by, model: g.model, voice: g.voice, status: g.status, done: g.done, total: g.total, error: g.error,
    sample: first ? `/audio/${first.file}` : '', voiceName: g.voice_name ?? '' };
};

// Locally the server listens where the app looks for it (API_BASE_URL); a host such as Render
// says where instead (HOST, PORT), the public address being its proxy's.
const listen = new URL(API);
const hostname = process.env.HOST ?? listen.hostname, port = Number(process.env.PORT ?? listen.port);
const server = Bun.serve({ hostname, port, maxRequestBodySize: 50 * 1024 * 1024, routes: {
  '/health': () => new Response('ok'),

  '/sign-in/nonce': { OPTIONS: preflight, POST: async (req) => send(accounts.nonce(await json(req))) },
  '/sign-in/identity': { OPTIONS: preflight, POST: async (req) => {
    try { return send(await accounts.identity(await json(req))); } catch (e) { return fail(e); }
  } },
  // The web's return: Google redirects here (GET), Apple posts a form (POST).
  '/sign-in/return': {
    GET: async (req) => back(await accounts.back('GET', Object.fromEntries(new URL(req.url).searchParams))),
    POST: async (req) => {
      const form = await req.formData().catch(() => null);
      return back(await accounts.back('POST', Object.fromEntries([...(form?.entries() ?? [])].map(([k, v]) => [k, String(v)]))));
    },
  },
  '/me': { OPTIONS: preflight, GET: (req) => {
    const me = accounts.user(req);
    return me ? send({ name: me.name, email: me.email }) : send({ error: 'Not signed in.' }, 401);
  } },
  // The audiobooks the signed-in person has made, with their books.
  '/me/audiobooks': { OPTIONS: preflight, GET: (req) => {
    const me = accounts.user(req);
    if (!me) return send({ error: 'Not signed in.' }, 401);
    return send(generationsBy(me.id).map((g) => ({ ...versionJson(g), book: g.book_id, title: g.title, author: g.author, cover: g.cover })));
  } },
  '/sign-out': { OPTIONS: preflight, POST: (req) => { accounts.signOut(req); return send({ ok: true }); } },

  '/search': { OPTIONS: preflight, GET: async (req) => {
    const params = new URL(req.url).searchParams;
    const q = params.get('q')?.trim() ?? '', provider = params.get('provider') ?? providerName;
    // Suggestions under the field ask for a few (`limit`); the results page for all.
    const limit = Math.min(25, Math.max(1, Number(params.get('limit')) || 25));
    if (!q) return send([]);
    if (!isProvider(provider)) return send({ error: `No book provider called ${provider}.` }, 400);
    try {
      const found = await search(q, OFFLINE, provider);
      const counts = readyCounts(found.map((b) => b.id));
      return send(found.slice(0, limit).map((b) => bookJson(b, counts.get(b.id) ?? 0)));
    } catch (e) { return fail(e); }
  } },

  '/listening': { OPTIONS: preflight, GET: () => send(booksWithAudio().map((b) => bookJson(b, b.versions))) },

  '/models': { OPTIONS: preflight, GET: async () => {
    try { return send(await listModels(OFFLINE)); } catch (e) { return fail(e); }
  } },

  // Fish Audio's library of voices to choose from (read through OpenRouter's Fish models).
  '/voices': { OPTIONS: preflight, GET: async (req) => {
    try { return send(await listVoices(new URL(req.url).searchParams.get('q') ?? '', OFFLINE)); } catch (e) { return fail(e); }
  } },

  '/books/:id': { OPTIONS: preflight, GET: async (req) => {
    try {
      const book = await ensureBook(req.params.id, OFFLINE);
      if (!book) return send({ error: 'No such book.' }, 404);
      const versions = generationsOf(book.id);
      // Asked for under an edition's id, the page keeps that id; everything it shows is the book's.
      return send({ book: { ...bookJson(book, versions.filter((v) => v.status === 'ready').length), id: req.params.id }, versions: versions.map(versionJson) });
    } catch (e) { return fail(e); }
  } },

  '/books/:id/sources': { OPTIONS: preflight, GET: async (req) => {
    try {
      const book = await ensureBook(req.params.id, OFFLINE);
      if (!book) return send({ error: 'No such book.' }, 404);
      if (OFFLINE) return send({ available: true, files: book.id === 'OL1W' ? [{ id: 'lg-00000000000000000000000000000001', label: 'LibGen · A Quiet Harbour · EPUB · English' }] : [] });
      const providers = [
        ...(lg.enabled ? [{ name: 'LibGen', api: lg, owns: /^lg-[a-f0-9]{32}$/ }] : []),
        ...(zlib.configured ? [{ name: 'Z-Library', api: zlib, owns: /^zl-\d+-[a-zA-Z0-9]+$/ }] : []),
      ];
      if (!providers.length) return send({ available: false, files: [] });
      const results = await Promise.allSettled(providers.map(async (p) => {
        const [matches, selected] = await Promise.all([
          p.api.search(`${book.title} ${book.author}`),
          p.owns.test(req.params.id) ? p.api.book(req.params.id) : Promise.resolve(null),
        ]);
        return [...new Map([...(selected ? [selected] : []), ...matches].map((f) => [f.id, f])).values()]
          .map((f) => ({ ...f, title: `${p.name} · ${f.title}` }));
      }));
      if (results.every((r) => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
      const files = results.flatMap((r) => r.status === 'fulfilled' ? r.value : [])
        .sort((a, b) => Number(b.extension === 'epub') - Number(a.extension === 'epub'));
      return send({ available: true, files: files.map((f) => ({ id: f.id, label: [f.title, f.author, f.extension.toUpperCase(), f.language, f.size].filter(Boolean).join(' · ') })) });
    } catch (e) { return fail(e); }
  } },

  // The upload is the request body; what to make of it is in the query.
  '/books/:id/generations': { OPTIONS: preflight, POST: async (req) => {
    const me = accounts.user(req);
    if (!me) return signInRequired();
    const q = new URL(req.url).searchParams;
    let name = q.get('name') ?? '';
    const source = q.get('source') ?? '';
    if (source) server.timeout(req, 180);
    const model = q.get('model') ?? '', voice = q.get('voice') ?? '', voiceName = (q.get('voiceName') ?? '').slice(0, 80);
    const by = q.get('by')?.trim() || me.name || me.email.split('@')[0] || 'Anonymous';
    if (q.get('rights') !== '1') return send({ error: 'Confirm you have the right to share an audiobook of this file.' }, 400);
    if (!model) return send({ error: 'Choose a voice model.' }, 400);
    if (model.length > 120 || voice.length > 200 || !(await listModels(OFFLINE)).some((m) => m.id === model)) return send({ error: 'Choose one of the available voice models.' }, 400);
    const book = await ensureBook(req.params.id, OFFLINE).catch(() => null);
    if (!book) return send({ error: 'No such book.' }, 404);
    if (source && !/^lg-[a-f0-9]{32}$/.test(source) && !/^zl-\d+-[a-zA-Z0-9]+$/.test(source)) return send({ error: 'Invalid book source.' }, 400);
    if (!OFFLINE && ((source.startsWith('lg-') && !lg.enabled) || (source.startsWith('zl-') && !zlib.configured))) return send({ error: 'This book source is not connected.' }, 400);
    if (OFFLINE && source && (source !== 'lg-00000000000000000000000000000001' || book.id !== 'OL1W')) return send({ error: 'No such source.' }, 400);
    let admitted;
    try {
      admitted = reserve({ book: book.id, user: me.id, by, model, voice, voiceName, name, source });
      if (admitted.reused) return send({ ok: true, id: String(admitted.id), reused: true });
      if (source) {
        enqueue(admitted.id, { source, ...(OFFLINE ? { offline: true } : {}) });
      } else {
        // At most two uploads parse concurrently in this one-process deployment.
        if (uploading >= 2) throw new QueueFull('Uploads are busy. Try again shortly.');
        uploading++;
        try {
          const bytes = new Uint8Array(await req.arrayBuffer());
          const chapters = await parseBook(name, bytes);
          db.query('UPDATE generations SET source_hash = ? WHERE id = ?').run(createHash('sha256').update(bytes).digest('hex'), admitted.id);
          enqueue(admitted.id, { chapters });
        } finally { uploading--; }
      }
      return send({ ok: true, id: String(admitted.id) }, 202);
    } catch (e) {
      if (admitted && !admitted.reused) failJob(admitted.id, e);
      return fail(e, e instanceof QueueFull ? 429 : 400);
    }
  } },

  '/generations/:id': { OPTIONS: preflight, GET: (req) => {
    const g = getGeneration(Number(req.params.id));
    if (!g) return send({ error: 'No such audiobook.' }, 404);
    const book = db.query('SELECT * FROM books WHERE id = ?').get(g.book_id) as BookRow;
    return send({ ...versionJson(g), book: bookJson(book, 0), tracks: tracksOf(g.id).map((t) => ({ idx: t.idx, title: t.title, src: `/audio/${t.file}` })) });
  } },

  // Audio files with byte ranges, so players can seek and stream.
  '/audio/*': async (req) => {
    if (req.method === 'OPTIONS') return preflight();
    const rel = normalize(decodeURIComponent(new URL(req.url).pathname.slice('/audio/'.length)));
    if (rel.startsWith('..') || rel.startsWith('/')) return new Response('Not found', { status: 404 });
    try { validateAudioFile(rel); } catch { return send({ error: 'No such audio.' }, 404); }
    const track = db.query('SELECT storage FROM tracks WHERE file = ? LIMIT 1').get(rel) as { storage: string } | null;
    if (!track) return send({ error: 'No such audio.' }, 404);
    if (track.storage === 's3') {
      try { return new Response(null, { status: 302, headers: { ...CORS, location: audioURL(rel), 'cache-control': 'no-store' } }); }
      catch (e) { return fail(e, 503); }
    }
    const file = Bun.file(pathJoin(AUDIO_DIR, rel));
    if (!(await file.exists())) return new Response('Not found', { status: 404, headers: CORS });
    const type = rel.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
    const common = { ...CORS, 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=3600' };
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
} });
console.log(`server/index.ts: http://${hostname}:${server.port}${OFFLINE ? ' (offline)' : ` (books from ${providerName})`}`);
