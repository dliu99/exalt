// Exalt's server: the shared catalog, uploads, and the audiobooks made from them.
// `bun server/index.ts` for development; `--offline` (what tests run) answers search from a
// fixture and voices with silence, so nothing reaches the network.
import { join as pathJoin, normalize } from 'node:path';
import { API } from '../app.ts';
import { consolidate, ensureBook, isProvider, providerName, search } from './catalog.ts';
import { booksWithAudio, db, generationsOf, getGeneration, readyCounts, tracksOf, type BookRow, type GenerationRow } from './db.ts';
import { AUDIO_DIR, enqueue } from './jobs.ts';
import { parseBook } from './parse.ts';
import { listModels } from './tts.ts';

const OFFLINE = process.argv.includes('--offline');
consolidate();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, range', 'access-control-allow-methods': 'GET, POST', 'access-control-expose-headers': 'content-range, accept-ranges, content-length' };
const send = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const preflight = () => new Response(null, { status: 204, headers: CORS });
const fail = (e: unknown, status = 502) => send({ error: String((e as Error).message ?? e) }, status);

const bookJson = (b: BookRow, versions: number) => ({ id: b.id, title: b.title, author: b.author, year: b.year, cover: b.cover, description: b.description, versions });
const versionJson = (g: GenerationRow) => {
  const first = tracksOf(g.id)[0];
  return { id: String(g.id), by: g.made_by, model: g.model, voice: g.voice, status: g.status, done: g.done, total: g.total, error: g.error,
    sample: first ? `/audio/${first.file}` : '' };
};

// Locally the server listens where the app looks for it (API_BASE_URL); a host such as Render
// says where instead (HOST, PORT), the public address being its proxy's.
const listen = new URL(API);
const hostname = process.env.HOST ?? listen.hostname, port = Number(process.env.PORT ?? listen.port);
Bun.serve({ hostname, port, maxRequestBodySize: 200 * 1024 * 1024, routes: {
  '/health': () => new Response('ok'),

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

  '/books/:id': { OPTIONS: preflight, GET: async (req) => {
    try {
      const book = await ensureBook(req.params.id, OFFLINE);
      if (!book) return send({ error: 'No such book.' }, 404);
      const versions = generationsOf(book.id);
      // Asked for under an edition's id, the page keeps that id; everything it shows is the book's.
      return send({ book: { ...bookJson(book, versions.filter((v) => v.status === 'ready').length), id: req.params.id }, versions: versions.map(versionJson) });
    } catch (e) { return fail(e); }
  } },

  // The upload is the request body; what to make of it is in the query.
  '/books/:id/generations': { OPTIONS: preflight, POST: async (req) => {
    const q = new URL(req.url).searchParams;
    const name = q.get('name') ?? '', model = q.get('model') ?? '', voice = q.get('voice') ?? '', by = q.get('by')?.trim() || 'Anonymous';
    if (q.get('rights') !== '1') return send({ error: 'Confirm you have the right to share an audiobook of this file.' }, 400);
    if (!model) return send({ error: 'Choose a voice model.' }, 400);
    const book = await ensureBook(req.params.id, OFFLINE).catch(() => null);
    if (!book) return send({ error: 'No such book.' }, 404);
    let chapters;
    try { chapters = await parseBook(name, new Uint8Array(await req.arrayBuffer())); } catch (e) { return fail(e, 400); }
    const { lastInsertRowid } = db.query(`INSERT INTO generations (book_id, made_by, model, voice, source_name, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?)`).run(book.id, by.slice(0, 40), model, voice, name, Date.now());
    enqueue({ id: Number(lastInsertRowid), model, voice, chapters });
    return send({ ok: true, id: String(lastInsertRowid) }, 201);
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
    const file = Bun.file(pathJoin(AUDIO_DIR, rel));
    if (!(await file.exists())) return new Response('Not found', { status: 404, headers: CORS });
    const type = rel.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
    const range = req.headers.get('range')?.match(/bytes=(\d*)-(\d*)/);
    if (!range) return new Response(file, { headers: { ...CORS, 'content-type': type, 'accept-ranges': 'bytes' } });
    const size = file.size, start = range[1] ? Number(range[1]) : size - Number(range[2]), end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start < 0) return new Response(null, { status: 416, headers: { ...CORS, 'content-range': `bytes */${size}` } });
    return new Response(file.slice(start, end + 1), { status: 206, headers: { ...CORS, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}` } });
  },
} });
console.log(`server/index.ts: http://${hostname}:${port}${OFFLINE ? ' (offline)' : ` (books from ${providerName})`}`);
