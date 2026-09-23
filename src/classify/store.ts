import { z } from 'zod';
import { VIDEO_ID_RE } from '../transcripts/ytdlp';
import { CacheStats } from '../transcripts/cache';
import { dirStats, ensureWritableDir, readJsonValidated, writeJsonAtomic } from '../util/jsonfiles';
import { log, errorMessage } from '../log';

/**
 * Persistent classifications: `<videoId>.json` under CLASSIFY_CACHE_DIR, one per video.
 * A record is reused only while taxonomyHash, promptVersion, model and the summary it
 * was made from are unchanged; any change means a new run that overwrites it.
 */
export const classificationRecordSchema = z.object({
  version: z.literal(1),
  videoId: z.string().regex(VIDEO_ID_RE),
  title: z.string().optional(),
  playlistId: z.string().nullable(),
  name: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  runnerUp: z.string(),
  reason: z.string(),
  model: z.string().nullable(),
  promptVersion: z.number().int(),
  taxonomyHash: z.string(),
  summaryLang: z.string(),
  summaryCreatedAt: z.string().datetime(),
  llmCalls: z.number().int(),
  createdAt: z.string().datetime(),
  durationMs: z.number(),
});
export type ClassificationRecord = z.infer<typeof classificationRecordSchema>;

const FILE_RE = /^[A-Za-z0-9_-]{11}\.json$/;

export class ClassificationStore {
  readonly dir: string;
  private writable = false;
  private initError?: string;

  constructor(opts: { dir: string }) {
    this.dir = opts.dir;
  }

  async init(): Promise<void> {
    this.initError = await ensureWritableDir(this.dir);
    this.writable = !this.initError;
    log(this.writable ? 'info' : 'error', this.writable ? 'classifications.ready' : 'classifications.unwritable', { dir: this.dir, ...(this.initError ? { error: this.initError } : {}) });
  }

  isWritable(): boolean {
    return this.writable;
  }

  async get(videoId: string): Promise<ClassificationRecord | null> {
    if (!VIDEO_ID_RE.test(videoId)) return null;
    return readJsonValidated(this.dir, `${videoId}.json`, classificationRecordSchema);
  }

  async put(record: ClassificationRecord): Promise<boolean> {
    const parsed = classificationRecordSchema.safeParse(record);
    if (!parsed.success) {
      log('warn', 'classifications.write_skipped', { videoId: record.videoId, error: parsed.error.issues[0]?.message });
      return false;
    }
    const r = await writeJsonAtomic(this.dir, `${record.videoId}.json`, parsed.data);
    this.writable = r.ok;
    this.initError = r.error;
    return r.ok;
  }

  async stats(): Promise<CacheStats> {
    let error = this.initError;
    let s = { files: 0, sizeBytes: 0 };
    try {
      s = await dirStats(this.dir, FILE_RE);
    } catch (err) {
      error = errorMessage(err);
    }
    return { dir: this.dir, ...s, writable: this.writable, ...(error ? { error } : {}) };
  }
}
