// The app reads a picked EPUB or TXT with book.ts (readBook: the zip's central directory and the
// native DecompressionStream, a turn ended between files and chapters); the server with parseBook and
// bookMeta (fflate). Both must read the same book.
import { expect, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { bookMeta, glance, readBook } from './book.ts';
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

// A Gutenberg-style EPUB: its parts listed beside their chapters, a caption glued into a heading,
// a chapter's own heading naming it, a title page, a dedication and the license.
const page = (body: string) => strToU8(`<html><body>${body}</body></html>`);
const ids = ['t', 'd', 'b1', 'c1', 'c2', 'b2', 'c3', 'c4', 'l'];
const parted = zipSync({
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'),
  'content.opf': strToU8(`<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Long Year; or, Seasons</dc:title></metadata>
    <manifest>${ids.map((id) => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`).join('')}
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>
    <spine>${ids.map((id) => `<itemref idref="${id}"/>`).join('')}</spine></package>`),
  'nav.xhtml': strToU8(`<html><body><nav epub:type="toc"><ol>${[['t', 'THE LONG YEAR; or, SEASONS.'], ['d', 'DEDICATION'], ['b1', 'BOOK ONE: WINTER'], ['c1', 'CHAPTER I'],
    ['c2', 'He rode a black horse. CHAPTER II.'], ['b2', 'BOOK TWO: SPRING'], ['c3', 'CHAPTER I'], ['c4', 'CHAPTER II'], ['l', 'THE FULL PROJECT GUTENBERG™ LICENSE']]
    .map(([id, t]) => `<li><a href="${id}.xhtml">${t}</a></li>`).join('')}</ol></nav></body></html>`),
  't.xhtml': page(`<h1>THE LONG YEAR</h1><p>A novel in two books.</p>${prose('title')}`),
  'd.xhtml': page(`<h2>Dedication</h2>${prose('dear')}`),
  'b1.xhtml': page('<h2>BOOK ONE: WINTER</h2>'),
  'c1.xhtml': page(`<h2>CHAPTER I. THE FIRST SNOW</h2>${prose('snow')}`),
  'c2.xhtml': page(`<h2><span class="caption">He rode a black horse.</span><br/>CHAPTER II.</h2>${prose('horse')}`),
  'b2.xhtml': page('<h2>BOOK TWO: SPRING</h2>'),
  'c3.xhtml': page(`<h2>CHAPTER I</h2>${prose('thaw')}`),
  'c4.xhtml': page(`<h2>CHAPTER II</h2>${prose('rain')}`),
  'l.xhtml': page(`<h2>THE FULL PROJECT GUTENBERG™ LICENSE</h2>${prose('license')}`),
});

test('titles are read one way, on the phone as on the server: names shown, headings narrated, parts kept', async () => {
  const { chapters } = await readBook('year.epub', parted);
  expect(chapters).toEqual(await parseBook('year.epub', parted));
  // The title page, the dedication and the license are left out; Chapter 1 repeats, so each shows its book.
  expect(chapters.map((c) => [c.title, c.heading])).toEqual([
    ['Book 1 · The First Snow', 'Book 1. Winter. Chapter 1. The First Snow.'],
    ['Book 1 · Chapter 2', 'Chapter 2.'],
    ['Book 2 · Chapter 1', 'Book 2. Spring. Chapter 1.'],
    ['Book 2 · Chapter 2', 'Chapter 2.'],
  ]);
  expect(chapters[0].parts).toEqual({ kind: 'chapter', label: 'Chapter', n: 1, name: 'The First Snow', part: 'Book 1: Winter' });
  // The page's own heading names the chapter and isn't narrated twice; the caption isn't narrated at all.
  expect(chapters[0].text.startsWith('snow snow')).toBe(true);
  expect(chapters[1].text.startsWith('horse horse')).toBe(true);
});

test('a plain-text book is read between its Gutenberg lines, past its contents, at its headings and not at prose', async () => {
  const para = (w: string) => `${Array(30).fill(w).join(' ')}.\n${Array(30).fill(w).join(' ')}.`;
  const txt = strToU8([
    'The Project Gutenberg eBook of The Long Year', 'license words here', '*** START OF THE PROJECT GUTENBERG EBOOK THE LONG YEAR ***', '',
    'CONTENTS', '', 'BOOK THE FIRST—WINTER', '', 'CHAPTER I. The First Snow', '', 'CHAPTER II. The Thaw', '', 'BOOK THE SECOND—SPRING', '', 'CHAPTER I. Rain', '', '',
    'BOOK THE FIRST—WINTER', '', 'CHAPTER I.', 'The First Snow', '', para('snow'),
    'part of the fence fell, and the dog', 'ran out into the road.', '', 'CHAPTER II. The Thaw', '', para('thaw'),
    'Chapter 3 of the almanac said so, and', 'nobody argued.', '', 'BOOK THE SECOND—SPRING', '', 'CHAPTER I. Rain', '', para('rain'),
    '*** END OF THE PROJECT GUTENBERG EBOOK THE LONG YEAR ***', 'THE FULL PROJECT GUTENBERG LICENSE', para('license'),
  ].join('\r\n'));
  const { chapters } = await readBook('year.txt', txt);
  expect(chapters).toEqual(await parseBook('year.txt', txt));
  expect(chapters.map((c) => [c.title, c.heading])).toEqual([
    ['The First Snow', 'Book 1. Winter. Chapter 1. The First Snow.'],
    ['The Thaw', 'Chapter 2. The Thaw.'],
    ['Rain', 'Book 2. Spring. Chapter 1. Rain.'],
  ]);
  expect(chapters.some((c) => /license/.test(c.text))).toBe(false);
  expect(chapters[0].text).toContain('part of the fence fell');
});

// An illustrated edition sets each chapter's first letter as a picture or in its own span
// (Gutenberg's Pride and Prejudice): the letter is read, and the word stays whole.
test('a decorated first letter stays in the text', async () => {
  const book = zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>'),
    'c.opf': strToU8(`<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>P</dc:title></metadata>
      <manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`),
    'a.xhtml': strToU8(`<html><body><h2>Chapter I.</h2><p><span class="letra">I</span>T is a truth ${'universally acknowledged '.repeat(40)}.</p>
      <h2>Chapter II.</h2><p><span class="letra"><img alt="N" src="n.png"/></span>OT all that Mrs. Bennet ${'could ask '.repeat(40)}.</p>
      <p><span class="letra"> <img alt="“I" src="i.png"/></span> hope, my dear,” said Mr. Bennet.</p></body></html>`),
  });
  const { chapters } = await readBook('p.epub', book);
  const text = chapters.map((c) => c.text).join(' ');
  expect(text).toContain('IT is a truth');
  expect(text).toContain('NOT all that Mrs. Bennet');
  expect(text).toContain('“I hope, my dear,”');
  expect(chapters).toEqual(await parseBook('p.epub', book));
});

test('a chapter at a glance: its opening line, in sentence case, and its length', () => {
  const at = (text: string) => glance({ title: 'Chapter 1', text }).opening;
  expect(at('IT is a truth universally acknowledged. That a single man…')).toBe('It is a truth universally acknowledged.');
  expect(at('MR. BENNET was among the earliest of those who waited on Mr. Bingley. He had always intended it.')).toBe('Mr. Bennet was among the earliest of those who waited on Mr. Bingley.');
  expect(at('WHEN Jane and Elizabeth were alone. The former spoke.')).toBe('When Jane and Elizabeth were alone.');
  expect(at('Call me Ishmael. Some years ago—never mind how long precisely.')).toBe('Call me Ishmael.');
  expect(at('I. To Sherlock Holmes she is always _the_ woman. I have seldom heard him mention her.')).toBe('To Sherlock Holmes she is always the woman.');
  expect(at(`Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice she had peeped`)).toMatch(/^Alice was beginning .+…$/);
  expect(glance({ title: 'T', text: 'x'.repeat(6000) }).words).toBe(1000);
});
