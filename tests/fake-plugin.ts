/**
 * L3 test double: a hand-rolled RNPlugin implementing exactly the SDK
 * surface VimAdapter touches (verified by grep — ~25 methods). Everything
 * else FAILS FAST: accessing an unmocked namespace member throws, so a new
 * SDK dependency in the adapter surfaces as a loud test failure instead of
 * silent weirdness.
 *
 * The world models:
 * - a single focused editor line (`text`/`caret`/`sel`) with the action
 *   semantics the adapter relies on (selectText/cut/delete/insertPlainText/
 *   moveCaret) — the same model tests/harness.ts proves against the engine;
 * - a tiny rem tree (for the "Vim Keymap" config document);
 * - recorders: toasts, the CURRENT stolen-spec set (maintained from
 *   stealKeys/releaseKeys calls), a chronological call log, storage.
 *
 * Dispatch events like RemNote would with `stealKey(spec)` / `focusChanged()`.
 * The adapter serializes work on a private promise queue — await
 * `drain(adapter)` after dispatching to observe the settled state.
 */
import { AppEvents, SelectionType } from '@remnote/plugin-sdk';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface FakeCall {
  ns: string;
  method: string;
  args: unknown[];
}

export class FakeRem {
  _id: string;
  text: string[];
  parent: string | null = null;
  childIds: string[] = [];
  isDocument = false;
  fontSize: 'H1' | 'H2' | 'H3' | undefined;
  highlightColor: string | undefined;

  constructor(
    private world: FakeWorld,
    id: string,
    text: string[]
  ) {
    this._id = id;
    this.text = text;
  }

  async getChildrenRem(): Promise<FakeRem[]> {
    this.world.log('rem', 'getChildrenRem', this._id);
    return this.childIds.map((id) => this.world.rems.get(id)!).filter(Boolean);
  }
  /** Whole subtree, pre-order — the document row order the adapter assumes. */
  async getDescendants(): Promise<FakeRem[]> {
    this.world.log('rem', 'getDescendants', this._id);
    const out: FakeRem[] = [];
    const walk = (r: FakeRem) => {
      for (const id of r.childIds) {
        const kid = this.world.rems.get(id);
        if (!kid) continue;
        out.push(kid);
        walk(kid);
      }
    };
    walk(this);
    return out;
  }
  async setText(text: string[]) {
    this.world.log('rem', 'setText', this._id, text.join(''));
    this.text = text;
  }
  async setIsDocument(v: boolean) {
    this.isDocument = v;
  }
  async setFontSize(size: 'H1' | 'H2' | 'H3' | undefined) {
    this.world.log('rem', 'setFontSize', this._id, size ?? '');
    this.fontSize = size;
  }
  async setHighlightColor(color: string) {
    this.world.log('rem', 'setHighlightColor', this._id, color);
    this.highlightColor = color;
  }
  async setParent(parent: string | FakeRem | null, pos?: number) {
    const pid = typeof parent === 'string' ? parent : (parent?._id ?? null);
    if (this.parent) {
      const old = this.world.rems.get(this.parent);
      if (old) old.childIds = old.childIds.filter((c) => c !== this._id);
    }
    this.parent = pid;
    if (pid) {
      const p = this.world.rems.get(pid)!;
      const at = pos == null ? p.childIds.length : clamp(pos, 0, p.childIds.length);
      p.childIds.splice(at, 0, this._id);
    }
  }
  async getParentRem(): Promise<FakeRem | undefined> {
    return this.parent ? this.world.rems.get(this.parent) : undefined;
  }
}

export class FakeWorld {
  // ---- recorders
  calls: FakeCall[] = [];
  toasts: string[] = [];
  /** The specs RemNote would currently be stealing for us. */
  stolen = new Set<string>();
  storage = new Map<string, unknown>();
  /** Palette commands registered via app.registerCommand, by id. */
  commands = new Map<string, { name: string; action: () => Promise<void> }>();
  /** Every openFloatingWidget call: [widgetName, position, classContainer, closeOnClickOutside]. */
  floatingOpens: unknown[][] = [];
  /** Floating widget ids currently open (openFloatingWidget adds, closeFloatingWidget removes). */
  openFloating = new Set<string>();
  /** Plugin settings registered/set (registerBooleanSetting defaults land here). */
  settings = new Map<string, unknown>();

  // ---- rem tree
  rems = new Map<string, FakeRem>();
  focusedRemId: string | null = null;
  /** The doc open in the (single) fake pane. */
  paneDocId: string | null = null;
  openedRemIds: string[] = [];

  // ---- the focused editor line
  text = '';
  caret = 0;
  sel: { start: number; end: number } | null = null;
  clipboard: string | null = null;

  private listeners = new Map<string, ((args: unknown) => void)[]>();
  private nextId = 1;

  readonly plugin: unknown;

  constructor() {
    this.plugin = {
      id: 'remnote-vim-test',
      app: this.ns('app', {
        toast: async (m: string) => {
          this.toasts.push(m);
        },
        stealKeys: async (specs: string[]) => {
          this.log('app', 'stealKeys', specs.join(','));
          for (const s of specs) this.stolen.add(s);
        },
        releaseKeys: async (specs: string[]) => {
          this.log('app', 'releaseKeys', specs.join(','));
          for (const s of specs) this.stolen.delete(s);
        },
        registerCSS: async () => {},
        registerCommand: async (opts: { id: string; name: string; action: () => Promise<void> }) => {
          this.commands.set(opts.id, { name: opts.name, action: opts.action });
        },
        registerWidget: async (name: string) => {
          this.log('app', 'registerWidget', name);
        },
      }),
      settings: this.ns('settings', {
        registerBooleanSetting: async (opts: { id: string; defaultValue?: boolean }) => {
          if (!this.settings.has(opts.id)) this.settings.set(opts.id, opts.defaultValue ?? false);
        },
        getSetting: async (id: string) => this.settings.get(id),
      }),
      event: this.ns('event', {
        addListener: (event: string, key: string | undefined, cb: (args: unknown) => void) => {
          const k = `${event}::${String(key)}`;
          this.listeners.set(k, [...(this.listeners.get(k) ?? []), cb]);
        },
      }),
      rem: this.ns('rem', {
        findOne: async (id: string) => this.rems.get(id),
        createRem: async () => this.makeRem([]),
        findByName: async (name: string[]) => {
          const flat = name.join('');
          return [...this.rems.values()].find((r) => r.text.join('') === flat);
        },
      }),
      focus: this.ns('focus', {
        getFocusedRem: async () => (this.focusedRemId ? this.rems.get(this.focusedRemId) : undefined),
      }),
      window: this.ns('window', {
        getFocusedPaneId: async () => 'pane-1',
        getOpenPaneRemId: async () => this.paneDocId ?? undefined,
        getOpenPaneIds: async () => ['pane-1'],
        setFocusedPaneId: async () => {},
        openRem: async (rem: FakeRem) => {
          this.log('window', 'openRem', rem._id);
          this.openedRemIds.push(rem._id);
          this.paneDocId = rem._id;
          this.focusedRemId = rem._id;
        },
        openFloatingWidget: async (...args: unknown[]) => {
          this.log('window', 'openFloatingWidget', args[0]);
          this.floatingOpens.push(args);
          const id = `float-${this.floatingOpens.length}`;
          this.openFloating.add(id);
          return id;
        },
        closeFloatingWidget: async (id: string) => {
          this.log('window', 'closeFloatingWidget', id);
          this.openFloating.delete(id);
        },
        isFloatingWidgetOpen: async (id: string) => this.openFloating.has(id),
      }),
      search: this.ns('search', {
        search: async () => [],
      }),
      richText: this.ns('richText', {
        toString: async (rich: unknown[]) =>
          (rich ?? [])
            .map((x) => (typeof x === 'string' ? x : ((x as { text?: string }).text ?? '')))
            .join(''),
      }),
      storage: this.ns('storage', {
        setSynced: async (k: string, v: unknown) => {
          this.storage.set(k, v);
        },
        getSynced: async (k: string) => this.storage.get(k),
      }),
      editor: this.ns('editor', {
        getFocusedEditorText: async () => (this.focusedRemId == null ? null : [this.text]),
        getSelection: async () =>
          this.sel
            ? {
                type: SelectionType.Text,
                range: { start: this.sel.start, end: this.sel.end },
                isReverse: false,
              }
            : undefined,
        moveCaret: async (delta: number) => {
          this.caret = clamp(this.caret + delta, 0, this.text.length);
        },
        // Walk editor focus one document row up/down, pre-order over the
        // open pane doc's subtree — the same "one bullet per line" order the
        // adapter's walkToBoundary/walkToTarget loops assume. Focus does NOT
        // move onto the doc root itself (matches the live app: gg stops on
        // the first bullet, not the title), so at either boundary focus
        // simply stops changing — exactly the signal those loops terminate
        // on. A no-op when the focused rem isn't a doc row (e.g. the
        // single-scratch-rem setups older tests use).
        moveCaretVertical: async (dir: number) => {
          const doc = this.paneDocId ? this.rems.get(this.paneDocId) : undefined;
          if (!doc || !this.focusedRemId) return;
          const ids = (await doc.getDescendants()).map((r) => r._id);
          const idx = ids.indexOf(this.focusedRemId);
          if (idx < 0) return;
          const next = clamp(idx + Math.sign(dir), 0, ids.length - 1);
          if (next !== idx) this.focusRow(ids[next]);
        },
        selectText: async ({ start, end }: { start: number; end: number }) => {
          const s = clamp(Math.min(start, end), 0, this.text.length);
          const e = clamp(Math.max(start, end), 0, this.text.length);
          if (s === e) {
            this.caret = s;
            this.sel = null;
          } else {
            this.sel = { start: s, end: e };
            this.caret = e;
          }
        },
        cut: async () => {
          if (!this.sel) return;
          this.clipboard = this.text.slice(this.sel.start, this.sel.end);
          this.removeSel();
        },
        delete: async () => {
          if (this.sel) this.removeSel();
        },
        insertPlainText: async (t: string) => {
          this.text = this.text.slice(0, this.caret) + t + this.text.slice(this.caret);
          this.caret += t.length;
          this.sel = null;
        },
        undo: async () => {},
        redo: async () => {},
      }),
    };
  }

  // ------------------------------------------------------------ helpers

  log(ns: string, method: string, ...args: unknown[]) {
    this.calls.push({ ns, method, args });
  }

  /** Namespace proxy: known members pass through, unknown ones throw. */
  private ns<T extends object>(name: string, impl: T): T {
    return new Proxy(impl, {
      get: (target, prop) => {
        if (typeof prop === 'symbol' || prop === 'then' || prop in target) {
          return (target as Record<string | symbol, unknown>)[prop];
        }
        throw new Error(`FakeWorld: unmocked plugin.${name}.${String(prop)}`);
      },
    });
  }

  /** Move editor focus to `id`, syncing the single-line editor model. */
  focusRow(id: string) {
    this.focusedRemId = id;
    const rem = this.rems.get(id);
    this.text = rem ? rem.text.join('') : '';
    this.caret = clamp(this.caret, 0, this.text.length);
    this.sel = null;
  }

  private removeSel() {
    if (!this.sel) return;
    this.text = this.text.slice(0, this.sel.start) + this.text.slice(this.sel.end);
    this.caret = this.sel.start;
    this.sel = null;
  }

  makeRem(text: string[]): FakeRem {
    const rem = new FakeRem(this, `rem-${this.nextId++}`, text);
    this.rems.set(rem._id, rem);
    return rem;
  }

  /**
   * Create a plain document with one child bullet per line, open it in the
   * fake pane and focus the first bullet — the multi-row setup search/`:N`
   * tests need (single-line tests keep using makeRem + direct field pokes).
   */
  seedDoc(lines: string[]): FakeRem {
    const doc = this.makeRem(['Doc']);
    doc.isDocument = true;
    for (const l of lines) {
      const kid = this.makeRem([l]);
      kid.parent = doc._id;
      doc.childIds.push(kid._id);
    }
    this.paneDocId = doc._id;
    if (doc.childIds.length) this.focusRow(doc.childIds[0]);
    return doc;
  }

  /** Create the "Vim Keymap" doc with the given lines and pin it in storage. */
  seedConfigDoc(lines: string[]): FakeRem {
    const doc = this.makeRem(['Vim Keymap']);
    doc.isDocument = true;
    for (const l of lines) {
      const kid = this.makeRem([l]);
      kid.parent = doc._id;
      doc.childIds.push(kid._id);
    }
    this.storage.set('vim-keymap-doc-id', doc._id);
    return doc;
  }

  /** Replace the config doc's lines (like the user editing it). */
  setConfigLines(doc: FakeRem, lines: string[]) {
    for (const id of doc.childIds) this.rems.delete(id);
    doc.childIds = [];
    for (const l of lines) {
      const kid = this.makeRem([l]);
      kid.parent = doc._id;
      doc.childIds.push(kid._id);
    }
  }

  // ------------------------------------------------------------ dispatch

  private emit(event: string, args: unknown) {
    // RemNote dispatches per listenerKey; the adapter registers under its
    // plugin id AND undefined (a hedge) — fire ONE bucket like the app does.
    for (const cb of this.listeners.get(`${event}::undefined`) ?? []) cb(args);
  }

  /** A stolen key arrives (spec string, as RemNote reports it). */
  stealKey(spec: string) {
    this.emit(AppEvents.StealKeyEvent, { key: spec });
  }

  /** Focus moved (the adapter re-checks focus itself — no payload needed). */
  focusChanged() {
    this.emit(AppEvents.FocusedRemChange, {});
  }

  /** A text edit the plugin did not make (native typing / leaked keys). */
  textEdited() {
    this.emit(AppEvents.EditorTextEdited, {});
  }
}

/** Await the adapter's serialized work queue (private, reached for tests). */
export function drain(adapter: unknown): Promise<unknown> {
  return (adapter as { queue: Promise<unknown> }).queue;
}

/** Let fire-and-forget (off-queue) async work settle — e.g. trackConfigFocus. */
export function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
