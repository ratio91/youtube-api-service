import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseJson3, toPlainText, normalizeCaptionText } from '../src/transcripts/json3';
import { TranscriptError } from '../src/transcripts/errors';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'json3', name), 'utf8');

describe('parseJson3 (fixtures captured from YouTube on 2026-09-22)', () => {
  it('manual track: one entry per event, ms passthrough, newlines collapsed', () => {
    const raw = fixture('manual-en.json');
    const events = JSON.parse(raw).events;
    const entries = parseJson3(raw, 'en');
    expect(entries).toHaveLength(events.length);
    expect(entries[0]).toEqual({
      text: "Today I'm speaking with Andrej Karpathy. Andrej, why do you say that this will be",
      offset: 48560,
      duration: 4400,
      lang: 'en',
    });
    for (const e of entries) {
      expect(e.text).not.toMatch(/\n|\s{2,}/);
      expect(Number.isInteger(e.offset)).toBe(true);
      expect(e.duration).toBeGreaterThan(0);
    }
  });

  it('auto track: drops the window header and aAppend newline events, keeps each phrase once', () => {
    const raw = fixture('auto-en.json');
    const events: any[] = JSON.parse(raw).events;
    const contentEvents = events.filter((e) => e.segs && !e.aAppend);
    const entries = parseJson3(raw, 'en');
    expect(events.some((e) => !e.segs)).toBe(true); // header present in fixture
    expect(events.some((e) => e.aAppend === 1)).toBe(true); // rolling markers present in fixture
    expect(entries).toHaveLength(contentEvents.length);
    expect(entries[0]).toEqual({ text: 'reinforcement learning is terrible.', offset: 0, duration: 4240, lang: 'en' });
    expect(entries.every((e) => e.text.length > 0)).toBe(true);
    // no two consecutive entries carry the same text (no rolling duplication)
    for (let i = 1; i < entries.length; i++) expect(entries[i].text).not.toBe(entries[i - 1].text);
    // offsets are monotonically non-decreasing
    for (let i = 1; i < entries.length; i++) expect(entries[i].offset).toBeGreaterThanOrEqual(entries[i - 1].offset);
  });

  it('German auto track keeps umlauts and word spacing', () => {
    const entries = parseJson3(fixture('auto-de.json'), 'de');
    expect(entries[0].text).toBe('einen wunderschönen guten Abend. Wir');
    expect(entries[0].lang).toBe('de');
  });

  it('tolerates events without dDurationMs and rounds fractional times', () => {
    const raw = JSON.stringify({ events: [{ tStartMs: 10.6, segs: [{ utf8: 'a' }] }, { tStartMs: 20, dDurationMs: 5.4, segs: [{ utf8: 'b' }] }] });
    expect(parseJson3(raw, 'en')).toEqual([
      { text: 'a', offset: 11, duration: 0, lang: 'en' },
      { text: 'b', offset: 20, duration: 5, lang: 'en' },
    ]);
  });

  it('throws BACKEND_FAILURE on non-JSON or schema mismatch', () => {
    expect(() => parseJson3('<html>', 'en')).toThrowError(TranscriptError);
    expect(() => parseJson3('<html>', 'en')).toThrow(/not valid JSON/);
    expect(() => parseJson3(JSON.stringify({ events: [{ segs: [] }] }), 'en')).toThrow(/json3 schema/);
    try {
      parseJson3('nope', 'en');
    } catch (e) {
      expect((e as TranscriptError).code).toBe('BACKEND_FAILURE');
      expect((e as TranscriptError).httpStatus).toBe(500);
    }
  });
});

describe('toPlainText', () => {
  it('joins entries into flowing text and drops sound tags and profanity placeholders', () => {
    const text = toPlainText([
      { text: '[Music]', offset: 0, duration: 1, lang: 'en' },
      { text: 'Hello there,', offset: 1, duration: 1, lang: 'en' },
      { text: 'this is [ __ ] great', offset: 2, duration: 1, lang: 'en' },
      { text: '[Applaus]', offset: 3, duration: 1, lang: 'de' },
      { text: 'bye.', offset: 4, duration: 1, lang: 'en' },
    ]);
    expect(text).toBe('Hello there, this is great bye.');
  });

  it('produces readable text from the auto fixture with no duplicated rolling lines', () => {
    const entries = parseJson3(fixture('auto-en.json'), 'en');
    const text = toPlainText(entries);
    expect(text.startsWith('reinforcement learning is terrible. It just so happens that everything that')).toBe(true);
    expect(text).not.toMatch(/\n/);
    expect(text).not.toMatch(/\s{2,}/);
  });

  it('normalizeCaptionText collapses whitespace', () => {
    expect(normalizeCaptionText('  a \n b\t\tc  ')).toBe('a b c');
  });
});
