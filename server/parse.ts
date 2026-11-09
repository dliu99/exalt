// An uploaded book to chapters of plain text: EPUB by its spine, PDF by pages, TXT by its
// "Chapter" headings. Anything without chapters is cut into parts of about PART_WORDS words.
import { strFromU8, unzipSync } from 'fflate';

export type Chapter = { title: string; text: string };
const PART_WORDS = 4000;

export async function parseBook(name: string, bytes: Uint8Array): Promise<Chapter[]> {
  const ext = name.toLowerCase().split('.').pop();
  const chapters = ext === 'epub' ? parseEpub(bytes) : ext === 'pdf' ? await parsePdf(bytes) : ext === 'txt' ? parseTxt(new TextDecoder().decode(bytes)) : null;
  if (!chapters) throw new Error('Upload an EPUB, PDF or TXT file.');
  const kept = chapters.map((c) => ({ title: c.title, text: tidy(c.text) })).filter((c) => c.text.split(' ').length >= 20);
  if (kept.length === 0) throw new Error('No readable text was found in this file.');
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
  const files = unzipSync(bytes);
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
