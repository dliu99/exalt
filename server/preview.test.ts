// An import's preview (POST /audiobooks/preview): what a file or link is, before anything is made
// of it, and nothing kept; and an import's answer carries its audiobook's id.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

const words = (word: string, n = 60) => Array(n).fill(word).join(' ');
// A 1×1 PNG, for the cover.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const epub = () => {
  const chapter = (h: string, w: string) => strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${h}</h1><p>${words(w)}.</p></body></html>`);
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>The Lantern Keeper</dc:title><dc:creator>Mara Ellison</dc:creator></metadata>
      <manifest><item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/>
      <item id="img" href="images/front.png" media-type="image/png" properties="cover-image"/></manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
    'OEBPS/one.xhtml': chapter('Chapter One', 'lantern'),
    'OEBPS/two.xhtml': chapter('Chapter Two', 'harbour'),
    'OEBPS/images/front.png': PNG,
  });
};

// A one-page PDF with a line of text.
function pdf() {
  const stream = `BT /F1 10 Tf 20 700 Td (${words('tide', 40)}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out);
}

// An offline server on an empty database of its own; the persona token `ada` signs in.
async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-preview-'));
  const child = Bun.spawn([process.execPath, 'server/index.ts', '--offline'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DB: join(dir, 'db.sqlite'), AUDIO_DIR: join(dir, 'audio'), AUDIO_S3_BUCKET: '', AUDIO_SIGNING_KEY: '' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const address = new TextDecoder().decode(value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!address) { child.kill(); throw new Error('Test server did not start.'); }
  const post = (path: string, query: Record<string, string>, body?: Uint8Array, token = 'ada') =>
    fetch(`${address}${path}?${new URLSearchParams(query)}`,
      { method: 'POST', body, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/octet-stream' } });
  const stop = async () => { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); };
  return { address, post, stop };
}

test('a preview says what a file or link is, and keeps nothing', async () => {
  const s = await start();
  try {
    const preview = (query: Record<string, string>, body?: Uint8Array, token?: string) => s.post('/audiobooks/preview', query, body, token);
    const signedOut = await preview({ name: 'a.epub' }, epub(), '');
    expect(signedOut.status).toBe(401);
    expect((await signedOut.json()).ok).toBe(false);

    // An EPUB: its metadata, its cover inline, its chapter titles in order.
    expect(await preview({ name: 'upload.epub' }, epub()).then((r) => r.json())).toEqual({ ok: true, error: '', title: 'The Lantern Keeper',
      author: 'Mara Ellison', cover: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`, chapters: ['Chapter One', 'Chapter Two'] });

    // A PDF: named by its file, no cover, its pages in parts.
    const fromPdf = await preview({ name: 'Notes on Tides.pdf' }, pdf()).then((r) => r.json());
    expect([fromPdf.ok, fromPdf.title, fromPdf.author, fromPdf.cover]).toEqual([true, 'Notes on Tides', '', '']);
    expect(fromPdf.chapters.length).toBeGreaterThan(0);

    // A link (the offline server's sample book).
    expect(await preview({ link: 'https://books.example/a-quiet-harbour.txt' }).then((r) => r.json())).toEqual({ ok: true, error: '',
      title: 'A Quiet Harbour', author: '', cover: '', chapters: ['Chapter One: The Harbour', 'Chapter Two: The River', 'Chapter Three: The Sea'] });

    // Not a book, or a link refused: ok false, and why.
    const notBook = await preview({ name: 'notes.docx' }, strToU8('not a book'));
    expect(notBook.status).toBe(400);
    expect(await notBook.json()).toEqual({ ok: false, error: 'Upload an EPUB, PDF or TXT file.' });
    const refused = await preview({ link: 'https://elsewhere.example/book.epub' }).then((r) => r.json());
    expect(refused.ok).toBe(false);
    expect(refused.error).toBeTruthy();

    // Nothing was kept.
    expect(await fetch(`${s.address}/me/audiobooks`, { headers: { authorization: 'Bearer ada' } }).then((r) => r.json())).toEqual([]);
  } finally { await s.stop(); }
});

test('an import answers its audiobook’s id', async () => {
  const s = await start();
  try {
    const made = await s.post('/audiobooks', { name: 'upload.epub', model: 'exalt/silence', public: '0' }, epub());
    expect(made.status).toBe(202);
    const { ok, id } = await made.json();
    expect(ok).toBe(true);
    expect(id).toMatch(/^\d+$/);
    const mine = await fetch(`${s.address}/me/audiobooks`, { headers: { authorization: 'Bearer ada' } }).then((r) => r.json());
    expect(mine.map((g: { id: string }) => g.id)).toEqual([id]);
  } finally { await s.stop(); }
});
