import {
  AppEvents,
  MoveUnit,
  RNPlugin,
  RichTextInterface,
  SelectionType,
} from '@remnote/plugin-sdk';
import { version as VIM_VERSION } from '../../package.json';
import { handleKey, initialState } from '../engine/engine';
import {
  TUTORIAL_DOC_NAME,
  TUTORIAL_LINES,
  TUTORIAL_OLD_NAME,
  TUTORIAL_VERSION,
} from './tutorialDoc';
import { stopsBetween } from '../engine/motions';
import { Action, Mode, Snapshot, VimState } from '../engine/types';
import { hostDocument, readDomCaret, setDomCaret } from './domCaret';
import {
  effectiveSpecs,
  emptyConfig,
  expandSym,
  listMappingLines,
  MapConfig,
  MapDiagnostic,
  parseMappings,
  specToSymTable,
} from './mappings';
import {
  classifyStrayEdit,
  computeJumpStep,
  cyclePaneId,
  decideRedo,
  decideUndo,
  findSearchMatch,
  flattenRich,
  isDescendantAmong,
  isEscapeWanted,
  JumpEntry,
  reconcileInsertText,
  resolveInsertCaret,
  retryUntilTrue,
  sanitizeInsert,
  SearchUnit,
  settleRead,
  truncateLabel,
  walkParagraph,
  alignCaretRow,
  LineRect,
  newViewGeometry,
  ViewGeometry,
  walkToBoundary,
  walkToRoot,
  walkToTarget,
  wrapIndex,
} from './pure';

export { diffCaret } from './pure';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A register entry: one bullet's rich text plus its whole subtree. */
interface RegisterNode {
  text: RichTextInterface;
  children: RegisterNode[];
}

/**
 * Pane-layout node accepted by the (undocumented) `window.setRemWindowTree`
 * host RPC — react-mosaic shape, probed live: a leaf is a rem id string, a
 * split is {direction, first, second, splitPercentage}. 'row' = side by side
 * (:vsplit), 'column' = stacked (:split). There is no matching getter, so
 * layouts are rebuilt flat from getOpenPaneRemIds when panes change.
 */
type PaneNode =
  | string
  | { direction: 'row' | 'column'; first: PaneNode; second: PaneNode; splitPercentage: number };

/** The SDK's RemObject as returned by rem.findOne (not exported by name). */
type RemObj = NonNullable<Awaited<ReturnType<RNPlugin['rem']['findOne']>>>;

const MODE_COLORS: Record<Mode, string> = {
  normal: '#7c3aed',
  insert: '#059669',
  visual: '#d97706',
  'visual-line': '#d97706',
  command: '#0ea5e9',
  search: '#db2777',
};

/**
 * Brighter variants for RemNote's dark theme (`body.dark` — probed live
 * 2026-07-08): the saturated 600-level colors above read well on white but
 * sink into the dark background, so caret/cursorline use these instead there.
 * The mode badge keeps MODE_COLORS on both themes (white text on saturated
 * background works everywhere).
 */
const MODE_COLORS_DARK: Record<Mode, string> = {
  normal: '#a78bfa',
  insert: '#34d399',
  visual: '#fbbf24',
  'visual-line': '#fbbf24',
  command: '#38bdf8',
  search: '#f472b6',
};

const MODE_LABELS: Record<Mode, string> = {
  normal: 'NORMAL',
  insert: 'INSERT',
  visual: 'VISUAL',
  'visual-line': 'V-LINE',
  command: 'COMMAND',
  search: 'SEARCH',
};

export class VimAdapter {
  /** First debug-badge token: `<package version>@<webpack build time>`, so a
   * stale "no hot reload" plugin load is immediately visible instead of
   * silently running old code. The version is a real module import from
   * package.json — bump it EVERY change round (with public/manifest.json in
   * tandem) and a running dev server picks it up on the next incremental
   * rebuild; the time half (DefinePlugin, see src/global.d.ts) only refreshes
   * when the webpack process itself restarts. */
  private static readonly BUILD = `${VIM_VERSION}@${
    typeof __VIM_BUILD__ !== 'undefined' ? __VIM_BUILD__ : 'dev'
  }`;
  private state: VimState = initialState();
  private queue: Promise<unknown> = Promise.resolve();
  private stolenSpecs = new Set<string>();
  /** replayKeys nesting (dot-repeat, macros). >0 = keys are being re-fed. */
  private replayDepth = 0;
  /** Keys left in the current top-level replay (see exec's replayKeys case). */
  private replayBudget = 0;
  private static readonly REPLAY_MAX_DEPTH = 8;
  private static readonly REPLAY_KEY_BUDGET = 1000;
  /** Line register: cut/yanked bullets INCLUDING their subtrees. */
  private lineRegister: RegisterNode[] = [];
  /**
   * The most recent compound structural op (`pasteRem` / `indentSelection` /
   * `outdentSelection`), reversible/reapplyable directly with the same
   * primitives that performed it — NOT by calling RemNote's own
   * `editor.undo()`/`redo()`. RemNote's undo history records one entry per
   * Rem such an op touches (createRem/setParent), not one per vim command,
   * and there's no way to observe that count from the plugin API — an
   * earlier version of this tried counting native undo-history entries and
   * replaying `editor.undo()` that many times, but it doesn't reliably
   * reverse the whole op in live testing (the exact native granularity isn't
   * 1:1 with what we counted). Reversing it ourselves is correct by
   * construction: no guessing. `structuralApplied` tracks which direction it
   * currently is; any OTHER mutating action clears it entirely (a genuinely
   * new change should make `u` target THAT change, not reach back through
   * this one) — see the `MUTATING_OTHER` check in `applyKey`.
   */
  private structuralOp: { revert: () => Promise<void>; reapply: () => Promise<void> } | null = null;
  /** zt/zz/zb: where each pane's view parks scrolled-in lines (see alignCaretRow). */
  private viewGeo = new Map<string, ViewGeometry>();
  private structuralApplied = true;
  /** Debug trace: which path the last u/C-r actually took, so live testing
   * can confirm the direct-revert path is the one firing. */
  private dbgUndo = '';
  /**
   * Whether `escape` is currently in `stolenSpecs`. Normally always true
   * (every mode needs Escape stolen), except IDLE normal mode (no pending
   * op/count) — RemNote's steal apparently intercepts Escape ahead of its
   * own UI regardless of whether a popup is open, so leaving it stolen while
   * idle swallows the Escape a user presses to close RemNote's own Ctrl-P/
   * Ctrl-K palette. `applyMode` also writes this (it does its own full
   * stolenSpecs diff on every mode transition) — keep both in sync or they
   * fight over whether `escape` is actually registered.
   */
  private escapeWanted = true;
  private enabled = false;
  /**
   * The flashcard queue is open: vim steps aside (nothing stolen, no badge)
   * so RemNote's own review keys work. Separate from `enabled`, which is the
   * user's on/off toggle — leaving the queue restores whatever that says.
   */
  private inQueue = false;
  /** Enabled and not paused for flashcard review: keys are ours. */
  private get active(): boolean {
    return this.enabled && !this.inQueue;
  }
  /** start()'s steal-heal interval (see reassertSteals); stop() clears it. */
  private healTimer: ReturnType<typeof setInterval> | undefined;
  /** One removeListener closure per listener start() registered, for stop(). */
  private unlisteners: (() => void)[] = [];
  /** True while we are applying our own edits (so we ignore our own events). */
  private processing = false;
  /** Fallback caret when the editor reports no selection. */
  private lastCaret = 0;
  // ------------------------------------------------ user keymap (:config)
  /** Parsed user key mappings from the "Vim Keymap" config document. */
  private mapConfig: MapConfig = emptyConfig();
  private mapDiagnostics: MapDiagnostic[] = [];
  /** spec → engine sym for the steal listener; rebuilt with the config so
   * mapped non-base specs (e.g. 'ctrl+j') survive translation. */
  private specToSym: Record<string, string> = specToSymTable(emptyConfig());
  /** The config document's rem id (pinned in synced storage). */
  private configRemId: string | null = null;
  /** The tutorial document's rem id (pinned in synced storage, like config). */
  private tutorialRemId: string | null = null;
  /** Focus tracking: was the previous focus inside the config doc? A true→
   * false transition means the user finished editing it — reload. */
  private focusInConfig = false;
  /** Drops out-of-order async focus checks (FocusedRemChange fires per row). */
  private focusSeq = 0;
  private configReloadQueued = false;
  // debug/instrumentation
  private pluginId = '(none)';
  // Lightweight instrumentation: rx (keys received) and done (keys fully
  // processed) let the e2e harness wait for the plugin's queue to drain.
  private dbgCount = 0;
  private dbgDone = 0;
  private dbgLast = '-';
  /** Line text at the moment insert mode was entered (for caret diffing). */
  private insertEntryText: string | null = null;
  /**
   * Set by an `EditorTextEdited` event while insert mode is active — lets
   * `reconcileAfterInsert` skip its extra confirmatory read when we have
   * independent proof nothing was typed (the common `i<Esc>` idiom), instead
   * of paying a fixed worst-case delay to disambiguate "nothing changed" from
   * "the read is still lagging" on every single Escape.
   */
  private insertSawEdit = false;
  /**
   * Debug trace: last time the leak-resync guard (below) fired, so live
   * testing can confirm it actually engaged.
   */
  private dbgLeak = '';
  /** Debug: ms spent in reconcileAfterInsert vs. applyMode on the last
   * mode-switch action — see the 'mode' case in exec(). */
  private dbgTiming = '';
  /** Visual-line selection: the trail of Rem ids the head has walked. */
  private vTrail: string[] | null = null;
  /** Rem ids currently highlighted (normalized trail) — rendered via CSS. */
  private vSelIds: string[] = [];
  /** Where the last dd / visual-line cut happened, for paste-after-cut. */
  private lastCutSite: { parentId: string | null; pos: number } | null = null;
  /** Debug trace of the last visual-line operation (shown in the badge). */
  private dbgV = '';
  /** Debug: how the last clipboard write went (api/exec/cut/FAIL). */
  private dbgClip = '';
  /**
   * Jumplist (Ctrl-O / Ctrl-I): rem ids recorded when a jump command leaves a
   * position. `jumpPos === jumps.length` means "at the live end" (not
   * currently browsing the list) — vim's model.
   */
  private jumps: JumpEntry[] = [];
  private jumpPos = 0;
  /**
   * Marks (`m<c>` / `'<c>`): mark name → jump entry. The pseudo-mark `'` is
   * auto-set by every recordJump, so `''` returns to the pre-jump rem.
   */
  private marks = new Map<string, JumpEntry>();
  /** Wildmenu: current command-line suggestions (label shown, complete = full command line it expands to). */
  private suggestions: { label: string; complete: string }[] = [];
  /** Index of the suggestion last applied by Tab (-1 = none applied). */
  private suggestIdx = -1;
  /** Monotonic counter so stale async search results can't overwrite newer ones. */
  private suggestSeq = 0;
  /** The pattern from the last `space<pattern><CR>` submit, for `n`/`z` to repeat. */
  private lastSearchPattern: string | null = null;

  constructor(private plugin: RNPlugin) {
    // Dev/e2e introspection hook: lets the CDP harness call SDK methods
    // directly inside the sandbox (e.g. probing editor selection behavior).
    // Sandboxed iframe scope only — invisible to the host page.
    (globalThis as { __vimAdapter?: unknown }).__vimAdapter = this;
  }

  get mode(): Mode {
    return this.state.mode;
  }

  async start(mode: Mode) {
    this.state.mode = mode;
    this.enabled = true;
    // RemNote fires StealKeyEvent with listenerKey = this plugin's id and
    // args = { key: <the is-hotkey spec that matched> }. Register a single
    // listener under the plugin id and translate the spec to an engine symbol.
    const pluginId = (this.plugin as unknown as { id?: string }).id;
    this.pluginId = pluginId ?? '(none)';
    const onSteal = (args: unknown) => {
      const spec = (args as { key?: string } | undefined)?.key;
      this.dbgCount++;
      this.dbgLast = String(spec);
      void this.render();
      if (!spec) return;
      const sym = this.specToSym[spec] ?? (spec.length === 1 ? spec : undefined);
      if (sym == null) return;
      this.enqueue(sym);
    };
    // Register under the plugin id (the documented listenerKey) and also
    // under undefined, as a hedge against dispatch differences.
    this.listen(AppEvents.StealKeyEvent, pluginId, onSteal);
    this.listen(AppEvents.StealKeyEvent, undefined, onSteal);

    // Moving focus to a different Rem invalidates the local line model. (We
    // can't listen to EditorSelectionChanged for same-rem caret moves: our own
    // edits fire it asynchronously and would clobber the model we just built.
    // The snapshot's remId check handles cross-rem focus; a same-rem click is
    // reconciled on the next re-sync.)
    this.listen(AppEvents.FocusedRemChange, undefined, () => {
      if (!this.processing) this.invalidateModel();
      // Config-doc tracking: reload the keymap when focus leaves it.
      void this.trackConfigFocus();
      void this.reassertSteals();
    });

    // A text edit RemNote tells us about while WE are not the one editing
    // (`!this.processing`) can only be native typing that slipped past our
    // key-stealing — normal mode steals every letter, digit and shifted key,
    // but not everything (e.g. '/', '-', modifier combos RemNote owns), so a
    // stray character can still reach the document as literal text while the
    // engine believes nothing changed. Two distinct uses of the same signal:
    //  - insert mode: just remember an edit happened (reconcileAfterInsert
    //    below uses this to skip its own confirmatory read when nothing was
    //    typed, instead of blindly re-reading every time).
    //  - any other mode: the local model and any in-flight pending command
    //    (e.g. `r` waiting for its replacement char) are now stale — drop the
    //    pending state and mark the model dirty so the next keystroke
    //    resyncs instead of computing against a bullet the engine still
    //    thinks is empty (the reported "can't move left/right after typing
    //    capitals into an empty bullet" symptom).
    this.listen(AppEvents.EditorTextEdited, undefined, () => {
      switch (classifyStrayEdit(this.state.mode, this.processing)) {
        case 'ignore':
          return;
        case 'markInsertEdit':
          this.insertSawEdit = true;
          return;
        case 'resetPending':
          this.dbgLeak = `resync@${this.dbgCount}`;
          this.state = { ...this.state, pending: { p: 'none' }, op: null, opCount: '', count: '' };
          this.invalidateModel(true);
          // A stray edit outside insert mode is also the signature of LOST
          // key steals (keys leaking into the document as text) — re-assert.
          void this.reassertSteals();
          return;
      }
    });

    await this.applyMode(this.state.mode);
    // Load the user keymap. Serialized on the key queue and not awaited:
    // keys pressed before it lands use the base bindings.
    this.enqueueTask(() => this.reloadConfig(false));
    // Flashcard review owns its keys (rating, show answer, …). The events
    // switch vim off and on; the same poll that heals steals also catches a
    // missed enter/exit, and the initial check covers a queue already open.
    this.listen(AppEvents.QueueEnter, undefined, () => this.setQueueOpen(true));
    this.listen(AppEvents.QueueLoadCard, undefined, () => this.setQueueOpen(true));
    this.listen(AppEvents.QueueExit, undefined, () => this.setQueueOpen(false));
    await this.pollQueue();
    // Steady-state heal for GC'd steals (see reassertSteals): even with no
    // clicks or leaked keys, a wiped registry recovers within one tick.
    this.healTimer = setInterval(() => {
      void this.pollQueue();
      this.reassertSteals();
    }, 5000);
  }

  /** Ask RemNote whether the queue is open (undefined remaining = closed). */
  private async pollQueue() {
    try {
      const remaining = await this.plugin.queue.getNumRemainingCards();
      this.setQueueOpen(remaining !== undefined);
    } catch (e) {
      console.debug('[vim] queue poll failed', e);
    }
  }

  /**
   * Pause for / resume after flashcard review. The flag flips immediately so
   * keys already in flight see it; the steal/release work runs on the key
   * queue so it can't interleave with an applyMode.
   */
  private setQueueOpen(open: boolean) {
    if (open === this.inQueue) return;
    this.inQueue = open;
    this.enqueueTask(async () => {
      if (this.inQueue !== open || !this.enabled) return;
      if (open) {
        const specs = [...this.stolenSpecs];
        this.stolenSpecs.clear();
        if (specs.length) await this.plugin.app.releaseKeys(specs);
        await this.plugin.app.registerCSS('vim-mode', '');
      } else {
        this.state = { ...initialState(), mode: 'normal' };
        this.structuralOp = null;
        this.invalidateModel();
        await this.applyMode('normal');
      }
    });
  }

  /**
   * Undo everything start() set up. Runs from the plugin's onDeactivate
   * (RemNote deactivates on disable and uninstall) and from onActivate before
   * a replacement adapter starts.
   *
   * The synchronous half comes first and is the part that matters: the SDK
   * does not await onDeactivate, so the RPCs below may never land. Without
   * it the heal timer kept re-stealing every key for a plugin RemNote was
   * unloading — and RemNote's GlobalStealKeySingleton (1.27.10, read from
   * the bundle) loops setState in componentDidUpdate for any stealer whose
   * plugin is unloading/not-loaded, so each re-steal would re-arm that loop
   * (issue #1; DEVELOPMENT.md §9).
   * Deliberately NOT on the key queue: a queue stuck on an unresolved SDK
   * promise (rx ahead of done on the badge) must not block teardown.
   */
  async stop() {
    this.enabled = false;
    if (this.healTimer !== undefined) clearInterval(this.healTimer);
    this.healTimer = undefined;
    for (const off of this.unlisteners.splice(0)) off();
    const specs = [...this.stolenSpecs];
    this.stolenSpecs.clear();
    try {
      if (specs.length) await this.plugin.app.releaseKeys(specs);
      await this.plugin.app.registerCSS('vim-mode', '');
    } catch (e) {
      console.debug('[vim] teardown RPC failed (host already gone?)', e);
    }
  }

  /** The caret's on-screen line rect (zt/zz/zb), from RemNote's getCaretPosition. */
  private async caretRect(): Promise<LineRect | undefined> {
    const r = (await this.plugin.editor.getCaretPosition()) as
      | { top?: number; y?: number; bottom?: number; height?: number }
      | undefined;
    const top = r?.top ?? r?.y;
    if (top === undefined) return undefined;
    return { top, bottom: r?.bottom ?? top + (r?.height ?? 0) };
  }

  /** addListener, remembering the matching removeListener for stop(). */
  private listen(event: string, key: string | undefined, cb: (args: unknown) => void) {
    this.plugin.event.addListener(event, key, cb);
    this.unlisteners.push(() => this.plugin.event.removeListener(event, key, cb));
  }

  async toggle() {
    if (this.enabled) {
      this.enabled = false;
      await this.plugin.app.releaseKeys([...this.stolenSpecs]);
      this.stolenSpecs.clear();
      await this.plugin.app.registerCSS('vim-mode', '');
      await this.plugin.app.toast('Vim mode off');
    } else {
      this.enabled = true;
      this.state = { ...initialState(), mode: 'normal' };
      // Whatever happened while vim mode was off isn't reflected in this —
      // a stale record would misapply to an unrelated future `u`/`C-r`.
      this.structuralOp = null;
      this.escapeWanted = true;
      await this.applyMode('normal');
      await this.plugin.app.toast('Vim mode on');
    }
  }

  /** Serialize key handling: keys can arrive faster than the async API runs. */
  private enqueue(sym: string) {
    this.enqueueTask(() =>
      this.handleSym(sym).catch((e) => console.error('[vim] error handling', sym, e))
    );
  }

  /**
   * Put a task on the same serialized queue as key handling. Config reloads
   * ride it so the mapping tables never swap in the middle of a key.
   * NEVER await a freshly enqueued task from code already running ON the
   * queue (runEx etc.) — it is chained behind the current task: deadlock.
   * Queue-context code calls the work (e.g. reloadConfig) directly instead.
   */
  private enqueueTask(fn: () => Promise<void>) {
    this.queue = this.queue.then(() =>
      fn().catch((e) => console.error('[vim] queued task failed', e))
    );
  }

  private async handleSym(sym: string) {
    if (!this.active) {
      this.dbgDone++;
      return;
    }
    // Escape also dismisses the :help window (RemNote never sees the stolen
    // Escape, so we handle the close ourselves).
    if (sym === 'Escape' && this.helpWidgetId) {
      await this.closeHelp();
    }
    // Tab in command mode cycles the wildmenu — an adapter concern (the
    // candidates come from async searches the pure engine can't run).
    if (this.state.mode === 'command' && sym === 'Tab') {
      this.cycleCompletion();
      this.dbgDone++;
      await this.render();
      return;
    }
    // User mapping: replace the pressed key with its expansion. Decided here
    // (not at enqueue time) so `state.pending` reflects every earlier key;
    // rhs syms run through the same per-key path dot-repeat's replayKeys
    // uses, and are never re-expanded (noremap).
    const rhs = expandSym(this.mapConfig, this.state, sym);
    this.processing = true;
    try {
      for (const s of (rhs ?? [sym]).slice(0, 32)) await this.applyKey(s);
    } finally {
      this.processing = false;
    }
    this.dbgDone++;
    // Recompute wildmenu suggestions for the new command line (async; fire
    // and forget — render() runs again when they arrive).
    if (this.state.mode === 'command') {
      void this.updateSuggestions();
    } else if (this.suggestions.length) {
      this.suggestions = [];
      this.suggestIdx = -1;
    }
    await this.render();
  }

  /**
   * Run one engine key: snapshot → handleKey → execute the emitted actions.
   * Shared by the live key handler and dot-repeat's `replayKeys` (which
   * re-feeds recorded keys exactly like real ones, fresh snapshot per key).
   */
  private async applyKey(sym: string) {
    const snap = await this.snapshot();
    // snapshot() returns a fresh object, never this.model itself, so tagging
    // it is safe. The flag keeps replayed keys out of an active macro
    // recording and inert as q — see the Snapshot doc comment.
    if (this.replayDepth > 0) snap.replaying = true;
    const { state, actions } = handleKey(this.state, sym, snap);
    this.state = state;
    for (const a of actions) {
      // exec sees the pre-action model; update it afterwards so multi-action
      // commands still compose correctly.
      await this.exec(a, snap);
      this.updateModel(a);
      // A genuinely new mutation supersedes any pending structuralOp record
      // — `u` right after this should target THIS change, not reach back
      // through an earlier paste/indent. pasteRem/indentSelection/
      // outdentSelection themselves aren't in this set: they set a fresh
      // structuralOp in their own exec() case, in the same iteration.
      if (VimAdapter.MUTATING_OTHER.has(a.t)) this.structuralOp = null;
    }
    await this.syncEscapeSteal();
  }

  /** See `structuralOp` — action kinds that are plain (non-compound) native
   * mutations and should invalidate any pending structural-undo record. */
  private static readonly MUTATING_OTHER = new Set<Action['t']>([
    'deleteRange',
    'insertText',
    'deleteRem',
    'deleteRemSelection',
    'indent',
    'outdent',
    'joinRem',
    'newBullet',
    'runEx',
  ]);

  /**
   * The line the engine reasons about.
   *
   * RemNote's `getFocusedEditorText()` lags a keystroke or two behind the
   * actual editor after programmatic edits, so re-reading it every key makes
   * rapid command sequences (e.g. `dwA!`) compute offsets against stale text.
   * Instead we keep a local model, updated deterministically from the engine's
   * own actions (exactly like the unit-test harness), and only re-sync from
   * RemNote when the model is invalidated: focus moved, a structural/vertical
   * command ran, or the user typed natively in insert mode.
   */
  private model: { remId: string | undefined; text: string; caret: number } | null = null;

  /**
   * Set when the focused line's TEXT was just mutated through an SDK path the
   * editor-read API lags behind (joinRem's setText, undo/redo, :s). The next
   * snapshot() re-sync then reads until stable instead of trusting the first
   * (possibly pre-mutation) read. Sticky across plain invalidations; cleared
   * only once a settled read has been installed.
   */
  private modelDirty = false;

  private invalidateModel(dirty = false) {
    this.model = null;
    this.modelDirty = this.modelDirty || dirty;
  }

  /**
   * RemNote won't let a Rem's text begin with whitespace — it trims leading
   * spaces after every edit. Mirror that in the model (adjusting the caret) so
   * the engine's offsets keep matching what RemNote actually stores; otherwise
   * an operation that leaves a leading space (e.g. `de` on "world foo") drifts
   * the model one character and corrupts every later command.
   */
  private normalizeModel() {
    const m = this.model;
    if (!m) return;
    const trimmed = m.text.replace(/^\s+/, '');
    const removed = m.text.length - trimmed.length;
    if (removed > 0) {
      m.text = trimmed;
      m.caret = clamp(m.caret - removed, 0, trimmed.length);
    }
  }

  /**
   * Read the focused line's model-space text: null when no editor is focused
   * (transient during structural commands — must NOT be cached as ''), else
   * the flattened rich text (see flattenRich for the offset-space contract).
   */
  private async readLine(): Promise<string | null> {
    const rich = await this.plugin.editor.getFocusedEditorText();
    return rich == null ? null : flattenRich(rich);
  }

  private async snapshot(): Promise<Snapshot> {
    // Trust the local model until it is explicitly invalidated (structural
    // command, leaving insert mode, or a FocusedRemChange event). Re-reading
    // RemNote here — or even calling getFocusedRem to compare ids — is flaky
    // under rapid key sequences and reintroduces the very staleness the model
    // exists to avoid.
    if (this.model) {
      return { text: this.model.text, caret: this.model.caret };
    }
    const focused = await this.plugin.focus.getFocusedRem();
    const remId = focused?._id;
    // After an SDK-side text mutation the read API can still serve the old
    // text — read until two consecutive reads agree before trusting it.
    const line = this.modelDirty
      ? await settleRead(() => this.readLine(), (a, b) => a === b)
      : await this.readLine();
    const text = line ?? '';
    let caret: number | null = null;
    const doc = hostDocument();
    if (doc) caret = readDomCaret(doc); // native: the real caret
    if (caret == null) {
      const sel = await this.plugin.editor.getSelection();
      caret =
        sel && sel.type === SelectionType.Text
          ? sel.isReverse
            ? sel.range.start
            : sel.range.end
          : this.lastCaret;
    }
    caret = clamp(caret, 0, text.length);
    // A failed read (no focused editor) must not poison the model with an
    // empty line — leave it null so the next key re-reads.
    if (line != null) {
      this.model = { remId, text, caret };
      this.modelDirty = false;
    }
    return { text, caret };
  }

  /** Keep the local model in step with an action we are about to execute. */
  private updateModel(a: Action) {
    if (!this.model) return;
    const m = this.model;
    switch (a.t) {
      case 'setCaret':
        m.caret = clamp(a.at, 0, m.text.length);
        break;
      case 'select':
        m.caret = clamp(a.end, 0, m.text.length);
        break;
      case 'deleteRange':
        m.text = m.text.slice(0, a.start) + m.text.slice(a.end);
        m.caret = clamp(a.start, 0, m.text.length);
        // keepLead deletes keep the editor's exact text (no whitespace
        // swallow in exec), so the model must not trim either.
        if (!a.keepLead) this.normalizeModel();
        break;
      case 'insertText': {
        // Mirrors exec: atomic placeholders are stripped before insertion.
        const ins = sanitizeInsert(a.text);
        m.text = m.text.slice(0, a.at) + ins + m.text.slice(a.at);
        m.caret = clamp(a.at + ins.length, 0, m.text.length);
        this.normalizeModel();
        break;
      }
      // Anything that changes the focused rem, its structure, or triggers
      // native typing invalidates the model — re-sync on the next snapshot.
      // (newBullet sets its own fresh model in exec, so it's not listed here.)
      case 'moveVertical':
      case 'deleteRem':
      case 'pasteRem':
      case 'goDoc':
      case 'paragraph':
      case 'align': // walks the caret off the line and back
      case 'indent':
      case 'outdent':
      case 'scroll':
      case 'deleteRemSelection':
      case 'indentSelection':
      case 'outdentSelection':
      case 'clearRemSelection':
      case 'jump': // the caret lands in a different rem
      case 'gotoMark': // ditto
      case 'focusPane':
      case 'vExtend': // the selection head physically moves the caret
      case 'yankRemSelection': // native copy parks the caret on the first line
        this.invalidateModel();
        break;
      // These mutate the FOCUSED line's text through SDK paths the editor
      // read lags behind — mark the model dirty so the next snapshot reads
      // until stable instead of trusting a possibly pre-mutation read.
      case 'undo':
      case 'redo':
      case 'runEx':
      case 'joinRem': // the focused line's text grew by the joined sibling
        this.invalidateModel(true);
        break;
      case 'mode':
      case 'newBullet':
      case 'vStart':
      case 'yankRem': // exec restores the caret column itself after native copy
      case 'copyText':
      case 'setMark': // no document change at all
      case 'replayKeys': // the replayed keys maintain the model themselves
      case 'collapseSelection': // exec sets model.caret itself
      case 'search': // exec's performSearch installs a fresh model itself
      case 'searchStep': // ditto — a no-op when there's no previous search
      case 'toast': // informational only — never touches document or caret
        // newBullet installs its own model in exec; copyText's fallback path
        // maintains the model caret itself in exec; the others don't change
        // the focused line's text. Insert-mode exit is reconciled separately.
        break;
    }
  }

  // ------------------------------------------------------------ actions

  private async exec(a: Action, snap: Snapshot) {
    const { editor, rem, focus } = this.plugin;
    switch (a.t) {
      case 'setCaret': {
        // Move the REAL caret by a relative delta from the model's pre-action
        // position. (MoveUnit.LINE is a no-op in RemNote, but CHARACTER deltas
        // move the live cursor — this is what makes h/l/w/e/0 visible on
        // screen.) moveCaret counts CARET STOPS — one per code point, one per
        // atomic element (probed live 2026-07-08) — not UTF-16 units, so the
        // delta is converted through the model text. exec runs before
        // updateModel, so this.model still holds the pre-action caret.
        const from = this.model?.caret ?? this.lastCaret;
        const to = clamp(a.at, 0, this.model?.text.length ?? a.at);
        const delta = this.model ? stopsBetween(this.model.text, from, to) : to - from;
        if (delta !== 0) {
          await editor.moveCaret(delta, MoveUnit.CHARACTER);
        }
        this.lastCaret = to;
        break;
      }

      case 'select':
        await editor.selectText({ start: a.start, end: a.end });
        this.lastCaret = a.end;
        break;

      case 'collapseSelection': {
        // Clear an active native text selection AND set the caret. A
        // collapsed selectText both collapses the selection and places the
        // caret ABSOLUTELY — the one case where absolute caret setting works
        // (verified live; with no selection it is a no-op, hence the
        // relative-move fallback mirroring setCaret).
        const to = clamp(a.at, 0, this.model?.text.length ?? a.at);
        const sel = await editor.getSelection();
        if (sel && sel.type === SelectionType.Text) {
          await editor.selectText({ start: to, end: to });
        } else {
          const from = this.model?.caret ?? this.lastCaret;
          const delta = this.model ? stopsBetween(this.model.text, from, to) : to - from;
          if (delta !== 0) await editor.moveCaret(delta, MoveUnit.CHARACTER);
        }
        if (this.model) this.model.caret = to;
        this.lastCaret = to;
        break;
      }

      case 'deleteRange': {
        // If the deletion starts at column 0, extend it over any whitespace
        // that would become the new line start: RemNote's data layer trims
        // leading whitespace anyway (while the editor keeps it until later),
        // and deleting it ourselves keeps editor, data layer and model in sync.
        let end = a.end;
        const pre = this.model?.text ?? snap.text;
        if (a.start === 0 && !a.keepLead) {
          while (end < pre.length && /\s/.test(pre[end])) end++;
        }
        if (end > a.start) {
          await editor.selectText({ start: a.start, end });
          // Register-worthy deletes go through the editor's native CUT: same
          // edit, but the removed text also reaches the OS clipboard (vim
          // clipboard=unnamed). cut() runs in the host, so it works despite
          // the sandbox's clipboard restrictions.
          if (a.yank) {
            await editor.cut();
          } else {
            await editor.delete();
          }
        }
        this.lastCaret = a.start;
        break;
      }

      case 'insertText': {
        // Atomic placeholders never reach the document as literal text.
        const ins = sanitizeInsert(a.text);
        await this.insertAt(a.at, ins);
        this.lastCaret = a.at + ins.length;
        break;
      }

      case 'copyText': {
        // Yank without deleting. The real path live is: select the range,
        // native-CUT it (host-side clipboard, always works), and reinsert the
        // same text — net no-op on the document, exact text on the clipboard.
        // The direct sandbox write is tried first only because it's free and
        // may work on hosts other than the desktop app (where it is
        // permission-denied, §9 — watch the clip: badge).
        const ok = await this.writeClipboard(sanitizeInsert(a.text));
        // The cut+reinsert trick would DESTROY atomic elements (the reinsert
        // is plain text, so a cut reference chip could not be restored) —
        // skip it when the range contains one; the vim register still works.
        if (
          !ok &&
          a.start != null &&
          a.end != null &&
          a.end > a.start &&
          a.text === sanitizeInsert(a.text)
        ) {
          await editor.selectText({ start: a.start, end: a.end });
          await editor.cut();
          await editor.insertPlainText(a.text);
          if (this.model) this.model.caret = clamp(a.end, 0, this.model.text.length);
          this.lastCaret = a.end;
        }
        break;
      }

      case 'moveVertical':
        for (let i = 0; i < a.count; i++) {
          await editor.moveCaretVertical(a.dir);
        }
        break;

      case 'undo': {
        // See `structuralOp`: a tracked multi-Rem paste/indent reverses
        // itself directly instead of guessing how many native undo-history
        // entries it produced. Anything else is RemNote's own single-step
        // undo, unchanged from before this ever existed.
        const useStructural = decideUndo(this.structuralOp != null, this.structuralApplied) === 'structuralRevert';
        if (useStructural && this.structuralOp) {
          await this.structuralOp.revert();
          this.structuralApplied = false;
          this.dbgUndo = 'u:structural';
        } else {
          await editor.undo();
          this.dbgUndo = 'u:native';
        }
        break;
      }
      case 'redo': {
        const useStructural = decideRedo(this.structuralOp != null, this.structuralApplied) === 'structuralReapply';
        if (useStructural && this.structuralOp) {
          await this.structuralOp.reapply();
          this.structuralApplied = true;
          this.dbgUndo = 'r:structural';
        } else {
          await editor.redo();
          this.dbgUndo = 'r:native';
        }
        break;
      }

      case 'deleteRem': {
        const rems = await this.focusedPlusFollowing(a.count);
        if (rems.length === 0) break;
        this.lineRegister = [];
        for (const r of rems) {
          this.lineRegister.push(await this.captureSubtree(r));
        }
        await this.cutRems(rems);
        this.lastCaret = 0;
        break;
      }

      case 'yankRem': {
        const rems = await this.focusedPlusFollowing(a.count);
        if (rems.length === 0) break;
        this.lineRegister = [];
        for (const r of rems) this.lineRegister.push(await this.captureSubtree(r));
        // Pane refocus inside nativeClipboardRems puts the caret back at the
        // exact rem+column it had, so the local model stays valid as-is.
        if (!(await this.nativeClipboardRems(rems.map((r) => r._id)))) {
          await this.copyRegisterToClipboard();
        }
        break;
      }

      case 'pasteRem': {
        if (this.lineRegister.length === 0) break;
        // Anchor at the focused rem; after a cut (dd / V…d) focus is often
        // gone, so fall back to the remembered cut site — which is also the
        // vim-correct place to paste the cut lines back.
        let parent: { _id: string } | null = null;
        let at = 0;
        const focused = await focus.getFocusedRem();
        if (focused) {
          parent = (await focused.getParentRem()) ?? null;
          const pos = await this.positionById(focused);
          at = a.where === 'below' ? pos + 1 : pos;
        } else if (this.lastCutSite) {
          parent = this.lastCutSite.parentId
            ? ((await rem.findOne(this.lastCutSite.parentId)) as unknown as { _id: string } | null)
            : null;
          at = this.lastCutSite.pos;
        } else {
          break;
        }
        const atStart = at;
        const pasteParent = parent;
        const register = this.lineRegister;
        const pasteCount = a.count;
        let firstPastedId: string | null = null;
        let createdTopIds: string[] = [];
        for (let i = 0; i < a.count; i++) {
          for (const node of this.lineRegister) {
            const res = await this.pasteSubtree(node, parent, at);
            if (!res) break;
            if (!firstPastedId) firstPastedId = res.id;
            createdTopIds.push(res.id);
            at++;
          }
        }
        // vim puts the cursor on the pasted line
        if (firstPastedId) await this.walkCaretTo(firstPastedId, 1);
        if (createdTopIds.length > 0) {
          // Reversible directly — no need to know how many native
          // undo-history entries the paste produced (see `structuralOp`).
          this.structuralOp = {
            revert: async () => {
              // removeRems (not a bare r.remove() loop) — re-parenting/
              // removing a Rem the caret is sitting in "unmounts its editor
              // and kills the caret" (walkCaretOut's doc comment); removeRems
              // already walks the caret to a safe neighbor first and falls
              // back to clearing one Rem's text if there's nowhere to go.
              const fetched = await Promise.all(createdTopIds.map((id) => rem.findOne(id)));
              const found = fetched.filter((r): r is NonNullable<typeof r> => r != null);
              if (found.length > 0) await this.removeRems(found);
            },
            reapply: async () => {
              let pos = atStart;
              const freshIds: string[] = [];
              let firstId: string | null = null;
              for (let i = 0; i < pasteCount; i++) {
                for (const node of register) {
                  const res = await this.pasteSubtree(node, pasteParent, pos);
                  if (!res) break;
                  if (!firstId) firstId = res.id;
                  freshIds.push(res.id);
                  pos++;
                }
              }
              createdTopIds = freshIds;
              if (firstId) await this.walkCaretTo(firstId, 1);
              this.invalidateModel();
            },
          };
          this.structuralApplied = true;
        }
        break;
      }

      case 'newBullet': {
        // Always a SIBLING (vim o/O), never a child — even when the current
        // bullet has an expanded subtree. The caret then walks visible rows
        // until it lands in the new bullet.
        const focused = await focus.getFocusedRem();
        if (!focused) break;
        const parent = await focused.getParentRem();
        const pos = await this.positionById(focused);
        const created = await rem.createRem();
        if (!created) break;
        await created.setParent(parent ?? null, a.where === 'below' ? pos + 1 : pos);
        await this.walkCaretTo(created._id, a.where === 'below' ? 1 : -1);
        this.model = { remId: created._id, text: '', caret: 0 };
        this.lastCaret = 0;
        break;
      }

      case 'scroll':
        for (let i = 0; i < a.count; i++) {
          await editor.moveCaretVertical(a.dir);
        }
        this.invalidateModel();
        break;

      case 'runEx':
        await this.runEx(a.cmd);
        break;

      case 'focusPane': {
        const panes = await this.plugin.window.getOpenPaneIds();
        const cur = await this.plugin.window.getFocusedPaneId();
        const next = cyclePaneId(panes, cur, a.dir);
        if (!next) break;
        await this.plugin.window.setFocusedPaneId(next);
        this.invalidateModel();
        break;
      }

      case 'indent': {
        const focused = await focus.getFocusedRem();
        if (!focused) break;
        const parent = await focused.getParentRem();
        if (!parent) break;
        // Locate the previous sibling BY ID in the children list —
        // positionAmongstSiblings() races the data layer right after an edit
        // (§9; this bit the smoke suite's paste-then-indent repeatedly).
        const siblings = await parent.getChildrenRem();
        const idx = siblings.findIndex((s) => s._id === focused._id);
        if (idx <= 0) break;
        const prev = siblings[idx - 1];
        if (!prev || prev._id === focused._id) break;
        await focused.setParent(prev, (prev.children ?? []).length);
        break;
      }

      case 'outdent': {
        const focused = await focus.getFocusedRem();
        if (!focused) break;
        const parent = await focused.getParentRem();
        // Top-level bullet (parent is the page/document): vim `<` is a no-op.
        // Without this guard the bullet would be lifted OUT of the document.
        if (!parent || (await parent.isDocument())) break;
        const grand = await parent.getParentRem();
        if (!grand) break;
        const parentPos = await this.positionById(parent);
        await focused.setParent(grand, parentPos + 1);
        break;
      }

      case 'vStart': {
        // Entering visual-line often comes from charwise visual (v→vv, v→j);
        // kill the lingering native text selection or it (and RemNote's
        // selection toolbar) stays on screen for the whole line-wise session.
        const sel = await editor.getSelection();
        if (sel && sel.type === SelectionType.Text && this.model) {
          await editor.selectText({ start: this.model.caret, end: this.model.caret });
        }
        const focused = await focus.getFocusedRem();
        this.dbgV = `anch:${focused ? 'ok' : 'NULL'}`;
        if (!focused) break;
        this.vTrail = [focused._id];
        this.vSelIds = await this.expandWithDescendants([focused._id]);
        break;
      }

      case 'vExtend': {
        // Walk the REAL caret through visible rows (vim's V+j/k), recording
        // the trail. Crossing out of a sibling list into parents, uncles or
        // children works because moveCaretVertical moves by visual rows.
        if (!this.vTrail || this.vTrail.length === 0) break;
        for (let i = 0; i < Math.min(a.count, 300); i++) {
          const headBefore = this.vTrail[this.vTrail.length - 1];
          await editor.moveCaretVertical(a.dir);
          const f = await focus.getFocusedRem();
          if (!f || f._id === headBefore) break; // document boundary
          if (this.vTrail.length >= 2 && this.vTrail[this.vTrail.length - 2] === f._id) {
            this.vTrail.pop(); // stepping back over the trail shrinks it
          } else {
            this.vTrail.push(f._id);
          }
        }
        const units = await this.normalizedTrail();
        this.vSelIds = await this.expandWithDescendants(units);
        this.dbgV = `trail:${this.vTrail.length} units:${units.length} tint:${this.vSelIds.length}`;
        break;
      }

      case 'deleteRemSelection': {
        const rems = await this.vUnits();
        this.dbgV = `DEL n:${rems.length}`;
        if (rems.length === 0) break;
        this.lineRegister = [];
        for (const r of rems) this.lineRegister.push(await this.captureSubtree(r));
        await this.cutRems(rems);
        this.clearVTrail();
        this.invalidateModel();
        break;
      }

      case 'yankRemSelection': {
        const rems = await this.vUnits();
        if (rems.length === 0) break;
        this.lineRegister = [];
        for (const r of rems) this.lineRegister.push(await this.captureSubtree(r));
        if (!(await this.nativeClipboardRems(rems.map((r) => r._id)))) {
          await this.copyRegisterToClipboard();
        }
        // vim leaves the cursor on the first yanked line
        await this.walkCaretTo(rems[0]._id, -1);
        this.clearVTrail();
        break;
      }

      case 'indentSelection':
      case 'outdentSelection': {
        const rems = await this.vUnits();
        if (rems.length === 0) break;
        // Re-parenting the focused Rem unmounts its editor and kills the
        // caret; park the caret on a stable neighbor first.
        await this.walkCaretOut(new Set(rems.map((r) => r._id)));
        // Record each rem's ORIGINAL (parent, position) before moving it, so
        // `u` can restore the exact prior arrangement directly instead of
        // guessing how many native undo-history entries the moves produced
        // (see `structuralOp`) — an extra getChildrenRem() per rem versus the
        // already-optimized forward path below, spent only on building this
        // record; the moved-to (parent, position) is recorded too, so redo
        // doesn't have to re-derive destinations either.
        const moves: {
          id: string;
          fromParentId: string | null;
          fromPos: number;
          toParentId: string | null;
          toPos: number;
        }[] = [];
        if (a.t === 'indentSelection') {
          // vim >: a run of units sharing a parent all tuck under the sibling
          // just above the run's FIRST unit, keeping order. The destination is
          // derived once per run — re-querying positions between setParent
          // calls races RemNote's data layer (a stale read can return the
          // unit itself as its own "previous sibling" and silently no-op).
          let runParent: string | null | undefined;
          let dest: (typeof rems)[number] | null = null;
          let at = 0;
          for (const r of rems) {
            const parent = await r.getParentRem();
            const pid = parent?._id ?? null;
            if (pid !== runParent || !dest) {
              runParent = pid;
              dest = null;
              if (!parent) continue;
              // BY-ID sibling lookup (not positionAmongstSiblings — §9 race;
              // this exact site produced the recurring smoke-suite
              // "paste-then-indent misses beta" flake).
              const siblings = await parent.getChildrenRem();
              const idx = siblings.findIndex((s) => s._id === r._id);
              if (idx <= 0) continue;
              const prev = siblings[idx - 1];
              if (!prev || prev._id === r._id) continue;
              dest = prev;
              at = (prev.children ?? []).length;
            }
            const beforeSiblings = parent ? await parent.getChildrenRem() : [];
            const fromPos = parent ? beforeSiblings.findIndex((s) => s._id === r._id) : 0;
            await r.setParent(dest, at);
            moves.push({ id: r._id, fromParentId: pid, fromPos, toParentId: dest._id, toPos: at });
            at += 1;
          }
        } else {
          // each unit moves to just after its parent; bottom-up keeps the
          // relative order of units that shared a parent
          for (let i = rems.length - 1; i >= 0; i--) {
            const r = rems[i];
            const parent = await r.getParentRem();
            // Never outdent past the page: a top-level bullet stays put
            // (otherwise it would be ejected out of the document).
            if (!parent || (await parent.isDocument())) continue;
            const grand = await parent.getParentRem();
            if (!grand) continue;
            const parentPos = await this.positionById(parent);
            const beforeSiblings = await parent.getChildrenRem();
            const fromPos = beforeSiblings.findIndex((s) => s._id === r._id);
            await r.setParent(grand, parentPos + 1);
            moves.push({
              id: r._id,
              fromParentId: parent._id,
              fromPos,
              toParentId: grand._id,
              toPos: parentPos + 1,
            });
          }
        }
        this.clearVTrail();
        // vim leaves the cursor on the (first) operated line
        await this.walkCaretTo(rems[0]._id, -1);
        this.invalidateModel();
        if (moves.length > 0) {
          const moveIds = new Set(moves.map((mv) => mv.id));
          this.structuralOp = {
            revert: async () => {
              // setParent (like remove) "unmounts its editor and kills the
              // caret" if it's currently focused there — walk it out first,
              // same as the forward operation above, or `u` leaves the
              // cursor unrecoverable without a mouse click.
              await this.walkCaretOut(moveIds);
              // Reverse of application order — undo the LAST move first, the
              // general-purpose safe rule for a sequence of order-dependent
              // position changes.
              for (const mv of [...moves].reverse()) {
                const r = await rem.findOne(mv.id);
                const p = mv.fromParentId ? await rem.findOne(mv.fromParentId) : null;
                if (r) await r.setParent((p as never) ?? null, mv.fromPos);
              }
              this.invalidateModel();
              await this.walkCaretTo(moves[0].id, -1);
            },
            reapply: async () => {
              await this.walkCaretOut(moveIds);
              for (const mv of moves) {
                const r = await rem.findOne(mv.id);
                const p = mv.toParentId ? await rem.findOne(mv.toParentId) : null;
                if (r) await r.setParent((p as never) ?? null, mv.toPos);
              }
              this.invalidateModel();
              await this.walkCaretTo(moves[0].id, -1);
            },
          };
          this.structuralApplied = true;
        }
        break;
      }

      case 'clearRemSelection':
        // the "selection" is CSS-only; the caret stays where the head walked
        this.clearVTrail();
        break;

      case 'goDoc': {
        await this.recordJump(); // gg/G are jumps — Ctrl-O returns here
        const dir = (a.where === 'start' ? -1 : 1) as -1 | 1;
        // moveCaretVertical past the document boundary is a safe no-op — the
        // 'scroll' case above already relies on this unchecked. So batch
        // several hops between focus checks instead of checking after every
        // single one: the previous 1-hop-then-check loop paid TWO async
        // round trips per bullet (moveCaretVertical + getFocusedRem), which
        // is what made this "go bullet by bullet, up to 2s in long
        // documents" — most of that cost was the getFocusedRem() checks, not
        // the moves themselves. Batching cuts the check count ~20-fold at the
        // cost of at most 19 wasted moves once the boundary is hit. Ceiling
        // raised from 200 to 2000 hops too: a document with more visible rows
        // than the old cap would have silently stopped short of the true
        // start/end.
        await walkToBoundary(
          () => editor.moveCaretVertical(dir),
          async () => (await focus.getFocusedRem())?._id
        );
        break;
      }

      case 'paragraph': {
        await this.recordJump(); // { and } are jumps in vim — Ctrl-O returns
        await walkParagraph(
          () => editor.moveCaretVertical(a.dir),
          async () => {
            const f = await focus.getFocusedRem();
            return f ? { id: f._id, empty: flattenRich(f.text).trim() === '' } : undefined;
          },
          a.count
        );
        break;
      }

      case 'align': {
        const pane = (await this.plugin.window.getFocusedPaneId()) ?? '';
        let geo = this.viewGeo.get(pane);
        if (!geo) this.viewGeo.set(pane, (geo = newViewGeometry()));
        // The caret has to travel off-screen and back to make RemNote scroll;
        // hide it and the row tint meanwhile so only the page is seen moving.
        await this.plugin.app.registerCSS(
          'vim-align',
          `html body [contenteditable="true"] { caret-color: transparent !important; }
           html body [data-rem-id]:focus-within { background: none !important; box-shadow: none !important; }`
        );
        let res;
        try {
          res = await alignCaretRow(
            {
              step: (dir) => editor.moveCaretVertical(dir),
              caretRect: () => this.caretRect(),
              rowId: async () => (await focus.getFocusedRem())?._id,
            },
            a.where,
            geo,
            { screenHeight: globalThis.screen?.availHeight }
          );
        } finally {
          await this.plugin.app.registerCSS('vim-align', '');
        }
        if (res === 'unavailable') await this.plugin.app.toast('zt/zz/zb: RemNote did not report the cursor position');
        break;
      }

      case 'jump': {
        const cur = (await focus.getFocusedRem())?._id;
        // Only resolve docId (an SDK call) when computeJumpStep will actually
        // use it — the "stash the live position" branch, first Ctrl-O off it.
        const needsDocId = a.dir === -1 && this.jumpPos === this.jumps.length;
        const docId = needsDocId ? await this.currentDocId() : undefined;
        const step = computeJumpStep(this.jumps, this.jumpPos, a.dir, cur, docId);
        this.jumps = step.jumps;
        this.jumpPos = step.jumpPos;
        if (step.target) await this.focusRemById(step.target.id, step.target.docId);
        break;
      }

      case 'setMark': {
        const f = await focus.getFocusedRem();
        if (f) this.marks.set(a.name, { id: f._id, docId: await this.currentDocId() });
        break;
      }

      case 'gotoMark': {
        const mark = this.marks.get(a.name);
        const target = mark ? await rem.findOne(mark.id) : null;
        if (!target) {
          await this.plugin.app.toast(mark ? `Mark points to a deleted rem: ${a.name}` : `Mark not set: ${a.name}`);
          if (mark) this.marks.delete(a.name);
          break;
        }
        await this.recordJump(); // a mark jump is a jumplist entry (and sets ')
        await this.focusRemById(target._id, mark?.docId);
        break;
      }

      case 'search':
        this.lastSearchPattern = a.pattern;
        await this.performSearch(a.pattern, snap, 1);
        break;

      case 'searchStep':
        if (this.lastSearchPattern == null) {
          await this.plugin.app.toast('No previous search');
          break;
        }
        await this.performSearch(this.lastSearchPattern, snap, a.dir);
        break;

      case 'joinRem': {
        // vim J: count 1 and 2 both join once; 3gj joins three bullets.
        const joins = Math.max(1, a.count - 1);
        for (let i = 0; i < joins; i++) {
          const focused = await focus.getFocusedRem();
          if (!focused) break;
          const parent = await focused.getParentRem();
          if (!parent) break;
          // Find the sibling by id in the children list, NOT via
          // positionAmongstSiblings — that re-query races RemNote's data
          // layer right after an edit (same hazard as indentSelection, §0)
          // and can hand back the focused rem as its own "next sibling".
          const siblings = await parent.getChildrenRem();
          const idx = siblings.findIndex((s) => s._id === focused._id);
          const sib = idx >= 0 ? siblings[idx + 1] : undefined;
          if (!sib || sib._id === focused._id) break;
          // adopt the sibling's children first, then merge its text in
          const kids = await sib.getChildrenRem();
          let at = (focused.children ?? []).length;
          for (const k of kids) await k.setParent(focused, at++);
          const fText = (focused.text ?? []) as RichTextInterface;
          const sText = (sib.text ?? []) as RichTextInterface;
          await focused.setText([...fText, ' ', ...sText] as RichTextInterface);
          await sib.remove();
        }
        break;
      }

      case 'replayKeys': {
        // Dot-repeat AND macro replay share this path. A dot sequence can
        // never contain '.' (a replay is not itself recorded as a change),
        // but a macro CAN invoke gq — even its own register — so recursion
        // is guarded by depth, and total volume by a per-invocation key
        // budget (which also caps `100gqa` on a long macro) instead of the
        // old flat 32-key slice.
        if (this.replayDepth >= VimAdapter.REPLAY_MAX_DEPTH) {
          await this.plugin.app.toast('macro: recursion too deep — stopped');
          break;
        }
        if (this.replayDepth === 0) this.replayBudget = VimAdapter.REPLAY_KEY_BUDGET;
        this.replayDepth++;
        try {
          for (const k of a.keys) {
            if (this.replayBudget-- <= 0) {
              if (this.replayDepth === 1) {
                await this.plugin.app.toast('macro: replay stopped (key budget exhausted)');
              }
              break;
            }
            await this.applyKey(k);
          }
        } finally {
          this.replayDepth--;
        }
        break;
      }

      case 'toast':
        await this.plugin.app.toast(a.msg);
        break;

      case 'mode': {
        // Timing breakdown for the insert→normal path specifically — shown
        // in the debug badge as `t:recon=..ms mode=..ms` so a further latency
        // report can point at which half is actually slow instead of
        // guessing blind.
        const t0 = Date.now();
        if (a.mode === 'insert') {
          // Put the *real* caret where the model says before native typing
          // begins, then remember the line so we can recover the caret on exit.
          const m = this.model;
          if (m) await this.setCaretAbs(m.caret, m.text.length);
          this.insertEntryText = m?.text ?? snap.text;
          this.insertSawEdit = false;
        } else if (this.insertEntryText != null) {
          await this.reconcileAfterInsert();
        }
        const t1 = Date.now();
        await this.applyMode(a.mode);
        const t2 = Date.now();
        this.dbgTiming = `t:recon=${t1 - t0}ms mode=${t2 - t1}ms`;
        break;
      }
    }
  }

  /**
   * Insert `text` at offset `at`: walk the real caret there with a relative
   * CHARACTER move from the model's pre-action position, then insert. Used by
   * `r`, backtick (case toggle), and character-register `p`.
   */
  private async insertAt(at: number, text: string) {
    const { editor } = this.plugin;
    const from = this.model?.caret ?? this.lastCaret;
    const len = this.model?.text.length ?? at;
    const to = clamp(at, 0, len);
    const delta = this.model ? stopsBetween(this.model.text, from, to) : to - from;
    if (delta !== 0) {
      await editor.moveCaret(delta, MoveUnit.CHARACTER);
    }
    await editor.insertPlainText(text);
  }

  /**
   * Move the real caret to offset `at` via a relative delta (in caret STOPS,
   * see the setCaret case) from the model's current position — the one caret
   * primitive RemNote honors.
   */
  private async setCaretAbs(at: number, textLen: number) {
    const from = this.model?.caret ?? this.lastCaret;
    const to = clamp(at, 0, textLen);
    const delta = this.model ? stopsBetween(this.model.text, from, to) : to - from;
    if (delta !== 0) {
      await this.plugin.editor.moveCaret(delta, MoveUnit.CHARACTER);
    }
  }

  /**
   * Leaving insert mode: re-read the line, take the real caret if we can.
   *
   * The editor read API lags native typing — a single immediate read after a
   * fast type-then-Escape can return the line MISSING the last typed
   * characters, and the truncated model then makes every EOL computation land
   * a few characters short (the user-reported "cursor believes it is at the
   * end of line" bug). Read until two consecutive reads agree; if the line
   * still looks EXACTLY like it did when insert began (either nothing was
   * typed or the flush hasn't happened yet — indistinguishable), give it one
   * more, longer-spaced confirmation read.
   */
  private async reconcileAfterInsert() {
    const pre = this.insertEntryText ?? '';
    this.insertEntryText = null;
    // If no EditorTextEdited event fired while insert mode was active, we
    // have independent proof nothing was typed — skip reading the editor at
    // all (no network/IPC round trip to confirm something already certain).
    // This is a real bet on EditorTextEdited firing reliably for every native
    // edit; if that ever turns out to be wrong, the fallback (used whenever
    // an edit WAS seen) is completely unchanged from before this shortcut
    // existed, so the exposure is bounded to this one branch.
    const fresh = await reconcileInsertText(pre, this.insertSawEdit, () => this.readLine());
    if (fresh == null) {
      // No focused editor (focus lost mid-insert) — never install an empty
      // model over a line that still has text; re-read on the next key.
      this.invalidateModel();
      return;
    }
    const doc = hostDocument();
    const domCaret = doc ? readDomCaret(doc) : null;
    const caret = resolveInsertCaret(domCaret, pre, fresh, this.model?.caret ?? 0);
    const remId = this.model?.remId;
    this.model = { remId, text: fresh, caret };
    this.lastCaret = caret;
  }

  // ------------------------------------------------- Ex commands

  /**
   * Execute an Ex command line (the text after `:`). RemNote autosaves, so the
   * write/quit family is mostly acknowledgement; `:e`/`:find` do a real search
   * and open the top hit; `:Ex` can't pop the native omnibar (no SDK hook) so
   * it points the user at Ctrl/Cmd-P.
   */
  private async runEx(cmd: string) {
    // Verbs are matched case-insensitively (':Ex' and ':ex' both work).
    const [verbRaw, ...restParts] = cmd.split(/\s+/);
    const verb = verbRaw.toLowerCase();
    const arg = restParts.join(' ').trim();
    const app = this.plugin.app;

    // :s/pat/repl/[flags] — the separator touches the verb (no whitespace),
    // so it can't go through the verb switch. Vim's range prefixes are
    // untypeable live ('%' arrives as '5', '<'/'>' as ','/'.'): the visual
    // selection is the implicit range instead (vim-style), and the `a` flag
    // spells "all bullets of the current document" (vim's %).
    const subst = cmd.match(
      /^s(?:ubstitute)?\/((?:\\.|[^/])*)(?:\/((?:\\.|[^/])*)(?:\/([a-z]*))?)?$/i
    );
    if (subst) {
      await this.substitute(subst[1], subst[2] ?? '', (subst[3] ?? '').toLowerCase());
      return;
    }

    // :g/pat/d — delete every bullet of the document whose text matches
    // (vim's :global; `d` is the only supported sub-command).
    const glob = cmd.match(/^(?:g|global)\/((?:\\.|[^/])*)(?:\/([a-z]*))?$/i);
    if (glob) {
      await this.globalDelete(glob[1], (glob[2] ?? '').toLowerCase());
      return;
    }

    // :N — jump to the Nth bullet (Rem) from the top of the document (vim's
    // line-number range prefix; this codebase's "line" = one Rem). A bare
    // digit string is not verb-shaped, so — like :s/:g above — it's matched
    // before the verb switch rather than falling through split(/\s+/).
    if (/^\d+$/.test(cmd.trim())) {
      await this.recordJump(); // :N is a jump — Ctrl-O returns here
      await this.gotoLine(parseInt(cmd.trim(), 10));
      return;
    }

    switch (verb) {
      case 'w':
      case 'write':
      case 'w!':
        await app.toast('Saved (RemNote autosaves)');
        return;
      case 'wq':
      case 'x':
      case 'x!':
      case 'wq!':
        await app.toast('Saved (RemNote autosaves)');
        return;
      case 'q':
      case 'q!':
      case 'quit':
        // vim semantics: with a split open, :q closes the focused pane;
        // on the last pane there is nothing to quit (always-saved outliner).
        await this.closePane();
        return;
      case 'vs':
      case 'vsp':
      case 'vsplit':
        await this.splitPane('row', arg);
        return;
      case 'sp':
      case 'split':
        await this.splitPane('column', arg);
        return;
      case 'on':
      case 'only':
        await this.onlyPane();
        return;
      case 'e':
      case 'edit':
      case 'find':
      case 'f':
        if (!arg) {
          await app.toast('Usage: :e <rem name>');
          return;
        }
        await this.recordJump(); // :e is a jump — Ctrl-O comes back
        await this.openByName(arg);
        return;
      case 'ex':
      case 'explore':
        await app.toast('Open the Rem explorer with Ctrl/Cmd-P');
        return;
      case 'sort':
        await this.sortBullets(arg);
        return;
      case 'sort!': // vim's bang = reverse
        await this.sortBullets(`${arg} rev`);
        return;
      case 't':
      case 'co':
      case 'copy':
        await this.duplicateBullets();
        return;
      case 'd':
      case 'delete':
        await this.deleteBullets();
        return;
      case 'y':
      case 'yank':
        await this.yankBullets();
        return;
      case 'marks':
        await this.listMarks();
        return;
      // (:todo/:done/:untodo were removed — RemNote's own slash-command menu
      // on '/' covers rem-type changes; the vim command line only carries
      // things RemNote has no native affordance for.)
      case 'help':
      case 'h':
        await this.openHelp();
        return;
      case 'config':
        await this.openConfig();
        return;
      case 'tutorial':
      case 'vimtutor':
        await this.openTutorial();
        return;
      case 'map':
        await this.listMappings();
        return;
      // NOTE: called directly, not enqueued — runEx is already ON the key
      // queue and awaiting a freshly enqueued task would deadlock it.
      case 'mapload':
        await this.reloadConfig(true);
        return;
      case 'nmap':
      case 'vmap':
      case 'noremap':
      case 'nnoremap':
      case 'vnoremap':
      case 'imap':
      case 'unmap':
      case 'nunmap':
      case 'vunmap':
        await app.toast('Mappings live in the "Vim Keymap" document — :config to edit');
        return;
      default:
        await app.toast(`Not an editor command: ${cmd} — try :help`);
    }
  }

  /** The rems a bulk Ex command acts on: selection units, else the focused rem. */
  private async exTargets() {
    const units = await this.vUnits();
    if (units.length > 0) return units;
    const f = await this.plugin.focus.getFocusedRem();
    return f ? [f] : [];
  }

  /**
   * `:s/pat/repl/[flags]` — vim substitute over RemNote rich text.
   *
   * Pattern/replacement use JS regex semantics (vim's \1 backrefs are
   * translated to $1). Flags: `g` = every match per text run (else first
   * match per bullet), `i` = ignore case, `a` = all bullets of the current
   * document (vim's untypeable `%`). Range: the visual selection when one is
   * active, else the focused bullet. Only PLAIN string segments of the rich
   * text are touched — references/formatting objects are left intact, and a
   * match can't span across them.
   */
  private async substitute(pat: string, repl: string, flags: string) {
    const app = this.plugin.app;
    if (!pat) {
      await app.toast('Usage: :s/pattern/replacement/[gia]');
      return;
    }
    let re: RegExp;
    try {
      re = new RegExp(pat, `${flags.includes('g') ? 'g' : ''}${flags.includes('i') ? 'i' : ''}`);
    } catch {
      await app.toast(`Bad pattern: /${pat}/`);
      return;
    }
    // Escaped separators arrive as '\/'; vim backrefs \1..\9 become JS $1..$9.
    const replacement = repl.replace(/\\\//g, '/').replace(/\\(\d)/g, '$$$1');

    let targets = await this.exTargets();
    if (flags.includes('a')) {
      const paneRemId = await this.plugin.window.getOpenPaneRemId(
        await this.plugin.window.getFocusedPaneId()
      );
      const doc = paneRemId ? await this.plugin.rem.findOne(paneRemId) : null;
      const all = doc ? await doc.getDescendants() : [];
      if (all.length > 0) targets = all.slice(0, 500);
    }
    if (targets.length === 0) {
      await app.toast('No bullet to act on');
      return;
    }

    const focusedId = (await this.plugin.focus.getFocusedRem())?._id;
    let bullets = 0;
    let hits = 0;
    let touchedFocused = false;
    for (const r of targets) {
      const rich = (r.text ?? []) as unknown[];
      let remHits = 0;
      const next = rich.map((seg) => {
        if (typeof seg !== 'string') return seg;
        if (remHits > 0 && !flags.includes('g')) return seg; // first match per bullet
        return seg.replace(re, (...args) => {
          remHits++;
          const whole = args[0] as string;
          const groups = args.slice(1, -2) as (string | undefined)[];
          // manual $-expansion ($$, $&, $1..$9) — can't re-run `re` inside
          // its own replace callback (lastIndex corruption on /g)
          return replacement
            .replace(/\$\$/g, '\u0000')
            .replace(/\$&/g, whole)
            .replace(/\$(\d)/g, (_, d: string) => groups[+d - 1] ?? '')
            .replace(/\u0000/g, '$');
        });
      });
      if (remHits > 0) {
        await r.setText(next as RichTextInterface);
        bullets++;
        hits += remHits;
        if (r._id === focusedId) touchedFocused = true;
      }
    }
    if (touchedFocused) this.invalidateModel();
    await app.toast(
      hits === 0
        ? `Pattern not found: /${pat}/`
        : `${hits} substitution${hits > 1 ? 's' : ''} on ${bullets} bullet${bullets > 1 ? 's' : ''}`
    );
  }

  /**
   * `:d` — delete the selected bullets (or the focused one) with subtrees,
   * exactly like `dd`/visual-`d`: register + OS clipboard + caret rescue.
   */
  private async deleteBullets() {
    const targets = await this.exTargets();
    if (targets.length === 0) {
      await this.plugin.app.toast('No bullet to delete');
      return;
    }
    this.lineRegister = [];
    for (const r of targets) this.lineRegister.push(await this.captureSubtree(r));
    await this.cutRems(targets);
    this.state = { ...this.state, register: { kind: 'line' } }; // p pastes it back
    this.invalidateModel();
  }

  /** `:y` — yank the selected bullets (or the focused one), like `yy`. */
  private async yankBullets() {
    const targets = await this.exTargets();
    if (targets.length === 0) {
      await this.plugin.app.toast('No bullet to yank');
      return;
    }
    this.lineRegister = [];
    for (const r of targets) this.lineRegister.push(await this.captureSubtree(r));
    if (!(await this.nativeClipboardRems(targets.map((r) => r._id)))) {
      await this.copyRegisterToClipboard();
    }
    this.state = { ...this.state, register: { kind: 'line' } };
    await this.plugin.app.toast(`${targets.length} bullet${targets.length > 1 ? 's' : ''} yanked`);
  }

  /**
   * `:t` (also `:co[py]`) — duplicate the selected bullets (or the focused
   * one) with their subtrees, inserted right below the last selected unit.
   */
  private async duplicateBullets() {
    const targets = await this.exTargets();
    if (targets.length === 0) {
      await this.plugin.app.toast('No bullet to duplicate');
      return;
    }
    const last = targets[targets.length - 1];
    const parent = await last.getParentRem();
    let at = (await this.positionById(last)) + 1;
    let firstId: string | null = null;
    for (const r of targets) {
      const node = await this.captureSubtree(r);
      const res = await this.pasteSubtree(node, parent, at++);
      if (!firstId && res) firstId = res.id;
    }
    if (firstId) await this.walkCaretTo(firstId, 1);
    this.invalidateModel();
  }

  /**
   * `:sort [n] [rev]` — with a visual selection: sort the selected sibling
   * bullets; without: sort the focused bullet's CHILDREN (the useful outliner
   * reading of vim's line sort). `n` compares leading numbers, `rev` (or
   * vim's `:sort!`) reverses.
   */
  private async sortBullets(arg: string) {
    const app = this.plugin.app;
    const flags = new Set(arg.toLowerCase().split(/\s+/).filter(Boolean));
    const units = await this.vUnits();
    let rems;
    let parent;
    if (units.length >= 2) {
      parent = await units[0].getParentRem();
      rems = [];
      for (const u of units) {
        const p = await u.getParentRem();
        if (p?._id === parent?._id) rems.push(u);
      }
    } else {
      const f = await this.plugin.focus.getFocusedRem();
      if (!f) {
        await app.toast('Nothing to sort (select bullets or focus a parent)');
        return;
      }
      parent = f;
      rems = await f.getChildrenRem();
    }
    if (!parent || rems.length < 2) {
      await app.toast('Nothing to sort');
      return;
    }
    const keyed: { r: (typeof rems)[number]; key: string; pos: number }[] = [];
    for (const r of rems) {
      keyed.push({
        r,
        key: (await this.plugin.richText.toString((r.text ?? []) as RichTextInterface)) ?? '',
        pos: (await r.positionAmongstSiblings()) ?? 0,
      });
    }
    const minPos = Math.min(...keyed.map((k) => k.pos));
    keyed.sort((a, b) =>
      flags.has('n')
        ? (parseFloat(a.key) || 0) - (parseFloat(b.key) || 0)
        : a.key.localeCompare(b.key)
    );
    if (flags.has('rev')) keyed.reverse();
    // Refill the block of sibling slots the rems came from, in sorted order.
    for (let i = 0; i < keyed.length; i++) {
      await keyed[i].r.setParent(parent, minPos + i);
    }
    this.invalidateModel();
    await app.toast(`${keyed.length} bullets sorted`);
  }

  /**
   * Every Rem in the currently open document, top-to-bottom traversal order
   * (assumed from `getDescendants()` — this codebase's only whole-document
   * enumeration primitive), capped at 500 like `:g/pattern/d` always was to
   * keep a single scan bounded on huge documents. Shared by `globalDelete`
   * and the space-search feature: both need "every Rem's text, in order".
   */
  private async allDocumentRems() {
    const paneRemId = await this.plugin.window.getOpenPaneRemId(
      await this.plugin.window.getFocusedPaneId()
    );
    const doc = paneRemId ? await this.plugin.rem.findOne(paneRemId) : null;
    return doc ? (await doc.getDescendants()).slice(0, 500) : [];
  }

  /** `:g/pat/d` — delete every matching bullet (subtree included) in the doc. */
  private async globalDelete(pat: string, cmdFlag: string) {
    const app = this.plugin.app;
    if (cmdFlag !== 'd' && cmdFlag !== 'delete') {
      await app.toast('Only :g/pattern/d is supported');
      return;
    }
    if (!pat) {
      await app.toast('Usage: :g/pattern/d');
      return;
    }
    let re: RegExp;
    try {
      re = new RegExp(pat);
    } catch {
      await app.toast(`Bad pattern: /${pat}/`);
      return;
    }
    const all = await this.allDocumentRems();
    const matches = [];
    for (const r of all) {
      const txt = (await this.plugin.richText.toString((r.text ?? []) as RichTextInterface)) ?? '';
      if (re.test(txt)) matches.push(r);
    }
    // A matching ancestor already takes its subtree — drop covered matches.
    const ids = new Set(matches.map((r) => r._id));
    const units = [];
    for (const r of matches) {
      let covered = false;
      let cur: { parent?: string } | null = r as unknown as { parent?: string };
      for (let hop = 0; cur?.parent && hop < 20; hop++) {
        if (ids.has(cur.parent)) {
          covered = true;
          break;
        }
        cur = (await this.plugin.rem.findOne(cur.parent)) as unknown as { parent?: string } | null;
      }
      if (!covered) units.push(r);
    }
    if (units.length === 0) {
      await app.toast(`Pattern not found: /${pat}/`);
      return;
    }
    this.lineRegister = [];
    for (const r of units) this.lineRegister.push(await this.captureSubtree(r));
    await this.cutRems(units);
    this.state = { ...this.state, register: { kind: 'line' } };
    this.invalidateModel();
    await app.toast(`${units.length} bullet${units.length > 1 ? 's' : ''} deleted`);
  }

  /** `:marks` — list the set marks in a toast. */
  private async listMarks() {
    if (this.marks.size === 0) {
      await this.plugin.app.toast('No marks set');
      return;
    }
    const parts: string[] = [];
    for (const [name, mark] of this.marks) {
      const r = await this.plugin.rem.findOne(mark.id);
      const txt = r
        ? ((await this.plugin.richText.toString((r.text ?? []) as RichTextInterface)) ?? '')
        : '(deleted)';
      parts.push(`${name} → ${txt.slice(0, 24)}`);
    }
    await this.plugin.app.toast(`Marks: ${parts.join('  |  ')}`);
  }

  /** Floating widget id of the open :help window, if any. */
  private helpWidgetId: string | null = null;

  /** Open (or re-open) the :help cheat-sheet window. */
  async openHelp() {
    await this.closeHelp();
    this.helpWidgetId = await this.plugin.window.openFloatingWidget(
      'vim_help',
      { top: 55, left: 80 },
      undefined,
      true // close when clicking outside
    );
  }

  private async closeHelp() {
    if (this.helpWidgetId) {
      await this.plugin.window.closeFloatingWidget(this.helpWidgetId).catch(() => {});
      this.helpWidgetId = null;
    }
  }

  /** `:e <name>` — search for a Rem by name and open the best match. */
  // ------------------------------------------------- wildmenu (command-line suggestions)

  /** The Ex command catalog the wildmenu offers. */
  private static readonly EX_COMMANDS: { verb: string; hint: string; arg?: 'rem' | 'none' }[] = [
    { verb: 'e', hint: 'open document (search)', arg: 'rem' },
    { verb: 's/', hint: 'substitute  s/pat/repl/[gia]', arg: 'none' },
    { verb: 'g/', hint: 'global delete  g/pat/d', arg: 'none' },
    { verb: 'sort', hint: 'sort bullets  sort [n] [rev]', arg: 'none' },
    { verb: 't', hint: 'duplicate bullet(s)', arg: 'none' },
    { verb: 'd', hint: 'delete bullet(s)', arg: 'none' },
    { verb: 'y', hint: 'yank bullet(s)', arg: 'none' },
    { verb: 'marks', hint: 'list marks', arg: 'none' },
    { verb: 'config', hint: 'edit custom keybindings', arg: 'none' },
    { verb: 'tutorial', hint: 'open the practice document', arg: 'none' },
    { verb: 'map', hint: 'list key mappings + issues', arg: 'none' },
    { verb: 'mapload', hint: 'reload keybindings', arg: 'none' },
    { verb: 'vs', hint: 'vertical split [document]', arg: 'rem' },
    { verb: 'sp', hint: 'horizontal split [document]', arg: 'rem' },
    { verb: 'q', hint: 'close pane', arg: 'none' },
    { verb: 'only', hint: 'single pane', arg: 'none' },
    { verb: 'help', hint: 'cheat sheet', arg: 'none' },
    { verb: 'w', hint: 'save (RemNote autosaves)', arg: 'none' },
  ];

  /**
   * Recompute the wildmenu for the current command line. Verb position →
   * filter the catalog; argument position of a rem-taking verb (:e, :vs,
   * :sp) → live document search. Async: a seq counter drops stale results.
   */
  private async updateSuggestions() {
    const seq = ++this.suggestSeq;
    this.suggestIdx = -1;
    const line = this.state.commandLine;
    const argMatch = line.match(/^(\S+)\s+(.*)$/);

    if (!argMatch) {
      // verb position (also covers the empty line = full catalog)
      this.suggestions = VimAdapter.EX_COMMANDS.filter((c) =>
        c.verb.startsWith(line.toLowerCase())
      ).map((c) => ({
        label: `:${c.verb}  — ${c.hint}`,
        complete: c.arg === 'rem' ? `${c.verb} ` : c.verb,
      }));
      await this.render();
      return;
    }

    const verb = argMatch[1].toLowerCase();
    const arg = argMatch[2];
    const takesRem = ['e', 'edit', 'find', 'f', 'vs', 'vsp', 'vsplit', 'sp', 'split'].includes(verb);
    if (!takesRem || arg.length === 0) {
      this.suggestions = [];
      await this.render();
      return;
    }
    try {
      const results = await this.plugin.search.search([arg]);
      if (seq !== this.suggestSeq) return; // a newer keystroke superseded us
      // Same-named rems (and search-index residue) produce identical rows the
      // user can't tell apart — collapse them; opening picks the top hit anyway.
      const seen = new Set<string>();
      this.suggestions = (results ?? [])
        .map((r) => {
          const name = (r.text ?? [])
            .map((x) => (typeof x === 'string' ? x : ((x as { text?: string }).text ?? '')))
            .join('');
          // The full (untruncated) name still completes the command line —
          // only the on-screen label is clipped, so Tab-completing a long
          // Rem name isn't affected.
          return { label: truncateLabel(name), complete: `${argMatch[1]} ${name}` };
        })
        .filter((s) => s.label !== '' && !seen.has(s.complete) && (seen.add(s.complete), true))
        .slice(0, 5);
    } catch {
      this.suggestions = [];
    }
    if (seq === this.suggestSeq) await this.render();
  }

  /** Tab: apply the next wildmenu entry to the command line (cycles). */
  private cycleCompletion() {
    if (this.state.mode !== 'command' || this.suggestions.length === 0) return;
    this.suggestIdx = (this.suggestIdx + 1) % this.suggestions.length;
    this.state = {
      ...this.state,
      commandLine: this.suggestions[this.suggestIdx].complete,
    };
  }

  // ------------------------------------------------- panes (:vs/:sp/:q/:on)

  /** Raw host RPC — the pane layout has no typed SDK surface (probed live). */
  private winCall(method: string, args: unknown): Promise<unknown> {
    return (
      this.plugin.window as unknown as {
        call: (m: string, a?: unknown) => Promise<unknown>;
      }
    ).call(method, args);
  }

  /** Current panes as an ordered doc-id list plus the focused index. */
  private async paneLeaves() {
    const win = this.plugin.window;
    const ids = await win.getOpenPaneIds();
    const focused = await win.getFocusedPaneId();
    const docs: (string | undefined)[] = [];
    for (const id of ids) docs.push(await win.getOpenPaneRemId(id));
    return { docs, focusedIdx: Math.max(0, ids.indexOf(focused)) };
  }

  /** Right-fold a flat leaf list into equal splits along one direction. */
  private buildPaneTree(leaves: string[], direction: 'row' | 'column'): PaneNode {
    let node: PaneNode = leaves[leaves.length - 1];
    for (let i = leaves.length - 2; i >= 0; i--) {
      node = {
        direction,
        first: leaves[i],
        second: node,
        splitPercentage: 100 / (leaves.length - i),
      };
    }
    return node;
  }

  /**
   * Apply a rebuilt pane layout and re-focus. `setRemWindowTree` regenerates
   * every pane id and drops the pane focus entirely (probed live) — without
   * the restore the caret is dead until the user clicks a pane. `focusIdx`
   * indexes the new leaf order.
   */
  private async setPaneTree(leaves: string[], direction: 'row' | 'column', focusIdx: number) {
    await this.winCall('setRemWindowTree', {
      tree: leaves.length === 1 ? leaves[0] : this.buildPaneTree(leaves, direction),
    });
    const ids = await this.plugin.window.getOpenPaneIds();
    const target = ids[clamp(focusIdx, 0, ids.length - 1)];
    if (target) await this.plugin.window.setFocusedPaneId(target);
    this.invalidateModel();
  }

  /**
   * `:vsplit`/`:split` — duplicate the focused pane (or open `arg`, found via
   * search, beside it). There is no layout GETTER, so an existing multi-pane
   * arrangement is rebuilt flat along `direction` — nesting/ratios of a
   * hand-arranged 3+ pane layout are not preserved.
   */
  private async splitPane(direction: 'row' | 'column', arg: string) {
    const app = this.plugin.app;
    const { docs, focusedIdx } = await this.paneLeaves();
    const curDoc = docs[focusedIdx];
    if (!curDoc || docs.some((d) => !d)) {
      await app.toast('Cannot split: a pane has no document');
      return;
    }
    let newDoc = curDoc;
    if (arg) {
      const results = await this.plugin.search.search([arg]);
      const top = results?.[0];
      if (!top) {
        await app.toast(`No Rem matching "${arg}"`);
        return;
      }
      newDoc = top._id;
    }
    const leaves = [
      ...(docs as string[]).slice(0, focusedIdx + 1),
      newDoc,
      ...(docs as string[]).slice(focusedIdx + 1),
    ];
    // vim focuses the new window after :split/:vsplit
    await this.setPaneTree(leaves, direction, focusedIdx + 1);
  }

  /** `:q` with a split open — close the focused pane. */
  private async closePane() {
    const { docs, focusedIdx } = await this.paneLeaves();
    if (docs.length < 2 || docs.some((d) => !d)) {
      await this.plugin.app.toast('Nothing to quit (RemNote autosaves)');
      return;
    }
    const leaves = (docs as string[]).filter((_, i) => i !== focusedIdx);
    await this.setPaneTree(leaves, 'row', Math.min(focusedIdx, leaves.length - 1));
  }

  /** `:only` — collapse the layout to just the focused pane. */
  private async onlyPane() {
    const { docs, focusedIdx } = await this.paneLeaves();
    const keep = docs[focusedIdx];
    if (!keep) {
      await this.plugin.app.toast('Cannot resolve the focused pane');
      return;
    }
    if (docs.length < 2) return;
    await this.setPaneTree([keep], 'row', 0);
  }

  private async openByName(name: string) {
    try {
      const results = await this.plugin.search.search([name]);
      const top = results?.[0];
      if (top) {
        await this.plugin.window.openRem(top);
      } else {
        await this.plugin.app.toast(`No Rem matching "${name}"`);
      }
    } catch (e) {
      await this.plugin.app.toast(`Search failed: ${String(e)}`);
    }
  }

  // ------------------------------------------------- user keymap (:config)

  private static readonly CONFIG_DOC_NAME = 'Vim Keymap';
  private static readonly CONFIG_ID_KEY = 'vim-keymap-doc-id';

  /** Resolve the config document: pinned id first, then title search. */
  private async findConfigDoc(): Promise<RemObj | null> {
    const storedId =
      this.configRemId ??
      (await this.plugin.storage.getSynced<string>(VimAdapter.CONFIG_ID_KEY)) ??
      null;
    if (storedId) {
      const doc = await this.plugin.rem.findOne(storedId);
      if (doc) {
        this.configRemId = storedId;
        return doc;
      }
    }
    // The pinned id dangles (doc deleted / different vault) — adopt by name.
    const byName = await this.plugin.rem.findByName([VimAdapter.CONFIG_DOC_NAME], null);
    if (byName) {
      this.configRemId = byName._id;
      await this.plugin.storage.setSynced(VimAdapter.CONFIG_ID_KEY, byName._id);
      return byName;
    }
    this.configRemId = null;
    return null;
  }

  /**
   * Re-read the "Vim Keymap" document and apply it: parse the direct child
   * bullets, swap the mapping/spec tables, re-diff the stolen keys. Runs ON
   * the key queue — Ex verbs (already queued) call it directly; activation
   * and focus-tracking enqueue it via enqueueTask (see its deadlock note).
   */
  private async reloadConfig(notify: boolean) {
    let lines: string[] = [];
    const doc = await this.findConfigDoc();
    if (doc) {
      const kids = await doc.getChildrenRem();
      lines = kids.map((k) => flattenRich((k.text ?? []) as RichTextInterface));
    }
    const { config, diagnostics } = parseMappings(lines);
    this.mapConfig = config;
    this.mapDiagnostics = diagnostics;
    this.specToSym = specToSymTable(config);
    // While vim is toggled off nothing may be stolen — toggle-on re-applies.
    if (this.active) await this.applyMode(this.state.mode);
    const nMaps = listMappingLines(config).length;
    const errs = diagnostics.filter((d) => d.severity === 'error').length;
    const warns = diagnostics.length - errs;
    if (notify) {
      const parts = [`${nMaps} mapping${nMaps === 1 ? '' : 's'}`];
      if (errs) parts.push(`${errs} error${errs === 1 ? '' : 's'}`);
      if (warns) parts.push(`${warns} warning${warns === 1 ? '' : 's'}`);
      const tail = errs || warns ? ' — :map for details' : '';
      await this.plugin.app.toast(`vim keymap: ${parts.join(', ')}${tail}`);
    } else if (errs) {
      // Silent reloads still surface real errors — a broken config that only
      // half-applies must never be invisible.
      await this.plugin.app.toast(
        `vim keymap: ${errs} error${errs === 1 ? '' : 's'} in "Vim Keymap" — :map for details`
      );
    }
  }

  /** `:config` — open the config document (create + seed it on first use).
   * Public: also the "Vim: Edit keybindings" palette command (index.tsx). */
  async openConfig() {
    let doc = await this.findConfigDoc();
    if (!doc) {
      const created = await this.plugin.rem.createRem();
      if (!created) {
        await this.plugin.app.toast('Could not create the "Vim Keymap" document');
        return;
      }
      await created.setText([VimAdapter.CONFIG_DOC_NAME]);
      await created.setIsDocument(true);
      const seed = [
        '" vim keymap — one mapping per bullet: map/nmap/vmap <key> <keys…>',
        '" unmap <key> returns a key to RemNote · :mapload applies · :map lists',
        '" e.g.:  nmap - $    (shifted keys work on either side: nmap H ^)',
      ];
      for (let i = 0; i < seed.length; i++) {
        const kid = await this.plugin.rem.createRem();
        if (!kid) continue;
        await kid.setParent(created._id, i);
        await kid.setText([seed[i]]);
      }
      this.configRemId = created._id;
      await this.plugin.storage.setSynced(VimAdapter.CONFIG_ID_KEY, created._id);
      doc = created;
    }
    // Opening lands focus inside the doc; mark it so the eventual focus-out
    // applies the edits even if no FocusedRemChange fired for the way in.
    this.focusInConfig = true;
    await this.recordJump(); // :config is a jump — Ctrl-O returns
    await this.plugin.window.openRem(doc);
  }

  // ------------------------------------------------- tutorial (:tutorial)

  private static readonly TUTORIAL_ID_KEY = 'vim-tutorial-doc-id';
  /** The TUTORIAL_VERSION the pinned document was seeded from (absent on
   * copies seeded before versioning — those count as outdated). */
  private static readonly TUTORIAL_VERSION_KEY = 'vim-tutorial-version';

  /** Resolve the tutorial document: pinned id first, then title search —
   * the exact `findConfigDoc` dance, for the practice document. */
  private async findTutorialDoc(): Promise<RemObj | null> {
    const storedId =
      this.tutorialRemId ??
      (await this.plugin.storage.getSynced<string>(VimAdapter.TUTORIAL_ID_KEY)) ??
      null;
    if (storedId) {
      const doc = await this.plugin.rem.findOne(storedId);
      if (doc) {
        this.tutorialRemId = storedId;
        return doc;
      }
    }
    const byName = await this.plugin.rem.findByName([TUTORIAL_DOC_NAME], null);
    if (byName) {
      this.tutorialRemId = byName._id;
      await this.plugin.storage.setSynced(VimAdapter.TUTORIAL_ID_KEY, byName._id);
      return byName;
    }
    this.tutorialRemId = null;
    return null;
  }

  /**
   * `:tutorial` — open the practice document, creating + seeding it from
   * `TUTORIAL_LINES` on first use (vimtutor's model: lessons are ordinary
   * bullets, practiced in place with the real bindings — the document is the
   * user's to edit or wreck; deleting it entirely just makes the next
   * `:tutorial` seed a fresh copy). Public: also the "Vim: Tutorial" palette
   * command and the one-time first-activation auto-open (index.tsx).
   */
  async openTutorial() {
    const { doc, replaced } = await this.ensureTutorialDoc(true);
    if (!doc) return;
    if (replaced) {
      await this.plugin.app.toast(
        `Vim Tutorial updated with new lessons — your old copy is kept as "${TUTORIAL_OLD_NAME}".`
      );
    }
    await this.recordJump(); // :tutorial is a jump — Ctrl-O returns
    await this.plugin.window.openRem(doc);
  }

  /**
   * Activation-time half of the versioning (index.tsx, for users who have
   * already seen the tutorial): replace an outdated copy and say so, without
   * opening anything. Someone who deleted the tutorial gets nothing back.
   */
  async refreshTutorialIfOutdated() {
    const { replaced } = await this.ensureTutorialDoc(false);
    if (replaced) {
      await this.plugin.app.toast(
        `The Vim Tutorial has new lessons — ;tutorial opens it. Your old copy is kept as "${TUTORIAL_OLD_NAME}".`
      );
    }
  }

  /**
   * The current tutorial document: the existing copy if it was seeded from
   * this TUTORIAL_VERSION; a fresh copy replacing it if it was seeded from an
   * older one (or before versioning — no version stored); a fresh copy when
   * there is none and `create`. Replacing never deletes: the old copy is the
   * user's document and may hold their notes, so it's renamed
   * TUTORIAL_OLD_NAME (which also takes it out of findTutorialDoc's
   * by-name reach). Seeding goes first so a failed seed leaves the old copy
   * in place and still pinned — the next call simply retries.
   */
  private async ensureTutorialDoc(
    create: boolean
  ): Promise<{ doc: RemObj | null; replaced: boolean }> {
    const existing = await this.findTutorialDoc();
    if (existing) {
      const seededFrom = await this.plugin.storage.getSynced<number>(
        VimAdapter.TUTORIAL_VERSION_KEY
      );
      if (seededFrom === TUTORIAL_VERSION) return { doc: existing, replaced: false };
      const fresh = await this.seedTutorialDoc();
      if (!fresh) return { doc: existing, replaced: false };
      await existing.setText([TUTORIAL_OLD_NAME]);
      return { doc: fresh, replaced: true };
    }
    return { doc: create ? await this.seedTutorialDoc() : null, replaced: false };
  }

  /** Create the "Vim Tutorial" document from TUTORIAL_LINES and pin it
   * (id + the TUTORIAL_VERSION it was built from) in synced storage. */
  private async seedTutorialDoc(): Promise<RemObj | null> {
    const created = await this.plugin.rem.createRem();
    if (!created) {
      await this.plugin.app.toast(`Could not create the "${TUTORIAL_DOC_NAME}" document`);
      return null;
    }
    await created.setText([TUTORIAL_DOC_NAME]);
    await created.setIsDocument(true);
    // Seed with one parent stack: indent 0 hangs off the doc, indent 1 off
    // the most recent indent-0 bullet. Positions count per parent.
    let lastTop: string | null = null;
    const pos: Record<string, number> = {};
    for (const line of TUTORIAL_LINES) {
      const kid = await this.plugin.rem.createRem();
      if (!kid) continue;
      const parentId = line.indent === 1 && lastTop ? lastTop : created._id;
      await kid.setParent(parentId, (pos[parentId] = (pos[parentId] ?? -1) + 1));
      await kid.setText([line.text]);
      if (line.heading) {
        // Lesson titles get the vimtutor look: /h3 heading, blue bullet.
        await kid.setFontSize('H3');
        await kid.setHighlightColor('Blue');
      }
      if (line.indent === 0) lastTop = kid._id;
    }
    this.tutorialRemId = created._id;
    await this.plugin.storage.setSynced(VimAdapter.TUTORIAL_ID_KEY, created._id);
    await this.plugin.storage.setSynced(VimAdapter.TUTORIAL_VERSION_KEY, TUTORIAL_VERSION);
    return created;
  }

  /** `:map` — list active mappings + config diagnostics (toasts, like :marks). */
  private async listMappings() {
    const lines = listMappingLines(this.mapConfig);
    await this.plugin.app.toast(
      lines.length ? `Mappings: ${lines.join('  |  ')}` : 'No custom mappings — :config to add'
    );
    if (this.mapDiagnostics.length) {
      const shown = this.mapDiagnostics
        .slice(0, 5)
        .map((d) => `line ${d.line} ${d.severity}: ${d.message}`);
      const more = this.mapDiagnostics.length - shown.length;
      await this.plugin.app.toast(
        `Keymap issues: ${shown.join('  |  ')}${more > 0 ? `  (+${more} more)` : ''}`
      );
    }
  }

  /**
   * Called on every FocusedRemChange: reload the keymap when focus LEAVES
   * the config document (the user just edited it). Cheap checks only — the
   * focused rem, its direct parent, or the focused pane's document must be
   * the config doc; no ancestor walk per keystroke. Deeply nested bullets
   * viewed through portals can miss the transition: :mapload is the fallback.
   */
  private async trackConfigFocus() {
    if (!this.configRemId) return;
    const seq = ++this.focusSeq;
    let inConfig = false;
    try {
      const focused = await this.plugin.focus.getFocusedRem();
      if (focused && (focused._id === this.configRemId || focused.parent === this.configRemId)) {
        inConfig = true;
      } else if (focused) {
        const paneId = await this.plugin.window.getFocusedPaneId();
        const paneDoc = paneId ? await this.plugin.window.getOpenPaneRemId(paneId) : undefined;
        inConfig = paneDoc === this.configRemId;
      }
    } catch {
      return;
    }
    if (seq !== this.focusSeq) return; // superseded by a newer focus event
    const was = this.focusInConfig;
    this.focusInConfig = inConfig;
    if (was && !inConfig && !this.configReloadQueued) {
      this.configReloadQueued = true;
      this.enqueueTask(async () => {
        this.configReloadQueued = false;
        await this.reloadConfig(false);
      });
    }
  }

  /**
   * `:N` — walk the live caret to the Nth bullet (Rem) from the top of the
   * document, 1-indexed (`:0` clamps to line 1 — vim has no line 0). First
   * walks to the document START via the same `walkToBoundary` helper
   * `goDoc`'s 'start' case uses (batched moveCaretVertical(-1), stopping
   * once focus stops changing — the document boundary), then hops DOWN n-1
   * more times.
   *
   * The second leg checks focus after EVERY hop (no batching): unlike a
   * walk to a true boundary, an unchecked hop here is only harmless once
   * the real last line has been reached — short of that it would land on
   * the wrong interior line instead of no-op'ing. Checking every hop keeps
   * the common case (document has >= n lines) landing exactly on line n,
   * while the same "focus stopped changing" check still clamps the
   * pathological case (n past the end of a shorter document) to the last
   * line, matching vim's own `:999`-past-EOF behavior instead of erroring.
   * (Neither `walkToBoundary` nor `walkToTarget` fits this leg: there's no
   * known target id to walk toward, and a fixed hop COUNT — not a boundary
   * — is what must be respected whenever the document is long enough.)
   */
  private async gotoLine(n: number) {
    const { editor, focus } = this.plugin;
    const target = Math.max(1, n);
    // Leg 1: walk to the document start (mirrors goDoc's 'start' case).
    await walkToBoundary(
      () => editor.moveCaretVertical(-1),
      async () => (await focus.getFocusedRem())?._id
    );
    // Leg 2: hop down exactly target-1 more times, stopping early if the
    // document is shorter than target (boundary reached).
    let prevId: string | undefined;
    for (let i = 0; i < target - 1; i++) {
      await editor.moveCaretVertical(1);
      const f = await focus.getFocusedRem();
      if (!f || f._id === prevId) break;
      prevId = f._id;
    }
  }

  // ------------------------------------------------- structural helpers

  /** Flatten register nodes to tab-indented plain text (for the clipboard). */
  private registerToText(nodes: RegisterNode[], depth = 0): string {
    let out = '';
    for (const n of nodes) {
      const line = (n.text ?? [])
        .map((x) => (typeof x === 'string' ? x : ((x as { text?: string }).text ?? '')))
        .join('');
      out += '\t'.repeat(depth) + line + '\n';
      out += this.registerToText(n.children, depth + 1);
    }
    return out;
  }

  /**
   * Write `text` to the SYSTEM clipboard from the sandboxed widget iframe.
   * Tries the async clipboard API first, then the legacy execCommand path.
   * KNOWN DEAD on the desktop app (both tiers verified permission-denied
   * live, §9): there it always returns false and callers' native-editor
   * fallbacks do the real work. Kept because the try is free and other hosts
   * (web) may grant it — the clip:api/clip:exec badges reveal if one fires.
   */
  private async writeClipboard(text: string): Promise<boolean> {
    if (!text) return true;
    try {
      await navigator.clipboard.writeText(text);
      this.dbgClip = 'clip:api';
      return true;
    } catch {
      /* fall through */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      this.dbgClip = ok ? 'clip:exec' : 'clip:FAIL';
      return ok;
    } catch {
      this.dbgClip = 'clip:FAIL';
      return false;
    }
  }

  /** Best-effort copy of the line register (vim yanks are OS yanks). */
  private async copyRegisterToClipboard() {
    const text = this.registerToText(this.lineRegister).replace(/\n$/, '');
    if (!text) return;
    await this.writeClipboard(text);
  }

  /**
   * Whole-rem copy through RemNote's NATIVE clipboard. The sandbox can never
   * write the OS clipboard itself (clipboard-write is permission-denied for
   * the unfocused plugin iframe — §9), so a real Rem selection plus
   * `editor.copy()` is the only host-side path that works. `selectRem` blurs
   * the text caret, but re-focusing the pane clears the Rem selection and
   * restores the caret to its exact pre-selection rem AND column (verified
   * live) — this is the escape hatch §9's "one-way door" note was missing.
   * Note: `editor.cut()` on a Rem selection writes EMPTY html to the
   * clipboard (verified live), so deletion is always copy + SDK removal.
   */
  private async nativeClipboardRems(ids: string[]): Promise<boolean> {
    const { editor, window } = this.plugin;
    try {
      const paneId = await window.getFocusedPaneId();
      await editor.selectRem(ids);
      const kind = await editor.copy();
      await window.setFocusedPaneId(paneId);
      this.dbgClip = kind ? 'clip:native' : 'clip:FAIL';
      return Boolean(kind);
    } catch {
      this.dbgClip = 'clip:FAIL';
      return false;
    }
  }

  /**
   * Remove whole rems with vim register semantics: OS clipboard first (native
   * copy of the full selection), then the proven SDK removal loop — which
   * needs the caret alive to park it on a survivor, hence copy-then-remove.
   */
  private async cutRems(
    rems: {
      _id: string;
      getParentRem: () => Promise<unknown>;
      positionAmongstSiblings: () => Promise<number | undefined>;
      remove: () => Promise<void>;
      setText?: (t: RichTextInterface) => Promise<void>;
    }[]
  ) {
    if (!(await this.nativeClipboardRems(rems.map((r) => r._id)))) {
      await this.copyRegisterToClipboard();
    }
    await this.removeRems(rems);
  }

  // ------------------------------------------------- jumplist

  /** Record the current position before a jump command leaves it (vim m'). */
  private async recordJump() {
    const f = await this.plugin.focus.getFocusedRem();
    if (!f) return;
    const docId = await this.currentDocId();
    // A new jump truncates the forward part of the list, like vim.
    this.jumps = this.jumps.slice(0, this.jumpPos);
    if (this.jumps[this.jumps.length - 1]?.id !== f._id) this.jumps.push({ id: f._id, docId });
    this.jumpPos = this.jumps.length;
    this.marks.set("'", { id: f._id, docId }); // vim's automatic ' mark — '' jumps back
  }

  /** The Rem id currently open as the focused pane's document (its zoom root). */
  private async currentDocId(): Promise<string | undefined> {
    return this.plugin.window.getOpenPaneRemId(await this.plugin.window.getFocusedPaneId());
  }

  /**
   * Put the caret into `id`: walk visible rows if it is on screen in the
   * current document (keeps the caret alive), otherwise open the document
   * that was showing when this jump/mark was recorded (`docIdHint`) and walk
   * down to `id` from there — the cross-document case, where the pane has to
   * navigate first anyway.
   *
   * `walkCaretTo` alone can't tell these two cases apart except by trying:
   * every hop needs an exact-match check (batching the way `goDoc` does would
   * silently walk right past the target), so a jump to a Rem in a *different*
   * document — the common case for Ctrl-O after using RemNote's own search to
   * open elsewhere, or a mark set before switching documents — paid its full
   * 60-hops-per-direction budget (up to ~240 round trips) before ever falling
   * back, dragging the live caret through the whole current document on the
   * way. Checking document membership first (bounded, O(1) round trips
   * regardless of doc size) turns that into a handful of calls instead.
   *
   * The fallback needs the *recorded* document, not a guess: `openRem(id)`
   * zooms into `id` as if it were its own page (reported live — landed on a
   * bullet's zoomed-in parent instead of the real document). Re-deriving a
   * "document root" from `id` by walking `.parent` up doesn't work either —
   * there's no principled stopping point short of the true tree root, which
   * overshoots past any document nested under a folder-like parent (also
   * reported live — landed on the workspace folder, not the document). Only
   * `docIdHint`, captured from `getOpenPaneRemId()` at record time, actually
   * knows which Rem was the open document — `findDocRoot` stays only as a
   * fallback for entries recorded before this existed / a missing hint.
   *
   * The walk-down after `openRem` is retried, not attempted once: right after
   * a pane navigates to a brand-new document, `getFocusedRem()` reports the
   * document's own root immediately, but `moveCaretVertical` silently no-ops
   * for the first several calls (the editor hasn't finished mounting) —
   * `walkCaretTo` sees the caret "not moving" and concludes it's hit a
   * boundary after just its first couple of hops in each direction, leaving
   * the caret stranded on the title (reported live: doc opens at the right
   * scroll position, but the caret itself never left the title). A few
   * retries a beat apart give the editor time to actually become navigable.
   */
  private async focusRemById(id: string, docIdHint?: string) {
    if ((await this.isInFocusedDocument(id)) && (await this.walkCaretTo(id, -1))) return;
    const r = await this.plugin.rem.findOne(id);
    if (!r) return;
    const root = (docIdHint && (await this.plugin.rem.findOne(docIdHint))) || (await this.findDocRoot(r));
    await this.plugin.window.openRem(root);
    if (root._id === id) return;
    await retryUntilTrue(() => this.walkCaretTo(id, 1));
  }

  /** Walk `.parent` up to the top-level Rem (no parent) that `r` lives under. */
  private async findDocRoot(
    r: NonNullable<Awaited<ReturnType<RNPlugin['rem']['findOne']>>>
  ): Promise<NonNullable<Awaited<ReturnType<RNPlugin['rem']['findOne']>>>> {
    const rootId = await walkToRoot(r._id, async (id) => {
      const cur = await this.plugin.rem.findOne(id);
      return (cur as unknown as { parent?: string } | undefined)?.parent;
    });
    return (await this.plugin.rem.findOne(rootId)) ?? r;
  }

  /**
   * Is `remId` the currently open document's root, or somewhere in its
   * subtree? Any inconclusive result (no focused pane, doc rem vanished)
   * defaults to `true` — falls back to the old behavior of just trying the
   * walk, never a worse outcome than before this check existed.
   */
  private async isInFocusedDocument(remId: string): Promise<boolean> {
    const paneRemId = await this.currentDocId();
    if (!paneRemId || paneRemId === remId) return true;
    const doc = await this.plugin.rem.findOne(paneRemId);
    const descendantIds = doc ? (await doc.getDescendants()).map((d) => d._id) : undefined;
    return isDescendantAmong(remId, descendantIds);
  }

  /**
   * `space<pattern><CR>` / `n` / `z`: find the next (`dir: 1`) or previous
   * (`dir: -1`) match of `pattern` across the WHOLE document — reusing
   * `allDocumentRems` (the same enumeration `:g/pattern/d` uses) and
   * `flattenRich` (the model-space flatten every other motion/edit reasons
   * in, so match offsets land correctly on lines with a rem reference/image/
   * LaTeX chip) — and jump the real cursor there via `focusRemById`, the
   * same cross-Rem jump primitive `gotoMark`/Ctrl-O already use.
   *
   * No absolute caret-set API exists in this sandbox (only a RELATIVE
   * `moveCaret`, see CLAUDE.md), and `focusRemById`'s row-walk leaves the
   * caret at whatever column the vertical move happened to preserve — so
   * after the jump this reads where the REAL caret actually landed (via a
   * fresh `snapshot()`, since the model was just invalidated) and walks a
   * relative delta from there to the exact match offset.
   */
  private async performSearch(pattern: string, snap: Snapshot, dir: 1 | -1) {
    const app = this.plugin.app;
    const rems = await this.allDocumentRems();
    const units: SearchUnit[] = rems.map((r) => ({
      id: r._id,
      text: flattenRich((r.text ?? []) as RichTextInterface),
    }));
    const fromId = this.model?.remId ?? (await this.plugin.focus.getFocusedRem())?._id;
    const outcome = findSearchMatch(units, fromId, snap.caret, pattern, dir);
    if (!outcome.ok) {
      await app.toast(
        outcome.reason === 'badPattern'
          ? `Bad pattern: /${pattern}/`
          : `Pattern not found: /${pattern}/`
      );
      return;
    }
    await this.recordJump(); // search jumps are Ctrl-O-able, like gg/G/:e
    await this.focusRemById(outcome.match.id);
    this.invalidateModel();
    const post = await this.snapshot(); // the REAL caret, wherever the row-walk left it
    const target = clamp(outcome.match.start, 0, post.text.length);
    const delta = stopsBetween(post.text, post.caret, target);
    if (delta !== 0) {
      await this.plugin.editor.moveCaret(delta, MoveUnit.CHARACTER);
    }
    if (this.model) this.model.caret = target;
    this.lastCaret = target;
    if (outcome.wrapped) {
      await app.toast(
        dir === 1 ? 'search hit BOTTOM, continuing at TOP' : 'search hit TOP, continuing at BOTTOM'
      );
    }
  }

  /** Serialize a Rem including its whole subtree into a register node. */
  private async captureSubtree(r: {
    text?: unknown;
    getChildrenRem: () => Promise<unknown[]>;
  }, depth = 0): Promise<RegisterNode> {
    const node: RegisterNode = { text: (r.text as RichTextInterface) ?? [], children: [] };
    if (depth < 20) {
      const kids = (await r.getChildrenRem()) as {
        text?: unknown;
        getChildrenRem: () => Promise<unknown[]>;
      }[];
      for (const k of kids) {
        node.children.push(await this.captureSubtree(k, depth + 1));
      }
    }
    return node;
  }

  /**
   * Create Rems from a register node under `parent` at position `at`.
   * `count` is the total number of Rems created (this node plus every
   * descendant) — one `createRem` per node, so it doubles as the number of
   * native undo-history entries the paste produced (see `undoGroups`).
   */
  private async pasteSubtree(
    node: RegisterNode,
    parent: unknown,
    at: number
  ): Promise<{ id: string; count: number } | null> {
    const created = await this.plugin.rem.createRem();
    if (!created) return null;
    await created.setText(node.text);
    await created.setParent((parent as never) ?? null, at);
    let childAt = 0;
    let count = 1;
    for (const child of node.children) {
      const r = await this.pasteSubtree(child, created, childAt++);
      if (r) count += r.count;
    }
    return { id: created._id, count };
  }

  /** True if `remId` is one of `ids` or lies inside one of their subtrees. */
  private async inRemovedSubtree(remId: string, ids: Set<string>): Promise<boolean> {
    let cur = await this.plugin.rem.findOne(remId);
    for (let hop = 0; cur && hop < 15; hop++) {
      if (ids.has(cur._id)) return true;
      const parent = (cur as unknown as { parent?: string }).parent;
      if (!parent) return false;
      cur = await this.plugin.rem.findOne(parent);
    }
    return false;
  }

  /**
   * Walk the LIVE text caret out of the doomed subtree(s) BEFORE deleting.
   * moveCaretVertical only works while a text editor is focused — once the
   * focused rem is removed the caret is unrecoverable programmatically — so
   * escape first, delete second.
   */
  private async walkCaretOut(removedIds: Set<string>): Promise<boolean> {
    const { editor, focus } = this.plugin;
    for (const dir of [1, -1] as const) {
      let prevId: string | null = null;
      for (let i = 0; i < 30; i++) {
        await editor.moveCaretVertical(dir);
        const f = await focus.getFocusedRem();
        if (!f) break;
        if (!(await this.inRemovedSubtree(f._id, removedIds))) return true;
        if (f._id === prevId) break; // hit the document boundary
        prevId = f._id;
      }
    }
    return false;
  }

  /**
   * Remove Rems (a dd or visual-line cut): remember the cut site for
   * paste-after-cut, walk the caret to safety, then delete. The caret ends on
   * the neighboring survivor, so `p`, motions and indent keep working without
   * a mouse click.
   *
   * If there is NO survivor to walk to (deleting the only bullet(s) of the
   * document), vim semantics apply: keep one line, emptied. We clear the
   * focused Rem's text instead of removing it, so the caret stays alive.
   */
  private async removeRems(rems: { _id: string; getParentRem: () => Promise<unknown>; positionAmongstSiblings: () => Promise<number | undefined>; remove: () => Promise<void>; setText?: (t: RichTextInterface) => Promise<void> }[]) {
    const first = rems[0];
    const parent = (await first.getParentRem()) as { _id: string } | undefined;
    const pos = (await first.positionAmongstSiblings()) ?? 0;
    this.lastCutSite = { parentId: parent?._id ?? null, pos };
    const removedIds = new Set(rems.map((r) => r._id));
    const escaped = await this.walkCaretOut(removedIds);
    let keepId: string | null = null;
    if (!escaped) {
      // nowhere to go — keep the rem the caret is in (or the first one),
      // clear it, and delete the rest
      const f = await this.plugin.focus.getFocusedRem();
      keepId = f && removedIds.has(f._id) ? f._id : rems[0]._id;
    }
    for (const r of rems) {
      if (r._id === keepId && r.setText) {
        await r.setText([]);
      } else {
        await r.remove();
      }
    }
    this.invalidateModel();
    this.lastCaret = 0;
  }

  /**
   * Expand selection-unit ids with all their descendants. RemNote's DOM does
   * NOT nest child rows inside the parent's [data-rem-id] container, so the
   * CSS tint must name every row explicitly for subtrees to look selected.
   */
  private async expandWithDescendants(ids: string[]): Promise<string[]> {
    const out: string[] = [];
    const walk = async (id: string, depth: number) => {
      if (out.length > 400 || depth > 20 || out.includes(id)) return;
      out.push(id);
      const r = await this.plugin.rem.findOne(id);
      for (const kid of (r?.children ?? []) as string[]) {
        await walk(kid, depth + 1);
      }
    };
    for (const id of ids) await walk(id, 0);
    return out;
  }

  /**
   * Walk the live caret through visible rows until it lands in `targetId`
   * (tries `firstDir` first, then the other way). Used to put the cursor on
   * a bullet we just created/moved — selectRem would kill the caret instead.
   */
  private async walkCaretTo(targetId: string, firstDir: -1 | 1 = 1): Promise<boolean> {
    const { editor, focus } = this.plugin;
    return walkToTarget(
      targetId,
      firstDir,
      async () => (await focus.getFocusedRem())?._id,
      (dir) => editor.moveCaretVertical(dir)
    );
  }

  /** Clear the visual-line trail and its CSS highlight. */
  private clearVTrail() {
    this.vTrail = null;
    this.vSelIds = [];
    this.dbgV = ''; // stale trail:/units:/tint: in the badge reads as a live selection
  }

  /** Is `remId` a strict descendant of `ancestorId`? */
  private async isDescendantOf(remId: string, ancestorId: string): Promise<boolean> {
    let cur = await this.plugin.rem.findOne(remId);
    for (let hop = 0; cur && hop < 20; hop++) {
      const parent = (cur as unknown as { parent?: string }).parent;
      if (!parent) return false;
      if (parent === ancestorId) return true;
      cur = await this.plugin.rem.findOne(parent);
    }
    return false;
  }

  /**
   * The selection trail reduced to its top-level units, in visual order:
   * ids covered by another trail id's subtree are dropped (walking down
   * through a parent's children keeps just the parent).
   */
  private async normalizedTrail(): Promise<string[]> {
    const trail = this.vTrail ?? [];
    const out: string[] = [];
    for (const id of trail) {
      let covered = false;
      for (const other of trail) {
        if (other !== id && (await this.isDescendantOf(id, other))) {
          covered = true;
          break;
        }
      }
      if (!covered && !out.includes(id)) out.push(id);
    }
    return out;
  }

  /** Resolve the normalized trail to RemObjects (visual order). */
  private async vUnits() {
    const ids = await this.normalizedTrail();
    const rems = [];
    for (const id of ids) {
      const r = await this.plugin.rem.findOne(id);
      if (r) rems.push(r);
    }
    return rems;
  }

  /**
   * A rem's position among its siblings, located BY ID in the parent's
   * children list. `positionAmongstSiblings()` races RemNote's data layer
   * right after an edit — it can return a stale position or effectively make
   * a rem its own neighbor (§9; bit joinRem, indentSelection and the smoke
   * suite's paste-then-indent). Falls back to the racy call only when the
   * id lookup is impossible (no parent / not yet in the children list).
   */
  private async positionById(r: {
    _id: string;
    getParentRem: () => Promise<{ getChildrenRem: () => Promise<{ _id: string }[]> } | undefined>;
    positionAmongstSiblings: () => Promise<number | undefined>;
  }): Promise<number> {
    const parent = await r.getParentRem();
    if (parent) {
      const idx = (await parent.getChildrenRem()).findIndex((s) => s._id === r._id);
      if (idx >= 0) return idx;
    }
    return (await r.positionAmongstSiblings()) ?? 0;
  }

  /** The focused Rem plus up to count-1 following siblings. */
  private async focusedPlusFollowing(count: number) {
    const focused = await this.plugin.focus.getFocusedRem();
    if (!focused) return [];
    if (count <= 1) return [focused];
    const parent = await focused.getParentRem();
    if (!parent) return [focused];
    const siblings = await parent.getChildrenRem();
    const idx = siblings.findIndex((s) => s._id === focused._id);
    if (idx < 0) return [focused];
    return siblings.slice(idx, idx + count);
  }

  // ------------------------------------------------------------ mode UI

  private async applyMode(mode: Mode) {
    // Off (toggled, stopped, or paused for flashcard review) means nothing
    // stolen and no badge — a key still in flight must not bring either back.
    if (!this.active) return;
    const wanted = new Set(effectiveSpecs(mode, this.mapConfig));
    const toRelease = [...this.stolenSpecs].filter((s) => !wanted.has(s));
    // Steal the FULL wanted set, not the stolen-vs-wanted delta. RemNote can
    // silently drop registered steals (observed live 2026-07-10: 'escape'
    // present in our bookkeeping yet no longer delivered — the app was stuck
    // in insert mode until a redundant stealKeys healed it). Re-stealing an
    // already-stolen spec is idempotent (verified live: keys still arrive
    // exactly once), so every mode change now re-asserts reality for the
    // same single RPC.
    if (wanted.size) await this.plugin.app.stealKeys([...wanted]);
    if (toRelease.length) await this.plugin.app.releaseKeys(toRelease);
    this.stolenSpecs = wanted;
    // Keep in sync with syncEscapeSteal's own bookkeeping — a mode
    // transition's full diff is authoritative over whatever idle-normal-mode
    // toggling did before it.
    this.escapeWanted = wanted.has('escape');
    await this.render();
  }

  /** Last steal re-assertion (ms epoch) — throttles reassertSteals. */
  private lastStealAssert = 0;

  /**
   * Self-healing for SILENTLY LOST key steals. RemNote's
   * GlobalStealKeySingleton garbage-collects a plugin's entire steal list
   * whenever the plugin's load-state map reads 'not-loaded'/'unloading'/
   * 'error' at any registry update (read from the app bundle 2026-07-10;
   * a dev-server hiccup is enough to flicker it) — the plugin keeps running
   * but no key ever arrives again, and since keys are the usual trigger for
   * applyMode, the full-steal there can't heal it. These two events still
   * fire without any stolen keys — FocusedRemChange (clicks) and stray
   * EditorTextEdited (leaked keys typing into the document) — so they
   * re-assert the current steal set, throttled. Re-stealing is idempotent
   * (verified live: keys arrive exactly once).
   *
   * MUST run on the key queue: an off-queue re-steal races applyMode's
   * insert-mode release (observed live: `o` focuses the new bullet →
   * FocusedRemChange → a full-set steal snapshotted BEFORE
   * applyMode('insert') lands re-steals every letter mid-typing and the
   * typed text vanishes into the engine).
   */
  private reassertSteals() {
    const now = Date.now();
    if (!this.active || now - this.lastStealAssert < 1500) return;
    this.lastStealAssert = now;
    this.enqueueTask(async () => {
      if (!this.active || this.stolenSpecs.size === 0) return;
      await this.plugin.app.stealKeys([...this.stolenSpecs]);
    });
  }

  /**
   * Escape is normally always stolen, but idle normal mode (no pending
   * op/count) releases it so RemNote's own Ctrl-P/Ctrl-K palette can see the
   * Escape a user presses to close it — see `escapeWanted`'s doc comment.
   * Called after every keystroke; only issues a steal/release RPC on an
   * actual transition, not on every key.
   */
  private async syncEscapeSteal() {
    const wanted = isEscapeWanted(this.state);
    if (!this.active || wanted === this.escapeWanted) return;
    this.escapeWanted = wanted;
    if (wanted) {
      await this.plugin.app.stealKeys(['escape']);
      this.stolenSpecs.add('escape');
    } else {
      await this.plugin.app.releaseKeys(['escape']);
      this.stolenSpecs.delete('escape');
    }
  }

  /** One CSS block (single id) draws the mode label, debug readout, and the
   * visual-line selection highlight (RemNote's own rem-selection rendering is
   * not guaranteed, so we tint the selected bullets ourselves). */
  private async render() {
    if (!this.active) return; // toggle-off/stop()/review cleared the badge
    const mode = this.state.mode;
    const color = MODE_COLORS[mode];
    const esc = (s: string) => s.replace(/["\\]/g, '');
    // In command mode show the `:` line being typed (vim-style '<,'> marker
    // when a selection is the implicit range) with the wildmenu stacked
    // above; otherwise the mode name.
    let label: string;
    if (mode === 'command') {
      const range = this.vSelIds.length ? "'<,'>" : '';
      const menu = this.suggestions
        .map((s, i) => `${i === this.suggestIdx ? '▸' : ' '} ${esc(s.label)}`)
        .join('\\A');
      label = `${menu ? menu + '\\A' : ''}:${range}${esc(this.state.commandLine)}`;
    } else if (mode === 'search') {
      // vim convention: '/' prefixes a forward search line.
      label = `/${esc(this.state.searchLine)}`;
    } else {
      label = `-- ${MODE_LABELS[mode]} --`;
      // vim shows "recording @a" in the statusline for the whole recording;
      // the badge is this plugin's statusline. Kept visible through insert
      // mode too — that's exactly when forgetting an open recording hurts.
      if (this.state.recording) label += ` recording @${this.state.recording.reg}`;
    }
    // The visual-line tint survives into command mode so the user can see
    // what a range command (:s over the selection) will act on while typing.
    const selCss =
      (mode === 'visual-line' || mode === 'command') && this.vSelIds.length
        ? this.vSelIds
            .map(
              (id) =>
                `[data-rem-id="${id}"] { background: rgba(217,119,6,0.16); border-radius: 4px; }`
            )
            .join('\n')
        : '';
    // Cursorline: outside insert mode the focused row gets a mode-colored
    // tint and a bar at its left edge, so the (thin) caret is findable at a
    // glance — vim's 'cursorline' for an outliner. The sandbox can't draw a
    // real block cursor on the host page (§9 native-mode lockout), so this
    // plus the bright caret-color below IS the mode indicator at the caret.
    const dark = MODE_COLORS_DARK[mode];
    const cursorLineCss =
      mode === 'normal' || mode === 'visual' || mode === 'command' || mode === 'search'
        ? `
      [data-rem-id]:focus-within {
        background: color-mix(in srgb, ${color} 8%, transparent); border-radius: 4px;
        box-shadow: inset 3px 0 0 0 ${color};
      }
      body.dark [data-rem-id]:focus-within {
        background: color-mix(in srgb, ${dark} 13%, transparent);
        box-shadow: inset 3px 0 0 0 ${dark};
      }`
        : '';
    // Caret: bright mode color outside insert; insert keeps the editor's own
    // thin default caret, so "no colored caret" itself reads as insert mode.
    // caret-shape is a progressive enhancement — unsupported in the desktop
    // app's Chromium 136, but web users on newer browsers get a true block
    // caret in normal/visual for free.
    const caretCss =
      mode !== 'insert'
        ? `
      [contenteditable="true"] { caret-color: ${color}; }
      body.dark [contenteditable="true"] { caret-color: ${dark}; }
      @supports (caret-shape: block) {
        [contenteditable="true"] { caret-shape: ${mode === 'command' || mode === 'search' ? 'bar' : 'block'}; }
      }`
        : '';
    // Charwise visual: the native selection is the vim selection — paint it
    // in the mode color so it can't be mistaken for a plain mouse selection.
    const visualSelCss =
      mode === 'visual'
        ? `
      [contenteditable="true"] ::selection, [contenteditable="true"]::selection {
        background: color-mix(in srgb, ${color} 30%, transparent);
      }
      body.dark [contenteditable="true"] ::selection, body.dark [contenteditable="true"]::selection {
        background: color-mix(in srgb, ${dark} 35%, transparent);
      }`
        : '';
    await this.plugin.app.registerCSS(
      'vim-mode',
      `
      body::after {
        content: "${label}";
        position: fixed; right: 14px; bottom: 12px; z-index: 99999;
        padding: 2px 10px; border-radius: 6px;
        font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: 0.08em; background: ${color}; color: #fff;
        pointer-events: none; opacity: 0.9;
        white-space: pre; text-align: left;
        max-width: 70vw; overflow: hidden;
      }
      body::before {
        content: "vim ${VimAdapter.BUILD} ${mode} rx=${this.dbgCount} done=${this.dbgDone} k=${this.dbgLast} ${this.dbgV} ${this.dbgClip} ${this.dbgLeak} ${this.dbgUndo} ${this.dbgTiming} esc:${this.escapeWanted ? 'steal' : 'free'}";
        position: fixed; left: 8px; bottom: 8px; z-index: 99999; max-width: 90vw;
        font: 10px ui-monospace, monospace; color: #aaa; white-space: nowrap; overflow: hidden;
        background: rgba(0,0,0,0.6); padding: 1px 6px; border-radius: 4px;
        pointer-events: none;
      }
      ${caretCss}
      ${cursorLineCss}
      ${visualSelCss}
      ${selCss}
      `
    );
  }
}
