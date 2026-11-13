// Database rows contain object keys, never audio blobs or expiring playback URLs. Chapter audio
// is `audio/<generation>/<chapter>.<ext>`, covers `covers/<book>.<ext>`, on disk under AUDIO_DIR
// or as keys in the bucket.
import { S3Client } from 'bun';
import { mkdirSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const AUDIO_DIR = process.env.AUDIO_DIR ?? join(dirname(process.env.DB ?? 'data.db'), 'audio');
export const SCRATCH_DIR = join(AUDIO_DIR, '.tmp');
mkdirSync(SCRATCH_DIR, { recursive: true });
export const storageKind = process.env.AUDIO_S3_BUCKET ? 's3' : 'local';
const s3 = storageKind === 's3' ? new S3Client({
  bucket: process.env.AUDIO_S3_BUCKET,
  endpoint: process.env.AUDIO_S3_ENDPOINT,
  region: process.env.AUDIO_S3_REGION ?? 'auto',
  accessKeyId: process.env.AUDIO_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.AUDIO_S3_SECRET_ACCESS_KEY,
}) : null;
const key = (file: string) => `audio/${file}`;
// Chapters are stored as M4A (encode.ts); MP3 when the provider's was already small, and MP3 or
// WAV from versions before compression, which still play.
const TYPES: Record<string, string> = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' };
export function validateAudioFile(file: string) {
  if (!/^\d+\/\d+\.(m4a|mp3|wav)$/.test(file)) throw new Error('Invalid audio key.');
  return file;
}
export const audioType = (file: string) => TYPES[validateAudioFile(file).split('.').pop()!];
export function requireDiskSpace() {
  const stat = statfsSync(AUDIO_DIR);
  if (stat.bavail * stat.bsize < 256 * 1024 * 1024) throw new Error('Audio storage is almost full. Try again after storage is expanded.');
}
export async function saveAudio(file: string, path: string): Promise<'s3' | 'local'> {
  validateAudioFile(file);
  if (s3) {
    await s3.file(key(file)).write(Bun.file(path), { type: audioType(file) });
    rmSync(path, { force: true });
    return 's3';
  }
  mkdirSync(dirname(join(AUDIO_DIR, file)), { recursive: true });
  renameSync(path, join(AUDIO_DIR, file));
  return 'local';
}
export function audioURL(file: string): string {
  validateAudioFile(file);
  if (!s3) throw new Error('The audio bucket is not configured on this server.');
  return s3.presign(key(file), { expiresIn: 3600 });
}

// A chapter's stored audio, gone (a deleted audiobook's).
export async function removeAudio(file: string, storage: string) {
  validateAudioFile(file);
  if (storage === 's3') { if (s3) await s3.file(key(file)).delete(); }
  else rmSync(join(AUDIO_DIR, file), { force: true });
}
export const audioDir = (generationId: number) => join(AUDIO_DIR, String(generationId));

// Covers: what an import's EPUB carried, kept as its book's. Only these names are served.
const COVER_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
export function validateCoverFile(file: string) {
  if (!/^up-[0-9a-f]{16}\.(jpg|jpeg|png|webp|gif)$/.test(file)) throw new Error('Invalid cover key.');
  return file;
}
export const coverType = (file: string) => COVER_TYPES[validateCoverFile(file).split('.').pop()!];
export const coverPath = (file: string) => join(AUDIO_DIR, 'covers', validateCoverFile(file));
export async function saveCover(file: string, bytes: Uint8Array) {
  if (s3) { await s3.file(`covers/${validateCoverFile(file)}`).write(bytes, { type: coverType(file) }); return; }
  mkdirSync(join(AUDIO_DIR, 'covers'), { recursive: true });
  writeFileSync(coverPath(file), bytes);
}
// Where a bucket's cover is fetched from, or null when covers are kept on disk.
export const coverURL = (file: string) => (s3 ? s3.presign(`covers/${validateCoverFile(file)}`, { expiresIn: 3600 }) : null);
export async function removeCover(file: string) {
  rmSync(coverPath(file), { force: true });
  if (s3) await s3.file(`covers/${file}`).delete().catch(() => {});
}
