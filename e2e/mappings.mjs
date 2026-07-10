#!/usr/bin/env node
// Live e2e for user-configurable keybindings (:config / the "Vim Keymap" doc).
//
// Drives real keystrokes over CDP (run.mjs conventions: daily-doc scoping,
// rx/done badge settling, text-proof assertions — a caret claim is proven by
// typing at it) and reaches the plugin sandbox (globalThis.__vimAdapter) via
// a raw CDP websocket (sdk-repl.mjs pattern) to seed/inspect the config doc.
//
// Phases:
//   (default)   full narrative; LEAVES the config doc pinned with 'nmap - gl'
//               so a follow-up relaunch can prove activation persistence.
//   --persist   run right after a fresh app relaunch: the pinned mapping must
//               work with NO :mapload; then swaps the doc to the
//               non-overlapping 'nmap <c-j> gl' for the regression gates.
//   --cleanup   delete the config doc + unpin (restores the no-config state).
//
// Prereqs identical to run.mjs: app on --remote-debugging-port (9223 here),
// dev plugin loaded+enabled, today's Daily Document open. NEVER send
// Ctrl+E/Ctrl+Y (RemNote audio embed).
import { chromium } from 'playwright-core';
import WebSocket from '../node_modules/ws/index.js';
import { resolveDailyDocId, dailyPaneScope } from './docid.mjs';

const PHASE = process.argv.includes('--persist')
  ? 'persist'
  : process.argv.includes('--cleanup')
    ? 'cleanup'
    : 'main';
const PORT = process.env.REMNOTE_CDP_PORT ?? '9223';
const SETTLE = Number(process.env.VIM_E2E_SETTLE ?? 900);
const TYPE_DELAY = Number(process.env.VIM_E2E_TYPE ?? 130);

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
  const map = { esc: 'Escape', cr: 'Enter', bs: 'Backspace', space: 'Space', 'c-r': 'Control+r', 'c-o': 'Control+o', 'c-j': 'Control+j', tab: 'Tab' };
  let i = 0;
  while (i < seq.length) {
    if (seq[i] === '<') { const j = seq.indexOf('>', i); await press(map[seq.slice(i + 1, j).toLowerCase()]); i = j + 1; }
    else { await press(seq[i] === ' ' ? 'Space' : seq[i]); i++; }
    await wait(45);
  }
  await waitIdle();
  await wait(420);
}
async function readOwn() {
  return page.evaluate(async () => {
    const r = window.currentFocusedRem && window.currentFocusedRem();
    if (!r) return null;
    try { return ((await r.getText()) ?? []).map((x) => (typeof x === 'string' ? x : '')).join(''); }
    catch { return null; }
  });
}

// ---- plugin-sandbox access (sdk-repl.mjs pattern) --------------------------
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const sbTarget = list.find((x) => /localhost:8080/.test(x.url));
if (!sbTarget) { console.error('✗ plugin iframe target not found'); process.exit(2); }
const sbWs = new WebSocket(sbTarget.webSocketDebuggerUrl);
await new Promise((r) => sbWs.on('open', r));
function sbSend(method, params) {
  return new Promise((res) => {
    const id = Math.floor(Math.random() * 1e6);
    const h = (d) => {
      const m = JSON.parse(d);
      if (m.id === id) { sbWs.off('message', h); res(m); }
    };
    sbWs.on('message', h);
    sbWs.send(JSON.stringify({ id, method, params }));
  });
}
/** Run an async body in the sandbox with `a` (adapter) and `p` (plugin). */
async function sandbox(body) {
  const r = await sbSend('Runtime.evaluate', {
    expression: `(async () => {
      const a = globalThis.__vimAdapter;
      if (!a) return { __err: 'NO __vimAdapter' };
      const p = a.plugin;
      try { ${body} } catch (e) { return { __err: String(e) }; }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const v = r.result?.result?.value;
  if (v && v.__err) throw new Error(`sandbox: ${v.__err}`);
  if (r.result?.exceptionDetails) throw new Error(`sandbox: ${r.result.exceptionDetails.text}`);
  return v;
}

/** Make the config doc exist with EXACTLY these lines (extra bullets become
 * comments instead of being removed — SDK removal of rendered rems leaves
 * zombie rows, §9). Creates + pins the doc if missing. Returns the doc id. */
async function setConfigLines(lines) {
  return sandbox(`
    let id = await p.storage.getSynced('vim-keymap-doc-id');
    let doc = id ? await p.rem.findOne(id) : undefined;
    if (!doc) {
      doc = await p.rem.createRem();
      await doc.setText(['Vim Keymap']);
      await doc.setIsDocument(true);
      await p.storage.setSynced('vim-keymap-doc-id', doc._id);
    }
    const want = ${JSON.stringify(lines)};
    const kids = await doc.getChildrenRem();
    for (let i = 0; i < Math.max(kids.length, want.length); i++) {
      const text = i < want.length ? want[i] : '" (unused)';
      if (kids[i]) await kids[i].setText([text]);
      else {
        const kid = await p.rem.createRem();
        await kid.setParent(doc._id, i);
        await kid.setText([text]);
      }
    }
    return doc._id;
  `);
}

// ---- daily-doc scoping (run.mjs) -------------------------------------------
const DOC_ID = await resolveDailyDocId(page);
if (!DOC_ID) {
  console.error("✗ Could not determine the daily document id from the URL. Open today's Daily Document.");
  process.exit(2);
}
const paneScope = () => dailyPaneScope(page, DOC_ID);
console.log(`· phase=${PHASE}, scoped to daily doc ${DOC_ID}`);

async function scopedBullets() {
  return page.evaluate(({ docId, pane }) => {
    const out = [];
    for (const c of document.querySelectorAll(pane + '.EditorContainer')) {
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
      out.push({ text: c.textContent.replace(/ |​/g, ' ').trim(), x: r.x + Math.min(25, r.width / 2 + 5), y: r.y + r.height / 2 });
    }
    return out;
  }, { docId: DOC_ID, pane: await paneScope() });
}

async function focusScratch() {
  const bullets = await scopedBullets();
  const target = bullets[0] ?? { x: 200, y: 167 };
  await page.mouse.click(target.x, target.y);
  await wait(400);
  if ((await mode()) !== 'NORMAL') { await press('Escape'); await waitIdle(); }
}

async function resetEmpty() {
  for (let i = 0; i < 15; i++) {
    const bullets = await scopedBullets();
    const dirty = bullets.find((b) => b.text !== '');
    if (!dirty) break;
    await page.mouse.click(dirty.x, dirty.y);
    await wait(400);
    if ((await mode()) !== 'NORMAL') { await press('Escape'); await waitIdle(); }
    await keys('dd');
  }
  await focusScratch();
}

async function insertType(text) {
  await waitMode('INSERT');
  await waitIdle();
  await wait(SETTLE);
  await page.keyboard.type(text, { delay: TYPE_DELAY });
  await wait(150);
  await press('Escape');
  await waitMode('NORMAL');
  await waitIdle();
}
async function cmdType(cmd, text) {
  await keys(cmd);
  await insertType(text);
}
/** Reset the scratch line to exactly `text`. */
async function line(text) {
  await resetEmpty();
  await press('i');
  await insertType(text);
}

// ---- checks ----------------------------------------------------------------
let pass = 0;
const failures = [];
function check(label, got, want) {
  let ok = false;
  try {
    ok = typeof want === 'function' ? want(got) : got === want;
  } catch {
    ok = false;
  }
  if (ok) { pass++; console.log(`  ✓ ${label} → ${JSON.stringify(got)}`); }
  else { failures.push({ label, got, want: String(want) }); console.log(`  ✗ ${label} → ${JSON.stringify(got)} (want ${JSON.stringify(String(want))})`); }
}
async function expectOwn(label, want) { check(label, await readOwn(), want); }

async function finish() {
  sbWs.close();
  console.log(failures.length ? `\n✗ ${failures.length} failed, ${pass} passed` : `\n✓ all ${pass} checks passed`);
  process.exit(failures.length ? 1 : 0);
}

// ============================================================ cleanup phase
if (PHASE === 'cleanup') {
  await focusScratch(); // keep focus away from the config doc
  const res = await sandbox(`
    const id = await p.storage.getSynced('vim-keymap-doc-id');
    const doc = id ? await p.rem.findOne(id) : undefined;
    if (doc) await doc.remove();
    await p.storage.setSynced('vim-keymap-doc-id', null);
    await a.reloadConfig(false);
    return 'cleaned';
  `);
  check('config doc removed + unpinned', res, 'cleaned');
  const maps = await sandbox(`return Object.keys(a.mapConfig.maps.normal);`);
  check('no mappings active', JSON.stringify(maps), '[]');
  await finish();
}

// ============================================================ persist phase
if (PHASE === 'persist') {
  // The previous (main) phase left the doc pinned with 'nmap - gl'. A fresh
  // app activation must have loaded it with no :mapload typed here.
  // Warm up first — a cold window swallows the first synthetic click/keys.
  await focusScratch();
  await press('i');
  await waitMode('INSERT');
  await press('Escape');
  await waitMode('NORMAL');
  await waitIdle();
  await line('hello world');
  await keys('0-');
  await cmdType('a', 'Z');
  await expectOwn('pinned mapping active right after activation (0 - a Z)', 'hello worldZ');
  const pin = await sandbox(`return await p.storage.getSynced('vim-keymap-doc-id');`);
  check('pin survives restart', typeof pin, 'string');
  // Hand over to the regression gates: a mapping no suite's keys overlap.
  await setConfigLines(['nmap <c-j> gl']);
  await keys(';mapload<cr>');
  const maps = await sandbox(`return Object.keys(a.mapConfig.maps.normal);`);
  check('gate config in place (<c-j> only)', JSON.stringify(maps), '["C-j"]');
  await resetEmpty();
  await finish();
}

// ============================================================ main phase
// Start from a clean slate: a previous run leaves the config doc pinned, and
// a fresh window can swallow the first synthetic click — warm up first.
await sandbox(`
  const id = await p.storage.getSynced('vim-keymap-doc-id');
  const doc = id ? await p.rem.findOne(id) : undefined;
  if (doc) await doc.remove();
  await p.storage.setSynced('vim-keymap-doc-id', null);
  await a.reloadConfig(false);
  return 'reset';
`);
await focusScratch();
await press('i');
await waitMode('INSERT');
await press('Escape');
await waitMode('NORMAL');
await waitIdle();

console.log('· 1: baseline — unmapped "-" is not stolen and types into the line');
await line('hello world');
await expectOwn('setup: scratch line typed', 'hello world');
// caret sits at EOL after insert-exit; keep it there — a '-' at line START
// can trigger RemNote's own markdown-ish transforms and restructure the rem
await press('-');
await waitIdle();
await wait(400);
check('unstolen - reaches RemNote as text', await readOwn(), (t) => !!t && t !== 'hello world' && t.includes('-'));

console.log('· 2: seed config + :mapload — motion, operator, counts');
await setConfigLines(['nmap - gl', 'nmap s w', 'nmap q x']);
await keys(';mapload<cr>');
await line('hello world');
await keys('0-');
await cmdType('a', 'Z');
await expectOwn('nmap - gl: 0 - lands at EOL (a Z appends)', 'hello worldZ');
await keys('0d-');
await expectOwn('d- = d$ deletes to EOL', '');
await line('aa bb cc dd');
await keys('03s');
await cmdType('i', 'X');
await expectOwn('count composes: 3s = 3w', 'aa bb cc Xdd');

console.log('· 3: shift-blind arrival (informational — CDP cannot express it)');
// The shift-blind steal contract ('Q' arrives as 'q', '$' as '4') is REAL-
// INPUT behavior, verified via kernel uinput (see §9 / real-input.mjs).
// CDP-SYNTHESIZED shifted keys bypass that layer and do not match bare steal
// specs at all (probed here 2026-07-10: synthesized Shift+q types "q",
// synthesized Shift+- types "-"). Mappings ride the same steal specs as the
// base bindings, so the real-keyboard guarantee carries over unchanged —
// this block only logs what synthesis does, it asserts nothing.
await setConfigLines(['nmap - gl', 'nmap s w', 'nmap q x']);
await keys(';mapload<cr>');
await line('abc');
await keys('0');
await page.keyboard.down('Shift');
await press('q');
await page.keyboard.up('Shift');
await waitIdle();
await wait(400);
console.log(`  · synthesized Shift+q over CDP → ${JSON.stringify(await readOwn())} (real keyboards: arrives as 'q', §9)`);

console.log('· 4: mapped ctrl chord steals and fires');
await setConfigLines(['nmap - gl', 'nmap <c-j> x']);
await keys(';mapload<cr>');
await line('abc');
await keys('0');
await keys('<c-j>');
await expectOwn('nmap <c-j> x deletes the char under the caret', 'bc');

console.log('· 5: :config creates, seeds, pins and opens the doc (a jump)');
await sandbox(`
  const id = await p.storage.getSynced('vim-keymap-doc-id');
  const doc = id ? await p.rem.findOne(id) : undefined;
  if (doc) await doc.remove();
  await p.storage.setSynced('vim-keymap-doc-id', null);
  await a.reloadConfig(false);
  return 'reset';
`);
await keys(';config<cr>');
await wait(800);
const info = await sandbox(`
  const id = await p.storage.getSynced('vim-keymap-doc-id');
  const doc = id ? await p.rem.findOne(id) : undefined;
  const kids = doc ? await doc.getChildrenRem() : [];
  const paneDoc = await p.window.getOpenPaneRemId(await p.window.getFocusedPaneId());
  return {
    pinned: !!id,
    title: doc ? doc.text.join('') : null,
    seedTexts: kids.slice(0, 3).map((k) => (k.text ?? []).join('').slice(0, 1)),
    opened: paneDoc === id,
  };
`);
check(':config pinned a new doc', info.pinned, true);
check(':config doc title', info.title, 'Vim Keymap');
// RemNote may append an empty trailing bullet when opening a doc — assert the
// three seeds are comments rather than an exact child count.
check(':config seeded comment bullets', JSON.stringify(info.seedTexts), JSON.stringify(['"', '"', '"']));
check(':config opened the doc in the pane', info.opened, true);
await keys('<c-o>');
await wait(600);
const backDoc = await sandbox(`return await p.window.getOpenPaneRemId(await p.window.getFocusedPaneId());`);
check('Ctrl-O returns to the daily doc', backDoc, DOC_ID);

console.log('· 6: editing the doc + focusing away auto-reloads (no :mapload)');
const docId = await setConfigLines(['nmap - gl']);
await keys(';mapload<cr>'); // adopt current content first
await keys(';config<cr>');
await wait(800);
// click the mapping bullet inside the config doc (real focus-in)
const kidId = await sandbox(`
  const doc = await p.rem.findOne(${JSON.stringify(docId)});
  return (await doc.getChildrenRem())[0]._id;
`);
const kidBox = await page.evaluate((id) => {
  const el = document.querySelector(`[data-rem-id="${id}"] .EditorContainer`) ?? document.querySelector(`[data-rem-id="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + Math.min(30, r.width / 2 + 5), y: r.y + r.height / 2 };
}, kidId);
check('config bullet visible for clicking', !!kidBox, true);
if (kidBox) {
  await page.mouse.click(kidBox.x, kidBox.y);
  await wait(500);
  if ((await mode()) !== 'NORMAL') { await press('Escape'); await waitIdle(); }
  await sandbox(`
    const kid = await p.rem.findOne(${JSON.stringify(kidId)});
    await kid.setText(['nmap - gh']);
    return 'edited';
  `);
  await wait(300);
  await keys('<c-o>'); // leave the doc — the transition must reload
  await wait(900);
  await focusScratch();
  await line('hello world');
  await keys('gl-'); // gl to EOL, then '-' should now be gh (col 0)
  await cmdType('i', 'A');
  await expectOwn('focus-leave applied the edit (- now acts as gh)', 'Ahello world');
}

console.log('· 7: unmap returns the key to RemNote; re-map takes it back');
await setConfigLines(['nmap - gl', 'nunmap x']);
await keys(';mapload<cr>');
await line('abc');
await keys('0');
await press('x');
await waitIdle();
await wait(400);
check('unmapped x types into the line', await readOwn(), (t) => !!t && t !== 'abc' && t.includes('x'));
await setConfigLines(['nmap - gl', 'nmap q x']);
await keys(';mapload<cr>');
await line('abcd');
await keys('0x');
await expectOwn('re-stolen x deletes again', 'bcd');

console.log('· 8: dot-repeat records the expansion');
await keys('0q');
await expectOwn('nmap q x: q deletes', 'cd');
await keys('.');
await expectOwn('. repeats the recorded raw x', 'd');

console.log('· 9: vim-toggle off/on');
await sandbox(`await a.toggle(); return 'off';`);
await wait(600);
await press('-'); // toggled off: nothing is stolen, RemNote types it
await wait(600);
check('toggled off: - types natively', await readOwn(), (t) => t != null && t.includes('-'));
await sandbox(`await a.toggle(); return 'on';`);
await wait(600);
await line('hello world');
await keys('0-');
await cmdType('a', 'W');
await expectOwn('toggled back on: mapping expands again', 'hello worldW');

console.log('· 10: :map lists mappings (screenshot) + diagnostics internals');
await keys(';map<cr>');
await wait(400);
await page.screenshot({ path: 'e2e/shots/mappings-map.png' });
const mapState = await sandbox(`
  return { maps: Object.keys(a.mapConfig.maps.normal).sort(), diags: a.mapDiagnostics.length };
`);
check(':map internals — active mappings', JSON.stringify(mapState.maps), JSON.stringify(['-', 'q']));
check(':map internals — no diagnostics for valid config', mapState.diags, 0);

// leave the doc pinned with the persistence mapping for the --persist phase
await setConfigLines(['nmap - gl']);
await keys(';mapload<cr>');
await resetEmpty();
console.log('· left "Vim Keymap" pinned with nmap - gl for the --persist relaunch');
await finish();
