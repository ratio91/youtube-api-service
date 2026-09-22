import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { z } from 'zod';
import { log, errorMessage } from '../log';
import { TrackKind, primarySubtag } from './select';
import { VIDEO_ID_RE } from './ytdlp';

/**
 * Persistent transcript cache: one JSON file per video and track.
 *
 *   <videoId>.<lang>.json   a fetched track (segments in ms, no per-segment lang)
 *   <videoId>.none.json     "video has no captions", trusted until `expiresAt`
 *
 * Writes are atomic (temp file in the same directory + rename). Reads validate the
 * schema; an unreadable or invalid file is logged and treated as a miss so the next
 * fetch overwrites it. Cache failures never fail a request — the cache is an
 * optimisation, `writable`/`error` are surfaced through /health instead.
 */

export interface CachedSegment {
  text: string;
  /** ms */
  offset: number;
  /** ms */
  duration: number;
}

export const trackRecordSchema = z.object({
  version: z.literal(1),
  videoId: z.string().regex(VIDEO_ID_RE),
  title: z.string().optional(),
  channel: z.string().optional(),
  /** video length in seconds as reported by yt-dlp */
  durationSec: z.number().optional(),
  lang: z.string().min(1),
  kind: z.enum(['manual', 'auto']),
  /** written by a request without ?lang= → preferred hit for later default requests */
  default: z.boolean().optional(),
  fetchedAt: z.string().datetime(),
  backend: z.string(),
  backendVersion: z.string().nullable(),
  segments: z.array(z.object({ text: z.string(), offset: z.number(), duration: z.number() })),
});
export type TrackRecord = z.infer<typeof trackRecordSchema>;

export const noneRecordSchema = z.object({
  version: z.literal(1),
  videoId: z.string().regex(VIDEO_ID_RE),
  kind: z.literal('none'),
  fetchedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  reason: z.string(),
  backend: z.string(),
  backendVersion: z.string().nullable(),
});
export type NoneRecord = z.infer<typeof noneRecordSchema>;

export type CacheHit = { type: 'track'; record: TrackRecord } | { type: 'none'; record: NoneRecord };

export interface CacheListEntry {
  videoId: string;
  lang: string | null;
  kind: TrackKind | 'none';
  fetchedAt: string;
  expiresAt?: string;
}

export interface CacheStats {
  dir: string;
  files: number;
  sizeBytes: number;
  writable: boolean;
  error?: string;
}

export interface TranscriptCacheOptions {
  dir: string;
  noCaptionsTtlMs: number;
  now?: () => number;
  /** memo lifetime for list()/stats(), default 60 s */
  memoMs?: number;
}

const NONE_LANG = 'none';
const FILE_RE = /^([A-Za-z0-9_-]{11})\.([A-Za-z0-9-]+)\.json$/;

function fileName(videoId: string, lang: string): string {
  return `${videoId}.${lang}.json`;
}

export class TranscriptCache {
  readonly dir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly memoMs: number;
  private writable = false;
  private initError?: string;
  private listMemo: { at: number; value: CacheListEntry[] } | null = null;
  private statsMemo: { at: number; value: CacheStats } | null = null;

  constructor(opts: TranscriptCacheOptions) {
    this.dir = opts.dir;
    this.ttlMs = opts.noCaptionsTtlMs;
    this.now = opts.now ?? (() => Date.now());
    this.memoMs = opts.memoMs ?? 60_000;
  }

  /** Create the directory and verify it is writable. Never throws. */
  async init(): Promise<void> {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      const probe = path.join(this.dir, `.write-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      await fsp.writeFile(probe, 'ok');
      await fsp.unlink(probe);
      this.writable = true;
      this.initError = undefined;
      log('info', 'cache.ready', { dir: this.dir });
    } catch (err) {
      this.writable = false;
      this.initError = errorMessage(err);
      log('error', 'cache.unwritable', { dir: this.dir, error: this.initError });
    }
  }

  isWritable(): boolean {
    return this.writable;
  }

  // --- lookups ----------------------------------------------------------------

  async get(videoId: string, lang?: string): Promise<CacheHit | null> {
    if (!VIDEO_ID_RE.test(videoId)) return null;
    if (lang) {
      const exact = await this.readTrack(fileName(videoId, lang));
      if (exact) return { type: 'track', record: exact };
    }
    const files = await this.filesFor(videoId);
    const trackFiles = files.filter((f) => f.lang !== NONE_LANG);
    const noneFile = files.find((f) => f.lang === NONE_LANG);

    if (lang) {
      const wanted = primarySubtag(lang);
      for (const f of trackFiles) {
        if (primarySubtag(f.lang) === wanted) {
          const rec = await this.readTrack(f.name);
          if (rec) return { type: 'track', record: rec };
        }
      }
      // No track in that language, but the video is known to have none at all → 404 from cache.
      if (noneFile) {
        const none = await this.readNone(noneFile.name);
        if (none) return { type: 'none', record: none };
      }
      return null;
    }

    const candidates: TrackRecord[] = [];
    for (const f of trackFiles) {
      const rec = await this.readTrack(f.name);
      if (rec) candidates.push(rec);
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        if ((b.default ? 1 : 0) !== (a.default ? 1 : 0)) return (b.default ? 1 : 0) - (a.default ? 1 : 0);
        if (a.kind !== b.kind) return a.kind === 'manual' ? -1 : 1;
        return a.fetchedAt.localeCompare(b.fetchedAt);
      });
      return { type: 'track', record: candidates[0] };
    }
    if (noneFile) {
      const none = await this.readNone(noneFile.name);
      if (none) return { type: 'none', record: none };
    }
    return null;
  }

  // --- writes -----------------------------------------------------------------

  async putTrack(record: TrackRecord): Promise<boolean> {
    const parsed = trackRecordSchema.safeParse(record);
    if (!parsed.success) {
      log('warn', 'cache.write_skipped', { videoId: record.videoId, error: parsed.error.issues[0]?.message });
      return false;
    }
    const ok = await this.writeAtomic(fileName(record.videoId, record.lang), parsed.data);
    if (ok) await this.removeIfExists(fileName(record.videoId, NONE_LANG)); // captions exist after all
    return ok;
  }

  async putNone(videoId: string, reason: string, backend: string, backendVersion: string | null): Promise<boolean> {
    const fetchedAt = new Date(this.now());
    const record: NoneRecord = {
      version: 1,
      videoId,
      kind: 'none',
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: new Date(fetchedAt.getTime() + this.ttlMs).toISOString(),
      reason,
      backend,
      backendVersion,
    };
    return this.writeAtomic(fileName(videoId, NONE_LANG), record);
  }

  // --- listing / stats ----------------------------------------------------------

  async list(): Promise<CacheListEntry[]> {
    if (this.listMemo && this.now() - this.listMemo.at < this.memoMs) return this.listMemo.value;
    const entries: CacheListEntry[] = [];
    for (const f of await this.allFiles()) {
      if (f.lang === NONE_LANG) {
        const rec = await this.readNone(f.name, { keepExpired: true });
        if (rec) entries.push({ videoId: rec.videoId, lang: null, kind: 'none', fetchedAt: rec.fetchedAt, expiresAt: rec.expiresAt });
      } else {
        const rec = await this.readTrack(f.name);
        if (rec) entries.push({ videoId: rec.videoId, lang: rec.lang, kind: rec.kind, fetchedAt: rec.fetchedAt });
      }
    }
    entries.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
    this.listMemo = { at: this.now(), value: entries };
    return entries;
  }

  async stats(): Promise<CacheStats> {
    if (this.statsMemo && this.now() - this.statsMemo.at < this.memoMs) return this.statsMemo.value;
    let files = 0;
    let sizeBytes = 0;
    let error = this.initError;
    try {
      for (const f of await this.allFiles()) {
        try {
          const st = await fsp.stat(path.join(this.dir, f.name));
          files++;
          sizeBytes += st.size;
        } catch {
          /* file vanished between readdir and stat */
        }
      }
    } catch (err) {
      error = errorMessage(err);
    }
    const value: CacheStats = { dir: this.dir, files, sizeBytes, writable: this.writable, ...(error ? { error } : {}) };
    this.statsMemo = { at: this.now(), value };
    return value;
  }

  // --- internals ---------------------------------------------------------------

  private invalidateMemo(): void {
    this.listMemo = null;
    this.statsMemo = null;
  }

  private async allFiles(): Promise<{ name: string; videoId: string; lang: string }[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: { name: string; videoId: string; lang: string }[] = [];
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (m) out.push({ name, videoId: m[1], lang: m[2] });
    }
    return out;
  }

  private async filesFor(videoId: string): Promise<{ name: string; videoId: string; lang: string }[]> {
    try {
      return (await this.allFiles()).filter((f) => f.videoId === videoId);
    } catch (err) {
      log('warn', 'cache.readdir_failed', { dir: this.dir, error: errorMessage(err) });
      return [];
    }
  }

  private async readJson(name: string): Promise<unknown | null> {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.dir, name), 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log('warn', 'cache.read_failed', { file: name, error: errorMessage(err) });
      }
      return null;
    }
  }

  private async readTrack(name: string): Promise<TrackRecord | null> {
    const raw = await this.readJson(name);
    if (raw === null) return null;
    const parsed = trackRecordSchema.safeParse(raw);
    if (!parsed.success) {
      log('warn', 'cache.invalid_file', { file: name, error: parsed.error.issues[0]?.message });
      return null;
    }
    return parsed.data;
  }

  private async readNone(name: string, opts: { keepExpired?: boolean } = {}): Promise<NoneRecord | null> {
    const raw = await this.readJson(name);
    if (raw === null) return null;
    const parsed = noneRecordSchema.safeParse(raw);
    if (!parsed.success) {
      log('warn', 'cache.invalid_file', { file: name, error: parsed.error.issues[0]?.message });
      return null;
    }
    if (!opts.keepExpired && Date.parse(parsed.data.expiresAt) <= this.now()) {
      await this.removeIfExists(name);
      log('info', 'cache.none_expired', { videoId: parsed.data.videoId });
      return null;
    }
    return parsed.data;
  }

  private async writeAtomic(name: string, data: unknown): Promise<boolean> {
    const finalPath = path.join(this.dir, name);
    const tmpPath = path.join(this.dir, `.${name}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(tmpPath, JSON.stringify(data), { mode: 0o644 });
      await fsp.rename(tmpPath, finalPath);
      this.writable = true;
      this.initError = undefined;
      this.invalidateMemo();
      return true;
    } catch (err) {
      this.writable = false;
      this.initError = errorMessage(err);
      log('error', 'cache.write_failed', { file: name, error: this.initError });
      try {
        if (fs.existsSync(tmpPath)) await fsp.unlink(tmpPath);
      } catch {
        /* best effort */
      }
      return false;
    }
  }

  private async removeIfExists(name: string): Promise<void> {
    try {
      await fsp.unlink(path.join(this.dir, name));
      this.invalidateMemo();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log('warn', 'cache.unlink_failed', { file: name, error: errorMessage(err) });
      }
    }
  }
}
