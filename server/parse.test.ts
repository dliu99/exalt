import { describe, expect, test } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { parseBook, restoreLigatures } from './parse.ts';
import { MAX_TEXT_CHARS } from './limits.ts';

test('EPUB extraction rejects oversized entries before expanding them', async () => {
  const zip = zipSync({ 'chapter.xhtml': strToU8('x'.repeat(9 * 1024 * 1024)) });
  await expect(parseBook('large.epub', zip)).rejects.toThrow('expands beyond');
});

test('long books are bounded before they can enter the narration queue', async () => {
  await expect(parseBook('long.txt', new TextEncoder().encode('word '.repeat(Math.ceil(MAX_TEXT_CHARS / 5) + 1))))
    .rejects.toThrow('narration limit');
});

// Fixtures are built here: each section's text repeats one word, so a chapter's text shows which
// sections it took in.
const prose = (word: string, n = 30) => `<p>${Array(n).fill(word).join(' ')}.</p>`;
const xhtml = (body: string, bodyAttrs = '') => `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>The Harbour Book</title></head>
<body${bodyAttrs}>${body}</body></html>`;

// An EPUB with its package at OEBPS/content.opf. `files` are relative to OEBPS; a file ending in
// nav.xhtml is the EPUB 3 nav document and one ending in .ncx the EPUB 2 table of contents.
function epub(files: Record<string, string>, spine: string[], { guide = '', nonLinear = [] as string[] } = {}) {
  const id = (f: string) => f.replace(/\W/g, '_');
  const ncx = Object.keys(files).find((f) => f.endsWith('.ncx'));
  const manifest = Object.keys(files).map((f) => `<item id="${id(f)}" href="${f}" media-type="${f === ncx ? 'application/x-dtbncx+xml' : 'application/xhtml+xml'}"${f.endsWith('nav.xhtml') ? ' properties="nav"' : ''}/>`).join('\n');
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Harbour Book</dc:title></metadata>
<manifest>${manifest}</manifest>
<spine${ncx ? ` toc="${id(ncx)}"` : ''}>${spine.map((f) => `<itemref idref="${id(f)}"${nonLinear.includes(f) ? ' linear="no"' : ''}/>`).join('')}</spine>${guide}</package>`;
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(opf),
    ...Object.fromEntries(Object.entries(files).map(([f, s]) => [`OEBPS/${f}`, strToU8(s)])),
  });
}

describe('EPUB chapters', () => {
  test('EPUB 3: the nav gives chapters, parts give way to their chapters, and front and back matter is left out', async () => {
    const files = {
      'text/cover.xhtml': xhtml('<img src="cover.jpg" alt="The Harbour Book"/>', ' epub:type="cover"'),
      'text/title.xhtml': xhtml(`<h1>The Harbour Book</h1>${prose('titling')}`, ' epub:type="titlepage"'),
      'text/legal.xhtml': xhtml(prose('legalese'), ' epub:type="frontmatter copyright-page"'),
      'text/foreword.xhtml': xhtml(`<section epub:type="foreword"><h1>Foreword</h1>${prose('forewording')}</section>`),
      'text/part1.xhtml': xhtml('<h1>Part One</h1><h2>Arrival</h2>', ' epub:type="bodymatter"'),
      'text/ch1.xhtml': xhtml(`<section epub:type="chapter" id="c1"><h1>Chapter 1</h1><h2>The Harbour</h2>${prose('harbour')}</section>`),
      'text/ch2.xhtml': xhtml(`<h1 id="c2">Chapter 2: The River</h1>${prose('river')}`),
      'text/ch2b.xhtml': xhtml(prose('riverbank')),
      'text/part2.xhtml': xhtml('<h1>Part Two</h1><h2>Departure</h2>'),
      'text/ch3.xhtml': xhtml(`<h1>Chapter 3: The Sea</h1>${prose('sea')}`),
      'text/epilogue.xhtml': xhtml(`<h1>Epilogue</h1>${prose('afterwards')}`, ' epub:type="backmatter epilogue"'),
      'text/ads.xhtml': xhtml(`<h1>Also by A. Writer</h1>${prose('advert')}`),
      'text/thanks.xhtml': xhtml(`<h1>Thanks</h1>${prose('grateful')}`),
      'text/index.xhtml': xhtml(`<h1>Index</h1>${prose('indexing')}`),
      'nav/nav.xhtml': xhtml(`<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
        <li><a href="../text/title.xhtml">The Harbour Book</a></li>
        <li><a href="../text/legal.xhtml">Fine Print</a></li>
        <li><a href="nav.xhtml#toc">Contents</a></li>
        <li><a href="../text/foreword.xhtml">Foreword</a></li>
        <li><a href="../text/part1.xhtml">Part One: Arrival</a><ol>
          <li><a href="../text/ch1.xhtml#c1">Chapter 1: The Harbour</a></li>
          <li><a href="../text/ch2.xhtml#c2">Chapter 2: The River</a></li>
        </ol></li>
        <li><a href="../text/part2.xhtml">Part Two: Departure</a><ol>
          <li><a href="../text/ch3.xhtml">Chapter 3: The Sea</a></li>
        </ol></li>
        <li><a href="../text/epilogue.xhtml">Epilogue</a></li>
        <li><a href="../text/thanks.xhtml">Thanks</a></li>
        <li><a href="../text/index.xhtml">Index</a></li>
      </ol></nav>
      <nav epub:type="landmarks" hidden=""><ol>
        <li><a epub:type="cover" href="../text/cover.xhtml">Cover</a></li>
        <li><a epub:type="bodymatter" href="../text/ch1.xhtml">Start</a></li>
        <li><a epub:type="acknowledgments" href="../text/thanks.xhtml">Acknowledgments</a></li>
      </ol></nav>`),
    };
    const chapters = await parseBook('harbour.epub', epub(files, ['text/cover.xhtml', 'text/title.xhtml', 'text/legal.xhtml', 'nav/nav.xhtml', 'text/foreword.xhtml', 'text/part1.xhtml', 'text/ch1.xhtml', 'text/ch2.xhtml', 'text/ch2b.xhtml', 'text/part2.xhtml', 'text/ch3.xhtml', 'text/epilogue.xhtml', 'text/ads.xhtml', 'text/thanks.xhtml', 'text/index.xhtml']));
    expect(chapters.map((c) => c.title)).toEqual(['Foreword', 'Chapter 1: The Harbour', 'Chapter 2: The River', 'Chapter 3: The Sea', 'Epilogue']);
    const [, one, two, three, epilogue] = chapters;
    // The title is narrated before the text, so headings that repeat it are left out.
    expect(one.text).toStartWith('harbour harbour');
    expect(two.text).toStartWith('river river');
    // A chapter continues through spine files the table of contents doesn't list...
    expect(two.text).toContain('riverbank');
    expect(three.text).not.toContain('Departure');
    // ...but not into front or back matter.
    expect(epilogue.text).toContain('afterwards');
    expect(epilogue.text).not.toContain('advert');
    expect(chapters.map((c) => c.text).join(' ')).not.toMatch(/titling|legalese|indexing|grateful|Arrival/);
  });

  test('EPUB 2: the NCX gives chapters, the guide marks front matter, and sections stay in their chapter', async () => {
    const files = {
      'cover.html': xhtml('<img src="cover.jpg" alt="Cover"/>'),
      'rights.html': xhtml(`<h2>Publication Details</h2>${prose('publishing')}`),
      'prologue.html': xhtml(`<h1>Prologue</h1>${prose('beforehand', 250)}`),
      'preface.html': xhtml(`<h1>Preface</h1>${prose('prefacing')}`),
      'one.html': xhtml(`<h1>Chapter One</h1>${prose('harbour')}<h2 id="walk">A Walk</h2>${prose('walking')}`),
      'two.html': xhtml(`<h1>Chapter Two</h1>${prose('river')}`),
      'index.html': xhtml(`<h1>Index</h1>${prose('indexing')}`),
      'index2.html': xhtml(prose('indexing', 250)),
      'toc.ncx': `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>The Harbour Book</text></docTitle><navMap>
        <navPoint id="n1" playOrder="1"><navLabel><text>Publication Details</text></navLabel><content src="rights.html"/></navPoint>
        <navPoint id="n2" playOrder="2"><navLabel><text>Preface</text></navLabel><content src="preface.html"/></navPoint>
        <navPoint id="n3" playOrder="3"><navLabel><text>Chapter One</text></navLabel><content src="one.html"/>
          <navPoint id="n4" playOrder="4"><navLabel><text>A Walk</text></navLabel><content src="one.html#walk"/></navPoint>
        </navPoint>
        <navPoint id="n5" playOrder="5"><navLabel><text>Chapter Two</text></navLabel><content src="two.html"/></navPoint>
        <navPoint id="n6" playOrder="6"><navLabel><text>Index</text></navLabel><content src="index.html"/></navPoint>
      </navMap></ncx>`,
    };
    const guide = '<guide><reference type="cover" href="cover.html"/><reference type="copyright-page" title="Copyright" href="rights.html"/></guide>';
    const chapters = await parseBook('harbour.epub', epub(files, ['cover.html', 'rights.html', 'prologue.html', 'preface.html', 'one.html', 'two.html', 'index.html', 'index2.html'], { guide }));
    // An unlisted prologue after skipped front matter stays; an unlisted file after the index doesn't.
    expect(chapters.map((c) => c.title)).toEqual(['Prologue', 'Preface', 'Chapter One', 'Chapter Two']);
    expect(chapters[0].text).not.toMatch(/publishing|Prologue/);
    expect(chapters[2].text).toContain('harbour');
    expect(chapters[2].text).toContain('A Walk walking');
    expect(chapters[3].text).not.toContain('walking');
    expect(chapters.map((c) => c.text).join(' ')).not.toContain('indexing');
  });

  test('EPUB: a contents entry wrapping every chapter is read through', async () => {
    // In one file, so falling back to the spine would give a single chapter.
    const files = {
      'book.xhtml': xhtml(`<h1 id="a">The Harbour</h1>${prose('harbour')}<h1 id="b">The River</h1>${prose('river')}`),
      'nav.xhtml': xhtml(`<nav epub:type="toc"><ol><li><a href="book.xhtml">Table of Contents</a><ol>
        <li><a href="book.xhtml#a">The Harbour</a></li>
        <li><a href="book.xhtml#b">The River</a></li>
      </ol></li></ol></nav>`),
    };
    const chapters = await parseBook('harbour.epub', epub(files, ['book.xhtml']));
    expect(chapters.map((c) => c.title)).toEqual(['The Harbour', 'The River']);
  });

  test('EPUB: chapters sharing one file split at their anchors', async () => {
    const files = {
      'book.xhtml': xhtml(`<h1>The Harbour Book</h1><p>by A. Writer</p>
        <h2 id="c1">Chapter 1</h2>${prose('harbour')}
        <a id="c2"></a><h2>Chapter 2</h2>${prose('river')}
        <div id="c3"><h2>Chapter 3</h2>${prose('sea')}</div>`),
      'nav.xhtml': xhtml(`<nav epub:type="toc"><ol>
        <li><a href="book.xhtml#c1">Chapter 1</a></li>
        <li><a href="book.xhtml#c2">Chapter 2</a></li>
        <li><a href="book.xhtml#c3">Chapter 3</a></li>
      </ol></nav>`),
    };
    const chapters = await parseBook('harbour.epub', epub(files, ['book.xhtml']));
    expect(chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(chapters.map((c) => c.text)).toEqual([prose('harbour'), prose('river'), prose('sea')].map((p) => p.replace(/<\/?p>/g, '')));
  });

  test('EPUB without a usable table of contents: one chapter per spine file, titled by its heading, without front matter', async () => {
    const files = {
      'cover.xhtml': xhtml('<img src="cover.jpg" alt="Cover"/>'),
      'rights.xhtml': xhtml(`<p>Copyright © 2020 A. Writer. All rights reserved.</p><p>ISBN 978-0-00-000000-0</p>${prose('publishing')}`),
      'contents.xhtml': xhtml(`<h1>Contents</h1>${prose('listing')}`),
      'one.xhtml': xhtml(`<h1>The Harbour</h1>${prose('harbour')}`),
      'two.xhtml': xhtml(`<h1>The River</h1>${prose('river')}`),
      'answers.xhtml': xhtml(`<h1>Answers</h1>${prose('answering')}`),
    };
    const spine = ['cover.xhtml', 'rights.xhtml', 'contents.xhtml', 'one.xhtml', 'answers.xhtml', 'two.xhtml'];
    const oneEntry = xhtml('<nav epub:type="toc"><ol><li><a href="one.xhtml">Start Reading</a></li></ol></nav>');
    for (const book of [epub(files, spine, { nonLinear: ['answers.xhtml'] }), epub({ ...files, 'nav.xhtml': oneEntry }, spine, { nonLinear: ['answers.xhtml'] })]) {
      const chapters = await parseBook('harbour.epub', book);
      expect(chapters.map((c) => c.title)).toEqual(['The Harbour', 'The River']);
      expect(chapters[0].text).toBe(prose('harbour').replace(/<\/?p>/g, ''));
    }
  });
});

// A PDF of one page per string (lines split at \n), with an outline of bookmarks to pages (0-based).
// With `glyphIds`, text is set in a composite font whose ToUnicode map covers only ASCII, as calibre's
// PDFs are: each character is drawn as the glyph id of its code point, so pdf.js reads any character
// beyond ASCII back as that code point. (Named Helvetica, pdf.js would read the ids as Arial's glyphs.)
type Mark = { title: string; page: number; kids?: Mark[] };
function pdf(pages: string[], outline: Mark[] = [], { glyphIds = false } = {}): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
  const objs: string[] = [], page = (i: number) => 6 + 2 * i, root = page(pages.length);
  let next = root;
  objs[1] = `<< /Type /Catalog /Pages 2 0 R${outline.length ? ` /Outlines ${root} 0 R` : ''} >>`;
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${page(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = glyphIds ? '<< /Type /Font /Subtype /Type0 /BaseFont /CharisSIL /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>' : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objs[4] = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CharisSIL /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>';
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /ASCII def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0020> <007E> <0020> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end';
  objs[5] = `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`;
  const show = (l: string) => (glyphIds ? `<${[...l].map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).join('')}>` : `(${esc(l)})`);
  pages.forEach((text, i) => {
    // pdf.js leaves out text drawn past the page edge, so long lines wrap at 8 words.
    const lines = text.split('\n').flatMap((l) => l.split(' ').reduce<string[][]>((out, w) => (out.at(-1)!.length < 8 ? out.at(-1)!.push(w) : out.push([w]), out), [[]]).map((ws) => ws.join(' ')));
    const stream = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `${show(l)} Tj T*`).join(' ')} ET`;
    objs[page(i)] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page(i) + 1} 0 R >>`;
    objs[page(i) + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  const items = (marks: Mark[], parent: number): number[] => {
    const ids = marks.map(() => ++next);
    marks.forEach((m, j) => {
      const kids = m.kids?.length ? items(m.kids, ids[j]) : [];
      objs[ids[j]] = `<< /Title (${esc(m.title)}) /Parent ${parent} 0 R /Dest [${page(m.page)} 0 R /XYZ 0 792 0]${j ? ` /Prev ${ids[j - 1]} 0 R` : ''}${j < ids.length - 1 ? ` /Next ${ids[j + 1]} 0 R` : ''}${kids.length ? ` /First ${kids[0]} 0 R /Last ${kids.at(-1)} 0 R /Count ${kids.length}` : ''} >>`;
    });
    return ids;
  };
  if (outline.length) {
    const top = items(outline, root);
    objs[root] = `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top.at(-1)} 0 R /Count ${top.length} >>`;
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out);
}
const line = (word: string, n = 30) => Array(n).fill(word).join(' ') + '.';

describe('PDF chapters', () => {
  test('the outline gives chapters, split where each title appears on its page', async () => {
    const book = pdf([
      'The Harbour Book\nA. Writer',
      `Contents\nChapter 1: The Harbour .......... 3\nChapter 2: The River .......... 4\n${line('listing')}`,
      `Part One\nChapter 1: The Harbour\n${line('harbour')}`,
      `${line('harbour')}\nChapter 2: The River\n${line('river')}`,
      line('river'),
      `CHAPTER 3\nTHE SEA\n${line('sea')}`,
      `Index\n${line('indexing')}`,
    ], [
      { title: 'Contents', page: 1 },
      { title: 'Part One', page: 2, kids: [{ title: 'Chapter 1: The Harbour', page: 2 }, { title: 'Chapter 2: The River', page: 3 }] },
      { title: 'Chapter 3: The Sea', page: 5 },
      { title: 'Index', page: 6 },
    ]);
    const chapters = await parseBook('harbour.pdf', book);
    expect(chapters.map((c) => c.title)).toEqual(['Chapter 1: The Harbour', 'Chapter 2: The River', 'Chapter 3: The Sea']);
    const [one, two, three] = chapters;
    expect(one.text).toBe(`${line('harbour')} ${line('harbour')}`);
    expect(two.text).toBe(`${line('river')} ${line('river')}`);
    expect(three.text).toBe(line('sea'));
  });

  test('without an outline, a PDF is read in 10-page parts', async () => {
    const chapters = await parseBook('harbour.pdf', pdf(Array.from({ length: 12 }, (_, i) => line(`page${i + 1}`))));
    expect(chapters.map((c) => c.title)).toEqual(['Pages 1–10', 'Pages 11–12']);
    expect(chapters[1].text).toBe(`${line('page11')} ${line('page12')}`);
  });
});

describe('ligatures', () => {
  // As in a calibre PDF set in Charis SIL, whose ligature glyph ids read as ʃ (ff), ɹ (fi), ɻ (fl),
  // ɽ (ffi) and ʀ (ffl). Plain spellings at sentence starts vouch for the first three; ffi and ffl
  // follow Charis SIL. The IPA at the end isn't inside a Latin word, so it stays.
  const plain = 'First light. Find five. Fine. Finally. Flat floor. Flight. Off. Effort. Coffee.';
  const restored = 'At first light she had to find the five boats in fine rain, and finally the flat floor of the far-flung flight deck, off and on, with effort and coffee, past the harbour office and its shuffled cards. The sound /ɹ/ is written ˈɹʌn here.';
  const glyphs = 'At ɹrst light she had to ɹnd the ɹve boats in ɹne rain, and ɹnally the ɻat ɻoor of the far-ɻung ɻight deck, oʃ and on, with eʃort and coʃee, past the harbour oɽce and its shuʀed cards. The sound /ɹ/ is written ˈɹʌn here.';

  test('a PDF font that leaves ligatures out of its ToUnicode map is read with them restored', async () => {
    const chapters = await parseBook('harbour.pdf', pdf([`${plain}\n${glyphs}`], [], { glyphIds: true }));
    expect(chapters.map((c) => c.text)).toEqual([`${plain} ${restored}`]);
  });

  test('stray letters are only read as ligatures when the book spells the restored words', () => {
    expect(restoreLigatures([plain, glyphs])).toEqual([plain, restored]);
    // IPA in Latin-looking words, with plain words a ligature could make from some of them ("flip",
    // "stop"), isn't evidence enough.
    const ipa = ['The vowels: /ʃip/, /ʃop/, /ʃut/, /ɹed/, /ɹat/ and /ɹun/. Flip the card, then stop.'];
    expect(restoreLigatures(ipa)).toEqual(ipa);
  });

  test('Unicode ligatures and the long s are read as their letters', async () => {
    const text = `Chapter 1: The ﬁrst Floor\n${line('harbour')} ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ ſ\nChapter 2: Aﬂoat\n${line('river')}`;
    const chapters = await parseBook('harbour.txt', new TextEncoder().encode(text));
    expect(chapters.map((c) => c.title)).toEqual(['Chapter 1: The first Floor', 'Chapter 2: Afloat']);
    expect(chapters[0].text).toBe(`${line('harbour')} ff fi fl ffi ffl st st s`);
  });
});
