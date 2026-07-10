import { describe, expect, it } from 'vitest';
import { ATOMIC_CH } from '../src/engine/motions';
import type { Pending } from '../src/engine/types';
import {
  effectiveSpecs,
  emptyConfig,
  expandSym,
  listMappingLines,
  MapConfig,
  parseLhs,
  parseMappings,
  renderKeys,
  specToSymTable,
  tokenizeKeys,
} from '../src/adapter/mappings';

const NONE: Pending = { p: 'none' };

function parse(...lines: string[]) {
  return parseMappings(lines);
}
function errors(r: ReturnType<typeof parseMappings>) {
  return r.diagnostics.filter((d) => d.severity === 'error');
}
function warnings(r: ReturnType<typeof parseMappings>) {
  return r.diagnostics.filter((d) => d.severity === 'warning');
}

// ------------------------------------------------------------ tokenizeKeys

describe('tokenizeKeys (shared notation)', () => {
  it('splits plain chars', () => {
    expect(tokenizeKeys('dw')).toEqual(['d', 'w']);
  });
  it('maps named keys', () => {
    expect(tokenizeKeys('<esc><cr><enter><bs><space><tab>')).toEqual([
      'Escape', 'Enter', 'Enter', 'Backspace', ' ', 'Tab',
    ]);
  });
  it('maps any ctrl-letter chord generically', () => {
    expect(tokenizeKeys('<c-r><c-j>')).toEqual(['C-r', 'C-j']);
    expect(tokenizeKeys('<C-R>')).toEqual(['C-r']); // case-insensitive
  });
  it('<lt> is a literal <', () => {
    expect(tokenizeKeys('<lt>')).toEqual(['<']);
  });
  it('unknown or unterminated <...> falls through as literal chars (harness compat)', () => {
    expect(tokenizeKeys('<f1>')).toEqual(['<', 'f', '1', '>']);
    expect(tokenizeKeys('a<b')).toEqual(['a', '<', 'b']);
  });
});

// ------------------------------------------------------------ parseLhs

describe('parseLhs', () => {
  it('accepts lowercase letters and stealable punctuation', () => {
    expect(parseLhs('x')).toEqual({ sym: 'x', spec: 'x' });
    for (const ch of [';', ',', '.', '`', "'", '[', ']', '/', '-', '=', '\\']) {
      expect(parseLhs(ch)).toEqual({ sym: ch, spec: ch });
    }
  });
  it('accepts named keys with their steal specs', () => {
    expect(parseLhs('<space>')).toEqual({ sym: ' ', spec: 'space' });
    expect(parseLhs('<cr>')).toEqual({ sym: 'Enter', spec: 'enter' });
    expect(parseLhs('<bs>')).toEqual({ sym: 'Backspace', spec: 'backspace' });
    expect(parseLhs('<tab>')).toEqual({ sym: 'Tab', spec: 'tab' });
  });
  it('accepts ctrl chords', () => {
    expect(parseLhs('<c-j>')).toEqual({ sym: 'C-j', spec: 'ctrl+j' });
    expect(parseLhs('<C-J>')).toEqual({ sym: 'C-j', spec: 'ctrl+j' });
  });
  it('rejects digits (counts)', () => {
    expect(parseLhs('5')).toHaveProperty('error');
    expect((parseLhs('5') as { error: string }).error).toMatch(/counts/);
  });
  it('rejects capitals and shifted symbols with a shift-blind explanation', () => {
    for (const ch of ['A', 'V', '$', '^', '~', '_', ':', '?', '{', '"']) {
      const r = parseLhs(ch) as { error: string };
      expect(r.error, ch).toMatch(/shift/i);
    }
  });
  it('rejects <esc>, multi-key sequences, non-ASCII, unknown named keys', () => {
    expect((parseLhs('<esc>') as { error: string }).error).toMatch(/reserved/);
    expect((parseLhs('gw') as { error: string }).error).toMatch(/ONE key/);
    expect(parseLhs('é')).toHaveProperty('error');
    expect(parseLhs('🙂')).toHaveProperty('error');
    expect(parseLhs('<f1>')).toHaveProperty('error');
    expect(parseLhs('<c-5>')).toHaveProperty('error');
  });
});

// ------------------------------------------------------------ parseMappings

describe('parseMappings: verbs and scoping', () => {
  it('nmap fills normal only', () => {
    const { config } = parse('nmap - gl');
    expect(config.maps.normal['-']).toEqual(['g', 'l']);
    expect(config.maps.visual['-']).toBeUndefined();
    expect(config.maps['visual-line']['-']).toBeUndefined();
    expect(config.mapSpecs.normal['-']).toBe('-');
  });
  it('vmap fills both visual modes', () => {
    const { config } = parse('vmap q <esc>');
    expect(config.maps.visual['q']).toEqual(['Escape']);
    expect(config.maps['visual-line']['q']).toEqual(['Escape']);
    expect(config.maps.normal['q']).toBeUndefined();
  });
  it('map fills all three', () => {
    const { config } = parse('map <c-n> j');
    for (const m of ['normal', 'visual', 'visual-line'] as const) {
      expect(config.maps[m]['C-n']).toEqual(['j']);
      expect(config.mapSpecs[m]['C-n']).toBe('ctrl+n');
    }
  });
  it('noremap synonyms work (all our maps are noremap)', () => {
    const { config, diagnostics } = parse('nnoremap - gl', 'vnoremap q <esc>', 'noremap = j');
    expect(diagnostics).toEqual([]);
    expect(config.maps.normal['-']).toEqual(['g', 'l']);
    expect(config.maps.visual['q']).toEqual(['Escape']);
    expect(config.maps['visual-line']['=']).toEqual(['j']);
  });
  it('verbs are case-insensitive (config doc is typed in insert mode)', () => {
    const { config, diagnostics } = parse('NMAP - gl');
    expect(diagnostics).toEqual([]);
    expect(config.maps.normal['-']).toEqual(['g', 'l']);
  });
  it('comments and blank lines are skipped', () => {
    const { config, diagnostics } = parse('', '   ', '" nmap - gl', '"comment');
    expect(diagnostics).toEqual([]);
    expect(Object.keys(config.maps.normal)).toEqual([]);
  });
  it('unmap releases per scope and unmap verbs scope like map verbs', () => {
    const { config } = parse('nunmap ,', 'vunmap .');
    expect(config.unmapSpecs.normal.has(',')).toBe(true);
    expect(config.unmapSpecs.visual.has(',')).toBe(false);
    expect(config.unmapSpecs.visual.has('.')).toBe(true);
    expect(config.unmapSpecs['visual-line'].has('.')).toBe(true);
    expect(config.unmapSpecs.normal.has('.')).toBe(false);
  });
});

describe('parseMappings: last-wins overrides', () => {
  it('later map overrides earlier map', () => {
    const { config } = parse('nmap - gl', 'nmap - gh');
    expect(config.maps.normal['-']).toEqual(['g', 'h']);
  });
  it('unmap cancels an earlier map (and its steal spec)', () => {
    const { config } = parse('nmap - gl', 'nunmap -');
    expect(config.maps.normal['-']).toBeUndefined();
    expect(config.mapSpecs.normal['-']).toBeUndefined();
    expect(config.unmapSpecs.normal.has('-')).toBe(true);
  });
  it('map cancels an earlier unmap', () => {
    const { config } = parse('nunmap ,', 'nmap , gl');
    expect(config.unmapSpecs.normal.has(',')).toBe(false);
    expect(config.maps.normal[',']).toEqual(['g', 'l']);
  });
  it('scoped override: vmap then nunmap leaves the visual maps alone', () => {
    const { config } = parse('vmap q <esc>', 'nunmap q');
    expect(config.maps.visual['q']).toEqual(['Escape']);
    expect(config.unmapSpecs.normal.has('q')).toBe(true);
  });
});

describe('parseMappings: errors', () => {
  it('every lhs rejection surfaces as an error and skips the line', () => {
    const r = parse('nmap 5 j', 'nmap A j', 'nmap $ j', 'nmap <esc> j', 'nmap gw j');
    expect(errors(r)).toHaveLength(5);
    expect(Object.keys(r.config.maps.normal)).toEqual([]);
    expect(errors(r).map((d) => d.line)).toEqual([1, 2, 3, 4, 5]);
  });
  it('missing lhs / missing rhs / unmap-with-rhs', () => {
    const r = parse('nmap', 'nmap -', 'nunmap - gl');
    expect(errors(r)).toHaveLength(3);
    expect(errors(r)[1].message).toMatch(/right-hand side/);
    expect(errors(r)[2].message).toMatch(/no right-hand side/);
  });
  it('bad rhs: unknown named key, unterminated <, too long', () => {
    const long = 'j'.repeat(33);
    const r = parse('nmap - <f1>', 'nmap - a<b', `nmap - ${long}`);
    expect(errors(r)).toHaveLength(3);
    expect(errors(r)[0].message).toMatch(/unknown key <f1>/);
    expect(errors(r)[1].message).toMatch(/unterminated/);
    expect(errors(r)[2].message).toMatch(/too long/);
  });
  it('reserved vim verbs get the not-supported error', () => {
    const r = parse('imap jk <esc>', 'omap i x', 'xmap q y', 'cmap w q');
    expect(errors(r)).toHaveLength(4);
    expect(errors(r)[0].message).toMatch(/not supported/);
  });
  it('an atomic chip in the line is a diagnostic, not a crash', () => {
    const r = parse(`nmap ${ATOMIC_CH} j`, `${ATOMIC_CH}map - j`);
    expect(errors(r).length + warnings(r).length).toBe(2);
    expect(Object.keys(r.config.maps.normal)).toEqual([]);
  });
  it('rhs at exactly 32 keys is accepted', () => {
    const r = parse(`nmap - ${'j'.repeat(32)}`);
    expect(errors(r)).toEqual([]);
    expect(r.config.maps.normal['-']).toHaveLength(32);
  });
});

describe('parseMappings: warnings', () => {
  it('unknown verb is a warning, not an error', () => {
    const r = parse('bogus - j');
    expect(errors(r)).toEqual([]);
    expect(warnings(r)).toHaveLength(1);
    expect(warnings(r)[0].message).toMatch(/unknown verb 'bogus'/);
  });
  it('hazard lhs specs warn but still map', () => {
    const r = parse('nmap <c-w> j', 'nmap <c-e> j', 'nmap <c-y> j', 'nmap / j');
    expect(errors(r)).toEqual([]);
    expect(warnings(r)).toHaveLength(4);
    expect(r.config.maps.normal['C-w']).toEqual(['j']);
    expect(r.config.maps.normal['/']).toEqual(['j']);
  });
  it('unmap of a key that is not bound warns', () => {
    const r = parse('nunmap =');
    expect(warnings(r)).toHaveLength(1);
    expect(warnings(r)[0].message).toMatch(/not bound/);
  });
  it('unmap of a previously mapped non-base key does not warn', () => {
    const r = parse('nmap = gl', 'nunmap =');
    expect(warnings(r)).toEqual([]);
  });
  it('the ; safety net fires on unmap ; and on remapping ;', () => {
    expect(warnings(parse('unmap ;')).some((w) => w.message.includes('command line'))).toBe(true);
    expect(warnings(parse('nmap ; gl')).some((w) => w.message.includes('command line'))).toBe(true);
  });
  it('the ; safety net is silenced by a rescue mapping whose rhs starts with ;', () => {
    const r = parse('unmap ;', 'nmap <space> ;');
    expect(warnings(r).filter((w) => w.message.includes('command line'))).toEqual([]);
  });
  it('the ; safety net is silent when ; is untouched', () => {
    expect(warnings(parse('nmap - gl'))).toEqual([]);
  });
});

// ------------------------------------------------------------ expandSym

describe('expandSym gate', () => {
  const cfg = parse('map - gl').config;
  it('expands in each normal-family mode', () => {
    for (const mode of ['normal', 'visual', 'visual-line'] as const) {
      expect(expandSym(cfg, { mode, pending: NONE }, '-')).toEqual(['g', 'l']);
    }
  });
  it('never expands in insert or command mode', () => {
    expect(expandSym(cfg, { mode: 'insert', pending: NONE }, '-')).toBeNull();
    expect(expandSym(cfg, { mode: 'command', pending: NONE }, '-')).toBeNull();
  });
  it('suspends for every literal-consuming pending', () => {
    const pendings: Pending[] = [
      { p: 'g' },
      { p: 'replace' },
      { p: 'find', key: 'f' },
      { p: 'textobj', key: 'i' },
      { p: 'pane' },
      { p: 'mark' },
      { p: 'gotoMark' },
    ];
    for (const pending of pendings) {
      expect(expandSym(cfg, { mode: 'normal', pending }, '-'), pending.p).toBeNull();
    }
  });
  it('unmapped syms pass through as null', () => {
    expect(expandSym(cfg, { mode: 'normal', pending: NONE }, 'x')).toBeNull();
  });
  it('nmap-only mapping is inert in visual mode', () => {
    const n = parse('nmap - gl').config;
    expect(expandSym(n, { mode: 'visual', pending: NONE }, '-')).toBeNull();
  });
});

// ------------------------------------------------------------ effectiveSpecs

describe('effectiveSpecs', () => {
  it('empty config returns the base sets untouched', () => {
    const cfg = emptyConfig();
    expect(effectiveSpecs('insert', cfg)).toEqual(['escape']);
    expect(new Set(effectiveSpecs('normal', cfg))).toEqual(
      new Set(effectiveSpecs('visual', cfg))
    );
    expect(effectiveSpecs('command', cfg)).toContain('tab');
    expect(effectiveSpecs('command', cfg)).toContain('/');
  });
  it('mapped lhs are stolen across all three normal-family modes (union rule)', () => {
    const cfg = parse('nmap - gl').config;
    for (const mode of ['normal', 'visual', 'visual-line'] as const) {
      expect(effectiveSpecs(mode, cfg), mode).toContain('-');
    }
    expect(effectiveSpecs('insert', cfg)).toEqual(['escape']);
    // command already steals '-' in base; the point is insert stays clean
  });
  it('ctrl chords join the steal sets', () => {
    const cfg = parse('nmap <c-j> l').config;
    for (const mode of ['normal', 'visual', 'visual-line'] as const) {
      expect(effectiveSpecs(mode, cfg)).toContain('ctrl+j');
    }
    expect(effectiveSpecs('command', cfg)).not.toContain('ctrl+j');
  });
  it('unmap removes the spec only in its modes', () => {
    const cfg = parse('nunmap ,').config;
    expect(effectiveSpecs('normal', cfg)).not.toContain(',');
    expect(effectiveSpecs('visual', cfg)).toContain(',');
    expect(effectiveSpecs('visual-line', cfg)).toContain(',');
  });
  it('per-mode unmap beats the cross-mode union', () => {
    const cfg = parse('vmap - gl', 'nunmap -').config;
    expect(effectiveSpecs('normal', cfg)).not.toContain('-');
    expect(effectiveSpecs('visual', cfg)).toContain('-');
  });
});

// ------------------------------------------------------------ spec→sym, render, :map

describe('specToSymTable', () => {
  it('preserves the base table and adds mapped chords', () => {
    const cfg = parse('nmap <c-j> l').config;
    const table = specToSymTable(cfg);
    expect(table['escape']).toBe('Escape');
    expect(table['ctrl+d']).toBe('C-d');
    expect(table['ctrl+j']).toBe('C-j');
  });
  it('empty config equals the static table plus nothing', () => {
    const table = specToSymTable(emptyConfig());
    expect(table['ctrl+j']).toBeUndefined();
  });
});

describe('renderKeys / listMappingLines', () => {
  it('round-trips through tokenizeKeys', () => {
    const syms = tokenizeKeys('<esc>x<c-j><space>g<lt>');
    expect(tokenizeKeys(renderKeys(syms))).toEqual(syms);
  });
  it(':map listing uses the most specific verb and is valid config syntax', () => {
    const { config } = parse('map <c-n> j', 'nmap - gl', 'vmap q <esc>', 'nunmap ,');
    const lines = listMappingLines(config);
    expect(lines).toContain('map <c-n> j');
    expect(lines).toContain('nmap - gl');
    expect(lines).toContain('vmap q <esc>');
    expect(lines).toContain('nunmap ,');
    expect(lines).toHaveLength(4);
    // round-trip: feeding the listing back reproduces the same tables
    const again = parseMappings(lines).config;
    expect(again.maps).toEqual(config.maps);
    expect([...again.unmapSpecs.normal]).toEqual([...config.unmapSpecs.normal]);
  });
});

describe('search mode (regression: effectiveSpecs threw for mode "search" pre-fix)', () => {
  // The space-search feature was built against the pre-mappings keymap and
  // patched bindingsForMode only; effectiveSpecs then indexed
  // config.unmapSpecs['search'] — undefined — and threw inside applyMode,
  // leaving the search prompt unrendered and '/', '-', '=', tab unstolen.
  it('steals exactly the command-line set (a typed pattern needs every printable)', () => {
    expect(() => effectiveSpecs('search', emptyConfig())).not.toThrow();
    expect(new Set(effectiveSpecs('search', emptyConfig()))).toEqual(
      new Set(effectiveSpecs('command', emptyConfig()))
    );
    const specs = new Set(effectiveSpecs('search', emptyConfig()));
    for (const s of ['/', '-', '=', '\\', 'tab', 'space', 'enter', 'backspace']) {
      expect(specs.has(s)).toBe(true);
    }
  });
  it('never consults the config: maps add nothing, unmaps release nothing', () => {
    const { config } = parseMappings(['nmap <c-j> l', 'unmap x']);
    const specs = new Set(effectiveSpecs('search', config));
    expect(specs.has('ctrl+j')).toBe(false); // mapped lhs not stolen in search
    expect(specs.has('x')).toBe(true); // unmap does not leak into search
  });
  it('expandSym never expands while typing a search pattern', () => {
    const { config } = parseMappings(['map x dd']);
    expect(expandSym(config, { mode: 'search', pending: { p: 'none' } }, 'x')).toBeNull();
  });
});

// type-only usage so the import is exercised
const _cfgType: MapConfig = emptyConfig();
void _cfgType;
