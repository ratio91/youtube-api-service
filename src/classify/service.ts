import { SummaryStore } from '../summaries/store';
import { LlmQueue } from '../llm/queue';
import { log } from '../log';
import { Classifier } from './classifier';
import { ClassificationRecord, ClassificationStore } from './store';
import { CLASSIFY_PROMPT_VERSION, Playlist, taxonomyHash } from './prompts';

export interface ClassifyResult {
  videoId: string;
  title?: string;
  playlistId: string | null;
  name: string | null;
  confidence: 'high' | 'medium' | 'low';
  runnerUp: string;
  reason: string;
  model: string | null;
  promptVersion: number;
  taxonomyHash: string;
  cached: boolean;
  durationMs: number;
}

/** 409: classification needs the cached summary; the client calls /summary first. */
export class NoSummaryError extends Error {
  readonly httpStatus = 409;
  constructor(readonly videoId: string) {
    super(`no cached summary for ${videoId}; call GET /summary/${videoId} first`);
    this.name = 'NoSummaryError';
  }
  toJSON() {
    return { code: 'NO_SUMMARY', reason: this.message, retryable: false, status: 409 };
  }
}

export function isNoSummaryError(err: unknown): err is NoSummaryError {
  return err instanceof NoSummaryError;
}

export class ClassifyService {
  constructor(
    private readonly deps: {
      summaries: SummaryStore;
      classifier: Classifier;
      store: ClassificationStore;
      queue: LlmQueue;
      /** summary languages to prefer when a video has several (SUMMARY_LANGUAGES) */
      preferredLangs?: string[];
      /** model llama-server currently serves (last probe); null = unknown, cache not keyed on it */
      currentModel?: () => string | null;
      now?: () => number;
    }
  ) {}

  async classify(videoId: string, playlists: Playlist[], opts: { refresh?: boolean } = {}): Promise<ClassifyResult> {
    const summary = await this.deps.summaries.latest(videoId, this.deps.preferredLangs?.length ? this.deps.preferredLangs : ['en', 'de']);
    if (!summary) throw new NoSummaryError(videoId);
    const hash = taxonomyHash(playlists);

    const fresh = (rec: ClassificationRecord | null): rec is ClassificationRecord => {
      if (!rec || opts.refresh) return false;
      const model = this.deps.currentModel?.() ?? null;
      return rec.taxonomyHash === hash && rec.promptVersion === CLASSIFY_PROMPT_VERSION && rec.summaryCreatedAt === summary.createdAt && (model === null || rec.model === model);
    };

    const hit = await this.deps.store.get(videoId);
    if (fresh(hit)) return toResult(hit, true);

    return this.deps.queue.run(async () => {
      const again = await this.deps.store.get(videoId);
      if (fresh(again)) return toResult(again, true);
      const c = await this.deps.classifier.classify(playlists, { title: summary.title, channel: summary.channel, summaryMarkdown: summary.markdown });
      const record: ClassificationRecord = {
        version: 1,
        videoId,
        ...(summary.title ? { title: summary.title } : {}),
        playlistId: c.playlistId,
        name: c.name,
        confidence: c.confidence,
        runnerUp: c.runnerUp,
        reason: c.reason,
        model: c.model,
        promptVersion: CLASSIFY_PROMPT_VERSION,
        taxonomyHash: hash,
        summaryLang: summary.summaryLang,
        summaryCreatedAt: summary.createdAt,
        llmCalls: c.llmCalls,
        createdAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
        durationMs: c.durationMs,
      };
      // An invalid answer is returned as "none" but never cached, so the next call retries.
      if (c.valid) await this.deps.store.put(record);
      log('info', 'classify.ok', { videoId, playlistId: c.playlistId, confidence: c.confidence, valid: c.valid, llmCalls: c.llmCalls, ms: c.durationMs });
      return toResult(record, false);
    });
  }
}

function toResult(r: ClassificationRecord, cached: boolean): ClassifyResult {
  return {
    videoId: r.videoId,
    ...(r.title ? { title: r.title } : {}),
    playlistId: r.playlistId,
    name: r.name,
    confidence: r.confidence,
    runnerUp: r.runnerUp,
    reason: r.reason,
    model: r.model,
    promptVersion: r.promptVersion,
    taxonomyHash: r.taxonomyHash,
    cached,
    durationMs: r.durationMs,
  };
}
