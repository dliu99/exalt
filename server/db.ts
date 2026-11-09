// One record per book, keyed by its Open Library work id, so every audiobook made from any
// upload of that book hangs off the same row.
import { Database } from 'bun:sqlite';

export const db = new Database(process.env.DB ?? 'data.db');
db.run('PRAGMA journal_mode = WAL');
db.run(`CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  year INTEGER NOT NULL DEFAULT 0,
  cover TEXT NOT NULL DEFAULT ''
)`);
db.run(`CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  made_by TEXT NOT NULL,
  model TEXT NOT NULL,
  voice TEXT NOT NULL,
  source_name TEXT NOT NULL,
  status TEXT NOT NULL,            -- queued | working | ready | failed
  done INTEGER NOT NULL DEFAULT 0, -- chapters voiced
  total INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS tracks (
  generation_id INTEGER NOT NULL REFERENCES generations(id),
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  file TEXT NOT NULL,
  PRIMARY KEY (generation_id, idx)
)`);

export type BookRow = { id: string; title: string; author: string; year: number; cover: string };
export type GenerationRow = {
  id: number; book_id: string; made_by: string; model: string; voice: string; source_name: string;
  status: string; done: number; total: number; error: string; created_at: number;
};
export type TrackRow = { generation_id: number; idx: number; title: string; file: string };

export const upsertBook = (b: BookRow) =>
  db.query(`INSERT INTO books (id, title, author, year, cover) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, author = excluded.author, year = excluded.year, cover = excluded.cover`)
    .run(b.id, b.title, b.author, b.year, b.cover);

export const getBook = (id: string) => db.query('SELECT * FROM books WHERE id = ?').get(id) as BookRow | null;

export const generationsOf = (bookId: string) =>
  db.query('SELECT * FROM generations WHERE book_id = ? ORDER BY id DESC').all(bookId) as GenerationRow[];

export const getGeneration = (id: number) => db.query('SELECT * FROM generations WHERE id = ?').get(id) as GenerationRow | null;

export const tracksOf = (generationId: number) =>
  db.query('SELECT * FROM tracks WHERE generation_id = ? ORDER BY idx').all(generationId) as TrackRow[];

// Books someone has made an audiobook of, newest activity first.
export const booksWithAudio = () => db.query(`SELECT b.*, COUNT(g.id) AS versions, MAX(g.id) AS latest
  FROM books b JOIN generations g ON g.book_id = b.id AND g.status = 'ready'
  GROUP BY b.id ORDER BY latest DESC`).all() as (BookRow & { versions: number })[];

export const readyCounts = (ids: string[]) => {
  if (ids.length === 0) return new Map<string, number>();
  const rows = db.query(`SELECT book_id, COUNT(*) AS n FROM generations WHERE status = 'ready'
    AND book_id IN (${ids.map(() => '?').join(',')}) GROUP BY book_id`).all(...ids) as { book_id: string; n: number }[];
  return new Map(rows.map((r) => [r.book_id, r.n]));
};
