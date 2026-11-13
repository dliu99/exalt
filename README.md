# Exalt

A minimal, open audiobook app built with [Exact](https://github.com/expo/exact).

- **Import a book.** A signed-in person uploads their own EPUB, PDF or TXT and chooses a voice
  model. The server splits the file into chapters, voices the whole book up front, and stores one
  audio file per chapter. An EPUB's title, author and cover come from its package file.
- **Your library.** Everything you import is yours: listed with its progress, renamed, shared or
  kept private, deleted.
- **Browse.** Each audiobook has a share switch, on by default. Shared, finished ones appear in a
  public Browse feed with their cover, title and author, for anyone to play.

Exalt opens on Sign in with Google (the offline server used by tests leaves the door open).

Sharing asks the importer to confirm the book is in the public domain or that they hold the
rights to share it; a private audiobook needs no confirmation and is played only by its owner,
on signed URLs. Exalt has no book catalog and downloads no books: it narrates what you bring.

## Layout

| Path | What it is |
| --- | --- |
| `app.contract` | The screens: Browse, library, import sheet, player |
| `app.ts` | The app's data module: talks to the server |
| `app.test.contract` | Tests, run against the server in offline mode |
| `server/index.ts` | Bun HTTP server: imports, library, Browse, covers, audio with byte ranges |
| `server/auth.ts` | Accounts: checks Apple's and Google's ID tokens, issues session tokens |
| `server/db.ts` | SQLite schema: `books`, `generations` (with `public`), `tracks`, `settings` |
| `server/signing.ts` | Signed, expiring URLs for private audiobooks' audio and covers |
| `server/places.ts` | Where each signed-in listener is in each audiobook, so their devices carry over |
| `server/parse.ts` | EPUB / PDF / TXT to chapters, an EPUB's title, author and cover, and chapters to chunks for TTS |
| `server/tts.ts` | Text to speech through an OpenAI-compatible `/audio/speech` endpoint |
| `server/encode.ts` | Compresses each narrated chapter to AAC in M4A with ffmpeg before it is stored |
| `server/jobs.ts` | Durable SQLite queue, admission limits and chapter checkpoints |
| `server/storage.ts` | Local or S3-compatible chapter audio and cover storage |

## Routes

Signed-in routes take `Authorization: Bearer <token>`. Cover and audio `src` values are paths on
the server (`/covers/…`, `/audio/…`); a private audiobook's carry `?exp=…&sig=…`.

| Route | What it does |
| --- | --- |
| `POST /audiobooks?name=&model=&voice=&voiceName=&by=&title=&author=&public=1\|0&rights=1\|0` | The file is the body. Sharing (`public=1`, the default) needs `rights=1`. Answers `202 {ok, id}` |
| `GET /browse?q=` | Shared, finished audiobooks, newest first (at most 100); `q` matches title or author |
| `GET /me/audiobooks` | The signed-in person's audiobooks, every status, newest first |
| `PATCH /me/audiobooks/:id` | `{public?, rights?, title?, author?}`; sharing needs `rights: true` |
| `DELETE /me/audiobooks/:id` | Removes it, its audio, and its book and cover, even mid-narration |
| `GET /generations/:id` | One audiobook and its chapters: shared ones for anyone, private ones for their owner |
| `GET /audio/*`, `GET /covers/*` | Audio (byte ranges) and covers; private ones only on a valid signature |
| `GET /me/places`, `PUT /me/places/:gen` | Listening places, below |
| `GET /models`, `GET /voices` | Voice models and Fish Audio's voices |

## Run it

In Conductor, the default **app** action starts both servers. **backend** and **frontend**
are also available separately. Each workspace uses its allocated frontend port and the next
port for the API; Stop shuts down both processes. Outside Conductor, run commands below.

Exact is used from a checkout beside this one (`../exact`; `EXACT2` overrides it):

```bash
git clone https://github.com/expo/exact.git ../exact && (cd ../exact && bun scripts/exact.mjs setup)
```

```bash
(cd server && bun install)
```

The server compresses narration with [ffmpeg](https://ffmpeg.org), which must be on `PATH`
(`brew install ffmpeg`, `apt install ffmpeg`; the Dockerfile installs it). Without it the
server still runs, but refuses to make audiobooks.

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
| `AUDIO_DIR` | `audio/` beside `DB` | Local audio and scratch directory (on persistent disk) |
| `MAX_BOOK_CHARACTERS` | 5000000 | Maximum extracted characters in one book |
| `MAX_GENERATION_BYTES` | 2 GiB | Maximum stored (compressed) audio bytes for one generation |
| `AUDIO_MAX_BYTES` | 8 GiB local; 0 with S3 | Cap on stored (compressed) chapter bytes; 0 means no aggregate cap |
| `AUDIO_SIGNING_KEY` | generated once, kept in SQLite `settings` | HMAC key for private audio and cover URLs; changing it ends links already handed out |
| `GOOGLE_CLIENT_SECRET` | none | The Google web client's secret, for the web sign-in's code exchange |
| `PUBLIC_URL` | `API_BASE_URL` | The server's public address (the web sign-in's return route is under it) |
| `WEB_ORIGINS` | none | The site's origins, comma-separated, that the web sign-in may return to (loopback ones always may) |

## Storage and backend capacity

| Data | Storage | Retention |
| --- | --- | --- |
| Book metadata, accounts, hashed sessions, source hashes, share switch, narration settings and progress | SQLite at `DB` | Retained until the audiobook is deleted |
| Extracted chapter text | SQLite `generation_jobs` | Removed on completion, failure or deletion |
| Source EPUB/PDF/TXT | Worker/request memory, at most 50 MiB per file | Discarded after parsing; never archived |
| Incomplete chapter audio (raw PCM or MP3) | `AUDIO_DIR/.tmp` | Removed after compression and upload, or failure; interrupted chapter is overwritten on resume |
| Finished chapter audio (M4A) | Persistent local disk or S3-compatible bucket | Retained until its audiobook is deleted |
| Covers (an EPUB's cover image, at most 5 MB, JPEG/PNG/WebP/GIF) | `AUDIO_DIR/covers/<book>.<ext>` or bucket key `covers/<book>.<ext>` | Retained until its book is deleted |
| Listening position | The listener's device; for a signed-in listener also SQLite `places` (chapter, time, when), newest wins | Device: until cleared. Server: retained, a finished book's row marked finished; removed with its audiobook |
| Voice preference | The listener's device | Until cleared |

The backend runs **one instance and one generation worker**. SQLite is a durable queue:
a restart resumes queued work and skips completed chapters. An interrupted chapter may
repeat TTS calls; completed chapters do not. New jobs are capped at 20 pending globally and
two per account. Concurrent upload parsing is capped at two. Books default to a limit of five
million extracted characters, and each generated audiobook to 2 GiB stored. EPUB expansion is
bounded and chapter audio is written to scratch chunk by chunk, rather than accumulated
in memory. Transient TTS failures retry up to three attempts. Every import is narrated as its
own audiobook. Deleting one mid-narration stops the worker at its next chunk.

### Audio format and size

Each chapter is stored as **AAC-LC, 32 kbps mono at 24 kHz, in an M4A file**: about
**15 MB per hour** of narration, so a typical 10-hour audiobook takes about 150 MB. The
providers answer in MP3 (Fish Audio, Gemini) or raw 16-bit PCM (HeyGen), which as WAV is
~317 MB per hour at 44.1 kHz, up to ~3 GB a book. A finished chapter is compressed with
ffmpeg from its scratch file before it is stored; an MP3 that compression would not shrink
by at least a third (one already near 32 kbps) is kept as the provider made it. Storage
limits count the stored, compressed bytes; while a chapter is still being narrated its PCM
counts as what its length will take compressed.

AAC rather than Opus: the iOS app supports iOS 17 and plays through AVPlayer, which opens
Ogg Opus only from iOS 18.4 (and misreports its length) and WebM not at all, and Safari reads
Ogg Opus only from 18.4 too. M4A plays in AVPlayer and in every browser's `<audio>`. Chapters stored before compression (`.mp3`, `.wav`) keep playing as they are,
with their own content types; they are not re-encoded.

At 15 MB an hour, the default 8 GiB local cap holds about 570 hours (some 55 ten-hour
books), and a bucket of 1,000 such books is about 150 GB.

The Render blueprint mounts a 10 GB persistent disk. The default 8 GiB audio cap and a
256 MiB free-space check stop work before normal audio growth consumes the disk; queue,
metadata, scratch, WAL and backups also need space. Failed audiobooks may retain completed
chapters for playback and count against the cap. Audio has no automatic eviction: monitor
storage and expand it, or delete audiobooks (`DELETE /me/audiobooks/:id`). Back up SQLite and local
audio together. Queue payload deletion is logical cleanup; backups can retain earlier data.
This is a bounded single-server deployment, not horizontal generation scaling. Multiple API
instances/workers require a shared database and job-claiming/lease design first.

### S3-compatible audio storage

For production audio delivery, configure a private bucket (AWS S3, Cloudflare R2, or another
S3-compatible service):

```bash
AUDIO_S3_BUCKET=exalt-audio
AUDIO_S3_ENDPOINT=https://your-s3-compatible-endpoint
AUDIO_S3_REGION=auto
AUDIO_S3_ACCESS_KEY_ID=your-server-access-key
AUDIO_S3_SECRET_ACCESS_KEY=your-server-secret-key
```

Use the actual AWS region for AWS S3. Keys remain server-side. The worker writes a chapter
locally, compresses it, uploads it to `audio/<generation>/<chapter>.m4a` (`audio/mp4`), then publishes the
track row and deletes the scratch copy. Covers go to `covers/<book>.<ext>`. `/audio/...` and
`/covers/...` check access, then redirect S3 objects to a signed GET URL valid for one hour, so the bucket serves playback/byte ranges directly. Configure bucket
CORS to allow the app's origins, GET/HEAD, the Range header, and exposure of Content-Range,
Accept-Ranges and Content-Length. Objects keep the content type they were uploaded with,
so older `.mp3` and `.wav` objects still play.

SQLite records each track's storage backend, so existing local tracks keep playing after S3
is enabled. Existing files are not automatically migrated, and changing buckets/endpoints
requires copying their objects with the same keys. Bucket provisioning, backups, retention
rules and storage billing remain deployment configuration; the code does not create cloud
resources.

With a bucket configured, the container also keeps SQLite in it: `deploy/start.sh` runs the
server under [Litestream](https://litestream.io) (`deploy/litestream.yml`), which restores the
database from `db/` in the bucket when the container starts without one and copies each change
there about once a second. A host without a lasting disk (Render's free instance) then loses at
most the last second of writes on a restart or deploy. Run one container per bucket: two would
write over each other's copy. Without a bucket, the database lives only on the container's disk.

For capacity planning, a 10-hour MP3 at 64 kbit/s is about **288 MB**; at 128 kbit/s it is
about **576 MB**. Actual provider output determines the size. The default 2 GiB per-generation
cap stops larger output; PCM/WAV reaches it much sooner. One stored version serves every
listener; playback does not trigger fresh TTS calls.

## Accounts

Sign in with Google, as `../exact/docs/recipes/sign-in.md` describes. The app shows Google's own
button on the lander, Library and the Import sheet; in the iPhone app the sheet also offers Apple
(below). It asks the server for a single-use nonce, and
the provider signs an ID token over that nonce. `server/auth.ts` checks the token's signature
against the provider's published keys, along with its issuer, audience, expiry and nonce. Then it
answers a session token of Exalt's own: the app keeps it in its secret store and sends it as a
bearer token. `POST /audiobooks` needs one, and each audiobook records the account
that made it (`generations.user_id`). On the web, the provider returns to `/sign-in/return` on the
server, which hands the page a single-use handle for the token.

A signed-in listener's place in each audiobook follows them between devices. The player saves it
every 15 seconds while it plays, at a pause and at a chapter's change; `app.ts` keeps it on the
device and, with a session, sends it to `PUT /me/places/:gen`. The Library, the dock and the player read
`GET /me/places` and take the newest of the device's and the server's places for each audiobook, by
when it was heard (a device clock ahead of the server's counts as the server's now). A book finished
on one device leaves the others' Library and dock. Signed out, places stay on the device and are never sent.

Register these clients, then set them for both the build (`app.json` `env`) and the server:

| Variable | Default (a placeholder) | What it is |
| --- | --- | --- |
| `GOOGLE_WEB_CLIENT_ID` | `exalt-web.apps.googleusercontent.com` | Google OAuth web client; redirect URI `<PUBLIC_URL>/sign-in/return` |
| `GOOGLE_IOS_CLIENT_ID` | `exalt-ios.apps.googleusercontent.com` | Google OAuth iOS client |
| `GOOGLE_IOS_URL_SCHEME` | `com.googleusercontent.apps.exalt-ios` | The iOS client's "iOS URL scheme" (its reversed client ID): the iPhone app's Google callback |
| `APPLE_SERVICES_ID` | `app.exalt.audiobooks.web` | Sign in with Apple's Services ID; return URL `<PUBLIC_URL>/sign-in/return` |

In the iPhone app, "Get started" opens a sheet of Apple's and Google's buttons. exact doesn't build
either provider's native sign-in yet, so both run in the system browser sheet: Google through
`@exact/oauth` (the server checks the access token at `POST /sign-in/google`), Apple through its web
sign-in, whose return route sends the sheet back to `app.exalt.audiobooks:/signed-in`.

Tests sign in with no network. `bun test server` checks tokens signed by Exact's fixture provider
(`../exact/packages/sign-in/test/idp.mjs`). Under `--offline`, `SIGN_IN_TEST_KEYS=<keys file>`
makes the server trust that provider's key instead of Apple's and Google's.

`bun server/index.ts --offline` voices with silence (the `exalt/silence` model), so it works
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
- Cap how many audiobooks each account makes per day.
- Read PDF metadata (title, author) as EPUB's is read.
- Shared database and leased worker jobs for horizontal generation scaling.
- Audio retention/deletion controls and storage usage reporting.
