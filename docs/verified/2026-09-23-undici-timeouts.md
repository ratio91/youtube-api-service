# undici fetch timeouts (verified 2026-09-23)

Pinned to **undici 7.29.1**: the version bundled with Node v24.21.0 in the image
(`process.versions.undici`) and the exact version added as a dependency. Read from the
npm tarball `undici@7.29.1`. Used by `src/llm/client.ts` (`createLlmFetch`).

1. `Client`/`Agent` default `headersTimeout` and `bodyTimeout` are **300e3 ms**:
   `lib/dispatcher/client.js` L261–262
   (`this[kHeadersTimeout] = headersTimeout != null ? headersTimeout : 300e3`).
   Node's global `fetch` uses these defaults, independent of any AbortSignal.
2. A per-request value overrides the client's (`lib/dispatcher/client-h1.js` L1093–1096);
   the parser arms a timer only `if (delay)` (L259), so **`0` disables** the timeout
   (also documented for `bodyTimeout` in `types/client.d.ts` L49).
3. `Agent.Options extends Pool.Options` (`types/agent.d.ts` L22), so the timeouts are
   passed to the Agent; `fetch` accepts a `dispatcher` (`types/fetch.d.ts` L146).
4. Timeouts run on a coarse internal timer (fast timers); sub-second values are not
   precise, so tests use seconds.

Field symptom that led here: `Headers Timeout Error` after exactly 300 s on long
non-streaming llama-server answers (docs/decisions.md 2026-09-23).
