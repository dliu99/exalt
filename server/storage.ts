// Database rows contain object keys, never audio blobs or expiring playback URLs.
import { S3Client } from 'bun';
import { mkdirSync, renameSync, rmSync, statfsSync } from 'node:fs';
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
