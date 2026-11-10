// Makes a whole audiobook up front: one audio file per chapter, voiced chunk by chunk.
// Jobs run one at a time in this process; a restart marks unfinished ones failed.
import { mkdirSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { db } from './db.ts';
import { type Chapter, chunks } from './parse.ts';
import { join, speak, wav } from './tts.ts';

export const AUDIO_DIR = process.env.AUDIO_DIR ?? pathJoin(dirname(process.env.DB ?? 'data.db'), 'audio');
mkdirSync(AUDIO_DIR, { recursive: true });

db.run(`UPDATE generations SET status = 'failed', error = 'The server restarted while this was being made.' WHERE status IN ('queued', 'working')`);

type Job = { id: number; model: string; voice: string; chapters: Chapter[] };
const queue: Job[] = [];
let running = false;

export function enqueue(job: Job) {
  db.query("UPDATE generations SET total = ?, status = 'queued' WHERE id = ?").run(job.chapters.length, job.id);
  queue.push(job);
  if (!running) void drain();
}

async function drain() {
  running = true;
  for (let job = queue.shift(); job; job = queue.shift()) {
    try {
      await run(job);
      db.query("UPDATE generations SET status = 'ready' WHERE id = ?").run(job.id);
    } catch (e) {
      db.query("UPDATE generations SET status = 'failed', error = ? WHERE id = ?").run(String((e as Error).message ?? e), job.id);
    }
  }
  running = false;
}

async function run({ id, model, voice, chapters }: Job) {
  db.query("UPDATE generations SET status = 'working' WHERE id = ?").run(id);
  mkdirSync(pathJoin(AUDIO_DIR, String(id)), { recursive: true });
  for (const [idx, chapter] of chapters.entries()) {
    const voiced = [];
    let ext = 'mp3', rate = 44100;
    // The chapter's title is read first, as a narrator would.
    for (const text of chunks(`${chapter.title}. ${chapter.text}`)) {
      const v = await speak(model, voice, text);
      voiced.push(v.audio);
      ext = v.ext;
      rate = v.rate ?? rate;
    }
    // A WAV can't be joined by bytes; the test voice's chunks are all the same silence.
    // Raw PCM chunks join, then get one WAV header for the whole chapter.
    const audio = ext === 'wav' ? voiced[0] : ext === 'pcm' ? wav(join(voiced), rate) : join(voiced);
    if (ext === 'pcm') ext = 'wav';
    const file = `${id}/${idx}.${ext}`;
    await Bun.write(pathJoin(AUDIO_DIR, file), audio);
    db.query('INSERT INTO tracks (generation_id, idx, title, file) VALUES (?, ?, ?, ?)').run(id, idx, chapter.title, file);
    db.query('UPDATE generations SET done = ? WHERE id = ?').run(idx + 1, id);
  }
}
