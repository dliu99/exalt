// Listening places that follow a signed-in listener between devices: the server's routes
// (GET and PUT /me/places), and app.ts's places as a phone and a fresh browser see them, against
// the offline server with exact's fixture sign-in. `bun test server`.
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const idp = await import(join(process.env.EXACT2 ?? join(import.meta.dir, '../../exact'), 'packages/sign-in/test/idp.mjs'));
const dir = mkdtempSync(join(tmpdir(), 'exalt-places-'));
const keys = join(dir, 'keys.json');
let child: ReturnType<typeof Bun.spawn>, address = '', gen = 0, other = 0;

beforeAll(async () => {
  await idp.jwks(keys);
  child = Bun.spawn([process.execPath, 'server/index.ts', '--offline'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DB: join(dir, 'db.sqlite'), AUDIO_DIR: join(dir, 'audio'), SIGN_IN_TEST_KEYS: keys },
    stdout: 'pipe', stderr: 'pipe',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  address = new TextDecoder().decode(value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? '';
  if (!address) throw new Error('Test server did not start.');
  reader.releaseLock();
  // Two finished audiobooks of the fixture's book, written straight into the server's database.
  const db = new Database(join(dir, 'db.sqlite'));
  db.run('PRAGMA busy_timeout = 5000');
  db.run("INSERT OR IGNORE INTO books (id, title, author, year, cover, description) VALUES ('OL1W', 'A Quiet Harbour', 'Test Author', 2001, 'https://covers.example/1.jpg', '')");
  const made = db.query(`INSERT INTO generations (book_id, made_by, model, voice, source_name, status, done, total, error, created_at)
    VALUES ('OL1W', 'Ada', 'exalt/silence', '', 'harbour.txt', 'ready', 10, 10, '', 0)`);
  gen = Number(made.run().lastInsertRowid);
  other = Number(made.run().lastInsertRowid);
  db.close();
});
afterAll(() => child?.kill());

const signIn = async (provider: 'google' | 'apple' = 'google') => {
  const post = (path: string, body: unknown) => fetch(`${address}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { nonce, client } = await post('/sign-in/nonce', {});
  const ticket = provider === 'google'
    ? { provider, configURL: 'https://accounts.google.com/gsi/fedcm.json', audience: 'exalt-web.apps.googleusercontent.com', nonce }
    : { provider, configURL: 'https://appleid.apple.com', audience: 'app.exalt.audiobooks', nonce };
  const { credential } = await idp.respond({ identity: { providers: [ticket] } }, keys, { first: provider === 'apple' });
  const { handle: _, ...posted } = credential;
  const done = await post('/sign-in/identity', { credential: posted, client, nonce });
  if (!done.ok) throw new Error(`sign-in: ${JSON.stringify(done)}`);
  return done.token as string;
};
const auth = (token: string) => (token ? { authorization: `Bearer ${token}` } : {});
const list = (token: string) => fetch(`${address}/me/places`, { headers: auth(token) });
const put = (token: string, g: number | string, body: unknown) => fetch(`${address}/me/places/${g}`, {
  method: 'PUT', headers: { 'content-type': 'application/json', ...auth(token) }, body: JSON.stringify(body) });

test('the routes: an account is required, and the newest place wins', async () => {
  const at = Date.now() - 60_000;
  const place = { track: 2, tracks: 10, time: 61.5, duration: 300, at };
  expect((await list('')).status).toBe(401);
  expect((await put('', gen, place)).status).toBe(401);
  expect((await put('not-a-session', gen, place)).status).toBe(401);

  const phone = await signIn(), web = await signIn();
  expect((await put(phone, 999999, place)).status).toBe(404);
  expect((await put(phone, gen, { ...place, track: 10 })).status).toBe(400);
  expect((await put(phone, gen, { ...place, time: -1 })).status).toBe(400);
  expect((await put(phone, gen, { ...place, at: 'later' })).status).toBe(400);

  const kept = await put(phone, gen, place);
  expect(kept.status).toBe(200);
  expect(await kept.json()).toEqual({ gen: String(gen), book: 'OL1W', title: 'A Quiet Harbour', author: 'Test Author',
    cover: 'https://covers.example/1.jpg', track: 2, tracks: 10, time: 61.5, duration: 300, at, finished: false });
  // The same account on another device finds it.
  expect(await list(web).then((r) => r.json())).toMatchObject([{ gen: String(gen), track: 2, time: 61.5 }]);

  // An older place doesn't replace a newer one; a newer one does.
  expect(await put(web, gen, { ...place, track: 1, at: at - 1000 }).then((r) => r.json())).toMatchObject({ track: 2, at });
  expect(await put(web, gen, { ...place, track: 3, time: 5, at: at + 1000 }).then((r) => r.json())).toMatchObject({ track: 3, time: 5, at: at + 1000 });
  expect(await list(phone).then((r) => r.json())).toMatchObject([{ gen: String(gen), track: 3 }]);

  // A clock ahead of the server's counts as now, so it can't win over every later place.
  const ahead = await put(phone, other, { ...place, at: Date.now() + 86_400_000 }).then((r) => r.json());
  expect(ahead.at).toBeLessThanOrEqual(Date.now());
  // Newest first; a finished book stays listed, marked, so other devices drop theirs.
  await put(web, gen, { ...place, track: 9, time: 290, at: Date.now(), finished: true });
  expect((await list(phone).then((r) => r.json())).map((p: { gen: string; finished: boolean }) => [p.gen, p.finished]))
    .toEqual([[String(gen), true], [String(other), false]]);

  // Places are each account's own.
  expect(await list(await signIn('apple')).then((r) => r.json())).toEqual([]);
});

test('app.ts: a place from the phone appears on a fresh browser after sign-in, and the newest wins', async () => {
  // app.ts reads the server's address at load, and uses Exact's packages only to sign in.
  process.env.API_BASE_URL = address;
  mock.module('@exact/passkeys', () => ({ credentials: {} }));
  mock.module('@exact/sign-in', () => ({ preventSilentAccess: async () => {} }));
  const { answer } = await import('../app.ts');
  const device = (token = '') => {
    const kept = new Map<string, string>(token ? [['exalt.session', JSON.stringify({ token, name: 'Ada' })]] : []);
    return { get: (k: string) => kept.get(k) ?? null, set: (k: string, v: string) => void kept.set(k, v), forget: (k: string) => void kept.delete(k), has: (k: string) => kept.has(k) };
  };
  // The app's data sources, as the view calls them.
  const call = (source: string, args: unknown[], store: ReturnType<typeof device>) =>
    (answer as unknown as (s: string, a: unknown[], st: unknown, sg: unknown) => Promise<any>)(source, args, store, {});
  const save = (store: ReturnType<typeof device>, g: number, track: number, time: number, duration: number, at: number) =>
    call('savePlace', [String(g), 'OL1W', 'A Quiet Harbour', 'Test Author', 'https://covers.example/1.jpg', track, 10, time, duration, at], store);

  // A new account's audiobooks: the first test's places belong to the other two generations' rows.
  const db = new Database(join(dir, 'db.sqlite'));
  db.run('PRAGMA busy_timeout = 5000');
  const fresh = Number(db.query(`INSERT INTO generations (book_id, made_by, model, voice, source_name, status, done, total, error, created_at)
    VALUES ('OL1W', 'Ada', 'exalt/silence', '', 'harbour.txt', 'ready', 10, 10, '', 0)`).run().lastInsertRowid);
  db.query('DELETE FROM places').run();
  db.close();

  const t = Date.now() - 600_000;
  const phone = device(await signIn());
  await save(phone, fresh, 4, 30, 300, t);

  // A browser that has never played it signs in to the same account: the place is there, and on Home's shelf.
  const web = device(await signIn());
  expect(await call('loadPlaces', [], web)).toEqual([{ gen: String(fresh), book: 'OL1W', title: 'A Quiet Harbour', author: 'Test Author',
    cover: 'https://covers.example/1.jpg', track: 4, tracks: 10, time: 30, duration: 300, at: t }]);
  expect((await call('loadShelf', [Date.now()], web))[0]).toMatchObject({ book: 'OL1W', gen: String(fresh), chapter: 'Chapter 5 of 10' });

  // The browser listens on; the phone's own, older place gives way to it.
  await save(web, fresh, 5, 12, 300, t + 60_000);
  expect(await call('loadPlaces', [], phone)).toMatchObject([{ gen: String(fresh), track: 5, time: 12 }]);
  // Then the phone again, later still: the browser picks that up.
  await save(phone, fresh, 6, 0, 0, t + 120_000);
  expect(await call('loadPlaces', [], web)).toMatchObject([{ gen: String(fresh), track: 6 }]);

  // Finished on the browser (the last chapter's last half minute): gone from the phone too.
  await save(web, fresh, 9, 290, 300, t + 180_000);
  expect(await call('loadPlaces', [], web)).toEqual([]);
  expect(await call('loadPlaces', [], phone)).toEqual([]);

  // Signed out, a place stays on its device and never reaches the account.
  const borrowed = device();
  await save(borrowed, fresh, 1, 10, 300, t + 240_000);
  expect(await call('loadPlaces', [], borrowed)).toMatchObject([{ gen: String(fresh), track: 1 }]);
  expect(await list(await signIn()).then((r) => r.json())).toMatchObject([{ gen: String(fresh), finished: true }]);
});
