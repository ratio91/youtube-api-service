import { config } from './config';
import { YouTubeService } from './youtube';
import { createApp } from './app';
import { createHealthProvider, TranscriptsHealth } from './health';
import { TranscriptService } from './transcripts/service';
import { createYtDlpRunner, probeYtDlpVersion } from './transcripts/ytdlp';
import { log } from './log';

const youtube = config.oauth ? new YouTubeService(config.oauth, config.TOKEN_PATH) : null;

const transcripts = new TranscriptService({
  run: createYtDlpRunner({ binary: config.YTDLP_PATH, jsRuntime: config.YTDLP_JS_RUNTIME, timeoutMs: config.YTDLP_TIMEOUT_MS }),
  config: {
    binary: config.YTDLP_PATH,
    batchDelayMs: config.TRANSCRIPT_BATCH_DELAY_MS,
    maxAttempts: config.TRANSCRIPT_MAX_ATTEMPTS,
    retryDelayMs: config.TRANSCRIPT_RETRY_DELAY_MS,
  },
});

async function probeTranscripts(): Promise<TranscriptsHealth> {
  const probe = await probeYtDlpVersion(config.YTDLP_PATH);
  const usesNode = config.YTDLP_JS_RUNTIME === 'node';
  return {
    backend: 'yt-dlp',
    version: probe.version,
    ok: probe.version !== null,
    ...(probe.error ? { error: probe.error } : {}),
    // yt-dlp is told to use this same Node binary (--js-runtimes node); it only
    // matters for media-format deciphering, not for caption extraction.
    jsRuntime: {
      name: config.YTDLP_JS_RUNTIME,
      version: usesNode ? process.version : null,
      present: usesNode || config.YTDLP_JS_RUNTIME === 'none',
    },
  };
}

const health = createHealthProvider({ youtube, probeTranscripts, oauthCacheMs: config.HEALTH_OAUTH_CACHE_MS });

const app = createApp({ youtube, transcripts, health });

app.listen(config.PORT, async () => {
  const t = await probeTranscripts();
  log('info', 'server.started', {
    port: config.PORT,
    mode: youtube ? 'full' : 'transcript-only',
    ytdlp: t.version ?? `unavailable (${t.error})`,
    jsRuntime: t.jsRuntime,
    batchDelayMs: config.TRANSCRIPT_BATCH_DELAY_MS,
  });
  if (youtube && !youtube.isAuthorized()) {
    log('info', 'oauth.not_authorized', { hint: 'GET /auth/url to start the OAuth flow' });
  }
});
