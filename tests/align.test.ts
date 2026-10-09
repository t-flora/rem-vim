/**
 * zt / zz / zb (`alignCaretRow`) against a simulated scroll view that
 * follows RemNote's caret-into-view rule, read from the 1.28.32 bundle
 * (HierarchyEditor `scrollCaretIntoViewIfNeeded`): when the caret line's
 * rect crosses the viewable top/bottom, scroll just enough to put it 5px
 * inside that edge. scrollTop is clamped like a real scroll container.
 */
import { describe, expect, it } from 'vitest';
import { alignCaretRow, newViewGeometry, ScrollIO } from '../src/adapter/pure';

interface Line {
  row: string;
  h: number;
}

class FakeView implements ScrollIO {
  scrollTop = 0;
  steps = 0;
  constructor(
    public lines: Line[],
    public caret: number,
    public viewTop = 60,
    public viewBottom = 860,
    scrollTop = 0,
    /** px of spacing between consecutive bullets (not between wrapped lines). */
    public gap = 0
  ) {
    this.scrollTop = scrollTop;
    this.clampScroll();
    this.reveal(); // the caret is always on screen in the real editor
  }
  /** RemNote's rule: put a line that crossed an edge 5px inside it. */
  private reveal() {
    const top = this.y(this.caret);
    const bottom = top + this.lines[this.caret].h;
    if (top < this.viewTop) this.scrollTop -= this.viewTop - top + 5;
    else if (bottom > this.viewBottom) this.scrollTop += bottom - this.viewBottom + 5;
    this.clampScroll();
  }
  private lineTop(i: number) {
    let t = 0;
    for (let k = 0; k < i; k++) {
      t += this.lines[k].h;
      if (this.lines[k + 1]?.row !== this.lines[k].row) t += this.gap;
    }
    return t;
  }
  private get total() {
    return this.lineTop(this.lines.length);
  }
  private clampScroll() {
    const max = Math.max(0, this.total - (this.viewBottom - this.viewTop));
    this.scrollTop = Math.max(0, Math.min(max, this.scrollTop));
  }
  /** Screen y of a line's top edge. */
  y(i: number) {
    return this.viewTop + this.lineTop(i) - this.scrollTop;
  }
  async step(dir: -1 | 1) {
    this.steps++;
    this.caret = Math.max(0, Math.min(this.lines.length - 1, this.caret + dir));
    this.reveal();
  }
  async caretRect() {
    const top = this.y(this.caret);
    return { top, bottom: top + this.lines[this.caret].h };
  }
  async rowId() {
    return this.lines[this.caret].row;
  }
}

/** n one-line bullets of height h. */
const bullets = (n: number, h = 26): Line[] => Array.from({ length: n }, (_, i) => ({ row: `r${i}`, h }));

/** A mixed document: headings, plain bullets, and bullets wrapping over 3 lines. */
function mixed(n: number): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 10 === 0) out.push({ row: `r${i}`, h: 42 });
    else if (i % 7 === 0) for (let k = 0; k < 3; k++) out.push({ row: `r${i}`, h: 24 });
    else out.push({ row: `r${i}`, h: 28 });
  }
  return out;
}

const center = (v: FakeView) => v.y(v.caret) + v.lines[v.caret].h / 2;
const mid = (v: FakeView) => (v.viewTop + v.viewBottom) / 2;

describe('alignCaretRow', () => {
  for (const [name, doc, gap] of [
    ['uniform bullets', bullets(200), 0],
    ['mixed heights and wrapped bullets', mixed(200), 0],
    ['mixed, with 6px gaps between bullets', mixed(200), 6],
  ] as const) {
    describe(name, () => {
      it('zt puts the cursor line 5px under the top edge and keeps the cursor', async () => {
        const v = new FakeView(doc, 80, 60, 860, 80 * 26 - 300, gap);
        const before = v.caret;
        expect(await alignCaretRow(v, 'top', newViewGeometry(), { screenHeight: 1000 })).toBe('ok');
        expect(v.caret).toBe(before);
        expect(v.y(v.caret)).toBe(v.viewTop + 5);
      });

      it('zb puts the cursor line 5px above the bottom edge and keeps the cursor', async () => {
        const v = new FakeView(doc, 80, 60, 860, 80 * 26 - 300, gap);
        const before = v.caret;
        expect(await alignCaretRow(v, 'bottom', newViewGeometry(), { screenHeight: 1000 })).toBe('ok');
        expect(v.caret).toBe(before);
        expect(v.y(v.caret) + v.lines[v.caret].h).toBe(v.viewBottom - 5);
      });

      it('zz centers the cursor line within a line height', async () => {
        for (const start of [60, 100, 140]) {
          const v = new FakeView(doc, start, 60, 860, start * 26 - 700, gap);
          const before = v.caret;
          expect(await alignCaretRow(v, 'center', newViewGeometry(), { screenHeight: 1000 })).toBe('ok');
          expect(v.caret).toBe(before);
          expect(Math.abs(center(v) - mid(v))).toBeLessThanOrEqual(v.lines[v.caret].h);
        }
      });

      it('zt then zb then zz on the same view, sharing what was learned', async () => {
        const v = new FakeView(doc, 90, 60, 860, 90 * 26 - 400, gap);
        const geo = newViewGeometry();
        expect(await alignCaretRow(v, 'top', geo, { screenHeight: 1000 })).toBe('ok');
        expect(v.y(v.caret)).toBe(v.viewTop + 5);
        expect(await alignCaretRow(v, 'bottom', geo, { screenHeight: 1000 })).toBe('ok');
        expect(v.y(v.caret) + v.lines[v.caret].h).toBe(v.viewBottom - 5);
        // what it learned is exactly where RemNote parks lines
        expect(geo).toEqual({ topPin: v.viewTop + 5, bottomPin: v.viewBottom - 5 });
        expect(await alignCaretRow(v, 'center', geo, { screenHeight: 1000 })).toBe('ok');
        expect(Math.abs(center(v) - mid(v))).toBeLessThanOrEqual(v.lines[v.caret].h);
      });
    });
  }

  it('learned geometry makes the next zt cheaper', async () => {
    const geo = newViewGeometry();
    const v1 = new FakeView(bullets(300), 100, 60, 860, 100 * 26 - 400);
    await alignCaretRow(v1, 'top', geo, { screenHeight: 1200 });
    const v2 = new FakeView(bullets(300), 100, 60, 860, 100 * 26 - 400);
    await alignCaretRow(v2, 'top', geo, { screenHeight: 1200 });
    expect(v2.y(v2.caret)).toBe(v2.viewTop + 5);
    expect(v2.steps).toBeLessThanOrEqual(v1.steps);
  });

  it('zt near the end of the document scrolls as far as it can and keeps the cursor', async () => {
    const doc = bullets(60);
    const v = new FakeView(doc, 55, 60, 860, 10_000);
    const before = v.caret;
    expect(await alignCaretRow(v, 'top', newViewGeometry(), { screenHeight: 1000 })).toBe('partial');
    expect(v.caret).toBe(before);
  });

  it('zb near the start of the document keeps the cursor', async () => {
    const v = new FakeView(bullets(60), 3, 60, 860, 0);
    expect(await alignCaretRow(v, 'bottom', newViewGeometry(), { screenHeight: 1000 })).toBe('partial');
    expect(v.caret).toBe(3);
  });

  it('a document shorter than the view: nothing to scroll, cursor kept', async () => {
    const v = new FakeView(bullets(8), 4, 60, 860, 0);
    for (const where of ['top', 'center', 'bottom'] as const) {
      expect(await alignCaretRow(v, where, newViewGeometry(), { screenHeight: 1000 })).toBe('partial');
      expect(v.caret).toBe(4);
    }
  });

  it('no caret position available: does nothing', async () => {
    const v = new FakeView(bullets(100), 50, 60, 860, 900);
    const io: ScrollIO = { step: (d) => v.step(d), caretRect: async () => undefined, rowId: () => v.rowId() };
    expect(await alignCaretRow(io, 'top', newViewGeometry())).toBe('unavailable');
    expect(await alignCaretRow(io, 'center', newViewGeometry())).toBe('unavailable');
    expect(v.steps).toBe(0);
  });
});
