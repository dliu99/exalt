// Chapter audio is stored compressed: PCM and high-bitrate MP3 become 32 kbps M4A, a small MP3 stays.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compress } from './encode.ts';

const ffmpeg = (...args: string[]) => { if (Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args]).exitCode) throw new Error('ffmpeg failed'); };
const seconds = (path: string) => Number(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).stdout.toString());
// Pink noise fills whatever bitrate it is given, as speech nearly does.
const noise = (s: number) => ['-f', 'lavfi', '-i', `anoisesrc=d=${s}:c=pink:a=0.2`, '-ac', '1'];
const head = async (path: string) => new TextDecoder().decode(await Bun.file(path).slice(4, 8).arrayBuffer());

test('raw PCM is stored as 32 kbps M4A of the same length', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-encode-'));
  try {
    const pcm = join(dir, '1-0.partial');
    ffmpeg(...noise(10), '-ar', '44100', '-f', 's16le', pcm);
    const stored = await compress(pcm, 44100);
    expect(stored).toMatchObject({ path: `${pcm}.m4a`, ext: 'm4a' });
    expect(stored.bytes).toBe(statSync(stored.path).size);
    expect(await head(stored.path)).toBe('ftyp');
    // 10 s at 32 kbps is 40 kB, where the PCM is 882 kB.
    expect(stored.bytes).toBeLessThan(50000);
    expect(Math.abs(seconds(stored.path) - 10)).toBeLessThan(0.1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a high-bitrate MP3 is re-encoded whole, and one near 32 kbps is kept as the provider made it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-encode-'));
  try {
    // A chapter's MP3 parts are joined by bytes, each with its own header.
    const part = join(dir, 'part.mp3'), joined = join(dir, '1-0.partial');
    ffmpeg(...noise(4), '-c:a', 'libmp3lame', '-b:a', '128k', part);
    const bytes = new Uint8Array(await Bun.file(part).arrayBuffer());
    await Bun.write(joined, new Uint8Array([...bytes, ...bytes]));
    const big = await compress(joined);
    expect(big.ext).toBe('m4a');
    expect(big.bytes).toBeLessThan(bytes.length);
    expect(Math.abs(seconds(big.path) - 8)).toBeLessThan(0.2);

    const small = join(dir, '1-1.partial');
    ffmpeg(...noise(4), '-c:a', 'libmp3lame', '-b:a', '32k', '-f', 'mp3', small);
    expect(await compress(small)).toEqual({ path: small, ext: 'mp3', bytes: statSync(small).size });
    expect(await Bun.file(`${small}.m4a`).exists()).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audio ffmpeg cannot read fails the chapter and leaves nothing behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exalt-encode-'));
  try {
    const junk = join(dir, '1-0.partial');
    await Bun.write(junk, 'not audio at all');
    await expect(compress(junk)).rejects.toThrow(/Compressing the chapter's audio failed/);
    expect(await Bun.file(`${junk}.m4a`).exists()).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
