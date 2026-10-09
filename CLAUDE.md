# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A RemNote desktop plugin that adds modal, vim-style editing (normal/insert/visual
modes, motions, operators, counts, registers, text objects, marks, dot-repeat, an
Ex command line, native clipboard integration) inside the RemNote note editor.
Desktop only — RemNote's plugin sandbox can't reliably steal keys on mobile.

## Commands

```bash
npm install
npm run dev          # webpack-dev-server on http://localhost:8080 (no HMR — see below)
npm run check-types  # tsc, no emit
npm test             # engine unit tests (Vitest) — fast, deterministic, no RemNote
npm run test:watch   # Vitest watch mode
npm run e2e          # live e2e against a running RemNote instance (local only, not in CI)
npm run build        # rm -rf dist + PluginZip.zip, prod webpack build, zips dist/ -> PluginZip.zip
```

Run a single unit test file/case with Vitest directly, e.g.
`npx vitest run tests/engine.test.ts -t "dw deletes a word"`.

To actually see a change working: `npm run dev`, then in RemNote **Settings →
Plugins → Build → Develop from localhost** → `http://localhost:8080/` → **Develop**,
and toggle "Vim Mode" on. There is **no hot reload**; reload the plugin (or the
RemNote window) after every code change to pick up new JS. Adding a **new
widget file** needs more: restart `npm run dev` entirely — webpack computes
the `src/widgets/**/*.tsx` entry list once at startup, so a widget file that
appeared later 404s on its `-sandbox.js` bundle and silently never mounts. A `-- NORMAL --` badge
bottom-right confirms the plugin is active, and its bottom-left twin
(`vim <version>@<build-time> <mode> rx=<n> done=<n> k=<spec>`) is the debug
readout — `rx` (keys received) staying ahead of `done` (keys fully processed)
means a handler is stuck on an unresolved promise inside `exec()`.

**Bump the version on every change round** — `version` in `package.json` plus
the `version` object in `public/manifest.json` — and tell the user the exact
first badge token to expect (e.g. `0.2.0@…`) so they can confirm the reload
actually picked up your code. The version half of that token is a live module
import from `package.json`, so a bump reaches a running dev server on the next
incremental rebuild; the `@<build-time>` half is baked in per webpack process
and only changes when `npm run dev`/`npm run build` restarts. An unchanged
badge after a "reload" is the classic silently-running-old-code trap here.

CI (`.github/workflows/ci.yml`) runs `check-types`, `test`, and `build` on every
push/PR to `main`. The live e2e suite cannot run in CI (needs a real RemNote
instance) and is local-only. `webpack.config.js` builds every
`src/widgets/**/*.tsx` **twice** — once as an ES module, once again as a
`-sandbox` variant loaded via `index.html?widgetName=<name>` inside RemNote's
cross-origin iframe — because that's how RemNote actually loads plugin widgets.

## Architecture

The whole codebase is built around one boundary — keep these two halves separate:

```
keystroke → adapter (RemNote-facing) → engine (pure) → Action[] → adapter executes them
            src/adapter/adapter.ts     src/engine/       against RemNote's plugin API
```

- **`src/engine/`** — a synchronous, pure state machine:
  `handleKey(VimState, key, {text, caret}) → {state, actions}`. Never heard of
  RemNote, awaits nothing, touches no DOM. This is where vim *semantics* live
  and where they're exhaustively unit-tested against a fake editor
  (`tests/harness.ts`). New motion/operator/mode behavior goes here, with tests.
  - `engine.ts` — `handleKey()` dispatches on `state.mode` to one handler per
    mode (`handleNormal`, `handleInsert`, `handleVisual`, `handleVisualLine`,
    `handleCommand`), plus `recordDotRepeat()` wrapping every call.
  - `motions.ts` — pure text math: word/find/text-object boundaries, and the
    code-point-safe caret helpers (`cpForward`/`cpBack`/`cpStart`/`stopsBetween`).
  - `types.ts` — `VimState`, `Action` (the full vocabulary the adapter must be
    able to execute — read the doc comment on every variant, several encode a
    subtle live-behavior fix), `Mode`, `Pending`, `Register`.
- **`src/adapter/adapter.ts`** (`VimAdapter`, ~2000 lines) — the *only* code
  that talks to the RemNote plugin SDK. Turns stolen keys into engine symbols
  (`applyKey`), runs the engine, executes returned `Action`s one at a time via
  `exec()`, and owns a local model of the focused line's text/caret (see
  below). New ways of talking to RemNote (a new `Action` case, an SDK call, a
  key to steal) go here.
  - `keymap.ts` — which key specs to steal per mode (`NORMAL_BINDINGS` doubles
    as visual/visual-line's set too — see `bindingsForMode`); spec→engine-symbol
    table (`SPEC_TO_SYM`).
  - `pure.ts` — SDK-free helpers factored out specifically so they're unit
    testable: `flattenRich` (rich-text → model-space string), `sanitizeInsert`,
    `diffCaret`, `settleRead`.
  - `domCaret.ts` — direct DOM caret read/write; only reachable when the
    plugin runs in the host page (`requestNative: true`). The manifest ships
    `requestNative: false`, so `hostDocument()` always returns `null` in
    production today and this module is dead code in practice — kept in place
    for if/when RemNote's Electron version makes native mode viable again
    (closed as a dead end on 1.26.30, see DEVELOPMENT.md's work log). Don't
    delete it or re-attempt enabling it without reading that history first.
- **`src/widgets/`** — plugin entry point (`index.tsx`'s `onActivate`,
  registers the `vim-toggle`/`vim-help`/`vim-config`/`vim-tutorial` commands
  and the `start-in-normal` setting, constructs the one `VimAdapter`, exposes
  `window.__vim` for e2e; `onDeactivate` calls `VimAdapter.stop()`, which
  must undo everything `start()` sets up — timer, listeners, steals, badge
  CSS; DEVELOPMENT.md §9 has why a leftover re-steal matters) and the
  `:help` cheat-sheet floating widget
  (`vim_help.tsx` — grabs real DOM focus on mount so plain `onKeyDown`
  handles its scrolling, no `stealKeys`). The getting-started tutorial is
  NOT a widget: it's a seeded **"Vim Tutorial" practice document** (vimtutor
  model — lessons are real bullets edited with the real bindings), content
  in `src/adapter/tutorialDoc.ts` (SDK-free, so tests verify every practice
  line's claim against the Harness), lifecycle in `VimAdapter.openTutorial`
  / `ensureTutorialDoc` (create + seed once, id pinned in synced storage like
  the `:config` doc, `:tutorial`/`:vimtutor`/palette command reopen it,
  deleting it re-seeds). Auto-opened once on first activation, gated on the
  `vim-tutorial-seen` synced flag set in `index.tsx` after a successful open.
  **Any edit to `TUTORIAL_LINES` must bump `TUTORIAL_VERSION`** (a pinned
  content fingerprint in `tests/tutorial.test.ts` fails otherwise): copies
  seeded from an older version are replaced on the next activation, the old
  one kept renamed "Vim Tutorial (old copy)".
- **`tests/harness.ts`** — `Harness`, a fake multi-line/multi-indent editor
  (`lines`/`indents`/`row`/`caret` arrays) that executes `Action`s the same way
  the real adapter does. Every new `Action` variant needs an implementation
  both in `VimAdapter.exec()` and `Harness.exec()`, kept as a faithful *model*
  (not a copy) of the real thing — e.g. Harness has no real Rem tree, just
  parallel arrays.
- **`e2e/`** — live end-to-end scripts driving a real running RemNote instance
  over CDP (`playwright-core`'s `connectOverCDP`). Read state through RemNote's
  read-only data API, never by parsing rendered DOM text for assertions.

## Core mechanisms worth understanding before touching either half

**Caret model.** The engine treats a line as a plain string with a
between-characters caret offset in `[0, text.length]`. Every stepping motion
and char-granular edit goes through `motions.ts`'s code-point helpers
(`cpForward`/`cpBack`/`cpStart`) rather than raw `+1`/`-1`, because an emoji or
a RemNote "atomic" rich-text element (rem reference, image, LaTeX chip — see
next paragraph) is 2 UTF-16 units but exactly one caret stop. `MotionResult.landsOn`
marks motions that conceptually land *on* a character (`e`, `f`, `$`): `target`
is the inclusive operator-range end (one past the landed-on char), and callers
in normal/visual mode convert that back to an on-char cursor position — this
asymmetry trips people up when adding a new inclusive motion, so check how `e`
and `f` do it in `engine.ts` before copying a different pattern.

**The rich-text offset-space contract.** RemNote's editor offsets (what
`editor.selectText`/`getSelection` use) count a plain-text run by UTF-16 units
but count *every other* rich-text element (rem reference, image, LaTeX, audio,
card delimiter…) as exactly 2 units regardless of its displayed length.
`flattenRich()` (`src/adapter/pure.ts`) mirrors this by flattening such
elements to a single reserved astral placeholder character, `ATOMIC_CH =
'\u{10FFFC}'` (2 UTF-16 units, 1 code point) — this is what makes the engine's
model-space string align 1:1 with RemNote's real offsets. `sanitizeInsert()`
strips that placeholder before any text is inserted back into the document
(a chip can't be reconstructed from plain text — a documented, accepted
limitation for charwise registers only; whole-line registers keep full
fidelity). If you ever see motions/edits landing off-by-N on a line containing
a reference or image, this is the first place to check.

**The adapter's local model (`this.model` in `adapter.ts`).** RemNote's
`getFocusedEditorText()` lags a keystroke or two behind programmatic edits, so
re-reading it on every key would compute offsets against stale text mid rapid
sequences (`dwA!`). Instead the adapter keeps `{ remId, text, caret } | null`:
`snapshot()` returns it as-is until invalidated; `updateModel(action)` mutates
it deterministically to mirror what each `Action` *should* have done — the
exact same logic `Harness.exec()` encodes for tests, just against a live
field instead of a lines array. Two invalidation flavors: a plain
`invalidateModel()` (focus moved to a different Rem, a structural/vertical
command ran — the giant `switch` in `updateModel()` lists exactly which
`Action` kinds do this) and `invalidateModel(true)` ("dirty"), used when an SDK
path mutated the focused line's text in a way the read API is known to lag
behind (`undo`/`redo`/`:s`/`gj`'s join) — the next `snapshot()` then loops via
`settleRead()` until two reads 40ms apart agree, instead of trusting a
possibly-stale first read. `normalizeModel()` additionally mirrors RemNote's
own behavior of trimming leading whitespace off a Rem's text after every edit,
adjusting the caret to match — skip this when you add a new `Action` and
non-obvious desyncs will follow every edit that happens to leave a leading
space.

**No absolute caret positioning API exists.** `selectText` with a collapsed
range, `editor.collapseSelection()`, and `moveCaret(_, MoveUnit.LINE)` are all
no-ops in this sandbox (empirically verified — see `setCaret`'s case in
`exec()`). The only primitive that moves the real, visible caret is
`editor.moveCaret(delta, MoveUnit.CHARACTER)` — a *relative* offset counted in
caret stops (via `stopsBetween`), not UTF-16 units. So every "move the caret to
X" computes `delta = to - from` against `this.model.caret` captured **before**
the action runs (`exec` sees the pre-action model; `updateModel` runs after).
The one exception: `collapseSelection` (distinct from `setCaret`) is used
specifically when leaving visual mode, because a relative `moveCaret` against
a *live native text selection* resizes it instead of collapsing it — a
collapsed `selectText` range is the one API call that both clears a selection
and sets the caret absolutely.

**Shifted keys (how RemNote matches steals).** RemNote's `stealKeys` matcher
is stock `is-hotkey` by keyCode (read from the 1.28.32 bundle, verified at a
real keyboard 2026-10-07): a bare spec `'v'` matches only an unshifted `v`, and
capitals/shifted symbols must be stolen as `'shift+<unshifted key>'`
(`'shift+v'`, `'shift+4'` for `$`, `'shift+['` for `{`) — they are reported back
under that exact spec and `keymap.ts` maps them to the real symbol. Never write
a spec as the shifted character itself: is-hotkey reads `'$'` as Home and `'{'`
as F12. keyCode is physical, so `SHIFTED_BASE` assumes a US layout. (Versions
before 0.3.0 believed stealing was shift-blind and used unshifted synonyms;
the harmless ones — `gl gh ga go gf gq`, visual-line `.`/`,` — remain as
aliases.)
Ctrl-combinations match the same way (`ctrl+d` etc.); `Ctrl-W` is
stolen and handled but **never arrives** on the desktop app specifically
(Electron consumes it before the renderer's key-steal hook sees it — verified
with kernel-level `uinput`, so CDP-synthesized e2e input is blind to this too)
— `Ctrl-H`/`Ctrl-L` are the actually-reachable pane-nav bindings; keep `Ctrl-W`
around only because some other host might deliver it.

**Dot-repeat.** `recordDotRepeat()` wraps every `handleKey` call: while in
normal mode with an operator/pending/count in flight it appends to
`state.keyLog`; once a key sequence completes and its actions include one from
the `DOT_MUTATING` set (`deleteRange`, `insertText`, `deleteRem`, `pasteRem`,
`indent`, `outdent`, `joinRem`), the whole logged sequence becomes
`state.lastChange`. `.` replays those keys via `{ t: 'replayKeys' }` (the
adapter must re-run them through the same per-key loop, fresh snapshot each
time — not literally re-execute the old actions). Commands that enter insert
mode (`cw`, `o`, `A`) are deliberately **not** recorded because the text
actually typed afterward never reaches the engine (insert mode releases every
key back to RemNote) — a replay could only redo half the change.

**Visual-line's selection trail.** Visual-line mode does not use RemNote's
real Rem-selection (`editor.selectRem` kills the text caret irrecoverably).
Instead the adapter tracks `vTrail: string[]`, the sequence of Rem ids the
caret has visually walked through as `vStart`/`vExtend` actions fire;
`normalizedTrail()` collapses it to top-level selected units, and
`expandWithDescendants()` turns that into every id that needs its own CSS tint
(RemNote's DOM doesn't nest child rows inside a parent's container).
`tests/harness.ts` mirrors this exact algorithm with row indices + an
`indents` array. If you touch trail logic, update both in lockstep or the unit
suite silently tests a different algorithm than what ships.

## Adding new behavior — where it goes

- New motion → `motions.ts` (if non-trivial) + a case in `motionFor()` in
  `engine.ts`. Because `motionFor` is shared, it automatically works standalone,
  as an operator target (`d{motion}`), and in visual mode.
- New simple normal-mode command (no motion) → a case in `handleNormal()`'s
  switch (engine.ts).
- New capability the adapter must execute → add the variant to `Action` in
  `types.ts` (with a doc comment on the semantics — this type is the contract),
  implement it in both `VimAdapter.exec()` and `Harness.exec()`, and add a case
  to `updateModel()` in `adapter.ts` deciding whether it mutates the focused
  line's tracked text/caret, invalidates the model, or is a no-op — TypeScript
  won't catch a missing case in a `switch` without a `default`, so grep for
  `a.t` after adding one.
- New Ex command (`:foo`) → a case in `VimAdapter.runEx()`'s switch
  (`adapter.ts`); verbs are matched case-insensitively (capitals are unreachable
  live, so `:Ex` arrives as `ex`). `:s` and `:g` are matched by regex *before*
  the verb switch because their separator (`/`) attaches directly to the verb
  with no whitespace. No engine changes needed — `runEx` is a leaf action the
  engine passes through verbatim.
- Multi-key sequences (`f<char>`, `r<char>`, `g`-chords, text objects `di`/`da`)
  go through `state.pending` (`types.ts`'s `Pending` union): the first key sets
  `pending`, and the top of `handleNormal` special-cases each `pending.p` value
  before falling through to counts/motions/single-key dispatch.

## Known live gotchas (verified against RemNote 1.26.30 / SDK 0.0.46)

- `positionAmongstSiblings()` races the data layer right after an edit
  (bit the e2e stress suite repeatedly on paste-then-indent) — `indent`'s
  `exec()` case works around it by finding the previous sibling via
  `parent.getChildrenRem()` + `findIndex`, not by trusting a position number.
  Follow that pattern for anything ordering-sensitive right after a mutation.
- `Ctrl-E`/`Ctrl-Y` are deliberately unbound — RemNote exposes no view-scroll
  API, so "scroll without moving the cursor" cannot be implemented faithfully.
- Charwise registers lose atomic rich-text elements on paste (a chip can't be
  reconstructed from `sanitizeInsert`'s stripped text); whole-line registers
  (`dd`/`yy`/visual-line) keep full fidelity because they copy real Rem
  subtrees, not flattened text.
- Native clipboard writes are permission-denied from inside the sandboxed
  iframe on the desktop app; the live fallback is select+cut+reinsert (net
  no-op on the doc, real text on the OS clipboard) — the debug badge's `clip:`
  field (`clip:native`/`clip:api`/`clip:exec`/`clip:FAIL`) shows which path
  actually fired, useful when a clipboard bug is reported.
- A RemNote bullet is one line by construction: `j`/`k` move between bullets
  (not visual/wrapped lines), and `o`/`go` always create a **sibling**, never
  a child, even when the current bullet has an expanded subtree.

## Testing philosophy

The engine unit suite (`tests/engine.test.ts`, `tests/engine-edge.test.ts`,
`tests/motions.test.ts`, `tests/adapter-pure.test.ts`, all via Vitest against
`Harness` or the SDK-free `pure.ts` helpers) is **the contract** — add or
update tests for any engine behavior you change, and prefer it for anything
that's pure vim semantics. Reach for the live `e2e/` scripts (`run.mjs` a
continuous narrative smoke test, `stress.mjs` long chaotic sequences checking
a focus-alive invariant after *every* keystroke, `tree.mjs` nested-hierarchy
visual-line precision with archived screenshots) only when the bug is
specifically about RemNote integration (caret visibility, focus survival, tree
structure) — they require a real RemNote instance (`e2e/launch.sh`, a scratch
`$HOME` + isolated CDP port) and a test account (`cp e2e/.env.example
e2e/.env`), and cannot run in CI. Run `stress.mjs` specifically after touching
anything that moves focus across Rems (`removeRems`, `walkCaretOut`,
`walkCaretTo`) — it's what originally caught "dead cursor after cut" bugs.

If a change is user-visible, update the `:help` sheet
(`src/widgets/vim_help.tsx`) and the feature status table in DEVELOPMENT.md
§0.5.

## Deeper reference

**DEVELOPMENT.md** is the full architecture deep-dive, platform-constraint
writeup, and dated work log (treat the work log as historical narrative, not
current-state documentation — check §0.5 "Feature status" for what's actually
verified live). Read it before any non-trivial engine/adapter change; §9 in
particular has the full empirical writeup behind every platform quirk listed
above.
