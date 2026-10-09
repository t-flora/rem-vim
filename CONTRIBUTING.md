# Contributing to rem-vim

Thanks for wanting to help. This plugin brings modal, vim-style editing to the
RemNote desktop app; it's a fork of
[Vim Mode](https://github.com/OneGraund/remnote-vim) by onegraund. The short version of how to work on it is below;
[**DEVELOPMENT.md**](./DEVELOPMENT.md) is the full deep-dive (architecture, the
platform constraints that shape every design decision, and concrete recipes for
adding commands or debugging live).

## Getting set up

```bash
git clone https://github.com/t-flora/rem-vim
cd rem-vim
npm install
npm run dev          # webpack-dev-server on http://localhost:8080
```

Then in RemNote: **Settings → Plugins → Build → Develop from localhost**, enter
`http://localhost:8080/`, click **Develop**, and turn on the "rem-vim" toggle.
A `-- NORMAL --` badge appears bottom-right when it's active.

## The one rule that keeps this codebase sane

Keep the two halves separate:

- **`src/engine/`** is a synchronous, pure state machine —
  `(VimState, key, {text, caret}) → (VimState, Action[])`. It has never heard of
  RemNote, awaits nothing, and touches no DOM. This is where vim *semantics*
  live, and it's exhaustively unit-tested with a fake editor.
- **`src/adapter/`** is the only code that talks to the RemNote plugin SDK. It
  turns stolen keys into engine symbols, runs the engine, and executes the
  returned `Action`s against RemNote.

New motion / operator / mode behavior → `src/engine/` (with tests). New way of
talking to RemNote (an `Action` case, an SDK call, a key to steal) →
`src/adapter/`. See DEVELOPMENT.md §1–§2.

## Tests

```bash
npm run check-types   # tsc
npm test              # unit tests (Vitest) — fast, deterministic, no RemNote
npm run e2e           # live end-to-end against a running RemNote (local only)
```

CI runs the type-check, unit tests, and a production build on every PR. The
**engine suite is the contract** — add or update tests for any behavior you
change. The live `e2e/` harness needs a running RemNote with a debug port and a
test account (`cp e2e/.env.example e2e/.env`); it can't run in CI. See
DEVELOPMENT.md §7 for how to drive it.

## Before you open a PR

- `npm run check-types` and `npm test` are green.
- If the change is user-visible, update the `:help` sheet
  (`src/widgets/vim_help.tsx`), the README, and the feature status in
  DEVELOPMENT.md §0.5, and add a line under an "Unreleased" heading in
  CHANGELOG.md.
- If you touched the tutorial's lessons (`src/adapter/tutorialDoc.ts`), bump
  `TUTORIAL_VERSION` — the suite fails until you do, and users' copies are
  replaced on upgrade.
- Note whether you live-verified in the real app — many bugs only show up
  against RemNote's async data layer, not the fake editor (DEVELOPMENT.md §6, §9).

## Releasing (maintainers)

The plugin is live on the RemNote Plugin Store and this repo's README is its
public documentation, so a release is more than a push:

1. **Check the scope first:** `git fetch && git log --oneline origin/main..main`
   is everything the push will publish — make sure the docs below cover all
   of it, not just the latest change.
2. Bump the version in **both** `package.json` and `public/manifest.json`.
3. `CHANGELOG.md`: turn "Unreleased" into the new version, dated. Call out
   anything that changes existing keys under "Upgrading" / "Changed".
4. README (features, cheat sheet, Ex table, limitations), the `:help` sheet,
   DEVELOPMENT.md §0.5, and the manifest `description` (the store listing)
   match what ships. The store rejects a `description` over 200 characters
   (`tests/manifest.test.ts` checks it and the other schema limits).
5. Tutorial lessons changed? `TUTORIAL_VERSION` bumped (the suite enforces it).
6. `npm run check-types`, `npm test`, `npm run build` all green; live-check
   the build in RemNote (the debug readout shows `vim <version>@…`).
7. Merge to `main`, push, wait for CI.
8. `gh release create v<version> PluginZip.zip` with that version's CHANGELOG
   section as the notes.
9. Upload the same `PluginZip.zip` to the RemNote Plugin Store. RemNote
   reviews it before it goes live, so the store lags the GitHub release for
   a while — say so in the release notes.

## Reporting bugs

Use the issue templates. Check `:help` and the README's "Known limitations"
before filing — it might be working as designed (for example, shifted keys
assume a US keyboard layout).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
