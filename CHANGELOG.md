# Changelog

All notable changes to the **Vim Mode** RemNote plugin. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version numbers are
the plugin manifest's.

## [0.2.3] — 2026-09-28

The first release since 0.1.0. Versions 0.2.0–0.2.2 were development builds
and were never released on their own.

### Upgrading from 0.1.0

- **`Space` now starts a search.** It used to move right like `l` — use `l`.
- **`gd` / `gu` are gone.** They were aliases of `Ctrl-D` / `Ctrl-U`, which
  work everywhere.
- The **Vim Tutorial** opens once after the update: a practice document in
  your knowledge base. Delete it any time; `;tutorial` brings it back.

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
  [#1](https://github.com/onegraund/remnote-vim/issues/1); the rest of that
  report appears to be on RemNote's side and is still being looked into.

## [0.1.0] — 2026-07-08

First public version: normal / insert / visual / visual-line modes, motions,
operators, counts, registers, text objects, marks, dot-repeat, the jumplist,
pane management, the `;` command line (`:s`, `:g`, `:sort`, `:e`, …), native
clipboard integration, and the `:help` cheat sheet.

[0.2.3]: https://github.com/onegraund/remnote-vim/compare/cffb8a7...v0.2.3
[0.1.0]: https://github.com/onegraund/remnote-vim/tree/cffb8a7
