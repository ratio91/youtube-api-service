import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import type { YouTubeService } from '../src/youtube';

// src/config.ts parses process.env at import time and calls process.exit(1)
// on failure, so the env MUST be populated before src/app (which imports
// src/config transitively) is loaded. That is why createApp is pulled in via
// a dynamic import below, after these assignments.
process.env.YOUTUBE_CLIENT_ID = 'test-client-id';
process.env.YOUTUBE_CLIENT_SECRET = 'test-client-secret';
process.env.BASIC_AUTH_USER = 'testuser';
process.env.BASIC_AUTH_PASS = 'testpass';
process.env.OAUTH_REDIRECT_URI = 'http://localhost:3000/oauth/callback';
process.env.TOKEN_PATH =
  '/private/tmp/claude-501/-Users-f19r-dev-youtube-api-service/52433b2f-56e6-4729-8847-34c864529466/scratchpad/tokens.json';
// /videos tests below rely on no default playlist being configured.
delete process.env.DEFAULT_PLAYLIST_ID;

const { createApp } = await import('../src/app');

const GOOD_AUTH = 'Basic ' + Buffer.from('testuser:testpass').toString('base64');
const BAD_AUTH = 'Basic ' + Buffer.from('testuser:wrong-password').toString('base64');

type ServiceOverrides = Partial<Record<keyof YouTubeService, unknown>>;

function makeFakeService(overrides: ServiceOverrides = {}): YouTubeService {
  const fake = {
    isAuthorized: vi.fn(() => true),
    getAuthUrl: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?fake=1'),
    authorize: vi.fn(async (_code: string) => {}),
    listMyPlaylists: vi.fn(async () => [
      {
        id: 'PL123',
        snippet: {
          title: 'My Playlist',
          description: 'A playlist',
          publishedAt: '2026-01-01T00:00:00Z',
        },
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
    getTranscript: vi.fn(async (_videoId: string) => [
      { text: 'hello world', duration: 1000, offset: 0, lang: 'en' },
    ]),
    getBatchTranscripts: vi.fn(async (_videoIds: string[]) => ({})),
    ...overrides,
  };
  return fake as unknown as YouTubeService;
}

function makeApp(overrides: ServiceOverrides = {}) {
  const service = makeFakeService(overrides);
  return { app: createApp(service), service };
}

describe('GET /health', () => {
  it('returns 200 with status ok and an authorized boolean (no auth required)', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.authorized).toBe('boolean');
    expect(res.body.authorized).toBe(true);
  });

  it('reflects an unauthorized service', async () => {
    const { app } = makeApp({ isAuthorized: vi.fn(() => false) });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(false);
  });
});

describe('basic auth middleware (via /playlists)', () => {
  it('rejects requests without an Authorization header with 401 and WWW-Authenticate', async () => {
    const { app, service } = makeApp();
    const res = await request(app).get('/playlists');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Basic /);
    expect(res.body.error).toBe('Authentication required');
    expect(service.listMyPlaylists).not.toHaveBeenCalled();
  });

  it('rejects wrong credentials with 401', async () => {
    const { app, service } = makeApp();
    const res = await request(app).get('/playlists').set('Authorization', BAD_AUTH);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Basic /);
    expect(res.body.error).toBe('Invalid credentials');
    expect(service.listMyPlaylists).not.toHaveBeenCalled();
  });

  it('passes through with correct credentials', async () => {
    const { app, service } = makeApp();
    const res = await request(app).get('/playlists').set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(200);
    expect(service.listMyPlaylists).toHaveBeenCalledOnce();
    expect(res.body.count).toBe(1);
    expect(res.body.playlists[0]).toMatchObject({ id: 'PL123', title: 'My Playlist', itemCount: 2 });
  });
});

describe('GET /oauth/callback', () => {
  it('returns 400 when code is missing', async () => {
    const { app, service } = makeApp();
    const res = await request(app).get('/oauth/callback');
    expect(res.status).toBe(400);
    expect(res.text).toContain('Missing authorization code');
    expect(service.authorize).not.toHaveBeenCalled();
  });

  it('authorizes with the code and returns HTML success', async () => {
    const { app, service } = makeApp();
    const res = await request(app).get('/oauth/callback').query({ code: 'the-code' });
    expect(res.status).toBe(200);
    expect(service.authorize).toHaveBeenCalledWith('the-code');
    expect(res.text).toContain('Authorization successful');
  });

  it('returns 500 when authorize throws', async () => {
    const { app } = makeApp({
      authorize: vi.fn(async () => {
        throw new Error('token exchange failed');
      }),
    });
    const res = await request(app).get('/oauth/callback').query({ code: 'bad-code' });
    expect(res.status).toBe(500);
    expect(res.text).toContain('Authorization failed');
    expect(res.text).toContain('token exchange failed');
  });
});

describe('POST /auth/callback', () => {
  it('returns 400 when code is missing', async () => {
    const { app, service } = makeApp();
    const res = await request(app).post('/auth/callback').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Authorization code required');
    expect(service.authorize).not.toHaveBeenCalled();
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
    const { app, service } = makeApp();
    const res = await request(app)
      .get('/videos')
      .query({ playlistId: 'PLxyz' })
      .set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(200);
    expect(service.fetchPlaylistVideos).toHaveBeenCalledWith('PLxyz');
    expect(res.body.playlistId).toBe('PLxyz');
    expect(res.body.count).toBe(1);
    expect(res.body.videos[0].videoId).toBe('vid1');
  });
});

describe('GET /transcript/:videoId', () => {
  it('returns 200 with the stubbed transcript', async () => {
    const { app, service } = makeApp();
    const res = await request(app).get('/transcript/vid1').set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(200);
    expect(service.getTranscript).toHaveBeenCalledWith('vid1');
    expect(res.body.videoId).toBe('vid1');
    expect(res.body.transcript).toEqual([{ text: 'hello world', duration: 1000, offset: 0, lang: 'en' }]);
  });

  it('returns 500 when the service throws', async () => {
    const { app } = makeApp({
      getTranscript: vi.fn(async () => {
        throw new Error('no transcript available');
      }),
    });
    const res = await request(app).get('/transcript/vid1').set('Authorization', GOOD_AUTH);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('no transcript available');
  });
});

describe('POST /batch-transcripts', () => {
  it('returns 400 when videoIds is not an array', async () => {
    const { app, service } = makeApp();
    const res = await request(app)
      .post('/batch-transcripts')
      .set('Authorization', GOOD_AUTH)
      .send({ videoIds: 'vid1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('videoIds must be an array');
    expect(service.getBatchTranscripts).not.toHaveBeenCalled();
  });
});
