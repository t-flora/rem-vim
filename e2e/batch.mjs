#!/usr/bin/env node
// Live probe for the 2026-07 feature batch: space-search (+ n/z repeat),
// :N goto-line, gf backward find, visual case toggle (backtick), gs visual
// surround, and :vs/:q pane management. Same harness conventions as run.mjs
// (single narrative in today's Daily Document, badge-counter idle waits,
// read-only assertions through the in-page data API).
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import { resolveDailyDocId } from './docid.mjs';

const PORT = process.env.REMNOTE_CDP_PORT ?? '9222';
const SETTLE = Number(process.env.VIM_E2E_SETTLE ?? 900);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);

async function findPage() {
  const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => !/^devtools|^chrome-extension/.test(p.url()));
  for (let i = 0; i < 20; i++) {
    for (const p of pages) {
      const ok = await p.evaluate(() => typeof window.currentFocusedRem !== 'undefined').catch(() => false);
      if (ok) return p;
    }
    await pages[0]?.waitForTimeout(500);
  }
  return null;
}
const page = await findPage();
if (!page) { console.error('✗ RemNote app page not found.'); process.exit(2); }

await page.evaluate(() =>
  document.querySelector('.rn-editor-container')?.classList.remove('pointer-events-none'));
await page.bringToFront();

const wait = (ms) => page.waitForTimeout(ms);
const dbg = () => page.evaluate(() => getComputedStyle(document.body, '::before').content.replace(/\\?"/g, ''));
const badge = () => page.evaluate(() => getComputedStyle(document.body, '::after').content.replace(/\\?"/g, ''));
if (!/NORMAL|INSERT|VISUAL/.test(await badge())) {
  console.error('✗ Vim plugin not active (no mode badge). Load & enable the dev plugin.');
  process.exit(2);
}

async function counters() {
  const m = (await dbg()).match(/rx=(\d+) done=(\d+)/);
  return m ? { rx: +m[1], done: +m[2] } : { rx: 0, done: 0 };
}
async function waitIdle(timeout = 6000) {
  const start = Date.now();
  let stable = 0, last = -1;
  while (Date.now() - start < timeout) {
    const { rx, done } = await counters();
    if (rx === done && done === last) { if (++stable >= 2) return; } else stable = 0;
    last = done;
    await wait(60);
  }
}
async function mode() {
  const m = (await badge()).match(/NORMAL|INSERT|V-LINE|VISUAL/);
  return m ? m[0] : '?';
}
async function waitMode(target, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if ((await mode()) === target) return; await wait(60); }
}
async function press(key) { await page.keyboard.press(key, { delay: 10 }); }
async function keys(seq) {
  const map = { esc: 'Escape', cr: 'Enter', bs: 'Backspace', space: 'Space' };
  let i = 0;
  while (i < seq.length) {
    if (seq[i] === '<') { const j = seq.indexOf('>', i); await press(map[seq.slice(i + 1, j).toLowerCase()]); i = j + 1; }
    else { await press(seq[i] === ' ' ? 'Space' : seq[i]); i++; }
    await wait(45);
  }
  await waitIdle();
  await wait(420);
}
async function insertType(text) {
  // insert mode releases stolen keys asynchronously — settle before typing
  await waitMode('INSERT');
  await wait(SETTLE);
  await page.keyboard.type(text, { delay: 60 });
  await wait(200);
}
async function readOwn() {
  return page.evaluate(async () => {
    const r = window.currentFocusedRem && window.currentFocusedRem();
    if (!r) return null;
    try { return ((await r.getText()) ?? []).map((x) => (typeof x === 'string' ? x : '')).join(''); }
    catch { return null; }
  });
}

// A fresh launch restores whatever page was last open (run.mjs assumes
// today's daily note already is). If the open page's title isn't
// date-shaped, open today's doc through the PLUGIN API — the main page has
// no route to it (the sidebar may not even be in the DOM), but the plugin's
// index iframe does: it's a cross-origin OOPIF playwright can't
// frame-attach to, reached over raw CDP instead (own /json/list target).
// A scratch KB may have no daily note for today at all (RemNote creates it
// on visiting the daily view) — then a plain document with today's title is
// created: resolveDailyDocId accepts any date-shaped title.
async function pluginEval(expr) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find((x) => x.url.includes('widgetName=index'));
  if (!t) throw new Error('plugin index iframe target not found');
  const sock = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res) => sock.on('open', res));
  const reply = new Promise((res) => sock.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.id === 1) res(m);
  }));
  sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  const r = await reply;
  sock.close();
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
}
async function ensureTodayOpen() {
  const onDatePage = await page.evaluate(() => {
    const href = decodeURIComponent(location.href);
    const tail = href.match(/-([A-Za-z0-9]+)$/)?.[1] ?? href.split('/').pop();
    try {
      const cur = window.Rem(window.CURRENT_KNOWLEDGE_BASE).findOne(tail);
      const text = (cur?.key ?? []).map((x) => (typeof x === 'string' ? x : '')).join('');
      return /[A-Z][a-z]+ \d+(st|nd|rd|th), \d{4}/.test(text);
    } catch { return false; }
  });
  if (onDatePage) return;
  await pluginEval(`(async () => {
    const p = window.__vim.plugin;
    let d = await p.date.getTodaysDoc();
    if (!d) {
      const day = new Date().getDate();
      const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
      const title = new Date().toLocaleString('en-US', { month: 'long' }) + ' ' + day + suffix + ', ' + new Date().getFullYear();
      d = await p.rem.createRem();
      await d.setText([title]);
      await d.setIsDocument(true);
    }
    await p.window.openRem(d);
  })()`);
  console.log("· opened today's daily note via the plugin API");
  await wait(2500);
}
await ensureTodayOpen();

const DOC_ID = await resolveDailyDocId(page);
if (!DOC_ID) { console.error('✗ No daily document id in the URL.'); process.exit(2); }
console.log('· scoped to daily doc', DOC_ID);

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

// Focus the first bullet of the daily doc (same click dance as run.mjs).
// A just-created daily note is empty — seed one bullet via the plugin API
// so there is something to click into (the probe builds its own fixtures).
const findFirstBullet = () =>
  page.evaluate((docId) => {
    for (const c of document.querySelectorAll('.EditorContainer')) {
      const id = c.closest('[data-rem-id]')?.getAttribute('data-rem-id');
      if (!id) continue;
      let cur = window.Rem(window.CURRENT_KNOWLEDGE_BASE).findOne(id);
      for (let hop = 0; cur && hop < 12; hop++) {
        if (cur._id === docId || cur.parent === docId) {
          const r = c.getBoundingClientRect();
          if (r.width || r.height) return { x: r.x + Math.min(25, r.width / 2 + 5), y: r.y + r.height / 2 };
        }
        cur = window.Rem(window.CURRENT_KNOWLEDGE_BASE).findOne(cur.parent);
      }
    }
    return null;
  }, DOC_ID);
let first = await findFirstBullet();
if (!first) {
  await pluginEval(`(async () => {
    const p = window.__vim.plugin;
    const kid = await p.rem.createRem();
    await kid.setParent('${DOC_ID}', 0);
    await kid.setText(['probe scratch']);
  })()`);
  await wait(2000);
  first = await findFirstBullet();
}
if (!first) { console.error('✗ No bullet found in the daily doc to focus.'); process.exit(2); }
// A freshly launched window can swallow the first synthetic clicks even
// after bringToFront — click until a rem actually reports focused.
let focusedOk = false;
for (let i = 0; i < 10 && !focusedOk; i++) {
  await page.bringToFront();
  await page.mouse.click(first.x, first.y);
  await wait(600);
  focusedOk = (await readOwn()) != null;
}
if (!focusedOk) { console.error('✗ Could not focus a bullet in the daily doc.'); process.exit(2); }
await keys('<esc>');
await waitMode('NORMAL');

// ---- fixtures: three probe bullets at the end of the doc ----
console.log('· creating probe bullets');
await keys('ge'); // bottom of document
for (const line of ['probe alpha one', 'probe bravo two', 'probe charlie one']) {
  await keys('o');
  await insertType(line);
  await keys('<esc>');
  await waitMode('NORMAL');
}
check('fixtures in place (focused = last probe bullet)', await readOwn(), 'probe charlie one');

// ---- space-search ----
console.log('· space-search');
await keys('<space>');
const searchBadge = await badge();
check('search prompt renders in the badge', /\//.test(searchBadge), true);
await keys('bravo<cr>');
check('space bravo <CR> jumps to the match (wrapping upward)', await readOwn(), 'probe bravo two');
await keys('<space>one<cr>');
check('search "one" lands on the next match below', await readOwn(), 'probe charlie one');
await keys('n');
check('n wraps forward to the earlier "one"', await readOwn(), 'probe alpha one');
await keys('z');
check('z steps back (wraps to the bottom match)', await readOwn(), 'probe charlie one');
await keys('<space>zzz<esc>');
check('Escape cancels a search without moving', await readOwn(), 'probe charlie one');
check('mode back to NORMAL after cancel', await mode(), 'NORMAL');

// ---- :N goto-line ----
console.log('· :N goto-line');
// DOM order of the doc's bullets = the visual row order :N counts in.
const rows = await page.evaluate((docId) => {
  const out = [];
  for (const c of document.querySelectorAll('.EditorContainer')) {
    const id = c.closest('[data-rem-id]')?.getAttribute('data-rem-id');
    if (!id) continue;
    let cur = window.Rem(window.CURRENT_KNOWLEDGE_BASE).findOne(id);
    let inDoc = false;
    for (let hop = 0; cur && hop < 12; hop++) {
      if (cur._id === docId || cur.parent === docId) { inDoc = true; break; }
      cur = window.Rem(window.CURRENT_KNOWLEDGE_BASE).findOne(cur.parent);
    }
    if (!inDoc) continue;
    const r = c.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    out.push(c.textContent.replace(/[  ​]/g, ' ').trim());
  }
  return out;
}, DOC_ID);
const norm = (s) => (s ?? '').replace(/[  ​]/g, ' ').trim();
await keys(';1<cr>');
check(':1 jumps to the first bullet', norm(await readOwn()), rows[0]);
await keys(`;${rows.length}<cr>`);
check(`:${rows.length} jumps to the last bullet`, norm(await readOwn()), rows[rows.length - 1]);
await keys(';999<cr>');
check(':999 clamps to the last bullet', norm(await readOwn()), rows[rows.length - 1]);

// ---- gf backward find + case toggle + gs surround ----
console.log('· gf / case toggle / gs');
await keys('o');
await insertType('abcabc');
await keys('<esc>');
await waitMode('NORMAL');
await keys('glgfbx'); // end of line, find 'b' backward (lands ON it), delete it
check('gf finds backward and lands on the char', await readOwn(), 'abcac');
await keys('0vll`');
check('visual backtick toggles case of the selection', await readOwn(), 'ABCac');
await keys('0vglgs9');
check('gs9 wraps the selection in parens', await readOwn(), '(ABCac)');
check('back in NORMAL after surround', await mode(), 'NORMAL');

// ---- panes (the gt/gp/gn/gc/gm chords were removed as redundant aliases;
// :vs/:q are the canonical bindings, Ctrl-H/Ctrl-L cycle focus) ----
console.log('· panes :vs/:q');
const paneSplit = () => page.evaluate(() => /\)_\(/.test(location.hash + location.pathname + location.search + location.href));
const before = await paneSplit();
await keys(';vs<cr>');
await wait(800);
const afterSplit = await paneSplit();
check(':vs opens a split pane', !before && afterSplit, true);
await keys(';q<cr>');
await wait(800);
check(':q closes it again', await paneSplit(), false);

console.log(`\nRESULT: ${pass}/${pass + fail} live checks passed`);
process.exit(fail ? 1 : 0);
