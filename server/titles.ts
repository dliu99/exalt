// A chapter title as the book's table of contents, headings or PDF outline gives it, read into what
// it says (a kind, the book's own label word, a number and a name), and shown and narrated one
// consistent way across books (see titles.md). book.ts keptChapters reads every book's titles with
// it, on the phone (the app's import preview) and the server alike, so it stays cheap: a few
// regular expressions a title, a turn a chapter.
//
// normalizeTitle reads one title on its own; normalizeChapters reads a whole book's, where some
// rules need the others: page numbers every title ends in, bare numbers that count up, the book's
// own title page, and a chapter's own heading when its table of contents label says less.

export type TitleKind = 'chapter' | 'front' | 'back' | 'skip';
export type Title = {
  kind: TitleKind;
  label?: string; // the book's word for its sections, title-cased: Chapter, Book, Part, Act, Letter…
  n?: number | string; // 4 (from 4, IV, Four, Fourth), or a letter for an appendix
  name?: string; // the chapter's own name, cased and trimmed: "Loomings"
  caption?: string; // an illustration caption that was glued to the title, dropped from it
  suspect?: true; // reads like a sentence of prose, not a title: the split that made it is likely wrong
  display: string; // a list row: the name, else "Chapter 4"
  spoken: string; // what is narrated before the text: "Chapter 4. Loomings."
  raw: string;
};

// The words books use for a numbered section.
const LABELS = ['chapter', 'chap', 'book', 'part', 'act', 'scene', 'letter', 'stave', 'canto', 'section', 'volume', 'vol', 'episode', 'lecture', 'lesson', 'appendix', 'essay', 'story', 'sermon', 'fit', 'fitte', 'sonnet', 'psalm'];
const LABEL_SHOWN: Record<string, string> = { chap: 'Chapter', vol: 'Volume' };
const LABEL = `(?:${LABELS.join('|')})\\.?`;

const ROMAN = /^(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i;
const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINAL_UNITS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth'];
const ORDINAL_TENS = ['', '', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth'];
const NUMBER_WORD = '(?:[a-z]+(?:-[a-z]+)?)';

function romanValue(s: string): number {
  const v: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  const u = s.toUpperCase();
  for (let i = 0; i < u.length; i++) n += v[u[i]] < (v[u[i + 1]] ?? 0) ? -v[u[i]] : v[u[i]];
  return n;
}

function wordValue(s: string): number | undefined {
  const w = s.toLowerCase();
  const one = (x: string) => {
    for (const list of [UNITS, ORDINAL_UNITS]) { const i = list.indexOf(x); if (i >= 0) return i; }
    for (const list of [TENS, ORDINAL_TENS]) { const i = list.indexOf(x); if (i >= 2) return i * 10; }
  };
  const [a, b] = w.split('-');
  if (b === undefined) return one(a) || undefined;
  const t = TENS.indexOf(a), u = one(b);
  return t >= 2 && u !== undefined && u > 0 && u < 10 ? t * 10 + u : undefined;
}

/** A number token (4, IV, Four, Fourth) as a number; undefined when it isn't one. */
export function numberOf(token: string): number | undefined {
  const t = token.replace(/\.$/, '');
  if (/^\d{1,4}$/.test(t)) return Number(t);
  if (ROMAN.test(t) && t === t.toUpperCase()) return romanValue(t);
  if (ROMAN.test(t) && /^[ivxlc]+$/.test(t)) return romanValue(t); // "chapter iv"
  return wordValue(t);
}

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'over', 'per', 'the', 'to', 'up', 'upon', 'via', 'vs', 'with']);
// A capitals-only roman numeral of I, V and X is kept as one ("Henry VIII", "Part II"); other
// letters spell words too often (MIX, CIVIL, DIM).
const KEEP_CAPS = /^(?=[IVX]{2,}$)(?:X{0,3})(?:IX|IV|V?I{0,3})$/;

function capWord(w: string, first: boolean, last: boolean): string {
  if (KEEP_CAPS.test(w)) return w;
  return w.split('-').map((part, i) => {
    const lower = part.toLowerCase();
    if (i === 0 && !first && !last && SMALL.has(lower.replace(/[^\p{L}]/gu, ''))) return lower;
    // The first letter, after any opening quote or bracket; O’Brien and D’Arcy keep their second capital.
    return lower.replace(/^([^\p{L}]*)(\p{L})/u, (_, p, c) => p + c.toUpperCase())
      .replace(/^([^\p{L}]*[odOD])(['’])(\p{L}{3,})/u, (_, p, q, rest) => p.replace(/[od]$/i, (c: string) => c.toUpperCase()) + q + rest[0].toUpperCase() + rest.slice(1));
  }).join('-');
}

/** Title Case for a run of text set in capitals; anything already in mixed case stays as it is,
 * so only the shouted parts of "GEOGRAPHICAL DISTRIBUTION—continued" change. */
export function titleCase(s: string): string {
  // Runs between sentence punctuation, dashes and brackets are cased on their own.
  // A run is shouted when its words are capitals, but for lower-case small words ("PRIDE and PREJUDICE").
  return s.replace(/[^.:;!?()[\]—–]+/g, (run) => {
    const ws = run.match(/\p{L}[\p{L}’'-]*/gu) ?? [];
    const caps = ws.filter((w) => w.length >= 2 && w === w.toUpperCase() && w !== w.toLowerCase());
    if (caps.length === 0 || !ws.every((w) => w === w.toUpperCase() || SMALL.has(w))) return run;
    return casedRun(run);
  });
}

function casedRun(run: string): string {
  const ws = run.split(/(\s+)/);
  const real = ws.map((w, i) => (i % 2 === 0 && /\p{L}/u.test(w) ? i : -1)).filter((i) => i >= 0);
  return ws.map((w, i) => (i % 2 === 0 && /\p{L}/u.test(w) ? capWord(w, i === real[0], i === real[real.length - 1]) : w)).join('');
}

// Matter: not narrated (skip), or narrated but not numbered (front, back).
const SKIP = [
  /project gutenberg/i, /\b(?:licen[cs]e|copyright)\b/i, /^(?:detailed |detea?iled )?(?:table of )?contents\b/i, /\bcontents\.?$/i,
  /^(?:front |back )?cover$/i, /^(?:half[- ]?)?title(?: page)?$/i, /^index$/i, /^colophon$/i, /^imprint$/i,
  /^list of (?:illustrations|figures|tables|maps|plates)\b/i, /^(?:also|other books|more books|books) by\b/i, /^praise for\b/i, /^about the (?:publisher|authors?)$/i,
  /^(?:the )?dedication$/i, /^acknowledge?ments?$/i,
];
const FRONT = /^(?:the |a )?(?:preface|foreword|fore-word|introduction|introductory|prologue|prolog|prelude|proem|epigraph|dramatis person(?:ae|æ)|persons represented|characters|etymology|extracts|author[’']s (?:note|preface)|translator[’']s (?:note|preface|introduction)|note to the .* edition|a note on the text|editor[’']s (?:note|preface))(?![\p{L}])/iu;
const BACK = /^(?:the |an? )?(?:epilogue|epilog|afterword|after-word|postscript|addend(?:a|um)|appendix|appendices|glossary|endnotes|notes|bibliography|author[’']s afterword|l[’']envoi)(?![\p{L}])/iu;

const trimDecor = (s: string) => s
  .replace(/\s+/g, ' ')
  .replace(/^[\s\-–—*·•_~=]+|[\s\-–—*·•_~=]+$/g, '') // "— I —", "* * *"
  .replace(/^[[(]?([^[\]()]*)[\])]$/, (all, inner) => (/[[(]/.test(all[0]) ? inner : all)) // "[Chapter I]"
  .replace(/^([^[]*)\]$/, '$1') // "Chapter I.]": a stray bracket from an illustration's markup
  .trim();
// A trailing full stop goes, unless it ends an abbreviation ("Mr.", "St.", "U.S.").
const trimStop = (s: string) => (/(?:\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Co|Mt|Ft|Esq|etc)|\b\p{L}\.\p{L})\.$/u.test(s) ? s : s.replace(/[.,;:]+$/, '')).trim();
// Page numbers after dot leaders or a tab ("Introduction ........ 12"), always.
const LEADERS = /(?:\s*\.(?:\s*\.){2,}\s*|\s*…+\s*|\t+)\s*\d+$/;

function cleanName(s: string): string | undefined {
  let n = trimStop(trimDecor(s.replace(/\.\s*—/g, '—').replace(/^[.:;,)\]—–\-\s]+/, '')));
  n = titleCase(n);
  return n && /[\p{L}\p{N}]/u.test(n) ? n : undefined;
}

type Parsed = { label?: string; n?: number | string; name?: string; caption?: string; weak?: boolean };

// The forms a title takes. Each returns undefined when it doesn't fit.
function parse(raw: string): Parsed {
  const s = trimDecor(raw.replace(LEADERS, ''));
  const NUM = `(\\d{1,4}|[ivxlcdm]+|${NUMBER_WORD})`;
  // A caption glued before its chapter's label: "He rode a black horse. CHAPTER III."
  let m = s.match(new RegExp(`^(.*?[.!?”"’)])\\s*(${LABEL})\\s*${NUM}\\.?$`, 'i'));
  if (m && numberOf(m[3]) !== undefined) {
    return { label: labelOf(m[2]), n: numberOf(m[3]), caption: trimStop(m[1].replace(/^[“"‘']|[”"’']$/g, '').replace(/[“"‘']/g, '')) || undefined };
  }
  // "Book the First", "Part the Second: Name"
  m = s.match(new RegExp(`^(${LABEL})\\s+the\\s+(${NUMBER_WORD})\\b(.*)$`, 'i'));
  if (m && wordValue(m[2]) !== undefined) return { label: labelOf(m[1]), n: wordValue(m[2]), name: cleanName(m[3]) };
  // "Chapter 4", "CHAPTER IV. Loomings", "CHAPTERXXVII.", "Chapter Four: Name", "Appendix A"
  m = s.match(new RegExp(`^(${LABEL})\\s*${NUM}(?![\\p{L}\\p{N}])(.*)$`, 'iu'));
  if (m && numberOf(m[2]) !== undefined) return { label: labelOf(m[1]), n: numberOf(m[2]), name: cleanName(m[3]) };
  m = s.match(/^(appendix)\s+([A-Z])\b(.*)$/i);
  if (m) return { label: 'Appendix', n: m[2].toUpperCase(), name: cleanName(m[3]) };
  // A number with punctuation before a name: "1: The Modern World", "IV. BEOWULF GOES…", "12) Name"
  m = s.match(/^(\d{1,3}|[IVXLC]+)\s*[.:)—–-]\s*(?!\d)(\S.*)$/);
  // A roman one is weak ("L. of G.’s Purport" is a name); an arabic one with punctuation is not.
  if (m && numberOf(m[1]) !== undefined && /\p{L}/u.test(m[2])) return { n: numberOf(m[1]), name: cleanName(m[2]), weak: !/\d/.test(m[1]) || undefined };
  // A number and a space before a capitalised name, as PDF outlines number: "3 Functions". Weak:
  // kept only when the book's numbers count up.
  m = s.match(/^(\d{1,3})\s+(\p{Lu}.*)$/u);
  if (m) return { n: Number(m[1]), name: cleanName(m[2]), weak: true };
  // A number alone: "I", "— II —", "12."
  m = s.match(/^(\d{1,4}|[IVXLC]+)\.?$/);
  if (m) return { n: numberOf(m[1]), weak: true };
  return { name: cleanName(s) };
}
const labelOf = (w: string) => { const k = w.toLowerCase().replace(/\.$/, ''); return LABEL_SHOWN[k] ?? k[0].toUpperCase() + k.slice(1); };

function kindOf(p: Parsed, raw: string): TitleKind {
  const s = trimDecor(raw);
  if (SKIP.some((r) => r.test(s))) return 'skip';
  if (p.label === 'Appendix') return 'back';
  if (p.label || p.n !== undefined) return 'chapter';
  const name = p.name ?? '';
  if (FRONT.test(name)) return 'front';
  if (BACK.test(name)) return 'back';
  return 'chapter';
}

// A number without the book's word for it ("IV. Beowulf Goes to Hrothgar's Assistance", "1: The
// Modern World") is shown as "Chapter 4" only when there's no name, and isn't spoken: the label
// would be the app's guess. Numbers are spoken as digits, which TTS reads; "IV" it may spell out.
function finish(p: Parsed, kind: TitleKind, raw: string): Title {
  const numbered = p.n !== undefined ? `${p.label ?? 'Chapter'} ${p.n}` : undefined;
  const display = p.name ?? numbered ?? (trimDecor(raw) || 'Untitled');
  const spoken = (p.label && numbered && p.name ? `${numbered}. ${p.name}` : display).replace(/([^.!?…])$/, '$1.');
  const t: Title = { kind, display, spoken, raw };
  if (p.label) t.label = p.label;
  if (p.n !== undefined) t.n = p.n;
  if (p.name) t.name = p.name;
  if (p.caption) t.caption = p.caption;
  if ((!p.label && p.n === undefined && looksLikeProse(raw)) || (p.name && p.name.split(' ').length > 8 && /[,;]?\s\p{Ll}+,?$/u.test(p.name))) t.suspect = true;
  return t;
}
// A sentence cut from the text rather than a title: it starts in lower case, or runs long and
// ends mid-clause. TXT's heading search finds these ("part of his face, extending down past the").
const looksLikeProse = (raw: string) => { const s = trimDecor(raw); return /^\p{Ll}/u.test(s) || (s.split(' ').length > 10 && /(?:[,;]|\s\p{Ll}[\p{L}’'-]*)$/u.test(s)); };

/** One title read on its own. */
export function normalizeTitle(raw: string): Title {
  const p = parse(raw);
  return finish(p, kindOf(p, raw), raw);
}

/** Whether a line of a plain-text book is a chapter heading: the book's word and a number
 * ("CHAPTER I.", "Letter 1", "BOOK the Second"), or a number before a name in capitals ("I. A
 * SCANDAL IN BOHEMIA"). A sentence that only starts with "part" or "book" isn't one. */
export function isHeadingLine(line: string): boolean {
  const s = trimDecor(line);
  if (!s || s.length > 120 || !/^[\p{Lu}\d]/u.test(s)) return false;
  const p = parse(s);
  if (p.label) return p.n !== undefined;
  if (p.n === undefined || !p.name) return false;
  const rest = s.replace(/^\S+\s*/, '');
  const letters = rest.replace(/[^\p{L}]/gu, '');
  return letters.length >= 3 && letters === letters.toUpperCase() && rest.split(' ').length <= 12;
}

export type ChapterIn = { title: string; heading?: string; part?: string; words?: number };
// `display` is the chapter list's line (with its part when the book repeats names: "Book 2 ·
// Chapter 1"); `heading` is narrated before the text (its part's too, as a part begins).
export type ChapterOut = Title & { part?: Title; heading: string };
export type Pause = () => Promise<void> | void;

const norm = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
// A title page or Gutenberg header with this many words under it holds the book's opening.
const LONG_OPENING = 1000;

/** A whole book's titles, a chapter a turn. `bookTitle` is the EPUB's dc:title, for its title page. */
export async function normalizeChapters(chapters: ChapterIn[], bookTitle = '', pause: Pause = () => {}): Promise<ChapterOut[]> {
  // Page numbers every title ends in (a PDF outline or a scraped contents page): when most titles
  // end in a number and those numbers never go down, they're page numbers.
  const tails = chapters.map((c) => c.title.trim().match(/\s(\d{1,4})$/)?.[1]).map((d) => (d ? Number(d) : undefined));
  const ended = tails.filter((d) => d !== undefined) as number[];
  const pageNumbers = ended.length >= 3 && ended.length >= chapters.length * 0.6 && ended.every((d, i) => i === 0 || d >= ended[i - 1])
    && ended.some((d, i) => i > 0 && d - ended[i - 1] > 1);
  const parsed: { c: ChapterIn; raw: string; p: Parsed }[] = [];
  for (const c of chapters) {
    let raw = pageNumbers ? c.title.trim().replace(/\s+\d{1,4}$/, '') : c.title;
    let p = parse(raw);
    // The chapter's own heading, when its label says less: the label has no name and the heading
    // names the same number, or the label is empty or is prose (too long, starts in lower case).
    if (c.heading) {
      const h = parse(c.heading);
      const sameNumber = h.n !== undefined && h.n === p.n;
      const labelPoor = !trimDecor(raw) || raw.length > 150 || /^\p{Ll}/u.test(trimDecor(raw));
      if ((sameNumber && !p.name && h.name && !h.caption) || (labelPoor && (h.name || h.n !== undefined))) { p = { ...h, caption: p.caption, weak: undefined }; raw = c.heading; }
    }
    parsed.push({ c, raw, p });
    await pause();
  }
  // Bare and weakly numbered titles keep their numbers only when the book's count up (1, 2, 3 or
  // I, II, III); a lone "1984" or "3 Women" stays a name.
  const weak = parsed.filter((x) => x.p.weak);
  const counts = weak.length >= 2 && weak.every((x, i) => i === 0 || (x.p.n as number) > (weak[i - 1].p.n as number) || x.p.n === 1);
  // The book's title, and its main title before a subtitle ("On the Origin of Species" of "… By
  // Means of Natural Selection / Or, …").
  const books = [norm(bookTitle), norm(bookTitle.split(/\s*[:;/]\s*|\s+by\s+|,\s*or\b/i)[0])].filter(Boolean);
  const out: ChapterOut[] = [];
  for (let i = 0; i < parsed.length; i++) {
    let { p } = parsed[i];
    const { c, raw } = parsed[i];
    if (p.weak && !counts) p = { name: cleanName(trimDecor(raw)) };
    let kind = kindOf(p, raw);
    // The book's own title as a chapter is its title page, as is Gutenberg's header. A long run
    // under one (an editor's preface, a translator's introduction) is the book's opening, not lost.
    const titlePage = i < 3 && books.includes(norm(raw));
    if (titlePage) kind = 'skip';
    if ((titlePage || /project gutenberg e-?book of/i.test(raw)) && i < 3 && (c.words ?? 0) >= LONG_OPENING) { kind = 'front'; p = { name: 'Opening' }; }
    const t = { ...finish(p, kind, raw), raw: c.title };
    out.push({ ...t, heading: t.spoken, ...(c.part ? { part: normalizeTitle(c.part) } : {}) });
    await pause();
  }
  // A book whose numbered chapters repeat ("Chapter 1" in every book of War and Peace) shows each
  // with its part, and a part's name is narrated as the part begins. Two poems named "To You"
  // aren't a reason to.
  const kept = out.filter((t) => t.kind !== 'skip');
  const seen = new Set<string>();
  const repeats = kept.some((t) => !t.name && seen.size === seen.add(t.display).size);
  let lastPart = '';
  for (const t of kept) {
    if (!t.part) { lastPart = ''; continue; }
    const short = t.part.label && t.part.n !== undefined ? `${t.part.label} ${t.part.n}` : t.part.display;
    if (repeats) t.display = `${short} · ${t.display}`;
    if (t.part.raw !== lastPart) t.heading = `${t.part.spoken} ${t.heading}`;
    lastPart = t.part.raw;
  }
  return out;
}
