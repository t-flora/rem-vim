# rem-vim

**Vim mode for the [RemNote](https://www.remnote.com) desktop app — with real Shift keys.**

[![CI](https://github.com/t-flora/rem-vim/actions/workflows/ci.yml/badge.svg)](https://github.com/t-flora/rem-vim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

rem-vim is a fork of **[Vim Mode](https://github.com/OneGraund/remnote-vim)**
by [onegraund](https://github.com/OneGraund), the RemNote plugin that brings
modal, vim-style editing to your notes: normal / insert / visual modes,
motions, operators, counts, registers, text objects, marks, dot-repeat,
macros, whole-document search, an Ex command line, custom keybindings, native
clipboard integration and an interactive tutorial. All of that is their work,
and its history is preserved here — this fork only builds on it. If you want
the original, install **"Vim Mode"** from the RemNote plugin store.

### What this fork adds

- **Real shifted keys.** `A`, `I`, `O`, `G`, `V`, `$`, `^`, `{`, `}`, `:`, `~`,
  `>`… all do what they do in vim. The original routes capitals through
  lowercase stand-ins (`ga` for `A`, `gl` for `$`) because RemNote's key
  capture looked shift-blind. It isn't: RemNote matches stolen keys with
  [is-hotkey](https://github.com/ianstormtaylor/is-hotkey) by key code, so a
  plugin just has to ask for `shift+a`, `shift+4`, `shift+[`… (and never `$`
  itself, which is-hotkey reads as the Home key). Verified in RemNote 1.28.32
  at a real keyboard.
- **`{` / `}`** jump between empty bullets, plus **`J`**, **`N`**, **`@a`** /
  **`@@`**, `di(` / `di{` / `di"`, `:sort!`.
- **vim's own meanings** where the stand-ins clashed: `:` opens the command
  line and `;` repeats `f`/`t`; `V` is line-wise visual; `ge` is end of the
  previous word; `` ` `` jumps to marks; `gj`/`gk` move.
- **Flashcard review is left alone**: vim steps aside while the queue is open,
  so RemNote's review shortcuts keep working.
- **`zt` / `zz` / `zb`** (experimental): plugins can't scroll the page, so it
  walks the cursor off-screen and back to make RemNote scroll. It works; the
  page visibly moves for a moment.

See the [CHANGELOG](CHANGELOG.md) (0.3.x entries) for the details.

> **Desktop only.** RemNote's plugin sandbox can't steal keys reliably on
> mobile, so the plugin declares `enableOnMobile: false`.

---

## Install

rem-vim isn't in the RemNote plugin store; run it from source. Don't run it
alongside the store's Vim Mode — both capture the same keys — so disable or
uninstall that first.

```bash
git clone https://github.com/t-flora/rem-vim
cd rem-vim
npm install
npm run dev          # webpack-dev-server on http://localhost:8080
```

In RemNote: **Settings → Plugins → Build → Develop from localhost**, enter
`http://localhost:8080/`, click **Develop**, and turn on the **"rem-vim"**
toggle. A `-- NORMAL --` badge appears bottom-right when it's active, and the
bottom-left readout starts with `vim <version>@`. Keep `npm run dev` running
while you use it; reload RemNote (Cmd/Ctrl-R) after pulling new code.

---

## Using it

- Toggle the whole thing off/on: command palette → **"Vim: Toggle vim mode"**.
- **Flashcard review is left alone:** while the queue is open, vim releases
  every key so RemNote's review shortcuts work, and comes back in normal
  mode when you leave.
- The mode badge (bottom-right) shows the current mode: `-- NORMAL --`,
  `-- INSERT --`, `-- VISUAL --`, etc. — plus `recording @a` while a macro
  records.
- The **caret and the focused row are tinted in the mode color** (violet =
  normal, amber = visual, sky = command; light and dark theme each get their
  own palette). Insert mode keeps the editor's plain thin caret — no color
  means "you're typing".
- **Block cursor:** on browsers with CSS `caret-shape` support the caret is a
  true vim-style block in normal/visual. The desktop app's current Chromium
  doesn't support it yet, so there you get the thin colored caret + row
  highlight until RemNote upgrades Electron — it will then light up
  automatically.
- Built-in cheat sheet for everything below: type **`:help`** or run **"Vim: Help / cheat sheet"** from the command palette.
  `j`/`k` scroll it, `Esc` closes it.

### Getting started: the Vim Tutorial

The tutorial is an ordinary RemNote document called **"Vim Tutorial"**: 14
short lessons written as bullets, each with practice lines you edit with the
real keys, vimtutor-style. It opens by itself the first time the plugin
activates; reopen it any time with **`:tutorial`** (or `:vimtutor`, or
**"Vim: Tutorial"** in the command palette).

It's yours to wreck — delete it and the next `:tutorial` seeds a fresh copy.
When a plugin update brings new lessons, your copy is replaced with the new
one and the old one is kept as **"Vim Tutorial (old copy)"**, in case you
wrote notes in it.

### Shifted keys

Capitals and shifted symbols are the real vim keys: `A`, `G`, `V`, `$`, `{`,
`:` and so on. RemNote matches them by **physical key on a US layout**, so on
other layouts a few symbols may sit elsewhere (remap them with `:config`).

Keys that mean something different from the original Vim Mode: `:` opens the
command line and `;` repeats `f`/`t` · `V` is line-wise visual and `v` inside
visual exits · `ge` is "end of previous word" · `` ` `` jumps to a mark · `gj`
/ `gk` move down/up · `J` joins · `N` searches backward · `@` plays macros.
Still there as aliases: `gl`=`$` `gh`=`^` `ga`=`A` `go`=`O` `gf`=`F` `gq`=`@`.

<sub>In RemNote a bullet is one line, so `o`/`O` create a **sibling**
bullet and `{`/`}` stop at empty bullets.</sub>

### Keybinding cheat sheet

| Category | Keys |
|---|---|
| **Modes** | `i a I A` insert · `Esc` normal · `v` charwise visual · `V` visual-line (or `v` then `j`/`k`) · `:` command line · `Space` search |
| **Motions** | `h l 0 ^ $ w b e W B E ge gE` · `f<c> t<c> F<c> T<c>` · `;` / `,` repeat find / reversed · `gg G` · `{ }` previous/next empty bullet · counts (`3w`, `2fx`, `2}`) |
| **Operators** | `d c y > <` + any motion/text-object · `x X s S D C` · `r<c>` replace char · `~` toggle case · `dd cc yy >> <<` |
| **Text objects** | `iw aw iW aW` · pairs `i( a(` (`ib`), `i{ a{` (`iB`), `i[ a[` · quotes `i' a' i" a"`, `` i` a` `` — under `d`/`c`/`y` and in visual (`vi[`) |
| **Search** | `Space` + a pattern + `Enter` jumps to the next match anywhere in the document (a regex, case-sensitive) · `n` next · `N` previous · wraps around the ends · `Ctrl-O` jumps back |
| **Macros** | `q<a-z>` record · `q` stop · `@<a-z>` play · `@@` replay the last one · counts (`3@a`) · `qaq` empties a register |
| **Marks** | `m<c>` set · `'<c>` or `` `<c> `` jump back (adds a jumplist entry) · `''` back to pre-jump spot · `:marks` list |
| **Lines / bullets** | `J` join next sibling (adopts its children; `3J`) · `o`/`O` new sibling · `p`/`P` paste below/above · `Y` yank bullet · `C-a`/`C-x` increment/decrement a number |
| **Repeat** | `.` repeat last normal-mode change (`dw`, `3x`, `r<c>`, `p`, `J`, `C-a`, …) |
| **Visual** | charwise `v` + any motion, then `d x c s y p o`, `~` toggle case, `>`/`<` indent, `gs<delim>` wrap in delimiters (`gs(` · `gs"` · `gs[` · `gs{` · `gs<` · `gs'` · ``gs` `` · `gs*` · `gs_`) · visual-line `V` extends across bullets with `j k gg G`; `d`/`x` cut, `y` yank, `p` paste, `>`/`<` indent/outdent · `:` opens the command line with the selected bullets as its range (`:s`, `:sort`, `:d`, …) |
| **Clipboard** | deletes/yanks route through the **native OS clipboard** (whole bullets serialize as RemNote's own `- bullet` text, subtrees included) |
| **Navigation** | `C-o`/`C-i` jumplist back/forward · `C-h`/`C-l` focus previous/next pane · `C-d`/`C-u` scroll half-page · `zt` `zz` `zb` (and `z<CR>` `z.`) put the cursor line at the top / middle / bottom of the screen |
| **Undo** | `u` undo · `C-r` redo (delegates to RemNote's history) |

### Ex command line (`:`)

Open with **`:`** (RemNote keeps `/` for its own slash menu). Tab cycles a
**wildmenu** of suggestions with live document search.

| Command | Does |
|---|---|
| `:help` | Open the cheat-sheet window (`j`/`k` scroll, `Esc` closes) |
| `:tutorial` / `:vimtutor` | Open the Vim Tutorial practice document |
| `:10` (any number) | Jump to that bullet, counted from the top of the document (a jump — `Ctrl-O` returns) |
| `:e <name>` | Search your knowledge base and open the best match (a jump) |
| `:s/pat/repl/[gia]` | Substitute — visual selection or focused bullet as range; `g` all, `i` ignore-case, `a` whole doc |
| `:sort [n] [rev]` / `:sort!` | Sort selection siblings (or the focused bullet's children); `n` numeric, `rev` or `!` reversed |
| `:t` / `:co[py]` | Duplicate the selected bullets below |
| `:d` / `:y` | Delete / yank bullets to the register + OS clipboard (like `dd`/`yy`) |
| `:g/pat/d` | Delete every bullet in the doc whose text matches (subtree included) |
| `:marks` | List current marks in a toast |
| `:vsplit` `:split` `:q` `:only` | Pane management — `:vs <name>` / `:sp <name>` open a search match in the new pane; focus follows vim semantics |
| `:w` | Acknowledged no-op (RemNote autosaves) |
| `:config` | Open your keybinding config document (see below) |
| `:map` / `:mapload` | List active mappings + issues / re-apply the config |

### Custom keybindings (`:config`)

Your keybindings live in a normal RemNote document called **"Vim Keymap"** —
`:config` jumps to it (and creates it on first use), you edit it *with vim
itself*, and it applies automatically when you focus away from the document
(`:mapload` re-applies it any time; `Ctrl-O` jumps back). One mapping per
bullet, vim style:

```
" comments start with a double quote
nmap - $           " '-' jumps to end of line
nmap s cw          " 's' = change word
nmap H ^           " shifted keys work on the left side too
map <c-n> j        " normal + visual modes
vmap q <esc>       " visual modes only
nmap <space> :     " space as a command-line leader
unmap ,            " give ',' back to RemNote (normal+visual)
```

The verbs are `map` (normal + both visual modes), `nmap`, `vmap`, and
`unmap`/`nunmap`/`vunmap` to release a key back to RemNote (`noremap`
spellings work too — every mapping here is noremap: the right side is never
re-expanded, so loops are impossible). Later lines win. `:map` lists what's
active plus any parse errors with their bullet numbers.

**Left side** (the key you press) — one key only: a character (capitals and
shifted symbols included; write `<lt>` for `<`), `<space>`, `<cr>`, `<bs>`,
`<tab>`, or a `<c-x>` ctrl chord. Digits are counts, and Escape is reserved.

**Right side** — up to 32 keys in the same notation, fed to the engine
directly. Whitespace separates tokens (write `<space>` to press space).
Counts and operators compose: with `nmap - $`, `3-` and `d-` behave like
`3$` / `d$`.

Fine print:

- Mappings also apply while an operator is pending (that's what makes `d-`
  work), so remapping `i`/`a`/`f`/`t`/`g` changes their `d`/`c`/`y`-sequence
  roles too (`nmap i x` breaks `diw`) — vim's separate `omap` doesn't exist
  here (yet).
- Keys are *not* remapped while vim waits for a literal character (`f`, `r`,
  `m`, `'`), in insert mode, or in the command line.
- An `unmap`ped key is fully native again — but if you press it while `f`/`r`
  waits for a character, it types into the document (the pending stays armed).
- You can't lock yourself out: Escape and insert-mode typing are untouchable,
  and the command palette always has **"Vim: Edit keybindings (:config)"**
  (plus "Vim: Toggle vim mode"). Unmapping `:` without another route to the
  command line earns you a warning. Want the pre-0.3 `;` command line back?
  `nmap ; :`.
- `<c-w>` never reaches the desktop app (Electron eats it); `<c-e>`/`<c-y>`
  are RemNote's audio-embed hotkeys — you'll get a warning if you bind them.

### Command palette and settings

| Palette command | Does |
|---|---|
| **Vim: Toggle vim mode** | Turn the plugin's key handling off / back on |
| **Vim: Help / cheat sheet** | Same as `:help` |
| **Vim: Edit keybindings (:config)** | Same as `:config` — reachable even if a mapping broke `:` |
| **Vim: Tutorial (interactive practice document)** | Same as `:tutorial` |

One setting, on the plugin's settings page: **Start in normal mode** (on by
default). Turn it off to start in insert mode instead.

---

## Known limitations

Most of these come from what a plugin is *allowed* to do inside RemNote's
sandbox (the gory details live in
[DEVELOPMENT.md](DEVELOPMENT.md) §9):

- **Shifted keys assume a US layout** — RemNote matches them by physical
  key. Remap with `:config` if a symbol lands elsewhere on your keyboard.
- **Macros and `.` can't replay typed text.** Insert-mode typing goes straight
  to RemNote, never through the plugin, so a macro records the commands
  around it but not the text, and changes that enter insert mode (`cw`, `o`)
  aren't dot-repeatable. Build macros from normal-mode commands.
- **Pasting charwise text drops rem references, images and LaTeX** (they
  can't be rebuilt from plain text). Whole-bullet `dd`/`yy`/`p` keep
  everything.
- **Caret column can desync** after clicking mid-line (the collapsed caret is
  unreadable from the sandbox). Re-anchor with `0`/`$`, or enter+leave insert.
- **`Ctrl-E`/`Ctrl-Y`** are unbound — there is no view-scroll API to hook.
- **`zt`/`zz`/`zb` scroll by walking the cursor** off-screen and back
  (RemNote scrolls it into view), since plugins can't scroll the page. You'll
  see the page move for a moment; the cursor ends where it started.
- **`j`/`k` move between bullets**, because a RemNote bullet is one line by
  construction.
- The charwise-visual selection is a real text selection, so RemNote's floating
  formatting toolbar may pop up over it (harmless).
- **RemNote may show an error popup when the plugin unloads** — on disable,
  uninstall or update, or when you change the plugin's options on RemNote's
  Plugins page (its debug log says `Minified React error #185`). That's a bug
  in RemNote's key-capture code, which loops whenever a plugin that captured
  keys is unloaded, so the plugin can't prevent it. Dismiss the popup: the
  plugin still switches off and back on normally. Tracked in
  [Vim Mode #1](https://github.com/onegraund/remnote-vim/issues/1).

## Privacy

This plugin runs **entirely inside RemNote**. It does not send your notes, keys,
or any other data to a server or third-party service — there is no network code.
The only "external" surface is your **operating-system clipboard**, which yanks
and deletes write to (exactly as you'd expect from a vim yank).

---

## Development

```
src/engine/     pure vim state machine (no RemNote) — the tested core
src/adapter/    engine ⇄ RemNote plugin API (key stealing, editor ops, model),
                plus the keymap parser and the tutorial's lesson content
src/widgets/    plugin entry point (onActivate / onDeactivate) + the :help widget
tests/          Vitest: engine suites against a fake editor, adapter suites
                against a fake RemNote plugin
e2e/            live end-to-end harness driving the real app over CDP
public/         manifest.json
```

See
[**DEVELOPMENT.md**](DEVELOPMENT.md) for the architecture deep-dive, the
platform constraints, how to add commands, and the work log (mostly
inherited from the original project; its §9 shift-blindness finding is
corrected at the top); see [**CONTRIBUTING.md**](CONTRIBUTING.md) for the
workflow, and [**CHANGELOG.md**](CHANGELOG.md) for what changed when.

### Test

```bash
npm run check-types  # tsc
npm test             # unit tests (Vitest) — fast, deterministic, no RemNote
npm run e2e          # live end-to-end against a running RemNote (local only)
```

The live harness needs RemNote running with a debug port, today's Daily
Document open, and a **test account** in `e2e/.env`
(`cp e2e/.env.example e2e/.env`). It types real keystrokes into one scratch
bullet, checks the result via RemNote's read-only data API, and cleans up after
itself. See DEVELOPMENT.md §7. These suites come from the original project
and haven't been updated for this fork's key changes (they still type `;` for
the command line, for example), so expect failures until they are.

### Build a distributable zip

```bash
npm run build        # → PluginZip.zip
```

## License

[MIT](LICENSE). The original Vim Mode is © 2026 onegraund; this fork's
changes are © 2026 Tiago Flora.
