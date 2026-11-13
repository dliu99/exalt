// Exercise the HTTP boundary and queue without any TTS quota: import, narrate, share, browse,
// keep private (signed audio), edit and delete, against the offline server.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

const idp = await import(join(process.env.EXACT2 ?? join(import.meta.dir, '../../exact'), 'packages/sign-in/test/idp.mjs'));
// A 1×1 PNG.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const WORDS = 'A quiet harbour opens onto a wide river where the ships come and go each morning and the people gather to watch them sail.';
const epub = () => zipSync({
  mimetype: strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  'OEBPS/content.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>A Quiet Harbour</dc:title><dc:creator id="a1">Ada Lovelace</dc:creator><dc:creator>Someone Else</dc:creator></metadata>
    <manifest><item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/><item id="img" href="images/front.png" media-type="image/png" properties="cover-image"/></manifest>
    <spine><itemref idref="c1"/></spine></package>`),
  'OEBPS/one.xhtml': strToU8(`<html><body><h1>The Harbour</h1><p>${WORDS}</p></body></html>`),
  'OEBPS/images/front.png': PNG,
});

test('an import is narrated, shared in Browse with its cover, kept private on signed URLs, edited and deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-generation-'));
  const keys = join(dir, 'keys.json');
  await idp.jwks(keys);
  const child = Bun.spawn([process.execPath, 'server/index.ts', '--offline'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DB: join(dir, 'db.sqlite'), AUDIO_DIR: join(dir, 'audio'), AUDIO_S3_BUCKET: '', AUDIO_SIGNING_KEY: '', SIGN_IN_TEST_KEYS: keys },
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    const address = new TextDecoder().decode(value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (!address) throw new Error('Test server did not start.');
    reader.releaseLock();
    const auth = (token: string) => (token ? { authorization: `Bearer ${token}` } : {});
    const post = (path: string, body: unknown) => fetch(`${address}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const upload = (query: string, bytes: Uint8Array, token = '') => fetch(`${address}/audiobooks?${query.includes('model=') ? '' : 'model=exalt%2Fsilence&'}${query}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', ...auth(token) }, body: bytes });
    const get = (path: string, token = '') => fetch(`${address}${path}`, { headers: auth(token) });
    const patch = (id: string, token: string, body: unknown) => fetch(`${address}/me/audiobooks/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', ...auth(token) }, body: JSON.stringify(body) });
    const finished = async (id: string, token = '') => {
      for (let i = 0; i < 100; i++) {
        const g = await get(`/generations/${id}`, token).then((r) => r.json());
        if (g.status === 'ready' || g.status === 'failed') return g;
        await Bun.sleep(20);
      }
      throw new Error('The audiobook did not finish.');
    };

    // Signed out, even offline, nothing is made.
    expect((await upload('name=harbour.epub&public=1&rights=1', epub())).status).toBe(401);
    const { nonce, client } = await post('/sign-in/nonce', {}).then((r) => r.json());
    const { credential } = await idp.respond({ identity: { providers: [{ provider: 'apple', configURL: 'https://appleid.apple.com', audience: 'app.exalt.audiobooks', nonce }] } }, keys, { first: true });
    const signedIn = await post('/sign-in/identity', { nonce, client, credential }).then((r) => r.json());
    expect(signedIn.ok).toBe(true);
    const token = signedIn.token as string;

    // Sharing needs the rights confirmed.
    const unconfirmed = await upload('name=harbour.epub&public=1', epub(), token);
    expect(unconfirmed.status).toBe(400);
    expect((await unconfirmed.json()).error).toBe('Confirm you may share this book publicly.');
    expect((await upload('name=harbour.epub&public=1&rights=1&model=nope', epub(), token)).status).toBe(400);

    // A public EPUB: its title, author and cover come from its package file.
    const made = await upload('name=harbour.epub&public=1&rights=1&voiceName=Reader', epub(), token);
    expect(made.status).toBe(202);
    const { id, ok } = await made.json();
    expect(ok).toBe(true);
    const generation = await finished(id);
    expect(generation).toMatchObject({ id, title: 'A Quiet Harbour', author: 'Ada Lovelace', voice: 'Reader', public: true, status: 'ready', done: 1, total: 1 });
    expect(generation.cover).toMatch(/^\/covers\/up-[0-9a-f]{16}\.png$/);
    expect(generation.tracks).toHaveLength(1);
    expect(generation.tracks[0].title).toBe('The Harbour');
    const src = generation.tracks[0].src;
    // The silent model answers in WAV; what is stored and served is the compressed M4A.
    expect(src).toMatch(/^\/audio\/\d+\/0\.m4a$/);
    const audio = await fetch(`${address}${src}`);
    expect(audio.headers.get('content-type')).toBe('audio/mp4');
    const stored = new Uint8Array(await audio.arrayBuffer());
    expect(new TextDecoder().decode(stored.subarray(4, 8))).toBe('ftyp');
    const partial = await fetch(`${address}${src}`, { headers: { range: 'bytes=10-19' } });
    expect(partial.status).toBe(206);
    expect((await partial.arrayBuffer()).byteLength).toBe(10);
    expect((await fetch(`${address}${src}`, { headers: { range: 'bytes=20-10' } })).status).toBe(416);
    expect((await fetch(`${address}${src}`, { headers: { range: 'bytes=-9999999' } })).status).toBe(206);

    // It is in Browse, its cover served as an image.
    const browse = await get('/browse').then((r) => r.json());
    expect(browse).toEqual([{ id, title: 'A Quiet Harbour', author: 'Ada Lovelace', cover: generation.cover, by: expect.any(String), voice: 'Reader', chapters: 1, created: expect.any(Number) }]);
    expect(await get('/browse?q=lovelace').then((r) => r.json())).toHaveLength(1);
    expect(await get('/browse?q=HARBOUR').then((r) => r.json())).toHaveLength(1);
    expect(await get('/browse?q=nothing%25').then((r) => r.json())).toEqual([]);
    const cover = await get(generation.cover);
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(PNG);
    expect((await get('/covers/..%2Fdb.sqlite')).status).toBe(404);

    const inspection = new Database(join(dir, 'db.sqlite'));
    expect(inspection.query('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 });
    expect(inspection.query('SELECT length(source_hash) AS hash_length, public FROM generations WHERE id = ?').get(id)).toEqual({ hash_length: 64, public: 1 });
    // Capacity counts what is stored: the M4A, not the 16 kB of PCM it was made from.
    expect(inspection.query('SELECT bytes, storage FROM tracks WHERE generation_id = ?').get(id)).toEqual({ bytes: stored.length, storage: 'local' });
    expect(stored.length).toBeLessThan(16044);

    // A private TXT: not in Browse, only its owner sees it, and its audio plays only signed.
    const secret = await upload('name=Field%20Notes.txt&public=0', strToU8(WORDS), token);
    expect(secret.status).toBe(202);
    const privateId = (await secret.json()).id as string;
    expect((await get(`/generations/${privateId}`)).status).toBe(404);
    const own = await finished(privateId, token);
    expect(own).toMatchObject({ title: 'Field Notes', author: '', cover: '', public: false, status: 'ready' });
    expect(await get('/browse').then((r) => r.json())).toHaveLength(1);
    const signedSrc = own.tracks[0].src as string;
    expect(signedSrc).toMatch(/^\/audio\/\d+\/0\.m4a\?exp=\d+&sig=[0-9a-f]{64}$/);
    expect((await get(signedSrc)).status).toBe(200);
    expect((await get(signedSrc.split('?')[0])).status).toBe(404);
    expect((await get(signedSrc.slice(0, -1) + (signedSrc.endsWith('0') ? '1' : '0'))).status).toBe(404);
    const library = await get('/me/audiobooks', token).then((r) => r.json());
    expect(library.map((a: { id: string; public: boolean }) => [a.id, a.public])).toEqual([[privateId, false], [id, true]]);
    expect(library[0]).toEqual({ id: privateId, title: 'Field Notes', author: '', cover: '', status: 'ready', done: 1, total: 1, error: '', public: false, voice: 'exalt/silence', created: expect.any(Number) });
    expect((await get('/me/audiobooks')).status).toBe(401);
    // Places in someone else's private audiobook are refused.
    const other = await post('/sign-in/nonce', {}).then((r) => r.json());
    // Exact's fixture provider is one person to Apple and another to Google.
    const second = await idp.respond({ identity: { providers: [{ provider: 'google', configURL: 'https://accounts.google.com/gsi/fedcm.json', audience: 'exalt-web.apps.googleusercontent.com', nonce: other.nonce }] } }, keys);
    const { handle: _, ...posted } = second.credential;
    const stranger = (await post('/sign-in/identity', { nonce: other.nonce, client: other.client, credential: posted }).then((r) => r.json())).token as string;
    expect(stranger).not.toBe(token);
    const place = { track: 0, tracks: 1, time: 1, duration: 2, at: Date.now() };
    const putPlace = (gen: string, t: string) => fetch(`${address}/me/places/${gen}`, { method: 'PUT', headers: { 'content-type': 'application/json', ...auth(t) }, body: JSON.stringify(place) });
    expect((await putPlace(privateId, stranger)).status).toBe(404);
    expect((await putPlace(privateId, token)).status).toBe(200);
    expect((await get(`/generations/${privateId}`, stranger)).status).toBe(404);
    expect((await patch(privateId, stranger, { public: true, rights: true })).status).toBe(404);

    // Sharing it later needs the rights confirmed too; then it is in Browse. Titles can be corrected.
    const preflight = await fetch(`${address}/me/audiobooks/${privateId}`, { method: 'OPTIONS' });
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect((await patch(privateId, token, { public: true })).status).toBe(400);
    expect((await patch(privateId, token, { title: '  ' })).status).toBe(400);
    const shared = await patch(privateId, token, { public: true, rights: true, title: ' Notes from the Field ', author: 'Ada' });
    expect(shared.status).toBe(200);
    expect(await shared.json()).toMatchObject({ id: privateId, title: 'Notes from the Field', author: 'Ada', public: true });
    expect((await get('/browse?q=field').then((r) => r.json())).map((b: { id: string }) => b.id)).toEqual([privateId]);
    expect((await get((await finished(privateId)).tracks[0].src)).status).toBe(200);

    // Deleted: gone from everywhere, its audio too.
    expect((await fetch(`${address}/me/audiobooks/${id}`, { method: 'DELETE', headers: auth(stranger) })).status).toBe(404);
    const removed = await fetch(`${address}/me/audiobooks/${id}`, { method: 'DELETE', headers: auth(token) });
    expect(await removed.json()).toEqual({ ok: true });
    expect((await get(`/generations/${id}`, token)).status).toBe(404);
    expect((await get(src)).status).toBe(404);
    expect(await Bun.file(join(dir, 'audio', src.slice('/audio/'.length))).exists()).toBe(false);
    expect((await get(generation.cover)).status).toBe(404);
    expect((await get('/me/audiobooks', token).then((r) => r.json())).map((a: { id: string }) => a.id)).toEqual([privateId]);
    expect(inspection.query('SELECT COUNT(*) AS n FROM books WHERE cover = ?').get(generation.cover)).toEqual({ n: 0 });

    // Active reservations, not just worker jobs, count toward admission limits.
    const uid = (inspection.query('SELECT id FROM users LIMIT 1').get() as { id: number }).id;
    inspection.query("INSERT INTO books (id, title, author) VALUES ('up-0000000000000000', 'Busy', '')").run();
    for (let i = 0; i < 2; i++) inspection.query("INSERT INTO generations (book_id, user_id, made_by, model, voice, source_name, status, created_at) VALUES ('up-0000000000000000', ?, 'test', 'exalt/silence', '', 'test', 'queued', 0)").run(uid);
    expect((await upload('name=more.txt&public=0', strToU8(WORDS), token)).status).toBe(429);
    for (let i = 0; i < 18; i++) inspection.query("INSERT INTO generations (book_id,made_by,model,voice,source_name,status,created_at) VALUES ('up-0000000000000000','other','exalt/silence','','test','queued',0)").run();
    const full = await upload('name=more.txt&public=0', strToU8(WORDS), stranger);
    expect(full.status).toBe(429);
    expect((await full.json()).error).toContain('queue is full');
    // A refused import leaves nothing behind.
    expect(inspection.query("SELECT COUNT(*) AS n FROM generations WHERE source_name = 'more.txt'").get()).toEqual({ n: 0 });
    inspection.close();
  } finally {
    child.kill(); await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
