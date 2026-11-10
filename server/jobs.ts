// One durable worker per server. Completed chapters survive restarts; only the interrupted
// chapter is regenerated. Text is removed when a job finishes or fails.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db, tracksOf, type GenerationRow } from './db.ts';
import { type Chapter, chunks, parseBook } from './parse.ts';
import { speak, wav } from './tts.ts';
import { AUDIO_DIR, SCRATCH_DIR, requireDiskSpace, saveAudio, storageKind } from './storage.ts';
import { MAX_TEXT_CHARS, MAX_GENERATION_BYTES } from './limits.ts';
import { lg } from './libgen.ts';
import { zlib } from './zlibrary.ts';
export { AUDIO_DIR } from './storage.ts';

const MAX_QUEUE = 20, MAX_PER_USER = 2;
const MAX_AUDIO_BYTES = Number(process.env.AUDIO_MAX_BYTES ?? (storageKind === 'local' ? 8 * 1024 ** 3 : 0));
if (!Number.isSafeInteger(MAX_AUDIO_BYTES) || MAX_AUDIO_BYTES < 0) throw new Error('AUDIO_MAX_BYTES must be a nonnegative integer.');
export class QueueFull extends Error {}
export type Payload = { source: string; offline?: boolean } | { chapters: Chapter[] };
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
  requireDiskSpace();
  const used = (db.query('SELECT COALESCE(SUM(bytes), 0) AS n FROM tracks').get() as { n: number }).n;
  if (MAX_AUDIO_BYTES && used >= MAX_AUDIO_BYTES) throw new QueueFull('Audio storage is full. Try again after storage is expanded.');
}
// Reserve a slot before reading uploads or resolving a remote source; concurrent requests
// cannot all pass admission checks and then allocate a full book each.
export const reserve = db.transaction((g: { book: string; user: number; by: string; model: string; voice: string; voiceName: string; name: string; source: string }) => {
  if (g.source) {
    const existing = db.query(`SELECT id FROM generations WHERE book_id = ? AND source_ref = ? AND model = ? AND voice = ? AND status IN ('queued', 'working', 'ready') ORDER BY id LIMIT 1`)
      .get(g.book, g.source, g.model, g.voice) as { id: number } | null;
    if (existing) return { id: existing.id, reused: true };
  }
  checkCapacity();
  const count = db.query("SELECT COUNT(*) AS n FROM generations WHERE status IN ('queued', 'working')").get() as { n: number };
  if (count.n >= MAX_QUEUE) throw new QueueFull('The audiobook queue is full. Try again later.');
  const own = db.query("SELECT COUNT(*) AS n FROM generations WHERE user_id = ? AND status IN ('queued', 'working')").get(g.user) as { n: number };
  if (own.n >= MAX_PER_USER) throw new QueueFull('You already have two audiobooks being made. Wait for one to finish.');
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
export function enqueue(id: number, payload: Payload) {
  if ('chapters' in payload) validateChapters(payload.chapters);
  db.query('INSERT OR REPLACE INTO generation_jobs (generation_id, payload) VALUES (?, ?)').run(id, JSON.stringify(payload));
  if (!running) void drain();
}
async function loadChapters(id: number, payload: Payload): Promise<Chapter[]> {
  if ('chapters' in payload) return payload.chapters;
  let source;
  if (payload.offline) {
    source = { name: 'A Quiet Harbour.txt', bytes: new TextEncoder().encode('A quiet harbour opens onto a wide river where the ships come and go each morning and the people gather to watch them sail.') };
  } else if (payload.source.startsWith('lg-')) source = await lg.download(payload.source);
  else if (payload.source.startsWith('zl-')) source = await zlib.download(payload.source);
  else throw new Error('No such book source.');
  const chapters = await parseBook(source.name, source.bytes);
  validateChapters(chapters);
  const hash = createHash('sha256').update(source.bytes).digest('hex');
  db.transaction(() => {
    db.query('UPDATE generations SET source_name = ?, source_hash = ? WHERE id = ?').run(source.name, hash, id);
    db.query('UPDATE generation_jobs SET payload = ? WHERE generation_id = ?').run(JSON.stringify({ chapters }), id);
  })();
  return chapters;
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
        await run(row, await loadChapters(row.id, JSON.parse(row.payload)));
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
    const path = join(SCRATCH_DIR, `${g.id}-${idx}.partial`);
    const file = await open(path, 'w');
    let ext = '', rate = 44100, bytes = 0, pcm = false;
    try {
      for (const text of chunks(`${chapter.title}. ${chapter.text}`)) {
        checkCapacity();
        const v = await speak(g.model, g.voice, text);
        const thisPcm = v.ext === 'pcm' || v.ext === 'wav';
        if (ext && (pcm !== thisPcm || (pcm && rate !== (v.rate ?? (v.ext === 'wav' ? 8000 : 44100))))) throw new Error('The speech provider changed audio formats mid-chapter.');
        if (!ext) {
          pcm = thisPcm; ext = pcm ? 'wav' : 'mp3'; rate = v.rate ?? (v.ext === 'wav' ? 8000 : 44100);
          if (pcm) { await file.write(new Uint8Array(44)); bytes += 44; }
        }
        const audio = v.ext === 'wav' ? v.audio.subarray(44) : v.audio;
        bytes += audio.length;
        const total = (db.query('SELECT COALESCE(SUM(bytes), 0) AS n FROM tracks WHERE generation_id = ?').get(g.id) as { n: number }).n;
        const all = (db.query('SELECT COALESCE(SUM(bytes), 0) AS n FROM tracks').get() as { n: number }).n;
        if (total + bytes > MAX_GENERATION_BYTES || (MAX_AUDIO_BYTES && all + bytes > MAX_AUDIO_BYTES)) throw new Error('The audiobook reached the audio storage limit.');
        // A chapter is streamed to scratch; no whole audiobook or chapter audio in memory.
        await file.writeFile(audio);
      }
      if (pcm) {
        const header = wav(new Uint8Array(0), rate);
        const view = new DataView(header.buffer); view.setUint32(4, bytes - 8, true); view.setUint32(40, bytes - 44, true);
        await file.write(header, 0, 44, 0);
      }
      await file.sync(); await file.close();
      const name = `${g.id}/${idx}.${ext}`;
      const storage = await saveAudio(name, path);
      db.transaction(() => {
        db.query('INSERT OR REPLACE INTO tracks (generation_id, idx, title, file, bytes, storage) VALUES (?, ?, ?, ?, ?, ?)').run(g.id, idx, chapter.title, name, bytes, storage);
        db.query('UPDATE generations SET done = done + 1 WHERE id = ?').run(g.id);
      })();
    } finally { await file.close().catch(() => {}); rmSync(path, { force: true }); }
  }
}
// Begin recovery after imports and route setup have completed.
setTimeout(() => { if (!running) void drain(); }, 0);
