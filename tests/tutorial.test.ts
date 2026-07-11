/**
 * Getting-started tutorial (src/widgets/vim_tutorial.tsx + index.tsx gating).
 *
 * Three layers, none needing a browser:
 * - render: every page server-renders (catches JSX/runtime errors in content);
 * - content accuracy: what the tutorial TEACHES is checked against the real
 *   engine (Harness), keymap and mapping parser, so the walkthrough cannot
 *   drift from what the plugin actually does — this suite is why the
 *   `unmap gt` example (rejected by parseLhs: lhs must be ONE key) was caught;
 * - gating (L3): the real onActivate against the fake plugin — auto-open on
 *   first activation only, palette command re-opens, no duplicate windows.
 */
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseMappings } from '../src/adapter/mappings';
import { SPEC_TO_SYM } from '../src/adapter/keymap';
import { STEPS } from '../src/widgets/vim_tutorial';
// The vitest alias resolves '@remnote/plugin-sdk' to tests/sdk-stub.ts, so
// importing the stub by its own path yields the SAME module instance the
// widgets see — its __stub recorders expose what renderWidget/
// declareIndexPlugin were called with. (Importing __stub via the package
// specifier would fail check-types: tsc types the real SDK.)
import { __stub } from './sdk-stub';
import { FakeWorld } from './fake-plugin';
import { Harness } from './harness';

const stepHtml = (i: number) => renderToStaticMarkup(createElement(Fragment, null, STEPS[i].body));
const kbdTexts = (html: string) =>
  [...html.matchAll(/<kbd[^>]*>(.*?)<\/kbd>/g)].map((m) =>
    m[1].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  );

describe('tutorial pages render', () => {
  it('is the advertised 14-page walkthrough, every page non-empty', () => {
    expect(STEPS).toHaveLength(14);
    for (let i = 0; i < STEPS.length; i++) {
      expect(STEPS[i].eyebrow.length).toBeGreaterThan(0);
      expect(STEPS[i].title.length).toBeGreaterThan(0);
      expect(stepHtml(i).length).toBeGreaterThan(80);
    }
    expect(new Set(STEPS.map((s) => s.title)).size).toBe(STEPS.length);
  });

  it('the whole widget component server-renders (welcome page)', () => {
    expect(__stub.renderedWidget).toBeTypeOf('function');
    const html = renderToStaticMarkup(createElement(__stub.renderedWidget as never));
    expect(html).toContain('Vim Mode for RemNote');
    expect(html).toContain('Next'); // footer nav rendered
  });
});

describe('tutorial content is true', () => {
  it('every single-letter key it shows is actually stolen in normal mode', () => {
    for (let i = 0; i < STEPS.length; i++) {
      for (const k of kbdTexts(stepHtml(i))) {
        if (/^[a-z0-9;,.'`[\]]$/.test(k)) {
          expect(SPEC_TO_SYM, `page ${i + 1} teaches unbound key '${k}'`).toHaveProperty([k]);
        }
      }
    }
  });

  it('every mapping example on the custom-keybindings page parses cleanly', () => {
    const page = STEPS.findIndex((s) => s.title === 'Custom keybindings');
    expect(page).toBeGreaterThanOrEqual(0);
    const examples = kbdTexts(stepHtml(page)).filter((k) => /^(map|nmap|vmap|unmap)\s/.test(k));
    expect(examples.length).toBeGreaterThanOrEqual(4); // map/nmap/vmap/unmap all shown
    const { diagnostics } = parseMappings(examples);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  // The commands each page teaches, run against the real engine. One
  // representative claim per page section — if a page's advice stops being
  // true, the matching assertion here should break.
  it('insert page: ga appends at end of line, go opens a bullet above', () => {
    const e = new Harness(['hello']);
    e.keys('ga');
    expect(e.mode).toBe('insert');
    expect(e.caret).toBe(5);
    const e2 = new Harness(['world']);
    e2.keys('go');
    expect(e2.lines).toEqual(['', 'world']);
    expect(e2.mode).toBe('insert');
  });

  it('motions page: gl/gh/f/gf/, behave as described', () => {
    const e = new Harness(['  abcabc'], 0, 4);
    e.keys('gl');
    expect(e.caret).toBe(8);
    e.keys('gh');
    expect(e.caret).toBe(2);
    e.keys('fb'); // onto the next b
    expect(e.caret).toBe(3);
    e.keys('fb'); // and the one after
    expect(e.caret).toBe(6);
    e.keys(','); // repeat reversed: back to the previous b
    expect(e.caret).toBe(3);
    e.keys('gl');
    e.keys('gfb'); // gf = backward find, landing ON the char
    expect(e.caret).toBe(6);
  });

  it('editing page: dib deletes inside parens, counts multiply (3x, 2dw)', () => {
    const e = new Harness(['foo (bar baz) qux'], 0, 7);
    e.keys('dib');
    expect(e.line).toBe('foo () qux');
    const e2 = new Harness(['abcdef']);
    e2.keys('3x');
    expect(e2.line).toBe('def');
    const e3 = new Harness(['one two three four']);
    e3.keys('2dw');
    expect(e3.line).toBe('three four');
  });

  it('editing page: backtick toggles case, gj joins, . repeats', () => {
    const e = new Harness(['abc']);
    e.keys('`');
    expect(e.line).toBe('Abc');
    const e2 = new Harness(['a', 'b']);
    e2.keys('gj');
    expect(e2.lines).toEqual(['a b']);
    const e3 = new Harness(['xxab']);
    e3.keys('x.');
    expect(e3.line).toBe('ab');
  });

  it('visual page: gs9 wraps in parens, backtick toggles the selection', () => {
    const e = new Harness(['abc']);
    e.keys('vllgs9');
    expect(e.line).toBe('(abc)');
    const e2 = new Harness(['abc']);
    e2.keys('vll`');
    expect(e2.line).toBe('ABC');
  });

  it('visual-line page: . and , indent/outdent the selection', () => {
    const e = new Harness(['a', 'b'], 0, 0);
    e.keys('vvj.');
    expect(e.indents).toEqual([1, 1]);
    e.keys('vvj,');
    expect(e.indents).toEqual([0, 0]);
  });

  it('command-line page: :10 goes to the adapter as a goto-line command', () => {
    const e = new Harness(['a']);
    e.keys(';10<cr>');
    expect(e.lastEx).toBe('10');
  });

  it('search page: space/n/z work as described', () => {
    const e = new Harness(['foo', 'bar', 'foo tail']);
    e.keys('<space>foo<cr>');
    expect(e.row).toBe(2);
    e.keys('z');
    expect(e.row).toBe(0);
  });
});

describe('tutorial gating (real onActivate on the fake plugin)', () => {
  async function activate(world: FakeWorld) {
    // index.tsx assigns window.__vim at the end of onActivate; vitest's node
    // environment has no window global.
    (globalThis as { window?: unknown }).window ??= globalThis;
    await import('../src/widgets/index');
    await __stub.onActivate!(world.plugin);
  }
  const tutorialOpens = (world: FakeWorld) =>
    world.floatingOpens.filter((args) => args[0] === 'vim_tutorial');

  it('first activation (no seen flag) auto-opens the tutorial, click-outside-closable', async () => {
    const world = new FakeWorld();
    await activate(world); // openTutorial is awaited inside onActivate — no queue to drain
    const opens = tutorialOpens(world);
    expect(opens).toHaveLength(1);
    expect(opens[0][3]).toBe(true); // closeWhenClickOutside
    expect(world.commands.has('vim-tutorial')).toBe(true);
  });

  it('activation with the seen flag set does not auto-open', async () => {
    const world = new FakeWorld();
    world.storage.set('vim-tutorial-seen', true);
    await activate(world);
    expect(tutorialOpens(world)).toHaveLength(0);
  });

  it('the palette command opens it, and re-running it does not stack a second window', async () => {
    const world = new FakeWorld();
    world.storage.set('vim-tutorial-seen', true);
    await activate(world);
    await world.commands.get('vim-tutorial')!.action();
    expect(tutorialOpens(world)).toHaveLength(1);
    await world.commands.get('vim-tutorial')!.action(); // still open → no-op
    expect(tutorialOpens(world)).toHaveLength(1);
    world.openFloating.clear(); // simulate the user closing it
    await world.commands.get('vim-tutorial')!.action();
    expect(tutorialOpens(world)).toHaveLength(2); // reopens after close
  });
});
