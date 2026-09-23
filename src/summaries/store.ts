import * as fsp from 'fs/promises';
import { z } from 'zod';
import { VIDEO_ID_RE } from '../transcripts/ytdlp';
import { TrackKind } from '../transcripts/select';
import { CacheStats } from '../transcripts/cache';
import { dirStats, ensureWritableDir, readJsonValidated, writeJsonAtomic } from '../util/jsonfiles';
import { log, errorMessage } from '../log';

/** Persistent summaries: `<videoId>.<summaryLang>.json` under SUMMARY_CACHE_DIR. */
export const summaryRecordSchema = z.object({
  version: z.literal(1),
  videoId: z.string().regex(VIDEO_ID_RE),
  title: z.string().optional(),
  channel: z.string().optional(),
  durationSec: z.number().optional(),
  /** transcript track used */
  lang: z.string(),
  kind: z.enum(['manual', 'auto']),
  summaryLang: z.string(),
  model: z.string().nullable(),
  promptVersion: z.number().int(),
  strategy: z.enum(['single', 'chunked']),
  chunks: z.number().int(),
  llmCalls: z.number().int(),
  createdAt: z.string().datetime(),
  durationMs: z.number(),
  tokens: z.object({ prompt: z.number(), completion: z.number() }),
  truncated: z.boolean(),
  markdown: z.string(),
  /** Obsidian note export, if it happened */
  exportedAt: z.string().datetime().optional(),
  exportPath: z.string().optional(),
});
export type SummaryRecord = z.infer<typeof summaryRecordSchema>;

export interface SummaryListEntry {
  videoId: string;
  title?: string;
  lang: string;
  kind: TrackKind;
  summaryLang: string;
  model: string | null;
  strategy: 'single' | 'chunked';
  createdAt: string;
  /** when the Obsidian note was last written; absent = never exported */
  exportedAt?: string;
}

const FILE_RE = /^([A-Za-z0-9_-]{11})\.([A-Za-z0-9-]+)\.json$/;

export class SummaryStore {
  readonly dir: string;
  private writable = false;
  private initError?: string;
  private readonly memoMs: number;
  private readonly now: () => number;
  private listMemo: { at: number; value: SummaryListEntry[] } | null = null;
  private statsMemo: { at: number; value: CacheStats } | null = null;

  constructor(opts: { dir: string; memoMs?: number; now?: () => number }) {
    this.dir = opts.dir;
    this.memoMs = opts.memoMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async init(): Promise<void> {
    this.initError = await ensureWritableDir(this.dir);
    this.writable = !this.initError;
    log(this.writable ? 'info' : 'error', this.writable ? 'summaries.ready' : 'summaries.unwritable', { dir: this.dir, ...(this.initError ? { error: this.initError } : {}) });
  }

  isWritable(): boolean {
    return this.writable;
  }

  async get(videoId: string, summaryLang: string): Promise<SummaryRecord | null> {
    if (!VIDEO_ID_RE.test(videoId) || !/^[A-Za-z0-9-]+$/.test(summaryLang)) return null;
    return readJsonValidated(this.dir, `${videoId}.${summaryLang}.json`, summaryRecordSchema);
  }

  /** Newest summary of a video, preferring the given summary languages (any if none match). */
  async latest(videoId: string, preferredLangs: string[] = []): Promise<SummaryRecord | null> {
    if (!VIDEO_ID_RE.test(videoId)) return null;
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log('warn', 'summaries.readdir_failed', { dir: this.dir, error: errorMessage(err) });
      return null;
    }
    const recs: SummaryRecord[] = [];
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m || m[1] !== videoId) continue;
      const rec = await readJsonValidated(this.dir, name, summaryRecordSchema);
      if (rec) recs.push(rec);
    }
    recs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return recs.find((r) => preferredLangs.includes(r.summaryLang)) ?? recs[0] ?? null;
  }

  async put(record: SummaryRecord): Promise<boolean> {
    const parsed = summaryRecordSchema.safeParse(record);
    if (!parsed.success) {
      log('warn', 'summaries.write_skipped', { videoId: record.videoId, error: parsed.error.issues[0]?.message });
      return false;
    }
    const r = await writeJsonAtomic(this.dir, `${record.videoId}.${record.summaryLang}.json`, parsed.data);
    this.writable = r.ok;
    this.initError = r.error;
    this.listMemo = null;
    this.statsMemo = null;
    return r.ok;
  }

  async list(): Promise<SummaryListEntry[]> {
    if (this.listMemo && this.now() - this.listMemo.at < this.memoMs) return this.listMemo.value;
    const out: SummaryListEntry[] = [];
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log('warn', 'summaries.readdir_failed', { dir: this.dir, error: errorMessage(err) });
    }
    for (const name of names) {
      if (!FILE_RE.test(name)) continue;
      const rec = await readJsonValidated(this.dir, name, summaryRecordSchema);
      if (rec) out.push({ videoId: rec.videoId, title: rec.title, lang: rec.lang, kind: rec.kind, summaryLang: rec.summaryLang, model: rec.model, strategy: rec.strategy, createdAt: rec.createdAt, ...(rec.exportedAt ? { exportedAt: rec.exportedAt } : {}) });
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.listMemo = { at: this.now(), value: out };
    return out;
  }

  async stats(): Promise<CacheStats> {
    if (this.statsMemo && this.now() - this.statsMemo.at < this.memoMs) return this.statsMemo.value;
    let error = this.initError;
    let s = { files: 0, sizeBytes: 0 };
    try {
      s = await dirStats(this.dir, FILE_RE);
    } catch (err) {
      error = errorMessage(err);
    }
    const value: CacheStats = { dir: this.dir, ...s, writable: this.writable, ...(error ? { error } : {}) };
    this.statsMemo = { at: this.now(), value };
    return value;
  }
}
