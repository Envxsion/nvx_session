/**
 * ------------------------------------------------------------------
 *  Title    |  Storage isolation proof
 *  Ref      |  store/keys.ts, the storage shim
 *  ID       |  test (storage isolation)
 * ------------------------------------------------------------------
 *  Purpose  |  In-browser proof that web storage isolates per
 *           |  session, the same shape as the cookie isolation suite:
 *           |  throwaway sessions, real tabs, every claim measured in
 *           |  the page rather than reasoned about in the worker.
 *  Note     |  Assertions run in the MAIN world, where the shim and a
 *           |  site's own script live, so a pass is what a site would
 *           |  actually observe.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

import { CookieStore } from '../jar/store.js';
import type { Registry } from '../kernel/registry.js';
import type { Netfilter } from '../netfilter/types.js';
import { manifestVersion } from '../platform.js';
import { NS, namespaceFor, SEP, STAMP } from '../store/keys.js';
import type { Check } from './selftest.js';
import { DEFAULT_DANGER } from '../guard/policy.js';

export interface StorageTestResult {
  ok: boolean;
  checks: Check[];
  error?: string;
}

const A = '__nvx_storagetest_a';
const B = '__nvx_storagetest_b';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Reads the real store, past the shim.
 *  Note     |  localStorage is an own accessor on window in Blink, so
 *           |  the shim's defineProperty replaces it outright and
 *           |  Window.prototype has nothing to recover. What still
 *           |  reaches the real store is a fresh same-origin
 *           |  about:blank frame: it inherits the origin and storage
 *           |  but is unshimmed. That is the honest limit, and the
 *           |  suite exercises it: a page can read another session's
 *           |  storage on its own origin in three lines. Cookies lack
 *           |  that property, the jar never enters the browser store.
 * ------------------------------------------------------------------
 */
function rawStore(): { keys: Record<string, string>; viaFrame: boolean } {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  document.documentElement.append(frame);
  const inner = frame.contentWindow as (Window & typeof globalThis) | null;
  const store = (inner?.localStorage ?? window.localStorage) as Storage;
  const keys: Record<string, string> = {};
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k !== null) keys[k] = store.getItem(k) ?? '';
  }
  const viaFrame = Boolean(inner);
  frame.remove();
  return { keys, viaFrame };
}

function wipeRaw(): void {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  document.documentElement.append(frame);
  const inner = frame.contentWindow as (Window & typeof globalThis) | null;
  try {
    (inner?.localStorage ?? window.localStorage).clear();
    (inner?.sessionStorage ?? window.sessionStorage).clear();
  } catch {
    /* nothing to clear */
  }
  frame.remove();
}

async function inPage<T, Args extends unknown[]>(
  tabId: number,
  func: (...args: Args) => T,
  args: Args
): Promise<T | null> {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: func as (...a: unknown[]) => unknown,
      args,
    });
    return (r?.result as T) ?? null;
  } catch {
    return null;
  }
}

async function loaded(tabId: number, url: string): Promise<void> {
  await chrome.tabs.update(tabId, { url });
  await new Promise<void>((resolve) => {
    const done = (id: number, info: { status?: string | undefined }) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(resolve, 10_000);
  });
}

export async function runStorageTest(
  registry: Registry,
  engine: Netfilter,
  opts: {
    /** Re-registers the content scripts, so the shim reaches the fixture host. */
    refresh: () => Promise<void>;
    /** What the shim reported for a tab, so the suite waits rather than guesses. */
    stateOf: (tabId: number) => { mode: string; sid: string | null } | undefined;
    /**
     * Declares the control tab deliberately unmanaged. Without it the tab is
     * held at the picker, because more than one session covers the fixture
     * origin by the time this runs, and the suite's whole control arm is a tab
     * that was meant to be left alone.
     */
    leaveUnmanaged?: (tabId: number, url: string) => void;
    fixture?: string;
  }
): Promise<StorageTestResult> {
  const fixture = opts.fixture ?? 'http://localhost:8787';
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string) =>
    checks.push({ name, pass, ...(detail ? { detail } : {}) });

  if (manifestVersion() !== 3) {
    return {
      ok: false,
      checks: [],
      error:
        'Storage virtualisation needs a MAIN world content script, which manifest v2 has no way to declare. This build isolates cookies only.',
    };
  }

  const tabs: number[] = [];
  const cleanup = async () => {
    if (tabs[0] !== undefined) await inPage(tabs[0], wipeRaw, []);
    for (const t of tabs) {
      try {
        await chrome.tabs.remove(t);
      } catch {
        /* already gone */
      }
    }
    for (const id of [A, B]) {
      registry.deleteSession(id);
      await engine.retire(id);
    }
    await opts.refresh();
  };

  /** Waits for the shim in a tab to stop being pending. */
  const settled = async (tabId: number): Promise<string> => {
    for (let i = 0; i < 40; i++) {
      const state = opts.stateOf(tabId);
      if (state && state.mode !== 'pending') return state.mode;
      await new Promise((r) => setTimeout(r, 100));
    }
    return 'pending';
  };

  try {
    const probe = await fetch(`${fixture}/echo`, { cache: 'no-store' }).catch(() => null);
    if (!probe?.ok) {
      return {
        ok: false,
        checks: [],
        error: `The fixture origin at ${fixture} is not answering. Start it with: node tools/fixture/server.mjs`,
      };
    }

    const win = await chrome.windows.getCurrent();
    const mk = async () => {
      const t = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: win.id });
      tabs.push(t.id!);
      return t.id!;
    };

    // The control tab comes first and stays unmanaged, so it is also what puts
    // the origin's own data in place for the fork check.
    const control = await mk();
    opts.leaveUnmanaged?.(control, `${fixture}/page`);
    const a = await mk();
    const b = await mk();

    for (const id of [A, B]) {
      registry.createSession({
        id,
        label: id,
        color: 'cyan',
        pinned: ['localhost'],
        store: new CookieStore(),
        family: [],
        forked: [],
        danger: DEFAULT_DANGER,
        thirdParty: 'allow',
        createdAt: Date.now(),
        lastSeen: Date.now(),
      });
    }
    // Registration has to land before the tabs navigate, or the first document
    // has no shim and the whole suite measures nothing.
    await opts.refresh();

    await loaded(control, `${fixture}/page?nvx=control`);
    await settled(control);
    add(
      'an unmanaged tab is left alone',
      opts.stateOf(control)?.mode === 'through',
      opts.stateOf(control)?.mode ?? 'never reported'
    );

    await inPage(
      control,
      (k: string, v: string) => {
        localStorage.clear();
        localStorage.setItem(k, v);
      },
      ['token', 'FROM_PROFILE']
    );
    const plain = await inPage(control, rawStore, []);
    add(
      'the origin keeps its own data unprefixed',
      plain?.keys.token === 'FROM_PROFILE',
      Object.keys(plain?.keys ?? {}).join(', ') || 'empty'
    );

    for (const [tabId, sessionId] of [
      [a, A],
      [b, B],
    ] as const) {
      const m = registry.bind(tabId, sessionId, {
        windowId: win.id ?? -1,
        url: `${fixture}/page`,
        origin: 'manual',
      });
      engine.markDirty(m.dirty);
    }
    await engine.flush();

    await loaded(a, `${fixture}/page?nvx=a`);
    const modeA = await settled(a);
    add('a managed tab virtualises its storage', modeA === 'live', modeA);
    add('and knows which session it is', opts.stateOf(a)?.sid === A, opts.stateOf(a)?.sid ?? 'none');

    // Fork. The session arrives on an origin it has never seen, and inherits
    // what the profile already had, exactly as adoption copies cookies.
    const forked = await inPage(a, (k: string) => localStorage.getItem(k), ['token']);
    add('a session arriving on an origin inherits what the profile had', forked === 'FROM_PROFILE', String(forked));
    add(
      'and the origin still has its own copy, because forking copies',
      (await inPage(control, (k: string) => localStorage.getItem(k), ['token'])) === 'FROM_PROFILE'
    );

    await loaded(b, `${fixture}/page?nvx=b`);
    await settled(b);

    await inPage(a, (k: string, v: string) => localStorage.setItem(k, v), ['token', 'A_ONLY']);
    await inPage(b, (k: string, v: string) => localStorage.setItem(k, v), ['token', 'B_ONLY']);

    const readA = await inPage(a, (k: string) => localStorage.getItem(k), ['token']);
    const readB = await inPage(b, (k: string) => localStorage.getItem(k), ['token']);
    add('one session reads back its own value', readA === 'A_ONLY', String(readA));
    add('the other reads back its own', readB === 'B_ONLY', String(readB));
    add('neither overwrote the other', readA !== readB);

    const origin = new URL(fixture).origin;
    const nsA = namespaceFor(A, origin);
    const nsB = namespaceFor(B, origin);

    const raw = (await inPage(a, rawStore, [])) ?? { keys: {}, viaFrame: false };
    add(
      'both live in the real store under separate namespaces',
      raw.keys[`${NS}${nsA}${SEP}token`] === 'A_ONLY' &&
        raw.keys[`${NS}${nsB}${SEP}token`] === 'B_ONLY',
      `${Object.keys(raw.keys).length} raw key(s)`
    );
    /**
     * And the namespace is not the session id, which is the whole point of it
     * being a derived token. A page reads these key names through the frame
     * above, and the id is the same string on every origin in the session, so a
     * name carrying it would let two unrelated sites discover they were looking
     * at the same person.
     */
    add(
      'and neither namespace names the session it belongs to',
      !Object.keys(raw.keys).some((k) => k.includes(A) || k.includes(B)),
      Object.keys(raw.keys).filter((k) => k.startsWith(NS)).join(', ')
    );
    // Stated as a check rather than a caveat in a document. This is correctness
    // isolation, not confidentiality: a page can still reach every namespace on
    // its own origin, and the suite proves it every run so nobody later mistakes
    // the guarantee for a stronger one.
    add(
      'and a page can still reach them through an about:blank frame, which is the known limit',
      raw.viaFrame && Object.keys(raw.keys).some((k) => k.startsWith(NS))
    );

    // The whole point of the shim, stated as a check: a page enumerating its
    // own storage must not find the other account's key names.
    const seen = (await inPage(a, () => Object.keys(localStorage), [])) ?? [];
    add('a page cannot enumerate another session’s keys', seen.every((k) => !k.startsWith(NS)), seen.join(', '));
    add('nor the tab stamp', !seen.includes(STAMP));

    const controlSees = await inPage(control, (k: string) => localStorage.getItem(k), ['token']);
    add(
      'an unmanaged tab still sees the profile’s own value, not a session’s',
      controlSees === 'FROM_PROFILE',
      String(controlSees)
    );

    await inPage(a, () => localStorage.clear(), []);
    add(
      'clearing one session leaves the other intact',
      (await inPage(b, (k: string) => localStorage.getItem(k), ['token'])) === 'B_ONLY'
    );
    add(
      'and leaves the origin’s own data intact',
      (await inPage(control, (k: string) => localStorage.getItem(k), ['token'])) === 'FROM_PROFILE'
    );

    // A second load in the same tab commits from the stamp, with no window at
    // all between document_start and knowing which session it is.
    await loaded(b, `${fixture}/page?nvx=b2`);
    const again = await inPage(b, (k: string) => localStorage.getItem(k), ['token']);
    add('a reload comes back to the same session', again === 'B_ONLY', String(again));

    add(
      'the session recorded that it forked this origin',
      registry.getSession(A)?.forked.includes(`http://localhost:8787`) === true,
      registry.getSession(A)?.forked.join(', ') || 'none'
    );

    // ------------------------------------------ the extension, seen by a page

    /**
     * Everything below is what an ordinary inline script can do with no
     * privileges, and each answer used to be the wrong one.
     *
     * The shim and the mask both run in the MAIN world, which is the page's own
     * world. It has no privacy from the page, and treating it as if it did put
     * three things in reach: the extension's name, a session identifier stable
     * across every origin in that session, and a channel that took instructions.
     */
    await loaded(b, `${fixture}/detect`);
    await settled(b);

    const exposed = await inPage<{ globals: string[]; heard: string[]; sid: string | null }, []>(
      b,
      () => {
        const probe = (window as unknown as { __nvxProbe?: Record<string, unknown> }).__nvxProbe;
        return {
          // The probe's own handle is excluded by exact name. Anything else
          // matching is the extension, which is the thing being asked about.
          globals: Object.getOwnPropertyNames(window).filter(
            (k) => /nvx/i.test(k) && k !== '__nvxProbe'
          ),
          heard: (probe?.heard as string[]) ?? [],
          sid: (probe?.sid as string | null) ?? null,
        };
      },
      []
    );

    /**
     * The one that undoes the rest of the work. Every anti-introspection measure
     * in the mask is spent on making patched functions indistinguishable from
     * native ones, and a named property on `window` defeats all of it in one
     * line. Worse than defeating it: an extension only a few people run is a
     * stronger identifier than the fingerprint it was hiding, so announcing
     * itself makes its user more identifiable rather than less.
     */
    add(
      'a page cannot find the extension by name on its own window',
      (exposed?.globals.length ?? 1) === 0,
      `found ${exposed?.globals.join(', ') || 'nothing'}`
    );

    /**
     * The session id is the same string on every origin in that session, so a
     * page that can read it can link its visitor across every site they use in
     * that session. That is the precise thing this product exists to prevent,
     * offered on a channel with a fixed name.
     */
    /**
     * Named for what it proves, which is narrower than it first read.
     *
     * The channel is closed. The session id is still recoverable on an origin
     * where that session has written something, because the namespace prefix on
     * the real keys contains it and a same-origin `about:blank` frame reaches
     * the real store. That is the same hole this file already documents for
     * cross-session reads, and it means the identifier is per-visit-history
     * rather than broadcast. Closing it properly means namespacing on a token
     * derived per origin instead of on the session id itself.
     */
    add(
      'and cannot overhear its session id on a channel',
      !exposed?.sid,
      `overheard ${exposed?.sid ?? 'nothing'} after ${exposed?.heard.join(', ') || 'no traffic'}`
    );

    /**
     * The worst of the three. The shim took a session id from a page event with
     * no authentication at all, so a page that had learned another session's id,
     * by listening on an earlier visit, could name it and be handed that
     * session's storage for this origin.
     */
    const crossed = await inPage(
      b,
      (other: string, key: string) => {
        const probe = (window as unknown as { __nvxProbe?: { becomeSession?: (s: string) => void } })
          .__nvxProbe;
        probe?.becomeSession?.(other);
        return localStorage.getItem(key);
      },
      [A, 'token']
    );
    add(
      'and cannot talk the shim into another session',
      crossed !== 'A_ONLY',
      `session B read ${String(crossed)} where the other session wrote A_ONLY`
    );

    /**
     * The same instruction sent into the window the handshake leaves open.
     *
     * The shim holds writes from document_start until the worker answers with a
     * session id, and the page's own scripts run inside that wait. So a page
     * that speaks first is not racing a decision that has been made, it is
     * making it. This is the variant that matters, and the one the check above
     * missed by arriving after the real answer.
     */
    await loaded(b, `${fixture}/detect?as=${encodeURIComponent(A)}`);
    await settled(b);
    const raced = await inPage<string | null, []>(
      b,
      () => ((window as unknown as { __nvxProbe?: { raced?: string } }).__nvxProbe?.raced ?? null),
      []
    );
    add(
      'and cannot claim a session by answering before the extension does',
      raced !== 'A_ONLY',
      `a page in session B read ${String(raced)} by naming session A first`
    );

    return { ok: checks.every((c) => c.pass), checks };
  } catch (e) {
    return { ok: false, checks, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await cleanup();
  }
}
