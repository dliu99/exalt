// One durable worker per server. Completed chapters survive restarts; only the interrupted
// chapter is regenerated. Text is removed when a job finishes or fails. An audiobook deleted
// while it is being made stops at its next chapter, and what it was writing is cleaned up.
import { open } from 'node:fs/promises';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db, getBook, getGeneration, tracksOf, type GenerationRow } from './db.ts';
import { type Chapter, chunks } from './parse.ts';
import { speak } from './tts.ts';
import { compress, requireEncoder, STORED_BYTES_PER_SECOND } from './encode.ts';
import { AUDIO_DIR, SCRATCH_DIR, audioDir, removeAudio, removeCover, requireDiskSpace, saveAudio, storageKind } from './storage.ts';
import { MAX_TEXT_CHARS, MAX_GENERATION_BYTES } from './limits.ts';
export { AUDIO_DIR } from './storage.ts';

const MAX_QUEUE = 20, MAX_PER_USER = 2;
const MAX_AUDIO_BYTES = Number(process.env.AUDIO_MAX_BYTES ?? (storageKind === 'local' ? 8 * 1024 ** 3 : 0));
if (!Number.isSafeInteger(MAX_AUDIO_BYTES) || MAX_AUDIO_BYTES < 0) throw new Error('AUDIO_MAX_BYTES must be a nonnegative integer.');
export class QueueFull extends Error {}
export type Payload = { chapters: Chapter[] };
// The audiobook was deleted while it was being made.
class Gone extends Error {}
const exists = (id: number) => !!db.query('SELECT 1 FROM generations WHERE id = ?').get(id);
let running = false;

// Backfill byte counts for audio created by earlier versions, so capacity limits include it.
for (const row of db.query("SELECT generation_id, idx, file FROM tracks WHERE bytes = 0 AND storage = 'local'").all() as { generation_id: number; idx: number; file: string }[]) {
  try { db.query('UPDATE tracks SET bytes = ? WHERE generation_id = ? AND idx = ?').run(statSync(join(AUDIO_DIR, row.file)).size, row.generation_id, row.idx); } catch { /* a missing old file stays visible as missing */ }
}
// Legacy in-memory jobs have no recoverable input. New ones resume from the database.
db.run(`UPDATE generations SET status = 'failed', error = 'The server restarted before this older job could finish.'
  WHERE status IN ('queued', 'working') AND id NOT IN (SELECT generation_id FROM generation_jobs)`);
db.run("UPDATE generations SET status = 'queued' WHERE status = 'working'");

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
// Reserve a slot before reading the upload; concurrent requests cannot all pass admission
// checks and then allocate a full book each.
export const reserve = db.transaction((g: { book: string; user: number; by: string; model: string; voice: string; voiceName: string; name: string; public: boolean }) => {
  checkCapacity();
  const count = db.query("SELECT COUNT(*) AS n FROM generations WHERE status IN ('queued', 'working')").get() as { n: number };
  if (count.n >= MAX_QUEUE) throw new QueueFull('The audiobook queue is full. Try again later.');
  const own = db.query("SELECT COUNT(*) AS n FROM generations WHERE user_id = ? AND status IN ('queued', 'working')").get(g.user) as { n: number };
  if (own.n >= MAX_PER_USER) throw new QueueFull('You already have two audiobooks being made. Wait for one to finish.');
  const result = db.query(`INSERT INTO generations (book_id, user_id, made_by, model, voice, voice_name, source_name, public, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`).run(g.book, g.user, g.by.slice(0, 40), g.model, g.voice, g.voiceName, g.name.slice(0, 200), g.public ? 1 : 0, Date.now());
  return Number(result.lastInsertRowid);
});
export function failJob(id: number, e: unknown) {
  db.transaction(() => {
    db.query("UPDATE generations SET status = 'failed', error = ? WHERE id = ?").run(String((e as Error).message ?? e).slice(0, 500), id);
    db.query('DELETE FROM generation_jobs WHERE generation_id = ?').run(id);
  })();
}
// An audiobook gone with everything of it: its queued text, tracks and their audio, listeners'
// places, and its book and cover when no other audiobook has them. A worker making it stops at its
// next chunk or chapter (run checks), and removes a chapter it stores meanwhile.
export async function removeAudiobook(id: number) {
  const g = getGeneration(id);
  if (!g) return;
  const tracks = tracksOf(id);
  let cover = '';
  db.transaction(() => {
    db.query('DELETE FROM generation_jobs WHERE generation_id = ?').run(id);
    db.query('DELETE FROM tracks WHERE generation_id = ?').run(id);
    db.query('DELETE FROM places WHERE generation_id = ?').run(id);
    db.query('DELETE FROM generations WHERE id = ?').run(id);
    const book = getBook(g.book_id);
    if (book && !db.query('SELECT 1 FROM generations WHERE book_id = ? LIMIT 1').get(book.id)) {
      db.query('DELETE FROM books WHERE id = ?').run(book.id);
      if (!db.query('SELECT 1 FROM books WHERE cover = ? LIMIT 1').get(book.cover)) cover = book.cover;
    }
  })();
  await Promise.all(tracks.map((t) => removeAudio(t.file, t.storage).catch(() => {})));
  rmSync(audioDir(id), { recursive: true, force: true });
  const file = /^\/covers\/([^/?]+)$/.exec(cover)?.[1];
  if (file) await removeCover(file).catch(() => {});
}
function validateChapters(chapters: Chapter[]) {
  if (!chapters.length || chapters.reduce((n, c) => n + c.text.length + c.title.length, 0) > MAX_TEXT_CHARS)
    throw new Error(`Books must contain readable text and be under ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters.`);
}
export function enqueue(id: number, payload: Payload) {
  validateChapters(payload.chapters);
  db.query('INSERT OR REPLACE INTO generation_jobs (generation_id, payload) VALUES (?, ?)').run(id, JSON.stringify(payload));
  if (!running) void drain();
}
function loadChapters(payload: Partial<Payload> & { source?: string }): Chapter[] {
  // Jobs queued from a book download, before Exalt stopped downloading books.
  if (!Array.isArray(payload.chapters)) throw new Error('This audiobook was queued from a book download, which Exalt no longer makes. Import the file instead.');
  return payload.chapters;
}
async function drain() {
  running = true;
  try {
    for (;;) {
      const row = db.query(`SELECT g.* , j.payload FROM generations g JOIN generation_jobs j ON j.generation_id = g.id WHERE g.status = 'queued' ORDER BY g.id LIMIT 1`).get() as (GenerationRow & { payload: string }) | null;
      if (!row) break;
      try {
        db.query("UPDATE generations SET status = 'working' WHERE id = ?").run(row.id);
        checkCapacity();
        await run(row, loadChapters(JSON.parse(row.payload)));
        db.transaction(() => {
          db.query("UPDATE generations SET status = 'ready', error = '' WHERE id = ?").run(row.id);
          db.query('DELETE FROM generation_jobs WHERE generation_id = ?').run(row.id);
        })();
      } catch (e) { failJob(row.id, e); }
    }
  } finally { running = false; }
}
async function run(g: GenerationRow, chapters: Chapter[]) {
  const done = new Set(tracksOf(g.id).map((t) => t.idx));
  db.query('UPDATE generations SET total = ?, done = ? WHERE id = ?').run(chapters.length, done.size, g.id);
  for (const [idx, chapter] of chapters.entries()) {
    if (done.has(idx)) continue;
    if (!exists(g.id)) throw new Gone();
    const path = join(SCRATCH_DIR, `${g.id}-${idx}.partial`);
    const file = await open(path, 'w');
    // A chapter is raw PCM (its parts' samples) or MP3 (its parts' frames) until it is compressed.
    let pcm: boolean | undefined, rate = 0, raw = 0;
    try {
      for (const text of chunks(`${chapter.title}. ${chapter.text}`)) {
        if (!exists(g.id)) throw new Gone();
        checkCapacity();
        const v = await speak(g.model, g.voice, text);
        const thisRate = v.ext === 'wav' ? new DataView(v.audio.buffer, v.audio.byteOffset, 44).getUint32(24, true) : v.rate ?? 0;
        if (pcm !== undefined && (pcm !== (v.ext !== 'mp3') || rate !== thisRate)) throw new Error('The speech provider changed audio formats mid-chapter.');
        pcm = v.ext !== 'mp3'; rate = thisRate;
        const audio = v.ext === 'wav' ? v.audio.subarray(44) : v.audio;
        raw += audio.length;
        // Until it is compressed, PCM counts as what its length will take stored; MP3 as itself, its most.
        if (overLimit(g.id, pcm ? Math.ceil(raw / (rate * 2) * STORED_BYTES_PER_SECOND) : raw)) throw new Error('The audiobook reached the audio storage limit.');
        // A chapter is streamed to scratch; no whole audiobook or chapter audio in memory.
        await file.writeFile(audio);
      }
      await file.sync(); await file.close();
      const stored = await compress(path, pcm ? rate : undefined);
      if (overLimit(g.id, stored.bytes)) throw new Error('The audiobook reached the audio storage limit.');
      const name = `${g.id}/${idx}.${stored.ext}`;
      const storage = await saveAudio(name, stored.path);
      if (!exists(g.id)) { await removeAudio(name, storage).catch(() => {}); throw new Gone(); }
      db.transaction(() => {
        db.query('INSERT OR REPLACE INTO tracks (generation_id, idx, title, file, bytes, storage) VALUES (?, ?, ?, ?, ?, ?)').run(g.id, idx, chapter.title, name, stored.bytes, storage);
        db.query('UPDATE generations SET done = done + 1 WHERE id = ?').run(g.id);
      })();
    } finally { await file.close().catch(() => {}); rmSync(path, { force: true }); rmSync(`${path}.m4a`, { force: true }); }
  }
}
// Begin recovery after imports and route setup have completed.
setTimeout(() => { if (!running) void drain(); }, 0);
