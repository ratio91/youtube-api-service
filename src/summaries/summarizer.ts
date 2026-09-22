import { ChatMessage, ChatResult, LlmClient } from '../llm/client';
import { LlmError, isLlmError } from '../llm/errors';
import { TranscriptEntry } from '../transcripts/json3';
import { log } from '../log';
import { PROMPT_VERSION, TranscriptContext, chunkNotesMessages, reduceMessages, singleShotMessages } from './prompts';

export interface SummarizeInput {
  videoId: string;
  title?: string;
  /** transcript track language */
  lang: string;
  entries: TranscriptEntry[];
  summaryLang: string;
}

export interface SummarizeOutput {
  markdown: string;
  strategy: 'single' | 'chunked';
  chunks: number;
  llmCalls: number;
  model: string | null;
  promptVersion: number;
  tokens: { prompt: number; completion: number };
  durationMs: number;
  /** the final answer hit max_tokens even after one retry */
  truncated: boolean;
}

export interface SummarizerOptions {
  client: LlmClient;
  /** live context window of the server (falls back to a default when unknown) */
  contextTokens: () => number;
  maxOutputTokens: number;
  /** conservative chars-per-token estimate; measured 4.3 for German ASR text */
  charsPerToken: number;
}

// Rough token cost of system prompt + framing + template tokens.
const PROMPT_OVERHEAD_TOKENS = 900;
// Notes per chunk are shorter than the final summary.
const CHUNK_NOTES_TOKENS = 900;
const STAMP_EVERY_MS = 60_000;

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} minutes`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export interface TranscriptLine {
  startMs: number;
  text: string;
}

/** One line per ~minute of video, each prefixed with a [h:mm:ss] stamp. */
export function toLines(entries: TranscriptEntry[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let current: TranscriptLine | null = null;
  let nextStamp = 0;
  for (const e of entries) {
    if (!current || e.offset >= nextStamp) {
      current = { startMs: e.offset, text: '' };
      lines.push(current);
      nextStamp = Math.floor(e.offset / STAMP_EVERY_MS) * STAMP_EVERY_MS + STAMP_EVERY_MS;
    }
    current.text += (current.text ? ' ' : '') + e.text;
  }
  return lines;
}

export function renderLines(lines: TranscriptLine[]): string {
  return lines.map((l) => `[${formatTimestamp(l.startMs)}] ${l.text}`).join('\n');
}

export function estimateTokens(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken);
}

/** Split lines into contiguous chunks whose rendered text stays under `maxChars`. */
export function chunkLines(lines: TranscriptLine[], maxChars: number): TranscriptLine[][] {
  const chunks: TranscriptLine[][] = [];
  let current: TranscriptLine[] = [];
  let size = 0;
  for (const l of lines) {
    const cost = l.text.length + 12;
    if (current.length > 0 && size + cost > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(l);
    size += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export class Summarizer {
  constructor(private readonly o: SummarizerOptions) {}

  async summarize(input: SummarizeInput): Promise<SummarizeOutput> {
    const started = performance.now();
    const ctxTokens = this.o.contextTokens();
    const lines = toLines(input.entries);
    const transcript = renderLines(lines);
    const durationMs = input.entries.length ? input.entries[input.entries.length - 1].offset + input.entries[input.entries.length - 1].duration : 0;
    const ctx: TranscriptContext = { title: input.title, transcriptLang: input.lang, durationText: formatDuration(durationMs) };

    const acc = { prompt: 0, completion: 0, calls: 0, model: null as string | null };
    const track = (r: ChatResult) => {
      acc.calls++;
      acc.model = acc.model ?? r.model;
      if (r.usage) {
        acc.prompt += r.usage.promptTokens;
        acc.completion += r.usage.completionTokens;
      }
    };

    const singleBudget = ctxTokens - this.o.maxOutputTokens - PROMPT_OVERHEAD_TOKENS;
    const estimated = estimateTokens(transcript, this.o.charsPerToken);
    let strategy: SummarizeOutput['strategy'] = estimated <= singleBudget ? 'single' : 'chunked';
    let chunks = 1;
    let result: { content: string; truncated: boolean } | null = null;
    // Actual prompt size as reported by the server after an overflow, if any.
    let measuredPromptTokens: number | null = null;

    if (strategy === 'single') {
      try {
        result = await this.completeWithRetry(singleShotMessages(ctx, transcript, input.summaryLang), this.o.maxOutputTokens, track);
      } catch (err) {
        // Estimate was too optimistic: the server knows better. Fall back to chunking.
        if (isLlmError(err) && err.code === 'LLM_CONTEXT_OVERFLOW') {
          log('warn', 'summary.overflow_fallback', { videoId: input.videoId, estimated, ctxTokens, detail: err.detail });
          acc.calls++; // the rejected request still counts
          strategy = 'chunked';
          const reported = err.detail?.promptTokens;
          measuredPromptTokens = typeof reported === 'number' && reported > 0 ? reported : Math.ceil(estimated * 1.5);
        } else {
          throw err;
        }
      }
    }

    if (strategy === 'chunked') {
      const chunkTokenBudget = ctxTokens - CHUNK_NOTES_TOKENS - PROMPT_OVERHEAD_TOKENS;
      let maxChars = Math.floor(chunkTokenBudget * this.o.charsPerToken * 0.9);
      if (measuredPromptTokens !== null) {
        // Re-derive chars/token from the server's count so the parts really fit, and
        // guarantee at least two parts (a single part just failed).
        const transcriptTokens = Math.max(1, measuredPromptTokens - PROMPT_OVERHEAD_TOKENS);
        const measuredCpt = transcript.length / transcriptTokens;
        const needed = Math.max(2, Math.ceil(transcriptTokens / chunkTokenBudget));
        maxChars = Math.min(Math.floor(chunkTokenBudget * measuredCpt * 0.9), Math.ceil(transcript.length / needed));
      }
      const parts = chunkLines(lines, maxChars);
      chunks = parts.length;
      if (chunks < 2) {
        throw new LlmError('LLM_CONTEXT_OVERFLOW', `transcript does not fit the ${ctxTokens}-token context even as a single chunk`);
      }
      log('info', 'summary.chunking', { videoId: input.videoId, estimated, ctxTokens, chunks });
      const notes: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const r = await this.completeWithRetry(chunkNotesMessages(ctx, i + 1, parts.length, renderLines(parts[i]), input.summaryLang), CHUNK_NOTES_TOKENS, track);
        notes.push(r.content);
      }
      result = await this.reduce(ctx, notes, input.summaryLang, ctxTokens, track);
    }

    if (!result) throw new LlmError('LLM_BAD_RESPONSE', 'summarizer produced no result');
    const out: SummarizeOutput = {
      markdown: result.content.trim(),
      strategy,
      chunks,
      llmCalls: acc.calls,
      model: acc.model,
      promptVersion: PROMPT_VERSION,
      tokens: { prompt: acc.prompt, completion: acc.completion },
      durationMs: Math.round(performance.now() - started),
      truncated: result.truncated,
    };
    log('info', 'summary.ok', { videoId: input.videoId, strategy, chunks, llmCalls: acc.calls, tokens: out.tokens, ms: out.durationMs, truncated: out.truncated, model: acc.model });
    return out;
  }

  /** Merge notes; recurse when the combined notes do not fit the context. */
  private async reduce(ctx: TranscriptContext, notes: string[], summaryLang: string, ctxTokens: number, track: (r: ChatResult) => void): Promise<{ content: string; truncated: boolean }> {
    const budget = ctxTokens - this.o.maxOutputTokens - PROMPT_OVERHEAD_TOKENS;
    const combined = notes.join('\n\n');
    if (estimateTokens(combined, this.o.charsPerToken) <= budget || notes.length <= 2) {
      return this.completeWithRetry(reduceMessages(ctx, notes, summaryLang, true), this.o.maxOutputTokens, track);
    }
    // Too many notes: merge pairs of neighbouring note sets first.
    const merged: string[] = [];
    for (let i = 0; i < notes.length; i += 2) {
      const pair = notes.slice(i, i + 2);
      const r = await this.completeWithRetry(reduceMessages(ctx, pair, summaryLang, false), CHUNK_NOTES_TOKENS * 2, track);
      merged.push(r.content);
    }
    return this.reduce(ctx, merged, summaryLang, ctxTokens, track);
  }

  /** One retry with a larger output budget when the answer was cut off. */
  private async completeWithRetry(messages: ChatMessage[], maxTokens: number, track: (r: ChatResult) => void): Promise<{ content: string; truncated: boolean }> {
    let r = await this.o.client.chat(messages, { maxTokens });
    track(r);
    if (r.finishReason === 'length') {
      log('info', 'summary.retry_longer', { maxTokens, next: Math.round(maxTokens * 1.6) });
      r = await this.o.client.chat(messages, { maxTokens: Math.round(maxTokens * 1.6) });
      track(r);
    }
    return { content: r.content, truncated: r.finishReason === 'length' };
  }
}
