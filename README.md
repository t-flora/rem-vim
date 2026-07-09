# remnote-vim

**Modal, vim-style editing for the [RemNote](https://www.remnote.com) desktop app**, as a RemNote plugin.

[![CI](https://github.com/onegraund/remnote-vim/actions/workflows/ci.yml/badge.svg)](https://github.com/onegraund/remnote-vim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Normal / insert / visual modes, motions, operators, counts, registers, text
objects, marks, dot-repeat, an Ex command line, and native clipboard
integration — driven entirely by the keyboard, right inside your RemNote notes.

https://github.com/user-attachments/assets/8df3a3c7-82cf-4f7d-a025-0d31f13e1263

> **Desktop only.** RemNote's plugin sandbox can't steal keys reliably on
> mobile, so the plugin declares `enableOnMobile: false`.

---

## Install

### From the RemNote Plugin Store *(once published)*

In RemNote: **Settings → Plugins → Explore**, search for **"Vim Mode"**, and
install. Then toggle it on from the command palette
(**"Vim: Toggle vim mode"**).

### From source (development build)

```bash
npm install
npm run dev          # webpack-dev-server on http://localhost:8080
```

In RemNote: **Settings → Plugins → Build → Develop from localhost**, enter
`http://localhost:8080/`, click **Develop**, and turn on the **"Vim Mode"**
toggle. A `-- NORMAL --` badge appears bottom-right when it's active.

---

## Using it

- Toggle the whole thing on/off: command palette → **"Vim: Toggle vim mode"**.
- The mode badge (bottom-right) shows the current mode: `-- NORMAL --`,
  `-- INSERT --`, `-- VISUAL --`, etc.
- The **caret and the focused row are tinted in the mode color** (violet =
  normal, amber = visual, sky = command; light and dark theme each get their
  own palette). Insert mode keeps the editor's plain thin caret — no color
  means "you're typing".
- **Block cursor:** on browsers with CSS `caret-shape` support the caret is a
  true vim-style block in normal/visual. The desktop app's current Chromium
  doesn't support it yet, so there you get the thin colored caret + row
  highlight until RemNote upgrades Electron — it will then light up
  automatically.
- Built-in cheat sheet for everything below: type **`;help`** (this plugin's
  `:help`) or run **"Vim: Help / cheat sheet"** from the command palette.

### The one thing to know first: Shift-blind keys

RemNote's plugin sandbox **cannot see the Shift key** when it intercepts
keystrokes. So capitals and shifted symbols are reached through lowercase
**`g`-chord synonyms** instead of Shift:

| You want (vim) | Type here | | You want (vim) | Type here |
|---|---|---|---|---|
| `$` (end of line) | `gl` | | `G` (last line) | `ge` |
| `^` (first non-blank) | `gh` | | `A` (append at end) | `ga` |
| `O` (open above)* | `go` | | `~` (toggle case) | `` ` `` (backtick) |

<sub>*In RemNote a bullet is one line, so `o`/`go` both create a **sibling**
bullet.</sub>

### Keybinding cheat sheet

| Category | Keys |
|---|---|
| **Modes** | `i` insert · `Esc` normal · `v` charwise visual · `vv` visual-line (or `v` then `j`/`k`) · `;` command line |
| **Motions** | `h l 0 w b e` · `f<c>` `t<c>` · `,` (repeat find, reversed) · counts (`3w`) · `gh`=`^` `gl`=`$` `gg` `ge`=`G` |
| **Operators** | `d c y` + any motion/text-object · `x X s S D C` · `r<c>` replace char · `` ` ``=`~` toggle case · `dgl`=`d$` `dgh`=`d^` |
| **Text objects** | `iw aw` · pairs `ib ab` (=`i(`/`a(`), `i[ a[` · quotes `i' a'`, `` i` a` `` — under `d`/`c`/`y` and in visual (`vi[`) |
| **Marks** | `m<c>` set · `'<c>` jump back (adds a jumplist entry) · `''` back to pre-jump spot · `:marks` list |
| **Lines / bullets** | `gj`=`J` join next sibling (adopts its children; `3gj`) · `o`/`go` new sibling · `C-a`/`C-x` increment/decrement a number |
| **Repeat** | `.` repeat last normal-mode change (`dw`, `3x`, `r<c>`, `p`, `gj`, `C-a`, …) |
| **Visual** | charwise `v` + `h l w b e f gl gh` then `d x c s y p o` · visual-line extends across bullets with `j k gg ge`; `d`/`x` cut, `y` yank, `p` paste, `.`/`,` indent/outdent |
| **Clipboard** | deletes/yanks route through the **native OS clipboard** (whole bullets serialize as RemNote's own `- bullet` text, subtrees included) |
| **Navigation** | `C-o`/`C-i` jumplist back/forward · `C-h`/`C-l` focus previous/next pane · `C-d`/`C-u` scroll half-page |
| **Undo** | `u` undo · `C-r` redo (delegates to RemNote's history) |

### Ex command line (`;`)

Open with **`;`** (RemNote keeps `/` for its own slash menu). Tab cycles a
**wildmenu** of suggestions with live document search.

| Command | Does |
|---|---|
| `:help` | Open the cheat-sheet widget |
| `:e <name>` | Search the document and open the matching bullet (a jump) |
| `:s/pat/repl/[gia]` | Substitute — visual selection or focused bullet as range; `g` all, `i` ignore-case, `a` whole doc |
| `:sort [n] [rev]` | Sort selection siblings (or the focused bullet's children); `n` numeric, `rev` reversed |
| `:t` / `:co[py]` | Duplicate the selected bullets below |
| `:d` / `:y` | Delete / yank bullets to the register + OS clipboard (like `dd`/`yy`) |
| `:g/pat/d` | Delete every bullet in the doc whose text matches (subtree included) |
| `:marks` | List current marks in a toast |
| `:vsplit` `:split` `:q` `:only` | Pane management (focus follows vim semantics) |
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
nmap - gl          " '-' jumps to end of line
nmap s cw          " 's' = change word
map <c-n> j        " normal + visual modes
vmap q <esc>       " visual modes only
nmap <space> ;     " space as a command-line leader
unmap ,            " give ',' back to RemNote (normal+visual)
```

The verbs are `map` (normal + both visual modes), `nmap`, `vmap`, and
`unmap`/`nunmap`/`vunmap` to release a key back to RemNote (`noremap`
spellings work too — every mapping here is noremap: the right side is never
re-expanded, so loops are impossible). Later lines win. `:map` lists what's
active plus any parse errors with their bullet numbers.

**Left side** (the key you press) — one key only: an unshifted character,
`<space>`, `<cr>`, `<bs>`, `<tab>`, or a `<c-x>` ctrl chord. Shifted keys
(`$`, capitals…) can never be captured (see Shift-blind keys above), digits
are counts, and Escape is reserved.

**Right side** — up to 32 keys in the same notation, *including keys you
can't type live*: the right side feeds the engine directly, so `nmap - $`
gives you a real `$`, and `G`, `A`, `~` etc. all work. Whitespace separates
tokens (write `<space>` to press space). Counts and operators compose:
with `nmap - gl`, `3-` and `d-` behave like `3gl` / `dgl`.

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
  (plus "Vim: Toggle vim mode"). Unmapping `;` without another route to the
  command line earns you a warning.
- `<c-w>` never reaches the desktop app (Electron eats it); `<c-e>`/`<c-y>`
  are RemNote's audio-embed hotkeys — you'll get a warning if you bind them.

---

## Known limitations

Most of these come from what a plugin is *allowed* to do inside RemNote's
sandbox (the gory details live in [DEVELOPMENT.md](./DEVELOPMENT.md) §9):

- **Capitals/symbols need synonyms** — the Shift-blind remaps above; `i{`/`i"`
  exist in the engine but can't be typed live. (`:config` mappings can put
  any of these on keys you like — `nmap - $`.)
- **Caret column can desync** after clicking mid-line (the collapsed caret is
  unreadable from the sandbox). Re-anchor with `0`/`gl`, or enter+leave insert.
- **`Ctrl-E`/`Ctrl-Y`** are unbound — there is no view-scroll API to hook.
- **`j`/`k` move between bullets**, because a RemNote bullet is one line by
  construction.
- The charwise-visual selection is a real text selection, so RemNote's floating
  formatting toolbar may pop up over it (harmless).

## Privacy

This plugin runs **entirely inside RemNote**. It does not send your notes, keys,
or any other data to a server or third-party service — there is no network code.
The only "external" surface is your **operating-system clipboard**, which yanks
and deletes write to (exactly as you'd expect from a vim yank).

---

## Development

```
src/engine/     pure vim state machine (no RemNote) — the tested core
src/adapter/    engine ⇄ RemNote plugin API (key stealing, editor ops, model)
src/widgets/    plugin entry point (onActivate) + the :help widget
tests/          Vitest unit suite for the engine
e2e/            live end-to-end harness driving the real app over CDP
public/         manifest.json
```

See [**DEVELOPMENT.md**](./DEVELOPMENT.md) for the architecture deep-dive, the
platform constraints, how to add commands, and the work log; see
[**CONTRIBUTING.md**](./CONTRIBUTING.md) for the workflow.

### Test

```bash
npm run check-types  # tsc
npm test             # engine unit tests (Vitest) — fast, deterministic, no RemNote
npm run e2e          # live end-to-end against a running RemNote (local only)
```

The live harness needs RemNote running with a debug port, today's Daily
Document open, and a **test account** in `e2e/.env`
(`cp e2e/.env.example e2e/.env`). It types real keystrokes into one scratch
bullet, checks the result via RemNote's read-only data API, and cleans up after
itself. See DEVELOPMENT.md §7.

### Build a distributable zip

```bash
npm run build        # → PluginZip.zip (upload this to the Plugin Store)
```

## License

[MIT](./LICENSE) © onegraund
