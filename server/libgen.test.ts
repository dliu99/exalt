import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { libgen, parseSearch } from './libgen.ts';
import { parseBook } from './parse.ts';
const epub = zipSync({
  'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
  'book.opf': strToU8('<package><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>'),
  'chapter.xhtml': strToU8('<html><h1>The Harbour</h1><p>A quiet harbour opens onto a wide river where the ships come and go each morning and the people gather to watch them sail.</p></html>'),
});
const md5 = createHash('md5').update(epub).digest('hex');
const id = `lg-${md5}`;
function client(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>, options = {}) {
  return libgen({ enabled: true, base: 'https://libgen.example', fetch: ((url: string | URL, init?: RequestInit) => handler(new URL(url), init)) as typeof fetch, ...options });
}
function metadata(url: URL): Response | undefined {
  if (url.searchParams.get('object') === 'f') return Response.json({ '42': { md5, extension: 'epub', filesize: epub.length, editions: { '1': { e_id: '7' } } } });
  if (url.searchParams.get('object') === 'e') return Response.json({ '7': { title: 'A Harbour', author: 'A Writer', year: 1900 } });
}

test('real LibGen HTML yields the title once, without ISBN links, and supported file metadata', async () => {
  const html = await Bun.file(new URL('./fixtures/libgen-search.html', import.meta.url)).text();
  const books = parseSearch(html);
  expect(books).toHaveLength(1);
  expect(books[0]).toMatchObject({ title: 'Pride and Prejudice: Jane Austen', author: 'Jane Austen', extension: 'epub', id: 'lg-51860b9694a6d153c4c305dcf3b9e10d' });
  expect(parseSearch(html.replace('<td>epub</td>', '<td>mobi</td>'))).toEqual([]);
});

test('concurrent searches coalesce and cache without requiring credentials', async () => {
  const html = await Bun.file(new URL('./fixtures/libgen-search.html', import.meta.url)).text();
  let calls = 0;
  const c = client((_url, init) => { calls++; expect(new Headers(init?.headers).get('cookie')).toBeNull(); return new Response(html); });
  await Promise.all([c.search('austen'), c.search('austen')]);
  await c.search('austen');
  expect(calls).toBe(1);
});

test('mirror failure falls back and malformed HTML fails instead of claiming no results', async () => {
  const html = await Bun.file(new URL('./fixtures/libgen-search.html', import.meta.url)).text();
  const c = client((url) => url.hostname === 'first.example' ? new Response('down', { status: 503 }) : new Response(html), { mirrors: ['https://first.example', 'https://second.example'] });
  expect(await c.search('austen')).toHaveLength(1);
  await expect(client(() => new Response('<html>Sign in</html>')).search('austen')).rejects.toThrow('unavailable');
});

test('JSON metadata, landing page and download produce an integrity-checked EPUB for chapter extraction', async () => {
  const c = client((url, init) => {
    const meta = metadata(url); if (meta) return meta;
    if (url.pathname === '/ads.php') return new Response(`<a href="get.php?md5=${md5}&amp;key=temporary">GET</a>`);
    expect(new Headers(init?.headers).get('referer')).toContain('/ads.php?md5=');
    if (url.pathname === '/get.php') return new Response(null, { status: 302, headers: { location: 'https://cdn5.booksdl.lc/book.epub' } });
    expect(url.hostname).toBe('cdn5.booksdl.lc');
    return new Response(epub);
  });
  expect((await c.book(id)).title).toBe('A Harbour');
  const book = await c.download(id);
  expect(book.name).toBe('A Harbour.epub');
  expect((await parseBook(book.name, book.bytes))[0].text).toContain('quiet harbour');
});

test('untrusted redirects, truncated downloads, invalid ids and oversized files are rejected', async () => {
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } }),
    () => new Response(epub.slice(0, 50)),
    () => new Response('', { headers: { 'content-length': String(51 * 1024 * 1024) } }),
  ]) {
    const c = client((url) => metadata(url) ?? (url.pathname === '/ads.php' ? new Response(`<a href="get.php?md5=${md5}&key=k">GET</a>`) : response()));
    await expect(c.download(id)).rejects.toThrow();
  }
  await expect(client(() => { throw new Error('should not request'); }).download('../../etc')).rejects.toThrow('Invalid');
});
