/**
 * L3 — the REAL VimAdapter against the fake plugin (tests/fake-plugin.ts):
 * the integration seams live e2e can only sample, deterministic here.
 * Where the outcome is editor state, the expectation comes from the engine
 * Harness run on the raw expansion — adapter plumbing must reproduce it.
 */
import { describe, expect, it } from 'vitest';
import { VimAdapter } from '../src/adapter/adapter';
import { effectiveSpecs, emptyConfig } from '../src/adapter/mappings';
import { drain, FakeWorld, tick } from './fake-plugin';
import { Harness } from './harness';

async function boot(opts: { config?: string[]; text?: string } = {}) {
  const world = new FakeWorld();
  const configDoc = opts.config != null ? world.seedConfigDoc(opts.config) : null;
  const scratch = world.makeRem(['scratch note']);
  world.focusedRemId = scratch._id;
  world.paneDocId = scratch._id;
  world.text = opts.text ?? 'alpha bravo charlie';
  world.caret = 0;
  const adapter = new VimAdapter(world.plugin as never);
  await adapter.start('normal');
  await drain(adapter); // the initial (queued) config load
  return { world, adapter, configDoc, scratch };
}

/** Dispatch stolen keys like RemNote (spec strings), then settle the queue. */
async function type(world: FakeWorld, adapter: VimAdapter, specs: string[]) {
  for (const s of specs) world.stealKey(s);
  await drain(adapter);
  await tick(); // let fire-and-forget epilogues (wildmenu render) settle
}

/** Escape has its own idle-toggle choreography — compare steal sets without it. */
const minusEsc = (specs: Iterable<string>) => new Set([...specs].filter((s) => s !== 'escape'));

/** What the engine says the editor should look like after `seq` on `line`. */
function predict(line: string, seq: string) {
  const h = new Harness([line]);
  h.keys(seq);
  return { text: h.lines[0], caret: h.caret };
}

const asAny = (adapter: VimAdapter) =>
  adapter as unknown as {
    reloadConfig(notify: boolean): Promise<void>;
    state: { commandLine: string; mode: string };
    jumps: { id: string }[];
  };

describe('1. boot', () => {
  it('steals exactly the base normal-mode set when no config doc exists (silently)', async () => {
    const { world } = await boot();
    expect(minusEsc(world.stolen)).toEqual(minusEsc(effectiveSpecs('normal', emptyConfig())));
    expect(world.toasts).toEqual([]);
  });
  it('applies a seeded config doc at activation', async () => {
    const { world } = await boot({ config: ['nmap <c-j> l'] });
    expect(world.stolen.has('ctrl+j')).toBe(true);
    expect(world.toasts).toEqual([]); // valid config loads silently
  });
});

describe('2. mapped ctrl-chord delivery', () => {
  it('a stolen ctrl+j spec reaches the engine as its expansion', async () => {
    const { world, adapter } = await boot({ config: ['nmap <c-j> l'], text: 'abcdef' });
    await type(world, adapter, ['ctrl+j']);
    expect({ text: world.text, caret: world.caret }).toEqual(predict('abcdef', 'l'));
  });
});

describe('3. queue serialization and gate timing', () => {
  it('d then mapped - dispatched back-to-back = d$ (op-pending expansion)', async () => {
    const { world, adapter } = await boot({ config: ['nmap - gl'] });
    world.stealKey('d');
    world.stealKey('-'); // no await between: the queue must serialize
    await drain(adapter);
    expect(world.text).toBe(predict('alpha bravo charlie', 'dgl').text);
    expect(world.clipboard).toBe('alpha bravo charlie'); // register-worthy delete = native cut
  });
  it('f then mapped - dispatched back-to-back finds the literal char (gate reads pending at processing time)', async () => {
    const { world, adapter } = await boot({ config: ['nmap - gl'], text: 'a-b-c' });
    world.stealKey('f');
    world.stealKey('-');
    await drain(adapter);
    expect({ text: world.text, caret: world.caret }).toEqual(predict('a-b-c', 'f-'));
  });
});

describe('4. mid-rhs mode change', () => {
  it('map <space> ; + "w" + enter runs the Ex command from inside one expansion', async () => {
    const { world, adapter } = await boot({ config: ['map <space> ;'] });
    await type(world, adapter, ['space', 'w', 'enter']);
    expect(world.toasts).toContain('Saved (RemNote autosaves)');
    expect(asAny(adapter).state.mode).toBe('normal');
  });
});

describe('5. :mapload (direct call from queue context — deadlock regression)', () => {
  it('reloads edited config and reports via toast; hangs the suite if ever re-enqueued', async () => {
    const { world, adapter, configDoc } = await boot({ config: ['nmap <c-j> l'] });
    world.setConfigLines(configDoc!, ['nmap <c-j> l', 'nmap - gl']);
    await type(world, adapter, [';', 'm', 'a', 'p', 'l', 'o', 'a', 'd', 'enter']);
    expect(world.toasts.some((t) => /2 mappings/.test(t))).toBe(true);
    expect(world.stolen.has('-')).toBe(true);
    expect(world.stolen.has('ctrl+j')).toBe(true);
  });
});

describe('6. diagnostics', () => {
  it('a silent (boot) reload with errors toasts them; valid lines still apply', async () => {
    const { world, adapter } = await boot({ config: ['nmap $ j', 'nmap - gl'] });
    expect(world.toasts.some((t) => /1 error/.test(t))).toBe(true);
    await type(world, adapter, ['-']);
    expect(world.caret).toBe(predict('alpha bravo charlie', 'gl').caret);
  });
});

describe('7. per-mode steal diffs across mode switches', () => {
  it('nunmap , releases , in normal only; mapped - is stolen in all normal-family modes', async () => {
    const { world, adapter } = await boot({ config: ['nunmap ,', 'nmap - gl'] });
    expect(world.stolen.has(',')).toBe(false);
    expect(world.stolen.has('-')).toBe(true);

    await type(world, adapter, ['v']); // charwise visual
    expect(asAny(adapter).state.mode).toBe('visual');
    expect(world.stolen.has(',')).toBe(true); // unmap was normal-scoped
    expect(world.stolen.has('-')).toBe(true); // union rule

    await type(world, adapter, ['v']); // vv → visual-line
    expect(asAny(adapter).state.mode).toBe('visual-line');
    expect(world.stolen.has(',')).toBe(true);

    await type(world, adapter, ['escape']);
    expect(asAny(adapter).state.mode).toBe('normal');
    expect(world.stolen.has(',')).toBe(false);
  });
  it('insert mode still steals only escape; leaving restores the config set', async () => {
    const { world, adapter } = await boot({ config: ['nunmap ,', 'nmap - gl'] });
    await type(world, adapter, ['i']);
    expect(asAny(adapter).state.mode).toBe('insert');
    expect(world.stolen).toEqual(new Set(['escape']));
    await type(world, adapter, ['escape']);
    expect(asAny(adapter).state.mode).toBe('normal');
    expect(world.stolen.has('-')).toBe(true);
    expect(world.stolen.has(',')).toBe(false);
  });
});

describe('7b. steal self-healing (full-set re-steal)', () => {
  it('a mode change repopulates steals RemNote silently dropped', async () => {
    const { world, adapter } = await boot({ config: ['nmap - gl'] });
    // Simulate the observed live failure: the app forgets every steal while
    // the adapter's bookkeeping still lists them (diff-only stealing would
    // never re-issue and the plugin would be stuck unstolen forever).
    world.stolen.clear();
    await type(world, adapter, ['i']); // any mode transition
    expect(world.stolen).toEqual(new Set(['escape']));
    world.stolen.clear();
    world.stealKey('escape'); // still registered adapter-side; deliver it
    await drain(adapter);
    expect(asAny(adapter).state.mode).toBe('normal');
    expect(world.stolen.has('-')).toBe(true); // full normal set re-asserted
  });
});

describe('8. toggle interplay', () => {
  it('reload while disabled updates tables but steals nothing; toggle-on applies them', async () => {
    const { world, adapter, configDoc } = await boot({ config: ['nmap <c-j> l'] });
    await adapter.toggle(); // off
    expect(world.stolen.size).toBe(0);
    world.setConfigLines(configDoc!, ['nmap <c-k> l']);
    await asAny(adapter).reloadConfig(false); // what a focus trigger would run
    expect(world.stolen.size).toBe(0);
    await adapter.toggle(); // on
    expect(world.stolen.has('ctrl+k')).toBe(true);
    expect(world.stolen.has('ctrl+j')).toBe(false);
  });
});

describe('9. focus-leave auto-reload', () => {
  const configReads = (world: FakeWorld, docId: string) =>
    world.calls.filter(
      (c) => c.ns === 'rem' && c.method === 'getChildrenRem' && c.args[0] === docId
    ).length;

  it('editing a config bullet (parent check) then focusing away reloads once', async () => {
    const { world, adapter, configDoc, scratch } = await boot({ config: ['nmap <c-j> l'] });
    // focus a BULLET inside the doc while the pane shows something else —
    // exercises the focused.parent check, not the pane check
    world.focusedRemId = configDoc!.childIds[0];
    world.focusChanged();
    await tick();
    world.setConfigLines(configDoc!, ['nmap <c-j> l', 'nmap <c-k> h']);
    const before = configReads(world, configDoc!._id);
    world.focusedRemId = scratch._id;
    world.focusChanged(); // leave
    world.focusChanged(); // duplicate event — must not double-reload
    await tick();
    await drain(adapter);
    await tick();
    expect(world.stolen.has('ctrl+k')).toBe(true);
    expect(configReads(world, configDoc!._id)).toBe(before + 1);
  });
  it('focus moves unrelated to the config doc never reload', async () => {
    const { world, adapter, configDoc, scratch } = await boot({ config: ['nmap <c-j> l'] });
    const before = configReads(world, configDoc!._id);
    const other = world.makeRem(['another note']);
    world.focusedRemId = other._id;
    world.focusChanged();
    await tick();
    world.focusedRemId = scratch._id;
    world.focusChanged();
    await tick();
    await drain(adapter);
    expect(configReads(world, configDoc!._id)).toBe(before);
  });
});

describe('10. :config lifecycle', () => {
  it('creates, seeds, pins and opens the doc on first use (a jump)', async () => {
    const { world, adapter, scratch } = await boot();
    await type(world, adapter, [';', 'c', 'o', 'n', 'f', 'i', 'g', 'enter']);
    const doc = [...world.rems.values()].find((r) => r.text.join('') === 'Vim Keymap');
    expect(doc).toBeDefined();
    expect(doc!.isDocument).toBe(true);
    expect(doc!.childIds.length).toBe(3); // seeded comment lines
    expect(world.storage.get('vim-keymap-doc-id')).toBe(doc!._id);
    expect(world.openedRemIds).toContain(doc!._id);
    expect(asAny(adapter).jumps.map((j) => j.id)).toContain(scratch._id); // Ctrl-O returns
  });
  it('a dangling pinned id is recovered by title search (adopt + re-pin, no new doc)', async () => {
    const world = new FakeWorld();
    world.storage.set('vim-keymap-doc-id', 'ghost-id');
    const doc = world.makeRem(['Vim Keymap']);
    doc.isDocument = true;
    const kid = world.makeRem(['nmap <c-j> l']);
    kid.parent = doc._id;
    doc.childIds.push(kid._id);
    const scratch = world.makeRem(['scratch note']);
    world.focusedRemId = scratch._id;
    world.paneDocId = scratch._id;
    world.text = 'alpha';
    const adapter = new VimAdapter(world.plugin as never);
    await adapter.start('normal');
    await drain(adapter);
    expect(world.stolen.has('ctrl+j')).toBe(true); // adopted at boot
    expect(world.storage.get('vim-keymap-doc-id')).toBe(doc._id); // re-pinned
    const docsNamed = [...world.rems.values()].filter((r) => r.text.join('') === 'Vim Keymap');
    await type(world, adapter, [';', 'c', 'o', 'n', 'f', 'i', 'g', 'enter']);
    expect(
      [...world.rems.values()].filter((r) => r.text.join('') === 'Vim Keymap')
    ).toHaveLength(docsNamed.length); // opened, not recreated
  });
});

describe('11. regressions in the refactored handleSym + :map output', () => {
  it('escape still closes the :help floating widget', async () => {
    const { world, adapter } = await boot();
    await type(world, adapter, [';', 'h', 'e', 'l', 'p', 'enter']);
    expect(world.calls.some((c) => c.method === 'openFloatingWidget')).toBe(true);
    await type(world, adapter, ['escape']);
    expect(world.calls.some((c) => c.method === 'closeFloatingWidget')).toBe(true);
  });
  it('tab still cycles the wildmenu in command mode', async () => {
    const { world, adapter } = await boot();
    await type(world, adapter, [';', 'm']);
    await tick(); // suggestions are computed off-queue
    await type(world, adapter, ['tab']);
    expect(asAny(adapter).state.commandLine).toBe('marks'); // first m-catalog entry
    await type(world, adapter, ['escape']);
  });
  it(':map lists mappings and surfaces diagnostics', async () => {
    const { world, adapter } = await boot({ config: ['nmap - gl', 'nmap $ j'] });
    await type(world, adapter, [';', 'm', 'a', 'p', 'enter']);
    expect(world.toasts.some((t) => t.includes('Mappings: nmap - gl'))).toBe(true);
    expect(world.toasts.some((t) => /line 2 error/.test(t))).toBe(true);
  });
});
