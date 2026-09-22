import { TranscriptService } from '../transcripts/service';
import { primarySubtag, TrackKind } from '../transcripts/select';
import { isTranscriptError } from '../transcripts/errors';
import { isLlmError } from '../llm/errors';
import { Summarizer } from './summarizer';
import { SummaryRecord, SummaryListEntry, SummaryStore } from './store';
import { log, errorMessage } from '../log';

export interface SummaryOptions {
  /** transcript track language */
  lang?: string;
  /** language of the summary; defaults to the transcript language */
  summaryLang?: string;
  /** regenerate even when a cached summary exists */
  refresh?: boolean;
}

export interface SummaryResult {
  videoId: string;
  title?: string;
  lang: string;
  kind: TrackKind;
  summaryLang: string;
  model: string | null;
  promptVersion: number;
  strategy: 'single' | 'chunked';
  chunks: number;
  cached: boolean;
  createdAt: string;
  durationMs: number;
  truncated: boolean;
  markdown: string;
}

export class SummaryService {
  // llama-server runs one slot; never let two summaries compete for it.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: { transcripts: TranscriptService; summarizer: Summarizer; store: SummaryStore; now?: () => number }
  ) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async getSummary(videoId: string, opts: SummaryOptions = {}): Promise<SummaryResult> {
    // Transcript first (normally a cache hit) so the default summary language is known.
    const track = await this.deps.transcripts.getEntries(videoId, { lang: opts.lang });
    const summaryLang = primarySubtag(opts.summaryLang ?? track.lang) || 'en';

    if (!opts.refresh) {
      const hit = await this.deps.store.get(videoId, summaryLang);
      if (hit) {
        log('info', 'summary.cache_hit', { videoId, summaryLang, createdAt: hit.createdAt, model: hit.model });
        return toResult(hit, true);
      }
    }

    return this.enqueue(async () => {
      if (!opts.refresh) {
        const hit = await this.deps.store.get(videoId, summaryLang);
        if (hit) return toResult(hit, true);
      }
      const createdAt = new Date((this.deps.now ?? Date.now)()).toISOString();
      const out = await this.deps.summarizer.summarize({ videoId, title: track.title, lang: track.lang, entries: track.entries, summaryLang });
      const record: SummaryRecord = {
        version: 1,
        videoId,
        ...(track.title ? { title: track.title } : {}),
        lang: track.lang,
        kind: track.kind,
        summaryLang,
        model: out.model,
        promptVersion: out.promptVersion,
        strategy: out.strategy,
        chunks: out.chunks,
        llmCalls: out.llmCalls,
        createdAt,
        durationMs: out.durationMs,
        tokens: out.tokens,
        truncated: out.truncated,
        markdown: out.markdown,
      };
      await this.deps.store.put(record);
      return toResult(record, false);
    });
  }

  listSummaries(): Promise<SummaryListEntry[]> {
    return this.deps.store.list();
  }
}

function toResult(r: SummaryRecord, cached: boolean): SummaryResult {
  return {
    videoId: r.videoId,
    ...(r.title ? { title: r.title } : {}),
    lang: r.lang,
    kind: r.kind,
    summaryLang: r.summaryLang,
    model: r.model,
    promptVersion: r.promptVersion,
    strategy: r.strategy,
    chunks: r.chunks,
    cached,
    createdAt: r.createdAt,
    durationMs: r.durationMs,
    truncated: r.truncated,
    markdown: r.markdown,
  };
}

/** HTTP status + body for any error thrown by getSummary. */
export function summaryErrorResponse(err: unknown): { status: number; body: Record<string, unknown> } {
  if (isTranscriptError(err) || isLlmError(err)) return { status: err.httpStatus, body: err.toJSON() };
  return { status: 500, body: { code: 'SUMMARY_FAILED', error: errorMessage(err), reason: errorMessage(err), retryable: false, status: 500 } };
}
