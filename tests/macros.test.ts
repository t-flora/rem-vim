/**
 * Macros with named registers: `q<reg>` records keys into register a–z,
 * `q` stops, `gq<reg>` replays (vim `@<reg>` — '@' is a shifted key RemNote's
 * shift-blind stealing can't see), `gq.` replays the last-replayed register
 * (vim `@@`), `[count]gq<reg>` repeats. Recording is engine-wide (any mode
 * whose keys reach the engine); insert-mode typed text never reaches the
 * engine (only Escape is stolen), so it is warned about, not captured —
 * the same platform limit dot-repeat lives with.
 */
import { describe, expect, it } from 'vitest';
import { Harness } from './harness';

const h = (lines: string[] | string, row = 0, caret = 0) =>
  new Harness(typeof lines === 'string' ? [lines] : lines, row, caret);

describe('recording (q)', () => {
  it('qa…q captures the keys in register a, excluding the q bookkeeping', () => {
    const e = h('hello world');
    e.keys('qadwq');
    expect(e.state.recording).toBeNull();
    expect(e.state.macros['a']).toEqual(['d', 'w']);
    expect(e.line).toBe('world'); // the recorded keys executed normally
  });

  it('the badge-visible recording state is active between q<reg> and q', () => {
    const e = h('abc');
    e.keys('qb');
    expect(e.state.recording).toEqual({ reg: 'b', keys: [] });
    expect(e.toasts.at(-1)).toContain('recording @b');
    e.keys('x');
    expect(e.state.recording?.keys).toEqual(['x']);
    e.keys('q');
    expect(e.state.recording).toBeNull();
    expect(e.toasts.at(-1)).toContain('recorded @b');
  });

  it('q followed by a non-letter cancels instead of recording', () => {
    const e = h('abc');
    e.keys('q'); // pending register name
    e.keys('<esc>');
    expect(e.state.recording).toBeNull();
    e.keys('x'); // x must act normally, not become a register name
    expect(e.line).toBe('bc');
    expect(e.state.macros).toEqual({});
  });

  it('qaq clears register a (the vim idiom)', () => {
    const e = h('abc');
    e.keys('qaxq');
    expect(e.state.macros['a']).toEqual(['x']);
    e.keys('qaq');
    expect(e.state.macros['a']).toEqual([]);
    e.keys('gqa'); // empty register: toast, no crash, no edit
    expect(e.toasts.at(-1)).toContain('@a is empty');
    expect(e.line).toBe('bc');
  });

  it('counts survive inside a recording (3x)', () => {
    const e = h('xxxhello');
    e.keys('qa3xq');
    expect(e.state.macros['a']).toEqual(['3', 'x']);
    expect(e.line).toBe('hello');
  });

  it('entering insert mode while recording warns; typed text is not captured', () => {
    const e = h(['one', 'two'], 0, 0);
    e.keys('qaidontrecordme<esc>q');
    expect(e.toasts.some((t) => t.includes('typed text is not captured'))).toBe(true);
    // the mode switch and the closing Escape ARE in the macro, the text is not
    expect(e.state.macros['a']).toEqual(['i', 'Escape']);
    expect(e.line).toBe('dontrecordmeone'); // typing itself still happened live
  });
});

describe('replay (gq)', () => {
  it('gqa replays the register on the current line', () => {
    const e = h('teh teh teh');
    e.keys('qafexpq'); // fix the first teh: onto the e, swap e/h
    expect(e.line).toBe('the teh teh');
    expect(e.state.macros['a']).toEqual(['f', 'e', 'x', 'p']);
    e.keys('gqa');
    expect(e.line).toBe('the the teh');
    e.keys('gqa');
    expect(e.line).toBe('the the the');
  });

  it('gq. replays the LAST-replayed register (vim @@)', () => {
    const e = h('teh teh teh');
    e.keys('qafexpq');
    e.keys('gqa');
    e.keys('gq.');
    expect(e.line).toBe('the the the');
  });

  it('gq. before any replay just toasts', () => {
    const e = h('abc');
    e.keys('gq.');
    expect(e.toasts.at(-1)).toContain('no macro replayed yet');
    expect(e.line).toBe('abc');
  });

  it('[count]gq<reg> repeats the macro count times', () => {
    const e = h('aaaaaa');
    e.keys('qbxq'); // macro b: delete one char
    expect(e.line).toBe('aaaaa');
    e.keys('3gqb');
    expect(e.line).toBe('aa');
  });

  it('an unknown register toasts and edits nothing', () => {
    const e = h('abc');
    e.keys('gqz');
    expect(e.toasts.at(-1)).toContain('@z is empty');
    expect(e.line).toBe('abc');
  });

  it('macros can run Ex commands recorded through the command line', () => {
    const e = h(['this is bad', 'also bad'], 0, 0);
    e.keys('qa;s/bad/good/<cr>q');
    expect(e.state.macros['a']).toEqual([';', 's', '/', 'b', 'a', 'd', '/', 'g', 'o', 'o', 'd', '/', 'Enter']);
    expect(e.lastEx).toBe('s/bad/good/');
    e.keys('j');
    e.lastEx = null;
    e.keys('gqa');
    expect(e.lastEx).toBe('s/bad/good/'); // the replay re-submitted it
  });

  it('a replayed change becomes the dot-repeat change (vim: . after @a)', () => {
    const e = h('one two three four');
    e.keys('qadwq'); // deletes "one "
    e.keys('gqa'); // deletes "two "
    expect(e.line).toBe('three four');
    e.keys('.'); // dot repeats the macro's inner dw, not nothing
    expect(e.line).toBe('four');
  });
});

describe('replay vs. recording interaction', () => {
  it('recording another macro captures the gq INVOCATION, not the expansion', () => {
    const e = h('xxxx');
    e.keys('qaxq'); // a = [x]
    e.keys('qbgqaq'); // b replays a while recording
    expect(e.state.macros['b']).toEqual(['g', 'q', 'a']);
    expect(e.line).toBe('xx'); // both the recording of a and b's replay deleted one char
    e.keys('gqb');
    expect(e.line).toBe('x');
  });

  it('a self-recursive macro terminates via the depth guard', () => {
    const e = h('abcdefghij');
    // record a = [g,q,a] (the inner replay fires against the still-empty
    // register mid-recording, so recording it is possible at all)
    e.keys('qagqaq');
    expect(e.state.macros['a']).toEqual(['g', 'q', 'a']);
    e.keys('gqa'); // must return, not loop forever
    expect(e.line).toBe('abcdefghij');
  });

  it('a replayed q cannot start a new recording', () => {
    // Build a register containing a bare 'q' directly (unreachable by
    // recording — q always means stop there — but reachable in principle
    // through hosts/mappings), then replay it.
    const e = h('abc');
    e.state = { ...e.state, macros: { z: ['q', 'a', 'x'] } };
    e.keys('gqz');
    expect(e.state.recording).toBeNull();
    expect(e.state.macros['a']).toBeUndefined();
  });
});
