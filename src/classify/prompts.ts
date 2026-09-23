import { createHash } from 'crypto';
import { ChatMessage } from '../llm/client';

/** Bump when the wording or the answer schema changes; part of the cache key. */
export const CLASSIFY_PROMPT_VERSION = 1;
export const NONE = 'none';
export const REASON_MAX = 200;
/** Cap on the summary excerpt the model sees (TL;DR + key points are ~1–2k chars). */
const SUMMARY_EXCERPT_MAX = 4000;

export interface Playlist {
  playlistId: string;
  name: string;
  description: string;
}

export interface VideoContext {
  title?: string;
  channel?: string;
  /** summary Markdown as stored by /summary */
  summaryMarkdown: string;
}

/** Stable across request order: hash of the sorted playlistId + name + description. */
export function taxonomyHash(playlists: Playlist[]): string {
  const canonical = [...playlists]
    .sort((a, b) => a.playlistId.localeCompare(b.playlistId))
    .map((p) => [p.playlistId, p.name, p.description]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

/**
 * The first two `##` sections of a summary (TL;DR and key points). Taken by position,
 * not heading text, because summaries in other languages may translate the headings.
 * Timestamps are dropped: they carry no topic information.
 */
export function summaryExcerpt(markdown: string): string {
  const sections = markdown.split(/^(?=## )/m).filter((s) => s.startsWith('## '));
  const picked = (sections.length ? sections.slice(0, 2) : [markdown]).join('\n').trim();
  return picked.replace(/\[\d{1,2}(?::\d{2}){1,2}\]\s*/g, '').slice(0, SUMMARY_EXCERPT_MAX);
}

/**
 * JSON schema for the answer. The model picks playlist *names* (meaningful tokens)
 * rather than opaque IDs; the classifier maps names back to IDs. `reason` comes first
 * so the model states its grounds before committing to a choice.
 */
export function answerSchema(playlists: Playlist[]): Record<string, unknown> {
  const choices = [...playlists.map((p) => p.name), NONE];
  return {
    type: 'object',
    properties: {
      reason: { type: 'string', maxLength: REASON_MAX },
      playlist: { type: 'string', enum: choices },
      runnerUp: { type: 'string', enum: choices },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['reason', 'playlist', 'runnerUp', 'confidence'],
    additionalProperties: false,
  };
}

const RULES = `You sort YouTube videos into the owner's topic playlists.

Rules:
- Each playlist description is a binding rule. Where it says "Not: … (-> other playlist)", a video on that topic belongs to the other playlist; when two playlists fit, follow these redirects.
- Decide by the video's main topic, not by its format (talk, podcast, interview, lecture) or by who is speaking.
- Pick exactly one playlist, or "none" if nothing fits clearly. Forcing a weak match is worse than "none". Music, DJ sets, entertainment and vlogs are always "none".
- runnerUp is the second-best playlist, or "none" if no other playlist is plausible.
- confidence: "high" if the main topic is squarely covered by one description, "medium" if another playlist is also plausible, "low" if the fit is weak.
- reason: one short English sentence naming the main topic and the rule that decided it.
- Answer with one JSON object with exactly these keys, in this order: "reason", "playlist" (a playlist name exactly as listed, or "none"), "runnerUp" (same choices), "confidence".`;

export function classifyMessages(playlists: Playlist[], video: VideoContext): ChatMessage[] {
  const list = playlists.map((p) => `- ${p.name}: ${p.description || '(no description)'}`).join('\n');
  const user = [
    'Playlists:',
    list,
    '',
    `Title: ${video.title ?? '(unknown)'}`,
    `Channel: ${video.channel ?? '(unknown)'}`,
    '',
    'Summary of the video:',
    summaryExcerpt(video.summaryMarkdown),
  ].join('\n');
  return [
    { role: 'system', content: RULES },
    { role: 'user', content: user },
  ];
}
