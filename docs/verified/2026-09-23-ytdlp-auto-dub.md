# yt-dlp and YouTube AI auto-dubbed videos (verified 2026-09-23)

Pinned to **yt-dlp 2026.08.19** (tag commit `3a08beaf031ab68f966401ead017ac81fe8486cf`),
the version in the image. Read at the tag via
`https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/<path>`; the only later change to
`_video.py` (c7fb478, 2026-09-16) is a one-line edit that moves no lines.
Extends `2026-09-22-transcript-backends.md` A3.4/A3.5. Used by `src/transcripts/select.ts`.

## From the code

1. **Top-level `language` = the selected audio format's language.** `YoutubeDL.py`
   L3103 takes `best_format = formats_to_download[-1]`, L3155 does
   `info_dict.update(best_format)`; merged formats join the non-empty languages
   (L2491, L2499), i.e. the audio track's. Format selection also runs for `-J`.
2. **The "original" audio track wins the default sort.** `_video.py`
   `get_language_code_and_preference` (L3276–3290): code = `audioTrack.id.split('.')[0]`
   (hence `en-US`), `'original' in displayName` → preference 10 (L3229), `audioIsDefault`
   → 5 (L3230), else -1; stored as `language` / `language_preference` (L3471–3472).
   `utils/_utils.py` default sort (L5358) has `lang` (→ `language_preference`, L5390)
   ahead of quality. So on a dubbed video `language` is the original's, unless `-f`/`-S`
   are customised (the service passes neither).
3. **Without multiple audio tracks** `language` comes from the caption fallback
   `set_audio_lang_from_orig_subs_lang` (L4220–4223) and can be None (no ASR track, PO-token
   dropped captions, non-translatable ASR track).
4. **One `<lang>-orig` key per ASR track.** In the caption loop (L4259–4327) every ASR
   track matching a translation language adds `f'{trans_code}-orig'` with its unchanged
   `baseUrl` (L4301–4308); the fallback adds `{lang}-orig` for translatable tracks
   (L4314–4327). yt-dlp has no notion of dubs, `variant` or "timing-optimized" (no
   matches under `yt_dlp/extractor/youtube/`); the parameter just passes through in
   `baseUrl` (`process_language`, L4206–4218, only adds `fmt`/`xosf`/`tlang`).
5. **Plain keys mix tracks**: `automatic_captions['en']` holds the untranslated entry of
   the track whose language is `en` plus `tlang=en` translations of every other ASR track,
   in `captionTracks` order (L4310–4312). The first entry is not necessarily the original.
6. Upstream: issue #17659 (2026-09-09, closed "not planned" 2026-09-17) reports
   `-orig` matching auto-dubbed languages; no fix. #17596 suggests `format_note*=original`
   for dubbed audio.

## Field observations (not backed by yt-dlp code; YouTube behaviour)

7. `U6KChi90nHs` (2026-09-23): 15 audio tracks, `language: en-US`, format note
   "English (US) original (default)", 15 `-orig` keys; the `en` ASR URL has no `variant`,
   all 14 dub ASR URLs carry `variant=timing-optimized`. Fixture:
   `test/fixtures/info/U6KChi90nHs.json` (scrubbed).
8. Normal videos (probe 2026-09-23, same yt-dlp): `lXUZvyajciY` `language=en`,
   `['en-orig']`; `fW4SwcMQYdA` `language=de-DE`, `['de-orig']`; `Me-kZi4xkEs`
   `language=en`, `['en-orig']`. No caption URL of any of them has a `variant`.

## Consequence for the selector

Original language = region-stripped `language` when it names an `-orig` key (1, 2); else
the `-orig` key without `variant` (7, 8); tracks with `variant` are never served; within
a plain key the untranslated, variant-free entry is picked, never "the first" (5).
