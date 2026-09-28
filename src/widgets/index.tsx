import { declareIndexPlugin, ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { VimAdapter } from '../adapter/adapter';

let adapter: VimAdapter | undefined;

/** Synced-storage key marking that the tutorial document was auto-opened once. */
const TUTORIAL_SEEN_KEY = 'vim-tutorial-seen';

async function onActivate(plugin: ReactRNPlugin) {
  await plugin.settings.registerBooleanSetting({
    id: 'start-in-normal',
    title: 'Start in normal mode',
    defaultValue: true,
  });

  // the :help window (fixed height — 'auto' collapses floating widgets to 0)
  await plugin.app.registerWidget('vim_help', WidgetLocation.FloatingWidget, {
    dimensions: { width: 690, height: 620 },
  });

  // A repeat activation in the same iframe must not leave the previous
  // adapter's listeners and steal-heal timer running next to the new one.
  await adapter?.stop();
  adapter = new VimAdapter(plugin);

  await plugin.app.registerCommand({
    id: 'vim-toggle',
    name: 'Vim: Toggle vim mode',
    action: async () => {
      await adapter?.toggle();
    },
  });

  await plugin.app.registerCommand({
    id: 'vim-help',
    name: 'Vim: Help / cheat sheet',
    action: async () => {
      await adapter?.openHelp();
    },
  });

  // Mouse-reachable recovery path: even a config that unmapped ';' (no way
  // to type ':config') can be fixed from the command palette.
  await plugin.app.registerCommand({
    id: 'vim-config',
    name: 'Vim: Edit keybindings (:config)',
    action: async () => {
      await adapter?.openConfig();
    },
  });

  await plugin.app.registerCommand({
    id: 'vim-tutorial',
    name: 'Vim: Tutorial (interactive practice document)',
    action: async () => {
      await adapter?.openTutorial();
    },
  });

  const startNormal = await plugin.settings.getSetting<boolean>('start-in-normal');
  await adapter.start(startNormal ? 'normal' : 'insert');
  console.debug('[vim] plugin activated, mode:', adapter.mode);

  // First install (or first activation after an update predating this
  // setting): open the "Vim Tutorial" practice document once, vimtutor
  // style — the lessons are real bullets edited with the real bindings.
  // The flag is set only after the open succeeds, so a failed first attempt
  // retries on the next activation. `:tutorial` / the palette command reopen
  // it (or re-seed a fresh copy if the user deleted it) any time after.
  const tutorialSeen = await plugin.storage.getSynced<boolean>(TUTORIAL_SEEN_KEY);
  if (!tutorialSeen) {
    await adapter.openTutorial();
    await plugin.storage.setSynced(TUTORIAL_SEEN_KEY, true);
  }

  // e2e hook: lets the Playwright driver reach the plugin API inside
  // this widget iframe to create test rems and assert editor state.
  (window as unknown as Record<string, unknown>).__vim = { plugin, adapter };
}

// Disable / uninstall. Was a no-op, which left the steal-heal timer
// re-stealing keys for an unloading plugin (issue #1) — see VimAdapter.stop.
async function onDeactivate(_: ReactRNPlugin) {
  const a = adapter;
  adapter = undefined;
  await a?.stop();
}

declareIndexPlugin(onActivate, onDeactivate);
