// The app reads a picked EPUB or TXT with book.ts (readBook: the zip's central directory and the
// native DecompressionStream, a turn ended between files and chapters); the server with parseBook and
// bookMeta (fflate). Both must read the same book.
import { expect, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { bookMeta, readBook } from './book.ts';
import { parseBook } from './parse.ts';

const prose = (word: string) => `<p>${Array(40).fill(word).join(' ')}.</p>`;
// A 1×1 PNG, for the cover.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
// Deflated and stored entries, a nav with fragments into one file, a cover, and a non-ASCII name.
const epub = zipSync({
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
  'OEBPS/content.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Harbour Book</dc:title><dc:creator>Mara Ellison</dc:creator></metadata>
    <manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b%C3%A9.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="img" href="images/front.png" media-type="image/png" properties="cover-image"/></manifest>
    <spine><itemref idref="a"/><itemref idref="b"/></spine></package>`),
  'OEBPS/nav.xhtml': strToU8(`<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>
    <li><a href="a.xhtml#one">The Harbour</a></li><li><a href="a.xhtml#two">The Lighthouse</a></li><li><a href="b%C3%A9.xhtml">The River</a></li></ol></nav></body></html>`),
  'OEBPS/a.xhtml': [strToU8(`<html><body><h1 id="one">The Harbour</h1>${prose('harbour')}<h1 id="two">The Lighthouse</h1>${prose('light')}</body></html>`), { level: 0 }],
  'OEBPS/bé.xhtml': strToU8(`<html><body><h1>The River</h1>${prose('river')}</body></html>`),
  'OEBPS/images/front.png': PNG,
});

test('the app’s reading of an EPUB is the server’s, a turn ended along the way', async () => {
  let pauses = 0;
  const { chapters, meta } = await readBook('a.epub', epub, () => { pauses++; });
  expect(chapters).toEqual(await parseBook('a.epub', epub));
  expect(chapters.map((c) => c.title)).toEqual(['The Harbour', 'The Lighthouse', 'The River']);
  expect(meta).toEqual(bookMeta('a.epub', epub));
  expect([meta.title, meta.author, meta.cover?.ext]).toEqual(['The Harbour Book', 'Mara Ellison', 'png']);
  expect(pauses).toBeGreaterThan(3);
});

test('the app’s reading of a TXT is the server’s, its headings found a piece at a time', async () => {
  // Long enough to be read in several pieces, with headings near the pieces' ends.
  const txt = strToU8(Array.from({ length: 12 }, (_, i) => `Chapter ${i + 1}\n${'sea and sky '.repeat(2400)}\n`).join(''));
  let pauses = 0;
  const { chapters, meta } = await readBook('a.txt', txt, () => { pauses++; });
  expect(chapters).toEqual(await parseBook('a.txt', txt));
  expect(chapters.map((c) => c.title)).toEqual(Array.from({ length: 12 }, (_, i) => `Chapter ${i + 1}`));
  expect(meta).toEqual({ title: '', author: '', cover: null });
  expect(pauses).toBeGreaterThan(12);
});

test('the app refuses what the server refuses', async () => {
  await expect(readBook('a.pdf', strToU8('x'))).rejects.toThrow('Upload an EPUB, PDF or TXT file.');
  await expect(readBook('a.epub', strToU8('not a zip'))).rejects.toThrow('This EPUB could not be read.');
  const big = zipSync({ 'chapter.xhtml': strToU8('x'.repeat(9 * 1024 * 1024)) });
  await expect(readBook('large.epub', big)).rejects.toThrow('expands beyond');
});
