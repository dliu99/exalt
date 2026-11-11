// Accounts: Sign in with Apple and Google (../exact/docs/recipes/sign-in.md). The app asks
// for a nonce, the provider signs an ID token over it, and this file checks the token and
// answers a session token of Exalt's own, kept by the app and sent as a bearer token.
//
//   POST /sign-in/nonce     {client?, callback?}        → {nonce, client}  single use, five minutes
//   GET  /sign-in/return    Google's redirect (code, state), on the web
//   POST /sign-in/return    Apple's form_post (code, id_token, state, user?), on the web
//                           → 303 to the page's /.exact/auth/callback with `state` and `relay=<handle>`
//   POST /sign-in/identity  {credential, client, nonce} → {ok, token, name, email} | {ok: false, error}
//                           The iPhone app's Apple sign-in uses this route too, in the system sheet:
//                           its nonce names the app's own callback (appCallbacks), where the 303 goes.
//   POST /sign-in/google    bearer: Google's access token → the same; the iPhone app, which signs
//                           in through @exact/oauth because exact's native Google identity is unbuilt
//   GET  /me                bearer                       → {name, email} | 401
//   POST /sign-out          bearer                       → {ok}
//
// Who may sign in is the clients app.ts names (CLIENTS): the token's `aud` must be one of
// them. Under `--offline` with SIGN_IN_TEST_KEYS, tokens signed by exact's fixture provider
// (packages/sign-in/test/idp.mjs) are trusted instead of Apple's and Google's keys.
import { db } from './db.ts';

db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,          -- apple | google
  sub TEXT NOT NULL,               -- the provider's id for the person
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (provider, sub)
)`);
db.run(`CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,     -- SHA-256 of the bearer token; the token itself is never stored
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
)`);
// Databases made before accounts gain the column; older audiobooks have no owner.
if (!(db.query('PRAGMA table_info(generations)').all() as { name: string }[]).some((c) => c.name === 'user_id'))
  db.run('ALTER TABLE generations ADD COLUMN user_id INTEGER REFERENCES users(id)');

export type Provider = 'apple' | 'google';
export type User = { id: number; provider: Provider; sub: string; name: string; email: string };
type Jwk = JsonWebKey & { kid?: string };
type Claims = { iss?: string; aud?: string; exp?: number; nonce?: string; sub?: string; email?: string; name?: string };
type Result = { ok: true; token: string; name: string; email: string } | { ok: false; error: string };

const TTL = 5 * 60_000;
const SESSION_DAYS = 90;
const ISSUERS: Record<Provider, string[]> = { apple: ['https://appleid.apple.com'], google: ['https://accounts.google.com', 'accounts.google.com'] };
const PUBLISHED: Record<Provider, string> = { apple: 'https://appleid.apple.com/auth/keys', google: 'https://www.googleapis.com/oauth2/v3/certs' };
const CONFIG: Record<string, Provider> = { 'https://appleid.apple.com': 'apple', 'https://accounts.google.com/gsi/fedcm.json': 'google' };
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const random = (n: number) => b64(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
const part = (s: string) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString()); } catch { return null; } };

export type AuthOptions = {
  /** The accepted `aud` per provider: the app's clients (its bundle ID for Apple natively). */
  audiences: Record<Provider, string[]>;
  /** This server's public address, for the web return route's redirect URI. */
  publicUrl: string;
  /** Page origins the return route may send a browser back to; loopback ones are always allowed. */
  webOrigins: string[];
  /** The app's own callbacks (its URL scheme) the return route may send the iPhone app's sign-in sheet back to. */
  appCallbacks?: string[];
  /** Google's web client secret, for exchanging the web redirect's code. */
  googleSecret?: string;
  /** The providers' signing keys; their published keys by default. */
  keys?: (provider: Provider) => Promise<Jwk[]>;
  /** What Google says of an access token: its client, the person and their name; Google's tokeninfo and userinfo by default. */
  googleAccess?: (accessToken: string) => Promise<GoogleAccess | null>;
  /** Google's code for its ID token; Google's token endpoint by default. */
  exchange?: (code: string) => Promise<string | null>;
  now?: () => number;
};

export function auth(o: AuthOptions) {
  const now = o.now ?? Date.now;
  const nonces = new Map<string, { client: string; callback: string; expires: number }>();
  const handles = new Map<string, { provider: Provider; token: string; user: AppleUser | null; expires: number }>();
  let lastCallback = '';
  const published = new Map<Provider, { keys: Jwk[]; at: number }>();

  const keysOf = o.keys ?? (async (provider: Provider) => {
    const held = published.get(provider);
    if (held && now() - held.at < 3600_000) return held.keys;
    const keys = ((await (await fetch(PUBLISHED[provider])).json()) as { keys: Jwk[] }).keys;
    published.set(provider, { keys, at: now() });
    return keys;
  });

  const exchange = o.exchange ?? (async (code: string) => {
    const [client] = o.audiences.google;
    if (!o.googleSecret || !client) return null;
    const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
      code, client_id: client, client_secret: o.googleSecret, redirect_uri: `${o.publicUrl}/sign-in/return`, grant_type: 'authorization_code',
    }) });
    return res.ok ? String(((await res.json()) as { id_token?: string }).id_token ?? '') || null : null;
  });

  const googleAccess = o.googleAccess ?? (async (accessToken: string): Promise<GoogleAccess | null> => {
    const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!info.ok) return null;
    const t = (await info.json()) as { aud?: string; azp?: string; sub?: string; email?: string; expires_in?: string };
    const me = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${accessToken}` } })
      .then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as { name?: string; email?: string };
    return { aud: String(t.aud ?? t.azp ?? ''), sub: String(t.sub ?? ''), email: String(t.email ?? me.email ?? ''), name: String(me.name ?? '') };
  });

  const sweep = () => {
    const t = now();
    for (const [k, v] of nonces) if (v.expires < t) nonces.delete(k);
    for (const [k, v] of handles) if (v.expires < t) handles.delete(k);
  };

  /** Where a page's sign-in comes back to: its own callback, if its origin is one we serve. */
  const allowedCallback = (url: string) => {
    if (o.appCallbacks?.includes(url)) return url;
    try {
      const u = new URL(url);
      return u.pathname === '/.exact/auth/callback' && (LOOPBACK.test(u.origin) || o.webOrigins.includes(u.origin)) ? u.toString() : '';
    } catch { return ''; }
  };

  /** An ID token's checks: signature, issuer, audience, expiry and the nonce issued for it. */
  async function verify(provider: Provider, token: string, nonce: string): Promise<{ claims: Claims } | { error: string }> {
    const [h, p, s] = String(token ?? '').split('.');
    if (!s) return { error: 'malformed' };
    const head = part(h), claims = part(p) as Claims | null;
    if (!head || !claims) return { error: 'malformed' };
    const jwk = (await keysOf(provider)).find((k) => k.kid === head.kid);
    if (!jwk) return { error: 'unknown key' };
    const alg = head.alg === 'ES256' ? [{ name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }]
      : head.alg === 'RS256' ? [{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, { name: 'RSASSA-PKCS1-v1_5' }] : null;
    if (!alg) return { error: `alg ${head.alg}` };
    const key = await crypto.subtle.importKey('jwk', jwk, alg[0], false, ['verify']);
    if (!(await crypto.subtle.verify(alg[1], key, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${p}`)))) return { error: 'signature' };
    if (!ISSUERS[provider].includes(String(claims.iss))) return { error: 'iss' };
    if (!o.audiences[provider].includes(String(claims.aud))) return { error: 'aud' };
    if (!(Number(claims.exp) * 1000 > now())) return { error: 'exp' };
    if (!nonce || claims.nonce !== nonce) return { error: 'nonce' };
    if (!claims.sub) return { error: 'sub' };
    return { claims };
  }

  function account(provider: Provider, claims: Claims, appleUser: AppleUser | null): User {
    // Apple sends the name once, on the first authorization; Google's token may carry it.
    const given = appleUser?.name ? [appleUser.name.firstName, appleUser.name.lastName].filter(Boolean).join(' ') : String(claims.name ?? '');
    const email = String(claims.email ?? appleUser?.email ?? '');
    db.query(`INSERT INTO users (provider, sub, name, email, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, sub) DO UPDATE SET
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE users.name END,
        email = CASE WHEN excluded.email != '' THEN excluded.email ELSE users.email END`)
      .run(provider, String(claims.sub), given.slice(0, 80), email, now());
    return db.query('SELECT * FROM users WHERE provider = ? AND sub = ?').get(provider, String(claims.sub)) as User;
  }

  function startSession(user: User) {
    const token = random(32);
    db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, now() + SESSION_DAYS * 86400_000);
    return token;
  }

  return {
    nonce(body: { client?: unknown; callback?: unknown }) {
      sweep();
      const nonce = random(24), client = String(body.client || random(12));
      const callback = allowedCallback(String(body.callback ?? ''));
      if (callback) lastCallback = callback;
      nonces.set(nonce, { client, callback, expires: now() + TTL });
      return { nonce, client };
    },

    /** The web's return route: the provider's answer is kept under a single-use handle the page redeems. */
    async back(method: 'GET' | 'POST', f: Record<string, string>): Promise<{ status: number; location?: string; body?: string }> {
      if (!f.state) return { status: 400, body: 'no state' };
      let kept: { provider: Provider; token: string; user: AppleUser | null } | null = null;
      if (!f.error) {
        if (method === 'POST') {
          if (!f.id_token) return { status: 400, body: 'no id_token' };
          let user: AppleUser | null = null;
          try { user = f.user ? JSON.parse(f.user) : null; } catch { /* a malformed name is no name */ }
          kept = { provider: 'apple', token: f.id_token, user };
        } else {
          const token = f.code ? await exchange(f.code).catch(() => null) : null;
          if (!token) return { status: 400, body: 'the code exchange failed' };
          kept = { provider: 'google', token, user: null };
        }
      }
      // Back to the page that asked: the one its nonce was issued to.
      const asked = kept ? nonces.get(String(part(kept.token.split('.')[1] ?? '')?.nonce ?? '')) : undefined;
      const callback = asked?.callback || allowedCallback(`${o.webOrigins[0] ?? ''}/.exact/auth/callback`) || lastCallback;
      if (!callback) return { status: 400, body: 'no page to return to' };
      const answer = (params: Record<string, string>) => `${callback}?${new URLSearchParams(params)}`;
      if (!kept) return { status: 303, location: answer({ state: f.state, error: f.error }) };
      const handle = random(16);
      handles.set(handle, { ...kept, expires: now() + TTL });
      return { status: 303, location: answer({ state: f.state, relay: handle }) };
    },

    /** A credential from `credentials.get`, checked against the nonce issued to this client, once. */
    async identity(body: { credential?: Credential; client?: unknown; nonce?: unknown }): Promise<Result> {
      sweep();
      const nonce = String(body.nonce ?? ''), issued = nonces.get(nonce);
      nonces.delete(nonce);
      if (!issued || issued.expires < now() || issued.client !== String(body.client ?? '')) return { ok: false, error: 'nonce' };
      const credential = body.credential;
      const provider = CONFIG[String(credential?.configURL)];
      if (!provider) return { ok: false, error: 'provider' };
      let token: unknown = credential?.token, user: AppleUser | null = null;
      if (token && typeof token === 'object' && 'relay' in token) {
        const relay = String((token as { relay: unknown }).relay), kept = handles.get(relay);
        handles.delete(relay);
        if (!kept || kept.expires < now() || kept.provider !== provider) return { ok: false, error: 'handle' };
        ({ token, user } = kept);
      } else if (provider === 'apple') {
        const t = token as { authorization?: { id_token?: string }; user?: AppleUser } | null;
        token = t?.authorization?.id_token;
        user = t?.user ?? null;
      }
      const checked = await verify(provider, String(token ?? ''), nonce);
      if ('error' in checked) return { ok: false, error: checked.error };
      const me = account(provider, checked.claims, user);
      return { ok: true, token: startSession(me), name: me.name, email: me.email };
    },

    /** Google's access token from the iPhone app: Google says which client it was issued to and to whom. */
    async google(req: Request): Promise<Result> {
      const accessToken = req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
      if (!accessToken) return { ok: false, error: 'no token' };
      const got = await googleAccess(accessToken);
      if (!got) return { ok: false, error: 'token' };
      if (!o.audiences.google.includes(got.aud)) return { ok: false, error: 'aud' };
      if (!got.sub) return { ok: false, error: 'sub' };
      const me = account('google', { sub: got.sub, email: got.email, name: got.name }, null);
      return { ok: true, token: startSession(me), name: me.name, email: me.email };
    },

    /** The account a request's bearer token belongs to. */
    user(req: Request): User | null {
      const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
      if (!token) return null;
      return db.query(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
        .get(sha256(token), now()) as User | null;
    },

    signOut(req: Request) {
      const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
      if (token) db.query('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    },
  };
}

type GoogleAccess = { aud: string; sub: string; email: string; name: string };
type AppleUser = { email?: string; name?: { firstName?: string; lastName?: string } };
type Credential = { configURL?: string; token?: unknown };
