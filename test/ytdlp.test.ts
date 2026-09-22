import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildArgs, classifyFailure, detectBlockSignal, lastLines, parseInfoJson, parseYtDlpDebugHeader, YtDlpResult, VIDEO_ID_RE } from '../src/transcripts/ytdlp';

const base: YtDlpResult = { exitCode: 1, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 100 };
const fixtureStdout = fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'info', 'lXUZvyajciY.json'), 'utf8');

describe('buildArgs', () => {
  it('requests JSON only, no download, one video, with the configured JS runtime', () => {
    const args = buildArgs('lXUZvyajciY', { jsRuntime: 'node' });
    expect(args).toContain('-J');
    expect(args).toContain('--skip-download');
    expect(args).toContain('--no-playlist');
    expect(args.slice(args.indexOf('--js-runtimes'), args.indexOf('--js-runtimes') + 2)).toEqual(['--js-runtimes', 'node']);
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('https://www.youtube.com/watch?v=lXUZvyajciY');
    expect(args).not.toContain('--ignore-no-formats-error'); // would turn bot checks into "no captions" (A4.3)
  });

  it('omits --js-runtimes when set to "none"', () => {
    expect(buildArgs('lXUZvyajciY', { jsRuntime: 'none' })).not.toContain('--js-runtimes');
  });

  it('VIDEO_ID_RE accepts 11-char ids only', () => {
    expect(VIDEO_ID_RE.test('lXUZvyajciY')).toBe(true);
    expect(VIDEO_ID_RE.test('Me-kZi4xkEs')).toBe(true);
    expect(VIDEO_ID_RE.test('short')).toBe(false);
    expect(VIDEO_ID_RE.test('lXUZvyajciY; rm -rf /')).toBe(false);
  });
});

describe('classifyFailure', () => {
  it('missing binary → BACKEND_FAILURE naming the path', () => {
    const err = classifyFailure({ ...base, exitCode: null, spawnError: Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }) }, '/usr/local/bin/yt-dlp');
    expect(err.code).toBe('BACKEND_FAILURE');
    expect(err.reason).toContain('/usr/local/bin/yt-dlp');
    expect(err.httpStatus).toBe(500);
  });

  it('timeout → TIMEOUT (503, retryable)', () => {
    const err = classifyFailure({ ...base, exitCode: null, signal: 'SIGTERM', timedOut: true, durationMs: 90000 }, 'yt-dlp');
    expect(err.code).toBe('TIMEOUT');
    expect(err.httpStatus).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it('bot check → BLOCKED, keyed on "not a bot" (not on "Sign in")', () => {
    const stderr = "ERROR: [youtube] lXUZvyajciY: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication. See https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp";
    const err = classifyFailure({ ...base, stderr }, 'yt-dlp');
    expect(err.code).toBe('BLOCKED');
    expect(err.retryable).toBe(true);
    expect(err.reason).toContain('not a bot');
  });

  it('IP block message → BLOCKED', () => {
    expect(classifyFailure({ ...base, stderr: 'ERROR: [youtube] x: All player responses are invalid. Your IP is likely being blocked by Youtube' }, 'yt-dlp').code).toBe('BLOCKED');
  });

  it('rate limit wording / HTTP 429 → RATE_LIMITED', () => {
    expect(classifyFailure({ ...base, stderr: 'ERROR: [youtube] x: This content isn\'t available, try again later. The video has been rate-limited by YouTube for up to an hour.' }, 'yt-dlp').code).toBe('RATE_LIMITED');
    expect(classifyFailure({ ...base, stderr: "ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests" }, 'yt-dlp').code).toBe('RATE_LIMITED');
  });

  it('private / unavailable videos → VIDEO_UNAVAILABLE (500), even though they mention "Sign in"', () => {
    const priv = classifyFailure({ ...base, stderr: "ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video. Use --cookies-from-browser or --cookies for the authentication." }, 'yt-dlp');
    expect(priv.code).toBe('VIDEO_UNAVAILABLE');
    expect(priv.httpStatus).toBe(500);
    expect(priv.retryable).toBe(false);
    expect(classifyFailure({ ...base, stderr: 'ERROR: [youtube] abc: Video unavailable' }, 'yt-dlp').code).toBe('VIDEO_UNAVAILABLE');
  });

  it('anything else → BACKEND_FAILURE with the exit code and last stderr lines', () => {
    const err = classifyFailure({ ...base, exitCode: 2, stderr: 'yt-dlp: error: no such option: --bogus' }, 'yt-dlp');
    expect(err.code).toBe('BACKEND_FAILURE');
    expect(err.reason).toContain('exit 2');
    expect(err.reason).toContain('--bogus');
  });
});

describe('detectBlockSignal (exit-0 warnings)', () => {
  it('flags the PO-token discard warning as BLOCKED', () => {
    const err = detectBlockSignal('WARNING: [youtube] abc: Some web client subtitles require a PO Token which was not provided. They will be discarded since they are not downloadable as-is.');
    expect(err?.code).toBe('BLOCKED');
  });

  it('returns null for ordinary output', () => {
    expect(detectBlockSignal('[youtube] Extracting URL: https://www.youtube.com/watch?v=abc\n[info] abc: Downloading 1 format(s)')).toBeNull();
    expect(detectBlockSignal('')).toBeNull();
  });
});

describe('parseInfoJson / lastLines', () => {
  it('accepts the captured yt-dlp info JSON', () => {
    const info = parseInfoJson(fixtureStdout);
    expect(info.id).toBe('lXUZvyajciY');
    expect(Object.keys(info.subtitles)).toEqual(['en', 'es']);
  });

  it('rejects garbage and wrong shapes with BACKEND_FAILURE', () => {
    expect(() => parseInfoJson('')).toThrow(/no parsable JSON/);
    expect(() => parseInfoJson(JSON.stringify({ subtitles: 'nope' }))).toThrow(/expected shape/);
  });

  it('lastLines prefers ERROR lines and truncates', () => {
    expect(lastLines('[debug] a\nWARNING: b\nERROR: c\n')).toBe('ERROR: c');
    expect(lastLines('one\ntwo\nthree\nfour')).toBe('two | three | four');
    expect(lastLines('x'.repeat(700)).length).toBeLessThan(700);
  });
});

describe('parseYtDlpDebugHeader (captured from yt-dlp 2026.08.19 `-v` with no URL)', () => {
  const header = [
    '[debug] Command-line config: [\'-v\', \'--js-runtimes\', \'node\']',
    '[debug] yt-dlp version stable@2026.08.19 from yt-dlp/yt-dlp (musllinux_aarch64_exe)',
    '[debug] Optional libraries: Cryptodome-3.23.0, brotli-1.2.0, certifi-2026.07.22, curl_cffi-0.16.0, mutagen-1.48.1, requests-2.34.2, secretstorage-3.5.0, sqlite3-3.53.4, urllib3-2.7.0, websockets-17.0.1, yt_dlp_ejs-0.8.0',
    '[debug] JS runtimes: node-24.21.0',
    'Usage: yt-dlp [OPTIONS] URL [URL...]',
    'yt-dlp: error: You must provide at least one URL.',
  ].join('\n');

  it('extracts version, detected runtime and ejs version', () => {
    expect(parseYtDlpDebugHeader(header)).toEqual({ version: '2026.08.19', jsRuntimes: 'node-24.21.0', ejs: '0.8.0' });
  });

  it('reads the negative wordings', () => {
    expect(parseYtDlpDebugHeader('[debug] JS runtimes: none (disabled)\n').jsRuntimes).toBe('none (disabled)');
    expect(parseYtDlpDebugHeader('[debug] JS runtimes: none\n').jsRuntimes).toBe('none');
  });

  it('handles a pip install header without channel prefix and without ejs', () => {
    const h = '[debug] yt-dlp version 2026.08.19 from yt-dlp/yt-dlp (pip)\n[debug] Optional libraries: certifi-2026.07.22\n[debug] JS runtimes: deno-2.9.7\n';
    expect(parseYtDlpDebugHeader(h)).toEqual({ version: '2026.08.19', jsRuntimes: 'deno-2.9.7', ejs: null });
  });

  it('returns nulls for unrelated output', () => {
    expect(parseYtDlpDebugHeader('sh: yt-dlp: not found')).toEqual({ version: null, jsRuntimes: null, ejs: null });
  });
});
