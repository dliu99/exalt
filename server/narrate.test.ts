// Narrating a chapter: it plays from its first part while the rest are narrated, two parts are
// asked for at a time, and a provider's 429 slows it to one at a time after its retry-after.
// A provider of the test's own (TTS_BASE_URL) answers each part when the test lets it.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partsOf } from './parse.ts';

const RATE = 24000, SECONDS = 2;
// A provider that answers in raw PCM (as HeyGen does): each part two seconds of a quiet tone.
function provider() {
  const tone = new Uint8Array(RATE * SECONDS * 2);
  const view = new DataView(tone.buffer);
  for (let i = 0; i < RATE * SECONDS; i++) view.setInt16(i * 2, Math.round(Math.sin(i / 10) * 2000), true);
  const p = {
    inputs: [] as string[], at: [] as number[], inFlight: 0, most: 0, held: false,
    waiting: [] as (() => void)[], limited: 0,
    release(n = 1) { for (let i = 0; i < n; i++) p.waiting.shift()?.(); },
    server: Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      if (new URL(req.url).pathname !== '/audio/speech') return new Response('', { status: 404 });
      const body = await req.json() as { input: string; response_format: string };
      expect(body.response_format).toBe('pcm');
      if (p.limited > 0) { p.limited--; p.at.push(Date.now()); return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }); }
      p.inputs.push(body.input); p.at.push(Date.now());
      p.inFlight++; p.most = Math.max(p.most, p.inFlight);
      if (p.held) await new Promise<void>((r) => p.waiting.push(r));
      p.inFlight--;
      return new Response(tone, { headers: { 'content-type': `audio/pcm;rate=${RATE}` } });
    } }),
  };
  return p;
}

async function start(providerPort: number) {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-narrate-'));
  const child = Bun.spawn([process.execPath, 'server/index.ts', '--offline'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DB: join(dir, 'db.sqlite'), AUDIO_DIR: join(dir, 'audio'), AUDIO_S3_BUCKET: '', SIGN_IN_TEST_KEYS: '',
      TTS_BASE_URL: `http://127.0.0.1:${providerPort}`, TTS_MODELS: 'heygen/test=Test voice', OPENROUTER_API_KEY: 'test-key' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const address = new TextDecoder().decode(value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!address) { child.kill(); throw new Error('Test server did not start.'); }
  const call = (method: string, path: string, body?: BodyInit) => fetch(`${address}${path}`, { method, body, headers: { authorization: 'Bearer ada' } });
  return { dir, address, call, stop: async () => { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); } };
}
type Chapter = { idx: number; status: string; src: string; progress: number; error: string };
const until = async <T>(what: string, f: () => Promise<T | undefined | false>, ms = 8000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(15)) { const v = await f(); if (v) return v; }
  throw new Error(`Timed out waiting for ${what}.`);
};
const seconds = (bytes: Uint8Array, dir: string) => {
  const path = join(dir, 'probe.aac');
  writeFileSync(path, bytes);
  return Number(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).stdout.toString());
};
const prose = 'The lantern keeper climbed the spiral stair each evening, counting the steps aloud so the gulls would know she was coming. ';
const book = `Chapter 1: Evening\n${prose.repeat(3)}\nChapter 2: The Light\n${prose.repeat(80)}`;

test('a chapter plays from its first part while the rest are narrated, at the address its M4A keeps', async () => {
  const p = provider();
  const s = await start(p.server.port);
  try {
    const made = await s.call('POST', `/books/OL2W/generations?model=${encodeURIComponent('heygen/test')}&rights=1&name=lantern.txt`, book);
    expect(made.status).toBe(202);
    const { id } = await made.json() as { id: string };
    const gen = () => s.call('GET', `/generations/${id}`).then((r) => r.json() as Promise<{ status: string; active: number; chapters: Chapter[] }>);
    await until('the first chapter', async () => { const g = await gen(); return g.status === 'ready' && g.active === 0; });
    const parts = partsOf('Chapter 2: The Light', prose.repeat(80).trim());
    // Parts start small and grow, so the first is back soonest.
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts[0].length).toBeLessThanOrEqual(600);
    expect(parts[1].length).toBeGreaterThan(parts[0].length);

    p.held = true; p.inputs = []; p.most = 0;
    expect((await s.call('POST', `/generations/${id}/chapters/1`)).status).toBe(202);
    // Two parts are asked for at once, and no more.
    await until('two parts asked for', async () => p.inFlight === 2);
    await Bun.sleep(100);
    expect(p.inputs).toEqual(parts.slice(0, 2));
    let g = await gen();
    expect([g.chapters[1].status, g.chapters[1].src]).toEqual(['working', '']);

    // The first part is narrated: the chapter has audio, while it is still narrating.
    p.release();
    const live = await until('the first part to play', async () => { const c = (await gen()).chapters[1]; return c.src ? c : undefined; });
    expect(live.status).toBe('working');
    expect(live.src).toBe(`/audio/${id}/1.m4a`);
    const res = await fetch(`${s.address}${live.src}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/aac');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const reader = res.body!.getReader();
    const heard: Uint8Array[] = [];
    const first = await reader.read();
    heard.push(first.value!);
    // ADTS: each AAC frame starts with a 12-bit sync word.
    expect([first.value![0], first.value![1] & 0xf0]).toEqual([0xff, 0xf0]);

    // The rest arrive over the same response as they are narrated, still two at a time.
    const reading = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; heard.push(value); } })();
    for (let i = 1; i < parts.length; i++) { await until(`part ${i + 1}`, async () => p.waiting.length > 0); p.release(); }
    await reading;
    expect(p.most).toBe(2);
    expect(p.inputs).toEqual(parts);
    const all = new Uint8Array(heard.reduce((n, h) => n + h.length, 0));
    heard.reduce((at, h) => (all.set(h, at), at + h.length), 0);
    expect(Math.abs(seconds(all, s.dir) - parts.length * SECONDS)).toBeLessThan(0.2);

    // Stored, it keeps the address it played at, now the M4A with byte ranges.
    g = await until('the chapter to be stored', async () => { const v = await gen(); return v.chapters[1].status === 'ready' ? v : undefined; });
    expect(g.chapters[1].src).toBe(live.src);
    const stored = await fetch(`${s.address}${live.src}`);
    expect(stored.headers.get('content-type')).toBe('audio/mp4');
    expect(new TextDecoder().decode(new Uint8Array(await stored.arrayBuffer()).subarray(4, 8))).toBe('ftyp');
    // A chapter not narrating has no live audio.
    expect((await fetch(`${s.address}/audio/${id}/2.m4a`)).status).toBe(404);
  } finally { p.server.stop(true); await s.stop(); }
}, 30000);

test('a provider that answers 429 is waited for (retry-after) and then asked one part at a time', async () => {
  const p = provider();
  const s = await start(p.server.port);
  try {
    p.limited = 1;
    const made = await s.call('POST', `/books/OL2W/generations?model=${encodeURIComponent('heygen/test')}&rights=1&name=lantern.txt`, book);
    const { id } = await made.json() as { id: string };
    await until('the first chapter', async () => { const g = await s.call('GET', `/generations/${id}`).then((r) => r.json()); return g.status === 'ready' && g.active === 0; });
    // The 429's retry-after (a second) passed before the provider was asked again.
    expect(p.at[1] - p.at[0]).toBeGreaterThanOrEqual(950);
    p.held = true; p.most = 0;
    await s.call('POST', `/generations/${id}/chapters/1`);
    await until('a part asked for', async () => p.inFlight === 1);
    await Bun.sleep(200);
    expect(p.inFlight).toBe(1);
    while ((await s.call('GET', `/generations/${id}`).then((r) => r.json())).chapters[1].status !== 'ready') { p.release(); await Bun.sleep(15); }
    expect(p.most).toBe(1);
  } finally { p.server.stop(true); await s.stop(); }
}, 30000);
