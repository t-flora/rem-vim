/**
 * Shifted keys: RemNote's steal matcher distinguishes Shift (stock is-hotkey
 * by keyCode — see keymap.ts), so capitals and shifted symbols are stolen as
 * 'shift+<base>' and reach the engine as their real vim symbols.
 *
 * - keymap: every shifted spec, which modes steal it, and the spec helper;
 * - engine: the vim commands that became reachable (A, V, J, N, @, {, }, ge,
 *   ;, `) and the aliases that stayed;
 * - walkParagraph: the adapter's `{`/`}` walk against a fake caret;
 * - adapter: a stolen 'shift+a' / 'shift+4' end to end on the fake plugin.
 */
import { describe, expect, it } from 'vitest';
import { VimAdapter } from '../src/adapter/adapter';
import {
  COMMAND_BINDINGS,
  INSERT_BINDINGS,
  NORMAL_BINDINGS,
  SPEC_TO_SYM,
  specForChar,
} from '../src/adapter/keymap';
import { ParagraphRow, walkParagraph } from '../src/adapter/pure';
import { drain, FakeWorld, tick } from './fake-plugin';
import { Harness } from './harness';

const h = (lines: string | string[], row = 0, caret = 0) =>
  new Harness(Array.isArray(lines) ? lines : [lines], row, caret);

// ------------------------------------------------------------ keymap

describe('keymap: shifted keys', () => {
  it('maps every shifted letter to its capital', () => {
    for (const l of 'abcdefghijklmnopqrstuvwxyz') {
      expect(SPEC_TO_SYM[`shift+${l}`], l).toBe(l.toUpperCase());
      expect(SPEC_TO_SYM[l], l).toBe(l);
    }
  });

  it('maps every shifted US-layout symbol to the character it types', () => {
    const want: Record<string, string> = {
      'shift+`': '~', 'shift+1': '!', 'shift+2': '@', 'shift+3': '#', 'shift+4': '$',
      'shift+5': '%', 'shift+6': '^', 'shift+7': '&', 'shift+8': '*', 'shift+9': '(',
      'shift+0': ')', 'shift+-': '_', 'shift+=': '+', 'shift+[': '{', 'shift+]': '}',
      'shift+\\': '|', 'shift+;': ':', "shift+'": '"', 'shift+,': '<', 'shift+.': '>',
      'shift+/': '?',
    };
    for (const [spec, sym] of Object.entries(want)) expect(SPEC_TO_SYM[spec], spec).toBe(sym);
  });

  it('never steals a shifted character by its own name (is-hotkey reads $ as Home, { as F12)', () => {
    const specs = new Set(COMMAND_BINDINGS.map((b) => b.spec));
    for (const ch of '~!@#$%^&*()_+{}|:"<>?ABCZ') expect(specs.has(ch), ch).toBe(false);
  });

  it('normal/visual and command modes steal shifted keys; insert steals only Escape', () => {
    const normal = new Set(NORMAL_BINDINGS.map((b) => b.spec));
    const command = new Set(COMMAND_BINDINGS.map((b) => b.spec));
    for (const spec of ['shift+a', 'shift+4', 'shift+[', 'shift+;', 'shift+/']) {
      expect(normal.has(spec), spec).toBe(true);
      expect(command.has(spec), spec).toBe(true);
    }
    expect(INSERT_BINDINGS.map((b) => b.spec)).toEqual(['escape']);
  });

  it('specs are unique', () => {
    const specs = COMMAND_BINDINGS.map((b) => b.spec);
    expect(new Set(specs).size).toBe(specs.length);
  });

  it('specForChar spells capitals and shifted symbols, null for anything else', () => {
    expect(specForChar('A')).toBe('shift+a');
    expect(specForChar('$')).toBe('shift+4');
    expect(specForChar('"')).toBe("shift+'");
    expect(specForChar('a')).toBeNull();
    expect(specForChar('-')).toBeNull();
  });
});

// ------------------------------------------------------------ engine

describe('engine: capital commands', () => {
  it('A appends at the end of the line, I inserts at the first non-blank', () => {
    const e = h('  hello');
    e.keys('A!<esc>');
    expect(e.line).toBe('  hello!');
    const e2 = h('  hello', 0, 5);
    e2.keys('I>');
    expect(e2.line).toBe('  >hello');
  });

  it('O opens a bullet above', () => {
    const e = h(['one', 'two'], 1);
    e.keys('Onew<esc>');
    expect(e.lines).toEqual(['one', 'new', 'two']);
  });

  it('D, C and S work on the line', () => {
    const e = h('hello world', 0, 5);
    e.keys('D');
    expect(e.line).toBe('hello');
    const e2 = h('hello world', 0, 6);
    e2.keys('Cthere<esc>');
    expect(e2.line).toBe('hello there');
    const e3 = h('hello world');
    e3.keys('Sbye<esc>');
    expect(e3.line).toBe('bye');
  });

  it('$ and ^ move to the line end and first non-blank', () => {
    const e = h('  one two', 0, 4);
    e.keys('$');
    expect(e.caret).toBe(9);
    e.keys('^');
    expect(e.caret).toBe(2);
  });

  it('d$ deletes to the end of the line', () => {
    const e = h('hello world', 0, 5);
    e.keys('d$');
    expect(e.line).toBe('hello');
  });

  it('W, B and E move by WORD (punctuation included)', () => {
    const e = h('foo.bar baz');
    e.keys('W');
    expect(e.caret).toBe(8);
    e.keys('B');
    expect(e.caret).toBe(0);
    e.keys('E');
    expect(e.caret).toBe(6);
  });

  it('F and T find backward', () => {
    const e = h('a-b-c', 0, 4);
    e.keys('F-');
    expect(e.caret).toBe(3);
    e.keys('T-');
    expect(e.caret).toBe(2);
  });

  it('f and r accept shifted characters', () => {
    const e = h('cost: $5');
    e.keys('f$');
    expect(e.caret).toBe(6);
    e.keys('r#');
    expect(e.line).toBe('cost: #5');
    const e2 = h('abc');
    e2.keys('rA');
    expect(e2.line).toBe('Abc');
  });

  it('G goes to the last bullet', () => {
    const e = h(['a', 'b', 'c']);
    e.keys('G');
    expect(e.row).toBe(2);
  });

  it('J joins the next bullet', () => {
    const e = h(['foo', 'bar']);
    e.keys('J');
    expect(e.lines).toEqual(['foo bar']);
  });

  it('P pastes before the cursor, X deletes before it, Y yanks the bullet', () => {
    const e = h('abc', 0, 1);
    e.keys('ylP');
    expect(e.line).toBe('abbc');
    const e2 = h('abc', 0, 2);
    e2.keys('X');
    expect(e2.line).toBe('ac');
    const e3 = h(['one', 'two']);
    e3.keys('Yjp');
    expect(e3.lines).toEqual(['one', 'two', 'one']);
  });

  it('~ toggles case and advances with a count', () => {
    const e = h('abc');
    e.keys('2~');
    expect(e.line).toBe('ABc');
  });

  it('>> and << indent and outdent', () => {
    const e = new Harness(['a', 'b'], 1, 0);
    e.keys('>>');
    expect(e.indents).toEqual([0, 1]);
    e.keys('<<');
    expect(e.indents).toEqual([0, 0]);
  });

  it('N steps the search backward', () => {
    const e = h(['foo', 'bar', 'foo'], 1);
    e.keys('<space>foo<cr>');
    expect(e.row).toBe(2);
    e.keys('N');
    expect(e.row).toBe(0);
  });

  it('@a replays a macro, @@ repeats the last replay, counts multiply', () => {
    const e = h('aaaaaaaa');
    e.keys('qaxq');
    expect(e.line).toBe('aaaaaaa');
    e.keys('@a');
    expect(e.line).toBe('aaaaaa');
    e.keys('@@');
    expect(e.line).toBe('aaaaa');
    e.keys('3@a');
    expect(e.line).toBe('aa');
  });

  it('@@ with nothing replayed yet just toasts', () => {
    const e = h('abc');
    e.keys('@@');
    expect(e.line).toBe('abc');
    expect(e.toasts.at(-1)).toContain('no macro replayed yet');
  });

  it('the gq alias still replays', () => {
    const e = h('aaaa');
    e.keys('qaxqgqa');
    expect(e.line).toBe('aa');
  });
});

describe('engine: { and } (paragraph = run of non-empty bullets)', () => {
  const doc = ['one', 'two', '', 'three', 'four', '', '', 'five'];

  it('} goes to the next empty bullet, { back to the previous one', () => {
    const e = h(doc, 0);
    e.keys('}');
    expect(e.row).toBe(2);
    e.keys('}');
    expect(e.row).toBe(5);
    e.keys('{');
    expect(e.row).toBe(2);
  });

  it('from an empty bullet, } skips the blank run before counting', () => {
    const e = h(doc, 5);
    e.keys('}');
    expect(e.row).toBe(7); // no blank after "five": stops at the last bullet
  });

  it('a count jumps several paragraphs', () => {
    const e = h(doc, 0);
    e.keys('2}');
    expect(e.row).toBe(5);
  });

  it('{ with no blank above stops at the first bullet', () => {
    const e = h(doc, 4);
    e.keys('2{');
    expect(e.row).toBe(0);
  });

  it('{ and } are jumps (Ctrl-O returns)', () => {
    const e = h(doc, 0);
    e.keys('}');
    e.keys('<c-o>');
    expect(e.row).toBe(0);
  });

  it('under an operator they are a no-op (no cross-bullet charwise delete)', () => {
    const e = h(doc, 0);
    e.keys('d}');
    expect(e.lines).toEqual(doc);
    e.keys('x'); // operator must be gone
    expect(e.lines[0]).toBe('ne');
  });
});

describe('engine: vim meanings that replaced the old stand-ins', () => {
  it('ge / gE go back to the end of the previous word / WORD', () => {
    const e = h('one two three', 0, 8);
    e.keys('ge');
    expect(e.caret).toBe(6);
    e.keys('ge');
    expect(e.caret).toBe(2);
    const e2 = h('a.b cd', 0, 4);
    e2.keys('gE');
    expect(e2.caret).toBe(2);
    const e3 = h('a.b cd', 0, 4);
    e3.keys('ge');
    expect(e3.caret).toBe(2);
  });

  it('ge from inside a word lands on the previous word, not the current one', () => {
    const e = h('one two', 0, 5);
    e.keys('ge');
    expect(e.caret).toBe(2);
  });

  it('2ge counts, and ge at the first word stays at 0', () => {
    const e = h('one two three', 0, 9);
    e.keys('2ge');
    expect(e.caret).toBe(2);
    const e2 = h('one two', 0, 1);
    e2.keys('ge');
    expect(e2.caret).toBe(0);
  });

  it('dge deletes back through the previous word end, cursor char included', () => {
    const e = h('one two', 0, 4);
    e.keys('dge');
    expect(e.line).toBe('onwo');
  });

  it('gj / gk move down / up instead of joining', () => {
    const e = h(['a', 'b', 'c']);
    e.keys('gj');
    expect(e.lines).toEqual(['a', 'b', 'c']);
    expect(e.row).toBe(1);
    e.keys('gk');
    expect(e.row).toBe(0);
  });

  it('z is no longer a search alias', () => {
    const e = h(['foo', 'foo'], 0);
    e.keys('<space>foo<cr>');
    expect(e.row).toBe(1);
    e.keys('z');
    expect(e.row).toBe(1);
  });

  it('visual ge moves the head back; vG still escalates to visual-line', () => {
    const e = h('one two', 0, 5);
    e.keys('vgey');
    expect(e.state.register).toEqual({ kind: 'char', text: 'e tw' });
  });

  it('V from normal enters visual-line; v from visual-line exits', () => {
    const e = h(['a', 'b']);
    e.keys('V');
    expect(e.mode).toBe('visual-line');
    e.keys('v');
    expect(e.mode).toBe('normal');
  });

  it('; does not open the command line any more, : does', () => {
    const e = h('abc');
    e.keys(';');
    expect(e.mode).toBe('normal');
    e.keys('vl;');
    expect(e.mode).toBe('visual');
    e.keys('<esc>Vj;');
    expect(e.mode).toBe('visual-line');
    e.keys('<esc>:');
    expect(e.mode).toBe('command');
  });

  it('the kept aliases gl, gh and ga still work', () => {
    const e = h('  one', 0, 3);
    e.keys('gl');
    expect(e.caret).toBe(5);
    e.keys('gh');
    expect(e.caret).toBe(2);
    e.keys('ga!<esc>');
    expect(e.line).toBe('  one!');
  });
});

describe('engine: shifted keys inside pendings, text objects and the command line', () => {
  it('di( di{ di" and di< text objects', () => {
    const cases: [string, string, string][] = [
      ['f(a)', 'di(', 'f()'],
      ['f{a}', 'di{', 'f{}'],
      ['x "a b" y', 'di"', 'x "" y'],
      ['f(a)', 'da)', 'f'],
    ];
    for (const [line, keys, want] of cases) {
      const e = h(line, 0, line.indexOf('a'));
      e.keys(keys);
      expect(e.line, keys).toBe(want);
    }
  });

  it('gs wraps with the real delimiters', () => {
    const cases: [string, string][] = [
      ['(', '(word)'],
      [')', '(word)'],
      ['"', '"word"'],
      ['*', '*word*'],
      ['{', '{word}'],
      ['<', '<word>'],
      ['_', '_word_'],
    ];
    for (const [delim, want] of cases) {
      const e = h('word');
      e.keys(`vegs${delim}`);
      expect(e.line, delim).toBe(want);
    }
  });

  it('capitals and shifted symbols type into the command line', () => {
    const e = h('abc');
    e.keys(':s/Foo(1)/Bar$/<cr>');
    expect(e.lastEx).toBe('s/Foo(1)/Bar$/');
  });

  it('marks accept shifted names and backtick jumps to them', () => {
    const e = h(['one', 'two', 'three'], 1);
    e.keys('mA');
    e.keys('gg');
    e.keys('`A');
    expect(e.row).toBe(1);
  });
});

// ------------------------------------------------------------ walkParagraph

/** A fake caret over rows; `wraps[i]` = extra steps needed to leave row i. */
function fakeRows(rows: string[], start: number, wraps: number[] = []) {
  let row = start;
  let inRow = 0;
  let steps = 0;
  const step = (dir: -1 | 1) => async () => {
    steps++;
    if (inRow < (wraps[row] ?? 0)) {
      inRow++;
      return;
    }
    const next = row + dir;
    if (next < 0 || next >= rows.length) return;
    row = next;
    inRow = 0;
  };
  const read = async (): Promise<ParagraphRow> => ({ id: String(row), empty: rows[row].trim() === '' });
  return { step, read, row: () => row, steps: () => steps };
}

describe('walkParagraph', () => {
  const rows = ['one', 'two', '', 'three', '', '', 'four'];

  it('stops at the next empty row after text', async () => {
    const f = fakeRows(rows, 0);
    await walkParagraph(f.step(1), f.read, 1);
    expect(f.row()).toBe(2);
  });

  it('skips a blank run before counting, then stops at the boundary', async () => {
    const f = fakeRows(rows, 4);
    await walkParagraph(f.step(1), f.read, 1);
    expect(f.row()).toBe(6);
  });

  it('walks backward with a count', async () => {
    const f = fakeRows(rows, 6);
    await walkParagraph(f.step(-1), f.read, 2);
    expect(f.row()).toBe(2);
  });

  it('a wrapped row that takes a couple of steps to leave is not mistaken for the boundary', async () => {
    const f = fakeRows(rows, 0, [2, 2]);
    await walkParagraph(f.step(1), f.read, 1);
    expect(f.row()).toBe(2);
  });

  it('gives up after stuckLimit steps at the document boundary', async () => {
    const f = fakeRows(['a', 'b'], 0);
    await walkParagraph(f.step(1), f.read, 1, { stuckLimit: 3 });
    expect(f.row()).toBe(1);
    expect(f.steps()).toBe(1 + 3);
  });

  it('a missing focus ends the walk', async () => {
    let calls = 0;
    await walkParagraph(
      async () => {},
      async () => (calls++ === 0 ? { id: 'a', empty: false } : undefined),
      1
    );
    expect(calls).toBe(2);
  });
});

// ------------------------------------------------------------ adapter

async function boot(text: string) {
  const world = new FakeWorld();
  const scratch = world.makeRem([text]);
  world.focusedRemId = scratch._id;
  world.paneDocId = scratch._id;
  world.text = text;
  world.caret = 0;
  const adapter = new VimAdapter(world.plugin as never);
  await adapter.start('normal');
  await drain(adapter);
  return { world, adapter };
}

async function type(world: FakeWorld, adapter: VimAdapter, specs: string[]) {
  for (const s of specs) world.stealKey(s);
  await drain(adapter);
  await tick();
}

describe('adapter: shifted specs end to end', () => {
  it('normal mode steals shift+ specs; insert mode releases them', async () => {
    const { world, adapter } = await boot('hello world');
    for (const spec of ['shift+a', 'shift+4', 'shift+[', 'shift+;']) {
      expect(world.stolen.has(spec), spec).toBe(true);
    }
    await type(world, adapter, ['i']);
    expect(world.stolen.has('shift+a')).toBe(false);
    expect(world.stolen.has('a')).toBe(false);
  });

  it("a stolen 'shift+4' runs $ and 'shift+a' runs A", async () => {
    const { world, adapter } = await boot('hello world');
    await type(world, adapter, ['shift+4']);
    expect(world.caret).toBe('hello world'.length);
    await type(world, adapter, ['0', 'shift+a']);
    expect((adapter as unknown as { state: { mode: string } }).state.mode).toBe('insert');
    expect(world.caret).toBe('hello world'.length);
  });

  it("'shift+;' opens the command line and shifted keys type into it", async () => {
    const { world, adapter } = await boot('abc');
    await type(world, adapter, ['shift+;', 'shift+w']);
    const st = (adapter as unknown as { state: { mode: string; commandLine: string } }).state;
    expect(st.mode).toBe('command');
    expect(st.commandLine).toBe('W');
    expect(world.stolen.has('shift+w')).toBe(true);
  });
});

describe('adapter: :sort! (the bang is typeable now)', () => {
  async function sortWith(specs: string[]) {
    const { world, adapter } = await boot('parent');
    const parent = world.rems.get(world.focusedRemId!)!;
    for (const t of ['b', 'c', 'a']) {
      const kid = world.makeRem([t]);
      await kid.setParent(parent._id);
    }
    await type(world, adapter, ['shift+;', 's', 'o', 'r', 't', ...specs, 'enter']);
    return (await parent.getChildrenRem()).map((r) => r.text.join(''));
  }

  it(':sort orders the children, :sort! reverses them', async () => {
    expect(await sortWith([])).toEqual(['a', 'b', 'c']);
    expect(await sortWith(['shift+1'])).toEqual(['c', 'b', 'a']);
  });
});

describe('engine: zt / zz / zb', () => {
  it('zt zz zb emit align and leave the text and cursor alone', () => {
    for (const [keys, where] of [['zt', 'top'], ['zz', 'center'], ['zb', 'bottom']] as const) {
      const e = h('  hello world', 0, 8);
      e.keys(keys);
      expect(e.aligns, keys).toEqual([where]);
      expect(e.line).toBe('  hello world');
      expect(e.caret).toBe(8);
      expect(e.mode).toBe('normal');
    }
  });

  it('z<CR> and z. also move the cursor to the first non-blank', () => {
    const e = h('  hello', 0, 5);
    e.keys('z<cr>');
    expect(e.aligns).toEqual(['top']);
    expect(e.caret).toBe(2);
    const e2 = h('  hello', 0, 5);
    e2.keys('z.');
    expect(e2.aligns).toEqual(['center']);
    expect(e2.caret).toBe(2);
  });

  it('z followed by anything else cancels', () => {
    const e = h('abc');
    e.keys('zq');
    expect(e.aligns).toEqual([]);
    expect(e.state.recording).toBeNull(); // q was eaten by the cancelled z, not a macro start
    e.keys('x');
    expect(e.line).toBe('bc');
  });
});

describe('adapter: zt without a caret position', () => {
  it('toasts instead of walking the cursor around', async () => {
    const { world, adapter } = await boot('abc');
    await type(world, adapter, ['z', 't']);
    expect(world.toasts.at(-1)).toContain('did not report the cursor position');
  });
});
