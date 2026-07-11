/**
 * Runtime stand-in for @remnote/plugin-sdk under vitest (see
 * vitest.config.ts): the real bundle needs a browser (`self`) and cannot be
 * imported in node. Only the VALUES the adapter actually uses at runtime
 * live here — the enum members below. Their string values are arbitrary but
 * must be internally consistent: the adapter, the fake plugin and the tests
 * all import THIS module, so comparisons and event keys line up.
 *
 * Types (RNPlugin, RichTextInterface, …) are erased at transform time and
 * keep typechecking against the real SDK — do not add them here.
 */
export const AppEvents = {
  StealKeyEvent: 'StealKeyEvent',
  FocusedRemChange: 'FocusedRemChange',
  EditorTextEdited: 'EditorTextEdited',
} as const;

export const MoveUnit = {
  CHARACTER: 'CHARACTER',
} as const;

export const SelectionType = {
  Text: 'Text',
  Rem: 'Rem',
} as const;

export const WidgetLocation = {
  FloatingWidget: 'FloatingWidget',
} as const;

/**
 * Widget-module support (index.tsx / vim_tutorial.tsx / vim_help.tsx import
 * these as VALUES, and renderWidget/declareIndexPlugin run at module scope).
 * The stubs record instead of rendering so tests can reach the component
 * function and the activate/deactivate callbacks directly.
 */
export const __stub = {
  renderedWidget: null as null | ((...args: never[]) => unknown),
  onActivate: null as null | ((plugin: unknown) => Promise<void>),
  onDeactivate: null as null | ((plugin: unknown) => Promise<void>),
  /** What usePlugin() returns inside a component under test. */
  pluginForHooks: null as unknown,
};

export function renderWidget(component: (...args: never[]) => unknown) {
  __stub.renderedWidget = component;
}

export function declareIndexPlugin(
  onActivate: (plugin: unknown) => Promise<void>,
  onDeactivate: (plugin: unknown) => Promise<void>
) {
  __stub.onActivate = onActivate;
  __stub.onDeactivate = onDeactivate;
}

export function usePlugin() {
  return __stub.pluginForHooks;
}
