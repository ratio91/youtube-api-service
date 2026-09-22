import { describe, it, expect, vi } from 'vitest';
import { LlmClient, DEFAULT_SAMPLING } from '../src/llm/client';
import { LlmError } from '../src/llm/errors';

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response> | never) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as unknown as typeof fetch;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const client = (f: typeof fetch) => new LlmClient({ baseUrl: 'http://llm.test:8000/v1/', model: 'default', timeoutMs: 5000, fetchImpl: f });

// Shapes captured from llama-server b9598 on 2026-09-22.
const OK_BODY = {
  model: 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf',
  choices: [{ message: { role: 'assistant', content: '## TL;DR\nHallo.' }, finish_reason: 'stop', index: 0 }],
  usage: { prompt_tokens: 15056, completion_tokens: 600, total_tokens: 15656 },
  timings: { prompt_n: 15056, prompt_ms: 60400, prompt_per_second: 249.3, predicted_n: 600, predicted_ms: 29500, predicted_per_second: 20.3 },
};
const OVERFLOW_BODY = { error: { code: 400, message: 'request (90158 tokens) exceeds the available context size (65536 tokens), try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 90158, n_ctx: 65536 } };

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LlmError);
    expect((e as LlmError).code).toBe(code);
    return e as LlmError;
  }
  throw new Error(`expected ${code}`);
}

describe('LlmClient.chat', () => {
  it('posts an OpenAI-style body with Qwen non-thinking sampling and thinking disabled, parses the answer', async () => {
    const f = fakeFetch(() => json(OK_BODY));
    const r = await client(f).chat([{ role: 'user', content: 'hi' }], { maxTokens: 600 });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://llm.test:8000/v1/chat/completions'); // trailing slash normalised
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ model: 'default', stream: false, max_tokens: 600, ...{ temperature: DEFAULT_SAMPLING.temperature, top_p: DEFAULT_SAMPLING.topP, top_k: DEFAULT_SAMPLING.topK, presence_penalty: DEFAULT_SAMPLING.presencePenalty }, chat_template_kwargs: { enable_thinking: false } });
    expect(r).toMatchObject({ content: '## TL;DR\nHallo.', finishReason: 'stop', model: 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf', usage: { promptTokens: 15056, completionTokens: 600 }, timings: { promptPerSecond: 249.3, predictedPerSecond: 20.3 } });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sends a bearer token when an api key is configured', async () => {
    const f = fakeFetch(() => json(OK_BODY));
    await new LlmClient({ baseUrl: 'http://x/v1', model: 'm', timeoutMs: 1000, apiKey: 'secret', fetchImpl: f }).chat([{ role: 'user', content: 'x' }], { maxTokens: 10 });
    const init = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });

  it('maps the llama-server context overflow to LLM_CONTEXT_OVERFLOW with token detail', async () => {
    const err = await expectCode(client(fakeFetch(() => json(OVERFLOW_BODY, 400))).chat([{ role: 'user', content: 'x' }], { maxTokens: 10 }), 'LLM_CONTEXT_OVERFLOW');
    expect(err.detail).toEqual({ promptTokens: 90158, contextTokens: 65536 });
    expect(err.retryable).toBe(false);
  });

  it('maps 429/503 to LLM_OVERLOADED (retryable) and other errors to LLM_REQUEST_FAILED', async () => {
    const over = await expectCode(client(fakeFetch(() => new Response('busy', { status: 503 }))).chat([{ role: 'user', content: 'x' }], { maxTokens: 10 }), 'LLM_OVERLOADED');
    expect(over.retryable).toBe(true);
    const bad = await expectCode(client(fakeFetch(() => json({ error: { message: 'nope' } }, 400))).chat([{ role: 'user', content: 'x' }], { maxTokens: 10 }), 'LLM_REQUEST_FAILED');
    expect(bad.reason).toContain('nope');
  });

  it('connection failures → LLM_UNAVAILABLE, aborts → LLM_TIMEOUT (both 503, retryable)', async () => {
    const refused = fakeFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:8000') }); });
    const e1 = await expectCode(client(refused).chat([{ role: 'user', content: 'x' }], { maxTokens: 10 }), 'LLM_UNAVAILABLE');
    expect(e1.reason).toContain('ECONNREFUSED');
    expect(e1.httpStatus).toBe(503);
    const timeout = fakeFetch(() => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; });
    expect((await expectCode(client(timeout).chat([{ role: 'user', content: 'x' }], { maxTokens: 10 }), 'LLM_TIMEOUT')).retryable).toBe(true);
  });

  it('rejects an unparsable success body as LLM_BAD_RESPONSE', async () => {
    await expectCode(client(fakeFetch(() => json({ choices: [] }))).chat([{ role: 'user', content: 'x' }], { maxTokens: 10 }), 'LLM_BAD_RESPONSE');
  });
});

describe('LlmClient.probe', () => {
  it('reports model, context and build from /v1/models + /props', async () => {
    const f = fakeFetch((url) => url.endsWith('/v1/models') ? json({ data: [{ id: 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf' }] }) : json({ default_generation_settings: { n_ctx: 65536 }, build_info: 'b9598-fdc3db9b6', total_slots: 1 }));
    expect(await client(f).probe()).toEqual({ ok: true, baseUrl: 'http://llm.test:8000/v1', model: 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf', contextTokens: 65536, build: 'b9598-fdc3db9b6' });
  });

  it('works without /props (other OpenAI-compatible servers) and reports failures', async () => {
    const noProps = fakeFetch((url) => url.endsWith('/v1/models') ? json({ data: [{ id: 'm' }] }) : new Response('nf', { status: 404 }));
    expect(await client(noProps).probe()).toMatchObject({ ok: true, model: 'm', contextTokens: null, build: null });
    const down = fakeFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') }); });
    const p = await client(down).probe();
    expect(p.ok).toBe(false);
    expect(p.error).toContain('ECONNREFUSED');
  });
});
