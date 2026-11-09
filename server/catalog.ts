// Book metadata from Open Library (title, author, year, cover). Goodreads has no public API;
// the app links to a Goodreads search for reviews instead.
import { type BookRow, getBook, upsertBook } from './db.ts';

const OL = 'https://openlibrary.org';
const cover = (id: unknown) => (typeof id === 'number' && id > 0 ? `https://covers.openlibrary.org/b/id/${id}-M.jpg` : '');

// `--offline` (what `bun exact.mjs test` runs) answers from these instead of the network.
export const FIXTURE: BookRow[] = [
  { id: 'OL1W', title: 'A Quiet Harbour', author: 'Test Author', year: 1901, cover: '' },
  { id: 'OL2W', title: 'Notes on Rivers', author: 'Another Author', year: 1899, cover: '' },
];

export async function search(q: string, offline: boolean): Promise<BookRow[]> {
  if (offline) return FIXTURE.filter((b) => b.title.toLowerCase().includes(q.toLowerCase()));
  const url = `${OL}/search.json?q=${encodeURIComponent(q)}&fields=key,title,author_name,first_publish_year,cover_i&limit=20`;
  const res = await fetch(url, { headers: { 'user-agent': 'Exalt/0.1 (open audiobook app)' } });
  if (!res.ok) throw new Error(`Open Library answered ${res.status}`);
  const body = (await res.json()) as { docs?: Record<string, unknown>[] };
  return (body.docs ?? []).flatMap((d) => {
    const key = typeof d.key === 'string' ? d.key.replace('/works/', '') : '';
    if (!key || typeof d.title !== 'string') return [];
    const authors = Array.isArray(d.author_name) ? (d.author_name as string[]) : [];
    return [{ id: key, title: d.title, author: authors.slice(0, 2).join(', '), year: Number(d.first_publish_year) || 0, cover: cover(d.cover_i) }];
  });
}

// The book's one record: from the database, else fetched once and kept.
export async function ensureBook(id: string, offline: boolean): Promise<BookRow | null> {
  const known = getBook(id);
  if (known) return known;
  if (!/^OL\d+W$/.test(id)) return null;
  let book: BookRow | undefined;
  if (offline) book = FIXTURE.find((b) => b.id === id);
  else {
    const res = await fetch(`${OL}/works/${id}.json`);
    if (!res.ok) return null;
    const w = (await res.json()) as { title?: string; covers?: number[]; authors?: { author?: { key?: string } }[]; first_publish_date?: string };
    let author = '';
    const authorKey = w.authors?.[0]?.author?.key;
    if (authorKey) {
      const a = await fetch(`${OL}${authorKey}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as { name?: string };
      author = a.name ?? '';
    }
    book = { id, title: w.title ?? 'Untitled', author, year: Number(w.first_publish_date?.match(/\d{4}/)?.[0]) || 0, cover: cover(w.covers?.[0]) };
  }
  if (!book) return null;
  upsertBook(book);
  return book;
}
