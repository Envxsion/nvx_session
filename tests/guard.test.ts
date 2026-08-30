/**
 * Blast-radius guardrails.
 *
 * The interesting failures here are the ones where the guard is too eager. A
 * warning that fires on an ordinary DELETE is a warning that gets switched off,
 * and a switched-off guard protects nothing, so "does not fire" is tested at
 * least as carefully as "does".
 */

import { describe, expect, it } from 'vitest';
import { CATALOG, blockable, classify, type GuardEntry } from '../src/guard/catalog.js';
import { AuditLog } from '../src/guard/audit.js';
import {
  DEFAULT_DANGER,
  GUARD_CAPACITY,
  GUARD_ID_BASE,
  GUARD_RULES_PER_SESSION,
  cleanDanger,
  compileGuard,
  decide,
  guardIdsFor,
  guardSlotFits,
} from '../src/guard/policy.js';
import { RULE_ID_BASE } from '../src/netfilter/compile.js';

const req = (method: string, url: string) => ({ method, url });

describe('classifying a request', () => {
  it('names the catalogued endpoint rather than the generic rule', () => {
    const f = classify(req('DELETE', 'https://api.vercel.com/v9/projects/prj_abc'));
    expect(f?.entry.id).toBe('vercel.project.delete');
    expect(f?.severity).toBe('destructive');
  });

  it('falls back to notable for an uncatalogued delete', () => {
    const f = classify(req('DELETE', 'https://internal.acme.dev/api/widgets/12'));
    expect(f?.entry.id).toBe('generic.delete');
    expect(f?.severity).toBe('notable');
  });

  it('catches a destroy path on a service nobody catalogued', () => {
    const f = classify(req('POST', 'https://tool.acme.dev/clusters/9/terminate'));
    expect(f?.severity).toBe('destructive');
    expect(f?.entry.id).toBe('generic.destroy.path');
  });

  it('says nothing about ordinary traffic', () => {
    expect(classify(req('GET', 'https://api.vercel.com/v9/projects/prj_abc'))).toBeNull();
    expect(classify(req('POST', 'https://api.github.com/repos/a/b/issues'))).toBeNull();
    expect(classify(req('GET', 'https://github.com/a/b/settings/delete'))).toBeNull();
  });

  // The catalogued entries are anchored to the exact shape of the endpoint, so
  // a nested resource under the same prefix is not the project itself.
  it('does not treat a sub-resource as the resource', () => {
    const f = classify(req('DELETE', 'https://api.vercel.com/v9/projects/prj_abc/env/xyz'));
    expect(f?.severity).toBe('notable');
  });

  it('is not fooled by a lookalike host', () => {
    const f = classify(req('DELETE', 'https://api.vercel.com.evil.test/v9/projects/prj'));
    expect(f?.entry.id).toBe('generic.delete');
  });

  it('matches the method case insensitively', () => {
    expect(classify(req('delete', 'https://api.github.com/repos/a/b'))?.severity).toBe(
      'destructive'
    );
  });

  it('survives a catalog entry with an unusable pattern', () => {
    const broken: GuardEntry[] = [
      { id: 'bad', what: 'x', service: 'x', methods: ['DELETE'], url: '([', severity: 'destructive' },
      ...CATALOG,
    ];
    expect(classify(req('DELETE', 'https://api.github.com/repos/a/b'), broken)?.entry.id).toBe(
      'github.repo.delete'
    );
  });
});

describe('deciding what to do about it', () => {
  it('warns by default, and only on the destructive tier', () => {
    expect(DEFAULT_DANGER).toBe('warn');
    expect(decide(req('DELETE', 'https://api.github.com/repos/a/b'), 'warn')?.action).toBe('warned');
    // Every DELETE on the web is not a warning.
    expect(decide(req('DELETE', 'https://acme.dev/api/drafts/1'), 'warn')?.action).toBe('logged');
  });

  it('refuses only where the user asked for it', () => {
    const r = req('DELETE', 'https://api.github.com/repos/a/b');
    expect(decide(r, 'block')?.action).toBe('blocked');
    expect(decide(r, 'off')?.action).toBe('logged');
  });

  it('still records everything with the guard turned off', () => {
    expect(decide(req('DELETE', 'https://acme.dev/x/1'), 'off')?.action).toBe('logged');
  });

  it('cleans a danger level arriving from storage', () => {
    expect(cleanDanger('block')).toBe('block');
    expect(cleanDanger('off')).toBe('off');
    expect(cleanDanger('nonsense')).toBe('warn');
    expect(cleanDanger(undefined)).toBe('warn');
  });
});

describe('compiling block rules', () => {
  const base = { sessionId: 'work', slot: 0, tabIds: [7, 8], now: 1000 };

  it('installs nothing unless the session asked to be blocked', () => {
    for (const danger of ['off', 'warn'] as const) {
      const out = compileGuard({ ...base, danger });
      expect(out.rules).toEqual([]);
      // Still returns the ids to withdraw, or turning the guard off would
      // leave the rules that were installed while it was on.
      expect(out.removeIds).toHaveLength(GUARD_RULES_PER_SESSION);
    }
  });

  it('covers every destructive entry and no notable one', () => {
    const out = compileGuard({ ...base, danger: 'block' });
    expect(out.rules).toHaveLength(blockable().length);
    expect(out.dropped).toEqual([]);
    for (const rule of out.rules) {
      expect(rule.action.type).toBe('block');
      expect(rule.condition.tabIds).toEqual([7, 8]);
      expect(rule.condition.requestMethods?.every((m) => m === m.toLowerCase())).toBe(true);
    }
  });

  it('never scopes a block to tabless traffic', () => {
    const out = compileGuard({ ...base, danger: 'block' });
    // A worker request has no tab, so there is nobody to confirm with and
    // nothing to show. Refusing it would break the page silently.
    expect(out.rules.every((r) => !r.condition.tabIds?.includes(-1))).toBe(true);
  });

  it('installs nothing for a session with no tabs open', () => {
    expect(compileGuard({ ...base, danger: 'block', tabIds: [] }).rules).toEqual([]);
  });

  it('keeps out of the session rule band', () => {
    const out = compileGuard({ ...base, danger: 'block', slot: 3 });
    const ids = out.rules.map((r) => r.id);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(GUARD_ID_BASE);
    expect(Math.max(...ids)).toBeLessThan(1000);
    expect(guardIdsFor(3)).toContain(ids[0]);
  });

  /**
   * The one that would have shipped. Guard ids are allocated below the session
   * rule band, and nothing stopped the 29th slot from walking into it: its
   * block rules would have replaced session slot 0's cookie rules, and that
   * session would have stopped isolating with nothing anywhere saying so. The
   * worst outcome this project has, reached from the feature meant to prevent
   * bad outcomes.
   */
  it('never emits an id inside the session rule band', () => {
    for (let slot = 0; slot < GUARD_CAPACITY + 4; slot++) {
      const out = compileGuard({ ...base, danger: 'block', slot });
      for (const id of [...out.rules.map((r) => r.id), ...out.removeIds]) {
        expect(id).toBeGreaterThanOrEqual(GUARD_ID_BASE);
        expect(id).toBeLessThan(RULE_ID_BASE);
      }
    }
  });

  it('reports a session it cannot cover rather than covering it wrongly', () => {
    const out = compileGuard({ ...base, danger: 'block', slot: GUARD_CAPACITY });
    expect(out.overCapacity).toBe(true);
    expect(out.rules).toEqual([]);
    // Nothing withdrawn either: those ids belong to somebody else.
    expect(out.removeIds).toEqual([]);
    expect(guardIdsFor(GUARD_CAPACITY)).toEqual([]);
    expect(guardSlotFits(GUARD_CAPACITY - 1)).toBe(true);
    expect(guardSlotFits(GUARD_CAPACITY)).toBe(false);
  });

  it('covers at least as many sessions as the rule ceiling allows', () => {
    // Otherwise the guard would run out before the isolation does, and a
    // session would be created that cannot be protected.
    expect(GUARD_CAPACITY).toBeGreaterThanOrEqual(Math.floor(5000 / 192));
  });

  it('honours a temporary allowance and drops it when it lapses', () => {
    const unlocked = { 'github.repo.delete': 5000 };
    const live = compileGuard({ ...base, danger: 'block', unlocked });
    expect(live.rules.map((r) => r.condition.regexFilter)).not.toContain(
      CATALOG.find((e) => e.id === 'github.repo.delete')!.url
    );
    const lapsed = compileGuard({ ...base, danger: 'block', unlocked, now: 6000 });
    expect(lapsed.rules).toHaveLength(blockable().length);
  });

  it('reports what it had to drop rather than silently truncating', () => {
    const big: GuardEntry[] = Array.from({ length: GUARD_RULES_PER_SESSION + 4 }, (_, i) => ({
      id: `e${i}`,
      what: 'x',
      service: 'x',
      methods: ['DELETE'],
      url: `^https://e${i}\\.test/`,
      severity: 'destructive' as const,
    }));
    const out = compileGuard({ ...base, danger: 'block' }, big);
    expect(out.rules).toHaveLength(GUARD_RULES_PER_SESSION);
    expect(out.dropped).toHaveLength(4);
  });
});

describe('the audit trail', () => {
  const entry = (over: Partial<Parameters<AuditLog['add']>[0]> = {}) => ({
    at: 1000,
    sessionId: 'work',
    sessionLabel: 'work',
    method: 'DELETE',
    url: 'https://api.github.com/repos/a/b',
    rule: 'github.repo.delete',
    what: 'delete a GitHub repository',
    severity: 'destructive' as const,
    action: 'warned' as const,
    ...over,
  });

  it('collapses a retry loop into one row', () => {
    const log = new AuditLog();
    log.add(entry());
    log.add(entry({ at: 1200 }));
    log.add(entry({ at: 1400 }));
    expect(log.all()).toHaveLength(1);
    expect(log.all()[0]!.count).toBe(3);
  });

  it('does not collapse the same action taken again much later', () => {
    const log = new AuditLog();
    log.add(entry());
    log.add(entry({ at: 60_000 }));
    expect(log.all()).toHaveLength(2);
  });

  it('keeps sessions apart', () => {
    const log = new AuditLog();
    log.add(entry());
    log.add(entry({ at: 1100, sessionId: 'personal' }));
    expect(log.forSession('work')).toHaveLength(1);
    expect(log.all()).toHaveLength(2);
  });

  it('is bounded, oldest first', () => {
    const log = new AuditLog(3);
    for (let i = 0; i < 10; i++) log.add(entry({ at: i * 10_000, url: `https://x/${i}` }));
    expect(log.all()).toHaveLength(3);
    expect(log.recent(1)[0]!.url).toBe('https://x/9');
  });

  it('counts what was actually stopped', () => {
    const log = new AuditLog();
    log.add(entry({ action: 'blocked' }));
    log.add(entry({ at: 20_000, action: 'blocked' }));
    log.add(entry({ at: 40_000, action: 'logged' }));
    expect(log.counts()).toMatchObject({ blocked: 2, warned: 0, total: 3 });
  });

  it('loads persisted rows and skips malformed ones', () => {
    const log = new AuditLog();
    log.load([entry(), null, { at: 'nope' }, { url: 'https://x' }, entry({ at: 90_000 })]);
    expect(log.all()).toHaveLength(2);
  });

  it('survives being handed something that is not an array', () => {
    const log = new AuditLog();
    log.add(entry());
    log.load('corrupt');
    expect(log.all()).toHaveLength(1);
  });
});
