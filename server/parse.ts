// An uploaded book to chapters of plain text: EPUB by its spine, PDF by pages, TXT by its
// "Chapter" headings. Anything without chapters is cut into parts of about PART_WORDS words.
import { MAX_BOOK_BYTES, MAX_TEXT_CHARS } from './limits.ts';
import { strFromU8, unzipSync } from 'fflate';

export type Chapter = { title: string; text: string };
const PART_WORDS = 4000;

export async function parseBook(name: string, bytes: Uint8Array): Promise<Chapter[]> {
  if (bytes.length > MAX_BOOK_BYTES) throw new Error('Book files must be under 50 MB.');
  const ext = name.toLowerCase().split('.').pop();
  const chapters = ext === 'epub' ? parseEpub(bytes) : ext === 'pdf' ? await parsePdf(bytes) : ext === 'txt' ? parseTxt(new TextDecoder().decode(bytes)) : null;
  if (!chapters) throw new Error('Upload an EPUB, PDF or TXT file.');
  const kept = chapters.map((c) => ({ title: c.title, text: tidy(c.text) })).filter((c) => c.text.split(' ').length >= 20);
  if (kept.length === 0) throw new Error('No readable text was found in this file.');
  if (kept.reduce((n, c) => n + c.text.length + c.title.length, 0) > MAX_TEXT_CHARS) throw new Error(`This book exceeds the ${MAX_TEXT_CHARS.toLocaleString('en-US')}-character narration limit.`);
  return kept;
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? all);
const htmlText = (html: string) => decode(html
  .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<\/(p|div|h\d|li|br)>|<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' '));
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? '';

function parseEpub(bytes: Uint8Array): Chapter[] {
  let expanded = 0;
  const files = unzipSync(bytes, { filter(file) {
    // Images/fonts aren't needed for narration. Bound expansion before allocating entries.
    if (!/\.(xml|opf|xhtml|html|htm|ncx)$/i.test(file.name)) return false;
    expanded += file.originalSize;
    if (expanded > 50 * 1024 * 1024 || file.originalSize > 8 * 1024 * 1024) throw new Error('The EPUB expands beyond the text extraction limit.');
    return true;
  } });
  const read = (path: string) => (files[path] ? strFromU8(files[path]) : '');
  const opfPath = attr(read('META-INF/container.xml').match(/<rootfile\b[^>]*>/i)?.[0] ?? '', 'full-path');
  const opf = read(opfPath);
  if (!opf) throw new Error('This EPUB has no package file.');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = new Map<string, string>();
  for (const tag of opf.match(/<item\b[^>]*>/gi) ?? []) manifest.set(attr(tag, 'id'), attr(tag, 'href'));
  const spine = (opf.match(/<itemref\b[^>]*>/gi) ?? []).map((tag) => manifest.get(attr(tag, 'idref'))).filter((h): h is string => !!h);
  return spine.map((href, i) => {
    const html = read(base + decodeURIComponent(href.split('#')[0]));
    const heading = html.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1];
    return { title: heading ? tidy(htmlText(heading)) || `Section ${i + 1}` : `Section ${i + 1}`, text: htmlText(html.replace(/<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]>/i, '')) };
  });
}

// What an import says of itself: an EPUB's title, first author and cover image. A cover is read
// in its own bounded pass (parseEpub skips images) and kept only when its bytes are a JPEG, PNG,
// WebP or GIF.
export type BookMeta = { title: string; author: string; cover: { bytes: Uint8Array; ext: 'jpg' | 'png' | 'webp' | 'gif' } | null };
const MAX_COVER_BYTES = 5 * 1024 * 1024;

export function bookMeta(name: string, bytes: Uint8Array): BookMeta {
  const none = { title: '', author: '', cover: null };
  if (name.toLowerCase().split('.').pop() !== 'epub') return none;
  try {
    const files = unzipSync(bytes, { filter: (f) => /\.(xml|opf)$/i.test(f.name) && f.originalSize <= 8 * 1024 * 1024 });
    const read = (path: string) => (files[path] ? strFromU8(files[path]) : '');
    const opfPath = attr(read('META-INF/container.xml').match(/<rootfile\b[^>]*>/i)?.[0] ?? '', 'full-path');
    const opf = read(opfPath);
    if (!opf) return none;
    const text = (tag: string) => tidy(htmlText(opf.match(new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)</dc:${tag}>`, 'i'))?.[1] ?? '')).slice(0, 200);
    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const items = (opf.match(/<item\b[^>]*>/gi) ?? []).map((tag) => ({ id: attr(tag, 'id'), href: attr(tag, 'href'), type: attr(tag, 'media-type'), props: attr(tag, 'properties') }));
    const metaCover = (opf.match(/<meta\b[^>]*>/gi) ?? []).find((tag) => attr(tag, 'name') === 'cover');
    const item = items.find((i) => i.props.split(/\s+/).includes('cover-image'))
      ?? (metaCover ? items.find((i) => i.id === attr(metaCover, 'content')) : undefined)
      ?? items.find((i) => (i.type.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(i.href)) && /cover/i.test(i.id + i.href));
    let cover: BookMeta['cover'] = null;
    if (item?.href) {
      const path = base + decodeURIComponent(item.href.split('#')[0]);
      const found = unzipSync(bytes, { filter: (f) => f.name === path && f.originalSize <= MAX_COVER_BYTES })[path];
      const ext = found && found.length <= MAX_COVER_BYTES ? imageType(found) : null;
      if (found && ext) cover = { bytes: found, ext };
    }
    return { title: text('title'), author: text('creator'), cover };
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

async function parsePdf(bytes: Uint8Array): Promise<Chapter[]> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: false });
  const pages = text as string[];
  const out: Chapter[] = [];
  for (let i = 0; i < pages.length; i += 10) {
    const last = Math.min(i + 10, pages.length);
    out.push({ title: `Pages ${i + 1}–${last}`, text: pages.slice(i, last).join(' ') });
  }
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
