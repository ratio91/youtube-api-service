export type LlmErrorCode =
  | 'LLM_UNAVAILABLE'       // 503 – connection refused / DNS / reset
  | 'LLM_TIMEOUT'           // 503 – no answer within LLM_TIMEOUT_MS
  | 'LLM_OVERLOADED'        // 503 – HTTP 429/503 from the server
  | 'LLM_CONTEXT_OVERFLOW'  // 500 – prompt did not fit; the summarizer chunks before this reaches a client
  | 'LLM_BAD_RESPONSE'      // 500 – unparsable / schema-invalid answer
  | 'LLM_REQUEST_FAILED';   // 500 – any other HTTP error

const HTTP_STATUS: Record<LlmErrorCode, number> = {
  LLM_UNAVAILABLE: 503,
  LLM_TIMEOUT: 503,
  LLM_OVERLOADED: 503,
  LLM_CONTEXT_OVERFLOW: 500,
  LLM_BAD_RESPONSE: 500,
  LLM_REQUEST_FAILED: 500,
};

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly reason: string;
  readonly detail?: Record<string, unknown>;

  constructor(code: LlmErrorCode, reason: string, extra: { cause?: unknown; detail?: Record<string, unknown> } = {}) {
    super(`${code}: ${reason}`);
    this.name = 'LlmError';
    this.code = code;
    this.reason = reason;
    this.httpStatus = HTTP_STATUS[code];
    this.retryable = this.httpStatus === 503;
    this.detail = extra.detail;
    if (extra.cause !== undefined) (this as { cause?: unknown }).cause = extra.cause;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, reason: this.reason, retryable: this.retryable, status: this.httpStatus, ...(this.httpStatus === 500 ? { error: this.reason } : {}) };
  }
}

export function isLlmError(err: unknown): err is LlmError {
  return err instanceof LlmError;
}
