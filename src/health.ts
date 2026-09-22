import { OAuthCheck, YouTubeService } from './youtube';

export interface TranscriptsHealth {
  backend: 'yt-dlp';
  /** yt-dlp --version, null when the binary cannot be run */
  version: string | null;
  /** binary runs and reports a version */
  ok: boolean;
  error?: string;
  /** yt-dlp's OWN detection of the JS runtime it was told to use (probe, not assumption) */
  jsRuntime: { requested: string; detected: string | null; present: boolean };
  /** bundled yt-dlp-ejs (n/sig solver) version */
  ejs: string | null;
}

export interface HealthReport {
  /** degraded when yt-dlp cannot run OR it does not detect the requested JS runtime */
  status: 'ok' | 'degraded';
  mode: 'full' | 'transcript-only';
  oauth: 'disabled' | OAuthCheck['status'];
  oauthDetail?: OAuthCheck;
  transcripts: TranscriptsHealth;
  /** legacy field (pre-2026-09): true only when oauth === "ok" */
  authorized: boolean;
  timestamp: string;
}

export interface HealthDeps {
  youtube: YouTubeService | null;
  probeTranscripts: () => Promise<TranscriptsHealth>;
  oauthCacheMs: number;
  /** re-probe interval for a failing transcript backend */
  transcriptsRecheckMs?: number;
  now?: () => number;
}

/**
 * Builds /health responses. The OAuth refresh check hits Google, so its result
 * is cached for `oauthCacheMs`. The yt-dlp probe runs once and is cached while it is
 * fully healthy (the binary cannot change inside a running container); a failing or
 * degraded probe is retried every `transcriptsRecheckMs`.
 */
export function createHealthProvider(deps: HealthDeps): () => Promise<HealthReport> {
  const now = deps.now ?? (() => Date.now());
  const recheckMs = deps.transcriptsRecheckMs ?? 60_000;
  let oauthCache: { at: number; value: OAuthCheck } | null = null;
  let oauthInFlight: Promise<OAuthCheck> | null = null;
  let transcriptsCache: { at: number; value: TranscriptsHealth } | null = null;

  async function oauthStatus(): Promise<OAuthCheck | null> {
    if (!deps.youtube) return null;
    if (oauthCache && now() - oauthCache.at < deps.oauthCacheMs) return oauthCache.value;
    if (!oauthInFlight) {
      oauthInFlight = deps.youtube
        .verifyRefresh()
        .then((value) => {
          oauthCache = { at: now(), value };
          return value;
        })
        .finally(() => {
          oauthInFlight = null;
        });
    }
    return oauthInFlight;
  }

  async function transcriptsStatus(): Promise<TranscriptsHealth> {
    const healthy = (v: TranscriptsHealth) => v.ok && v.jsRuntime.present;
    if (transcriptsCache && (healthy(transcriptsCache.value) || now() - transcriptsCache.at < recheckMs)) {
      return transcriptsCache.value;
    }
    const value = await deps.probeTranscripts();
    transcriptsCache = { at: now(), value };
    return value;
  }

  return async () => {
    const [oauth, transcripts] = await Promise.all([oauthStatus(), transcriptsStatus()]);
    return {
      status: transcripts.ok && transcripts.jsRuntime.present ? 'ok' : 'degraded',
      mode: deps.youtube ? 'full' : 'transcript-only',
      oauth: oauth ? oauth.status : 'disabled',
      ...(oauth ? { oauthDetail: oauth } : {}),
      transcripts,
      authorized: oauth?.status === 'ok',
      timestamp: new Date().toISOString(),
    };
  };
}
