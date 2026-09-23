import { z } from 'zod';
import { Agent, fetch as undiciFetch } from 'undici';
import { LlmError } from './errors';
import { log, errorMessage } from '../log';

/**
 * Minimal OpenAI-compatible chat client for llama.cpp's llama-server (also works
 * against other OpenAI-compatible servers; llama.cpp-specific fields are ignored
 * elsewhere). Field-verified 2026-09-22 against llama-server b9598:
 * - `chat_template_kwargs: { enable_thinking: false }` disables Qwen3.x thinking
 *   (no `reasoning_content`, no `<think>` in the answer)
 * - `top_k` is accepted; `timings` is returned with prompt/predicted tokens per second
 * - a prompt larger than the context answers HTTP 400 with
 *   `{"error":{"type":"exceed_context_size_error","message":"request (N tokens) exceeds the
 *   available context size (M tokens), try increasing it","n_prompt_tokens":N,"n_ctx":M}}`
 * - `/props` (llama-server only) exposes `default_generation_settings.n_ctx`.
 * - `jsonSchema` → `response_format.json_schema.schema`, a hard grammar constraint; the
 *   README's `{type, schema}` shape is silently ignored, and `maxLength` ≥ 2000 drops the
 *   whole grammar (docs/verified/2026-09-23-llama-server-json-schema.md).
 * - llama-server sends headers only when a non-streaming answer is complete. Node's
 *   built-in fetch (undici) gives up after 300 s without headers (`headersTimeout`,
 *   default 300e3, undici 7.29.1 lib/dispatcher/client.js L262), long before
 *   LLM_TIMEOUT_MS. The default fetch here therefore uses its own undici Agent with header
 *   and body timeouts disabled (`0`, client-h1.js L259); the AbortSignal is the only deadline
 *   (docs/decisions.md 2026-09-23 "5-minute fetch limit").
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  maxTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  /** default false: summaries do not need chain-of-thought */
  enableThinking?: boolean;
  timeoutMs?: number;
  /** constrain the answer to this JSON schema (llama-server grammar) */
  jsonSchema?: Record<string, unknown>;
}

export interface ChatResult {
  content: string;
  finishReason: string | null;
  model: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
  timings: { promptPerSecond: number | null; predictedPerSecond: number | null } | null;
  durationMs: number;
}

export interface LlmProbe {
  ok: boolean;
  baseUrl: string;
  model: string | null;
  /** server context window (llama-server /props), null if unknown */
  contextTokens: number | null;
  build: string | null;
  error?: string;
}

export interface LlmClientOptions {
  /** e.g. http://127.0.0.1:8000/v1 */
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

// Qwen3.x non-thinking defaults (Qwen model card "Best Practices", see docs/verified).
export const DEFAULT_SAMPLING = { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 } as const;

const chatResponseSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional() }).passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough()
      )
      .min(1),
    usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).passthrough().optional(),
    timings: z.object({ prompt_per_second: z.number().nullable().optional(), predicted_per_second: z.number().nullable().optional() }).passthrough().optional(),
  })
  .passthrough();

const errorBodySchema = z.object({ error: z.object({ message: z.string().optional(), type: z.string().optional(), n_prompt_tokens: z.number().optional(), n_ctx: z.number().optional() }).passthrough() }).passthrough();

/** fetch over a dedicated undici Agent; 0 = no header/body timeout (default for the LLM). */
export function createLlmFetch(timeouts: { headersTimeout: number; bodyTimeout: number } = { headersTimeout: 0, bodyTimeout: 0 }): typeof fetch {
  const agent = new Agent(timeouts);
  return ((url: string | URL, init?: RequestInit) => undiciFetch(url, { ...(init as object), dispatcher: agent })) as unknown as typeof fetch;
}
const llmFetch = createLlmFetch();

export class LlmClient {
  private readonly opts: LlmClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LlmClientOptions) {
    this.opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, '') };
    this.fetchImpl = opts.fetchImpl ?? llmFetch;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.apiKey) h.Authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async chat(messages: ChatMessage[], o: ChatOptions): Promise<ChatResult> {
    const body = {
      model: this.opts.model,
      messages,
      max_tokens: o.maxTokens,
      stream: false,
      temperature: o.temperature ?? DEFAULT_SAMPLING.temperature,
      top_p: o.topP ?? DEFAULT_SAMPLING.topP,
      top_k: o.topK ?? DEFAULT_SAMPLING.topK,
      presence_penalty: o.presencePenalty ?? DEFAULT_SAMPLING.presencePenalty,
      chat_template_kwargs: { enable_thinking: o.enableThinking ?? false },
      ...(o.jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: o.jsonSchema } } } : {}),
    };
    const timeoutMs = o.timeoutMs ?? this.opts.timeoutMs;
    const started = performance.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw classifyFetchError(err, timeoutMs);
    }
    const durationMs = Math.round(performance.now() - started);
    const text = await res.text();

    if (!res.ok) {
      const parsedErr = safeJson(text);
      const errBody = errorBodySchema.safeParse(parsedErr);
      const message = errBody.success ? errBody.data.error.message ?? text : text;
      const type = errBody.success ? errBody.data.error.type : undefined;
      if (type === 'exceed_context_size_error' || /exceeds the available context size/i.test(message)) {
        throw new LlmError('LLM_CONTEXT_OVERFLOW', message, {
          detail: errBody.success ? { promptTokens: errBody.data.error.n_prompt_tokens, contextTokens: errBody.data.error.n_ctx } : undefined,
        });
      }
      if (res.status === 429 || res.status === 503) {
        throw new LlmError('LLM_OVERLOADED', `LLM answered HTTP ${res.status}: ${truncate(message)}`);
      }
      throw new LlmError('LLM_REQUEST_FAILED', `LLM answered HTTP ${res.status}: ${truncate(message)}`);
    }

    const parsed = chatResponseSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      throw new LlmError('LLM_BAD_RESPONSE', `unexpected chat completion shape: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }
    const choice = parsed.data.choices[0];
    const content = choice.message.content ?? '';
    if (choice.message.reasoning_content) {
      log('warn', 'llm.reasoning_returned', { chars: choice.message.reasoning_content.length });
    }
    return {
      content,
      finishReason: choice.finish_reason ?? null,
      model: parsed.data.model ?? null,
      usage: parsed.data.usage ? { promptTokens: parsed.data.usage.prompt_tokens, completionTokens: parsed.data.usage.completion_tokens } : null,
      timings: parsed.data.timings
        ? { promptPerSecond: parsed.data.timings.prompt_per_second ?? null, predictedPerSecond: parsed.data.timings.predicted_per_second ?? null }
        : null,
      durationMs,
    };
  }

  /** Cheap liveness + capability probe: GET /v1/models, then (best effort) llama-server /props. */
  async probe(timeoutMs = 5_000): Promise<LlmProbe> {
    const base: LlmProbe = { ok: false, baseUrl: this.opts.baseUrl, model: null, contextTokens: null, build: null };
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { ...base, error: `GET /models answered HTTP ${res.status}` };
      const models = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough().safeParse(await res.json());
      if (!models.success) return { ...base, error: 'unexpected /models shape' };
      base.model = models.data.data[0]?.id ?? null;
      base.ok = true;
    } catch (err) {
      return { ...base, error: classifyFetchError(err, timeoutMs).reason };
    }
    // llama-server specific; other servers 404 here and we simply do not know the context.
    try {
      const root = this.opts.baseUrl.replace(/\/v1$/, '');
      const res = await this.fetchImpl(`${root}/props`, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const props = z
          .object({ default_generation_settings: z.object({ n_ctx: z.number().optional() }).passthrough().optional(), build_info: z.string().optional() })
          .passthrough()
          .safeParse(await res.json());
        if (props.success) {
          base.contextTokens = props.data.default_generation_settings?.n_ctx ?? null;
          base.build = props.data.build_info ?? null;
        }
      }
    } catch {
      /* optional */
    }
    return base;
  }
}

function classifyFetchError(err: unknown, timeoutMs: number): LlmError {
  const name = (err as { name?: string })?.name;
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return new LlmError('LLM_TIMEOUT', `LLM did not answer within ${timeoutMs} ms`, { cause: err });
  }
  return new LlmError('LLM_UNAVAILABLE', `cannot reach LLM: ${errorMessage((err as { cause?: unknown })?.cause ?? err)}`, { cause: err });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
