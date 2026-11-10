import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('speech retries rate limits, stops after three attempts and does not retry permanent refusals', async () => {
  let calls = 0, mode = 'limited';
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    expect(new URL(req.url).pathname).toBe('/audio/speech');
    const body = await req.json();
    expect(body).toMatchObject({ model: 'test/model', voice: 'reader', input: 'A short test sentence.', response_format: 'mp3' });
    calls++;
    if (mode === 'unauthorized') return new Response('not allowed', { status: 401 });
    if (mode === 'unavailable') return new Response('busy', { status: 503 });
    if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 1]), { headers: { 'content-type': 'audio/mpeg' } });
  } });
  async function run() {
    const child = Bun.spawn([process.execPath, '-e', `import {speak} from './server/tts.ts';try {const v=await speak('test/model','reader','A short test sentence.');console.log(v.ext,v.audio.length)}catch(e){console.log(e.message);process.exitCode=1}`], {
      cwd: join(import.meta.dir, '..'), env: { ...process.env, OPENROUTER_API_KEY: 'test-key', TTS_BASE_URL: `http://127.0.0.1:${provider.port}` }, stdout: 'pipe', stderr: 'pipe',
    });
    const text = await new Response(child.stdout).text();
    return { code: await child.exited, text };
  }
  try {
    expect(await run()).toMatchObject({ code: 0, text: 'mp3 4\n' }); expect(calls).toBe(2);
    calls = 0; mode = 'unauthorized';
    expect((await run()).code).toBe(1); expect(calls).toBe(1);
    calls = 0; mode = 'unavailable';
    expect((await run()).code).toBe(1); expect(calls).toBe(3);
  } finally { provider.stop(true); }
}, 10000);
