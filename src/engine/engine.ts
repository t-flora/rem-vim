import {
  ATOMIC_CH,
  cpBack,
  cpForward,
  cpStart,
  cpWidthAt,
  findCharCount,
  firstNonBlank,
  nextWordStart,
  numberAt,
  pairObject,
  prevWordStart,
  quoteObject,
  stopsBetween,
  wordEnd,
  wordObject,
  MotionResult,
} from './motions';
import { Action, EngineResult, Mode, Operator, Snapshot, VimState, initialState } from './types';

export { initialState };

/**
 * Feed one normalized key into the engine.
 *
 * Keys are engine symbols, not raw hotkey specs: single characters
 * ('a', 'A', '$', '0', ' '), or named keys 'Escape', 'Enter',
 * 'Backspace', 'C-r'.
 */
export function handleKey(state: VimState, key: string, snap: Snapshot): EngineResult {
  const res = recordDotRepeat(state, key, dispatch(state, key, snap));
  return recordMacro(state, key, snap, res);
}

function dispatch(state: VimState, key: string, snap: Snapshot): EngineResult {
  switch (state.mode) {
    case 'insert':
      return handleInsert(state, key, snap);
    case 'normal':
      return handleNormal(state, key, snap);
    case 'visual':
      return handleVisual(state, key, snap);
    case 'visual-line':
      return handleVisualLine(state, key, snap);
    case 'command':
      return handleCommand(state, key, snap);
    case 'search':
      return handleSearch(state, key, snap);
  }
}

/** Document-mutating actions worth repeating with `.` (undo/redo are not). */
const DOT_MUTATING = new Set<Action['t']>([
  'deleteRange',
  'insertText',
  'deleteRem',
  'pasteRem',
  'indent',
  'outdent',
  'joinRem',
]);

/**
 * Dot-repeat bookkeeping. A repeatable change is a key sequence that starts
 * AND completes in normal mode and emits a mutating action — `dw`, `3dd`,
 * `rx`, `p`, `gj`, `C-a`… Commands that enter insert mode (`cw`, `o`) are
 * not recorded: inserted text never reaches the engine (insert mode releases
 * every key), so a replay could only do half the change. `.` itself emits
 * `replayKeys` (not mutating), so it never records itself; the replayed keys
 * re-record naturally, keeping `lastChange` stable across repeats.
 */
function recordDotRepeat(pre: VimState, key: string, res: EngineResult): EngineResult {
  if (pre.mode !== 'normal') {
    if (res.state.keyLog.length) res.state = { ...res.state, keyLog: [] };
    return res;
  }
  const log = [...pre.keyLog, key];
  const st = res.state;
  const inProgress =
    st.mode === 'normal' &&
    (st.op !== null || st.pending.p !== 'none' || st.count !== '' || st.opCount !== '');
  if (inProgress) {
    res.state = { ...st, keyLog: log };
  } else if (st.mode === 'normal' && res.actions.some((a) => DOT_MUTATING.has(a.t))) {
    res.state = { ...st, keyLog: [], lastChange: log };
  } else if (st.keyLog.length) {
    res.state = { ...st, keyLog: [] };
  }
  return res;
}

/**
 * Macro bookkeeping (vim `q` / `@`, replay spelled `gq` here). Every key that
 * arrives while a recording is active is appended to it, whatever the mode —
 * except the keys that manage the recording itself (the starting `q<reg>`:
 * recording was null before this key; the stopping `q`: null after it) and
 * keys re-fed by a replay (`snap.replaying` — see the Snapshot doc comment).
 * Entering insert mode while recording earns a warning toast: insert mode
 * releases every key but Escape back to RemNote, so typed text can never be
 * part of a macro — the same platform limit that keeps `cw`/`o` out of
 * dot-repeat. The mode switch itself and the closing Escape ARE recorded, so
 * a replay still passes through insert mode, it just types nothing.
 */
function recordMacro(pre: VimState, key: string, snap: Snapshot, res: EngineResult): EngineResult {
  if (snap.replaying || !pre.recording || !res.state.recording) return res;
  const rec = res.state.recording;
  res.state = { ...res.state, recording: { reg: rec.reg, keys: [...rec.keys, key] } };
  if (pre.mode !== 'insert' && res.state.mode === 'insert') {
    res.actions = [
      ...res.actions,
      { t: 'toast', msg: `recording @${rec.reg}: typed text is not captured (insert mode)` },
    ];
  }
  return res;
}

// ---------------------------------------------------------------- command line

const PAGE = 12; // Rems moved by Ctrl-D / Ctrl-U

function handleCommand(state: VimState, key: string, snap: Snapshot): EngineResult {
  // Command mode can be entered from visual/visual-line with the selection
  // kept alive (so range commands can act on it). Leaving command mode — by
  // running a command or cancelling — always drops that selection: the rem
  // trail via clearRemSelection AND any native charwise text selection via
  // collapseSelection (entered-from-`v` case).
  const leave = (actions: Action[]): EngineResult => ({
    state: { ...state, mode: 'normal', commandLine: '' },
    actions: [
      ...actions,
      { t: 'clearRemSelection' },
      { t: 'collapseSelection', at: snap.caret },
      { t: 'mode', mode: 'normal' },
    ],
  });
  if (key === 'Escape') {
    return leave([]);
  }
  if (key === 'Enter') {
    const cmd = state.commandLine.trim();
    return leave(cmd ? [{ t: 'runEx', cmd }] : []);
  }
  if (key === 'Backspace') {
    // Backspacing past the ':' leaves command mode entirely.
    if (state.commandLine.length === 0) {
      return leave([]);
    }
    return { state: { ...state, commandLine: state.commandLine.slice(0, -1) }, actions: [] };
  }
  if (key.length === 1) {
    return { state: { ...state, commandLine: state.commandLine + key }, actions: [] };
  }
  return { state, actions: [] };
}

// ---------------------------------------------------------------- search line

/**
 * `space<pattern><Enter>` incremental search. Structured exactly like
 * handleCommand above (accumulate into a buffer, Enter submits, Escape/
 * Backspace-past-empty cancels) — the difference is what leaving emits: a
 * `search` Action carrying the raw typed pattern, resolved by the adapter
 * (match-finding needs async SDK calls the pure engine never makes). Unlike
 * command mode, search is only ever entered from NORMAL mode (no visual
 * selection to preserve/clear on the way out), so `leave` is simpler.
 */
function handleSearch(state: VimState, key: string, _snap: Snapshot): EngineResult {
  const leave = (actions: Action[]): EngineResult => ({
    state: { ...state, mode: 'normal', searchLine: '' },
    actions: [...actions, { t: 'mode', mode: 'normal' }],
  });
  if (key === 'Escape') {
    // Cancel: no action at all, so the caret/document are left untouched.
    return leave([]);
  }
  if (key === 'Enter') {
    const pattern = state.searchLine;
    return leave(pattern ? [{ t: 'search', pattern }] : []);
  }
  if (key === 'Backspace') {
    // Backspacing past the start leaves search mode entirely (mirrors ':').
    if (state.searchLine.length === 0) {
      return leave([]);
    }
    return { state: { ...state, searchLine: state.searchLine.slice(0, -1) }, actions: [] };
  }
  if (key.length === 1) {
    return { state: { ...state, searchLine: state.searchLine + key }, actions: [] };
  }
  return { state, actions: [] };
}

// ---------------------------------------------------------------- helpers

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function toMode(state: VimState, mode: Mode, actions: Action[]): EngineResult {
  return {
    state: { ...state, mode, count: '', op: null, opCount: '', pending: { p: 'none' } },
    actions: [...actions, { t: 'mode', mode }],
  };
}

function reset(state: VimState, actions: Action[] = []): EngineResult {
  return {
    state: { ...state, count: '', op: null, opCount: '', pending: { p: 'none' } },
    actions,
  };
}

function countOf(state: VimState): number {
  const c = state.count === '' ? 1 : parseInt(state.count, 10);
  const oc = state.opCount === '' ? 1 : parseInt(state.opCount, 10);
  return c * oc;
}

// ---------------------------------------------------------------- insert

function handleInsert(state: VimState, key: string, _snap: Snapshot): EngineResult {
  if (key === 'Escape') {
    return toMode(state, 'normal', []);
  }
  // Insert mode only steals Escape; anything else is unexpected — ignore.
  return { state, actions: [] };
}

// ---------------------------------------------------------------- motions

interface Motion {
  result: MotionResult;
  /** Line-wise motions (j/k) don't produce a char target. */
  vertical?: -1 | 1;
}

/**
 * Try to interpret `key` as a motion in the current context.
 * Returns null if the key is not a motion.
 */
function motionFor(
  state: VimState,
  key: string,
  snap: Snapshot,
  head: number
): Motion | null {
  const { text } = snap;
  const n = text.length;
  const count = countOf(state);

  const simple = (target: number, landsOn = false): Motion => ({
    result: { target: clamp(target, 0, n), landsOn },
  });

  switch (key) {
    // h/l step whole CODE POINTS: an astral char (emoji, or the adapter's
    // atomic-element placeholder) is one caret stop, never half of one.
    case 'h':
    case 'Backspace':
      return simple(cpBack(text, head, count));
    // ' ' (space) is NOT a synonym here any more — it now starts incremental
    // search (see the top-level `case ' '` in handleNormal below). `l` alone
    // still moves right.
    case 'l':
      return simple(cpForward(text, head, count));
    case '0':
      return simple(0);
    case '^':
      return simple(firstNonBlank(text));
    case '$':
      return { result: { target: n, landsOn: true } };
    case 'w':
    case 'W': {
      let t = head;
      for (let i = 0; i < count; i++) t = nextWordStart(text, t, key === 'W');
      return simple(t);
    }
    case 'b':
    case 'B': {
      let t = head;
      for (let i = 0; i < count; i++) t = prevWordStart(text, t, key === 'B');
      return simple(t);
    }
    case 'e':
    case 'E': {
      let t = head;
      for (let i = 0; i < count; i++) t = wordEnd(text, t, key === 'E');
      return { result: { target: clamp(t, 0, n), landsOn: true } };
    }
    case 'j':
      return { result: { target: head, landsOn: false }, vertical: 1 };
    case 'k':
      return { result: { target: head, landsOn: false }, vertical: -1 };
    case 'Enter':
      return { result: { target: head, landsOn: false }, vertical: 1 };
    // ';' is NOT a find-repeat here: it is the live spelling of ':' (command
    // line), and doubling it up as "repeat find" made it unpredictable.
    // ',' still repeats the last f/F/t/T in the reverse direction.
    case ',': {
      if (!state.lastFind) return null;
      const fk = ({ f: 'F', F: 'f', t: 'T', T: 't' } as const)[state.lastFind.key];
      const r = findCharCount(text, head, fk, state.lastFind.ch, count, true);
      return r ? { result: r } : null;
    }
  }
  return null;
}

/**
 * Resolve a text-object key (the char after `i`/`a`) to a range. `b`/`B`
 * are vim's block synonyms — the only live-typeable spelling of `i(`/`i{`,
 * since `(`/`)`/`{`/`}` are shifted keys the stealing can't see. `"` is
 * likewise unreachable live (arrives as `'`) but supported for other hosts.
 */
function textObjectFor(
  text: string,
  caret: number,
  key: string,
  around: boolean
): { start: number; end: number } | null {
  switch (key) {
    case 'w':
    case 'W':
      return wordObject(text, caret, around, key === 'W');
    case 'b':
    case '(':
    case ')':
      return pairObject(text, caret, '(', ')', around);
    case 'B':
    case '{':
    case '}':
      return pairObject(text, caret, '{', '}', around);
    case '[':
    case ']':
      return pairObject(text, caret, '[', ']', around);
    case "'":
    case '"':
    case '`':
      return quoteObject(text, caret, key, around);
  }
  return null;
}

// ---------------------------------------------------------------- normal

function handleNormal(state: VimState, key: string, snap: Snapshot): EngineResult {
  const { text, caret } = snap;
  const n = text.length;
  const count = countOf(state);

  // --- multi-key continuations first
  if (state.pending.p === 'replace') {
    if (key.length !== 1) return reset(state);
    if (caret >= n) return reset(state);
    // vim: [count]r fails outright when fewer than count chars remain —
    // no partial replacement. Chars are code points (emoji count as one);
    // atomic elements (references etc.) can't be rewritten as text.
    if (stopsBetween(text, caret, n) < count) return reset(state);
    const end = cpForward(text, caret, count);
    if (text.slice(caret, end).includes(ATOMIC_CH)) return reset(state);
    // keepLead: the delete is immediately refilled at the same offset, so the
    // column-0 whitespace swallow must not fire (`r` on "a b" col 0 keeps " b").
    return reset(state, [
      { t: 'deleteRange', start: caret, end, keepLead: true },
      { t: 'insertText', at: caret, text: key.repeat(count) },
      { t: 'setCaret', at: caret },
    ]);
  }

  if (state.pending.p === 'find') {
    if (key.length !== 1) return reset(state);
    const fk = state.pending.key;
    // [count]f/t/F/T finds the count-th occurrence (2fx, d2fx).
    const r = findCharCount(text, caret, fk, key, count);
    const st = { ...state, lastFind: { key: fk, ch: key } };
    if (!r) return reset(st);
    if (st.op) return applyOperator(st, snap, caret, r.target);
    // Plain cursor find must land ON the char, exactly like the visual find
    // path. The forward finds (f, t) report `target` as the offset AFTER the
    // landed-on char (the inclusive operator-range end consumed by
    // applyOperator above), so the on-char cursor is target-1; F/T already
    // report an on-char offset (landsOn:false). Without this, `fz` then `x`
    // deleted the char after z, and `tx` then `x` deleted the x itself.
    const at = r.landsOn ? cpStart(text, Math.max(0, r.target - 1)) : r.target;
    return reset(st, [{ t: 'setCaret', at }]);
  }

  if (state.pending.p === 'g') {
    // Operator + g-chord: dgl = delete to end of line (vim d$), dgh = to
    // first non-blank (vim d^). The g-chords stand in for the shifted keys.
    if (state.op) {
      if (key === 'l') return applyOperator(state, snap, caret, n);
      if (key === 'h') return applyOperator(state, snap, caret, firstNonBlank(text));
      // dgf<char> = vim's dF<char> (delete backward-to-and-including char).
      // Hand off to the same find-prefix pending state `df` uses, keeping
      // state.op alive so the find continuation below calls applyOperator.
      if (key === 'f') return { state: { ...state, pending: { p: 'find', key: 'F' } }, actions: [] };
      return reset(state);
    }
    // g-chords double as unshifted synonyms for capital commands, which are
    // unreachable through RemNote's shift-blind key stealing.
    switch (key) {
      case 'g':
        return reset(state, [{ t: 'goDoc', where: 'start' }]);
      case 'e': // ge → G (end of document)
        return reset(state, [{ t: 'goDoc', where: 'end' }]);
      case 'l': // gl → $ (end of line)
        return reset(state, [{ t: 'setCaret', at: n }]);
      case 'h': // gh → ^ (first non-blank)
        return reset(state, [{ t: 'setCaret', at: firstNonBlank(text) }]);
      case 'f': // gf → F (find character backward on the line)
        return { state: { ...state, pending: { p: 'find', key: 'F' } }, actions: [] };
      case 'o': // go → O (open bullet above)
        return toMode(state, 'insert', [{ t: 'newBullet', where: 'above' }]);
      case 'a': // ga → A (append at end of line)
        return toMode(state, 'insert', [{ t: 'setCaret', at: n }]);
      case 'j': // gj → J (join with the next sibling bullet)
        return reset(state, [{ t: 'joinRem', count }]);
      case 'q': // gq<reg> → @<reg> (macro replay; '@' is shift-blind-unreachable)
        return { state: { ...state, pending: { p: 'play' } }, actions: [] };
      // NOTE: gd/gu (half-page scroll) were REMOVED 2026-07-12 — they were
      // pure aliases of Ctrl-D/Ctrl-U, which deliver fine on every host
      // (ctrl chords are not shift-blind). The letters are free again; gu
      // is reserved-by-convention for vim's own lowercase operator.
      // NOTE: a 2026-07 batch briefly bound gt/gp/gn/gc/gm to pane
      // management; removed as redundant aliases (gt/gp = Ctrl-L/Ctrl-H,
      // gn = :vs, gc = :q, and gm's pane-swap rebuilt hand-arranged layouts
      // flat). Those letters are deliberately FREE again — gn especially is
      // reserved-by-convention for vim's own "select next search match".
    }
    return reset(state);
  }

  if (state.pending.p === 'pane') {
    const st: VimState = { ...state, pending: { p: 'none' } };
    if (key === 'h') return { state: st, actions: [{ t: 'focusPane', dir: -1 }] };
    if (key === 'l' || key === 'w') return { state: st, actions: [{ t: 'focusPane', dir: 1 }] };
    return { state: st, actions: [] };
  }

  if (state.pending.p === 'textobj') {
    const around = state.pending.key === 'a';
    if (state.op && key.length === 1) {
      const obj = textObjectFor(text, caret, key, around);
      const st: VimState = { ...state, pending: { p: 'none' } };
      if (!obj) return reset(st);
      return applyOperator(st, snap, obj.start, obj.end);
    }
    return reset(state);
  }

  if (state.pending.p === 'mark') {
    if (key.length !== 1) return reset(state);
    return reset(state, [{ t: 'setMark', name: key }]);
  }
  if (state.pending.p === 'gotoMark') {
    if (key.length !== 1) return reset(state);
    return reset(state, [{ t: 'gotoMark', name: key }]);
  }

  // --- macros: q<reg> starts recording, gq<reg> replays (vim @<reg>)
  if (state.pending.p === 'record') {
    if (!/^[a-z]$/.test(key)) return reset(state);
    return reset({ ...state, recording: { reg: key, keys: [] } }, [
      { t: 'toast', msg: `recording @${key} — q stops` },
    ]);
  }
  if (state.pending.p === 'play') {
    // `.` = replay the last-replayed register (vim @@; '.' is not a register
    // name, so this can't shadow one).
    const reg = key === '.' ? state.lastMacro : /^[a-z]$/.test(key) ? key : null;
    if (!reg) return reset(state, key === '.' ? [{ t: 'toast', msg: 'no macro replayed yet' }] : []);
    const keys = state.macros[reg];
    if (!keys || keys.length === 0) {
      return reset(state, [{ t: 'toast', msg: `register @${reg} is empty — record with q${reg}` }]);
    }
    // [count]gq<reg> = vim [count]@<reg>: the executor caps total replayed
    // keys, so a huge count degrades gracefully instead of wedging.
    const repeated = count > 1 ? Array.from({ length: count }, () => keys).flat() : keys;
    return reset({ ...state, lastMacro: reg }, [{ t: 'replayKeys', keys: repeated }]);
  }

  // --- counts
  if (/^[1-9]$/.test(key) || (key === '0' && state.count !== '')) {
    return { state: { ...state, count: state.count + key }, actions: [] };
  }

  // --- pending operator: doubled operator = line-wise, or operator + motion
  if (state.op) {
    return handleOperatorKey(state, key, snap);
  }

  // --- motions
  const m = motionFor(state, key, snap, caret);
  if (m) {
    if (m.vertical) {
      return reset(state, [{ t: 'moveVertical', dir: m.vertical, count }]);
    }
    let at = m.result.target;
    // landsOn motions (e, `,` over f/t) put the cursor ON the char, so `x`
    // deletes it and `a` appends right after it (`ea` was landing at the
    // start of the NEXT word). `$` keeps this plugin's I-beam EOL convention
    // (caret past the last char, like gl) — see §0 on block-caret clamping.
    if (m.result.landsOn && key !== '$') {
      at = cpStart(text, Math.max(0, at - 1));
      if (at <= caret && (key === 'e' || key === 'E')) {
        // vim: e must land on a LATER char. From a caret already on (or past)
        // the word-end char, rerun from the next code point; if there is no
        // later word end, e fails in place (never moves backward).
        const m2 = motionFor(state, key, snap, cpForward(text, caret, 1));
        if (m2 && !m2.vertical) at = cpStart(text, Math.max(0, m2.result.target - 1));
        if (at <= caret) at = caret;
      }
    }
    return reset(state, [{ t: 'setCaret', at }]);
  }

  switch (key) {
    // --- operators
    case 'd':
    case 'c':
    case 'y':
    case '>':
    case '<':
      return {
        state: { ...state, op: key as Operator, opCount: state.count, count: '' },
        actions: [],
      };

    // --- find prefixes
    case 'f':
    case 'F':
    case 't':
    case 'T':
      return { state: { ...state, pending: { p: 'find', key } }, actions: [] };
    case 'g':
      return { state: { ...state, pending: { p: 'g' } }, actions: [] };
    case 'r':
      return { state: { ...state, pending: { p: 'replace' } }, actions: [] };

    // --- marks (rem-level; `'x` jumps like vim's line-wise mark)
    case 'm':
      return { state: { ...state, pending: { p: 'mark' } }, actions: [] };
    case "'":
      return { state: { ...state, pending: { p: 'gotoMark' } }, actions: [] };

    // --- macros: q toggles recording (vim's own key — reserved for exactly
    // this since the `z` search-repeat pick, see that comment below). Replay
    // is `gq<reg>` because vim's `@` is a shifted key the stealing can't see.
    // Ignored mid-replay like vim: a replayed q must not start a recording.
    case 'q': {
      if (snap.replaying) return reset(state);
      if (state.recording) {
        const { reg, keys } = state.recording;
        // `q<reg>q` with nothing in between clears the register — the vim
        // `qaq` idiom — so an empty save is deliberate, not an error.
        return reset({ ...state, recording: null, macros: { ...state.macros, [reg]: keys } }, [
          {
            t: 'toast',
            msg: keys.length
              ? `recorded @${reg} (${keys.length} keys) — replay with gq${reg}`
              : `register @${reg} cleared`,
          },
        ]);
      }
      return { state: { ...state, pending: { p: 'record' } }, actions: [] };
    }

    // --- mode switches
    case 'i':
      return toMode(state, 'insert', []);
    case 'a':
      return toMode(state, 'insert', [{ t: 'setCaret', at: cpForward(text, caret, 1) }]);
    case 'I':
      return toMode(state, 'insert', [{ t: 'setCaret', at: firstNonBlank(text) }]);
    case 'A':
      return toMode(state, 'insert', [{ t: 'setCaret', at: n }]);
    case 'o':
      return toMode(state, 'insert', [{ t: 'newBullet', where: 'below' }]);
    case 'O':
      return toMode(state, 'insert', [{ t: 'newBullet', where: 'above' }]);
    // v cycles: v → charwise visual (select text within the bullet),
    // vv → visual-LINE (whole bullets), vvv → back to normal. j/k in
    // charwise also switch to visual-line, so `vj` selects two bullets.
    case 'v':
    case 'V': {
      const r = toMode(state, 'visual', []);
      // Head is an ON-char index: snap to the start of the code point so an
      // astral last char doesn't leave the head between surrogate halves.
      const head = cpStart(text, clamp(caret, 0, Math.max(0, n - 1)));
      r.state.anchor = head;
      r.state.head = head;
      r.actions.push(selectionAction(r.state, snap));
      return r;
    }

    // --- simple edits
    case 'x': {
      if (caret >= n) return reset(state);
      const end = cpForward(text, caret, count);
      return reset(withCharRegister(state, text.slice(caret, end)), [
        { t: 'deleteRange', start: caret, end, yank: true },
      ]);
    }
    case 'X': {
      if (caret === 0) return reset(state);
      const start = cpBack(text, caret, count);
      return reset(withCharRegister(state, text.slice(start, caret)), [
        { t: 'deleteRange', start, end: caret, yank: true },
      ]);
    }
    case 's': {
      const end = cpForward(text, caret, count);
      const st = end > caret ? withCharRegister(state, text.slice(caret, end)) : state;
      const acts: Action[] =
        end > caret ? [{ t: 'deleteRange', start: caret, end, yank: true, keepLead: true }] : [];
      return toMode(st, 'insert', acts);
    }
    case 'D':
      return reset(withCharRegister(state, text.slice(caret)), [
        { t: 'deleteRange', start: caret, end: n, yank: true },
      ]);
    case 'C':
      return toMode(withCharRegister(state, text.slice(caret)), 'insert', [
        { t: 'deleteRange', start: caret, end: n, yank: true },
      ]);
    case 'S':
      return toMode(withCharRegister(state, text), 'insert', [
        { t: 'deleteRange', start: 0, end: n, yank: true },
      ]);
    case '~':
    case '`': {
      // backtick doubles as ~ (Shift+` is invisible to the key stealing)
      if (caret >= n) return reset(state);
      // Whole code points (an emoji toggles to itself, but must never be
      // split); atomic elements can't be rewritten as text — refuse, like r.
      const end = cpForward(text, caret, count);
      const slice = text.slice(caret, end);
      if (slice.includes(ATOMIC_CH)) return reset(state);
      const toggled = [...slice]
        .map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
        .join('');
      // keepLead: delete-then-refill at the same offset (see `r`).
      return reset(state, [
        { t: 'deleteRange', start: caret, end, keepLead: true },
        { t: 'insertText', at: caret, text: toggled },
      ]);
    }

    // --- registers
    case 'p':
    case 'P': {
      if (!state.register) return reset(state);
      if (state.register.kind === 'line') {
        return reset(state, [
          { t: 'pasteRem', where: key === 'p' ? 'below' : 'above', count },
        ]);
      }
      const txt = state.register.text.repeat(count);
      // vim: p pastes after the character under the cursor, P before it
      const at = key === 'p' ? cpForward(text, caret, 1) : caret;
      return reset(state, [{ t: 'insertText', at, text: txt }]);
    }
    case 'Y':
      return reset({ ...state, register: { kind: 'line' } }, [{ t: 'yankRem', count }]);

    // --- undo / redo
    case 'u':
      return reset(state, Array.from({ length: count }, () => ({ t: 'undo' as const })));
    case 'C-r':
      return reset(state, Array.from({ length: count }, () => ({ t: 'redo' as const })));

    // --- document jumps
    case 'G':
      return reset(state, [{ t: 'goDoc', where: 'end' }]);

    // --- scrolling (approximated as caret moves; the view follows the caret)
    // Ctrl-E/Ctrl-Y are intentionally absent: RemNote exposes no view-scroll
    // API, so a faithful "scroll without moving the cursor" is impossible —
    // those keys are left to RemNote.
    case 'C-d':
      return reset(state, [{ t: 'scroll', dir: 1, count: PAGE }]);
    case 'C-u':
      return reset(state, [{ t: 'scroll', dir: -1, count: PAGE }]);
    case 'C-w':
      return { state: { ...state, pending: { p: 'pane' }, count: '' }, actions: [] };
    // Direct pane nav (vim's common `<C-h>`/`<C-l>` ↦ `<C-w>h`/`<C-w>l`
    // mapping). These exist because a real Ctrl+W never reaches the desktop
    // app's renderer (Electron eats it) — C-w above only works on hosts that
    // deliver it.
    case 'C-h':
      return reset(state, [{ t: 'focusPane', dir: -1 }]);
    case 'C-l':
      return reset(state, [{ t: 'focusPane', dir: 1 }]);

    // --- jumplist
    case 'C-o':
      return reset(state, [{ t: 'jump', dir: -1 }]);
    case 'C-i':
      return reset(state, [{ t: 'jump', dir: 1 }]);

    // --- incremental search: repeat the last `space<pattern><CR>` search.
    // `n` is vim's own key and was free across the whole engine at the time
    // this was added. Real vim's reverse-search key is `N`, but capitals are
    // unreachable (shift-blind stealing — see keymap.ts), so an unshifted
    // stand-in is needed; of the handful of letters still unbound at the
    // time (re-grep `case '` in this switch before reusing either), `z` was
    // picked over `q` specifically to leave `q` free for a macro-record
    // command (vim's own, more idiomatic use for that letter) — which `q`
    // has since become (see the macros case above).
    // Matching itself is async (whole-document Rem enumeration), so it lives
    // entirely in the adapter — see Action's search/searchStep doc comments.
    case 'n':
      return reset(state, [{ t: 'searchStep', dir: 1 }]);
    case 'z':
      return reset(state, [{ t: 'searchStep', dir: -1 }]);

    // --- number increment / decrement (vim Ctrl-A / Ctrl-X)
    case 'C-a':
    case 'C-x': {
      const r = numberAt(text, caret);
      if (!r) return reset(state);
      const next = String(r.value + (key === 'C-a' ? count : -count));
      return reset(state, [
        { t: 'deleteRange', start: r.start, end: r.end, keepLead: true },
        { t: 'insertText', at: r.start, text: next },
        // vim leaves the cursor on the last digit of the result
        { t: 'setCaret', at: r.start + next.length - 1 },
      ]);
    }

    // --- dot-repeat: replay the last normal-mode change
    case '.': {
      if (!state.lastChange || state.lastChange.length === 0) return reset(state);
      return reset(state, [{ t: 'replayKeys', keys: state.lastChange }]);
    }

    // --- command-line mode. ':' is unreachable live (shift-blind stealing
    // reports it as ';'), so ';' doubles as ':' — always, now that the
    // find-repeat meaning of ';' is retired. '/' is deliberately NOT ours:
    // it is not stolen at all, so RemNote's own slash-command menu opens
    // (user's call — RemNote commands stay on /, vim Ex lives on ;).
    case ':':
    case ';':
      return { state: { ...state, mode: 'command', commandLine: '', count: '', op: null, pending: { p: 'none' } }, actions: [{ t: 'mode', mode: 'command' }] };

    // space: start an incremental search (previously a synonym for `l`
    // right-motion — see motionFor above; `l` itself is unaffected). Typed
    // characters accumulate in handleSearch until Enter submits a `search`
    // Action or Escape cancels without moving.
    case ' ':
      return {
        state: { ...state, mode: 'search', searchLine: '', count: '', op: null, pending: { p: 'none' } },
        actions: [{ t: 'mode', mode: 'search' }],
      };

    case 'Escape':
      return reset(state);
  }

  return reset(state);
}

function withCharRegister(state: VimState, text: string): VimState {
  return { ...state, register: { kind: 'char', text } };
}

// ------------------------------------------------- operator + motion

function handleOperatorKey(state: VimState, key: string, snap: Snapshot): EngineResult {
  const op = state.op as Operator;
  const { text, caret } = snap;
  const count = countOf(state);

  // Doubled operator → line-wise (dd, cc, yy, >>, <<)
  if (key === op) {
    switch (op) {
      case 'd':
        return reset(
          { ...state, register: { kind: 'line' } },
          [{ t: 'deleteRem', count }]
        );
      case 'y':
        return reset({ ...state, register: { kind: 'line' } }, [{ t: 'yankRem', count }]);
      case 'c':
        return toMode(withCharRegister(state, text), 'insert', [
          { t: 'deleteRange', start: 0, end: text.length, yank: true, keepLead: true },
        ]);
      case '>':
        return reset(state, [{ t: 'indent' }]);
      case '<':
        return reset(state, [{ t: 'outdent' }]);
    }
  }

  // Text objects: operator + i/a waits for the object key (iw, aw)
  if (key === 'i' || key === 'a') {
    return { state: { ...state, pending: { p: 'textobj', key } }, actions: [] };
  }

  // find-motion prefixes inside an operator (df, ct, ...)
  if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
    return { state: { ...state, pending: { p: 'find', key } }, actions: [] };
  }
  // g-chord motions inside an operator (dgl = d$, dgh = d^)
  if (key === 'g') {
    return { state: { ...state, pending: { p: 'g' } }, actions: [] };
  }

  // cw acts like ce when on a word character (vim quirk)
  let effKey = key;
  if (op === 'c' && (key === 'w' || key === 'W') && caret < text.length && !/\s/.test(text[caret])) {
    effKey = key === 'w' ? 'e' : 'E';
  }

  const m = motionFor(state, effKey, snap, caret);
  if (m && !m.vertical) {
    return applyOperator(state, snap, caret, m.result.target);
  }

  return reset(state);
}

function applyOperator(state: VimState, snap: Snapshot, from: number, to: number): EngineResult {
  const op = state.op as Operator;
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const slice = snap.text.slice(start, end);

  switch (op) {
    case 'd':
      if (start === end) return reset(state);
      return reset(withCharRegister(state, slice), [{ t: 'deleteRange', start, end, yank: true }]);
    case 'c':
      return toMode(withCharRegister(state, slice), 'insert', [
        { t: 'deleteRange', start, end, yank: true, keepLead: true },
      ]);
    case 'y':
      if (start === end) return reset(state);
      return reset(withCharRegister(state, slice), [
        { t: 'copyText', text: slice, start, end },
        { t: 'setCaret', at: start },
      ]);
    case '>':
      return reset(state, [{ t: 'indent' }]);
    case '<':
      return reset(state, [{ t: 'outdent' }]);
  }
}

// ---------------------------------------------------------------- visual

// The selection covers the WHOLE code point the head sits on (an astral char
// or atomic-element placeholder is 2 units wide — hi+1 would cut it in half).
function selectionAction(state: VimState, snap: Snapshot): Action {
  const { start, end } = visualRange(state, snap);
  return { t: 'select', start, end };
}

function visualRange(state: VimState, snap: Snapshot): { start: number; end: number } {
  const n = snap.text.length;
  const lo = Math.min(state.anchor, state.head);
  const hi = Math.max(state.anchor, state.head);
  return { start: lo, end: clamp(hi + cpWidthAt(snap.text, hi), 0, Math.max(n, lo)) };
}

/**
 * `gs<key>`: visual-mode charwise surround. Delimiter selector -> [open,
 * close]. Several shifted delimiters RemNote's shift-blind key stealing can
 * never report on their own (`"`, `*`, `(`, `)`, `{`, `}` — see keymap.ts's
 * doc comment) are reached the same way `~` is reached via backtick: an
 * unshifted stand-in, either the literal unshifted key (`'`/`` ` ``/`[`/`]`)
 * or the physical unshifted sibling of the shifted symbol on a US layout
 * (`8` for `*`, `9`/`0` for the `(`/`)` pair — the same "same physical key"
 * logic as `8`→`*`, applied twice). `q` ("quote") is a free mnemonic letter
 * standing in for the otherwise-unreachable `"`.
 *
 *   '   ->  '…'    literal, directly typeable
 *   `   ->  `…`    literal, directly typeable
 *   [ ] ->  […]    literal, either bracket key wraps the same pair
 *   q   ->  "…"    mnemonic ("quote"); `"` is shift+' and unreachable
 *   8   ->  *…*    unshifted sibling of `*` (shift+8), same physical key
 *   9 0 ->  (…)    unshifted siblings of `(`/`)` (shift+9 / shift+0)
 *
 * Curly braces (`{`/`}`) are deliberately NOT mapped: unlike `(`/`)` there's
 * no unshifted-sibling digit to piggyback on, and none of the letters still
 * free in visual mode's dispatch (m, n, r, u, z — checked by grepping
 * `case '` across handleVisual/motionFor) reads as an obvious curly/brace
 * mnemonic. Left out rather than picked arbitrarily.
 */
const SURROUND_PAIRS: Record<string, [string, string]> = {
  "'": ["'", "'"],
  '`': ['`', '`'],
  '[': ['[', ']'],
  ']': ['[', ']'],
  q: ['"', '"'],
  '8': ['*', '*'],
  '9': ['(', ')'],
  '0': ['(', ')'],
};

function handleVisual(state: VimState, key: string, snap: Snapshot): EngineResult {
  const { text } = snap;
  const n = text.length;

  if (key === 'Escape') {
    // collapseSelection, not setCaret: a relative caret move against the
    // live native selection resizes it instead of clearing it.
    return toMode(state, 'normal', [
      { t: 'collapseSelection', at: clamp(state.head, 0, n) },
    ]);
  }

  // gs<delimiter>: consumes the very next key as the delimiter selector.
  // Checked ahead of digit-accumulation/g-dispatch/mode-toggle below so ANY
  // next key — including digits (`8`, `9`, `0` from the table above) and
  // letters that would otherwise start a different chord — is read as the
  // delimiter, never reinterpreted as a count or another command.
  if (state.pending.p === 'surround') {
    const cancel: VimState = { ...state, pending: { p: 'none' }, count: '' };
    const pair = key.length === 1 ? SURROUND_PAIRS[key] : undefined;
    if (!pair) return { state: cancel, actions: [] };
    const range = visualRange(state, snap);
    if (range.start >= range.end) {
      // Empty selection (only possible on an empty bullet) — no-op, just
      // leave visual mode like the other visual commands do on a no-op.
      return toMode(cancel, 'normal', [{ t: 'setCaret', at: range.start }]);
    }
    // Deliberately NOT delete-then-reinsert-the-slice (unlike ~/r, or the
    // skeleton this was first drafted from): insertText runs every payload
    // through the adapter's sanitizeInsert, which strips ATOMIC_CH — so
    // round-tripping the selection's own text through it would silently
    // destroy any rem-reference/image/LaTeX chip inside the selection (the
    // same lossy path `cw`/register-paste already accept for charwise
    // edits). Instead we insert ONLY the two plain-ASCII delimiter chars,
    // around the untouched selection, so nothing inside it ever passes
    // through insertText — chips and any rich formatting survive intact.
    // Close first: inserting after the selection doesn't shift `range.start`,
    // so the second insert's offset is still valid on the mutated line.
    // collapseSelection MUST precede the inserts: unlike the other visual
    // mutators, gs runs no deleteRange (whose select+cut consumes the native
    // selection), so the live selection would still be active when the first
    // insertText's relative moveCaret runs — and a relative move against a
    // live selection RESIZES it instead of moving the caret (verified live
    // 2026-07-10: both delimiters landed at the selection start, '()abc'
    // instead of '(abc)').
    return toMode(cancel, 'normal', [
      { t: 'collapseSelection', at: range.end },
      { t: 'insertText', at: range.end, text: pair[1] },
      { t: 'insertText', at: range.start, text: pair[0] },
      { t: 'setCaret', at: range.start },
    ]);
  }

  // g-chords: gg/ge escalate to a line-wise selection reaching the document
  // boundary (vim v gg / v G); gl/gh stay charwise, extending the selection
  // to the line end / first non-blank ($ / ^ synonyms); gs starts the
  // surround-pending state above.
  if (state.pending.p === 'g') {
    const st: VimState = { ...state, pending: { p: 'none' }, count: '' };
    if (key === 'g' || key === 'e') {
      const r = toMode(st, 'visual-line', []);
      r.actions.push({ t: 'vStart' });
      r.actions.push({ t: 'vExtend', dir: key === 'g' ? -1 : 1, count: 1000 });
      return r;
    }
    if (key === 'l' || key === 'h') {
      const target = key === 'l' ? cpStart(text, Math.max(0, n - 1)) : firstNonBlank(text);
      const st2 = { ...st, head: clamp(target, 0, Math.max(0, n - 1)) };
      return { state: st2, actions: [selectionAction(st2, snap)] };
    }
    // vgf<char> = vim's vF<char> (extend the selection backward to a char).
    // Hand off to the same find-prefix pending state `vf` uses below.
    if (key === 'f') {
      return { state: { ...state, pending: { p: 'find', key: 'F' } }, actions: [] };
    }
    if (key === 's') {
      return { state: { ...st, pending: { p: 'surround' } }, actions: [] };
    }
    return { state: st, actions: [] };
  }
  if (key === 'g') {
    return { state: { ...state, pending: { p: 'g' } }, actions: [] };
  }
  if (key === 'G') {
    const r = toMode(state, 'visual-line', []);
    r.actions.push({ t: 'vStart' });
    r.actions.push({ t: 'vExtend', dir: 1, count: 1000 });
    return r;
  }

  if (key === 'v' || key === 'V') {
    // second v: switch to visual-LINE mode (whole bullets)
    const r = toMode(state, 'visual-line', []);
    r.actions.push({ t: 'vStart' });
    return r;
  }

  if (/^[0-9]$/.test(key) && !(key === '0' && state.count === '')) {
    return { state: { ...state, count: state.count + key }, actions: [] };
  }

  if (state.pending.p === 'find') {
    const fk = state.pending.key;
    const r =
      key.length === 1 ? findCharCount(text, state.head, fk, key, countOf(state)) : null;
    const st: VimState = { ...state, pending: { p: 'none' }, count: '' };
    if (!r) return { state: st, actions: [] };
    st.lastFind = { key: fk, ch: key };
    st.head = cpStart(text, clamp(r.landsOn ? r.target - 1 : r.target, 0, Math.max(0, n - 1)));
    return { state: st, actions: [selectionAction(st, snap)] };
  }

  if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
    return { state: { ...state, pending: { p: 'find', key } }, actions: [] };
  }

  // text objects reshape the whole selection (vim vi[ / va')
  if (state.pending.p === 'textobj') {
    const around = state.pending.key === 'a';
    const st: VimState = { ...state, pending: { p: 'none' }, count: '' };
    const obj = key.length === 1 ? textObjectFor(text, st.head, key, around) : null;
    if (!obj || obj.end <= obj.start) return { state: st, actions: [] };
    const st2 = {
      ...st,
      anchor: obj.start,
      head: cpStart(text, clamp(obj.end - 1, 0, Math.max(0, n - 1))),
    };
    return { state: st2, actions: [selectionAction(st2, snap)] };
  }
  if (key === 'i' || key === 'a') {
    return { state: { ...state, pending: { p: 'textobj', key } }, actions: [] };
  }

  const m = motionFor(state, key, snap, state.head);
  if (m && !m.vertical) {
    const onChar = (t: number) => cpStart(text, clamp(t, 0, Math.max(0, n - 1)));
    let target = m.result.landsOn ? onChar(m.result.target - 1) : m.result.target;
    // Inclusive motions measure from an I-beam caret, but the visual head is
    // an ON-char index — when the head already sits on a word's last char,
    // `e` reports that same char and the selection would never grow. Rerun
    // the motion from one char later (vim's "must land later" block-cursor
    // rule applies here, unlike in normal mode).
    if (m.result.landsOn && target === state.head && cpForward(text, state.head, 1) < n) {
      const m2 = motionFor(state, key, snap, cpForward(text, state.head, 1));
      if (m2 && !m2.vertical) {
        target = m2.result.landsOn ? onChar(m2.result.target - 1) : m2.result.target;
      }
    }
    const st = { ...state, head: onChar(target), count: '' };
    return { state: st, actions: [selectionAction(st, snap)] };
  }
  if (m && m.vertical) {
    // j/k in charwise visual: switch to LINE selection and extend — this is
    // what vim muscle memory expects from `v j` / `V j` (V arrives as v here,
    // since RemNote's key stealing is shift-blind).
    const r = toMode(state, 'visual-line', []);
    r.actions.push({ t: 'vStart' });
    r.actions.push({ t: 'vExtend', dir: m.vertical, count: countOf(state) });
    return r;
  }

  const range = visualRange(state, snap);
  const slice = text.slice(range.start, range.end);

  switch (key) {
    case 'o': {
      const st = { ...state, anchor: state.head, head: state.anchor };
      return { state: st, actions: [selectionAction(st, snap)] };
    }
    case 'd':
    case 'x':
      return toMode(withCharRegister(state, slice), 'normal', [
        { t: 'deleteRange', start: range.start, end: range.end, yank: true },
      ]);
    case 'c':
    case 's':
      return toMode(withCharRegister(state, slice), 'insert', [
        { t: 'deleteRange', start: range.start, end: range.end, yank: true, keepLead: true },
      ]);
    case 'y':
      return toMode(withCharRegister(state, slice), 'normal', [
        { t: 'copyText', text: slice, start: range.start, end: range.end },
        { t: 'setCaret', at: range.start },
      ]);
    case 'p':
    case 'P': {
      if (!state.register || state.register.kind !== 'char') {
        return toMode(state, 'normal', [{ t: 'setCaret', at: range.start }]);
      }
      const txt = state.register.text;
      return toMode(withCharRegister(state, slice), 'normal', [
        { t: 'deleteRange', start: range.start, end: range.end, keepLead: true },
        { t: 'insertText', at: range.start, text: txt },
      ]);
    }
    case '>':
      return toMode(state, 'normal', [{ t: 'indent' }]);
    case '<':
      return toMode(state, 'normal', [{ t: 'outdent' }]);
    case '~':
    case '`': {
      // backtick doubles as ~ (Shift+` is invisible to the key stealing) —
      // same convention as normal-mode `~`. Unlike normal-mode `~`, this
      // toggles the WHOLE selection (no count-width slicing needed: the
      // selection itself is the target), and vim's real visual `~` does NOT
      // yank the original text, so state.register is left untouched.
      if (slice.includes(ATOMIC_CH)) {
        // Same refusal as normal-mode `~`: an atomic rich-text placeholder
        // can't be reconstructed by insertText (sanitizeInsert strips it),
        // so toggling case around/through one would silently destroy the
        // chip. Still leave visual mode, like every other visual command.
        return toMode(state, 'normal', [{ t: 'setCaret', at: range.start }]);
      }
      const toggled = [...slice]
        .map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
        .join('');
      return toMode(state, 'normal', [
        { t: 'deleteRange', start: range.start, end: range.end, keepLead: true },
        { t: 'insertText', at: range.start, text: toggled },
        // insertText alone would leave the caret after the (same-length)
        // toggled text; vim leaves the cursor at the START of the region.
        { t: 'setCaret', at: range.start },
      ]);
    }

    // command line from charwise visual — range commands (:s) act on the
    // focused bullet ('/' is not stolen; it belongs to RemNote's slash menu)
    case ':':
    case ';':
      return {
        state: { ...state, mode: 'command', commandLine: '', count: '', op: null, pending: { p: 'none' } },
        actions: [{ t: 'mode', mode: 'command' }],
      };
  }

  return { state: { ...state, count: '' }, actions: [] };
}

function handleVisualLine(state: VimState, key: string, snap: Snapshot): EngineResult {
  const count = countOf(state);

  // g-chords: gg extends to the top of the document, ge to the bottom
  if (state.pending.p === 'g') {
    const st: VimState = { ...state, pending: { p: 'none' }, count: '' };
    if (key === 'g') return { state: st, actions: [{ t: 'vExtend', dir: -1, count: 1000 }] };
    if (key === 'e') return { state: st, actions: [{ t: 'vExtend', dir: 1, count: 1000 }] };
    return { state: st, actions: [] };
  }
  if (key === 'g') {
    return { state: { ...state, pending: { p: 'g' } }, actions: [] };
  }

  // counts (3j extends by three visible rows)
  if (/^[1-9]$/.test(key) || (key === '0' && state.count !== '')) {
    return { state: { ...state, count: state.count + key }, actions: [] };
  }

  switch (key) {
    // --- extend / shrink the selection one VISIBLE row at a time (vim V+j/k)
    case 'j':
    case 'Enter':
      return reset(state, [{ t: 'vExtend', dir: 1, count }]);
    case 'k':
      return reset(state, [{ t: 'vExtend', dir: -1, count }]);
    case 'G':
      return reset(state, [{ t: 'vExtend', dir: 1, count: 1000 }]);

    // --- operations on the selected bullets
    case 'd':
    case 'x':
      return toMode({ ...state, register: { kind: 'line' } }, 'normal', [
        { t: 'deleteRemSelection' },
      ]);
    case 'y':
      return toMode({ ...state, register: { kind: 'line' } }, 'normal', [
        { t: 'yankRemSelection' },
      ]);
    case 'c':
      // vim cc-on-selection: replace the selected lines with one empty line
      return toMode({ ...state, register: { kind: 'line' } }, 'insert', [
        { t: 'deleteRemSelection' },
        { t: 'newBullet', where: 'below' },
      ]);
    // Physically pressing vim's > and < works (Shift is invisible, so they
    // arrive as '.' and ','). Bare '.'/',' alias them ONLY in this mode;
    // normal-mode '.' stays reserved for a future repeat command.
    case '>':
    case '.':
      return toMode(state, 'normal', [{ t: 'indentSelection' }, { t: 'clearRemSelection' }]);
    case '<':
    case ',':
      return toMode(state, 'normal', [{ t: 'outdentSelection' }, { t: 'clearRemSelection' }]);
    case 'v':
      // third v completes the cycle: back to normal
      return toMode(state, 'normal', [{ t: 'clearRemSelection' }]);
    case 'p':
    case 'P':
      // replace the selected bullets with the line register
      if (state.register?.kind === 'line') {
        return toMode(state, 'normal', [
          { t: 'deleteRemSelection' },
          { t: 'pasteRem', where: 'above', count: 1 },
        ]);
      }
      return { state, actions: [] };

    // command line over the selection: the bullet trail is deliberately NOT
    // cleared, so range Ex commands (:s over the selection) apply to every
    // selected bullet. Leaving command mode clears it. ('/' is not stolen —
    // RemNote's slash menu owns it.)
    case ':':
    case ';':
      return {
        state: { ...state, mode: 'command', commandLine: '', count: '', op: null, pending: { p: 'none' } },
        actions: [{ t: 'mode', mode: 'command' }],
      };

    case 'Escape':
    case 'V':
      return toMode(state, 'normal', [{ t: 'clearRemSelection' }]);
  }
  return { state: { ...state, count: '' }, actions: [] };
}
