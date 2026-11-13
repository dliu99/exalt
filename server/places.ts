// Where each signed-in listener is in each audiobook, so the web and the phone carry over
// (GET and PUT /me/places in index.ts). The app keeps the same place on the device; the newest
// `at` wins on both sides. A finished book keeps its row, marked finished, so an older place on
// another device can't bring it back to the shelf.
import { db } from './db.ts';

db.run(`CREATE TABLE IF NOT EXISTS places (
  user_id INTEGER NOT NULL,        -- users(id)
  generation_id INTEGER NOT NULL,  -- generations(id); a deleted one's row is left out by placesOf
  track INTEGER NOT NULL,          -- the chapter, from 0
  tracks INTEGER NOT NULL,
  time REAL NOT NULL,              -- seconds into the chapter
  duration REAL NOT NULL,          -- the chapter's length in seconds, 0 when not yet known
  at INTEGER NOT NULL,             -- when it was heard (ms since the epoch), never later than the server's clock
  finished INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, generation_id)
)`);

export type Place = { track: number; tracks: number; time: number; duration: number; at: number; finished: boolean };
export type PlaceRow = Omit<Place, 'finished'> & {
  generation_id: number; finished: number; book_id: string; title: string; author: string; cover: string; public: number;
};

const withBook = `SELECT p.*, g.book_id, g.public, b.title, b.author, b.cover FROM places p
  JOIN generations g ON g.id = p.generation_id JOIN books b ON b.id = g.book_id`;

// One listener's places, newest first, the finished ones included (they tell a device to drop its
// own); an audiobook its maker has since made private is left out, unless the listener is its maker.
export const placesOf = (userId: number) =>
  db.query(`${withBook} WHERE p.user_id = ?1 AND (g.public = 1 OR g.user_id = ?1) ORDER BY p.at DESC LIMIT 50`).all(userId) as PlaceRow[];

// Keeps a place unless the one already kept is newer, and answers whichever is kept.
export function keepPlace(userId: number, generationId: number, p: Place) {
  db.query(`INSERT INTO places (user_id, generation_id, track, tracks, time, duration, at, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, generation_id) DO UPDATE SET track = excluded.track, tracks = excluded.tracks, time = excluded.time,
      duration = excluded.duration, at = excluded.at, finished = excluded.finished
    WHERE excluded.at >= places.at`)
    .run(userId, generationId, p.track, p.tracks, p.time, p.duration, p.at, p.finished ? 1 : 0);
  return db.query(`${withBook} WHERE p.user_id = ? AND p.generation_id = ?`).get(userId, generationId) as PlaceRow;
}

// A place as a request body gives it, or null when it isn't one. A device whose clock runs ahead
// of the server's counts as now, so it can't win over every later place for good.
export function placeFrom(body: Record<string, unknown>, now = Date.now()): Place | null {
  const n = (k: string) => (typeof body[k] === 'number' && Number.isFinite(body[k]) ? (body[k] as number) : NaN);
  const [track, tracks, time, duration, at] = ['track', 'tracks', 'time', 'duration', 'at'].map(n);
  if (!Number.isInteger(track) || !Number.isInteger(tracks) || track < 0 || tracks < 1 || track >= tracks) return null;
  if (!(time >= 0) || !(duration >= 0) || !(at > 0)) return null;
  return { track, tracks, time, duration, at: Math.min(Math.round(at), now), finished: body.finished === true };
}

// `cover` is the route's to sign (a private audiobook's) before it is answered.
export const placeJson = (r: PlaceRow, cover = r.cover) => ({
  gen: String(r.generation_id), book: r.book_id, title: r.title, author: r.author, cover,
  track: r.track, tracks: r.tracks, time: r.time, duration: r.duration, at: r.at, finished: r.finished === 1,
});
