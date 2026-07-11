import { describe, expect, it, vi } from 'vitest';
import type { RichTextInterface } from '@remnote/plugin-sdk';
import { initialState } from '../src/engine/engine';
import { ATOMIC_CH } from '../src/engine/motions';
import type { VimState } from '../src/engine/types';
import {
  classifyStrayEdit,
  computeJumpStep,
  cyclePaneId,
  decideRedo,
  decideUndo,
  diffCaret,
  findSearchMatch,
  flattenRich,
  isDescendantAmong,
  isEscapeWanted,
  reconcileInsertText,
  resolveInsertCaret,
  retryUntilTrue,
  sanitizeInsert,
  SearchUnit,
  settleRead,
  truncateLabel,
  walkToBoundary,
  walkToRoot,
  walkToTarget,
  wrapIndex,
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

describe('truncateLabel (wildmenu overflow guard)', () => {
  it('passes short labels through untouched', () => {
    expect(truncateLabel('short name')).toBe('short name');
    expect(truncateLabel('')).toBe('');
  });

  it('clips at exactly the boundary without adding an ellipsis', () => {
    const s = 'x'.repeat(60);
    expect(truncateLabel(s, 60)).toBe(s);
  });

  it('clips anything past max and appends an ellipsis', () => {
    const s = 'x'.repeat(61);
    const out = truncateLabel(s, 60);
    expect(out).toBe('x'.repeat(60) + '…');
  });

  it('counts code points, not UTF-16 units (an emoji is one char)', () => {
    const s = '😀'.repeat(5);
    expect(truncateLabel(s, 3)).toBe('😀😀😀…');
  });

  it('defaults to a 60-char cap', () => {
    const s = 'y'.repeat(200);
    expect(truncateLabel(s)).toBe('y'.repeat(60) + '…');
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

describe('wrapIndex (flat-order wraparound, pane focus cycling)', () => {
  it('steps forward and backward within bounds', () => {
    expect(wrapIndex(3, 0, 1)).toBe(1);
    expect(wrapIndex(3, 1, 1)).toBe(2);
    expect(wrapIndex(3, 1, -1)).toBe(0);
  });

  it('wraps past the last index back to 0', () => {
    expect(wrapIndex(3, 2, 1)).toBe(0);
  });

  it('wraps before 0 back to the last index', () => {
    expect(wrapIndex(3, 0, -1)).toBe(2);
  });

  it('a 2-pane layout just toggles', () => {
    expect(wrapIndex(2, 0, 1)).toBe(1);
    expect(wrapIndex(2, 1, 1)).toBe(0);
  });

  it('len 0 returns idx unchanged (nothing to wrap into)', () => {
    expect(wrapIndex(0, 0, 1)).toBe(0);
  });
});

describe('cyclePaneId (next/previous pane id, Ctrl-H/Ctrl-L)', () => {
  it('returns the next id with wraparound', () => {
    expect(cyclePaneId(['a', 'b', 'c'], 'a', 1)).toBe('b');
    expect(cyclePaneId(['a', 'b', 'c'], 'c', 1)).toBe('a');
  });

  it('returns the previous id with wraparound', () => {
    expect(cyclePaneId(['a', 'b', 'c'], 'a', -1)).toBe('c');
    expect(cyclePaneId(['a', 'b', 'c'], 'b', -1)).toBe('a');
  });

  it('a single pane has nothing to cycle to', () => {
    expect(cyclePaneId(['a'], 'a', 1)).toBeUndefined();
    expect(cyclePaneId([], 'a', 1)).toBeUndefined();
  });

  it('an unrecognized current id falls back to index 0 instead of throwing', () => {
    expect(cyclePaneId(['a', 'b', 'c'], 'not-a-real-id', 1)).toBe('b');
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

// Ctrl-O/Ctrl-I jumplist, Ctrl-P/Ctrl-K escape passthrough, stray shift-blind
// edit fallout, undo/redo grouping, and the cross-document Ctrl-O fallback
// (document-membership pre-check, mount-race retry) — all reasoned/fixed
// live over several rounds without a RemNote instance to test against
// directly, so the underlying decision logic was extracted here specifically
// so it doesn't regress silently. See DEVELOPMENT.md §0, rounds 1-5d.

describe('computeJumpStep (Ctrl-O / Ctrl-I jumplist)', () => {
  it('Ctrl-O with an empty list just seeds it with the live position (nowhere to jump)', () => {
    const r = computeJumpStep([], 0, -1, 'live', 'doc-live');
    expect(r.jumps).toEqual([{ id: 'live', docId: 'doc-live' }]);
    expect(r.jumpPos).toBe(0);
    expect(r.target).toBeUndefined();
  });

  it('first Ctrl-O off the live end stashes cur, then lands on the previous entry', () => {
    const jumps = [{ id: 'a', docId: 'doc-a' }];
    const r = computeJumpStep(jumps, 1, -1, 'b', 'doc-b');
    expect(r.jumps).toEqual([
      { id: 'a', docId: 'doc-a' },
      { id: 'b', docId: 'doc-b' },
    ]);
    expect(r.jumpPos).toBe(0);
    expect(r.target).toEqual({ id: 'a', docId: 'doc-a' });
  });

  it('Ctrl-I after that first Ctrl-O returns to the stashed live position', () => {
    const jumps = [
      { id: 'a', docId: 'doc-a' },
      { id: 'b', docId: 'doc-b' },
    ];
    const r = computeJumpStep(jumps, 0, 1, 'a', undefined);
    expect(r.jumpPos).toBe(1);
    expect(r.target).toEqual({ id: 'b', docId: 'doc-b' });
    expect(r.jumps).toBe(jumps); // no mutation needed on a forward hop
  });

  it('Ctrl-O when cur already equals the last recorded entry does not duplicate it', () => {
    const jumps = [{ id: 'x', docId: 'doc-x' }];
    const r = computeJumpStep(jumps, 1, -1, 'x', 'doc-x');
    expect(r.jumps).toBe(jumps); // unchanged, no push
    expect(r.jumpPos).toBe(0);
    expect(r.target).toBeUndefined(); // only entry IS cur — nowhere further back
  });

  it('backward hop while already browsing history (not at the live end)', () => {
    const jumps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const r = computeJumpStep(jumps, 2, -1, 'c', undefined);
    expect(r.jumpPos).toBe(1);
    expect(r.target).toEqual({ id: 'b' });
    expect(r.jumps).toBe(jumps);
  });

  it('forward hop while browsing history', () => {
    const jumps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const r = computeJumpStep(jumps, 0, 1, 'a', undefined);
    expect(r.jumpPos).toBe(1);
    expect(r.target).toEqual({ id: 'b' });
  });

  it('backward hop at the oldest entry is a no-op', () => {
    const jumps = [{ id: 'a' }, { id: 'b' }];
    const r = computeJumpStep(jumps, 0, -1, 'a', undefined);
    expect(r.jumpPos).toBe(0);
    expect(r.target).toBeUndefined();
    expect(r.jumps).toBe(jumps);
  });

  it('forward hop already at the newest entry is a no-op', () => {
    const jumps = [{ id: 'a' }, { id: 'b' }];
    const r = computeJumpStep(jumps, 1, 1, 'b', undefined);
    expect(r.jumpPos).toBe(1);
    expect(r.target).toBeUndefined();
  });

  it('forward hop with an empty list is a no-op (no crash on length-1 = -1)', () => {
    const r = computeJumpStep([], 0, 1, 'live', undefined);
    expect(r.target).toBeUndefined();
    expect(r.jumpPos).toBe(0);
  });

  it('the docId passed in is only ever used for the stashed live-position entry', () => {
    const jumps = [{ id: 'a', docId: 'doc-a' }];
    const r = computeJumpStep(jumps, 1, -1, 'b', 'doc-b-recorded-now');
    expect(r.jumps[1]).toEqual({ id: 'b', docId: 'doc-b-recorded-now' });
    // the entry we land ON keeps its OWN previously-recorded docId, untouched
    expect(r.target?.docId).toBe('doc-a');
  });

  it('dedup does not overwrite the existing entry’s docId with a new one', () => {
    // cur matches the last recorded entry's id, but a (hypothetically)
    // different docId is offered — the push is skipped entirely, so the
    // OLD docId survives untouched rather than being silently replaced.
    const jumps = [{ id: 'x', docId: 'doc-original' }];
    const r = computeJumpStep(jumps, 1, -1, 'x', 'doc-different');
    expect(r.jumps).toEqual([{ id: 'x', docId: 'doc-original' }]);
  });

  it('focus lost (cur undefined) with existing history still jumps back', () => {
    const jumps = [{ id: 'a', docId: 'doc-a' }];
    const r = computeJumpStep(jumps, 1, -1, undefined, undefined);
    expect(r.jumps).toBe(jumps); // nothing to stash without a cur id
    expect(r.jumpPos).toBe(0);
    expect(r.target).toEqual({ id: 'a', docId: 'doc-a' });
  });

  it('focus lost AND an empty list: no crash, no negative jumpPos, no target', () => {
    const r = computeJumpStep([], 0, -1, undefined, undefined);
    expect(r.jumps).toEqual([]);
    expect(r.jumpPos).toBe(0); // clamped, not -1
    expect(r.target).toBeUndefined();
  });

  it('a subsequent hop after the empty+no-cur case does not get permanently wedged', () => {
    // Regression guard for the -1 jumpPos wedge: once jumpPos is clamped to
    // 0 on an empty list, a later backward hop (still nothing recorded)
    // must stay a clean no-op, not throw or go further negative.
    const first = computeJumpStep([], 0, -1, undefined, undefined);
    const second = computeJumpStep(first.jumps, first.jumpPos, -1, undefined, undefined);
    expect(second.jumpPos).toBe(0);
    expect(second.target).toBeUndefined();
  });

  it('a realistic session: back, back, back, forward, forward retraces the exact path', () => {
    // Simulates gg (records 'p1'), :e (records 'p2'), a mark jump (records
    // 'p3'), then the user does Ctrl-O x3 and Ctrl-I x2 from Rem 'live'.
    let jumps: { id: string; docId?: string }[] = [
      { id: 'p1', docId: 'docA' },
      { id: 'p2', docId: 'docB' },
      { id: 'p3', docId: 'docC' },
    ];
    let pos = jumps.length; // at the live end
    let cur = 'live';

    const back = () => {
      const r = computeJumpStep(jumps, pos, -1, cur, 'doc-live');
      jumps = r.jumps;
      pos = r.jumpPos;
      if (r.target) cur = r.target.id;
      return r.target;
    };
    const fwd = () => {
      const r = computeJumpStep(jumps, pos, 1, cur, undefined);
      jumps = r.jumps;
      pos = r.jumpPos;
      if (r.target) cur = r.target.id;
      return r.target;
    };

    expect(back()?.id).toBe('p3'); // stashes 'live', jumps to p3
    expect(back()?.id).toBe('p2');
    expect(back()?.id).toBe('p1');
    expect(back()).toBeUndefined(); // oldest entry — nowhere further back
    expect(cur).toBe('p1');

    expect(fwd()?.id).toBe('p2');
    expect(fwd()?.id).toBe('p3');
    expect(cur).toBe('p3');
    // one more forward returns to the stashed live position
    expect(fwd()?.id).toBe('live');
    expect(fwd()).toBeUndefined(); // already at the newest entry
  });
});

describe('isEscapeWanted (Ctrl-P/Ctrl-K passthrough gate)', () => {
  const idleNormal: VimState = { ...initialState(), mode: 'normal' };

  it('idle normal mode releases Escape (wanted = false)', () => {
    expect(isEscapeWanted(idleNormal)).toBe(false);
  });

  it('any non-normal mode wants Escape captured', () => {
    for (const mode of ['insert', 'visual', 'visual-line', 'command'] as const) {
      expect(isEscapeWanted({ ...idleNormal, mode })).toBe(true);
    }
  });

  it('a pending operator wants Escape (to cancel it)', () => {
    expect(isEscapeWanted({ ...idleNormal, op: 'd' })).toBe(true);
  });

  it('a pending multi-key sequence wants Escape', () => {
    expect(isEscapeWanted({ ...idleNormal, pending: { p: 'find', key: 'f' } })).toBe(true);
  });

  it('a count in flight wants Escape', () => {
    expect(isEscapeWanted({ ...idleNormal, count: '3' })).toBe(true);
  });

  it('an operator count in flight wants Escape', () => {
    expect(isEscapeWanted({ ...idleNormal, opCount: '2' })).toBe(true);
  });

  it('every Operator value on a pending op wants Escape', () => {
    for (const op of ['d', 'c', 'y', '>', '<'] as const) {
      expect(isEscapeWanted({ ...idleNormal, op })).toBe(true);
    }
  });

  it('every non-none Pending variant wants Escape', () => {
    const variants: VimState['pending'][] = [
      { p: 'g' },
      { p: 'replace' },
      { p: 'find', key: 'F' },
      { p: 'textobj', key: 'a' },
      { p: 'pane' },
      { p: 'mark' },
      { p: 'gotoMark' },
    ];
    for (const pending of variants) {
      expect(isEscapeWanted({ ...idleNormal, pending })).toBe(true);
    }
  });

  it('combining two idle-breaking conditions still wants Escape (no accidental AND)', () => {
    expect(isEscapeWanted({ ...idleNormal, mode: 'visual', op: 'd', count: '5' })).toBe(true);
  });

  it('only truly all-idle fields release Escape — one field off is enough to keep it', () => {
    // Flip exactly one field away from idle at a time; every one alone
    // must be sufficient to want Escape (guards against a `&&` accidentally
    // becoming an `||`, or a condition being dropped).
    expect(isEscapeWanted({ ...idleNormal, op: 'y' })).toBe(true);
    expect(isEscapeWanted({ ...idleNormal, pending: { p: 'mark' } })).toBe(true);
    expect(isEscapeWanted({ ...idleNormal, count: '1' })).toBe(true);
    expect(isEscapeWanted({ ...idleNormal, opCount: '1' })).toBe(true);
    expect(isEscapeWanted({ ...idleNormal, mode: 'insert' })).toBe(true);
    // and the baseline, with nothing flipped, is the only false case
    expect(isEscapeWanted(idleNormal)).toBe(false);
  });

  it('accepts the full VimState shape, not just the fields it reads', () => {
    // isEscapeWanted takes a Pick<VimState, ...> — confirm passing the
    // complete, real initialState() shape (as the adapter actually does)
    // still works, not just hand-trimmed fixtures.
    expect(isEscapeWanted(initialState())).toBe(true); // initialState's mode is 'insert'
  });
});

describe('classifyStrayEdit (shift-blind capital-letter leak fallout)', () => {
  it('an edit WE caused (processing) is always ignored, regardless of mode', () => {
    for (const mode of ['normal', 'insert', 'visual', 'visual-line', 'command'] as const) {
      expect(classifyStrayEdit(mode, true)).toBe('ignore');
    }
  });

  it('a stray edit during insert mode just marks that something changed', () => {
    expect(classifyStrayEdit('insert', false)).toBe('markInsertEdit');
  });

  it('a stray edit during command mode is ignored (not Rem text)', () => {
    expect(classifyStrayEdit('command', false)).toBe('ignore');
  });

  it('a stray edit in normal/visual/visual-line resets pending state', () => {
    for (const mode of ['normal', 'visual', 'visual-line'] as const) {
      expect(classifyStrayEdit(mode, false)).toBe('resetPending');
    }
  });
});

describe('decideUndo / decideRedo (structural-op grouping)', () => {
  it('no structural op recorded: always native, regardless of applied', () => {
    expect(decideUndo(false, true)).toBe('nativeUndo');
    expect(decideUndo(false, false)).toBe('nativeUndo');
    expect(decideRedo(false, true)).toBe('nativeRedo');
    expect(decideRedo(false, false)).toBe('nativeRedo');
  });

  it('a recorded, currently-applied op: undo reverts it structurally', () => {
    expect(decideUndo(true, true)).toBe('structuralRevert');
  });

  it('a recorded op already reverted: undo falls through to native (nothing left to revert)', () => {
    expect(decideUndo(true, false)).toBe('nativeUndo');
  });

  it('a recorded, already-reverted op: redo reapplies it structurally', () => {
    expect(decideRedo(true, false)).toBe('structuralReapply');
  });

  it('a recorded op still applied: redo falls through to native (nothing to reapply)', () => {
    expect(decideRedo(true, true)).toBe('nativeRedo');
  });

  it('a paste-then-undo-then-redo-then-undo session flips applied each time', () => {
    // Models the adapter's actual usage: `applied` starts true right after
    // the structural op is recorded (the paste/indent already happened),
    // and each undo/redo call is expected to flip it.
    let applied = true;
    const hasOp = true;

    expect(decideUndo(hasOp, applied)).toBe('structuralRevert');
    applied = false;
    expect(decideRedo(hasOp, applied)).toBe('structuralReapply');
    applied = true;
    expect(decideUndo(hasOp, applied)).toBe('structuralRevert');
    applied = false;
    // a second undo with nothing left applied falls through to native,
    // exactly like vim running out of its own undo tree
    expect(decideUndo(hasOp, applied)).toBe('nativeUndo');
  });

  it('an unrelated mutation after the structural op clears it — next undo is native', () => {
    // Mirrors `applyKey`'s MUTATING_OTHER reset: any other edit invalidates
    // `structuralOp`, so hasStructuralOp becomes false regardless of applied.
    expect(decideUndo(false, true)).toBe('nativeUndo');
  });
});

describe('retryUntilTrue (post-openRem mount-race recovery)', () => {
  const noSleep = () => Promise.resolve();

  it('succeeds immediately: no retries, no sleeps', async () => {
    const op = vi.fn(async () => true);
    const sleep = vi.fn(noSleep);
    const out = await retryUntilTrue(op, { sleep });
    expect(out).toBe(true);
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('succeeds on a later attempt after the editor "finishes mounting"', async () => {
    let calls = 0;
    const op = async () => ++calls === 3; // fails twice, then works
    const sleep = vi.fn(noSleep);
    const out = await retryUntilTrue(op, { sleep });
    expect(out).toBe(true);
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2); // only between failed attempts
  });

  it('gives up after the attempt budget, with no trailing sleep after the last failure', async () => {
    const op = vi.fn(async () => false);
    const sleep = vi.fn(noSleep);
    const out = await retryUntilTrue(op, { attempts: 4, sleep });
    expect(out).toBe(false);
    expect(op).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('honors a custom delay between attempts', async () => {
    const delays: number[] = [];
    let calls = 0;
    const op = async () => ++calls === 2;
    await retryUntilTrue(op, {
      delayMs: 123,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([123]);
  });

  it('attempts: 1 means exactly one try, no retries possible', async () => {
    const op = vi.fn(async () => false);
    const sleep = vi.fn(noSleep);
    const out = await retryUntilTrue(op, { attempts: 1, sleep });
    expect(out).toBe(false);
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a rejected op propagates immediately instead of being swallowed and retried', async () => {
    const op = vi.fn(async () => {
      throw new Error('boom');
    });
    const sleep = vi.fn(noSleep);
    await expect(retryUntilTrue(op, { sleep })).rejects.toThrow('boom');
    expect(op).toHaveBeenCalledTimes(1); // no retry-through-the-exception
  });

  it('defaults to 5 attempts when no options are given at all', async () => {
    const op = vi.fn(async () => false);
    // Real production usage (`focusRemById`) calls this with NO options —
    // confirm the actual default (not just a test-supplied one) is 5.
    const out = await retryUntilTrue(op);
    expect(out).toBe(false);
    expect(op).toHaveBeenCalledTimes(5);
  }, 2000);

  it('defaults to an 80ms delay between attempts', async () => {
    const delays: number[] = [];
    let calls = 0;
    const op = async () => ++calls === 2;
    await retryUntilTrue(op, {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([80]);
  });
});

describe('walkToRoot (document-root fallback when no docId was recorded)', () => {
  it('walks a simple parent chain to the top', async () => {
    const parents: Record<string, string | undefined> = { a: 'b', b: 'c', c: undefined };
    const out = await walkToRoot('a', async (id) => parents[id]);
    expect(out).toBe('c');
  });

  it('a Rem with no parent is already the root', async () => {
    const out = await walkToRoot('solo', async () => undefined);
    expect(out).toBe('solo');
  });

  it('stops at the hop cap instead of looping forever on a cycle', async () => {
    const parents: Record<string, string> = { a: 'b', b: 'a' }; // cycle
    const getParentId = vi.fn(async (id: string) => parents[id]);
    const out = await walkToRoot('a', getParentId, 5);
    // deterministic: 5 flips starting from 'a' lands on 'b' (a→b→a→b→a→b)
    expect(out).toBe('b');
    expect(getParentId).toHaveBeenCalledTimes(5);
  });

  it('a broken link (lookup fails mid-walk) is treated the same as "found the root"', async () => {
    const parents: Record<string, string | undefined> = { a: 'b' }; // b's lookup "fails" (undefined)
    const out = await walkToRoot('a', async (id) => parents[id]);
    expect(out).toBe('b');
  });

  it('maxHops: 0 returns the start id untouched, without ever calling getParentId', async () => {
    const getParentId = vi.fn(async () => 'never-seen');
    const out = await walkToRoot('a', getParentId, 0);
    expect(out).toBe('a');
    expect(getParentId).not.toHaveBeenCalled();
  });

  it('a long non-cyclic chain that exactly exhausts the cap stops one short of the true root', async () => {
    // chain: a→b→c→d→e→f (f has no parent) — cap at 4 hops stops at 'e',
    // never reaching the true root 'f'. This is the documented tradeoff:
    // findDocRoot's fallback can undershoot on a very deep hierarchy.
    const parents: Record<string, string | undefined> = { a: 'b', b: 'c', c: 'd', d: 'e', e: 'f', f: undefined };
    const getParentId = vi.fn(async (id: string) => parents[id]);
    const out = await walkToRoot('a', getParentId, 4);
    expect(out).toBe('e');
    expect(getParentId).toHaveBeenCalledTimes(4);
  });

  it('the default cap (100) comfortably covers realistic document depths', async () => {
    // A 30-level chain — deeper than any real RemNote outline is likely to
    // go — should still resolve fully with no explicit maxHops override.
    const depth = 30;
    const parents: Record<string, string | undefined> = {};
    for (let i = 0; i < depth; i++) parents[`n${i}`] = i + 1 < depth ? `n${i + 1}` : undefined;
    const out = await walkToRoot('n0', async (id) => parents[id]);
    expect(out).toBe(`n${depth - 1}`);
  });
});

describe('walkToTarget (exact-match caret walk, both directions)', () => {
  it('already on the target: no steps taken', async () => {
    const step = vi.fn();
    const out = await walkToTarget('t', 1, async () => 't', step);
    expect(out).toBe(true);
    expect(step).not.toHaveBeenCalled();
  });

  it('finds the target a few hops into the first direction', async () => {
    const ids = ['a', 'b', 'c', 't'];
    let i = 0;
    const step = vi.fn(async () => {
      i++;
    });
    const out = await walkToTarget('t', 1, async () => ids[i], step);
    expect(out).toBe(true);
    expect(step).toHaveBeenCalledTimes(3);
    expect(step).toHaveBeenCalledWith(1);
  });

  it('reverses direction when firstDir never finds it', async () => {
    // A one-dimensional position: firstDir (+1) hits a boundary right away
    // (positions >= 1 all read the same, like a document edge); the target
    // only exists in the -1 direction.
    let pos = 0;
    const idFor = (p: number) => (p >= 1 ? 'boundary' : p === 0 ? 'origin' : p === -1 ? 'x' : 't');
    const step = vi.fn(async (dir: -1 | 1) => {
      pos += dir;
    });
    const out = await walkToTarget('t', 1, async () => idFor(pos), step);
    expect(out).toBe(true);
    // the winning hop (and everything after the failed +1 attempt) is -1
    expect(step.mock.calls.at(-1)).toEqual([-1]);
    expect(step.mock.calls.some((c) => c[0] === -1)).toBe(true);
  });

  it('gives up after exhausting both directions without a match', async () => {
    const step = vi.fn();
    const out = await walkToTarget('missing', 1, async () => 'stuck', step, 5);
    expect(out).toBe(false);
  });

  it('regression: the round-5d mount race — moveCaretVertical no-ops right after openRem', async () => {
    // getFocusedRem reports the document title on every call because the
    // caret never actually moves (editor still mounting) — this is exactly
    // what stranded the caret on the title after a cross-document Ctrl-O.
    const step = vi.fn(async () => {});
    const currentId = async () => 'title';
    const out = await walkToTarget('child', 1, currentId, step);
    expect(out).toBe(false); // walkToTarget alone can't recover from this
    // it gives up fast — 2 hops per direction, not the full 60-hop budget
    expect(step).toHaveBeenCalledTimes(4);
  });

  it('regression, continued: retryUntilTrue recovers once the editor settles', async () => {
    const mountedAtAttempt = 3;
    let attempt = 0;
    const walk = async () => {
      attempt++;
      if (attempt < mountedAtAttempt) {
        // still mounting: every currentId() call returns the title
        return walkToTarget('child', 1, async () => 'title', async () => {});
      }
      // mounted: a real (tiny, 1-hop) walk to the child succeeds
      const ids = ['title', 'child'];
      let i = 0;
      return walkToTarget('child', 1, async () => ids[i], async () => {
        i++;
      });
    };
    const out = await retryUntilTrue(walk, { sleep: async () => {} });
    expect(out).toBe(true);
    expect(attempt).toBe(3);
  });

  it('respects a custom per-direction hop cap', async () => {
    const step = vi.fn();
    const out = await walkToTarget('never', 1, async () => `id-${Math.random()}`, step, 3);
    expect(out).toBe(false);
    expect(step).toHaveBeenCalledTimes(6); // 3 per direction, both exhausted
  });

  it('firstDir = -1 works symmetrically (not hardcoded to 1)', async () => {
    const ids = ['a', 'b', 't'];
    let i = 0;
    const step = vi.fn(async () => {
      i++;
    });
    const out = await walkToTarget('t', -1, async () => ids[i], step);
    expect(out).toBe(true);
    expect(step).toHaveBeenCalledTimes(2);
    expect(step).toHaveBeenCalledWith(-1);
  });

  it('nothing focused initially (currentId undefined) does not crash and still walks', async () => {
    const ids: (string | undefined)[] = [undefined, 'a', 't'];
    let i = 0;
    const step = vi.fn(async () => {
      i++;
    });
    const out = await walkToTarget('t', 1, async () => ids[i], step);
    expect(out).toBe(true);
    expect(step).toHaveBeenCalledTimes(2);
  });

  it('finds the target on the very last allowed hop (inclusive boundary, not off-by-one)', async () => {
    const ids = ['a', 'b', 'c', 't']; // reached only on the 3rd step call
    let i = 0;
    const step = vi.fn(async () => {
      i++;
    });
    const out = await walkToTarget('t', 1, async () => ids[i], step, 3);
    expect(out).toBe(true);
    expect(step).toHaveBeenCalledTimes(3);
  });

  it('a hop cap of exactly 1 tries one step per direction, no more', async () => {
    const step = vi.fn();
    const out = await walkToTarget('missing', 1, async () => 'stuck', step, 1);
    expect(out).toBe(false);
    expect(step).toHaveBeenCalledTimes(2);
  });

  it('losing focus mid-walk in one direction still tries the other', async () => {
    // dir=1: currentId() immediately returns undefined (focus lost) — that
    // direction's inner loop must `break`, not throw, and the outer loop
    // must still attempt -1, which finds the target after a couple hops.
    let phase: 'first' | 'second' = 'first';
    let calls = 0;
    const step = vi.fn(async (dir: -1 | 1) => {
      if (dir === -1) phase = 'second';
      calls++;
    });
    const currentId = async () => {
      if (phase === 'first') return undefined;
      return calls >= 3 ? 't' : 'x';
    };
    const out = await walkToTarget('t', 1, currentId, step);
    expect(out).toBe(true);
    expect(step.mock.calls[0]).toEqual([1]); // tried firstDir first
    expect(step).toHaveBeenCalledTimes(3); // 1 (dir=1, lost focus) + 2 (dir=-1)
  });
});

describe('walkToBoundary (batched gg/G document-boundary walk)', () => {
  it('stops once two consecutive batch-end checks agree (boundary reached)', async () => {
    const checks = ['row20', 'row20']; // no progress between checks 1 and 2
    let i = 0;
    const step = vi.fn(async () => {});
    const check = vi.fn(async () => checks[Math.min(i++, checks.length - 1)]);
    await walkToBoundary(step, check, { batch: 5, maxHops: 100 });
    expect(check).toHaveBeenCalledTimes(2);
    expect(step).toHaveBeenCalledTimes(10); // 2 batches of 5
  });

  it('stops immediately if focus is lost (check returns undefined)', async () => {
    const step = vi.fn(async () => {});
    const check = vi.fn(async () => undefined);
    await walkToBoundary(step, check, { batch: 4 });
    expect(check).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenCalledTimes(4);
  });

  it('keeps going while every batch makes progress, up to the hop cap', async () => {
    let n = 0;
    const step = vi.fn(async () => {});
    const check = vi.fn(async () => `row${n++}`); // always a new id: never "stuck"
    await walkToBoundary(step, check, { batch: 20, maxHops: 60 });
    expect(step).toHaveBeenCalledTimes(60);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('defaults match the live gg/G tuning (batch 20, cap 2000)', async () => {
    let n = 0;
    const step = vi.fn(async () => {});
    const check = vi.fn(async () => `row${n++}`);
    await walkToBoundary(step, check);
    expect(step).toHaveBeenCalledTimes(2000);
    expect(check).toHaveBeenCalledTimes(100);
  });

  it('batch: 1 degenerates to the original check-after-every-step behavior', async () => {
    const positions = ['r0', 'r1', 'r2', 'r2']; // stops once r2 repeats
    let i = 0;
    const step = vi.fn(async () => {});
    const check = vi.fn(async () => positions[Math.min(i++, positions.length - 1)]);
    await walkToBoundary(step, check, { batch: 1, maxHops: 100 });
    expect(check).toHaveBeenCalledTimes(4);
    expect(step).toHaveBeenCalledTimes(4); // exactly one step per check
  });

  it('every step in a batch runs before that batch\'s check (ordering)', async () => {
    const log: string[] = [];
    const step = vi.fn(async () => {
      log.push('step');
    });
    const check = vi.fn(async () => {
      log.push('check');
      return undefined; // stop after the first batch
    });
    await walkToBoundary(step, check, { batch: 3 });
    expect(log).toEqual(['step', 'step', 'step', 'check']);
  });

  it('a maxHops that is not a multiple of batch still runs full batches (can overshoot the cap)', async () => {
    // The outer loop only re-checks `i < maxHops` BETWEEN full batches, so a
    // partial final batch is never taken — total steps can exceed maxHops
    // itself when it doesn't divide evenly by batch. Documented, not a bug:
    // gg/G always uses an exact multiple (2000 / 20) in production.
    let n = 0;
    const step = vi.fn(async () => {});
    const check = vi.fn(async () => `row${n++}`); // never repeats: never "stuck"
    await walkToBoundary(step, check, { batch: 20, maxHops: 25 });
    expect(step).toHaveBeenCalledTimes(40); // two full batches, not 25
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('reconcileInsertText (Insert→Normal switching delay)', () => {
  const noSleep = () => Promise.resolve();

  it('no EditorTextEdited event seen: returns pre with zero reads', async () => {
    const readLine = vi.fn(async () => 'should never be read');
    const out = await reconcileInsertText('typed-nothing', false, readLine);
    expect(out).toBe('typed-nothing');
    expect(readLine).not.toHaveBeenCalled();
  });

  it('a genuinely changed value needs no second confirmation read', async () => {
    let call = 0;
    const readLine = async () => {
      call++;
      return call === 1 ? 'stale-read' : 'fresh-text'; // stabilizes after 1 change
    };
    const out = await reconcileInsertText('stale-original', true, readLine, { sleep: noSleep });
    expect(out).toBe('fresh-text');
  });

  it('when both reads confirm nothing changed, returns pre unchanged', async () => {
    const out = await reconcileInsertText('same-text', true, async () => 'same-text', { sleep: noSleep });
    expect(out).toBe('same-text');
  });

  it('catches a slow flush that only shows up on the second, longer-spaced read', async () => {
    let call = 0;
    const readLine = async () => {
      call++;
      // the first settleRead's two reads both see the stale line; only the
      // second (120ms-spaced) settleRead's reads see the flush land
      return call <= 2 ? 'pre-text' : 'pre-text-appended';
    };
    const out = await reconcileInsertText('pre-text', true, readLine, { sleep: noSleep });
    expect(out).toBe('pre-text-appended');
    expect(call).toBe(4);
  });

  it('propagates null when the editor cannot be read at all (focus lost mid-insert)', async () => {
    const out = await reconcileInsertText('previous text', true, async () => null, { sleep: noSleep });
    expect(out).toBeNull();
  });

  it('uses the default 40ms settle spacing first, then a single 120ms confirmation', async () => {
    const delays: number[] = [];
    const sleepSpy = async (ms: number) => {
      delays.push(ms);
    };
    // A line that never changes needs exactly one settle round to agree
    // (40ms), then — since it "looks unchanged" — one more at 120ms.
    const out = await reconcileInsertText('same', true, async () => 'same', { sleep: sleepSpy });
    expect(out).toBe('same');
    expect(delays).toEqual([40, 120]);
  });
});

describe('resolveInsertCaret (insert-exit caret placement)', () => {
  it('prefers a real DOM caret read when available (native mode)', () => {
    expect(resolveInsertCaret(3, 'abc', 'abcXYZ', 0)).toBe(3);
  });

  it('falls back to diffCaret when no DOM caret is available (sandboxed mode, the default)', () => {
    expect(resolveInsertCaret(null, 'abc', 'abcXY', 0)).toBe(5);
  });

  it('a DOM caret of exactly 0 is honored, not treated as missing (nullish check, not falsy)', () => {
    expect(resolveInsertCaret(0, 'abc', 'abc', 5)).toBe(0);
  });

  it('clamps an out-of-range DOM caret into the fresh text\'s bounds', () => {
    expect(resolveInsertCaret(999, 'abc', 'abc', 0)).toBe(3);
    expect(resolveInsertCaret(-5, 'abc', 'abc', 0)).toBe(0);
  });
});

describe('isDescendantAmong (Ctrl-O document-membership check)', () => {
  it('undefined descendantIds (doc Rem vanished mid-check) fails open to true', () => {
    expect(isDescendantAmong('x', undefined)).toBe(true);
  });

  it('an empty descendant list is NOT the same as "undefined" — correctly false', () => {
    expect(isDescendantAmong('x', [])).toBe(false);
  });

  it('true when the id is among the descendants', () => {
    expect(isDescendantAmong('b', ['a', 'b', 'c'])).toBe(true);
  });

  it('false when the id is not among the descendants', () => {
    expect(isDescendantAmong('z', ['a', 'b', 'c'])).toBe(false);
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
