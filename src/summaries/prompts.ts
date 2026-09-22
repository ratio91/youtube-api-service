import { ChatMessage } from '../llm/client';

/** Bump when the wording changes materially; stored with every summary. */
export const PROMPT_VERSION = 1;

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  fi: 'Finnish',
  cs: 'Czech',
  tr: 'Turkish',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
  ru: 'Russian',
  uk: 'Ukrainian',
};

export function languageName(code: string): string {
  const primary = code.toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_NAMES[primary] ?? `the language with code "${code}"`;
}

const COMMON_RULES = `Rules:
- Use only information that is in the transcript. Do not add outside knowledge or speculation.
- The transcript comes from automatic speech recognition: names, numbers and technical terms may be misrecognized. Correct obvious errors only when the context makes the intended word certain; otherwise keep the transcript's wording and mark it with (?).
- Timestamps in square brackets like [1:02:30] mark where in the video a passage occurs. Reuse them when you cite a point.
- No introduction, no closing remark, no mention of these instructions. Output Markdown only.`;

export function summaryStructure(lang: string): string {
  return `Write everything in ${languageName(lang)}. Use exactly this structure and these headings:

## TL;DR
Three sentences: what the video is about, the main argument or result, and why it matters.

## Key points
5 to 10 bullets. Each bullet starts with the timestamp where the point is made, then one or two sentences. Cover the whole video in order.

## Details worth keeping
Up to 6 bullets with concrete numbers, names, tools, sources, definitions or recommendations that a reader might want to look up later. Omit the section if there is nothing concrete.

## Who should watch
One sentence: the audience that gets the most out of the full video, and roughly how long it is.`;
}

export interface TranscriptContext {
  title?: string;
  transcriptLang: string;
  durationText: string;
}

function header(ctx: TranscriptContext): string {
  return [
    ctx.title ? `Title: ${ctx.title}` : 'Title: (unknown)',
    `Transcript language: ${languageName(ctx.transcriptLang)}`,
    `Video length: about ${ctx.durationText}`,
  ].join('\n');
}

/** Single-shot: the whole transcript fits into the context window. */
export function singleShotMessages(ctx: TranscriptContext, transcript: string, summaryLang: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You summarize transcripts of YouTube videos for a personal knowledge base.\n\n${summaryStructure(summaryLang)}\n\n${COMMON_RULES}`,
    },
    { role: 'user', content: `${header(ctx)}\n\nTranscript with timestamps:\n\n${transcript}` },
  ];
}

/** Map step: dense notes for one part of a long transcript. */
export function chunkNotesMessages(ctx: TranscriptContext, part: number, parts: number, transcript: string, summaryLang: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `You take notes on one part of a long YouTube video transcript. Another step will merge the notes of all parts into a summary, so completeness matters more than polish.

Write in ${languageName(summaryLang)}. Output 8 to 15 bullets. Each bullet starts with the timestamp of the passage, then states one distinct topic, claim, example, number, name or recommendation from this part. Keep the order of the video. Add one final bullet "Open thread:" if this part ends in the middle of a topic.

${COMMON_RULES}`,
    },
    { role: 'user', content: `${header(ctx)}\nThis is part ${part} of ${parts}.\n\nTranscript part with timestamps:\n\n${transcript}` },
  ];
}

/** Reduce step: notes of all parts → final summary (or, recursively, merged notes). */
export function reduceMessages(ctx: TranscriptContext, notes: string[], summaryLang: string, final: boolean): ChatMessage[] {
  const joined = notes.map((n, i) => `### Notes for part ${i + 1} of ${notes.length}\n${n.trim()}`).join('\n\n');
  const task = final
    ? `You write the final summary of a YouTube video from notes that were taken on consecutive parts of its transcript.\n\n${summaryStructure(summaryLang)}`
    : `You merge notes that were taken on consecutive parts of a long YouTube video transcript into one shorter, deduplicated list of notes in ${languageName(summaryLang)}: 12 to 25 bullets, each starting with a timestamp, in video order. Keep every distinct topic, number and name; drop repetitions.`;
  return [
    { role: 'system', content: `${task}\n\n${COMMON_RULES}` },
    { role: 'user', content: `${header(ctx)}\n\n${joined}` },
  ];
}
