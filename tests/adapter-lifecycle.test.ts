/**
 * L3 — plugin lifecycle teardown (issue #1: disabling / uninstalling the
 * plugin misbehaved). The real VimAdapter and the real index.tsx
 * onActivate/onDeactivate against the fake plugin: after teardown nothing
 * may stay stolen, drawn, listened to, or scheduled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VimAdapter } from '../src/adapter/adapter';
import { __stub } from './sdk-stub';
import { drain, FakeWorld } from './fake-plugin';

async function boot() {
  const world = new FakeWorld();
  const scratch = world.makeRem(['scratch note']);
  world.focusedRemId = scratch._id;
  world.paneDocId = scratch._id;
  world.text = 'alpha bravo';
  const adapter = new VimAdapter(world.plugin as never);
  await adapter.start('normal');
  await drain(adapter);
  return { world, adapter };
}

const stealCalls = (world: FakeWorld) => world.calls.filter((c) => c.method === 'stealKeys').length;

describe('VimAdapter.stop()', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases every stolen key, clears the badge and removes every listener', async () => {
    const { world, adapter } = await boot();
    expect(world.stolen.size).toBeGreaterThan(0);
    expect(world.css.get('vim-mode')).toContain('NORMAL');
    expect(world.listenerCount()).toBeGreaterThan(0);

    await adapter.stop();

    expect(world.stolen.size).toBe(0);
    expect(world.css.get('vim-mode')).toBe('');
    expect(world.listenerCount()).toBe(0);
  });

  it('cancels the 5 s steal-heal timer', async () => {
    vi.useFakeTimers();
    const { world, adapter } = await boot();
    // Control: the timer is live before stop(), so the check below can fail.
    let before = stealCalls(world);
    await vi.advanceTimersByTimeAsync(5000);
    await drain(adapter);
    expect(stealCalls(world)).toBeGreaterThan(before);

    await adapter.stop();
    before = stealCalls(world);
    await vi.advanceTimersByTimeAsync(30_000);
    await drain(adapter);
    expect(stealCalls(world)).toBe(before);
    expect(world.stolen.size).toBe(0);
  });

  it('work still queued when stop() runs cannot re-steal keys or redraw the badge', async () => {
    const { world, adapter } = await boot();
    await adapter.stop();
    const calls = stealCalls(world);
    // What an in-flight key would reach after teardown: a mode change, the
    // idle-Escape toggle, a badge repaint.
    const internals = adapter as unknown as {
      applyMode(m: string): Promise<void>;
      syncEscapeSteal(): Promise<void>;
      render(): Promise<void>;
    };
    await internals.applyMode('insert');
    await internals.applyMode('normal');
    await internals.syncEscapeSteal();
    await internals.render();
    expect(stealCalls(world)).toBe(calls);
    expect(world.stolen.size).toBe(0);
    expect(world.css.get('vim-mode')).toBe('');
  });

  it('keys delivered after stop() are ignored', async () => {
    const { world, adapter } = await boot();
    await adapter.stop();
    world.text = 'alpha bravo';
    world.caret = 0;
    world.stealKey('x');
    world.stealKey('d');
    world.stealKey('w');
    await drain(adapter);
    expect(world.text).toBe('alpha bravo');
  });
});

describe('plugin lifecycle (real onActivate / onDeactivate)', () => {
  async function activate(world: FakeWorld) {
    (globalThis as { window?: unknown }).window ??= globalThis;
    await import('../src/widgets/index');
    world.storage.set('vim-tutorial-seen', true); // skip the first-run tutorial
    await __stub.onActivate!(world.plugin);
  }
  const liveAdapter = () =>
    (globalThis as unknown as { __vim: { adapter: VimAdapter } }).__vim.adapter;

  it('onDeactivate (disable / uninstall) leaves nothing stolen, drawn or listened to', async () => {
    const world = new FakeWorld();
    await activate(world);
    const adapter = liveAdapter();
    expect(world.stolen.size).toBeGreaterThan(0);

    // Deactivate while activation's config load may still be queued.
    await __stub.onDeactivate!(world.plugin);
    await drain(adapter);

    expect(world.stolen.size).toBe(0);
    expect(world.css.get('vim-mode')).toBe('');
    expect(world.listenerCount()).toBe(0);
  });

  it('a repeat activation stops the previous adapter first', async () => {
    const first = new FakeWorld();
    await activate(first);
    const second = new FakeWorld();
    await activate(second);

    expect(first.stolen.size).toBe(0);
    expect(first.listenerCount()).toBe(0);
    expect(second.stolen.size).toBeGreaterThan(0);
    expect(second.listenerCount()).toBeGreaterThan(0);

    await __stub.onDeactivate!(second.plugin);
    expect(second.stolen.size).toBe(0);
  });
});
