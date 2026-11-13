// Importing a book with no catalog record: the file names its own book (parse.ts bookMeta,
// catalog.ts localBook), and POST /imports answers that book's id.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { bookMeta } from './parse.ts';

const words = (word: string, n = 60) => Array(n).fill(word).join(' ');
// A one-pixel PNG, for the cover.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

function epub({ title = 'The Lantern Keeper', creator = 'Mara Ellison', cover = true } = {}) {
  const chapter = (h: string, w: string) => strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${h}</h1><p>${words(w)}.</p></body></html>`);
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${creator}</dc:creator>${cover ? '<meta name="cover" content="img"/>' : ''}</metadata>
<manifest><item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/>
${cover ? '<item id="img" href="images/cover.png" media-type="image/png"/>' : ''}</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/one.xhtml': chapter('Chapter One', 'lantern'),
    'OEBPS/two.xhtml': chapter('Chapter Two', 'harbour'),
    ...(cover ? { 'OEBPS/images/cover.png': PNG } : {}),
  });
}

// A one-page PDF with an info dictionary (Title, Author) and a line of text.
function pdf({ title = 'Notes on Tides', author = 'Iris Okafor' } = {}) {
  const text = words('tide', 40);
  const stream = `BT /F1 10 Tf 20 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Title (${title}) /Author (${author}) >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out);
}

test('an EPUB names its book by its package metadata, with its cover', async () => {
  const meta = await bookMeta('whatever_file.epub', epub());
  expect([meta.title, meta.author]).toEqual(['The Lantern Keeper', 'Mara Ellison']);
  expect(meta.cover?.type).toBe('image/png');
  expect(meta.cover?.bytes).toEqual(PNG);
});

test('a PDF names its book by its info dictionary', async () => {
  const meta = await bookMeta('scan-0001.pdf', pdf());
  expect([meta.title, meta.author, meta.cover]).toEqual(['Notes on Tides', 'Iris Okafor', null]);
});

test('a file that says nothing of itself is named by its file name', async () => {
  expect(await bookMeta('the_salt_road.txt', strToU8(words('salt')))).toEqual({ title: 'the salt road', author: '', cover: null });
  const meta = await bookMeta('Untitled_Draft.pdf', pdf({ title: '', author: '' }));
  expect([meta.title, meta.author]).toEqual(['Untitled Draft', '']);
});

// An offline server on an empty database of its own; the persona token `ada` signs in.
async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-imports-'));
  const child = Bun.spawn([process.execPath, 'server/index.ts', '--offline'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DB: join(dir, 'db.sqlite'), AUDIO_DIR: join(dir, 'audio'), AUDIO_S3_BUCKET: '', PUBLIC_URL: 'https://exalt.example' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const address = new TextDecoder().decode(value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!address) { child.kill(); throw new Error('Test server did not start.'); }
  const importing = (query: Record<string, string>, body?: Uint8Array) =>
    fetch(`${address}/imports?${new URLSearchParams({ model: 'exalt/silence', rights: '1', ...query })}`,
      { method: 'POST', body, headers: { authorization: 'Bearer ada', 'content-type': 'application/octet-stream' } });
  const stop = async () => { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); };
  return { address, importing, stop };
}

test('an import with no book keeps one from the file and answers its id', async () => {
  const s = await start();
  try {
    // An EPUB upload: its title, author and cover become a local book, which the book page, the
    // listening shelf and the version all answer.
    const made = await s.importing({ name: 'upload.epub' }, epub());
    expect(made.status).toBe(202);
    const { ok, id, book } = await made.json();
    expect(ok).toBe(true);
    expect(book).toMatch(/^local-[0-9a-f]{16}$/);
    const page = await fetch(`${s.address}/books/${book}`).then((r) => r.json());
    expect([page.book.id, page.book.title, page.book.author]).toEqual([book, 'The Lantern Keeper', 'Mara Ellison']);
    expect(page.book.cover).toBe(`https://exalt.example/covers/${book}`);
    expect(page.versions.map((v: { id: string }) => v.id)).toEqual([id]);
    const cover = await fetch(`${s.address}/covers/${book}`);
    expect(cover.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(PNG);
    const version = await fetch(`${s.address}/generations/${id}`).then((r) => r.json());
    expect(version.book.id).toBe(book);
    expect(version.chapters.map((c: { title: string }) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
    for (let i = 0; i < 200 && !(await fetch(`${s.address}/listening`).then((r) => r.json())).length; i++) await Bun.sleep(20);
    expect((await fetch(`${s.address}/listening`).then((r) => r.json())).map((b: { id: string }) => b.id)).toEqual([book]);

    // The same book imported again, as another file, is the same book.
    const again = await s.importing({ name: 'copy.epub' }, epub({ cover: false })).then((r) => r.json());
    expect(again.book).toBe(book);

    // A PDF: its info dictionary names it.
    const fromPdf = await s.importing({ name: 'scan.pdf' }, pdf()).then((r) => r.json());
    expect(fromPdf.book).toMatch(/^local-/);
    expect(fromPdf.book).not.toBe(book);
    const pdfPage = await fetch(`${s.address}/books/${fromPdf.book}`).then((r) => r.json());
    expect([pdfPage.book.title, pdfPage.book.author, pdfPage.book.cover]).toEqual(['Notes on Tides', 'Iris Okafor', '']);

    // A link (the offline server's sample): named by the file the link gave.
    const linked = await s.importing({ name: '', link: 'https://books.example/a-quiet-harbour.txt' });
    expect(linked.status).toBe(202);
    const fromLink = await linked.json();
    const linkPage = await fetch(`${s.address}/books/${fromLink.book}`).then((r) => r.json());
    expect([linkPage.book.title, linkPage.book.author]).toEqual(['A Quiet Harbour', '']);
    expect(linkPage.versions.map((v: { id: string }) => v.id)).toEqual([fromLink.id]);
    // The same link again is the version already made from it.
    expect(await s.importing({ name: '', link: 'https://books.example/a-quiet-harbour.txt' }).then((r) => r.json()))
      .toMatchObject({ ok: true, id: fromLink.id, book: fromLink.book, reused: true });
  } finally { await s.stop(); }
});

test('an import that is not a book keeps no book, and a download needs its book', async () => {
  const s = await start();
  try {
    const bad = await s.importing({ name: 'notes.docx' }, strToU8('not a book'));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('Upload an EPUB, PDF or TXT file.');
    expect(await fetch(`${s.address}/listening`).then((r) => r.json())).toEqual([]);
    const download = await s.importing({ source: 'lg-00000000000000000000000000000001' });
    expect(download.status).toBe(400);
    // A catalog book still answers its own id.
    const catalog = await fetch(`${s.address}/books/OL1W/generations?${new URLSearchParams({ model: 'exalt/silence', rights: '1', name: 'harbour.epub' })}`,
      { method: 'POST', body: epub(), headers: { authorization: 'Bearer ada' } }).then((r) => r.json());
    expect(catalog.book).toBe('OL1W');
  } finally { await s.stop(); }
});

test('a preview says what a file is, keeping nothing', async () => {
  const s = await start();
  try {
    const preview = (query: Record<string, string>, body?: Uint8Array, token = 'ada') =>
      fetch(`${s.address}/imports/preview?${new URLSearchParams(query)}`,
        { method: 'POST', body, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/octet-stream' } });
    expect((await preview({ name: 'a.epub' }, epub(), '')).status).toBe(401);

    // An EPUB: its metadata, its cover inline, its chapter titles in order.
    const fromEpub = await preview({ name: 'upload.epub' }, epub()).then((r) => r.json());
    expect(fromEpub).toEqual({ ok: true, error: '', title: 'The Lantern Keeper', author: 'Mara Ellison',
      cover: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`, chapters: ['Chapter One', 'Chapter Two'] });

    // A PDF: its info dictionary, no cover; one page is one part.
    const fromPdf = await preview({ name: 'scan.pdf' }, pdf()).then((r) => r.json());
    expect([fromPdf.ok, fromPdf.title, fromPdf.author, fromPdf.cover]).toEqual([true, 'Notes on Tides', 'Iris Okafor', '']);
    expect(fromPdf.chapters.length).toBeGreaterThan(0);

    // A link (the offline server's sample).
    const fromLink = await preview({ link: 'https://books.example/a-quiet-harbour.txt' }).then((r) => r.json());
    expect(fromLink).toEqual({ ok: true, error: '', title: 'A Quiet Harbour', author: '', cover: '',
      chapters: ['Chapter One: The Harbour', 'Chapter Two: The River', 'Chapter Three: The Sea'] });

    // Not a book, or a link refused: ok false, and why.
    const notBook = await preview({ name: 'notes.docx' }, strToU8('not a book'));
    expect(notBook.status).toBe(400);
    expect(await notBook.json()).toEqual({ ok: false, error: 'Upload an EPUB, PDF or TXT file.' });
    const refused = await preview({ link: 'https://elsewhere.example/book.epub' }).then((r) => r.json());
    expect(refused.ok).toBe(false);
    expect(refused.error).toBeTruthy();

    // Nothing was kept: no book is on the shelf, and the EPUB's book page doesn't exist.
    expect(await fetch(`${s.address}/listening`).then((r) => r.json())).toEqual([]);
    const made = await s.importing({ name: 'upload.epub' }, epub()).then((r) => r.json());
    expect((await fetch(`${s.address}/books/${made.book}`).then((r) => r.json())).versions).toHaveLength(1);
  } finally { await s.stop(); }
});
