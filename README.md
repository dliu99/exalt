# Exalt

A minimal, open audiobook app built with [Exact](https://github.com/expo/exact).

- **Import a book.** A signed-in person uploads their own EPUB, PDF or TXT, or pastes a link to
  one, and chooses a voice model. The server splits the file into chapters and narrates the
  first; an EPUB's title, author and cover come from its package file.
- **Chapters on request.** The rest are narrated one at a time, when someone asks: the player's
  chapter list has **Generate** beside every chapter not yet narrated (anyone signed in, for a
  shared audiobook; only its owner, for a private one), with at most three chapters waiting or
  narrating per account at once. A chapter plays from its first part, seconds after Generate,
  while the rest of it is narrated; and a signed-in listener's next chapter is narrated ahead of
  them as they reach each one. Each narrated chapter is one stored audio file.
- **Your library.** Everything you import is yours: listed with its progress, renamed, shared or
  kept private, deleted (its audio with it).
- **Browse.** Each audiobook has a share switch, on by default. Shared ones with a narrated
  chapter appear in a public Browse feed with their cover, title and author, for anyone to play.
- **Listen anywhere.** Playback lives at the app level: a mini player sits with the dock while
  you move between Library, Browse and Voices, with a sleep timer and downloads for offline
  listening. The player plays narrated chapters in order and stops at one that isn't narrated
  yet, offering to narrate it.

Exalt opens on Sign in with Google (the offline server used by tests leaves the door open).

Sharing asks the importer to confirm the book is in the public domain or that they hold the
rights to share it; a private audiobook needs no confirmation and is played only by its owner,
on signed URLs. Exalt has no book catalog and finds no books: it narrates what you bring, a file
or a link to your own copy.

## Layout

| Path | What it is |
| --- | --- |
| `app.contract` | The screens: Browse, library, import sheet, player, mini player |
| `app.ts` | The app's data module: talks to the server |
| `app.test.contract` | Tests, run against the server in offline mode |
| `server/index.ts` | Bun HTTP server: imports, library, Browse, covers, audio with byte ranges |
| `server/auth.ts` | Accounts: checks Apple's and Google's ID tokens, issues session tokens |
| `server/db.ts` | SQLite schema: `books`, `generations` (with `public`), `tracks`, `settings` |
| `server/signing.ts` | Signed, expiring URLs for private audiobooks' audio and covers |
| `server/places.ts` | Where each signed-in listener is in each audiobook, so their devices carry over |
| `server/parse.ts` | EPUB / PDF / TXT to chapters (PDF ligatures read as their letters), an EPUB's title, author and cover, and chapters to parts for TTS |
| `server/tts.ts` | Text to speech through an OpenAI-compatible `/audio/speech` endpoint, two parts at a time |
| `server/live.ts` | A chapter while it is narrated: its parts so far as one AAC stream, playable before it is done |
| `server/link.ts` | Importing by link: downloads a pasted EPUB/PDF/TXT link from public HTTPS hosts only |
| `server/encode.ts` | Compresses each narrated chapter to AAC in M4A with ffmpeg before it is stored |
| `server/jobs.ts` | Durable SQLite queue: narrating chapters on request, admission limits, deletion |
| `server/storage.ts` | Local or S3-compatible chapter audio and cover storage |

## Routes

Signed-in routes take `Authorization: Bearer <token>`. Cover and audio `src` values are paths on
the server (`/covers/…`, `/audio/…`); a private audiobook's carry `?exp=…&sig=…`.

| Route | What it does |
| --- | --- |
| `POST /audiobooks?name=&model=&voice=&voiceName=&by=&title=&author=&public=1\|0&rights=1\|0&link=` | The file is the body, or `link` names an `https://` address to download it from. Sharing (`public=1`, the default) needs `rights=1`. Answers `202 {ok, id}`; a link this person already imported with the same voice answers `200 {ok, id, reused: true}` |
| `GET /browse?q=` | Shared audiobooks with a narrated chapter, newest first (at most 100); `q` matches title or author |
| `GET /me/audiobooks` | The signed-in person's audiobooks, every status, newest first |
| `PATCH /me/audiobooks/:id` | `{public?, rights?, title?, author?}`; sharing needs `rights: true` |
| `DELETE /me/audiobooks/:id`, `DELETE /generations/:id` | Removes it, its audio, and its book and cover, even mid-narration (its owner only) |
| `GET /generations/:id` | One audiobook, its chapters (status, progress, `src` once playable) and tracks: shared ones for anyone, private ones for their owner |
| `POST /generations/:id/chapters/:idx` | Generate: narrate that chapter. `202 {ok, status: 'queued', mine, limit}`, or `200` when it is already queued, narrating or narrated; `429` at the account's three or a full queue |
| `GET /audio/*`, `GET /covers/*` | Audio (byte ranges; a narrating chapter streams) and covers; private ones only on a valid signature |
| `GET /me/places`, `PUT /me/places/:gen` | Listening places, below; a place also narrates the next chapter ahead |
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
| `TTS_PARALLEL` | 2 | Parts of a chapter asked of the provider at once (one at a time for ten minutes after a 429) |
| `DB` | `data.db` | SQLite file |
| `AUDIO_DIR` | `audio/` beside `DB` | Local audio and scratch directory (on persistent disk) |
| `MAX_BOOK_CHARACTERS` | 5000000 | Maximum extracted characters in one book |
| `MAX_GENERATION_BYTES` | 2 GiB | Maximum stored (compressed) audio bytes for one generation |
| `AUDIO_MAX_BYTES` | 8 GiB local; 0 with S3 | Cap on stored (compressed) chapter bytes; 0 means no aggregate cap |
| `AUDIO_SIGNING_KEY` | generated once, kept in SQLite `settings` | HMAC key for private audio and cover URLs; changing it ends links already handed out |
| `GOOGLE_CLIENT_SECRET` | none | The Google web client's secret, for the web sign-in's code exchange |
| `PUBLIC_URL` | `API_BASE_URL` | The server's public address (the web sign-in's return route is under it) |
| `WEB_ORIGINS` | none | The site's origins, comma-separated, that the web sign-in may return to (loopback ones always may) |

## Import by link

On **Import a Book**, paste a link to an EPUB, PDF or TXT in the **Link** row instead of choosing
a file, and press **Narrate**. The same share switch and rights confirmation apply. The server downloads it during
the request, as it reads an upload, with these safeguards: HTTPS only (port 443, no user name
or password in the link), a 50 MiB cap enforced while reading, a 90-second limit, and a check of
the first bytes (`%PDF-`, a ZIP for EPUB, or text with no NUL bytes; a web page or JSON is
refused). The file's extension comes from what it is, not from the link. It must not reach the
server's own network: before anything is reserved, and again at each of up to five redirects
(followed by hand), the host is resolved and refused unless every address is public, so
loopback, private, link-local (cloud metadata at `169.254.169.254`), shared (`100.64.0.0/10`),
multicast, reserved and documentation ranges are out, as are IPv6 ULA, link-local and
IPv4-mapped forms of those. The download then connects to the address that was checked (the
name goes in `Host` and as TLS's server name, and the certificate must match it), so a second
DNS answer can't redirect it inside. The link itself is not kept: its audiobook records a hash
(`link:<sha256 prefix>`), which finds the same person's audiobook of the same link (same model
and voice) again instead of narrating it twice. Link downloads share the two upload slots. The
offline server imports only its sample link, `https://books.example/a-quiet-harbour.txt`, with
no network.

## Storage and backend capacity

| Data | Storage | Retention |
| --- | --- | --- |
| Book metadata, accounts, hashed sessions, source hashes, share switch, narration settings and progress | SQLite at `DB` | Retained until the audiobook is deleted |
| Queued whole-book job text (only from before chapters were narrated on request) | SQLite `generation_jobs` | Removed once its chapters are listed, or on failure or deletion |
| Each chapter's extracted text | SQLite `chapters.text` | Kept until that chapter is narrated, then removed; removed with its audiobook |
| Source EPUB/PDF/TXT (uploaded or from a pasted link) | Worker/request memory, at most 50 MiB per file | Discarded after parsing; never archived |
| A pasted link | Not kept; its audiobook's `source_ref` is a hash of it (`link:…`) | The hash is retained with the audiobook |
| Incomplete chapter audio (raw PCM or MP3) | `AUDIO_DIR/.tmp` | Removed after compression and upload, or failure; interrupted chapter is overwritten on resume |
| A narrating chapter's parts so far, as AAC (`<gen>-<chapter>.live.aac`), what listeners play before it is stored | `AUDIO_DIR/.tmp`, about 15 MB an hour | Removed once the chapter is stored or fails (a listener already reading it keeps its open copy until done); a restart starts the chapter over |
| Finished chapter audio (M4A) | Persistent local disk or S3-compatible bucket | Retained until its audiobook is deleted |
| Covers (an EPUB's cover image, at most 5 MB, JPEG/PNG/WebP/GIF) | `AUDIO_DIR/covers/<book>.<ext>` or bucket key `covers/<book>.<ext>` | Retained until its book is deleted |
| Listening position | The listener's device; for a signed-in listener also SQLite `places` (chapter, time, when), newest wins | Device: until cleared. Server: retained, a finished book's row marked finished; removed with its audiobook |
| Voice preference | The listener's device | Until cleared |

The backend runs **one instance and one generation worker**. An import is split into chapters
as it arrives and its first chapter is asked for; SQLite is then a durable queue of chapters to
narrate, in the order they were asked for. A restart resumes queued work; the chapter it was
narrating starts over and may repeat TTS calls, finished chapters do not. At most 20 pieces of
work (chapters waiting or narrating, imports being prepared) are queued at once, and at most
**three per account**: an import being prepared counts as one (it asks for its first chapter),
and a fourth Generate is refused (`429`) until one finishes. Concurrent upload parsing (and
link downloads) is capped at two. Every import is its own audiobook. Deleting one mid-narration
stops its chapter at the next part, and what it was writing is removed.

**Time to first audio.** A chapter is narrated in parts that start at about 600 characters and
double to 3,000, two asked of the provider at once (`TTS_PARALLEL`), and written in order. A
provider that answers `429` is asked one part at a time for the next ten minutes, and no part
is asked of it before its `retry-after` has passed. As each part is narrated it is encoded into
the chapter's live AAC stream (`server/live.ts`, one ffmpeg per narrating chapter), and the
chapter's `src` in `GET /generations/:id` appears with its first part, at the address its
M4A will be stored under (signed, for a private audiobook). `/audio/<gen>/<chapter>.m4a` answers
that stream (`audio/aac`, no byte ranges) until the M4A is stored, holding the response open,
with no idle timeout, until the last part is in; then the same address serves the M4A, so a
player that started early plays on without reloading. Each chapter is encoded twice (the live
stream, then the stored M4A from the raw parts): at ffmpeg's ~100× real time, about 36
CPU-seconds each per narrated hour. A failed chapter ends its stream in an error. Measured on a
12,000-character chapter:

| From Generate to first audio | Before | After |
| --- | --- | --- |
| Offline silence model (answers instantly) | 55 ms | 56 ms |
| A simulated provider at a real one's pace (2 s + 20 ms a character) | 255 s | 14 s (whole chapter 137 s) |
| Fish Audio S2.1 Pro (free) through OpenRouter | 282 s | 17 s (whole chapter 161 s) |

**Narrating ahead.** When a signed-in listener's place (`PUT /me/places/:gen`) reaches a
chapter, the one after it is asked for on their behalf if nobody has asked (`idle`), so it is
narrated before they get there. It counts toward their three; at the limit, with the queue
full or storage short, nothing is asked and the place is kept as usual. A chapter that failed
waits for its Retry. Books default to a limit of five million extracted characters, and each
audiobook to 2 GiB stored. EPUB expansion is bounded and chapter audio is written to scratch
part by part, rather than accumulated in memory. Transient TTS failures retry up to three
attempts; a chapter that still fails shows **Retry**, its text kept.

Narrating on request means a book costs only the chapters people listen to. Because each
chapter's text is kept until it is narrated, an imported audiobook holds its book's text in
SQLite (up to `MAX_BOOK_CHARACTERS`, five million by default) until every chapter is narrated
or the audiobook is deleted. Audiobooks made before this change kept no text once their job
ended: their narrated chapters play, and any they never narrated show as unavailable.

`--offline` takes the test driver's persona tokens (`Authorization: Bearer ada`, what a test's
`request … as ada` sends) as accounts of their own, so screen tests can import audiobooks and
narrate chapters as other people. Only the offline server does.

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
metadata, scratch, WAL and backups also need space. Failed chapters keep the chapters already
narrated, which count against the cap. Audio has no automatic eviction: monitor storage and
expand it, or delete audiobooks (`DELETE /me/audiobooks/:id`). Back up SQLite and local
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
an unset voice uses the model's first. HeyGen answers only in 16-bit PCM, the others MP3; either
way a chapter's parts are joined and compressed to one M4A. Under `--offline`, setting
`TTS_BASE_URL` (a test's own provider) adds the `TTS_MODELS` to the silence model. Run the server from the repo root so Bun loads
`.env`, or pass `--env-file`.

## Next

- Cap how many chapters each account narrates per day, beside the three-at-once limit.
- More than one narration worker, for a provider that allows it.
- Read PDF metadata (title, author) as EPUB's is read.
- Shared database and leased worker jobs for horizontal generation scaling.
- Audio retention/deletion controls and storage usage reporting.
