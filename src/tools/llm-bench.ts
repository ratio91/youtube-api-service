/**
 * Benchmark the configured LLM on cached transcripts with the exact prompts the
 * service uses. Run inside the container so LLM_BASE_URL and the cache dir apply:
 *
 *   docker compose exec youtube-api node dist/tools/llm-bench.js [videoId ...]
 *
 * Reads transcripts through the service's own cache (no YouTube traffic when they are
 * cached), prints one row per video and writes each summary as Markdown to
 * $BENCH_OUT_DIR (default /data/benchmarks) for side-by-side reading. Swap the model
 * in llama-server, restart it, rerun → compare.
 */
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { LlmClient } from '../llm/client';
import { Summarizer } from '../summaries/summarizer';
import { TranscriptCache } from '../transcripts/cache';
import { TranscriptService } from '../transcripts/service';
import { createYtDlpRunner } from '../transcripts/ytdlp';
import { primarySubtag } from '../transcripts/select';

const DEFAULT_VIDEOS = ['fW4SwcMQYdA', 'lXUZvyajciY'];

async function main() {
  const videoIds = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_VIDEOS;
  const outDir = process.env.BENCH_OUT_DIR ?? '/data/benchmarks';
  fs.mkdirSync(outDir, { recursive: true });

  const llm = new LlmClient({ baseUrl: config.LLM_BASE_URL, apiKey: config.LLM_API_KEY, model: config.LLM_MODEL, timeoutMs: config.LLM_TIMEOUT_MS });
  const probe = await llm.probe();
  if (!probe.ok) {
    console.error(`LLM not reachable at ${probe.baseUrl}: ${probe.error}`);
    process.exit(2);
  }
  const contextTokens = config.LLM_CONTEXT_TOKENS ?? probe.contextTokens ?? 32_768;
  const modelTag = (probe.model ?? 'unknown-model').replace(/[^A-Za-z0-9._-]+/g, '_');
  console.log(`model=${probe.model} build=${probe.build ?? '?'} context=${contextTokens} base=${probe.baseUrl}`);

  const cache = new TranscriptCache({ dir: config.TRANSCRIPT_CACHE_DIR, noCaptionsTtlMs: config.NO_CAPTIONS_TTL_DAYS * 86_400_000 });
  const transcripts = new TranscriptService({
    run: createYtDlpRunner({ binary: config.YTDLP_PATH, jsRuntime: config.YTDLP_JS_RUNTIME, timeoutMs: config.YTDLP_TIMEOUT_MS }),
    cache,
    config: { binary: config.YTDLP_PATH, batchDelayMs: config.TRANSCRIPT_BATCH_DELAY_MS, maxAttempts: config.TRANSCRIPT_MAX_ATTEMPTS, retryDelayMs: config.TRANSCRIPT_RETRY_DELAY_MS },
  });
  const summarizer = new Summarizer({ client: llm, contextTokens: () => contextTokens, maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS, charsPerToken: config.SUMMARY_CHARS_PER_TOKEN });

  const rows: string[] = ['video       | lang | chars   | strategy | chunks | calls | prompt tok | compl tok | wall s | truncated'];
  for (const videoId of videoIds) {
    const t = await transcripts.getEntries(videoId);
    const chars = t.entries.reduce((n, e) => n + e.text.length, 0);
    const summaryLang = primarySubtag(t.lang) || 'en';
    const started = Date.now();
    const out = await summarizer.summarize({ videoId, title: t.title, lang: t.lang, entries: t.entries, summaryLang });
    const wall = ((Date.now() - started) / 1000).toFixed(1);
    rows.push(`${videoId} | ${t.lang.padEnd(4)} | ${String(chars).padStart(7)} | ${out.strategy.padEnd(8)} | ${String(out.chunks).padStart(6)} | ${String(out.llmCalls).padStart(5)} | ${String(out.tokens.prompt).padStart(10)} | ${String(out.tokens.completion).padStart(9)} | ${wall.padStart(6)} | ${out.truncated}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(outDir, `${stamp}-${modelTag}-${videoId}.md`);
    const meta = [
      `<!-- model: ${out.model ?? probe.model} | context: ${contextTokens} | strategy: ${out.strategy} | chunks: ${out.chunks} | llmCalls: ${out.llmCalls} | tokens: ${out.tokens.prompt}+${out.tokens.completion} | wall: ${wall}s | truncated: ${out.truncated} | promptVersion: ${out.promptVersion} -->`,
      `# ${t.title ?? videoId}`,
      '',
      out.markdown,
      '',
    ].join('\n');
    fs.writeFileSync(file, meta);
    console.log(rows[rows.length - 1], `→ ${file}`);
  }
  console.log('\n' + rows.join('\n'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
