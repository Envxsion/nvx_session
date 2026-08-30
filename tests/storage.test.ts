/**
 * Storage virtualisation.
 *
 * Two halves. The key maths in src/store/keys.ts is what the kernel and the
 * tests reason about; the shim in src/content/shim.ts is what actually runs,
 * and it carries its own copy because a content script cannot import. So the
 * shim is exercised here for real, against a fake origin store, rather than
 * being trusted to agree with a module it cannot use.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NS,
  SEP,
  PERSONA,
  STAMP,
  forkPlan,
  isNamespaced,
  keysFor,
  namespaceFor,
  namespacesIn,
  nsKey,
  plainKeys,
  unNsKey,
  usableSessionId,
} from '../src/store/keys.js';

describe('namespacing', () => {
  it('round trips an ordinary key', () => {
    const raw = nsKey('s_a1', 'token');
    expect(raw).toBe('__nvx~s_a1~token');
    expect(unNsKey('s_a1', raw)).toBe('token');
  });

  it('refuses to hand one session another session’s key', () => {
    expect(unNsKey('s_b2', nsKey('s_a1', 'token'))).toBeNull();
  });

  it('leaves a key that merely looks like ours alone', () => {
    expect(unNsKey('s_a1', 'token')).toBeNull();
    expect(unNsKey('s_a1', '__nvx~nosep')).toBeNull();
  });

  // A page is entitled to store a key containing our prefix, and it must come
  // back exactly as it went in.
  it('round trips a page key that contains the prefix', () => {
    const raw = nsKey('s_a1', '__nvx~evil~key');
    expect(unNsKey('s_a1', raw)).toBe('__nvx~evil~key');
  });

  it('separates the origin’s own keys from every namespace', () => {
    const raw = ['token', nsKey('s_a1', 'token'), nsKey('s_b2', 'x'), STAMP, 'theme'];
    expect(plainKeys(raw)).toEqual(['token', 'theme']);
    expect(keysFor('s_a1', raw)).toEqual(['token']);
    expect(namespacesIn(raw)).toEqual(['s_a1', 's_b2']);
  });

  it('rejects a session id that would alias two namespaces', () => {
    expect(usableSessionId('s_a1')).toBe(true);
    expect(usableSessionId(`s${SEP}a1`)).toBe(false);
    expect(usableSessionId('')).toBe(false);
    expect(usableSessionId('x'.repeat(129))).toBe(false);
  });

  it('knows a namespaced key from a bare prefix', () => {
    expect(isNamespaced(`${NS}s_a1${SEP}k`)).toBe(true);
    expect(isNamespaced(NS)).toBe(false);
    expect(isNamespaced('plain')).toBe(false);
  });
});

describe('forking an origin into a session', () => {
  it('copies the origin’s own data and nothing else', () => {
    const raw = ['token', 'theme', nsKey('s_b2', 'token'), STAMP];
    const plan = forkPlan('s_a1', raw);
    expect(plan.skipped).toBe(false);
    expect(plan.copies).toEqual([
      { from: 'token', to: nsKey('s_a1', 'token') },
      { from: 'theme', to: nsKey('s_a1', 'theme') },
    ]);
  });

  // Otherwise a site calling clear() and reloading silently gets the profile's
  // data back, which looks exactly like the sign-out not working.
  it('does nothing once the session has data of its own', () => {
    const plan = forkPlan('s_a1', ['token', nsKey('s_a1', 'seen')]);
    expect(plan).toEqual({ copies: [], skipped: true });
  });
});

// --------------------------------------------------------------- the shim

/** A Storage that behaves like the real one, including insertion order. */
class FakeStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
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
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.m);
  }
}

interface Harness {
  local: FakeStorage;
  session: FakeStorage;
  /** The fake document, for driving document.cookie reads and writes. */
  doc: { cookie: string };
  /** The cookie writes the shim forwarded to the agent, in order. */
  cookies: Array<{ value: string; url: string }>;
  page: { localStorage: Storage; sessionStorage: Storage };
  /** Answers the shim as the agent would. */
  commit(sid: string | null, fork?: boolean, ...persona: Array<string | null>): void;
  /** A full commit payload, for fields the positional helper does not carry (idb). */
  commitWith(payload: Record<string, unknown>): void;
  /** The IndexedDB reports the shim forwarded, in order. */
  idb: Array<{ used: boolean }>;
  states: Array<{ sid: string | null; mode: string; forked: number }>;
  /** The nonce the shim announced, so a test can assert it is not guessable. */
  channel(): string;
}

/**
 * Runs the real shim source against a fake origin.
 *
 * `agent` decides whether an ISOLATED-world agent is present, which is the
 * signal the shim uses to tell a managed tab from an unmanaged one.
 */
async function boot(
  opts: {
    agent?: boolean;
    subframe?: boolean;
    local?: Record<string, string>;
    session?: Record<string, string>;
    /** A fake IndexedDB factory, injected before the shim wraps it at load. */
    indexedDB?: unknown;
    /** A fake CacheStorage, injected before the shim wraps it at load. */
    caches?: unknown;
  } = {}
): Promise<Harness> {
  const local = new FakeStorage();
  const session = new FakeStorage();
  for (const [k, v] of Object.entries(opts.local ?? {})) local.setItem(k, v);
  for (const [k, v] of Object.entries(opts.session ?? {})) session.setItem(k, v);

  /**
   * A document with a real cookie accessor, so the shim's document.cookie wrap
   * has a native get and set to capture. Defined per boot so its prototype is
   * fresh each time and one test's wrap does not nest onto the next. The jar is
   * a minimal replace-by-name, which is all the shim's read-through needs.
   */
  class FakeDocument extends EventTarget {
    private jar = '';
    get cookie(): string {
      return this.jar;
    }
    set cookie(value: string) {
      const pair = String(value).split(';')[0]!.trim();
      const eq = pair.indexOf('=');
      const name = eq >= 0 ? pair.slice(0, eq) : pair;
      const kept = (this.jar ? this.jar.split('; ') : []).filter(
        (p) => p.split('=')[0] !== name
      );
      kept.push(pair);
      this.jar = kept.filter(Boolean).join('; ');
    }
  }

  const doc = new FakeDocument();
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.localStorage = local;
  win.sessionStorage = session;
  // Injected before the import below, because the shim wraps window.indexedDB
  // once at document_start; a factory set afterwards would never be wrapped.
  if (opts.indexedDB) win.indexedDB = opts.indexedDB;
  if (opts.caches) win.caches = opts.caches;
  // A subframe shares the tab's storage but never gets an agent.
  win.top = opts.subframe ? {} : win;

  const g = globalThis as Record<string, unknown>;
  g.Storage = FakeStorage;
  g.Document = FakeDocument;
  g.window = win;
  g.document = doc;
  // The shim reads location.href when it forwards a cookie. A bare location in a
  // content script's world is window.location; the tests only need an href.
  g.location = { href: 'https://example.com/' };

  /**
   * The harness learns the channel the way the agent does, because there is no
   * other way to learn it.
   *
   * Everything after the announcement runs on a per-document nonce, so a test
   * that kept using the old fixed names would be testing a channel nothing
   * listens on. Following the handshake here means the suite exercises the same
   * rendezvous a real page's agent does, which is worth more than the two lines
   * it costs.
   */
  const states: Harness['states'] = [];
  const cookies: Array<{ value: string; url: string }> = [];
  const idb: Array<{ used: boolean }> = [];
  let channel = '';

  doc.addEventListener('__nvx.storage.ready', (e) => {
    channel = String(JSON.parse(String((e as CustomEvent).detail)).channel ?? '');
    doc.addEventListener(`${channel}.state`, (ev) => {
      states.push(JSON.parse(String((ev as CustomEvent).detail)));
    });
    doc.addEventListener(`${channel}.idb`, (ev) => {
      idb.push(JSON.parse(String((ev as CustomEvent).detail)));
    });
    // The agent's half of the document.cookie route: it relays these to the
    // worker. Captured here so a test can see what the page's writes forwarded.
    doc.addEventListener(`${channel}.cookie`, (ev) => {
      cookies.push(JSON.parse(String((ev as CustomEvent).detail)));
    });
    // Synchronous, exactly as the agent answers it.
    if (opts.agent !== false) {
      doc.dispatchEvent(new CustomEvent(`${channel}.wait`, { detail: '{}' }));
    }
  });

  vi.resetModules();
  await import('../src/content/shim.js');

  return {
    local,
    session,
    doc: doc as unknown as { cookie: string },
    cookies,
    page: win as unknown as Harness['page'],
    // `persona` left out of the payload entirely when it was not passed, which
    // is what an older worker's message looks like and is a different case from
    // saying there is none.
    commit: (sid, fork = false, ...rest) =>
      doc.dispatchEvent(
        new CustomEvent(`${channel}.commit`, {
          detail: JSON.stringify(rest.length ? { sid, fork, persona: rest[0] } : { sid, fork }),
        })
      ),
    commitWith: (payload) =>
      doc.dispatchEvent(
        new CustomEvent(`${channel}.commit`, { detail: JSON.stringify(payload) })
      ),
    idb,
    states,
    channel: () => channel,
  };
}

describe('the shim, running', () => {
  /**
   * The namespace token, which is the difference between correctness isolation
   * and handing out a cross-site correlator. A page reads these key names
   * through a same-origin about:blank frame, so every property below is a
   * property of something the page can see.
   */
  describe('the namespace token', () => {
    const origin = 'https://example.com';

    it('never contains the session it belongs to', () => {
      const token = namespaceFor('s_a1', origin);
      expect(token).not.toContain('s_a1');
      expect(token).not.toContain('a1');
    });

    /** The whole point: the same session looks unrelated on two sites. */
    it('is different on a different origin, for the same session', () => {
      expect(namespaceFor('s_a1', origin)).not.toBe(
        namespaceFor('s_a1', 'https://other.example')
      );
    });

    it('is different for a different session, on the same origin', () => {
      expect(namespaceFor('s_a1', origin)).not.toBe(namespaceFor('s_b2', origin));
    });

    /** A reload has to find its own data, so this cannot be per-visit. */
    it('is the same every time it is asked', () => {
      expect(namespaceFor('s_a1', origin)).toBe(namespaceFor('s_a1', origin));
    });

    /**
     * It is concatenated into a key and split back out on the first separator,
     * so a token containing one would alias two namespaces onto each other.
     */
    it('survives the key maths it is fed to', () => {
      const token = namespaceFor('s_a1', origin);
      expect(token).not.toContain(SEP);
      expect(usableSessionId(token)).toBe(true);
      expect(unNsKey(token, nsKey(token, 'k'))).toBe('k');
    });

    /** Fixed width, so no pair can borrow a digit from the other half. */
    it('is a fixed length whatever it hashes', () => {
      const lengths = new Set<number>();
      for (let i = 0; i < 500; i++) lengths.add(namespaceFor(`s_${i}`, origin).length);
      expect([...lengths]).toHaveLength(1);
    });

    it('does not collide across a realistic number of sessions and origins', () => {
      const seen = new Set<string>();
      for (let o = 0; o < 200; o++) {
        for (let i = 0; i < 50; i++) seen.add(namespaceFor(`s_${i}`, `https://site${o}.example`));
      }
      expect(seen.size).toBe(200 * 50);
    });
  });

  it('agrees with the key maths it cannot import', () => {
    const src = readFileSync('src/content/shim.ts', 'utf8');
    expect(src).toContain(`const NS = '${NS}'`);
    expect(src).toContain(`const SEP = '${SEP}'`);
    expect(src).toContain(`const STAMP = '${STAMP}'`);
    expect(src).toContain(`const PERSONA = '${PERSONA}'`);
  });

  /**
   * The mask's seed material, which the shim writes because the shim is the one
   * with a channel to the worker.
   *
   * Every assertion here is about a key the page must never see. The material
   * is what a persona is derived from, so a page that can enumerate it can work
   * out the noise and subtract it, which would defeat the posture entirely on
   * the surfaces that matter most.
   */
  describe('the persona material', () => {
    it('is written only when the worker sends one', async () => {
      // What the worker sends under Mirror and Standardize: an explicit no.
      const h = await boot();
      h.commit('s_a1', false, null);
      expect(h.session.getItem(PERSONA)).toBeNull();

      const b = await boot();
      b.commit('s_b2', false, 'tok3n');
      expect(b.session.getItem(PERSONA)).toBe('tok3n');
    });

    /** Switching back to a posture without personas must clear it, not keep it. */
    it('is cleared when the worker says there is none', async () => {
      const h = await boot({ session: { [PERSONA]: 'stale' } });
      h.commit('s_a1', false, null);
      expect(h.session.getItem(PERSONA)).toBeNull();
    });

    it('goes when an unmanaged tab commits to nothing', async () => {
      const h = await boot({ session: { [PERSONA]: 'stale', [STAMP]: 's_a1' } });
      h.commit(null, false, 'tok3n');
      expect(h.session.getItem(PERSONA)).toBeNull();
      expect(h.session.getItem(STAMP)).toBeNull();
    });

    it('is invisible to the page, in every way the page can look', async () => {
      const h = await boot({ session: { [PERSONA]: 'tok3n' } });
      h.commit('s_a1', false, 'tok3n');
      const store = h.page.sessionStorage;
      expect(store.getItem(PERSONA)).toBeNull();
      expect(Object.keys(store)).not.toContain(PERSONA);
      expect(store.length).toBe(0);
      const seen: string[] = [];
      for (let i = 0; i < store.length; i++) seen.push(store.key(i)!);
      expect(seen).not.toContain(PERSONA);
      expect(PERSONA in store).toBe(false);
    });

    /**
     * And a page cannot remove it either, which would turn Persona off for the
     * next load in that tab and hand the site the shared bucket instead.
     */
    it('survives the page clearing its own storage', async () => {
      const h = await boot({ session: { [PERSONA]: 'tok3n' } });
      h.commit('s_a1', false, 'tok3n');
      h.page.sessionStorage.removeItem(PERSONA);
      h.page.sessionStorage.clear();
      expect(h.session.getItem(PERSONA)).toBe('tok3n');
    });

    /** An older worker's message says nothing about it, which is not "none". */
    it('is left alone when the message does not mention it', async () => {
      const h = await boot({ session: { [PERSONA]: 'tok3n' } });
      h.commit('s_a1', false);
      expect(h.session.getItem(PERSONA)).toBe('tok3n');
    });
  });

  it('namespaces every write once it knows its session', async () => {
    const h = await boot();
    h.commit('s_a1');
    h.page.localStorage.setItem('token', 'AAA');
    expect(h.local.snapshot()).toMatchObject({ [nsKey('s_a1', 'token')]: 'AAA' });
    expect(h.page.localStorage.getItem('token')).toBe('AAA');
  });

  it('keeps two sessions on one origin apart', async () => {
    const a = await boot();
    a.commit('s_a1');
    a.page.localStorage.setItem('token', 'AAA');
    const raw = a.local.snapshot();

    const b = await boot({ local: raw });
    b.commit('s_b2');
    // The second session sees nothing of the first, and writing does not
    // overwrite it. This is the entire bug.
    expect(b.page.localStorage.getItem('token')).toBeNull();
    b.page.localStorage.setItem('token', 'BBB');
    expect(b.local.getItem(nsKey('s_a1', 'token'))).toBe('AAA');
    expect(b.local.getItem(nsKey('s_b2', 'token'))).toBe('BBB');
  });

  it('holds writes made before the session is known, then replays them', async () => {
    const h = await boot();
    h.page.localStorage.setItem('early', '1');
    // Nothing has touched the origin's own store: a write that leaked here
    // would be visible to every other session.
    expect(h.local.snapshot()).toEqual({});
    expect(h.page.localStorage.getItem('early')).toBe('1');

    h.commit('s_a1');
    expect(h.local.getItem(nsKey('s_a1', 'early'))).toBe('1');
  });

  it('reads the origin’s own data while it waits', async () => {
    const h = await boot({ local: { token: 'SHARED' } });
    expect(h.page.localStorage.getItem('token')).toBe('SHARED');
  });

  it('forks the origin’s own data on first arrival', async () => {
    const h = await boot({ local: { token: 'FROM_PROFILE', theme: 'dark' } });
    h.commit('s_a1', true);
    expect(h.page.localStorage.getItem('token')).toBe('FROM_PROFILE');
    // Copied, never moved, so an unmanaged tab still works.
    expect(h.local.getItem('token')).toBe('FROM_PROFILE');
    expect(h.states.at(-1)).toMatchObject({ sid: 's_a1', mode: 'live', forked: 2 });
  });

  it('does not re-fork a namespace that already has data', async () => {
    const h = await boot({
      local: { token: 'FROM_PROFILE', [nsKey('s_a1', 'own')]: '1' },
    });
    h.commit('s_a1', true);
    expect(h.page.localStorage.getItem('token')).toBeNull();
    expect(h.states.at(-1)).toMatchObject({ forked: 0 });
  });

  it('passes straight through on an unmanaged page', async () => {
    const h = await boot({ agent: false, local: { token: 'SHARED' } });
    // No agent answered, so nothing is virtualised and the page behaves as if
    // the extension were not installed.
    expect(h.states.at(-1)).toMatchObject({ sid: null, mode: 'through' });
    h.page.localStorage.setItem('theme', 'dark');
    expect(h.local.getItem('theme')).toBe('dark');
  });

  it('hides our bookkeeping from a page that enumerates', async () => {
    const h = await boot({
      agent: false,
      local: { token: 'SHARED', [nsKey('s_a1', 'secret')]: 'X', [STAMP]: 's_a1' },
    });
    expect(Object.keys(h.page.localStorage)).toEqual(['token']);
    expect(h.page.localStorage.getItem(nsKey('s_a1', 'secret'))).toBeNull();
    expect(h.page.localStorage.length).toBe(1);
  });

  it('refuses a page write into a session namespace', async () => {
    const h = await boot({ agent: false });
    expect(() => h.page.localStorage.setItem(nsKey('s_a1', 'token'), 'FORGED')).toThrow();
    expect(h.local.getItem(nsKey('s_a1', 'token'))).toBeNull();
  });

  it('clears only its own session', async () => {
    const h = await boot({ local: { [nsKey('s_b2', 'keep')]: 'B', shared: 'S' } });
    h.commit('s_a1');
    h.page.localStorage.setItem('mine', 'A');
    h.page.localStorage.clear();
    expect(h.page.localStorage.length).toBe(0);
    expect(h.local.getItem(nsKey('s_b2', 'keep'))).toBe('B');
    expect(h.local.getItem('shared')).toBe('S');
  });

  it('stamps the tab so the next load starts already committed', async () => {
    const h = await boot();
    h.commit('s_a1');
    expect(h.session.getItem(STAMP)).toBe('s_a1');

    // Second load, same tab, no agent answer yet.
    const again = await boot({ local: h.local.snapshot(), session: h.session.snapshot() });
    expect(again.states.at(-1)).toMatchObject({ sid: 's_a1', mode: 'live' });
  });

  it('rebases when the tab is moved to another session', async () => {
    const h = await boot();
    h.commit('s_a1');
    h.page.localStorage.setItem('token', 'AAA');
    h.commit('s_b2');
    expect(h.page.localStorage.getItem('token')).toBeNull();
    expect(h.local.getItem(nsKey('s_a1', 'token'))).toBe('AAA');
    expect(h.session.getItem(STAMP)).toBe('s_b2');
  });

  it('drops the stamp when the tab stops being managed', async () => {
    const h = await boot();
    h.commit('s_a1');
    h.commit(null);
    expect(h.session.getItem(STAMP)).toBeNull();
  });

  it('ignores a session id that could alias a namespace', async () => {
    const h = await boot();
    h.commit(`s${SEP}bad`);
    expect(h.states).toHaveLength(0);
  });

  it('looks like a Storage to code that checks', async () => {
    const h = await boot();
    h.commit('s_a1');
    expect(h.page.localStorage instanceof (globalThis as never as { Storage: never }).Storage).toBe(
      true
    );
    expect(Object.prototype.toString.call(h.page.localStorage)).toBe('[object Storage]');
  });

  it('supports property access, in, delete and JSON', async () => {
    const h = await boot();
    h.commit('s_a1');
    const s = h.page.localStorage as unknown as Record<string, string>;
    s.token = 'AAA';
    expect(s.token).toBe('AAA');
    expect('token' in s).toBe(true);
    expect(JSON.parse(JSON.stringify(s))).toEqual({ token: 'AAA' });
    delete s.token;
    expect('token' in s).toBe(false);
  });

  // Native Storage gives its own members precedence, and a site storing
  // something called "clear" must not lose the method.
  it('keeps its methods reachable when a page stores their names', async () => {
    const h = await boot();
    h.commit('s_a1');
    h.page.localStorage.setItem('clear', 'not a function');
    expect(typeof h.page.localStorage.clear).toBe('function');
    expect(h.page.localStorage.getItem('clear')).toBe('not a function');
    expect(h.page.localStorage.key(0)).toBe('clear');
  });

  it('leaves sessionStorage unforked, because a new tab has nothing to fork', async () => {
    const h = await boot({ session: { scratch: 'S' } });
    h.commit('s_a1', true);
    expect(h.page.sessionStorage.getItem('scratch')).toBeNull();
  });

  /**
   * A same-origin iframe on a managed tab. It has no agent, so nothing tells
   * it which session it is in, and passing through would write a framed
   * sign-in straight into the origin's shared keys.
   */
  it('makes a same-origin subframe wait for the tab rather than leak', async () => {
    const h = await boot({ agent: false, subframe: true, local: { token: 'SHARED' } });
    expect(h.states).toHaveLength(0);
    h.page.localStorage.setItem('framed', 'F');
    // Nothing has reached the shared store while it waits.
    expect(h.local.getItem('framed')).toBeNull();

    // The top frame is told, and stamps the tab.
    h.session.setItem(STAMP, 's_a1');
    await new Promise((r) => setTimeout(r, 260));
    expect(h.states.at(-1)).toMatchObject({ sid: 's_a1', mode: 'live' });
    expect(h.local.getItem(nsKey('s_a1', 'framed'))).toBe('F');
  });

  it('gives up and behaves natively when no session ever claims the tab', async () => {
    const h = await boot({ agent: false, subframe: true });
    h.page.localStorage.setItem('framed', 'F');
    await new Promise((r) => setTimeout(r, 2400));
    expect(h.states.at(-1)).toMatchObject({ sid: null, mode: 'through' });
    expect(h.local.getItem('framed')).toBe('F');
  }, 10_000);

  it('installs once even when injected twice', async () => {
    const h = await boot();
    h.commit('s_a1');
    h.page.localStorage.setItem('token', 'AAA');
    const before = h.page.localStorage;
    await import('../src/content/shim.js');
    expect(h.page.localStorage).toBe(before);
    expect(h.page.localStorage.getItem('token')).toBe('AAA');
  });
});

/**
 * document.cookie, routed so a page-set cookie reaches the wire.
 *
 * A cookie the page sets with script goes into the browser jar, but the header
 * rewrite then replaces the Cookie header from the session store, so the write
 * never leaves the machine and a site that reads its probe cookie back declares
 * cookies disabled. The shim forwards each managed write to the worker, which
 * puts it in the store. These pin that it forwards the right thing, only when it
 * should, and never at the cost of the page's own reads.
 */
describe('the cookie shim, running', () => {
  it('forwards a managed write to the worker, and the jar still has it', async () => {
    const h = await boot();
    h.commit('s_a1');
    h.doc.cookie = 'SID=abc; path=/; secure';
    // The whole value, attributes and all, so the worker can parse path and
    // expiry exactly as it would a Set-Cookie header.
    expect(h.cookies).toContainEqual({ value: 'SID=abc; path=/; secure', url: 'https://example.com/' });
    // The native jar was written too, so the page's own read is unchanged.
    expect(h.doc.cookie).toBe('SID=abc');
  });

  it('leaves reads native, returning every cookie the page set', async () => {
    const h = await boot();
    h.commit('s_a1');
    h.doc.cookie = 'a=1';
    h.doc.cookie = 'b=2';
    expect(h.doc.cookie).toBe('a=1; b=2');
    expect(h.cookies.map((c) => c.value)).toEqual(['a=1', 'b=2']);
  });

  it('forwards nothing on an unmanaged tab', async () => {
    const h = await boot();
    h.commit(null); // no session claims the tab: mode through
    h.doc.cookie = 'x=y';
    expect(h.cookies).toEqual([]);
    // Native behaviour is untouched: the write still lands in the jar.
    expect(h.doc.cookie).toBe('x=y');
  });

  it('replays a write made before the session was known, on commit', async () => {
    const h = await boot();
    // A page script that sets a cookie before the worker has answered. Nothing
    // is forwarded yet, because there is no session to forward it to.
    h.doc.cookie = 'early=1';
    expect(h.cookies).toEqual([]);
    // The moment the session is known, the held write is sent.
    h.commit('s_a1');
    expect(h.cookies).toContainEqual({ value: 'early=1', url: 'https://example.com/' });
  });

  it('drops a pending write when the tab turns out to be unmanaged', async () => {
    const h = await boot();
    h.doc.cookie = 'early=1';
    h.commit(null); // through: the write was only ever native, so it is not sent
    expect(h.cookies).toEqual([]);
    expect(h.doc.cookie).toBe('early=1');
  });
});
