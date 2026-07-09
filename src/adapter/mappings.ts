/**
 * User-configurable key mappings (the `:config` document) — pure logic.
 *
 * This module is deliberately SDK-free (like ./pure.ts) so every rule here is
 * unit-testable: parsing the config lines, deciding when a pressed key
 * expands, and deriving the per-mode steal sets. The adapter owns the I/O
 * (reading the config doc, stealing keys, feeding expanded syms).
 *
 * Semantics are vim's `noremap` family, single level: a mapping replaces ONE
 * pressed key (lhs) with a sequence of canonical engine symbols (rhs), and
 * rhs symbols are never re-expanded — loops are impossible by construction.
 *
 * Two platform facts shape the rules (see keymap.ts header):
 * - Stealing is shift-blind → an lhs must be an unshifted key or a Ctrl
 *   chord; capitals/shifted symbols are rejected with an explanation.
 * - rhs tokens are ENGINE symbols, not keystrokes → they bypass
 *   shift-blindness entirely: `nmap - $` works even though `$` can never be
 *   typed live. This is the main reason the feature exists.
 */
import type { Mode, Pending } from '../engine/types';
import { bindingsForMode, NORMAL_BINDINGS, SPEC_TO_SYM } from './keymap';

/** The modes user mappings can target (insert/command are off limits). */
export type MapMode = 'normal' | 'visual' | 'visual-line';
export const MAP_MODES: readonly MapMode[] = ['normal', 'visual', 'visual-line'];

export interface MapDiagnostic {
  /** 1-based bullet index in the config document. */
  line: number;
  /** The raw config line, for display. */
  text: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface MapConfig {
  /** mode → lhs sym → rhs syms (the expansion table). */
  maps: Record<MapMode, Record<string, string[]>>;
  /** mode → lhs sym → is-hotkey spec (what to steal for that lhs). */
  mapSpecs: Record<MapMode, Record<string, string>>;
  /** mode → specs released back to RemNote (`unmap`). */
  unmapSpecs: Record<MapMode, Set<string>>;
}

export function emptyConfig(): MapConfig {
  return {
    maps: { normal: {}, visual: {}, 'visual-line': {} },
    mapSpecs: { normal: {}, visual: {}, 'visual-line': {} },
    unmapSpecs: { normal: new Set(), visual: new Set(), 'visual-line': new Set() },
  };
}

// ------------------------------------------------------------ key notation

/** `<name>` tokens shared by config rhs, config lhs and the test harness. */
const NAMED_SYMS: Record<string, string> = {
  esc: 'Escape',
  cr: 'Enter',
  enter: 'Enter',
  bs: 'Backspace',
  space: ' ',
  tab: 'Tab',
  lt: '<',
};

/**
 * Lenient tokenizer: '<esc>ab<c-r>' → ['Escape','a','b','C-r']. Unknown or
 * unterminated `<...>` falls through as literal characters (the historical
 * test-harness behavior — harness.ts imports this).
 */
export function tokenizeKeys(seq: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < seq.length) {
    if (seq[i] === '<') {
      const j = seq.indexOf('>', i);
      if (j > i) {
        const name = seq.slice(i + 1, j).toLowerCase();
        const sym = NAMED_SYMS[name] ?? (/^c-[a-z]$/.test(name) ? `C-${name[2]}` : undefined);
        if (sym !== undefined) {
          out.push(sym);
          i = j + 1;
          continue;
        }
      }
    }
    out.push(seq[i]);
    i++;
  }
  return out;
}

/**
 * Strict tokenizer for config rhs: unknown/unterminated `<...>` is an error
 * instead of silently becoming literal characters (a typo like `<c-5>` must
 * not turn into five keypresses).
 */
function tokenizeRhs(seq: string): { syms: string[] } | { error: string } {
  const syms: string[] = [];
  let i = 0;
  while (i < seq.length) {
    if (seq[i] === '<') {
      const j = seq.indexOf('>', i);
      if (j <= i) return { error: "unterminated '<' — write <lt> for a literal '<'" };
      const name = seq.slice(i + 1, j).toLowerCase();
      const sym = NAMED_SYMS[name] ?? (/^c-[a-z]$/.test(name) ? `C-${name[2]}` : undefined);
      if (sym === undefined) {
        return { error: `unknown key <${name}> — named keys: <esc> <cr> <bs> <space> <tab> <c-a>…<c-z> <lt>` };
      }
      syms.push(sym);
      i = j + 1;
      continue;
    }
    syms.push(seq[i]);
    i++;
  }
  return { syms };
}

/** Reverse notation, for `:map` output (round-trips through tokenizeKeys). */
export function renderKeys(syms: string[]): string {
  return syms
    .map((s) => {
      if (s === 'Escape') return '<esc>';
      if (s === 'Enter') return '<cr>';
      if (s === 'Backspace') return '<bs>';
      if (s === ' ') return '<space>';
      if (s === 'Tab') return '<tab>';
      if (s === '<') return '<lt>';
      if (/^C-[a-z]$/.test(s)) return `<c-${s[2]}>`;
      return s;
    })
    .join('');
}

// ------------------------------------------------------------ lhs parsing

/** Unshifted punctuation proven stealable (keymap.ts plainPunct + commandExtra). */
const LHS_PUNCT = new Set([';', ',', '.', '`', "'", '[', ']', '/', '-', '=', '\\']);

/** Shifted US-layout characters — arrive as their unshifted key or not at all. */
const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?'.split(''));

const NAMED_LHS: Record<string, { sym: string; spec: string }> = {
  space: { sym: ' ', spec: 'space' },
  cr: { sym: 'Enter', spec: 'enter' },
  enter: { sym: 'Enter', spec: 'enter' },
  bs: { sym: 'Backspace', spec: 'backspace' },
  tab: { sym: 'Tab', spec: 'tab' },
};

/**
 * Validate a mapping's lhs: exactly one stealable key. Returns the engine
 * symbol it will arrive as plus the is-hotkey spec to steal.
 */
export function parseLhs(token: string): { sym: string; spec: string } | { error: string } {
  if (token.startsWith('<') && token.endsWith('>') && token.length > 2) {
    const name = token.slice(1, -1).toLowerCase();
    if (name === 'esc') return { error: 'Escape is reserved (mode exit) and cannot be remapped' };
    if (/^c-[a-z]$/.test(name)) return { sym: `C-${name[2]}`, spec: `ctrl+${name[2]}` };
    const named = NAMED_LHS[name];
    if (named) return named;
    return { error: `<${name}> cannot be a mapping key — use a plain key, <space>/<cr>/<bs>/<tab>, or <c-a>…<c-z>` };
  }
  if (token.length !== 1) {
    return { error: `'${token}' — the key side must be ONE key (multi-key sequences are not supported in v1)` };
  }
  const ch = token;
  if (/[0-9]/.test(ch)) return { error: 'digits cannot be mapped — they are counts' };
  if (/[a-z]/.test(ch)) return { sym: ch, spec: ch };
  if (/[A-Z]/.test(ch) || SHIFTED.has(ch)) {
    return { error: `'${ch}' needs Shift, which RemNote's key capture cannot see (shift-blind) — map an unshifted key instead` };
  }
  if (LHS_PUNCT.has(ch)) return { sym: ch, spec: ch };
  return { error: `'${ch}' is not a stealable key` };
}

// ------------------------------------------------------------ config parsing

const MAP_VERBS: Record<string, readonly MapMode[]> = {
  map: MAP_MODES,
  noremap: MAP_MODES,
  nmap: ['normal'],
  nnoremap: ['normal'],
  vmap: ['visual', 'visual-line'],
  vnoremap: ['visual', 'visual-line'],
};

const UNMAP_VERBS: Record<string, readonly MapMode[]> = {
  unmap: MAP_MODES,
  nunmap: ['normal'],
  vunmap: ['visual', 'visual-line'],
};

/** Vim verbs we recognize but deliberately do not support. */
const RESERVED_VERBS = new Set([
  'imap', 'inoremap', 'iunmap',
  'cmap', 'cnoremap', 'cunmap',
  'omap', 'onoremap', 'ounmap',
  'xmap', 'xnoremap', 'xunmap',
  'smap', 'map!', 'unmap!',
]);

const HAZARD_SPECS: Record<string, string> = {
  'ctrl+w': 'a real Ctrl-W never reaches the desktop app (Electron eats it)',
  'ctrl+e': "Ctrl-E is RemNote's audio-embed hotkey — stealing it is unverified",
  'ctrl+y': "Ctrl-Y is RemNote's audio-embed hotkey — stealing it is unverified",
  '/': "'/' opens RemNote's slash-command menu — mapping it steals that",
};

const MAX_RHS = 32;

/**
 * Parse config-document lines (one bullet = one line). Later lines win, and
 * `map`/`unmap` of the same key override each other in document order.
 * Errors skip their line; warnings don't. The parse never throws.
 */
export function parseMappings(lines: string[]): { config: MapConfig; diagnostics: MapDiagnostic[] } {
  const config = emptyConfig();
  const diagnostics: MapDiagnostic[] = [];
  /** Last line that mapped/unmapped ';' in normal mode (for the safety net). */
  let semicolonLine: { line: number; text: string } | null = null;

  lines.forEach((raw, idx) => {
    const line = idx + 1;
    const text = raw.trim();
    const err = (message: string) => diagnostics.push({ line, text, severity: 'error', message });
    const warn = (message: string) => diagnostics.push({ line, text, severity: 'warning', message });
    if (text === '' || text.startsWith('"')) return;
    const parts = text.split(/\s+/);
    const verb = parts[0].toLowerCase();

    const mapModes = MAP_VERBS[verb];
    const unmapModes = UNMAP_VERBS[verb];
    if (!mapModes && !unmapModes) {
      if (RESERVED_VERBS.has(verb)) {
        err(`'${verb}' is not supported (v1) — only map/nmap/vmap and unmap/nunmap/vunmap`);
      } else {
        warn(`unknown verb '${verb}' — line ignored`);
      }
      return;
    }

    if (parts.length < 2) {
      err(`usage: ${verb} <key>${mapModes ? ' <keys…>' : ''}`);
      return;
    }
    const lhs = parseLhs(parts[1]);
    if ('error' in lhs) {
      err(lhs.error);
      return;
    }
    if (HAZARD_SPECS[lhs.spec]) warn(HAZARD_SPECS[lhs.spec]);

    if (mapModes) {
      if (parts.length < 3) {
        err(`usage: ${verb} <key> <keys…> — missing the right-hand side`);
        return;
      }
      // Whitespace inside the rhs is a separator, not a key — write <space>
      // to press space. This makes `nmap x d i w` readable.
      const rhs = tokenizeRhs(parts.slice(2).join(''));
      if ('error' in rhs) {
        err(rhs.error);
        return;
      }
      if (rhs.syms.length > MAX_RHS) {
        err(`right-hand side too long (${rhs.syms.length} keys, max ${MAX_RHS})`);
        return;
      }
      for (const m of mapModes) {
        config.maps[m][lhs.sym] = rhs.syms;
        config.mapSpecs[m][lhs.sym] = lhs.spec;
        config.unmapSpecs[m].delete(lhs.spec);
      }
      if (lhs.spec === ';' && mapModes.includes('normal')) semicolonLine = { line, text };
    } else if (unmapModes) {
      if (parts.length > 2) {
        err(`${verb} takes no right-hand side`);
        return;
      }
      const hadMap = unmapModes.some((m) => lhs.sym in config.maps[m]);
      const inBase = NORMAL_BINDINGS.some((b) => b.spec === lhs.spec);
      if (!hadMap && !inBase) warn(`'${parts[1]}' is not bound by default — unmap has no effect`);
      for (const m of unmapModes) {
        delete config.maps[m][lhs.sym];
        delete config.mapSpecs[m][lhs.sym];
        config.unmapSpecs[m].add(lhs.spec);
      }
      if (lhs.spec === ';' && unmapModes.includes('normal')) semicolonLine = { line, text };
    }
  });

  // Safety net: don't let a config silently lock the user out of `:` — the
  // command line is how :config/:mapload are reached from the keyboard.
  const semicolonGone =
    config.unmapSpecs.normal.has(';') || ';' in config.maps.normal;
  const rescued = Object.values(config.maps.normal).some((rhs) => rhs[0] === ';');
  if (semicolonGone && !rescued && semicolonLine) {
    diagnostics.push({
      line: semicolonLine.line,
      text: semicolonLine.text,
      severity: 'warning',
      message:
        'no key opens the command line now — :map/:mapload are unreachable by keyboard (the "Vim: Edit keybindings" palette command still works)',
    });
  }

  return { config, diagnostics };
}

// ------------------------------------------------------------ runtime lookups

/**
 * Expansion decision — the ONE place the gate lives (adapter and test
 * harness both call this). A key expands only when it would START a command:
 * never in insert/command mode, and never while the engine is waiting for a
 * continuation key (`f`/`r`/`m`/`'`/`g`/text-object/pane pendings consume
 * the literal key). A pending OPERATOR does expand: with `nmap - gl`,
 * `d-` = `dgl` = `d$`. Counts pass through untouched (`3-` works).
 */
export function expandSym(
  config: MapConfig,
  state: { mode: Mode; pending: Pending },
  sym: string
): string[] | null {
  const mode = state.mode;
  if (mode !== 'normal' && mode !== 'visual' && mode !== 'visual-line') return null;
  if (state.pending.p !== 'none') return null;
  return config.maps[mode][sym] ?? null;
}

/**
 * The specs to steal in `mode`. Mapped lhs are stolen across ALL THREE
 * normal-family modes (union): an nmap-only key left unstolen in visual mode
 * would reach RemNote and REPLACE the live native selection with typed text.
 * Out-of-scope it just arrives raw and is inert to the engine. Unmaps stay
 * strictly per-mode — releasing the key to RemNote is their whole point.
 * Insert and command mode never consult the config.
 */
export function effectiveSpecs(mode: Mode, config: MapConfig): string[] {
  const base = bindingsForMode(mode).map((b) => b.spec);
  if (mode === 'insert' || mode === 'command') return base;
  const specs = new Set(base);
  for (const m of MAP_MODES) {
    for (const spec of Object.values(config.mapSpecs[m])) specs.add(spec);
  }
  for (const spec of config.unmapSpecs[mode as MapMode]) specs.delete(spec);
  return [...specs];
}

/**
 * spec → engine sym for the steal listener: the static table plus every
 * mapped lhs (a `ctrl+j` lhs is not in the base table and would otherwise be
 * dropped on arrival).
 */
export function specToSymTable(config: MapConfig): Record<string, string> {
  const table: Record<string, string> = { ...SPEC_TO_SYM };
  for (const m of MAP_MODES) {
    for (const [sym, spec] of Object.entries(config.mapSpecs[m])) table[spec] = sym;
  }
  return table;
}

/**
 * `:map` listing — one line per distinct mapping/unmap, most-specific verb
 * (our verbs can only produce {normal}, {both visuals} or {all three} mode
 * sets). Output is itself valid config syntax.
 */
export function listMappingLines(config: MapConfig): string[] {
  const out: string[] = [];
  const verbFor = (modes: MapMode[], mapVerb: boolean) => {
    const [n, v, vl] = [
      modes.includes('normal'),
      modes.includes('visual'),
      modes.includes('visual-line'),
    ];
    if (n && v && vl) return mapVerb ? 'map' : 'unmap';
    if (v && vl) return mapVerb ? 'vmap' : 'vunmap';
    return mapVerb ? 'nmap' : 'nunmap';
  };
  const seen = new Set<string>();
  for (const m of MAP_MODES) {
    for (const [sym, rhs] of Object.entries(config.maps[m])) {
      const modes = MAP_MODES.filter(
        (mm) => config.maps[mm][sym] !== undefined && renderKeys(config.maps[mm][sym]) === renderKeys(rhs)
      );
      const key = `${modes.join(',')} ${sym}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`${verbFor(modes, true)} ${renderKeys([sym])} ${renderKeys(rhs)}`);
    }
  }
  const seenU = new Set<string>();
  const allUnmapped = new Set([...config.unmapSpecs.normal, ...config.unmapSpecs.visual, ...config.unmapSpecs['visual-line']]);
  for (const spec of allUnmapped) {
    const modes = MAP_MODES.filter((mm) => config.unmapSpecs[mm].has(spec));
    const key = `${modes.join(',')} ${spec}`;
    if (seenU.has(key)) continue;
    seenU.add(key);
    const sym = specToSymTable(emptyConfig())[spec] ?? spec;
    out.push(`${verbFor(modes, false)} ${renderKeys([sym])}`);
  }
  return out;
}
