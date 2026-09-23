/**
 * Measure playlist classification against labelled videos with the exact logic of
 * POST /classify (same prompt, schema, cache). Run inside the container:
 *
 *   docker compose exec youtube-api node dist/tools/classify-eval.js \
 *     --playlists /data/eval/playlists.json --labels /data/eval/labels.json [--refresh] [--limit N]
 *
 * playlists.json: [{ playlistId, name, description }] (what n8n sends to /classify)
 * labels.json:    [{ videoId, expectedPlaylistId, title?, needsReview?, suggestedPlaylistId? }]
 * Rows with needsReview are classified but reported separately, never scored. Videos
 * without a cached summary are skipped (no YouTube or summary work happens here).
 * Writes all rows as CSV to $EVAL_OUT_DIR (default /data/eval).
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { config } from '../config';
import { LlmClient } from '../llm/client';
import { LlmQueue } from '../llm/queue';
import { SummaryStore } from '../summaries/store';
import { Classifier } from '../classify/classifier';
import { ClassificationStore } from '../classify/store';
import { ClassifyResult, ClassifyService, isNoSummaryError } from '../classify/service';
import { CLASSIFY_PROMPT_VERSION, NONE, taxonomyHash } from '../classify/prompts';

const playlistsSchema = z.array(z.object({ playlistId: z.string().min(1), name: z.string().min(1), description: z.string().optional().default('') })).min(1);
const labelsSchema = z.array(
  z
    .object({
      videoId: z.string(),
      expectedPlaylistId: z.string(),
      title: z.string().optional(),
      needsReview: z.boolean().optional(),
      suggestedPlaylistId: z.string().optional(),
    })
    .passthrough()
);

interface Row {
  videoId: string;
  title: string;
  expected: string;
  review: boolean;
  suggested?: string;
  r: ClassifyResult;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJson<S extends z.ZodTypeAny>(file: string, schema: S, what: string): z.infer<S> {
  const parsed = schema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    console.error(`${what} ${file} is invalid: ${i?.path.join('.')}: ${i?.message}`);
    process.exit(2);
  }
  return parsed.data;
}

const pct = (n: number, d: number) => (d === 0 ? '   –  ' : `${((100 * n) / d).toFixed(1).padStart(5)}%`);
const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const playlistsFile = arg('playlists');
  const labelsFile = arg('labels');
  if (!playlistsFile || !labelsFile) {
    console.error('usage: classify-eval --playlists <file> --labels <file> [--refresh] [--limit N]');
    process.exit(2);
  }
  const playlists = readJson(playlistsFile, playlistsSchema, 'playlists');
  const labels = readJson(labelsFile, labelsSchema, 'labels').slice(0, Number(arg('limit')) || undefined);
  const refresh = process.argv.includes('--refresh');
  const nameOf = new Map(playlists.map((p) => [p.playlistId, p.name]));
  const label = (id: string | null | undefined) => (!id || id === NONE ? NONE : nameOf.get(id) ?? `?${id}`);
  const unknown = [...new Set(labels.map((l) => l.expectedPlaylistId).filter((id) => !nameOf.has(id)))];
  if (unknown.length) console.warn(`warning: ${unknown.length} expectedPlaylistId(s) not in playlists: ${unknown.join(', ')}`);

  const llm = new LlmClient({ baseUrl: config.LLM_BASE_URL, apiKey: config.LLM_API_KEY, model: config.LLM_MODEL, timeoutMs: config.LLM_TIMEOUT_MS });
  const probe = await llm.probe();
  if (!probe.ok) {
    console.error(`LLM not reachable at ${probe.baseUrl}: ${probe.error}`);
    process.exit(2);
  }
  const store = new ClassificationStore({ dir: config.CLASSIFY_CACHE_DIR });
  await store.init();
  const service = new ClassifyService({
    summaries: new SummaryStore({ dir: config.SUMMARY_CACHE_DIR }),
    classifier: new Classifier({ client: llm }),
    store,
    queue: new LlmQueue(),
    preferredLangs: config.SUMMARY_LANGUAGES,
    currentModel: () => probe.model,
  });
  console.log(`model=${probe.model} promptVersion=${CLASSIFY_PROMPT_VERSION} taxonomy=${taxonomyHash(playlists)} playlists=${playlists.length} labels=${labels.length}${refresh ? ' refresh' : ''}`);

  const rows: Row[] = [];
  const noSummary: string[] = [];
  let invalid = 0;
  for (const [i, l] of labels.entries()) {
    try {
      const r = await service.classify(l.videoId, playlists, { refresh });
      if (r.reason === 'invalid model output') invalid++;
      rows.push({ videoId: l.videoId, title: l.title ?? r.title ?? '', expected: l.expectedPlaylistId, review: l.needsReview === true, suggested: l.suggestedPlaylistId, r });
      process.stdout.write(`\r${i + 1}/${labels.length}`);
    } catch (err) {
      if (isNoSummaryError(err)) noSummary.push(l.videoId);
      else throw err;
    }
  }
  process.stdout.write('\n');

  const scored = rows.filter((x) => !x.review);
  const correct = (x: Row) => x.r.playlistId === x.expected;
  const high = scored.filter((x) => x.r.confidence === 'high');
  console.log(`\nclassified ${rows.length} (${scored.length} scored, ${rows.length - scored.length} needsReview), skipped ${noSummary.length} without summary, invalid answers ${invalid}`);
  console.log(`accuracy            ${pct(scored.filter(correct).length, scored.length)}  (${scored.filter(correct).length}/${scored.length})`);
  console.log(`top-2 (incl. runner-up) ${pct(scored.filter((x) => correct(x) || x.r.runnerUp === x.expected).length, scored.length)}`);
  console.log(`confidence=high     ${pct(high.filter(correct).length, high.length)}  (${high.filter(correct).length}/${high.length}; high on ${pct(high.length, scored.length)} of videos)`);
  for (const c of ['medium', 'low'] as const) {
    const g = scored.filter((x) => x.r.confidence === c);
    console.log(`confidence=${c.padEnd(8)} ${pct(g.filter(correct).length, g.length)}  (${g.filter(correct).length}/${g.length})`);
  }
  console.log(`"none" rate         ${pct(scored.filter((x) => x.r.playlistId === null).length, scored.length)}`);

  console.log('\nper playlist                         precision  recall   (predicted / expected)');
  for (const p of playlists) {
    const predicted = scored.filter((x) => x.r.playlistId === p.playlistId);
    const expected = scored.filter((x) => x.expected === p.playlistId);
    if (!predicted.length && !expected.length) continue;
    const tp = predicted.filter(correct).length;
    console.log(`  ${p.name.slice(0, 34).padEnd(34)} ${pct(tp, predicted.length)}   ${pct(tp, expected.length)}   (${predicted.length} / ${expected.length})`);
  }

  const pairs = new Map<string, Row[]>();
  for (const x of scored.filter((y) => !correct(y))) {
    const k = `${label(x.expected)} → ${label(x.r.playlistId)}`;
    pairs.set(k, [...(pairs.get(k) ?? []), x]);
  }
  console.log('\ntop confusions (expected → predicted)');
  for (const [k, xs] of [...pairs].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
    console.log(`  ${String(xs.length).padStart(3)}  ${k}`);
    for (const x of xs.slice(0, 3)) console.log(`         ${x.videoId}  ${x.title.slice(0, 80)}  [${x.r.confidence}] ${x.r.reason.slice(0, 100)}`);
  }

  const review = rows.filter((x) => x.review);
  if (review.length) {
    console.log(`\nneedsReview (not scored): ${review.length}`);
    for (const x of review) {
      console.log(`  ${x.videoId}  ${x.title.slice(0, 60).padEnd(60)}  expected=${label(x.expected)}  suggested=${label(x.suggested)}  predicted=${label(x.r.playlistId)} [${x.r.confidence}]`);
    }
  }

  const outDir = process.env.EVAL_OUT_DIR ?? '/data/eval';
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `classify-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  const header = ['videoId', 'title', 'expected', 'predicted', 'confidence', 'runnerUp', 'correct', 'needsReview', 'suggested', 'reason', 'cached'];
  const lines = rows.map((x) =>
    [x.videoId, x.title, label(x.expected), label(x.r.playlistId), x.r.confidence, label(x.r.runnerUp), correct(x), x.review, x.suggested ? label(x.suggested) : '', x.r.reason, x.r.cached].map(csvCell).join(',')
  );
  fs.writeFileSync(file, [header.join(','), ...lines, ...noSummary.map((id) => `${id},,,,,,,,,no summary,`)].join('\n') + '\n');
  console.log(`\nCSV: ${file}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
