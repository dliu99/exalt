// Book metadata (title, author, year, cover, description) from a choice of providers, picked
// by BOOK_PROVIDER: `google` (the default), `hardcover` or `openlibrary`. Goodreads has no public
// API; the app links to a Goodreads search for reviews instead.
//
// A book is the work, not an edition: Hardcover groups every edition, translation and reprint of
// a book under one record (Beyond Good and Evil's 183 ISBNs are one book), which is what
// audiobooks hang off. Its id says which provider it came from, so books saved under any of
// them keep resolving whatever BOOK_PROVIDER is now: Hardcover ids prefixed (`hc-482336`),
// Google Books volume ids prefixed (`gb-zyTCAlFPjgYC`), Open Library work ids as they are
// (`OL123W`).
import { allBooksByAudio, type BookRow, getBook, link, linkedBook, mergeBooks, savedBooks, upsertBook } from './db.ts';

// What a provider answers: a book, and the other names it goes by (its editions' ISBNs).
export type Found = BookRow & { refs: string[] };
type Provider = {
  search(q: string): Promise<Found[]>;
  fetch(id: string): Promise<Found | null>;
  owns(id: string): boolean;
};

const UA = { 'user-agent': 'Exalt/0.1 (open audiobook app)' };

// Descriptions come as HTML (Google) or Markdown-ish text (Open Library); the app shows plain text.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
const plain = (s: unknown) => (typeof s === 'string' ? s : '')
  .replace(/<br\s*\/?>|<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
  .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e])
  .replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ── Open Library ────────────────────────────────────────────────────────────────────────────
const OL = 'https://openlibrary.org';
const olCover = (id: unknown) => (typeof id === 'number' && id > 0 ? `https://covers.openlibrary.org/b/id/${id}-M.jpg` : '');

const openLibrary: Provider = {
  owns: (id) => /^OL\d+W$/.test(id),
  async search(q) {
    const url = `${OL}/search.json?q=${encodeURIComponent(q)}&fields=key,title,author_name,first_publish_year,cover_i&limit=20`;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`Open Library answered ${res.status}`);
    const body = (await res.json()) as { docs?: Record<string, unknown>[] };
    return (body.docs ?? []).flatMap((d) => {
      const key = typeof d.key === 'string' ? d.key.replace('/works/', '') : '';
      if (!key || typeof d.title !== 'string') return [];
      const authors = Array.isArray(d.author_name) ? (d.author_name as string[]) : [];
      return [{ id: key, title: d.title, author: authors.slice(0, 2).join(', '), year: Number(d.first_publish_year) || 0, cover: olCover(d.cover_i), description: '', refs: [] }];
    });
  },
  async fetch(id) {
    const res = await fetch(`${OL}/works/${id}.json`, { headers: UA });
    if (!res.ok) return null;
    const w = (await res.json()) as { title?: string; covers?: number[]; authors?: { author?: { key?: string } }[]; first_publish_date?: string; description?: string | { value?: string }; type?: { key?: string }; location?: string };
    // A merged work answers with a redirect record; it is the same book under the new id's data.
    if (w.type?.key === '/type/redirect') {
      const to = w.location?.replace('/works/', '');
      return to && to !== id && openLibrary.owns(to) ? openLibrary.fetch(to).then((b) => b && { ...b, id, refs: [...b.refs, to] }) : null;
    }
    if (!w.title) return null;
    let author = '';
    const authorKey = w.authors?.[0]?.author?.key;
    if (authorKey) {
      const a = (await fetch(`${OL}${authorKey}.json`, { headers: UA }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))) as { name?: string };
      author = a.name ?? '';
    }
    const description = plain(typeof w.description === 'object' ? w.description?.value : w.description);
    return { id, title: w.title, author, year: Number(w.first_publish_date?.match(/\d{4}/)?.[0]) || 0, cover: olCover(w.covers?.[0]), description, refs: [] };
  },
};

// ── Ranking ─────────────────────────────────────────────────────────────────────────────────
// Every provider answers loosely: "harassment architecture" brings back architecture journals,
// "mike ma" anyone named Mike in an anthology of fifty. A result is shown only if every word
// searched is in its title or in one author's name; then the title itself ranks first, and among
// the rest, books people actually read rise and one-reader reprints sink, the way Goodreads
// orders them. Study aids and bundles are dropped unless the search asks for one.
export type Candidate<T> = {
  item: T; title: string; subtitle?: string; authors: string[];
  readers: number; cover: boolean; description: boolean; language?: string;
};

const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'by', 'in', 'on', 'to', 'for', 'de', 'la', 'le']);
const JUNK = /\b(summary|summaries|analysis|study guide|sparknotes|cliffsnotes|book club|workbook|review|reader'?s guide|conversation starters|collection set|box set|boxed set|books? \d+\s*-\s*\d+)\b/i;
const words = (s: string) => s.replace(/&/g, ' and ').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
// "Dune (Movie Tie-In)" and "Project Hail Mary (Deluxe Edition)" are the book itself.
const baseTitle = (t: string) => words(t.replace(/\([^)]*\)|\[[^\]]*\]/g, '')).join(' ');
const LANG = (process.env.BOOK_LANG ?? 'en').toLowerCase();

// The same book across editions and providers, by name: its title without what an edition
// adds ("(Movie Tie-In)", "Illustrated", "Annotated", "by Friedrich Nietzsche") and its first
// author's first and last names ("Friedrich Wilhelm Nietzsche" is "friedrich nietzsche"). Two
// different books by one author never share a title, so this is safe to merge on.
const EDITION_WORDS = new Set(['illustrated', 'annotated', 'unabridged', 'abridged', 'edition', 'classics', 'classic',
  'deluxe', 'premium', 'hardback', 'hardcover', 'paperback', 'version', 'english', 'translation', 'translated']);
export function workKey(title: string, author: string): string {
  const name = words(author.split(/\s*,\s*/)[0] ?? '');
  if (!name.length) return '';
  const surname = name[name.length - 1];
  let t = words(title.replace(/\([^)]*\)|\[[^\]]*\]/g, ''));
  // "… by Friedrich Wilhelm Nietzsche Annotated and Illustrated Edition"
  const by = t.indexOf('by');
  if (by > 0 && t.slice(by + 1, by + 5).includes(surname)) t = t.slice(0, by);
  // "Friedrich Nietzsche - Beyond Good and Evil"
  const lead = t.findIndex((w) => !name.includes(w));
  if (lead > 0 && t.slice(0, lead).includes(surname)) t = t.slice(lead);
  t = t.filter((w) => !EDITION_WORDS.has(w));
  return t.length ? `key:${t.join(' ')}|${name.length > 1 ? `${name[0]} ${name[name.length - 1]}` : name[0]}` : '';
}
const isbnRefs = (isbns: (string | undefined)[]) => [...new Set(isbns.flatMap((i) => (i ? [`isbn:${i.replace(/[^0-9X]/gi, '')}`] : [])))];
// A word matches a whole word, or the start of one once it is three letters long ("harass").
const matches = (ws: string[], t: string) => ws.some((w) => w === t || (t.length >= 3 && w.startsWith(t)));

export function rank<T>(q: string, candidates: Candidate<T>[]): T[] {
  const terms = words(q).filter((w) => !STOP.has(w));
  if (!terms.length) return [];
  const query = words(q).join(' ');
  const junkAsked = JUNK.test(q);
  const scored = candidates.flatMap((c) => {
    // "Gilles Deleuze, Félix Guattari" as one name is two people ("Herbert, Frank" is one).
    const authors = c.authors
      .flatMap((a) => { const parts = a.split(/\s*,\s*|\s+&\s+/); return parts.every((p) => p.trim().includes(' ')) ? parts : [a]; })
      .filter((a) => !/^(unknown|anonymous|various)$/i.test(a.trim()));
    if (!c.title || !authors.length) return []; // no author: journals, film listings
    const full = `${c.title} ${c.subtitle ?? ''}`;
    if (!junkAsked && JUNK.test(`${full} ${authors.join(' ')}`)) return [];
    const titleWords = words(full);
    // The words not in the title must all be in the same author's name.
    const rest = terms.filter((t) => !matches(titleWords, t));
    if (rest.length && !authors.some((a) => rest.every((t) => matches(words(a), t)))) return [];
    // A book by whom was searched counts as fully matched ("nietzsche": his books, not only
    // books called Nietzsche).
    const byAuthor = authors.some((a) => terms.every((t) => matches(words(a), t)));
    const title = baseTitle(c.title);
    // What it is matters some; how many people read it matters most.
    let score = 0;
    if (title === query) score += 20;
    else if (title.startsWith(query)) score += 10;
    score += byAuthor ? 18 : 10 * (terms.length - rest.length) / terms.length;
    if (c.cover) score += 4;
    if (c.description) score += 4;
    score += 12 * Math.log10(1 + Math.max(0, c.readers));
    return [{ c, score, key: workKey(c.title, authors[0]) || `${title}|${words(authors[0]).join(' ')}` }];
  });
  // Other languages' editions only when nothing in BOOK_LANG cleared the bar.
  const local = scored.filter((s) => !s.c.language || s.c.language.toLowerCase() === LANG);
  const pool = local.length ? local : scored;
  pool.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return pool.filter((s) => !seen.has(s.key) && seen.add(s.key)).map((s) => s.c.item);
}

// ── Google Books ────────────────────────────────────────────────────────────────────────────
// One record per edition, and no notion of the book they are editions of; used on its own
// (BOOK_PROVIDER=google), for books Hardcover lacks, and for descriptions Hardcover lacks.
// Works without a key at a low shared quota; GOOGLE_BOOKS_API_KEY raises it.
const GB = 'https://www.googleapis.com/books/v1/volumes';
const GB_PREFIX = 'gb-';
const gbKey = () => (process.env.GOOGLE_BOOKS_API_KEY ? `key=${encodeURIComponent(process.env.GOOGLE_BOOKS_API_KEY)}` : '');
export type Volume = { id?: string; volumeInfo?: {
  title?: string; subtitle?: string; authors?: string[]; publishedDate?: string; description?: string; language?: string;
  pageCount?: number; ratingsCount?: number; imageLinks?: Record<string, string>;
  industryIdentifiers?: { type?: string; identifier?: string }[];
} };

const gbBook = (v: Volume): Found | null => {
  const info = v.volumeInfo;
  if (!v.id || !info?.title) return null;
  const img = info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail ?? '';
  return {
    id: GB_PREFIX + v.id,
    title: info.title,
    author: (info.authors ?? []).slice(0, 2).join(', '),
    year: Number(info.publishedDate?.match(/\d{4}/)?.[0]) || 0,
    cover: img.replace(/^http:/, 'https:').replace('&edge=curl', ''),
    description: plain(info.description),
    refs: isbnRefs((info.industryIdentifiers ?? []).filter((i) => /^ISBN_1[03]$/.test(i.type ?? '')).map((i) => i.identifier)),
  };
};

// Google's placeholder records (no pages, no cover, no description: film listings, stubs) never show.
export const rankVolumes = (q: string, items: Volume[]) => rank(q, items.flatMap((v): Candidate<Volume>[] => {
  const i = v.volumeInfo;
  if (!v.id || !i?.title || (!i.pageCount && !i.imageLinks && !i.description)) return [];
  return [{ item: v, title: i.title, subtitle: i.subtitle, authors: i.authors ?? [], readers: i.ratingsCount ?? 0,
    cover: !!i.imageLinks, description: !!i.description, language: i.language }];
}));

async function askGoogle(query: string, max = 40): Promise<Volume[]> {
  const params = [`q=${encodeURIComponent(query)}`, 'printType=books', `maxResults=${max}`, gbKey()].filter(Boolean).join('&');
  const res = await fetch(`${GB}?${params}`, { headers: UA });
  if (!res.ok) throw new Error(`Google Books answered ${res.status}`);
  return ((await res.json()) as { items?: Volume[] }).items ?? [];
}

const googleBooks: Provider = {
  owns: (id) => id.startsWith(GB_PREFIX) && /^[\w-]+$/.test(id.slice(GB_PREFIX.length)),
  async search(q) {
    const items = await askGoogle(q);
    let ranked = rankVolumes(q, items);
    // An author's name alone is lost in Google's loose matching ("mike ma"); when few books
    // cleared the bar, ask again for books by that name.
    if (ranked.length < 5 && !/[:"]/.test(q)) ranked = rankVolumes(q, [...items, ...(await askGoogle(`inauthor:"${q}"`))]);
    return ranked.slice(0, 20).flatMap((v) => gbBook(v) ?? []);
  },
  async fetch(id) {
    const key = gbKey();
    const res = await fetch(`${GB}/${encodeURIComponent(id.slice(GB_PREFIX.length))}${key ? `?${key}` : ''}`, { headers: UA });
    if (!res.ok) return null;
    return gbBook((await res.json()) as Volume);
  },
};

// A description for an edition, by ISBN, when the book's own record has none.
async function googleDescription(isbns: string[]): Promise<string> {
  for (const isbn of isbns.slice(0, 3)) {
    const v = (await askGoogle(`isbn:${isbn}`, 1).catch(() => []))[0];
    const d = plain(v?.volumeInfo?.description);
    if (d) return d;
  }
  return '';
}

// ── Hardcover ───────────────────────────────────────────────────────────────────────────────
// A community catalog in Goodreads' mould: one record per book with every edition under it, a
// cover from its most-read edition (Beyond Good and Evil shows the Penguin Classics one), and
// how many readers each book has, which is what ranks a search. HARDCOVER_API_KEY is the token
// from hardcover.app/account/api, kept on the server.
const HC = 'https://api.hardcover.app/v1/graphql';
const HC_PREFIX = 'hc-';

async function hardcover<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = (process.env.HARDCOVER_API_KEY ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new Error('Book search needs HARDCOVER_API_KEY (or BOOK_PROVIDER=google).');
  const res = await fetch(HC, { method: 'POST', headers: { ...UA, 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }) });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message?: string }[] };
  if (!res.ok || body.errors?.length || !body.data) throw new Error(`Hardcover answered ${res.status}${body.errors?.[0]?.message ? `: ${body.errors[0].message}` : ''}`);
  return body.data;
}

export type HardcoverHit = { document?: {
  id?: string | number; title?: string; subtitle?: string; author_names?: string[]; release_year?: number;
  users_count?: number; image?: { url?: string }; description?: string; isbns?: string[];
} };

const hcBook = (d: NonNullable<HardcoverHit['document']>): Found => ({
  id: HC_PREFIX + d.id, title: d.title ?? '', author: (d.author_names ?? []).slice(0, 2).join(', '),
  year: Number(d.release_year) || 0, cover: d.image?.url ?? '', description: plain(d.description),
  refs: isbnRefs((d.isbns ?? []).slice(0, 20)),
});

export const rankHits = (q: string, hits: HardcoverHit[]) => rank(q, hits.flatMap((h): Candidate<NonNullable<HardcoverHit['document']>>[] => {
  const d = h.document;
  if (!d?.id || !d.title) return [];
  return [{ item: d, title: d.title, subtitle: d.subtitle, authors: d.author_names ?? [], readers: d.users_count ?? 0,
    cover: !!d.image?.url, description: !!d.description }];
}));

const hardcoverBooks: Provider = {
  owns: (id) => /^hc-\d+$/.test(id),
  async search(q) {
    // Hardcover's own order is by text match alone, so a search also asks for the most-read
    // books that match: "nietzsche" then brings his books, not only books named after him.
    type Results = { results: { hits?: HardcoverHit[] } | null };
    const data = await hardcover<{ relevant: Results; popular: Results }>(`query Search($q: String!) {
      relevant: search(query: $q, query_type: "Book", per_page: 25, page: 1) { results }
      popular: search(query: $q, query_type: "Book", per_page: 25, page: 1, sort: "users_count:desc") { results }
    }`, { q });
    const hits = [...(data.relevant.results?.hits ?? []), ...(data.popular.results?.hits ?? [])];
    const unique = [...new Map(hits.map((h) => [String(h.document?.id), h])).values()];
    const books = rankHits(q, unique).slice(0, 20).map(hcBook);
    // A book Hardcover doesn't know yet may be in Google; those follow, never ahead.
    if (books.length >= 3 || !process.env.GOOGLE_BOOKS_API_KEY) return books;
    const seen = new Set(books.map((b) => `${baseTitle(b.title)}|${words(b.author.split(',')[0]).sort().join(' ')}`));
    const extra = (await googleBooks.search(q).catch(() => [])).filter((b) => !seen.has(`${baseTitle(b.title)}|${words(b.author.split(',')[0]).sort().join(' ')}`));
    return [...books, ...extra].slice(0, 20);
  },
  async fetch(id) {
    type Book = {
      id: number; title?: string; release_year?: number; description?: string; cached_image?: { url?: string };
      cached_contributors?: { author?: { name?: string }; contribution?: string | null }[];
      default_cover_edition?: { isbn_13?: string; isbn_10?: string };
      editions?: { isbn_13?: string }[];
    };
    const data = await hardcover<{ books_by_pk: Book | null }>(`query Book($id: Int!) { books_by_pk(id: $id) {
      id title release_year description cached_image cached_contributors
      default_cover_edition { isbn_13 isbn_10 }
      editions(order_by: {users_count: desc}, limit: 3, where: {isbn_13: {_is_null: false}}) { isbn_13 }
    } }`, { id: Number(id.slice(HC_PREFIX.length)) });
    const b = data.books_by_pk;
    if (!b?.title) return null;
    const authors = (b.cached_contributors ?? []).filter((c) => !c.contribution || c.contribution === 'Author').flatMap((c) => c.author?.name ?? []);
    const isbns = [...new Set([b.default_cover_edition?.isbn_13, b.default_cover_edition?.isbn_10, ...(b.editions ?? []).map((e) => e.isbn_13)].filter((x): x is string => !!x))];
    const description = plain(b.description) || await googleDescription(isbns);
    return { id, title: b.title, author: authors.slice(0, 2).join(', '), year: Number(b.release_year) || 0, cover: b.cached_image?.url ?? '', description, refs: isbnRefs(isbns) };
  },
};

const PROVIDERS = { hardcover: hardcoverBooks, google: googleBooks, openlibrary: openLibrary } as const;
export const providerName = (process.env.BOOK_PROVIDER ?? 'google').toLowerCase() as keyof typeof PROVIDERS;
if (!(providerName in PROVIDERS)) throw new Error(`BOOK_PROVIDER must be one of: ${Object.keys(PROVIDERS).join(', ')}`);

// `--offline` (what `bun exact.mjs test` runs) answers from these instead of the network.
export const FIXTURE: Found[] = [
  { id: 'OL1W', title: 'A Quiet Harbour', author: 'Test Author', year: 1901, cover: '', description: 'A test book about a harbour.', refs: ['isbn:9780000000001'] },
  { id: 'OL2W', title: 'Notes on Rivers', author: 'Another Author', year: 1899, cover: '', description: '', refs: [] },
];

// Searches are kept a few minutes: typing the same search again, or several people searching
// the same book, costs the provider's allowance once.
const recent = new Map<string, { at: number; found: Found[] }>();
const KEEP_MS = 10 * 60_000;

export type ProviderName = keyof typeof PROVIDERS;
export const isProvider = (p: string): p is ProviderName => p in PROVIDERS;

async function providerSearch(q: string, offline: boolean, provider: ProviderName): Promise<Found[]> {
  if (offline) return FIXTURE.filter((b) => words(`${b.title} ${b.author}`).join(' ').includes(words(q).join(' ')));
  const key = `${provider}:${words(q).join(' ')}`;
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.found;
  let found: Found[];
  try {
    found = await PROVIDERS[provider].search(q);
  } catch (e) {
    // Hardcover over its allowance or down: Google answers meanwhile, when it can.
    if (provider !== 'hardcover' || !process.env.GOOGLE_BOOKS_API_KEY) throw e;
    console.warn(`search: ${(e as Error).message}; answering from Google Books`);
    return googleBooks.search(q);
  }
  recent.set(key, { at: Date.now(), found });
  if (recent.size > 500) recent.delete(recent.keys().next().value!);
  return found;
}

// Which book an ISBN is an edition of, from catalogs that group editions: Hardcover (one request
// for a whole search's ISBNs) and Open Library. Answers are kept; an ISBN neither knows (a
// university press edition, say) stays unknown and the edition matches by title and author.
const bookOfIsbn = new Map<string, string | null>();

async function hardcoverBooksOf(isbns: string[]): Promise<void> {
  const ask = [...new Set(isbns)].filter((i) => !bookOfIsbn.has(i)).slice(0, 100);
  if (!ask.length || !process.env.HARDCOVER_API_KEY) return;
  const data = await hardcover<{ editions: { isbn_13?: string; isbn_10?: string; book_id?: number }[] }>(
    'query E($i: [String!]) { editions(where: {_or: [{isbn_13: {_in: $i}}, {isbn_10: {_in: $i}}]}, limit: 200) { isbn_13 isbn_10 book_id } }', { i: ask });
  for (const i of ask) bookOfIsbn.set(i, null);
  for (const e of data.editions) for (const i of [e.isbn_13, e.isbn_10]) if (i && e.book_id) bookOfIsbn.set(i, HC_PREFIX + e.book_id);
}

const isbnsOf = (f: Found) => f.refs.filter((r) => r.startsWith('isbn:')).map((r) => r.slice(5));
const authorityOf = (f: Found) => [...new Set(isbnsOf(f).flatMap((i) => bookOfIsbn.get(i) ?? []))];

// Every name a found edition goes by, surest first.
const namesOf = (f: Found) => [f.id, ...authorityOf(f), ...f.refs, workKey(f.title, f.author)].filter(Boolean);

// One row per book: a result that is an edition of a saved book shows as that book, and saved
// books that match (the ones with audiobooks first) come along even when the provider missed
// them. `provider` asks one provider for this search alone (comparing them).
export async function search(q: string, offline: boolean, provider: ProviderName = providerName): Promise<BookRow[]> {
  const terms = words(q).filter((w) => !STOP.has(w));
  const saved = savedBooks().filter((b) => terms.length > 0 && terms.every((t) => matches(words(`${b.title} ${b.author}`), t)));
  const found = await providerSearch(q, offline, provider);
  if (!offline) await hardcoverBooksOf(found.flatMap(isbnsOf)).catch((e) => console.warn(`search: editions: ${(e as Error).message}`));
  const out: BookRow[] = [], seen = new Set<string>();
  const add = (b: BookRow, group = b.id) => {
    if (seen.has(group) || seen.has(b.id)) return;
    seen.add(group); seen.add(b.id);
    out.push({ id: b.id, title: b.title, author: b.author, year: b.year, cover: b.cover, description: b.description });
  };
  for (const b of saved) if (b.versions > 0) add(b);
  for (const f of found) {
    const known = linkedBook(namesOf(f));
    if (known && getBook(known)) add(getBook(known)!);
    // Editions of one unsaved book (the same Hardcover book, or title and author) show once.
    else add(f, authorityOf(f)[0] ?? (workKey(f.title, f.author) || f.id));
  }
  for (const b of saved) add(b);
  return out.slice(0, 25);
}

// Open Library groups every edition of a book under one work; an ISBN names it for free.
async function olWorkOf(isbns: string[]): Promise<string | null> {
  for (const isbn of isbns.slice(0, 3)) {
    const res = await fetch(`${OL}/isbn/${isbn}.json`, { headers: UA }).catch(() => null);
    if (!res?.ok) continue;
    const e = (await res.json().catch(() => ({}))) as { works?: { key?: string }[] };
    const work = e.works?.[0]?.key?.replace('/works/', '');
    if (work && /^OL\d+W$/.test(work)) return work;
  }
  return null;
}

// The book a found edition is: the saved one any of its names points to (its own id, the
// Hardcover book or Open Library work its ISBN belongs to, an ISBN, its title and author), else a
// new book under the edition's id. Every name is then kept, so the next edition of it is a
// lookup; names that turn out to point at two saved books merge them.
export async function resolve(f: Found, offline: boolean): Promise<BookRow> {
  const isbns = isbnsOf(f);
  const extra: string[] = [];
  if (!offline && isbns.length) {
    await hardcoverBooksOf(isbns).catch(() => {});
    if (!openLibrary.owns(f.id)) { const work = await olWorkOf(isbns); if (work) extra.push(work); }
  }
  const names = [...namesOf(f), ...extra];
  const owners = [...new Set(names.flatMap((n) => linkedBook([n]) ?? []))].filter((id) => getBook(id));
  let id = owners[0];
  if (!id) {
    upsertBook({ id: f.id, title: f.title, author: f.author, year: f.year, cover: f.cover, description: f.description });
    id = f.id;
  }
  for (const other of owners.slice(1)) mergeBooks(id, other);
  link(id, names);
  const book = getBook(id)!;
  // A description or cover the saved record lacks, from this edition.
  if ((!book.description && f.description) || (!book.cover && f.cover)) {
    upsertBook({ ...book, description: book.description || f.description, cover: book.cover || f.cover });
    return getBook(id)!;
  }
  return book;
}

// The book's one record: saved, under this id or any name linked to it; else fetched once from
// the provider that owns the id and resolved to the book it is an edition of.
export async function ensureBook(id: string, offline: boolean): Promise<BookRow | null> {
  const known = linkedBook([id]) ?? (getBook(id) ? id : null);
  if (known) return getBook(known);
  const provider = Object.values(PROVIDERS).find((p) => p.owns(id));
  if (!provider) return null;
  const found = offline ? FIXTURE.find((b) => b.id === id) ?? null : await provider.fetch(id);
  return found ? resolve(found, offline) : null;
}

// At start: every saved book is named by its id and title, and rows that name the same book
// (saved before books were merged) become one, keeping the one with the most audiobooks.
export function consolidate() {
  for (const b of allBooksByAudio()) {
    const key = workKey(b.title, b.author);
    const owner = key ? linkedBook([key]) : null;
    if (owner && owner !== b.id && getBook(owner)) { mergeBooks(owner, b.id); continue; }
    link(b.id, [b.id, key]);
  }
}
