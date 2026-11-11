import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wav } from './tts.ts';
import { chunks } from './parse.ts';

async function start(dir: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, 'server/index.ts', '--offline'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DB: join(dir, 'db.sqlite'), AUDIO_DIR: join(dir, 'audio'), AUDIO_S3_BUCKET: '', SIGN_IN_TEST_KEYS: '', ...extra },
    stdout: 'pipe', stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const { value } = await reader.read(); reader.releaseLock();
  const address = new TextDecoder().decode(value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!address) { child.kill(); throw new Error('Recovery server did not start.'); }
  return { child, address, stop: async () => { child.kill(); await child.exited; } };
}
const chapter = (n: number) => ({ title: `Chapter ${n}`, text: 'A quiet harbour opens onto a wide river where the ships come and go each morning and the people gather to watch them sail. '.repeat(30) });
function seed(dir: string, chapters = [chapter(1), chapter(2)]) {
  const db = new Database(join(dir, 'db.sqlite'));
  db.query("INSERT OR IGNORE INTO books (id,title,author) VALUES ('OL1W','A Quiet Harbour','Test Author')").run();
  const { lastInsertRowid } = db.query("INSERT INTO generations (book_id,made_by,model,voice,source_name,status,created_at) VALUES ('OL1W','test','exalt/silence','','test.txt','working',0)").run();
  const id = Number(lastInsertRowid);
  db.query('INSERT INTO generation_jobs VALUES (?, ?)').run(id, JSON.stringify({ chapters }));
  return { db, id };
}
async function finished(address: string, id: number) {
  let value;
  for (let i = 0; i < 100; i++) {
    value = await fetch(`${address}/generations/${id}`).then((r) => r.json());
    if ((value.status === 'ready' && value.active === 0) || value.status === 'failed') return value;
    await Bun.sleep(20);
  }
  throw new Error('Recovery did not finish.');
}

test('a whole-book job from before chapters were asked for one at a time keeps its chapters and narrates the next', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-recovery-'));
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(dir); await server.stop(); server = undefined;
    const { db, id } = seed(dir);
    const first = wav(new Uint8Array(32).fill(7), 8000);
    await Bun.write(join(dir, 'audio', String(id), '0.wav'), first);
    db.query("INSERT INTO tracks (generation_id,idx,title,file,bytes,storage) VALUES (?,0,'Kept chapter',?,?, 'local')").run(id, `${id}/0.wav`, first.length);
    // An MP3 audiobook from before compression, also kept as it was.
    const old = Number(db.query("INSERT INTO generations (book_id,made_by,model,voice,source_name,status,created_at) VALUES ('OL1W','test','exalt/silence','','old.txt','ready',0)").run().lastInsertRowid);
    await Bun.write(join(dir, 'audio', String(old), '0.mp3'), new Uint8Array([0x49, 0x44, 0x33, 4]));
    db.query("INSERT INTO tracks (generation_id,idx,title,file,bytes,storage) VALUES (?,0,'Old chapter',?,4,'local')").run(old, `${old}/0.mp3`);
    // One that failed after two of its four chapters: its text is gone, so the others can't be narrated.
    const failed = Number(db.query("INSERT INTO generations (book_id,made_by,model,voice,source_name,status,done,total,error,created_at) VALUES ('OL1W','test','exalt/silence','','f.txt','failed',2,4,'It broke.',0)").run().lastInsertRowid);
    for (const i of [0, 1]) {
      await Bun.write(join(dir, 'audio', String(failed), `${i}.mp3`), new Uint8Array([0x49, 0x44, 0x33, 4]));
      db.query("INSERT INTO tracks (generation_id,idx,title,file,bytes,storage) VALUES (?,?,?,?,4,'local')").run(failed, i, `Part ${i + 1}`, `${failed}/${i}.mp3`);
    }
    db.close();
    server = await start(dir);
    const gen = await finished(server.address, id);
    expect(gen.status).toBe('ready'); expect(gen.done).toBe(2);
    expect(gen.tracks[0].title).toBe('Kept chapter');
    expect(gen.chapters.map((c: { title: string; status: string }) => [c.title, c.status])).toEqual([['Kept chapter', 'ready'], ['Chapter 2', 'ready']]);
    const older = await finished(server.address, old);
    expect(older.chapters.map((c: { status: string }) => c.status)).toEqual(['ready']);
    const broken = await finished(server.address, failed);
    expect([broken.status, broken.done, broken.total]).toEqual(['ready', 2, 4]);
    expect(broken.chapters.map((c: { title: string; status: string }) => [c.title, c.status]))
      .toEqual([['Part 1', 'ready'], ['Part 2', 'ready'], ['Chapter 3', 'unavailable'], ['Chapter 4', 'unavailable']]);
    expect(new Uint8Array(await Bun.file(join(dir, 'audio', String(id), '0.wav')).arrayBuffer())).toEqual(first);
    const check = new Database(join(dir, 'db.sqlite'));
    expect(check.query('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 });
    check.close();
    // Chapters stored before compression still play, as what they are.
    const kept = await fetch(`${server.address}${gen.tracks[0].src}`);
    expect(kept.headers.get('content-type')).toBe('audio/wav');
    expect(new Uint8Array(await kept.arrayBuffer())).toEqual(first);
    const oldAudio = await fetch(`${server.address}/audio/${old}/0.mp3`);
    expect(oldAudio.headers.get('content-type')).toBe('audio/mpeg');
    expect((await oldAudio.arrayBuffer()).byteLength).toBe(4);
    // The second chapter crosses TTS chunk boundaries: every chunk's second of PCM is in its M4A.
    expect(gen.tracks[1].src).toBe(`/audio/${id}/1.m4a`);
    const second = join(dir, 'audio', String(id), '1.m4a');
    const parts = chunks(`${chapter(2).title}. ${chapter(2).text}`).length;
    expect(parts).toBeGreaterThan(1);
    const seconds = Number(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', second]).stdout.toString());
    expect(Math.abs(seconds - parts)).toBeLessThan(0.1);
    const size = Bun.file(second).size;
    expect(size).toBeLessThan(parts * 16000 / 4);
    const rows = new Database(join(dir, 'db.sqlite'));
    expect(rows.query('SELECT bytes FROM tracks WHERE generation_id = ? AND idx = 1').get(id)).toEqual({ bytes: size });
    rows.close();
    expect(readdirSync(join(dir, 'audio', '.tmp'))).toEqual([]);
  } finally { await server?.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 10000);

test('S3 storage uploads chapter audio and playback redirects to a signed object URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-s3-'));
  const objects = new Map<string, Uint8Array>();
  const s3 = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === 'PUT') {
      expect(req.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
      expect(path).toEndWith('.m4a');
      expect(req.headers.get('content-type')).toBe('audio/mp4');
      objects.set(path, new Uint8Array(await req.arrayBuffer())); return new Response('', { headers: { etag: '"test"' } });
    }
    if (req.method === 'GET') return new Response(objects.get(path) ?? null, { status: objects.has(path) ? 200 : 404 });
    return new Response(null, { status: 200 });
  } });
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(dir); await server.stop(); server = undefined;
    const { db, id } = seed(dir, [chapter(1)]); db.close();
    server = await start(dir, { AUDIO_S3_BUCKET: 'exalt-test', AUDIO_S3_ENDPOINT: `http://127.0.0.1:${s3.port}`, AUDIO_S3_REGION: 'us-east-1', AUDIO_S3_ACCESS_KEY_ID: 'test-key', AUDIO_S3_SECRET_ACCESS_KEY: 'test-secret' });
    const gen = await finished(server.address, id);
    expect(gen.status).toBe('ready');
    expect(objects.size).toBe(1);
    const playback = await fetch(`${server.address}${gen.tracks[0].src}`, { redirect: 'manual' });
    expect(playback.status).toBe(302);
    const location = new URL(playback.headers.get('location')!);
    expect(location.searchParams.has('X-Amz-Signature')).toBe(true);
    const audio = new Uint8Array(await fetch(location).then((r) => r.arrayBuffer()));
    expect(new TextDecoder().decode(audio.subarray(4, 8))).toBe('ftyp');
    const check = new Database(join(dir, 'db.sqlite'));
    expect(check.query('SELECT storage FROM tracks WHERE generation_id = ?').get(id)).toEqual({ storage: 's3' });
    expect(check.query('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 }); check.close();
    expect(await Bun.file(join(dir, 'audio', String(id), '0.m4a')).exists()).toBe(false);
    expect(readdirSync(join(dir, 'audio', '.tmp'))).toEqual([]);
  } finally { await server?.stop(); s3.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 10000);
