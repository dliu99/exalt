export const MAX_BOOK_BYTES = 50 * 1024 * 1024;
export const MAX_TEXT_CHARS = Number(process.env.MAX_BOOK_CHARACTERS ?? 5000000);
export const MAX_GENERATION_BYTES = Number(process.env.MAX_GENERATION_BYTES ?? 2 * 1024 ** 3);
for (const [name, n] of [['MAX_BOOK_CHARACTERS', MAX_TEXT_CHARS], ['MAX_GENERATION_BYTES', MAX_GENERATION_BYTES]] as const) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer.`);
}
