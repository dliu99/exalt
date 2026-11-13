// An uploaded book to chapters of plain text: EPUB and TXT as book.ts reads them (the app reads
// those too), and PDF here, by its outline, else in 10-page parts. Ligatures are read as their
// letters, including PDF ligature glyphs that pdf.js reads as stray letters.
import { MAX_BOOK_BYTES, MAX_TEXT_CHARS } from './limits.ts';
import { type Chapter, chapterLevel, type Entry, escapeRe, isLegal, isMatterTitle, keptChapters, norm, OPENING_WORDS, readChapters, tidy, unligate, words } from './book.ts';

export { bookMeta, type BookMeta, type Chapter } from './book.ts';

export async function parseBook(name: string, bytes: Uint8Array): Promise<Chapter[]> {
  if (bytes.length > MAX_BOOK_BYTES) throw new Error('Book files must be under 50 MB.');
  const ext = name.toLowerCase().split('.').pop();
  const chapters = ext === 'pdf' ? await parsePdf(bytes) : await readChapters(name, bytes);
  if (!chapters) throw new Error('Upload an EPUB, PDF or TXT file.');
  return await keptChapters(chapters, MAX_TEXT_CHARS);
}

type Pdf = Awaited<ReturnType<typeof import('unpdf')['getDocumentProxy']>>;
type OutlineNode = { title: string; dest: string | unknown[] | null; items?: OutlineNode[] };

async function parsePdf(bytes: Uint8Array): Promise<Chapter[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  try {
    const pages = restoreLigatures((await extractText(pdf, { mergePages: false })).text as string[]);
    const chapters = await byOutline(pdf, pages);
    return chapters && chapters.length >= 2 ? chapters : byPages(pages);
  } finally {
    await pdf.loadingTask.destroy();
  }
}

// pdf.js reads a character code missing from a font's ToUnicode map as the character itself. In a
// composite font that code is the glyph id, so a PDF that leaves its ligature glyphs out of the map
// (calibre's do) comes out with stray letters for them: Charis SIL gives "ɹrst" for "first" and "oʃ"
// for "off". pdf.js has no option to map them otherwise, and the ids depend on the font, so the book
// says which ligature each stray letter stands for: the one that turns the most of the Latin words
// it's in into words the book also spells in plain letters ("First" at a sentence start vouches for
// "ɹrst"). IPA and other real uses of these letters don't spell the book's words, so they stay.
const LIGATURE_LETTERS = ['ff', 'fi', 'fl', 'ffi', 'ffl', 'ft', 'fj', 'st', 'ct', 'Th'];
// Charis SIL's ligature glyph ids, for a ligature too rare to vouch for itself in a book that has
// vouched for two others.
const CHARIS: Record<string, string> = { 'ʃ': 'ff', 'ɹ': 'fi', 'ɻ': 'fl', 'ɽ': 'ffi', 'ʀ': 'ffl' };
const LATIN = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u017F';
// A letter beyond Latin-1 and Latin Extended-A, or a private-use character.
const STRAY = new RegExp(`[^\\P{L}${LATIN}]|\\p{Co}`, 'gu');
const MIXED_WORD = new RegExp(`(?:[${LATIN}]|${STRAY.source})+`, 'gu');

export function restoreLigatures(pages: string[]): string[] {
  const plain = new Set<string>(), seen = new Map<string, Set<string>>();
  for (const page of pages) for (const [w] of page.matchAll(MIXED_WORD)) {
    const strays = new Set(w.match(STRAY));
    if (strays.size === 0) plain.add(w.toLowerCase());
    else if (strays.size === 1 && /[A-Za-z]/.test(w)) { const [c] = strays; seen.set(c, (seen.get(c) ?? new Set()).add(w)); }
  }
  // A stray letter's ligature must make at least three of its words, a tenth of them, and twice as
  // many as the next best.
  const map = new Map<string, string>();
  for (const [c, ws] of seen) {
    const [[best, n], [, next]] = LIGATURE_LETTERS.map((l) => [l, [...ws].filter((w) => plain.has(w.split(c).join(l).toLowerCase())).length] as const).sort((a, b) => b[1] - a[1]);
    if (n >= 3 && n >= ws.size / 10 && n >= 2 * next) map.set(c, best);
  }
  if (Object.entries(CHARIS).filter(([c, l]) => map.get(c) === l).length >= 2) for (const [c, l] of Object.entries(CHARIS)) if (!map.has(c)) map.set(c, l);
  if (map.size === 0) return pages;
  // Only inside words with Latin letters, and only words whose every stray letter is a ligature.
  return pages.map((p) => p.replace(MIXED_WORD, (w) => {
    const strays = w.match(STRAY);
    return strays && /[A-Za-z]/.test(w) && strays.every((c) => map.has(c)) ? w.replace(STRAY, (c) => map.get(c)!) : w;
  }));
}

function byPages(pages: string[]): Chapter[] {
  const out: Chapter[] = [];
  for (let i = 0; i < pages.length; i += 10) {
    const last = Math.min(i + 10, pages.length);
    out.push({ title: `Pages ${i + 1}–${last}`, text: pages.slice(i, last).join(' ') });
  }
  return out;
}

// Where a title appears in page text, matching its words through any spacing, case or punctuation.
// A title of a word or two short letters ("I", "12") is too easily found in prose, so isn't looked for.
function findTitle(text: string, title: string): { index: number; length: number } | null {
  const ws = norm(title);
  if (ws.join('').length < 4) return null;
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${ws.map(escapeRe).join('[^\\p{L}\\p{N}]*')}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
  return m ? { index: m.index, length: m[0].length } : null;
}

// Chapters from the PDF's outline (bookmarks). Each starts where its title appears on its page, so a
// chapter that begins mid-page splits there; otherwise at the top of its page.
async function byOutline(pdf: Pdf, pages: string[]): Promise<Chapter[] | null> {
  const outline = (await pdf.getOutline().catch(() => null)) as OutlineNode[] | null;
  if (!outline?.length) return null;
  const pageOf = async (dest: OutlineNode['dest']): Promise<number | undefined> => {
    try {
      const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      if (!Array.isArray(d) || d[0] == null) return;
      const i = typeof d[0] === 'number' ? d[0] : await pdf.getPageIndex(d[0] as Parameters<Pdf['getPageIndex']>[0]);
      return i >= 0 && i < pages.length ? i : undefined;
    } catch { return; }
  };
  const place = (nodes: OutlineNode[], depth: number): Promise<Entry<number>[]> => Promise.all(nodes.map(async (n) => (
    { title: tidy(unligate(n.title ?? '')), at: await pageOf(n.dest), children: depth < 3 ? await place(n.items ?? [], depth + 1) : [] })));
  const list = chapterLevel(await place(outline, 0)).filter((e): e is Entry<number> & { at: number } => e.at !== undefined).sort((a, b) => a.at - b.at);
  if (new Set(list.map((e) => e.at)).size < 2) return null;

  const starts: number[] = [];
  let stream = '';
  for (const p of pages) { starts.push(stream.length); stream += p + '\n'; }
  starts.push(stream.length);
  let floor = 0;
  const marks = list.map((e) => {
    const top = Math.max(starts[e.at], floor), hit = findTitle(stream.slice(top, starts[e.at + 1]), e.title);
    const from = hit ? top + hit.index : top;
    floor = hit ? from + hit.length : from;
    return { e, from, body: floor };
  });

  const out: Chapter[] = [];
  // Pages before the first bookmark, without copyright and contents pages, open the book if they're long enough.
  const lead = pages.slice(0, list[0].at).filter((p) => !isLegal(p) && !/\bcontents\b/i.test(p.slice(0, 200)) && !/(?:\.\s*){6,}\d/.test(p)).join('\n');
  if (words(lead) >= OPENING_WORDS) out.push({ title: 'Opening', text: lead });
  marks.forEach(({ e, body }, i) => {
    const text = tidy(stream.slice(body, marks[i + 1]?.from ?? stream.length));
    if (isMatterTitle(e.title) || isLegal(text) || (e.part && words(text) < OPENING_WORDS)) return;
    out.push({ title: e.title || `Section ${out.length + 1}`, text });
  });
  return out;
}

// TTS endpoints take a bounded input: split at sentence ends under `max` characters. With
// `first`, the chunks start smaller and double up to `max` (first, 2×first, …), so the opening
// of a chapter comes back from the provider soonest.
export function chunks(text: string, max = 3000, first = max): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]+["'’”)]*\s*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  const limit = () => Math.min(max, first * 2 ** out.length);
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > limit()) { out.push(cur.trim()); cur = ''; }
    if (s.length > max) { for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max)); continue; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// What a chapter is narrated in: its title read first, then its text, in parts that start at
// about 600 characters (some 40 seconds of speech) and grow to 3,000. The first part is back
// from the provider in seconds, and plays while the larger ones are narrated.
export const partsOf = (title: string, text: string) => chunks(`${title}. ${text}`, 3000, 600);
