// An uploaded book to chapters of plain text. EPUB follows its table of contents (the EPUB 3 nav,
// else the EPUB 2 NCX) and falls back to the spine; PDF follows its outline and falls back to
// 10-page parts; TXT splits at "Chapter" headings. Cover, title, copyright, contents, index and
// similar pages are left out; forewords, prefaces, introductions, prologues and epilogues stay.
// Anything without chapters is cut into parts of about PART_WORDS words. Ligatures are read as their
// letters, including PDF ligature glyphs that pdf.js reads as stray letters.
import { MAX_BOOK_BYTES, MAX_TEXT_CHARS } from './limits.ts';
import { strFromU8, unzipSync } from 'fflate';

export type Chapter = { title: string; text: string };
const PART_WORDS = 4000;
// Text before the first table-of-contents entry, and a part's pages before its first chapter, become
// a chapter of their own only from this many words: shorter runs are title pages and epigraphs.
const OPENING_WORDS = 200;

export async function parseBook(name: string, bytes: Uint8Array): Promise<Chapter[]> {
  if (bytes.length > MAX_BOOK_BYTES) throw new Error('Book files must be under 50 MB.');
  const ext = name.toLowerCase().split('.').pop();
  const chapters = ext === 'epub' ? parseEpub(bytes) : ext === 'pdf' ? await parsePdf(bytes) : ext === 'txt' ? parseTxt(new TextDecoder().decode(bytes)) : null;
  if (!chapters) throw new Error('Upload an EPUB, PDF or TXT file.');
  const kept = chapters.map((c) => ({ title: unligate(c.title), text: tidy(unligate(c.text)) })).filter((c) => c.text.split(' ').length >= 20);
  if (kept.length === 0) throw new Error('No readable text was found in this file.');
  if (kept.reduce((n, c) => n + c.text.length + c.title.length, 0) > MAX_TEXT_CHARS) throw new Error(`This book exceeds the ${MAX_TEXT_CHARS.toLocaleString('en-US')}-character narration limit.`);
  return kept;
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
// Typographic ligatures (U+FB00–FB06) as their letters, and the long s as s, so TTS reads words.
const LIGATURES: Record<string, string> = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st', '\u017F': 's' };
const unligate = (s: string) => s.replace(/[\uFB00-\uFB06\u017F]/g, (c) => LIGATURES[c]);
const words = (s: string) => s.match(/\S+/g)?.length ?? 0;
// A title's words, for comparing titles and headings regardless of case, spacing and punctuation.
const norm = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parts(text: string, label = 'Part'): Chapter[] {
  const words = tidy(text).split(' ');
  const out: Chapter[] = [];
  for (let i = 0; i < words.length; i += PART_WORDS) out.push({ title: `${label} ${out.length + 1}`, text: words.slice(i, i + PART_WORDS).join(' ') });
  return out;
}

function parseTxt(text: string): Chapter[] {
  const heading = /^[ \t]*((?:chapter|book|part)\b[^\n]{0,80})$/gim;
  const marks = [...text.matchAll(heading)];
  if (marks.length < 2) return parts(text);
  const out: Chapter[] = [];
  const front = text.slice(0, marks[0].index);
  if (tidy(front).split(' ').length > 200) out.push({ title: 'Opening', text: front });
  marks.forEach((m, i) => out.push({ title: tidy(m[1]), text: text.slice(m.index! + m[0].length, marks[i + 1]?.index ?? text.length) }));
  return out;
}

// Front and back matter isn't narrated. EPUB marks it by structural type (epub:type or a doc- role
// on the page, its landmarks, the EPUB 2 guide); any book by title, and a copyright page by its
// rights line or ISBN.
const MATTER_TYPES = new Set(['cover', 'titlepage', 'title-page', 'halftitlepage', 'copyright-page', 'copyright', 'toc', 'landmarks', 'page-list', 'loi', 'lot', 'lov', 'loa', 'index', 'acknowledgments', 'acknowledgements', 'colophon', 'imprint', 'imprimatur', 'errata', 'bibliography', 'endnotes', 'rearnotes', 'footnotes', 'notes']);
const MATTER_TITLE = /^(?:(?:front )?cover|title(?: page)?|half[- ]?title(?: page)?|copyright(?: page| notice)?|(?:table of )?contents|index|acknowledge?ments?|colophon|imprint|list of (?:illustrations|figures|tables|maps)|bibliography|references|works cited|(?:end)?notes|(?:also|more|(?:other |more )?(?:books|titles|works)) by\b.*|praise for\b.*|about the publisher)$/i;
const isMatterTitle = (title: string) => MATTER_TITLE.test(tidy(title).replace(/[\s.:]+$/, ''));
const isMatterType = (types: string[]) => types.some((t) => MATTER_TYPES.has(t));
const isLegal = (text: string) => words(text) < 400 && /all rights reserved|\bISBN(?:-1[03])?:?\s*[\dX]/i.test(text);

// A table of contents entry: where it points, if anywhere, and the entries under it.
type Entry<At> = { title: string; at?: At; children: Entry<At>[]; part?: boolean };
const PART = /^(?:part|book|volume|vol\.)\s*(?:[ivxlcdm]+\b|\d|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b)/i;

const GROUP = /^(?:(?:front|back|end) ?matter|(?:table of )?contents)$/i;

// The level of a table of contents that holds the chapters: the top level, with parts ("Part One"),
// front and back matter groups, unlinked headings and a lone entry wrapping the whole book replaced
// by the entries under them. A lifted part keeps its own start, for its pages before its first chapter.
function chapterLevel<At>(entries: Entry<At>[]): Entry<At>[] {
  for (let round = 0; round < 3; round++) {
    const content = entries.filter((e) => !e.part && !isMatterTitle(e.title));
    const lift = (e: Entry<At>) => e.children.length > 0 && (e.at === undefined || PART.test(e.title) || GROUP.test(e.title) || (content.length === 1 && content[0] === e));
    if (!entries.some(lift)) break;
    entries = entries.flatMap((e) => (lift(e) ? [...(e.at === undefined ? [] : [{ ...e, children: [], part: true }]), ...e.children] : [e]));
  }
  return entries;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? all);
const htmlText = (html: string) => decode(html
  .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<\/(p|div|h\d|li|br)>|<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' '));
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? '';
const unescape = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

// A small XML/XHTML tree, enough to read a nav document or an NCX: element names lose their prefix
// and are lowercased, text is decoded.
type Node = { name: string; attrs: string; kids: (Node | string)[] };
const VOID = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'col', 'area', 'base', 'wbr', 'source']);
function tree(xml: string): Node {
  const root: Node = { name: '', attrs: '', kids: [] }, stack = [root];
  for (const m of xml.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+/g)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.kids.push(m[1]);
    else if (m[3] === undefined) { if (m[0][0] !== '<') top.kids.push(decode(m[0])); }
    else {
      const name = m[3].replace(/^.*:/, '').toLowerCase();
      if (m[2]) { const i = stack.findLastIndex((n) => n.name === name); if (i > 0) stack.length = i; continue; }
      const node: Node = { name, attrs: m[4], kids: [] };
      top.kids.push(node);
      if (!m[4].endsWith('/') && !VOID.has(name)) stack.push(node);
    }
  }
  return root;
}
const children = (n: Node, name: string) => n.kids.filter((k): k is Node => typeof k !== 'string' && k.name === name);
const descendants = (n: Node, name: string): Node[] => n.kids.flatMap((k) => (typeof k === 'string' ? [] : k.name === name ? [k] : descendants(k, name)));
const textOf = (n: Node | string): string => (typeof n === 'string' ? n : n.kids.map(textOf).join(''));

// The zip path an href in the file at `from` points to, with its fragment; null for links out of the book.
type Target = { file: string; frag: string };
function resolve(from: string, href: string): Target | null {
  const [path, ...frag] = decode(href).trim().split('#');
  if (/^[a-z][\w+.-]*:/i.test(path)) return null;
  if (!path) return { file: from, frag: unescape(frag.join('#')) };
  const out: string[] = [];
  for (const seg of ((path.startsWith('/') ? '' : from.slice(0, from.lastIndexOf('/') + 1)) + path).split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return { file: unescape(out.join('/')), frag: unescape(frag.join('#')) };
}

// EPUB 3: the `toc` nav's nested lists, and the landmarks nav.
function navOf(xml: string, from: string): { toc: Entry<Target>[]; landmarks: { types: string; target: Target | null }[] } {
  const navs = descendants(tree(xml), 'nav');
  const is = (n: Node, type: string) => attr(n.attrs, 'epub:type').toLowerCase().split(/\s+/).includes(type) || attr(n.attrs, 'role') === `doc-${type}`;
  const list = (ol: Node): Entry<Target>[] => children(ol, 'li').map((li) => {
    const label = li.kids.find((k): k is Node => typeof k !== 'string' && (k.name === 'a' || k.name === 'span'));
    const sub = children(li, 'ol')[0];
    return { title: tidy(label ? textOf(label) : ''), at: (label?.name === 'a' && resolve(from, attr(label.attrs, 'href'))) || undefined, children: sub ? list(sub) : [] };
  });
  const toc = navs.find((n) => is(n, 'toc')), marks = navs.find((n) => is(n, 'landmarks'));
  const ol = toc && descendants(toc, 'ol')[0];
  return {
    toc: ol ? list(ol) : [],
    landmarks: marks ? descendants(marks, 'a').map((a) => ({ types: attr(a.attrs, 'epub:type'), target: resolve(from, attr(a.attrs, 'href')) })) : [],
  };
}

// EPUB 2: the NCX's nested navPoints.
function ncxOf(xml: string, from: string): Entry<Target>[] {
  const points = (n: Node): Entry<Target>[] => children(n, 'navpoint').map((p) => {
    const src = attr(children(p, 'content')[0]?.attrs ?? '', 'src');
    return { title: tidy(textOf(descendants(children(p, 'navlabel')[0] ?? { name: '', attrs: '', kids: [] }, 'text')[0] ?? '')), at: (src && resolve(from, src)) || undefined, children: points(p) };
  });
  const map = descendants(tree(xml), 'navmap')[0];
  return map ? points(map) : [];
}

// A spine file, with where its body starts and ends.
type Doc = { file: string; html: string; start: number; end: number; linear: boolean };
// A place in the book: a spine index and a character offset into that file.
type Spot = { k: number; at: number };
// Markup and blank space read as nothing, so places can be compared by the text around them.
const blank = (s: string) => s.replace(/<[^>]*>|&nbsp;|&#160;|&#xa0;/gi, (m) => ' '.repeat(m.length));

// Moves a place back over markup and blank space to just after the text before it, so an anchor, the
// heading or section it sits in and (with no text before them) the start of the file are one place.
function settle(doc: Doc, at: number): number {
  const lo = Math.max(doc.start, at - 4000), kept = blank(doc.html.slice(lo, at)).trimEnd().length;
  return kept === 0 && lo > doc.start ? at : lo + kept;
}

// The structural types (epub:type, or an ARIA doc- role) of the elements opening at a place, before any text.
function typesAt(doc: Doc, at: number): string[] {
  const after = doc.html.slice(at, at + 4000), text = blank(after).search(/\S/);
  return [...after.slice(0, text < 0 ? after.length : text).matchAll(/\s(?:epub:type|role)\s*=\s*["']([^"']*)["']/gi)]
    .flatMap((m) => m[1].toLowerCase().split(/\s+/)).map((t) => t.replace(/^doc-/, ''));
}

// Drops the headings that open a chapter when its title already says them, since the title is narrated.
function unheaded(html: string, title: string): string {
  const said = new Set(norm(title));
  for (let n = 0; n < 4; n++) {
    const m = html.match(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/i);
    if (!m || tidy(htmlText(html.slice(0, m.index))) !== '') break;
    const heading = norm(htmlText(m[2]));
    if (!heading.length || !heading.every((w) => said.has(w))) break;
    html = html.slice(m.index! + m[0].length);
  }
  return html;
}
const headingOf = (html: string) => tidy(htmlText(html.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ?? ''));

function parseEpub(bytes: Uint8Array): Chapter[] {
  let expanded = 0;
  const files = unzipSync(bytes, { filter(file) {
    // Images/fonts aren't needed for narration. Bound expansion before allocating entries.
    if (!/\.(xml|opf|xhtml|html|htm|ncx)$/i.test(file.name)) return false;
    expanded += file.originalSize;
    if (expanded > 50 * 1024 * 1024 || file.originalSize > 8 * 1024 * 1024) throw new Error('The EPUB expands beyond the text extraction limit.');
    return true;
  } });
  const names = new Map(Object.keys(files).map((p) => [p.toLowerCase(), p]));
  const real = (path: string) => (files[path] ? path : names.get(path.toLowerCase()) ?? path);
  const read = (path: string) => (files[real(path)] ? strFromU8(files[real(path)]) : '');
  const opfPath = attr(read('META-INF/container.xml').match(/<rootfile\b[^>]*>/i)?.[0] ?? '', 'full-path');
  const opf = read(opfPath);
  if (!opf) throw new Error('This EPUB has no package file.');
  const items = new Map<string, { file: string; type: string; props: string }>();
  for (const tag of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const target = resolve(opfPath, attr(tag, 'href'));
    if (target) items.set(attr(tag, 'id'), { file: real(target.file), type: attr(tag, 'media-type'), props: attr(tag, 'properties') });
  }
  const docs: Doc[] = (opf.match(/<itemref\b[^>]*>/gi) ?? []).flatMap((tag) => {
    const item = items.get(attr(tag, 'idref'));
    if (!item) return [];
    const html = read(item.file);
    const body = html.search(/<body\b/i), head = html.search(/<\/head\s*>/i), close = html.search(/<\/body\s*>/i);
    return [{ file: item.file, html, start: body >= 0 ? body : head >= 0 ? html.indexOf('>', head) + 1 : 0, end: close >= 0 ? close : html.length, linear: attr(tag, 'linear').toLowerCase() !== 'no' }];
  });
  const spineIndex = new Map<string, number>();
  docs.forEach((d, k) => { if (!spineIndex.has(d.file)) spineIndex.set(d.file, k); });

  // Each spine file's ids (and old-style anchor names), indexed on first use.
  const ids = new Map<number, Map<string, number>>();
  const idsOf = (k: number) => {
    let found = ids.get(k);
    if (!found) {
      ids.set(k, found = new Map());
      for (const tag of docs[k].html.matchAll(/<[^>]+>/g)) {
        for (const id of tag[0].matchAll(/\s(?:id|name)\s*=\s*["']([^"']*)["']/g)) if (!found.has(id[1])) found.set(id[1], tag.index!);
      }
    }
    return found;
  };
  const spot = (target: Target | null | undefined): Spot | undefined => {
    const k = target ? spineIndex.get(real(target.file)) : undefined;
    if (k === undefined) return;
    const doc = docs[k], at = target!.frag ? idsOf(k).get(target!.frag) ?? doc.start : doc.start;
    return { k, at: settle(doc, Math.max(doc.start, at)) };
  };
  const key = (s: Spot) => `${s.k}:${s.at}`;

  const manifest = [...items.values()];
  const navItem = manifest.find((i) => i.props.split(/\s+/).includes('nav'));
  const ncxItem = items.get(attr(opf.match(/<spine\b[^>]*>/i)?.[0] ?? '', 'toc')) ?? manifest.find((i) => i.type === 'application/x-dtbncx+xml');
  const nav = navItem ? navOf(read(navItem.file), navItem.file) : { toc: [], landmarks: [] };
  const toc = nav.toc.length ? nav.toc : ncxItem ? ncxOf(read(ncxItem.file), ncxItem.file) : [];
  const guide = (opf.match(/<reference\b[^>]*>/gi) ?? []).map((tag) => ({ types: attr(tag, 'type'), target: resolve(opfPath, attr(tag, 'href')) }));
  const marked = new Set([...nav.landmarks, ...guide].filter((l) => isMatterType(l.types.toLowerCase().split(/\s+/))).flatMap((l) => {
    const s = spot(l.target);
    return s ? [key(s)] : [];
  }));
  const matterAt = (s: Spot) => marked.has(key(s)) || isMatterType(typesAt(docs[s.k], s.at));
  const bookTitle = norm(htmlText(opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ?? '')).join(' ');

  // A run of a spine file outside the table of contents, titled by its first heading; null when it's
  // front or back matter.
  const loose = (k: number, from: number, to: number, fallback: string): Chapter | null => {
    const html = docs[k].html.slice(from, to);
    const heading = html.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const title = heading ? tidy(htmlText(heading[1])) : '';
    const text = tidy(htmlText(heading ? html.replace(heading[0], ' ') : html));
    return matterAt({ k, at: from }) || isMatterTitle(title) || isLegal(text) ? null : { title: title || fallback, text };
  };

  const bySpine = () => {
    const out: Chapter[] = [];
    docs.forEach((d, k) => {
      const c = d.linear ? loose(k, d.start, d.end, `Section ${out.length + 1}`) : null;
      if (c) out.push(c);
    });
    return out;
  };

  const byToc = (): Chapter[] | null => {
    const place = (entries: Entry<Target>[]): Entry<Spot>[] => entries
      .map((e) => ({ title: e.title, at: spot(e.at), children: place(e.children) }))
      .filter((e) => e.at || e.children.length);
    const list = chapterLevel(place(toc)).filter((e): e is Entry<Spot> & { at: Spot } => !!e.at)
      .sort((a, b) => a.at.k - b.at.k || a.at.at - b.at.at);
    if (new Set(list.map((e) => key(e.at))).size < 2) return null;
    const out: Chapter[] = [];
    // Spine files before the first entry: an untitled prologue stays, title pages and the like don't.
    const first = list[0].at;
    for (let k = 0; k <= first.k; k++) {
      const d = docs[k], to = k === first.k ? first.at : d.end;
      const c = d.linear && to > d.start ? loose(k, d.start, to, 'Opening') : null;
      if (c && words(c.text) >= OPENING_WORDS) out.push(c);
    }
    let listed = 0;
    list.forEach((e, i) => {
      const end = list[i + 1]?.at ?? { k: docs.length - 1, at: docs[docs.length - 1].end };
      let html = '';
      // Files between two entries continue the first one's chapter, unless they're front or back matter.
      const follow: Chapter[] = [];
      for (let k = e.at.k; k <= end.k; k++) {
        const d = docs[k], from = k === e.at.k ? e.at.at : d.start, to = k === end.k ? end.at : d.end;
        const alone = k > e.at.k && to > from && d.linear ? loose(k, from, to, '') : null;
        if (alone) follow.push(alone);
        if (to > from && (k === e.at.k || alone)) html += d.html.slice(from, to) + '\n';
      }
      const title = e.title || headingOf(html) || `Section ${out.length + 1}`;
      const text = tidy(htmlText(unheaded(html, title)));
      // A first entry named after the book is its title page.
      const titlePage = listed === 0 && !e.part && !!bookTitle && norm(title).join(' ') === bookTitle && words(text) < 300;
      if (isMatterTitle(title) || matterAt(e.at) || isLegal(text) || titlePage) {
        // Before the first chapter, unlisted files after a skipped page are read like the ones before
        // the first entry (an untitled prologue stays); after it, they're the rest of the back matter.
        if (listed === 0) for (const c of follow) if (words(c.text) >= OPENING_WORDS) out.push({ title: c.title || 'Opening', text: c.text });
        return;
      }
      if (e.part && words(text) < OPENING_WORDS) return;
      out.push({ title, text });
      listed++;
    });
    return out;
  };

  const chapters = byToc();
  if (chapters && chapters.length >= 2) return chapters;
  const spine = bySpine();
  return chapters && chapters.length >= spine.length ? chapters : spine;
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

// TTS endpoints take a bounded input: split at sentence ends under `max` characters.
export function chunks(text: string, max = 3000): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]+["'’”)]*\s*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > max) { out.push(cur.trim()); cur = ''; }
    if (s.length > max) { for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max)); continue; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
