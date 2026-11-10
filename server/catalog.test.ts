// The bar Google Books results clear before Exalt shows them (rankVolumes in catalog.ts),
// on volumes shaped like what Google answered for these searches. `bun test server`.
import { expect, test } from 'bun:test';
process.env.DB = ':memory:';
process.env.LIBGEN_ENABLED = '0';
const { rankVolumes } = await import('./catalog.ts');
import type { Volume } from './catalog.ts';

const vol = (id: string, title: string, authors: string[] | undefined, more: Record<string, unknown> = {}): Volume =>
  ({ id, volumeInfo: { title, authors, language: 'en', pageCount: 200, imageLinks: { thumbnail: 'x' }, description: 'd', ...more } });
const titles = (q: string, vs: Volume[]) => rankVolumes(q, vs).map((v) => `${v.volumeInfo?.title} / ${v.volumeInfo?.authors?.[0]}`);

test('every word searched must be in the title or an author', () => {
  expect(titles('harassment architecture', [
    vol('1', 'Harassment Architecture', ['Mike Ma']),
    vol('2', 'Stop the Machines', ['Mauro Lubrano']),
    vol('3', "The Architect's Handbook of Professional Practice", ['American Institute of Architects']),
    vol('4', 'Architectural Record', undefined),
  ])).toEqual(['Harassment Architecture / Mike Ma']);
});

test('study aids, reviews, film listings, stubs and translations are dropped; editions collapse', () => {
  const found = [
    vol('a', 'Project Hail Mary', ['Andy Weir'], { subtitle: 'A Novel', ratingsCount: 2 }),
    vol('b', 'Project Hail Mary', ['Andy Weir'], { language: 'it' }),
    vol('c', 'Project Hail Mary (Deluxe Edition)', ['Andy Weir']),
    vol('d', 'PROJECT HAIL MARY MOVIE REVIEW', ['OMAR. LINEHAN']),
    vol('e', 'Summary and Analysis of Project Hail Mary by Andy Weir', ['Good Reads Publishing']),
    vol('f', 'Project Hail Mary', ['Ryan Gosling'], { pageCount: 0, imageLinks: undefined, description: undefined }),
    vol('g', 'Book Club Kit: Project Hail Mary', ['Andy Weir']),
  ];
  expect(titles('project hail mary', found)).toEqual(['Project Hail Mary / Andy Weir']);
  expect(rankVolumes('project hail mary', found)[0].id).toBe('a');
  // Asking for a summary finds one.
  expect(titles('project hail mary summary', found)).toEqual(['Summary and Analysis of Project Hail Mary by Andy Weir / Good Reads Publishing']);
});

test('the title itself ranks above books that only contain the word', () => {
  expect(titles('dune', [
    vol('1', 'Chapterhouse: Dune', ['Frank Herbert'], { ratingsCount: 5 }),
    vol('2', 'Dune Erosion During Storm Surges', ['J. van Thiel de Vries']),
    vol('3', 'Dune', ['Frank Herbert'], { ratingsCount: 1 }),
  ])[0]).toBe('Dune / Frank Herbert');
});

test('another language only when nothing in English clears the bar', () => {
  expect(titles('uppdrag hail mary', [vol('1', 'Uppdrag Hail Mary', ['Andy Weir'], { language: 'sv' })])).toEqual(['Uppdrag Hail Mary / Andy Weir']);
});

test('an empty or stopword search finds nothing', () => {
  expect(rankVolumes('the', [vol('1', 'The', ['A'])])).toEqual([]);
});

// Hardcover: one record per book, with how many people read it.
const { rankHits } = await import('./catalog.ts');
import type { HardcoverHit } from './catalog.ts';
const hit = (id: number, title: string, author_names: string[], users_count: number, more: Record<string, unknown> = {}): HardcoverHit =>
  ({ document: { id, title, author_names, users_count, image: { url: 'x' }, description: 'd', ...more } });
const ranked = (q: string, hs: HardcoverHit[]) => rankHits(q, hs).map((d) => `${d.title} / ${d.author_names?.[0]}`);

test('the most-read book of a title ranks first; one-reader books of the same name sink', () => {
  expect(ranked('beyond good and evil', [
    hit(1, 'Beyond Good and Evil', ['Eric Meyer'], 1),
    hit(2, 'Beyond Good & Evil', ['L.T. Vargus'], 1),
    hit(3, 'Human, All Too Human & Beyond Good and Evil', ['Friedrich Nietzsche'], 4),
    hit(4, 'Beyond Good and Evil', ['Friedrich Nietzsche'], 1268),
  ])).toEqual(['Beyond Good and Evil / Friedrich Nietzsche', 'Beyond Good and Evil / Eric Meyer',
    'Beyond Good & Evil / L.T. Vargus', 'Human, All Too Human & Beyond Good and Evil / Friedrich Nietzsche']);
});

test('a series ranks by readers, not by whether its title is exactly the search', () => {
  expect(ranked('dune', [
    hit(1, 'Dune', ['Christian McCrea'], 2),
    hit(2, 'Dune Messiah', ['Frank Herbert'], 5421),
    hit(3, 'Dune', ['Frank Herbert'], 15672),
  ])).toEqual(['Dune / Frank Herbert', 'Dune Messiah / Frank Herbert', 'Dune / Christian McCrea']);
});

test("an author's name finds their books ahead of books named after them", () => {
  expect(ranked('nietzsche', [
    hit(1, 'Nietzsche', ['Walter Arnold Kaufmann'], 42),
    hit(2, 'Thus Spoke Zarathustra', ['Friedrich Nietzsche'], 3000),
  ])[0]).toBe('Thus Spoke Zarathustra / Friedrich Nietzsche');
});

test('the words not in the title must all be in one author, not spread over an anthology', () => {
  expect(ranked('mike ma', [
    hit(1, 'Harassment Architecture', ['Mike Ma'], 52),
    hit(2, 'Writers of the Future Volume #35', ['L. Ron Hubbard', 'Mike Resnick', 'Qianjiao Ma'], 4),
    hit(3, 'Fleetwood Mac: The Definitive History', ['Mike Evans'], 1),
    hit(4, 'Unattributed', ['Unknown'], 9),
  ])).toEqual(['Harassment Architecture / Mike Ma']);
});

test('a duplicate record that lists its authors as one name is the same book', () => {
  expect(ranked('anti-oedipus', [
    hit(1, 'Anti-Oedipus: Capitalism and Schizophrenia', ['Gilles Deleuze', 'Félix Guattari'], 227),
    hit(2, 'Anti-Oedipus: Capitalism and Schizophrenia', ['Gilles Deleuze, Félix Guattari'], 3),
    hit(3, 'Dune', ['Herbert, Frank'], 3),
  ])).toEqual(['Anti-Oedipus: Capitalism and Schizophrenia / Gilles Deleuze']);
});

// One book, however many editions and providers name it.
const { workKey, resolve, consolidate, search } = await import('./catalog.ts');
const { db, getBook, upsertBook, linkedBook } = await import('./db.ts');
import type { Found } from './catalog.ts';
const edition = (id: string, title: string, author: string, isbns: string[] = [], description = ''): Found =>
  ({ id, title, author, year: 2000, cover: '', description, refs: isbns.map((i) => `isbn:${i}`) });

test('editions of one book share a key; different books by one author do not', () => {
  const k = workKey('Thus Spoke Zarathustra', 'Friedrich Nietzsche');
  expect(workKey('Thus Spoke Zarathustra (Illustrated Edition)', 'Friedrich Wilhelm Nietzsche')).toBe(k);
  expect(workKey('Thus Spoke Zarathustra by Friedrich Nietzsche', 'Friedrich Nietzsche')).toBe(k);
  expect(workKey('Thus Spoke Zarathustra Annotated', 'Friedrich Nietzsche, R. J. Hollingdale')).toBe(k);
  const bge = workKey('Beyond Good and Evil', 'Friedrich Nietzsche');
  expect(workKey('Beyond Good and Evil by Friedrich Wilhelm Nietzsche Annotated and Illustrated Edition', 'Friedrich Wilhelm Nietzsche')).toBe(bge);
  expect(workKey('Friedrich Nietzsche - Beyond Good and Evil', 'Friedrich Wilhelm Nietzsche')).toBe(bge);
  expect(workKey('Stand By Me', 'Stephen King')).toBe('key:stand by me|stephen king');
  expect(workKey('Dune: House Atreides', 'Brian Herbert')).not.toBe(workKey('Dune: The Butlerian Jihad', 'Brian Herbert'));
  expect(workKey('Dune', 'Brian Herbert')).not.toBe(workKey('Dune', 'Frank Herbert'));
  expect(workKey('Untitled', '')).toBe('');
});

test('a second edition of a saved book is that book, and its audiobooks stay together', async () => {
  const first = await resolve(edition('gb-Z1', 'Thus Spoke Zarathustra', 'Friedrich Nietzsche', ['9780140441185']), true);
  const second = await resolve(edition('gb-Z2', 'Thus Spoke Zarathustra (Penguin Classics)', 'Friedrich Wilhelm Nietzsche', ['9780140441189'], 'About it.'), true);
  expect(second.id).toBe(first.id);
  expect(second.description).toBe('About it.'); // the saved record gains what it lacked
  expect(linkedBook(['gb-Z2'])).toBe('gb-Z1');
  expect(linkedBook(['isbn:9780140441189'])).toBe('gb-Z1');
  // An edition known only by an ISBN another edition carried is the same book too.
  expect((await resolve(edition('hc-77', 'Also sprach Zarathustra', 'F. Nietzsche', ['9780140441185']), true)).id).toBe('gb-Z1');
});

test('books saved twice before merging become one, with every audiobook', () => {
  upsertBook({ id: 'gb-D1', title: 'Dune', author: 'Frank Herbert', year: 1965, cover: '', description: '' });
  upsertBook({ id: 'gb-D2', title: 'Dune (Movie Tie-In)', author: 'Frank Herbert', year: 2021, cover: '', description: '' });
  const made = (book: string) => db.query(`INSERT INTO generations (book_id, made_by, model, voice, source_name, status, created_at)
    VALUES (?, 'x', 'm', '', 'f', 'ready', 0)`).run(book);
  made('gb-D2'); made('gb-D2'); made('gb-D1');
  consolidate();
  const left = ['gb-D1', 'gb-D2'].filter((id) => getBook(id));
  expect(left).toEqual(['gb-D2']); // the one with more audiobooks stays
  expect(linkedBook(['gb-D1'])).toBe('gb-D2');
  expect((db.query("SELECT COUNT(*) AS n FROM generations WHERE book_id = 'gb-D2'").get() as { n: number }).n).toBe(3);
});

test('a search shows a saved book once, under its saved id, even when the provider has other editions', async () => {
  // Saved earlier from another provider's edition; the offline provider answers with OL1W.
  await resolve(edition('gb-H0', 'A Quiet Harbour: Illustrated', 'Test Author'), true);
  expect((await search('harbour', true)).map((b) => b.id)).toEqual(['gb-H0']);
  // A saved book the provider doesn't answer with still shows.
  await resolve(edition('gb-R9', 'Harbour Lights', 'Somebody Else'), true);
  expect((await search('harbour', true)).map((b) => b.id).sort()).toEqual(['gb-H0', 'gb-R9']);
});

test('an edition whose names point at two saved books shows they were one, and merges them', async () => {
  await resolve(edition('gb-M1', 'Meditations', 'Marcus Aurelius', ['9780000000101']), true);
  await resolve(edition('gb-M2', 'The Meditations of the Emperor', 'Marcus Aurelius', ['9780000000102']), true);
  expect(getBook('gb-M2')).not.toBeNull();
  // This edition carries an ISBN of each.
  const one = await resolve(edition('gb-M3', 'Meditations', 'Marcus Aurelius', ['9780000000101', '9780000000102']), true);
  expect(one.id).toBe('gb-M1');
  expect(getBook('gb-M2')).toBeNull();
  expect(linkedBook(['gb-M2'])).toBe('gb-M1');
});

test('Z-Library augments catalog search, merges editions and answers when the catalog is down', async () => {
  const { zlib } = await import('./zlibrary.ts');
  const original = { configured: zlib.configured, search: zlib.search, book: zlib.book, fetch: globalThis.fetch };
  const remote = { id: 'zl-765-abc', title: 'The Public Harbour', author: 'Ada Writer', year: 1900, cover: '', description: '', extension: 'epub', language: 'English', size: '' };
  try {
    zlib.configured = true;
    zlib.search = async () => [remote];
    zlib.book = async () => remote;
    globalThis.fetch = (async () => Response.json({ items: [vol('public-harbour', remote.title, [remote.author])] })) as typeof fetch;
    expect((await search('public harbour', false, 'google')).map((b) => b.id)).toEqual(['gb-public-harbour']);
    const saved = await (await import('./catalog.ts')).ensureBook(remote.id, false);
    expect(saved?.title).toBe(remote.title);
    globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
    expect((await search('public harbour ada', false, 'google')).map((b) => b.id)).toEqual([remote.id]);
    zlib.search = async () => { throw new Error('Z-Library unavailable'); };
    await expect(search('uncached unavailable query', false, 'google')).rejects.toThrow();
  } finally {
    zlib.configured = original.configured; zlib.search = original.search; zlib.book = original.book; globalThis.fetch = original.fetch;
  }
});

test('LibGen results join catalog search and saved books resolve from stable file hashes', async () => {
  const { lg } = await import('./libgen.ts');
  const old = { enabled: lg.enabled, search: lg.search, book: lg.book, fetch: globalThis.fetch };
  const file = { id: 'lg-1234567890abcdef1234567890abcdef', title: 'The Open River', author: 'Ada Writer', year: 1900, cover: '', description: '', extension: 'epub', language: 'eng', size: '' };
  try {
    lg.enabled = true; lg.search = async () => [file]; lg.book = async () => file;
    globalThis.fetch = (async () => Response.json({ items: [vol('river-meta', file.title, [file.author])] })) as typeof fetch;
    expect((await search('open river', false, 'google')).map((b) => b.id)).toEqual(['gb-river-meta']);
    const saved = await (await import('./catalog.ts')).ensureBook(file.id, false);
    expect(saved?.title).toBe(file.title);
    expect((await search('open river ada', false, 'google')).map((b) => b.id)).toEqual([file.id]);
  } finally { lg.enabled = old.enabled; lg.search = old.search; lg.book = old.book; globalThis.fetch = old.fetch; }
});
