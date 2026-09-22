import { z } from 'zod';
import { TranscriptError } from './errors';

/**
 * YouTube "json3" timedtext format (verified in the field 2026-09-22, see
 * docs/decisions.md "Gate 0" and docs/verified/2026-09-22-transcript-backends.md C1).
 *
 * - manual tracks: events { tStartMs, dDurationMs, segs: [{ utf8 }] }, text contains "\n"
 * - auto (ASR) tracks: one header event without `segs` (window definition), then
 *   content events with word-level segs ({ utf8, tOffsetMs, acAsrConf }) alternating
 *   with `aAppend: 1` events whose only segment is "\n". Some aAppend events have no
 *   dDurationMs. Text is NOT repeated across json3 events; the "rolling" duplication
 *   seen in vtt/srv renderings does not exist here, so dropping aAppend events and
 *   events without segs yields each phrase exactly once.
 */
const segSchema = z.object({ utf8: z.string().optional(), tOffsetMs: z.number().optional() }).passthrough();
const eventSchema = z
  .object({
    tStartMs: z.number(),
    dDurationMs: z.number().optional(),
    aAppend: z.number().optional(),
    segs: z.array(segSchema).optional(),
  })
  .passthrough();
const json3Schema = z.object({ wireMagic: z.string().optional(), events: z.array(eventSchema).default([]) }).passthrough();

export interface TranscriptEntry {
  text: string;
  /** milliseconds */
  duration: number;
  /** milliseconds */
  offset: number;
  lang: string;
}

export function normalizeCaptionText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function parseJson3(raw: string, lang: string): TranscriptEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new TranscriptError('BACKEND_FAILURE', 'caption track is not valid JSON', { cause: err });
  }
  const parsed = json3Schema.safeParse(data);
  if (!parsed.success) {
    throw new TranscriptError('BACKEND_FAILURE', `caption track does not match json3 schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }

  const entries: TranscriptEntry[] = [];
  for (const ev of parsed.data.events) {
    if (!ev.segs || ev.aAppend) continue;
    const text = normalizeCaptionText(ev.segs.map((s) => s.utf8 ?? '').join(''));
    if (!text) continue;
    entries.push({ text, duration: Math.round(ev.dDurationMs ?? 0), offset: Math.round(ev.tStartMs), lang });
  }
  return entries;
}

// Sound tags such as "[Music]", "[Applause]", "[Musik]" and the ASR profanity
// placeholder "[ __ ]" carry nothing for an LLM summary.
const SOUND_TAG_ONLY = /^\[[^\]]{0,40}\]$/;
const PROFANITY_PLACEHOLDER = /\[\s*_+\s*\]/g;

/** One flowing plain-text string for LLM input. */
export function toPlainText(entries: TranscriptEntry[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    if (SOUND_TAG_ONLY.test(e.text)) continue;
    const cleaned = normalizeCaptionText(e.text.replace(PROFANITY_PLACEHOLDER, ' '));
    if (cleaned) parts.push(cleaned);
  }
  return parts.join(' ');
}
