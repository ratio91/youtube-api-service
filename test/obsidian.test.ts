import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ObsidianExporter, noteBaseName, renderNote } from '../src/notes/obsidian';
import type { SummaryRecord } from '../src/summaries/store';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytnotes-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const rec = (over: Partial<SummaryRecord> = {}): SummaryRecord => ({
  version: 1,
  videoId: 'fW4SwcMQYdA',
  title: 'Nobelpreis-Vortrag: Eine Reise durch die Welt der Quanten',
  channel: 'Universität Wien',
  durationSec: 4704,
  lang: 'de',
  kind: 'auto',
  summaryLang: 'de',
  model: 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
  promptVersion: 1,
  strategy: 'single',
  chunks: 1,
  llmCalls: 1,
  createdAt: '2026-09-22T21:04:39.991Z',
  durationMs: 50000,
  tokens: { prompt: 15938, completion: 1036 },
  truncated: false,
  markdown: '## TL;DR\nText.\n\n## Key points\n- [0:07] Punkt',
  ...over,
});

describe('noteBaseName', () => {
  it('strips characters Obsidian rejects, collapses whitespace, keeps umlauts', () => {
    expect(noteBaseName('Nobelpreis-Vortrag: Eine Reise / durch [die] Welt | #Quanten?', 'x')).toBe('Nobelpreis-Vortrag Eine Reise durch die Welt Quanten');
    expect(noteBaseName('  Ärger   mit  Ö ', 'x')).toBe('Ärger mit Ö');
    expect(noteBaseName('...leading dots and trailing...', 'x')).toBe('leading dots and trailing');
  });

  it('falls back to the video id and truncates long titles at a word boundary', () => {
    expect(noteBaseName(undefined, 'fW4SwcMQYdA')).toBe('YouTube fW4SwcMQYdA');
    expect(noteBaseName('###', 'fW4SwcMQYdA')).toBe('YouTube fW4SwcMQYdA');
    const long = noteBaseName(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '), 'x');
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('word')).toBe(false);
  });
});

describe('renderNote', () => {
  it('writes the agreed frontmatter (no transcript kind, video id only as property) and a source link', () => {
    const note = renderNote(rec(), ['video', 'youtube']);
    const fm = note.split('---')[1];
    expect(fm).toContain('title: "Nobelpreis-Vortrag: Eine Reise durch die Welt der Quanten"');
    expect(fm).toContain('source: https://www.youtube.com/watch?v=fW4SwcMQYdA');
    expect(fm).toContain('channel: "Universität Wien"');
    expect(fm).toContain('duration: "1:18:24"');
    expect(fm).toContain('created: 2026-09-22T21:04:39.991Z');
    expect(fm).toContain('language: de');
    expect(fm).toContain('model: "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf"');
    expect(fm).toContain('tags: ["video", "youtube"]');
    expect(fm).toContain('video_id: fW4SwcMQYdA');
    expect(fm).not.toMatch(/kind|transcript:/);
    expect(note).toContain('## TL;DR\nText.');
    expect(note.trim().endsWith('[▶ YouTube](https://www.youtube.com/watch?v=fW4SwcMQYdA)')).toBe(true);
  });

  it('omits unknown channel/duration/model and escapes quotes in titles', () => {
    const note = renderNote(rec({ channel: undefined, durationSec: undefined, model: null, title: 'He said "hi"' }), ['video']);
    expect(note).not.toMatch(/^channel:|^duration:|^model:/m);
    expect(note).toContain('title: "He said \\"hi\\""');
  });
});

describe('ObsidianExporter', () => {
  it('init creates the dir, a .tmp subdir and an .stignore ignoring it', async () => {
    const ex = new ObsidianExporter({ dir: path.join(dir, 'video-inbox'), tags: ['video'] });
    await ex.init();
    expect(ex.isWritable()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'video-inbox', '.tmp'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'video-inbox', '.stignore'), 'utf8')).toContain('/.tmp');
  });

  it('writes <title>.md, leaves no temp file, and overwrites the same note on re-export even after a rename', async () => {
    const ex = new ObsidianExporter({ dir, tags: ['video'] });
    await ex.init();
    const first = await ex.export(rec());
    expect(first).toMatchObject({ fileName: 'Nobelpreis-Vortrag Eine Reise durch die Welt der Quanten.md', created: true });
    expect(fs.readdirSync(path.join(dir, '.tmp'))).toEqual([]);
    // user renames the note in Obsidian
    fs.renameSync(first.path, path.join(dir, 'Zeilinger.md'));
    const second = await ex.export(rec({ markdown: '## TL;DR\nNeu.' }));
    expect(second).toMatchObject({ fileName: 'Zeilinger.md', created: false });
    expect(fs.readFileSync(path.join(dir, 'Zeilinger.md'), 'utf8')).toContain('Neu.');
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.md'))).toEqual(['Zeilinger.md']);
  });

  it('moves a placeholder-named note to the real title once known, but respects user renames', async () => {
    const ex = new ObsidianExporter({ dir, tags: [] });
    await ex.init();
    const first = await ex.export(rec({ title: undefined }));
    expect(first.fileName).toBe('YouTube fW4SwcMQYdA.md');
    const second = await ex.export(rec({ title: 'Echter Titel' }));
    expect(second.fileName).toBe('Echter Titel.md');
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.md'))).toEqual(['Echter Titel.md']);
    // a later title change does NOT rename a real-titled note
    const third = await ex.export(rec({ title: 'Anderer Titel' }));
    expect(third.fileName).toBe('Echter Titel.md');
  });

  it('listNotes reports every note by its frontmatter video_id; a note moved out disappears', async () => {
    const ex = new ObsidianExporter({ dir, tags: ['video'] });
    await ex.init();
    await ex.export(rec());
    await ex.export(rec({ videoId: 'lXUZvyajciY', title: 'Other talk' }));
    fs.writeFileSync(path.join(dir, 'My own note.md'), '# no frontmatter\n');
    fs.writeFileSync(path.join(dir, 'Bad id.md'), '---\nvideo_id: tooShort\n---\n');
    const list = await ex.listNotes();
    expect(list.map((n) => n.videoId).sort()).toEqual(['fW4SwcMQYdA', 'lXUZvyajciY']);
    const other = list.find((n) => n.videoId === 'lXUZvyajciY')!;
    expect(other.fileName).toBe('Other talk.md');
    expect(Number.isNaN(Date.parse(other.modifiedAt))).toBe(false);
    fs.renameSync(path.join(dir, other.fileName), path.join(os.tmpdir(), `moved-${Date.now()}.md`)); // consumed
    expect((await ex.listNotes()).map((n) => n.videoId)).toEqual(['fW4SwcMQYdA']);
    expect(await ex.findExisting('lXUZvyajciY')).toBeNull();
    expect(await new ObsidianExporter({ dir: path.join(dir, 'missing'), tags: [] }).listNotes()).toEqual([]);
  });

  it('two different videos with the same title get distinct files', async () => {
    const ex = new ObsidianExporter({ dir, tags: [] });
    await ex.init();
    const a = await ex.export(rec({ videoId: 'lXUZvyajciY', title: 'Same title' }));
    const b = await ex.export(rec({ videoId: 'fW4SwcMQYdA', title: 'Same title' }));
    expect(a.fileName).toBe('Same title.md');
    expect(b.fileName).toBe('Same title (2).md');
    expect(await ex.findExisting('fW4SwcMQYdA')).toBe(b.path);
    expect(await ex.findExisting('ScMzIvxBSi4')).toBeNull();
  });

  it('stats count notes; unwritable dir is reported and export throws', async () => {
    const ex = new ObsidianExporter({ dir, tags: [] });
    await ex.init();
    await ex.export(rec());
    expect(await ex.stats()).toMatchObject({ dir, files: 1, writable: true });
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const bad = new ObsidianExporter({ dir: file, tags: [] });
    await bad.init();
    expect(bad.isWritable()).toBe(false);
    await expect(bad.export(rec())).rejects.toBeTruthy();
  });
});
