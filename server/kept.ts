// Files a preview read, kept in memory for the import that follows it (POST /audiobooks?token=), so
// Generate needs no second upload or download. Each is its reader's alone, for KEPT_MS; the oldest
// go first past KEPT_PER_USER for one person or KEPT_BYTES for everyone. A restart forgets them all:
// the app then sends the file again.
import { randomBytes } from 'node:crypto';

export const KEPT_MS = Number(process.env.PREVIEW_KEEP_MS ?? 30 * 60 * 1000);
const KEPT_PER_USER = 3;
const KEPT_BYTES = Number(process.env.PREVIEW_KEEP_BYTES ?? 200 * 1024 * 1024);

export type Kept = { name: string; bytes: Uint8Array; link: string };
type Entry = Kept & { user: number; at: number };
const kept = new Map<string, Entry>();

function sweep(now = Date.now()) {
  for (const [token, e] of kept) if (now - e.at > KEPT_MS) kept.delete(token);
}

/** Keeps a file for this person; answers the token that takes it. */
export function keep(user: number, file: Kept): string {
  sweep();
  // Map order is insertion order, so the first of a person's (or of all) is the oldest.
  const mine = [...kept].filter(([, e]) => e.user === user);
  for (const [token] of mine.slice(0, Math.max(0, mine.length - KEPT_PER_USER + 1))) kept.delete(token);
  let total = file.bytes.length;
  for (const e of kept.values()) total += e.bytes.length;
  for (const [token, e] of kept) { if (total <= KEPT_BYTES) break; kept.delete(token); total -= e.bytes.length; }
  if (file.bytes.length > KEPT_BYTES) return '';
  const token = randomBytes(18).toString('base64url');
  kept.set(token, { ...file, user, at: Date.now() });
  return token;
}

/** The file a token keeps for this person, once: null when unknown, another's or expired. */
export function take(user: number, token: string): Kept | null {
  sweep();
  const e = kept.get(token);
  if (!e || e.user !== user) return null;
  kept.delete(token);
  return { name: e.name, bytes: e.bytes, link: e.link };
}
