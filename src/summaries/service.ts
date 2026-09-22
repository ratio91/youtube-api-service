import { TranscriptService } from '../transcripts/service';
import { primarySubtag, TrackKind } from '../transcripts/select';
import { isTranscriptError } from '../transcripts/errors';
import { isLlmError } from '../llm/errors';
import { Summarizer } from './summarizer';
import { SummaryRecord, SummaryListEntry, SummaryStore } from './store';
import { ObsidianExporter } from '../notes/obsidian';
import { log, errorMessage } from '../log';

export interface SummaryOptions {
  /** transcript track language */
  lang?: string;
  /** language of the summary; defaults to the transcript language */
  summaryLang?: string;
  /** regenerate even when a cached summary exists */
  refresh?: boolean;
  /** (re)write the Obsidian note even for a cached summary */
  export?: boolean;
}

export interface SummaryResult {
  videoId: string;
  title?: string;
  channel?: string;
  durationSec?: number;
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
  /** Obsidian note export outcome for this request (absent when export is disabled) */
  note?: { exported: boolean; path?: string; fileName?: string; error?: string };
}

export class SummaryService {
  // llama-server runs one slot; never let two summaries compete for it.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: { transcripts: TranscriptService; summarizer: Summarizer; store: SummaryStore; exporter?: ObsidianExporter; now?: () => number }
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
        // Cache hits never re-create a note (a note moved out of the inbox must stay gone) — unless asked.
        return opts.export ? this.withExport(hit, true) : toResult(hit, true);
      }
    }

    return this.enqueue(async () => {
      if (!opts.refresh) {
        const hit = await this.deps.store.get(videoId, summaryLang);
        if (hit) return opts.export ? this.withExport(hit, true) : toResult(hit, true);
      }
      const createdAt = new Date((this.deps.now ?? Date.now)()).toISOString();
      const out = await this.deps.summarizer.summarize({ videoId, title: track.title, lang: track.lang, entries: track.entries, summaryLang });
      const record: SummaryRecord = {
        version: 1,
        videoId,
        ...(track.title ? { title: track.title } : {}),
        ...(track.channel ? { channel: track.channel } : {}),
        ...(track.durationSec ? { durationSec: track.durationSec } : {}),
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
      // A freshly generated summary always produces its note.
      return this.withExport(record, false);
    });
  }

  listSummaries(): Promise<SummaryListEntry[]> {
    return this.deps.store.list();
  }

  /** Export the note (when an exporter is configured); failures are reported, never thrown. */
  private async withExport(record: SummaryRecord, cached: boolean): Promise<SummaryResult> {
    const result = toResult(record, cached);
    if (!this.deps.exporter) return result;
    try {
      const r = await this.deps.exporter.export(record);
      const updated: SummaryRecord = { ...record, exportedAt: new Date((this.deps.now ?? Date.now)()).toISOString(), exportPath: r.path };
      await this.deps.store.put(updated);
      return { ...result, note: { exported: true, path: r.path, fileName: r.fileName } };
    } catch (err) {
      log('error', 'notes.export_failed', { videoId: record.videoId, error: errorMessage(err) });
      return { ...result, note: { exported: false, error: errorMessage(err) } };
    }
  }
}

function toResult(r: SummaryRecord, cached: boolean): SummaryResult {
  return {
    videoId: r.videoId,
    ...(r.title ? { title: r.title } : {}),
    ...(r.channel ? { channel: r.channel } : {}),
    ...(r.durationSec ? { durationSec: r.durationSec } : {}),
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
