# Decision log

Append-only. One dated entry per operator decision, field finding that invalidates
an assumption, gate outcome, or explicit deviation from the plan.

## 2026-09-22 — Transcript backend rework: plan approved

**Context.** Transcript scraping via the unofficial `youtube-transcript` npm package is
fragile and fails from datacenter IPs. The service moves to a home machine on a
residential connection; playlist work has moved into n8n; the OAuth app stays in
Google "Testing" mode (refresh tokens expire after 7 days).

**Decisions (operator approved the recommended defaults):**

1. **Backend: yt-dlp as a subprocess.** Not youtubei.js, and no youtubei.js fallback
   for now. Basis: `docs/verified/2026-09-22-transcript-backends.md`. Deciding facts:
   yt-dlp exits 0 with empty track dicts for "no captions" and exits 1 with YouTube's
   `playabilityStatus.reason` for bot checks / blocks (distinguishable); youtubei.js
   does not throw on `LOGIN_REQUIRED` so a bot check surfaces as "no transcript"
   (B2.5), and its `/get_transcript` endpoint has an open intermittent-400 issue
   (B3.2). yt-dlp: 10 releases in 2026; youtubei.js: single maintainer.
2. **Image: `node:24-alpine` + official `yt-dlp_musllinux` binary, Node as the
   yt-dlp JS runtime (`--js-runtimes node`). No Deno.** Corrected assumption: the JS
   runtime is only used to decipher media format URLs (n/sig), never for caption
   extraction (A2.6/A2.8). Node >= 22 is an officially supported runtime (A2.3).
   Deno has no musl build (A8.1); the glibc `yt-dlp_linux` binary does not run on
   Alpine (A6.1). Binary is pinned by `ARG YTDLP_VERSION` and checksum-verified.
3. **Extraction strategy: one `yt-dlp -J --skip-download` call per video, track
   selection in our code, direct fetch of the chosen json3 URL** using the
   `http_headers` from the info JSON (what yt-dlp itself does, C2.1). Fallback if the
   direct fetch proves unreliable in the field: second invocation with
   `--load-info-json` and `--write-subs`.
4. **`?format=text` returns JSON** `{ videoId, lang, kind, text }` rather than a
   `text/plain` body, so n8n keeps the track metadata.
5. **`/health.oauth` has a fourth value `unauthorized`** (OAuth configured, no token
   stored yet). Deviation from the three-value spec, approved.
6. **`/health` always answers HTTP 200** with `status: "ok" | "degraded"`, so a broken
   transcript backend does not flap the container healthcheck.
7. **Batch: strictly sequential, abort remaining videos on the first block**
   (remaining IDs reported as retryable in the error map), **max 50 IDs per request**.
   In-process retry only for rate-limit / timeout, never for the bot check.
8. **`docker-stack.yml` moved to `deploy/swarm/`** as the legacy Swarm reference.
   New single-host `docker-compose.yml` at the repo root.
9. **`CLAUDE.md` stays untracked** (contains real hostnames; repo is public).

**Error contract** (n8n-facing):
- no captions / requested language missing → `404 { available: false, reason, ... }`
- bot check, rate limit, IP block, PO-token discard warning, yt-dlp timeout →
  `503 { retryable: true, reason }`
- everything else (private, removed, backend failure) → `500 { error, reason, retryable: false }`

**Staged de-risking gates:**
- Gate 0 — read-only probe from a residential IP with the bare yt-dlp command on the
  three CLAUDE.md test videos; captures json3 fixtures and settles the items marked
  UNVERIFIED in the verified note. Must pass before parser code is written.
- Gate 1 — unit + route tests green, `npm run build` green.
- Gate 2 — `docker compose up` on the dev Mac; the CLAUDE.md "Testing" checklist passes.
- Gate 3 — same checklist on the home machine over Tailscale from n8n.

## 2026-09-22 — Gate 0 (read-only probe from residential IP): PASSED, with findings

Ran `yt-dlp -J --skip-download --no-playlist --js-runtimes node` (yt-dlp 2026.08.19,
`yt-dlp_musllinux_aarch64` on `node:24-alpine`) on the three CLAUDE.md test videos from
the dev Mac (residential IP). All three exited 0 with no warnings; `[debug] JS runtimes:
node-24.21.0` confirms Node is picked up as the EJS runtime.

**Field findings that change assumptions:**

1. **`Me-kZi4xkEs` HAS auto-generated English captions** (`automatic_captions['en-orig']`,
   541 KB json3, 1,436 events). The old backend's "Transcript is disabled" was a false
   negative, not a "no captions" case. → The 404 path is covered by a synthetic fixture
   (`test/fixtures/info/no-captions.json`); a real no-captions video must still be found
   for the field checklist. `Me-kZi4xkEs` now becomes a *positive* auto-caption test.
2. **`--extractor-args youtube:skip=translated_subs` does not remove auto-track
   translations** in 2026.08.19: it only gates translations *of manual subtitles*
   (`_video.py` L4237/L4298). The ASR track's ~150 translations are always emitted,
   distinguishable by a `tlang=` query parameter on their URL. → The selector ignores any
   auto entry whose URL carries `tlang`; the `<lang>-orig` key is the original ASR track.
3. **No top-level `http_headers` in `-J` output**; they exist per format
   (`formats[].http_headers`, Chrome UA). Direct fetch of the json3 URL with that UA
   returned HTTP 200 for all four tracks tried (manual en, auto en-orig, auto de-orig,
   auto en-orig). Direct fetch is therefore the primary path; no `--load-info-json`
   second pass needed.
4. **Top-level `language` is populated** (`"en"`, `"de-DE"`, `"en"`) — region subtags
   appear, so match on the primary subtag. The `-orig` key remains the primary signal.
5. **Caption URLs are signed and expire ~8 h after extraction** (`expire=`, `signature=`,
   and an `ip=` parameter). Fetch immediately, never cache URLs, never commit them
   (fixtures use scrubbed URLs).
6. **json3 shape in the field**: manual tracks = `{tStartMs, dDurationMs, segs:[{utf8}]}`
   with embedded `\n`. Auto tracks = one header event without `segs` (window definition),
   then content events (word-level `segs` with `tOffsetMs`, `acAsrConf`) alternating with
   `aAppend: 1` events whose only segment is `"\n"`; some `aAppend` events lack
   `dDurationMs`. Text is not duplicated across events in json3 — the "rolling repeat"
   is a rendering artefact of vtt/srv formats. Cleaning = drop events without segs, drop
   `aAppend` events, join segments, normalise whitespace.

**Decision:** translated auto-captions are never served (no `kind: "translated"`); a
`?lang=` miss lists the manual and auto (original) languages that do exist.

## 2026-09-22 — Gate 1 (build + tests) and Gate 2 (local compose field test): PASSED

**Gate 1.** `npm run build` exit 0; `vitest run` 6 files / 87 tests green (fixtures from
Gate 0; no network). `youtube-transcript` removed from dependencies.

**Gate 2.** Image `node:24-alpine` + `yt-dlp_musllinux_aarch64` 2026.08.19 built on the
dev Mac (arm64), checksum verified; container run in transcript-only mode.

| Check | Result |
|---|---|
| `/health` | `status ok`, `mode transcript-only`, `oauth disabled`, yt-dlp 2026.08.19, Node v24.21.0 |
| `lXUZvyajciY` (EN) | 200, `manual/en`, 1,806 entries, total 2.1 s (yt-dlp 1.96 s, fetch 0.18 s, parse 7 ms) |
| `fW4SwcMQYdA` (DE) | 200, `auto/de`, 1,830 entries, 2.9 s |
| `Me-kZi4xkEs` | 200, `auto/en`, 718 entries, 9.6 s (yt-dlp 9.4 s) — positive test now, see Gate 0 finding 1 |
| `fW4SwcMQYdA?format=text` | 64 kB flowing German text, no newlines, no double spaces, no repeats |
| `lXUZvyajciY?lang=es` | 200, `manual/es` |
| `lXUZvyajciY?lang=de` | 404 `LANG_UNAVAILABLE`, `availableLanguages {manual:[en,es], auto:[en]}` |
| `aaaaaaaaaaa` | 500 `VIDEO_UNAVAILABLE` ("This video is unavailable"), 1.1 s |
| `ScMzIvxBSi4` | **404 `NO_CAPTIONS`** — "Placeholder Video" (public, 94 s, 2011), 0 manual / 0 auto tracks. Adopted as the real no-captions field test video. |
| bad id / bad format | 400 without a YouTube call |
| no auth / OAuth routes | 401 / 503 `oauth disabled` |
| batch of 2, `format=text` | 200 in 7.96 s = 2.2 s + 3 s delay + 2.7 s; `errors {}`, `tracks` filled |
| `docker compose config` | resolves `host_ip`, published port, `YTDLP_VERSION` build arg and both volumes |

Observations: yt-dlp dominates latency (2–9 s per video; the json3 fetch is ~0.2 s).
One video produced a harmless `WARNING: ffmpeg not found` on stderr — ignored by the
classifier, ffmpeg is not needed for captions. Per-call cost to YouTube: one player
request plus one timedtext GET.

**Not yet done:** Gate 3 (same checklist on the home machine over Tailscale from n8n) —
needs the operator to create `.env` with `BIND_ADDR=<tailscale ip>` and run
`docker compose up -d --build` there. Nothing is committed yet.
