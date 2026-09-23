import { z } from 'zod';
import { TranscriptError } from './errors';

/**
 * Track selection over yt-dlp's info JSON (`-J`). Field-verified 2026-09-22 against
 * yt-dlp 2026.08.19 (docs/decisions.md "Gate 0"):
 * - `subtitles[lang]` = manual tracks, `automatic_captions[lang]` = ASR tracks.
 * - yt-dlp synthesises `<lang>-orig` for the video's original ASR language.
 * - Every other `automatic_captions` key is an auto-TRANSLATION whose URL carries
 *   `tlang=`; `skip=translated_subs` does not remove them. We never serve those.
 * - Top-level `language` may carry a region ("de-DE"); match on the primary subtag.
 * - `http_headers` live per format, not top-level.
 * - AI auto-dubbed videos (field finding 2026-09-23, docs/decisions.md) carry one ASR
 *   track per dub language, and yt-dlp labels every one of them `<lang>-orig`. The dub
 *   tracks' URLs carry `variant=timing-optimized`; the real original has no `variant`
 *   and matches the top-level `language` (docs/verified/2026-09-23-ytdlp-auto-dub.md).
 */
const trackEntrySchema = z.object({ ext: z.string(), url: z.string().url(), name: z.string().optional() }).passthrough();
const trackDictSchema = z.record(z.array(trackEntrySchema)).default({});

export const captionInfoSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    channel: z.string().nullish(),
    uploader: z.string().nullish(),
    /** seconds */
    duration: z.number().nullish(),
    language: z.string().nullish(),
    subtitles: trackDictSchema,
    automatic_captions: trackDictSchema,
    formats: z.array(z.object({ http_headers: z.record(z.string()).optional() }).passthrough()).optional(),
  })
  .passthrough();

export type CaptionInfo = z.infer<typeof captionInfoSchema>;
export type TrackKind = 'manual' | 'auto';

export interface SelectedTrack {
  lang: string;
  kind: TrackKind;
  url: string;
  name?: string;
}

export interface AvailableTracks {
  manual: Map<string, SelectedTrack>;
  auto: Map<string, SelectedTrack>;
  /** primary subtag of the video's original language, if known */
  origLang?: string;
}

const CAPTION_FORMAT = 'json3';
const FALLBACK_PREFERENCE = ['en', 'de'];

export function primarySubtag(lang: string): string {
  return lang.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

function param(url: string, name: string): string | null {
  try {
    return new URL(url).searchParams.get(name);
  } catch {
    return null;
  }
}

function isTranslation(url: string): boolean {
  return param(url, 'tlang') !== null;
}

/** ASR of an AI-generated dub audio track, not of the speaker. */
function isDubTrack(url: string): boolean {
  return param(url, 'variant') !== null;
}

function json3Entries(entries: { ext: string; url: string; name?: string }[]) {
  return entries.filter((e) => e.ext === CAPTION_FORMAT && !isTranslation(e.url));
}

/**
 * Original language: the top-level `language` when it names one of the `-orig` tracks,
 * else the `-orig` track without a dub `variant`, else `language`, else the first
 * `-orig` key. Never "the last `-orig` key seen" — dubbed videos have one per dub.
 */
function originalLanguage(info: CaptionInfo): string | undefined {
  const origs = Object.entries(info.automatic_captions)
    .filter(([key]) => key.endsWith('-orig'))
    .map(([key, entries]) => ({ lang: primarySubtag(key.slice(0, -'-orig'.length)), dub: json3Entries(entries).some((e) => isDubTrack(e.url)) }));
  const declared = info.language ? primarySubtag(info.language) : undefined;
  if (declared && origs.some((o) => o.lang === declared)) return declared;
  return origs.find((o) => !o.dub)?.lang ?? declared ?? origs[0]?.lang;
}

export function listTracks(info: CaptionInfo): AvailableTracks {
  const manual = new Map<string, SelectedTrack>();
  const auto = new Map<string, SelectedTrack>();
  const origLang = originalLanguage(info);

  for (const [lang, entries] of Object.entries(info.subtitles)) {
    const e = json3Entries(entries)[0];
    if (e) manual.set(lang, { lang, kind: 'manual', url: e.url, name: e.name });
  }
  for (const [key, entries] of Object.entries(info.automatic_captions)) {
    if (key.endsWith('-orig')) continue;
    const candidates = json3Entries(entries);
    // Dub ASR is only acceptable as the original-language track (never seen, but a
    // missing original must not silently drop the video's own language).
    const e = candidates.find((c) => !isDubTrack(c.url)) ?? (primarySubtag(key) === origLang ? candidates[0] : undefined);
    if (e) auto.set(key, { lang: key, kind: 'auto', url: e.url, name: e.name });
  }
  return { manual, auto, origLang };
}

function findLang(map: Map<string, SelectedTrack>, wanted: string): SelectedTrack | undefined {
  const exact = map.get(wanted) ?? map.get(wanted.toLowerCase());
  if (exact) return exact;
  const primary = primarySubtag(wanted);
  for (const [key, track] of map) {
    if (primarySubtag(key) === primary) return track;
  }
  return undefined;
}

function firstPreferred(map: Map<string, SelectedTrack>): SelectedTrack | undefined {
  for (const pref of FALLBACK_PREFERENCE) {
    const t = findLang(map, pref);
    if (t) return t;
  }
  return map.values().next().value as SelectedTrack | undefined;
}

export function availableLanguages(tracks: AvailableTracks) {
  return { manual: [...tracks.manual.keys()], auto: [...tracks.auto.keys()] };
}

/**
 * Default order: manual in the video's language → auto in the video's language →
 * any manual (en, de, then first) → any auto. With `requestedLang`: manual → auto in
 * that language (exact code, then primary subtag), else LANG_UNAVAILABLE.
 */
export function selectTrack(info: CaptionInfo, requestedLang?: string): SelectedTrack {
  const tracks = listTracks(info);
  if (tracks.manual.size === 0 && tracks.auto.size === 0) {
    throw new TranscriptError('NO_CAPTIONS', 'video has no caption tracks (manual or auto-generated)');
  }

  if (requestedLang) {
    const hit = findLang(tracks.manual, requestedLang) ?? findLang(tracks.auto, requestedLang);
    if (hit) return hit;
    throw new TranscriptError('LANG_UNAVAILABLE', `no caption track for language "${requestedLang}"`, {
      availableLanguages: availableLanguages(tracks),
    });
  }

  if (tracks.origLang) {
    const hit = findLang(tracks.manual, tracks.origLang) ?? findLang(tracks.auto, tracks.origLang);
    if (hit) return hit;
  }
  const fallback = firstPreferred(tracks.manual) ?? firstPreferred(tracks.auto);
  if (fallback) return fallback;
  throw new TranscriptError('NO_CAPTIONS', 'video has no usable caption tracks');
}

/** User-Agent etc. that yt-dlp would send; falls back to a generic browser UA. */
export function requestHeaders(info: CaptionInfo): Record<string, string> {
  const fromFormat = info.formats?.find((f) => f.http_headers && f.http_headers['User-Agent'])?.http_headers;
  return {
    'User-Agent': fromFormat?.['User-Agent'] ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'Accept-Language': fromFormat?.['Accept-Language'] ?? 'en-us,en;q=0.5',
  };
}
