/**
 * Keys to steal from RemNote (is-hotkey syntax) and the engine symbol each maps
 * to.
 *
 * HOW RemNote MATCHES STOLEN KEYS (read from the 1.28.32 app bundle, then
 * verified at a real keyboard on macOS, 2026-10-07): GlobalStealKeySingleton
 * runs stock `is-hotkey` on every keydown, matching by keyCode (`which`) and
 * requiring every modifier the spec doesn't name to be UP. So:
 *  - a bare spec ('a') matches only the unshifted key — Shift+A does NOT
 *    match it (and, unstolen, would type a literal 'A' into the bullet);
 *  - shifted characters are stolen as 'shift+<unshifted key>' and reported
 *    back under that exact spec ('shift+a', 'shift+4', 'shift+[');
 *  - a spec written as the shifted character itself is WRONG: is-hotkey turns
 *    '$' into keyCode 36 (Home) and '{' into 123 (F12).
 * keyCode is a physical-key code, so SHIFTED below assumes a US layout.
 *
 * (Earlier versions of this plugin treated stealing as shift-blind and
 * routed capitals through unshifted synonyms; most of those synonyms remain
 * as aliases — see the engine.)
 *
 * Ctrl combinations match the same way (ctrl+d etc.).
 */
export interface KeyBinding {
  spec: string;
  sym: string;
}

const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
const digits = '0123456789'.split('');

const named: KeyBinding[] = [
  { spec: 'escape', sym: 'Escape' },
  { spec: 'enter', sym: 'Enter' },
  { spec: 'space', sym: ' ' },
  { spec: 'backspace', sym: 'Backspace' },
  { spec: 'ctrl+r', sym: 'C-r' },
  { spec: 'ctrl+d', sym: 'C-d' },
  { spec: 'ctrl+u', sym: 'C-u' },
  // Ctrl-E/Ctrl-Y are NOT stolen: RemNote has no view-scroll API, so the vim
  // behavior (scroll without moving the cursor) cannot be implemented.
  // Ctrl-W is stolen but NEVER ARRIVES on the desktop app: Electron consumes
  // a real Ctrl+W before the renderer sees it (verified with kernel-level
  // uinput — the keydown never fires; CDP-synthesized input bypasses that
  // layer, so CDP tests are blind to it). Kept for hosts that deliver it;
  // Ctrl-H/Ctrl-L below are the reachable pane-nav bindings.
  { spec: 'ctrl+w', sym: 'C-w' },
  { spec: 'ctrl+h', sym: 'C-h' },
  { spec: 'ctrl+l', sym: 'C-l' },
  { spec: 'ctrl+o', sym: 'C-o' },
  { spec: 'ctrl+i', sym: 'C-i' },
  // vim Ctrl-A/Ctrl-X (increment/decrement). Overrides RemNote's select-all
  // in normal mode only; insert mode releases them. Delivery class unknown
  // until probed — verify with real-input.mjs like every ctrl chord.
  { spec: 'ctrl+a', sym: 'C-a' },
  { spec: 'ctrl+x', sym: 'C-x' },
];

const plainLetters: KeyBinding[] = letters.map((l) => ({ spec: l, sym: l }));
const plainDigits: KeyBinding[] = digits.map((d) => ({ spec: d, sym: d }));
const plainPunct: KeyBinding[] = [
  { spec: ';', sym: ';' },
  { spec: ',', sym: ',' },
  { spec: '.', sym: '.' },
  { spec: '`', sym: '`' },
  // marks (`'x`), bracket text objects (di[ / da]) and f-args like f'
  { spec: "'", sym: "'" },
  { spec: '[', sym: '[' },
  { spec: ']', sym: ']' },
  // '/' is deliberately NOT stolen: RemNote's slash-command menu owns it
  // (the vim command line lives on ':').
];

const shiftedLetters: KeyBinding[] = letters.map((l) => ({ spec: `shift+${l}`, sym: l.toUpperCase() }));

/** Shifted US-layout symbols: the character → its unshifted physical key. */
export const SHIFTED_BASE: Record<string, string> = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7',
  '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\',
  ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
};
const shiftedPunct: KeyBinding[] = Object.entries(SHIFTED_BASE).map(([sym, base]) => ({
  spec: `shift+${base}`,
  sym,
}));

/** The is-hotkey spec that steals a printable character, or null if none. */
export function specForChar(ch: string): string | null {
  if (/^[A-Z]$/.test(ch)) return `shift+${ch.toLowerCase()}`;
  if (ch in SHIFTED_BASE) return `shift+${SHIFTED_BASE[ch]}`;
  return null;
}

// Every shifted key is stolen in normal/visual, bound or not: an unstolen
// Shift+key would type its character into the bullet, which normal mode
// must never do. ('shift+/' is '?', not RemNote's '/' slash menu.)
export const NORMAL_BINDINGS: KeyBinding[] = [
  ...named,
  ...plainLetters,
  ...shiftedLetters,
  ...plainDigits,
  ...plainPunct,
  ...shiftedPunct,
];

export const INSERT_BINDINGS: KeyBinding[] = [{ spec: 'escape', sym: 'Escape' }];

// While TYPING a command line every printable key must reach the engine, not
// the document underneath — including keys normal mode leaves to RemNote.
// '/' here is the :s separator (`s/foo/bar/g`); the rest make :e arguments
// with hyphens etc. typeable. Capitals and shifted symbols come from
// NORMAL_BINDINGS. (' [ ] moved into the normal-mode set for marks/text objects.)
const commandExtra: KeyBinding[] = ['/', '-', '=', '\\'].map(
  (c) => ({ spec: c, sym: c })
);
export const COMMAND_BINDINGS: KeyBinding[] = [
  ...NORMAL_BINDINGS,
  ...commandExtra,
  { spec: 'tab', sym: 'Tab' }, // wildmenu completion cycling
];

export const ALL_BINDINGS: KeyBinding[] = COMMAND_BINDINGS;

/**
 * Map an is-hotkey spec (as reported by RemNote's steal event) to an engine
 * symbol. Specs are unique, so the first binding for each one wins.
 */
export const SPEC_TO_SYM: Record<string, string> = {};
for (const b of ALL_BINDINGS) {
  if (!(b.spec in SPEC_TO_SYM)) SPEC_TO_SYM[b.spec] = b.sym;
}

export function bindingsForMode(mode: string): KeyBinding[] {
  if (mode === 'insert') return INSERT_BINDINGS;
  // 'search' steals the same full printable set as command mode: a typed
  // pattern needs every key that a `;` command line does (letters, digits,
  // '/', '-', etc.), not just the normal-mode subset.
  if (mode === 'command' || mode === 'search') return COMMAND_BINDINGS;
  return NORMAL_BINDINGS;
}
