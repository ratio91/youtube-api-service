import { log, errorMessage } from '../log';
import { TranscriptError, isTranscriptError } from './errors';
import { TranscriptEntry, parseJson3, toPlainText } from './json3';
import { CaptionInfo, SelectedTrack, TrackKind, requestHeaders, selectTrack } from './select';
import { YtDlpRunner, classifyFailure, detectBlockSignal, parseInfoJson } from './ytdlp';
import { CacheListEntry, TranscriptCache, TrackRecord } from './cache';

export type TranscriptFormat = 'json' | 'text';

export interface TranscriptOptions {
  lang?: string;
  format?: TranscriptFormat;
  /** bypass the cache read and overwrite the cached file */
  refresh?: boolean;
}

export interface TranscriptResult {
  videoId: string;
  lang: string;
  kind: TrackKind;
  cached: boolean;
  fetchedAt: string;
  /** present when format=json (default) */
  transcript?: TranscriptEntry[];
  /** present when format=text */
  text?: string;
}

export interface BatchResult {
  transcripts: Record<string, TranscriptEntry[] | string | null>;
  errors: Record<string, ReturnType<TranscriptError['toJSON']>>;
  /** track metadata for the successes */
  tracks: Record<string, { lang: string; kind: TrackKind; cached: boolean }>;
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
  cache?: TranscriptCache;
  /** yt-dlp version as probed at startup; recorded in cache files */
  backendVersion?: () => string | null;
  now?: () => number;
  config: {
    binary: string;
    batchDelayMs: number;
    maxAttempts: number;
    retryDelayMs: number;
  };
}

interface FetchedTrack {
  lang: string;
  kind: TrackKind;
  entries: TranscriptEntry[];
}

const RETRY_CODES = new Set(['RATE_LIMITED', 'TIMEOUT']);
const CAPTION_FETCH_TIMEOUT_MS = 30_000;
const BACKEND = 'yt-dlp';

export async function defaultCaptionFetcher(url: string, headers: Record<string, string>): Promise<CaptionFetchResponse> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(CAPTION_FETCH_TIMEOUT_MS) });
  return { status: res.status, body: await res.text() };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TranscriptService {
  private readonly run: YtDlpRunner;
  private readonly fetchCaptions: CaptionFetcher;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache?: TranscriptCache;
  private readonly backendVersion: () => string | null;
  private readonly now: () => number;
  private readonly cfg: TranscriptServiceDeps['config'];
  // All YouTube traffic is serialised through this chain so parallel n8n calls
  // never burst (bursts are what escalate soft-blocks). Cache reads bypass it.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: TranscriptServiceDeps) {
    this.run = deps.run;
    this.fetchCaptions = deps.fetchCaptions ?? defaultCaptionFetcher;
    this.sleep = deps.sleep ?? defaultSleep;
    this.cache = deps.cache;
    this.backendVersion = deps.backendVersion ?? (() => null);
    this.now = deps.now ?? (() => Date.now());
    this.cfg = deps.config;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async getTranscript(videoId: string, opts: TranscriptOptions = {}): Promise<TranscriptResult> {
    if (!opts.refresh) {
      const hit = await this.fromCache(videoId, opts);
      if (hit) return hit;
    }
    return this.enqueue(async () => {
      // Re-check: an identical request queued right behind us may have filled the cache.
      if (!opts.refresh) {
        const hit = await this.fromCache(videoId, opts);
        if (hit) return hit;
      }
      return this.fetchAndStore(videoId, opts);
    });
  }

  async getBatch(videoIds: string[], opts: TranscriptOptions = {}): Promise<BatchResult> {
    return this.enqueue(async () => {
      const out: BatchResult = { transcripts: {}, errors: {}, tracks: {} };
      let abortedBy: TranscriptError | null = null;
      let fetchedAny = false;

      const record = (id: string, r: TranscriptResult) => {
        out.transcripts[id] = opts.format === 'text' ? (r.text ?? '') : (r.transcript ?? []);
        out.tracks[id] = { lang: r.lang, kind: r.kind, cached: r.cached };
      };
      const fail = (id: string, te: TranscriptError) => {
        out.transcripts[id] = null;
        out.errors[id] = te.toJSON();
      };

      for (const id of videoIds) {
        if (abortedBy) {
          fail(id, new TranscriptError('SKIPPED', `not attempted: batch aborted after ${abortedBy.code} on an earlier video`));
          continue;
        }
        if (!opts.refresh) {
          try {
            const hit = await this.fromCache(id, opts);
            if (hit) {
              record(id, hit);
              continue; // no YouTube traffic → no delay needed
            }
          } catch (err) {
            fail(id, toTranscriptError(err)); // cached NO_CAPTIONS
            continue;
          }
        }
        if (fetchedAny && this.cfg.batchDelayMs > 0) await this.sleep(this.cfg.batchDelayMs);
        fetchedAny = true;
        try {
          record(id, await this.fetchAndStore(id, opts));
        } catch (err) {
          const te = toTranscriptError(err);
          fail(id, te);
          if (te.code === 'BLOCKED' || te.code === 'RATE_LIMITED') {
            abortedBy = te;
            log('warn', 'batch.aborted', { videoId: id, code: te.code, remaining: videoIds.length - videoIds.indexOf(id) - 1 });
          }
        }
      }
      return out;
    });
  }

  async listCached(): Promise<CacheListEntry[]> {
    return this.cache ? this.cache.list() : [];
  }

  // --- cache ---------------------------------------------------------------------

  /** Returns a result on hit, null on miss; throws a cached NO_CAPTIONS error. */
  private async fromCache(videoId: string, opts: TranscriptOptions): Promise<TranscriptResult | null> {
    if (!this.cache) return null;
    const hit = await this.cache.get(videoId, opts.lang);
    if (!hit) return null;
    if (hit.type === 'none') {
      log('info', 'transcript.cache_hit', { videoId, kind: 'none', fetchedAt: hit.record.fetchedAt });
      throw new TranscriptError('NO_CAPTIONS', hit.record.reason, { cached: true });
    }
    const { record } = hit;
    log('info', 'transcript.cache_hit', { videoId, lang: record.lang, kind: record.kind, fetchedAt: record.fetchedAt });
    const entries: TranscriptEntry[] = record.segments.map((s) => ({ ...s, lang: record.lang }));
    return this.toResult(videoId, { lang: record.lang, kind: record.kind, entries }, opts.format, true, record.fetchedAt);
  }

  private async fetchAndStore(videoId: string, opts: TranscriptOptions): Promise<TranscriptResult> {
    const fetchedAt = new Date(this.now()).toISOString();
    let track: FetchedTrack;
    try {
      track = await this.getWithRetry(videoId, opts.lang);
    } catch (err) {
      const te = toTranscriptError(err);
      // Only a definitive "no captions" is cached; retryable and other errors never are.
      if (te.code === 'NO_CAPTIONS' && this.cache) {
        await this.cache.putNone(videoId, te.reason, BACKEND, this.backendVersion());
      }
      throw te;
    }
    if (this.cache) {
      const record: TrackRecord = {
        version: 1,
        videoId,
        lang: track.lang,
        kind: track.kind,
        ...(opts.lang ? {} : { default: true }),
        fetchedAt,
        backend: BACKEND,
        backendVersion: this.backendVersion(),
        segments: track.entries.map(({ text, offset, duration }) => ({ text, offset, duration })),
      };
      await this.cache.putTrack(record);
    }
    return this.toResult(videoId, track, opts.format, false, fetchedAt);
  }

  private toResult(videoId: string, track: FetchedTrack, format: TranscriptFormat | undefined, cached: boolean, fetchedAt: string): TranscriptResult {
    const base = { videoId, lang: track.lang, kind: track.kind, cached, fetchedAt };
    return format === 'text' ? { ...base, text: toPlainText(track.entries) } : { ...base, transcript: track.entries };
  }

  // --- fetching ------------------------------------------------------------------

  private async getWithRetry(videoId: string, lang?: string): Promise<FetchedTrack> {
    let lastErr: TranscriptError | undefined;
    for (let attempt = 1; attempt <= this.cfg.maxAttempts; attempt++) {
      try {
        return await this.fetchOnce(videoId, lang, attempt);
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

  private async fetchOnce(videoId: string, lang: string | undefined, attempt: number): Promise<FetchedTrack> {
    const t0 = performance.now();
    const result = await this.run(videoId);
    const tYtDlp = performance.now();

    if (result.spawnError || result.timedOut || result.exitCode !== 0) {
      throw classifyFailure(result, this.cfg.binary);
    }

    const info: CaptionInfo = parseInfoJson(result.stdout);
    let track: SelectedTrack;
    try {
      track = selectTrack(info, lang);
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

    return { lang: track.lang, kind: track.kind, entries };
  }
}

export function toTranscriptError(err: unknown): TranscriptError {
  if (isTranscriptError(err)) return err;
  return new TranscriptError('BACKEND_FAILURE', errorMessage(err), { cause: err });
}
