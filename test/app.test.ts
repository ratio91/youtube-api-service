import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { YouTubeService } from '../src/youtube';
import type { TranscriptService } from '../src/transcripts/service';
import type { SummaryService } from '../src/summaries/service';
import type { HealthReport } from '../src/health';

// src/config.ts parses process.env at import time and calls process.exit(1)
// on failure, so the env MUST be populated before src/app (which imports
// src/config transitively) is loaded. That is why createApp is pulled in via
// a dynamic import below, after these assignments.
process.env.BASIC_AUTH_USER = 'testuser';
process.env.BASIC_AUTH_PASS = 'testpass';
delete process.env.YOUTUBE_CLIENT_ID;
delete process.env.YOUTUBE_CLIENT_SECRET;
delete process.env.OAUTH_REDIRECT_URI;
// /videos tests below rely on no default playlist being configured.
delete process.env.DEFAULT_PLAYLIST_ID;

const { createApp } = await import('../src/app');
const { TranscriptError } = await import('../src/transcripts/errors');
const { LlmError } = await import('../src/llm/errors');

const GOOD_AUTH = 'Basic ' + Buffer.from('testuser:testpass').toString('base64');
const BAD_AUTH = 'Basic ' + Buffer.from('testuser:wrong-password').toString('base64');

type YtOverrides = Partial<Record<keyof YouTubeService, unknown>>;
type TxOverrides = Partial<Record<keyof TranscriptService, unknown>>;

function makeFakeYouTube(overrides: YtOverrides = {}): YouTubeService {
  const fake = {
    isAuthorized: vi.fn(() => true),
    getAuthUrl: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?fake=1'),
    authorize: vi.fn(async (_code: string) => {}),
    listMyPlaylists: vi.fn(async () => [
      {
        id: 'PL123',
        snippet: { title: 'My Playlist', description: 'A playlist', publishedAt: '2026-01-01T00:00:00Z' },
        contentDetails: { itemCount: 2 },
      },
    ]),
    fetchPlaylistVideos: vi.fn(async (_playlistId: string) => [
      {
        videoId: 'vid1',
        title: 'Video One',
        channel: 'Chan',
        channelId: 'ch1',
        description: '',
        duration: 'PT1M',
        publishedAt: '2026-01-01T00:00:00Z',
        thumbnails: { default: '', medium: '', high: '' },
      },
    ]),
    ...overrides,
  };
  return fake as unknown as YouTubeService;
}

const SAMPLE_ENTRIES = [{ text: 'hello world', duration: 1000, offset: 0, lang: 'en' }];

function makeFakeTranscripts(overrides: TxOverrides = {}): TranscriptService {
  const fake = {
    getTranscript: vi.fn(async (videoId: string, opts: { format?: string } = {}) =>
      opts.format === 'text'
        ? { videoId, lang: 'en', kind: 'manual', cached: false, fetchedAt: 'f', text: 'hello world' }
        : { videoId, lang: 'en', kind: 'manual', cached: false, fetchedAt: 'f', transcript: SAMPLE_ENTRIES }
    ),
    listCached: vi.fn(async () => [{ videoId: 'lXUZvyajciY', lang: 'en', kind: 'manual', fetchedAt: '2026-09-22T00:00:00.000Z' }]),
    getBatch: vi.fn(async (videoIds: string[]) => ({
      transcripts: Object.fromEntries(videoIds.map((id) => [id, SAMPLE_ENTRIES])),
      errors: {},
      tracks: Object.fromEntries(videoIds.map((id) => [id, { lang: 'en', kind: 'manual', cached: false }])),
    })),
    ...overrides,
  };
  return fake as unknown as TranscriptService;
}

const HEALTH_OK: HealthReport = {
  status: 'ok',
  mode: 'full',
  oauth: 'ok',
  transcripts: { backend: 'yt-dlp', version: '2026.08.19', ok: true, jsRuntime: { requested: 'node', detected: 'node-24.21.0', present: true }, ejs: '0.8.0' },
  cache: { dir: '/data/transcripts', files: 3, sizeBytes: 12345, writable: true },
  llm: { ok: true, baseUrl: 'http://host.docker.internal:8000/v1', model: 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf', contextTokens: 65536, build: 'b9598' },
  summaryCache: { dir: '/data/summaries', files: 1, sizeBytes: 2048, writable: true },
  authorized: true,
  timestamp: '2026-09-22T00:00:00.000Z',
};

const SUMMARY = { videoId: 'fW4SwcMQYdA', title: 'Vortrag', lang: 'de', kind: 'auto', summaryLang: 'de', model: 'fake', promptVersion: 1, strategy: 'single', chunks: 1, cached: false, createdAt: 'c', durationMs: 90000, truncated: false, markdown: '## TL;DR\nText.' };
type SumOverrides = Partial<Record<keyof SummaryService, unknown>>;
function makeFakeSummaries(overrides: SumOverrides = {}): SummaryService {
  return {
    getSummary: vi.fn(async (videoId: string) => ({ ...SUMMARY, videoId })),
    listSummaries: vi.fn(async () => [{ videoId: 'fW4SwcMQYdA', title: 'Vortrag', lang: 'de', kind: 'auto', summaryLang: 'de', model: 'fake', strategy: 'single', createdAt: 'c' }]),
    ...overrides,
  } as unknown as SummaryService;
}

function makeApp(opts: { youtube?: YtOverrides | null; transcripts?: TxOverrides; summaries?: SumOverrides | null; health?: HealthReport; batchMax?: number } = {}) {
  const youtube = opts.youtube === null ? null : makeFakeYouTube(opts.youtube);
  const transcripts = makeFakeTranscripts(opts.transcripts);
  const summaries = opts.summaries === null ? null : makeFakeSummaries(opts.summaries);
  const health = vi.fn(async () => opts.health ?? HEALTH_OK);
  return { app: createApp({ youtube, transcripts, summaries, health, batchMax: opts.batchMax }), youtube, transcripts, summaries, health };
}

const VID = 'lXUZvyajciY';

describe('GET /health', () => {
  it('returns 200 with the health report (no auth required)', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.oauth).toBe('ok');
    expect(res.body.authorized).toBe(true);
    expect(res.body.transcripts.backend).toBe('yt-dlp');
  });

  it('still answers 200 when degraded, so the container healthcheck does not flap', async () => {
    const degraded: HealthReport = { ...HEALTH_OK, status: 'degraded', mode: 'transcript-only', oauth: 'disabled', authorized: false };
    const { app } = makeApp({ health: degraded });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.oauth).toBe('disabled');
    expect(res.body.authorized).toBe(false);
  });
});

describe('basic auth middleware (via /playlists)', () => {
  it('rejects requests without an Authorization header with 401 and WWW-Authenticate', async () => {
    const { app, youtube } = makeApp();
    const res = await request(app).get('/playlists');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Basic /);
    expect(res.body.error).toBe('Authentication required');
    expect(youtube!.listMyPlaylists).not.toHaveBeenCalled();
  });

  it('rejects wrong credentials with 401', async () => {
    const { app, youtube } = makeApp();
    const res = await request(app).get('/playlists').set('Authorization', BAD_AUTH);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
    expect(youtube!.listMyPlaylists).not.toHaveBeenCalled();
  });

  it('passes through with correct credentials', async () => {
    const { app, youtube } = makeApp();
    const res = await request(app).get('/playlists').set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(200);
    expect(youtube!.listMyPlaylists).toHaveBeenCalledOnce();
    expect(res.body.playlists[0]).toMatchObject({ id: 'PL123', title: 'My Playlist', itemCount: 2 });
  });
});

describe('transcript-only mode (no OAuth configured)', () => {
  it.each(['/auth/url', '/oauth/callback?code=x'])('%s answers 503 oauth disabled', async (path) => {
    const { app } = makeApp({ youtube: null });
    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'oauth disabled' });
  });

  it('POST /auth/callback answers 503', async () => {
    const { app } = makeApp({ youtube: null });
    const res = await request(app).post('/auth/callback').send({ code: 'x' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'oauth disabled' });
  });

  it.each(['/playlists', '/playlist/PL1', '/videos?playlistId=PL1'])('%s answers 503 after basic auth', async (path) => {
    const { app } = makeApp({ youtube: null });
    expect((await request(app).get(path)).status).toBe(401);
    const res = await request(app).get(path).set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'oauth disabled' });
  });

  it('transcripts keep working', async () => {
    const { app } = makeApp({ youtube: null });
    const res = await request(app).get(`/transcript/${VID}`).set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(200);
    expect(res.body.transcript).toEqual(SAMPLE_ENTRIES);
  });
});

describe('GET /oauth/callback', () => {
  it('returns 400 when code is missing', async () => {
    const { app, youtube } = makeApp();
    const res = await request(app).get('/oauth/callback');
    expect(res.status).toBe(400);
    expect(res.text).toContain('Missing authorization code');
    expect(youtube!.authorize).not.toHaveBeenCalled();
  });

  it('authorizes with the code and returns HTML success', async () => {
    const { app, youtube } = makeApp();
    const res = await request(app).get('/oauth/callback').query({ code: 'the-code' });
    expect(res.status).toBe(200);
    expect(youtube!.authorize).toHaveBeenCalledWith('the-code');
    expect(res.text).toContain('Authorization successful');
  });

  it('returns 500 when authorize throws', async () => {
    const { app } = makeApp({ youtube: { authorize: vi.fn(async () => { throw new Error('token exchange failed'); }) } });
    const res = await request(app).get('/oauth/callback').query({ code: 'bad-code' });
    expect(res.status).toBe(500);
    expect(res.text).toContain('token exchange failed');
  });
});

describe('POST /auth/callback', () => {
  it('returns 400 when code is missing', async () => {
    const { app, youtube } = makeApp();
    const res = await request(app).post('/auth/callback').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Authorization code required');
    expect(youtube!.authorize).not.toHaveBeenCalled();
  });
});

describe('GET /videos', () => {
  it('returns 400 with a helpful error when no playlistId and no DEFAULT_PLAYLIST_ID', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/videos').set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('playlistId');
    expect(res.body.error).toContain('DEFAULT_PLAYLIST_ID');
  });

  it('returns 200 via the stub when ?playlistId= is given', async () => {
    const { app, youtube } = makeApp();
    const res = await request(app).get('/videos').query({ playlistId: 'PLxyz' }).set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(200);
    expect(youtube!.fetchPlaylistVideos).toHaveBeenCalledWith('PLxyz');
    expect(res.body.videos[0].videoId).toBe('vid1');
  });
});

describe('GET /transcript/:videoId', () => {
  it('returns 200 with transcript, lang and kind', async () => {
    const { app, transcripts } = makeApp();
    const res = await request(app).get(`/transcript/${VID}`).set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(200);
    expect(transcripts.getTranscript).toHaveBeenCalledWith(VID, { lang: undefined, format: 'json', refresh: false });
    expect(res.body.cached).toBe(false);
    expect(res.body).toMatchObject({ videoId: VID, lang: 'en', kind: 'manual', transcript: SAMPLE_ENTRIES });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('passes ?lang= and ?format=text through and returns text', async () => {
    const { app, transcripts } = makeApp();
    const res = await request(app).get(`/transcript/${VID}`).query({ lang: 'de', format: 'text' }).set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(200);
    expect(transcripts.getTranscript).toHaveBeenCalledWith(VID, { lang: 'de', format: 'text', refresh: false });
    expect(res.body.text).toBe('hello world');
    expect(res.body.transcript).toBeUndefined();
  });

  it('passes ?refresh=true and rejects other values', async () => {
    const { app, transcripts } = makeApp();
    await request(app).get(`/transcript/${VID}`).query({ refresh: 'true' }).set('Authorization', GOOD_AUTH);
    expect(transcripts.getTranscript).toHaveBeenLastCalledWith(VID, { lang: undefined, format: 'json', refresh: true });
    await request(app).get(`/transcript/${VID}`).query({ refresh: '1' }).set('Authorization', GOOD_AUTH);
    expect(transcripts.getTranscript).toHaveBeenLastCalledWith(VID, expect.objectContaining({ refresh: true }));
    expect((await request(app).get(`/transcript/${VID}`).query({ refresh: 'yes' }).set('Authorization', GOOD_AUTH)).status).toBe(400);
  });

  it('a cached 404 carries cached:true', async () => {
    const { app } = makeApp({ transcripts: { getTranscript: vi.fn(async () => { throw new TranscriptError('NO_CAPTIONS', 'no tracks', { cached: true }); }) } });
    const res = await request(app).get(`/transcript/${VID}`).set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ available: false, cached: true });
  });

  it('rejects an invalid video id with 400 before calling the backend', async () => {
    const { app, transcripts } = makeApp();
    const res = await request(app).get('/transcript/not-a-valid-id!').set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(400);
    expect(transcripts.getTranscript).not.toHaveBeenCalled();
  });

  it('rejects bad ?lang= and ?format= with 400', async () => {
    const { app } = makeApp();
    expect((await request(app).get(`/transcript/${VID}`).query({ lang: 'en gb' }).set('Authorization', GOOD_AUTH)).status).toBe(400);
    expect((await request(app).get(`/transcript/${VID}`).query({ format: 'xml' }).set('Authorization', GOOD_AUTH)).status).toBe(400);
  });

  it('maps NO_CAPTIONS to 404 { available: false }', async () => {
    const { app } = makeApp({ transcripts: { getTranscript: vi.fn(async () => { throw new TranscriptError('NO_CAPTIONS', 'no tracks'); }) } });
    const res = await request(app).get(`/transcript/${VID}`).set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ videoId: VID, available: false, code: 'NO_CAPTIONS', reason: 'no tracks', retryable: false });
  });

  it('maps LANG_UNAVAILABLE to 404 with the available languages', async () => {
    const err = new TranscriptError('LANG_UNAVAILABLE', 'no fr', { availableLanguages: { manual: ['en'], auto: ['en'] } });
    const { app } = makeApp({ transcripts: { getTranscript: vi.fn(async () => { throw err; }) } });
    const res = await request(app).get(`/transcript/${VID}`).query({ lang: 'fr' }).set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(404);
    expect(res.body.available).toBe(false);
    expect(res.body.availableLanguages).toEqual({ manual: ['en'], auto: ['en'] });
  });

  it('maps BLOCKED to 503 { retryable: true }', async () => {
    const { app } = makeApp({ transcripts: { getTranscript: vi.fn(async () => { throw new TranscriptError('BLOCKED', 'not a bot'); }) } });
    const res = await request(app).get(`/transcript/${VID}`).set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ retryable: true, code: 'BLOCKED', reason: 'not a bot' });
  });

  it('maps unknown errors to 500 with error and reason', async () => {
    const { app } = makeApp({ transcripts: { getTranscript: vi.fn(async () => { throw new Error('boom'); }) } });
    const res = await request(app).get(`/transcript/${VID}`).set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'boom', reason: 'boom', code: 'BACKEND_FAILURE', retryable: false });
  });
});

describe('POST /batch-transcripts', () => {
  it('returns 400 when videoIds is not an array', async () => {
    const { app, transcripts } = makeApp();
    const res = await request(app).post('/batch-transcripts').set('Authorization', GOOD_AUTH).send({ videoIds: 'vid1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('videoIds must be an array');
    expect(transcripts.getBatch).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid id inside the array', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/batch-transcripts').set('Authorization', GOOD_AUTH).send({ videoIds: [VID, 'bad id'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('videoIds.1');
  });

  it('caps the batch size', async () => {
    const { app, transcripts } = makeApp({ batchMax: 2 });
    const res = await request(app).post('/batch-transcripts').set('Authorization', GOOD_AUTH).send({ videoIds: [VID, VID, VID] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('TRANSCRIPT_BATCH_MAX');
    expect(transcripts.getBatch).not.toHaveBeenCalled();
  });

  it('returns transcripts, errors and tracks and forwards lang/format', async () => {
    const { app, transcripts } = makeApp();
    const res = await request(app).post('/batch-transcripts').set('Authorization', GOOD_AUTH).send({ videoIds: [VID], lang: 'en', format: 'text' });
    expect(res.status).toBe(200);
    expect(transcripts.getBatch).toHaveBeenCalledWith([VID], { lang: 'en', format: 'text', refresh: false });
    expect(res.body.transcripts[VID]).toEqual(SAMPLE_ENTRIES);
    expect(res.body.errors).toEqual({});
    expect(res.body.tracks[VID]).toEqual({ lang: 'en', kind: 'manual', cached: false });
  });

  it('forwards refresh:true from the body', async () => {
    const { app, transcripts } = makeApp();
    await request(app).post('/batch-transcripts').set('Authorization', GOOD_AUTH).send({ videoIds: [VID], refresh: true });
    expect(transcripts.getBatch).toHaveBeenCalledWith([VID], { lang: undefined, format: 'json', refresh: true });
  });
});

describe('GET /transcripts (cache listing)', () => {
  it('requires basic auth and returns the cached entries with a count', async () => {
    const { app, transcripts } = makeApp();
    expect((await request(app).get('/transcripts')).status).toBe(401);
    const res = await request(app).get('/transcripts').set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(200);
    expect(transcripts.listCached).toHaveBeenCalledOnce();
    expect(res.body.count).toBe(1);
    expect(res.body.transcripts[0]).toMatchObject({ videoId: 'lXUZvyajciY', lang: 'en', kind: 'manual' });
  });
});

describe('GET /summary/:videoId', () => {
  it('returns the summary and forwards lang/summaryLang/refresh', async () => {
    const { app, summaries } = makeApp();
    const res = await request(app).get('/summary/fW4SwcMQYdA').query({ lang: 'de', summaryLang: 'en', refresh: 'true' }).set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(200);
    expect(summaries!.getSummary).toHaveBeenCalledWith('fW4SwcMQYdA', { lang: 'de', summaryLang: 'en', refresh: true });
    expect(res.body).toMatchObject({ videoId: 'fW4SwcMQYdA', summaryLang: 'de', markdown: '## TL;DR\nText.', cached: false });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('requires auth and validates the id and language params', async () => {
    const { app, summaries } = makeApp();
    expect((await request(app).get('/summary/fW4SwcMQYdA')).status).toBe(401);
    expect((await request(app).get('/summary/bad').set('Authorization', GOOD_AUTH)).status).toBe(400);
    expect((await request(app).get('/summary/fW4SwcMQYdA').query({ summaryLang: 'not a lang' }).set('Authorization', GOOD_AUTH)).status).toBe(400);
    expect(summaries!.getSummary).not.toHaveBeenCalled();
  });

  it('maps transcript 404s, LLM outages (503) and other failures (500)', async () => {
    const noCaps = makeApp({ summaries: { getSummary: vi.fn(async () => { throw new TranscriptError('NO_CAPTIONS', 'none', { cached: true }); }) } });
    const r1 = await request(noCaps.app).get('/summary/ScMzIvxBSi4').set('Authorization', GOOD_AUTH);
    expect(r1.status).toBe(404);
    expect(r1.body).toMatchObject({ videoId: 'ScMzIvxBSi4', available: false, cached: true });
    const down = makeApp({ summaries: { getSummary: vi.fn(async () => { throw new LlmError('LLM_UNAVAILABLE', 'cannot reach LLM'); }) } });
    const r2 = await request(down.app).get('/summary/fW4SwcMQYdA').set('Authorization', GOOD_AUTH);
    expect(r2.status).toBe(503);
    expect(r2.body).toMatchObject({ code: 'LLM_UNAVAILABLE', retryable: true });
    const boom = makeApp({ summaries: { getSummary: vi.fn(async () => { throw new Error('boom'); }) } });
    const r3 = await request(boom.app).get('/summary/fW4SwcMQYdA').set('Authorization', GOOD_AUTH);
    expect(r3.status).toBe(500);
    expect(r3.body).toMatchObject({ code: 'SUMMARY_FAILED', error: 'boom' });
  });

  it('answers 503 when summaries are disabled', async () => {
    const { app } = makeApp({ summaries: null });
    const res = await request(app).get('/summary/fW4SwcMQYdA').set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('summaries disabled');
  });
});

describe('GET /summaries', () => {
  it('lists cached summaries with a count', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/summaries')).status).toBe(401);
    const res = await request(app).get('/summaries').set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.summaries[0]).toMatchObject({ videoId: 'fW4SwcMQYdA', summaryLang: 'de' });
  });
});
