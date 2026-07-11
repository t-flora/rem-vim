import { declareIndexPlugin, ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { VimAdapter } from '../adapter/adapter';

let adapter: VimAdapter | undefined;

/** Synced-storage key marking that the getting-started tutorial has been shown. */
const TUTORIAL_SEEN_KEY = 'vim-tutorial-seen';

/** Floating widget id of the open tutorial, if any (so re-running the command re-focuses it). */
let tutorialWidgetId: string | null = null;

async function openTutorial(plugin: ReactRNPlugin) {
  if (tutorialWidgetId && (await plugin.window.isFloatingWidgetOpen(tutorialWidgetId))) {
    return;
  }
  tutorialWidgetId = await plugin.window.openFloatingWidget(
    'vim_tutorial',
    { top: 40, left: 60 },
    undefined,
    true // close when clicking outside
  );
}

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

  // the getting-started tutorial — opened once automatically, reachable
  // afterward via the "Vim: Tutorial" command
  await plugin.app.registerWidget('vim_tutorial', WidgetLocation.FloatingWidget, {
    dimensions: { width: 760, height: 640 },
  });

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
    name: 'Vim: Tutorial (getting started guide)',
    action: async () => {
      await openTutorial(plugin);
    },
  });

  const startNormal = await plugin.settings.getSetting<boolean>('start-in-normal');
  await adapter.start(startNormal ? 'normal' : 'insert');
  console.debug('[vim] plugin activated, mode:', adapter.mode);

  // First install (or first activation after an update predating this
  // setting): pop the getting-started tutorial once. The widget itself
  // marks TUTORIAL_SEEN_KEY true on mount, so this only fires until the
  // user has actually seen it once, however it was opened.
  const tutorialSeen = await plugin.storage.getSynced<boolean>(TUTORIAL_SEEN_KEY);
  if (!tutorialSeen) {
    await openTutorial(plugin);
  }

  // e2e hook: lets the Playwright driver reach the plugin API inside
  // this widget iframe to create test rems and assert editor state.
  (window as unknown as Record<string, unknown>).__vim = { plugin, adapter };
}

async function onDeactivate(_: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);
