// One record per book (the work, not an edition), so every audiobook made from any upload of
// any edition of it hangs off the same row. A book's id is the provider id it was first saved
// under; `links` maps everything else that names the same book to it (see catalog.ts).
import { Database } from 'bun:sqlite';

export const db = new Database(process.env.DB ?? 'data.db');
// Litestream (deploy/start.sh) briefly locks the database to checkpoint it; wait rather than fail.
db.run('PRAGMA busy_timeout = 5000');
db.run('PRAGMA journal_mode = WAL');
db.run(`CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  year INTEGER NOT NULL DEFAULT 0,
  cover TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT ''
)`);
// Databases made before descriptions were kept gain the column.
if (!(db.query('PRAGMA table_info(books)').all() as { name: string }[]).some((c) => c.name === 'description'))
  db.run("ALTER TABLE books ADD COLUMN description TEXT NOT NULL DEFAULT ''");
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
// The voice's name as the reader chose it (a Fish Audio voice is stored by its id).
if (!(db.query('PRAGMA table_info(generations)').all() as { name: string }[]).some((c) => c.name === 'voice_name'))
  db.run("ALTER TABLE generations ADD COLUMN voice_name TEXT NOT NULL DEFAULT ''");
db.run(`CREATE TABLE IF NOT EXISTS tracks (
  generation_id INTEGER NOT NULL REFERENCES generations(id),
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  file TEXT NOT NULL,
  PRIMARY KEY (generation_id, idx)
)`);

// Durable queue payloads exist only while work is queued/running. Source PDFs/EPUBs are not retained.
db.run(`CREATE TABLE IF NOT EXISTS generation_jobs (
  generation_id INTEGER PRIMARY KEY REFERENCES generations(id),
  payload TEXT NOT NULL
)`);
for (const [name, type] of [['source_ref', "TEXT NOT NULL DEFAULT ''"], ['source_hash', "TEXT NOT NULL DEFAULT ''"]]) {
  if (!(db.query('PRAGMA table_info(generations)').all() as { name: string }[]).some((c) => c.name === name))
    db.run(`ALTER TABLE generations ADD COLUMN ${name} ${type}`);
}
for (const [name, type] of [['bytes', 'INTEGER NOT NULL DEFAULT 0'], ['storage', "TEXT NOT NULL DEFAULT 'local'"]]) {
  if (!(db.query('PRAGMA table_info(tracks)').all() as { name: string }[]).some((c) => c.name === name))
    db.run(`ALTER TABLE tracks ADD COLUMN ${name} ${type}`);
}
db.run('CREATE INDEX IF NOT EXISTS generations_status ON generations(status)');
// A version's chapters, narrated one at a time when someone asks (jobs.ts). Each keeps its text
// until it is narrated; then only its audio (`tracks`) is kept. Versions made before this kept no
// text once done, so a chapter of theirs that never got audio is `unavailable`.
db.run(`CREATE TABLE IF NOT EXISTS chapters (
  generation_id INTEGER NOT NULL REFERENCES generations(id),
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  text TEXT,                              -- NULL once narrated (or never kept)
  status TEXT NOT NULL,                   -- idle | queued | working | ready | failed | unavailable
  requested_by INTEGER,                   -- the account whose Generate it was, for its limit
  requested_at INTEGER NOT NULL DEFAULT 0,
  parts_done INTEGER NOT NULL DEFAULT 0,  -- speech requests answered, while narrating
  parts_total INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (generation_id, idx)
)`);
db.run('CREATE INDEX IF NOT EXISTS chapters_status ON chapters(status, requested_at)');
db.run('CREATE INDEX IF NOT EXISTS tracks_file ON tracks(file)');

// Every name a book goes by: provider ids (`gb-…`, `hc-…`, `OL…W`), its editions' ISBNs
// (`isbn:…`) and its normalized title and author (`key:…`). One name, one book.
db.run(`CREATE TABLE IF NOT EXISTS links (
  ref TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id)
)`);
db.run('CREATE INDEX IF NOT EXISTS links_book ON links(book_id)');

export type BookRow = { id: string; title: string; author: string; year: number; cover: string; description: string };
export type GenerationRow = {
  id: number; book_id: string; made_by: string; model: string; voice: string; voice_name?: string; source_name: string;
  source_ref?: string; source_hash?: string; status: string; done: number; total: number; error: string; created_at: number;
};
export type TrackRow = { generation_id: number; idx: number; title: string; file: string; bytes: number; storage: string };
export type ChapterRow = {
  generation_id: number; idx: number; title: string; text: string | null; status: string; requested_by: number | null;
  requested_at: number; parts_done: number; parts_total: number; error: string;
};

export const upsertBook = (b: BookRow) =>
  db.query(`INSERT INTO books (id, title, author, year, cover, description) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, author = excluded.author, year = excluded.year, cover = excluded.cover, description = excluded.description`)
    .run(b.id, b.title, b.author, b.year, b.cover, b.description);

export const getBook = (id: string) => db.query('SELECT * FROM books WHERE id = ?').get(id) as BookRow | null;

export const generationsOf = (bookId: string) =>
  db.query('SELECT * FROM generations WHERE book_id = ? ORDER BY id DESC').all(bookId) as GenerationRow[];

export const getGeneration = (id: number) => db.query('SELECT * FROM generations WHERE id = ?').get(id) as GenerationRow | null;

export const tracksOf = (generationId: number) =>
  db.query('SELECT * FROM tracks WHERE generation_id = ? ORDER BY idx').all(generationId) as TrackRow[];

// A version's chapters, without their text.
export const chaptersOf = (generationId: number) => db.query(`SELECT generation_id, idx, title, NULL AS text, status, requested_by,
  requested_at, parts_done, parts_total, error FROM chapters WHERE generation_id = ? ORDER BY idx`).all(generationId) as ChapterRow[];

// A version with something to play: prepared, and at least one chapter narrated.
const PLAYABLE = "g.status = 'ready' AND g.done > 0";

// Books someone has made an audiobook of, newest activity first.
export const booksWithAudio = () => db.query(`SELECT b.*, COUNT(g.id) AS versions, MAX(g.id) AS latest
  FROM books b JOIN generations g ON g.book_id = b.id AND ${PLAYABLE}
  GROUP BY b.id ORDER BY latest DESC`).all() as (BookRow & { versions: number })[];

export const readyCounts = (ids: string[]) => {
  if (ids.length === 0) return new Map<string, number>();
  const rows = db.query(`SELECT g.book_id, COUNT(*) AS n FROM generations g WHERE ${PLAYABLE}
    AND g.book_id IN (${ids.map(() => '?').join(',')}) GROUP BY g.book_id`).all(...ids) as { book_id: string; n: number }[];
  return new Map(rows.map((r) => [r.book_id, r.n]));
};

// The book any of these names already belongs to, trying them in order.
export function linkedBook(refs: string[]): string | null {
  const q = db.query('SELECT book_id FROM links WHERE ref = ?');
  for (const ref of refs) {
    const row = q.get(ref) as { book_id: string } | null;
    if (row) return row.book_id;
  }
  return null;
}

// Names this book; a name another book already has stays that book's.
export function link(bookId: string, refs: string[]) {
  const q = db.query('INSERT OR IGNORE INTO links (ref, book_id) VALUES (?, ?)');
  db.transaction(() => { for (const ref of refs) if (ref) q.run(ref, bookId); })();
}

// Two rows that turned out to be one book: everything of `drop` moves to `keep`.
export const mergeBooks = db.transaction((keep: string, drop: string) => {
  if (keep === drop) return;
  db.query('UPDATE generations SET book_id = ? WHERE book_id = ?').run(keep, drop);
  db.query('UPDATE links SET book_id = ? WHERE book_id = ?').run(keep, drop);
  db.query('INSERT OR IGNORE INTO links (ref, book_id) VALUES (?, ?)').run(drop, keep);
  db.query('DELETE FROM books WHERE id = ?').run(drop);
});

export const allBooksByAudio = () => db.query(`SELECT b.*, (SELECT COUNT(*) FROM generations g WHERE g.book_id = b.id) AS made
  FROM books b ORDER BY made DESC, b.rowid`).all() as (BookRow & { made: number })[];

// Every saved book with how many audiobooks of it can be played (search matches words in JS, where
// "anti-oedipus" and "Anti–Oedipus" normalize alike).
export const savedBooks = () => db.query(`SELECT b.*, (SELECT COUNT(*) FROM generations g WHERE g.book_id = b.id AND ${PLAYABLE}) AS versions
  FROM books b`).all() as (BookRow & { versions: number })[];

// What one person has made, newest first, each with its book.
export const generationsBy = (userId: number) => db.query(`SELECT g.*, b.title, b.author, b.cover
  FROM generations g JOIN books b ON b.id = g.book_id WHERE g.user_id = ? ORDER BY g.id DESC`).all(userId) as (GenerationRow & { title: string; author: string; cover: string })[];

// A cover read from an imported file (an EPUB's cover image), served at /covers/<book id>.
db.run(`CREATE TABLE IF NOT EXISTS covers (
  book_id TEXT PRIMARY KEY REFERENCES books(id),
  type TEXT NOT NULL,
  bytes BLOB NOT NULL
)`);
export const keepCover = (bookId: string, type: string, bytes: Uint8Array) =>
  db.query('INSERT OR REPLACE INTO covers (book_id, type, bytes) VALUES (?, ?, ?)').run(bookId, type, bytes);
export const coverOf = (bookId: string) => db.query('SELECT type, bytes FROM covers WHERE book_id = ?').get(bookId) as { type: string; bytes: Uint8Array } | null;
