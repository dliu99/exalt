// Side by side, what each book provider answers to the same searches, from the running server
// (`bun exact.mjs server` or the dev server): its cache answers repeats, so comparing costs
// Hardcover one request per new search. `bun exact.mjs compare "dune" "mike ma"`.
import { API } from './config.ts';

const PROVIDERS = (process.env.PROVIDERS ?? 'hardcover,google,openlibrary').split(',');
const ROWS = Number(process.env.ROWS ?? 8);
const WIDTH = Math.max(28, Math.floor(((process.stdout.columns || 150) - 4) / PROVIDERS.length) - 2);
const cut = (s: string, n = WIDTH) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
type Book = { title: string; author: string; year: number; cover: string; description: string };

const queries = process.argv.slice(2);
if (!queries.length) { console.error('bun exact.mjs compare "<search>" ["<search>" …]'); process.exit(2); }
for (const q of queries) {
  const answers = await Promise.all(PROVIDERS.map(async (p) => {
    const t0 = performance.now();
    try {
      const res = await fetch(`${API}/search?q=${encodeURIComponent(q)}&provider=${p}`);
      const body = await res.json();
      if (!res.ok) return { p, error: (body as { error?: string }).error ?? `HTTP ${res.status}`, ms: 0, books: [] as Book[] };
      return { p, books: body as Book[], ms: Math.round(performance.now() - t0), error: '' };
    } catch (e) {
      return { p, error: `${(e as Error).message} (is the server running at ${API}?)`, ms: 0, books: [] as Book[] };
    }
  }));
  console.log(`\n── ${q} ${'─'.repeat(Math.max(0, WIDTH * PROVIDERS.length - q.length))}`);
  console.log(answers.map((a) => cut(`${a.p} · ${a.error ? 'error' : `${a.books.length} books, ${a.ms} ms`}`)).join('  '));
  for (let i = 0; i < ROWS; i++) {
    const cells = answers.map((a) => {
      if (a.error) return i === 0 ? cut(a.error) : cut('');
      const b = a.books[i];
      return b ? [cut(`${i + 1}. ${b.title}`), cut(`   ${b.author}${b.year ? ` · ${b.year}` : ''}${b.cover ? '' : ' · no cover'}${b.description ? '' : ' · no desc'}`)] : [cut(''), cut('')];
    });
    const lines = cells.map((c) => (Array.isArray(c) ? c : [c, cut('')]));
    if (lines.every((l) => !l[0].trim())) break;
    console.log(lines.map((l) => l[0]).join('  '));
    console.log(lines.map((l) => l[1]).join('  '));
  }
}
