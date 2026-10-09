# Changelog

All notable changes to **rem-vim**, a fork of the
[Vim Mode](https://github.com/OneGraund/remnote-vim) RemNote plugin by
onegraund. Entries up to 0.2.3 are the original project's; 0.3.0 on are this
fork's. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version numbers are
the plugin manifest's.

## [0.3.4] — 2026-10-08

0.3.2 and 0.3.3 were development builds.

### Added

- **`zt` / `zz` / `zb`** (and `z<CR>` / `z.`) put the cursor line at the top,
  middle or bottom of the screen. Plugins can't scroll RemNote's page, so the
  plugin walks the cursor off-screen and back and lets RemNote scroll it into
  view; the page visibly moves for a moment (the cursor is hidden while it
  travels). The first use in a pane is slower while it measures where the
  screen edges are.

## [0.3.1] — 2026-10-08

### Changed

- **Vim steps aside during flashcard review.** While the queue is open the
  plugin releases every key and hides its badge, so RemNote's own review
  shortcuts work; leaving the queue switches vim back on in normal mode. If
  you had toggled vim off, it stays off.

## [0.3.0] — 2026-10-08

### Shifted keys work

RemNote's key capture does see Shift, as long as a plugin asks for
`shift+<key>` (RemNote 1.28.32, verified at a real keyboard). Earlier versions
assumed it couldn't, and routed capitals through lowercase stand-ins. Now the
real vim keys work.

### Added

- **Capitals and shifted symbols**: `A I O D C S X P Y G V W B E F T ~ $ ^ > <`
  plus `:` all do what they do in vim. They also work inside commands: `fA`,
  `r$`, `di(`, `di{`, `di"`, marks like `mA`, and capitals in the command line
  (`:s/Foo/Bar/`).
- **`{` / `}`** jump to the previous / next empty bullet (vim's paragraph
  motion; RemNote has no blank lines). Counts work, and they're jumps
  (`Ctrl-O` returns).
- **`J`** joins the next bullet, **`N`** searches backward, **`@a`** plays a
  macro, **`@@`** replays the last one.
- **`gs(`**, **`gs"`**, **`gs*`**, **`gs{`**, **`gs<`**, **`gs_`** wrap a
  visual selection.
- **`:sort!`** reverses (same as `:sort rev`).
- `:config` mappings can use shifted keys on the left side too (`nmap H ^`).

### Changed — these keys now mean what they mean in vim

- **`:` opens the command line; `;` repeats the last `f`/`t`/`F`/`T`.**
  (`;` used to open the command line.) If you want the old behavior back,
  add `nmap ; :` in `:config`.
- **`V`** enters line-wise visual directly; **`v`** inside visual exits.
  (`vv` used to mean `V`.)
- **`ge`** goes back to the end of the previous word. (It used to mean `G`.)
- **`` ` ``** jumps to a mark, like `'`. (It used to toggle case; use `~`.)
- **`gj` / `gk`** move down / up. (`gj` used to join bullets; use `J`.)
- **`z`** no longer searches backward; use `N`.
- Still there as aliases: `gl` (`$`), `gh` (`^`), `ga` (`A`), `go` (`O`),
  `gf` (`F`), `gq` (`@`), and `.` / `,` to indent / outdent in line-wise
  visual.
- The **Vim Tutorial** is rewritten for the real keys. Your old copy is kept
  as "Vim Tutorial (old copy)".

### Known issues

- Shifted keys are matched by physical key on a US layout. On other layouts
  some symbols may land on different keys; `:config` can remap them.

## [0.2.3] — 2026-09-28

The first release since 0.1.0. Versions 0.2.0–0.2.2 were development builds
and were never released on their own.

### Upgrading from 0.1.0

- **`Space` now starts a search.** It used to move right like `l` — use `l`.
- **`gd` / `gu` are gone.** They were aliases of `Ctrl-D` / `Ctrl-U`, which
  work everywhere.
- The **Vim Tutorial** opens once after the update: a practice document in
  your knowledge base. Delete it any time; `;tutorial` brings it back.
- Installing the update can make RemNote show one error popup — harmless,
  see Known issues below.

### Added

- **Custom keybindings.** `:config` opens a "Vim Keymap" document where you
  write vim-style mappings, one per bullet (`nmap - $`, `vmap q <esc>`,
  `unmap ,`). They apply when you leave the document or on `:mapload`;
  `:map` lists what's active plus any errors. Also in the command palette as
  "Vim: Edit keybindings (:config)".
- **Macros.** `q<a-z>` records, `q` stops, `gq<a-z>` plays back (vim's `@`,
  which needs Shift), `gq.` replays the last one, and counts work (`3gqa`).
  The badge shows `recording @a` while recording.
- **Whole-document search.** `Space`, type a pattern (a regex,
  case-sensitive), `Enter` jumps to the next match anywhere in the document.
  `n` / `z` (vim's `N`) repeat forward / backward and wrap around the ends;
  `Ctrl-O` jumps back.
- **`:N`** (e.g. `:10`) jumps to the Nth bullet from the top of the document.
- **`gs<delim>`** wraps a charwise-visual selection in a delimiter pair:
  `gs9` `(…)`, `gsq` `"…"`, `gs[` `[…]`, `gs'`, ``gs` ``, `gs8` `*…*`. Safe
  around rem references, images and LaTeX.
- **`gf<c>`** finds a character backward (vim's `F`), also after an operator
  (`dgf<c>`).
- **Toggle case in charwise visual** with backtick (vim's `~`).
- **The Vim Tutorial:** a practice document with 14 lessons, vimtutor-style —
  every lesson is ordinary bullets you edit with the real keys. It opens once
  on first install; `;tutorial`, `;vimtutor` or "Vim: Tutorial" reopen it.
  When an update changes the lessons, your copy is replaced and the old one is
  kept as "Vim Tutorial (old copy)".
- **`:help` scrolls** with `j`/`k` or the arrow keys, and now lists `t<c>`.
- The debug readout (bottom-left) shows the plugin version — `vim 0.2.3@…` —
  handy in bug reports.

### Changed

- `Space` starts a search instead of moving right.
- `gd` / `gu` were removed (use `Ctrl-D` / `Ctrl-U`).

### Fixed

- Keys could silently stop being captured when RemNote dropped the plugin's
  key registrations; they are now re-registered automatically.
- A capital letter slipping past RemNote's Shift-blind key capture no longer
  leaves `r` waiting or breaks `h`/`l` in that bullet.
- A noticeable delay when leaving insert mode.
- `gg` / `G` taking seconds in long documents.
- `Ctrl-O` and mark jumps into another document landing in the wrong place.
- Undoing a pasted subtree or a multi-bullet indent/outdent now takes one `u`.
- `Esc` couldn't close RemNote's own `Ctrl-P` / `Ctrl-K` palette while vim was
  in normal mode.
- Long command-line completions overflowing the badge.
- Disabling or uninstalling the plugin now releases everything it set up
  (key capture, event listeners, the mode badge). That is the plugin's part of
  [#1](https://github.com/onegraund/remnote-vim/issues/1); the error popup
  RemNote itself can still show is under Known issues.

### Known issues

- RemNote can show an error popup (`Minified React error #185`) when the
  plugin unloads: on disable, uninstall or update, or when you change its
  options on RemNote's Plugins page. It's a bug in RemNote's key-capture
  code, which loops whenever a plugin that captured keys is unloaded, so the
  plugin can't prevent it. Dismiss the popup; the plugin still switches off
  and back on normally. Tracked in
  [#1](https://github.com/onegraund/remnote-vim/issues/1).

## [0.1.0] — 2026-07-08

First public version: normal / insert / visual / visual-line modes, motions,
operators, counts, registers, text objects, marks, dot-repeat, the jumplist,
pane management, the `;` command line (`:s`, `:g`, `:sort`, `:e`, …), native
clipboard integration, and the `:help` cheat sheet.

[0.2.3]: https://github.com/onegraund/remnote-vim/compare/cffb8a7...v0.2.3
[0.1.0]: https://github.com/onegraund/remnote-vim/tree/cffb8a7
