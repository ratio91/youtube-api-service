import { z } from 'zod';
import { LlmClient } from '../llm/client';
import { log } from '../log';
import { answerSchema, classifyMessages, NONE, Playlist, REASON_MAX, VideoContext } from './prompts';

export type Confidence = 'high' | 'medium' | 'low';

export interface Classification {
  /** null = no playlist fits */
  playlistId: string | null;
  name: string | null;
  confidence: Confidence;
  /** playlistId of the second-best playlist, or "none" */
  runnerUp: string;
  reason: string;
  model: string | null;
  llmCalls: number;
  durationMs: number;
  /** false = the model's answer stayed invalid after one retry (never cached) */
  valid: boolean;
}

// Deterministic enough for repeatable evaluations; no presence penalty, which would
// push the model away from names it has already written in the prompt.
const SAMPLING = { temperature: 0.2, topP: 0.8, topK: 20, presencePenalty: 0 } as const;
const MAX_TOKENS = 300;

export class Classifier {
  constructor(private readonly o: { client: LlmClient }) {}

  async classify(playlists: Playlist[], video: VideoContext): Promise<Classification> {
    const schema = answerSchema(playlists);
    const names: [string, ...string[]] = [NONE, ...playlists.map((p) => p.name)];
    const answer = z.object({
      reason: z.string(),
      playlist: z.enum(names),
      runnerUp: z.enum(names),
      confidence: z.enum(['high', 'medium', 'low']),
    });
    const byName = new Map(playlists.map((p) => [p.name, p]));
    const messages = classifyMessages(playlists, video);
    const started = performance.now();
    let model: string | null = null;

    for (let call = 1; call <= 2; call++) {
      // LLM transport errors (unavailable, timeout, overloaded) propagate to the caller.
      const r = await this.o.client.chat(messages, { maxTokens: MAX_TOKENS, ...SAMPLING, jsonSchema: schema });
      model = r.model ?? model;
      const parsed = r.finishReason === 'length' ? null : answer.safeParse(safeJson(r.content));
      if (parsed?.success) {
        const hit = parsed.data.playlist === NONE ? undefined : byName.get(parsed.data.playlist);
        const runner = parsed.data.runnerUp === NONE || parsed.data.runnerUp === parsed.data.playlist ? undefined : byName.get(parsed.data.runnerUp);
        return {
          playlistId: hit?.playlistId ?? null,
          name: hit?.name ?? null,
          confidence: parsed.data.confidence,
          runnerUp: runner?.playlistId ?? NONE,
          reason: parsed.data.reason.trim().slice(0, REASON_MAX),
          model,
          llmCalls: call,
          durationMs: Math.round(performance.now() - started),
          valid: true,
        };
      }
      log('warn', 'classify.invalid_answer', {
        call,
        finishReason: r.finishReason,
        error: parsed ? parsed.error.issues[0]?.message : 'answer cut off (finish_reason length)',
        content: r.content.slice(0, 300),
      });
    }
    return {
      playlistId: null,
      name: null,
      confidence: 'low',
      runnerUp: NONE,
      reason: 'invalid model output',
      model,
      llmCalls: 2,
      durationMs: Math.round(performance.now() - started),
      valid: false,
    };
  }
}

/** The grammar also admits the JSON inside a ```json fence (docs/verified/2026-09-23-llama-server-json-schema.md). */
function safeJson(text: string): unknown {
  const unfenced = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  try {
    return JSON.parse(unfenced);
  } catch {
    return undefined;
  }
}
