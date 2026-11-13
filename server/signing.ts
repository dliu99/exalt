// Private audiobooks' audio and covers are served only on signed URLs: `<path>?exp=<unix
// seconds>&sig=<hex HMAC-SHA256 of "<path>|<exp>">`, handed to the owner by the routes that list
// them and good for six hours. The key is AUDIO_SIGNING_KEY, or one made once and kept in SQLite.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from './db.ts';

const KEY = process.env.AUDIO_SIGNING_KEY || (() => {
  db.query('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('audio_signing_key', randomBytes(32).toString('hex'));
  return (db.query('SELECT value FROM settings WHERE key = ?').get('audio_signing_key') as { value: string }).value;
})();
const TTL = 6 * 3600;
const mac = (path: string, exp: number) => createHmac('sha256', KEY).update(`${path}|${exp}`).digest('hex');

// A server-relative path with its signature; anything else (empty, an older row's absolute URL) as it is.
export function sign(path: string, now = Date.now()) {
  if (!path.startsWith('/')) return path;
  // Rounded up to the hour, so a URL stays the same between polls and the image stays cached:
  // good for six to seven hours.
  const exp = (Math.floor(now / 1000 / 3600) + 1) * 3600 + TTL;
  return `${path}?exp=${exp}&sig=${mac(path, exp)}`;
}

// Whether the query signs this path and hasn't expired.
export function signed(path: string, query: URLSearchParams, now = Date.now()) {
  const exp = Number(query.get('exp')), sig = query.get('sig') ?? '';
  if (!Number.isSafeInteger(exp) || exp * 1000 < now || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(mac(path, exp), 'hex'));
}
