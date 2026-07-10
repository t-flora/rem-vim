/**
 * L3 — the REAL VimAdapter against the fake plugin, for the two 2026-07
 * batch features whose logic lives in adapter exec paths the engine suites
 * can't reach: space-search (`performSearch`: whole-document enumeration,
 * cross-rem jump, caret walk, wrap/error toasts) and `:N` goto-line
 * (`gotoLine`: walk-to-top + counted hops). Uses fake-plugin's multi-row
 * document model (`seedDoc` + a moveCaretVertical that walks pre-order).
 */
import { describe, expect, it } from 'vitest';
import { VimAdapter } from '../src/adapter/adapter';
import { drain, FakeWorld, tick } from './fake-plugin';

async function bootDoc(lines: string[]) {
  const world = new FakeWorld();
  const doc = world.seedDoc(lines);
  const adapter = new VimAdapter(world.plugin as never);
  await adapter.start('normal');
  await drain(adapter); // the initial (queued) config load
  return { world, adapter, doc };
}

/** Dispatch stolen keys like RemNote (spec strings), then settle the queue. */
async function type(world: FakeWorld, adapter: VimAdapter, specs: string[]) {
  for (const s of specs) world.stealKey(s);
  await drain(adapter);
  await tick();
}

const asAny = (adapter: VimAdapter) =>
  adapter as unknown as { state: { mode: string; searchLine: string } };

describe('search mode key stealing (regression: applyMode("search") crashed pre-fix)', () => {
  it('space switches to search mode and steals the command-line extras', async () => {
    const { world, adapter } = await bootDoc(['alpha', 'bravo']);
    expect(world.stolen.has('/')).toBe(false); // normal mode leaves / to RemNote
    await type(world, adapter, ['space']);
    expect(asAny(adapter).state.mode).toBe('search');
    // Pre-fix, effectiveSpecs('search') threw inside applyMode and none of
    // these were stolen — a typed pattern's '/', '-', '=' leaked into the doc.
    for (const s of ['/', '-', '=', '\\', 'tab']) {
      expect(world.stolen.has(s)).toBe(true);
    }
  });

  it('escape cancels: back to the normal-mode steal set, document untouched', async () => {
    const { world, adapter } = await bootDoc(['alpha', 'bravo']);
    await type(world, adapter, ['space', 'b', 'r', 'escape']);
    expect(asAny(adapter).state.mode).toBe('normal');
    expect(world.stolen.has('/')).toBe(false);
    expect(world.text).toBe('alpha'); // pattern keys never reached the doc
  });
});

describe('space-search end to end (performSearch)', () => {
  it('submit jumps the focus and caret to the first match after the cursor', async () => {
    const { world, adapter, doc } = await bootDoc(['alpha one', 'bravo two', 'charlie one']);
    await type(world, adapter, ['space', 'o', 'n', 'e', 'enter']);
    expect(asAny(adapter).state.mode).toBe('normal');
    // 'one' first matches in the focused line itself, after caret 0
    expect(world.focusedRemId).toBe(doc.childIds[0]);
    expect(world.caret).toBe('alpha '.length);
  });

  it('n steps forward across rems; wrapping fires the vim wrap toast', async () => {
    const { world, adapter, doc } = await bootDoc(['alpha one', 'bravo two', 'charlie one']);
    await type(world, adapter, ['space', 'o', 'n', 'e', 'enter']); // (row 0, col 6)
    await type(world, adapter, ['n']);
    expect(world.focusedRemId).toBe(doc.childIds[2]); // 'charlie one'
    expect(world.caret).toBe('charlie '.length);
    await type(world, adapter, ['n']); // past the last match → wraps to the top
    expect(world.focusedRemId).toBe(doc.childIds[0]);
    expect(world.toasts).toContain('search hit BOTTOM, continuing at TOP');
  });

  it('z steps backward, wrapping to the bottom with the mirrored toast', async () => {
    const { world, adapter, doc } = await bootDoc(['alpha one', 'bravo two', 'charlie one']);
    await type(world, adapter, ['space', 'o', 'n', 'e', 'enter']); // (row 0, col 6)
    await type(world, adapter, ['z']); // nothing before (0,6) → wraps to (2,8)
    expect(world.focusedRemId).toBe(doc.childIds[2]);
    expect(world.toasts).toContain('search hit TOP, continuing at BOTTOM');
  });

  it('n with no previous search toasts instead of jumping', async () => {
    const { world, adapter, doc } = await bootDoc(['alpha', 'bravo']);
    await type(world, adapter, ['n']);
    expect(world.toasts).toContain('No previous search');
    expect(world.focusedRemId).toBe(doc.childIds[0]);
  });

  it('an invalid regex pattern toasts Bad pattern and moves nothing', async () => {
    const { world, adapter, doc } = await bootDoc(['alpha', 'bravo']);
    await type(world, adapter, ['space', '[', 'enter']);
    expect(world.toasts).toContain('Bad pattern: /[/');
    expect(world.focusedRemId).toBe(doc.childIds[0]);
  });

  it('a missing pattern toasts Pattern not found', async () => {
    const { world, adapter } = await bootDoc(['alpha', 'bravo']);
    await type(world, adapter, ['space', 'z', 'z', 'enter']);
    expect(world.toasts).toContain('Pattern not found: /zz/');
  });

  it('a search jump is Ctrl-O-able (recorded on the jumplist)', async () => {
    const { world, adapter, doc } = await bootDoc(['alpha', 'bravo target']);
    await type(world, adapter, ['space', 't', 'a', 'r', 'enter']);
    expect(world.focusedRemId).toBe(doc.childIds[1]);
    await type(world, adapter, ['ctrl+o']);
    expect(world.focusedRemId).toBe(doc.childIds[0]);
  });
});

describe(':N goto-line end to end (gotoLine)', () => {
  it(':4 lands on the 4th bullet from the top', async () => {
    const { world, adapter, doc } = await bootDoc(['one', 'two', 'three', 'four']);
    await type(world, adapter, [';', '4', 'enter']);
    expect(world.focusedRemId).toBe(doc.childIds[3]);
  });

  it(':1 returns to the first bullet from anywhere', async () => {
    const { world, adapter, doc } = await bootDoc(['one', 'two', 'three']);
    world.focusRow(doc.childIds[2]);
    await type(world, adapter, [';', '1', 'enter']);
    expect(world.focusedRemId).toBe(doc.childIds[0]);
  });

  it(':99 past the end clamps to the last bullet (vim :999 behavior)', async () => {
    const { world, adapter, doc } = await bootDoc(['one', 'two', 'three']);
    await type(world, adapter, [';', '9', '9', 'enter']);
    expect(world.focusedRemId).toBe(doc.childIds[2]);
  });

  it(':0 clamps to line 1 (vim has no line 0)', async () => {
    const { world, adapter, doc } = await bootDoc(['one', 'two']);
    world.focusRow(doc.childIds[1]);
    await type(world, adapter, [';', '0', 'enter']);
    expect(world.focusedRemId).toBe(doc.childIds[0]);
  });

  it('nested bullets count in pre-order — the same order j/k walk', async () => {
    const { world, adapter, doc } = await bootDoc(['a', 'b', 'd']);
    const c = world.makeRem(['c']);
    await c.setParent(world.rems.get(doc.childIds[1])!); // nest c under b
    await type(world, adapter, [';', '3', 'enter']); // pre-order: a b c d
    expect(world.focusedRemId).toBe(c._id);
  });
});
