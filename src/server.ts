import { config } from './config';
import { YouTubeService } from './youtube';
import { createApp } from './app';
import { createHealthProvider, TranscriptsHealth } from './health';
import { TranscriptService } from './transcripts/service';
import { TranscriptCache } from './transcripts/cache';
import { createYtDlpRunner, probeYtDlp, YtDlpProbe } from './transcripts/ytdlp';
import { LlmClient } from './llm/client';
import { Summarizer } from './summaries/summarizer';
import { SummaryStore } from './summaries/store';
import { SummaryService } from './summaries/service';
import { ObsidianExporter } from './notes/obsidian';
import { log } from './log';

const youtube = config.oauth ? new YouTubeService(config.oauth, config.TOKEN_PATH) : null;

let lastProbe: YtDlpProbe | null = null;

async function probeTranscripts(): Promise<TranscriptsHealth> {
  // Same binary and --js-runtimes flag as real calls; reports what yt-dlp itself
  // detects (see docs/decisions.md 2026-09-22 "health probe hardening").
  const probe = await probeYtDlp({ binary: config.YTDLP_PATH, jsRuntime: config.YTDLP_JS_RUNTIME });
  lastProbe = probe;
  return {
    backend: 'yt-dlp',
    version: probe.version,
    ok: probe.version !== null,
    ...(probe.error ? { error: probe.error } : {}),
    jsRuntime: probe.jsRuntime,
    ejs: probe.ejs,
  };
}

const cache = new TranscriptCache({
  dir: config.TRANSCRIPT_CACHE_DIR,
  noCaptionsTtlMs: Math.round(config.NO_CAPTIONS_TTL_DAYS * 24 * 60 * 60 * 1000),
});

const transcripts = new TranscriptService({
  run: createYtDlpRunner({ binary: config.YTDLP_PATH, jsRuntime: config.YTDLP_JS_RUNTIME, timeoutMs: config.YTDLP_TIMEOUT_MS }),
  cache,
  backendVersion: () => lastProbe?.version ?? null,
  config: {
    binary: config.YTDLP_PATH,
    batchDelayMs: config.TRANSCRIPT_BATCH_DELAY_MS,
    maxAttempts: config.TRANSCRIPT_MAX_ATTEMPTS,
    retryDelayMs: config.TRANSCRIPT_RETRY_DELAY_MS,
  },
});

// --- summaries via the local LLM ---------------------------------------------
const llm = new LlmClient({ baseUrl: config.LLM_BASE_URL, apiKey: config.LLM_API_KEY, model: config.LLM_MODEL, timeoutMs: config.LLM_TIMEOUT_MS });
let lastLlmProbe: Awaited<ReturnType<LlmClient['probe']>> | null = null;
async function probeLlm() {
  lastLlmProbe = await llm.probe();
  return lastLlmProbe;
}
const DEFAULT_CONTEXT_TOKENS = 32_768;
const summaryStore = new SummaryStore({ dir: config.SUMMARY_CACHE_DIR });
const summarizer = new Summarizer({
  client: llm,
  // explicit env wins; otherwise what the server reports; otherwise a safe default
  contextTokens: () => config.LLM_CONTEXT_TOKENS ?? lastLlmProbe?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
  maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
  charsPerToken: config.SUMMARY_CHARS_PER_TOKEN,
});
const exporter = config.OBSIDIAN_EXPORT_DIR
  ? new ObsidianExporter({ dir: config.OBSIDIAN_EXPORT_DIR, tags: config.OBSIDIAN_TAGS.split(',').map((t) => t.trim()).filter(Boolean) })
  : undefined;
const summaries = new SummaryService({ transcripts, summarizer, store: summaryStore, exporter, summaryLanguages: config.SUMMARY_LANGUAGES });

const health = createHealthProvider({
  youtube,
  probeTranscripts,
  cacheStats: () => cache.stats(),
  probeLlm,
  summaryStats: () => summaryStore.stats(),
  ...(exporter ? { notesStats: () => exporter.stats() } : {}),
  oauthCacheMs: config.HEALTH_OAUTH_CACHE_MS,
});

const app = createApp({ youtube, transcripts, summaries, health });

async function main() {
  const t = await probeTranscripts(); // populates lastProbe before the first fetch is cached
  await cache.init();
  await summaryStore.init();
  if (exporter) await exporter.init();
  const l = await probeLlm();
  app.listen(config.PORT, () => {
    log('info', 'server.started', {
      port: config.PORT,
      mode: youtube ? 'full' : 'transcript-only',
      ytdlp: t.version ?? `unavailable (${t.error})`,
      jsRuntime: t.jsRuntime,
      ejs: t.ejs,
      degraded: !(t.ok && t.jsRuntime.present),
      cacheDir: config.TRANSCRIPT_CACHE_DIR,
      cacheWritable: cache.isWritable(),
      noCaptionsTtlDays: config.NO_CAPTIONS_TTL_DAYS,
      batchDelayMs: config.TRANSCRIPT_BATCH_DELAY_MS,
      llm: { baseUrl: l.baseUrl, ok: l.ok, model: l.model, contextTokens: config.LLM_CONTEXT_TOKENS ?? l.contextTokens ?? DEFAULT_CONTEXT_TOKENS, ...(l.error ? { error: l.error } : {}) },
      summaryDir: config.SUMMARY_CACHE_DIR,
      summaryWritable: summaryStore.isWritable(),
      notes: exporter ? { dir: exporter.dir, writable: exporter.isWritable() } : 'disabled',
    });
    if (youtube && !youtube.isAuthorized()) {
      log('info', 'oauth.not_authorized', { hint: 'GET /auth/url to start the OAuth flow' });
    }
  });
}

main().catch((err) => {
  log('error', 'server.start_failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
