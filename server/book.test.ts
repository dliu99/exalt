// book.ts reads EPUB and TXT with only fflate, as the app does, and as the server's parseBook does.
import { expect, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { readBook } from './book.ts';
import { parseBook } from './parse.ts';

const prose = (word: string) => `<p>${Array(40).fill(word).join(' ')}.</p>`;
const epub = zipSync({
  mimetype: strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'),
  'content.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
    <manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest>
    <spine><itemref idref="a"/><itemref idref="b"/></spine></package>`),
  'a.xhtml': strToU8(`<html><body><h1>The Harbour</h1>${prose('harbour')}</body></html>`),
  'b.xhtml': strToU8(`<html><body><h1>The River</h1>${prose('river')}</body></html>`),
});

test('the app’s reading of an EPUB or TXT is the server’s', async () => {
  expect(readBook('a.epub', epub)).toEqual(await parseBook('a.epub', epub));
  const txt = strToU8(`Chapter One\n${'sea '.repeat(50)}\nChapter Two\n${'sky '.repeat(50)}`);
  expect(readBook('a.txt', txt)).toEqual(await parseBook('a.txt', txt));
  expect(() => readBook('a.pdf', txt)).toThrow('Upload an EPUB, PDF or TXT file.');
});
