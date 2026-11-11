// Narrating ahead: a signed-in listener's place (PUT /me/places/:gen) asks for the chapter after
// theirs if nobody has, on their behalf and within their three; at the limit nothing happens.
// Against the offline server with exact's fixture sign-in. `bun test server`.
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const idp = await import(join(process.env.EXACT2 ?? join(import.meta.dir, '../../exact'), 'packages/sign-in/test/idp.mjs'));
const dir = mkdtempSync(join(tmpdir(), 'exalt-ahead-'));
const keys = join(dir, 'keys.json');
let child: ReturnType<typeof Bun.spawn>, address = '';

beforeAll(async () => {
  await idp.jwks(keys);
  child = Bun.spawn([process.execPath, 'server/index.ts', '--offline'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DB: join(dir, 'db.sqlite'), AUDIO_DIR: join(dir, 'audio'), AUDIO_S3_BUCKET: '', SIGN_IN_TEST_KEYS: keys },
    stdout: 'pipe', stderr: 'pipe',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  address = new TextDecoder().decode(value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? '';
  reader.releaseLock();
  if (!address) throw new Error('Test server did not start.');
});
afterAll(async () => { child?.kill(); await child?.exited; rmSync(dir, { recursive: true, force: true }); });

async function signIn() {
  const post = (path: string, body: unknown) => fetch(`${address}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { nonce, client } = await post('/sign-in/nonce', {});
  const { credential } = await idp.respond({ identity: { providers: [{ provider: 'google', configURL: 'https://accounts.google.com/gsi/fedcm.json', audience: 'exalt-web.apps.googleusercontent.com', nonce }] } }, keys, {});
  const { handle: _, ...posted } = credential;
  const done = await post('/sign-in/identity', { credential: posted, client, nonce });
  if (!done.ok) throw new Error(`sign-in: ${JSON.stringify(done)}`);
  return done.token as string;
}
type Chapter = { idx: number; status: string };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const chapters = (token: string, gen: string) => fetch(`${address}/generations/${gen}`, { headers: auth(token) }).then((r) => r.json() as Promise<{ status: string; active: number; chapters: Chapter[]; mine: number }>);
const settled = async (token: string, gen: string) => {
  for (let i = 0; i < 300; i++) { const g = await chapters(token, gen); if (g.status === 'ready' && g.active === 0) return g; await Bun.sleep(20); }
  throw new Error('The version did not settle.');
};
let at = Date.now() - 600_000;
const place = (token: string, gen: string, track: number, finished = false) => fetch(`${address}/me/places/${gen}`, {
  method: 'PUT', headers: { 'content-type': 'application/json', ...auth(token) },
  body: JSON.stringify({ track, tracks: 3, time: 0, duration: 0, at: (at += 1000), finished }) });

test('reaching a chapter asks for the next one, within the listener’s three, and skips at the limit', async () => {
  const token = await signIn();
  const made = await fetch(`${address}/books/OL1W/generations?source=lg-00000000000000000000000000000001&model=exalt%2Fsilence&rights=1`, { method: 'POST', headers: auth(token) });
  expect(made.status).toBe(202);
  const { id } = await made.json() as { id: string };
  let g = await settled(token, id);
  expect(g.chapters.map((c) => c.status)).toEqual(['ready', 'idle', 'idle']);

  // Listening to the first chapter: the second is narrated, on this listener's behalf.
  expect((await place(token, id, 0)).status).toBe(200);
  const db = new Database(join(dir, 'db.sqlite'));
  db.run('PRAGMA busy_timeout = 5000');
  const user = (db.query("SELECT user_id FROM generations WHERE id = ?").get(id) as { user_id: number }).user_id;
  expect(db.query('SELECT requested_by FROM chapters WHERE generation_id = ? AND idx = 1').get(id)).toEqual({ requested_by: user });
  g = await settled(token, id);
  expect(g.chapters.map((c) => c.status)).toEqual(['ready', 'ready', 'idle']);
  // Again at the same place, or at a finished book: nothing more.
  await place(token, id, 0);
  await place(token, id, 1, true);
  expect((await chapters(token, id)).chapters[2].status).toBe('idle');

  // Three chapters of theirs narrating elsewhere: the place is kept, and nothing is asked for.
  const other = Number(db.query("INSERT INTO generations (book_id, made_by, model, voice, source_name, status, created_at) VALUES ('OL1W', 'x', 'exalt/silence', '', 'x', 'ready', 0)").run().lastInsertRowid);
  for (let i = 0; i < 3; i++) db.query("INSERT INTO chapters (generation_id, idx, title, text, status, requested_by) VALUES (?, ?, 'x', 'x', 'working', ?)").run(other, i, user);
  const full = await place(token, id, 1);
  expect(full.status).toBe(200);
  expect((await full.json()).track).toBe(1);
  g = await chapters(token, id);
  expect([g.chapters[2].status, g.mine]).toEqual(['idle', 3]);
  // One of them done: the next place asks for it.
  db.query('DELETE FROM chapters WHERE generation_id = ? AND idx = 0').run(other);
  await place(token, id, 1);
  expect(['queued', 'working', 'ready']).toContain((await chapters(token, id)).chapters[2].status);
  db.query('DELETE FROM chapters WHERE generation_id = ?').run(other);
  g = await settled(token, id);
  expect(g.chapters.map((c) => c.status)).toEqual(['ready', 'ready', 'ready']);
  // The last chapter has none after it.
  expect((await place(token, id, 2)).status).toBe(200);
  db.close();
}, 20000);

test('a chapter that failed is left for its Retry, not narrated ahead', async () => {
  const token = await signIn();
  const book = ['Chapter 1: Morning', 'Chapter 2: Noon', 'Chapter 3: Night']
    .map((h) => `${h}\n${'The light moves slowly over the water and the town wakes, turns, and settles again by evening. '.repeat(3)}`).join('\n');
  const made = await fetch(`${address}/books/OL2W/generations?model=exalt%2Fsilence&rights=1&name=days.txt`, { method: 'POST', headers: auth(token), body: book });
  const { id } = await made.json() as { id: string };
  await settled(token, id);
  const db = new Database(join(dir, 'db.sqlite'));
  db.run('PRAGMA busy_timeout = 5000');
  db.query("UPDATE chapters SET status = 'failed', error = 'It broke.' WHERE generation_id = ? AND idx = 1").run(id);
  db.close();
  expect((await place(token, id, 0)).status).toBe(200);
  expect((await chapters(token, id)).chapters[1].status).toBe('failed');
});
