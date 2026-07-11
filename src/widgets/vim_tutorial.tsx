import { renderWidget, usePlugin, WidgetLocation } from '@remnote/plugin-sdk';
import { useEffect, useRef, useState } from 'react';

/**
 * The getting-started tutorial — opened automatically the first time the
 * plugin activates (see `index.tsx`'s `maybeAutoOpenTutorial`), and any time
 * afterward via the "Vim: Tutorial" command. Unlike `vim_help.tsx` (a dense
 * reference table meant to be searched), this is a linear walkthrough meant
 * to be read once, front to back, by someone who has never used vim.
 *
 * Same focus model as `vim_help.tsx`: this floating widget gets real DOM
 * focus on mount, so plain `onKeyDown` handles navigation — no
 * `stealKeys` needed. Left/Right (or vim's own `h`/`l`) move between pages,
 * fittingly.
 */

const SEEN_KEY = 'vim-tutorial-seen';

function Key({ k }: { k: string }) {
  return <kbd>{k}</kbd>;
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="keys">
      {keys.map((k, i) => (
        <span key={i}>
          {i > 0 && <span className="then"> then </span>}
          <Key k={k} />
        </span>
      ))}
    </span>
  );
}

function Bind({ keys, desc }: { keys: string[]; desc: React.ReactNode }) {
  return (
    <div className="bind">
      <Keys keys={keys} />
      <span className="desc">{desc}</span>
    </div>
  );
}

function ModeChip({ label, color }: { label: string; color: string }) {
  return (
    <span className="modeChip" style={{ background: color }}>
      {label}
    </span>
  );
}

export interface Step {
  eyebrow: string;
  title: string;
  body: React.ReactNode;
}

/** Exported for tests: content-accuracy checks render and validate every page. */
export const STEPS: Step[] = [
  {
    eyebrow: 'Welcome',
    title: 'Vim Mode for RemNote',
    body: (
      <>
        <p>
          This plugin brings <b>modal editing</b> to the RemNote note editor:
          instead of always typing, you switch between a mode where keys are{' '}
          <b>commands</b> and a mode where keys are <b>text</b>. Once it
          clicks, it's a much faster way to move around and edit than arrow
          keys and the mouse.
        </p>
        <p>
          This tutorial walks through everything the plugin can do, one topic
          at a time — 14 short pages. It only
          opens automatically the first time; after that, run{' '}
          <b>"Vim: Tutorial"</b> from the command palette to see it again, or
          type <Key k=":help" /> for a compact reference sheet once you know
          your way around.
        </p>
        <p>
          Use <Key k="→" /> / <Key k="l" /> and <Key k="←" /> / <Key k="h" />{' '}
          (or the buttons below) to move through this tutorial —{' '}
          <Key k="Esc" /> closes it any time.
        </p>
      </>
    ),
  },
  {
    eyebrow: 'Getting started',
    title: 'Turning it on, and the mode badge',
    body: (
      <>
        <p>
          Run <b>"Vim: Toggle vim mode"</b> from the command palette
          (Cmd/Ctrl-P) to turn vim mode on or off — it takes effect instantly,
          no reload. There's also a <b>"Start in normal mode"</b> plugin
          setting: on, every fresh load starts ready for commands; off, it
          starts as if you'd pressed <Key k="i" /> already.
        </p>
        <p>
          A small badge in the bottom-right corner of the editor always shows
          the current mode:
        </p>
        <div className="modes">
          <ModeChip label="NORMAL" color="#7c3aed" />
          <ModeChip label="INSERT" color="#059669" />
          <ModeChip label="VISUAL" color="#d97706" />
          <ModeChip label="V-LINE" color="#d97706" />
          <ModeChip label="COMMAND" color="#0ea5e9" />
          <ModeChip label="SEARCH" color="#db2777" />
        </div>
        <p>
          If you ever feel "stuck" and don't know what keys will do, press{' '}
          <Key k="Esc" /> — it always returns you to NORMAL mode.
        </p>
      </>
    ),
  },
  {
    eyebrow: 'Insert mode',
    title: 'Typing text',
    body: (
      <>
        <p>
          In NORMAL mode, letters are commands, not text. To actually type,
          enter INSERT mode first:
        </p>
        <Bind keys={['i']} desc="insert before the cursor" />
        <Bind keys={['a']} desc="insert after the cursor" />
        <Bind keys={['g', 'a']} desc={<>insert at the end of the line (vim's <Key k="A" />)</>} />
        <Bind keys={['o']} desc="new bullet below, start typing" />
        <Bind keys={['g', 'o']} desc={<>new bullet above (vim's <Key k="O" />)</>} />
        <Bind keys={['Esc']} desc="back to NORMAL — stop typing" />
        <p className="hint">
          A RemNote bullet is always one sibling under its parent: <Key k="o" />{' '}
          / <Key k="go" /> never create a child, even if the current bullet
          has one expanded already.
        </p>
      </>
    ),
  },
  {
    eyebrow: 'Moving around',
    title: 'Motions',
    body: (
      <>
        <p>Character and word movement inside a bullet:</p>
        <Bind keys={['h']} desc="left" />
        <Bind keys={['l']} desc="right" />
        <Bind keys={['w']} desc="next word" />
        <Bind keys={['b']} desc="previous word" />
        <Bind keys={['e']} desc="end of word" />
        <Bind keys={['0']} desc="start of the line" />
        <Bind keys={['g', 'l']} desc={<>end of the line (vim's <Key k="$" />)</>} />
        <Bind keys={['g', 'h']} desc={<>first non-blank character (vim's <Key k="^" />)</>} />
        <Bind keys={['f', '·']} desc={<>jump onto the next "·" on this line</>} />
        <Bind keys={['g', 'f', '·']} desc={<>jump onto the previous "·" (vim's <Key k="F" />)</>} />
        <Bind keys={[',']} desc="repeat the last f/gf jump, reversed" />
        <p>Between bullets, and across the whole document:</p>
        <Bind keys={['j']} desc="bullet down" />
        <Bind keys={['k']} desc="bullet up" />
        <Bind keys={['g', 'g']} desc="top of the document" />
        <Bind keys={['g', 'e']} desc={<>bottom of the document (vim's <Key k="G" />)</>} />
        <Bind keys={['4', 'j']} desc="a number before a motion repeats it — 4 bullets down" />
        <p className="hint">
          A RemNote bullet is one line by construction, so <Key k="j" />/
          <Key k="k" /> move between bullets, not between wrapped visual
          lines.
        </p>
      </>
    ),
  },
  {
    eyebrow: 'Finding text',
    title: 'Search',
    body: (
      <>
        <Bind keys={['Space']} desc="start a search — type a pattern, Enter jumps to the first match" />
        <Bind keys={['n']} desc="repeat the search forward (wraps at the end of the document)" />
        <Bind keys={['z']} desc={<>repeat the search backward (vim's <Key k="N" />)</>} />
        <Bind keys={['Esc']} desc="cancel the search prompt without moving" />
        <p>
          Search looks through every bullet in the document, top to bottom,
          and the pattern is a plain regular expression (case-sensitive).
        </p>
        <p>Scrolling and jumping back to where you came from:</p>
        <Bind keys={['Ctrl-d']} desc="half a page down" />
        <Bind keys={['Ctrl-u']} desc="half a page up" />
        <Bind keys={['Ctrl-o']} desc={<>jump back to before the last <Key k="gg" />/<Key k="ge" />/<Key k=":e" />/search jump</>} />
        <Bind keys={['Ctrl-i']} desc="jump forward again" />
      </>
    ),
  },
  {
    eyebrow: 'Editing',
    title: 'Deleting, changing, and repeating',
    body: (
      <>
        <Bind keys={['x']} desc="delete the character under the cursor" />
        <Bind keys={['d', 'w']} desc="delete to the start of the next word" />
        <Bind keys={['d', 'i', 'w']} desc="delete the word you're standing in" />
        <Bind keys={['d', 'i', 'b']} desc={<>delete inside <Key k="(…)" /> — also <Key k="i[" />, <Key k="i'" />, <Key k="i`" /></>} />
        <Bind keys={['c', 'w']} desc="change a word — deletes it and drops you in INSERT mode" />
        <Bind keys={['r', '·']} desc={'replace the character under the cursor with "·"'} />
        <Bind keys={['`']} desc={<>toggle UPPER/lower case of one character (vim's <Key k="~" />)</>} />
        <Bind keys={['g', 'j']} desc={<>join with the next bullet, space-separated (vim's <Key k="J" />)</>} />
        <Bind keys={['Ctrl-a']} desc="increment the number under/after the cursor" />
        <Bind keys={['Ctrl-x']} desc="decrement it" />
        <Bind keys={['.']} desc="repeat the last change" />
        <p className="hint">
          Almost every command above accepts a leading count, exactly like a
          motion: <Key k="3x" /> deletes 3 characters, <Key k="2dw" /> deletes
          2 words. Commands that drop you into INSERT mode (like{' '}
          <Key k="cw" /> or <Key k="o" />) are <b>not</b> replayed by{' '}
          <Key k="." /> — the text you go on to type never reaches the
          plugin, so there's nothing recorded to repeat.
        </p>
      </>
    ),
  },
  {
    eyebrow: 'Cut, copy, paste',
    title: 'Whole bullets, and marks',
    body: (
      <>
        <Bind keys={['d', 'd']} desc="cut the whole bullet, including its children" />
        <Bind keys={['y', 'y']} desc="copy the whole bullet" />
        <Bind keys={['p']} desc="paste below" />
        <Bind keys={['u']} desc="undo" />
        <Bind keys={['Ctrl-r']} desc="redo" />
        <p>
          Deletes and yanks like these also land on your real OS clipboard,
          so you can paste into another app with the usual Cmd/Ctrl-V.
        </p>
        <p>Bookmarking specific bullets to jump back to later:</p>
        <Bind keys={['m', '·']} desc={'remember the current bullet as mark "·" (any letter)'} />
        <Bind keys={["'", '·']} desc={'jump back to mark "·"'} />
        <Bind keys={["'", "'"]} desc="jump back to where the last jump started" />
        <Bind keys={[':marks']} desc="list every mark you've set" />
      </>
    ),
  },
  {
    eyebrow: 'Selecting text',
    title: 'Visual mode',
    body: (
      <>
        <p>
          Visual mode selects text, then applies a command to the selection —
          the same way an operator like <Key k="d" /> applies to a motion.
        </p>
        <Bind keys={['v']} desc="start a text selection in this bullet" />
        <Bind keys={['h', '/', 'l', '/', 'w', '/', 'b', '/', 'e']} desc="grow the selection with any motion" />
        <Bind keys={['d']} desc="cut the selection" />
        <Bind keys={['y']} desc="copy it (also to the OS clipboard)" />
        <Bind keys={['p']} desc="paste over the selection" />
        <Bind keys={['`']} desc="toggle the case of the whole selection" />
        <Bind keys={['g', 's', '·']} desc={'wrap the selection in a delimiter — e.g. gs9 for ( … )'} />
        <Bind keys={['Esc']} desc="cancel the selection" />
        <p className="hint">
          Wrap delimiters are shift-blind-friendly stand-ins:{' '}
          <Key k="gs'" />, <Key k="gs`" />, <Key k="gs[" /> (or{' '}
          <Key k="gs]" />) are literal; <Key k="gsq" /> gives{' '}
          <Key k='"…"' /> ("q" for quote), <Key k="gs8" /> gives{' '}
          <Key k="*…*" />, <Key k="gs9" /> or <Key k="gs0" /> gives{' '}
          <Key k="(…)" />.
        </p>
      </>
    ),
  },
  {
    eyebrow: 'Selecting bullets',
    title: 'Visual-line mode',
    body: (
      <>
        <p>
          Where visual mode selects text within a bullet, visual-line mode
          selects whole bullets — useful for reordering or bulk-editing
          outline structure.
        </p>
        <Bind keys={['v', 'v']} desc={<>select whole bullets (vim's <Key k="V" />)</>} />
        <Bind keys={['j', '/', 'k']} desc="extend the selection up/down (also works from plain v)" />
        <Bind keys={['g', 'g', '/', 'g', 'e']} desc="extend all the way to the top/bottom of the document" />
        <Bind keys={['d']} desc="cut the selected bullets" />
        <Bind keys={['y']} desc="copy them" />
        <Bind keys={['p']} desc="paste" />
        <Bind keys={['.']} desc={<>indent the selection (vim's <Key k=">" />)</>} />
        <Bind keys={[',']} desc={<>outdent it (vim's <Key k="<" />)</>} />
        <Bind keys={[';']} desc="open the command line, applying it to the selection" />
      </>
    ),
  },
  {
    eyebrow: 'The command line',
    title: 'Ex commands',
    body: (
      <>
        <Bind keys={[';']} desc="open the : command line (Tab cycles suggestions)" />
        <Bind keys={[':help']} desc="the compact reference sheet — everything on one screen" />
        <Bind keys={[':e', 'name']} desc="search for a page by name and open it" />
        <Bind keys={[':10']} desc="jump to the 10th bullet from the top" />
        <Bind keys={[':s/a/b/']} desc={<>replace a→b (flags: <Key k="g" /> all, <Key k="i" /> case-insensitive, <Key k="a" /> whole document)</>} />
        <Bind keys={[':g/pat/d']} desc="delete every bullet matching a pattern" />
        <Bind keys={[':sort']} desc={<>sort the selection or children (<Key k="n" /> for numeric)</>} />
        <Bind keys={[':t', '/', ':d', '/', ':y']} desc="duplicate / delete / copy bullets" />
        <Bind keys={[':vs', '/', ':sp']} desc="split the pane right / below" />
        <Bind keys={[':q', '/', ':only']} desc="close this pane / keep only this pane" />
        <p className="hint">
          The command line's Tab-completion wildmenu lists every available
          command, so you can always discover more by typing <Key k=";" />{' '}
          and pressing Tab.
        </p>
      </>
    ),
  },
  {
    eyebrow: 'Multiple panes',
    title: '"Tabs" and pane navigation',
    body: (
      <>
        <Bind keys={['g', 't']} desc="focus the next pane" />
        <Bind keys={['g', 'p']} desc="focus the previous pane" />
        <Bind keys={['g', 'n']} desc={<>open a new pane (vertical split, like <Key k=":vs" />)</>} />
        <Bind keys={['g', 'c']} desc={<>close this pane (like <Key k=":q" />)</>} />
        <Bind keys={['g', 'm', 'h', '/', 'l']} desc="move this pane left/right in the cycle order" />
        <Bind keys={['Ctrl-h']} desc="focus the previous pane" />
        <Bind keys={['Ctrl-l']} desc="focus the next pane" />
      </>
    ),
  },
  {
    eyebrow: 'Make it your own',
    title: 'Custom keybindings',
    body: (
      <>
        <p>
          Don't like a mapping, or want to add your own? Type <Key k=":config" />{' '}
          to open a "Vim Keymap" document — one line per bullet, using vim's
          own mapping syntax:
        </p>
        <Bind keys={['nmap - $']} desc="map a key in normal mode" />
        <Bind keys={['vmap - $']} desc="map a key in visual mode" />
        <Bind keys={['map - $']} desc="map in both" />
        <Bind keys={['unmap ,']} desc="release a key back to RemNote (the key side is always ONE key)" />
        <p>Mappings are noremap (no recursive expansion) and apply as soon as you leave the document, or immediately with:</p>
        <Bind keys={[':mapload']} desc="reload keybindings from the document" />
        <Bind keys={[':map']} desc="list your current mappings, plus any parse errors" />
      </>
    ),
  },
  {
    eyebrow: 'One RemNote quirk',
    title: "Why some keys look 'wrong'",
    body: (
      <>
        <p>
          RemNote's key-stealing can't tell Shift apart from its base key:{' '}
          <Key k="v" /> and <Key k="Shift-V" /> arrive identically. That means
          a capital letter can never be bound to something different from its
          lowercase version — so this plugin uses unshifted stand-ins for
          every vim command that's normally a capital or a shifted symbol:
        </p>
        <Bind keys={['g', 'l']} desc={<>= <Key k="$" /></>} />
        <Bind keys={['g', 'h']} desc={<>= <Key k="^" /></>} />
        <Bind keys={['g', 'e']} desc={<>= <Key k="G" /></>} />
        <Bind keys={['g', 'a']} desc={<>= <Key k="A" /></>} />
        <Bind keys={['g', 'o']} desc={<>= <Key k="O" /></>} />
        <Bind keys={['v', 'v']} desc={<>= <Key k="V" /></>} />
        <Bind keys={['`']} desc={<>= <Key k="~" /></>} />
        <Bind keys={['.', '/', ',']} desc={<>= <Key k=">" />/<Key k="<" /> (visual-line only)</>} />
        <p className="hint">
          A couple of smaller limitations worth knowing up front: pasting text
          (not whole bullets) across a rem-reference/image/LaTeX chip drops
          the chip — whole-bullet cut/copy keeps full fidelity; and after
          clicking with the mouse mid-line, press <Key k="0" /> or{' '}
          <Key k="gl" /> once to re-anchor the cursor before using motions.
        </p>
      </>
    ),
  },
  {
    eyebrow: "You're set",
    title: 'Where to go from here',
    body: (
      <>
        <p>You've now seen everything the plugin does. A few pointers:</p>
        <Bind keys={[':help']} desc="the full reference sheet, one screen, searchable by eye" />
        <Bind keys={['Vim: Tutorial']} desc="reopen this walkthrough any time from the command palette" />
        <Bind keys={['Vim: Toggle vim mode']} desc="turn it off if you need plain typing for a while" />
        <Bind keys={['Vim: Edit keybindings']} desc={<>opens the same document as <Key k=":config" /></>} />
        <p>
          The best way to learn is to just start using it — muscle memory
          builds fast, and <Key k="Esc" /> always gets you back to a mode
          where nothing bad happens by accident.
        </p>
      </>
    ),
  },
];

function VimTutorial() {
  const plugin = usePlugin();
  const containerRef = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(0);

  // Mark the tutorial as seen the moment it's actually rendered, whether it
  // was opened automatically on first install or manually via the command —
  // either way there's no reason to auto-pop it again later.
  useEffect(() => {
    void plugin.storage.setSynced(SEEN_KEY, true);
  }, [plugin]);

  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    containerRef.current?.scrollTo({ top: 0 });
  }, [i]);

  const close = async () => {
    const ctx = await plugin.widget.getWidgetContext<WidgetLocation.FloatingWidget>();
    if (ctx?.floatingWidgetId) {
      await plugin.window.closeFloatingWidget(ctx.floatingWidgetId);
    }
  };

  const first = i === 0;
  const last = i === STEPS.length - 1;
  const next = () => (last ? void close() : setI((n) => n + 1));
  const back = () => {
    if (!first) setI((n) => n - 1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      next();
    } else if (e.key === 'ArrowLeft' || e.key === 'h') {
      e.preventDefault();
      e.stopPropagation();
      back();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void close();
    }
  };

  const step = STEPS[i];

  return (
    <div className="vim-tut" ref={containerRef} tabIndex={0} onKeyDown={onKeyDown}>
      <style>{`
        .vim-tut:focus { outline: none; }
        .vim-tut {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: var(--rn-clr-background-primary, #fff);
          color: var(--rn-clr-content-primary, #1a1a2e);
          border: 1px solid var(--rn-clr-border-primary, #d9d9e3);
          border-radius: 10px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.25);
          width: 100%;
          height: 100%;
          box-sizing: border-box;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          padding: 20px 26px 16px;
          font-size: 13.5px;
          line-height: 1.55;
        }
        .vim-tut header {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 4px;
        }
        .vim-tut .eyebrow {
          font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
          color: var(--rn-clr-content-tertiary, #999); margin: 0 0 2px;
        }
        .vim-tut h2 { margin: 0 0 10px; font-size: 19px; }
        .vim-tut .closeBtn {
          border: none; background: transparent; cursor: pointer;
          font-size: 18px; line-height: 1; padding: 4px 8px; border-radius: 6px;
          color: var(--rn-clr-content-secondary, #666);
          align-self: flex-start;
        }
        .vim-tut .closeBtn:hover { background: var(--rn-clr-background-secondary, #eee); }
        .vim-tut .body { flex: 1; }
        .vim-tut p { margin: 0 0 10px; color: var(--rn-clr-content-primary, #1a1a2e); }
        .vim-tut p.hint {
          background: rgba(217,119,6,0.10);
          border: 1px solid rgba(217,119,6,0.35);
          border-radius: 8px; padding: 9px 11px; margin-top: 8px;
          font-size: 12.5px;
        }
        .vim-tut .modes { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 10px; }
        .vim-tut .modeChip {
          font: 600 10.5px ui-monospace, monospace; letter-spacing: .06em;
          color: #fff; border-radius: 5px; padding: 2px 8px;
        }
        .vim-tut .bind {
          display: flex; align-items: baseline; gap: 12px; padding: 3px 0;
        }
        .vim-tut .bind .keys { white-space: nowrap; min-width: 108px; flex: none; }
        .vim-tut .bind .desc { color: var(--rn-clr-content-secondary, #444); }
        .vim-tut .then { color: var(--rn-clr-content-tertiary, #999); font-size: 11px; }
        .vim-tut kbd {
          font: 600 11px ui-monospace, SFMono-Regular, Menlo, monospace;
          background: var(--rn-clr-background-secondary, #f0f0f5);
          border: 1px solid var(--rn-clr-border-primary, #d5d5e0);
          border-bottom-width: 2px;
          border-radius: 4px; padding: 1px 5px;
        }
        .vim-tut footer {
          display: flex; align-items: center; justify-content: space-between;
          margin-top: 14px; padding-top: 12px;
          border-top: 1px solid var(--rn-clr-border-primary, #e5e5ee);
        }
        .vim-tut .dots { display: flex; gap: 5px; }
        .vim-tut .dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--rn-clr-border-primary, #d9d9e3);
        }
        .vim-tut .dot.active { background: #7c3aed; }
        .vim-tut .navBtns { display: flex; gap: 8px; align-items: center; }
        .vim-tut .navHint {
          font-size: 11px; color: var(--rn-clr-content-tertiary, #999);
          margin-right: 4px;
        }
        .vim-tut button.nav {
          font: 600 12.5px -apple-system, sans-serif;
          border: 1px solid var(--rn-clr-border-primary, #d5d5e0);
          background: var(--rn-clr-background-secondary, #f4f4f8);
          color: var(--rn-clr-content-primary, #1a1a2e);
          border-radius: 7px; padding: 6px 14px; cursor: pointer;
        }
        .vim-tut button.nav:hover { filter: brightness(0.96); }
        .vim-tut button.nav:disabled { opacity: 0.4; cursor: default; }
        .vim-tut button.nav.primary {
          background: #7c3aed; border-color: #7c3aed; color: #fff;
        }
      `}</style>

      <header>
        <div>
          <div className="eyebrow">{step.eyebrow}</div>
          <h2>{step.title}</h2>
        </div>
        <button className="closeBtn" onClick={close} title="Close (Esc)">
          ✕
        </button>
      </header>

      <div className="body">{step.body}</div>

      <footer>
        <div className="dots">
          {STEPS.map((_, idx) => (
            <span key={idx} className={`dot${idx === i ? ' active' : ''}`} />
          ))}
        </div>
        <div className="navBtns">
          <span className="navHint">
            <Key k="←" />/<Key k="h" /> <Key k="→" />/<Key k="l" />
          </span>
          <button className="nav" onClick={back} disabled={first}>
            Back
          </button>
          <button className="nav primary" onClick={next}>
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </footer>
    </div>
  );
}

renderWidget(VimTutorial);
