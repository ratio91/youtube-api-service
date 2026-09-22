import { log, errorMessage } from '../log';
import { TranscriptError, isTranscriptError } from './errors';
import { TranscriptEntry, parseJson3, toPlainText } from './json3';
import { CaptionInfo, SelectedTrack, TrackKind, requestHeaders, selectTrack } from './select';
import { YtDlpRunner, classifyFailure, detectBlockSignal, parseInfoJson } from './ytdlp';

export type TranscriptFormat = 'json' | 'text';

export interface TranscriptOptions {
  lang?: string;
  format?: TranscriptFormat;
}

export interface TranscriptResult {
  videoId: string;
  lang: string;
  kind: TrackKind;
  /** present when format=json (default) */
  transcript?: TranscriptEntry[];
  /** present when format=text */
  text?: string;
}

export interface BatchResult {
  transcripts: Record<string, TranscriptEntry[] | string | null>;
  errors: Record<string, ReturnType<TranscriptError['toJSON']>>;
  /** track metadata for the successes */
  tracks: Record<string, { lang: string; kind: TrackKind }>;
}

export interface CaptionFetchResponse {
  status: number;
  body: string;
}
export type CaptionFetcher = (url: string, headers: Record<string, string>) => Promise<CaptionFetchResponse>;

export interface TranscriptServiceDeps {
  run: YtDlpRunner;
  fetchCaptions?: CaptionFetcher;
  sleep?: (ms: number) => Promise<void>;
  config: {
    binary: string;
    batchDelayMs: number;
    maxAttempts: number;
    retryDelayMs: number;
  };
}

const RETRY_CODES = new Set(['RATE_LIMITED', 'TIMEOUT']);
const CAPTION_FETCH_TIMEOUT_MS = 30_000;

export async function defaultCaptionFetcher(url: string, headers: Record<string, string>): Promise<CaptionFetchResponse> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(CAPTION_FETCH_TIMEOUT_MS) });
  return { status: res.status, body: await res.text() };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TranscriptService {
  private readonly run: YtDlpRunner;
  private readonly fetchCaptions: CaptionFetcher;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cfg: TranscriptServiceDeps['config'];
  // All YouTube traffic is serialised through this chain so parallel n8n calls
  // never burst (bursts are what escalate soft-blocks).
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: TranscriptServiceDeps) {
    this.run = deps.run;
    this.fetchCaptions = deps.fetchCaptions ?? defaultCaptionFetcher;
    this.sleep = deps.sleep ?? defaultSleep;
    this.cfg = deps.config;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async getTranscript(videoId: string, opts: TranscriptOptions = {}): Promise<TranscriptResult> {
    return this.enqueue(() => this.getWithRetry(videoId, opts));
  }

  async getBatch(videoIds: string[], opts: TranscriptOptions = {}): Promise<BatchResult> {
    return this.enqueue(async () => {
      const out: BatchResult = { transcripts: {}, errors: {}, tracks: {} };
      let abortedBy: TranscriptError | null = null;
      for (let i = 0; i < videoIds.length; i++) {
        const id = videoIds[i];
        if (abortedBy) {
          out.transcripts[id] = null;
          out.errors[id] = new TranscriptError('SKIPPED', `not attempted: batch aborted after ${abortedBy.code} on an earlier video`).toJSON();
          continue;
        }
        if (i > 0 && this.cfg.batchDelayMs > 0) await this.sleep(this.cfg.batchDelayMs);
        try {
          const r = await this.getWithRetry(id, opts);
          out.transcripts[id] = opts.format === 'text' ? (r.text ?? '') : (r.transcript ?? []);
          out.tracks[id] = { lang: r.lang, kind: r.kind };
        } catch (err) {
          const te = toTranscriptError(err);
          out.transcripts[id] = null;
          out.errors[id] = te.toJSON();
          if (te.code === 'BLOCKED' || te.code === 'RATE_LIMITED') {
            abortedBy = te;
            log('warn', 'batch.aborted', { videoId: id, code: te.code, remaining: videoIds.length - i - 1 });
          }
        }
      }
      return out;
    });
  }

  private async getWithRetry(videoId: string, opts: TranscriptOptions): Promise<TranscriptResult> {
    let lastErr: TranscriptError | undefined;
    for (let attempt = 1; attempt <= this.cfg.maxAttempts; attempt++) {
      try {
        return await this.getOnce(videoId, opts, attempt);
      } catch (err) {
        const te = toTranscriptError(err);
        lastErr = te;
        const canRetry = RETRY_CODES.has(te.code) && attempt < this.cfg.maxAttempts;
        log(te.httpStatus >= 500 ? 'warn' : 'info', 'transcript.failed', { videoId, attempt, code: te.code, reason: te.reason, retry: canRetry });
        if (!canRetry) throw te;
        await this.sleep(this.cfg.retryDelayMs);
      }
    }
    throw lastErr ?? new TranscriptError('BACKEND_FAILURE', 'no attempts made');
  }

  private async getOnce(videoId: string, opts: TranscriptOptions, attempt: number): Promise<TranscriptResult> {
    const t0 = performance.now();
    const result = await this.run(videoId);
    const tYtDlp = performance.now();

    if (result.spawnError || result.timedOut || result.exitCode !== 0) {
      throw classifyFailure(result, this.cfg.binary);
    }

    const info: CaptionInfo = parseInfoJson(result.stdout);
    let track: SelectedTrack;
    try {
      track = selectTrack(info, opts.lang);
    } catch (err) {
      // An exit-0 run whose tracks were discarded for a PO token is a block, not "no captions" (A5.4).
      if (isTranscriptError(err) && err.code === 'NO_CAPTIONS') {
        const blocked = detectBlockSignal(result.stderr);
        if (blocked) throw blocked;
      }
      throw err;
    }

    const res = await this.fetchCaptions(track.url, requestHeaders(info));
    const tFetch = performance.now();
    if (res.status === 429) throw new TranscriptError('RATE_LIMITED', 'caption download answered HTTP 429');
    if (res.status === 403) throw new TranscriptError('BLOCKED', 'caption download answered HTTP 403');
    if (res.status < 200 || res.status >= 300) throw new TranscriptError('BACKEND_FAILURE', `caption download answered HTTP ${res.status}`);
    if (!res.body.trim()) throw new TranscriptError('RATE_LIMITED', 'caption download returned an empty body (soft block)');

    const entries = parseJson3(res.body, track.lang);
    const tParse = performance.now();

    log('info', 'transcript.ok', {
      videoId,
      attempt,
      lang: track.lang,
      kind: track.kind,
      entries: entries.length,
      ms: { ytdlp: Math.round(tYtDlp - t0), fetch: Math.round(tFetch - tYtDlp), parse: Math.round(tParse - tFetch), total: Math.round(tParse - t0) },
      stderrLines: result.stderr ? result.stderr.split('\n').filter(Boolean).length : 0,
    });

    const base = { videoId, lang: track.lang, kind: track.kind };
    return opts.format === 'text' ? { ...base, text: toPlainText(entries) } : { ...base, transcript: entries };
  }
}

export function toTranscriptError(err: unknown): TranscriptError {
  if (isTranscriptError(err)) return err;
  return new TranscriptError('BACKEND_FAILURE', errorMessage(err), { cause: err });
}
