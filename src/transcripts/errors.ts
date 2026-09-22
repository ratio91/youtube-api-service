export type TranscriptErrorCode =
  | 'NO_CAPTIONS'        // 404 – video has no caption tracks at all
  | 'LANG_UNAVAILABLE'   // 404 – requested ?lang= has no track
  | 'BLOCKED'            // 503 – bot check / IP block / PO-token discard
  | 'RATE_LIMITED'       // 503 – HTTP 429 / "rate-limited by YouTube"
  | 'TIMEOUT'            // 503 – yt-dlp or caption fetch exceeded its deadline
  | 'SKIPPED'            // 503 – batch aborted after an earlier block; not attempted
  | 'VIDEO_UNAVAILABLE'  // 500 – private / removed / region-locked etc.
  | 'BACKEND_FAILURE';   // 500 – yt-dlp missing, unparsable output, unexpected error

const HTTP_STATUS: Record<TranscriptErrorCode, number> = {
  NO_CAPTIONS: 404,
  LANG_UNAVAILABLE: 404,
  BLOCKED: 503,
  RATE_LIMITED: 503,
  TIMEOUT: 503,
  SKIPPED: 503,
  VIDEO_UNAVAILABLE: 500,
  BACKEND_FAILURE: 500,
};

const RETRYABLE: ReadonlySet<TranscriptErrorCode> = new Set(['BLOCKED', 'RATE_LIMITED', 'TIMEOUT', 'SKIPPED']);

export interface AvailableLanguages {
  manual: string[];
  auto: string[];
}

export class TranscriptError extends Error {
  readonly code: TranscriptErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly reason: string;
  readonly availableLanguages?: AvailableLanguages;
  /** true when this result was served from the transcript cache (cached NO_CAPTIONS) */
  readonly cached: boolean;

  constructor(code: TranscriptErrorCode, reason: string, extra: { availableLanguages?: AvailableLanguages; cause?: unknown; cached?: boolean } = {}) {
    super(`${code}: ${reason}`);
    this.name = 'TranscriptError';
    this.code = code;
    this.reason = reason;
    this.httpStatus = HTTP_STATUS[code];
    this.retryable = RETRYABLE.has(code);
    this.availableLanguages = extra.availableLanguages;
    this.cached = extra.cached ?? false;
    if (extra.cause !== undefined) {
      (this as { cause?: unknown }).cause = extra.cause;
    }
  }

  /** Shape used both for single-video error responses and the batch error map. */
  toJSON(): Record<string, unknown> {
    const base: Record<string, unknown> = { code: this.code, reason: this.reason, retryable: this.retryable, status: this.httpStatus };
    if (this.httpStatus === 404) {
      base.available = false;
      if (this.availableLanguages) base.availableLanguages = this.availableLanguages;
      base.cached = this.cached;
    }
    if (this.httpStatus === 500) {
      // `error` kept for consumers of the pre-2026-09 API that read res.body.error
      base.error = this.reason;
    }
    return base;
  }
}

export function isTranscriptError(err: unknown): err is TranscriptError {
  return err instanceof TranscriptError;
}
