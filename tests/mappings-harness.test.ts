/**
 * L2 — user mappings through the REAL engine (Harness + expandSym), covering
 * expansion semantics end-to-end below the adapter. The core pattern is
 * EQUIVALENCE: a mapped key sequence must leave the editor in exactly the
 * state of typing its expansion raw — that's the definition of noremap.
 */
import { describe, expect, it } from 'vitest';
import { parseMappings } from '../src/adapter/mappings';
import { Harness } from './harness';

const DOC = ['alpha bravo charlie', 'second line here', 'third row words'];

function mapped(cfgLines: string[], doc = DOC, row = 0, caret = 0) {
  const h = new Harness([...doc], row, caret);
  h.setMappings(parseMappings(cfgLines).config);
  return h;
}

function raw(doc = DOC, row = 0, caret = 0) {
  return new Harness([...doc], row, caret);
}

function snapshotOf(h: Harness) {
  return {
    lines: h.lines,
    row: h.row,
    caret: h.caret,
    mode: h.mode,
    lastEx: h.lastEx,
    clipboard: h.clipboard,
    marks: h.marks,
  };
}

/** Assert `seq` under `cfgLines` ≡ `rawSeq` with no mappings. */
function equiv(cfgLines: string[], seq: string, rawSeq: string, doc = DOC, caret = 0) {
  const a = mapped(cfgLines, doc, 0, caret);
  a.keys(seq);
  const b = raw(doc, 0, caret);
  b.keys(rawSeq);
  expect(snapshotOf(a), `${cfgLines.join('; ')} :: '${seq}' vs '${rawSeq}'`).toEqual(snapshotOf(b));
}

describe('motion mapping (nmap - gl)', () => {
  it('bare motion, operator compositions and yank+paste are equivalent', () => {
    equiv(['nmap - gl'], '-', 'gl');
    equiv(['nmap - gl'], 'd-', 'dgl');
    equiv(['nmap - gl'], 'c-woo<esc>', 'cglwoo<esc>');
    equiv(['nmap - gl'], 'y-p', 'yglp');
  });
  it('rhs may use syms untypeable live ($ = shift-blind bypass)', () => {
    equiv(['nmap - $'], '-', 'gl'); // engine $ ≡ the gl synonym
    equiv(['nmap - $'], 'd-', 'dgl');
  });
});

describe('counts compose with mappings', () => {
  it('count before the mapped key applies to the expansion', () => {
    equiv(['nmap s w'], '3s', '3w');
    equiv(['nmap s w'], '2s', 'ww');
  });
  it('operator + count + mapped motion', () => {
    equiv(['nmap s w'], 'd2s', 'd2w');
  });
});

describe('pending states consume literal keys (no expansion)', () => {
  it('f{mapped} finds the literal char', () => {
    equiv(['nmap - gl'], 'f-', 'f-', ['a-b-c']);
    // and produces a real find: caret lands on the '-' (compare against fb on a
    // doc where '-' sits where 'b' does — same column)
    const h = mapped(['nmap - gl'], ['a-b']);
    const control = raw(['axb']);
    h.keys('f-');
    control.keys('fx');
    expect(h.caret).toBe(control.caret);
  });
  it('r{mapped} replaces with the literal char', () => {
    equiv(['nmap - gl'], 'r-', 'r-', ['abc']);
    const h = mapped(['nmap - gl'], ['abc']);
    h.keys('r-');
    expect(h.lines[0]).toBe('-bc');
  });
  it('m{mapped} and \'{mapped} use the literal mark name', () => {
    const h = mapped(['nmap - gl'], DOC);
    h.keys('m-');
    expect(Object.keys(h.marks)).toEqual(['-']);
    h.keys("j'-");
    expect(h.row).toBe(0);
  });
  it('g-pending is immune: remapping l does not break the gl chord', () => {
    const h = mapped(['nmap l h'], ['abcdef'], 0, 3);
    h.keys('l'); // expands to h → left
    expect(h.caret).toBe(2);
    const before = h.caret;
    h.keys('gl'); // g-chord must still reach EOL, not g+h
    const control = raw(['abcdef'], 0, before);
    control.keys('gl');
    expect(h.caret).toBe(control.caret);
  });
  it('operator-pending DOES expand (documented v1 rule): nmap i x changes diw', () => {
    equiv(['nmap i x'], 'diw', 'dxw', ['alpha bravo'], 2);
  });
});

describe('mode scoping', () => {
  it('vmap-only mapping is inert in normal mode', () => {
    const h = mapped(['vmap - gl'], DOC);
    const before = snapshotOf(h);
    h.keys('-');
    expect(snapshotOf(h)).toEqual(before);
  });
  it('vmap shapes the charwise selection', () => {
    equiv(['vmap , gl'], 'v,d', 'vgld', ['alpha bravo']);
  });
  it('map works in both normal and visual', () => {
    equiv(['map , gl'], ',', 'gl');
    equiv(['map , gl'], 'v,y', 'vgly');
  });
  it('no expansion while typing in the command line', () => {
    const h = mapped(['nmap w gl'], DOC);
    h.keys(':w<cr>'); // 'w' is command-line text, not the mapped motion
    expect(h.lastEx).toBe('w');
  });
});

describe('noremap: single-level expansion, never recursive', () => {
  it('nmap a x + nmap x j: a acts as raw x, x acts as raw j', () => {
    equiv(['nmap a x', 'nmap x j'], 'a', 'x', ['word here']);
    equiv(['nmap a x', 'nmap x j'], 'x', 'j');
  });
});

describe('leader-style command mapping', () => {
  it('map <space> : opens the command line; typed verb executes', () => {
    const h = mapped(['map <space> :'], DOC);
    h.keys('<space>w<cr>');
    expect(h.lastEx).toBe('w');
    expect(h.mode).toBe('normal');
  });
  it('rhs can be a whole Ex command including <cr>', () => {
    const h = mapped(['nmap = :sort<cr>'], DOC);
    h.keys('=');
    expect(h.lastEx).toBe('sort');
  });
});

describe('rhs named keys', () => {
  it('vmap q <esc> leaves visual mode', () => {
    const h = mapped(['vmap q <esc>'], DOC, 0, 2);
    h.keys('v');
    expect(h.mode).toBe('visual');
    h.keys('q');
    expect(h.mode).toBe('normal');
  });
});

describe('dot-repeat records the expansion (raw syms)', () => {
  it('nmap q x: q then . deletes two chars', () => {
    const h = mapped(['nmap q x'], ['abcd']);
    h.keys('q');
    expect(h.lines[0]).toBe('bcd');
    h.keys('.');
    expect(h.lines[0]).toBe('cd');
  });
  it('replay is immune to later remapping of the recorded syms', () => {
    const h = mapped(['nmap q x'], ['abcd']);
    h.keys('q');
    expect(h.lines[0]).toBe('bcd');
    // x itself now remapped to j — the recorded change must still replay raw x
    h.setMappings(parseMappings(['nmap q x', 'nmap x j']).config);
    h.keys('.');
    expect(h.lines[0]).toBe('cd');
    expect(h.row).toBe(0);
  });
});
