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

## 2026-09-22 — Gate 3 (home machine over Tailscale): PASSED — service is live

Deployed from the pushed commit via `git clone` + `docker compose up -d --build` on the
home machine (x86_64, Fedora 42, Docker 29.5 / compose v5.1). `yt-dlp_musllinux`
2026.08.19 checksum OK; container `healthy`; `.env` mode 600 with a generated
32-char basic-auth password (user `n8n`), transcript-only mode, port published on the
host's Tailscale address only. A pre-existing local process on loopback:3000 does not
collide (different bind address).

Field checklist from the home machine (residential IP), all as specified:
EN manual 200 (2.6 s) · DE auto 200 (2.9 s) · `Me-kZi4xkEs` auto 200 (2.2 s) ·
`format=text` 64 kB flowing text · `lang=de` on EN → 404 `LANG_UNAVAILABLE` ·
`ScMzIvxBSi4` → 404 `NO_CAPTIONS` · unknown id → 500 `VIDEO_UNAVAILABLE` ·
batch of 2 (text) 200 in 8.7 s · no auth 401 · `/auth/url` 503.

Reachability: `/health` answers 200 from the n8n host over the tailnet (58 ms) and from
**inside the n8n container** (verified with a fetch from within the container).

**Cutover status:** the old VPS service keeps running until the n8n workflows are
repointed to `http://<home-machine-tailscale-ip>:3000` with the new basic-auth
credential. Retire the VPS service afterwards.

## 2026-09-22 — Health probe hardening (operator review finding)

**Finding (operator):** `/health.transcripts.jsRuntime` only echoed `process.version`,
i.e. it proved that Node exists, not that yt-dlp uses it. yt-dlp enables only Deno by
default; Node is used only because every call passes `--js-runtimes node`.

**Field check on the home machine (inside the running container, same argv as the
service):** `[debug] JS runtimes: node-24.21.0` and `[jsc] JS Challenge Providers: bun
(unavailable), deno (unavailable), node, quickjs (unavailable)`; all successful calls so
far logged `stderrLines: 0`, so the "No supported JavaScript runtime" warning never fired.
The flag works as intended.

**Fix:** the health probe now runs `yt-dlp -v [--js-runtimes X]` **with no URL** (prints
the debug header offline in <1 s, exits 2) and parses `yt-dlp version …`, `JS runtimes: …`
and `yt_dlp_ejs-…`. `/health` reports `jsRuntime: { requested, detected, present }` and
`ejs`; `status` is `degraded` when the requested runtime is not detected. A degraded probe
is re-run every 60 s, a healthy one is cached. Header wording verified against 2026.08.19
(`node-24.21.0`, `none`, `none (disabled)`).

## 2026-09-22 — Task 6: persistent transcript cache (spec approved, decisions)

Spec (operator): fetch each transcript once, keep it on disk, derive both output formats
from the stored segments, cache "no captions" with a TTL, never cache retryable errors,
`?refresh=true`, `/health.cache`, `GET /transcripts`.

**Decisions (operator approved):**
1. Cache lives in the existing `./data` bind mount (`/data/transcripts`), not a named
   volume: host-readable, already owned by uid 1000 on the home machine; ownership
   problems surface as `cache.writable=false` in `/health` instead of failing fetches.
2. `GET /transcripts` includes the no-captions markers as `kind: "none"`, `lang: null`,
   with `expiresAt`.
3. Batch responses report cache hits in `tracks[id].cached`; cached 404s appear in the
   error map with `cached: true`.

**Implementation notes:** `<videoId>.<lang>.json` / `<videoId>.none.json`; zod-validated on
read; atomic temp-file + rename writes; a `default: true` flag marks the track chosen by a
request without `?lang=` so later default requests hit the same track; cache reads bypass
the yt-dlp queue, fetches re-check the cache inside the queue; batch delay only between
real fetches; listing/stats memoised 60 s. Only `NO_CAPTIONS` is cached (TTL
`NO_CAPTIONS_TTL_DAYS`, default 7); `LANG_UNAVAILABLE` is not, since a manual track in
that language may appear later.

## 2026-09-22 — Task 6 gates: PASSED locally and on the home machine

**Local (dev Mac, bind-mounted data dir):** first fetch `cached:false` + file written;
second fetch `cached:true`, same `fetchedAt`, log shows 1 `transcript.ok` and 1
`transcript.cache_hit`; `format=text` from cache byte-identical to a `refresh=true`
live answer (145,773 bytes); refresh updated `fetchedAt` on disk; `ScMzIvxBSi4` → 404
`cached:false` then 404 `cached:true`, `<id>.none.json` present; `GET /transcripts`
lists both; container restart → still `cached:true`; batch [cached EN, new DE] → one
yt-dlp run, no delay, `tracks[id].cached` correct; `/health.cache` = 3 files /
371 kB / writable; no temp files left.

**Home machine (compose, `./data/transcripts`):** same sequence after `git pull` +
rebuild; files owned by the host user (uid 1000 = container `node`), `cache.writable:
true`, container healthy. Commit `052fbb8` deployed.

## 2026-09-22 — Task 7: summaries with the local LLM (findings, decisions, design)

**Field findings on the home machine (invalidating the task's premise):**
- No Ollama installed. The LLM is **llama.cpp `llama-server`** (build b9598, 2026-06-11,
  Vulkan backend) as a system unit, model **Qwen3.6-35B-A3B UD-Q4_K_XL** (20.8 GB, MoE,
  ~3B active), all layers on the Radeon 780M (Vulkan, 24 GiB GTT), port 8000 on all
  interfaces, no API key, one slot, flash attention, q8_0 KV cache, `--jinja`.
- Architecture (HF `Qwen/Qwen3.6-35B-A3B` config.json): 40 layers, 10 full attention
  (2 KV heads × 256) + 30 linear attention, 256 experts / 8 active, 262k native context.
  KV cache ≈ 10 KB/token at q8_0 → raising the server context is cheap.
- Probe (thinking disabled via `chat_template_kwargs.enable_thinking=false`): warm-up
  21 tok/s generation; full German talk (15,056 prompt tokens) 90 s wall: prefill 249
  tok/s (60 s), generation 20 tok/s; good structured German summary; 600 output tokens
  was too little (`finish_reason: length`).
- Context overflow answers HTTP 400 `{"error":{"type":"exceed_context_size_error",
  "message":"request (N tokens) exceeds the available context size (M tokens), try
  increasing it","n_prompt_tokens":N,"n_ctx":M}}`.
- `Qwen3.8-27B` (operator's original pick) is dense, 64 layers, multimodal, 16.5 GB at
  UD-Q4_K_M: on this hardware several times slower per token than the 3B-active MoE.

**Decisions (operator):**
1. Keep Qwen3.6-35B-A3B; add a benchmark tool (`dist/tools/llm-bench.js`) that runs
   the service's prompts on cached transcripts against whatever model llama-server
   loads. Gemma 3 12B noted as the candidate to try later.
2. Summaries live in this service (`GET /summary/:videoId`, `GET /summaries`), cached
   under `/data/summaries/<videoId>.<summaryLang>.json` with model, prompt version,
   strategy, token counts. Summary language defaults to the transcript language.
3. Operator raised `--ctx-size` to 65536 (unit edit + restart; verified via `/props`).
   No API key on llama-server (home network).
4. Synchronous endpoint; n8n timeout to be set to ~10 min.

**Design notes:** LLM client = OpenAI chat completions with llama.cpp extensions
(`top_k`, `chat_template_kwargs`); sampling per Qwen non-thinking recommendation
(temperature 0.7, top-p 0.8, top-k 20, presence 1.5); output budget 1200 with one retry
at 1.6× when cut off. Context window taken from `/props` unless `LLM_CONTEXT_TOKENS` is
set. Chunking (map → reduce, recursive when notes do not fit) when the estimate
(3.5 chars/token, conservative vs. 4.3 measured) exceeds the budget, and as a fallback
when the server reports an overflow (then recalibrated from the reported token count and
forced to ≥ 2 parts). Transcript lines carry `[h:mm:ss]` stamps once per minute so the
notes can cite positions. Video title now stored in the transcript cache on new fetches.
LLM outages surface as 503 retryable and never degrade `/health.status`.

## 2026-09-22 — Task 7 gates (local container → home-machine LLM over Tailscale): PASSED

| Case | Result |
|---|---|
| `/health.llm` | `ok`, model `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`, `contextTokens 65536` read from `/props`, build b9598 |
| DE talk (16k tokens) | single shot, 117 s, 1,036 output tokens, not truncated; German, all four sections, correct timestamps |
| DE again | `cached: true`, no LLM call |
| EN talk (33k tokens) | single shot (64k ctx), 360 s incl. one retry after `finish_reason: length` at 1,200 tokens → default output budget raised to 2,000 |
| EN talk, `summaryLang=de` | separate file, German summary of the English transcript, 364 s |
| DE with `LLM_CONTEXT_TOKENS=12000` | chunked: 3 parts, 6 LLM calls, 437 s, coherent result — fallback works but is several times slower than one pass |
| LLM unreachable | `503 LLM_UNAVAILABLE` with the connection error, `retryable: true`; `/health.status` stays `ok` |
| no-captions video | `404 NO_CAPTIONS` passthrough, `cached: true` |

Observation: headings are emitted in English regardless of summary language (prompt says
"these headings") — deliberate for uniform notes; to be confirmed with the operator.
Files: `/data/summaries/<videoId>.<summaryLang>.json` (4–7 kB each).

## 2026-09-22 — Task 8: Obsidian note export via nested Syncthing folder (decisions)

**Operator decisions:** (1) nested folder — the service's export directory on the home
machine is a Syncthing folder `video-inbox` shared with the vault device, where its path is
`<vault>/video-inbox`; not a full vault copy on the home machine. (2) Pairing/acceptance is
done by the operator in the two Syncthing UIs once the side-car is up. (3) Vault location:
**top level `video-inbox`**. (4) Frontmatter: `title, source, channel, duration, created,
language, model, tags, video_id`; **no transcript kind; no video id in the filename** —
the id stays a property because the exporter needs it to find the note again.

**Design:** `ObsidianExporter` writes `<sanitised title>.md` (Obsidian-forbidden chars
stripped, ≤120 chars, ` (n)` suffix on title collisions of different videos), finds an
existing note by `video_id` in the frontmatter (survives renames), writes via `.tmp/` +
rename and drops an `.stignore` for `.tmp`. Export happens on every newly generated
summary and on `?export=true`; cache hits never re-create a note (inbox semantics).
Export failures are returned in `note.error` and never fail the summary. Syncthing runs as
a compose side-car (`syncthing/syncthing:2`, matching v2.1.3 on the vault host), GUI and
22000 published on `BIND_ADDR` only; the vault host's port 22000 is reachable from the
home machine over the tailnet (probed). Channel and duration are now carried from the
yt-dlp info JSON through the transcript cache into summaries and notes.

## 2026-09-22 — Task 8 gate (home machine): note export + Syncthing side-car PASSED, pairing pending

- Deployed `47864a4`. `/health.notes` writable; `?export=true` on the cached German
  summary wrote the note; after refreshing the transcript (title, channel `Uni Vienna
  live`, 1:18:52) the cached summary was enriched and the placeholder-named note was
  moved to the real title. Frontmatter as decided, no transcript kind, video id only as
  a property.
- Side-car `syncthing/syncthing:2` up and healthy, GUI + 22000 on the Tailscale address.
  Configured via its REST API: vault host added as device (Tailscale address + dynamic),
  folder `video-inbox` (`/var/syncthing/video-inbox`, sendreceive, fs-watcher) shared with
  it, default folder removed. Folder state idle, 1 local file. The vault host still has to
  accept the device and the folder (operator, in its UI) and add the ignore lines for the
  nested folder markers to the vault folder.
- Open: GUI password on the side-car not set yet (Tailscale-only exposure).

## 2026-09-23 — Summaries from the n8n Data Table, not the inbox playlist

**Field finding:** the bundled `deploy/n8n` workflow reads only the inbox playlist, but the
daily sort job removes sorted videos from it — 261 were already gone and would never be
summarised. The operator keeps every video (inbox, sorted, dead) in an n8n Data Table
`yt_inbox` (key `videoId`; the sort job owns `title, channel, action, targetPlaylistId,
targetName, status, note`), which only n8n workflows can read.

**Operator decisions:**
1. New nightly workflow, source = `yt_inbox`. Dedup against `GET /summaries`, then
   `GET /summary/:id` one video at a time (15 min timeout); the service writes the note.
2. State lives in two operator-added columns, never in the sort job's `status`/`note`:
   `summaryStatus` ∈ `done | no_captions | failed`, `summaryNote` (error text).
   200 → `done`; 404 → `no_captions`, skipped for good (the service forgets NO_CAPTIONS
   after `NO_CAPTIONS_TTL_DAYS`, the table does not); 500 → `failed`, skipped until cleared
   by hand; 503 or a failed request → status stays empty, retried next night. Clearing
   `summaryStatus` re-queues a video.
3. The 08:00 inbox workflow is retired from the repo (it was never imported on the n8n
   instance, so this is a repo/docs change only).
4. Runs are bounded by time, not count: start 01:00, no new video after 06:30 (one video
   takes at most ~15 min), `maxPerRun` 150 as a safety net only. Backlog ~600–650 rows →
   roughly 5–7 nights (no-caption 404s return in seconds).

**Gate (operator):** confirm with a test row that the sort job's upsert leaves
`summaryStatus`/`summaryNote` untouched before relying on them.

**Gate passed (operator, 2026-09-23):** columns `summaryStatus`/`summaryNote` added to the
table; an upsert test row written by the sort job's path kept its `summaryStatus`. Next:
import the workflow and do a manual run with `maxPerRun = 3`.
- Manual test run (`maxPerRun = 3`, 2026-09-23 08:39–08:44 UTC): service log shows three
  fresh summaries, all `single` strategy, 75 s / 138 s / 79 s (5.9k / 14.9k / 5.7k prompt
  tokens), three new notes in the vault inbox. Test row and helper workflow removed.
  One video's transcript was Ukrainian (`uk` auto) → note in Ukrainian, since
  `summaryLang` defaults to the transcript language.

## 2026-09-23 — Field finding: AI auto-dubbed videos broke track selection; notes only in en/de

**Finding:** `U6KChi90nHs` (English talk) came back as a Ukrainian transcript and note.
YouTube has AI-dubbed it into 14 languages; each dub gets its own ASR caption track, and
yt-dlp labels every one `<lang>-orig` (15 "originals"). `listTracks` kept the *last*
`-orig` key (`uk-orig`) and then served the ASR of the Ukrainian dub (fluent MT-quality
text). Raw info JSON: top-level `language: en-US`, English audio "original (default)",
the `en-orig` URL without `variant`, all 14 dub tracks with `variant=timing-optimized`.
Only this video was affected in the cache (all other cached tracks en/de).

**Fix:** original language = top-level `language` when it names an `-orig` track, else
the `-orig` track without `variant`; auto tracks with a `variant` are never served
(fixture `test/fixtures/info/U6KChi90nHs.json`, scrubbed).
**Operator decision:** notes only in German or English → `SUMMARY_LANGUAGES` (compose
default `en,de`): an en/de transcript keeps its language, any other is summarised in
English by the LLM from the original transcript. Unset keeps the old behaviour; an
explicit `?summaryLang=` wins. Nightly workflow stays inactive until this is deployed.
- Deployed `37357ff` on the home machine (health ok, `SUMMARY_LANGUAGES=en,de`). The
  Ukrainian transcript and summary of `U6KChi90nHs` were moved aside; the regenerated
  summary uses the `en` auto track (74.8 s, single) and overwrote the existing note in
  place (`language: en`). Live probe of the three field-test videos: one `-orig` key
  each, no `variant` anywhere, `language` set (docs/verified/2026-09-23-ytdlp-auto-dub.md).

## 2026-09-23 — Field finding: backlog run exposes a 5-minute fetch limit and llama-server OOM kills

During the first backlog run (from ~09:35 UTC) 24 `/summary` calls failed with 503:
- **`Headers Timeout Error` after exactly 5 min** (09:42, 10:13, 10:18, 10:28): Node's
  built-in fetch (undici 7.29.1 in the image) has a default `headersTimeout` of 300 s,
  which fires before our `LLM_TIMEOUT_MS` (600 s) abort signal. llama-server answers a
  non-streaming request only when done, so every summary longer than 5 min fails and is
  reported as `LLM_UNAVAILABLE`.
- **llama-server OOM-killed twice** (09:44, 10:28 UTC; `NRestarts=2`, memory peak
  18.9/21.2 GB + 5.5 GB swap on a 30 GB host whose iGPU shares system RAM). Each kill
  came right after a cancelled request (the aborted fetch) whose prompt state (~550 MB)
  was saved into llama-server's RAM prompt cache (default `--cache-ram` 8192 MiB, dozens
  of cached prompts of 280–630 MB each). The following requests hit `ECONNREFUSED` /
  `503 Loading model` for ~30 s.
- All affected videos are retried next night (status stays empty). One `VIDEO_UNAVAILABLE`
  (500) was marked failed correctly.
- **Fix (service):** the LLM client uses its own undici 7.29.1 Agent with header/body
  timeouts disabled; `LLM_TIMEOUT_MS` is the only deadline, and an undici header/body
  timeout now maps to `LLM_TIMEOUT` (docs/verified/2026-09-23-undici-timeouts.md).
- **Fix (host, operator):** `--cache-ram 2048` for llama-server (prompt cache 8 GiB → 2 GiB).

## 2026-09-23 — Playlist classification (`POST /classify/:videoId`), service side

Operator spec: suggest one playlist or none from title, channel and the cached summary's
TL;DR + key points; taxonomy sent by n8n per request; categorical confidence; cache keyed
by taxonomy hash + prompt version + model (+ the summary it was made from).
Decisions: invalid model output after one retry → 200 "none" with reason
`invalid model output`, not cached (500 only for unexpected failures). The model chooses
among playlist **names** (meaningful tokens) instead of opaque IDs; the response still
carries `playlistId`. Temperature 0.2, no presence penalty. Summaries and classifications
share one LLM queue. Constrained output via `response_format.json_schema.schema`
(docs/verified/2026-09-23-llama-server-json-schema.md; field probe: enum enforced,
truncation = `finish_reason: length`). The real taxonomy and labels (299 labelled videos,
37 `needsReview`) stay out of git; the eval tool reports `needsReview` rows separately.
**Next gate:** eval on the labelled videos once the backlog has their summaries; nothing
writes to yt_inbox before the operator has seen the numbers.
*Superseded in part by "2026-09-23 — Suggestions in their own columns; approval via
`status = approved`": suggestions are written to their own `suggest*` columns before the
eval gate; the eval gates bulk approval, not the writing of suggestions.*
- Deployed `4105f11` (health ok, classification cache writable). Smoke test on one
  labelled video: correct playlist, confidence high; first call 99 s (queued behind a
  running summary — shared LLM queue working), second call 13 ms from cache. Only 1 of
  299 labelled videos has a summary yet (the backlog runs newest rows first), so the
  eval waits for the backlog.
- Host fix applied (13:07 local): unit has `--cache-ram 2048`, running process carries
  it, llama-server logs `prompt cache is enabled, size limit: 2048 MiB`, model loaded in
  25 s, `/health` llm ok. A few summaries during the reload got `503 Loading model`
  (retried next night).

## 2026-09-23 — Suggestions in their own columns; approval via `status = approved`

Operator + sort-job facts (from the n8n agent): the sort job acts only on
`status = pending` rows still in the inbox; a pending row with an empty/unknown `action`
used to be removed from the inbox without being added anywhere.
Decisions: the classifier owns four columns `suggestedPlaylistId`, `suggestedName`,
`suggestConfidence`, `suggestReason` and never writes `status` or the target columns
(same ownership rule as `summaryStatus`). Approval = operator sets `status = approved`;
the sort job copies the suggestion into the target columns and moves (no suggestion →
failed). Sort-job guard: pending with `action` ∉ {move, remove} → failed. Overrides keep
the suggestion, so suggested vs. decided stays measurable. The nightly workflow now
suggests after each `done` and for every summarised row without a suggestion (incl.
already sorted rows). Suggestions are written before the eval gate because they only
touch their own columns; the eval gates bulk approval.

## 2026-09-23 — Approval stays in the n8n table; Obsidian approval deferred

Suggestions are approved in the `yt_inbox` table view (`status = approved`). Approving
from Obsidian frontmatter was discussed and deferred; see `docs/backlog.md`.

## 2026-09-23 — "Consumed" notes from the inbox mirror, not the vault

Operator: moving a note out of `video-inbox` means consumed; no access to the full
vault. The home machine's `data/obsidian-inbox` is the Syncthing mirror of exactly that
folder, so the service answers it: new `GET /notes` (notes by frontmatter `video_id`)
and `exportedAt` in `GET /summaries`. Consumed = exported and not in `/notes` (a deleted
note counts too). The nightly workflow sets a new `yt_inbox` column `noteConsumedAt`
once per video (owner: nightly workflow; never cleared); no marking unless `/notes`
answered a clean 200. Column added by the operator's n8n agent.

## 2026-09-23 — Three LLM windows; labelled rows first (operator, applied live in n8n)

The operator's n8n agent changed the live nightly workflow: three schedule triggers /
LLM windows (01:00–06:30, 07:00–16:30, 18:00–23:30) to use the home machine's LLM for
the backlog; `stopAt` accepts a list of window ends and the deadline is the next end
after the start (`maxRunMinutes` only as fallback); `maxPerRun` default 250; labelled
rows are summarised first so the classifier eval can run sooner (supersedes the earlier
"keep newest first" choice). Trade-off: llama-server is busy during the day.
Repo drift: the live workflow and `deploy/n8n/youtube-summaries-nightly.json` differ
(live lacks the consumed-note steps, repo lacks these changes) until the live export is
merged into the repo file.
