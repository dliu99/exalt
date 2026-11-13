// Exercise the HTTP boundary and queue without any TTS quota: import (a file or a link), narrate
// the first chapter and others on request, share, browse, keep private (signed audio), edit and
// delete, against the offline server.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
        if (g.status === 'failed' || (g.status === 'ready' && g.active === 0)) return g;
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
    expect(generation).toMatchObject({ id, title: 'A Quiet Harbour', author: 'Ada Lovelace', voice: 'Reader', public: true, status: 'ready', done: 1, total: 1, active: 0, owner: false, signedIn: false });
    expect(generation.chapters).toEqual([{ idx: 0, title: 'The Harbour', status: 'ready', error: '', src: generation.tracks[0].src, progress: 1 }]);
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
    expect(browse).toEqual([{ id, title: 'A Quiet Harbour', author: 'Ada Lovelace', cover: generation.cover, by: expect.any(String), voice: 'Reader', chapters: 1, done: 1, created: expect.any(Number) }]);
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
    expect(own.owner).toBe(true);
    const signedSrc = own.tracks[0].src as string;
    expect(own.chapters[0].src).toBe(signedSrc);
    expect(signedSrc).toMatch(/^\/audio\/\d+\/0\.m4a\?exp=\d+&sig=[0-9a-f]{64}$/);
    expect((await get(signedSrc)).status).toBe(200);
    expect((await get(signedSrc.split('?')[0])).status).toBe(404);
    expect((await get(signedSrc.slice(0, -1) + (signedSrc.endsWith('0') ? '1' : '0'))).status).toBe(404);
    const library = await get('/me/audiobooks', token).then((r) => r.json());
    expect(library.map((a: { id: string; public: boolean }) => [a.id, a.public])).toEqual([[privateId, false], [id, true]]);
    expect(library[0]).toEqual({ id: privateId, title: 'Field Notes', author: '', cover: '', status: 'ready', done: 1, total: 1, active: 0, error: '', public: false, voice: 'exalt/silence', created: expect.any(Number) });
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
    // Nor can they ask for its chapters to be narrated, or delete it.
    expect((await fetch(`${address}/generations/${privateId}/chapters/0`, { method: 'POST', headers: auth(stranger) })).status).toBe(404);
    expect((await fetch(`${address}/generations/${privateId}`, { method: 'DELETE', headers: auth(stranger) })).status).toBe(404);
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
    expect((await fetch(`${address}/generations/${id}`, { method: 'DELETE', headers: auth(stranger) })).status).toBe(403);
    const removed = await fetch(`${address}/me/audiobooks/${id}`, { method: 'DELETE', headers: auth(token) });
    expect(await removed.json()).toEqual({ ok: true });
    expect((await get(`/generations/${id}`, token)).status).toBe(404);
    expect((await get(src)).status).toBe(404);
    expect(await Bun.file(join(dir, 'audio', src.slice('/audio/'.length))).exists()).toBe(false);
    expect((await get(generation.cover)).status).toBe(404);
    expect((await get('/me/audiobooks', token).then((r) => r.json())).map((a: { id: string }) => a.id)).toEqual([privateId]);
    expect(inspection.query('SELECT COUNT(*) AS n FROM books WHERE cover = ?').get(generation.cover)).toEqual({ n: 0 });

    // Active reservations, not just worker jobs, count toward admission limits: three per account.
    const uid = (inspection.query('SELECT id FROM users LIMIT 1').get() as { id: number }).id;
    inspection.query("INSERT INTO books (id, title, author) VALUES ('up-0000000000000000', 'Busy', '')").run();
    for (let i = 0; i < 3; i++) inspection.query("INSERT INTO generations (book_id, user_id, made_by, model, voice, source_name, status, created_at) VALUES ('up-0000000000000000', ?, 'test', 'exalt/silence', '', 'test', 'queued', 0)").run(uid);
    expect((await upload('name=more.txt&public=0', strToU8(WORDS), token)).status).toBe(429);
    for (let i = 0; i < 17; i++) inspection.query("INSERT INTO generations (book_id,made_by,model,voice,source_name,status,created_at) VALUES ('up-0000000000000000','other','exalt/silence','','test','queued',0)").run();
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

// An offline server on an empty database of its own.
async function start(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-generation-'));
  const child = Bun.spawn([process.execPath, 'server/index.ts', '--offline'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DB: join(dir, 'db.sqlite'), AUDIO_DIR: join(dir, 'audio'), AUDIO_S3_BUCKET: '', ...extra },
    stdout: 'pipe', stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const address = new TextDecoder().decode(value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!address) { child.kill(); throw new Error('Test server did not start.'); }
  const call = (method: string, path: string, token = '', body?: BodyInit) => fetch(`${address}${path}`, { method, body,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } });
  const stop = async () => { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); };
  return { dir, address, call, stop };
}
type Server = Awaited<ReturnType<typeof start>>;
type Chapter = { idx: number; title: string; status: string; src: string; progress: number; error: string };
type Generation = { id: string; status: string; done: number; total: number; active: number; chapters: Chapter[]; tracks: { src: string }[];
  mine: number; limit: number; owner: boolean; signedIn: boolean };
// The offline server's one importable link, its sample book of three chapters.
const SAMPLE = `/audiobooks?model=exalt%2Fsilence&rights=1&link=${encodeURIComponent('https://books.example/a-quiet-harbour.txt')}`;

// The audiobook once nothing in it is waiting or narrating.
async function settled(s: Server, id: string, token = ''): Promise<Generation> {
  let g: Generation | undefined;
  for (let i = 0; i < 200; i++) {
    g = await s.call('GET', `/generations/${id}`, token).then((r) => r.json());
    if (g!.status === 'failed' || (g!.status === 'ready' && g!.active === 0)) return g!;
    await Bun.sleep(20);
  }
  throw new Error(`Version ${id} did not settle: ${JSON.stringify(g)}`);
}
const userId = (dir: string, name: string) => {
  const db = new Database(join(dir, 'db.sqlite'));
  try { return (db.query('SELECT id FROM users WHERE name = ?').get(name) as { id: number }).id; } finally { db.close(); }
};

test('an import by link is split into chapters, only its first narrated; the same link again is the same audiobook', async () => {
  const s = await start();
  try {
    expect((await s.call('POST', SAMPLE)).status).toBe(401);
    expect((await s.call('POST', SAMPLE.replace('&rights=1', ''), 'ada')).status).toBe(400);
    const made = await s.call('POST', SAMPLE, 'ada');
    expect(made.status).toBe(202);
    const { id } = await made.json();
    const generation = await settled(s, id, 'ada');
    expect(generation.status).toBe('ready');
    // The sample is three chapters: the first is narrated, the others wait to be asked for.
    expect(generation.chapters.map((c) => [c.title, c.status])).toEqual([
      ['Chapter One: The Harbour', 'ready'], ['Chapter Two: The River', 'idle'], ['Chapter Three: The Sea', 'idle']]);
    expect([generation.done, generation.total, generation.owner, generation.mine, generation.limit]).toEqual([1, 3, true, 0, 3]);
    expect(generation.tracks).toHaveLength(1);
    expect(generation.chapters[0].src).toBe(generation.tracks[0].src);
    expect(generation.tracks[0].src).toMatch(/\/0\.m4a$/);
    const again = await s.call('POST', SAMPLE, 'ada');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, id, reused: true });
    // Someone else's import of the same link is their own audiobook.
    const theirs = await s.call('POST', SAMPLE, 'grace');
    expect(theirs.status).toBe(202);
    expect((await theirs.json()).id).not.toBe(id);
    const inspection = new Database(join(s.dir, 'db.sqlite'));
    expect(inspection.query('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 0 });
    const row = inspection.query('SELECT source_name, source_ref, length(source_hash) AS hash_length FROM generations WHERE id = ?').get(id) as { source_name: string; source_ref: string; hash_length: number };
    expect([row.source_name, row.hash_length]).toEqual(['A Quiet Harbour.txt', 64]);
    expect(row.source_ref).toMatch(/^link:[0-9a-f]{32}$/);
    // A chapter's text is kept until it is narrated, then only its audio.
    expect(inspection.query('SELECT idx, text IS NOT NULL AS kept FROM chapters WHERE generation_id = ? ORDER BY idx').all(id))
      .toEqual([{ idx: 0, kept: 0 }, { idx: 1, kept: 1 }, { idx: 2, kept: 1 }]);
    inspection.close();
  } finally { await s.stop(); }
}, 15000);

test('Generate narrates one chapter; an account has at most three waiting or narrating', async () => {
  const s = await start();
  try {
    const made = await s.call('POST', SAMPLE, 'ada');
    expect(made.status).toBe(202);
    const { id } = await made.json();
    await settled(s, id);
    expect((await s.call('POST', `/generations/${id}/chapters/1`)).status).toBe(401);
    // Anyone signed in may ask of a shared audiobook, not only its maker.
    const asked = await s.call('POST', `/generations/${id}/chapters/1`, 'grace');
    expect(asked.status).toBe(202);
    expect((await asked.json()).status).toBe('queued');
    let g = await settled(s, id, 'grace');
    expect(g.chapters.map((c) => c.status)).toEqual(['ready', 'ready', 'idle']);
    expect([g.done, g.tracks.length, g.owner, g.signedIn]).toEqual([2, 2, false, true]);
    // A narrated chapter is left as it is.
    const twice = await s.call('POST', `/generations/${id}/chapters/1`, 'grace');
    expect(twice.status).toBe(200);
    expect((await twice.json()).status).toBe('ready');
    expect((await s.call('POST', `/generations/${id}/chapters/9`, 'grace')).status).toBe(404);
    // A private one: only its maker may ask.
    const kept = await s.call('POST', '/audiobooks?model=exalt%2Fsilence&public=0&name=notes.txt', 'ada', ['Chapter 1: One', 'Chapter 2: Two'].map((h) => `${h}\n${'The light moves slowly over the water and the town wakes, turns, and settles again by evening. '.repeat(3)}`).join('\n'));
    const keptBody = await kept.json();
    expect([kept.status, keptBody.error]).toEqual([202, undefined]);
    const privateId = keptBody.id;
    await settled(s, privateId, 'ada');
    expect((await s.call('POST', `/generations/${privateId}/chapters/1`, 'grace')).status).toBe(404);
    expect((await s.call('POST', `/generations/${privateId}/chapters/1`, 'ada')).status).toBe(202);
    const own = await settled(s, privateId, 'ada');
    expect(own.chapters.map((c) => c.status)).toEqual(['ready', 'ready']);
    expect(own.chapters[1].src).toMatch(/^\/audio\/\d+\/1\.m4a\?exp=\d+&sig=[0-9a-f]{64}$/);

    // Three chapters of grace's already narrating elsewhere: a fourth is refused until one is done.
    const db = new Database(join(s.dir, 'db.sqlite'));
    const grace = userId(s.dir, 'grace');
    const other = Number(db.query("INSERT INTO generations (book_id, made_by, model, voice, source_name, status, created_at) VALUES ('OL1W', 'x', 'exalt/silence', '', 'x', 'ready', 0)").run().lastInsertRowid);
    for (let i = 0; i < 3; i++) db.query("INSERT INTO chapters (generation_id, idx, title, text, status, requested_by) VALUES (?, ?, 'x', 'x', 'working', ?)").run(other, i, grace);
    g = await s.call('GET', `/generations/${id}`, 'grace').then((r) => r.json());
    expect([g.mine, g.limit]).toEqual([3, 3]);
    const fourth = await s.call('POST', `/generations/${id}/chapters/2`, 'grace');
    expect(fourth.status).toBe(429);
    expect((await fourth.json()).error).toBe('You have 3 chapters narrating. Wait for one to finish, then try again.');
    // Someone else's chapters don't count against grace's, but the server's whole queue does.
    db.query('UPDATE chapters SET requested_by = NULL WHERE generation_id = ?').run(other);
    for (let i = 3; i < 20; i++) db.query("INSERT INTO chapters (generation_id, idx, title, text, status) VALUES (?, ?, 'x', 'x', 'working')").run(other, i);
    const full = await s.call('POST', `/generations/${id}/chapters/2`, 'grace');
    expect(full.status).toBe(429);
    expect((await full.json()).error).toContain('queue is full');
    db.query('DELETE FROM chapters WHERE generation_id = ?').run(other);
    // A version being prepared counts as one of its maker's three.
    for (let i = 0; i < 3; i++) db.query("INSERT INTO generations (book_id, user_id, made_by, model, voice, source_name, status, created_at) VALUES ('OL1W', ?, 'x', 'exalt/silence', '', 'x', 'working', 0)").run(grace);
    expect((await s.call('POST', `/generations/${id}/chapters/2`, 'grace')).status).toBe(429);
    expect((await s.call('POST', '/audiobooks?model=exalt%2Fsilence&rights=1&name=b.txt', 'grace', 'x')).status).toBe(429);
    db.query("DELETE FROM generations WHERE status = 'working'").run();
    // A chapter whose text an older version didn't keep can't be narrated.
    db.query("UPDATE chapters SET text = NULL, status = 'unavailable' WHERE generation_id = ? AND idx = 2").run(id);
    const gone = await s.call('POST', `/generations/${id}/chapters/2`, 'grace');
    expect(gone.status).toBe(409);
    expect((await gone.json()).error).toContain('wasn’t kept');
    db.close();
  } finally { await s.stop(); }
}, 15000);

test('an upload is split into chapters, and only its maker can delete it, audio and all', async () => {
  const s = await start();
  try {
    const book = ['Chapter 1: Morning', 'Chapter 2: Noon', 'Chapter 3: Night']
      .map((h) => `${h}\n${'The light moves slowly over the water and the town wakes, turns, and settles again by evening. '.repeat(3)}`).join('\n');
    const made = await s.call('POST', '/audiobooks?model=exalt%2Fsilence&rights=1&name=days.txt', 'ada', book);
    expect(made.status).toBe(202);
    const { id } = await made.json();
    const g = await settled(s, id, 'ada');
    expect(g.chapters.map((c) => [c.title, c.status])).toEqual([['Chapter 1: Morning', 'ready'], ['Chapter 2: Noon', 'idle'], ['Chapter 3: Night', 'idle']]);
    expect(g.owner).toBe(true);
    const file = join(s.dir, 'audio', String(id), '0.m4a');
    expect(existsSync(file)).toBe(true);
    // Ada's own list shows it, with how much is narrated.
    const mine = await s.call('GET', '/me/audiobooks', 'ada').then((r) => r.json());
    expect(mine.map((m: { id: string; done: number; total: number }) => [m.id, m.done, m.total])).toEqual([[id, 1, 3]]);
    expect((await s.call('DELETE', `/generations/${id}`)).status).toBe(401);
    const notYours = await s.call('DELETE', `/generations/${id}`, 'grace');
    expect(notYours.status).toBe(403);
    expect((await notYours.json()).error).toBe('Only the person who made this audiobook can delete it.');
    expect((await s.call('DELETE', `/generations/${id}`, 'ada')).status).toBe(200);
    expect((await s.call('GET', `/generations/${id}`)).status).toBe(404);
    expect((await fetch(`${s.address}${g.tracks[0].src}`)).status).toBe(404);
    expect(existsSync(file)).toBe(false);
    expect(await s.call('GET', '/me/audiobooks', 'ada').then((r) => r.json())).toEqual([]);
    const db = new Database(join(s.dir, 'db.sqlite'));
    for (const table of ['chapters', 'tracks', 'generation_jobs']) expect(db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE generation_id = ?`).get(id)).toEqual({ n: 0 });
    db.close();
    expect((await s.call('DELETE', `/generations/${id}`, 'ada')).status).toBe(404);
  } finally { await s.stop(); }
}, 15000);
