import type { NextFunction, Request, Response } from 'express';

/**
 * What the service is doing right now, for a host-side idle check (the operator's
 * home machine suspends itself when nothing is in flight, the LLM queue is empty and
 * the last activity is old enough).
 */
export interface ActivitySnapshot {
  /** HTTP requests being handled, /health excluded */
  inFlight: number;
  /** LLM tasks queued or running; they outlive a request whose client disconnected */
  llmPending: number;
  /** last request start/end or LLM task end; process start until the first one */
  lastActivityAt: string;
  idleSeconds: number;
}

export interface ActivityDeps {
  llmPending?: () => number;
  now?: () => number;
}

/** Paths that never count as activity: health polls (container healthcheck, n8n wake loop). */
const IGNORED_PATHS = new Set(['/health']);

export class ActivityTracker {
  private inFlight = 0;
  private lastAt: number;
  private readonly now: () => number;

  constructor(private readonly deps: ActivityDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.lastAt = this.now();
  }

  touch(): void {
    this.lastAt = this.now();
  }

  /** Marks one unit of work as started; the returned function ends it (idempotent). */
  begin(): () => void {
    this.inFlight++;
    this.touch();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inFlight--;
      this.touch();
    };
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (IGNORED_PATHS.has(req.path)) return next();
      const end = this.begin();
      // 'finish' = response sent; 'close' also fires when the client disconnects first.
      res.once('finish', end);
      res.once('close', end);
      next();
    };
  }

  snapshot(): ActivitySnapshot {
    const t = this.now();
    return {
      inFlight: this.inFlight,
      llmPending: this.deps.llmPending ? this.deps.llmPending() : 0,
      lastActivityAt: new Date(this.lastAt).toISOString(),
      idleSeconds: Math.max(0, Math.floor((t - this.lastAt) / 1000)),
    };
  }
}
