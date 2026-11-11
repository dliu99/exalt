// One durable worker per server, with two kinds of work. Preparing a version gets its source
// (a download), splits it into chapters and keeps their text; narrating voices one chapter, when
// someone asks for it (its creator's first chapter is asked for as it is prepared). An account
// has at most MAX_ACTIVE chapters waiting or narrating at once. A chapter's text is removed once
// it is narrated; a restart picks up queued work, and the chapter it was voicing starts over.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db, tracksOf, type ChapterRow, type GenerationRow } from './db.ts';
import { type Chapter, chunks, parseBook } from './parse.ts';
import { speak } from './tts.ts';
import { compress, requireEncoder, STORED_BYTES_PER_SECOND } from './encode.ts';
import { AUDIO_DIR, SCRATCH_DIR, deleteAudio, requireDiskSpace, saveAudio, storageKind } from './storage.ts';
import { MAX_TEXT_CHARS, MAX_GENERATION_BYTES } from './limits.ts';
import { lg } from './libgen.ts';
import { zlib } from './zlibrary.ts';
export { AUDIO_DIR } from './storage.ts';

// The whole server's queue, and one account's share of it: chapters waiting or narrating, and
// versions being prepared (each of which asks for its first chapter).
const MAX_QUEUE = 20;
export const MAX_ACTIVE = 3;
const MAX_AUDIO_BYTES = Number(process.env.AUDIO_MAX_BYTES ?? (storageKind === 'local' ? 8 * 1024 ** 3 : 0));
if (!Number.isSafeInteger(MAX_AUDIO_BYTES) || MAX_AUDIO_BYTES < 0) throw new Error('AUDIO_MAX_BYTES must be a nonnegative integer.');
/** Refused for now (a full queue, the account's limit, full storage): 429. */
export class QueueFull extends Error {}
/** Refused for good (no such chapter, or no text left to narrate): its status is `status`. */
export class Refused extends Error { constructor(message: string, readonly status: number) { super(message); } }
// A queued download. `{ chapters }` is a whole-book job from before chapters were narrated one at a time.
export type Payload = { source: string; offline?: boolean } | { chapters: Chapter[] };
let running = false;
const ACTIVE = "('queued', 'working')";

// The offline server's download (`--offline`): a short book of three chapters, so a test can
// prepare one, hear its first chapter and ask for the others.
const OFFLINE_BOOK = `Chapter One: The Harbour
A quiet harbour opens onto a wide river where the ships come and go each morning, and the people gather on the stones to watch them sail out past the lighthouse.
Chapter Two: The River
Upstream the river narrows between green banks, and the boatmen call to one another across the water as they pole their flat boats toward the market town.
Chapter Three: The Sea
Beyond the last buoy the water turns grey and wide, and the ships grow small against the sky until only their smoke is left above the line of the sea.
`;

// Backfill byte counts for audio created by earlier versions, so capacity limits include it.
for (const row of db.query("SELECT generation_id, idx, file FROM tracks WHERE bytes = 0 AND storage = 'local'").all() as { generation_id: number; idx: number; file: string }[]) {
  try { db.query('UPDATE tracks SET bytes = ? WHERE generation_id = ? AND idx = ?').run(statSync(join(AUDIO_DIR, row.file)).size, row.generation_id, row.idx); } catch { /* a missing old file stays visible as missing */ }
}
// Legacy in-memory jobs have no recoverable input. New ones resume from the database.
db.run(`UPDATE generations SET status = 'failed', error = 'The server restarted before this older job could finish.'
  WHERE status IN ${ACTIVE} AND id NOT IN (SELECT generation_id FROM generation_jobs)`);
db.run("UPDATE generations SET status = 'queued' WHERE status = 'working'");
db.run("UPDATE chapters SET status = 'queued', parts_done = 0 WHERE status = 'working'");
upgradeVersions();

// Versions made before chapters were narrated one at a time gain their chapter list. A whole-book
// job still queued keeps its text: what it narrated stays, its next chapter is asked for, and the
// rest wait for someone to ask. A finished or failed one kept no text, so a chapter it never
// voiced is unavailable.
function upgradeVersions() {
  const bare = db.query(`SELECT g.*, j.payload FROM generations g LEFT JOIN generation_jobs j ON j.generation_id = g.id
    WHERE NOT EXISTS (SELECT 1 FROM chapters c WHERE c.generation_id = g.id)`).all() as (GenerationRow & { user_id: number | null; payload: string | null })[];
  for (const g of bare) {
    const payload = g.payload ? JSON.parse(g.payload) as Payload : null;
    if (payload && !('chapters' in payload)) continue; // a download still to prepare
    const tracks = new Map(tracksOf(g.id).map((t) => [t.idx, t]));
    if (payload) {
      db.transaction(() => {
        insertChapters(g.id, payload.chapters, new Map([...tracks].map(([i, t]) => [i, t.title])));
        const next = payload.chapters.findIndex((_, i) => !tracks.has(i));
        if (next >= 0) queueChapter(g.id, next, g.user_id);
        db.query("UPDATE generations SET status = 'ready', error = '', total = ?, done = ? WHERE id = ?").run(payload.chapters.length, tracks.size, g.id);
        db.query('DELETE FROM generation_jobs WHERE generation_id = ?').run(g.id);
      })();
      continue;
    }
    const total = Math.max(g.total, ...[...tracks.keys()].map((i) => i + 1));
    if (total === 0) continue;
    db.transaction(() => {
      const q = db.query('INSERT INTO chapters (generation_id, idx, title, text, status) VALUES (?, ?, ?, NULL, ?)');
      for (let i = 0; i < total; i++) q.run(g.id, i, tracks.get(i)?.title ?? `Chapter ${i + 1}`, tracks.has(i) ? 'ready' : 'unavailable');
      if (tracks.size) db.query("UPDATE generations SET status = 'ready', error = '', total = ?, done = ? WHERE id = ?").run(total, tracks.size, g.id);
    })();
  }
}

function checkCapacity() {
  requireEncoder();
  requireDiskSpace();
  const used = (db.query('SELECT COALESCE(SUM(bytes), 0) AS n FROM tracks').get() as { n: number }).n;
  if (MAX_AUDIO_BYTES && used >= MAX_AUDIO_BYTES) throw new QueueFull('Audio storage is full. Try again after storage is expanded.');
}
// Whether `adding` stored bytes would pass this audiobook's cap or the server's.
function overLimit(id: number, adding: number) {
  const total = (db.query('SELECT COALESCE(SUM(bytes), 0) AS n FROM tracks WHERE generation_id = ?').get(id) as { n: number }).n;
  const all = (db.query('SELECT COALESCE(SUM(bytes), 0) AS n FROM tracks').get() as { n: number }).n;
  return total + adding > MAX_GENERATION_BYTES || (MAX_AUDIO_BYTES > 0 && all + adding > MAX_AUDIO_BYTES);
}

/** How many chapters this account has waiting or narrating, counting each version it is preparing as one. */
export function activeFor(user: number) {
  const chapters = db.query(`SELECT COUNT(*) AS n FROM chapters WHERE requested_by = ? AND status IN ${ACTIVE}`).get(user) as { n: number };
  const preparing = db.query(`SELECT COUNT(*) AS n FROM generations WHERE user_id = ? AND status IN ${ACTIVE}`).get(user) as { n: number };
  return chapters.n + preparing.n;
}
// Whether one more piece of work fits: the server's storage and queue, and the account's limit.
function admit(user: number) {
  checkCapacity();
  const chapters = db.query(`SELECT COUNT(*) AS n FROM chapters WHERE status IN ${ACTIVE}`).get() as { n: number };
  const preparing = db.query(`SELECT COUNT(*) AS n FROM generations WHERE status IN ${ACTIVE}`).get() as { n: number };
  if (chapters.n + preparing.n >= MAX_QUEUE) throw new QueueFull('The narration queue is full. Try again later.');
  if (activeFor(user) >= MAX_ACTIVE) throw new QueueFull(`You have ${MAX_ACTIVE} chapters narrating. Wait for one to finish, then try again.`);
}

// Reserve a slot before reading uploads or resolving a remote source; concurrent requests
// cannot all pass admission checks and then allocate a full book each.
export const reserve = db.transaction((g: { book: string; user: number; by: string; model: string; voice: string; voiceName: string; name: string; source: string }) => {
  if (g.source) {
    const existing = db.query(`SELECT id FROM generations WHERE book_id = ? AND source_ref = ? AND model = ? AND voice = ? AND status IN ('queued', 'working', 'ready') ORDER BY id LIMIT 1`)
      .get(g.book, g.source, g.model, g.voice) as { id: number } | null;
    if (existing) return { id: existing.id, reused: true };
  }
  admit(g.user);
  const result = db.query(`INSERT INTO generations (book_id, user_id, made_by, model, voice, voice_name, source_name, source_ref, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`).run(g.book, g.user, g.by.slice(0, 40), g.model, g.voice, g.voiceName, g.name, g.source, Date.now());
  return { id: Number(result.lastInsertRowid), reused: false };
});
export function failJob(id: number, e: unknown) {
  db.transaction(() => {
    db.query("UPDATE generations SET status = 'failed', error = ? WHERE id = ?").run(String((e as Error).message ?? e).slice(0, 500), id);
    db.query('DELETE FROM generation_jobs WHERE generation_id = ?').run(id);
  })();
}
function validateChapters(chapters: Chapter[]) {
  if (!chapters.length || chapters.reduce((n, c) => n + c.text.length + c.title.length, 0) > MAX_TEXT_CHARS)
    throw new Error(`Books must contain readable text and be under ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters.`);
}
// `narrated` names the chapters that already have audio, by the title they were stored under.
function insertChapters(id: number, chapters: Chapter[], narrated = new Map<number, string>()) {
  const q = db.query('INSERT OR IGNORE INTO chapters (generation_id, idx, title, text, status) VALUES (?, ?, ?, ?, ?)');
  chapters.forEach((c, i) => q.run(id, i, narrated.get(i) ?? c.title, narrated.has(i) ? null : c.text, narrated.has(i) ? 'ready' : 'idle'));
}
function queueChapter(id: number, idx: number, user: number | null) {
  db.query(`UPDATE chapters SET status = 'queued', requested_by = ?, requested_at = ?, parts_done = 0, parts_total = 0, error = ''
    WHERE generation_id = ? AND idx = ?`).run(user, Date.now(), id, idx);
}

/** A version's chapters are known: keep their text, ask for the first on its maker's behalf, and the version is ready. */
export function prepared(id: number, chapters: Chapter[]) {
  validateChapters(chapters);
  db.transaction(() => {
    const g = db.query('SELECT user_id FROM generations WHERE id = ?').get(id) as { user_id: number | null } | null;
    if (!g) return; // deleted while it was being prepared
    insertChapters(id, chapters);
    queueChapter(id, 0, g.user_id);
    db.query("UPDATE generations SET status = 'ready', error = '', total = ?, done = 0 WHERE id = ?").run(chapters.length, id);
    db.query('DELETE FROM generation_jobs WHERE generation_id = ?').run(id);
  })();
  wake();
}

/** A download to prepare. */
export function enqueue(id: number, payload: Payload) {
  if ('chapters' in payload) return prepared(id, payload.chapters);
  db.query('INSERT OR REPLACE INTO generation_jobs (generation_id, payload) VALUES (?, ?)').run(id, JSON.stringify(payload));
  wake();
}

/** Someone asks for a chapter to be narrated. One already narrated, waiting or narrating is left as it is. */
export function requestChapter(id: number, idx: number, user: number) {
  const status = ask(id, idx, user);
  if (status === 'queued') wake();
  return status;
}
const ask = db.transaction((id: number, idx: number, user: number): string => {
  const g = db.query('SELECT status FROM generations WHERE id = ?').get(id) as { status: string } | null;
  if (!g) throw new Refused('No such audiobook.', 404);
  const c = db.query('SELECT status, text IS NOT NULL AS kept FROM chapters WHERE generation_id = ? AND idx = ?').get(id, idx) as { status: string; kept: number } | null;
  if (!c) throw g.status === 'ready' ? new Refused('No such chapter.', 404)
    : new Refused(g.status === 'failed' ? 'This audiobook couldn’t be prepared.' : 'This audiobook is still being prepared.', 409);
  if (['ready', 'queued', 'working'].includes(c.status)) return c.status;
  if (!c.kept) throw new Refused('This chapter’s text wasn’t kept, so it can’t be narrated. Make a new audiobook of the book to hear it.', 409);
  admit(user);
  queueChapter(id, idx, user);
  return 'queued';
});

/** Deletes a version: its chapters, its audio and any work still waiting for it. */
export async function removeGeneration(id: number) {
  const tracks = tracksOf(id);
  db.transaction(() => {
    for (const table of ['chapters', 'tracks', 'generation_jobs']) db.query(`DELETE FROM ${table} WHERE generation_id = ?`).run(id);
    db.query('DELETE FROM generations WHERE id = ?').run(id);
  })();
  for (const t of tracks) await deleteAudio(t.file, t.storage);
  if (storageKind === 'local') rmSync(join(AUDIO_DIR, String(id)), { recursive: true, force: true });
}

function wake() { if (!running) void drain(); }

async function drain() {
  running = true;
  try {
    for (;;) {
      // Preparing comes first: it is quick, and it is what a new version's first chapter waits on.
      const prep = db.query(`SELECT g.*, j.payload FROM generations g JOIN generation_jobs j ON j.generation_id = g.id
        WHERE g.status = 'queued' ORDER BY g.id LIMIT 1`).get() as (GenerationRow & { payload: string }) | null;
      if (prep) { await prepare(prep); continue; }
      const next = db.query(`SELECT c.*, g.model, g.voice FROM chapters c JOIN generations g ON g.id = c.generation_id
        WHERE c.status = 'queued' ORDER BY c.requested_at, c.generation_id, c.idx LIMIT 1`).get() as (ChapterRow & { model: string; voice: string }) | null;
      if (!next) break;
      await narrate(next);
    }
  } finally { running = false; }
}

async function prepare(row: GenerationRow & { payload: string }) {
  try {
    db.query("UPDATE generations SET status = 'working' WHERE id = ?").run(row.id);
    checkCapacity();
    const payload = JSON.parse(row.payload) as Payload;
    if ('chapters' in payload) return prepared(row.id, payload.chapters);
    let source;
    if (payload.offline) source = { name: 'A Quiet Harbour.txt', bytes: new TextEncoder().encode(OFFLINE_BOOK) };
    else if (payload.source.startsWith('lg-')) source = await lg.download(payload.source);
    else if (payload.source.startsWith('zl-')) source = await zlib.download(payload.source);
    else throw new Error('No such book source.');
    const chapters = await parseBook(source.name, source.bytes);
    validateChapters(chapters);
    db.query('UPDATE generations SET source_name = ?, source_hash = ? WHERE id = ?').run(source.name, createHash('sha256').update(source.bytes).digest('hex'), row.id);
    prepared(row.id, chapters);
  } catch (e) { failJob(row.id, e); }
}

class Removed extends Error {}
const stillThere = (id: number, idx: number) => db.query('SELECT 1 FROM chapters WHERE generation_id = ? AND idx = ?').get(id, idx) != null;

async function narrate(c: ChapterRow & { model: string; voice: string }) {
  const id = c.generation_id, idx = c.idx;
  const text = (db.query('SELECT text FROM chapters WHERE generation_id = ? AND idx = ?').get(id, idx) as { text: string | null } | null)?.text;
  if (text == null) {
    db.query("UPDATE chapters SET status = 'unavailable' WHERE generation_id = ? AND idx = ?").run(id, idx);
    return;
  }
  const parts = chunks(`${c.title}. ${text}`);
  db.query("UPDATE chapters SET status = 'working', parts_done = 0, parts_total = ? WHERE generation_id = ? AND idx = ?").run(parts.length, id, idx);
  const path = join(SCRATCH_DIR, `${id}-${idx}.partial`);
  const file = await open(path, 'w');
  // A chapter is raw PCM (its parts' samples) or MP3 (its parts' frames) until it is compressed.
  let pcm: boolean | undefined, rate = 0, raw = 0;
  try {
    checkCapacity();
    for (const part of parts) {
      if (!stillThere(id, idx)) throw new Removed();
      const v = await speak(c.model, c.voice, part);
      const thisRate = v.ext === 'wav' ? new DataView(v.audio.buffer, v.audio.byteOffset, 44).getUint32(24, true) : v.rate ?? 0;
      if (pcm !== undefined && (pcm !== (v.ext !== 'mp3') || rate !== thisRate)) throw new Error('The speech provider changed audio formats mid-chapter.');
      pcm = v.ext !== 'mp3'; rate = thisRate;
      const audio = v.ext === 'wav' ? v.audio.subarray(44) : v.audio;
      raw += audio.length;
      // Until it is compressed, PCM counts as what its length will take stored; MP3 as itself, its most.
      if (overLimit(id, pcm ? Math.ceil(raw / (rate * 2) * STORED_BYTES_PER_SECOND) : raw)) throw new Error('The audiobook reached the audio storage limit.');
      // A chapter is streamed to scratch; no chapter's audio is held in memory.
      await file.writeFile(audio);
      db.query('UPDATE chapters SET parts_done = parts_done + 1 WHERE generation_id = ? AND idx = ?').run(id, idx);
    }
    await file.sync(); await file.close();
    const stored = await compress(path, pcm ? rate : undefined);
    if (overLimit(id, stored.bytes)) throw new Error('The audiobook reached the audio storage limit.');
    const name = `${id}/${idx}.${stored.ext}`;
    const storage = await saveAudio(name, stored.path);
    const kept = db.transaction(() => {
      if (!stillThere(id, idx)) return false;
      db.query('INSERT OR REPLACE INTO tracks (generation_id, idx, title, file, bytes, storage) VALUES (?, ?, ?, ?, ?, ?)').run(id, idx, c.title, name, stored.bytes, storage);
      db.query("UPDATE chapters SET status = 'ready', text = NULL, error = '' WHERE generation_id = ? AND idx = ?").run(id, idx);
      db.query('UPDATE generations SET done = (SELECT COUNT(*) FROM tracks WHERE generation_id = ?) WHERE id = ?').run(id, id);
      return true;
    })();
    // Deleted while it was being stored: its audio goes too.
    if (!kept) await deleteAudio(name, storage);
  } catch (e) {
    if (!(e instanceof Removed)) db.query("UPDATE chapters SET status = 'failed', error = ? WHERE generation_id = ? AND idx = ?")
      .run(String((e as Error).message ?? e).slice(0, 500), id, idx);
  } finally { await file.close().catch(() => {}); rmSync(path, { force: true }); rmSync(`${path}.m4a`, { force: true }); }
}
// Begin recovery after imports and route setup have completed.
setTimeout(wake, 0);
