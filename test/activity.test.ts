import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { ActivityTracker } from '../src/activity';
import { LlmQueue } from '../src/llm/queue';
import { createHealthProvider, TranscriptsHealth } from '../src/health';

const healthy: TranscriptsHealth = { backend: 'yt-dlp', version: '2026.08.19', ok: true, jsRuntime: { requested: 'node', detected: 'node-24.21.0', present: true }, ejs: '0.8.0' };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('ActivityTracker', () => {
  it('counts idle time from process start until the first activity', () => {
    let t = 1_000_000;
    const a = new ActivityTracker({ now: () => t });
    t += 90_500;
    expect(a.snapshot()).toEqual({ inFlight: 0, llmPending: 0, lastActivityAt: new Date(1_000_000).toISOString(), idleSeconds: 90 });
  });

  it('begin/end count in-flight work, touch the clock, and end is idempotent', () => {
    let t = 0;
    const a = new ActivityTracker({ now: () => t });
    t = 5_000;
    const end = a.begin();
    expect(a.snapshot()).toMatchObject({ inFlight: 1, idleSeconds: 0 });
    t = 65_000;
    expect(a.snapshot().idleSeconds).toBe(60); // a long request: idle time keeps counting, inFlight guards it
    end();
    end();
    expect(a.snapshot()).toMatchObject({ inFlight: 0, idleSeconds: 0, lastActivityAt: new Date(65_000).toISOString() });
  });

  it('reports the LLM queue length from the injected function', () => {
    const a = new ActivityTracker({ llmPending: () => 2 });
    expect(a.snapshot().llmPending).toBe(2);
  });
});

describe('ActivityTracker.middleware', () => {
  function makeApp(a: ActivityTracker, gate: Promise<void>) {
    const app = express();
    app.use(a.middleware());
    app.get('/health', (_req, res) => res.json({ inFlight: a.snapshot().inFlight }));
    app.get('/slow', async (_req, res) => {
      await gate;
      res.json({ ok: true });
    });
    app.get('/fast', (_req, res) => res.json({ inFlight: a.snapshot().inFlight }));
    return app;
  }

  it('does not count /health, counts other requests until the response is sent', async () => {
    const a = new ActivityTracker();
    const gate = deferred();
    const app = makeApp(a, gate.promise);
    expect((await request(app).get('/health')).body.inFlight).toBe(0);
    expect((await request(app).get('/fast')).body.inFlight).toBe(1);
    expect(a.snapshot().inFlight).toBe(0);

    const slow = request(app).get('/slow').then((r) => r.status);
    for (let i = 0; i < 20 && a.snapshot().inFlight === 0; i++) await tick();
    expect(a.snapshot().inFlight).toBe(1);
    gate.resolve();
    expect(await slow).toBe(200);
    expect(a.snapshot().inFlight).toBe(0);
  });

  it('decrements when the client disconnects before the response', async () => {
    const a = new ActivityTracker();
    const gate = deferred();
    const server = http.createServer(makeApp(a, gate.promise));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const req = http.get({ host: '127.0.0.1', port, path: '/slow' });
      req.on('error', () => {});
      for (let i = 0; i < 50 && a.snapshot().inFlight === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(a.snapshot().inFlight).toBe(1);
      req.destroy();
      for (let i = 0; i < 50 && a.snapshot().inFlight !== 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(a.snapshot().inFlight).toBe(0);
      gate.resolve(); // the handler finishing afterwards must not decrement twice
      await new Promise((r) => setTimeout(r, 20));
      expect(a.snapshot().inFlight).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('LlmQueue.pending', () => {
  it('counts queued and running tasks and calls onSettle after success and failure', async () => {
    let settled = 0;
    const q = new LlmQueue({ onSettle: () => settled++ });
    const g1 = deferred();
    const p1 = q.run(async () => {
      await g1.promise;
      return 'a';
    });
    const p2 = q.run(async () => {
      throw new Error('boom');
    });
    expect(q.pending).toBe(2);
    g1.resolve();
    expect(await p1).toBe('a');
    await expect(p2).rejects.toThrow('boom');
    await tick();
    expect(q.pending).toBe(0);
    expect(settled).toBe(2);
  });
});

describe('/health activity field', () => {
  it('is the live snapshot when provided and null otherwise', async () => {
    let n = 0;
    const withActivity = createHealthProvider({
      youtube: null,
      probeTranscripts: async () => healthy,
      activity: () => ({ inFlight: n++, llmPending: 0, lastActivityAt: 'x', idleSeconds: 0 }),
      oauthCacheMs: 1000,
    });
    expect((await withActivity()).activity?.inFlight).toBe(0);
    expect((await withActivity()).activity?.inFlight).toBe(1); // not cached
    const without = createHealthProvider({ youtube: null, probeTranscripts: async () => healthy, oauthCacheMs: 1000 });
    expect((await without()).activity).toBeNull();
  });
});
