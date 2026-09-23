import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { SummaryRecord } from '../summaries/store';
import { formatTimestamp } from '../summaries/summarizer';
import { dirStats, ensureWritableDir } from '../util/jsonfiles';
import { CacheStats } from '../transcripts/cache';
import { log, errorMessage } from '../log';

/**
 * Writes one Obsidian note per summary into a directory that Syncthing carries into
 * the vault. Filename = sanitized video title; the video id lives only in the
 * frontmatter (`video_id`) so a re-export finds and overwrites the same note even if
 * it was renamed. Temp files go to `<dir>/.tmp` (ignored via .stignore) and are renamed
 * into place, so Syncthing never sees a half-written note.
 */
export interface ObsidianExporterOptions {
  dir: string;
  tags: string[];
}

export interface ExportResult {
  path: string;
  fileName: string;
  created: boolean;
}

const TMP_DIR = '.tmp';
const STIGNORE = `// written by youtube-api-service: temp files of the note exporter
/${TMP_DIR}
`;
// Characters Obsidian refuses in file names, plus path separators and control chars.
const FORBIDDEN = /[\\/:*?"<>|#^[\]\u0000-\u001f]/g;
const MAX_NAME = 120;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const VIDEO_ID_LINE_RE = /^video_id:\s*([A-Za-z0-9_-]{11})\s*$/m;

export interface NoteEntry {
  videoId: string;
  fileName: string;
  modifiedAt: string;
}

export function noteBaseName(title: string | undefined, videoId: string): string {
  let name = (title ?? '').replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').trim();
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).replace(/\s+\S*$/, '').trim();
  return name || `YouTube ${videoId}`;
}

function yamlString(v: string): string {
  return JSON.stringify(v); // JSON strings are valid double-quoted YAML scalars
}

export function renderNote(rec: SummaryRecord, tags: string[]): string {
  const lines = ['---'];
  lines.push(`title: ${yamlString(rec.title ?? `YouTube ${rec.videoId}`)}`);
  lines.push(`source: https://www.youtube.com/watch?v=${rec.videoId}`);
  if (rec.channel) lines.push(`channel: ${yamlString(rec.channel)}`);
  if (rec.durationSec) lines.push(`duration: ${yamlString(formatTimestamp(rec.durationSec * 1000))}`);
  lines.push(`created: ${rec.createdAt}`);
  lines.push(`language: ${rec.summaryLang}`);
  if (rec.model) lines.push(`model: ${yamlString(rec.model)}`);
  lines.push(`tags: [${tags.map((t) => yamlString(t)).join(', ')}]`);
  lines.push(`video_id: ${rec.videoId}`);
  lines.push('---', '');
  lines.push(rec.markdown.trim(), '');
  lines.push(`[▶ YouTube](https://www.youtube.com/watch?v=${rec.videoId})`, '');
  return lines.join('\n');
}

export class ObsidianExporter {
  readonly dir: string;
  private readonly tags: string[];
  private writable = false;
  private initError?: string;

  constructor(opts: ObsidianExporterOptions) {
    this.dir = opts.dir;
    this.tags = opts.tags;
  }

  async init(): Promise<void> {
    this.initError = await ensureWritableDir(path.join(this.dir, TMP_DIR));
    this.writable = !this.initError;
    if (this.writable) {
      try {
        const ignore = path.join(this.dir, '.stignore');
        if (!fs.existsSync(ignore)) await fsp.writeFile(ignore, STIGNORE);
      } catch (err) {
        log('warn', 'notes.stignore_failed', { dir: this.dir, error: errorMessage(err) });
      }
    }
    log(this.writable ? 'info' : 'error', this.writable ? 'notes.ready' : 'notes.unwritable', { dir: this.dir, ...(this.initError ? { error: this.initError } : {}) });
  }

  isWritable(): boolean {
    return this.writable;
  }

  async stats(): Promise<CacheStats> {
    let error = this.initError;
    let s = { files: 0, sizeBytes: 0 };
    try {
      s = await dirStats(this.dir, /\.md$/);
    } catch (err) {
      error = errorMessage(err);
    }
    return { dir: this.dir, ...s, writable: this.writable, ...(error ? { error } : {}) };
  }

  /**
   * Notes currently in the export directory, identified by their frontmatter `video_id`.
   * The directory is the Syncthing mirror of the vault inbox, so a note the operator moved
   * out of the inbox (consumed) disappears from this list.
   */
  async listNotes(): Promise<NoteEntry[]> {
    let names: string[];
    try {
      names = (await fsp.readdir(this.dir)).filter((n) => n.endsWith('.md'));
    } catch {
      return [];
    }
    const out: NoteEntry[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const fh = await fsp.open(file, 'r');
        try {
          const buf = Buffer.alloc(2048);
          const { bytesRead } = await fh.read(buf, 0, 2048, 0);
          const fm = FRONTMATTER_RE.exec(buf.subarray(0, bytesRead).toString('utf8'))?.[1];
          const videoId = fm ? VIDEO_ID_LINE_RE.exec(fm)?.[1] : undefined;
          if (videoId) out.push({ videoId, fileName: name, modifiedAt: (await fh.stat()).mtime.toISOString() });
        } finally {
          await fh.close();
        }
      } catch {
        /* unreadable note: skip */
      }
    }
    return out;
  }

  /** Path of an existing note for this video (by frontmatter video_id), if any. */
  async findExisting(videoId: string): Promise<string | null> {
    const hit = (await this.listNotes()).find((n) => n.videoId === videoId);
    return hit ? path.join(this.dir, hit.fileName) : null;
  }

  private async freeFileName(base: string): Promise<string> {
    for (let i = 1; i < 100; i++) {
      const name = i === 1 ? `${base}.md` : `${base} (${i}).md`;
      if (!fs.existsSync(path.join(this.dir, name))) return name;
    }
    return `${base} ${Date.now()}.md`;
  }

  /** Write (or overwrite) the note. Throws on I/O failure so the caller can report it. */
  async export(rec: SummaryRecord): Promise<ExportResult> {
    const existing = await this.findExisting(rec.videoId);
    const wanted = noteBaseName(rec.title, rec.videoId);
    // A note that was created before the title was known carries the placeholder name;
    // move it to the real title now. User renames (anything else) are respected.
    const placeholder = existing !== null && path.basename(existing, '.md') === noteBaseName(undefined, rec.videoId) && wanted !== noteBaseName(undefined, rec.videoId);
    const target = existing && !placeholder ? existing : path.join(this.dir, await this.freeFileName(wanted));
    const tmp = path.join(this.dir, TMP_DIR, `${path.basename(target)}.${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.mkdir(path.dirname(tmp), { recursive: true });
    try {
      await fsp.writeFile(tmp, renderNote(rec, this.tags), { mode: 0o644 });
      await fsp.rename(tmp, target);
      if (placeholder && existing && existing !== target) await fsp.unlink(existing);
    } catch (err) {
      try {
        if (fs.existsSync(tmp)) await fsp.unlink(tmp);
      } catch {
        /* best effort */
      }
      throw err;
    }
    log('info', 'notes.exported', { videoId: rec.videoId, file: path.basename(target), overwritten: existing !== null, renamedFromPlaceholder: placeholder });
    return { path: target, fileName: path.basename(target), created: existing === null };
  }
}
