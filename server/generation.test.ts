// Exercise the HTTP boundary and queue without consuming a real download or TTS quota.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const idp = await import(join(process.env.EXACT2 ?? join(import.meta.dir, '../../exact'), 'packages/sign-in/test/idp.mjs'));

// An offline server on an empty database of its own.
async function start(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-generation-'));
  const child = Bun.spawn([process.execPath, 'server/index.ts', '--offline'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DB: join(dir, 'db.sqlite'), AUDIO_DIR: join(dir, 'audio'), AUDIO_S3_BUCKET: '', ...extra },
    stdout: 'pipe', stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const address = new TextDecoder().decode(value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!address) { child.kill(); throw new Error('Test server did not start.'); }
  const call = (method: string, path: string, token = '', body?: BodyInit) => fetch(`${address}${path}`, { method, body,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } });
  const stop = async () => { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); };
  return { dir, address, call, stop };
}
type Server = Awaited<ReturnType<typeof start>>;
type Chapter = { idx: number; title: string; status: string; src: string; progress: number; error: string };
type Generation = { id: string; status: string; done: number; total: number; active: number; chapters: Chapter[]; tracks: { src: string }[];
  mine: number; limit: number; owner: boolean; signedIn: boolean };

// The version once nothing in it is waiting or narrating.
async function settled(s: Server, id: string, token = ''): Promise<Generation> {
  let g: Generation | undefined;
  for (let i = 0; i < 200; i++) {
    g = await s.call('GET', `/generations/${id}`, token).then((r) => r.json());
    if (g!.status === 'failed' || (g!.status === 'ready' && g!.active === 0)) return g!;
    await Bun.sleep(20);
  }
  throw new Error(`Version ${id} did not settle: ${JSON.stringify(g)}`);
}
const userId = (dir: string, name: string) => {
  const db = new Database(join(dir, 'db.sqlite'));
  try { return (db.query('SELECT id FROM users WHERE name = ?').get(name) as { id: number }).id; } finally { db.close(); }
};

test('a selected remote source requires sign-in and rights, is split into chapters, and only its first is narrated', async () => {
  const keyDir = mkdtempSync(join(tmpdir(), 'exalt-keys-'));
  const keys = join(keyDir, 'keys.json');
  await idp.jwks(keys);
  const s = await start({ SIGN_IN_TEST_KEYS: keys });
  try {
    const source = await fetch(`${s.address}/books/OL1W/sources`).then((r) => r.json());
    expect(source.files[0].id).toBe('lg-00000000000000000000000000000001');
    const endpoint = '/books/OL1W/generations?source=lg-00000000000000000000000000000001&model=exalt%2Fsilence';
    expect((await s.call('POST', `${endpoint}&rights=1`)).status).toBe(401);
    const { nonce, client } = await s.call('POST', '/sign-in/nonce', '', '{}').then((r) => r.json());
    const { credential } = await idp.respond({ identity: { providers: [{ provider: 'apple', configURL: 'https://appleid.apple.com', audience: 'app.exalt.audiobooks', nonce }] } }, keys, { first: true });
    const signedIn = await s.call('POST', '/sign-in/identity', '', JSON.stringify({ nonce, client, credential })).then((r) => r.json());
    expect(signedIn.ok).toBe(true);
    expect((await s.call('POST', endpoint, signedIn.token)).status).toBe(400);
    const made = await s.call('POST', `${endpoint}&rights=1`, signedIn.token);
    expect(made.status).toBe(202);
    const { id } = await made.json();
    const generation = await settled(s, id, signedIn.token);
    expect(generation.status).toBe('ready');
    // The offline download is three chapters: the first is narrated, the others wait to be asked for.
    expect(generation.chapters.map((c) => [c.title, c.status])).toEqual([
      ['Chapter One: The Harbour', 'ready'], ['Chapter Two: The River', 'idle'], ['Chapter Three: The Sea', 'idle']]);
    expect([generation.done, generation.total, generation.owner, generation.mine, generation.limit]).toEqual([1, 3, true, 0, 3]);
    expect(generation.tracks).toHaveLength(1);
    expect(generation.chapters[0].src).toBe(generation.tracks[0].src);
    const audio = await fetch(`${s.address}${generation.tracks[0].src}`);
    // The silent model answers in WAV; what is stored and served is the compressed M4A.
    expect(generation.tracks[0].src).toMatch(/\/0\.m4a$/);
    expect(audio.headers.get('content-type')).toBe('audio/mp4');
    const stored = new Uint8Array(await audio.arrayBuffer());
    expect(new TextDecoder().decode(stored.subarray(4, 8))).toBe('ftyp');
    const partial = await fetch(`${s.address}${generation.tracks[0].src}`, { headers: { range: 'bytes=10-19' } });
    expect(partial.status).toBe(206);
    expect((await partial.arrayBuffer()).byteLength).toBe(10);
    expect((await fetch(`${s.address}${generation.tracks[0].src}`, { headers: { range: 'bytes=20-10' } })).status).toBe(416);
    const suffix = await fetch(`${s.address}${generation.tracks[0].src}`, { headers: { range: 'bytes=-9999999' } });
    expect(suffix.status).toBe(206);
    const again = await s.call('POST', `${endpoint}&rights=1`, signedIn.token);
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(id);
    // The book counts a version once it has something to play.
    expect((await fetch(`${s.address}/books/OL1W`).then((r) => r.json())).book.versions).toBe(1);
    const inspection = new Database(join(s.dir, 'db.sqlite'));
    expect(inspection.query('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 });
    expect(inspection.query('SELECT source_ref, length(source_hash) AS hash_length FROM generations WHERE id = ?').get(id))
      .toEqual({ source_ref: 'lg-00000000000000000000000000000001', hash_length: 64 });
    // A chapter's text is kept until it is narrated, then only its audio.
    expect(inspection.query('SELECT idx, text IS NOT NULL AS kept FROM chapters WHERE generation_id = ? ORDER BY idx').all(id))
      .toEqual([{ idx: 0, kept: 0 }, { idx: 1, kept: 1 }, { idx: 2, kept: 1 }]);
    // Capacity counts what is stored: the M4A, not the PCM it was made from.
    expect(inspection.query('SELECT bytes, storage FROM tracks WHERE generation_id = ?').get(id)).toEqual({ bytes: stored.length, storage: 'local' });
    inspection.close();
  } finally {
    await s.stop();
    rmSync(keyDir, { recursive: true, force: true });
  }
}, 15000);

test('Generate narrates one chapter; an account has at most three waiting or narrating', async () => {
  const s = await start();
  try {
    const made = await s.call('POST', '/books/OL1W/generations?source=lg-00000000000000000000000000000001&model=exalt%2Fsilence&rights=1', 'ada');
    expect(made.status).toBe(202);
    const { id } = await made.json();
    await settled(s, id);
    expect((await s.call('POST', `/generations/${id}/chapters/1`)).status).toBe(401);
    // Anyone signed in may ask, not only its maker.
    const asked = await s.call('POST', `/generations/${id}/chapters/1`, 'grace');
    expect(asked.status).toBe(202);
    expect((await asked.json()).status).toBe('queued');
    let g = await settled(s, id, 'grace');
    expect(g.chapters.map((c) => c.status)).toEqual(['ready', 'ready', 'idle']);
    expect([g.done, g.tracks.length, g.owner, g.signedIn]).toEqual([2, 2, false, true]);
    // A narrated chapter is left as it is.
    const twice = await s.call('POST', `/generations/${id}/chapters/1`, 'grace');
    expect(twice.status).toBe(200);
    expect((await twice.json()).status).toBe('ready');
    expect((await s.call('POST', `/generations/${id}/chapters/9`, 'grace')).status).toBe(404);

    // Three chapters of grace's already narrating elsewhere: a fourth is refused until one is done.
    const db = new Database(join(s.dir, 'db.sqlite'));
    const grace = userId(s.dir, 'grace');
    const other = Number(db.query("INSERT INTO generations (book_id, made_by, model, voice, source_name, status, created_at) VALUES ('OL1W', 'x', 'exalt/silence', '', 'x', 'ready', 0)").run().lastInsertRowid);
    for (let i = 0; i < 3; i++) db.query("INSERT INTO chapters (generation_id, idx, title, text, status, requested_by) VALUES (?, ?, 'x', 'x', 'working', ?)").run(other, i, grace);
    g = await s.call('GET', `/generations/${id}`, 'grace').then((r) => r.json());
    expect([g.mine, g.limit]).toEqual([3, 3]);
    const fourth = await s.call('POST', `/generations/${id}/chapters/2`, 'grace');
    expect(fourth.status).toBe(429);
    expect((await fourth.json()).error).toBe('You have 3 chapters narrating. Wait for one to finish, then try again.');
    // Someone else's chapters don't count against grace's, but the server's whole queue does.
    db.query('UPDATE chapters SET requested_by = NULL WHERE generation_id = ?').run(other);
    for (let i = 3; i < 20; i++) db.query("INSERT INTO chapters (generation_id, idx, title, text, status) VALUES (?, ?, 'x', 'x', 'working')").run(other, i);
    const full = await s.call('POST', `/generations/${id}/chapters/2`, 'grace');
    expect(full.status).toBe(429);
    expect((await full.json()).error).toContain('queue is full');
    db.query('DELETE FROM chapters WHERE generation_id = ?').run(other);
    // A version being prepared counts as one of its maker's three.
    for (let i = 0; i < 3; i++) db.query("INSERT INTO generations (book_id, user_id, made_by, model, voice, source_name, status, created_at) VALUES ('OL1W', ?, 'x', 'exalt/silence', '', 'x', 'working', 0)").run(grace);
    expect((await s.call('POST', `/generations/${id}/chapters/2`, 'grace')).status).toBe(429);
    expect((await s.call('POST', '/books/OL1W/generations?model=exalt%2Fsilence&rights=1&name=b.txt', 'grace', 'x')).status).toBe(429);
    db.query("DELETE FROM generations WHERE status = 'working'").run();
    // A chapter whose text an older version didn't keep can't be narrated.
    db.query("UPDATE chapters SET text = NULL, status = 'unavailable' WHERE generation_id = ? AND idx = 2").run(id);
    const gone = await s.call('POST', `/generations/${id}/chapters/2`, 'grace');
    expect(gone.status).toBe(409);
    expect((await gone.json()).error).toContain('wasn’t kept');
    db.close();
  } finally { await s.stop(); }
}, 15000);

test('an upload is split into chapters, and only its maker can delete it, audio and all', async () => {
  const s = await start();
  try {
    const book = ['Chapter 1: Morning', 'Chapter 2: Noon', 'Chapter 3: Night']
      .map((h) => `${h}\n${'The light moves slowly over the water and the town wakes, turns, and settles again by evening. '.repeat(3)}`).join('\n');
    const made = await s.call('POST', '/books/OL2W/generations?model=exalt%2Fsilence&rights=1&name=days.txt', 'ada', book);
    expect(made.status).toBe(202);
    const { id } = await made.json();
    const g = await settled(s, id, 'ada');
    expect(g.chapters.map((c) => [c.title, c.status])).toEqual([['Chapter 1: Morning', 'ready'], ['Chapter 2: Noon', 'idle'], ['Chapter 3: Night', 'idle']]);
    expect(g.owner).toBe(true);
    const file = join(s.dir, 'audio', String(id), '0.m4a');
    expect(existsSync(file)).toBe(true);
    // Ada's own list shows it, with how much is narrated.
    const mine = await s.call('GET', '/me/audiobooks', 'ada').then((r) => r.json());
    expect(mine.map((m: { id: string; done: number; total: number }) => [m.id, m.done, m.total])).toEqual([[id, 1, 3]]);
    expect((await s.call('DELETE', `/generations/${id}`)).status).toBe(401);
    const notYours = await s.call('DELETE', `/generations/${id}`, 'grace');
    expect(notYours.status).toBe(403);
    expect((await notYours.json()).error).toBe('Only the person who made this audiobook can delete it.');
    expect((await s.call('DELETE', `/generations/${id}`, 'ada')).status).toBe(200);
    expect((await s.call('GET', `/generations/${id}`)).status).toBe(404);
    expect((await fetch(`${s.address}${g.tracks[0].src}`)).status).toBe(404);
    expect(existsSync(file)).toBe(false);
    expect((await fetch(`${s.address}/books/OL2W`).then((r) => r.json())).versions).toEqual([]);
    const db = new Database(join(s.dir, 'db.sqlite'));
    for (const table of ['chapters', 'tracks', 'generation_jobs']) expect(db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE generation_id = ?`).get(id)).toEqual({ n: 0 });
    db.close();
    expect((await s.call('DELETE', `/generations/${id}`, 'ada')).status).toBe(404);
  } finally { await s.stop(); }
}, 15000);
