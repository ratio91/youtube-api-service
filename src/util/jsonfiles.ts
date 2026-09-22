import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { z } from 'zod';
import { log, errorMessage } from '../log';

/** Write JSON atomically: temp file in the same directory, then rename. Never throws. */
export async function writeJsonAtomic(dir: string, name: string, data: unknown): Promise<{ ok: boolean; error?: string }> {
  const finalPath = path.join(dir, name);
  const tmpPath = path.join(dir, `.${name}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(tmpPath, JSON.stringify(data), { mode: 0o644 });
    await fsp.rename(tmpPath, finalPath);
    return { ok: true };
  } catch (err) {
    const error = errorMessage(err);
    log('error', 'jsonfile.write_failed', { file: finalPath, error });
    try {
      if (fs.existsSync(tmpPath)) await fsp.unlink(tmpPath);
    } catch {
      /* best effort */
    }
    return { ok: false, error };
  }
}

/** Read + schema-validate a JSON file. Missing → null (silent); unreadable/invalid → null (logged). */
export async function readJsonValidated<T>(dir: string, name: string, schema: z.ZodType<T>): Promise<T | null> {
  const file = path.join(dir, name);
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('warn', 'jsonfile.read_failed', { file, error: errorMessage(err) });
    }
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    log('warn', 'jsonfile.invalid', { file, error: parsed.error.issues[0]?.message });
    return null;
  }
  return parsed.data;
}

/** mkdir -p and a write probe. Returns the error message if the directory is not writable. */
export async function ensureWritableDir(dir: string): Promise<string | undefined> {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
    return undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

export interface DirStats {
  files: number;
  sizeBytes: number;
}

/** Count and size the files in `dir` whose names match `pattern`. */
export async function dirStats(dir: string, pattern: RegExp): Promise<DirStats> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { files: 0, sizeBytes: 0 };
    throw err;
  }
  let files = 0;
  let sizeBytes = 0;
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try {
      sizeBytes += (await fsp.stat(path.join(dir, name))).size;
      files++;
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return { files, sizeBytes };
}
