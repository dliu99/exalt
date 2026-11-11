// A chapter while it is narrated, playable before it is finished. Each part is encoded as it
// comes back from the provider into one AAC stream (ADTS frames, the same 32 kbps mono at 24 kHz
// as the stored M4A) in scratch, by one ffmpeg per chapter, so there are no seams between parts.
// A listener reads it from the start and is sent the rest as it is narrated, over a response held
// open until the chapter is; the player plays on, waiting at the edge if it catches up.
//
// It is served at the address the chapter's M4A will have (`/audio/<generation>/<chapter>.m4a`),
// so the player's source doesn't change when the stored file takes its place, and what is
// playing isn't reloaded. Once the M4A is stored, that address serves it (with byte ranges).
import { open, type FileHandle } from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KBPS, requireEncoder } from './encode.ts';
import { SCRATCH_DIR } from './storage.ts';

const FFMPEG = Bun.which('ffmpeg');
const live = new Map<string, Live>();
const key = (id: number, idx: number) => `${id}/${idx}`;

export class Live {
  /** Encoded bytes so far. */
  size = 0;
  /** `done`: the whole chapter is encoded; `failed`: it never will be (an error, or deleted). */
  state: 'growing' | 'done' | 'failed' = 'growing';
  readonly path: string;
  private waiters = new Set<() => void>();
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private pumped: Promise<void> = Promise.resolve();
  private log = '';

  constructor(readonly id: number, readonly idx: number) {
    this.path = join(SCRATCH_DIR, `${id}-${idx}.live.aac`);
    writeFileSync(this.path, new Uint8Array());
  }

  // The encoder starts with the first part, once its format is known: raw 16-bit mono PCM at
  // `pcmRate`, or MP3 (parts' frames, joined).
  private start(pcmRate?: number) {
    requireEncoder();
    const input = pcmRate ? ['-f', 's16le', '-ar', String(pcmRate), '-ac', '1'] : ['-f', 'mp3'];
    const child = Bun.spawn([FFMPEG!, '-hide_banner', '-loglevel', 'error', ...input, '-i', 'pipe:0',
      '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '24000', '-c:a', 'aac', '-b:a', `${KBPS}k`,
      '-f', 'adts', '-flush_packets', '1', 'pipe:1'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    this.child = child;
    void new Response(child.stderr as ReadableStream).text().then((t) => { this.log = t; });
    this.pumped = (async () => {
      const out = await open(this.path, 'a');
      try {
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          await out.write(chunk);
          this.size += chunk.length;
          this.wake();
        }
      } finally { await out.close(); }
    })();
  }

  /** One narrated part, in order. */
  async push(audio: Uint8Array, pcmRate?: number) {
    if (!this.child) this.start(pcmRate);
    const stdin = this.child!.stdin as import('bun').FileSink;
    stdin.write(audio);
    await stdin.flush();
  }

  /** Every part is in: the stream ends once the encoder has written the last of it. */
  async finish() {
    if (this.child) {
      (this.child.stdin as import('bun').FileSink).end();
      const [code] = await Promise.all([this.child.exited, this.pumped]);
      if (code !== 0) throw new Error(`Encoding the chapter as it was narrated failed: ${this.log.trim().split('\n').at(-1)?.slice(0, 200) ?? `ffmpeg exited ${code}`}`);
    }
    this.state = 'done';
    this.wake();
  }

  fail() {
    if (this.state === 'growing') this.state = 'failed';
    this.child?.kill();
    this.wake();
  }

  private wake() { const w = [...this.waiters]; this.waiters.clear(); for (const f of w) f(); }
  private grown() { return new Promise<void>((r) => this.waiters.add(r)); }

  /** The chapter so far from its start, then the rest as it is narrated. A failure ends it in an error. */
  stream(): ReadableStream<Uint8Array> {
    let file: FileHandle | null = null, at = 0;
    const close = () => { void file?.close().catch(() => {}); file = null; };
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          file ??= await open(this.path, 'r');
          while (at >= this.size && this.state === 'growing') await this.grown();
          if (at < this.size) {
            const buf = new Uint8Array(Math.min(this.size - at, 64 * 1024));
            const { bytesRead } = await file.read(buf, 0, buf.length, at);
            at += bytesRead;
            controller.enqueue(buf.subarray(0, bytesRead));
            return;
          }
          close();
          if (this.state === 'done') controller.close();
          else controller.error(new Error('This chapter stopped narrating.'));
        } catch (e) { close(); controller.error(e); }
      },
      cancel: close,
    }, { highWaterMark: 0 });
  }
}

/** A chapter begins narrating; one already there (a retry) is replaced. */
export function beginLive(id: number, idx: number) {
  endLive(id, idx);
  const l = new Live(id, idx);
  live.set(key(id, idx), l);
  return l;
}
/** The chapter is stored, failed or deleted: its stream is no longer offered. Listeners reading it keep their copy. */
export function endLive(id: number, idx: number) {
  const l = live.get(key(id, idx));
  if (!l) return;
  live.delete(key(id, idx));
  l.fail();
  rmSync(l.path, { force: true });
}
/** The chapter's live stream, once it has something to play. */
export function liveOf(id: number, idx: number): Live | null {
  const l = live.get(key(id, idx));
  return l && l.size > 0 && l.state !== 'failed' ? l : null;
}
/** Where a chapter's audio is played from: the M4A's address, before and after it is stored. */
export const liveFile = (id: number, idx: number) => `${id}/${idx}.m4a`;
