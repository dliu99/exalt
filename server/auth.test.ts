// Sign-in checks (auth.ts) with ID tokens signed by exact's fixture provider, the way Apple
// and Google sign them: what is accepted, what is refused, and what a session can do.
// `bun test server` (EXACT2 names the exact2 checkout when it is not at ../exact).
import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DB = ':memory:';
const { auth } = await import('./auth.ts');
const idp = await import(join(process.env.EXACT2 ?? join(import.meta.dir, '../../exact'), 'packages/sign-in/test/idp.mjs'));

const keys = join(mkdtempSync(join(tmpdir(), 'exalt-auth-')), 'keys.json');
const APPLE = 'https://appleid.apple.com', GOOGLE = 'https://accounts.google.com/gsi/fedcm.json';
let clock = Date.now();
const accounts = auth({
  audiences: { apple: ['app.exalt.audiobooks', 'app.exalt.audiobooks.web'], google: ['exalt-web.apps.googleusercontent.com', 'exalt-ios.apps.googleusercontent.com'] },
  publicUrl: 'http://127.0.0.1:8787', webOrigins: ['https://exalt.example'],
  keys: async () => (await idp.jwks(keys)).keys, exchange: (code: string) => idp.exchange(keys, code), now: () => clock,
});
const ticket = (provider: 'apple' | 'google', nonce: string, audience: string, extra: Record<string, unknown> = {}) =>
  ({ identity: { providers: [{ provider, configURL: provider === 'apple' ? APPLE : GOOGLE, audience, nonce, ...extra }] } });
const bearer = (token: string) => new Request('http://x/me', { headers: { authorization: `Bearer ${token}` } });

test('Apple natively: the first sign-in keeps the name, and the session finds the account', async () => {
  const { nonce, client } = accounts.nonce({});
  const { credential } = await idp.respond(ticket('apple', nonce, 'app.exalt.audiobooks'), keys, { first: true });
  const { handle: _, ...posted } = credential;
  const done = await accounts.identity({ credential: posted, client, nonce });
  expect(done).toMatchObject({ ok: true, name: 'Ada Fixture', email: 'fixture@apple.example' });
  if (!done.ok) return;
  expect(accounts.user(bearer(done.token))).toMatchObject({ provider: 'apple', name: 'Ada Fixture' });

  // Apple sends the name only the first time; the account keeps it.
  const again = accounts.nonce({ client });
  const second = await idp.respond(ticket('apple', again.nonce, 'app.exalt.audiobooks'), keys);
  expect(await accounts.identity({ credential: second.credential, client, nonce: again.nonce })).toMatchObject({ ok: true, name: 'Ada Fixture' });

  accounts.signOut(bearer(done.token));
  expect(accounts.user(bearer(done.token))).toBeNull();
});

test('Google on iOS: its iOS client is an accepted audience', async () => {
  const { nonce, client } = accounts.nonce({});
  const { credential } = await idp.respond(ticket('google', nonce, 'exalt-ios.apps.googleusercontent.com'), keys);
  expect(await accounts.identity({ credential, client, nonce })).toMatchObject({ ok: true, email: 'fixture@google.example' });
});

test('refused: a reused nonce, another client, another audience, a stranger’s token, an expired one', async () => {
  const a = accounts.nonce({});
  const good = (await idp.respond(ticket('google', a.nonce, 'exalt-web.apps.googleusercontent.com'), keys)).credential;
  expect(await accounts.identity({ credential: good, client: a.client, nonce: a.nonce })).toMatchObject({ ok: true });
  expect(await accounts.identity({ credential: good, client: a.client, nonce: a.nonce })).toEqual({ ok: false, error: 'nonce' });

  const b = accounts.nonce({});
  const forB = (await idp.respond(ticket('google', b.nonce, 'exalt-web.apps.googleusercontent.com'), keys)).credential;
  expect(await accounts.identity({ credential: forB, client: 'someone-else', nonce: b.nonce })).toEqual({ ok: false, error: 'nonce' });

  const c = accounts.nonce({});
  const otherApp = (await idp.respond(ticket('google', c.nonce, 'another-app.apps.googleusercontent.com'), keys)).credential;
  expect(await accounts.identity({ credential: otherApp, client: c.client, nonce: c.nonce })).toEqual({ ok: false, error: 'aud' });

  const d = accounts.nonce({});
  const stranger = join(mkdtempSync(join(tmpdir(), 'exalt-auth-')), 'keys.json');
  const forged = (await idp.respond(ticket('google', d.nonce, 'exalt-web.apps.googleusercontent.com'), stranger)).credential;
  expect(await accounts.identity({ credential: forged, client: d.client, nonce: d.nonce })).toMatchObject({ ok: false });

  const e = accounts.nonce({});
  const old = (await idp.respond(ticket('google', e.nonce, 'exalt-web.apps.googleusercontent.com'), keys)).credential;
  clock += 11 * 60_000;
  expect(await accounts.identity({ credential: old, client: e.client, nonce: e.nonce })).toEqual({ ok: false, error: 'nonce' });
  clock = Date.now();
});

test('the web: Google redirects back, the page redeems the handle once', async () => {
  const { nonce, client } = accounts.nonce({ callback: 'http://localhost:5173/.exact/auth/callback' });
  const code = await idp.sign(keys, { fixtureCode: true, provider: 'google', aud: 'exalt-web.apps.googleusercontent.com', nonce, sub: 's', email: 'e' });
  const back = await accounts.back('GET', { code, state: 'st' });
  expect(back.status).toBe(303);
  const to = new URL(back.location!);
  expect(to.origin + to.pathname).toBe('http://localhost:5173/.exact/auth/callback');
  const relay = to.searchParams.get('relay')!;
  const credential = { type: 'identity', configURL: GOOGLE, token: { relay } };
  expect(await accounts.identity({ credential, client, nonce })).toMatchObject({ ok: true });
  const n = accounts.nonce({ client });
  expect(await accounts.identity({ credential, client, nonce: n.nonce })).toEqual({ ok: false, error: 'handle' });
});

test('the web: a page we do not serve is never a return address', () => {
  accounts.nonce({ callback: 'https://evil.example/.exact/auth/callback' });
  return accounts.back('GET', { error: 'access_denied', state: 'st' }).then((r) => {
    expect(new URL(r.location!).origin).toBe('https://exalt.example');
  });
});

test('Google from the iPhone app: an access token Google issued to the iOS client opens a session; another app’s is refused', async () => {
  const issued: Record<string, { aud: string; sub: string; email: string; name: string }> = {
    'ios-token': { aud: 'exalt-ios.apps.googleusercontent.com', sub: 'g-42', email: 'grace@google.example', name: 'Grace Hopper' },
    'other-token': { aud: 'another-app.apps.googleusercontent.com', sub: 'g-42', email: 'grace@google.example', name: 'Grace Hopper' },
  };
  const native = auth({
    audiences: { apple: ['app.exalt.audiobooks'], google: ['exalt-web.apps.googleusercontent.com', 'exalt-ios.apps.googleusercontent.com'] },
    publicUrl: 'http://127.0.0.1:8787', webOrigins: [], googleAccess: async (t) => issued[t] ?? null, now: () => clock,
  });
  const post = (token?: string) => new Request('http://x/sign-in/google', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
  const done = await native.google(post('ios-token'));
  expect(done).toMatchObject({ ok: true, name: 'Grace Hopper', email: 'grace@google.example' });
  if (done.ok) expect(native.user(bearer(done.token))).toMatchObject({ provider: 'google', sub: 'g-42' });
  expect(await native.google(post('other-token'))).toEqual({ ok: false, error: 'aud' });
  expect(await native.google(post('forged'))).toEqual({ ok: false, error: 'token' });
  expect(await native.google(post())).toEqual({ ok: false, error: 'no token' });
});

test('Apple from the iPhone app: the return route sends the sheet back to the app’s own scheme, and the app redeems the handle', async () => {
  const APP = 'app.exalt.audiobooks:/signed-in';
  const sheet = auth({
    audiences: { apple: ['app.exalt.audiobooks', 'app.exalt.audiobooks.web'], google: [] },
    publicUrl: 'http://127.0.0.1:8787', webOrigins: ['https://exalt.example'], appCallbacks: [APP],
    keys: async () => (await idp.jwks(keys)).keys, now: () => clock,
  });
  const { nonce, client } = sheet.nonce({ callback: APP });
  const id_token = await idp.sign(keys, { iss: 'https://appleid.apple.com', exp: Math.floor(clock / 1000) + 600, aud: 'app.exalt.audiobooks.web', nonce, sub: 'a-7', email: 'ada@apple.example' });
  const back = await sheet.back('POST', { id_token, code: 'c', state: 'st', user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Apple' } }) });
  expect(back.status).toBe(303);
  expect(back.location!.startsWith(`${APP}?`)).toBe(true);
  const relay = new URL(back.location!).searchParams.get('relay')!;
  const credential = { type: 'identity', configURL: APPLE, token: { relay } };
  expect(await sheet.identity({ credential, client, nonce })).toMatchObject({ ok: true, name: 'Ada Apple', email: 'ada@apple.example' });

  // Another app's scheme is never a return address.
  sheet.nonce({ callback: 'evil.app:/signed-in' });
  const r = await sheet.back('GET', { error: 'access_denied', state: 'st' });
  expect(r.location!.startsWith('evil.app')).toBe(false);
});
