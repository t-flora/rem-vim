#!/usr/bin/env node
// Live probe for the getting-started tutorial: auto-open on first activation,
// full 14-page keyboard navigation, Enter/Escape close, seen-flag persistence
// (reloads the app window at the end — run it AFTER other suites, not before).
// Drives the plugin OOPIF targets over raw CDP: playwright's connectOverCDP
// cannot frame-attach to RemNote's cross-origin plugin iframes, but each one
// is its own /json/list target with a webSocketDebuggerUrl.
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
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' — ' + String(extra)}`);
};

const tutTarget = async () => (await list()).find((t) => t.url.includes('widgetName=vim_tutorial'));

// 1. auto-open
let tut = await tutTarget();
check('tutorial auto-opened on first activation (iframe target present)', !!tut);
if (!tut) process.exit(1);

const c = await connect(tut.webSocketDebuggerUrl);
const title = () => evalIn(c, `document.querySelector('.vim-tut h2')?.textContent ?? null`);
const key = (k) => evalIn(c, `(document.querySelector('.vim-tut')||document.body).dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true})), true`);

check('welcome page rendered', (await title()) === 'Vim Mode for RemNote', await title());

// 2. navigate all pages with ArrowRight
const titles = [await title()];
for (let i = 0; i < 13; i++) { await key('ArrowRight'); await sleep(150); titles.push(await title()); }
check('ArrowRight walks 14 distinct pages', new Set(titles).size === 14 && !titles.includes(null), JSON.stringify(titles));
check('last page reached', titles[13] === 'Where to go from here', titles[13]);
await key('h'); await sleep(150);
check('h navigates back', (await title()) === titles[12], await title());
await key('l'); await sleep(150);
check('l navigates forward', (await title()) === titles[13], await title());

// 3. Enter on the last page = Done → closes
await key('Enter'); await sleep(1200);
check('Enter on the last page closes the tutorial', !(await tutTarget()));
c.close();

// 4. seen flag readable through the index widget's plugin API
const idx = (await list()).find((t) => t.url.includes('widgetName=index'));
const ci = await connect(idx.webSocketDebuggerUrl);
const seen = await evalIn(ci, `window.__vim.plugin.storage.getSynced('vim-tutorial-seen')`);
check('vim-tutorial-seen persisted as true', seen === true, JSON.stringify(seen));

const pageT = (await list()).find((t) => t.type === 'page');
const cp = await connect(pageT.webSocketDebuggerUrl);
await cp.send('Page.enable');
await cp.send('Page.reload', { ignoreCache: false });
await sleep(15000);
let reopened = null;
for (let i = 0; i < 10; i++) { reopened = await tutTarget(); if (reopened) break; await sleep(1000); }
const pluginBack = (await list()).some((t) => t.url.includes('widgetName=index'));
check('plugin reactivated after reload', pluginBack);
check('tutorial does NOT reopen after reload (seen flag)', !reopened);
cp.close(); ci.close();

console.log(`\nRESULT: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
