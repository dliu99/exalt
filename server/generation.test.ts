// Exercise the HTTP boundary and queue without consuming a real download or TTS quota.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const idp = await import(join(process.env.EXACT2 ?? join(import.meta.dir, '../../exact'), 'packages/sign-in/test/idp.mjs'));

test('a selected remote source requires sign-in and rights, then becomes playable audio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-generation-'));
  const keys = join(dir, 'keys.json');
  await idp.jwks(keys);
  const child = Bun.spawn([process.execPath, 'server/index.ts', '--offline'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DB: join(dir, 'db.sqlite'), AUDIO_DIR: join(dir, 'audio'), SIGN_IN_TEST_KEYS: keys },
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    const address = new TextDecoder().decode(value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (!address) throw new Error('Test server did not start.');
    reader.releaseLock();
    const request = (path: string, token = '', body?: unknown) => fetch(`${address}${path}`, { method: 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const source = await fetch(`${address}/books/OL1W/sources`).then((r) => r.json());
    expect(source.files[0].id).toBe('lg-00000000000000000000000000000001');
    const endpoint = '/books/OL1W/generations?source=lg-00000000000000000000000000000001&model=exalt%2Fsilence';
    expect((await request(`${endpoint}&rights=1`)).status).toBe(401);
    const { nonce, client } = await request('/sign-in/nonce', '', {}).then((r) => r.json());
    const { credential } = await idp.respond({ identity: { providers: [{ provider: 'apple', configURL: 'https://appleid.apple.com', audience: 'app.exalt.audiobooks', nonce }] } }, keys, { first: true });
    const signedIn = await request('/sign-in/identity', '', { nonce, client, credential }).then((r) => r.json());
    expect(signedIn.ok).toBe(true);
    expect((await request(endpoint, signedIn.token)).status).toBe(400);
    const made = await request(`${endpoint}&rights=1`, signedIn.token);
    expect(made.status).toBe(202);
    const { id } = await made.json();
    let generation;
    for (let i = 0; i < 50; i++) {
      generation = await fetch(`${address}/generations/${id}`).then((r) => r.json());
      if (generation.status === 'ready' || generation.status === 'failed') break;
      await Bun.sleep(20);
    }
    expect(generation.status).toBe('ready');
    expect(generation.tracks).toHaveLength(1);
    const audio = await fetch(`${address}${generation.tracks[0].src}`);
    expect(audio.headers.get('content-type')).toBe('audio/wav');
    expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(44);
    const partial = await fetch(`${address}${generation.tracks[0].src}`, { headers: { range: 'bytes=10-19' } });
    expect(partial.status).toBe(206);
    expect((await partial.arrayBuffer()).byteLength).toBe(10);
    expect((await fetch(`${address}${generation.tracks[0].src}`, { headers: { range: 'bytes=20-10' } })).status).toBe(416);
    const suffix = await fetch(`${address}${generation.tracks[0].src}`, { headers: { range: 'bytes=-9999999' } });
    expect(suffix.status).toBe(206);
    const again = await request(`${endpoint}&rights=1`, signedIn.token);
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(id);
    const inspection = new Database(join(dir, 'db.sqlite'));
    expect(inspection.query('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 });
    expect(inspection.query('SELECT source_ref, length(source_hash) AS hash_length FROM generations WHERE id = ?').get(id))
      .toEqual({ source_ref: 'lg-00000000000000000000000000000001', hash_length: 64 });
    expect(inspection.query('SELECT bytes, storage FROM tracks WHERE generation_id = ?').get(id)).toEqual({ bytes: 16044, storage: 'local' });
    // Active reservations, not just worker jobs, count toward admission limits.
    const uid = (inspection.query('SELECT id FROM users LIMIT 1').get() as { id: number }).id;
    for (let i = 0; i < 2; i++) inspection.query("INSERT INTO generations (book_id, user_id, made_by, model, voice, source_name, status, created_at) VALUES ('OL1W', ?, 'test', 'exalt/silence', '', 'test', 'queued', 0)").run(uid);
    expect((await request('/books/OL1W/generations?model=exalt%2Fsilence&rights=1', signedIn.token)).status).toBe(429);
    for (let i = 0; i < 18; i++) inspection.query("INSERT INTO generations (book_id,made_by,model,voice,source_name,status,created_at) VALUES ('OL1W','other','exalt/silence','','test','queued',0)").run();
    const full = await request('/books/OL1W/generations?model=exalt%2Fsilence&rights=1', signedIn.token);
    expect(full.status).toBe(429);
    expect((await full.json()).error).toContain('queue is full');
    inspection.close();
  } finally {
    child.kill(); await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
