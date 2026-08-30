/**
 * The extension's own pages, checked structurally.
 *
 * These exist because of two bugs found by looking at a screenshot rather than
 * by any suite, and both were the same shape: a name that had to match
 * something in another file, and did not.
 *
 * The setup screen asked the worker for `scan` when the command is `adoptScan`,
 * so it reported an empty profile on a profile full of accounts. Nothing threw.
 * The reply carried `{ error: 'unknown command' }` and the page rendered it as
 * "nothing found", which is the worst possible failure for a first run screen:
 * confidently wrong, in the direction of "this does not work".
 *
 * And a helper moved between two script files, so a page that loaded only one of
 * them threw `ReferenceError` on its first paint and sat on its loading state
 * forever.
 *
 * Neither is catchable by typecheck: these are classic scripts with no module
 * graph, talking to the worker over a string. So the graph is checked here, by
 * reading the files as text, which is the same arrangement `ramp.test.ts` has
 * and for the same reason.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const EXT = join(ROOT, 'extension');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const PAGES = readdirSync(EXT).filter((f) => f.endsWith('.html'));
const SCRIPTS = readdirSync(EXT).filter((f) => f.endsWith('.js'));

/** Which script and style files a page pulls in, in order. */
function assets(html: string): { scripts: string[]; styles: string[] } {
  return {
    scripts: [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]!),
    styles: [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]!),
  };
}

describe('every page loads what it references', () => {
  for (const page of PAGES) {
    it(`${page} has every file it asks for`, () => {
      const { scripts, styles } = assets(read(`extension/${page}`));
      for (const ref of [...scripts, ...styles]) {
        // Two kinds of reference are not files in `extension/`. The shared token
        // sheet is staged by the build out of `packages/ui`, and the manifest v2
        // background page loads the compiled worker out of `src/`, which only
        // exists in `dist`.
        const path =
          ref === 'ui/tokens.css'
            ? 'packages/ui/tokens.css'
            : ref.startsWith('src/')
              ? ref.replace(/\.js$/, '.ts')
              : `extension/${ref}`;
        expect(() => read(path), `${page} references ${ref}`).not.toThrow();
      }
    });
  }
});

/**
 * The one that would have caught the ReferenceError.
 *
 * A helper defined in one script and used in another is fine as long as the
 * page loads both, in order. Nothing enforces that but this.
 */
describe('every page loads the helpers its scripts use', () => {
  const SHARED = ['$', 'send', 'el', 'plural', 'hex', 'tone', 'COLORS'];
  const base = read('extension/base.js');

  /** `$` is a valid identifier and a regex metacharacter, so it is escaped once. */
  const declares = (name: string) =>
    new RegExp(`(function|const|let)\\s+${name.replace('$', '\\$')}\\s*[=(]`);

  it('base.js is where the shared helpers are', () => {
    for (const name of SHARED) {
      expect(declares(name).test(base), `${name} is not declared in base.js`).toBe(true);
    }
  });

  for (const page of PAGES) {
    const html = read(`extension/${page}`);
    const { scripts } = assets(html);
    const own = scripts.filter((s) => SCRIPTS.includes(s));
    if (!own.length) continue;

    it(`${page} loads base.js before anything that needs it`, () => {
      const body = own
        .filter((s) => s !== 'base.js')
        .map((s) => read(`extension/${s}`))
        .join('\n');
      const borrows = SHARED.some((n) => {
        const calls = new RegExp(`(^|[^\\w.$])${n.replace('$', '\\$')}\\s*\\(`, 'm');
        // A page that carries its own copy is not borrowing one. The in-page
        // chooser is that case: it runs inside somebody else's document, where
        // nothing of ours can be loaded alongside it.
        return calls.test(body) && !declares(n).test(body);
      });
      if (!borrows) return;
      expect(own[0], `${page} must load base.js first`).toBe('base.js');
    });
  }
});

/**
 * The one that would have caught the wrong command name.
 *
 * Every `send({ cmd: 'x' })` anywhere in the extension has to reach a `case 'x'`
 * in the worker. The worker answers an unknown command with `{ error }` rather
 * than throwing, which is the right behaviour and exactly what makes the mistake
 * silent, so it has to be caught here.
 */
describe('every command a page sends is one the worker answers', () => {
  const worker = read('src/bg/index.ts');
  const handled = new Set(
    [...worker.matchAll(/case '([a-zA-Z.]+)':/g)].map((m) => m[1]!)
  );

  for (const script of SCRIPTS) {
    const source = read(`extension/${script}`);
    const sent = [...source.matchAll(/cmd:\s*'([a-zA-Z.]+)'/g)].map((m) => m[1]!);
    if (!sent.length) continue;

    it(`${script} sends only commands the worker knows`, () => {
      const unknown = [...new Set(sent)].filter((c) => !handled.has(c));
      expect(unknown, `no case for: ${unknown.join(', ')}`).toEqual([]);
    });
  }

  it('finds the worker commands at all, so an empty set cannot pass this', () => {
    expect(handled.size).toBeGreaterThan(15);
    expect(handled.has('adoptScan')).toBe(true);
    expect(handled.has('journal')).toBe(true);
  });
});

/**
 * Every element a script reaches for by id has to be in the page that loads it.
 *
 * A missing id is not an error at runtime: `$('typo')` returns null and the
 * optional chaining that every listener here uses swallows it, so the control
 * silently does nothing.
 */
describe('every id a page script reaches for exists in its page', () => {
  for (const page of PAGES) {
    const html = read(`extension/${page}`);
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!));
    const scripts = assets(html).scripts.filter((s) => SCRIPTS.includes(s));
    if (!scripts.length) continue;

    // panel.js is shared and deliberately paints whatever the page happens to
    // have, returning early for everything it does not; only the scripts a page
    // owns are held to this.
    const owned = scripts.filter((s) => s !== 'base.js' && s !== 'panel.js');
    if (!owned.length) continue;

    it(`${page} has every id ${owned.join(', ')} asks for`, () => {
      const missing: string[] = [];
      for (const script of owned) {
        for (const m of read(`extension/${script}`).matchAll(/\$\('([a-z0-9-]+)'\)/g)) {
          if (!ids.has(m[1]!)) missing.push(`${script}: ${m[1]}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});

describe('the popup navigation', () => {
  const html = read('extension/popup.html');
  const destinations = [...html.matchAll(/data-go="([a-z]+)"/g)].map((m) => m[1]!);
  const views = new Set([...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]!));

  it('has a view behind every button', () => {
    for (const d of destinations) expect(views, `no view for ${d}`).toContain(d);
  });

  it('has a button for every view that is not reached another way', () => {
    // home is the landing view and native is folded into settings, both on
    // purpose. Anything else with no button is unreachable.
    const reachedOtherwise = new Set(['home', 'native']);
    for (const v of views) {
      if (reachedOtherwise.has(v)) continue;
      expect(destinations, `${v} has no way in`).toContain(v);
    }
  });

  /**
   * The nav is a fixed four column grid, so the destinations have to divide
   * into rows evenly or the last row is ragged and reads as an accident.
   */
  it('fills its rows', () => {
    expect(destinations.length % 4).toBe(0);
  });
});

/**
 * The guide has to keep up with the product.
 *
 * A tutorial that is missing a feature is a tutorial somebody trusts and then
 * cannot find what they came for. Checking that every destination in the popup
 * has a chapter is not proof the chapter is any good, but it is proof that
 * adding a view and forgetting the guide fails a test rather than shipping.
 */
describe('the guide covers what the product has', () => {
  const guide = read('extension/guide-data.js');
  const chapters = [...guide.matchAll(/^\s*id: '([a-z-]+)',$/gm)].map((m) => m[1]!);

  it('has chapters at all, so an empty match cannot pass this', () => {
    expect(chapters.length).toBeGreaterThan(10);
  });

  it('has a chapter for every destination in the popup', () => {
    const html = read('extension/popup.html');
    const destinations = [...html.matchAll(/data-go="([a-z]+)"/g)].map((m) => m[1]!);
    // The chapter ids are written for readers rather than matched to view
    // names, so the mapping is stated here rather than inferred.
    const covers: Record<string, string> = {
      sessions: 'sessions',
      tabs: 'tabs',
      trail: 'trail',
      parties: 'parties',
      storage: 'storage',
      settings: 'fingerprint',
      journal: 'journal',
      guide: 'idea',
    };
    for (const d of destinations) {
      expect(covers[d], `no mapping declared for the ${d} view`).toBeTruthy();
      expect(chapters, `the guide has no chapter for ${d}`).toContain(covers[d]);
    }
  });

  it('says what the product cannot do, not only what it can', () => {
    expect(guide).toContain('const LIMITS');
    const limits = guide.slice(guide.indexOf('const LIMITS'));
    expect([...limits.matchAll(/\['/g)].length).toBeGreaterThan(4);
  });

  /** Both surfaces read one array. A second copy is a guide that goes stale. */
  it('exists in exactly one file', () => {
    const carriers = SCRIPTS.filter((f) => /const GUIDE\s*=/.test(read(`extension/${f}`)));
    expect(carriers).toEqual(['guide-data.js']);
  });
});

/**
 * The three postures, in the three places that have to agree about them.
 *
 * They did not. The worker accepted `persona`, the guide taught it with a figure
 * naming all three, and the control in the popup offered two, so the flagship
 * feature of an entire milestone was unreachable by anybody who had not read the
 * source. Nothing failed and nothing looked wrong: the guide chapter was
 * correct, the setting worked when set, and the only symptom was an option that
 * was not there.
 *
 * This is the same shape as the command name checks above, one level up. A
 * feature is not shipped when the code path exists, it is shipped when a person
 * can reach it, and the only place that can be checked from is the text.
 */
describe('the postures agree across the worker, the control and the guide', () => {
  const worker = read('src/bg/index.ts');
  const control = read('extension/panel.js');
  const guide = read('extension/guide-data.js');

  /** What `setSettings` will actually accept, read from the comparison itself. */
  const accepted = [...worker.matchAll(/msg\.posture === '([a-z]+)'/g)].map((m) => m[1]!);

  /** What the control puts on screen. */
  const offered = (() => {
    const list = control.slice(control.indexOf('const POSTURES'));
    const end = list.indexOf('\n];');
    return [...list.slice(0, end).matchAll(/key: '([a-z]+)'/g)].map((m) => m[1]!);
  })();

  it('reads something at all, so an empty match cannot pass this', () => {
    expect(accepted.length).toBeGreaterThan(1);
    expect(offered.length).toBeGreaterThan(1);
  });

  it('offers every posture the worker accepts', () => {
    for (const p of accepted) {
      expect(offered, `the worker accepts ${p} and no control offers it`).toContain(p);
    }
  });

  it('offers nothing the worker would refuse', () => {
    for (const p of offered) {
      expect(accepted, `the control offers ${p} and the worker ignores it`).toContain(p);
    }
  });

  it('teaches every posture it offers, by name', () => {
    for (const p of offered) {
      const label = p[0]!.toUpperCase() + p.slice(1);
      expect(guide, `the guide never names ${label}`).toContain(label);
    }
  });

  it('gives each one its own explanation rather than one shared line', () => {
    const list = control.slice(control.indexOf('const POSTURES'));
    const notes = [...list.slice(0, list.indexOf('\n];')).matchAll(/note: '([^']+)'/g)].map(
      (m) => m[1]!
    );
    expect(notes.length).toBe(offered.length);
    expect(new Set(notes).size).toBe(notes.length);
  });
});

/**
 * The setup screen shows a colour beside each account and then creates a session
 * with one. Those have to be the same colour, decided once.
 *
 * The first version had them decided twice: the dot took the group's index in
 * the whole list and the session took its index among the ticked ones, so the
 * swatch somebody saw stopped being the colour they got the moment they unticked
 * anything above it. Exactly the drift `ramp.test.ts` exists to prevent one level
 * down, reintroduced in a new file.
 */
describe('the setup screen picks a colour once', () => {
  const source = read('extension/welcome.js');

  it('has one function that decides it', () => {
    expect(source).toMatch(/function colorFor\(/);
  });

  it('and reads COLORS nowhere else', () => {
    const uses = [...source.matchAll(/COLORS\[/g)].length;
    expect(uses, 'COLORS is indexed outside colorFor').toBe(1);
    expect(source.slice(source.indexOf('function colorFor('))).toMatch(/COLORS\[/);
  });
});

/**
 * Drawing a hint must not spend a reopen. The picker asks which session was last
 * used on this host so it can mark one option, and the function that answers
 * that question used to be the one that consumes the memory.
 */
describe('the picker peeks rather than takes', () => {
  const worker = read('src/bg/index.ts');

  it('has a peek that does not mutate', () => {
    const fn = worker.slice(worker.indexOf('function peekRemembered'));
    const body = fn.slice(0, fn.indexOf(String.fromCharCode(10) + '}'));
    expect(body).not.toContain('.pop(');
    expect(body).not.toContain('recentlyClosed.delete');
    expect(body).not.toContain('ephemeral.schedule');
  });

  it('and the picker uses it', () => {
    const at = worker.indexOf("case 'pickerOptions'");
    expect(at).toBeGreaterThan(0);
    const block = worker.slice(at, at + 600);
    expect(block).toContain('peekRemembered');
    expect(block).not.toMatch(/[^k]rememberedFor\(/);
  });
});

/**
 * The popup polls the worker every 1500 milliseconds because state changes
 * underneath it. Repainting on every poll tore the home view down and rebuilt
 * it, which replayed a staggered entrance animation that starts at zero
 * opacity, threw away the scroll position, and dropped any keyboard focus in
 * the list. It read as the popup flickering twice a second.
 *
 * Measured after the fix: nine rows survived seven seconds as the same DOM
 * nodes with the scroll position intact, and zero survived with the guard
 * disabled.
 */
describe('the popup does not repaint when nothing changed', () => {
  const js = read('extension/popup.js');
  const css = read('extension/popup.css');

  it('compares the whole view state before painting', () => {
    expect(js).toMatch(/function homeState\(/);
    expect(js).toMatch(/if \(!force && now === painted\) return;/);
  });

  /** A field missing here is a change that would never reach the screen. */
  it('and that state covers everything the four painters read', () => {
    const fn = js.slice(js.indexOf('function homeState('));
    const body = fn.slice(0, fn.indexOf(String.fromCharCode(10) + '}'));
    for (const field of ['desync', 'bindings', 'sessions', 'cookies', 'thirdPart', 'identity', 'pinned', 'telemetry']) {
      expect(body, `homeState ignores ${field}`).toContain(field);
    }
  });

  it('keeps the scroll position across a repaint that does happen', () => {
    expect(js).toMatch(/stage\?\.scrollTop \?\? 0/);
    expect(js).toMatch(/stage\.scrollTop = at/);
  });

  /** An entrance means "this just appeared", so it plays once. */
  it('plays the row entrance only on the first paint', () => {
    expect(css).toMatch(/\.opt-enter \.opt \{[^}]*animation: rise/);
    const opt = css.slice(css.indexOf(String.fromCharCode(10) + '.opt {'));
    expect(opt.slice(0, opt.indexOf('}')), '.opt animates unconditionally').not.toContain('animation:');
  });

  /**
   * The browser sizes a popup window from its document, so a CSS transition on
   * the width asks it to resize the window sixty times over a quarter second.
   */
  it('never animates its own width', () => {
    expect(css).not.toMatch(/transition:\s*width/);
  });
});

/**
 * The undo toast crosses three files: base.js defines toast, panel.js calls it
 * from the move bar, and popup.css styles it. Each of those is a name that has
 * to match one in another file, which is exactly the failure this suite exists
 * to catch, so the seam is pinned here.
 */
describe('the move bar can be taken back', () => {
  const base = read('extension/base.js');
  const panel = read('extension/panel.js');
  const css = read('extension/popup.css');

  it('defines toast where every page can reach it', () => {
    expect(base).toMatch(/function toast\(/);
  });

  it('offers undo after a move and wires it to a real reverse', () => {
    expect(panel).toMatch(/toast\(`Moved /);
    expect(panel).toContain('onClick: () => undoMove(prior)');
    expect(panel).toMatch(/async function undoMove\(/);
  });

  it('captures where tabs were before the move, not after', () => {
    const handler = panel.slice(panel.indexOf("to.addEventListener('change'"));
    const body = handler.slice(0, handler.indexOf('paintMoveBar();'));
    expect(body, 'prior bindings read after the move').toContain('const prior = new Map()');
  });

  it('sends the reverse back through the guarded move path', () => {
    const start = panel.indexOf('async function undoMove(');
    const body = panel.slice(start, panel.indexOf("toast('Move undone')", start));
    expect(body).toMatch(/cmd: 'moveTabs'/);
    expect(body, 'undo regroups by prior session first').toContain('const byDest = new Map()');
  });

  it('and popup.css styles the toast it shows', () => {
    expect(css).toMatch(/\.toast \{/);
    expect(css).toMatch(/\.toast-do \{/);
  });
});

/**
 * The telemetry consent surfaces cross the same kind of seams the rest of this
 * file guards: the popup shows a one-time card gated on state the worker sends,
 * the panel shows a toggle, and both talk to the worker over the setSettings
 * string. Pinned here so a rename on one side cannot silently unwire the other.
 */
describe('telemetry is opt-in and asks once', () => {
  const popup = read('extension/popup.js');
  const panel = read('extension/panel.js');
  const html = read('extension/popup.html');

  it('has a consent card, shown only when possible and not yet answered', () => {
    expect(popup).toMatch(/function paintConsent\(/);
    expect(popup).toContain('state.telemetryPossible === true');
    expect(popup).toContain("state.settings?.telemetryAsked !== true");
    expect(html).toContain('id="consent"');
  });

  it('records a decision either way, so No is remembered', () => {
    const card = popup.slice(popup.indexOf('function paintConsent('), popup.indexOf('function paintPaused('));
    expect(card).toContain("cmd: 'setSettings', telemetry: true");
    expect(card).toContain('telemetryAsked: true');
  });

  it('offers a Settings toggle only in a build that can send', () => {
    const block = panel.slice(panel.indexOf('function paintChannels('));
    expect(block).toContain('state.telemetryPossible');
    expect(block).toContain("cmd: 'setSettings', telemetry: next");
  });

  it('defaults off and never ships an endpoint from source', () => {
    expect(read('src/kernel/persist.ts')).toMatch(/telemetry: false/);
    // The endpoint is injected at package time from an env var, never written
    // into any tracked file.
    expect(read('tools/build.mjs')).toContain('process.env.NVX_TELEMETRY_URL');
  });
});

/**
 * The QoL trio: keyboard shortcuts, an undo for moves made with the popup
 * closed, and the default-account hint. Each crosses a seam the rest of this
 * file guards, so each is pinned where a rename would otherwise slip through.
 */
describe('moving the active tab by keyboard', () => {
  const worker = read('src/bg/index.ts');
  const mv3 = JSON.parse(read('extension/manifest.json'));
  const mv2 = JSON.parse(read('extension/manifest.mv2.json'));

  const moveCommands = (m: { commands: Record<string, unknown> }) =>
    Object.keys(m.commands).filter((k) => /^move-to-session-[1-9]$/.test(k));

  it('declares the same move commands in both manifests', () => {
    expect(moveCommands(mv3).sort()).toEqual(moveCommands(mv2).sort());
    expect(moveCommands(mv3).length).toBeGreaterThan(0);
  });

  it('never suggests more keys than the browser allows', () => {
    for (const m of [mv3, mv2]) {
      const suggested = Object.values(m.commands).filter(
        (c) => c && typeof c === 'object' && 'suggested_key' in (c as object)
      );
      expect(suggested.length, 'at most four commands may suggest a key').toBeLessThanOrEqual(4);
    }
  });

  it('has a handler that routes every declared move command', () => {
    expect(worker).toMatch(/move-to-session-\(\[1-9\]\)/);
    expect(worker).toMatch(/function moveActiveToNth\(/);
    // The Nth session, one-based, so the number matches the list the user sees.
    const fn = worker.slice(worker.indexOf('function moveActiveToNth('));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('sessions[n - 1]');
  });
});

describe('an undo survives a move made with the popup closed', () => {
  const worker = read('src/bg/index.ts');
  const popup = read('extension/popup.js');
  const html = read('extension/popup.html');

  it('remembers only single-tab moves that asked to be remembered', () => {
    expect(worker).toMatch(/opts: \{ remember\?: boolean \} = \{\}/);
    expect(worker).toContain('opts.remember && ids.length === 1');
  });

  it('offers undo and keep in the popup, both real commands', () => {
    expect(popup).toMatch(/function paintMoved\(/);
    expect(html).toContain('id="moved"');
    const card = popup.slice(popup.indexOf('function paintMoved('), popup.indexOf('function paintPaused('));
    expect(card).toContain("cmd: 'undoLastMove'");
    expect(card).toContain("cmd: 'dismissLastMove'");
  });

  it('and the worker answers both', () => {
    expect(worker).toContain("case 'undoLastMove'");
    expect(worker).toContain("case 'dismissLastMove'");
  });
});

describe('the default-account hint names no provider', () => {
  const popup = read('extension/popup.js');

  it('keys the hint on the detected identity and its domain, not a hardcoded site', () => {
    const fn = popup.slice(popup.indexOf('function paintHere('), popup.indexOf('function paintSwitch('));
    expect(fn).toContain('session.identityDomain');
    expect(fn).toContain('session.identity');
    // No provider hostname is baked into the popup's hint logic.
    expect(fn).not.toMatch(/google\.com|microsoftonline|okta/i);
  });
});
