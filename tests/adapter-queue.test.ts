/**
 * Flashcard review: while the queue is open vim steps aside — nothing stolen,
 * no badge — so RemNote's own review keys (rating, show answer, …) work.
 * The real VimAdapter on the fake plugin.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { VimAdapter } from '../src/adapter/adapter';
import { drain, FakeWorld, tick } from './fake-plugin';

let running: VimAdapter[] = [];
afterEach(async () => {
  for (const a of running) await a.stop();
  running = [];
});

async function boot(opts: { queueOpen?: boolean } = {}) {
  const world = new FakeWorld();
  const scratch = world.makeRem(['scratch']);
  world.focusedRemId = scratch._id;
  world.paneDocId = scratch._id;
  world.text = 'alpha bravo';
  world.caret = 0;
  if (opts.queueOpen) world.queueRemaining = 5;
  const adapter = new VimAdapter(world.plugin as never);
  running.push(adapter);
  await adapter.start('normal');
  await drain(adapter);
  return { world, adapter };
}

async function settle(adapter: VimAdapter) {
  await drain(adapter);
  await tick();
  await drain(adapter);
}

const internals = (adapter: VimAdapter) =>
  adapter as unknown as { state: { mode: string }; pollQueue(): Promise<void> };

describe('flashcard review pauses vim', () => {
  it('entering the queue releases every key and hides the badge', async () => {
    const { world, adapter } = await boot();
    expect(world.stolen.has('j')).toBe(true);
    expect(world.css.get('vim-mode')).not.toBe('');
    world.queueEntered();
    await settle(adapter);
    expect([...world.stolen]).toEqual([]);
    expect(world.css.get('vim-mode')).toBe('');
  });

  it('leaving the queue steals the normal-mode keys again, in normal mode', async () => {
    const { world, adapter } = await boot();
    world.queueEntered();
    await settle(adapter);
    world.queueExited();
    await settle(adapter);
    for (const spec of ['h', 'j', 'k', 'l', ';', 'shift+a']) {
      expect(world.stolen.has(spec), spec).toBe(true);
    }
    expect(internals(adapter).state.mode).toBe('normal');
    expect(world.css.get('vim-mode')).not.toBe('');
  });

  it('a key that still arrives during review does nothing', async () => {
    const { world, adapter } = await boot();
    world.queueEntered();
    await settle(adapter);
    world.stealKey('x');
    world.stealKey('shift+4');
    await settle(adapter);
    expect(world.text).toBe('alpha bravo');
    expect(world.caret).toBe(0);
  });

  it('focus changes during review do not re-steal (the steal heal is paused)', async () => {
    const { world, adapter } = await boot();
    world.queueEntered();
    await settle(adapter);
    world.focusChanged();
    world.textEdited();
    await settle(adapter);
    expect([...world.stolen]).toEqual([]);
  });

  it('a queue already open at startup is detected: nothing stolen', async () => {
    const { world, adapter } = await boot({ queueOpen: true });
    await settle(adapter);
    expect([...world.stolen]).toEqual([]);
  });

  it('the poll recovers a missed exit event', async () => {
    const { world, adapter } = await boot({ queueOpen: true });
    await settle(adapter);
    world.queueRemaining = undefined; // closed without a QueueExit event
    await internals(adapter).pollQueue();
    await settle(adapter);
    expect(world.stolen.has('j')).toBe(true);
  });

  it('the poll catches a missed enter event', async () => {
    const { world, adapter } = await boot();
    world.queueRemaining = 2;
    await internals(adapter).pollQueue();
    await settle(adapter);
    expect([...world.stolen]).toEqual([]);
  });

  it('vim toggled off before review stays off after it', async () => {
    const { world, adapter } = await boot();
    await adapter.toggle(); // off
    world.queueEntered();
    await settle(adapter);
    world.queueExited();
    await settle(adapter);
    expect([...world.stolen]).toEqual([]);
  });

  it('vim toggled on during review waits for the queue to close', async () => {
    const { world, adapter } = await boot();
    await adapter.toggle(); // off
    world.queueEntered();
    await settle(adapter);
    await adapter.toggle(); // on, still reviewing
    await settle(adapter);
    expect([...world.stolen]).toEqual([]);
    world.queueExited();
    await settle(adapter);
    expect(world.stolen.has('j')).toBe(true);
  });

  it('a pending command from before review does not survive it', async () => {
    const { world, adapter } = await boot();
    world.stealKey('d'); // operator pending
    await settle(adapter);
    world.queueEntered();
    await settle(adapter);
    world.queueExited();
    await settle(adapter);
    world.stealKey('l');
    await settle(adapter);
    expect(world.text).toBe('alpha bravo'); // l moved, it did not complete `dl`
    expect(world.caret).toBe(1);
  });
});
