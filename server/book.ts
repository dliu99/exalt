// An EPUB or TXT book to chapters of plain text, and what an EPUB says of itself (title, author,
// cover). The app reads a picked EPUB or TXT with this module itself (app.ts previewImport), and the
// server's parse.ts uses it for these and adds PDF. The server opens a zip with fflate (fflateZip);
// the app reads its central directory and inflates only the entries it reads with the host's native
// DecompressionStream (nativeZip), ending its turn (`pause`) between files and chapters, since the
// app's data module runs on an interpreter with a budget per turn. Both read the same chapters. EPUB follows its table
// of contents (the EPUB 3 nav, else the EPUB 2 NCX) and falls back to the spine; TXT splits at
// "Chapter" headings. Cover, title, copyright, contents, index and similar pages are left out;
// forewords, prefaces, introductions, prologues and epilogues stay. Anything without chapters is cut
// into parts of about PART_WORDS words. Ligatures are read as their letters.
import { strFromU8, unzipSync } from 'fflate';

export type Chapter = { title: string; text: string };
const PART_WORDS = 4000;
// Text before the first table-of-contents entry, and a part's pages before its first chapter, become
// a chapter of their own only from this many words: shorter runs are title pages and epigraphs.
export const OPENING_WORDS = 200;
// The narration limit's default; the server's is limits.ts MAX_TEXT_CHARS (MAX_BOOK_CHARACTERS).
export const DEFAULT_MAX_CHARS = 5000000;

// Where a long read may end its turn: the app's `() => scheduler.yield()`; the server's, nothing.
export type Pause = () => Promise<void> | void;
const noPause: Pause = () => {};

// A zip's entries (name, size once inflated), and one entry's bytes read on asking.
export type ZipEntry = { name: string; size: number };
export type Zip = { entries: ZipEntry[]; read(path: string): Promise<Uint8Array | undefined> };
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

/** A zip opened with fflate (the server's): its directory at once, each entry inflated on asking. */
export function fflateZip(bytes: Uint8Array): Zip {
  const entries: ZipEntry[] = [];
  unzipSync(bytes, { filter(f) { entries.push({ name: f.name, size: f.originalSize }); return false; } });
  const kept = new Map<string, Uint8Array | undefined>();
  return { entries, async read(path) {
    if (!kept.has(path)) kept.set(path, entries.some((e) => e.name === path) ? unzipSync(bytes, { filter: (f) => f.name === path })[path] : undefined);
    return kept.get(path);
  } };
}

/** A zip opened by its central directory (the app's): an entry is inflated by the host's native
 * DecompressionStream when it is read, so nothing it isn't asked for (images) is inflated. */
export function nativeZip(bytes: Uint8Array): Zip {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = () => new Error('This EPUB could not be read.');
  // The end of central directory record: its signature, within the last 64 KiB and 22 bytes.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw bad();
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw bad();
  const latin1 = (b: Uint8Array) => { let out = ''; for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]); return out; };
  const found = new Map<string, { method: number; packed: number; size: number; local: number }>();
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw bad();
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true), extraLen = view.getUint16(at + 30, true), commentLen = view.getUint16(at + 32, true);
    const raw = bytes.subarray(at + 46, at + 46 + nameLen);
    // As fflate names it: UTF-8 when the entry says so, else Latin-1.
    const name = flags & 0x800 ? utf8(raw) : latin1(raw);
    if (!found.has(name)) found.set(name, { method, packed, size, local: view.getUint32(at + 42, true) });
    entries.push({ name, size });
    at += 46 + nameLen + extraLen + commentLen;
  }
  const kept = new Map<string, Promise<Uint8Array | undefined>>();
  const inflate = async (path: string): Promise<Uint8Array | undefined> => {
    const e = found.get(path);
    if (!e) return undefined;
    if (view.getUint32(e.local, true) !== 0x04034b50) throw bad();
    const from = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
    const data = bytes.subarray(from, from + e.packed);
    if (e.method === 0) return data.slice();
    if (e.method !== 8) throw bad();
    const stream = new DecompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    // The read is pending before the write: a write waits for one.
    const out = new Response(stream.readable).arrayBuffer();
    // A view on the picked file's own ArrayBuffer (never a shared one).
    await writer.write(data as Uint8Array<ArrayBuffer>);
    await writer.close();
    return new Uint8Array(await out);
  };
  return { entries, read(path) {
    if (!kept.has(path)) kept.set(path, inflate(path));
    return kept.get(path)!;
  } };
}

/** An EPUB's or TXT's chapters as raw text, or null for any other kind of file. */
export async function readChapters(name: string, bytes: Uint8Array, pause: Pause = noPause, open: (b: Uint8Array) => Zip = fflateZip): Promise<Chapter[] | null> {
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'epub' ? parseEpub(open(bytes), pause) : ext === 'txt' ? parseTxt(utf8(bytes), pause) : null;
}

/** The chapters to narrate: ligatures read, space tidied, ones with too few words left out, the book within the limit. */
export async function keptChapters(chapters: Chapter[], maxChars = DEFAULT_MAX_CHARS, pause: Pause = noPause): Promise<Chapter[]> {
  const kept: Chapter[] = [];
  for (const c of chapters) {
    const k = { title: unligate(c.title), text: tidy(unligate(c.text)) };
    if (k.text.split(' ').length >= 20) kept.push(k);
    await pause();
  }
  if (kept.length === 0) throw new Error('No readable text was found in this file.');
  if (kept.reduce((n, c) => n + c.text.length + c.title.length, 0) > maxChars) throw new Error(`This book exceeds the ${maxChars.toLocaleString('en-US')}-character narration limit.`);
  return kept;
}

/** An EPUB or TXT read as the server reads it: its chapters to narrate (or why not), and what it
 * says of itself. The app's: the zip opened natively, a turn ended between files and chapters. */
export async function readBook(name: string, bytes: Uint8Array, pause: Pause = noPause, open: (b: Uint8Array) => Zip = nativeZip): Promise<{ chapters: Chapter[]; meta: BookMeta }> {
  const ext = name.toLowerCase().split('.').pop();
  if (ext !== 'epub' && ext !== 'txt') throw new Error('Upload an EPUB, PDF or TXT file.');
  const zip = ext === 'epub' ? open(bytes) : null;
  const raw = zip ? await parseEpub(zip, pause) : await parseTxt(utf8(bytes), pause);
  const chapters = await keptChapters(raw, DEFAULT_MAX_CHARS, pause);
  return { chapters, meta: zip ? await zipMeta(zip) : { title: '', author: '', cover: null } };
}

export const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
// Typographic ligatures (U+FB00–FB06) as their letters, and the long s as s, so TTS reads words.
const LIGATURES: Record<string, string> = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st', '\u017F': 's' };
export const unligate = (s: string) => s.replace(/[\uFB00-\uFB06\u017F]/g, (c) => LIGATURES[c]);
export const words = (s: string) => s.match(/\S+/g)?.length ?? 0;
// A title's words, for comparing titles and headings regardless of case, spacing and punctuation.
export const norm = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parts(text: string, label = 'Part'): Chapter[] {
  const words = tidy(text).split(' ');
  const out: Chapter[] = [];
  for (let i = 0; i < words.length; i += PART_WORDS) out.push({ title: `${label} ${out.length + 1}`, text: words.slice(i, i + PART_WORDS).join(' ') });
  return out;
}

// Headings are found 64 KiB of lines at a time, a turn each: a piece ends just after a newline, so
// every line is whole in one piece and its matches are those of the whole text.
async function parseTxt(text: string, pause: Pause): Promise<Chapter[]> {
  const heading = /^[ \t]*((?:chapter|book|part)\b[^\n]{0,80})$/gim;
  const marks: { index: number; length: number; title: string }[] = [];
  for (let from = 0; from < text.length;) {
    const nl = text.indexOf('\n', from + 65536), to = nl < 0 ? text.length : nl + 1;
    for (const m of text.slice(from, to).matchAll(heading)) marks.push({ index: from + m.index!, length: m[0].length, title: m[1] });
    from = to;
    await pause();
  }
  if (marks.length < 2) return parts(text);
  const out: Chapter[] = [];
  const front = text.slice(0, marks[0].index);
  if (tidy(front).split(' ').length > 200) out.push({ title: 'Opening', text: front });
  marks.forEach((m, i) => out.push({ title: tidy(m.title), text: text.slice(m.index + m.length, marks[i + 1]?.index ?? text.length) }));
  return out;
}

// Front and back matter isn't narrated. EPUB marks it by structural type (epub:type or a doc- role
// on the page, its landmarks, the EPUB 2 guide); any book by title, and a copyright page by its
// rights line or ISBN.
const MATTER_TYPES = new Set(['cover', 'titlepage', 'title-page', 'halftitlepage', 'copyright-page', 'copyright', 'toc', 'landmarks', 'page-list', 'loi', 'lot', 'lov', 'loa', 'index', 'acknowledgments', 'acknowledgements', 'colophon', 'imprint', 'imprimatur', 'errata', 'bibliography', 'endnotes', 'rearnotes', 'footnotes', 'notes']);
const MATTER_TITLE = /^(?:(?:front )?cover|title(?: page)?|half[- ]?title(?: page)?|copyright(?: page| notice)?|(?:table of )?contents|index|acknowledge?ments?|colophon|imprint|list of (?:illustrations|figures|tables|maps)|bibliography|references|works cited|(?:end)?notes|(?:also|more|(?:other |more )?(?:books|titles|works)) by\b.*|praise for\b.*|about the publisher)$/i;
export const isMatterTitle = (title: string) => MATTER_TITLE.test(tidy(title).replace(/[\s.:]+$/, ''));
const isMatterType = (types: string[]) => types.some((t) => MATTER_TYPES.has(t));
export const isLegal = (text: string) => words(text) < 400 && /all rights reserved|\bISBN(?:-1[03])?:?\s*[\dX]/i.test(text);

// A table of contents entry: where it points, if anywhere, and the entries under it.
export type Entry<At> = { title: string; at?: At; children: Entry<At>[]; part?: boolean };
const PART = /^(?:part|book|volume|vol\.)\s*(?:[ivxlcdm]+\b|\d|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b)/i;

const GROUP = /^(?:(?:front|back|end) ?matter|(?:table of )?contents)$/i;

// The level of a table of contents that holds the chapters: the top level, with parts ("Part One"),
// front and back matter groups, unlinked headings and a lone entry wrapping the whole book replaced
// by the entries under them. A lifted part keeps its own start, for its pages before its first chapter.
export function chapterLevel<At>(entries: Entry<At>[]): Entry<At>[] {
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

async function parseEpub(zip: Zip, pause: Pause): Promise<Chapter[]> {
  // Images/fonts aren't needed for narration. Bound expansion before reading entries.
  let expanded = 0;
  const text = zip.entries.filter((e) => /\.(xml|opf|xhtml|html|htm|ncx)$/i.test(e.name));
  for (const e of text) {
    expanded += e.size;
    if (expanded > 50 * 1024 * 1024 || e.size > 8 * 1024 * 1024) throw new Error('The EPUB expands beyond the text extraction limit.');
  }
  const files = new Set(text.map((e) => e.name));
  const names = new Map(text.map((e) => [e.name.toLowerCase(), e.name]));
  const real = (path: string) => (files.has(path) ? path : names.get(path.toLowerCase()) ?? path);
  const read = async (path: string) => { const b = files.has(real(path)) ? await zip.read(real(path)) : undefined; return b ? utf8(b) : ''; };
  const opfPath = attr((await read('META-INF/container.xml')).match(/<rootfile\b[^>]*>/i)?.[0] ?? '', 'full-path');
  const opf = await read(opfPath);
  if (!opf) throw new Error('This EPUB has no package file.');
  const items = new Map<string, { file: string; type: string; props: string }>();
  for (const tag of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const target = resolve(opfPath, attr(tag, 'href'));
    if (target) items.set(attr(tag, 'id'), { file: real(target.file), type: attr(tag, 'media-type'), props: attr(tag, 'properties') });
  }
  const docs: Doc[] = [];
  for (const tag of opf.match(/<itemref\b[^>]*>/gi) ?? []) {
    const item = items.get(attr(tag, 'idref'));
    if (!item) continue;
    const html = await read(item.file);
    const body = html.search(/<body\b/i), head = html.search(/<\/head\s*>/i), close = html.search(/<\/body\s*>/i);
    docs.push({ file: item.file, html, start: body >= 0 ? body : head >= 0 ? html.indexOf('>', head) + 1 : 0, end: close >= 0 ? close : html.length, linear: attr(tag, 'linear').toLowerCase() !== 'no' });
    await pause();
  }
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
  const nav = navItem ? navOf(await read(navItem.file), navItem.file) : { toc: [], landmarks: [] };
  await pause();
  const toc = nav.toc.length ? nav.toc : ncxItem ? ncxOf(await read(ncxItem.file), ncxItem.file) : [];
  await pause();
  const guide = (opf.match(/<reference\b[^>]*>/gi) ?? []).map((tag) => ({ types: attr(tag, 'type'), target: resolve(opfPath, attr(tag, 'href')) }));
  // The ids of every file an entry points into, a file a turn (spot reads them).
  const targets = (es: Entry<Target>[]): (Target | null)[] => es.flatMap((e) => [e.at ?? null, ...targets(e.children)]);
  for (const t of [...targets(toc), ...nav.landmarks.map((l) => l.target), ...guide.map((g) => g.target)]) {
    const k = t?.frag ? spineIndex.get(real(t.file)) : undefined;
    if (k !== undefined && !ids.has(k)) { idsOf(k); await pause(); }
  }
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

  const bySpine = async () => {
    const out: Chapter[] = [];
    for (let k = 0; k < docs.length; k++) {
      const d = docs[k];
      const c = d.linear ? loose(k, d.start, d.end, `Section ${out.length + 1}`) : null;
      if (c) out.push(c);
      await pause();
    }
    return out;
  };

  const byToc = async (): Promise<Chapter[] | null> => {
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
      await pause();
    }
    let listed = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      await pause();
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
        continue;
      }
      if (e.part && words(text) < OPENING_WORDS) continue;
      out.push({ title, text });
      listed++;
    }
    return out;
  };

  const chapters = await byToc();
  if (chapters && chapters.length >= 2) return chapters;
  const spine = await bySpine();
  return chapters && chapters.length >= spine.length ? chapters : spine;
}

// What an import says of itself: an EPUB's title, first author and cover image. A cover is read
// in its own bounded pass (parseEpub skips images) and kept only when its bytes are a JPEG, PNG,
// WebP or GIF.
export type BookMeta = { title: string; author: string; cover: { bytes: Uint8Array; ext: 'jpg' | 'png' | 'webp' | 'gif' } | null };
const MAX_COVER_BYTES = 5 * 1024 * 1024;

// The OPF's title, first author, and the path of its cover image: the manifest item marked
// cover-image, else the one an EPUB 2 <meta name="cover"> names, else an image named for a cover.
function opfMeta(opf: string, opfPath: string): { title: string; author: string; cover: string } {
  const text = (tag: string) => tidy(htmlText(opf.match(new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)</dc:${tag}>`, 'i'))?.[1] ?? '')).slice(0, 200);
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const items = (opf.match(/<item\b[^>]*>/gi) ?? []).map((tag) => ({ id: attr(tag, 'id'), href: attr(tag, 'href'), type: attr(tag, 'media-type'), props: attr(tag, 'properties') }));
  const metaCover = (opf.match(/<meta\b[^>]*>/gi) ?? []).find((tag) => attr(tag, 'name') === 'cover');
  const item = items.find((i) => i.props.split(/\s+/).includes('cover-image'))
    ?? (metaCover ? items.find((i) => i.id === attr(metaCover, 'content')) : undefined)
    ?? items.find((i) => (i.type.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(i.href)) && /cover/i.test(i.id + i.href));
  return { title: text('title'), author: text('creator'), cover: item?.href ? base + decodeURIComponent(item.href.split('#')[0]) : '' };
}
const coverOf = (found: Uint8Array | undefined): BookMeta['cover'] => {
  const ext = found && found.length <= MAX_COVER_BYTES ? imageType(found) : null;
  return found && ext ? { bytes: found, ext } : null;
};

export function bookMeta(name: string, bytes: Uint8Array): BookMeta {
  const none = { title: '', author: '', cover: null };
  if (name.toLowerCase().split('.').pop() !== 'epub') return none;
  try {
    const files = unzipSync(bytes, { filter: (f) => /\.(xml|opf)$/i.test(f.name) && f.originalSize <= 8 * 1024 * 1024 });
    const read = (path: string) => (files[path] ? strFromU8(files[path]) : '');
    const opfPath = attr(read('META-INF/container.xml').match(/<rootfile\b[^>]*>/i)?.[0] ?? '', 'full-path');
    const opf = read(opfPath);
    if (!opf) return none;
    const m = opfMeta(opf, opfPath);
    const cover = m.cover ? coverOf(unzipSync(bytes, { filter: (f) => f.name === m.cover && f.originalSize <= MAX_COVER_BYTES })[m.cover]) : null;
    return { title: m.title, author: m.author, cover };
  } catch { return none; }
}

/** bookMeta from an opened zip: the app's, whose entries are read as they're asked for. */
export async function zipMeta(zip: Zip): Promise<BookMeta> {
  const none = { title: '', author: '', cover: null };
  try {
    const sized = (path: string, max: number) => zip.entries.some((e) => e.name === path && e.size <= max);
    const read = async (path: string) => {
      const b = /\.(xml|opf)$/i.test(path) && sized(path, 8 * 1024 * 1024) ? await zip.read(path) : undefined;
      return b ? utf8(b) : '';
    };
    const opfPath = attr((await read('META-INF/container.xml')).match(/<rootfile\b[^>]*>/i)?.[0] ?? '', 'full-path');
    const opf = await read(opfPath);
    if (!opf) return none;
    const m = opfMeta(opf, opfPath);
    const cover = m.cover && sized(m.cover, MAX_COVER_BYTES) ? coverOf(await zip.read(m.cover)) : null;
    return { title: m.title, author: m.author, cover };
  } catch { return none; }
}

function imageType(b: Uint8Array): 'jpg' | 'png' | 'webp' | 'gif' | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}
