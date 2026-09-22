import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TranscriptService, CaptionFetcher } from '../src/transcripts/service';
import { YtDlpResult } from '../src/transcripts/ytdlp';
import { TranscriptError } from '../src/transcripts/errors';
import { TranscriptCache } from '../src/transcripts/cache';
import * as os from 'os';

const fx = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...p), 'utf8');
const INFO_EN = fx('info', 'lXUZvyajciY.json');
const INFO_DE = fx('info', 'fW4SwcMQYdA.json');
const INFO_NONE = fx('info', 'no-captions.json');
const JSON3_MANUAL_EN = fx('json3', 'manual-en.json');
const JSON3_AUTO_DE = fx('json3', 'auto-de.json');

const ok = (stdout: string, stderr = ''): YtDlpResult => ({ exitCode: 0, signal: null, stdout, stderr, timedOut: false, durationMs: 50 });
const fail = (stderr: string): YtDlpResult => ({ exitCode: 1, signal: null, stdout: '', stderr, timedOut: false, durationMs: 50 });
const timeout = (): YtDlpResult => ({ exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true, durationMs: 90000 });

function makeService(results: YtDlpResult[] | ((id: string, call: number) => YtDlpResult), fetchImpl?: CaptionFetcher, cfg: Partial<{ batchDelayMs: number; maxAttempts: number; retryDelayMs: number }> = {}, cache?: TranscriptCache) {
  let call = 0;
  const run = vi.fn(async (id: string) => {
    const r = typeof results === 'function' ? results(id, call) : results[Math.min(call, results.length - 1)];
    call++;
    return r;
  });
  const fetchCaptions = vi.fn<CaptionFetcher>(fetchImpl ?? (async (url) => ({ status: 200, body: url.includes('lang=de') ? JSON3_AUTO_DE : JSON3_MANUAL_EN })));
  const sleep = vi.fn(async (_ms: number) => {});
  let clock = 1_700_000_000_000;
  const service = new TranscriptService({ run, fetchCaptions, sleep, cache, backendVersion: () => '2026.08.19', now: () => (clock += 1000), config: { binary: 'yt-dlp', batchDelayMs: 3000, maxAttempts: 2, retryDelayMs: 5000, ...cfg } });
  return { service, run, fetchCaptions, sleep };
}

function tmpCache(ttlMs = 7 * 86_400_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytsvc-'));
  return { cache: new TranscriptCache({ dir, noCaptionsTtlMs: ttlMs }), dir };
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TranscriptError);
    expect((e as TranscriptError).code).toBe(code);
    return e as TranscriptError;
  }
  throw new Error(`expected ${code}`);
}

describe('TranscriptService.getTranscript', () => {
  it('runs yt-dlp once, fetches the selected json3 track with a browser UA, returns entries + track metadata', async () => {
    const { service, run, fetchCaptions } = makeService([ok(INFO_EN)]);
    const r = await service.getTranscript('lXUZvyajciY');
    expect(run).toHaveBeenCalledTimes(1);
    expect(fetchCaptions).toHaveBeenCalledTimes(1);
    const [url, headers] = fetchCaptions.mock.calls[0];
    expect(url).toContain('lang=en');
    expect(url).not.toContain('tlang=');
    expect(headers['User-Agent']).toMatch(/Chrome/);
    expect(r).toMatchObject({ videoId: 'lXUZvyajciY', lang: 'en', kind: 'manual' });
    expect(r.transcript![0]).toMatchObject({ offset: 48560, duration: 4400, lang: 'en' });
    expect(r.text).toBeUndefined();
  });

  it('format=text returns one flowing string', async () => {
    const { service } = makeService([ok(INFO_DE)]);
    const r = await service.getTranscript('fW4SwcMQYdA', { format: 'text' });
    expect(r).toMatchObject({ lang: 'de', kind: 'auto' });
    expect(r.text!.startsWith('einen wunderschönen guten Abend. Wir freuen uns sehr')).toBe(true);
    expect(r.transcript).toBeUndefined();
  });

  it('NO_CAPTIONS when both dicts are empty (exit 0, clean stderr)', async () => {
    const { service, fetchCaptions } = makeService([ok(INFO_NONE)]);
    const err = await expectCode(service.getTranscript('nocaps00000'), 'NO_CAPTIONS');
    expect(err.httpStatus).toBe(404);
    expect(fetchCaptions).not.toHaveBeenCalled();
  });

  it('empty dicts + PO-token discard warning → BLOCKED, not NO_CAPTIONS', async () => {
    const stderr = 'WARNING: [youtube] nocaps00000: Some web client subtitles require a PO Token which was not provided. They will be discarded since they are not downloadable as-is.';
    const { service } = makeService([ok(INFO_NONE, stderr)]);
    const err = await expectCode(service.getTranscript('nocaps00000'), 'BLOCKED');
    expect(err.httpStatus).toBe(503);
  });

  it('LANG_UNAVAILABLE for a language that only exists as auto-translation', async () => {
    const { service } = makeService([ok(INFO_EN)]);
    const err = await expectCode(service.getTranscript('lXUZvyajciY', { lang: 'de' }), 'LANG_UNAVAILABLE');
    expect(err.availableLanguages).toEqual({ manual: ['en', 'es'], auto: ['en'] });
  });

  it('bot check is NOT retried', async () => {
    const { service, run, sleep } = makeService([fail("ERROR: [youtube] x: Sign in to confirm you're not a bot. Use --cookies")]);
    await expectCode(service.getTranscript('lXUZvyajciY'), 'BLOCKED');
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('timeouts are retried once with the retry delay, then succeed', async () => {
    const { service, run, sleep } = makeService([timeout(), ok(INFO_EN)]);
    const r = await service.getTranscript('lXUZvyajciY');
    expect(r.kind).toBe('manual');
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('gives up after maxAttempts and surfaces TIMEOUT', async () => {
    const { service, run } = makeService([timeout(), timeout(), timeout()], undefined, { maxAttempts: 3 });
    await expectCode(service.getTranscript('lXUZvyajciY'), 'TIMEOUT');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('caption download 429 → RATE_LIMITED (retried), empty body → RATE_LIMITED, 403 → BLOCKED', async () => {
    const r429 = makeService([ok(INFO_EN)], async () => ({ status: 429, body: '' }));
    await expectCode(r429.service.getTranscript('lXUZvyajciY'), 'RATE_LIMITED');
    expect(r429.run).toHaveBeenCalledTimes(2); // retried once

    const empty = makeService([ok(INFO_EN)], async () => ({ status: 200, body: '   ' }), { maxAttempts: 1 });
    await expectCode(empty.service.getTranscript('lXUZvyajciY'), 'RATE_LIMITED');

    const r403 = makeService([ok(INFO_EN)], async () => ({ status: 403, body: 'nope' }));
    await expectCode(r403.service.getTranscript('lXUZvyajciY'), 'BLOCKED');
  });

  it('serialises concurrent calls so yt-dlp never runs in parallel', async () => {
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return ok(INFO_EN);
    });
    const service = new TranscriptService({ run, fetchCaptions: async () => ({ status: 200, body: JSON3_MANUAL_EN }), sleep: async () => {}, config: { binary: 'yt-dlp', batchDelayMs: 0, maxAttempts: 1, retryDelayMs: 0 } });
    await Promise.all([service.getTranscript('lXUZvyajciY'), service.getTranscript('lXUZvyajciY'), service.getTranscript('lXUZvyajciY')]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
  });
});

describe('TranscriptService.getBatch', () => {
  it('processes sequentially with the batch delay, keeps null for failures and fills the error map', async () => {
    const { service, sleep } = makeService((id) => (id === 'nocaps00000' ? ok(INFO_NONE) : ok(INFO_EN)));
    const r = await service.getBatch(['lXUZvyajciY', 'nocaps00000', 'Me-kZi4xkEs']);
    expect(Object.keys(r.transcripts)).toEqual(['lXUZvyajciY', 'nocaps00000', 'Me-kZi4xkEs']);
    expect(r.transcripts.nocaps00000).toBeNull();
    expect(r.errors.nocaps00000).toMatchObject({ code: 'NO_CAPTIONS', status: 404, available: false, retryable: false });
    expect(r.errors.lXUZvyajciY).toBeUndefined();
    expect(r.tracks.lXUZvyajciY).toEqual({ lang: 'en', kind: 'manual', cached: false });
    expect(sleep.mock.calls.filter(([ms]) => ms === 3000)).toHaveLength(2); // before video 2 and 3
  });

  it('aborts the remaining videos after a block and marks them SKIPPED (retryable)', async () => {
    const { service, run } = makeService((id) => (id === 'blockedvid1' ? fail("ERROR: [youtube] blockedvid1: Sign in to confirm you're not a bot.") : ok(INFO_EN)));
    const r = await service.getBatch(['lXUZvyajciY', 'blockedvid1', 'Me-kZi4xkEs', 'fW4SwcMQYdA']);
    expect(run).toHaveBeenCalledTimes(2);
    expect(r.transcripts.lXUZvyajciY).not.toBeNull();
    expect(r.transcripts.blockedvid1).toBeNull();
    expect(r.errors.blockedvid1).toMatchObject({ code: 'BLOCKED', retryable: true, status: 503 });
    expect(r.errors['Me-kZi4xkEs']).toMatchObject({ code: 'SKIPPED', retryable: true });
    expect(r.errors.fW4SwcMQYdA).toMatchObject({ code: 'SKIPPED', retryable: true });
  });

  it('format=text yields strings in the map', async () => {
    const { service } = makeService([ok(INFO_DE)]);
    const r = await service.getBatch(['fW4SwcMQYdA'], { format: 'text' });
    expect(typeof r.transcripts.fW4SwcMQYdA).toBe('string');
    expect((r.transcripts.fW4SwcMQYdA as string).startsWith('einen wunderschönen')).toBe(true);
  });
});

describe('TranscriptService with the persistent cache', () => {
  it('second call is served from cache with cached:true and no yt-dlp run; text is identical', async () => {
    const { cache, dir } = tmpCache();
    const { service, run } = makeService([ok(INFO_EN)], undefined, {}, cache);
    const first = await service.getTranscript('lXUZvyajciY');
    expect(first.cached).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['lXUZvyajciY.en.json']);

    const second = await service.getTranscript('lXUZvyajciY');
    expect(second.cached).toBe(true);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.transcript).toEqual(first.transcript); // per-entry lang restored on read
    expect(run).toHaveBeenCalledTimes(1);

    const liveText = (await makeService([ok(INFO_EN)]).service.getTranscript('lXUZvyajciY', { format: 'text' })).text;
    const cachedText = (await service.getTranscript('lXUZvyajciY', { format: 'text' })).text;
    expect(cachedText).toBe(liveText);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('?lang= uses the cache per track and a default fetch is flagged default', async () => {
    const { cache, dir } = tmpCache();
    const { service, run } = makeService([ok(INFO_EN)], undefined, {}, cache);
    await service.getTranscript('lXUZvyajciY');            // default → en (manual), default:true
    await service.getTranscript('lXUZvyajciY', { lang: 'es' }); // miss → fetch es
    expect(run).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(dir).sort()).toEqual(['lXUZvyajciY.en.json', 'lXUZvyajciY.es.json']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'lXUZvyajciY.en.json'), 'utf8')).default).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'lXUZvyajciY.es.json'), 'utf8')).default).toBeUndefined();
    const again = await service.getTranscript('lXUZvyajciY'); // still the default track
    expect(again).toMatchObject({ lang: 'en', cached: true });
    expect(run).toHaveBeenCalledTimes(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refresh:true bypasses the cache, refetches and updates fetchedAt', async () => {
    const { cache, dir } = tmpCache();
    const { service, run } = makeService([ok(INFO_EN)], undefined, {}, cache);
    const a = await service.getTranscript('lXUZvyajciY');
    const b = await service.getTranscript('lXUZvyajciY', { refresh: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(b.cached).toBe(false);
    expect(b.fetchedAt > a.fetchedAt).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'lXUZvyajciY.en.json'), 'utf8')).fetchedAt).toBe(b.fetchedAt);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('NO_CAPTIONS is cached with a TTL and served as a cached 404', async () => {
    const { cache, dir } = tmpCache();
    const { service, run } = makeService([ok(INFO_NONE)], undefined, {}, cache);
    await expectCode(service.getTranscript('nocaps00000'), 'NO_CAPTIONS');
    expect(fs.readdirSync(dir)).toEqual(['nocaps00000.none.json']);
    const err = await expectCode(service.getTranscript('nocaps00000'), 'NO_CAPTIONS');
    expect(err.cached).toBe(true);
    expect(err.toJSON()).toMatchObject({ available: false, cached: true, status: 404 });
    expect(run).toHaveBeenCalledTimes(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never caches retryable errors, unavailable videos or language misses', async () => {
    const { cache, dir } = tmpCache();
    const blocked = makeService([fail("ERROR: [youtube] x: Sign in to confirm you're not a bot.")], undefined, {}, cache);
    await expectCode(blocked.service.getTranscript('lXUZvyajciY'), 'BLOCKED');
    const unavailable = makeService([fail('ERROR: [youtube] aaaaaaaaaaa: This video is unavailable')], undefined, {}, cache);
    await expectCode(unavailable.service.getTranscript('aaaaaaaaaaa'), 'VIDEO_UNAVAILABLE');
    const langMiss = makeService([ok(INFO_EN)], undefined, {}, cache);
    await expectCode(langMiss.service.getTranscript('lXUZvyajciY', { lang: 'fr' }), 'LANG_UNAVAILABLE');
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('batch: cache hits skip the delay and are flagged; cached 404s land in errors', async () => {
    const { cache, dir } = tmpCache();
    const { service, run, sleep } = makeService((id) => (id === 'nocaps00000' ? ok(INFO_NONE) : ok(INFO_EN)), undefined, {}, cache);
    await service.getTranscript('lXUZvyajciY'); // warm one entry
    await expectCode(service.getTranscript('nocaps00000'), 'NO_CAPTIONS'); // warm a marker
    run.mockClear();
    sleep.mockClear();

    const r = await service.getBatch(['lXUZvyajciY', 'nocaps00000', 'Me-kZi4xkEs', 'fW4SwcMQYdA']);
    expect(run).toHaveBeenCalledTimes(2); // only the two uncached videos
    expect(sleep.mock.calls.filter(([ms]) => ms === 3000)).toHaveLength(1); // one pause, between the two fetches
    expect(r.tracks.lXUZvyajciY).toEqual({ lang: 'en', kind: 'manual', cached: true });
    expect(r.errors.nocaps00000).toMatchObject({ code: 'NO_CAPTIONS', cached: true });
    expect(r.tracks['Me-kZi4xkEs'].cached).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(['Me-kZi4xkEs.en.json', 'fW4SwcMQYdA.en.json', 'lXUZvyajciY.en.json', 'nocaps00000.none.json']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('listCached returns the cache listing and [] without a cache', async () => {
    const { cache, dir } = tmpCache();
    const { service } = makeService([ok(INFO_EN)], undefined, {}, cache);
    await service.getTranscript('lXUZvyajciY');
    expect(await service.listCached()).toMatchObject([{ videoId: 'lXUZvyajciY', lang: 'en', kind: 'manual' }]);
    expect(await makeService([ok(INFO_EN)]).service.listCached()).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
