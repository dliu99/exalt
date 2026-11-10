// Chapter audio is stored compressed: AAC-LC at 32 kbps mono, 24 kHz, in an M4A file. That is
// about 15 MB an hour of narration, where the 16-bit PCM some providers answer in is ~317 MB.
// AAC rather than Opus: the iOS app (iOS 17 and later) plays through AVPlayer, which opens Ogg
// Opus only from iOS 18.4, misjudging its length, and WebM not at all; Safari reads Ogg Opus only
// from 18.4 too. M4A plays there and in every browser's <audio>.
// ffmpeg (the Dockerfile installs it) encodes from the scratch file on disk, so no chapter is
// held in memory, at about a hundred times real time.
import { rmSync, statSync } from 'node:fs';

export const KBPS = 32;
// What a second of narration takes stored, to count a chapter against limits before it is encoded.
export const STORED_BYTES_PER_SECOND = KBPS * 1000 / 8;
const FFMPEG = Bun.which('ffmpeg');
if (!FFMPEG) console.error('server: ffmpeg is not installed, so no audiobook can be made until it is.');

export function requireEncoder() {
  if (!FFMPEG) throw new Error('This server cannot compress audio yet: ffmpeg is not installed.');
}

// The chapter at `path` (raw 16-bit mono PCM at `pcmRate`, or MP3) as it should be stored: M4A,
// or the MP3 as the provider made it when encoding saves less than a third (an MP3 already near
// 32 kbps would lose quality to a second lossy pass for little space).
export async function compress(path: string, pcmRate?: number): Promise<{ path: string; ext: 'm4a' | 'mp3'; bytes: number }> {
  requireEncoder();
  const out = `${path}.m4a`;
  const input = pcmRate ? ['-f', 's16le', '-ar', String(pcmRate), '-ac', '1', '-i', path] : ['-i', path];
  const child = Bun.spawn([FFMPEG!, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...input,
    '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '24000', '-c:a', 'aac', '-b:a', `${KBPS}k`,
    '-movflags', '+faststart', '-f', 'mp4', out], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  // Joined MP3 parts warn at each seam; only the exit code says whether it failed.
  const [code, log] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) {
    rmSync(out, { force: true });
    throw new Error(`Compressing the chapter's audio failed: ${log.trim().split('\n').at(-1)?.slice(0, 200) ?? `ffmpeg exited ${code}`}`);
  }
  const bytes = statSync(out).size;
  if (!pcmRate) {
    const before = statSync(path).size;
    if (bytes * 3 > before * 2) { rmSync(out, { force: true }); return { path, ext: 'mp3', bytes: before }; }
  }
  return { path: out, ext: 'm4a', bytes };
}
