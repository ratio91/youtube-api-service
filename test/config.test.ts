import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

// src/config.ts calls process.exit(1) on invalid env at import time, which
// would kill the test runner if imported in-process. Validate in a child node
// process instead, with a scrubbed env.
const projectRoot = process.cwd(); // vitest runs from the package root
const tsNodeRegister = path.join(projectRoot, 'node_modules', 'ts-node', 'register', 'transpile-only');
const configModule = path.join(projectRoot, 'src', 'config.ts');

function runConfigWithEnv(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ['-r', tsNodeRegister, '-e', `const c = require(${JSON.stringify(configModule)}).config; console.log(JSON.stringify({ oauth: c.oauth, delay: c.TRANSCRIPT_BATCH_DELAY_MS, max: c.TRANSCRIPT_BATCH_MAX, langs: c.SUMMARY_LANGUAGES }))`],
    { cwd: projectRoot, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf-8', timeout: 30_000 }
  );
}

const basicOnly: Record<string, string> = { BASIC_AUTH_USER: 'user', BASIC_AUTH_PASS: 'pass' };
const oauthTrio: Record<string, string> = {
  YOUTUBE_CLIENT_ID: 'cid',
  YOUTUBE_CLIENT_SECRET: 'csecret',
  OAUTH_REDIRECT_URI: 'http://localhost:3000/oauth/callback',
};

describe('config env validation (child process)', () => {
  it('exits 1 and names the missing variable when BASIC_AUTH_USER is absent', () => {
    const { BASIC_AUTH_USER: _omit, ...env } = basicOnly;
    const result = runConfigWithEnv(env);
    expect(result.status).toBe(1);
    const output = result.stderr + result.stdout;
    expect(output).toContain('Invalid environment configuration');
    expect(output).toContain('BASIC_AUTH_USER');
    expect(output).toContain('missing');
  }, 60_000);

  it('starts in transcript-only mode with only basic-auth vars (oauth = null, defaults applied)', () => {
    const result = runConfigWithEnv(basicOnly);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ oauth: null, delay: 3000, max: 50, langs: [] });
  }, 60_000);

  it('treats empty OAuth values (as in .env.example) as unset', () => {
    const result = runConfigWithEnv({ ...basicOnly, YOUTUBE_CLIENT_ID: '', YOUTUBE_CLIENT_SECRET: '', OAUTH_REDIRECT_URI: '' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).oauth).toBeNull();
  }, 60_000);

  it('enables OAuth when all three vars are present', () => {
    const result = runConfigWithEnv({ ...basicOnly, ...oauthTrio });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).oauth).toEqual({ clientId: 'cid', clientSecret: 'csecret', redirectUri: oauthTrio.OAUTH_REDIRECT_URI });
  }, 60_000);

  it('exits 1 when the OAuth trio is only partially set', () => {
    const result = runConfigWithEnv({ ...basicOnly, YOUTUBE_CLIENT_ID: 'cid' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('YOUTUBE_CLIENT_SECRET');
    expect(result.stderr).toContain('OAUTH_REDIRECT_URI');
  }, 60_000);

  it('exits 1 on a non-URL OAUTH_REDIRECT_URI or a non-numeric delay', () => {
    expect(runConfigWithEnv({ ...basicOnly, ...oauthTrio, OAUTH_REDIRECT_URI: 'not a url' }).status).toBe(1);
    const bad = runConfigWithEnv({ ...basicOnly, TRANSCRIPT_BATCH_DELAY_MS: 'soon' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('TRANSCRIPT_BATCH_DELAY_MS');
  }, 60_000);

  it('parses SUMMARY_LANGUAGES as a lower-cased list and rejects non-codes', () => {
    const ok = runConfigWithEnv({ ...basicOnly, SUMMARY_LANGUAGES: ' EN, de ,' });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).langs).toEqual(['en', 'de']);
    const bad = runConfigWithEnv({ ...basicOnly, SUMMARY_LANGUAGES: 'english' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('SUMMARY_LANGUAGES');
  }, 60_000);
});
