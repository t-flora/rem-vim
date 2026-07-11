#!/usr/bin/env node
// Live probe for the "Vim Tutorial" practice DOCUMENT (vimtutor model):
// auto-open + seed on first activation, pinned id, :tutorial reopen without
// duplicating, and a real practice edit (search for the caaat exercise and
// fix it with fa xx). Resets the seen flag / deletes any existing tutorial
// doc up front, so every run exercises the fresh-seed path and is rerunnable.
// (Reloads the app window — run it AFTER other suites, not before.)
//
// The plugin's index iframe is a cross-origin OOPIF playwright cannot
// frame-attach to; its plugin API is reached over raw CDP instead (each
// iframe is its own /json/list target with a webSocketDebuggerUrl).
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const PORT = process.env.REMNOTE_CDP_PORT ?? '9222';
const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

function connect(wsUrl) {
  const sock = new WebSocket(wsUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  sock.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); sock.send(JSON.stringify({ id: i, method, params })); });
  return new Promise((res) => sock.on('open', () => res({ send, close: () => sock.close() })));
}
const evalIn = async (c, expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description ?? ''));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function indexSession() {
  for (let i = 0; i < 40; i++) {
    const t = (await list().catch(() => [])).find((x) => x.url.includes('widgetName=index'));
    if (t) return connect(t.webSocketDebuggerUrl);
    await sleep(500);
  }
  throw new Error('plugin index iframe target never appeared');
}

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' — ' + String(extra)}`);
};

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => !/^devtools/.test(p.url()));
let page = null;
for (let i = 0; i < 30 && !page; i++) {
  for (const p of pages) {
    if (await p.evaluate(() => typeof window.currentFocusedRem !== 'undefined').catch(() => false)) page = p;
  }
  if (!page) await pages[0]?.waitForTimeout(500);
}
if (!page) { console.error('✗ app page not found'); process.exit(2); }
// RemNote can throw a beforeunload dialog at the reload below; an explicit
// handler avoids playwright's auto-dismiss racing itself (observed live).
page.on('dialog', (d) => d.accept().catch(() => {}));
await page.bringToFront();

// ---- reset: no seen flag, no existing tutorial doc, then seed via the
// adapter's own openTutorial() (the same method :tutorial / the palette
// command / the first-activation auto-open all call). NOTE: the auto-open
// branch itself needs a real plugin (re)activation — reloading the main
// window over CDP makes the Electron app EXIT (observed live twice), so
// that branch is verified by relaunching the app after this script leaves
// `vim-tutorial-seen` false: the next activation must open the pinned doc
// and flip the flag true.
let ci = await indexSession();
const state = await evalIn(ci, `(async () => {
  const p = window.__vim.plugin;
  await p.storage.setSynced('vim-tutorial-seen', false);
  const oldId = await p.storage.getSynced('vim-tutorial-doc-id');
  const oldDoc = oldId && await p.rem.findOne(oldId);
  if (oldDoc) await oldDoc.remove();
  await p.storage.setSynced('vim-tutorial-doc-id', undefined);
  await window.__vim.adapter.openTutorial();
  const docId = await p.storage.getSynced('vim-tutorial-doc-id');
  const doc = docId && await p.rem.findOne(docId);
  const kids = doc ? await doc.getChildrenRem() : [];
  const paneDoc = await p.window.getOpenPaneRemId(await p.window.getFocusedPaneId());
  const title = doc ? await p.richText.toString(doc.text ?? []) : null;
  return { docId, freshId: !oldId || docId !== oldId, title, nTop: kids.length, paneDoc };
})()`);
await sleep(1500);
check('openTutorial created + pinned a fresh document', !!state.docId && state.freshId, JSON.stringify(state));
check('document is titled "Vim Tutorial"', state.title === 'Vim Tutorial', state.title);
check('lessons seeded (top-level bullets present)', state.nTop >= 10, state.nTop);
check('the document is what the pane opened', state.paneDoc === state.docId, `pane=${state.paneDoc}`);

// ---- practice a real exercise: search for caaat, fix it with fa xx
await page.evaluate(() =>
  document.querySelector('.rn-editor-container')?.classList.remove('pointer-events-none'));
// click a bullet in the tutorial doc so the editor has the caret
const spot = await page.evaluate(() => {
  const c = document.querySelector('.EditorContainer');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x + Math.min(25, r.width / 2 + 5), y: r.y + r.height / 2 };
});
let focused = false;
for (let i = 0; i < 10 && !focused; i++) {
  await page.bringToFront();
  if (spot) await page.mouse.click(spot.x, spot.y);
  await sleep(600);
  focused = await page.evaluate(() => !!(window.currentFocusedRem && window.currentFocusedRem()));
}
check('a tutorial bullet takes focus', focused);
const keys = async (seq) => {
  for (const k of seq) { await page.keyboard.press(k === ' ' ? 'Space' : k); await sleep(80); }
  await sleep(700);
};
await keys(['Escape']);
await keys([' ', 'c', 'a', 'a', 'a', 't', 'Enter']); // search jumps to the exercise
await keys(['f', 'a', 'x', 'x']); // land on the first a, delete two
const fixed = await page.evaluate(async () => {
  const r = window.currentFocusedRem && window.currentFocusedRem();
  if (!r) return null;
  return ((await r.getText()) ?? []).map((x) => (typeof x === 'string' ? x : '')).join('');
});
check('the caaat exercise is fixable in place (fa xx → cat)', /: cat$/.test(fixed ?? ''), fixed);

// ---- :tutorial reopens the SAME document (no duplicate seed)
await keys([';', 't', 'u', 't', 'o', 'r', 'i', 'a', 'l', 'Enter']);
await sleep(1500);
const after = await evalIn(ci, `(async () => {
  const p = window.__vim.plugin;
  const docId = await p.storage.getSynced('vim-tutorial-doc-id');
  const paneDoc = await p.window.getOpenPaneRemId(await p.window.getFocusedPaneId());
  return { docId, paneDoc };
})()`);
check(':tutorial keeps the same pinned document', after.docId === state.docId, JSON.stringify(after));
check(':tutorial opens it in the pane', after.paneDoc === state.docId, `pane=${after.paneDoc}`);
ci.close();

console.log(`\nRESULT: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
