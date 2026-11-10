import { expect, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { zlibrary } from './zlibrary.ts';
import { parseBook } from './parse.ts';

const raw = { id: 42, hash: 'abc123', title: 'A Harbour', author: 'A Writer', extension: 'epub', language: 'English', filesizeString: '12 KB' };
const epub = zipSync({
  'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
  'book.opf': strToU8('<package><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>'),
  'chapter.xhtml': strToU8('<html><h1>The Harbour</h1><p>A quiet harbour opens onto a wide river where the ships come and go each morning and the people gather to watch them sail.</p></html>'),
});
function client(handle: (url: URL, init?: RequestInit) => Response | Promise<Response>, extra = {}) {
  return zlibrary({ base: 'https://books.example', userId: '123', userKey: 'secret',
    fetch: ((url: string | URL, init?: RequestInit) => handle(new URL(url), init)) as typeof fetch, ...extra });
}
const json = (data: object) => Response.json({ success: 1, ...data });

test('unconfigured Z-Library does not make requests', async () => {
  const c = zlibrary({ base: '', userId: '', userKey: '', fetch: (() => { throw new Error('network'); }) as typeof fetch });
  expect(c.configured).toBe(false);
  expect(await c.search('harbour')).toEqual([]);
  await expect(c.download('zl-42-abc123')).rejects.toThrow('not connected');
});

test('search sends authenticated form filters and only exposes EPUB/PDF metadata', async () => {
  const c = client(async (url, init) => {
    expect(url.pathname).toBe('/eapi/book/search');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('remix-userkey')).toBe('secret');
    const form = new URLSearchParams(init?.body as URLSearchParams);
    expect(form.getAll('extensions[]')).toEqual(['epub', 'pdf']);
    return json({ books: [raw, { ...raw, id: 43, extension: 'pdf' }, { ...raw, extension: 'mobi' }, { ...raw, hash: '../bad' }] });
  });
  const files = await c.search('harbour');
  expect(files.map((b) => b.extension)).toEqual(['epub', 'pdf']);
  expect(files[0].id).toBe('zl-42-abc123');
  expect(JSON.stringify(files)).not.toContain('secret');
});

test('a downloaded EPUB feeds the same chapter parser used by the audiobook queue', async () => {
  const calls: string[] = [];
  const c = client((url) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith('/file')) return json({ file: { downloadLink: '/download/book', allowDownload: true } });
    if (url.pathname.startsWith('/download')) return new Response(epub);
    return json({ book: raw });
  });
  const file = await c.download('zl-42-abc123');
  expect(file.name).toBe('A Harbour.epub');
  const chapters = await parseBook(file.name, file.bytes);
  expect(chapters[0].title).toBe('The Harbour');
  expect(chapters[0].text).toContain('quiet harbour');
  expect(calls).toEqual(['/eapi/book/42/abc123', '/eapi/book/42/abc123/file', '/download/book']);
});

test('session failures and download limits surface as useful errors', async () => {
  await expect(client(() => Response.json({ success: 0 })).search('book')).rejects.toThrow('session');
  await expect(client((url) => url.pathname.endsWith('/file') ? json({ file: { allowDownload: false } }) : json({ book: raw }))
    .download('zl-42-abc123')).rejects.toThrow('allowance');
});

test('downloads reject invalid refs, unexpected origins, HTML and oversized files', async () => {
  await expect(client(() => { throw new Error('must not request'); }).download('../../etc')).rejects.toThrow('Invalid');
  for (const link of ['http://books.example/file', 'https://untrusted.example/file', 'https://user:pass@books.example/file']) {
    await expect(client((url) => url.pathname.endsWith('/file') ? json({ file: { downloadLink: link } }) : json({ book: raw }))
      .download('zl-42-abc123')).rejects.toThrow('unconfigured origin');
  }
  for (const res of [new Response('<html>Login</html>'), new Response('', { headers: { 'content-length': String(201 * 1024 * 1024) } })]) {
    await expect(client((url) => url.pathname.endsWith('/file') ? json({ file: { downloadLink: '/download/book' } }) : url.pathname.startsWith('/download') ? res : json({ book: raw }))
      .download('zl-42-abc123')).rejects.toThrow();
  }
});

test('download redirects are checked and credentials stay on the configured API origin', async () => {
  const c = client((url, init) => {
    if (url.pathname.endsWith('/file')) return json({ file: { downloadLink: '/download/book' } });
    if (url.pathname.startsWith('/eapi')) return json({ book: raw });
    if (url.hostname === 'books.example') return new Response(null, { status: 302, headers: { location: 'https://files.example/book' } });
    expect(new Headers(init?.headers).get('cookie')).toBeNull();
    expect(new Headers(init?.headers).get('remix-userkey')).toBeNull();
    expect(init?.redirect).toBe('manual');
    return new Response(epub);
  }, { downloadOrigins: 'https://files.example' });
  expect((await c.download('zl-42-abc123')).bytes.length).toBe(epub.length);
  const blocked = client((url) => url.pathname.endsWith('/file') ? json({ file: { downloadLink: '/download/book' } }) : url.pathname.startsWith('/eapi') ? json({ book: raw }) : new Response(null, { status: 302, headers: { location: 'https://evil.example' } }));
  await expect(blocked.download('zl-42-abc123')).rejects.toThrow('unconfigured origin');
});
