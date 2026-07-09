# Developer Guide

This is the deep-dive companion to [README.md](./README.md) (quick start).
Read this when you're about to write code: it explains *how the pieces fit
together* and gives concrete recipes for extending or debugging the plugin.
Written for both human contributors and future Claude Code instances picking
this repo back up cold. It also carries the **work log (§0)**, the **feature
status (§0.5)** and the **platform blockers (§9)** — the former VIM_STATUS.md
was retired into those sections (its full text is in git history,
commit 122d18e).

> **Convention:** all in-flight plans and progress live in §0 (work log)
> below — update it as you work so parallel contributors can see state at a
> glance.

## 0. Work log / current state

### 2026-07-10 — round 6b: "44 tests seems minor" — deepened coverage (85 new tests) + found and fixed one real latent bug

User pushed back on round 6's test pass as too thin: "44 tests seems to be a
minor amount, think about what you potentially missed to test and add much
more tests." Re-audited every function extracted in round 6 for undertested
branches, plus re-checked the original five reported issues end-to-end for
gaps — issue #3 (Insert→Normal delay) had NO coverage at all despite being
one of the five originally-reported bugs; round 5's document-membership
check (`isInFocusedDocument`) also had no isolated coverage.

**New extractions** (previously inline, SDK-coupled, now pure + tested):
- `reconcileInsertText` — the Insert→Normal reconcile decision (skip the
  read entirely / settle-then-confirm / catch-a-slow-flush), pulled out of
  `reconcileAfterInsert`. This is issue #3's actual fix, completely
  uncovered until now.
- `resolveInsertCaret` — the DOM-caret-vs-diffCaret preference, same method.
- `isDescendantAmong` — the "is this id in the open document's descendant
  list" predicate at the center of round 5's Ctrl-O fix, split out of
  `isInFocusedDocument` (the pane/SDK lookups around it stay adapter-only).

**A real bug found while writing tests, not just more assertions on existing
behavior**: constructing `computeJumpStep([], 0, -1, undefined, undefined)`
(Ctrl-O with an empty jumplist AND no focused Rem to stash — focus somehow
already lost) computed `nextPos = nextJumps.length - 1 = -1`. Every
subsequent hop from a `jumpPos` of -1 would stay wedged there indefinitely
(the "else" branch only escapes on `jumpPos > 0`), and `recordJump`'s
`slice(0, jumpPos)` on -1 silently no-ops rather than crashing, so this
would have failed silently rather than loudly. Unlikely to fire in practice
(needs both an empty jumplist and a lost focus simultaneously) but a real
latent bug regardless. **Fixed**: clamped to `Math.max(0, nextJumps.length -
1)`, with a comment explaining why, plus two dedicated regression tests
(the immediate case, and a follow-up hop proving it doesn't stay wedged).

**Depth added to every round-6 suite** (34 → 119 tests in
`adapter-pure.test.ts`; 365 → 450 total):
- `computeJumpStep`: dedup-preserves-existing-docId, focus-lost-with-history,
  focus-lost-with-empty-list (the bug above), a full realistic
  back/back/back/forward/forward session retracing an exact path end-to-end.
- `isEscapeWanted`: every `Operator` value, every non-`none` `Pending`
  variant (was spot-checking one of each category before), a
  no-accidental-AND/OR combination check, and a "flip exactly one field at a
  time" sweep.
- `decideUndo`/`decideRedo`: a full paste→undo→redo→undo session sequence,
  and the "an unrelated edit clears the structural op" case.
- `retryUntilTrue`: `attempts: 1`, a rejected `op` propagating immediately
  instead of being silently retried-through (a real contract worth locking
  down), and — importantly — the ACTUAL defaults (5 attempts, 80ms) with no
  options object at all, not just test-supplied stand-ins for them.
- `walkToRoot`: `maxHops: 0`, a deterministic (not "either A or B") cap-hit
  on a long non-cyclic chain with an exact call-count assertion, and a
  30-level chain confirming the real default cap (100) comfortably covers
  any realistic document depth.
- `walkToTarget`: `firstDir: -1` symmetry (everything before only exercised
  `+1`), an undefined initial `currentId()`, an exact-inclusive-boundary hit
  on the last allowed hop, `maxHopsPerDir: 1`, and losing focus mid-walk in
  one direction while the other still succeeds.
- `walkToBoundary`: `batch: 1` (degenerates to the pre-round-4 per-hop
  behavior), a step-then-check ordering assertion via a shared call log, and
  the documented (not a bug) overshoot when `maxHops` isn't an exact
  multiple of `batch`.

**Status**: `check-types` clean, all 450 unit tests pass, `npm run build`
succeeds, dev server restarted and `curl`-confirmed serving
`reconcileInsertText`. The `computeJumpStep` clamp is a genuine (if narrow)
behavior change on top of round 6's pure refactor — everything else this
round is additive test coverage, not logic changes, so live-verification
risk is limited to that one clamp.

### 2026-07-10 — round 6: Ctrl-O confirmed fully fixed live; extracted the decision logic behind rounds 1-5d into pure.ts and unit-tested it

User confirmed round 5d live: "yeah, okay, jumps back correctly, that's good"
— the full Ctrl-O/cross-document chain (fast in-document walk, correct
document reopened, caret lands on the exact original Rem past the mount
race) is done. Then asked for test coverage: "can you maybe create test
cases to cover these issues the best way you could. make as much possible."

**The constraint**: `adapter.ts` (`VimAdapter`) is the SDK-coupled half of
this codebase — per its own testing philosophy, "adapter.ts itself can only
be exercised live," and this whole multi-round investigation (rounds 1-5d)
happened with zero live RemNote access. Writing a Vitest suite that mocks
the RemNote plugin SDK wholesale wasn't the move — it would test the mock,
not the real integration, and this project already has a real answer for
integration coverage (`e2e/`, live-only, not in CI). What WAS available: the
actual DECISION LOGIC behind every one of this session's fixes is pure data
math with no SDK dependency once separated from the `await this.plugin.*`
calls around it — jumplist stack transitions, an idle-state boolean, a
mode/flag classification, a 2×2 undo/redo truth table, a generic retry
loop, and two walk algorithms parameterized over an injected step/check
function instead of calling `editor.moveCaretVertical`/`focus.getFocusedRem`
directly. None of that had been factored out before now because no single
round's fix, in isolation, obviously justified the refactor — it only
became clearly worthwhile looking back at the whole arc together.

**Extracted into `pure.ts`** (all now imported and actually used by
`adapter.ts`, not parallel duplicate logic that could drift):
- `computeJumpStep` — the full Ctrl-O/Ctrl-I jumplist stack transition
  (stash-on-first-hop-back, live-end/history-browsing modes, dedup, docId
  threading) pulled out of the `case 'jump'` switch arm verbatim.
- `isEscapeWanted` — `syncEscapeSteal`'s idle-normal-mode boolean (round 5's
  namesake, "round 5" here meaning the Ctrl-P/Ctrl-K session, not the Ctrl-O
  rounds above — same numbering coincidence, different fix).
- `classifyStrayEdit` — the `EditorTextEdited` listener's 3-way branch
  (ignore / mark-insert-edit / reset-pending) behind the shift-blind
  capital-letter fallout fix (issues #1/#2 from the original five).
- `decideUndo` / `decideRedo` — the structural-op-vs-native truth table
  behind the paste/mass-indent undo grouping fix.
- `retryUntilTrue` — generalizes round 5d's post-`openRem` retry loop.
- `walkToRoot` — generalizes `findDocRoot`'s parent-chain walk (round 5b's
  fallback-of-a-fallback, now only reached when a `JumpEntry` has no
  recorded `docId`).
- `walkToTarget` — generalizes `walkCaretTo`'s exact-match search (used
  everywhere the adapter puts the caret on a specific just-created/moved
  Rem: paste, indent/outdent revert-reapply, `o`/`O`, marks, jumps — ALL of
  these now run through one tested implementation instead of an
  adapter-only method with no coverage).
- `walkToBoundary` — generalizes round 4's `gg`/`G` batched boundary walk.

`adapter.ts`'s methods (`focusRemById`, `walkCaretTo`, `findDocRoot`,
`syncEscapeSteal`, the `EditorTextEdited` listener, `case 'jump'`, the
`undo`/`redo` cases, `case 'goDoc'`) are now thin wrappers that resolve real
SDK calls into `currentId()`/`step()`/`getParentId()` closures and hand them
to the pure functions — the SDK-facing shape is unchanged (same public
methods, same call sites), only the decision logic moved.

**Test suite** (`tests/adapter-pure.test.ts`, +44 tests, 365 → 409 total):
covers every branch of each function above, including two regression tests
that reproduce round 5d's exact bug end-to-end without any RemNote
involved: `walkToTarget` alone fails after exactly 4 `step()` calls when
`currentId()` never changes (the mount-race symptom, reproduced
byte-for-byte), then a follow-up test proves `retryUntilTrue` recovers once
a later attempt's `currentId()` sequence starts actually progressing —
i.e., the test suite encodes not just "this function returns X for input Y"
but the specific live-reported failure and its fix.

**What's still NOT unit-testable, and why**: the actual `await
this.plugin.rem.*` / `editor.*` / `window.*` calls themselves (would require
mocking the entire RemNote SDK to test nothing but the mock), `structuralOp`'s
`revert`/`reapply` closures (real `setParent`/`remove` mutations against a
live Rem tree), and anything timing-dependent on RemNote's actual read-lag
behavior. These remain live-only per the existing testing philosophy;
`e2e/stress.mjs` (focus-alive invariant after every keystroke) is the
right tool if a regression here is ever suspected, not a new mock harness.

**Status**: `check-types` clean, all 409 unit tests pass, `npm run build`
succeeds, dev server restarted and `curl`-confirmed serving the refactor.
This round is a refactor + test-coverage pass on ALREADY-confirmed-working
code (round 5d was live-verified before this started) — low behavioral risk,
but worth a quick general smoke-test pass (jumps, marks, undo/redo, gg/G,
:e wildmenu) next time, since the refactor touched the call sites for all
of them even though none of their logic changed.

### 2026-07-10 — round 5d: round 5c opened the right document but the caret never left its title — walk-down now retries past the post-`openRem` mount race

Live-tested round 5c: the document is now correct ("RemNote Vim Plugin"),
and the screen even scrolls to the right area — but the actual text caret
stays on the document's title, never lands on the target child bullet.
User's own framing nailed the symptom precisely: "the screen positions at the
correct spot, but the cursor is still at the title."

**Root cause**: `focusRemById`'s cross-document fallback does `openRem(root)`
then immediately `walkCaretTo(id, 1)`. Right after `openRem` resolves,
`getFocusedRem()` already correctly reports the new document's title Rem —
but `moveCaretVertical` silently no-ops for the first several calls, because
the editor hasn't finished mounting yet (the same family of "just-navigated/
just-mutated state lags behind the read API" race as `positionAmongstSiblings`
post-edit and the insert-mode reconcile lag, just a different API surfacing
it this time). `walkCaretTo`'s loop reads this as "hit a boundary": hop 1
no-ops (caret still on title, `prevId` was `null` so no break yet), hop 2
no-ops again (`f._id === prevId` now true, since both reads are the title) —
break, having tried only 2 real hops. Same thing in the other direction, 2
more no-op hops, then give up. Total ~4 wasted calls, caret stranded on the
title exactly as reported.

**Fix**: wrapped the walk-down in a retry loop — up to 5 attempts, 80ms apart,
stopping as soon as one `walkCaretTo(id, 1)` call succeeds. No new "is the
editor ready" signal exists in the SDK to poll directly (checked `focus.d.ts`
and `editor.d.ts` — nothing like a mount/ready event), so this retries the
actual operation we care about rather than betting on a specific readiness
heuristic; each failed attempt is cheap (the ~4-hop failure mode above, not a
full 60-hop budget) since `walkCaretTo` itself still bails fast on a
no-progress boundary.

**Status: NOT yet live-verified** — same session, no live RemNote access.
`check-types` clean, 365/365 tests green. Dev server restarted, `curl`-
confirmed the retry loop is present in the served bundle. This is the fourth
live-feedback round on the same underlying Ctrl-O/cross-document fix (5 →
5b → 5c → 5d) — each prior round fixed exactly what was reported and exposed
the next layer once that layer's fix was confirmed working. Needs the same
repro once more: Ctrl-O from a different document should now open "RemNote
Vim Plugin" *and* land the caret precisely on the original child bullet, not
just scroll there.

### 2026-07-10 — round 5c: round 5b's ancestry-walk overshot too — jump/mark entries now carry the recorded document id directly

Live-tested round 5b immediately: still broken, more precisely diagnosed this
time. User's real hierarchy: a workspace "project folder" (true tree root,
no parent) contains the "RemNote Vim Plugin" document, which contains an
"Issues" subtree, whose child was the original focus. Ctrl-O after navigating
elsewhere via RemNote's own search landed on **the project folder's title**,
not "RemNote Vim Plugin". User: "it is not fixed it is not working."

**Root cause**: round 5b's `findDocRoot` walks `.parent` all the way to the
Rem with *no parent at all* — but that's the workspace-level container, not
the document the user was actually working in. RemNote has no data-level
distinction between "a document/page" and "a regular nested bullet that
happens to be one level down from a folder" — any Rem can be zoomed into as
a pane's root, so "which Rem counts as the document" is a **session/UI fact**
(whatever was open in the pane), not something recoverable by walking the
tree after the fact. Round 5b's heuristic had no principled place to stop
between "Issues" and the workspace root and guessed wrong (too far, this
time, rather than round 5's too-shallow zoom-into-the-leaf).

**Fix**: stopped guessing entirely. `jumps`/`marks` now store a `JumpEntry
{ id, docId }` instead of a bare Rem id — `docId` is captured via the new
`currentDocId()` helper (`getFocusedPaneId()` + `getOpenPaneRemId()`) at the
exact moment a position is recorded: every `recordJump()` call, the live-
position stash inside `case 'jump'` (first Ctrl-O off the live end), and
`setMark`. `focusRemById(id, docIdHint)` now takes that hint and, on a
cross-document fallback, opens `docIdHint`'s Rem directly (no ancestry
guessing) before walking down to `id`. `findDocRoot`'s parent-walk survives
only as a last-resort fallback for a missing/unresolvable hint (e.g. a
`JumpEntry` whose `docId` Rem was since deleted) — kept rather than deleted
since it degrades gracefully instead of failing outright, and is honest
about being second-best. `gotoMark`/`listMarks` updated for the new
`Map<string, JumpEntry>` shape.

This is the *right* fix in hindsight — a UI-session fact (what's open in a
pane) can only be known by observing it when it's true, not reconstructed
afterward from the Rem tree alone. Both round 5 and 5b were solving the
wrong half of the problem (making the walk fast, then making the fallback's
*target* less wrong) without questioning whether the fallback could know the
right document at all.

**Status: NOT yet live-verified** — same session, no live RemNote access.
`check-types` clean, 365/365 tests green. Dev server restarted, `curl`-
confirmed `currentDocId` present in the served bundle. Needs the exact
repro re-run: Ctrl-O from a different document should land back in "RemNote
Vim Plugin" (not the project folder, not "Issues") with the original child
bullet focused. Also worth a quick sanity check that plain same-document
Ctrl-O and marks (`ma` / `` `a ``) still work — those go through the fast
`isInFocusedDocument` + in-place walk path, untouched by this round, but the
data-shape change (`jumps`/`marks` now hold objects, not strings) touches
every read site of both, so it's worth confirming nothing was missed.

### 2026-07-10 — round 5b: fixed the round-5 regression it caused — fallback now reopens the real document root, not the leaf

Live feedback on round 5, same session: "it jumps back without all of that
cursor scrolling through entire documents, but the focus got messed up, which
made things worse." Concrete repro the user gave: focused on a child of an
"Issues" bullet inside document "RemNote Vim Plugin"; opens RemNote's own
search/quick-switcher and navigates to a different document; presses Ctrl-O.
Landed on the right Rem id, but the pane ended up zoomed into the "Issues"
bullet (or the target's immediate neighborhood) instead of showing the
original "RemNote Vim Plugin" document with that child in context. Explicit
user framing: a correct-but-slower fallback beats a fast-but-wrong one — this
was a real regression, not a nitpick.

**Root cause**: round 5's fallback path called `window.openRem(target)`
directly on the *leaf* Rem once `isInFocusedDocument` correctly determined
the walk was hopeless. `openRem` zooms the pane into whatever Rem you hand it
— for a plain outline bullet (not itself a page), that discards the
surrounding top-level document entirely and shows a narrower view rooted at
(or near) that bullet instead. This exact call already existed before round 5
too (same fallback, reached the slow way after ~240 wasted round trips) — so
this bug likely predates this whole investigation; round 5 just made the path
fire near-instantly, so the wrong end state became prominent and repeatable
instead of an easy-to-miss edge case at the end of a 2-second stall.

**Fix**: added `findDocRoot(r)` — walks `.parent` up from the target Rem
until it hits the true top-level Rem (no parent), same walk-the-parent-chain
pattern already used by `isDescendantOf`/`inRemovedSubtree` in this file, just
capped more generously (100 hops, since this one needs the *actual* root, not
a shallow trail-covering check). `focusRemById`'s fallback now calls
`openRem(root)` — reproducing the document the user was actually in — and
then, if the root isn't the target itself, does one more `walkCaretTo(id, 1)`
downward from the freshly opened top to land the caret exactly back on the
original Rem, same as the pre-navigation state.

Cost: this fallback path is already the "slow-ish, cross-document" case (a
real pane navigation is unavoidable there), so the extra short downward walk
from a document's top — generally far fewer hops than a blind 60-hop budget,
since we start at row 0 — is a small, justified addition given the user's own
stated preference for correctness over speed here.

**Status: NOT yet live-verified** — same-session fix, no live RemNote access.
`check-types` clean, 365/365 tests green (still adapter.ts-only logic, no
unit coverage). Dev server restarted, `curl`-confirmed `findDocRoot` present
in the served bundle. Needs the exact repro above re-tested: Ctrl-O back from
a different document should now both (a) skip the slow scroll-through (round
5) and (b) land back in the correct document with the correct bullet focused,
not zoomed into a narrower view (round 5b).

### 2026-07-10 — round 5: Ctrl-O jump-to-previous-document dragged the caret through the whole doc — fixed with a document-membership pre-check

New report (after round 4's gg/G fix was confirmed): "when doing Ctrl+O and
jumping to previous document, the cursor sort of goes through the entire
document" — user correctly linked it to the same family of issue as the gg/G
slowness.

**Root cause**, found by reading `focusRemById`/`walkCaretTo` (adapter.ts):
`focusRemById` already had a doc comment describing the intended behavior
("walk visible rows if on screen in the current document, otherwise open the
rem") but the *implementation* never actually checked which case it was in —
it just always tried `walkCaretTo` first (up to 60 hops **per direction**,
each hop = 1 `moveCaretVertical` + 1 `getFocusedRem`, i.e. up to ~240 round
trips) and only fell back to `window.openRem()` after that budget was
exhausted. Ctrl-O jumping back to a Rem in a *different* document (or a mark
set before switching documents) is exactly the case where the walk can never
succeed — the live caret can only move within the currently open document's
visible tree — so every cross-document jump paid the full ~240-round-trip
timeout before the correct `openRem()` fallback ever fired, visibly dragging
the caret through every row on the way.

Unlike gg/G, this genuinely can't be fixed by batching the walk itself:
`walkCaretTo` needs an exact-match check on every hop (it's homing in on one
specific Rem, not a document boundary), and I re-derived why batching+deferred
verification is a false economy here — after a blind batch of K hops, ruling
out that the target was one of the K-1 *skipped* intermediate rows requires
backtracking through all of them anyway, so batching then backtracking costs
*more* round trips than just checking every hop, not fewer. (Documented this
reasoning here since it's the second time this exact "can we batch it"
question comes up for a walk — the answer depends on whether the loop is
searching for a boundary, batchable, vs. an exact target, not batchable this
way.)

**Fix**: added `isInFocusedDocument(remId)` — before attempting the walk,
check whether `remId` is the currently-open document's root or in its
subtree, via `getFocusedPaneId()` + `getOpenPaneRemId()` + `rem.findOne` +
`doc.getDescendants()` (the same pattern the existing `:s///a` flag already
uses for "act on the whole open document", so not a new API shape for this
codebase). This is O(1) round trips regardless of document size or the
target's depth, unlike a hand-rolled parent-walk-up (which I considered and
rejected — its cost scales with the target's *tree depth*, unrelated to
whether it's visually walkable, and would have made ordinary deep-nested
same-document jumps slower without fixing anything). Any inconclusive result
(no focused pane, doc Rem vanished) defaults to `true` — i.e. falls back to
the pre-existing "just try the walk" behavior, never worse than before this
check existed.

Cost tradeoff: every in-document jump (the already-fast, common case) now
pays ~4 extra round trips (pane lookup ×2, `rem.findOne`, `getDescendants`)
before the walk even starts. Judged worth it: those jumps are typically only
a few hops already, so this roughly doubles a fast operation, versus cutting
the reported cross-document case from up to ~240 wasted round trips down to
~4-5 total. `focusRemById` is shared by both the `jump` (Ctrl-O/Ctrl-I) and
`gotoMark` cases, so mark-jumps across documents get the same fix for free.

**Status: NOT yet live-verified** — implemented and reasoned from source only
(no live RemNote access this session, same constraint as every other round).
`npm run check-types` clean, 365/365 unit tests still green (this is
adapter.ts-only logic, no unit coverage exists for it — same gap as the rest
of the adapter). Dev server restarted with a fresh stamp; `curl`-verified
`isInFocusedDocument` is present in the served `index.js`. Needs a real
Ctrl-O-across-documents test to confirm both that the slow case is now fast
*and* that ordinary same-document Ctrl-O/marks didn't regress.

### 2026-07-10 — round 4 CONFIRMED: gg/G batching live-verified "much better"

User re-tested on a long document: the batched boundary-check loop (20 hops
between `getFocusedRem()` checks instead of 1) is a clearly noticeable
improvement. Not pushed further since it wasn't asked for — if it ever comes
back as "still too slow" for a much larger document, bump `BATCH` in the
`goDoc` case first (cheap dial), before reaching for the heavier
`window.openRem()`-loses-the-live-caret alternative noted below.

### 2026-07-10 — round 4: gg/G slow in long documents — batched the boundary-check loop

New report (not one of the original 5): `gg`/`G` visibly walks bullet by
bullet in long documents, up to ~2s. Confirmed in `goDoc`'s case in `exec()`:
the loop did ONE `moveCaretVertical` + ONE `getFocusedRem()` (to detect
arrival) PER BULLET, capped at 200 hops — literally two async round trips per
bullet, matching "goes to the end rem by rem" exactly. There is still no way
to jump the caret directly to an arbitrary position (the same documented
platform limit `walkCaretTo` already works around elsewhere in this file), so
this can't become O(1) — but the per-hop `getFocusedRem()` check doesn't need
to run after literally every single move. Batched to 20 moves between checks,
leaning on an assumption already relied upon elsewhere in this exact file
(the `scroll` case loops `moveCaretVertical` with NO check at all) — that
calling it past the document boundary is a safe no-op. Cuts total round
trips roughly in half for a document needing the full walk (~1.05N async
calls instead of ~2N). Also raised the hop ceiling 200 → 2000: a document
with MORE visible rows than 200 would have silently stopped short of the
true start/end before this — separate latent correctness bug, same fix.

**Not addressed**: whether ~2x fewer round trips is enough to satisfy "up to
2 seconds" is unverified (no live timing data yet — same reasoning gap as the
insert→normal delay fix from round 2, where a partial fix turned out to be
"slightly better, not perfect"). If it's still too slow, the next lever would
be a larger batch size (cheap to try) or a fundamentally different approach —
`window.openRem()` can focus a Rem directly without the incremental walk (used
already as `focusRemById`'s cross-document fallback) but is documented
elsewhere as NOT leaving a live text caret behind (a click is needed
afterwards) — trading that away for gg/G specifically would be a real UX
change, not just a speed fix, and shouldn't be done without checking with the
user first.

### 2026-07-10 — round 3: undo-grouping CONFIRMED working live, but revert/reapply forgot walkCaretOut — fixed

Live signal at last: user confirmed the round-2 `structuralOp` rewrite
actually reverses a full paste / mass-indent in one `u` press now (the
counted-`editor.undo()`-N-times approach from round 1 truly didn't work; the
direct revert/reapply approach does). Also confirmed the Ctrl-P/Ctrl-K Escape
fix works once genuinely idle in normal mode — turned out the original report
was from insert mode, exactly the known gap flagged in round 2 (insert mode's
Escape stays unconditional to exit insert; can't disambiguate "close RemNote's
popup" from "leave insert mode" using the same bare keystroke with no DOM
visibility into whether a popup is open).

New regression from round 2: undoing a paste/indent worked, but **the caret
disappeared afterward**, forcing a mouse click to regain focus. Root cause:
`pasteRem`/`indentSelection`/`outdentSelection`'s `structuralOp.revert`/
`reapply` closures called `rem.remove()`/`setParent()` directly, skipping
`walkCaretOut()` — which the ORIGINAL forward-direction code always calls
first, with the exact comment "re-parenting the focused Rem unmounts its
editor and kills the caret... once removed the caret is unrecoverable
programmatically." My new closures moved/removed Rems the caret could easily
still be sitting on (undo/redo can fire long after the original command) with
no such guard. Fixed:
- `pasteRem`'s `revert` now fetches the created Rems and passes them through
  the EXISTING `removeRems()` helper (used by `dd`/visual-line delete)
  instead of a bare `remove()` loop — it already walks the caret to a safe
  neighbor first, and falls back to clearing one Rem's text if there's
  nowhere to go (the "deleting the only bullet" case).
- `indentSelection`/`outdentSelection`'s `revert`/`reapply` now call
  `walkCaretOut(moveIds)` before the `setParent` loop and `walkCaretTo` after,
  mirroring the forward operation exactly.

**One acknowledged, unaddressed residual risk**: `walkCaretOut` always moves
the caret at least one step vertically before checking whether it needed to
(it calls `moveCaretVertical` unconditionally, then checks). In the ORIGINAL
forward code this never mattered — the caret is always ALREADY on the
targeted rems when the user just ran that command on their own selection. My
revert/reapply can fire much later (nothing currently clears `structuralOp`
on plain caret movement, only on another mutating action), so if the user has
since moved the caret AWAY from the affected rems entirely, calling
`walkCaretOut` unconditionally would still nudge the caret one line for no
reason. Not fixed this round (lower severity than the disappearing-caret bug,
and time-boxed) — if reported, the fix is to check
`inRemovedSubtree(focusedId, ids)` first and only call `walkCaretOut` when
true.

Debug badge additions this round: `esc:steal`/`esc:free` (live, always
current — shows whether `escape` is currently in `stolenSpecs`, so a report
like "Escape didn't close the popup" can be immediately split into "we were
still holding it" vs. "we released it and RemNote still didn't take it," two
very different follow-ups). Also: the build-stamp
(`__VIM_BUILD__`/`webpack.config.js` DefinePlugin, shown as the first badge
token) only refreshes on a dev-server **process restart**, not on every
incremental rebuild the watcher does automatically — this confused a status
check this round (bundle was current, stamp was stale-looking). Habit going
forward: restart `npm run dev` after each round of fixes specifically so the
stamp stays a meaningful "is this fresh" signal, not just rely on the
watcher's silent rebuild.

### 2026-07-10 — HANDOFF: round 2 on `fix/vim-mode-bugs` after live feedback — undo-grouping rewritten, still no live access this session

User live-tested the 2026-07-09 entry below against a real RemNote build (via
`npm run dev`) and reported back per-item status. Still no GUI/RemNote access
in this session — everything below is reasoned from the code plus the user's
verbal report, not independently observed. A build-stamp was added this round
too (`webpack.config.js` DefinePlugin → `__VIM_BUILD__`, shown as the first
token in the debug badge, e.g. `vim 0.1.0@2026-07-09T23:41:07 normal ...`) —
**always check that string changed after a plugin reload** before trusting a
"still broken" report; `npm run dev`'s dev-server has no hot reload, and the
stamp is only refreshed when the dev-server process itself (re)starts, not on
every incremental save.

1. **Undo after paste/mass-indent: reported "not done."** The previous
   `undoGroups`/`redoGroups` counted-repeat approach (call `editor.undo()` N
   times, N = Rems touched) evidently doesn't reverse these operations
   correctly live — most likely because RemNote's real undo-history
   granularity per Rem isn't 1:1 with what was counted (createRem/setText/
   setParent may be more than one native entry each), which isn't observable
   from the plugin API. **Replaced entirely** with a direct
   revert/reapply mechanism (`structuralOp` in `VimAdapter`) that bypasses
   `editor.undo()`/`redo()` for these two ops and reverses them with the same
   primitives that performed them — correct by construction, no native
   undo-history granularity to guess:
   - `pasteRem`'s case in `exec()` now records every top-level created Rem id;
     `revert` just `remove()`s them, `reapply` re-runs `pasteSubtree` at the
     original site. This half is simple and should be solid.
   - `indentSelection`/`outdentSelection`'s case now records each moved rem's
     original AND destination `(parentId, position)` (one extra
     `getChildrenRem()` per rem versus the existing race-avoiding lookup, paid
     only to build this record). `revert` restores original positions in
     REVERSE of application order (undo the last move first — the general
     rule for a sequence of order-dependent position changes); `reapply`
     replays forward. **This is the riskiest part of this whole session** —
     the position arithmetic for restoring MULTIPLE moved rems that
     originally shared a parent is reasoned through, not tested (a single
     selected rem, the most common case, has no such ordering complexity —
     risk is concentrated in multi-rem, multi-parent visual-line indents).
   - Any OTHER mutating action (new `MUTATING_OTHER` set in `applyKey`)
     clears `structuralOp`, so a `u` after some unrelated later edit correctly
     falls through to plain `editor.undo()` instead of reaching back through
     a stale record.
   - Debug badge now shows `dbgUndo`: `u:structural`/`u:native`/
     `r:structural`/`r:native` — **check this first** next time: if it says
     `u:native` right after a multi-bullet paste, the tracking isn't firing
     (a real bug to chase); if it says `u:structural` but the bullets are
     still there afterward, the `revert`/`reapply` logic itself has a bug.

2. **Insert→Normal delay: reported "maybe slightly better, but still not
   perfect."** The prior fix only removed the second, redundant confirmatory
   read; the FIRST `settleRead` in `reconcileAfterInsert` still ran
   unconditionally (≥1 network/IPC round trip even when nothing was typed).
   Now skipped entirely when no `EditorTextEdited` fired during insert (the
   `i<Esc>` idiom) — `fresh = pre` directly, no read at all. This is a firmer
   bet than before (previously we still read-to-confirm; now we trust the
   event outright when it never fired) — if `EditorTextEdited` turns out to
   be unreliable (event drop/debounce), the exposure is a stale model for
   ONE keystroke, self-correcting on the next real edit. The fallback path
   (when an edit WAS seen) is untouched. **If it's still not fast enough**,
   the remaining cost is very likely `applyMode()`'s `stealKeys`/
   `releaseKeys` RPC round-trip when swapping ~45 normal-mode key specs back
   in (architecturally required for per-mode key stealing, not something
   this session found a safe way to avoid) — added `dbgTiming` to the badge
   (`t:recon=Xms mode=Yms`) specifically to tell these apart next report:
   if `mode=` dominates, the remaining latency is the stealKeys round trip,
   which would need a different, more invasive approach (not attempted this
   round — flag it back here if that's what the numbers show).

3. **NEW: a RemNote popup (Ctrl-P/Ctrl-K) can't be closed with Escape** — the
   plugin's own Escape steal (always active, every mode) swallows it before
   RemNote's own popup-close handler sees it. Added `syncEscapeSteal()`: in
   NORMAL mode specifically, when there's genuinely nothing pending
   (`op`/`pending`/`count` all empty — Escape would be a vim no-op anyway),
   `escape` is released so RemNote's own handler gets it; the instant
   anything becomes pending, or on any other mode, it's re-stolen. Kept in
   sync with `applyMode`'s own `stolenSpecs` bookkeeping (`escapeWanted`) so
   the two mechanisms don't fight over whether `escape` is actually
   registered. **Known gaps, not fixed by this**: (a) doesn't help if the
   popup was invoked from INSERT mode (Escape there is unconditional, by
   necessity, to exit insert); (b) assumes RemNote's key-steal takes
   priority over popup-local Escape handling only while explicitly
   registered — if RemNote's steal mechanism intercepts at a level that
   ignores our release entirely, this won't help at all and needs a
   different investigation. Purely reasoned, zero live signal either way yet.

### 2026-07-09 — HANDOFF: five user-reported bugs fixed on branch `fix/vim-mode-bugs` — NEEDS LIVE VERIFICATION

Working from a fresh CLAUDE.md pass over the codebase (no live RemNote access
in that session — terminal-only environment), so **every item below is
implemented from reading the code and is unverified against a real running
RemNote instance.** `npm run check-types`, `npm test` (365/365) and `npm run
build` are all green, but per `pure.ts`'s own doc comment "adapter.ts itself
can only be exercised live" — none of this touched the engine, so the unit
suite couldn't catch a live-only regression either way. **Next step for
whoever picks this up: run through the 5 repro scenarios below against a real
RemNote build before merging**, watching the debug badge (bottom-left) for
the new `dbgLeak` field this session added.

User's 5 reports and what changed:

1. **`r` + a capital letter "just types it and ignores it."** Root cause is
   almost certainly the same shift-blindness §9 already documents for other
   keys (RemNote's steal matcher not reliably catching a held Shift) — **not
   fixed at the root, and may not be fixable** (no way to detect Shift from
   the plugin API at all). What IS fixed: the fallout. If the capital leaks
   through as literal native text while `state.pending.p === 'replace'` is
   armed, the pending replace previously stayed silently stuck against a now-
   stale caret position. See item 2's fix — the same guard also clears
   `pending`/`op`/`count` when this happens, so a leaked keystroke aborts the
   in-flight command cleanly instead of misfiring on the next keystroke.

2. **Empty bullet + typed capitals ⇒ h/l stop working in that bullet.**
   `VimAdapter.start()` (`src/adapter/adapter.ts`) now also listens for
   `AppEvents.EditorTextEdited` (previously unused — confirmed present in
   `@remnote/plugin-sdk`'s `events.d.ts`). When it fires while `!this.processing`
   and mode isn't `insert`/`command`, that can only be a native edit that
   slipped past our key-stealing (we never mutate the doc ourselves outside
   `exec()`), so the local model is now provably stale — the handler drops any
   in-flight `pending`/`op`/count and marks the model dirty so the next
   keystroke resyncs from RemNote instead of computing motions against a
   bullet the engine still believes is empty. Sets `dbgLeak` in the badge when
   it fires, for live confirmation.

3. **Delay between leaving insert mode and the next `j`/`k`.** Root cause
   found in `reconcileAfterInsert()`: it unconditionally paid a second,
   longer `settleRead` (rounds:1, delayMs:120) whenever the pre/post-insert
   text matched, to disambiguate "nothing was typed" from "the read API is
   still lagging behind a real edit" — and this fully blocks the adapter's key
   queue, so the very next keystroke (often `j`/`k` per the report) waits on
   it. The same new `EditorTextEdited` listener now sets `insertSawEdit` while
   in insert mode; if it never fired, `fresh === pre` is a certainty rather
   than a guess, and the extra confirmatory read is skipped. Behavior is
   byte-for-byte unchanged whenever an edit WAS seen (the risky path is
   untouched) — this only removes latency for the idiom where insert mode
   produced no edit (`i<Esc>`, arrow-then-Escape).

4. **`;e` wildmenu suggestions overflow the screen for long Rem names.** The
   wildmenu renders through CSS `body::after { content: "..." }` with
   `white-space: pre` (needed for the `\A`-separated multi-line stack), which
   has no usable `text-overflow` story — so truncation has to happen at the
   string level. Added `truncateLabel()` to `src/adapter/pure.ts` (code-point
   safe, default 60 chars + `…`), used only for the on-screen label in
   `updateSuggestions()` — Tab-completion still inserts the Rem's real,
   untruncated name. Also added a `max-width: 70vw; overflow: hidden` safety
   net to the badge CSS itself. Unit-tested in `tests/adapter-pure.test.ts`
   (this one's fully verified, unlike 1–3 and 5).

5. **Undo after paste-subtree / mass indent needs many presses.** RemNote's
   undo history apparently records one entry per Rem a structural op touches
   (`createRem`/`setParent`), not one per vim command — confirmed by the
   user's own repro ("remove each separate cell"). Added `undoGroups`/
   `redoGroups` stacks (`VimAdapter`): every keystroke that reaches
   `applyKey()` pushes its native-undo weight (default 1); `pasteRem`'s case
   in `exec()` now sums `pasteSubtree`'s (also changed to return a `{id,
   count}` node count instead of just an id — the other call site,
   `duplicateBullets`, was updated for the new shape but NOT wired into the
   grouping, out of scope for this pass) and `indentSelection`/
   `outdentSelection` counts actual `setParent` calls (some rems `continue`
   past guards and don't get one) — both override the default via
   `pendingGroupSize`, consumed once at the end of the same `applyKey()`
   call. `case 'undo'`/`'redo'` in `exec()` now pop a weight off one stack,
   loop `editor.undo()`/`redo()` that many times, and push it onto the other.
   `replayKeys` (dot-repeat) is excluded from pushing its own entry since it
   recurses into `applyKey()` per replayed key, which pushes its own — so
   `.`-repeating a grouped paste stays correctly grouped. **This is the
   riskiest change to get wrong** (an incorrect count would over/under-undo
   relative to what the user expects) — the design deliberately defaults
   every untouched action to weight 1 (today's exact existing behavior, zero
   regression risk) and only overrides the count for the two named ops where
   the user's own bug report empirically confirms the 1-native-step-per-Rem
   granularity. Still: verify live, specifically that `u` after a multi-
   bullet `p` and after a multi-line `>`/`<` in visual-line each fully
   reverse in one press, and that a subsequent `u` (for an unrelated earlier
   edit) isn't affected.

### 2026-07-08 — Block cursor: FINAL decision — caret-shape only, wait for the platform

**USER DECISION (2026-07-08, final):** the plugin is being published, so the
block cursor ships exclusively via the standards-based `@supports
(caret-shape: block)` rule already in `render()` (previous entry, item 2).
**On newer Chromium (with `caret-shape` support) users get a correct block
cursor in normal/visual; on older Chromium — like the desktop app's
Electron 36 / Chromium 136 — not so much:** they get the thin mode-colored
caret + mode-colored cursorline fallback until RemNote upgrades Electron.
No further action on our side — it's the platform's turn.

Explicitly rejected (don't re-propose): the **1-char-selection fake block**
(keep a native selection on the cursor char in normal mode, style
`::selection`). A live probe showed the core works — `selectText({start,
end:start+1})` renders a char-sized box, no formatting toolbar popped, SDK
reads it back cleanly (`isReverse:false`, correct range) — but it needs
collapse/re-select around every keystroke through async APIs (flicker risk,
EOL/empty-line/mouse edge cases). Not worth it for a published plugin.
`src/adapter/blockCursor.ts` (the native-only overlay WIP, never committed)
was **deleted**; its approach (host-page overlay div, mix-blend-mode
difference, tracks the DOM caret rect) is described in the 2026-07-08
handoff entry below if native mode ever ships.

### 2026-07-08 — Sandboxed visibility boost SHIPPED (user picked option (a); block-cursor WIP retired)

**USER DECISION (2026-07-08):** of the block-cursor options below, the user
chose **(a) sandboxed visibility boost** — the plugin is meant for public
use, so only store-shippable mechanisms are in play. The native-only WIP was
therefore **reverted from `src/adapter/adapter.ts`** (import, render hook,
`native:` badge suffix); `src/adapter/blockCursor.ts` was kept briefly as
an untracked local file, then deleted (see the final-decision entry above —
the approach is documented in the handoff entry; §9 has the re-test recipe).

What shipped (all in `render()`, CSS-only — no engine/adapter behavior
change):

1. **Theme-aware mode palette:** new `MODE_COLORS_DARK` (violet/emerald/
   amber/sky 400-series) used by caret + cursorline under `body.dark`
   (RemNote's dark-theme marker, probed live); light theme keeps the
   saturated 600-series `MODE_COLORS`. The badge keeps `MODE_COLORS` on both
   themes.
2. **Caret:** bright mode-colored `caret-color` outside insert (unchanged
   idea, now theme-aware); insert deliberately has NO caret rule — the
   editor's default thin caret itself signals insert mode. Plus
   `@supports (caret-shape: block)`: a TRUE block caret in normal/visual
   (bar in command) for browsers that support it — the desktop app's
   Chromium 136 does **not** (probed live: `CSS.supports("caret-shape",
   "block")` → false), but web users on newer browsers get it for free.
3. **Cursorline:** focused row tint is now mode-colored via `color-mix`
   (8% light / 13% dark, up from a fixed 7% violet) with a matching
   3px left bar, both themes.
4. **Visual mode:** `::selection` inside the editor is painted amber
   (30%/35% mix) so the vim selection can't be mistaken for a plain mouse
   selection.

Verified: tsc clean, unit 360/360, live style probes per mode on BOTH themes
(computed `caret-color`/row bg/box-shadow match the palette; insert reverts
to defaults; `::selection` rule present in visual), screenshot sanity, smoke
16/16, motionfix 8/8. Probe gotcha for future sessions: `page.reload()` over
CDP throws `net::ERR_UNEXPECTED` on this Electron target — use in-page
`location.reload()` + reconnect instead.

Still open from the handoff: the §0-item-3 EOL/block-caret clamping design
decision (unchanged by this entry).

### 2026-07-08 — NATIVE MODE INVESTIGATION CLOSED: hard-disabled platform-wide; block-cursor-via-native is a dead end on 1.26.30

Same session as the motion-fix entry below; this closes the handoff's
native-mode questions **definitively, from the app's own code** (extracted
the AppImage → grepped `resources/app.asar`; then verified live by forcing
the flag). Full mechanics now live in **§9's native-mode bullet**; summary:

1. **Why the manifest flip did nothing:** `requestNative` only feeds
   `installPlugin`'s `isNative` computation, which is `!O && requestNative
   && (!isLocal || id === "demo_all_features")` — a module-level `let O = !0`
   kill switch plus a local-plugin exclusion. Re-adding the dev plugin
   (handoff question 1) would NOT have helped: the flag computes false for
   every plugin on this version.
2. **The deeper lock:** the `PluginHost` constructor clears `isNative` on
   every registration (`m.sF && (e.isNative = !1)`). There is even a
   user-facing per-plugin "native mode" settings switch (calls
   `ot(id, {isNative})` → unregister/setNested/register) — it exists but is
   silently undone by the same kill switch. Store policy also rejects
   `requestNative:true` submissions ("REJECT IF TRUE FOR NOW" in the review
   UI). So: **no shippable native path exists today, dev or store**
   (handoff question 2 answered).
3. **Forced-native experiment** (unregister, then `pm.register(record)` with
   `isNative` as an accessor property — getter `true`, no-op setter — which
   neutralizes the constructor's clear): the native runtime DOES activate —
   widget mounts as `div[data-is-native-plugin]` + shadow root in the main
   page (no iframe), `window.__vimAdapter` appears in the MAIN window, keys
   steal fine, `hostDocument()` works, and **the block cursor renders and
   tracks** (measured `#vim-block-cursor` rects: 13.1px char-width
   difference-blend block mid-word, repositioning on 0/w/gl; the local
   `e2e/shots/native-cursor-*.png` mostly show the React error state, not a
   clean look — trust the rects). BUT: `registerCSS` output lands in the widget's
   shadow root (mode badge / debug HUD / cursorline all dead — every
   badge-reading e2e suite aborts), and the app throws React invariant
   errors with broken editor rendering. Native is a deliberately unfinished,
   switched-off feature; even dev use is not viable.

**State restored afterwards:** app relaunched clean (sandboxed iframe,
badge shows `native:no`, stored `isNative:false`), motionfix probes 8/8.
`public/manifest.json` reverted to `requestNative: false` (it does nothing
here and is store-poisonous). New tool committed: `e2e/main-repl.mjs`
(main-window REPL incl. webpack-module access recipe, §7).

**~~⚠ USER DECISION NEEDED~~ RESOLVED — user chose (a), see the entry
above.** The WIP
(`src/adapter/blockCursor.ts` + the adapter render hook, still uncommitted)
is validated as an approach but can only ship if RemNote enables native mode.
Options: (a) **sandboxed visibility boost** (brighter theme-aware
caret-color, bolder cursorline, stronger focused-row tint — no true block,
zero risk, shippable now) — the handoff's fallback, recommended; (b) shelve
blockCursor.ts in-tree behind the `hostDocument()` null-check (it already
no-ops sandboxed) and revisit when RemNote flips the switch (the §9 bullet
documents how to re-test quickly); (c) ask the RemNote team about the
native-mode timeline (the switch + settings UI are clearly built, just off).
(a)+(b) combine naturally. Also still open from the handoff: the §0-item-3
EOL/block-caret clamping design decision.

**Flagged re-probes RESOLVED — not bugs, one probe artifact.** All three of
the handoff's "needs cleaner repro" oddities are the same artifact: the old
hunt script pressed `$`, which arrives live as **`4`** (shift-blind, §9) and
became a pending COUNT for the next command. The numbers match exactly:
`$~`→"ABC" was really `4~` (toggle 4 chars); `C-a` on "item 9"→"item 13" was
9+**4**; `C-a` on "-3"→"1" was −3+**4**. Harness probes confirm the engine is
correct: `C-a` "item 9"→"item 10", `C-a` "-3"→"-2" (negatives fine), `C-x`
"item 10"→"item 9", and `$~`/`gl~` no-op at EOL (I-beam convention — the
deferred clamping decision, not a defect). Lesson for future live probes:
never type `$`/shifted keys in a probe sequence; assert the badge is
count-free between cases.

### 2026-07-08 — t/T and ea motion bugs FIXED + live-verified (on-char landing); env recovered; block cursor still blocked

Picked up the handoff below (next entry). **The two confirmed motion bugs are
fixed, unit-tested and live-verified; committed.** The block-cursor/native-mode
blocker is unchanged — see the handoff entry for that state. Environment
recovered: the crashed app was relaunched (`./e2e/launch.sh`, CDP 9223) and the
**webpack dev server on 8080 was found wedged** (watching but never rebuilding —
`touch` did nothing; it had been up since ~12:43). Killed + restarted `npm run
dev`; if a "fixed" bug still reproduces live, check the served bundle for a
fresh code marker before debugging.

**The fix (one root cause for both bugs):** landsOn semantics are now uniform —
a `landsOn` motion's `target` is its inclusive operator end (one PAST the
landed-on char) and the plain-motion caret / visual head become `target-1`.

- `motions.ts findChar`: **`t` is now `landsOn:true` with `target = i`** (the
  found char's index = its exclusive operator end = one past the landed-on
  char). That one change fixed normal `tx`, visual `vtx` (previously included
  the x), and `,`-repeat placement in all three paths, with `dtx` unchanged.
  `findChar`'s `c` is now explicitly the CURSOR (on-char) index: forward finds
  always search from c+1 (the cursor char never matches), the repeat-adjacency
  skips are now per-key (`t` and `T` only — an F skip would wrongly jump past
  an adjacent match, which `,`-after-f needs to find), and `findCharCount`
  hops pass the CURSOR position between hops, not the raw target (fixes
  `2tx` over adjacent chars, `,`-after-F was stuck on-char).
- `engine.ts` normal-motion branch: **landsOn motions now land ON the char**
  (`cpStart(target-1)`), so `e` puts the caret on the word-end char — `x`
  deletes it and `ea` appends right after the word (the user's bug: it landed
  at the NEXT word's start). vim's "e must land on a LATER char" progress rule
  applies (rerun from the next code point; if no later word end, e fails in
  place, never moves backward). **`$` deliberately keeps the I-beam EOL
  convention** (caret past the last char, like `gl`) pending the §0-item-3
  block-caret-clamping decision. Plain `e` on a one-char word now jumps to the
  NEXT word's end (vim); operator `de`/`ce` keep the I-beam rule (`de` on
  "a asdf" still deletes just "a" — the 2026-07-07 user request).

**Tests 352 → 360** (new: tx/Tx/dtx, 2tx adjacent, `,`-after-F, vtx, e+x /
ea / e-progress matrices; 5 stale pins updated to the vim-correct values).
**Live: new `e2e/motionfix.mjs` probe suite 8/8** (fz/tx/dtx/e/ee/`,`/2tx/ea
typed through the real key path). Full regression: smoke 16/16, stress 57/57,
formatting 5/5, reallife 31/34 (same 3 documented known issues, 0 violations).

**Stale-pin fix in `e2e/formatting.mjs`:** the "fm dw" probe still expected
the PRE-f-fix landing (`"pre ¤ tail m"`, i.e. dw from one-past-the-m). With f
landing ON the m, dw deletes all of "more" → `"pre ¤ tail "`. The 9ec436c
session's "formatting 5/5" evidently ran against a pre-fix bundle (see the
wedged-webpack note above — same hazard). Pin corrected, 5/5 again.

Note for the suites: the working tree's uncommitted block-cursor WIP
(adapter render hook + `requestNative:true` manifest) was IN the bundle for
all of the above runs and is inert while sandboxed (`native:no` badge) —
everything passes with it loaded.

### 2026-07-08 — HANDOFF (account switch): block-cursor feature BLOCKED on native mode; 2 more motion bugs found (t/T, ea)

**⚠ Read this first. App CRASHED at handoff; work is UNCOMMITTED in the working
tree. Nothing here is verified end-to-end yet.** The e2e RemNote instance
(CDP 9223) crashed when I called `getPluginManager().restartInDevMode('remnote-vim')`
trying to force native mode (see below) — relaunch with `./e2e/launch.sh` before
resuming. HEAD is still `9ec436c` (last session's committed work). `npm test`
and `tsc` are green on the working tree.

**Uncommitted working-tree changes (all block-cursor WIP — do NOT commit until
native mode works AND the full e2e suite is re-verified):**
- `public/manifest.json`: `requestNative` false→**true**.
- `src/adapter/blockCursor.ts`: NEW module — draws the vim block caret as a
  host-page overlay div (`mix-blend-mode:difference` over white so it inverts
  whatever's under it → visible on light AND dark; the character stays legible).
  Handles EOL (cover the last char) and empty line (default-width block).
- `src/adapter/adapter.ts`: imports + calls `updateBlockCursor(mode)` at the end
  of `render()`; also added `native:${hostDocument()?'yes':'no'}` to the
  `body::before` debug badge (KEEP this — it's how you tell if native is live).

#### The feature (user request)
Make the caret vim-like: a **block over the current char in normal/visual**
mode, a **thin bar in insert**. User's key constraint (learned the hard way):
it MUST be visible in **dark mode** — a semi-transparent purple block is
invisible on a dark background. The `mix-blend-mode: difference` (solid white)
approach is theme-agnostic by construction. A CDP prototype confirmed the look
is right in light mode; user approved the direction.

#### THE BLOCKER — native mode is not activating (the core problem to solve)
A true block cursor needs to position an overlay at the caret's **screen rect**,
which needs main-page DOM access (`window.top.document`). The plugin is a
**cross-origin sandboxed iframe** (`hostDocument()` returns null), so sandboxed
it can only inject static CSS via `registerCSS` — no overlay possible. The
dormant `src/adapter/domCaret.ts` (`hostDocument`/`readDomCaret`/`setDomCaret`,
already imported by adapter.ts lines ~296/934) was written for native mode.

`caret-shape: block` CSS (the clean one-liner) is **NOT supported** in RemNote's
Chromium 136 (shipped in Chrome 139+). Confirmed via `CSS.supports`.

I flipped `requestNative: true` and relaunched. Findings (all probed live via
`window.getPluginManager()`):
- The relaunch loads the **fresh JS bundle** but NOT a new sandbox decision.
  Debug badge shows `native:no`.
- `pm.getPluginById('remnote-vim').userPluginInfo` has `isNative:false`,
  `isLocal:true`, `baseUrl:"http://localhost:8080/"`, and its cached
  `manifest.requestNative` is still **false** — RemNote caches the manifest in
  the installed-dev-plugin record; an app relaunch reuses it.
- `restartInDevMode(id)` = `unregister(id)` then `register((await b.Nj())[id])`.
  `b.Nj()` returns a CACHED plugin-info map (still `requestNative:false`), so it
  did NOT flip `isNative`, and the call **crashed the app**.
- The dev server DOES serve the new manifest (`curl localhost:8080/manifest.json`
  → `requestNative:true`), so the cache is the only thing stale.

**What the next account must figure out (needs the author / manual RemNote UI):**
1. Force RemNote to re-read the manifest: almost certainly **remove and re-add
   the dev plugin** in Settings→Plugins→Build (pointing at localhost:8080), so
   the install record picks up `requestNative:true`. An app relaunch alone does
   not do this. (Alternatively find+edit the plugin record in the profile
   SQLite at `/tmp/remnote-vim-e2e-home/remnote/.../remnote.db`, risky.)
2. **Unknown / verify:** whether RemNote even allows a **local/dev** plugin to
   run native, or whether native requires a store-published plugin (which would
   mean the block cursor only ships to end users via a native-published plugin +
   a scary permission grant). If dev-native is impossible, reconsider the whole
   approach.
3. Once `native:yes` shows on the badge: the block cursor should render (the
   `#vim-block-cursor` div appears in the main page). Then screenshot at
   mid-word / EOL / empty-line / insert, AND **switch the e2e instance to dark
   mode** to prove visibility (it's light by default; the difference-blend
   should invert fine but SEE it).
4. **Regression risk:** native mode ALSO activates the dormant
   `readDomCaret`/`setDomCaret` paths (adapter ~296/934), dead under sandbox.
   So going native changes caret handling globally — re-run the FULL e2e suite
   (run/stress/tree/formatting/reallife) native before trusting anything.

If native proves unworkable: fall back to a **sandboxed visibility boost**
(brighter theme-aware caret-color, bolder cursorline bar, stronger focused-row
tint) — no true block, but zero risk. Offer the user this choice.

#### Bug hunt — 2 CONFIRMED motion bugs still to fix (the "find 3 more bugs" task)
1. **`t`/`T` cursor off-by-one** (SAME family as the committed `f` fix).
   `tx` then `x` deletes `x` instead of the char before it (probed: "abcx" →
   "abc", want "abx"). Root: engine.ts pending-find block (~line 310). The
   committed `f` fix used `landsOn ? target-1 : target`, but `t` is
   `landsOn:false, target=i` and ALSO needs `target-1`. Correct rule is by
   DIRECTION not landsOn: **forward finds (f AND t) → cursor = target-1;
   backward (F, T) → cursor = target** (`fk==='f'||fk==='t'`). Add unit tests
   (`tx`+`x`, `Tx`+`x`, `dtx` still deletes through — operator path is separate
   and already correct). Don't break the committed `f` behavior.
2. **`ea` lands at the start of the NEXT word** (user-reported real workflow:
   `e`→`a` should append right after the word). Almost certainly the same
   family: normal-mode `e` (engine.ts ~line 389, `motionCaret` ignores
   `landsOn`) overshoots the word-end char by one, so `a` (=cpForward+1) lands
   two past. VERIFY with `e`+`x` (should delete the word-end char) and
   `e`+`a`+type. FIX must keep `de`/`ce` operators correct (they need the
   inclusive end — separate path). This is the bug the USER most cares about
   after the cursor.
3. **`$`/EOL block-caret semantics (design decision, ties to the block cursor).**
   This plugin's normal-mode caret uses I-BEAM semantics — `$`/`gl` land at `n`
   (PAST the last char), so `r`/`~`/`x` at EOL hit nothing (`$rz` on "abc" →
   "abc" unchanged) and the block cursor has no char to cover at EOL. Vim's
   block caret is clamped to the last char (`$` lands ON it). **Adopting
   vim block-caret clamping in normal/visual (never past last char) would fix
   the block-cursor EOL case AND the r/~/x-at-EOL bugs at the root** — but it's
   a bigger change (clamp `$`, `l`, motions in normal mode; keep `a`/insert able
   to reach `n`). Worth considering alongside the block cursor.
   Also flagged, needs cleaner repro: `C-a` on "item 9" gave "item 13" (want
   "item 10"); `C-a` on "-3" gave "1" (negative-number handling in
   motions.ts `numberAt`). And `$~` on "abc" gave "ABC". Re-probe these.

Bug-hunt method: a live probe script drove ~18 vim behaviors and diffed against
real vim (`reset`→type→keys→read focused-rem text). Recreate it under `e2e/`
(I deleted the throwaway `_hunt.mjs`); most sandboxed shift-blind keys (D=d$,
C=c$) are NOT bugs — the plugin uses g-chords (`dgl`, `cgl`).

### 2026-07-08 — Stability pass live-verified + committed; real-life e2e suite added; f-motion off-by-one FIXED

Picked up the mid-verification handoff below and closed it out. **Everything
committed.** Live state at end of session: unit **352/352**, `tsc` clean,
smoke **16/16**, stress **57/57**, formatting **5/5**, tree **24/26**,
real-life **31/34 (0 violations, 3 documented known-issues)**. App on CDP 9223,
daily doc jB3hgL swept clean.

**Handoff checklist — all done:** smoke 16/16 (the first few `null` reads on a
cold boot were the daily-template banner, see below — a re-run was clean);
stress 57/57; formatting 5/5 on the FINAL bundle (proves the by-id batch didn't
disturb the offset/EOL paths); tree runs again (was silently building `[""]`).

**Root cause of the §9 "cold-boot click-swallow":** it is the **daily-template
modal** — an EMPTY daily document raises RemNote's "Capture & Organize Your
Day's Thoughts" banner, whose dimming backdrop swallows every synthetic click
(activeElement stays BODY, no rem focuses). It reappears whenever a suite
empties the doc. Fix: `dismissBanner()` (click its Close ×) — added to
`reallife.mjs` and `tree.mjs`, called up-front and inside `resetEmpty`'s loop.
tree.mjs also gained the `pointer-events-none` strip run.mjs/stress.mjs have.
(run.mjs/stress.mjs happened not to hit the banner this session; add
dismissBanner there too if they do.)

**NEW real-life e2e suite (`e2e/reallife.mjs`, `npm run e2e:reallife`).** The
old suites drive tiny fixtures; this one mirrors real usage — long prose lines
(~110 chars, bulk-typed) and many bullets (18). Three phases: (1) long-line
motion/edit fidelity, (2) many-bullet bulk visual cut/paste + `:g` + `:sort`,
(3) a realistic nested outline. It caught **three genuine bugs** on its first
run (details below); phase 1 (which re-verifies the stability pass's offset/EOL
class on long lines) is **green**.

**BUG FIXED — plain `f` cursor motion off-by-one** (found by reallife phase 1;
engine, unit-tested, live-verified). A plain `fz` landed the caret ONE PAST the
char (`findChar` returns the offset AFTER the char — its inclusive
operator-range end, used by `df`), so `fz` then `x` deleted the char after `z`.
The **visual** find path already did `landsOn ? target-1 : target` (engine.ts
vStart); the **normal** path (the `pending:'find'` branch) used `motionCaret(r)`
= `r.target` and forgot it. Fix mirrors the visual path inline. Three existing
unit tests had pinned the buggy `i+1` caret (they were written to match the
impl) — corrected, plus a new `fz`→`x` engine test. Live: `fz x` on
"the lazy dog" → "the lay dog". **352/352.**

**Open findings (pre-existing, NOT stability-pass regressions — their code paths
weren't touched; marked `known` in reallife.mjs so the suite is green):**
1. **`:sort` does not reorder** — runs but `sortBullets`'
   `setParent(parent, index)` does not move same-parent children (reproduced
   with a correctly-focused parent AND with a visual selection; `trail:4
   units:4` confirmed the selection was intact). The handoff's "✅ :sort" was
   likely a run-check, not an order-check.
2. **`vvd` on a parent with SEVERAL children** clears the parent's text but
   leaves the children — the subtree is not cut. The single-child case works
   (stress phase 5), so it's child-count/structure specific.
3. **tree.mjs 2 stable checks** (unchanged this session): `anchor tint` ([] vs
   the g1 anchor — first-step tint read) and the outdent→indent round-trip
   (`E:asdf` re-indents under `tail`, not `Empty Bullet` — outdent lands it at
   the doc end). Worth a look; the CORE cross-parent selection bug the suite
   exists for still passes 24/26.

Next session: decide whether to fix findings 1/2 (both are real user-facing).

### 2026-07-08 — HANDOFF mid-verification: stability pass (rich-text offset space, insert-exit race, code-point safety); unit suite 153 → 351

**⚠ Read this first — session ended on an account switch with live
verification INCOMPLETE and NOTHING COMMITTED.** All code changes below are
in the working tree only (alongside the earlier uncommitted OSS-prep tweaks
to e2e/launch.sh, package.json and webpack.config.js). State at handoff:
unit **351/351**, `tsc` clean; targeted live probes **5/5** (but against the
bundle from *before* the last change batch — see below); smoke **not green
on the final bundle yet** (details in the checklist).

**Environment at handoff:** e2e app RUNNING on CDP 9223 with the current
bundle (relaunched after the last code change); webpack dev on 8080 serving
current code. Daily doc may hold probe leftovers — `e2e/formatting.mjs`
cleans up after itself, but double-check.

**Next account's checklist (in order):**

1. **Re-run smoke**: `REMNOTE_CDP_PORT=9223 VIM_E2E_SETTLE=1600 npm run e2e`.
   The one run against the final bundle came back with the FIRST few checks
   reading `null` (`h`/`x`/`0 l` — `readOwn()` got no focused rem), which is
   the §9 cold-boot click-swallow/banner class, not obviously a code bug
   (those checks touch none of the changed positional code, and the same
   steps passed 15/16 on the previous bundle — the single failure there was
   the known `v j .` indent race, which the by-id fix below addresses).
   If nulls recur: bring the window to the compositor foreground, dismiss
   the daily-template banner, retry. Expect **16/16 including `v j .`**.
2. **Run stress**: `REMNOTE_CDP_PORT=9223 VIM_E2E_SETTLE=1600 node
   e2e/stress.mjs` (expect 57/57). NOT run at all this session.
3. **Re-run the formatting probes on the current bundle**:
   `REMNOTE_CDP_PORT=9223 node e2e/formatting.mjs` (new script, expect 5/5).
   It passed 5/5 against the bundle WITHOUT the positionById batch; the
   by-id changes shouldn't affect those paths, but prove it.
4. **Run `node e2e/tree.mjs`** — indentSelection/outdentSelection were
   touched (by-id lookups); tree.mjs is the precision test for that area.
5. **Commit** (single commit is fine; the working tree also carries the
   morning's OSS-prep tweaks — keep or split at your discretion).

User report driving this pass: the cursor sometimes believes it is at the
end of the line while characters remain; general instability on longer/
formatted lines. All root causes were found and fixed; unit-tested, and the
formatting/EOL fixes were live-verified via scripted probes (5/5).

**Root causes (probed live via sdk-repl on RemNote 1.26.30 — all three are
new §9 entries, read those before touching the model):**

1. **The formatting bug — `richText.toString` is NOT offset-safe.** The model
   text came from `richText.toString`, which expands a rem reference to its
   full display name. RemNote's REAL offset space (what `selectText` ranges
   and `getSelection().range` are measured in — probed live) counts text as
   UTF-16 units and every atomic element (reference/image/LaTeX/…) as exactly
   **2 units**: a line `["see ", {i:'q',…}, " end"]` is 10 units, while
   toString gave 23 chars. Every motion/delete right of a reference hit the
   wrong characters, and EOL computations were off by name-length−2.
   **Fix:** new pure `flattenRich()` (`src/adapter/pure.ts`) — text elements
   keep their chars, every atomic element becomes ONE astral placeholder
   (`ATOMIC_CH` U+10FFFC = 2 units, 1 code point), so model length ===
   RemNote's unit space by construction. Also removes an async host RPC from
   the snapshot hot path.
2. **`moveCaret(n, CHARACTER)` moves n caret STOPS, not units** — one stop
   per code point, one per whole atomic element (probed: a single +1 crossed
   a 2-unit reference chip; emoji ditto). Relative caret deltas computed as
   unit differences over-shot on any line with a chip or emoji. **Fix:** all
   relative moves (`setCaret`/`collapseSelection`/`insertAt`/`setCaretAbs`)
   convert unit offsets to stop deltas via `stopsBetween()` (motions.ts).
   The astral placeholder makes code-point counting handle chips and emoji
   uniformly.
3. **The EOL bug — insert-exit read race.** `reconcileAfterInsert()` read
   `getFocusedEditorText()` once, immediately on Escape; the read API lags
   native typing, so fast type-then-Escape installed a TRUNCATED line as the
   model — every later EOL computation landed a few chars short (exactly the
   user's report). **Fix:** `settleRead()` (pure.ts) — re-read until two
   consecutive reads agree, plus an extra longer-spaced confirmation when the
   line looks identical to insert-entry (ambiguous: nothing typed vs. flush
   pending). Also: a null read (focus lost) now invalidates the model instead
   of installing '' (previously poisoned every following key), and snapshot()
   re-syncs after SDK text mutations (`joinRem`/undo/redo/`runEx` mark the
   model **dirty**) also go through settleRead.

**Engine fixes (all pure, all unit-tested):**

- **Code-point safety**: h/l/x/X/s/r/`~`/a/charwise-p and visual boundaries
  step whole code points (new `cpForward`/`cpBack`/`cpStart`/`cpWidthAt`);
  previously `x` on an emoji deleted HALF the surrogate pair (lone-surrogate
  corruption). Visual ranges cover the full code point under the head.
- **Atomic-element semantics**: `x`/`d` across a chip delete it cleanly
  (native cut keeps clipboard fidelity); `r`/`~` REFUSE ranges containing a
  chip (rewriting one as text would corrupt it); text inserted from charwise
  registers strips placeholders (a chip can't be recreated from plain text —
  documented limitation; line registers dd/yy keep full rich fidelity).
- **`F`/`T` off-by-one**: backward find started at c−2, silently missing a
  match immediately left of the cursor (`Fb` on "abc" with caret on c found
  nothing). Now c−1, with the adjacent-match skip only on `,`-repeats.
- **`[count]f/t/F/T` implemented** (`2fx`, `d2fx`) — counts were silently
  ignored on find motions; all-or-nothing like vim. Applies in normal,
  operator and visual contexts, and to `,` reverse-repeat.
- **`r` overflow**: `5rz` with 3 chars left now fails outright (vim), no
  partial replace. `r`/`~` also set `keepLead` — at column 0 they no longer
  swallowed the whitespace after the replaced char (`rx` on "a b" gave "xb",
  now "x b").
- **`positionAmongstSiblings` fully retired from mutation paths** (§9 race,
  had recurred in the smoke suite's paste-then-indent as predicted by the
  night entry): `indent`/`outdent`/`indentSelection`/`outdentSelection`/
  `newBullet`/`pasteRem`/`:t` now locate neighbors BY ID via
  `getChildrenRem().findIndex` (new `positionById` helper; falls back to the
  racy call only when the id lookup is impossible).

**Tests: 153 → 351** (`npm test`, all green, tsc clean). New files:
`tests/motions.test.ts` (78 — direct pure-function coverage of every motion
helper incl. the new code-point math), `tests/engine-edge.test.ts` (91 —
EOL/empty-line matrices, emoji, atomic placeholders, count edges, operator
aborts, dot-repeat interplay, multi-line stability), `tests/adapter-pure.test.ts`
(29 — flattenRich offset-space contract, sanitizeInsert, diffCaret table,
settleRead convergence). Harness mirrors the placeholder-strip in insertText.

**Live verification so far** (see the handoff checklist above for what
remains): scripted probes (`e2e/formatting.mjs`) **5/5** — `ga`+type+Esc on
a reference line appends at the TRUE end; `0wx` deletes exactly the chip;
`fm dw` right of a chip hits the exact chars; `0lx` deletes a whole emoji;
fast-type+instant-Esc+`h x` lands on the right char. Those ran against the
bundle WITHOUT the positionById batch; smoke on the previous bundle was
15/16 (failure = the known `v j .` indent race that motivated that batch).
The offset-space facts themselves (atomics = 2 units, moveCaret = stops)
were probed directly via sdk-repl before any code was written.

**Contract changes for anyone rebasing:** engine text may contain
`ATOMIC_CH` (U+10FFFC, one per atomic rich element — 2 UTF-16 units); the
`insertText` action strips it on execution (adapter + harness); `diffCaret`
moved to `src/adapter/pure.ts` (re-exported from adapter.ts).

### 2026-07-08 — open-source readiness pass (docs/metadata only; no engine changes)

Prepped the repo to be published publicly and submitted to the RemNote Plugin
Store. **No source touched** — engine/adapter untouched, unit 153/153, `tsc`
clean. Added: `LICENSE` (MIT, © onegraund — the project's chosen handle),
`CONTRIBUTING.md`, `.github/workflows/ci.yml` (check-types + unit
tests + prod build; e2e stays local-only), issue/PR templates, and
`e2e/.env.example`. Rewrote `README.md` to be user-first (install, Shift-blind
synonym table, full keybinding + Ex cheat sheet, Known limitations, a Privacy
note stating no data leaves the app — RemNote asks for this disclosure).
Enriched `package.json` metadata (author/description/repository/bugs/keywords;
kept `private:true`). manifest.json already had the required `repoUrl`/author.
**Not done (user's call, needs their hands):** create+push the GitHub repo,
`npm run build`, upload the zip via Settings→Plugins→Build→Upload. Privacy
caveat surfaced to user: the commit author email in `.gitconfig` is a
personal address that would be public on push and partly defeats the
handle-only choice; suggested a GitHub noreply email instead.

### 2026-07-08 night — handoff closed: gj/:g/:marks/:help all live-verified; every suite green; stress c-e wedge fixed

Picked up the evening handoff below; **all five open items are resolved**.
Suite state at end of session: unit **153/153**, `tsc` clean, smoke
**16/16**, stress **57/57** (was 59 — see below), real-input **8/8**
(now proves real Ctrl+A/Ctrl+X delivery, the handoff's open question).
App relaunched on CDP 9223 with the current bundle; daily doc left as a
single empty bullet (suites swept it).

- ☑ **`gj` re-verified on the fixed bundle** — fixture
  `jtest > [one>[kid1], two>[kid2], three, four]`, focus `one`: `gj` →
  `"one two"` (NO self-join — the positionAmongstSiblings race fix holds),
  then `.` (dot-repeat, full-speed replay of exactly the racy path) →
  `"one two three"`. Children adopted in order `[kid1, kid2]`, `four`
  untouched, UI clean (no zombie rows). Data layer + screenshot verified.
- ☑ **`:g/tmp/d` live-verified** typed through the real command line
  (`;g/tmp/d<cr>`): fixture `tmp solo`, `tmp parent>[inner keep,
  tmp covered]`, `survivor`. Both units deleted, the matching parent took
  its whole subtree, the covered child was NOT double-deleted (ancestor
  dedup works), `survivor` intact, toast "2 bullets deleted", OS clipboard
  got both units with the subtree nested (`clip:native`).
- ☑ **`:marks` toast verified** — "Marks: a → gamma | b → zeta" after
  `ma`/`mb` on two bullets.
- ☑ **`:help` sheet eyeballed** (3 screenshots in e2e/shots/help-*.png):
  ga row, full Marks section (`m·`/`'·`/`''`/`:marks`), dib/gj/Ctrl-a/
  Ctrl-x/`.` rows, expanded Command line section (`:s`, `:vs`/`:sp`,
  `:q`/`:only`, `:sort`, `:t`/`:d`/`:y`, `:g/x/d`, `:e`, `:w`), and the
  RemNote-differences footer all render correctly.
- ☑ **FIX (user-reported): stress.mjs pressed `<c-e>`/`<c-y>`**, which the
  plugin deliberately does not steal (engine.ts: no view-scroll API) — the
  presses leaked to RemNote where **Ctrl+E opens the audio-embed widget**
  on the empty scratch bullet and wedged later cases. Steps removed (same
  treatment as the c-o/c-i drop in 81134a8); stress is now **57 steps**.
  §9 gained a bullet.
- ☑ **New harness gotcha found + fixed in all suites**: a freshly launched
  window **swallows synthetic CDP clicks until `page.bringToFront()`** —
  activeElement stays BODY, no rem focuses, keys still reach the steal, so
  everything silently no-ops. run/stress/tree.mjs now call it after
  connect; §9 gained a bullet. (This is why the first gj probe "failed".)
- Flake note: first smoke run after cold boot came in 15/16 — the
  `v j .` indent check hit the known §9 positionAmongstSiblings race
  (alpha reparented, beta missed); clean 16/16 on the next two runs.
  Not a regression; indentSelection may deserve the same by-id fix as
  joinRem if it recurs.
- Remaining optional follow-ups (unchanged from the evening entry):
  `:sort u` semantics, visual-mode dot-repeat, `d'a` delete-to-mark.

### 2026-07-08 evening — HANDOFF: new feature batch (marks, text objects, gj/ga, C-a/C-x, dot-repeat, 6 new Ex verbs)

Read this first. A large feature batch is **committed, 153/153 unit-green,
tsc clean, and MOSTLY live-verified** — the table below says exactly what
remains. The e2e app on CDP 9223 is running a bundle from BEFORE the last
`joinRem` fix (see open item 1); webpack dev on 8080 has the current build.
Daily doc state at handoff: `list` (children `2 two`/`9 nine`/`10 ten`),
`gamma`, `zeta`.

**What shipped** (all documented in the `:help` sheet — vim_help.tsx — and
§0.5; keys chosen to be typeable under shift-blind stealing):

| Feature | Impl | Unit | Live-verified? |
|---|---|---|---|
| Text objects `ib`/`ab` (=`i(`), `i[`/`a[`, `i'`/`a'`, `` i` ``/`` a` `` for d/c/y and charwise visual (`vi[`) | engine `textObjectFor` + motions `pairObject`/`quoteObject` | ✅ | ✅ `di[`, `dib` (first try hit a FIXTURE race, see gotchas) |
| Marks: `m<c>` set, `'<c>` jump (a jumplist entry), `''` auto-mark | actions `setMark`/`gotoMark`; adapter `marks` map; `recordJump` sets `'` | ✅ | ✅ `ma`/`ge`/`'a`/`''` toggle |
| `gj` = vim `J` (join with next sibling; adopts its children; counts) | action `joinRem` | ✅ | ⚠ **works, but see open item 1** |
| `ga` = vim `A` (append at end of line) | g-chord | ✅ | ✅ |
| `C-a`/`C-x` number increment/decrement with counts | motions `numberAt`; emits deleteRange+insertText | ✅ | ✅ via CDP (41→42, `5<C-x>`→37). **Delivery class: CDP-visible** (like C-d, unlike C-o). Real-keyboard delivery NOT yet probed — real-input.mjs has the checks, not yet run |
| Dot-repeat `.` (normal-mode changes only: d/x/r/p/`~`/gj/C-a…; c-family and o are NOT recorded — insert text never reaches the engine) | `keyLog`/`lastChange` in VimState, `recordDotRepeat` wrapper in `handleKey`, action `replayKeys`, adapter `applyKey` extraction | ✅ | ✅ `dw` then `.` |
| `:sort [n] [rev]` — selection siblings, else focused bullet's children | `sortBullets` | n/a | ✅ all three forms + visual selection |
| `:t` / `:co[py]` — duplicate bullets below selection | `duplicateBullets` | n/a | ✅ |
| `:d` / `:y` — delete/yank selection or focused bullet (register + OS clipboard, like dd/yy) | `deleteBullets`/`yankBullets` | n/a | ✅ (`- gamma` and 2-bullet clip:native) |
| `:g/pat/d` — delete every matching bullet in the doc (subtree incl.) | `globalDelete` | n/a | ❌ **not verified** (open item 2) |
| `:marks` — list marks in a toast | `listMarks` | n/a | ❌ not verified |
| Wildmenu catalog + `:help` sheet updated with all of the above (help also gained the previously-missing `:s`/`:vs`/`:sp`/`:q`/`:only` rows) | | | ❌ help rendering not eyeballed |
| keymap: normal mode now steals `'` `[` `]` (marks/objects/f-args) and `ctrl+a`/`ctrl+x` | | ✅ | ✅ (`[` and `'` proven by di[/ma) |

**Next account's job (in priority order):**

1. **Relaunch the app** (`pkill -f 'remote-debugging-por[t]=9223'` +
   `./e2e/launch.sh`; the running bundle predates the fix) and **re-verify
   `gj`**, including `gj` then `.`. Background: the first live `gj` self-joined
   ("alpha alpha") — `positionAmongstSiblings()` raced the data layer right
   after an edit and handed back the focused rem as its own next sibling (the
   same race that bit indentSelection, see 2026-07-07 evening). Fixed by
   finding the sibling **by id in `getChildrenRem()`** (`findIndex` + guard)
   instead of the position re-query; fix is committed but NOT live-verified.
   Dot-repeated `gj .` replays at full speed, so it exercises exactly this race.
2. **Live-verify `:g/pat/d`**: create two `tmp …` bullets in the daily doc,
   `;g/tmp/d<cr>` → both deleted (clipboard gets them via cutRems); also check
   a matching parent takes its whole subtree and covered children are not
   double-deleted (the `units` ancestor-dedup in `globalDelete`).
3. **Eyeball `:marks`** (toast) **and the `:help` sheet** (`;help` — new rows:
   ga, Marks section, dib/gj/C-a/C-x/`.`, expanded Command line section).
4. **Run the suites** against the relaunched bundle:
   `REMNOTE_CDP_PORT=9223 VIM_E2E_SETTLE=1600 npm run e2e` (expect 16/16),
   `… node e2e/stress.mjs` (59/59), and `… node e2e/real-input.mjs` —
   now **8 checks** (added C-a/C-x; needs the window focused in the
   compositor — machine runs niri, check `niri msg windows`, ydotool user
   service must be active).
5. Optional follow-ups noted while building: `:sort u` (unique) was skipped
   deliberately (deletes rems — decide semantics first); visual-mode dot
   repeat not planned; `d'a` (delete to mark) unsupported.

**Harness gotchas (re)confirmed this session — cost real time:**

- **SDK `setText` → immediate click → keystroke = stale local model.** The
  editor read API lags the data layer (§6), so the adapter caches the OLD
  text and motions "fail" (a `dib` looked broken this way — it wasn't). After
  fixture `setText`, press `j k` (or wait ~1 s before clicking) to force a
  model resync before driving keys. Real typing never hits this.
- `positionAmongstSiblings()` right after an edit is unreliable (race above);
  promoted to a §9 bullet since it has now bitten twice.

### 2026-07-08 later — handoff closed: :s / panes / wildmenu all live-verified; pane-focus fix; cmdline shift-blindness mapped

Picked up the handoff below; every open item is resolved. Suites at the end
of this session: unit **119/119**, `tsc` clean, smoke **16/16**, stress
**59/59**, real-input **6/6** (now includes C-o/C-i).

- ☑ **`:s` live-verified end-to-end** (typed through the real command line):
  plain (`;s/alpha/one/` on the focused bullet), `g` (all matches per
  bullet), default first-match-only, `i`/`gi` on a case-mixed fixture, `a`
  (whole doc, proven focus-independent), and a `v j` visual-line selection as
  the implicit range — in-range bullets substituted, out-of-range untouched,
  `'<,'>` marker shown in the badge. Replacement `$`-expansion (`$$`→literal,
  `$&`, `$1`) and vim `\1..\9` backrefs verified against real rich text via
  direct `substitute()` calls from sdk-repl — they are **untypeable from the
  keyboard** (see the new §9 entry), so keystroke tests can't reach them.
- ☑ **Pane Ex commands live-verified**: `;vs` (side-by-side duplicate), `;sp`
  (stacked), `;vs gamma` (search + open beside), `;q` (close focused), `;only`.
  Layout + docs asserted via `getOpenPaneIds`/`getOpenPaneRemId`, screenshots
  eyeballed.
- ☑ **BUG FOUND+FIXED while verifying panes: every `setRemWindowTree` call
  regenerates all pane ids and drops the pane focus entirely** — after any
  `:vs/:sp/:q/:only` the caret was dead until a real click. New `setPaneTree()`
  wrapper re-fetches the ids after the rebuild and `setFocusedPaneId`s the
  right leaf: the NEW pane for splits (vim focuses the new window), the
  survivor at the closed index for `:q`, the kept pane for `:only`. Verified
  live: `;vs gamma` lands focus in the gamma pane, then `;q` typed with NO
  intervening click closes it and restores the caret to the exact pre-split
  rem (alpha). Also confirms `getOpenPaneIds()` order matches the leaf order.
- ☑ **Wildmenu live-verified**: catalog renders stacked above the badge;
  verb filtering (`;s` → `:s/`+`:sp`); Tab cycles with the `▸` marker, applies
  `complete` (trailing space for rem-arg verbs), wraps; `;e gam` runs the live
  doc search; Tab+Enter opens the hit with the caret ON the target bullet.
  Stale-async guard proven live by bursting `handleSym` calls (`;e gam` then
  immediate rewrite to `q` before the search resolved — no clobber).
- ☑ **Wildmenu fix: suggestions dedupe** by completed line (same-named rems
  and search residue rendered as five identical `gamma` rows — useless).
- ☑ **Badge fix: `clearVTrail` now clears `dbgV`** — after leaving
  visual-line the badge kept showing `trail:N units:N tint:N`, which reads as
  a live selection and cost this session a phantom-bug detour.
- ☑ **stress.mjs C-o/C-i decision**: they were already dropped in 81134a8
  (no such presses exist in the file). `real-input.mjs` instead gained real
  `Ctrl+O`/`Ctrl+I` delivery checks (the only suite that can see them) — 6/6.
- **New platform findings** (all in §9): the command line is shift-blind like
  every other stolen key, so `:s` patterns can only use the unshifted regex
  subset; SDK `rem.remove()` of currently-rendered rems leaves zombie rows the
  UI still shows (clicks focus detached rems — e2e hazard, refresh via an
  `openRem` round-trip).

### 2026-07-08 — HANDOFF to next account: command-line rework shipped (needs live verify) + bughunt results

Read this first. A batch of command-line/Ex work is **committed and
unit-green (119/119, tsc clean)** but several pieces are **NOT yet
live-verified** — that's the main open work. Plus a live bughunt cleared the
user's reported issues (most already fixed; the one "bug" that remained is a
test-harness artifact, not a real defect). Live e2e RemNote is running on CDP
9223 with three clean scratch bullets (`alpha`/`beta`/`gamma`) in the daily
doc; `ydotool` daemon is up (`systemctl --user start ydotool`).

**Commit `81134a8`** — "Pane nav via C-h/C-l; release '/'; drop todo verbs;
add :s/:vsplit/:split/:q/:only; wildmenu". What it contains and its
verification state:

| Feature | Code | Unit | Live-verified? |
|---|---|---|---|
| `/` released → RemNote's own slash menu opens; `;` is the only vim cmdline key | ✅ | ✅ | ✅ (slash menu screenshot) |
| `:todo`/`:done`/`:untodo` removed (slash menu covers them) | ✅ | ✅ | n/a (removal) |
| `Ctrl-H`/`Ctrl-L` pane nav (C-w kept for other hosts) | ✅ | ✅ | ✅ (real ydotool click + split) |
| Escape from charwise visual COLLAPSES the native selection (`collapseSelection` action) | ✅ | ✅ | ✅ (this session) |
| visual `e` advances past current word end | ✅ | ✅ | ✅ (earlier session) |
| **`:s/pat/repl/[gia]`** substitute over rich text | ✅ | ⚠ engine-only | ❌ **needs live verify** |
| **`:vsplit`/`:split`/`:q`/`:only`** via `window.setRemWindowTree` host RPC | ✅ | n/a | ❌ **needs live verify** (RPC shape probed live, Ex verbs not driven end-to-end) |
| **Wildmenu** (Tab-cycled suggestions; `:e`/`:vs`/`:sp` live doc search) | ✅ | ⚠ `/`-typeable only | ❌ **needs live verify** |

**Next account's job (in priority order):**

1. **Live-verify `:s`** — `;s/alpha/ALPHA/<cr>` on a focused bullet; then
   flags: `g` (all matches in a bullet), `i` (case), `a` (whole document,
   vim's untypeable `%`), and a visual-line selection as the implicit range
   (`v j` then `;s/e/E/g`). The `'<,'>` marker should show in the badge while
   a selection is live. Impl: `substitute()` in `adapter.ts`; only PLAIN
   string rich-text segments are touched (references left intact). Watch for
   `$`-expansion bugs in the replacement (manual `$1`/`$&` handling, NUL
   sentinel for `$$`).
2. **Live-verify panes** — `;vs<cr>` (duplicate focused pane side by side),
   `;sp<cr>` (stacked), `;vs some-doc<cr>` (search + open beside), `;q<cr>`
   (close focused pane), `;only<cr>`. Impl: `splitPane`/`closePane`/`onlyPane`
   in `adapter.ts` build a react-mosaic tree and call `winCall`. Caveat
   documented in code: no layout GETTER exists, so a hand-arranged 3+ pane
   layout is rebuilt flat.
3. **Live-verify the wildmenu** — type `;` then `e ` and a partial doc name;
   suggestions render stacked above the mode badge (they're CSS `content` on
   `body::after`, `\A`-separated, `white-space:pre`); Tab cycles/applies them.
   `EX_COMMANDS` is the static verb catalog; arg-position search is async with
   a seq-guard. Verify stale async results don't clobber a newer keystroke.
4. Decide whether `stress.mjs` should drop its `c-o`/`c-i` presses (they are
   CDP no-ops — see finding below) or gain a real-input variant.

**Bughunt results (live, this session — against the user's VIM-doc report):**

- ✅ **Multiline visual-line yank → OS clipboard WORKS** (user said it didn't).
  `v j y` put `- alpha\n- beta` on the real clipboard (read via `wl-paste` —
  Wayland session; XWayland app clipboard bridges through). Was fixed by the
  evening `nativeClipboardRems` work; now confirmed. Single-line `yy` → `- alpha`.
- ✅ **Escape from visual no longer strands the selection** (user's complaint).
  After `0 v l l <esc>` the native selection is collapsed and mode is normal.
- ✅ **`v gg` / `v ge`** select the whole doc line-wise (trail:3/units:3) — user
  said these "didn't work"; they do now (was likely the stale-build era).
- ✅ **`Ctrl-O` / `Ctrl-I` jumplist WORKS with real input.** This looked like a
  bug under CDP (rx never incremented, focus never moved) but that is a
  **CDP delivery limitation, not a defect**: with real ydotool keys, `gg`→`ge`
  then physical Ctrl+O returned focus alpha←gamma and Ctrl+I went forward
  again (badge `k=ctrl+o`/`k=ctrl+i`, rx incremented). The jumplist logic in
  `adapter.ts` (`case 'jump'`, `recordJump`) is fine. If the USER still sees it
  fail, suspect an OS/Electron binding on Ctrl+O (common "open file"
  accelerator) in *their* environment — worth asking.
- `$` end-of-line stays unreachable by construction (shift-blind; use `gl`) —
  known, documented in §9/§0.5, not re-litigated.

**e2e harness gotchas discovered (cost real time — heed these):**

- **The daily-template banner** ("Set Up Template / Not Now") shifts bullet
  positions as it renders/dismisses, so precomputed click coords go stale and
  the click lands on empty space → focus never attaches (looks like clicks are
  "broken"). Dismiss the banner first, then click via a **locator** that
  resolves position at click-time, not a cached rect.
- **`selectRem` probing leaves the editor stuck** in `.in-selected-portal`
  with hit-testing falling through to `<html>` (even after pointer-events is
  forced to `auto`). Once in this state CDP clicks are dead; the reliable
  reset is a full app relaunch (`pkill` the 9223 process + `./e2e/launch.sh`).
- **Ctrl-chord delivery splits three ways** (all verified this session):
  `C-d`/`C-u`/`C-r` reach the steal via CDP; `C-o`/`C-i` do NOT via CDP but DO
  via real hardware; `C-w` reaches neither (Electron eats it even from a real
  keyboard). ⇒ `run.mjs`/`stress.mjs` cannot cover `C-o`/`C-i`/`C-w`; use
  `e2e/real-input.mjs` (ydotool) for those.

### 2026-07-07 late night — Ctrl-W was dead at real keyboards; C-h/C-l pane nav + real-input e2e

User report: Ctrl-W → h/l did nothing in real usage although the e2e passed.
**Root cause: Electron consumes a real Ctrl+W in the main process — the
renderer (and thus RemNote's key steal) never sees the keydown.** Proved with
kernel-level uinput (ydotool through the compositor, identical to a physical
keyboard): a real `h` arrives (badge rx increments), a real Ctrl+W does not;
a page-level capture listener logged real C-h/C-l/C-j/C-k/C-o/C-i all
arriving — only C-w is eaten. The CDP suites synthesize input inside the
renderer, bypassing Electron, which is why they lied. §9 has the new blocker
entry.

Fix + hardening:

- **`Ctrl-H` / `Ctrl-L` = focus previous/next pane** (the classic vim
  `<C-h>`/`<C-w>h` remap). Stolen + handled in normal mode; `C-w` chord kept
  for hosts that deliver it (web?). Help sheet now lists Ctrl-h/Ctrl-l only.
- **New `e2e/real-input.mjs`** (§7): ydotool-based key-DELIVERY test — real
  `h`, real C-h/C-l must reach the steal; documents the C-w hole (warns if a
  platform change ever makes it arrive). Requires the window focused +
  `systemctl --user start ydotool` (user has a udev ACL on /dev/uinput).
- Harness `focusPane` now records `paneMoves` so pane bindings are
  unit-assertable; tests for `C-w h/l/w` and direct `C-h`/`C-l`. 118/118.
- **Verified end-to-end with real input**: with a real split open, physical
  Ctrl+H switched `getFocusedPaneId()` to the left pane, Ctrl+L back —
  through the full kernel → compositor → Electron → steal path.

Env note: the machine runs **niri**, not Hyprland (CLAUDE.md is stale on
this); the e2e RemNote is an XWayland window. Real input via `ydotool`
(uinput) works regardless of compositor.

NEXT (user-directed, in order): bug-hunt current functionality live; release
`/` (RemNote's slash menu must open; `;` is the only command-line key) and
drop `:todo`/`:done`/`:untodo`; add `:vsplit`/`:s`-style Ex commands
(pane-open path still unknown — SDK has none; shift+click is the only known
trigger); command-line suggestions (wildmenu) incl. `:e` document completion.

### 2026-07-07 night — handoff batch closed: all ☐ probes verified, visual-`e` fix

Picked up the evening handoff below; every open item is now resolved.

- ☑ **indentSelection rewrite live-verified** — fresh app restart to load the
  bundle, then smoke suite **16/16 twice** (the previously-racy
  "v j . indent" step passed both times) and stress **59/59**.
- ☑ **`o` on a ToDo creates a sibling** — probed live via sdk-repl: built a
  todo with `:todo`, pressed `o`; both rems report the same `getParentRem()`
  (the daily doc), new bullet is NOT a child of the todo.
- ☑ **`:todo` on a multi-bullet visual selection** — `vv j j` over three
  bullets + `;todo` ⏎ set todo status on exactly the three selected rems
  (checked via `isTodo()` on all daily-doc children; unrelated rows
  untouched). Command exit cleared the trail, mode returned to normal.
- ☑ **Ctrl-W with a real split pane** — opened a second pane live, then
  `C-w h` / `C-w l` / `C-w w` each switched `getFocusedPaneId()` correctly
  (h→left, l→right, w→cycle). *E2e recipe:* the SDK cannot open a split
  (`window.openRem` takes no pane arg); **Shift+click on a rem-reference
  link** opens it in a new pane (Ctrl+click and Alt+click do nothing). Close
  it via the pane-header icon button (hover top of the pane).
- ☑ **Charwise visual rendering** — eyeballed via screenshot: the native
  text selection tracks the vim selection exactly (`0 v l l l` highlights
  "task"), plus cursorline tint + left bar. Side effect noted: RemNote's
  floating **formatting toolbar pops up over any native selection** — vim
  charwise-visual triggers it. Harmless (keys still work) but visually noisy;
  candidate for a mode-scoped CSS hide if it annoys.
- ☑ **BUG FOUND+FIXED while probing: visual-mode `e` could never advance
  past the current word end.** `state.head` is an ON-char index, but
  `wordEnd` measures from an I-beam caret: from head on a word's last char
  it returns head+1, and the `landsOn` −1 adjustment lands right back on
  head — `v e e e …` stayed stuck forever (live-reproduced: selection never
  grew past "task"). Fix in `handleVisual` (engine.ts): when a `landsOn`
  motion makes no progress, rerun it from head+1 (vim's block-cursor "must
  land later" rule — applies only in visual; normal-mode I-beam `e` already
  guarantees progress). New regression test (`v e` then `e` on
  "one two three"); 116/116 unit, fix verified live (`v e` → "task",
  second `e` → "task one").
- ☑ **copyText/writeClipboard decision (was the last ☐): KEEP the sandbox
  tiers, comments fixed.** They're proven dead only on the *desktop* app;
  the try is free, other hosts (web) may grant clipboard-write, and the
  `clip:api`/`clip:exec` badges are exactly how we'd notice. The comments
  now say the select+cut+reinsert fallback is the real live path instead of
  calling the direct write "preferred". §0.5 wording was already aligned.

No engine/adapter contract changes beyond the `handleVisual` fix; harness
untouched.

### 2026-07-07 evening — HANDOFF: live e2e verified, native rem-clipboard landed

Read this first — it supersedes the "BLOCKED" status of the entry below.
Session ended mid-verification (account switch); here is the exact state.

**Live environment (was running at handoff, easy to recreate):**

- e2e RemNote on CDP **9223** via `./e2e/launch.sh` (run in background; app up
  in ~30 s). Login **persists** in the scratch HOME (`/tmp/remnote-vim-e2e-home`,
  `e2e/.env` account, knowledge base "VIM") — it boots straight into the
  Daily Document. Webpack dev server on 8080 (`npm run dev`) serves the
  plugin; RemNote side is already configured to develop-from-localhost.
- **The plugin iframe does NOT pick up rebuilds**: webpack rebuilds, but the
  widget keeps running old code (no live-reload handshake), and CDP
  `Page.reload` on the iframe target reloads it *without* re-activating the
  plugin. **Reloading the MAIN window kills the whole app** (RemNote treats
  main-frame reload as exit — verified twice). The only reliable way to load
  a new bundle: `pkill -f 'remote-debugging-port=9223'; ./e2e/launch.sh`.
- Suite invocations that pass:
  `REMNOTE_CDP_PORT=9223 VIM_E2E_SETTLE=1600 npm run e2e` and
  `REMNOTE_CDP_PORT=9223 VIM_E2E_SETTLE=1600 node e2e/stress.mjs`.
  The raised `VIM_E2E_SETTLE` matters: with the default 900 ms the *first*
  insert after plugin activation still races the key-release and drops the
  first typed char (reproduced: 12/16; with 1600 ms: 16/16).

**⚠ ONE ITEM IN FLIGHT — finish this first:** `indentSelection` in
`src/adapter/adapter.ts` was rewritten this session (derive the indent
destination once per same-parent run instead of re-querying
`positionAmongstSiblings` between `setParent` calls — the re-query races
RemNote's data layer and can return the unit itself as its own "previous
sibling", silently skipping it; reproduced twice as `run.mjs` "v j . indent"
failing on the *pasted-then-indented* beta bullet while stress phase 4
passes). The rewrite is `tsc`-clean and 115/115 on unit tests but **has NOT
been live-verified**. Next action: restart the e2e app (see above) so the
plugin loads the current bundle, then run the smoke suite twice — expect
16/16 both times. If beta still ends up at doc level, instrument
`indentSelection` via `e2e/sdk-repl.mjs` (below).

**Landed this session — whole-rem ops now hit the OS clipboard natively:**

`dd`, `yy`, visual-line `d`/`y` previously wrote the clipboard via
`writeClipboard()` from the sandbox — which **can never work** (see
discoveries). They now go through `nativeClipboardRems()` (adapter):
`editor.selectRem(ids)` → `editor.copy()` → pane-refocus caret recovery,
with `cutRems()` = that + the proven `removeRems()` loop for the delete
family. All verified live: `yy` → `- line` on the OS clipboard
(`clip:native` badge), `v j y` → both bullets, `dd`+`p` round-trip intact,
and typing works immediately after a yank (caret survives). Unit tests
needed no changes (harness semantics already said "clipboard gets the
text" — now it's actually true live).

**Discoveries this session (all probed live on RemNote 1.26.30, §9 updated):**

1. **Sandbox clipboard writes are dead, always**: in the plugin iframe
   `navigator.clipboard.writeText` rejects (`Document is not focused`), the
   `clipboard-write` permission is hard-**denied**, and `execCommand('copy')`
   returns false (no transient user activation ever reaches the iframe —
   stolen keys arrive via async postMessage). `writeClipboard()`'s first two
   tiers are dead weight live; only host-side native paths work. The
   charwise `copyText` action still tries `writeClipboard` first — harmless
   (its select+cut+reinsert fallback does the real work) but a candidate for
   simplification.
2. **`editor.copy()` on a Rem selection works** and writes RemNote's own
   serialization (text/plain `- bullet` lines + rich text/html) — this is
   the only multi-rem clipboard path available to the sandbox.
3. **`editor.cut()` on a Rem selection writes EMPTY html** to the clipboard
   (it serializes *after* removal, apparently). Never use it for rem cuts;
   copy-then-remove instead. (Text-range `cut()` via `selectText` is fine —
   the charwise paths keep using it.)
4. **The `selectRem` "one-way door" has an escape hatch**:
   `window.getFocusedPaneId()` before + `window.setFocusedPaneId(paneId)`
   after clears the Rem selection and restores the text caret to its exact
   pre-selection rem AND column (probed with a marker insert). Everything
   else fails: `collapseSelection`, `moveCaret(Vertical)`, `selectText`,
   `selectRem([])`, `insertPlainText` over the selection, even a real
   Escape (we steal it) — only pane refocus (or a real ArrowDown/click, which
   the plugin can't synthesize) recovers. §9 rewritten accordingly.
5. **RemNote can boot with `pointer-events-none` stuck on
   `.rn-editor-container`** (its suppress-mouse-while-typing state; a real
   pointer never entering the window leaves it set). Symptom: every CDP
   `mouse.click` falls through to `<html>`, `elementFromPoint` returns the
   root, clicks focus nothing — looks exactly like a zoom/coordinate bug
   (it isn't; dpr=1). Both suites now strip the class once at startup;
   `sdk-repl.mjs`/manual sessions may need
   `document.querySelector('.rn-editor-container').classList.remove('pointer-events-none')`.

**New tool — `e2e/sdk-repl.mjs`**: run arbitrary async JS *inside the
sandboxed plugin iframe* with `a` = the live `VimAdapter` and `p` = the
`RNPlugin` (SDK): `node e2e/sdk-repl.mjs 'return await
p.focus.getFocusedRem()'`. Works because the adapter now exposes
`globalThis.__vimAdapter` (constructor; sandbox-scope only). This is how all
of the above was probed — vastly faster than rebuild-and-keypress loops.
Documented in §7.

**Files touched this session** (committed together with this log):
`src/adapter/adapter.ts` (nativeClipboardRems, cutRems, deleteRem/yankRem/
deleteRemSelection/yankRemSelection rewires, yankRemSelection now
invalidates the model, `__vimAdapter` hook, indentSelection rewrite),
`e2e/run.mjs` + `e2e/stress.mjs` (pointer-events strip; stress phase 5
updated to the new v-cycle: `vv`/`vvd` where it meant visual-line),
`e2e/launch.sh` (extracted-AppRun path + APPDIR export, deep-link warning),
`e2e/sdk-repl.mjs` (new).

**Still ☐ after the indent verification** (from the batch below):

- ☐ `o` on a ToDo bullet — verify live it creates a *sibling* (build one
  with `:todo`, press `o`, check `getParentRem()` via sdk-repl).
- ☐ `:todo` on a multi-bullet visual selection — verify live.
- ☐ `Ctrl-W h/l` with a real split pane — verify live.
- ☐ Charwise visual (`v` + `h/l/e` …) selection rendering — eyeball via
  screenshot that the native text selection tracks.
- ☐ Consider simplifying `copyText`/`writeClipboard` given discovery #1
  (drop the dead tiers, or keep as defensive fallback — decide, then align
  the §0.5 wording).

### 2026-07-07 — user-reported bug batch (in progress, Claude)

**Context discovered first:** `dist/` was built 2026-07-06 20:16 but
`src/engine`+`src/adapter` were edited 2026-07-07 ~14:00 — the running plugin
was an OLD build missing today's engine (v-cycle flip, sibling-only `o`,
subtree registers, clipboard). Several user reports were symptoms of the
stale build. Also: the repo had an empty `.git`; a baseline commit of the
pre-fix state is now in history (`main`).

Plan (☑ done / ☐ pending), driven by the user's report:

- ☑ git init + baseline commit; `.gitignore` for node_modules/dist/zip
- ☑ **Ctrl-W h/l panes** — root cause: `ctrl+w` was never in `keymap.ts`, so
  the engine's pane code was unreachable. Added.
- ☑ **v = charwise first** — engine already flipped (v → charwise, `vv` →
  line, `vvv` → normal; j/k still auto-upgrade charwise→line). Unit tests
  updated to the new cycle (they still asserted the old one and failed).
- ☑ **`de` on "a asdf" deleting too much** — `wordEnd` used vim's
  block-cursor rule (`e` must advance ≥2); switched to I-beam rule
  (`e > c`) matching this plugin's between-chars caret model.
- ☑ **`d$`** — already existed as `dgl`/`dgh` g-chords; now unit-tested and
  documented ( `$` itself is unreachable: shift-blind stealing reports `4`).
- ☑ **`;` find-repeat removed** — `;` now always opens the command line;
  `,` keeps reverse-repeat. `/` also opens the command line.
- ☑ **Ctrl-E/Ctrl-Y unbound** — no view-scroll API exists (only caret moves),
  so per user's call the keys are no longer stolen.
- ☑ **Ctrl-O/Ctrl-I jumplist** — new `jump` action; adapter records rem ids
  before jumps (`gg`/`ge`/`:e`) with vim's truncate-forward semantics;
  in-doc return walks the caret (stays alive), cross-doc falls back to
  `window.openRem`.
- ☑ **Yank → system clipboard** — layered: charwise deletes now go through
  native `editor.cut()` (host-side clipboard, sandbox-proof); charwise `y`
  emits new `copyText` action (async clipboard API → execCommand →
  select+cut+reinsert fallback); line register still flattens to
  tab-indented text via `writeClipboard`. Badge shows `clip:` status.
  **Update (evening entry above): verified live — the sandbox tiers can
  never fire; whole-rem ops now use `nativeClipboardRems` instead.**
- ☑ **Normal-mode cursor visibility** — cursorline: `[data-rem-id]
  :focus-within` row tint + colored left bar via registerCSS.
- ☑ **Visual-mode `/` command palette** — `;`/`/`/`:` from visual/visual-line
  enter command mode KEEPING the selection trail (tint stays via render());
  new Ex verbs `:todo`, `:done`, `:untodo` apply to all selected bullets
  (else focused bullet). Command-mode exit always clears the trail.
- ☐ **`o` on ToDo creating a child** — believed fixed by rebuild (old build
  had "child-aware o"; current `newBullet` is sibling-only). Verify live
  against a todo bullet.
- ☑ tests updated + extended (jumplist, clipboard, visual command line,
  charwise g-chords, I-beam `e`): 115/115 green; `tsc` clean
- ☑ live e2e pass — **UNBLOCKED, see the evening entry above**: environment
  works (launch.sh + e2e/.env login persisted), smoke suite 16/16 with
  `VIM_E2E_SETTLE=1600` (then 15/16 ×2 on an indent data race — fix in
  flight, see above), stress 59/59, clipboard tiers verified live. Remaining
  manual probes are re-listed in the evening entry's ☐ section.
- ☑ docs: VIM_STATUS.md was deleted from the working tree mid-session (not
  by Claude — swept into commit daaa04e by `git add -A`; full text
  recoverable from commit 122d18e). Its live content now lives here: feature
  status → §0.5, blockers → §9. `:help` widget (vim_help.tsx) updated with
  the new keys; README links fixed.
- ☑ **Companion-service design notes** — design-only exploration of a
  background companion service (CDP-based) to lift sandbox limits
  (shift-blindness, caret reads, true scrolling, clipboard). Explicitly NOT
  implemented; verdict: park it, file upstream issues first. Written up in
  **[Appendix A](#appendix-a-companion-service-design-notes-design-only-not-implemented)**
  (originally the standalone `SERVICE_NOTES.md`, folded in 2026-07-08).

Engine/adapter contract changes in this batch (for anyone rebasing):

- `Action.deleteRange` gained `yank?: boolean` (route through native cut →
  OS clipboard) and `keepLead?: boolean` (change-family deletes skip the
  column-0 whitespace swallow AND the model's normalizeModel trim; `cw` must
  leave "hello world" as "bye world", not "byeworld").
- New actions: `copyText {text,start?,end?}`, `jump {dir}`.
- `handleCommand` leave-path now always emits `clearRemSelection`.
- Harness mirrors all of the above + `clipboard`/`jumps` fields for tests.

## 0.5 Feature status (what works live)

Formerly VIM_STATUS.md; trimmed to what a contributor needs. Engine suite:
**351/351** unit tests green (run `npm test` — don't trust this number, verify).

Working live in the real app (RemNote 1.26.30, SDK 0.0.46):

- **Modes** — `i` insert / `Esc` normal / `v` charwise visual / `vv`
  visual-line (`v`+`j/k` auto-upgrades) / `;` `/` `:` command line; mode badge
  bottom-right; per-mode key stealing (insert releases everything but Esc).
- **Motions** — `h l 0 w b e f<c> t<c>` `,`(reverse find repeat), counts
  (incl. `[count]f/t`, e.g. `2fx`, `d2fx`); code-point safe (emoji and
  atomic elements are one character to every motion/edit);
  g-chords for shift-blind capitals: `gl`=`$` `gh`=`^` `gg` `ge`=`G`
  `ga`=`A` (append at line end).
  `e` uses I-beam semantics (any forward progress counts), so `de` on
  `a asdf` deletes just `a`.
- **Operators** — `d c y` + motions/text objects (`dw de db dd df<c> dt<c>
  diw daw`), `dgl`=`d$`, `dgh`=`d^`, `x X s S D C`, `r<c>`, backtick=`~`.
- **Text objects** — `iw aw`, pairs `ib ab`(=`i(`/`a(`) `i[ a[`, quotes
  `i' a'` `` i` a` `` — under d/c/y and in charwise visual (`vi[`). `i{`/`i"`
  exist in the engine but are untypeable live (shifted keys).
- **Marks** — `m<c>` remembers the bullet, `'<c>` jumps back (a jumplist
  entry; `''` returns to the pre-jump spot); `:marks` lists them.
- **`gj`** = vim `J`: join the next sibling bullet (space-separated, its
  children adopted; counts: `3gj`).
- **`C-a`/`C-x`** — increment/decrement the number under/after the cursor,
  with counts (CDP- and real-keyboard-verified, real-input.mjs 2026-07-08).
- **Dot-repeat `.`** — repeats the last completed normal-mode change (`dw`,
  `3x`, `r<c>`, `p`, `gj`, `C-a`…). Changes that enter insert mode (`cw`,
  `o`) are NOT recorded — inserted text never reaches the engine.
- **Charwise visual** — `v` + `h/l/w/b/e/f/gl/gh` to shape; `d x c s y p o`;
  `gg/ge/G` escalate to line-wise to the doc boundary.
- **Visual-line (multi-bullet)** — extend with `j/k`/counts/`gg/ge`; `d`/`x`
  cut, `y` yank, `p` paste, `.`/`,` indent/outdent; `;` or `/` opens the
  command line over the selection; registers carry whole subtrees; caret
  walks to a survivor before any deletion.
- **System clipboard** — charwise deletes route through native text-range
  `editor.cut()`; charwise yanks through `copyText` (live path is the
  select+cut+reinsert fallback — direct sandbox writes are permission-denied,
  see §9); whole-rem ops (`dd`/`yy`/visual-line `d`/`y`) through
  `nativeClipboardRems` (`selectRem` + `editor.copy()` + pane-refocus caret
  recovery) — clipboard gets RemNote's own `- bullet` serialization. Badge
  `clip:` field shows which path fired (`clip:native`/`clip:api`/
  `clip:exec`/`clip:FAIL`).
- **Jumplist** — `Ctrl-O`/`Ctrl-I` over `gg`/`ge`/`:e` jumps (vim
  truncate-forward semantics).
- **Panes** — `Ctrl-H`/`Ctrl-L` focus previous/next pane (the vim-classic
  `C-w h`/`C-w l` chord is also bound but a real Ctrl+W never reaches the
  desktop app — Electron eats it; see §9).
- **Scrolling** — `Ctrl-D`/`Ctrl-U` (caret page-moves; view follows).
  `Ctrl-E`/`Ctrl-Y` deliberately unbound — no view-scroll API exists.
- **Command line** — opened with `;` only (`/` now belongs to RemNote's own
  slash-command menu; `:todo`/`:done`/`:untodo` were removed). `:help` cheat
  sheet; `:e <name>` search+open (a jump); `:w` acknowledged (autosave);
  `:s/pat/repl/[gia]` substitute (visual selection or focused bullet as
  range, `a` = whole doc — but note the shift-blind typeable-regex subset,
  §9); `:vsplit`/`:split`/`:q`/`:only` pane management (undocumented
  `window.setRemWindowTree` RPC; focus follows vim semantics — new pane on
  split, survivor on `:q`); Tab-cycled **wildmenu** of command suggestions
  with live (deduped) `:e`/`:vs`/`:sp` document search; `:sort [n] [rev]`
  (selection siblings or focused bullet's children), `:t`/`:co[py]`
  duplicate, `:d`/`:y` delete/yank bullets (register + OS clipboard like
  dd/yy), `:g/pat/d` global delete, `:marks`. All live-verified 2026-07-08.
- **New bullets** — `o`/`go`(=`O`) always create a *sibling* (never a child).
- **Cursor visibility** — cursorline row tint + colored left caret bar
  outside insert mode.
- **Undo/redo** — `u`/`Ctrl-R` delegate to RemNote's history.

Known limitations (beyond §9 platform blockers):

- Caret column desyncs after an intra-line mouse click (collapsed caret is
  unreadable in the sandbox); re-anchor with `0`/`gl` or enter+leave insert.
- Charwise registers drop atomic elements: `x`/`dw` across a reference/
  image/LaTeX chip deletes it correctly (and the native clipboard keeps full
  fidelity), but `p` pastes the text minus the chip — a chip can't be
  recreated from plain text. Whole-line registers (`dd`/`yy`/visual-line)
  keep full rich fidelity. `r`/`~` refuse ranges containing a chip.
- Charwise visual uses a real native text selection, so RemNote's floating
  formatting toolbar pops up over it (harmless; keys keep working).
- Capitals act as their lowercase key (shift-blind stealing); use synonyms.
- `j`/`k` move between Rems — a bullet is one line by construction.

## 1. Mental model

The whole plugin is built around one idea: **keep the part that has to be
correct (vim semantics) completely separate from the part that has to talk to
RemNote (which is slow, async, and full of platform quirks).**

```
keystroke → adapter (RemNote-facing) → engine (pure) → Action[] → adapter executes them
            src/adapter/adapter.ts     src/engine/       against RemNote's plugin API
```

- **`src/engine/`** is a synchronous, pure function: `(VimState, key, {text,
  caret}) → (VimState, Action[])`. It has never heard of RemNote. It doesn't
  know what a "Rem" is, doesn't await anything, doesn't touch the DOM. This is
  what makes it exhaustively unit-testable and safe to reason about in
  isolation — `tests/engine.test.ts` drives it directly.
- **`src/adapter/adapter.ts`** (`VimAdapter`) is the only thing that touches
  the RemNote plugin SDK. It receives raw stolen keys, translates them to
  engine symbols, feeds them to `handleKey`, and executes the returned
  `Action`s one at a time against the RemNote API (`editor.moveCaret`,
  `rem.createRem`, etc). It also owns a **local model** of the focused line's
  text/caret, because RemNote's own read APIs lag a keystroke behind
  programmatic edits (see §6).
- **`src/widgets/`** is the RemNote plugin entry point (`index.tsx`,
  `onActivate`) plus the `:help` floating-widget UI (`vim_help.tsx`).

If you're adding a new vim *behavior* (a motion, an operator, a new mode
transition), it almost always belongs in `src/engine/`, tested with the
`Harness` fake editor, with zero RemNote involvement. If you're adding a new
way to talk to RemNote (a new `Action` case, a new SDK call), that's
`src/adapter/adapter.ts`. Keep that boundary — it's the whole reason this
codebase is testable.

## 2. Repository map

| Path | What it is |
|---|---|
| `src/engine/types.ts` | `VimState`, `Action` (the full vocabulary of things the adapter can be asked to do), `Mode`, `Pending`, `Register` |
| `src/engine/engine.ts` | `handleKey()` — the state machine. One `handleX` function per mode (`handleNormal`, `handleInsert`, `handleVisual`, `handleVisualLine`, `handleCommand`) |
| `src/engine/motions.ts` | Pure text math: `nextWordStart`, `wordEnd`, `findChar`, `wordObject`, etc. No engine state, just `(string, offset) → offset` |
| `src/adapter/adapter.ts` | `VimAdapter` — key stealing, the local line model, `exec()` (Action → SDK calls), visual-line selection trail, Ex commands, the debug/mode badge |
| `src/adapter/keymap.ts` | Which key specs to steal from RemNote per mode, and the spec→engine-symbol table (`SPEC_TO_SYM`) |
| `src/adapter/domCaret.ts` | Direct DOM caret read/write — only reachable when `requestNative: true` actually works (currently doesn't, see §9) |
| `src/widgets/index.tsx` | Plugin `onActivate`: registers commands/settings, constructs `VimAdapter`, exposes `window.__vim` for e2e |
| `src/widgets/vim_help.tsx` | The `:help` cheat-sheet floating widget |
| `tests/harness.ts` | `Harness` — a fake multi-line/multi-indent "editor" that executes `Action`s the same way the real adapter does, for unit tests |
| `tests/engine.test.ts` | Vitest suite driving `Harness` with key sequences |
| `e2e/run.mjs` | Live smoke test over CDP against a real running RemNote — narrative style, asserts on Rem text |
| `e2e/stress.mjs` | Live stress test — long key sequences with a **focus-alive invariant checked after every keystroke** |
| `e2e/tree.mjs` | Live precision test for nested-hierarchy visual-line selection (tint + data + focus, screenshots archived) |
| `e2e/ctl.mjs` | Manual CDP remote for poking at a running instance (`shot`, `eval`, `click`, `type`, `key`) |
| `e2e/launch.sh` | Launches an isolated RemNote AppImage instance (scratch `$HOME`, its own CDP port) for e2e |
| `public/manifest.json` | RemNote plugin manifest (id, permissions, `requestNative`) |
| `webpack.config.js` | Builds every `src/widgets/**/*.tsx` twice (module + sandboxed-iframe variant); see comments for why |

## 3. Running the plugin locally

```bash
npm install
npm run dev          # webpack-dev-server on http://localhost:8080, no HMR (see below)
```

In the RemNote desktop app: **Settings → Plugins → Build → Develop from
localhost**, enter `http://localhost:8080/`, click **Develop**. Confirm the
"Vim Mode" toggle is on in plugin settings. A `-- NORMAL --` badge should
appear bottom-right — that's your signal the plugin loaded and is active.

There is **no hot reload** (`hot`/`liveReload` are explicitly off in
`webpack.config.js` — RemNote's sandboxed-iframe loading doesn't play well
with webpack's dev-server client). After changing code you must reload the
plugin from RemNote's UI (or reload the whole RemNote window) to pick up new
JS. `npm run dev` just serves the freshly-built files; it doesn't push
updates.

Toggle the plugin on/off at runtime with the command palette action **"Vim:
Toggle vim mode"** (`vim-toggle` in `src/widgets/index.tsx`), and open the
cheat sheet with **"Vim: Help / cheat sheet"** or by typing `;help` inside the
app.

## 4. Reading the debug badge

`VimAdapter.render()` (`src/adapter/adapter.ts:988`) draws two fixed-position
overlays via injected CSS — no devtools needed to see plugin state:

- **Bottom-right** (`body::after`): the mode badge, e.g. `-- NORMAL --`, or
  the live `:command` text while typing an Ex command.
- **Bottom-left** (`body::before`): `vim <mode> rx=<n> done=<n> k=<spec>
  <vTrail debug>` — `rx` is keys received from RemNote's steal event, `done`
  is keys the adapter has fully finished processing (including all resulting
  `exec()` calls). **If `rx !== done` and stays that way, a key handler is
  stuck** — check for an unresolved promise in `exec()`. The e2e scripts poll
  this exact string (`waitIdle()` in `run.mjs`/`stress.mjs`) to know when it's
  safe to read state.

Since it's just CSS `content`, you can read it from a real DevTools console
attached to the page (`getComputedStyle(document.body, '::before').content`)
or via `e2e/ctl.mjs eval '...'` against a CDP-attached instance.

## 5. Working in the engine (`src/engine/`)

### The dispatch shape

`handleKey(state, key, snap)` switches on `state.mode` to one handler per
mode. Each handler returns `{ state, actions }`. Keys are **engine symbols**,
not raw browser events: single characters (`'a'`, `'$'`, `' '`), or named
tokens (`'Escape'`, `'Enter'`, `'Backspace'`, `'C-r'`, `'C-d'`, ...) — see
`src/adapter/keymap.ts` for the full symbol table the adapter produces.

Useful helpers already in `engine.ts` — reuse these instead of hand-rolling:
- `reset(state, actions)` — clear count/op/pending, return unchanged mode
- `toMode(state, mode, actions)` — same, but also switches `mode` and emits
  an `{ t: 'mode', mode }` action (the adapter reacts to mode changes: key
  re-stealing, insert-mode caret sync, etc — always go through `toMode`
  rather than hand-setting `state.mode`)
- `countOf(state)` — combines a pending count with an operator's count
  (`2d3w` → 6)
- `motionFor(state, key, snap, head)` — tries to interpret `key` as a motion
  in the current context; returns `null` if it isn't one. Both `handleNormal`
  and `handleVisual` call this so motions behave consistently across modes.

### Recipe: add a new normal-mode motion

1. Implement the pure text math in `motions.ts` if it's non-trivial (pattern:
   `(text: string, caret: number, ...) => number` or `MotionResult`).
2. Add a `case` to `motionFor()` in `engine.ts` returning `simple(target)` (or
   `{ result: { target, landsOn } }` directly for inclusive motions like `e`
   or `f`). `landsOn: true` means the motion conceptually lands *on* a
   character (used by visual mode to include that character in the
   selection) — see the doc comment on `MotionResult` in `motions.ts`.
3. That's it — because `motionFor` is shared, the new motion automatically
   works standalone (`{key}`), as an operator target (`d{key}`), and inside
   visual mode. Add a unit test in `tests/engine.test.ts` covering all three.

### Recipe: add a new simple normal-mode command (no motion)

Add a `case` to the big `switch (key)` at the bottom of `handleNormal()`
(engine.ts:270+). Look at neighboring cases for the pattern: mutate via
`withCharRegister`/`reset`/`toMode`, return the `Action[]` to emit. If it's a
Rem-structural operation (new register kind, new bullet, indent, etc.), you
likely need a **new `Action` variant** first — see below.

### Recipe: add a new `Action` (new capability the adapter must execute)

1. Add the variant to the `Action` union in `types.ts`, with a doc comment
   explaining semantics — this type is the contract between engine and
   adapter, and both `VimAdapter.exec()` and `Harness.exec()` must implement
   every case (TypeScript's exhaustiveness won't catch a missing `case` in a
   `switch` without a `default`, so grep for `a.t` usages after adding one).
2. Implement the real behavior in `VimAdapter.exec()` (`adapter.ts`).
3. Implement the fake-editor behavior in `Harness.exec()` (`tests/harness.ts`)
   — this is what makes it unit-testable. Keep it a faithful *model*, not
   copy of the real implementation (e.g. `Harness` models Rems as
   `lines`/`indents` arrays, not real tree objects).
4. If the action mutates the document, add its `t` to the `MUTATING` set in
   `harness.ts` so undo/redo snapshots correctly in tests.
5. If the action changes the focused line's text/caret in a way `updateModel`
   in `adapter.ts` needs to track (or invalidates it entirely), add a case
   there too (see §6).

### Recipe: add a new Ex command (`:foo`)

Add a case to the `switch (verb)` in `VimAdapter.runEx()` (adapter.ts:658).
Verbs are matched **case-insensitively** — capitals are unreachable live (see
§9), so `:Ex` arrives as `ex`. No engine changes needed; `runEx` is a leaf
action (`{ t: 'runEx', cmd }`) the engine just passes through verbatim from
`state.commandLine`.

### Multi-key sequences (pending state)

Commands spanning multiple keystrokes (`f<char>`, `r<char>`, `g`-chords,
text objects `di`/`da`) go through `state.pending` (`types.ts`'s `Pending`
union). Pattern: first key sets `pending`, and the top of `handleNormal`
special-cases each `pending.p` value before falling through to counts/motions
/single-key dispatch. If you add a new two-key prefix, add both the "waiting"
branch (top of `handleNormal`) and, if it should work under an operator too,
a case in `handleOperatorKey`.

## 6. Working in the adapter (`src/adapter/adapter.ts`)

### The local model and why it exists

RemNote's `getFocusedEditorText()` lags a keystroke or two behind
programmatic edits. If the adapter re-read RemNote on every key, rapid
sequences (`dwA!`) would compute offsets against stale text. Instead
`VimAdapter` keeps `this.model: { remId, text, caret } | null`:

- `snapshot()` returns the model if present; only calls into RemNote when
  `this.model === null`.
- `updateModel(action)` mutates the model **deterministically** to mirror
  what each `Action` should have done, run right after `exec(action)` for
  every action in the batch — this is the exact same logic `Harness.exec()`
  encodes for tests, just against `this.model` instead of `this.lines[row]`.
- Anything that changes the focused Rem, its structure, or triggers native
  typing must call `this.invalidateModel()` (sets `model = null`) so the next
  `snapshot()` re-syncs from RemNote. The `switch` in `updateModel` is the
  single source of truth for which actions do this — **when you add a new
  `Action`, you must add a case here** (mutate the model, invalidate it, or
  explicitly no-op with a comment, matching one of the three existing
  groups).

If you're chasing a bug where commands compute against the wrong text/caret,
this is the first place to look — either an action forgot to update the model
correctly, or forgot to invalidate it when it should have.

### Why caret moves are relative deltas

RemNote's sandboxed plugin API cannot set an absolute collapsed caret
position (`selectText` with a collapsed range, `collapseSelection`, and
`moveCaret(_, MoveUnit.LINE)` are all no-ops in this sandbox — see §9). The
one primitive that *does* move the real, visible
cursor is `editor.moveCaret(delta, MoveUnit.CHARACTER)` — a relative
character offset from wherever the caret currently is. So every "set caret to
X" in `exec()` (the `setCaret` case, `insertAt`, `setCaretAbs`) computes `to -
from` using `this.model.caret` as `from` (captured **before** the action
runs — `exec` sees the pre-action model, `updateModel` runs after) and issues
a relative move. If you add a new action that needs to position the caret,
follow this exact pattern; don't reach for an absolute-set API — none exists.

### Key stealing and the shift-blindness workaround

`applyMode(mode)` diffs the wanted key set (`bindingsForMode(mode)` in
`keymap.ts`) against `this.stolenSpecs` and calls
`app.stealKeys`/`releaseKeys` incrementally. RemNote's steal matcher cannot
distinguish Shift — see `keymap.ts`'s top comment and §9 for the empirical
writeup. Practical consequence for anyone
adding a keybinding: **you cannot bind a capital letter or a shifted symbol
to a different command than its lowercase key** — RemNote reports both as the
same spec. The existing pattern is unshifted synonyms via `g`-chords (`ge` =
`G`, `gl` = `$`, `gh` = `^`, `go` = `O`) or reused punctuation (`` ` `` = `~`,
`;` = `:`, `.`/`,` = `>`/`<` in visual-line). Follow this pattern for new
capital-only vim commands rather than trying to bind the real key.

### Visual-line selection trail

Visual-line mode doesn't use RemNote's real Rem-selection (`editor.selectRem`
kills the text caret irrecoverably — blocker #4). Instead `vTrail: string[]`
records the sequence of Rem ids the caret has visually walked through
(`vStart`/`vExtend` in `exec()`), `normalizedTrail()` collapses it to
top-level selected units (dropping ids covered by an ancestor already in the
trail), and `expandWithDescendants()` turns that into the full set of ids to
CSS-tint (since RemNote's DOM doesn't nest child rows inside the parent's
container, every row needs its own selector). `tests/harness.ts` mirrors this
exact algorithm using row indices + an `indents` array instead of a real
tree — if you touch the trail logic in the adapter, update
`Harness`'s `vExtend`/`deleteRemSelection`/etc in lockstep or the unit tests
will silently test a different algorithm than production runs.

## 7. Testing

Two independent layers with different jobs. Prefer the unit suite for anything that's pure vim
semantics; reach for e2e only when the bug is specifically about RemNote
integration (caret visibility, focus survival, tree structure).

### Unit tests — `npm test` / `npm run test:watch`

Vitest, `tests/engine.test.ts` against `tests/harness.ts`'s `Harness`. No
RemNote involved — this is the fast, deterministic feedback loop; run it
constantly while working in `src/engine/`.

```ts
const h = new Harness(['hello world'], /* row */ 0, /* caret */ 0);
h.keys('dw');
expect(h.lines[0]).toBe('world');
```

`Harness.keys(seq)` tokenizes a string (`<esc>`, `<cr>`, `<bs>`, `<space>`,
`<c-r>`, `<c-d>`, `<c-u>`, `<c-w>`, `<c-o>`, `<c-i>` for named keys;
everything else char-by-char) and feeds each through `handleKey` exactly like
the adapter does, except insert-mode plain characters are typed directly into
`lines` (mirroring that insert mode releases stolen keys live). Use a 4th
constructor arg (`indents: number[]`) to build a nested-tree fixture for
visual-line tests. `Harness.clipboard` models what the adapter would have
written to the system clipboard; `jumps`/`jumpPos` model the adapter's
jumplist with row numbers standing in for rem ids.

### Live e2e — `e2e/run.mjs`, `e2e/stress.mjs`, `e2e/tree.mjs`

All three connect to a **running RemNote instance** over the Chrome DevTools
Protocol via `playwright-core`'s `connectOverCDP`, find the app page, and
require the dev plugin already loaded and enabled with today's Daily
Document open. They read state through RemNote's own **read-only** data API
(`window.Rem(...).findOne(...)`, `getText()`), never by parsing rendered DOM
text for assertions (DOM is only used to locate bullets to click).

Start an isolated instance first:

```bash
REMNOTE_APPIMAGE=/path/to/RemNote.AppImage ./e2e/launch.sh   # or auto-finds one under ~/Applications
```

This uses a scratch `$HOME` (`/tmp/remnote-vim-e2e-home` by default) so it
won't collide with your real RemNote profile, and defaults its CDP port to
**9223**. Then load+enable the dev plugin in that instance (Settings →
Plugins → Build → Develop from localhost, same as §3) and open today's Daily
Document.

**Port caveat:** `launch.sh`/`ctl.mjs` default to port `9223`;
`run.mjs`/`stress.mjs`/`tree.mjs` default to `9222`. These do **not** agree —
always pass `REMNOTE_CDP_PORT` explicitly to whichever script you run so it
matches the port `launch.sh` actually started on, e.g.:

```bash
REMNOTE_CDP_PORT=9223 npm run e2e                 # run.mjs narrative smoke test
REMNOTE_CDP_PORT=9223 node e2e/stress.mjs          # long sequences + focus-alive invariant
REMNOTE_CDP_PORT=9223 node e2e/tree.mjs            # nested-hierarchy visual-line precision test
```

(README's example instead runs `launch.sh` with defaults and `npm run e2e`
with `REMNOTE_CDP_PORT=9222` explicitly — that only works if something else
is already listening on 9222, e.g. your everyday RemNote launched with
`--remote-debugging-port=9222`. Pick one instance and use its real port
consistently.)

All three scripts scope every DOM query to bullets whose Rem-ancestor chain
reaches the open Daily Document (matched by the URL slug's trailing id), so
they can't touch your other real documents even if other panes are open —
and they clean up after themselves (`resetEmpty()` sweeps the daily note back
to one empty bullet).

- **`run.mjs`** — a single continuous narrative (each command builds on the
  previous result) asserting exact resulting text after each step. Good
  first check after any adapter change.
- **`stress.mjs`** — long, more chaotic sequences with a **focus-alive
  invariant** checked after *every* keystroke (a focused Rem or editable
  element must exist, unless deliberately in visual-line mode). This is what
  originally caught "dead cursor after cut" class bugs — run it after
  touching `removeRems`/`walkCaretOut`/`walkCaretTo` or anything else that
  moves focus across Rems.
- **`tree.mjs`** — precision test for the visual-line trail on a real nested
  tree, checking three channels per step (CSS tint, data/parent links, focus
  alive) and archiving a screenshot per phase to `e2e/shots/`. Run this after
  touching `vTrail`/`normalizedTrail`/`expandWithDescendants`.

### Manual poking — `e2e/ctl.mjs`

A tiny CDP remote for one-off inspection against a running (launch.sh'd)
instance, port defaults to 9223:

```bash
node e2e/ctl.mjs shot out.png                 # screenshot the app
node e2e/ctl.mjs eval 'document.title'        # run arbitrary JS in the page
node e2e/ctl.mjs key 'j j x'                  # press a key sequence (space-separated)
node e2e/ctl.mjs type 'hello'                 # type text
node e2e/ctl.mjs click '.EditorContainer'     # click a selector
```

Handy for reproducing a live bug interactively before writing it into
`stress.mjs`/`tree.mjs` as a regression check, or for reading the debug badge
live (`eval "getComputedStyle(document.body,'::before').content"`).

### Real-input delivery test — `e2e/real-input.mjs`

The CDP suites synthesize input inside the renderer and therefore CANNOT see
keys the Electron main process eats (real Ctrl+W — §9). This script sends
kernel-level uinput events via **ydotool** — the identical path to a physical
keyboard — and asserts on what actually reaches the plugin's key steal (read
from the debug badge). Covers `h`, `C-h`/`C-l`, `C-o`/`C-i` (CDP-invisible,
only this suite can see them) and documents the `C-w` hole:

```bash
systemctl --user start ydotool        # once per session (user service exists)
REMNOTE_CDP_PORT=9223 node e2e/real-input.mjs
```

The e2e RemNote window must be FOCUSED in the compositor (real keys go to the
focused window; the script aborts otherwise instead of typing into whatever
else is focused). Run this whenever you add a modifier-chord binding — a
chord that passes the CDP suites can still be dead at a real keyboard.

### SDK REPL — `e2e/sdk-repl.mjs`

Runs an async JS body *inside the sandboxed plugin iframe*, with `a` bound to
the live `VimAdapter` instance and `p` to the `RNPlugin` (the adapter exposes
itself as `globalThis.__vimAdapter` for exactly this):

```bash
node e2e/sdk-repl.mjs 'const f = await p.focus.getFocusedRem(); return f?.text;'
node e2e/sdk-repl.mjs 'return (await p.editor.getSelection())?.type ?? "none";'
```

This is the fastest way to answer "what does SDK call X actually do live?" —
no rebuild, no keypress choreography. All of the §9 selection/clipboard
findings were probed this way. Caveats: the app must be running with the dev
plugin loaded (it attaches to the `localhost:8080` iframe CDP target), and
state you mutate is real — clean up after probes. Remember the app restart
requirement when you edit adapter code (§0 evening entry): the iframe does
not pick up rebuilds; `pkill -f 'remote-debugging-port=9223'` and relaunch.

### Main-window REPL — `e2e/main-repl.mjs`

The sibling of sdk-repl for the HOST page: runs an async JS body in the main
RemNote window, with `pm` bound to `window.getPluginManager()`:

```bash
node e2e/main-repl.mjs 'return Object.keys(pm.pluginIdToPluginHost)'
```

To reach RemNote's internal (webpack) modules from a probe, grab the require
fn by pushing a probe chunk — this is how the whole §9 native-mode
investigation was done (module `891324` = plugin install/records, `951185` =
PluginHost, store at `req(607680).UserDataStore.installedPlugins`):

```js
let req;
window.webpackChunk_remnote_client.push([[Symbol('probe')], {}, (r) => { req = r; }]);
const mod = req(891324); // e.g. mod.ds() = installed-plugin records
```

Module ids are for the 1.26.30 bundle — re-locate them after an app update
by grepping the extracted AppImage's `resources/app.asar` for a nearby
string (it's greppable as-is; see the §0 2026-07-08 native entry).

### Targeted motion probes — `e2e/motionfix.mjs`

Small text-diff probes for the find/word-end cursor-landing class
(f/t/dt/e/ea/`,`/counts), typed through the real key path against a fixture
line. Much faster than the full suites when touching `motions.ts` landing
semantics; run it plus `formatting.mjs` before reaching for run/stress.

```bash
REMNOTE_CDP_PORT=9223 VIM_E2E_SETTLE=1600 node e2e/motionfix.mjs
```

## 8. Debugging checklist

- **Key does nothing live, but the unit test passes:** check `keymap.ts` —
  is the spec actually in `NORMAL_BINDINGS`/`INSERT_BINDINGS` and being
  stolen for the current mode (`bindingsForMode`)? Check the badge's `k=`
  field to see what spec RemNote actually reported for your keypress (it may
  not be what you expect — shift-blindness, punctuation remapping).
- **Commands compute against stale text/caret:** almost always a missing or
  wrong case in `VimAdapter.updateModel()` (§6) — either an action didn't
  update the model to match what it just did, or should have invalidated it
  and didn't.
- **Caret disappears / keyboard "dies" after a command:** you're missing a
  `walkCaretOut`-style escape before removing/reparenting the focused Rem's
  editor. `moveCaretVertical` only works while some text editor is focused;
  once that Rem is gone, the caret is unrecoverable — always move focus to a
  survivor *before* the structural change, not after. `stress.mjs`'s
  focus-alive invariant exists specifically to catch this.
- **`rx`/`done` in the badge diverge and stay diverged:** a key handler in
  `handleSym`/`exec` is stuck on an unresolved promise — check the newest
  `exec()` case you added for a missing `await` or an SDK call that can hang.
- **Rich text / register content looks wrong:** `registerToText` and
  `captureSubtree`/`pasteSubtree` (adapter.ts) are the serialize/deserialize
  pair for the line register — a Rem's `RichTextInterface` is an array of
  strings or `{text}` objects, not a plain string; don't assume `.text` is a
  flat string.

## 9. Platform constraints (read before fighting the SDK)

What's actually enforced in code you'll touch (all verified empirically
against RemNote 1.26.30):

- **The rich-text offset space is UTF-16 code units with every ATOMIC
  element = exactly 2 units** (probed live 2026-07-08: `editor.selectText`
  ranges and `getSelection().range`; `richText.length` agrees). A rem
  reference, image or LaTeX chip is 2 units regardless of its display text.
  **`richText.toString` is NOT offset-safe** — it expands a reference to its
  full display name — never use it to build text the engine computes offsets
  against; `flattenRich()` (src/adapter/pure.ts) is the offset-safe flatten
  (atomics become the 2-unit/1-code-point placeholder `ATOMIC_CH`).
- **`moveCaret(n, MoveUnit.CHARACTER)` moves n caret STOPS, not units** —
  one stop per code point and one per whole atomic element (probed live: a
  single +1 crossed a 2-unit reference chip; same for emoji). Any relative
  caret move must convert unit offsets to stops (`stopsBetween()` in
  motions.ts); a raw unit delta over-shoots on chip/emoji lines.
- **`getFocusedEditorText()` lags native typing** — an immediate read on
  insert-exit can return the line missing the last typed characters, and an
  immediate read after an SDK `setText`-style mutation can return the
  pre-mutation text. Never trust a single read at those boundaries; use
  `settleRead()` (two consecutive agreeing reads) like
  `reconcileAfterInsert`/`snapshot()` do. A null read means "no focused
  editor" and must never be cached as an empty line.
- **Key stealing is SHIFT-BLIND.** The steal matcher reports the bare key
  regardless of Shift, and `shift+…` specs never match at all (probed live:
  with only `shift+v` stolen, neither `v` nor `V` is captured; with `v`
  stolen, both are captured and reported as `v`; `$` reports as `4`, `Q` as
  `q`). Ctrl combinations DO match correctly.
- **Leading whitespace**: RemNote's data layer trims it from a Rem
  immediately while the editor keeps it until a later normalization. The
  adapter mirrors the trim (`normalizeModel`) and extends column-0 deletes
  over the doomed whitespace — except `keepLead` (change-family) deletes,
  which stay vim-exact because an insert follows immediately.

- **Shift is unobservable** (`keymap.ts` top comment) → no real capital-key
  bindings, ever. Use the synonym pattern (§6).
- **The command line is shift-blind too** (typed Ex characters arrive through
  the same steal): capitals and shifted punctuation are UNTYPEABLE in
  `:commands` — `ALPHA` arrives as `alpha`, `$`→`4`, `%`→`5`, `(`→`9`,
  `)`→`0`, `^`→`6`, `*`→`8`, `?`→`/`. Practical `:s` fallout: patterns are
  limited to the unshifted regex subset (literals, `.`, `[...]`, `\d`/`\w`/
  `\b`-style escapes, `\/`); regex groups, `$`-forms in the replacement
  (`$1`, `$&`, `$$`) and therefore vim `\1` backrefs are code-correct
  (verified via direct `substitute()` calls) but unreachable from the
  keyboard; case-changing substitutions are impossible. Don't "fix" a
  capital-letter `:s` bug report — it's this.
- **`setRemWindowTree` regenerates every pane id and drops the pane focus**
  (`getFocusedPaneId()` → null, caret dead until a pane is focused). There is
  also NO layout getter, so a hand-arranged nested layout can only be rebuilt
  flat. After any tree write, re-fetch `getOpenPaneIds()` (order matches the
  leaf order — verified live) and `setFocusedPaneId` the intended leaf; that
  also restores the caret to the pane's last-focused rem. `setPaneTree()` in
  the adapter is the reference implementation — route new layout writes
  through it.
- **`positionAmongstSiblings()` races the data layer right after an edit** —
  it can return a stale position or effectively make a rem its own
  previous/next sibling. Bit `indentSelection` (2026-07-07, fixed by deriving
  the destination once per run) and `joinRem` (2026-07-08, fixed by locating
  the sibling by id in `getChildrenRem()` instead). When you need "the rem
  next to X" right after a mutation, find X by id in the children list and
  index from there — don't re-query positions.
- **SDK `rem.remove()` of a currently-rendered rem leaves a ZOMBIE row** —
  the data layer drops it (reads/search agree) but the open document keeps
  rendering it, and a click focuses the detached rem (a substitute aimed at
  "the focused bullet" then edits the zombie: reproduced live). Mostly an
  e2e/scripting hazard: after SDK-side removals, force a re-render with an
  `openRem` round-trip (another doc, then back) before clicking anything.
- **The collapsed caret can't be read**, only moved relatively (§6) → don't
  add code that assumes you can query "where is the caret right now" from
  RemNote directly; track it in the model instead.
- **Native plugin mode is HARD-DISABLED platform-wide in RemNote 1.26.30**
  (read from the app bundle + forced live, 2026-07-08 — full story in §0):
  `requestNative: true` does nothing for ANY plugin, local or store. Three
  independent locks: (1) `installPlugin` computes
  `isNative = !O && requestNative && (!isLocal || id === "demo_all_features")`
  where `O` is a module-level `let O = !0` kill switch — so local/dev plugins
  are also excluded by policy even if `O` flips; (2) the `PluginHost`
  constructor does `m.sF && (e.isNative = !1)` (same `O` via getter export
  `sF`), clearing the flag on EVERY registration — flipping the stored record
  (`UserDataStore.installedPlugins.pluginData.setNested`) or toggling the
  per-plugin "native mode" settings switch (it exists! calls `ot(id,
  {isNative})`) is silently undone here; (3) the plugin-store review UI
  renders "Request Native: … (REJECT IF TRUE FOR NOW)" — store submissions
  with `requestNative:true` are rejected by policy. Forcing registration
  with an accessor-protected record (getter `true`, no-op setter — neutralizes
  lock 2) DOES activate the native runtime: the widget mounts as a
  `div[data-is-native-plugin]` + open shadow root in the MAIN page (no
  iframe; `getWidgetURL` loads `index.js` — this is why the build emits
  `index-sandbox.js` twins), `window.__vimAdapter` appears in the main
  window, keys are stolen, and `hostDocument()` works — but `registerCSS`
  output lands inside the widget's shadow root (all `body::before/::after`
  UI — mode badge, debug HUD, cursorline — is dead) and the app throws React
  invariant errors (broken editor rendering). Verdict: native is a
  deliberately unfinished, switched-off feature — there is NO shippable or
  even dev-usable native path on this version. `domCaret.ts` stays (its
  `hostDocument()` null-check is the native/sandbox switch); the overlay
  block-cursor WIP (`blockCursor.ts`) was deleted — approach documented in
  the 2026-07-08 handoff §0 entry. Keep `requestNative: false` in
  manifest.json until RemNote unblocks native (it's store-poisonous).
  Force-recipe and probing tools (`e2e/main-repl.mjs`) are in the
  2026-07-08 §0 entry. Meanwhile the block cursor rides CSS `caret-shape`:
  correct block on newer Chromium, thin colored caret on older (see the
  2026-07-08 final-decision entry).
- **Direct clipboard writes from the sandbox NEVER work** (probed live):
  `navigator.clipboard.writeText` rejects with "Document is not focused",
  the `clipboard-write` permission is hard-denied for the plugin iframe, and
  `execCommand('copy')` returns false (no user activation ever reaches the
  iframe — stolen keys arrive by async postMessage). Every clipboard write
  must ride a native editor operation in the host: text-range
  `selectText`+`cut()` (charwise) or `selectRem`+`copy()` (whole-rem).
- **`editor.cut()` on a Rem selection writes EMPTY html to the clipboard**
  (it serializes after removal). For rem cuts: `copy()` first, then remove
  via the SDK (`cutRems` in the adapter). Text-range `cut()` is unaffected.
- **`editor.selectRem` blurs the caret — recover it with a pane refocus.**
  The old "one-way door, never call it" rule is obsolete: capture
  `window.getFocusedPaneId()` before selecting, call
  `window.setFocusedPaneId(paneId)` after, and the Rem selection clears with
  the caret restored to its exact pre-selection rem AND column (verified
  with a marker insert). Nothing else recovers it: `collapseSelection`,
  `moveCaret`/`moveCaretVertical`, `selectText`, `selectRem([])`,
  `insertPlainText`, and even a real Escape (stolen by us) all leave the
  selection stuck — and while it's stuck, typed keys bypass the steal and
  open RemNote's selection-actions popup. Use `nativeClipboardRems` as the
  reference implementation; visual-line mode still uses the CSS-tint trail
  (a persistent native selection would keep the caret dead between keys).
- **A real Ctrl+W NEVER reaches the renderer on the desktop app** — Electron
  consumes it in the main process before any web content sees it (verified
  with kernel-level uinput via ydotool: the keydown never fires in the page,
  while Ctrl+H/L/J/K/O/I all arrive). **CDP tests are blind to this**:
  CDP-synthesized input is injected inside the renderer, bypassing the
  Electron layer, so a `C-w` binding looks green over CDP and is dead at a
  real keyboard. Any new modifier-chord binding must be verified with
  `e2e/real-input.mjs` (§7) before trusting it. Pane nav therefore lives on
  Ctrl-H/Ctrl-L (the `C-w` chord stays bound for hosts that deliver it).
- **Ctrl-chord delivery splits THREE ways** (all verified 2026-07-08) — this
  is subtler than the C-w blocker and bit a bughunt hard:
  - `C-d` / `C-u` / `C-r` reach RemNote's key steal via **CDP** (so
    run.mjs/stress.mjs can drive them).
  - `C-o` / `C-i` do **NOT** reach the steal via CDP (rx never increments) but
    **DO** via real hardware (ydotool). So the jumplist looks broken under CDP
    and works at a real keyboard — do not "fix" a jumplist bug you only saw in
    a CDP test; reproduce it with `e2e/real-input.mjs` first.
  - `C-w` reaches neither (previous bullet).
  Net: `run.mjs`/`stress.mjs` cannot cover `C-o`/`C-i`/`C-w`; only
  `real-input.mjs` can.
- **`elementFromPoint` can fall through to `<html>` even with pointer-events
  fine**, making CDP `mouse.click` focus nothing. Two distinct causes seen:
  (1) the **daily-template banner** rendering/dismissing shifts bullet Y
  positions, so a precomputed click coord lands in empty space — dismiss the
  banner and click via a Playwright **locator** (position resolved at
  click-time); (2) leftover **`selectRem` state** stuck as
  `.in-selected-portal` on `.rn-editor-container` deadens hit-testing until a
  full app relaunch. If clicks mysteriously stop focusing, relaunch the app
  rather than fighting it.
- **RemNote can boot with `pointer-events-none` stuck on
  `.rn-editor-container`** (suppress-mouse-while-typing state that never
  clears when no real pointer enters the window — an e2e/CDP hazard more
  than a user-facing one). All CDP clicks then fall through to `<html>` and
  focus nothing. The e2e suites strip the class at startup; do the same in
  manual sessions if clicks mysteriously no-op.
- **A freshly launched window swallows synthetic CDP clicks until
  `page.bringToFront()`** (found 2026-07-08 night, cost a full debug loop):
  clicks dispatch fine but `document.activeElement` stays `BODY` and no rem
  ever focuses, while keystrokes still reach the key steal (rx increments) —
  so rem-targeted commands silently no-op. All suites now call
  `bringToFront()` right after connecting; do the same in ad-hoc scripts.
- **RemNote's own Ctrl+E opens the audio-embed widget** (on an empty bullet
  it renders the "Insert an Audio URL" box and wedges the doc for e2e).
  The plugin deliberately does NOT steal Ctrl+E/Ctrl+Y (no view-scroll API,
  see engine.ts), so never press them in suites — stress.mjs dropped its
  `<c-e>`/`<c-y>` steps for exactly this reason (user-reported wedge).

## 10. Build & release

```bash
npm run check-types   # tsc --noEmit, run before committing
npm run build          # rm -rf dist && webpack (production) && zip dist/ → PluginZip.zip
```

`PluginZip.zip` is the distributable uploaded via RemNote's plugin store flow
(or side-loaded). `public/manifest.json` is copied into `dist/` verbatim by
`CopyPlugin` in `webpack.config.js` — bump `version` there for a release.

---

## Appendix A. Companion-service design notes (design-only, not implemented)

The plugin has hit four hard walls that no amount of in-sandbox cleverness
removes (§9): shift-blind key stealing, an unreadable collapsed caret, no
view-scroll API, and second-class clipboard access from an unfocused sandbox
iframe. This appendix thinks through whether a local background service could
lift them, what it would look like, and whether it is worth the cost.
**Design-only; do not implement from this document without an explicit
decision.** (Formerly the standalone `SERVICE_NOTES.md`, folded in here so the
project has a single developer guide.)

### The one-line pitch

The e2e harness already proves the approach: a process attached to RemNote
over the Chrome DevTools Protocol (CDP) has full host-page access — real DOM
selections, real key events with modifier state, real scrolling, native
clipboard. A small always-on daemon doing exactly what `e2e/ctl.mjs` does,
plus a WebSocket bridge to the plugin, turns every "impossible" item into a
feature.

### What it would unlock, concretely

| Sandbox limitation | With a CDP companion |
|---|---|
| Shift-blindness → synonym table (`gl`=`$`, `ge`=`G`, `vv`=`V`) | A capture-phase `keydown` listener in the host page sees `key`, `shiftKey`, `ctrlKey` exactly. Real `$ ^ V G A O ~ : > <` become bindable; the synonym table becomes an optional fallback. |
| Collapsed caret unreadable → column desync after mouse clicks | Host-page `getSelection()` reads the caret directly; push `{caret}` events to the plugin on every selectionchange. The model never desyncs again. |
| No view scrolling → Ctrl-E/Ctrl-Y removed | `scroller.scrollBy(0, dy)` on the editor scroll container. True vim scroll (view moves, cursor stays). |
| Clipboard writes may be blocked in the unfocused iframe | The service process writes the OS clipboard itself (`wl-copy` on this machine, or CDP `Browser.setPermission` + host-page `navigator.clipboard`). Deterministic, no fallback tiers. *Update 2026-07-07: mostly solved in-sandbox — whole-rem yanks now ride `selectRem`+`editor.copy()` with pane-refocus caret recovery (§9), so the daemon's clipboard value shrinks to exotic cases (yank without any native op, custom formats).* |
| `/` opens RemNote's own slash menu only for the focused bullet | The service can synthesize real key events (`Input.dispatchKeyEvent`) — or the plugin keeps its own `:`-command palette and the service just supplies real keys. |

### Architecture sketch (option A — recommended shape *if* this is ever built)

```
┌─────────────────────────── RemNote (Electron) ───────────────────────────┐
│  host page  ←— injected observer script (keys, caret, scroll targets)    │
│  plugin sandbox iframe (this repo) —— ws://127.0.0.1:PORT ——┐            │
└──────────────────────────────△──────────────────────────────│────────────┘
                               │ CDP (127.0.0.1:9222)          │ WebSocket
                        ┌──────┴──────────────────────────────▽─────┐
                        │   companion daemon (systemd --user unit)  │
                        └────────────────────────────────────────────┘
```

- **Attach**: RemNote must be launched with `--remote-debugging-port=9222`
  (a `.desktop` file edit — same flag the e2e harness uses). The daemon
  attaches with `playwright-core` (already a devDependency here) or plain
  `chrome-remote-interface`. Python (`websockets` + `pychrome`) works
  equally well; the language matters less than the protocol. Reusing
  playwright-core keeps one stack and lets the daemon share helpers with
  `e2e/*.mjs`.
- **Host-side observer**: one injected script (via `Runtime.evaluate` /
  `Page.addScriptToEvaluateOnNewDocument`) that (a) listens to `keydown` in
  the capture phase, (b) mirrors `selectionchange` caret offsets, and (c)
  exposes `scrollBy`/clipboard verbs. When the vim plugin asks for a key to
  be "really stolen", the observer calls `preventDefault()+stopPropagation()`
  — this out-steals RemNote's own stealer, with full shift fidelity.
- **Plugin bridge**: the sandbox iframe opens `ws://127.0.0.1:PORT` (needs a
  one-time live check that RemNote's iframe CSP allows localhost WebSockets;
  nothing in the SDK forbids it). Protocol sketch:
  - service → plugin: `{t:'key', key:'$', shift:true, ctrl:false}`,
    `{t:'caret', offset:14}`
  - plugin → service: `{t:'steal', keys:[...]}`, `{t:'scroll', lines:±n}`,
    `{t:'copy', text}`, `{t:'ping'}`
- **Graceful degradation is non-negotiable**: the plugin must feature-detect
  the daemon (ping at startup, retry lazily) and run exactly as today when
  it is absent. The service is an enhancer, never a dependency — otherwise
  the plugin becomes uninstallable for anyone but this machine.

### Alternatives considered (and why they lose)

- **B. keyd/evdev remapping layer** (this machine already runs keyd): remap
  shifted keys to unshifted chords system-wide or per keyd profile. Fixes
  *only* the shift problem, has no idea which app or vim-mode is focused
  (would need a niri-IPC watcher feeding keyd application rules), and
  corrupts typing everywhere else the moment the focus heuristic is wrong.
  High blast radius, tiny win compared to A.
- **C. `requestNative: true`**: the clean, intended path — but RemNote
  hard-disables native plugins in current builds (`isNative: !O && …`,
  "REJECT IF TRUE FOR NOW"). Worth re-testing on each RemNote release; if it
  ever ships, `src/adapter/domCaret.ts` already contains the caret half and
  most of this document becomes unnecessary.
- **D. Patching app.asar** (inject a preload bridging host ↔ plugin):
  maximal power, zero extra processes at runtime — but it modifies the
  installed app, breaks on every update, and is the kind of thing that gets
  accounts flagged. Not worth it for an editor nicety.

### Costs and risks of option A (the honest part)

1. **Security**: an open CDP port is remote-code-execution-as-you on the
   whole RemNote app (notes, session, cookies) for *any* local process, not
   just our daemon. Localhost-only softens but does not remove this (any
   userspace malware is local). This must be an explicit opt-in with the
   trade-off documented, never a default.
2. **Fragility**: the observer script depends on RemNote's DOM (scroll
   container selector, editor classes). Every RemNote update can break it —
   the plugin API is versioned, the DOM is not. The e2e suite would need a
   "companion contract" test layer to catch this.
3. **Operational surface**: a daemon (systemd user unit), a launch flag, a
   port — three more things to install, document, and debug ("vim keys act
   weird" now has two suspects). For dotfiles integration that's manageable
   *for this machine*, but it forks the plugin into "plain" and "companion"
   behavior matrices to test.
4. **Latency**: key → CDP event → daemon → WebSocket → plugin → SDK call is
   two extra IPC hops (~1–5 ms each). Fine for commands; would need care if
   the daemon ever sat in the hot path of *every* keystroke (it shouldn't —
   keep RemNote's stealKeys as the transport for keys it can see correctly,
   and use the daemon only for the shift-sensitive ones and caret events).

### If it ever goes ahead: staged plan (smallest useful slice first)

1. **Caret mirror only** (read-only, no key handling): daemon pushes caret
   offsets; plugin drops the click-desync limitation. Lowest risk, validates
   the bridge end-to-end.
2. **Clipboard verb**: replaces the three-tier fallback with one native call.
3. **Scroll verb**: restore Ctrl-E/Ctrl-Y as true scrolling.
4. **Shift-faithful key layer**: real `$`, `V`, `:` … retire the synonym
   table by default, keep it as the no-daemon fallback.

Each stage independently useful, independently revertible, and the plugin
stays fully functional at every stage with the daemon off.

### Verdict

Technically sound and already 80 % proven by the e2e infrastructure, but it
buys polish, not capability the current plugin lacks entirely — every
blocked item now has a workable synonym or fallback. Recommendation: park
this until either (a) the click-desync/caret issue becomes a daily
irritation, or (b) RemNote ships native plugins (option C), which would
obsolete most of the daemon. Re-evaluate after filing the upstream issues
about shift-blind `stealKeys` and native-plugin availability — a fix on
their side is strictly better than any of this.
