import { describe, it, expect, vi } from 'vitest';
import { Summarizer, toLines, renderLines, chunkLines, formatTimestamp, formatDuration, estimateTokens } from '../src/summaries/summarizer';
import { PROMPT_VERSION, languageName } from '../src/summaries/prompts';
import { LlmClient, ChatMessage, ChatOptions } from '../src/llm/client';
import { LlmError } from '../src/llm/errors';
import type { TranscriptEntry } from '../src/transcripts/json3';

function entries(n: number, secondsEach = 5, words = 12): TranscriptEntry[] {
  return Array.from({ length: n }, (_, i) => ({ text: Array.from({ length: words }, (_, w) => `w${i}_${w}`).join(' '), offset: i * secondsEach * 1000, duration: secondsEach * 1000, lang: 'en' }));
}

/** Fake LLM: records calls, answers deterministically, optional overflow on the first call. */
function fakeLlm(opts: { overflowFirst?: boolean; cutFirst?: boolean } = {}) {
  const calls: { messages: ChatMessage[]; opts: ChatOptions }[] = [];
  let n = 0;
  const chat = vi.fn(async (messages: ChatMessage[], o: ChatOptions) => {
    calls.push({ messages, opts: o });
    n++;
    if (opts.overflowFirst && n === 1) throw new LlmError('LLM_CONTEXT_OVERFLOW', 'request (40000 tokens) exceeds the available context size (32768 tokens)', { detail: { promptTokens: 40000, contextTokens: 32768 } });
    const system = messages[0].content;
    const kind = system.startsWith('You take notes') ? 'notes' : system.includes('merge notes') ? 'merge' : 'final';
    const finish = opts.cutFirst && n === 1 ? 'length' : 'stop';
    return { content: `${kind}#${n}: ${messages[1].content.slice(0, 40)}`, finishReason: finish, model: 'fake-model', usage: { promptTokens: 100 * n, completionTokens: 10 }, timings: null, durationMs: 1 };
  });
  const client = { chat } as unknown as LlmClient;
  return { client, chat, calls };
}

describe('transcript rendering', () => {
  it('formats timestamps and durations', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(65_000)).toBe('1:05');
    expect(formatTimestamp(3_725_000)).toBe('1:02:05');
    expect(formatDuration(45 * 60_000)).toBe('45 minutes');
    expect(formatDuration(150 * 60_000)).toBe('2 h 30 min');
    expect(formatDuration(120 * 60_000)).toBe('2 h');
  });

  it('starts a new stamped line at most once per minute of video, keeping all text in order', () => {
    const e = entries(30, 5, 3); // 150 s of video → lines at 0:00, 1:00, 2:00
    const lines = toLines(e);
    expect(lines.map((l) => formatTimestamp(l.startMs))).toEqual(['0:00', '1:00', '2:00']);
    expect(lines.map((l) => l.text).join(' ')).toBe(e.map((x) => x.text).join(' '));
    expect(renderLines(lines).split('\n')[1].startsWith('[1:00] ')).toBe(true);
  });

  it('chunks lines contiguously without splitting a line, covering everything', () => {
    const lines = toLines(entries(120, 5, 12)); // 10 lines
    const chunks = chunkLines(lines, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(lines);
    // a chunk is either within the limit or a single line that is itself longer than the limit
    for (const c of chunks) expect(c.length === 1 || renderLines(c).length <= 500 + 100).toBe(true);
    const wide = chunkLines(lines, 100_000);
    expect(wide).toHaveLength(1);
  });

  it('estimateTokens and languageName', () => {
    expect(estimateTokens('a'.repeat(350), 3.5)).toBe(100);
    expect(languageName('de-DE')).toBe('German');
    expect(languageName('xx')).toContain('"xx"');
  });
});

describe('Summarizer', () => {
  const mk = (client: LlmClient, ctx = 32768) => new Summarizer({ client, contextTokens: () => ctx, maxOutputTokens: 1200, charsPerToken: 3.5 });

  it('single shot when the transcript fits: one call, final structure prompt in the target language', async () => {
    const { client, calls } = fakeLlm();
    const out = await mk(client).summarize({ videoId: 'lXUZvyajciY', title: 'A talk', lang: 'en', entries: entries(60), summaryLang: 'de' });
    expect(out).toMatchObject({ strategy: 'single', chunks: 1, llmCalls: 1, model: 'fake-model', promptVersion: PROMPT_VERSION, truncated: false, tokens: { prompt: 100, completion: 10 } });
    expect(calls[0].messages[0].content).toContain('Write everything in German');
    expect(calls[0].messages[0].content).toContain('## TL;DR');
    expect(calls[0].messages[1].content).toContain('Title: A talk');
    expect(calls[0].messages[1].content).toContain('Transcript language: English');
    expect(calls[0].messages[1].content).toMatch(/\[0:00\] w0_0/);
    expect(calls[0].opts.maxTokens).toBe(1200);
  });

  it('chunks a long transcript: notes per part in order, then one reduce call', async () => {
    const { client, calls } = fakeLlm();
    const many = entries(2400, 5, 12); // ~200 min, ~150k chars → does not fit 32k*3.5 chars
    const out = await mk(client).summarize({ videoId: 'lXUZvyajciY', lang: 'en', entries: many, summaryLang: 'en' });
    expect(out.strategy).toBe('chunked');
    expect(out.chunks).toBeGreaterThanOrEqual(2);
    expect(out.llmCalls).toBe(out.chunks + 1);
    const noteCalls = calls.slice(0, out.chunks);
    noteCalls.forEach((c, i) => {
      expect(c.messages[0].content.startsWith('You take notes')).toBe(true);
      expect(c.messages[1].content).toContain(`This is part ${i + 1} of ${out.chunks}.`);
      expect(c.opts.maxTokens).toBe(900);
    });
    const finalCall = calls[calls.length - 1];
    expect(finalCall.messages[0].content).toContain('final summary');
    for (let i = 1; i <= out.chunks; i++) expect(finalCall.messages[1].content).toContain(`### Notes for part ${i} of ${out.chunks}`);
    expect(out.tokens.prompt).toBe(calls.reduce((n, _c, i) => n + 100 * (i + 1), 0));
  });

  it('falls back to chunking when the server reports a context overflow despite the estimate', async () => {
    const { client, calls } = fakeLlm({ overflowFirst: true });
    // fits the estimate at 32k (≈ 60k chars) but the fake server says otherwise
    const out = await mk(client, 32768).summarize({ videoId: 'lXUZvyajciY', lang: 'en', entries: entries(700, 5, 12), summaryLang: 'en' });
    expect(out.strategy).toBe('chunked');
    expect(out.chunks).toBeGreaterThanOrEqual(2);
    expect(calls[0].messages[0].content).not.toContain('You take notes'); // the failed single shot
    expect(calls[1].messages[0].content).toContain('You take notes');
    expect(out.llmCalls).toBe(out.chunks + 2); // failed single shot + notes + final
  });

  it('retries once with a larger budget when the answer was cut off, and flags truncation only if it still is', async () => {
    const { client, calls } = fakeLlm({ cutFirst: true });
    const out = await mk(client).summarize({ videoId: 'lXUZvyajciY', lang: 'de', entries: entries(20), summaryLang: 'de' });
    expect(calls).toHaveLength(2);
    expect(calls[1].opts.maxTokens).toBe(1920);
    expect(out.truncated).toBe(false);
    expect(out.llmCalls).toBe(2);
  });

  it('propagates other LLM errors unchanged', async () => {
    const chat = vi.fn(async () => { throw new LlmError('LLM_UNAVAILABLE', 'down'); });
    await expect(mk({ chat } as unknown as LlmClient).summarize({ videoId: 'lXUZvyajciY', lang: 'en', entries: entries(5), summaryLang: 'en' })).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' });
  });
});
