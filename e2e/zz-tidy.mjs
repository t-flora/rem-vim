// One-off: remove EMPTY leftover bullets in the e2e daily doc via dd
// keystrokes (the suites' own cleaning path leaves them; crashes multiply
// them). Never touches non-empty rows.
import { chromium } from 'playwright-core';
import { resolveDailyDocId, dailyPaneScope } from './docid.mjs';
const PORT = process.env.REMNOTE_CDP_PORT ?? '9223';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => !/^devtools/.test(p.url()));
let page = null;
for (let i = 0; i < 20 && !page; i++) {
  for (const p of pages) {
    if (await p.evaluate(() => typeof window.currentFocusedRem !== 'undefined').catch(() => false)) { page = p; break; }
  }
  if (!page) await pages[0]?.waitForTimeout(500);
}
await page.evaluate(() => document.querySelector('.rn-editor-container')?.classList.remove('pointer-events-none'));
await page.bringToFront();
const wait = (ms) => page.waitForTimeout(ms);
const badge = () => page.evaluate(() => getComputedStyle(document.body, '::after').content.replace(/\\?"/g, ''));
const DOC_ID = await resolveDailyDocId(page);
const paneScope = () => dailyPaneScope(page, DOC_ID);
async function bullets() {
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
      out.push({ text: c.textContent.replace(/ |​/g, ' ').trim(), x: r.x + 25, y: r.y + r.height / 2 });
    }
    return out;
  }, { docId: DOC_ID, pane: await paneScope() });
}
for (let i = 0; i < 25; i++) {
  const bs = await bullets();
  if (bs.length <= 1) break;
  const target = bs.find((b) => b.text === '') && bs.length > 1 ? bs.slice(1).find((b) => b.text === '') ?? bs[1] : bs[1];
  if (!target) break;
  await page.mouse.click(target.x, target.y);
  await wait(500);
  if (!/NORMAL/.test(await badge())) { await page.keyboard.press('Escape'); await wait(600); }
  await page.keyboard.press('d'); await wait(120);
  await page.keyboard.press('d'); await wait(800);
}
const finalBs = await bullets();
console.log('remaining bullets:', JSON.stringify(finalBs.map((b) => b.text)));
process.exit(0);
