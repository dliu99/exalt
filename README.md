# Exalt

A minimal, open audiobook app built with [Exact](https://github.com/expo/exact).

- **One record per book.** Books come from Open Library (title, author, year, cover), keyed by
  their work id. Every audiobook anyone makes of a book hangs off that one record.
- **Make an audiobook** by selecting a LibGen EPUB/PDF (or an optional Z-Library source),
  pasting a link to an EPUB, PDF or TXT, or uploading one, then choosing a voice model. The
  server splits the file into chapters and narrates the first. The rest are narrated one at a
  time, when someone asks: each version's chapter list (on the player) has **Generate** beside
  every chapter not yet narrated. Anyone signed in may press it, with at most three chapters
  waiting or narrating per account at once. Each narrated chapter is one stored audio file, kept
  for everyone. A chapter plays from its first part, seconds after Generate, while the rest of
  it is narrated; and a signed-in listener's next chapter is narrated ahead of them as they
  reach each one.
- **A book's page** puts its one action in the dock on a phone, beside Back: **Play** once a
  version has a narrated chapter, **Generate** until then (signed out, it asks you to sign in
  first). Below the title are the book's numbers: when it was published, its audiobooks, and how
  many chapters the first has and has narrated. Generate opens **Import**, where the book comes from: upload an EPUB, PDF or TXT, pick a copy the server can download, paste a link to one, or search
  LibGen, Z-Library or the web in the browser to download it and upload it.
- **Listen.** A book's page shows a sample (the first narrated chapter of its first
  audiobook), every version people have made, and a link to its Goodreads reviews. The player
  plays narrated chapters in order and stops at one that isn't narrated yet, offering to
  narrate it. The person who made a version can delete it, its audio with it.

Exalt opens on Sign in with Google: nothing is reachable without an account (the offline server used by tests leaves the door open).

Audiobooks are public. The upload form asks the uploader to confirm the book is in the public
domain or that they hold the rights to share it.

## Layout

| Path | What it is |
| --- | --- |
| `app.contract` | The screens: library and search, book, Import, player |
| `app.ts` | The app's data module: talks to the server |
| `app.test.contract` | Tests, run against the server in offline mode |
| `server/index.ts` | Bun HTTP server: catalog, uploads, audio with byte ranges |
| `server/auth.ts` | Accounts: checks Apple's and Google's ID tokens, issues session tokens |
| `server/db.ts` | SQLite schema: `books`, `generations`, `tracks` |
| `server/places.ts` | Where each signed-in listener is in each audiobook, so their devices carry over |
| `server/parse.ts` | EPUB / PDF / TXT to chapters, and chapters to chunks for TTS |
| `server/tts.ts` | Text to speech through an OpenAI-compatible `/audio/speech` endpoint, two parts at a time |
| `server/live.ts` | A chapter while it is narrated: its parts so far as one AAC stream, playable before it is done |
| `server/link.ts` | Importing by link: downloads a pasted EPUB/PDF/TXT link from public HTTPS hosts only |
| `server/encode.ts` | Compresses each narrated chapter to AAC in M4A with ffmpeg before it is stored |
| `server/jobs.ts` | Durable SQLite queue: preparing versions, narrating chapters on request, admission limits |
| `server/libgen.ts` | LibGen discovery, JSON metadata and verified downloads |
| `server/storage.ts` | Local or S3-compatible chapter audio storage |

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
| `LIBGEN_ENABLED` | `1` | Set to `0` to disable LibGen search and downloads |
| `LIBGEN_MIRRORS` | `https://libgen.li,https://libgen.bz` | Comma-separated trusted HTTPS origins |
| `LIBGEN_DOWNLOAD_ORIGINS` | none | Additional exact trusted HTTPS origins for file redirects |
| `GOOGLE_CLIENT_SECRET` | none | The Google web client's secret, for the web sign-in's code exchange |
| `PUBLIC_URL` | `API_BASE_URL` | The server's public address (the web sign-in's return route is under it) |
| `WEB_ORIGINS` | none | The site's origins, comma-separated, that the web sign-in may return to (loopback ones always may) |

## LibGen search and downloads

LibGen is enabled by default, with no account or API key. Search includes its EPUB/PDF
results alongside the metadata catalog; `BOOK_PROVIDER=libgen` searches it alone. On a
book's **Import** page, choose a file under **Download**, select a voice, confirm
sharing rights and press **Make**. The server responds with a generation ID immediately
(`202`); the worker downloads and verifies the file, splits it into chapters and narrates the
first. Source failures appear on the book's generation status. Uploads remain available.

The adapter uses HTML search, `json.php` for edition/file details, and the download landing
page to resolve a short-lived link. Requests have timeouts, bounded responses and mirror
fallback. Repeated searches coalesce and cache for ten minutes, with four concurrent
upstream searches allowed. Only EPUB/PDF downloads under 50 MiB are accepted, redirect
hosts are checked (configured mirrors and numbered `cdn*.booksdl.lc` download hosts), and downloaded bytes must match the selected MD5. Mirror HTML and
availability can change; this is an optional external provider, not an uptime guarantee.

## Import by link

On **Import**, paste a link to an EPUB, PDF or TXT (it sets any chosen download or file
aside) and press **Make**. The server downloads it during the request, as it reads an upload,
with the LibGen downloads' safeguards: HTTPS only (port 443, no user name or password in the
link), a 50 MiB cap enforced while reading, a 90-second limit, and a check of the first bytes
(`%PDF-`, a ZIP for EPUB, or text with no NUL bytes; a web page or JSON is refused). The file's
extension comes from what it is, not from the link. It must not reach the server's own
network: before anything is reserved, and again at each of up to five redirects (followed by
hand), the host is resolved and refused unless every address is public, so loopback, private,
link-local (cloud metadata at `169.254.169.254`), shared (`100.64.0.0/10`), multicast, reserved
and documentation ranges are out, as are IPv6 ULA, link-local and IPv4-mapped forms of those.
The download then connects to the address that was checked (the name goes in `Host` and as
TLS's server name, and the certificate must match it), so a second DNS answer can't redirect it
inside. The link itself is not kept: its version records a hash (`link:<sha256 prefix>`), which
finds the same link's audiobook again (same book, model and voice) instead of narrating it
twice. Link downloads share the two upload slots. The offline server imports only its sample
link, `https://books.example/a-quiet-harbour.txt`, with no network.

## Storage and backend capacity

| Data | Storage | Retention |
| --- | --- | --- |
| Book metadata, accounts, hashed sessions, source IDs/hashes, narration settings and progress | SQLite at `DB` | Retained |
| Queued source reference (a download not yet prepared) | SQLite `generation_jobs` | Removed once the version is prepared, or fails |
| Each chapter's extracted text | SQLite `chapters.text` | Kept until that chapter is narrated, then removed; removed with its version |
| Source EPUB/PDF/TXT (uploaded, downloaded or from a pasted link) | Worker/request memory, at most 50 MiB per file | Discarded after parsing; never archived |
| A pasted link | Not kept; its version's `source_ref` is a hash of it (`link:…`) | The hash is retained with the version |
| Incomplete chapter audio (raw PCM or MP3) | `AUDIO_DIR/.tmp` | Removed after compression and upload, or failure; interrupted chapter is overwritten on resume |
| A narrating chapter's parts so far, as AAC (`<gen>-<chapter>.live.aac`), what listeners play before it is stored | `AUDIO_DIR/.tmp`, about 15 MB an hour | Removed once the chapter is stored or fails (a listener already reading it keeps its open copy until done); a restart starts the chapter over |
| Finished chapter audio (M4A) | Persistent local disk or S3-compatible bucket | Retained and shared by listeners |
| Listening position | The listener's device; for a signed-in listener also SQLite `places` (chapter, time, when), newest wins | Device: until cleared. Server: retained, a finished book's row marked finished |
| Voice preference | The listener's device | Until cleared |

The backend runs **one instance and one generation worker**. SQLite is a durable queue of
two kinds of work: preparing a version (download, split into chapters) and narrating one
chapter. Preparing goes first, since a new version's first chapter waits on it; chapters are
narrated in the order they were asked for. A restart resumes queued work; the chapter it was
narrating starts over and may repeat TTS calls, finished chapters do not. At most 20 pieces of
work (chapters waiting or narrating, versions being prepared) are queued at once, and at most
**three per account**: a version being prepared counts as one (it asks for its first chapter),
and a fourth Generate is refused (`429`) until one finishes. Concurrent upload parsing (and
link downloads) is capped at two.

**Time to first audio.** A chapter is narrated in parts that start at about 600 characters and
double to 3,000, two asked of the provider at once (`TTS_PARALLEL`), and written in order. A
provider that answers `429` is asked one part at a time for the next ten minutes, and no part
is asked of it before its `retry-after` has passed. As each part is narrated it is encoded into
the chapter's live AAC stream (`server/live.ts`, one ffmpeg per narrating chapter), and the
chapter's `src` in `GET /generations/:id` appears with its first part, at the address its
M4A will be stored under. `/audio/<gen>/<chapter>.m4a` answers that stream (`audio/aac`, no
byte ranges) until the M4A is stored, holding the response open, with no idle timeout, until
the last part is in; then the same address serves the M4A, so a player that started early
plays on without reloading. Each chapter is encoded twice (the live stream, then the stored
M4A from the raw parts): at ffmpeg's ~100× real time, about 36 CPU-seconds each per narrated
hour. A failed chapter ends its stream in an error. Measured on a 12,000-character chapter:

| From Generate to first audio | Before | After |
| --- | --- | --- |
| Offline silence model (answers instantly) | 55 ms | 56 ms |
| A simulated provider at a real one's pace (2 s + 20 ms a character) | 255 s | 14 s (whole chapter 137 s) |
| Fish Audio S2.1 Pro (free) through OpenRouter | 282 s | 17 s (whole chapter 161 s) |

**Narrating ahead.** When a signed-in listener's place (`PUT /me/places/:gen`) reaches a
chapter, the one after it is asked for on their behalf if nobody has asked (`idle`), so it is
narrated before they get there. It counts toward their three; at the limit, with the queue
full or storage short, nothing is asked and the place is kept as usual. A chapter that failed
waits for its Retry. Books default to a limit of five million extracted characters, and each generated
audiobook to 2 GiB stored. EPUB expansion is bounded and chapter audio is written to scratch
chunk by chunk, rather than accumulated in memory. Transient TTS failures retry up to three
attempts; a chapter that still fails shows **Retry**, its text kept. The same source, book,
model and voice reuse an existing queued/working/ready generation instead of generating again.

Narrating on request means a book costs only the chapters people listen to. Because each
chapter's text is kept until it is narrated, a prepared version holds its book's text in
SQLite (up to `MAX_BOOK_CHARACTERS`, five million by default) until every chapter is narrated
or the version is deleted. Versions made before this change kept no text once their job ended:
their narrated chapters play, and any they never narrated show as unavailable.

`--offline` takes the test driver's persona tokens (`Authorization: Bearer ada`, what a test's
`request … as ada` sends) as accounts of their own, so screen tests can make versions and
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
narrated, which count against the cap. Audio has no automatic eviction: its maker can delete a
version (`DELETE /generations/:id`), which removes its audio from disk or the bucket; otherwise
monitor storage and expand it or remove obsolete versions operationally. Back up SQLite and local
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
track row and deletes the scratch copy. `/audio/...` redirects S3 tracks to a signed GET URL
valid for one hour, so the bucket serves playback/byte ranges directly. Configure bucket
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

## Z-Library search and downloads

Connect an existing Z-Library session on the **server**:

```bash
ZLIBRARY_BASE_URL=https://your-working-domain.example
ZLIBRARY_USER_ID=your_remix_userid_cookie
ZLIBRARY_USER_KEY=your_remix_userkey_cookie
```

Use the HTTPS origin of your working Z-Library domain, and the `remix_userid` and
`remix_userkey` cookies from your signed-in browser session. Keep these values in the
server environment, alongside `OPENROUTER_API_KEY`; never add them to `app.json` or a client build.
This uses Z-Library's unofficial mobile EAPI, whose availability and domains can change.
Protocol references: [KOReader client](https://github.com/ZlibraryKO/zlibrary.koplugin) and
[EAPI client documentation](https://github.com/heartleo/zlib/blob/main/docs/eapi.md).

Search includes Z-Library books alongside the configured metadata catalog, merging editions.
You can also set `BOOK_PROVIDER=zlibrary` to search it alone. Open a book, choose **New
Audiobook**, select a Z-Library file, choose the voice, confirm sharing rights, and press
**Make**. The durable worker downloads the selected EPUB/PDF, extracts chapters, and sends their
text through the OpenRouter TTS queue. Uploads remain available when no download
is found or Z-Library is disconnected.

The session belongs to the server: every signed-in creator uses that account's download
allowance. Expired sessions, quota limits and unavailable downloads return an error on the
Import page. No download happens until the creator confirms Make. Files are limited to
50 MiB for processing. If your domain serves downloads through another trusted HTTPS origin, list its
exact origin in `ZLIBRARY_DOWNLOAD_ORIGINS` (comma-separated); redirects are checked and
session credentials are sent only to `ZLIBRARY_BASE_URL`.

## Accounts

Sign in with Google, as `../exact/docs/recipes/sign-in.md` describes (and with Apple in the iPhone
app). The lander has its own way in. Anything else that needs an account (Generate, a chapter's
Generate, Make) opens one sheet to log in or sign up, then carries on with what was asked; closing
it carries nothing on. On the web the sheet holds Google's own button, in the iPhone app Continue
with Apple and Continue with Google. It asks the server for a single-use nonce, and
the provider signs an ID token over that nonce. `server/auth.ts` checks the token's signature
against the provider's published keys, along with its issuer, audience, expiry and nonce. Then it
answers a session token of Exalt's own: the app keeps it in its secret store and sends it as a
bearer token. `POST /books/:id/generations` needs one, and each audiobook records the account
that made it (`generations.user_id`). On the web, the provider returns to `/sign-in/return` on the
server, which hands the page a single-use handle for the token.

A signed-in listener's place in each audiobook follows them between devices. The player saves it
every 15 seconds while it plays, at a pause and at a chapter's change; `app.ts` keeps it on the
device and, with a session, sends it to `PUT /me/places/:gen`. Home and the player read
`GET /me/places` and take the newest of the device's and the server's places for each audiobook, by
when it was heard (a device clock ahead of the server's counts as the server's now). A book finished
on one device leaves the others' shelves. Signed out, places stay on the device and are never sent.

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

`bun server/index.ts --offline` searches a two-book fixture and voices with silence, so it works
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
- Ratings of versions; reviews beside the Goodreads link.
- Shared database and leased worker jobs for horizontal generation scaling.
- Audio retention/deletion controls and storage usage reporting.
