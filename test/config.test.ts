import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

// src/config.ts calls process.exit(1) on invalid env at import time, which
// would kill the test runner if imported in-process. Validate the failure
// path in a child node process instead, with a scrubbed env.
const projectRoot = process.cwd(); // vitest runs from the package root
const tsNodeRegister = path.join(projectRoot, 'node_modules', 'ts-node', 'register', 'transpile-only');
const configModule = path.join(projectRoot, 'src', 'config.ts');

function runConfigWithEnv(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ['-r', tsNodeRegister, '-e', `require(${JSON.stringify(configModule)})`],
    {
      cwd: projectRoot,
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf-8',
      timeout: 30_000,
    }
  );
}

const validEnv: Record<string, string> = {
  YOUTUBE_CLIENT_ID: 'cid',
  YOUTUBE_CLIENT_SECRET: 'csecret',
  BASIC_AUTH_USER: 'user',
  BASIC_AUTH_PASS: 'pass',
  OAUTH_REDIRECT_URI: 'http://localhost:3000/oauth/callback',
};

describe('config env validation (child process)', () => {
  it('exits 1 and names the missing variable when YOUTUBE_CLIENT_ID is absent', () => {
    const { YOUTUBE_CLIENT_ID: _omit, ...env } = validEnv;
    const result = runConfigWithEnv(env);
    expect(result.status).toBe(1);
    const output = result.stderr + result.stdout;
    expect(output).toContain('Invalid environment configuration');
    expect(output).toContain('YOUTUBE_CLIENT_ID');
    expect(output).toContain('missing');
  }, 60_000);

  it('exits 0 when all required variables are present', () => {
    const result = runConfigWithEnv(validEnv);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }, 60_000);
});
