import { describe, expect, it } from 'vitest';
import type { RichTextInterface } from '@remnote/plugin-sdk';
import { ATOMIC_CH } from '../src/engine/motions';
import {
  diffCaret,
  findSearchMatch,
  flattenRich,
  sanitizeInsert,
  SearchUnit,
  settleRead,
} from '../src/adapter/pure';

// The adapter's pure data math: the rich-text → model-space flatten (the
// offset-space contract with RemNote, probed live 2026-07-08), the insert
// sanitizer, insert-exit caret diffing, and the lag-tolerant settle read.

describe('flattenRich (model-space flatten)', () => {
  it('plain string segments pass through', () => {
    expect(flattenRich(['hello'])).toBe('hello');
    expect(flattenRich(['a', 'b'])).toBe('ab');
  });

  it('formatted text runs keep their characters', () => {
    expect(flattenRich([{ i: 'm', text: 'bold', b: true } as never])).toBe('bold');
    expect(
      flattenRich(['see ', { i: 'm', text: 'it', b: true, u: true } as never, ' end'])
    ).toBe('see it end');
  });

  it('a rem reference becomes ONE atomic placeholder (2 units), not its name', () => {
    const rich = ['see ', { i: 'q', _id: 'xyz' } as never, ' end'];
    const flat = flattenRich(rich as RichTextInterface);
    expect(flat).toBe(`see ${ATOMIC_CH} end`);
    // the invariant that matters: length matches RemNote's offset space
    expect(flat.length).toBe(10);
  });

  it('images, LaTeX and unknown elements are atomic too', () => {
    expect(flattenRich([{ i: 'i', url: 'u' } as never])).toBe(ATOMIC_CH);
    expect(flattenRich([{ i: 'x', text: 'x^2' } as never])).toBe(ATOMIC_CH);
    expect(flattenRich([{ i: 'a', url: 'u' } as never])).toBe(ATOMIC_CH);
    expect(flattenRich([{ i: 'g', _id: null } as never])).toBe(ATOMIC_CH);
  });

  it('LaTeX source length does NOT leak into the flatten', () => {
    const flat = flattenRich(['a', { i: 'x', text: '\\frac{a}{b}+c' } as never, 'b']);
    expect(flat.length).toBe(4); // 1 + 2 + 1, matching richText.length live
  });

  it('emoji inside text keep their two UTF-16 units', () => {
    expect(flattenRich(['a😀b']).length).toBe(4);
  });

  it('mixed line: every element in order', () => {
    const flat = flattenRich([
      'x ',
      { i: 'm', text: 'bold' } as never,
      { i: 'q', _id: 'id1' } as never,
      ' y',
    ]);
    expect(flat).toBe(`x bold${ATOMIC_CH} y`);
  });

  it('a text element without text flattens to nothing', () => {
    expect(flattenRich([{ i: 'm' } as never])).toBe('');
  });

  it('empty, null and undefined flatten to the empty string', () => {
    expect(flattenRich([])).toBe('');
    expect(flattenRich(undefined)).toBe('');
    expect(flattenRich(null)).toBe('');
  });
});

describe('sanitizeInsert', () => {
  it('passes plain text through', () => {
    expect(sanitizeInsert('hello')).toBe('hello');
    expect(sanitizeInsert('')).toBe('');
  });

  it('strips atomic placeholders', () => {
    expect(sanitizeInsert(`a${ATOMIC_CH}b`)).toBe('ab');
    expect(sanitizeInsert(`${ATOMIC_CH}${ATOMIC_CH}`)).toBe('');
  });

  it('keeps real emoji (only the placeholder is special)', () => {
    expect(sanitizeInsert('a😀b')).toBe('a😀b');
  });
});

describe('diffCaret (insert-exit caret inference)', () => {
  it('unchanged text keeps the fallback, clamped', () => {
    expect(diffCaret('abc', 'abc', 2)).toBe(2);
    expect(diffCaret('abc', 'abc', 99)).toBe(3);
    expect(diffCaret('abc', 'abc', -1)).toBe(0);
  });

  it('append at the end puts the caret after the appended text', () => {
    expect(diffCaret('abc', 'abcXY', 0)).toBe(5);
  });

  it('insert in the middle puts the caret after the insertion', () => {
    expect(diffCaret('abcd', 'abXYcd', 0)).toBe(4);
  });

  it('insert at the start', () => {
    expect(diffCaret('abc', 'Xabc', 0)).toBe(1);
  });

  it('deletion at the end lands at the new end', () => {
    expect(diffCaret('abcdef', 'abc', 0)).toBe(3);
  });

  it('deletion in the middle lands at the deletion point', () => {
    expect(diffCaret('abcdef', 'abef', 0)).toBe(2);
  });

  it('replacement lands after the replaced region', () => {
    expect(diffCaret('abcdef', 'abXYef', 0)).toBe(4);
  });

  it('everything replaced lands at the end of the new text', () => {
    expect(diffCaret('abc', 'xyz', 0)).toBe(3);
  });

  it('empty to text and text to empty', () => {
    expect(diffCaret('', 'hello', 0)).toBe(5);
    expect(diffCaret('hello', '', 3)).toBe(0);
  });

  it('ambiguous repeated chars still land inside bounds', () => {
    const caret = diffCaret('aa', 'aaa', 1);
    expect(caret).toBeGreaterThanOrEqual(0);
    expect(caret).toBeLessThanOrEqual(3);
  });
});

describe('settleRead (lag-tolerant reads)', () => {
  const eq = (a: string | null, b: string | null) => a === b;
  const noSleep = () => Promise.resolve();

  it('returns immediately once two consecutive reads agree', async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      return 'stable';
    };
    const out = await settleRead(read, eq, { sleep: noSleep });
    expect(out).toBe('stable');
    expect(calls).toBe(2); // first read + one confirmation
  });

  it('keeps reading while the value is still changing', async () => {
    const values = ['v1', 'v2', 'v3', 'v3', 'v3'];
    let i = 0;
    const read = async () => values[Math.min(i++, values.length - 1)];
    const out = await settleRead(read, eq, { sleep: noSleep });
    expect(out).toBe('v3');
  });

  it('gives up after the configured rounds and returns the latest value', async () => {
    let i = 0;
    const read = async () => `v${i++}`; // never stabilizes
    const out = await settleRead(read, eq, { rounds: 3, sleep: noSleep });
    expect(out).toBe('v3'); // 1 initial + 3 rounds
  });

  it('a null (failed) read can settle to null — callers must handle it', async () => {
    const read = async () => null;
    const out = await settleRead<string | null>(read, eq, { sleep: noSleep });
    expect(out).toBeNull();
  });

  it('stale-then-fresh: catches text arriving on the second read', async () => {
    const values = ['hell', 'hello', 'hello'];
    let i = 0;
    const read = async () => values[Math.min(i++, values.length - 1)];
    const out = await settleRead(read, eq, { sleep: noSleep });
    expect(out).toBe('hello');
  });

  it('honors the sleep injection and delay', async () => {
    const delays: number[] = [];
    const read = async () => 'x';
    await settleRead(read, eq, {
      delayMs: 25,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([25]);
  });

  it('custom equality: settles on equivalent-but-not-identical values', async () => {
    const values = [{ v: 1 }, { v: 2 }, { v: 2 }];
    let i = 0;
    const read = async () => values[Math.min(i++, values.length - 1)];
    const out = await settleRead(read, (a, b) => a.v === b.v, { sleep: noSleep });
    expect(out.v).toBe(2);
  });
});

describe('findSearchMatch (space-search whole-document matching)', () => {
  const units = (...texts: string[]): SearchUnit[] =>
    texts.map((text, i) => ({ id: `r${i}`, text }));

  it('empty pattern is rejected without touching the units', () => {
    const out = findSearchMatch(units('alpha', 'bravo'), 'r0', 0, '', 1);
    expect(out).toEqual({ ok: false, reason: 'empty' });
  });

  it('an invalid regex pattern is reported distinctly from "not found"', () => {
    const out = findSearchMatch(units('alpha'), 'r0', 0, '(unterminated', 1);
    expect(out).toEqual({ ok: false, reason: 'badPattern' });
  });

  it('no units at all → noMatch', () => {
    const out = findSearchMatch([], undefined, 0, 'x', 1);
    expect(out).toEqual({ ok: false, reason: 'noMatch' });
  });

  it('pattern present nowhere in the document → noMatch', () => {
    const out = findSearchMatch(units('alpha', 'bravo'), 'r0', 0, 'zzz', 1);
    expect(out).toEqual({ ok: false, reason: 'noMatch' });
  });

  it('forward: finds the next match in a LATER unit', () => {
    const out = findSearchMatch(units('alpha', 'bravo', 'charlie'), 'r0', 5, 'bravo', 1);
    expect(out).toEqual({ ok: true, match: { id: 'r1', start: 0, end: 5 }, wrapped: false });
  });

  it('forward: a later match on the SAME unit (after fromOffset) wins over an earlier one', () => {
    // "foo bar foo" — starting at offset 2 (inside the first "foo"), the
    // next hit must be the SECOND "foo" (offset 8), not the one already
    // standing on.
    const out = findSearchMatch(units('foo bar foo'), 'r0', 2, 'foo', 1);
    expect(out).toEqual({ ok: true, match: { id: 'r0', start: 8, end: 11 }, wrapped: false });
  });

  it('forward: never re-reports a match starting exactly at fromOffset — always progresses', () => {
    const out = findSearchMatch(units('foo bar foo'), 'r0', 0, 'foo', 1);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.match.start).toBe(8); // skips the offset-0 match itself
  });

  it('forward: wraps to the top when nothing remains after the current position', () => {
    const out = findSearchMatch(units('foo', 'middle', 'end'), 'r2', 0, 'foo', 1);
    expect(out).toEqual({ ok: true, match: { id: 'r0', start: 0, end: 3 }, wrapped: true });
  });

  it('backward: finds the previous match in an EARLIER unit', () => {
    const out = findSearchMatch(units('alpha', 'bravo', 'charlie'), 'r2', 0, 'alpha', -1);
    expect(out).toEqual({ ok: true, match: { id: 'r0', start: 0, end: 5 }, wrapped: false });
  });

  it('backward: the NEAREST earlier match on the SAME unit wins, not the first one in the document', () => {
    // "foo bar foo" from just past the SECOND foo (offset 11): the nearest
    // preceding match is that same second "foo" (start 8), not the first
    // one at offset 0.
    const out = findSearchMatch(units('foo bar foo'), 'r0', 11, 'foo', -1);
    expect(out).toEqual({ ok: true, match: { id: 'r0', start: 8, end: 11 }, wrapped: false });
  });

  it('backward: wraps to the bottom when nothing precedes the current position', () => {
    const out = findSearchMatch(units('start', 'middle', 'foo'), 'r0', 0, 'foo', -1);
    expect(out).toEqual({ ok: true, match: { id: 'r2', start: 0, end: 3 }, wrapped: true });
  });

  it('an unrecognized fromId (e.g. focused Rem outside the document) starts from the top', () => {
    const out = findSearchMatch(units('foo', 'bar'), 'not-in-doc', 0, 'foo', 1);
    expect(out).toEqual({ ok: true, match: { id: 'r0', start: 0, end: 3 }, wrapped: false });
  });

  it('pattern is a real regex, not just a literal substring', () => {
    const out = findSearchMatch(units('no numbers here', 'value 42 units'), 'r0', 0, '\\d+', 1);
    expect(out).toEqual({ ok: true, match: { id: 'r1', start: 6, end: 8 }, wrapped: false });
  });

  it('matching is case-SENSITIVE (consistent with :g/:s\'s own new RegExp(pat) convention)', () => {
    const out = findSearchMatch(units('Alpha'), 'r0', 0, 'alpha', 1);
    expect(out).toEqual({ ok: false, reason: 'noMatch' });
  });

  it('a single match, searched from its own start, wraps back onto itself in both directions', () => {
    const fwd = findSearchMatch(units('only'), 'r0', 0, 'only', 1);
    expect(fwd).toEqual({ ok: true, match: { id: 'r0', start: 0, end: 4 }, wrapped: true });
    const back = findSearchMatch(units('only'), 'r0', 0, 'only', -1);
    expect(back).toEqual({ ok: true, match: { id: 'r0', start: 0, end: 4 }, wrapped: true });
  });

  it('backward from just PAST the only match finds it again without wrapping', () => {
    // Standing right after the match (offset 4, one past "only"), the
    // previous match IS that same one — no wrap needed.
    const out = findSearchMatch(units('only'), 'r0', 4, 'only', -1);
    expect(out).toEqual({ ok: true, match: { id: 'r0', start: 0, end: 4 }, wrapped: false });
  });

  it('a zero-width-capable pattern does not hang (bounded scan, not an infinite loop)', () => {
    const out = findSearchMatch(units('aaa', 'bbb'), 'r0', 0, 'a*', 1);
    expect(out.ok).toBe(true); // just needs to terminate with SOME answer
  });
});
