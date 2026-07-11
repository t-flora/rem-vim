/**
 * The "Vim Tutorial" practice document — content (src/adapter/tutorialDoc.ts),
 * document lifecycle (VimAdapter.openTutorial) and first-activation gating
 * (index.tsx), all without a browser or RemNote:
 *
 * - content accuracy: every practice line's claim is executed against the
 *   engine Harness ON THE LINE'S OWN TEXT — the tutorial physically cannot
 *   teach a command that doesn't do what the line says;
 * - lifecycle (L3): the real VimAdapter on the fake plugin — create + seed
 *   once, pin the id, reopen idempotently, re-seed after deletion, reachable
 *   as the `:tutorial` Ex command;
 * - gating (L3): the real onActivate — auto-open exactly once, seen flag.
 */
import { describe, expect, it } from 'vitest';
import { parseMappings } from '../src/adapter/mappings';
import { TUTORIAL_DOC_NAME, TUTORIAL_LINES } from '../src/adapter/tutorialDoc';
import { VimAdapter } from '../src/adapter/adapter';
import { __stub } from './sdk-stub';
import { drain, FakeWorld } from './fake-plugin';
import { Harness } from './harness';

const texts = TUTORIAL_LINES.map((l) => l.text);
/** The one tutorial line whose text contains `needle` (asserts uniqueness). */
const lineWith = (needle: string) => {
  const hits = texts.filter((t) => t.includes(needle));
  expect(hits, `expected exactly one tutorial line containing "${needle}"`).toHaveLength(1);
  return hits[0];
};

describe('tutorial document content structure', () => {
  it('has lessons, starts at indent 0, and never orphans a nested bullet', () => {
    expect(TUTORIAL_LINES.length).toBeGreaterThan(25);
    expect(TUTORIAL_LINES[0].indent).toBe(0);
    for (const l of TUTORIAL_LINES) expect([0, 1]).toContain(l.indent);
    expect(TUTORIAL_LINES.filter((l) => l.indent === 0).length).toBeGreaterThanOrEqual(10);
  });

  it("the search practice is honest: 'needle' appears exactly twice, lesson before bottom", () => {
    const rows = texts.map((t, i) => (t.includes('needle') ? i : -1)).filter((i) => i >= 0);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe(texts.length - 1); // the hidden one is the last line
  });
});

describe('tutorial practice lines do what they say', () => {
  it('lesson 1: fz lands on the z of crazy', () => {
    const words = lineWith('crazy lazy puzzle');
    const e = new Harness([words.slice(words.indexOf('crazy'))]);
    e.keys('fz');
    expect(e.caret).toBe('cra'.length);
  });

  it('lesson 3: x fixes caaat, diw removes the doubled is', () => {
    const e = new Harness(['caaat']);
    e.keys('faxx'); // onto the first a, delete two
    expect(e.line).toBe('cat');
    const dup = lineWith('sky is is blue');
    const e2 = new Harness([dup], 0, dup.indexOf('is is'));
    e2.keys('diw');
    expect(e2.line).not.toMatch(/is is/);
  });

  it('lesson 4: cw on the wrong word enters insert mode, backtick fixes aNGRY', () => {
    const line = lineWith('sky is green');
    const e = new Harness([line], 0, line.indexOf('green'));
    e.keys('cw');
    expect(e.mode).toBe('insert');
    expect(e.line).not.toContain('green');
    const e2 = new Harness(['aNGRY']);
    e2.keys('`');
    expect(e2.line).toBe('ANGRY');
  });

  it('lesson 5: 3x clears xxxhello, dw . . clears the three colors only', () => {
    const e = new Harness(['xxxhello']);
    e.keys('3x');
    expect(e.line).toBe('hello');
    const line = lineWith('red green blue');
    const e2 = new Harness([line], 0, line.indexOf('red'));
    e2.keys('dw..');
    expect(e2.line).toContain('keep the rest');
    expect(e2.line).not.toMatch(/red|green|blue/);
  });

  it('lesson 6: space-search lands in the lesson line first, n finds the bottom needle', () => {
    const lesson = lineWith('press n to chase');
    // the promise "n chases the bottom one" only holds if the lesson line
    // mentions the pattern exactly once
    expect(lesson.match(/needle/g)).toHaveLength(1);
    const from = texts.indexOf(lesson);
    const e = new Harness(texts, from, 0);
    e.keys('<space>needle<cr>');
    expect(e.row).toBe(from); // the mention inside the lesson line itself
    e.keys('n');
    expect(e.row).toBe(texts.length - 1); // the hidden one at the bottom
    e.keys('z');
    expect(e.row).toBe(from);
  });

  it('lesson 8: v + e + gs9 wraps important in parens; vv j . indents both practice bullets', () => {
    const line = lineWith('important with v');
    const e = new Harness([line], 0, line.indexOf('important'));
    e.keys('vegs9');
    expect(e.line).toContain('(important)');
    const row = texts.indexOf(lineWith('then . to indent both'));
    const e2 = new Harness(texts, row, 0);
    e2.keys('vvj.');
    expect(e2.indents[row]).toBe(1);
    expect(e2.indents[row + 1]).toBe(1);
    e2.keys('vvj,');
    expect(e2.indents[row]).toBe(0);
  });

  it('lesson 9: the ;s practice line submits the substitute it promises', () => {
    const line = lineWith('this line is bad');
    const e = new Harness([line]);
    e.keys(';s/bad/good/<cr>');
    expect(e.lastEx).toBe('s/bad/good/');
  });

  it('lesson 10: the mapping examples it quotes parse cleanly', () => {
    const line = lineWith(':config opens');
    expect(line).toContain('nmap - $');
    expect(line).toContain('unmap ,');
    const { diagnostics } = parseMappings(['nmap - $', 'unmap ,']);
    expect(diagnostics).toEqual([]);
  });
});

describe('tutorial document lifecycle (real adapter, fake plugin)', () => {
  async function boot() {
    const world = new FakeWorld();
    const scratch = world.makeRem(['scratch note']);
    world.focusedRemId = scratch._id;
    world.paneDocId = scratch._id;
    world.text = 'scratch note';
    const adapter = new VimAdapter(world.plugin as never);
    await adapter.start('normal');
    await drain(adapter);
    return { world, adapter };
  }
  const tutorialDoc = (world: FakeWorld) =>
    [...world.rems.values()].find((r) => r.text.join('') === TUTORIAL_DOC_NAME);

  it('first open creates, seeds and pins the document, then opens it', async () => {
    const { world, adapter } = await boot();
    await adapter.openTutorial();
    const doc = tutorialDoc(world);
    expect(doc).toBeDefined();
    expect(doc!.isDocument).toBe(true);
    expect(world.storage.get('vim-tutorial-doc-id')).toBe(doc!._id);
    expect(world.openedRemIds).toContain(doc!._id);
    // top-level children = the indent-0 lines, in order
    const tops = await doc!.getChildrenRem();
    const wantTops = TUTORIAL_LINES.filter((l) => l.indent === 0);
    expect(tops.map((r) => r.text.join(''))).toEqual(wantTops.map((l) => l.text));
    // nested lines hang under their preceding indent-0 line
    const lesson0kids = await tops[0].getChildrenRem();
    expect(lesson0kids.map((r) => r.text.join(''))).toEqual(
      [TUTORIAL_LINES[1], TUTORIAL_LINES[2], TUTORIAL_LINES[3]].map((l) => l.text)
    );
  });

  it('reopening does not create a second copy', async () => {
    const { world, adapter } = await boot();
    await adapter.openTutorial();
    const remCount = world.rems.size;
    await adapter.openTutorial();
    expect(world.rems.size).toBe(remCount);
    expect(world.openedRemIds.filter((id) => id === tutorialDoc(world)!._id)).toHaveLength(2);
  });

  it('a deleted document is re-seeded fresh on the next open', async () => {
    const { world, adapter } = await boot();
    await adapter.openTutorial();
    const first = tutorialDoc(world)!;
    world.rems.delete(first._id); // user deleted the doc (children orphaned)
    await adapter.openTutorial();
    const second = tutorialDoc(world)!;
    expect(second._id).not.toBe(first._id);
    expect(world.storage.get('vim-tutorial-doc-id')).toBe(second._id);
  });

  it(':tutorial typed on the command line opens it', async () => {
    const { world, adapter } = await boot();
    for (const spec of [';', 't', 'u', 't', 'o', 'r', 'i', 'a', 'l', 'enter']) {
      world.stealKey(spec);
    }
    await drain(adapter);
    expect(tutorialDoc(world)).toBeDefined();
    expect(world.openedRemIds).toContain(tutorialDoc(world)!._id);
  });
});

describe('first-activation gating (real onActivate)', () => {
  async function activate(world: FakeWorld) {
    (globalThis as { window?: unknown }).window ??= globalThis;
    await import('../src/widgets/index');
    await __stub.onActivate!(world.plugin);
  }
  const tutorialDoc = (world: FakeWorld) =>
    [...world.rems.values()].find((r) => r.text.join('') === TUTORIAL_DOC_NAME);

  it('first activation seeds + opens the tutorial and sets the seen flag', async () => {
    const world = new FakeWorld();
    await activate(world);
    expect(tutorialDoc(world)).toBeDefined();
    expect(world.openedRemIds).toContain(tutorialDoc(world)!._id);
    expect(world.storage.get('vim-tutorial-seen')).toBe(true);
    expect(world.commands.has('vim-tutorial')).toBe(true);
  });

  it('an activation with the seen flag set does not create or open anything', async () => {
    const world = new FakeWorld();
    world.storage.set('vim-tutorial-seen', true);
    await activate(world);
    expect(tutorialDoc(world)).toBeUndefined();
    expect(world.openedRemIds).toHaveLength(0);
  });

  it('the palette command reopens the same document afterward', async () => {
    const world = new FakeWorld();
    await activate(world);
    const doc = tutorialDoc(world)!;
    await world.commands.get('vim-tutorial')!.action();
    expect(world.openedRemIds.filter((id) => id === doc._id)).toHaveLength(2);
    expect([...world.rems.values()].filter((r) => r.text.join('') === TUTORIAL_DOC_NAME)).toHaveLength(1);
  });
});
