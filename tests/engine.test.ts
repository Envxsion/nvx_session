/**
 * ------------------------------------------------------------------
 *  Title    |  Engine flush loop and isolation
 *  Ref      |  kernel/engine.js, kernel/registry.js, netfilter/dnr.js
 *  ID       |  test (engine)
 * ------------------------------------------------------------------
 *  Purpose  |  The debounced flush coalesces bursts, withdraws rules
 *           |  for deleted sessions, reports overflow, and resolves
 *           |  strict mode per flush.
 *  Note     |  The isolation invariant: no rule ever covers tabs from
 *           |  two sessions, and two sessions on one domain stay apart.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CookieStore } from '../src/jar/store.js';
import { parseSetCookie } from '../src/jar/cookie.js';
import { isPublicSuffix } from '../src/jar/psl.js';
import { Registry, type Session } from '../src/kernel/registry.js';
import { Engine } from '../src/kernel/engine.js';
import { DnrBackend, type DnrApi } from '../src/netfilter/dnr.js';
import type { Rule } from '../src/netfilter/types.js';

const NOW = 1_700_000_000_000;

function seeded(header: string, url = 'https://vercel.com/'): CookieStore {
  const s = new CookieStore();
  const r = parseSetCookie(header, { url: new URL(url), now: NOW }, { isPublicSuffix, now: NOW });
  if (r.ok) s.upsert(r.cookie);
  s.takeDirty();
  return s;
}

function session(id: string, store = seeded('sid=v')): Session {
  return { id, label: id, color: 'cyan', pinned: [], store, createdAt: NOW, lastSeen: NOW };
}

function harness(maxRules = 5000) {
  const calls: { addRules?: Rule[]; removeRuleIds?: number[] }[] = [];
  const api: DnrApi = {
    maxRules,
    async updateSessionRules(opts) {
      calls.push(opts);
    },
    async getSessionRules() {
      return [];
    },
  };
  const registry = new Registry();
  const backend = new DnrBackend(api);
  return { calls, registry, backend };
}

describe('Engine flush loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('anchors a host the tab is on over plain http to http, so its cookies go out', async () => {
    const { calls, registry, backend } = harness();
    registry.createSession(session('work', seeded('sid=v', 'http://nas.lan/')));
    registry.bind(7, 'work', { windowId: 1, url: 'http://nas.lan/login', origin: 'manual' });
    const engine = new Engine(registry, backend, { now: NOW });
    engine.markDirty(['work']);
    await engine.flush();
    const filters = (calls[0]!.addRules ?? []).map((r) => r.condition.urlFilter).filter(Boolean);
    expect(filters.some((f) => f!.startsWith('|http://nas.lan'))).toBe(true);
    expect(filters.some((f) => f!.startsWith('|https://nas.lan'))).toBe(false);
  });

  it("withdraws a previous worker's rules in the same update that installs its own", async () => {
    const { calls, registry, backend } = harness();
    registry.createSession(session('work'));
    registry.bind(7, 'work', { windowId: 1, url: 'https://vercel.com/', origin: 'manual' });

    const engine = new Engine(registry, backend, { now: NOW });
    engine.replaceOnNextFlush([4321, 4322]);
    engine.markDirty(['work']);
    await engine.flush();

    // One call carries both, so there is no moment the tab has no rule.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.removeRuleIds).toEqual(expect.arrayContaining([4321, 4322]));
    expect(calls[0]!.addRules!.length).toBeGreaterThan(0);

    // And only once: a later flush does not withdraw them again.
    engine.markDirty(['work']);
    await engine.flush();
    expect(calls.at(-1)!.removeRuleIds).not.toContain(4321);
  });

  it('coalesces a burst into one call', async () => {
    const { calls, registry, backend } = harness();
    registry.createSession(session('work'));
    registry.bind(7, 'work', { windowId: 1, url: 'https://vercel.com/', origin: 'manual' });

    const engine = new Engine(registry, backend, { now: NOW });
    for (let i = 0; i < 20; i++) engine.markDirty(['work']);

    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.addRules!.length).toBeGreaterThan(0);
  });

  it('stops extending the debounce past the ceiling', async () => {
    const { calls, registry, backend } = harness();
    registry.createSession(session('work'));
    registry.bind(7, 'work', { windowId: 1, url: 'https://vercel.com/', origin: 'manual' });
    const engine = new Engine(registry, backend, { now: NOW, debounceMs: 40, maxWaitMs: 120 });

    // A steady trickle that keeps resetting a naive debounce forever.
    for (let i = 0; i < 10; i++) {
      engine.markDirty([`work`]);
      // Re-dirtying the same session must still re-arm, so alternate.
      engine.markDirty([`other-${i}`]);
      await vi.advanceTimersByTimeAsync(30);
    }
    expect(calls.length).toBeGreaterThan(0);
  });

  it('flush resolves only once rules are actually applied', async () => {
    let applied = false;
    const registry = new Registry();
    registry.createSession(session('work'));
    registry.bind(7, 'work', { windowId: 1, url: 'https://vercel.com/', origin: 'manual' });

    const backend = new DnrBackend({
      maxRules: 5000,
      async updateSessionRules() {
        await new Promise((r) => setTimeout(r, 50));
        applied = true;
      },
      async getSessionRules() {
        return [];
      },
    });

    const engine = new Engine(registry, backend, { now: NOW });
    engine.markDirty(['work']);
    const p = engine.flush();
    await vi.advanceTimersByTimeAsync(60);
    await p;
    expect(applied).toBe(true);
    expect(engine.pending).toBe(0);
  });

  it('withdraws rules for a session deleted mid-flight', async () => {
    const { calls, registry, backend } = harness();
    registry.createSession(session('work'));
    registry.bind(7, 'work', { windowId: 1, url: 'https://vercel.com/', origin: 'manual' });
    const engine = new Engine(registry, backend, { now: NOW });

    engine.markDirty(['work']);
    await engine.flush();
    const before = calls.length;

    registry.deleteSession('work');
    engine.markDirty(['work']);
    await engine.flush();

    expect(calls.length).toBeGreaterThan(before);
    const last = calls.at(-1)!;
    expect(last.addRules ?? []).toHaveLength(0);
    expect(last.removeRuleIds!.length).toBeGreaterThan(0);
  });

  it('reports overflow instead of dropping domains quietly', async () => {
    const store = new CookieStore();
    for (let i = 0; i < 2000; i++) {
      const r = parseSetCookie('c=1', { url: new URL(`https://d${i}.com/`), now: NOW }, { isPublicSuffix, now: NOW });
      if (r.ok) store.upsert(r.cookie);
    }
    const { registry, backend } = harness();
    registry.createSession(session('work', store));
    registry.bind(7, 'work', { windowId: 1, url: 'https://d0.com/', origin: 'manual' });

    const overflow = vi.fn();
    const engine = new Engine(registry, backend, { now: NOW, onOverflow: overflow });
    engine.markDirty(['work']);
    await engine.flush();

    expect(overflow).toHaveBeenCalled();
    expect(overflow.mock.calls[0]![1].length).toBeGreaterThan(0);
  });

  it('retire withdraws immediately without a flush', async () => {
    const { calls, registry, backend } = harness();
    registry.createSession(session('work'));
    registry.bind(7, 'work', { windowId: 1, url: 'https://vercel.com/', origin: 'manual' });
    const engine = new Engine(registry, backend, { now: NOW });

    engine.markDirty(['work']);
    await engine.flush();

    await engine.retire('work');
    expect(engine.pending).toBe(0);
    expect(calls.at(-1)!.removeRuleIds!.length).toBeGreaterThan(0);
    expect(calls.at(-1)!.addRules ?? []).toHaveLength(0);
  });

  it('does nothing when flushed with an empty dirty set', async () => {
    const { calls, registry, backend } = harness();
    await new Engine(registry, backend).flush();
    expect(calls).toHaveLength(0);
  });

  it('surfaces the apply report', async () => {
    const { registry, backend } = harness();
    registry.createSession(session('work'));
    registry.bind(7, 'work', { windowId: 1, url: 'https://vercel.com/', origin: 'manual' });

    const onReport = vi.fn();
    const engine = new Engine(registry, backend, { now: NOW, onReport });
    engine.markDirty(['work']);
    await engine.flush();

    expect(onReport).toHaveBeenCalledOnce();
    expect(onReport.mock.calls[0]![0]).toMatchObject({ sessions: ['work'] });
  });
});

describe('Engine isolation invariant', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('gives two sessions on one domain disjoint rules and no shared tab', async () => {
    const { calls, registry, backend } = harness();
    registry.createSession(session('work', seeded('sid=WORK')));
    registry.createSession(session('personal', seeded('sid=PERSONAL')));
    registry.bind(7, 'work', { windowId: 1, url: 'https://vercel.com/a', origin: 'manual' });
    registry.bind(8, 'personal', { windowId: 1, url: 'https://vercel.com/b', origin: 'manual' });

    const engine = new Engine(registry, backend, { now: NOW });
    engine.markDirty(['work', 'personal']);
    await engine.flush();

    const rules = calls.at(-1)!.addRules!;
    const forTab = (t: number) =>
      rules.filter((r) => r.condition.tabIds?.includes(t));

    expect(forTab(7).length).toBeGreaterThan(0);
    expect(forTab(8).length).toBeGreaterThan(0);

    const valueFor = (t: number) =>
      forTab(t)
        .map((r) => r.action.requestHeaders?.[0]?.value)
        .filter(Boolean);

    expect(valueFor(7).every((v) => v!.includes('WORK'))).toBe(true);
    expect(valueFor(8).every((v) => v!.includes('PERSONAL'))).toBe(true);

    // No rule may ever cover tabs from two different sessions.
    for (const r of rules) {
      const tabs = (r.condition.tabIds ?? []).filter((t) => t >= 0);
      const owners = new Set(tabs.map((t) => registry.binding(t)?.sessionId));
      expect(owners.size).toBeLessThanOrEqual(1);
    }

    // Contested domain, so neither session gets the service worker rule.
    expect(rules.some((r) => r.condition.tabIds?.includes(-1))).toBe(false);
  });

  it('resolves strictWhen per flush, adding or dropping the fail-closed catch-all', async () => {
    const { calls, registry, backend } = harness();
    registry.createSession(session('work'));
    registry.bind(7, 'work', { windowId: 1, url: 'https://vercel.com/', origin: 'manual' });

    let strict = false;
    const engine = new Engine(registry, backend, { now: NOW, strictWhen: () => strict });

    const isCatchAll = (r: Rule) =>
      Array.isArray(r.condition.tabIds) &&
      !r.condition.requestDomains &&
      !r.condition.urlFilter &&
      (r.condition.resourceTypes?.length ?? 0) > 1 &&
      !r.condition.domainType &&
      r.action.requestHeaders?.[0]?.operation === 'remove';
    const lastHasCatchAll = () => (calls.at(-1)?.addRules ?? []).some(isCatchAll);

    engine.markDirty(['work']);
    await vi.advanceTimersByTimeAsync(60);
    expect(lastHasCatchAll()).toBe(false); // fail-open

    strict = true;
    engine.markDirty(['work']);
    await vi.advanceTimersByTimeAsync(60);
    expect(lastHasCatchAll()).toBe(true); // fail-closed, live without rebuilding the engine

    strict = false;
    engine.markDirty(['work']);
    await vi.advanceTimersByTimeAsync(60);
    expect(lastHasCatchAll()).toBe(false); // and back
  });
});

describe('the fast path for a cookie a tab was just handed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('installs a few rules for that host above its own, and the next full compile drops them', async () => {
    const { calls, registry, backend } = harness();
    registry.createSession(session('work'));
    registry.bind(7, 'work', { windowId: 1, url: 'https://vercel.com/', origin: 'manual' });
    const engine = new Engine(registry, backend, { now: NOW });
    engine.markDirty(['work']);
    await engine.flush();
    const fullCount = calls[0]!.addRules!.length;

    vi.setSystemTime(NOW + 10);
    await engine.patch('work', ['vercel.com']);
    const patch = calls.at(-1)!;
    expect(patch.addRules!.length).toBeGreaterThan(0);
    expect(patch.addRules!.length).toBeLessThan(fullCount);
    expect(patch.addRules!.every((r) => r.id >= 900_000 && r.priority > 1000)).toBe(true);
    const ids = patch.addRules!.map((r) => r.id);

    vi.setSystemTime(NOW + 20);
    engine.markDirty(['work']);
    await engine.flush();
    expect(calls.at(-1)!.removeRuleIds).toEqual(expect.arrayContaining(ids));
  });

  it('keeps a patch that is newer than the compile that would drop it', async () => {
    const { calls, registry, backend } = harness();
    registry.createSession(session('work'));
    registry.bind(7, 'work', { windowId: 1, url: 'https://vercel.com/', origin: 'manual' });
    const engine = new Engine(registry, backend, { now: NOW });
    vi.setSystemTime(NOW + 50);
    await engine.patch('work', ['vercel.com']);
    const ids = calls.at(-1)!.addRules!.map((r) => r.id);
    vi.setSystemTime(NOW + 50);
    engine.markDirty(['work']);
    await engine.flush();
    // Same instant: the compile cannot prove it saw the patch's cookie.
    expect(calls.at(-1)!.removeRuleIds ?? []).not.toEqual(expect.arrayContaining(ids));
  });
});

describe('the rule pool, shared between sessions with tabs', () => {
  it('gives one busy session far more than the old fixed share, and splits it when a second arrives', async () => {
    const store = new CookieStore();
    for (let i = 0; i < 120; i++) {
      const r = parseSetCookie('c=1', { url: new URL(`https://d${i}.com/`), now: NOW }, { isPublicSuffix, now: NOW });
      if (r.ok) store.upsert(r.cookie);
    }
    const { calls, registry, backend } = harness();
    registry.createSession(session('work', store));
    registry.createSession(session('home'));
    registry.bind(7, 'work', { windowId: 1, url: 'https://d0.com/', origin: 'manual' });
    const overflow = vi.fn();
    const engine = new Engine(registry, backend, { now: NOW, onOverflow: overflow });
    engine.markDirty(['work']);
    await engine.flush();
    expect(overflow).not.toHaveBeenCalled();
    expect(calls.at(-1)!.addRules!.length).toBeGreaterThan(320);

    // A second session with a tab halves the share, and both recompile together.
    registry.bind(8, 'home', { windowId: 1, url: 'https://vercel.com/', origin: 'manual' });
    engine.markDirty(['home']);
    await engine.flush();
    const last = calls.at(-1)!;
    const total = last.addRules!.length;
    expect(total).toBeLessThanOrEqual(4400);
    expect(last.addRules!.some((r) => r.condition.urlFilter?.includes('vercel.com'))).toBe(true);
    expect(last.addRules!.some((r) => r.condition.urlFilter?.includes('d0.com'))).toBe(true);
  });
});
