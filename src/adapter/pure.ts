/**
 * Pure, SDK-free helpers for the adapter — everything here is plain data math
 * so the unit suite can cover it directly (adapter.ts itself can only be
 * exercised live). The RichTextInterface import is type-only (erased at
 * runtime), so this module stays loadable outside the plugin sandbox.
 */
import type { RichTextInterface } from '@remnote/plugin-sdk';
import { ATOMIC_CH } from '../engine/motions';
import type { Mode, VimState } from '../engine/types';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Flatten RemNote rich text into the MODEL-SPACE string the engine reasons
 * about. The invariant (probed live 2026-07-08 on RemNote 1.26.30): the
 * result's UTF-16 length equals RemNote's own rich-text offset space — the
 * space `editor.selectText` ranges and `getSelection().range` are measured
 * in. Concretely:
 *
 *   - plain string segments and `{i:'m'}` text runs count their UTF-16 units
 *     (an emoji inside text is 2 units in both spaces);
 *   - every OTHER element (rem reference `q`, image `i`, LaTeX `x`, audio,
 *     card delimiter, …) is ATOMIC: RemNote gives it exactly 2 units, so it
 *     becomes the single astral placeholder ATOMIC_CH (2 units, 1 code
 *     point — one caret stop, which is also what `moveCaret` counts).
 *
 * The old approach (`richText.toString`, which expands a reference to its
 * full display name) shifted every offset right of the element by
 * name-length − 2: motions and deletes on formatted lines hit the wrong
 * characters, and the engine believed the line was longer than the editor
 * did. That was the user-visible "cursor thinks it's at EOL / chaos on
 * formatted lines" instability.
 */
export function flattenRich(rich: RichTextInterface | undefined | null): string {
  if (!rich) return '';
  let out = '';
  for (const el of rich) {
    if (typeof el === 'string') out += el;
    else if (el.i === 'm') out += el.text ?? '';
    else out += ATOMIC_CH;
  }
  return out;
}

/**
 * Strip atomic-element placeholders from text about to be INSERTED as plain
 * text (charwise `p`, the copyText reinsert path). A chip can't be recreated
 * from its placeholder — inserting the literal private-use char would put
 * garbage in the document. The whole-line register (dd/yy) keeps full rich
 * text and is unaffected; only charwise registers lose atomic elements,
 * which is documented as a known limitation.
 */
export function sanitizeInsert(text: string): string {
  return text.split(ATOMIC_CH).join('');
}

/**
 * Clip a wildmenu label to `max` code points, appending an ellipsis. The
 * command-line badge renders suggestions via CSS `content` with
 * `white-space: pre` (so multi-line stacking via literal `\A` works) and no
 * `text-overflow` can apply to that — a single very long Rem name/text would
 * otherwise push the badge off-screen. Truncate at the string level instead.
 */
export function truncateLabel(s: string, max = 60): string {
  return [...s].length > max ? [...s].slice(0, max).join('') + '…' : s;
}

/**
 * Infer the caret position after `pre` changed into `fresh`: find the common
 * prefix/suffix and put the caret at the end of the changed region (which is
 * where typing/deleting leaves it). If nothing changed, keep `fallback`.
 */
export function diffCaret(pre: string, fresh: string, fallback: number): number {
  if (pre === fresh) return clamp(fallback, 0, fresh.length);
  let p = 0;
  const maxP = Math.min(pre.length, fresh.length);
  while (p < maxP && pre[p] === fresh[p]) p++;
  let s = 0;
  const maxS = Math.min(pre.length - p, fresh.length - p);
  while (s < maxS && pre[pre.length - 1 - s] === fresh[fresh.length - 1 - s]) s++;
  return clamp(fresh.length - s, 0, fresh.length);
}

/**
 * Wrap `idx` by `dir` steps within `[0, len)`, vim tab-cycle style: past the
 * last index comes back to 0, before 0 comes back to the last. Used by
 * pane-focus cycling (Ctrl-H/Ctrl-L, Ctrl-W h/l) via `cyclePaneId` below.
 * Returns `idx` unchanged when `len` is 0 (nothing to wrap into).
 */
export function wrapIndex(len: number, idx: number, dir: -1 | 1): number {
  if (len <= 0) return idx;
  return (idx + dir + len) % len;
}

/**
 * The pane id `dir` steps away from `currentId` in `ids` (RemNote's flat
 * `getOpenPaneIds()` order), wrapping around at the ends. `undefined` when
 * there's nothing to cycle to (fewer than 2 panes). `currentId` not being
 * found in `ids` (shouldn't happen live) falls back to index 0 rather than
 * throwing.
 */
export function cyclePaneId(ids: string[], currentId: string, dir: -1 | 1): string | undefined {
  if (ids.length < 2) return undefined;
  const idx = Math.max(0, ids.indexOf(currentId));
  return ids[wrapIndex(ids.length, idx, dir)];
}

export interface SettleOpts {
  /** Extra confirmation reads after the first (default 3). */
  rounds?: number;
  /** Pause between reads (default 40 ms). */
  delayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Read a lagging async source until two consecutive reads AGREE (bounded).
 * RemNote's editor read API can return text from a keystroke or two ago
 * right after native typing or an SDK edit — a single read at a mode
 * boundary can capture a truncated line, and every later offset computation
 * inherits the error ("cursor believes it is at the end of the line while
 * characters remain"). Agreement between two reads ~40 ms apart is the
 * cheapest observable signal that the editor has flushed.
 */
export async function settleRead<T>(
  read: () => Promise<T>,
  equals: (a: T, b: T) => boolean,
  opts: SettleOpts = {}
): Promise<T> {
  const {
    rounds = 3,
    delayMs = 40,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;
  let prev = await read();
  for (let i = 0; i < rounds; i++) {
    await sleep(delayMs);
    const next = await read();
    if (equals(prev, next)) return next;
    prev = next;
  }
  return prev;
}

/**
 * Resolve the focused line's text after leaving insert mode. If no
 * `EditorTextEdited` event fired while insert mode was active, that's
 * independent proof nothing was typed — skip reading the editor entirely (no
 * network/IPC round trip to confirm something already certain, the fix for
 * the reported Insert→Normal switching delay). Otherwise read until it
 * settles, and if the settled value looks unchanged, give it one more,
 * longer-spaced confirmation read — a slow flush and "truly nothing changed"
 * are indistinguishable from a single read.
 */
export async function reconcileInsertText(
  pre: string,
  sawEdit: boolean,
  readLine: () => Promise<string | null>,
  opts: SettleOpts = {}
): Promise<string | null> {
  if (!sawEdit) return pre;
  let fresh = await settleRead(readLine, (a, b) => a === b, opts);
  if (fresh === pre) {
    fresh = await settleRead(readLine, (a, b) => a === b, { ...opts, rounds: 1, delayMs: 120 });
  }
  return fresh;
}

/**
 * Where should the caret land after `pre` became `fresh` on leaving insert
 * mode? Prefer a real DOM caret read when available (native mode only, see
 * `domCaret.ts`); otherwise infer it from the text diff.
 */
export function resolveInsertCaret(domCaret: number | null, pre: string, fresh: string, fallback: number): number {
  return clamp(domCaret ?? diffCaret(pre, fresh, fallback), 0, fresh.length);
}

/** A jumplist/mark entry: the target Rem plus which document was open in the
 * pane when it was recorded. `docId` is what makes a cross-document Ctrl-O
 * or mark-jump reopen the Rem's *actual* prior document — walking `.parent`
 * up from the target after the fact can't recover this (it has no principled
 * stopping point short of the true tree root, which over-shoots past any
 * document nested inside a folder-like parent — DEVELOPMENT.md round 5b/5c).
 */
export interface JumpEntry {
  id: string;
  docId?: string;
}

export interface JumpStepResult {
  jumps: JumpEntry[];
  jumpPos: number;
  /** The entry to focus, or `undefined` if this hop is a no-op (list
   * exhausted in that direction, or the target is already where we are). */
  target: JumpEntry | undefined;
}

/**
 * Pure jumplist stack transition for Ctrl-O (`dir: -1`) / Ctrl-I (`dir: 1`).
 * Mirrors vim's model: `jumpPos === jumps.length` means "at the live end,"
 * not currently browsing history. The first Ctrl-O off the live end stashes
 * `cur` as a new entry (so Ctrl-I can return to it) before stepping back —
 * callers should only resolve `docId` (an SDK call) when that branch is
 * actually about to run, i.e. `dir === -1 && jumpPos === jumps.length`.
 */
export function computeJumpStep(
  jumps: readonly JumpEntry[],
  jumpPos: number,
  dir: -1 | 1,
  cur: string | undefined,
  docId: string | undefined
): JumpStepResult {
  let nextJumps = jumps as JumpEntry[];
  let nextPos = jumpPos;
  if (dir === -1) {
    if (jumpPos === jumps.length) {
      if (cur && jumps[jumps.length - 1]?.id !== cur) {
        nextJumps = [...jumps, { id: cur, docId }];
      }
      // Clamped: an empty list with no `cur` to stash (focus lost) would
      // otherwise leave `nextPos` at -1, permanently wedging every future
      // hop (recordJump's `slice(0, jumpPos)` degrades gracefully on -1, but
      // there'd never be a way back to a positive position without a fresh
      // jump being recorded first).
      nextPos = Math.max(0, nextJumps.length - 1);
      if (nextPos > 0 && nextJumps[nextPos]?.id === cur) nextPos--;
    } else if (jumpPos > 0) {
      nextPos = jumpPos - 1;
    } else {
      return { jumps: nextJumps, jumpPos, target: undefined };
    }
  } else {
    if (jumpPos >= jumps.length - 1) return { jumps: nextJumps, jumpPos, target: undefined };
    nextPos = jumpPos + 1;
  }
  const target = nextJumps[nextPos];
  return {
    jumps: nextJumps,
    jumpPos: nextPos,
    target: target && target.id !== cur ? target : undefined,
  };
}

/**
 * Is `remId` among a document's descendant ids? `descendantIds` is
 * `undefined` when the document Rem itself couldn't be resolved (vanished
 * mid-check) — treated as "yes, don't block the walk", the same
 * fail-open default `isInFocusedDocument` uses for every inconclusive case,
 * since the cost of a wrong "yes" here is just falling through to the
 * (already correct, just slower) `walkCaretTo` attempt.
 */
export function isDescendantAmong(remId: string, descendantIds: string[] | undefined): boolean {
  return descendantIds === undefined || descendantIds.includes(remId);
}

/**
 * Should Escape currently be stolen? Idle normal mode (no operator/pending/
 * count in flight) releases it so RemNote's own Ctrl-P/Ctrl-K palette can see
 * the Escape a user presses to close it; any other state needs Escape
 * captured (to leave insert mode, cancel a pending operator, etc).
 */
export function isEscapeWanted(state: Pick<VimState, 'mode' | 'op' | 'pending' | 'count' | 'opCount'>): boolean {
  const idle =
    state.mode === 'normal' &&
    state.op === null &&
    state.pending.p === 'none' &&
    state.count === '' &&
    state.opCount === '';
  return !idle;
}

export type StrayEditFallout = 'ignore' | 'markInsertEdit' | 'resetPending';

/**
 * Classify an `EditorTextEdited` event that WE didn't cause (`processing` is
 * false): RemNote's key-steal matcher is shift-blind (keymap.ts) and doesn't
 * always catch a held Shift, so a capital letter can occasionally reach the
 * document as literal text while the engine still believes nothing changed.
 *   - insert mode: the typed text is normal — no engine state to fix, just
 *     remember an edit happened (reconcileAfterInsert skips a redundant read
 *     when nothing was typed).
 *   - command mode: the command-line isn't Rem text; irrelevant here.
 *   - anything else: a stray edit landed while the engine thought it owned
 *     every keystroke — the model and any in-flight pending command (e.g. `r`
 *     waiting for its replacement char) are now stale.
 */
export function classifyStrayEdit(mode: Mode, processing: boolean): StrayEditFallout {
  if (processing) return 'ignore';
  if (mode === 'insert') return 'markInsertEdit';
  if (mode === 'command') return 'ignore';
  return 'resetPending';
}

export type UndoDecision = 'structuralRevert' | 'nativeUndo';
export type RedoDecision = 'structuralReapply' | 'nativeRedo';

/**
 * `u` after a grouped structural op (paste-subtree / mass indent-outdent):
 * revert it in one step via `structuralOp` rather than counting native
 * undo-history entries (RemNote's real granularity turned out finer than
 * "one native undo per Rem touched" — the counted approach this replaced
 * never fully reversed the operation; see DEVELOPMENT.md round 1→2).
 */
export function decideUndo(hasStructuralOp: boolean, structuralApplied: boolean): UndoDecision {
  return hasStructuralOp && structuralApplied ? 'structuralRevert' : 'nativeUndo';
}

/** The `redo` twin of `decideUndo` — reapply only undoes-the-undo once. */
export function decideRedo(hasStructuralOp: boolean, structuralApplied: boolean): RedoDecision {
  return hasStructuralOp && !structuralApplied ? 'structuralReapply' : 'nativeRedo';
}

export interface RetryOpts {
  /** Total attempts, including the first (default 5). */
  attempts?: number;
  /** Pause between a failed attempt and the next (default 80 ms). */
  delayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retry an async boolean-returning operation until it succeeds or the
 * attempt budget is exhausted, pausing between failures. Right after a pane
 * navigates to a brand-new document (`window.openRem`), `moveCaretVertical`
 * silently no-ops for the first several calls — the editor hasn't finished
 * mounting yet — so a single `walkCaretTo` attempt right after `openRem`
 * reads as "hit a boundary instantly" and strands the caret on the document
 * title (see `walkToTarget`'s doc comment and DEVELOPMENT.md round 5d).
 */
export async function retryUntilTrue(op: () => Promise<boolean>, opts: RetryOpts = {}): Promise<boolean> {
  const { attempts = 5, delayMs = 80, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = opts;
  for (let i = 0; i < attempts; i++) {
    if (await op()) return true;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}

/**
 * Walk `getParentId` up from `startId` to the top-level id with no parent
 * (capped). Used as a last-resort fallback when a jumplist/mark entry has no
 * recorded `docId` (e.g. set before that tracking existed) — walking all the
 * way to the true tree root is a worse answer than the recorded `docId`
 * would have been (it can overshoot past a document nested inside a
 * folder-like parent, landing on the workspace root instead — round 5b/5c),
 * but it degrades gracefully rather than failing outright.
 */
export async function walkToRoot(
  startId: string,
  getParentId: (id: string) => Promise<string | undefined>,
  maxHops = 100
): Promise<string> {
  let cur = startId;
  for (let hop = 0; hop < maxHops; hop++) {
    const parent = await getParentId(cur);
    if (!parent) return cur;
    cur = parent;
  }
  return cur;
}

/**
 * Walk the live caret toward `targetId`, trying `firstDir` then the other
 * way, stopping the moment `currentId()` matches or a direction's steps stop
 * making progress (two consecutive reads agree — a document boundary, or the
 * post-`openRem` mount race described on `retryUntilTrue`). Every hop needs
 * an exact-match check here — unlike `walkToBoundary`, this can't batch steps
 * between checks without risking silently walking straight past the target.
 */
export async function walkToTarget(
  targetId: string,
  firstDir: -1 | 1,
  currentId: () => Promise<string | undefined>,
  step: (dir: -1 | 1) => Promise<void>,
  maxHopsPerDir = 60
): Promise<boolean> {
  if ((await currentId()) === targetId) return true;
  for (const dir of [firstDir, -firstDir] as const) {
    let prevId: string | undefined;
    for (let i = 0; i < maxHopsPerDir; i++) {
      await step(dir as -1 | 1);
      const id = await currentId();
      if (!id) break;
      if (id === targetId) return true;
      if (id === prevId) break; // boundary: no progress this hop
      prevId = id;
    }
  }
  return false;
}

export interface BoundaryWalkOpts {
  /** Blind steps taken between boundary checks (default 20). */
  batch?: number;
  /** Total step budget (default 2000). */
  maxHops?: number;
}

/**
 * Walk to a BOUNDARY (document start/end), not a specific target — so unlike
 * `walkToTarget`, batching steps between checks is safe: overshooting a
 * boundary is a no-op (there's nothing past it to skip over), whereas
 * checking after every single step (the original `gg`/`G` implementation)
 * cost 2 round trips per hop and was visibly slow on long documents
 * (DEVELOPMENT.md round 4).
 */
export async function walkToBoundary(
  step: () => Promise<void>,
  check: () => Promise<string | undefined>,
  opts: BoundaryWalkOpts = {}
): Promise<void> {
  const { batch = 20, maxHops = 2000 } = opts;
  let prevId: string | undefined;
  for (let i = 0; i < maxHops; i += batch) {
    for (let k = 0; k < batch; k++) await step();
    const id = await check();
    if (!id || id === prevId) return;
    prevId = id;
  }
}

// ------------------------------------------------------------ search

/** One document unit to search: a Rem id and its flattened line text. */
export interface SearchUnit {
  id: string;
  text: string;
}

/** A single match's location: which Rem, and the char range within it. */
export interface SearchMatch {
  id: string;
  start: number;
  end: number;
}

export type SearchOutcome =
  | { ok: true; match: SearchMatch; wrapped: boolean }
  | { ok: false; reason: 'empty' | 'badPattern' | 'noMatch' };

/**
 * Find the next (`dir: 1`) or previous (`dir: -1`) match of `pattern` — a
 * plain JS regex source, case-sensitive, consistent with `:g`/`:s`'s own
 * `new RegExp(pat)` convention — across a whole document's flattened Rem
 * texts, scanning forward/backward from just after/before
 * `(fromId, fromOffset)` and wrapping around the document boundary like
 * vim's `wrapscan`. Always progresses to the NEXT hit, never re-reports the
 * position already standing on — matching real vim, where searching for the
 * word under the cursor moves you off it (`n`/the prev-match key rely on
 * this to actually advance on repeat, and the initial `space<pattern><CR>`
 * submit reuses the exact same call for consistency).
 *
 * `units` must already be in TOP-TO-BOTTOM document order (what the
 * adapter's whole-document Rem enumeration produces); this function does no
 * Rem/SDK work itself, so every branch is exhaustively unit-testable against
 * a synthetic unit list. `fromId` not found among `units` (e.g. the focused
 * Rem is the document root itself, not one of its own descendants) is
 * treated as "positioned before the very first unit" — a forward search
 * then starts from the top, a backward one wraps immediately to the bottom.
 */
export function findSearchMatch(
  units: readonly SearchUnit[],
  fromId: string | undefined,
  fromOffset: number,
  pattern: string,
  dir: 1 | -1
): SearchOutcome {
  if (!pattern) return { ok: false, reason: 'empty' };
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'g');
  } catch {
    return { ok: false, reason: 'badPattern' };
  }
  if (units.length === 0) return { ok: false, reason: 'noMatch' };

  interface Hit {
    unitIdx: number;
    start: number;
    end: number;
  }
  const hits: Hit[] = [];
  units.forEach((u, unitIdx) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(u.text))) {
      hits.push({ unitIdx, start: m.index, end: m.index + m[0].length });
      // Zero-width matches (e.g. `x*`) would otherwise loop forever at the
      // same lastIndex.
      if (m[0].length === 0) re.lastIndex++;
    }
  });
  if (hits.length === 0) return { ok: false, reason: 'noMatch' };

  // -1 (not -Infinity clamped to 0!) when fromId isn't among units at all —
  // "positioned before the very first unit": every hit counts as forward of
  // it (so a forward search never reports a spurious wrap), and none counts
  // as behind it (so a backward search wraps straight to the last hit).
  // Clamping to 0 instead would wrongly compare a match AT unit 0 against
  // `fromOffset` as if we were really standing inside unit 0.
  const startIdx = units.findIndex((u) => u.id === fromId);
  const toMatch = (h: Hit): SearchMatch => ({ id: units[h.unitIdx].id, start: h.start, end: h.end });

  if (dir === 1) {
    const isAfter = (h: Hit) =>
      startIdx === -1 || h.unitIdx > startIdx || (h.unitIdx === startIdx && h.start > fromOffset);
    const forward = hits.find(isAfter);
    return { ok: true, match: toMatch(forward ?? hits[0]), wrapped: !forward };
  }
  const isBefore = (h: Hit) =>
    startIdx !== -1 && (h.unitIdx < startIdx || (h.unitIdx === startIdx && h.start < fromOffset));
  let backward: Hit | undefined;
  for (let i = hits.length - 1; i >= 0; i--) {
    if (isBefore(hits[i])) {
      backward = hits[i];
      break;
    }
  }
  return { ok: true, match: toMatch(backward ?? hits[hits.length - 1]), wrapped: !backward };
}
