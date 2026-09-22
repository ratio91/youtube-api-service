import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TranscriptCache, TrackRecord } from '../src/transcripts/cache';

let dir: string;
let t = 1_000_000;
const now = () => t;
const DAY = 86_400_000;

const rec = (over: Partial<TrackRecord> = {}): TrackRecord => ({
  version: 1,
  videoId: 'lXUZvyajciY',
  lang: 'en',
  kind: 'manual',
  fetchedAt: new Date(now()).toISOString(),
  backend: 'yt-dlp',
  backendVersion: '2026.08.19',
  segments: [{ text: 'hello', offset: 0, duration: 1000 }, { text: 'world', offset: 1000, duration: 900 }],
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytcache-'));
  t = 1_000_000;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeCache(extra: Partial<ConstructorParameters<typeof TranscriptCache>[0]> = {}) {
  return new TranscriptCache({ dir, noCaptionsTtlMs: 7 * DAY, now, memoMs: 60_000, ...extra });
}

describe('TranscriptCache: files and atomic writes', () => {
  it('init creates the directory and reports writable', async () => {
    const c = new TranscriptCache({ dir: path.join(dir, 'nested', 'deeper'), noCaptionsTtlMs: DAY, now });
    await c.init();
    expect(c.isWritable()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'nested', 'deeper'))).toBe(true);
  });

  it('writes <videoId>.<lang>.json with the documented shape and leaves no temp file', async () => {
    const c = makeCache();
    expect(await c.putTrack(rec())).toBe(true);
    const files = fs.readdirSync(dir);
    expect(files).toEqual(['lXUZvyajciY.en.json']);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(onDisk).toMatchObject({ version: 1, videoId: 'lXUZvyajciY', lang: 'en', kind: 'manual', backend: 'yt-dlp', backendVersion: '2026.08.19' });
    expect(onDisk.segments[0]).toEqual({ text: 'hello', offset: 0, duration: 1000 });
    expect(onDisk.segments[0].lang).toBeUndefined();
  });

  it('refuses to write an invalid record', async () => {
    const c = makeCache();
    expect(await c.putTrack({ ...rec(), videoId: 'bad id' } as TrackRecord)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('reports unwritable directories without throwing', async () => {
    const file = path.join(dir, 'a-file-not-a-dir');
    fs.writeFileSync(file, 'x');
    const c = new TranscriptCache({ dir: file, noCaptionsTtlMs: DAY, now });
    await c.init();
    expect(c.isWritable()).toBe(false);
    expect(await c.putTrack(rec())).toBe(false);
    expect(await c.get('lXUZvyajciY')).toBeNull();
    expect((await c.stats()).error).toBeTruthy();
  });
});

describe('TranscriptCache: lookups', () => {
  it('exact language hit, primary-subtag hit, and miss', async () => {
    const c = makeCache();
    await c.putTrack(rec({ lang: 'de-DE', kind: 'auto' }));
    expect((await c.get('lXUZvyajciY', 'de-DE'))?.type).toBe('track');
    const sub = await c.get('lXUZvyajciY', 'de');
    expect(sub?.type).toBe('track');
    expect(sub && sub.type === 'track' ? sub.record.lang : null).toBe('de-DE');
    expect(await c.get('lXUZvyajciY', 'fr')).toBeNull();
    expect(await c.get('fW4SwcMQYdA')).toBeNull();
  });

  it('default lookup prefers the track written by a default request, then manual over auto', async () => {
    const c = makeCache();
    await c.putTrack(rec({ lang: 'es', kind: 'manual', fetchedAt: new Date(now()).toISOString() }));
    t += 1000;
    await c.putTrack(rec({ lang: 'en', kind: 'auto', default: true, fetchedAt: new Date(now()).toISOString() }));
    const hit = await c.get('lXUZvyajciY');
    expect(hit?.type === 'track' && hit.record.lang).toBe('en'); // default flag wins over manual

    const c2 = makeCache({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'ytcache2-')) });
    await c2.putTrack(rec({ lang: 'en', kind: 'auto' }));
    await c2.putTrack(rec({ lang: 'es', kind: 'manual' }));
    const hit2 = await c2.get('lXUZvyajciY');
    expect(hit2?.type === 'track' && hit2.record.lang).toBe('es'); // no default flag → manual wins
    fs.rmSync(c2.dir, { recursive: true, force: true });
  });

  it('corrupt or schema-invalid files are a miss, not an error', async () => {
    const c = makeCache();
    fs.writeFileSync(path.join(dir, 'lXUZvyajciY.en.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'lXUZvyajciY.de.json'), JSON.stringify({ version: 2, nope: true }));
    expect(await c.get('lXUZvyajciY')).toBeNull();
    expect(await c.get('lXUZvyajciY', 'en')).toBeNull();
    // and a fresh write overwrites the corrupt file
    expect(await c.putTrack(rec())).toBe(true);
    expect((await c.get('lXUZvyajciY', 'en'))?.type).toBe('track');
  });

  it('ignores files that do not follow the naming scheme', async () => {
    const c = makeCache();
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(dir, '.lXUZvyajciY.en.json.tmp-1-abcd'), '{}');
    expect(await c.list()).toEqual([]);
    expect((await c.stats()).files).toBe(0);
  });
});

describe('TranscriptCache: no-captions marker with TTL', () => {
  it('stores <videoId>.none.json, serves it until expiry, then deletes it', async () => {
    const c = makeCache({ noCaptionsTtlMs: 2 * DAY });
    expect(await c.putNone('ScMzIvxBSi4', 'no tracks', 'yt-dlp', '2026.08.19')).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['ScMzIvxBSi4.none.json']);
    const hit = await c.get('ScMzIvxBSi4');
    expect(hit?.type).toBe('none');
    expect(hit?.type === 'none' && hit.record.reason).toBe('no tracks');
    // a language-specific request is also answered from the marker
    expect((await c.get('ScMzIvxBSi4', 'en'))?.type).toBe('none');
    t += 2 * DAY + 1;
    expect(await c.get('ScMzIvxBSi4')).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a later successful track write removes the marker', async () => {
    const c = makeCache();
    await c.putNone('lXUZvyajciY', 'no tracks', 'yt-dlp', null);
    await c.putTrack(rec());
    expect(fs.readdirSync(dir).sort()).toEqual(['lXUZvyajciY.en.json']);
  });

  it('a track file wins over a stale marker for the same video', async () => {
    const c = makeCache();
    await c.putTrack(rec());
    fs.writeFileSync(path.join(dir, 'lXUZvyajciY.none.json'), JSON.stringify({ version: 1, videoId: 'lXUZvyajciY', kind: 'none', fetchedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + DAY).toISOString(), reason: 'x', backend: 'yt-dlp', backendVersion: null }));
    expect((await c.get('lXUZvyajciY'))?.type).toBe('track');
  });
});

describe('TranscriptCache: list and stats', () => {
  it('lists tracks and markers newest first, memoised until the next write', async () => {
    const c = makeCache();
    await c.putTrack(rec({ fetchedAt: new Date(now()).toISOString() }));
    t += 5000;
    await c.putNone('ScMzIvxBSi4', 'no tracks', 'yt-dlp', '2026.08.19');
    const list = await c.list();
    expect(list.map((e) => [e.videoId, e.lang, e.kind])).toEqual([
      ['ScMzIvxBSi4', null, 'none'],
      ['lXUZvyajciY', 'en', 'manual'],
    ]);
    expect(list[0].expiresAt).toBeTruthy();
    // memo: a file dropped behind the cache's back is not seen until the memo expires…
    fs.unlinkSync(path.join(dir, 'ScMzIvxBSi4.none.json'));
    expect((await c.list()).length).toBe(2);
    t += 61_000;
    expect((await c.list()).length).toBe(1);
    // …but a write through the cache invalidates the memo immediately
    await c.putTrack(rec({ lang: 'de' }));
    expect((await c.list()).length).toBe(2);
  });

  it('stats count files and bytes', async () => {
    const c = makeCache();
    await c.init();
    await c.putTrack(rec());
    const s = await c.stats();
    expect(s).toMatchObject({ dir, files: 1, writable: true });
    expect(s.sizeBytes).toBe(fs.statSync(path.join(dir, 'lXUZvyajciY.en.json')).size);
    expect(s.error).toBeUndefined();
  });
});
