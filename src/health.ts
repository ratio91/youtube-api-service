import { OAuthCheck, YouTubeService } from './youtube';

export interface TranscriptsHealth {
  backend: 'yt-dlp';
  version: string | null;
  ok: boolean;
  error?: string;
  jsRuntime: { name: string; version: string | null; present: boolean };
}

export interface HealthReport {
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
 * is cached for `oauthCacheMs`. The yt-dlp probe runs once and is cached while it
 * succeeds (the binary cannot change inside a running container); a failing probe
 * is retried every `transcriptsRecheckMs`.
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
    if (transcriptsCache && (transcriptsCache.value.ok || now() - transcriptsCache.at < recheckMs)) {
      return transcriptsCache.value;
    }
    const value = await deps.probeTranscripts();
    transcriptsCache = { at: now(), value };
    return value;
  }

  return async () => {
    const [oauth, transcripts] = await Promise.all([oauthStatus(), transcriptsStatus()]);
    return {
      status: transcripts.ok ? 'ok' : 'degraded',
      mode: deps.youtube ? 'full' : 'transcript-only',
      oauth: oauth ? oauth.status : 'disabled',
      ...(oauth ? { oauthDetail: oauth } : {}),
      transcripts,
      authorized: oauth?.status === 'ok',
      timestamp: new Date().toISOString(),
    };
  };
}
