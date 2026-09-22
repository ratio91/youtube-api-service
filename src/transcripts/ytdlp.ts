import { spawn } from 'child_process';
import { TranscriptError } from './errors';
import { CaptionInfo, captionInfoSchema } from './select';

/**
 * yt-dlp subprocess runner + result classifier.
 * Facts about flags, exit codes and stderr wording: docs/verified/2026-09-22-transcript-backends.md
 * (A2.4 --js-runtimes, A3.1 -J/--skip-download, A4 exit codes and messages, A5.4 PO-token warning).
 */
export interface YtDlpResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
  durationMs: number;
}

export type YtDlpRunner = (videoId: string) => Promise<YtDlpResult>;

export interface YtDlpOptions {
  binary: string;
  /** value for --js-runtimes; "none" omits the flag */
  jsRuntime: string;
  timeoutMs: number;
}

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function buildArgs(videoId: string, opts: Pick<YtDlpOptions, 'jsRuntime'>): string[] {
  const args = ['-J', '--skip-download', '--no-playlist', '--socket-timeout', '30'];
  if (opts.jsRuntime && opts.jsRuntime !== 'none') {
    args.push('--js-runtimes', opts.jsRuntime);
  }
  // Only drops translations of MANUAL subs in 2026.08.19; still shrinks the JSON.
  args.push('--extractor-args', 'youtube:skip=translated_subs');
  args.push('--', `https://www.youtube.com/watch?v=${videoId}`);
  return args;
}

function runProcess(binary: string, args: string[], timeoutMs: number): Promise<YtDlpResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5_000).unref();
    }, timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', (err: NodeJS.ErrnoException) => { spawnError = err; });
    child.on('close', (code, signal) => {
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout, stderr, timedOut, spawnError, durationMs: performance.now() - started });
    });
  });
}

export function createYtDlpRunner(opts: YtDlpOptions): YtDlpRunner {
  return (videoId) => runProcess(opts.binary, buildArgs(videoId, opts), opts.timeoutMs);
}

export interface YtDlpProbe {
  /** e.g. "2026.08.19"; null when the binary could not be run or the header was unreadable */
  version: string | null;
  jsRuntime: {
    /** what the service passes to --js-runtimes ("none" = flag omitted, yt-dlp default) */
    requested: string;
    /** yt-dlp's own detection, e.g. "node-24.21.0", "none", "none (disabled)" */
    detected: string | null;
    present: boolean;
  };
  /** bundled yt-dlp-ejs version (the n/sig challenge solver), null if absent */
  ejs: string | null;
  error?: string;
}

/**
 * Parse the `-v` debug header. Verified 2026-09-22 on yt-dlp 2026.08.19:
 *   [debug] yt-dlp version stable@2026.08.19 from yt-dlp/yt-dlp (musllinux_aarch64_exe)
 *   [debug] Optional libraries: Cryptodome-3.23.0, …, yt_dlp_ejs-0.8.0
 *   [debug] JS runtimes: node-24.21.0            | none | none (disabled)
 */
export function parseYtDlpDebugHeader(stderr: string): { version: string | null; jsRuntimes: string | null; ejs: string | null } {
  const version = stderr.match(/^\[debug\] yt-dlp version (?:\S+@)?(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)/m)?.[1] ?? null;
  const jsRuntimes = stderr.match(/^\[debug\] JS runtimes: (.+?)\s*$/m)?.[1] ?? null;
  const ejs = stderr.match(/\byt_dlp_ejs-(\S+?)(?:,|\s|$)/)?.[1] ?? null;
  return { version, jsRuntimes, ejs };
}

/**
 * Health probe without touching YouTube: `yt-dlp -v [--js-runtimes X]` with no URL
 * prints the debug header (version, optional libraries, detected JS runtimes) and
 * then exits 2 with "You must provide at least one URL". Same flag as the real
 * calls, so what it reports is what extraction will use.
 */
export async function probeYtDlp(opts: Pick<YtDlpOptions, 'binary' | 'jsRuntime'>, timeoutMs = 15_000): Promise<YtDlpProbe> {
  const args = ['-v'];
  if (opts.jsRuntime && opts.jsRuntime !== 'none') args.push('--js-runtimes', opts.jsRuntime);
  const base: YtDlpProbe = { version: null, jsRuntime: { requested: opts.jsRuntime, detected: null, present: false }, ejs: null };
  const r = await runProcess(opts.binary, args, timeoutMs);
  if (r.spawnError) return { ...base, error: `${r.spawnError.code ?? 'spawn error'}: ${r.spawnError.message}` };
  if (r.timedOut) return { ...base, error: 'yt-dlp probe timed out' };
  const header = parseYtDlpDebugHeader(r.stderr + '\n' + r.stdout);
  if (!header.version && !header.jsRuntimes) {
    return { ...base, error: `unexpected yt-dlp output (exit ${r.exitCode}): ${lastLines(r.stderr || r.stdout)}` };
  }
  const detected = header.jsRuntimes;
  return {
    version: header.version,
    jsRuntime: { requested: opts.jsRuntime, detected, present: detected !== null && !/^none\b/i.test(detected) },
    ejs: header.ejs,
  };
}

// --- classification -------------------------------------------------------

// Order matters: first match wins. Wording from yt-dlp 2026.08.19 / YouTube (A4.3–A4.5).
// "Sign in" alone is NOT a block signal — private videos carry it too (A4.4).
const BLOCK_PATTERNS: RegExp[] = [
  /not a bot/i,
  /IP is likely being blocked/i,
  /subtitles require a PO Token/i,
  /playerCaptcha|captcha/i,
  /HTTP Error 403/i,
];
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate-limited/i,
  /HTTP Error 429/i,
  /Too Many Requests/i,
  /This content isn't available, try again later/i,
];

export function lastLines(text: string, n = 3, max = 600): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLines = lines.filter((l) => l.startsWith('ERROR'));
  const picked = (errorLines.length ? errorLines : lines).slice(-n).join(' | ');
  return picked.length > max ? `${picked.slice(0, max)}…` : picked;
}

/** Block / rate-limit signals present in stderr regardless of exit code. */
export function detectBlockSignal(stderr: string): TranscriptError | null {
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(stderr))) {
    return new TranscriptError('RATE_LIMITED', `YouTube rate limit: ${lastLines(stderr)}`);
  }
  if (BLOCK_PATTERNS.some((re) => re.test(stderr))) {
    return new TranscriptError('BLOCKED', `YouTube blocked the request: ${lastLines(stderr)}`);
  }
  return null;
}

/** Turn a failed yt-dlp run (non-zero exit, timeout, spawn error) into a typed error. */
export function classifyFailure(result: YtDlpResult, binary: string): TranscriptError {
  if (result.spawnError) {
    const code = result.spawnError.code;
    const reason = code === 'ENOENT' ? `yt-dlp binary not found at "${binary}"` : `failed to start yt-dlp: ${result.spawnError.message}`;
    return new TranscriptError('BACKEND_FAILURE', reason, { cause: result.spawnError });
  }
  if (result.timedOut) {
    return new TranscriptError('TIMEOUT', `yt-dlp exceeded ${Math.round(result.durationMs)} ms`);
  }
  const blocked = detectBlockSignal(result.stderr);
  if (blocked) return blocked;
  const summary = lastLines(result.stderr) || `exit code ${result.exitCode}`;
  if (/ERROR:\s*\[youtube\]/i.test(result.stderr)) {
    return new TranscriptError('VIDEO_UNAVAILABLE', summary);
  }
  return new TranscriptError('BACKEND_FAILURE', `yt-dlp failed (exit ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ''}): ${summary}`);
}

export function parseInfoJson(stdout: string): CaptionInfo {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch (err) {
    throw new TranscriptError('BACKEND_FAILURE', 'yt-dlp produced no parsable JSON', { cause: err });
  }
  const parsed = captionInfoSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TranscriptError('BACKEND_FAILURE', `yt-dlp JSON does not match expected shape at ${issue?.path.join('.') || '<root>'}: ${issue?.message}`);
  }
  return parsed.data;
}
