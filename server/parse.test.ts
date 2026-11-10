import { expect, test } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { parseBook } from './parse.ts';
import { MAX_TEXT_CHARS } from './limits.ts';

test('EPUB extraction rejects oversized entries before expanding them', async () => {
  const zip = zipSync({ 'chapter.xhtml': strToU8('x'.repeat(9 * 1024 * 1024)) });
  await expect(parseBook('large.epub', zip)).rejects.toThrow('expands beyond');
});

test('long books are bounded before they can enter the narration queue', async () => {
  await expect(parseBook('long.txt', new TextEncoder().encode('word '.repeat(Math.ceil(MAX_TEXT_CHARS / 5) + 1))))
    .rejects.toThrow('narration limit');
});
