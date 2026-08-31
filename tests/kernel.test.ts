/**
 * ------------------------------------------------------------------
 *  Title    |  Kernel registry, persistence and backend
 *  Ref      |  kernel/registry.ts, kernel/persist.ts, netfilter/dnr.ts
 *  ID       |  test (kernel)
 * ------------------------------------------------------------------
 *  Purpose  |  Registry bindings and resolution, service-worker
 *           |  ownership, Set-Cookie capture and desync, the DnrBackend,
 *           |  and the audit regressions behind them.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

import { describe, expect, it, vi } from 'vitest';
import { CookieStore } from '../src/jar/store.js';
import { Registry, domainOf, type Session } from '../src/kernel/registry.js';
import { deserialise, reconcile, serialise } from '../src/kernel/persist.js';
import { parseSetCookie } from '../src/jar/cookie.js';
import { isPublicSuffix } from '../src/jar/psl.js';
import { DnrBackend, dedupeById, type DnrApi } from '../src/netfilter/dnr.js';
import type { Rule } from '../src/netfilter/types.js';
import { captureSetCookie, contextFor } from '../src/observer/capture.js';
import { compare, DesyncLog, parseCookieHeader } from '../src/observer/desync.js';

const NOW = 1_700_000_000_000;

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    label: id,
    color: 'cyan',
    pinned: [],
    family: [],
    store: new CookieStore(),
    createdAt: NOW,
    lastSeen: NOW,
    ...over,
  };
}

function registry(...ids: string[]): Registry {
  const r = new Registry();
  for (const id of ids) r.createSession(session(id));
  return r;
}

const bindOpts = (over: Partial<{ windowId: number; url: string }> = {}) => ({
  windowId: 1,
  url: 'https://vercel.com/dashboard',
  origin: 'manual' as const,
  now: NOW,
  ...over,
});

describe('Registry bindings', () => {
  it('binds a tab and reports the session dirty', () => {
    const r = registry('work');
    expect(r.bind(7, 'work', bindOpts()).dirty).toEqual(['work']);
    expect(r.sessionForTab(7)?.id).toBe('work');
    expect(r.tabsFor('work')).toEqual([7]);
  });

  it('refuses to bind to a session that does not exist', () => {
    const r = registry('work');
    expect(r.bind(7, 'ghost', bindOpts()).dirty).toEqual([]);
    expect(r.sessionForTab(7)).toBeUndefined();
  });

  it('rebinding to the same session is a no-op but refreshes the url', () => {
    const r = registry('work');
    r.bind(7, 'work', bindOpts());
    const m = r.bind(7, 'work', bindOpts({ url: 'https://vercel.com/teams' }));
    expect(m.dirty).toEqual([]);
    expect(r.binding(7)?.url).toBe('https://vercel.com/teams');
  });

  it('rebinding to another session dirties both', () => {
    const r = registry('work', 'personal');
    r.bind(7, 'work', bindOpts());
    const m = r.bind(7, 'personal', bindOpts());
    expect([...m.dirty].sort()).toEqual(['personal', 'work']);
  });

  it('demands a reload only when the tab had already shipped a request', () => {
    const r = registry('work', 'personal');
    r.bind(7, 'work', bindOpts());
    expect(r.bind(7, 'personal', bindOpts()).needsReload).toEqual([]);

    r.bind(8, 'work', bindOpts());
    r.seal(8);
    expect(r.bind(8, 'personal', bindOpts()).needsReload).toEqual([8]);
  });

  it('survives a tab id swap from prerender activation', () => {
    const r = registry('work');
    r.bind(7, 'work', bindOpts());
    r.seal(7);
    r.replaceTab(7, 99);
    expect(r.sessionForTab(99)?.id).toBe('work');
    expect(r.binding(7)).toBeUndefined();
    // The seal has to travel with the binding or a later rebind would skip
    // the reload it actually needs.
    expect(r.bind(99, 'work', bindOpts()).needsReload).toEqual([]);
  });

  it('unbinds on close and forgets the seal', () => {
    const r = registry('work');
    r.bind(7, 'work', bindOpts());
    r.seal(7);
    expect(r.unbind(7).dirty).toEqual(['work']);
    expect(r.unbind(7).dirty).toEqual([]);
  });

  it('deleting a session orphans its sealed tabs for reload', () => {
    const r = registry('work');
    r.bind(7, 'work', bindOpts());
    r.bind(8, 'work', bindOpts());
    r.seal(7);
    const m = r.deleteSession('work');
    expect(m.dirty).toEqual(['work']);
    expect(m.needsReload).toEqual([7]);
    expect(r.tabsFor('work')).toEqual([]);
  });

  it('only recompiles on navigation that changes domain', () => {
    const r = registry('work');
    r.bind(7, 'work', bindOpts());
    expect(r.navigated(7, 'https://vercel.com/teams/x').dirty).toEqual([]);
    expect(r.navigated(7, 'https://github.com/').dirty).toEqual(['work']);
  });
});

describe('Registry resolution', () => {
  it('inherits the opener session', () => {
    const r = registry('work');
    r.bind(7, 'work', bindOpts());
    expect(r.resolveForNewTab({ openerTabId: 7, url: 'https://anything.com' })).toBe('work');
  });

  it('falls back to a pinned domain when there is no opener', () => {
    const r = new Registry();
    r.createSession(session('work', { pinned: ['vercel.com'] }));
    expect(r.resolveForNewTab({ url: 'https://vercel.com/x' })).toBe('work');
    expect(r.resolveForNewTab({ url: 'https://github.com/x' })).toBeNull();
  });

  it('refuses to guess when two sessions pin the same domain', () => {
    const r = new Registry();
    r.createSession(session('a', { pinned: ['vercel.com'] }));
    r.createSession(session('b', { pinned: ['vercel.com'] }));
    expect(r.sessionForUrl('https://vercel.com/')).toBeNull();
  });

  it('ignores non-http urls', () => {
    expect(domainOf('chrome://extensions')).toBe('');
    expect(domainOf('about:blank')).toBe('');
    expect(domainOf('not a url')).toBe('');
    expect(domainOf('https://api.vercel.com/x')).toBe('vercel.com');
  });
});

describe('service worker ownership', () => {
  it('gives sole occupancy to the only session present', () => {
    const r = registry('work');
    r.bind(7, 'work', bindOpts());
    const p = r.serviceWorkerPolicy('https://vercel.com/dashboard');
    expect(p).toMatchObject({ owner: 'work', contested: false, suppressed: [] });
    expect(r.serviceWorkerOriginsFor('work')).toEqual(['https://vercel.com']);
  });

  it('marks the origin contested when two sessions are on it', () => {
    const r = registry('work', 'personal');
    r.bind(7, 'work', bindOpts({ url: 'https://vercel.com/a' }));
    r.bind(8, 'personal', bindOpts({ url: 'https://vercel.com/b' }));
    r.activated(8, NOW + 1000);

    const p = r.serviceWorkerPolicy('https://vercel.com/');
    expect(p.contested).toBe(true);
    expect(p.owner).toBe('personal');
    expect(p.suppressed).toEqual(['work']);
    // Contested means nobody gets the tabIds [-1] rule, or one session's jar
    // would feed another session's pages.
    expect(r.serviceWorkerOriginsFor('personal')).toEqual([]);
    expect(r.serviceWorkerOriginsFor('work')).toEqual([]);
  });

  it('reports no owner for an origin nobody is on', () => {
    const r = registry('work');
    expect(r.serviceWorkerPolicy('https://vercel.com/')).toMatchObject({
      owner: null,
      contested: false,
    });
  });

  it('stops being contested once the second session leaves', () => {
    const r = registry('work', 'personal');
    r.bind(7, 'work', bindOpts());
    r.bind(8, 'personal', bindOpts());
    expect(r.serviceWorkerPolicy('https://vercel.com/').contested).toBe(true);
    r.unbind(8);
    expect(r.serviceWorkerPolicy('https://vercel.com/')).toMatchObject({
      owner: 'work',
      contested: false,
    });
  });

  // The M4 fix. Two subdomains of one registrable domain are two separate
  // worker registrations with separate caches, and treating them as one contest
  // suppressed attribution for both sessions on exactly the federated sites
  // this project exists for.
  it('does not let a subdomain contest the apex, or the reverse', () => {
    const r = registry('work', 'personal');
    r.bind(7, 'work', bindOpts({ url: 'https://github.com/acme' }));
    r.bind(8, 'personal', bindOpts({ url: 'https://gist.github.com/cyn0v' }));

    expect(r.serviceWorkerPolicy('https://github.com/x')).toMatchObject({
      owner: 'work',
      contested: false,
    });
    expect(r.serviceWorkerPolicy('https://gist.github.com/x')).toMatchObject({
      owner: 'personal',
      contested: false,
    });
    expect(r.serviceWorkerOriginsFor('work')).toEqual(['https://github.com']);
    expect(r.serviceWorkerOriginsFor('personal')).toEqual(['https://gist.github.com']);
  });

  it('separates schemes, because they are separate registrations', () => {
    const r = registry('work', 'personal');
    r.bind(7, 'work', bindOpts({ url: 'https://vercel.com/a' }));
    r.bind(8, 'personal', bindOpts({ url: 'http://vercel.com/b' }));
    expect(r.serviceWorkerPolicy('https://vercel.com/').contested).toBe(false);
    expect(r.serviceWorkerPolicy('http://vercel.com/').contested).toBe(false);
  });

  it('separates ports, because the fixture depends on it', () => {
    const r = registry('work', 'personal');
    r.bind(7, 'work', bindOpts({ url: 'http://localhost:8787/page' }));
    r.bind(8, 'personal', bindOpts({ url: 'http://localhost:3000/page' }));
    expect(r.serviceWorkerPolicy('http://localhost:8787/').owner).toBe('work');
    expect(r.serviceWorkerPolicy('http://localhost:3000/').owner).toBe('personal');
  });

  it('ignores a url that is not an http origin', () => {
    const r = registry('work');
    r.bind(7, 'work', bindOpts());
    expect(r.serviceWorkerPolicy('chrome://extensions')).toMatchObject({
      origin: '',
      owner: null,
    });
  });
});

describe('captureSetCookie', () => {
  const base = { url: 'https://vercel.com/api', now: NOW };

  it('captures every Set-Cookie and reports the domains touched', () => {
    const r = captureSetCookie({
      ...base,
      responseHeaders: [
        { name: 'Set-Cookie', value: 'a=1; Path=/' },
        { name: 'set-cookie', value: 'b=2; Path=/' },
        { name: 'Content-Type', value: 'text/html' },
      ],
    });
    expect(r.cookies.map((c) => c.name).sort()).toEqual(['a', 'b']);
    expect(r.domains).toEqual(['vercel.com']);
  });

  it('splits a folded multi-line header', () => {
    const r = captureSetCookie({
      ...base,
      responseHeaders: [{ name: 'Set-Cookie', value: 'a=1; Path=/\nb=2; Path=/' }],
    });
    expect(r.cookies).toHaveLength(2);
  });

  it('reports rejections rather than dropping them silently', () => {
    const r = captureSetCookie({
      ...base,
      responseHeaders: [
        { name: 'Set-Cookie', value: 'good=1' },
        { name: 'Set-Cookie', value: 'bad; Path=/' },
        { name: 'Set-Cookie', value: 'x=1; SameSite=None' },
      ],
    });
    expect(r.cookies.map((c) => c.name)).toEqual(['good']);
    expect(r.rejected.map((x) => x.reason).sort()).toEqual([
      'no-name',
      'none-requires-secure',
    ]);
  });

  it('ignores schemes that cannot carry cookies', () => {
    for (const url of ['chrome-extension://abc/x', 'data:text/html,x', 'about:blank']) {
      expect(captureSetCookie({ url, responseHeaders: [{ name: 'Set-Cookie', value: 'a=1' }] }).cookies).toEqual([]);
    }
  });

  it('treats missing responseHeaders as nothing to do', () => {
    expect(captureSetCookie({ ...base }).cookies).toEqual([]);
    expect(captureSetCookie({ ...base, responseHeaders: [] }).cookies).toEqual([]);
  });

  it('skips a header with no value', () => {
    expect(
      captureSetCookie({ ...base, responseHeaders: [{ name: 'Set-Cookie' }] }).cookies
    ).toEqual([]);
  });
});

describe('contextFor', () => {
  it('calls a main frame request top level', () => {
    expect(contextFor({ type: 'main_frame', url: 'https://vercel.com/' })).toBe('top-level');
  });

  it('splits first from third party by registrable domain', () => {
    expect(
      contextFor({ type: 'script', url: 'https://api.vercel.com/x', initiator: 'https://vercel.com' })
    ).toBe('first-party');
    expect(
      contextFor({ type: 'script', url: 'https://vercel.com/x', initiator: 'https://evil.com' })
    ).toBe('third-party');
  });

  it('treats a browser-initiated subresource as first party', () => {
    expect(contextFor({ type: 'script', url: 'https://vercel.com/x' })).toBe('first-party');
    expect(contextFor({ type: 'script', url: 'https://vercel.com/x', initiator: 'null' })).toBe(
      'first-party'
    );
  });

  it('does not throw on a malformed initiator', () => {
    expect(contextFor({ type: 'script', url: 'https://vercel.com/x', initiator: '???' })).toBe(
      'first-party'
    );
  });
});

describe('desync comparison', () => {
  it('parses a Cookie header, first duplicate wins', () => {
    const m = parseCookieHeader('a=1; b=2; a=3');
    expect(m.get('a')).toBe('1');
    expect(m.size).toBe(2);
  });

  it('matches when identical regardless of spacing', () => {
    expect(compare('a=1; b=2', 'a=1;b=2').matched).toBe(true);
  });

  it('flags a foreign cookie, which is the profile jar leaking', () => {
    const c = compare('a=1; leaked=x', 'a=1');
    expect(c.matched).toBe(false);
    expect(c.events).toEqual([{ kind: 'foreign', names: ['leaked'] }]);
  });

  it('flags missing and stale separately', () => {
    expect(compare('a=1', 'a=1; b=2').events).toEqual([{ kind: 'missing', names: ['b'] }]);
    expect(compare('a=old', 'a=new').events).toEqual([{ kind: 'stale', names: ['a'] }]);
  });

  it('treats both sides empty as a match', () => {
    expect(compare(undefined, '').matched).toBe(true);
    expect(compare('', '').matched).toBe(true);
  });

  it('counts and bounds the log', () => {
    const log = new DesyncLog(3);
    expect(log.clean).toBe(true);
    for (let i = 0; i < 5; i++) {
      log.observed();
      log.record({
        kind: 'foreign',
        url: 'https://vercel.com/',
        tabId: 1,
        sessionId: 'work',
        context: 'first-party',
        names: [`c${i}`],
        at: NOW + i,
      });
    }
    expect(log.recent()).toHaveLength(3);
    expect(log.snapshot()).toMatchObject({ total: 5, foreign: 5, checked: 5 });
    expect(log.clean).toBe(false);
    log.reset();
    expect(log.clean).toBe(true);
  });
});

describe('DnrBackend', () => {
  function fake(overrides: Partial<DnrApi> = {}) {
    const calls: { addRules?: Rule[]; removeRuleIds?: number[] }[] = [];
    const api: DnrApi = {
      maxRules: 5000,
      async updateSessionRules(opts) {
        calls.push(opts);
      },
      async getSessionRules() {
        return [];
      },
      ...overrides,
    };
    return { api, calls };
  }

  const rule = (id: number): Rule => ({
    id,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'remove' }] },
    condition: { requestDomains: ['vercel.com'], tabIds: [1] },
  });

  it('dedupes ids, keeping the last', () => {
    const a = rule(1);
    const b = { ...rule(1), priority: 9 };
    expect(dedupeById([a, b])).toEqual([b]);
  });

  it('skips the call entirely when there is nothing to do', async () => {
    const { api, calls } = fake();
    const r = await new DnrBackend(api).applyReporting([], []);
    expect(calls).toHaveLength(0);
    expect(r).toMatchObject({ added: 0, removed: 0 });
  });

  it('serialises overlapping applies', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((res) => (release = res));
    let first = true;

    const { api } = fake({
      async updateSessionRules(opts) {
        const tag = String(opts.addRules?.[0]?.id);
        order.push(`start:${tag}`);
        if (first) {
          first = false;
          await gate;
        }
        order.push(`end:${tag}`);
      },
    });

    const backend = new DnrBackend(api);
    const p1 = backend.applyReporting([rule(1)], []);
    const p2 = backend.applyReporting([rule(2)], []);
    release!();
    await Promise.all([p1, p2]);

    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('reports overflow rather than dropping rules quietly', async () => {
    const { api } = fake({ maxRules: 2 });
    const r = await new DnrBackend(api).applyReporting([rule(1), rule(2), rule(3)], []);
    expect(r.added).toBe(2);
    expect(r.dropped.map((x) => x.id)).toEqual([3]);
  });

  it('bisects a failing batch down to the offending rule', async () => {
    const { api } = fake({
      async updateSessionRules(opts) {
        if (opts.addRules?.some((r) => r.id === 3)) throw new Error('invalid condition');
      },
    });
    const r = await new DnrBackend(api).applyReporting([rule(1), rule(2), rule(3), rule(4)], []);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.rule.id).toBe(3);
    expect(r.rejected[0]!.error).toBe('invalid condition');
    expect(r.added).toBe(3);
  });

  it('keeps working after a failed apply', async () => {
    let fail = true;
    const { api } = fake({
      async updateSessionRules() {
        if (fail) throw new Error('boom');
      },
    });
    const backend = new DnrBackend(api);
    await backend.applyReporting([rule(1)], []);
    fail = false;
    const ok = await backend.applyReporting([rule(2)], []);
    expect(ok.rejected).toHaveLength(0);
    expect(ok.added).toBe(1);
  });
});

describe('audit regressions', () => {
  it('rejects a cookie carrying control characters', () => {
    // Values land verbatim in a Cookie header, so a smuggled CTL or semicolon
    // would let one origin forge extra cookies or split the header.
    const at = { url: new URL('https://vercel.com/'), now: NOW };
    for (const bad of ['a=one\r\nInjected: yes', 'a=one\u0000two', 'a\r\nb=1']) {
      const r = parseSetCookie(bad, at, { isPublicSuffix, now: NOW });
      expect(r.ok, bad).toBe(false);
    }
    // A semicolon cannot reach a value: it separates attributes, so this is
    // simply cookie "a=one" with a junk attribute.
    const semi = parseSetCookie('a=one;two', at, { isPublicSuffix, now: NOW });
    expect(semi.ok && semi.cookie.value).toBe('one');

    // Commas are forbidden by the grammar but Chrome accepts them and real
    // cookies use them. Rejecting one would break a site that works without us.
    const comma = parseSetCookie('a=one,two', at, { isPublicSuffix, now: NOW });
    expect(comma.ok && comma.cookie.value).toBe('one,two');

    expect(parseSetCookie('a=fine_value-123', at, { isPublicSuffix, now: NOW }).ok).toBe(true);
  });

  it('keeps a binding whose tab navigated across origins while asleep', () => {
    // The federated sign-in case. Dropping this hands the next request to the
    // profile jar, which is the wrong-account failure the project prevents.
    const r = registry('work');
    r.bind(7, 'work', bindOpts({ url: 'https://staff.monash.edu/' }));
    const out = reconcile(r, [{ id: 7, url: 'https://identity.monash.edu/login', windowId: 1 }]);

    expect(out.dropped).toEqual([]);
    expect(out.kept).toEqual([7]);
    expect(r.sessionForTab(7)?.id).toBe('work');
    expect(r.binding(7)?.url).toBe('https://identity.monash.edu/login');
  });

  it('drops a binding whose tab no longer exists', () => {
    const r = registry('work');
    r.bind(7, 'work', bindOpts());
    const out = reconcile(r, []);
    expect(out.dropped).toEqual([7]);
    expect(r.sessionForTab(7)).toBeUndefined();
  });

  /**
   * A browser restart gives every tab a new id, so every binding lands in
   * dropped even though the tabs themselves came back. The id is genuinely
   * gone; the knowledge of which session that url belonged to is not, and
   * throwing it away is what signs the user out of everything they had open.
   */
  it('keeps what a dropped binding knew, so a restored tab can be matched to it', () => {
    const r = registry('work', 'home');
    r.bind(7, 'work', bindOpts({ url: 'https://learning.monash.edu/my/' }));
    r.bind(8, 'home', bindOpts({ url: 'https://learning.monash.edu/course/' }));

    // What a restart looks like from here: the same two tabs, different ids.
    const out = reconcile(r, [
      { id: 91, url: 'https://learning.monash.edu/my/', windowId: 1 },
      { id: 92, url: 'https://learning.monash.edu/course/', windowId: 1 },
    ]);

    expect(out.dropped.sort()).toEqual([7, 8]);
    expect(out.orphans).toEqual([
      { url: 'https://learning.monash.edu/my/', sessionId: 'work' },
      { url: 'https://learning.monash.edu/course/', sessionId: 'home' },
    ]);
  });

  it('does not record an orphan for a binding that had no url to remember', () => {
    const r = registry('work');
    r.bind(7, 'work', bindOpts({ url: '' }));
    expect(reconcile(r, []).orphans).toEqual([]);
  });

  it('recompiles when the host changes even inside one registrable domain', () => {
    // Rules are host scoped, so staff -> identity under monash.edu still needs
    // a new rule set.
    const r = registry('work');
    r.bind(7, 'work', bindOpts({ url: 'https://staff.monash.edu/' }));
    expect(r.navigated(7, 'https://identity.monash.edu/').dirty).toEqual(['work']);
    expect(r.navigated(7, 'https://identity.monash.edu/other').dirty).toEqual([]);
  });

  it('does not retain seal records for tabs of a deleted session', () => {
    const r = registry('work');
    r.bind(7, 'work', bindOpts());
    r.seal(7);
    r.deleteSession('work');
    r.createSession(session('work'));
    r.bind(7, 'work', bindOpts());
    // A fresh binding on a recycled id must not inherit the old seal, which
    // would force a spurious reload.
    expect(r.bind(7, 'work', bindOpts()).needsReload).toEqual([]);
  });

  it('reports which sessions could sign in at a domain', () => {
    const r = new Registry();
    for (const id of ['staff', 'student', 'empty']) r.createSession(session(id));
    for (const [id, value] of [
      ['staff', 'STAFF'],
      ['student', 'STUDENT'],
    ] as const) {
      const p = parseSetCookie(
        `okta=${value}`,
        { url: new URL('https://identity.monash.edu/'), now: NOW },
        { isPublicSuffix, now: NOW }
      );
      if (p.ok) r.getSession(id)!.store.upsert(p.cookie);
    }
    expect(r.sessionsWithIdentityFor('identity.monash.edu').sort()).toEqual(['staff', 'student']);
    expect(r.sessionsWithIdentityFor('github.com')).toEqual([]);
  });

  it('offers an empty session that pins the domain', () => {
    // The second account. It is empty by definition, so a chooser built only
    // from who already holds cookies cannot offer it, and the user ends up
    // picking the account they were trying to get away from. Measured live:
    // both tabs landed in one session and the site showed one person twice.
    const r = new Registry();
    r.createSession(session('staff', { pinned: ['monash.edu'] }));
    r.createSession(session('student', { pinned: ['monash.edu'] }));
    r.createSession(session('github', { pinned: ['github.com'] }));

    const p = parseSetCookie(
      'MoodleSession=STAFF',
      { url: new URL('https://learning.monash.edu/'), now: NOW },
      { isPublicSuffix, now: NOW }
    );
    if (p.ok) r.getSession('staff')!.store.upsert(p.cookie);

    expect(r.sessionsWithIdentityFor('learning.monash.edu')).toEqual(['staff']);
    expect(r.sessionsCovering('learning.monash.edu')).toEqual(['staff', 'student']);
    // Ordering is part of the contract: an identity to resume comes first.
    expect(r.sessionsCovering('learning.monash.edu')[0]).toBe('staff');
    // A session pinning somewhere else is not an option here.
    expect(r.sessionsCovering('learning.monash.edu')).not.toContain('github');
  });

  it('offers both sessions before either has signed in anywhere', () => {
    // The very first navigation. Neither session holds anything yet, so the
    // old rule produced no options at all, no chooser, and a tab left on the
    // profile jar while the panel said it was managed.
    const r = new Registry();
    r.createSession(session('staff', { pinned: ['monash.edu'] }));
    r.createSession(session('student', { pinned: ['monash.edu'] }));
    expect(r.sessionsCovering('learning.monash.edu').sort()).toEqual(['staff', 'student']);
  });

  it('does not offer a session pinning a different registrable domain', () => {
    const r = new Registry();
    r.createSession(session('a', { pinned: ['monash.edu.au'] }));
    expect(r.sessionsCovering('learning.monash.edu')).toEqual([]);
  });

  /**
   * One identity spans several domains: a service, its identity provider, and
   * whatever the chain touches on the way. Holding cookies there already counts
   * as covering it, but session cookies are dropped when the browser closes, so
   * the morning's first visit to the identity provider would match nothing and
   * fall through to the profile jar. The family is what survives that.
   */
  it('covers a domain the session has been observed signing in at', () => {
    const r = new Registry();
    r.createSession(session('work', { pinned: ['monash.edu'] }));

    expect(r.sessionsCovering('monashuni.okta.com')).toEqual([]);
    expect(r.noteFamily('work', 'https://monashuni.okta.com/idp/idx/identify')).toBe(true);
    expect(r.sessionsCovering('monashuni.okta.com')).toEqual(['work']);
    // Recorded as the registrable domain, so a sibling host is covered too.
    expect(r.getSession('work')!.family).toEqual(['okta.com']);
    expect(r.sessionsCovering('login.okta.com')).toEqual(['work']);
  });

  it('reports nothing new the second time, so it can drive a one-off note', () => {
    const r = new Registry();
    r.createSession(session('work', { pinned: ['monash.edu'] }));
    expect(r.noteFamily('work', 'https://monashuni.okta.com/')).toBe(true);
    expect(r.noteFamily('work', 'https://other.okta.com/')).toBe(false);
  });

  it('does not record a domain the user already named', () => {
    const r = new Registry();
    r.createSession(session('work', { pinned: ['monash.edu'] }));
    expect(r.noteFamily('work', 'https://learning.monash.edu/')).toBe(false);
    expect(r.getSession('work')!.family).toEqual([]);
  });

  it('never gives the holding pen a family', () => {
    const r = new Registry();
    r.createSession(session('pen', { ephemeral: true }));
    expect(r.noteFamily('pen', 'https://monashuni.okta.com/')).toBe(false);
  });

  /**
   * The holding pen must not become an account. Every tab waiting on a choice
   * is parked in the same session, so anything it keeps is shared between them,
   * which is precisely the collision the chooser exists to prevent. Clearing it
   * in memory is not enough on its own: the snapshot hands it straight back on
   * the next wake, which is how it was found holding a live MoodleSession.
   */
  it('never writes an ephemeral session jar out', () => {
    const r = new Registry();
    const pen = session('anon', { ephemeral: true });
    const real = session('work');
    r.createSession(pen);
    r.createSession(real);
    for (const s of [pen, real]) {
      const p = parseSetCookie(
        'MoodleSession=LIVE',
        { url: new URL('https://learning.monash.edu/'), now: NOW },
        { isPublicSuffix, now: NOW }
      );
      if (p.ok) s.store.upsert(p.cookie);
    }
    expect(pen.store.size).toBe(1);

    const state = serialise(r, { now: NOW });
    const saved = (id: string) => state.sessions.find((s) => s.id === id)!.jar.cookies;
    expect(saved('anon')).toEqual([]);
    expect(saved('work')).toHaveLength(1);

    // And it comes back empty rather than being restored from what it held.
    expect(deserialise(state).getSession('anon')!.store.size).toBe(0);
  });

  /**
   * The flag has to be derived on the way in, not trusted. It went missing on
   * exactly this boundary once: a pen restored without it counted as a real
   * account again, which made a site with two sessions look like three and
   * offered the pen in the picker.
   */
  it('marks a restored system session ephemeral and drops what it held', () => {
    const r = new Registry();
    r.createSession(session('__nvx_anonymous'));
    const p = parseSetCookie(
      'MoodleSession=LIVE',
      { url: new URL('https://learning.monash.edu/'), now: NOW },
      { isPublicSuffix, now: NOW }
    );
    if (p.ok) r.getSession('__nvx_anonymous')!.store.upsert(p.cookie);

    // Written by a build that did not know about the flag, so the jar is on
    // disk whatever serialise would do with it today.
    const state = serialise(r, { now: NOW });
    expect(state.sessions[0]!.jar.cookies).toHaveLength(1);

    const back = deserialise(state).getSession('__nvx_anonymous')!;
    expect(back.ephemeral).toBe(true);
    expect(back.store.size).toBe(0);
  });

  it('never offers an ephemeral session as somewhere a tab could go', () => {
    const r = new Registry();
    r.createSession(session('work', { pinned: ['monash.edu'] }));
    r.createSession(session('pen', { pinned: ['monash.edu'], ephemeral: true }));
    const p = parseSetCookie(
      'MoodleSession=LIVE',
      { url: new URL('https://learning.monash.edu/'), now: NOW },
      { isPublicSuffix, now: NOW }
    );
    if (p.ok) r.getSession('pen')!.store.upsert(p.cookie);

    // Holding cookies does not promote it. One real session covers this site,
    // so the tab joins it rather than being asked to choose between an account
    // and a waiting room.
    expect(r.sessionsCovering('learning.monash.edu')).toEqual(['work']);
  });
});

describe('DnrBackend removals on the failure path', () => {
  it('still withdraws rules when the additions are rejected', async () => {
    const calls: { addRules?: Rule[]; removeRuleIds?: number[] }[] = [];
    const api: DnrApi = {
      maxRules: 5000,
      async updateSessionRules(opts) {
        calls.push(opts);
        if (opts.addRules?.length) throw new Error('bad rule');
      },
      async getSessionRules() {
        return [];
      },
    };
    const rule = (id: number): Rule => ({
      id,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'remove' }] },
      condition: { tabIds: [1] },
    });

    await new DnrBackend(api).applyReporting([rule(1), rule(2)], [900, 901]);

    // A withdrawal that only happens on the success path leaves stale rules
    // rewriting headers for a session that no longer wants them.
    const removals = calls.filter((c) => c.removeRuleIds?.length && !c.addRules?.length);
    expect(removals.length).toBeGreaterThan(0);
    expect(removals[0]!.removeRuleIds).toEqual([900, 901]);
  });
});
