// A book is what someone imported: its title, author and cover. Each import makes its own book
// row (`up-<hex>`) and one audiobook of it (a generation), which its maker can share or keep
// private. Older databases also hold books from the retired catalog; they keep playing.
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
  cover TEXT NOT NULL DEFAULT '',  -- '/covers/<id>.<ext>', or an older row's absolute URL
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
const generationColumns = () => (db.query('PRAGMA table_info(generations)').all() as { name: string }[]).map((c) => c.name);
// The voice's name as the reader chose it (a Fish Audio voice is stored by its id); where the
// text came from; whether it is shared in Browse (existing audiobooks stay shared).
for (const [name, type] of [['voice_name', "TEXT NOT NULL DEFAULT ''"], ['source_ref', "TEXT NOT NULL DEFAULT ''"],
  ['source_hash', "TEXT NOT NULL DEFAULT ''"], ['public', 'INTEGER NOT NULL DEFAULT 1']]) {
  if (!generationColumns().includes(name)) db.run(`ALTER TABLE generations ADD COLUMN ${name} ${type}`);
}
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
for (const [name, type] of [['bytes', 'INTEGER NOT NULL DEFAULT 0'], ['storage', "TEXT NOT NULL DEFAULT 'local'"]]) {
  if (!(db.query('PRAGMA table_info(tracks)').all() as { name: string }[]).some((c) => c.name === name))
    db.run(`ALTER TABLE tracks ADD COLUMN ${name} ${type}`);
}
db.run('CREATE INDEX IF NOT EXISTS generations_status ON generations(status)');
db.run('CREATE INDEX IF NOT EXISTS generations_book ON generations(book_id)');
db.run('CREATE INDEX IF NOT EXISTS tracks_file ON tracks(file)');
// The server's own small values, such as the key that signs private audio URLs (signing.ts).
db.run('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

export type BookRow = { id: string; title: string; author: string; year: number; cover: string; description: string };
export type GenerationRow = {
  id: number; book_id: string; user_id: number | null; made_by: string; model: string; voice: string; voice_name?: string; source_name: string;
  source_ref?: string; source_hash?: string; status: string; done: number; total: number; error: string; created_at: number; public: number;
};
export type TrackRow = { generation_id: number; idx: number; title: string; file: string; bytes: number; storage: string };
// An audiobook with its book's title, author and cover.
export type AudiobookRow = GenerationRow & { title: string; author: string; cover: string };

export const getBook = (id: string) => db.query('SELECT * FROM books WHERE id = ?').get(id) as BookRow | null;

export const getGeneration = (id: number) => db.query('SELECT * FROM generations WHERE id = ?').get(id) as GenerationRow | null;

export const getAudiobook = (id: number) => db.query(`SELECT g.*, b.title, b.author, b.cover
  FROM generations g JOIN books b ON b.id = g.book_id WHERE g.id = ?`).get(id) as AudiobookRow | null;

export const tracksOf = (generationId: number) =>
  db.query('SELECT * FROM tracks WHERE generation_id = ? ORDER BY idx').all(generationId) as TrackRow[];

// What one person has made, newest first, each with its book.
export const generationsBy = (userId: number) => db.query(`SELECT g.*, b.title, b.author, b.cover
  FROM generations g JOIN books b ON b.id = g.book_id WHERE g.user_id = ? ORDER BY g.created_at DESC, g.id DESC`).all(userId) as AudiobookRow[];

// The public, finished audiobooks, newest first, those whose title or author has `q` in it.
export function browse(q = '', limit = 100) {
  const like = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db.query(`SELECT g.*, b.title, b.author, b.cover FROM generations g JOIN books b ON b.id = g.book_id
    WHERE g.public = 1 AND g.status = 'ready' AND (?1 = '' OR lower(b.title) LIKE ?2 ESCAPE '\\' OR lower(b.author) LIKE ?2 ESCAPE '\\')
    ORDER BY g.created_at DESC, g.id DESC LIMIT ?3`).all(q, like, limit) as AudiobookRow[];
}
