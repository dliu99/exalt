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

Listening needs no account. Making an audiobook needs one: Sign in with Apple or Google.

Audiobooks are public. The upload form asks the uploader to confirm the book is in the public
domain or that they hold the rights to share it.

## Layout

| Path | What it is |
| --- | --- |
| `app.contract` | The screens: library and search, book, new audiobook sheet, player |
| `app.ts` | The app's data module: talks to the server |
| `app.test.contract` | Tests, run against the server in offline mode |
| `server/index.ts` | Bun HTTP server: catalog, uploads, audio with byte ranges |
| `server/auth.ts` | Accounts: checks Apple's and Google's ID tokens, issues session tokens |
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
| `GOOGLE_CLIENT_SECRET` | none | The Google web client's secret, for the web sign-in's code exchange |
| `PUBLIC_URL` | `API_BASE_URL` | The server's public address (the web sign-in's return route is under it) |
| `WEB_ORIGINS` | none | The site's origins, comma-separated, that the web sign-in may return to (loopback ones always may) |

## Accounts

Sign in with Apple and Google, as `../exact/docs/recipes/sign-in.md` describes. The app shows the
providers' own buttons on the New Audiobook sheet. It asks the server for a single-use nonce, and
the provider signs an ID token over that nonce. `server/auth.ts` checks the token's signature
against the provider's published keys, along with its issuer, audience, expiry and nonce. Then it
answers a session token of Exalt's own: the app keeps it in its secret store and sends it as a
bearer token. Only `POST /books/:id/generations` needs one, and each audiobook records the account
that made it (`generations.user_id`). On the web, the provider returns to `/sign-in/return` on the
server, which hands the page a single-use handle for the token.

Register these clients, then set them for both the build (`app.json` `env`) and the server:

| Variable | Default (a placeholder) | What it is |
| --- | --- | --- |
| `APPLE_SERVICES_ID` | `app.exalt.audiobooks.web` | Apple Services ID for the web; its return URL is `<PUBLIC_URL>/sign-in/return`. Natively Apple's audience is the bundle ID, `app.exalt.audiobooks`. |
| `GOOGLE_WEB_CLIENT_ID` | `exalt-web.apps.googleusercontent.com` | Google OAuth web client; redirect URI `<PUBLIC_URL>/sign-in/return` |
| `GOOGLE_IOS_CLIENT_ID` | `exalt-ios.apps.googleusercontent.com` | Google OAuth iOS client |

Tests sign in with no network. `bun test server` checks tokens signed by Exact's fixture provider
(`../exact/packages/sign-in/test/idp.mjs`). Under `--offline`, `SIGN_IN_TEST_KEYS=<keys file>`
makes the server trust that provider's key instead of Apple's and Google's.

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
- Let people remove their own versions, and cap how many each account makes per day.
- Ratings of versions; reviews beside the Goodreads link.
- A background worker and object storage instead of one process and a folder.
