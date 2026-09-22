# YouTube API Service

A small TypeScript/Express microservice that fetches **YouTube transcripts** (via
[yt-dlp](https://github.com/yt-dlp/yt-dlp)) and, optionally, **videos from any of
your playlists** (via the YouTube Data API v3 with OAuth2). Built to be called from
n8n over a private network and to feed a local LLM with clean transcript text.

## Features

- Transcripts for single videos or sequential batches, backed by a pinned yt-dlp
  binary (no unofficial scraping libraries)
- Language selection (`?lang=`), manual vs. auto-generated track reporting, and a
  cleaned plain-text mode (`?format=text`) for LLM input
- Precise error semantics so automations can react: `404` no captions, `503`
  blocked/rate-limited (retry later), `500` everything else
- Optional OAuth2 playlist access (list playlists, fetch all videos of a playlist)
- **Transcript-only mode** when no OAuth credentials are configured
- Honest `/health`: reports whether the stored refresh token still works and which
  yt-dlp version is installed
- Basic authentication on all data endpoints; single-host `docker compose` deployment

> **Watch Later is not accessible via the API.** YouTube removed API access to the
> `WL` playlist in September 2016. See [Watch Later workaround](#watch-later-workaround).

## Modes

| Env vars set | Mode | OAuth/playlist routes |
|---|---|---|
| only `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` | **transcript-only** | answer `503 { "error": "oauth disabled" }` |
| + `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `OAUTH_REDIRECT_URI` (all three) | **full** | enabled |

Setting only one or two of the OAuth variables is a configuration error and the
service refuses to start, naming the missing ones.

## Configuration

Copy `.env.example` to `.env` and fill it in. Empty values count as unset.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | yes | – | Credentials for all data endpoints |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `OAUTH_REDIRECT_URI` | all or none | – | Enables OAuth + playlist routes |
| `DEFAULT_PLAYLIST_ID` | no | – | Fallback playlist for `GET /videos` |
| `TOKEN_PATH` | no | `/data/tokens.json` | Where OAuth tokens are persisted |
| `TRANSCRIPT_BATCH_DELAY_MS` | no | `3000` | Pause between videos in `POST /batch-transcripts` |
| `TRANSCRIPT_BATCH_MAX` | no | `50` | Max `videoIds` per batch request |
| `TRANSCRIPT_MAX_ATTEMPTS` | no | `2` | Attempts per video for rate-limit/timeout failures (bot checks are never retried) |
| `TRANSCRIPT_RETRY_DELAY_MS` | no | `5000` | Pause before a retry |
| `YTDLP_TIMEOUT_MS` | no | `90000` | Deadline for one yt-dlp run |
| `YTDLP_PATH` | no | `yt-dlp` | Path to the yt-dlp binary |
| `YTDLP_JS_RUNTIME` | no | `node` | Value for `yt-dlp --js-runtimes`; `none` omits the flag |
| `HEALTH_OAUTH_CACHE_MS` | no | `300000` | How long `/health` caches the OAuth refresh check |
| `PORT` | no | `3000` | Listen port (fixed to 3000 inside the compose setup) |
| `BIND_ADDR`, `HOST_PORT`, `YTDLP_VERSION` | compose only | `127.0.0.1`, `3000`, pinned | Host-side settings, see [Deployment](#deployment-single-host-docker-compose) |

### OAuth prerequisites (full mode only)

Google Cloud project with **YouTube Data API v3** enabled → OAuth 2.0 credentials of
type **Web application** → add `https://<your-host>/oauth/callback` to the authorized
redirect URIs → put client ID, secret and that redirect URI into `.env`.

You do not need to publish/verify the app if you are its only user, but note the
consequence: **in Google "Testing" mode refresh tokens expire after 7 days.** See
[Token issues](#token-issues).

## Deployment (single host, docker compose)

Intended for a machine on a **residential connection** (YouTube blocks transcript
requests from many datacenter/VPS IP ranges) that other services reach over a
private network such as Tailscale.

```bash
cp .env.example .env          # set BASIC_AUTH_*, leave OAuth empty for transcript-only mode
# in .env: BIND_ADDR=<this host's Tailscale IP, 100.x.y.z>
docker compose up -d --build
curl "http://$(tailscale ip -4):3000/health"   # the port answers on BIND_ADDR only
```

- The port is published **only on `BIND_ADDR`**, which defaults to `127.0.0.1`
  (reachable from the host only). Set it to the host's Tailscale IP to make the
  service reachable from the tailnet and nowhere else. No router port forwarding.
- `./data` is bind-mounted to `/data` for OAuth tokens (unused in transcript-only mode).
- A named volume keeps yt-dlp's cache between restarts.
- The image bakes in the official standalone yt-dlp binary for the build platform
  (`yt-dlp_musllinux` on Alpine, checksum-verified) and uses the image's Node 24 as
  yt-dlp's JavaScript runtime. No Deno, no Python needed.

### How n8n calls it

n8n on another machine in the same tailnet uses an **HTTP Request** node with
**Basic Auth** credentials and URLs like:

```
http://<tailscale-hostname-or-ip>:3000/transcript/<videoId>?format=text
http://<tailscale-hostname-or-ip>:3000/batch-transcripts
```

Both hosts must be in the tailnet (the n8n host itself; containers on it reach
Tailscale addresses through the host's routing). Nothing here is reachable from the
public internet.

### Updating yt-dlp

YouTube changes regularly break older yt-dlp releases, so plan to rebuild. The
version is a build argument (`YTDLP_VERSION` in `.env`, default pinned in the
Dockerfile):

```bash
# check https://github.com/yt-dlp/yt-dlp/releases, then
sed -i 's/^YTDLP_VERSION=.*/YTDLP_VERSION=2026.xx.yy/' .env
docker compose build && docker compose up -d
curl -s http://127.0.0.1:3000/health | jq .transcripts   # shows the new version
```

`yt-dlp -U` is deliberately not used: the binary lives in a read-only image layer
and runs as a non-root user, so updates are reproducible image rebuilds.

### Legacy: Docker Swarm + Traefik

The previous VPS deployment file lives in `deploy/swarm/docker-stack.yml`. It is kept
as a reference only (`cd deploy/swarm` before deploying; placeholders for domain,
entrypoint, cert resolver and network must be adapted).

## API

All endpoints except `/health` require `Authorization: Basic base64(user:pass)`.

### `GET /health` (no auth)

Always answers HTTP `200`; the `status` field says whether the service is degraded,
so a broken transcript backend shows up in monitoring without flapping the container.

```json
{
  "status": "ok",
  "mode": "transcript-only",
  "oauth": "disabled",
  "transcripts": {
    "backend": "yt-dlp",
    "version": "2026.08.19",
    "ok": true,
    "jsRuntime": { "requested": "node", "detected": "node-24.21.0", "present": true },
    "ejs": "0.8.0"
  },
  "authorized": false,
  "timestamp": "2026-09-22T12:00:00.000Z"
}
```

| Field | Values | Meaning |
|---|---|---|
| `status` | `ok`, `degraded` | `degraded` when yt-dlp cannot be executed **or does not detect the requested JS runtime** |
| `mode` | `full`, `transcript-only` | Whether OAuth is configured |
| `oauth` | `disabled`, `ok`, `expired`, `unauthorized`, `error` | `ok` only if the stored refresh token **actually refreshed** (checked against Google, cached `HEALTH_OAUTH_CACHE_MS`). `expired` = Google answered `invalid_grant`. `unauthorized` = OAuth configured but no token stored yet. `error` = check failed for another reason (see `oauthDetail.error`). |
| `oauthDetail` | object | `{ status, checkedAt, error? }`, present in full mode |
| `transcripts.version` | string or `null` | Output of `yt-dlp --version`; `null` if the binary failed to run (`transcripts.error` says why) |
| `transcripts.jsRuntime` | object | `requested` = value of `YTDLP_JS_RUNTIME`; `detected` = what **yt-dlp itself** reports in its `-v` header (`node-24.21.0`, or `none`); `present` = detected and not `none`. Probed offline by running `yt-dlp -v --js-runtimes …` without a URL, so it reflects the flag real calls use, not just that a binary exists. The runtime only affects media-URL deciphering, never caption extraction, but without it yt-dlp drops the `web` client. |
| `transcripts.ejs` | string or `null` | Bundled `yt-dlp-ejs` (JS challenge solver) version |
| `authorized` | boolean | Legacy field: `true` only when `oauth` is `ok` |

### Transcripts

#### `GET /transcript/:videoId[?lang=xx][&format=json|text]`

Track selection order without `lang`: **manual captions in the video's original
language → auto-generated captions in that language → any manual track (en, de
preferred) → any auto-generated track.** Auto-*translated* tracks are never served.
With `lang`, manual then auto in that language is used (`en-US` matches `en` and
vice versa); otherwise `404` with the languages that do exist.

```json
{
  "videoId": "lXUZvyajciY",
  "lang": "en",
  "kind": "manual",
  "transcript": [
    { "text": "Today I'm speaking with Andrej Karpathy.", "duration": 4400, "offset": 48560, "lang": "en" }
  ],
  "timestamp": "2026-09-22T12:00:00.000Z"
}
```

`offset` and `duration` are **milliseconds**. `kind` is `manual` or `auto`.

`?format=text` returns one cleaned string instead of the array (auto-caption rolling
repeats removed, sound tags such as `[Music]` dropped, whitespace normalised):

```json
{ "videoId": "fW4SwcMQYdA", "lang": "de", "kind": "auto", "text": "einen wunderschönen guten Abend. Wir freuen uns sehr …", "timestamp": "…" }
```

**Error responses** (`code` is machine-readable, `reason` is human-readable):

| HTTP | Body | When |
|---|---|---|
| `404` | `{ available: false, code: "NO_CAPTIONS", reason, retryable: false }` | Video has no caption tracks at all |
| `404` | `{ available: false, code: "LANG_UNAVAILABLE", availableLanguages: { manual: [...], auto: [...] }, ... }` | Requested `lang` has no track |
| `503` | `{ retryable: true, code: "BLOCKED" \| "RATE_LIMITED" \| "TIMEOUT", reason }` | Bot check, IP block, HTTP 429, PO-token discard, or yt-dlp deadline hit — try again later |
| `500` | `{ error, reason, code: "VIDEO_UNAVAILABLE" \| "BACKEND_FAILURE", retryable: false }` | Private/removed video, yt-dlp missing or broken, unexpected error |
| `400` | `{ error }` | Invalid video id, `lang` or `format` |

All YouTube traffic is serialised inside the service, so parallel calls never burst.

#### `POST /batch-transcripts`

```json
{ "videoIds": ["lXUZvyajciY", "fW4SwcMQYdA"], "lang": "de", "format": "text" }
```

`lang` and `format` are optional and apply to every video. Videos are processed
**sequentially** with `TRANSCRIPT_BATCH_DELAY_MS` between them; at most
`TRANSCRIPT_BATCH_MAX` ids per request (`400` otherwise). Failed videos stay `null`
in `transcripts` and get an entry in `errors` with the same shape as the single-video
error bodies. **After the first `BLOCKED`/`RATE_LIMITED` result the remaining videos
are not attempted** and are reported as `code: "SKIPPED", retryable: true`, so one bad
answer does not turn into twenty more probes.

```json
{
  "transcripts": { "lXUZvyajciY": [ ... ], "fW4SwcMQYdA": null },
  "errors": { "fW4SwcMQYdA": { "code": "NO_CAPTIONS", "reason": "…", "retryable": false, "status": 404, "available": false } },
  "tracks": { "lXUZvyajciY": { "lang": "en", "kind": "manual" } },
  "timestamp": "2026-09-22T12:00:00.000Z"
}
```

Keep batches small enough for your HTTP client's timeout: each video costs roughly
the yt-dlp run (a few seconds) plus the configured delay.

### OAuth endpoints (full mode; `503 { "error": "oauth disabled" }` otherwise)

| Endpoint | Purpose |
|---|---|
| `GET /auth/url` | Returns the Google authorization URL for first-time setup |
| `GET /oauth/callback?code=…` | Where Google redirects; exchanges the code and stores tokens |
| `POST /auth/callback { "code": "…" }` | Manual fallback if the redirect cannot reach the server |

Authorization always requests a fresh refresh token (`prompt: consent`); refreshed
access tokens are written back to `TOKEN_PATH`.

### Playlist endpoints (full mode, basic auth)

| Endpoint | Purpose |
|---|---|
| `GET /playlists` | All playlists of the authorized channel (`id`, `title`, `itemCount`, …) |
| `GET /playlist/:playlistId` | All videos of a playlist (`videoId`, `title`, `channel`, ISO 8601 `duration`, thumbnails, …) |
| `GET /videos[?playlistId=…]` | Same, falling back to `DEFAULT_PLAYLIST_ID`; `400` if neither is given |

## Important notes

### Watch Later workaround

The `WL` playlist returns nothing through the API (removed September 2016, see the
[revision history](https://developers.google.com/youtube/v3/revision_history#september-15-2016)).
Use an **inbox playlist** instead:

1. Create a normal (private) playlist, e.g. "Inbox".
2. Move or copy videos from Watch Later into it (YouTube UI: select all → *Add to
   playlist* → Inbox; then clear Watch Later).
3. Process the inbox via the API: read its items, fetch transcripts, sort into topic
   playlists by adding the item there, then remove it from the inbox.

### YouTube Data API quota

| Operation | Cost |
|---|---|
| Read playlist items | 1 unit per page of up to 50 items |
| Read video details (`videos.list`) | 1 unit per page of up to 50 ids |
| Add a playlist item | 50 units |
| Remove a playlist item | 50 units |
| Daily quota | 10,000 units, reset at midnight Pacific Time |

Reading is nearly free; **sorting 100 videos into topic playlists (add + remove) costs
10,000 units — a whole day**. Transcripts do not use the Data API at all.

### Token issues

- **Google "Testing" mode: refresh tokens expire after 7 days.** The service then
  logs `invalid_grant`, `/health` reports `"oauth": "expired"`, and playlist calls
  fail. **Fix: re-authorize** — `GET /auth/url`, open the URL, approve. Deleting
  `tokens.json` alone does not help; a new consent is required. Publishing the OAuth
  app removes the 7-day limit but requires Google's verification.
- `"oauth": "unauthorized"` means no token has been stored yet: run the flow once.
- Access tokens refresh automatically; the refreshed tokens are persisted.

## n8n usage

- **Transcript for one video:** HTTP Request → GET
  `http://<tailscale-host>:3000/transcript/{{ $json.videoId }}?format=text`, Basic Auth.
  On status `404` skip the video for good; on `503` leave it for the next run; `500`
  needs a look.
- **Batch:** POST `/batch-transcripts` with 10–20 ids; iterate over `transcripts`,
  re-queue ids whose `errors[id].retryable` is `true`.
- **Summaries:** feed `text` to your local LLM (OpenAI-compatible endpoint) in the
  next node.

## Development

```bash
npm ci
npm run dev        # ts-node, http://localhost:3000 (needs yt-dlp on PATH for transcripts)
npm run build
npm test           # vitest: 97 unit/route tests, no network
```

`package-lock.json` is committed — use `npm ci`.

### Field test checklist (run from a residential IP)

```bash
H=http://$(tailscale ip -4):3000; A=user:pass   # or http://127.0.0.1:3000 if BIND_ADDR is unset
curl -s $H/health | jq .
curl -su $A "$H/transcript/lXUZvyajciY" | jq '{lang,kind,n:(.transcript|length)}'   # English, manual
curl -su $A "$H/transcript/fW4SwcMQYdA" | jq '{lang,kind}'                           # German, auto
curl -su $A "$H/transcript/Me-kZi4xkEs" | jq '{lang,kind}'                           # auto (was a false "disabled" with the old backend)
curl -su $A "$H/transcript/fW4SwcMQYdA?format=text" | jq -r .text | head -c 600     # readable, no repeats
curl -su $A "$H/transcript/lXUZvyajciY?lang=de" | jq .                              # 404 LANG_UNAVAILABLE
curl -su $A "$H/transcript/ScMzIvxBSi4" | jq .                                      # 404 NO_CAPTIONS (public video, no tracks)
curl -su $A -o /dev/null -w '%{http_code}\n' "$H/transcript/aaaaaaaaaaa"            # 500 VIDEO_UNAVAILABLE
```

## Troubleshooting

- **Service exits at startup** — the log lists the missing/invalid variables.
- **`/health` says `degraded`** — either `transcripts.error` tells you why yt-dlp could
  not run (`ENOENT` = binary missing; rebuild the image), or
  `transcripts.jsRuntime.detected` is `none`: yt-dlp did not find the runtime named in
  `YTDLP_JS_RUNTIME`. With the default `node` that means `node` is not on the PATH yt-dlp
  sees; check `docker compose exec youtube-api yt-dlp -v --js-runtimes node`.
- **Every transcript answers `503 BLOCKED`** — YouTube is bot-checking this IP.
  Wait, keep the batch delay generous, and make sure the machine is on a residential
  connection. If the reason mentions a *PO Token*, check the
  [yt-dlp PO-Token guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide).
- **Transcripts suddenly fail with `500 BACKEND_FAILURE`** after working for months —
  YouTube changed something; [update yt-dlp](#updating-yt-dlp).
- **`"oauth": "expired"`** — see [Token issues](#token-issues).
- **Logs** are one JSON line per event (`docker compose logs -f youtube-api`);
  `transcript.ok` lines carry per-phase timings (`ms.ytdlp`, `ms.fetch`, `ms.parse`).

## License

MIT
