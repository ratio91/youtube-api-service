import { describe, it, expect, vi } from 'vitest';
import { createHealthProvider, TranscriptsHealth } from '../src/health';
import type { YouTubeService } from '../src/youtube';

const healthy: TranscriptsHealth = { backend: 'yt-dlp', version: '2026.08.19', ok: true, jsRuntime: { requested: 'node', detected: 'node-24.21.0', present: true }, ejs: '0.8.0' };
const noRuntime: TranscriptsHealth = { ...healthy, jsRuntime: { requested: 'node', detected: 'none', present: false } };
const noBinary: TranscriptsHealth = { backend: 'yt-dlp', version: null, ok: false, error: 'ENOENT', jsRuntime: { requested: 'node', detected: null, present: false }, ejs: null };

function fakeYouTube(check: () => Promise<{ status: 'ok' | 'expired' | 'unauthorized' | 'error'; checkedAt: string; error?: string }>) {
  return { verifyRefresh: vi.fn(check) } as unknown as YouTubeService;
}

describe('createHealthProvider', () => {
  it('transcript-only mode: oauth disabled, authorized false, status ok when yt-dlp and runtime are detected', async () => {
    const probe = vi.fn(async () => healthy);
    const health = createHealthProvider({ youtube: null, probeTranscripts: probe, oauthCacheMs: 1000 });
    const r = await health();
    expect(r).toMatchObject({ status: 'ok', mode: 'transcript-only', oauth: 'disabled', authorized: false, transcripts: healthy });
    expect(r.oauthDetail).toBeUndefined();
  });

  it('includes cache stats when provided and null otherwise', async () => {
    const stats = { dir: '/data/transcripts', files: 2, sizeBytes: 100, writable: true };
    const withCache = createHealthProvider({ youtube: null, probeTranscripts: async () => healthy, cacheStats: async () => stats, oauthCacheMs: 1000 });
    expect((await withCache()).cache).toEqual(stats);
    const without = createHealthProvider({ youtube: null, probeTranscripts: async () => healthy, oauthCacheMs: 1000 });
    expect((await without()).cache).toBeNull();
  });

  it('reports the LLM probe (cached for llmCacheMs) without affecting status', async () => {
    let t = 0;
    const probe = vi.fn(async () => ({ ok: false, baseUrl: 'http://x/v1', model: null, contextTokens: null, build: null, error: 'ECONNREFUSED' }));
    const health = createHealthProvider({ youtube: null, probeTranscripts: async () => healthy, probeLlm: probe, llmCacheMs: 100, summaryStats: async () => ({ dir: '/s', files: 0, sizeBytes: 0, writable: true }), oauthCacheMs: 1000, now: () => t });
    const r = await health();
    expect(r.status).toBe('ok'); // LLM down does not degrade the transcript service
    expect(r.llm).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
    expect(r.summaryCache).toMatchObject({ dir: '/s' });
    await health();
    expect(probe).toHaveBeenCalledTimes(1);
    t = 150;
    await health();
    expect(probe).toHaveBeenCalledTimes(2);
    const without = createHealthProvider({ youtube: null, probeTranscripts: async () => healthy, oauthCacheMs: 1000 });
    expect((await without()).llm).toBeNull();
  });

  it('is degraded when yt-dlp runs but does not detect the requested JS runtime', async () => {
    const health = createHealthProvider({ youtube: null, probeTranscripts: async () => noRuntime, oauthCacheMs: 1000 });
    const r = await health();
    expect(r.status).toBe('degraded');
    expect(r.transcripts.ok).toBe(true);
    expect(r.transcripts.jsRuntime.present).toBe(false);
  });

  it('is degraded when the binary cannot run', async () => {
    const health = createHealthProvider({ youtube: null, probeTranscripts: async () => noBinary, oauthCacheMs: 1000 });
    expect((await health()).status).toBe('degraded');
  });

  it('caches a healthy probe forever but re-probes a degraded one after transcriptsRecheckMs', async () => {
    let t = 0;
    const now = () => t;
    const results = [noRuntime, noRuntime, healthy, noBinary];
    const probe = vi.fn(async () => results.shift() ?? healthy);
    const health = createHealthProvider({ youtube: null, probeTranscripts: probe, oauthCacheMs: 1000, transcriptsRecheckMs: 100, now });
    expect((await health()).status).toBe('degraded'); // probe 1
    expect((await health()).status).toBe('degraded'); // cached (t=0 < 100)
    t = 150;
    expect((await health()).status).toBe('degraded'); // probe 2 (noRuntime)
    t = 300;
    expect((await health()).status).toBe('ok');       // probe 3 (healthy) → cached from now on
    t = 10_000;
    expect((await health()).status).toBe('ok');       // no probe 4
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('full mode: oauth reflects a real refresh check, cached for oauthCacheMs, authorized only when ok', async () => {
    let t = 0;
    const check = vi.fn(async () => ({ status: 'ok' as const, checkedAt: 'c1' }));
    const health = createHealthProvider({ youtube: fakeYouTube(check), probeTranscripts: async () => healthy, oauthCacheMs: 1000, now: () => t });
    const r1 = await health();
    expect(r1).toMatchObject({ mode: 'full', oauth: 'ok', authorized: true, oauthDetail: { status: 'ok', checkedAt: 'c1' } });
    await health();
    expect(check).toHaveBeenCalledTimes(1); // cached
    t = 1500;
    check.mockResolvedValueOnce({ status: 'expired' as const, checkedAt: 'c2', error: 'invalid_grant' });
    const r3 = await health();
    expect(check).toHaveBeenCalledTimes(2);
    expect(r3).toMatchObject({ oauth: 'expired', authorized: false, oauthDetail: { error: 'invalid_grant' } });
  });

  it('collapses concurrent health calls into one refresh check', async () => {
    const check = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return { status: 'unauthorized' as const, checkedAt: 'c' }; });
    const health = createHealthProvider({ youtube: fakeYouTube(check), probeTranscripts: async () => healthy, oauthCacheMs: 1000 });
    const [a, b] = await Promise.all([health(), health()]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(a.oauth).toBe('unauthorized');
    expect(b.authorized).toBe(false);
  });
});
