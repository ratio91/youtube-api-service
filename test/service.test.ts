import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TranscriptService, CaptionFetcher } from '../src/transcripts/service';
import { YtDlpResult } from '../src/transcripts/ytdlp';
import { TranscriptError } from '../src/transcripts/errors';

const fx = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...p), 'utf8');
const INFO_EN = fx('info', 'lXUZvyajciY.json');
const INFO_DE = fx('info', 'fW4SwcMQYdA.json');
const INFO_NONE = fx('info', 'no-captions.json');
const JSON3_MANUAL_EN = fx('json3', 'manual-en.json');
const JSON3_AUTO_DE = fx('json3', 'auto-de.json');

const ok = (stdout: string, stderr = ''): YtDlpResult => ({ exitCode: 0, signal: null, stdout, stderr, timedOut: false, durationMs: 50 });
const fail = (stderr: string): YtDlpResult => ({ exitCode: 1, signal: null, stdout: '', stderr, timedOut: false, durationMs: 50 });
const timeout = (): YtDlpResult => ({ exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true, durationMs: 90000 });

function makeService(results: YtDlpResult[] | ((id: string, call: number) => YtDlpResult), fetchImpl?: CaptionFetcher, cfg: Partial<{ batchDelayMs: number; maxAttempts: number; retryDelayMs: number }> = {}) {
  let call = 0;
  const run = vi.fn(async (id: string) => {
    const r = typeof results === 'function' ? results(id, call) : results[Math.min(call, results.length - 1)];
    call++;
    return r;
  });
  const fetchCaptions = vi.fn<CaptionFetcher>(fetchImpl ?? (async (url) => ({ status: 200, body: url.includes('lang=de') ? JSON3_AUTO_DE : JSON3_MANUAL_EN })));
  const sleep = vi.fn(async (_ms: number) => {});
  const service = new TranscriptService({ run, fetchCaptions, sleep, config: { binary: 'yt-dlp', batchDelayMs: 3000, maxAttempts: 2, retryDelayMs: 5000, ...cfg } });
  return { service, run, fetchCaptions, sleep };
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
    expect(r.tracks.lXUZvyajciY).toEqual({ lang: 'en', kind: 'manual' });
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
