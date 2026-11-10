# Exalt

A minimal, open audiobook app built with [Exact](https://github.com/expo/exact).

- **One record per book.** Books come from Open Library (title, author, year, cover), keyed by
  their work id. Every audiobook anyone makes of a book hangs off that one record.
- **Make an audiobook** by uploading an EPUB, PDF or TXT and choosing a voice model. The
  server splits the file into chapters, voices the whole book up front, and stores one audio
  file per chapter.
- **Listen.** A book's page shows a sample (the first chapter of its first finished
  audiobook), every version people have made, and a link to its Goodreads reviews. The player
  plays chapter after chapter.

Audiobooks are public. The upload form asks the uploader to confirm the book is in the public
domain or that they hold the rights to share it.

## Layout

| Path | What it is |
| --- | --- |
| `app.contract` | The screens: library and search, book, new audiobook sheet, player |
| `app.ts` | The app's data module: talks to the server |
| `app.test.contract` | Tests, run against the server in offline mode |
| `server/index.ts` | Bun HTTP server: catalog, uploads, audio with byte ranges |
| `server/db.ts` | SQLite schema: `books`, `generations`, `tracks` |
| `server/parse.ts` | EPUB / PDF / TXT to chapters, and chapters to chunks for TTS |
| `server/tts.ts` | Text to speech through an OpenAI-compatible `/audio/speech` endpoint |
| `server/jobs.ts` | The queue that voices a book, one chapter file at a time |

## Run it

Exact is used from a checkout beside this one (`../exact`; `EXACT2` overrides it):

```bash
git clone https://github.com/expo/exact.git ../exact && (cd ../exact && bun scripts/exact.mjs setup)
```

```bash
(cd server && bun install)
```

```bash
OPENROUTER_API_KEY=sk-or-... bun server/index.ts
```

```bash
bun exact.mjs web
```

`bun exact.mjs ios --run` and `bun exact.mjs mac --run` run it natively. Tests start their own
offline server: `bun exact.mjs test web`.

### Server settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | none | Key for the TTS provider; it stays on the server |
| `TTS_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible speech API |
| `TTS_MODELS` | Fish Audio S2.1 Pro (free), HeyGen Voice Turbo (free), Gemini 3.8 Flash Lite TTS, Gemini 3.8 Flash TTS | Replace the model picker: `id=Name,id=Name` |
| `DB` | `data.db` | SQLite file |
| `AUDIO_DIR` | `audio/` beside `DB` | Where chapter files are written |

`bun server/index.ts --offline` searches a two-book fixture and voices with silence, so it works
without a network or a key.

## OpenRouter speech

`server/tts.ts` calls `POST /audio/speech` and reads each model's voices from
`GET /models?output_modalities=speech` (`supported_voices`); the app's Voice picker shows them, and
an unset voice uses the model's first. HeyGen answers only in 16-bit PCM, so its chunks are joined
and saved as one WAV per chapter; the others are MP3. Run the server from the repo root so Bun loads
`.env`, or pass `--env-file`.

## Next

- **Streaming generation.** Voice a chapter when someone first plays it and keep it for
  everyone. This costs less than voicing whole books, and fits a free model that may not stay free.
- Accounts, so versions have owners and can be removed.
- Ratings of versions; reviews beside the Goodreads link.
- A background worker and object storage instead of one process and a folder.
