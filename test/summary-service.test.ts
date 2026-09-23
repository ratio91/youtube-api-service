import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SummaryService, summaryErrorResponse } from '../src/summaries/service';
import { SummaryStore } from '../src/summaries/store';
import { Summarizer } from '../src/summaries/summarizer';
import type { TranscriptService } from '../src/transcripts/service';
import { TranscriptError } from '../src/transcripts/errors';
import { LlmError } from '../src/llm/errors';
import { ObsidianExporter } from '../src/notes/obsidian';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytsum-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ENTRIES = [{ text: 'hallo welt', offset: 0, duration: 1000, lang: 'de' }, { text: 'zweiter satz', offset: 1000, duration: 1000, lang: 'de' }];

function make(over: { transcripts?: Partial<TranscriptService>; summarize?: () => Promise<unknown>; exporter?: ObsidianExporter; summaryLanguages?: string[] } = {}) {
  const transcripts = {
    getEntries: vi.fn(async (videoId: string) => ({ videoId, title: 'Vortrag', channel: 'Uni', durationSec: 600, lang: 'de', kind: 'auto', entries: ENTRIES, cached: true, fetchedAt: 'f' })),
    ...over.transcripts,
  } as unknown as TranscriptService;
  const summarize = vi.fn(over.summarize ?? (async () => ({ markdown: '## TL;DR\nText.', strategy: 'single', chunks: 1, llmCalls: 1, model: 'fake', promptVersion: 1, tokens: { prompt: 10, completion: 5 }, durationMs: 42, truncated: false })));
  const summarizer = { summarize } as unknown as Summarizer;
  const store = new SummaryStore({ dir });
  let clock = 1_700_000_000_000;
  const service = new SummaryService({ transcripts, summarizer, store, exporter: over.exporter, summaryLanguages: over.summaryLanguages, now: () => (clock += 1000) });
  return { service, transcripts, summarize, store };
}

describe('SummaryService', () => {
  it('summarizes in the transcript language by default, stores <videoId>.<lang>.json, second call is cached', async () => {
    const { service, summarize, transcripts } = make();
    const a = await service.getSummary('fW4SwcMQYdA');
    expect(a).toMatchObject({ videoId: 'fW4SwcMQYdA', title: 'Vortrag', lang: 'de', kind: 'auto', summaryLang: 'de', model: 'fake', strategy: 'single', cached: false, markdown: '## TL;DR\nText.' });
    expect(summarize).toHaveBeenCalledWith({ videoId: 'fW4SwcMQYdA', title: 'Vortrag', lang: 'de', entries: ENTRIES, summaryLang: 'de' });
    expect(fs.readdirSync(dir)).toEqual(['fW4SwcMQYdA.de.json']);
    const b = await service.getSummary('fW4SwcMQYdA');
    expect(b.cached).toBe(true);
    expect(b.createdAt).toBe(a.createdAt);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(transcripts.getEntries).toHaveBeenCalledTimes(2); // transcript lookup is a cache hit each time
  });

  it('?summaryLang= produces a separate file; refresh regenerates', async () => {
    const { service, summarize } = make();
    await service.getSummary('fW4SwcMQYdA');
    const en = await service.getSummary('fW4SwcMQYdA', { summaryLang: 'en-US' });
    expect(en.summaryLang).toBe('en');
    expect(fs.readdirSync(dir).sort()).toEqual(['fW4SwcMQYdA.de.json', 'fW4SwcMQYdA.en.json']);
    const again = await service.getSummary('fW4SwcMQYdA', { refresh: true });
    expect(again.cached).toBe(false);
    expect(summarize).toHaveBeenCalledTimes(3);
  });

  it('SUMMARY_LANGUAGES: keeps an allowed transcript language, maps any other to the first entry', async () => {
    const withLang = (lang: string) => ({ getEntries: vi.fn(async (videoId: string) => ({ videoId, lang, kind: 'auto', entries: ENTRIES, cached: true, fetchedAt: 'f' })) });
    const de = make({ summaryLanguages: ['en', 'de'], transcripts: withLang('de-DE') });
    expect((await de.service.getSummary('fW4SwcMQYdA')).summaryLang).toBe('de');
    const fr = make({ summaryLanguages: ['en', 'de'], transcripts: withLang('fr') });
    const r = await fr.service.getSummary('xxxxxxxxxxx');
    expect(r).toMatchObject({ lang: 'fr', summaryLang: 'en' });
    expect(fr.summarize).toHaveBeenCalledWith(expect.objectContaining({ lang: 'fr', summaryLang: 'en' }));
    const explicit = make({ summaryLanguages: ['en', 'de'], transcripts: withLang('fr') });
    expect((await explicit.service.getSummary('yyyyyyyyyyy', { summaryLang: 'fr' })).summaryLang).toBe('fr');
  });

  it('passes ?lang= through to the transcript lookup', async () => {
    const { service, transcripts } = make();
    await service.getSummary('lXUZvyajciY', { lang: 'es' });
    expect(transcripts.getEntries).toHaveBeenCalledWith('lXUZvyajciY', { lang: 'es' });
  });

  it('transcript errors pass through with their status; LLM errors map to 503/500', async () => {
    const noCaps = make({ transcripts: { getEntries: vi.fn(async () => { throw new TranscriptError('NO_CAPTIONS', 'none'); }) } as unknown as Partial<TranscriptService> });
    await expect(noCaps.service.getSummary('ScMzIvxBSi4')).rejects.toMatchObject({ code: 'NO_CAPTIONS' });
    expect(summaryErrorResponse(new TranscriptError('NO_CAPTIONS', 'none'))).toMatchObject({ status: 404, body: { available: false } });
    expect(summaryErrorResponse(new LlmError('LLM_UNAVAILABLE', 'down'))).toMatchObject({ status: 503, body: { code: 'LLM_UNAVAILABLE', retryable: true } });
    expect(summaryErrorResponse(new LlmError('LLM_BAD_RESPONSE', 'weird'))).toMatchObject({ status: 500, body: { error: 'weird' } });
    expect(summaryErrorResponse(new Error('boom'))).toMatchObject({ status: 500, body: { code: 'SUMMARY_FAILED', error: 'boom' } });
    const down = make({ summarize: async () => { throw new LlmError('LLM_TIMEOUT', 'slow'); } });
    await expect(down.service.getSummary('fW4SwcMQYdA')).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
    expect(fs.readdirSync(dir)).toEqual([]); // nothing cached on failure
  });

  it('serialises concurrent summaries', async () => {
    let active = 0, max = 0;
    const { service } = make({ summarize: async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 5)); active--; return { markdown: 'x', strategy: 'single', chunks: 1, llmCalls: 1, model: 'f', promptVersion: 1, tokens: { prompt: 1, completion: 1 }, durationMs: 5, truncated: false }; } });
    await Promise.all([service.getSummary('lXUZvyajciY', { summaryLang: 'en' }), service.getSummary('fW4SwcMQYdA', { summaryLang: 'de' })]);
    expect(max).toBe(1);
  });

  it('lists summaries newest first', async () => {
    const { service } = make();
    await service.getSummary('fW4SwcMQYdA');
    await service.getSummary('lXUZvyajciY', { summaryLang: 'en' });
    const list = await service.listSummaries();
    expect(list.map((e) => e.videoId)).toEqual(['lXUZvyajciY', 'fW4SwcMQYdA']);
    expect(list[0]).toMatchObject({ summaryLang: 'en', model: 'fake', strategy: 'single', title: 'Vortrag' });
    expect(list[0]).not.toHaveProperty('exportedAt'); // no exporter → never exported
  });

  it('store: invalid file is a miss, stats count files', async () => {
    const store = new SummaryStore({ dir });
    await store.init();
    fs.writeFileSync(path.join(dir, 'fW4SwcMQYdA.de.json'), '{broken');
    expect(await store.get('fW4SwcMQYdA', 'de')).toBeNull();
    expect(await store.get('bad id', 'de')).toBeNull();
    expect(await store.stats()).toMatchObject({ dir, files: 1, writable: true });
  });
});

describe('SummaryService with the Obsidian exporter', () => {
  it('writes a note on generation, not on cache hits, and again on ?export=true', async () => {
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytnotes-'));
    const exporter = new ObsidianExporter({ dir: notesDir, tags: ['video'] });
    await exporter.init();
    const { service, store } = make({ exporter });
    const a = await service.getSummary('fW4SwcMQYdA');
    expect(a.note).toMatchObject({ exported: true, fileName: 'Vortrag.md' });
    expect(a).toMatchObject({ channel: 'Uni', durationSec: 600 });
    const noteText = fs.readFileSync(path.join(notesDir, 'Vortrag.md'), 'utf8');
    expect(noteText).toContain('channel: "Uni"');
    expect(noteText).toContain('duration: "10:00"');
    expect((await store.get('fW4SwcMQYdA', 'de'))?.exportPath).toBe(path.join(notesDir, 'Vortrag.md'));
    // the listing carries exportedAt, the basis of the "consumed" check (exported + not in /notes)
    expect((await service.listSummaries())[0].exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    fs.unlinkSync(path.join(notesDir, 'Vortrag.md')); // user "moved" the note out of the inbox
    const b = await service.getSummary('fW4SwcMQYdA');
    expect(b.cached).toBe(true);
    expect(b.note).toBeUndefined();
    expect(fs.existsSync(path.join(notesDir, 'Vortrag.md'))).toBe(false); // stays gone

    const c = await service.getSummary('fW4SwcMQYdA', { export: true });
    expect(c.cached).toBe(true);
    expect(c.note).toMatchObject({ exported: true, fileName: 'Vortrag.md' });
    fs.rmSync(notesDir, { recursive: true, force: true });
  });

  it('fills title/channel/duration into an old cached summary from the transcript and renames the note', async () => {
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytnotes-'));
    const exporter = new ObsidianExporter({ dir: notesDir, tags: ['video'] });
    await exporter.init();
    // transcript without metadata first (old cache), then with
    let meta: Record<string, unknown> = {};
    const transcripts = { getEntries: vi.fn(async (videoId: string) => ({ videoId, lang: 'de', kind: 'auto', entries: ENTRIES, cached: true, fetchedAt: 'f', ...meta })) } as unknown as TranscriptService;
    const { service, store } = make({ exporter, transcripts: transcripts as unknown as Partial<TranscriptService> });
    const a = await service.getSummary('fW4SwcMQYdA');
    expect(a.title).toBeUndefined();
    expect(a.note?.fileName).toBe('YouTube fW4SwcMQYdA.md');

    meta = { title: 'Vortrag', channel: 'Uni', durationSec: 600 }; // transcript refreshed with metadata
    const b = await service.getSummary('fW4SwcMQYdA', { export: true });
    expect(b).toMatchObject({ cached: true, title: 'Vortrag', channel: 'Uni', durationSec: 600 });
    expect(b.note?.fileName).toBe('Vortrag.md');
    expect(fs.readdirSync(notesDir).filter((n) => n.endsWith('.md'))).toEqual(['Vortrag.md']);
    expect((await store.get('fW4SwcMQYdA', 'de'))?.title).toBe('Vortrag');
    fs.rmSync(notesDir, { recursive: true, force: true });
  });

  it('an export failure is reported in the result but does not fail the summary', async () => {
    const file = path.join(dir, 'blocker');
    fs.writeFileSync(file, 'x');
    const exporter = new ObsidianExporter({ dir: file, tags: [] });
    await exporter.init();
    const { service } = make({ exporter });
    const r = await service.getSummary('fW4SwcMQYdA');
    expect(r.markdown).toContain('TL;DR');
    expect(r.note?.exported).toBe(false);
    expect(r.note?.error).toBeTruthy();
  });

  it('no exporter → no note field', async () => {
    const { service } = make();
    expect((await service.getSummary('fW4SwcMQYdA')).note).toBeUndefined();
  });
});
