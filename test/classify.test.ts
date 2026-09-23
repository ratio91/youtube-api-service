import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import type { LlmClient, ChatOptions, ChatResult } from '../src/llm/client';
import type { TranscriptService } from '../src/transcripts/service';
import type { HealthReport } from '../src/health';

// src/config.ts validates env at import time (see app.test.ts).
process.env.BASIC_AUTH_USER = 'testuser';
process.env.BASIC_AUTH_PASS = 'testpass';
delete process.env.YOUTUBE_CLIENT_ID;
delete process.env.YOUTUBE_CLIENT_SECRET;
delete process.env.OAUTH_REDIRECT_URI;

const { createApp } = await import('../src/app');
const { answerSchema, summaryExcerpt, taxonomyHash, classifyMessages } = await import('../src/classify/prompts');
const { Classifier } = await import('../src/classify/classifier');
const { ClassificationStore } = await import('../src/classify/store');
const { ClassifyService, NoSummaryError } = await import('../src/classify/service');
const { SummaryStore } = await import('../src/summaries/store');
const { LlmQueue } = await import('../src/llm/queue');
const { LlmError } = await import('../src/llm/errors');

const AUTH = 'Basic ' + Buffer.from('testuser:testpass').toString('base64');
const VID = 'fW4SwcMQYdA';
const PLAYLISTS = [
  { playlistId: 'PLfinance000000000000000000000001', name: 'Finance & Markets', description: 'Investing and markets. Not: crypto (-> Crypto).' },
  { playlistId: 'PLcrypto0000000000000000000000002', name: 'Crypto', description: 'Bitcoin and decentralization.' },
];
const MARKDOWN = '## TL;DR\nA talk about bond markets.\n\n## Key points\n- [0:07] Yields rise.\n- [1:02:30] Debt cycle.\n\n## Details worth keeping\n- Lyn Alden\n\n## Who should watch\nInvestors.';

function answer(o: Partial<{ reason: string; playlist: string; runnerUp: string; confidence: string }>) {
  return JSON.stringify({ reason: 'Main topic is bond markets.', playlist: 'Finance & Markets', runnerUp: 'Crypto', confidence: 'high', ...o });
}

function fakeClient(contents: Array<string | { content: string; finishReason: string }>) {
  const chat = vi.fn(async (_m: unknown, _o: ChatOptions): Promise<ChatResult> => {
    const next = contents.shift() ?? '';
    const c = typeof next === 'string' ? { content: next, finishReason: 'stop' } : next;
    return { ...c, model: 'fake-model', usage: null, timings: null, durationMs: 5 };
  });
  return { client: { chat } as unknown as LlmClient, chat };
}

describe('classification prompt', () => {
  it('builds the answer enum from the given playlists plus "none"', () => {
    const s = answerSchema(PLAYLISTS) as { properties: Record<string, { enum?: string[]; maxLength?: number }>; required: string[] };
    expect(s.properties.playlist.enum).toEqual(['Finance & Markets', 'Crypto', 'none']);
    expect(s.properties.runnerUp.enum).toEqual(['Finance & Markets', 'Crypto', 'none']);
    expect(s.properties.confidence.enum).toEqual(['high', 'medium', 'low']);
    expect(s.properties.reason.maxLength).toBe(200);
    expect(s.required).toEqual(['reason', 'playlist', 'runnerUp', 'confidence']);
  });

  it('hashes the taxonomy independent of order, sensitive to any description change', () => {
    const h = taxonomyHash(PLAYLISTS);
    expect(taxonomyHash([...PLAYLISTS].reverse())).toBe(h);
    expect(taxonomyHash([{ ...PLAYLISTS[0], description: 'changed' }, PLAYLISTS[1]])).not.toBe(h);
  });

  it('feeds only TL;DR + key points, without timestamps; never the transcript', () => {
    const ex = summaryExcerpt(MARKDOWN);
    expect(ex).toContain('bond markets');
    expect(ex).toContain('Debt cycle');
    expect(ex).not.toContain('Lyn Alden');
    expect(ex).not.toMatch(/\[\d/);
    const user = classifyMessages(PLAYLISTS, { title: 'T', channel: 'C', summaryMarkdown: MARKDOWN })[1].content;
    expect(user).toContain('- Crypto: Bitcoin and decentralization.');
    expect(user).toContain('Title: T');
  });
});

describe('Classifier', () => {
  it('maps the chosen name to its playlistId and sends the schema', async () => {
    const { client, chat } = fakeClient([answer({})]);
    const c = await new Classifier({ client }).classify(PLAYLISTS, { summaryMarkdown: MARKDOWN });
    expect(c).toMatchObject({ playlistId: PLAYLISTS[0].playlistId, name: 'Finance & Markets', runnerUp: PLAYLISTS[1].playlistId, confidence: 'high', valid: true, llmCalls: 1 });
    expect(chat.mock.calls[0][1].jsonSchema).toEqual(answerSchema(PLAYLISTS));
    expect(chat.mock.calls[0][1].temperature).toBe(0.2);
  });

  it('accepts the answer inside a ```json fence (the grammar allows it)', async () => {
    const c = await new Classifier({ client: fakeClient(['```json\n' + answer({}) + '\n```']).client }).classify(PLAYLISTS, { summaryMarkdown: MARKDOWN });
    expect(c).toMatchObject({ playlistId: PLAYLISTS[0].playlistId, valid: true, llmCalls: 1 });
  });

  it('retries once on an unknown playlist, then accepts a valid answer', async () => {
    const { client, chat } = fakeClient([answer({ playlist: 'Gardening' }), answer({ playlist: 'Crypto', runnerUp: 'none' })]);
    const c = await new Classifier({ client }).classify(PLAYLISTS, { summaryMarkdown: MARKDOWN });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(c).toMatchObject({ playlistId: PLAYLISTS[1].playlistId, runnerUp: 'none', valid: true, llmCalls: 2 });
  });

  it('falls back to "none" after two invalid answers (bad JSON, cut off)', async () => {
    const { client } = fakeClient(['not json', { content: '{"reason":"cut', finishReason: 'length' }]);
    const c = await new Classifier({ client }).classify(PLAYLISTS, { summaryMarkdown: MARKDOWN });
    expect(c).toMatchObject({ playlistId: null, name: null, confidence: 'low', runnerUp: 'none', reason: 'invalid model output', valid: false });
  });

  it('"none" gives a null playlistId; a runner-up equal to the pick becomes "none"', async () => {
    const none = await new Classifier({ client: fakeClient([answer({ playlist: 'none', runnerUp: 'Crypto', confidence: 'low' })]).client }).classify(PLAYLISTS, { summaryMarkdown: MARKDOWN });
    expect(none).toMatchObject({ playlistId: null, name: null, runnerUp: PLAYLISTS[1].playlistId });
    const same = await new Classifier({ client: fakeClient([answer({ runnerUp: 'Finance & Markets' })]).client }).classify(PLAYLISTS, { summaryMarkdown: MARKDOWN });
    expect(same.runnerUp).toBe('none');
  });

  it('lets LLM transport errors through (503 for the caller)', async () => {
    const chat = vi.fn(async () => {
      throw new LlmError('LLM_UNAVAILABLE', 'refused');
    });
    await expect(new Classifier({ client: { chat } as unknown as LlmClient }).classify(PLAYLISTS, { summaryMarkdown: MARKDOWN })).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
  });
});

describe('ClassifyService', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function setup(contents: string[], opts: { summary?: boolean; model?: () => string | null } = {}) {
    const summaries = new SummaryStore({ dir: path.join(dir, 's') });
    await summaries.init();
    if (opts.summary !== false) {
      await summaries.put({
        version: 1, videoId: VID, title: 'Bonds', channel: 'Chan', lang: 'en', kind: 'auto', summaryLang: 'en', model: 'm', promptVersion: 1,
        strategy: 'single', chunks: 1, llmCalls: 1, createdAt: '2026-09-23T08:00:00.000Z', durationMs: 1, tokens: { prompt: 1, completion: 1 }, truncated: false, markdown: MARKDOWN,
      });
    }
    const store = new ClassificationStore({ dir: path.join(dir, 'c') });
    await store.init();
    const { client, chat } = fakeClient(contents);
    const service = new ClassifyService({ summaries, classifier: new Classifier({ client }), store, queue: new LlmQueue(), currentModel: opts.model });
    return { service, chat, store };
  }

  it('409 NO_SUMMARY without a cached summary, before any LLM call', async () => {
    const { service, chat } = await setup([], { summary: false });
    const err = await service.classify(VID, PLAYLISTS).catch((e) => e);
    expect(err).toBeInstanceOf(NoSummaryError);
    expect(err.httpStatus).toBe(409);
    expect(err.toJSON()).toMatchObject({ code: 'NO_SUMMARY', retryable: false });
    expect(chat).not.toHaveBeenCalled();
  });

  it('caches per taxonomy: same list → hit, changed description → new run, refresh → new run', async () => {
    const { service, chat } = await setup([answer({}), answer({ playlist: 'Crypto' }), answer({})]);
    const a = await service.classify(VID, PLAYLISTS);
    expect(a).toMatchObject({ cached: false, playlistId: PLAYLISTS[0].playlistId, title: 'Bonds', taxonomyHash: taxonomyHash(PLAYLISTS) });
    expect((await service.classify(VID, [...PLAYLISTS].reverse())).cached).toBe(true);
    const changed = [{ ...PLAYLISTS[0], description: 'Only stocks.' }, PLAYLISTS[1]];
    const b = await service.classify(VID, changed);
    expect(b).toMatchObject({ cached: false, playlistId: PLAYLISTS[1].playlistId });
    expect((await service.classify(VID, changed, { refresh: true })).cached).toBe(false);
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it('a model change invalidates the cache', async () => {
    let model = 'fake-model';
    const { service, chat } = await setup([answer({}), answer({})], { model: () => model });
    await service.classify(VID, PLAYLISTS);
    expect((await service.classify(VID, PLAYLISTS)).cached).toBe(true);
    model = 'other-model';
    expect((await service.classify(VID, PLAYLISTS)).cached).toBe(false);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('never caches an invalid answer', async () => {
    const { service, store } = await setup(['x', 'y', answer({})]);
    expect(await service.classify(VID, PLAYLISTS)).toMatchObject({ playlistId: null, reason: 'invalid model output', cached: false });
    expect(await store.get(VID)).toBeNull();
    expect(await service.classify(VID, PLAYLISTS)).toMatchObject({ playlistId: PLAYLISTS[0].playlistId, cached: false });
  });
});

describe('LlmQueue', () => {
  it('runs tasks one at a time, also after a failure', async () => {
    const q = new LlmQueue();
    const order: string[] = [];
    const task = (name: string, ms: number, fail = false) => () =>
      new Promise<string>((resolve, reject) => {
        order.push(`start ${name}`);
        setTimeout(() => {
          order.push(`end ${name}`);
          fail ? reject(new Error(name)) : resolve(name);
        }, ms);
      });
    const results = await Promise.allSettled([q.run(task('a', 20, true)), q.run(task('b', 1))]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
  });
});

describe('POST /classify/:videoId', () => {
  const health = async () => ({}) as HealthReport;
  const transcripts = {} as TranscriptService;
  function app(classify: unknown) {
    return createApp({ youtube: null, transcripts, summaries: null, classify: classify as never, health });
  }
  const ok = { videoId: VID, playlistId: PLAYLISTS[0].playlistId, name: 'Finance & Markets', confidence: 'high', runnerUp: 'none', reason: 'r', model: 'm', promptVersion: 1, taxonomyHash: 'h', cached: false, durationMs: 1 };

  it('requires auth, validates id and body, passes playlists + refresh through', async () => {
    const classify = vi.fn(async () => ok);
    const a = app({ classify });
    expect((await request(a).post(`/classify/${VID}`).send({ playlists: PLAYLISTS })).status).toBe(401);
    expect((await request(a).post('/classify/bad').set('Authorization', AUTH).send({ playlists: PLAYLISTS })).status).toBe(400);
    const res = await request(a).post(`/classify/${VID}`).set('Authorization', AUTH).send({ playlists: PLAYLISTS, refresh: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(ok);
    expect(classify).toHaveBeenCalledWith(VID, PLAYLISTS, { refresh: true });
  });

  it('rejects empty, duplicate or reserved playlist entries with 400', async () => {
    const a = app({ classify: vi.fn() });
    const post = (body: unknown) => request(a).post(`/classify/${VID}`).set('Authorization', AUTH).send(body as object);
    expect((await post({ playlists: [] })).status).toBe(400);
    expect((await post({ playlists: [PLAYLISTS[0], { ...PLAYLISTS[1], name: PLAYLISTS[0].name }] })).body.error).toContain('duplicate name');
    expect((await post({ playlists: [PLAYLISTS[0], PLAYLISTS[0]] })).body.error).toContain('duplicate playlistId');
    expect((await post({ playlists: [{ ...PLAYLISTS[0], name: 'None' }] })).body.error).toContain('reserved');
  });

  it('maps NO_SUMMARY to 409, LLM outages to 503, disabled to 503', async () => {
    const noSummary = app({ classify: vi.fn(async () => { throw new NoSummaryError(VID); }) });
    const r1 = await request(noSummary).post(`/classify/${VID}`).set('Authorization', AUTH).send({ playlists: PLAYLISTS });
    expect(r1.status).toBe(409);
    expect(r1.body).toMatchObject({ videoId: VID, code: 'NO_SUMMARY', retryable: false });
    const down = app({ classify: vi.fn(async () => { throw new LlmError('LLM_TIMEOUT', 'slow'); }) });
    const r2 = await request(down).post(`/classify/${VID}`).set('Authorization', AUTH).send({ playlists: PLAYLISTS });
    expect(r2.status).toBe(503);
    expect(r2.body).toMatchObject({ code: 'LLM_TIMEOUT', retryable: true });
    expect((await request(app(null)).post(`/classify/${VID}`).set('Authorization', AUTH).send({ playlists: PLAYLISTS })).status).toBe(503);
  });
});
