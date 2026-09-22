import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { captionInfoSchema, listTracks, selectTrack, requestHeaders, primarySubtag, CaptionInfo } from '../src/transcripts/select';
import { TranscriptError } from '../src/transcripts/errors';

const info = (name: string): CaptionInfo =>
  captionInfoSchema.parse(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'info', `${name}.json`), 'utf8')));

const EN_VIDEO = 'lXUZvyajciY'; // manual en+es, auto en (orig)
const DE_VIDEO = 'fW4SwcMQYdA'; // no manual, auto de (orig), language "de-DE"
const PROM_VIDEO = 'Me-kZi4xkEs'; // no manual, auto en (orig)

function expectErr(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TranscriptError);
    expect((e as TranscriptError).code).toBe(code);
    return e as TranscriptError;
  }
  throw new Error(`expected ${code}`);
}

describe('listTracks', () => {
  it('separates manual from auto, ignores auto-translations (tlang) and the -orig alias', () => {
    const t = listTracks(info(EN_VIDEO));
    expect([...t.manual.keys()]).toEqual(['en', 'es']);
    expect([...t.auto.keys()]).toEqual(['en']); // fixture also has de/es translations → dropped
    expect(t.origLang).toBe('en');
    expect(new URL(t.auto.get('en')!.url).searchParams.has('tlang')).toBe(false);
    expect(t.auto.get('en')!.url).toContain('fmt=json3');
  });

  it('derives the original language from -orig even when `language` carries a region', () => {
    const t = listTracks(info(DE_VIDEO));
    expect(t.manual.size).toBe(0);
    expect([...t.auto.keys()]).toEqual(['de']);
    expect(t.origLang).toBe('de');
  });

  it('falls back to the top-level language when no -orig key exists', () => {
    const t = listTracks(captionInfoSchema.parse({ language: 'de-DE', subtitles: { de: [{ ext: 'json3', url: 'https://x/y?fmt=json3' }] }, automatic_captions: {} }));
    expect(t.origLang).toBe('de');
  });
});

describe('selectTrack default order', () => {
  it('prefers a manual track in the video language', () => {
    const t = selectTrack(info(EN_VIDEO));
    expect(t).toMatchObject({ lang: 'en', kind: 'manual', name: 'English' });
  });

  it('falls back to the original-language auto track', () => {
    expect(selectTrack(info(DE_VIDEO))).toMatchObject({ lang: 'de', kind: 'auto' });
    expect(selectTrack(info(PROM_VIDEO))).toMatchObject({ lang: 'en', kind: 'auto' });
  });

  it('falls back to any manual track (en, de preferred) when the original language has none', () => {
    const only = captionInfoSchema.parse({
      automatic_captions: { 'fr-orig': [{ ext: 'json3', url: 'https://x/fr?fmt=json3' }], fr: [{ ext: 'json3', url: 'https://x/fr?fmt=json3' }] },
      subtitles: { ja: [{ ext: 'json3', url: 'https://x/ja?fmt=json3' }], de: [{ ext: 'json3', url: 'https://x/de?fmt=json3' }] },
    });
    // original language fr has an auto track → that wins over foreign manual tracks
    expect(selectTrack(only)).toMatchObject({ lang: 'fr', kind: 'auto' });
    const noOrig = captionInfoSchema.parse({ automatic_captions: {}, subtitles: { ja: [{ ext: 'json3', url: 'https://x/ja?fmt=json3' }], de: [{ ext: 'json3', url: 'https://x/de?fmt=json3' }] } });
    expect(selectTrack(noOrig)).toMatchObject({ lang: 'de', kind: 'manual' });
  });

  it('throws NO_CAPTIONS when neither dict has a track', () => {
    const err = expectErr(() => selectTrack(info('no-captions')), 'NO_CAPTIONS');
    expect(err.httpStatus).toBe(404);
    expect(err.retryable).toBe(false);
  });

  it('ignores entries that only offer non-json3 formats', () => {
    const vttOnly = captionInfoSchema.parse({ subtitles: { en: [{ ext: 'vtt', url: 'https://x/en?fmt=vtt' }] }, automatic_captions: {} });
    expectErr(() => selectTrack(vttOnly), 'NO_CAPTIONS');
  });
});

describe('selectTrack with ?lang=', () => {
  it('returns the manual track for an exact match', () => {
    expect(selectTrack(info(EN_VIDEO), 'es')).toMatchObject({ lang: 'es', kind: 'manual' });
  });

  it('matches on the primary subtag in both directions', () => {
    expect(selectTrack(info(EN_VIDEO), 'en-US')).toMatchObject({ lang: 'en', kind: 'manual' });
    expect(selectTrack(info(DE_VIDEO), 'DE')).toMatchObject({ lang: 'de', kind: 'auto' });
    const regional = captionInfoSchema.parse({ subtitles: { 'pt-BR': [{ ext: 'json3', url: 'https://x/pt?fmt=json3' }] }, automatic_captions: {} });
    expect(selectTrack(regional, 'pt')).toMatchObject({ lang: 'pt-BR', kind: 'manual' });
  });

  it('never serves an auto-translation; reports what exists instead', () => {
    const err = expectErr(() => selectTrack(info(EN_VIDEO), 'de'), 'LANG_UNAVAILABLE');
    expect(err.httpStatus).toBe(404);
    expect(err.availableLanguages).toEqual({ manual: ['en', 'es'], auto: ['en'] });
    expect(err.toJSON()).toMatchObject({ available: false, availableLanguages: { manual: ['en', 'es'], auto: ['en'] } });
  });

  it('still reports NO_CAPTIONS (not LANG_UNAVAILABLE) when the video has no tracks at all', () => {
    expectErr(() => selectTrack(info('no-captions'), 'en'), 'NO_CAPTIONS');
  });
});

describe('requestHeaders / primarySubtag', () => {
  it('uses the User-Agent yt-dlp recorded on the formats', () => {
    const h = requestHeaders(info(EN_VIDEO));
    expect(h['User-Agent']).toMatch(/^Mozilla\/5\.0 .*Chrome\//);
    expect(h['Accept-Language']).toBe('en-us,en;q=0.5');
  });

  it('falls back to a browser UA when formats carry none', () => {
    expect(requestHeaders(captionInfoSchema.parse({ subtitles: {}, automatic_captions: {} }))['User-Agent']).toMatch(/Mozilla/);
  });

  it('primarySubtag lower-cases and strips region/script', () => {
    expect(primarySubtag('de-DE')).toBe('de');
    expect(primarySubtag('zh-Hans')).toBe('zh');
    expect(primarySubtag(' EN ')).toBe('en');
  });
});
