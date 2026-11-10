import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wav } from './tts.ts';

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
    if (value.status === 'ready' || value.status === 'failed') return value;
    await Bun.sleep(20);
  }
  throw new Error('Recovery did not finish.');
}

test('restart resumes the durable queue, keeps completed chapters and deletes temporary text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-recovery-'));
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(dir); await server.stop(); server = undefined;
    const { db, id } = seed(dir);
    const first = wav(new Uint8Array(32).fill(7), 8000);
    await Bun.write(join(dir, 'audio', String(id), '0.wav'), first);
    db.query("INSERT INTO tracks (generation_id,idx,title,file,bytes,storage) VALUES (?,0,'Kept chapter',?,?, 'local')").run(id, `${id}/0.wav`, first.length);
    db.close();
    server = await start(dir);
    const gen = await finished(server.address, id);
    expect(gen.status).toBe('ready'); expect(gen.done).toBe(2);
    expect(gen.tracks[0].title).toBe('Kept chapter');
    expect(new Uint8Array(await Bun.file(join(dir, 'audio', String(id), '0.wav')).arrayBuffer())).toEqual(first);
    const check = new Database(join(dir, 'db.sqlite'));
    expect(check.query('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 });
    check.close();
    // The second chapter crosses TTS chunk boundaries; every PCM chunk belongs in the WAV.
    const second = Bun.file(join(dir, 'audio', String(id), '1.wav'));
    expect(second.size).toBeGreaterThan(16044);
    const header = new DataView(await second.slice(0, 44).arrayBuffer());
    expect(header.getUint32(40, true)).toBe(second.size - 44);
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
      expect(req.headers.get('content-type')).toBe('audio/wav');
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
    const audio = await fetch(location);
    expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(44);
    const check = new Database(join(dir, 'db.sqlite'));
    expect(check.query('SELECT storage FROM tracks WHERE generation_id = ?').get(id)).toEqual({ storage: 's3' });
    expect(check.query('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 }); check.close();
    expect(await Bun.file(join(dir, 'audio', String(id), '0.wav')).exists()).toBe(false);
    expect(readdirSync(join(dir, 'audio', '.tmp'))).toEqual([]);
  } finally { await server?.stop(); s3.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 10000);
