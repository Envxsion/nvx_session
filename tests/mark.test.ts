/**
 * ------------------------------------------------------------------
 *  Title    |  The mark after the extension goes away
 *  Ref      |  mark shim (link rel=icon watchdog)
 *  ID       |  test (mark)
 * ------------------------------------------------------------------
 *  Purpose  |  A removed extension leaves every managed tab wearing its
 *           |  dot. The in-page shim, all that survives, watches the
 *           |  stamp the agent refreshed and clears the mark when it
 *           |  stops moving.
 *  Note     |  Tested here, not in a browser: neither CDP uninstall nor
 *           |  setDisabled actually stops the extension on Opera GX 134,
 *           |  so the heartbeat kept ticking. See STATUS.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Enough DOM for the watchdog, and no more. */
class El {
  readonly attrs = new Map<string, string>();
  readonly children: El[] = [];
  constructor(
    readonly tag: string,
    private readonly doc: Doc
  ) {}
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  append(child: El): void {
    this.children.push(child);
    this.doc.all.push(child);
  }
  /** The watchdog asks the head, not the document, before re-adding an icon. */
  querySelector(selector: string): El | null {
    return this.doc.querySelector(selector);
  }
  remove(): void {
    const i = this.doc.all.indexOf(this);
    if (i >= 0) this.doc.all.splice(i, 1);
    for (const parent of this.doc.all) {
      const j = parent.children.indexOf(this);
      if (j >= 0) parent.children.splice(j, 1);
    }
  }
  set rel(v: string) {
    this.setAttribute('rel', v);
  }
  get rel(): string {
    return this.getAttribute('rel') ?? '';
  }
  set href(v: string) {
    this.setAttribute('href', v);
  }
  get href(): string {
    return this.getAttribute('href') ?? '';
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Matches selectors by hand against the three shapes the
 *           |  watchdog uses.
 *  Note     |  A real CSS engine would be a dependency and a fiction;
 *           |  the test is the decision and the repair, not the engine.
 * ------------------------------------------------------------------
 */
class Doc extends EventTarget {
  all: El[] = [];
  documentElement = new El('html', this);
  head = new El('head', this);

  createElement(tag: string): El {
    return new El(tag, this);
  }

  private match(el: El, selector: string): boolean {
    if (selector.includes('data-nvx-mark')) return el.hasAttribute('data-nvx-mark');
    if (selector.includes('rel~="icon"')) {
      if (!/icon/i.test(el.rel)) return false;
      const href = /href="([^"]*)"/.exec(selector)?.[1];
      return href === undefined || el.href === href;
    }
    return false;
  }

  querySelector(selector: string): El | null {
    return this.all.find((el) => this.match(el, selector)) ?? null;
  }

  querySelectorAll(selector: string): El[] {
    return this.all.filter((el) => this.match(el, selector));
  }
}

class FakeStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(String(k)) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(String(k), String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
}

const MARK = 'data-nvx-mark';
const WAS = 'data-nvx-was';
const ALIVE = 'data-nvx-alive';

let doc: Doc;

/** Runs the real shim against a page that is already wearing a mark. */
async function boot(opts: { was?: string[]; marks?: number } = {}): Promise<void> {
  doc = new Doc();
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.localStorage = new FakeStorage();
  win.sessionStorage = new FakeStorage();
  win.top = win;

  const g = globalThis as Record<string, unknown>;
  g.Storage = FakeStorage;
  g.window = win;
  g.document = doc;
  g.CSS = { escape: (v: string) => v };

  for (let i = 0; i < (opts.marks ?? 1); i++) {
    const mark = doc.createElement('link');
    mark.setAttribute(MARK, '');
    mark.rel = 'icon';
    mark.href = `data:image/png;base64,MARK${i}`;
    mark.setAttribute(WAS, JSON.stringify(opts.was ?? ['https://site.example/favicon.ico']));
    doc.head.append(mark);
  }

  vi.resetModules();
  await import('../src/content/shim.js');
}

function beat(at = Date.now()): void {
  doc.documentElement.setAttribute(ALIVE, String(at));
}

const marks = () => doc.querySelectorAll(`link[${MARK}]`);
const icons = () => doc.querySelectorAll('link[rel~="icon" i]');

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the mark outliving the extension', () => {
  it('is left alone while the agent is still stamping', async () => {
    await boot();
    for (let i = 0; i < 10; i++) {
      beat();
      await vi.advanceTimersByTimeAsync(4000);
    }
    expect(marks()).toHaveLength(1);
  });

  it('comes off once the stamp stops moving', async () => {
    await boot();
    beat();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(marks()).toHaveLength(0);
  });

  it('and the page gets the icon it had back', async () => {
    await boot({ was: ['https://site.example/favicon.ico'] });
    beat();
    await vi.advanceTimersByTimeAsync(60_000);
    const back = icons();
    expect(back).toHaveLength(1);
    expect(back[0]!.href).toBe('https://site.example/favicon.ico');
  });

  /**
   * A page that never had one is not given one. Restoring an icon the site did
   * not declare would put a request on the wire that the page never asked for.
   */
  it('leaves a page that had no icon with no icon', async () => {
    await boot({ was: [] });
    beat();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(icons()).toHaveLength(0);
  });

  it('clears every mark, not just the first', async () => {
    await boot({ marks: 3 });
    beat();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(marks()).toHaveLength(0);
  });

  /**
   * The threshold has to survive a background tab whose timers the browser has
   * throttled. Twenty seconds of nothing is the line; a gap under it is an
   * ordinary lull and must not strip a live mark.
   */
  it('tolerates a lull without stripping a live mark', async () => {
    await boot();
    beat();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(marks()).toHaveLength(1);
    beat();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(marks()).toHaveLength(1);
  });

  it('does not restore an icon the page has already put back itself', async () => {
    await boot({ was: ['https://site.example/favicon.ico'] });
    const own = doc.createElement('link');
    own.rel = 'icon';
    own.href = 'https://site.example/favicon.ico';
    doc.head.append(own);
    beat();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(icons()).toHaveLength(1);
  });

  /** An unreadable record costs the page its icon, never the page itself. */
  it('survives a restore record it cannot parse', async () => {
    await boot();
    for (const m of marks()) m.setAttribute(WAS, 'not json');
    beat();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(marks()).toHaveLength(0);
  });

  /**
   * The stamp is never written on a page that was never marked, so a page with
   * no mark must not be swept by a watchdog that sees no heartbeat either.
   */
  it('does nothing at all on a page that was never marked', async () => {
    await boot({ marks: 0 });
    const own = doc.createElement('link');
    own.rel = 'icon';
    own.href = 'https://site.example/favicon.ico';
    doc.head.append(own);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(icons()).toHaveLength(1);
  });
});

/**
 * The other half lives in the agent, and the two only work together: a stamp
 * nobody writes strips every mark on sight, and a record nobody writes leaves
 * the page with no icon. Checked as text because the agent needs a browser to
 * run and this is the cheap half of the guarantee.
 */
describe('the agent holds up its end', () => {
  const agent = readAgent();
  function readAgent(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'content', 'agent.ts'),
      'utf8'
    );
  }

  it('stamps the document on an interval', () => {
    expect(agent).toContain("const ALIVE = 'data-nvx-alive'");
    expect(agent).toMatch(/setInterval\(beat, BEAT_MS\)/);
  });

  it('records what the page had onto the mark itself', () => {
    expect(agent).toContain("const RESTORE = 'data-nvx-was'");
    expect(agent).toMatch(/setAttribute\(RESTORE/);
  });

  it('beats faster than the watchdog gives up', () => {
    const beat = Number(/const BEAT_MS = (\d+)/.exec(agent)?.[1]);
    const shim = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'content', 'shim.ts'),
      'utf8'
    );
    const stale = Number(/const STALE_MS = ([\d_]+)/.exec(shim)?.[1].replace(/_/g, ''));
    expect(beat).toBeGreaterThan(0);
    expect(stale).toBeGreaterThan(beat * 2);
  });
});
