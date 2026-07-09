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
