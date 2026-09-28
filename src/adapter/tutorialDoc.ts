/**
 * The "Vim Tutorial" practice document — content only, SDK-free (like
 * mappings.ts / pure.ts) so tests can verify every practice line against the
 * engine Harness. The adapter seeds a real RemNote document from this on
 * first `:tutorial` (see `VimAdapter.openTutorial`), pinning its id the same
 * way the `:config` "Vim Keymap" doc is pinned.
 *
 * Unlike the retired floating-widget walkthrough, this is vimtutor's model:
 * the lessons live in ordinary bullets and every command is practiced right
 * where it's read, on real text, with the real bindings. It's the user's
 * document — editing (or wrecking) it is the point. Deleting it entirely
 * just means the next `:tutorial` re-seeds a fresh copy.
 *
 * Content rules, enforced by tests/tutorial.test.ts:
 * - every taught key sequence must exist and do what the line says (checked
 *   against the Harness on the practice line's own text);
 * - indents only ever step down by one (a bullet can't skip a nesting level
 *   on creation);
 * - lesson titles are headings (seeded as /h3 with a blue bullet) and every
 *   title after the first is preceded by exactly one blank spacer bullet;
 * - the search lesson's 'needle' must appear exactly twice: once in the
 *   lesson, once near the bottom, so `space needle Enter` from the lesson
 *   really jumps forward;
 * - any edit to TUTORIAL_LINES bumps TUTORIAL_VERSION (a pinned content
 *   fingerprint fails the suite otherwise).
 */

export const TUTORIAL_DOC_NAME = 'Vim Tutorial';

/**
 * Content version of TUTORIAL_LINES — bump it with EVERY edit to them. The
 * seeded copy records the version it was built from; an older copy is
 * replaced on the next activation, the old one kept under TUTORIAL_OLD_NAME
 * (see VimAdapter.ensureTutorialDoc). Copies seeded before versioning
 * existed carry no version and count as outdated — that content was v1.
 */
export const TUTORIAL_VERSION = 2;

/** What an outdated copy is renamed to when a fresh one replaces it. */
export const TUTORIAL_OLD_NAME = 'Vim Tutorial (old copy)';

export interface TutorialLine {
  text: string;
  /** 0 = direct child of the document, 1 = nested one level under it. */
  indent: 0 | 1;
  /** Lesson titles: seeded as an H3 heading with a blue bullet. */
  heading?: boolean;
}

const L = (text: string): TutorialLine => ({ text, indent: 0, heading: true });
const c = (text: string): TutorialLine => ({ text, indent: 1 });
/** Blank spacer bullet between lessons — visual breathing room. */
const gap = (): TutorialLine => ({ text: '', indent: 0 });

export const TUTORIAL_LINES: TutorialLine[] = [
  L('Lesson 0 — this document'),
  c(
    'Welcome! This is a practice document: every lesson below is ordinary text, meant to be edited with the vim keys it teaches. Break anything you like — reopen a fresh or existing copy any time with ;tutorial (or "Vim: Tutorial" in the command palette), and press Ctrl-O to jump back to wherever you came from.'
  ),
  c('The badge in the bottom-right corner shows the current mode. Esc always returns to NORMAL mode, where keys are commands, not text.'),
  c('Practice: press j and k a few times to walk down and up these bullets.'),
  c('Practice: press ge to jump to the very last bullet of this document, then gg to come back to the top.'),

  gap(),
  L('Lesson 1 — moving on a line'),
  c('h and l move by character; w, b and e move by word; 0 jumps to the start of the line, gh to the first non-blank, gl to the end (vim: $).'),
  c('Practice: walk across this line word by word with w, then come back with b.'),
  c('f jumps onto a character: press fz to land on the z here: crazy lazy puzzle. gf finds backward, and , repeats the last find reversed.'),
  c('Practice: press gl to send the caret to the end of this line, then 0 to snap back to the start.'),

  gap(),
  L('Lesson 2 — insert mode'),
  c("i inserts before the cursor, a after it, ga at the end of the line (vim: A). o opens a new bullet below, go above (vim: O). Esc leaves insert mode."),
  c('Practice: this line is missing its last word — press ga and type it: the quick brown'),
  c('Practice: press o, type a brand-new bullet below this one, then Esc.'),
  c('Practice: press go to open a bullet above this one instead, leave a note in it, then Esc.'),

  gap(),
  L('Lesson 3 — deleting'),
  c('x deletes the character under the cursor; dw deletes to the next word; diw deletes the word you are standing in; dd cuts the whole bullet, children included.'),
  c('Practice: fix this animal with x: caaat'),
  c('Practice: delete the doubled word with diw: the sky is is blue'),
  c('Practice: daw deletes a word and the space after it — stand on the middle word and daw it away: delete clutter here.'),
  c('Practice: this bullet is pointless — cut it with dd. (u brings it back if you regret it.)'),

  gap(),
  L('Lesson 4 — changing'),
  c('cw changes a word: it deletes the word and drops you straight into insert mode. r replaces a single character. Backtick toggles the case of the character under the cursor (vim: ~).'),
  c('Practice: the sky is green — put the cursor on the wrong word and cw it to blue.'),
  c('Practice: fix the case of the first letter with backtick: aNGRY (then fix the rest too)'),
  c('Practice: r replaces a single letter without leaving normal mode — put the cursor on the k and press r c: kat'),

  gap(),
  L('Lesson 5 — counts and the dot'),
  c('A number before a command repeats it: 3x deletes three characters, 2dw two words, 4j moves four bullets down. The . key repeats your last change.'),
  c('Practice: delete the three x with one 3x: xxxhello'),
  c('Practice: with the cursor on the first color, dw . . deletes all three: red green blue keep the rest'),
  c('Practice: counts work on motions too — 4j drops four bullets down, 4k climbs back up here.'),

  gap(),
  L('Lesson 6 — search the whole document'),
  c('Space starts a search: type a pattern (a real regex, case-sensitive), Enter jumps to the next match anywhere in the document. n repeats forward, z backward (vim: N), and it wraps around the ends.'),
  c('Practice: press Space, type needle, press Enter — the first hit is the word you just typed, right here in this sentence; press n to chase the second one hiding at the bottom of this document, and z to come back. Ctrl-O returns here when you are done.'),
  c('Practice: bag, big and bug all match one pattern — a dot matches any character: press Space, type b.g, press Enter to land on bag, then n n to reach the other two.'),

  gap(),
  L('Lesson 7 — cut, copy, paste, undo'),
  c('dd cuts a bullet, yy copies it (also onto the OS clipboard), p pastes below, u undoes, Ctrl-R redoes. Marks: m + any letter remembers the current bullet, \' + that letter jumps back to it.'),
  c('Practice: yy this bullet, p it twice, then u away the copies.'),
  c("Practice: press m a to mark this bullet, jump to the top with gg, then ' a to teleport back here."),

  gap(),
  L('Lesson 8 — selecting'),
  c('v starts a text selection you grow with any motion; vv selects whole bullets (vim: V). On a selection: d cuts, y copies, p pastes over, backtick toggles case, and gs wraps it in delimiters — gs9 for (…), gsq for "…", gs[ for […], gs8 for *…*.'),
  c('Practice: select the word important with v and word motions, then wrap it with gs9: this is important, truly.'),
  c('Practice: press vv then j to select this bullet and the next, then . to indent both (vim: >).'),
  c('Practice: …and vv j , to outdent them back.'),
  c('Practice: put the cursor on the whisper at the end of this line, press v e to select it, then backtick to shout it: shhh'),

  gap(),
  L('Lesson 9 — the command line'),
  c('; opens the : command line (Tab cycles completions). :help shows the full reference sheet. :10 jumps to the 10th bullet from the top. :s/old/new/ substitutes on the current bullet — flags: g every match, i ignore case, a the whole document.'),
  c('Practice: run ;s/bad/good/ on this bullet: this line is bad, truly bad.'),
  c('Practice: a bare number is a jump — type ;5 then Enter to land on the 5th bullet from the top, and Ctrl-O to come back.'),
  c('Panes: :vs and :sp split the view, :q closes a pane, :only keeps just this one; Ctrl-H and Ctrl-L move focus between panes. Try ;vs and then ;q right now.'),

  gap(),
  L('Lesson 10 — make it yours'),
  c(':config opens a "Vim Keymap" document: one mapping per bullet, vim syntax — nmap - $ maps - to end-of-line in normal mode; unmap , releases a key back to RemNote (the key side is always ONE key). :map lists what is active; edits apply when you leave that document.'),
  c('Practice: type ;config then Enter to open the "Vim Keymap" document, take a look around, then press Ctrl-O to come back here.'),
  c('One RemNote quirk to remember: key capture cannot see Shift, so capitals get unshifted stand-ins — gl=$ gh=^ ge=G ga=A go=O vv=V backtick=~ and z is search-backward (vim: N).'),
  c('Practice: type ;map then Enter — a toast lists every custom mapping that is active (an empty list just means nothing is mapped yet).'),

  gap(),
  L('Lesson 11 — macros'),
  c('q plus a letter records every key you press into that register — the badge says recording @a — and q stops it. gq plus the letter plays it back (vim spells that @a, but @ is a shifted key RemNote cannot see). gq. repeats the last replay, and a count multiplies it: 3gqa runs it three times.'),
  c('Practice: put the cursor on the first broken word at the end of this line, then qafexpq records the fix (f e jumps onto the e, x p swaps it past the h); gqa replays it, gq. replays it again: teh teh teh'),
  c('Practice: macros shine across bullets — the three bullets below all start with junk. On the first, record qd2xjq (2x eats the junk, j steps down), then gqd fixes the second and gq. the third.'),
  c('xxone of three'),
  c('xxtwo of three'),
  c('xxthree of three'),
  c('One catch: text you type in insert mode is not captured (RemNote owns those keys), so build macros from normal-mode commands — motions, x, r, dw, p, even ; commands. qaq records nothing and simply empties register a.'),

  gap(),
  L('Lesson 12 — precise edits'),
  c("t is the careful sibling of f: it stops one character before its target instead of on it, so dt deletes up to a character and keeps that character. Text objects also work on pairs: dib deletes inside round brackets (vim spells it di( but that bracket needs Shift, so b stands in), di[ empties square brackets, and i' and a' work on quotes. Swap the d for c to change instead of delete, or y to copy."),
  c('Practice: stand on the first letter of the last word and press dth — it deletes up to the h and keeps the h itself: unhappy'),
  c('Practice: put the cursor anywhere between the brackets and press dib to empty them: call(this, that)'),
  c("Practice: the greeting 'hello there' is dull — cursor inside the quotes, press ci' and type a better one."),

  gap(),
  L('Lesson 13 — numbers and bullets'),
  c('Ctrl-A adds one to the number under or after the cursor and Ctrl-X subtracts one; a count adds or subtracts more, so 5 Ctrl-X takes five away. gj glues the next bullet onto this one with a space (vim: J), and the joined bullet brings its children along.'),
  c('Practice: 9 lives left — from the start of this line, Ctrl-A adds one more.'),
  c('Practice: 12 apples in the basket — from the start of this line, press 5 and then Ctrl-X to eat five of them.'),
  c('Practice: this sentence got split across'),
  c('two bullets — press gj on the first half to glue them back together.'),

  gap(),
  L('The end'),
  c('That was the tour. :help keeps the full reference one keystroke away, and this document stays yours to practice in. Happy editing!'),
  c('needle — you found it. Press Ctrl-O to jump back to Lesson 6.'),
];
