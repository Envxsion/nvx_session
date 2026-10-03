/**
 * ------------------------------------------------------------------
 *  Title    |  Compiling sessions into DNR rules
 *  Ref      |  netfilter/compile.js, netfilter/types.js
 *  ID       |  test (netfilter compile)
 * ------------------------------------------------------------------
 *  Purpose  |  compileDomain, compileHost and compileSession emit the
 *           |  right declarativeNetRequest rules: scoped, budgeted,
 *           |  deduped, with the strict catch-all and the Lax window.
 *  Author   |  Ojas Kekre, 24/08/2026
 * ------------------------------------------------------------------
 */
import { describe, expect, it } from 'vitest';
import { parseSetCookie } from '../src/jar/cookie.js';
import { isPublicSuffix } from '../src/jar/psl.js';
import { CookieStore } from '../src/jar/store.js';
import { compileDomain, compileSession, RuleIds, RULE_ID_STRIDE, RULES_PER_SESSION } from '../src/netfilter/compile.js';
import type { SessionView } from '../src/netfilter/types.js';

const NOW = 1_700_000_000_000;

function store(headers: string[], url = 'https://vercel.com/'): CookieStore {
  const s = new CookieStore();
  for (const h of headers) {
    const r = parseSetCookie(h, { url: new URL(url), now: NOW }, { isPublicSuffix, now: NOW });
    if (!r.ok) throw new Error(`fixture cookie rejected: ${h} (${r.reason})`);
    s.upsert(r.cookie);
  }
  return s;
}

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 'work',
    tabIds: [7],
    serviceWorkerOrigins: [],
    activeHosts: [],
    store: store(['sid=abc; SameSite=Lax']),
    ...over,
  };
}

const counter = (start = 5000) => {
  let n = start;
  return () => n++;
};

const setValue = (r: { action: { requestHeaders?: { operation: string; value?: string }[] } }) =>
  r.action.requestHeaders?.[0];

describe('compileDomain', () => {
  it('emits one rule per variant, scoped to the session tabs', () => {
    const out = compileDomain(session(), 'vercel.com', counter(), { now: NOW });
    // Four, not three: a top level navigation compiles to two rules, split on
    // whether the method is safe, because SameSite=Lax rides a cross-site
    // navigation only on GET and HEAD.
    expect(out.rules).toHaveLength(5);
    for (const r of out.rules) {
      expect(r.condition.tabIds).toEqual([7]);
      expect(r.condition.requestDomains).toEqual(['vercel.com']);
    }

    // A Lax cookie is correctly withheld from a third party context, which
    // leaves that variant with an empty header. It must still emit a rule, and
    // that rule must remove rather than set, or the profile jar leaks in.
    const byVariant = (pred: (r: (typeof out.rules)[number]) => boolean) =>
      setValue(out.rules.find(pred) as never);

    expect(byVariant((r) => r.condition.domainType === 'firstParty')).toMatchObject({
      operation: 'set',
      value: 'sid=abc',
    });
    expect(byVariant((r) => r.condition.resourceTypes?.includes('main_frame') === true)).toMatchObject({
      operation: 'set',
      value: 'sid=abc',
    });
    expect(byVariant((r) => r.condition.domainType === 'thirdParty')).toEqual({
      header: 'cookie',
      operation: 'remove',
    });
  });

  it('splits first party, third party and top level', () => {
    const s = session({
      store: store([
        'strict=s; SameSite=Strict',
        'lax=l; SameSite=Lax',
        'none=n; SameSite=None; Secure',
      ]),
    });
    const out = compileDomain(s, 'vercel.com', counter(), { now: NOW });

    const third = out.rules.find((r) => r.condition.domainType === 'thirdParty')!;
    expect(setValue(third as never)?.value).toBe('none=n');

    const first = out.rules.find((r) => r.condition.domainType === 'firstParty')!;
    expect(setValue(first as never)?.value).toContain('strict=s');

    const top = out.rules.find((r) => r.condition.resourceTypes?.includes('main_frame'))!;
    expect(setValue(top as never)?.value).toContain('strict=s');
  });

  it('honours strictOnTopLevel when turned off', () => {
    const s = session({ store: store(['strict=s; SameSite=Strict', 'lax=l']) });
    const out = compileDomain(s, 'vercel.com', counter(), { now: NOW, strictOnTopLevel: false });
    const top = out.rules.find((r) => r.condition.resourceTypes?.includes('main_frame'))!;
    expect(setValue(top as never)?.value).toBe('lax=l');
  });

  it('REMOVES the header when the session holds nothing, never omits the rule', () => {
    const s = session({ store: new CookieStore() });
    const out = compileDomain(s, 'vercel.com', counter(), { now: NOW });
    expect(out.rules).toHaveLength(5);
    for (const r of out.rules) {
      expect(setValue(r as never)).toEqual({ header: 'cookie', operation: 'remove' });
    }
  });

  it('adds a tabIds [-1] rule set when the session owns the service worker', () => {
    const s = session({ serviceWorkerOrigins: ['https://vercel.com'] });
    const out = compileDomain(s, 'vercel.com', counter(), { now: NOW });
    expect(out.rules).toHaveLength(10);
    expect(out.rules.filter((r) => r.condition.tabIds?.includes(-1))).toHaveLength(5);
  });

  it('produces nothing when the session has no tabs and owns no worker', () => {
    const out = compileDomain(session({ tabIds: [] }), 'vercel.com', counter(), { now: NOW });
    expect(out.rules).toHaveLength(0);
  });

  it('gives path scoped cookies their own higher priority rules', () => {
    const s = session({
      store: store(['root=r'], 'https://vercel.com/').constructor === CookieStore
        ? (() => {
            const st = store(['root=r'], 'https://vercel.com/');
            const deep = parseSetCookie(
              'deep=d',
              { url: new URL('https://vercel.com/teams/acme/x'), now: NOW },
              { isPublicSuffix, now: NOW }
            );
            if (deep.ok) st.upsert(deep.cookie);
            return st;
          })()
        : new CookieStore(),
    });

    const out = compileDomain(s, 'vercel.com', counter(), { now: NOW });
    const deepRules = out.rules.filter((r) => r.condition.urlFilter?.includes('/teams/acme'));
    const rootRules = out.rules.filter((r) => !r.condition.urlFilter?.includes('/teams/acme'));

    expect(deepRules.length).toBe(5);
    expect(rootRules.length).toBe(5);
    expect(deepRules[0]!.priority).toBeGreaterThan(rootRules[0]!.priority);
    expect(setValue(deepRules[0] as never)?.value).toContain('deep=d');
    expect(setValue(rootRules[0] as never)?.value).not.toContain('deep=d');
  });

  it('withholds Secure cookies from an http origin', () => {
    const s = session({
      store: store(['sec=1; Secure', 'plain=2'], 'https://localhost/'),
    });
    const out = compileDomain(s, 'localhost', counter(), {
      now: NOW,
      schemeFor: () => 'http:',
    });
    // localhost counts as a trustworthy origin, so Secure survives there.
    expect(setValue(out.rules[0] as never)?.value).toContain('sec=1');

    const other = session({ store: store(['sec=1; Secure'], 'https://example.com/') });
    const insecure = compileDomain(other, 'example.com', counter(), {
      now: NOW,
      schemeFor: () => 'http:',
    });
    expect(setValue(insecure.rules[0] as never)).toEqual({
      header: 'cookie',
      operation: 'remove',
    });
  });
});

describe('RuleIds', () => {
  it('gives each session a disjoint block', () => {
    const ids = new RuleIds();
    const a = ids.blockFor('a');
    const b = ids.blockFor('b');
    expect(b.base - a.base).toBe(RULE_ID_STRIDE);
    expect(a.limit).toBeLessThanOrEqual(b.base);
  });

  it('is stable across repeated lookups', () => {
    const ids = new RuleIds();
    expect(ids.blockFor('a').base).toBe(ids.blockFor('a').base);
  });

  it('releases a whole block on session removal', () => {
    const ids = new RuleIds();
    const { base } = ids.blockFor('a');
    const freed = ids.releaseSession('a');
    expect(freed).toHaveLength(RULES_PER_SESSION);
    expect(freed[0]).toBe(base);
  });
});

/**
 * The per-host Cookie rules only, leaving out the two rules every session with a
 * tab carries: the Set-Cookie strip and the unknown-site navigation rule.
 */
function cookieRules<T extends { action: unknown; condition: { requestDomains?: string[]; resourceTypes?: string[] } }>(
  rules: T[]
): T[] {
  return rules.filter(
    (r) =>
      !(r.action as { responseHeaders?: unknown }).responseHeaders &&
      !(r.condition.resourceTypes?.length === 1 && r.condition.resourceTypes[0] === 'main_frame' && !r.condition.requestDomains)
  );
}

describe('compileSession', () => {
  it('strips Set-Cookie from every response in the session\'s tabs', () => {
    const out = compileSession(session({ activeHosts: ['vercel.com'] }), new RuleIds(), undefined, { now: NOW });
    const strip = out.rules.filter((r) =>
      (r.action as { responseHeaders?: Array<{ header: string; operation: string }> }).responseHeaders?.some(
        (h) => h.header === 'set-cookie' && h.operation === 'remove'
      )
    );
    expect(strip).toHaveLength(1);
    expect(strip[0]!.condition.tabIds).toEqual([7]);
    // Every request type, page loads included. Leaving resourceTypes out
    // matches everything except main_frame, which is how navigations leaked.
    expect(strip[0]!.condition.resourceTypes).toContain('main_frame');
    expect(strip[0]!.condition.resourceTypes).toContain('xmlhttprequest');
  });

  it('sends a navigation to an unknown site with no cookies, below every host rule', () => {
    const out = compileSession(session({ activeHosts: ['vercel.com'] }), new RuleIds(), undefined, { now: NOW });
    const nav = out.rules.filter((r) => r.condition.resourceTypes?.length === 1 && r.condition.resourceTypes[0] === 'main_frame' && !r.condition.requestDomains);
    expect(nav).toHaveLength(1);
    expect(nav[0]!.condition.tabIds).toEqual([7]);
    expect(setValue(nav[0] as never)).toEqual({ header: 'cookie', operation: 'remove' });
    for (const r of out.rules.filter((x) => x.condition.requestDomains)) {
      expect(r.priority).toBeGreaterThan(nav[0]!.priority);
    }
  });

  it('anchors a path rule to scheme and host, and stops it at a path boundary', () => {
    const st = store(['scoped=1; Path=/api', 'dir=1; Path=/docs/'], 'https://vercel.com/api/x');
    const out = compileDomain(session({ store: st }), 'vercel.com', counter(), { now: NOW });
    const filters = new Set(out.rules.map((r) => r.condition.urlFilter));
    // /api matches /api, /api/x and /api?q, never /apiary or a subdomain.
    expect(filters).toContain('|https://vercel.com/api^');
    // A path ending in a slash already ends at a boundary.
    expect(filters).toContain('|https://vercel.com/docs/');
    expect([...filters].some((f) => f?.startsWith('||'))).toBe(false);
  });

  it('sends overflowed hosts nothing rather than the browser jar', () => {
    const jar = new CookieStore();
    for (let i = 0; i < 400; i++) {
      const r = parseSetCookie('c=1', { url: new URL(`https://d${i}.com/`), now: NOW }, { isPublicSuffix, now: NOW });
      if (r.ok) jar.upsert(r.cookie);
    }
    const out = compileSession(session({ store: jar, tabIds: [7] }), new RuleIds(), undefined, { now: NOW });
    expect(out.overflowed.length).toBeGreaterThan(0);
    const backstop = out.rules.find(
      (r) => r.condition.requestDomains?.includes(out.overflowed[0]!) && r.priority === 1
    );
    expect(setValue(backstop as never)).toEqual({ header: 'cookie', operation: 'remove' });
    expect(backstop!.condition.tabIds).toEqual([7]);
    // And it fits: the whole block stays within the session's budget.
    expect(out.rules.length).toBeLessThanOrEqual(RULES_PER_SESSION);
  });

  it('adds no Set-Cookie rule for a session with no tabs', () => {
    const out = compileSession(session({ tabIds: [], activeHosts: [] }), new RuleIds(), undefined, { now: NOW });
    expect(out.rules.some((r) => (r.action as { responseHeaders?: unknown }).responseHeaders)).toBe(false);
  });

  it('compiles every domain and returns the removal set', () => {
    const s = new CookieStore();
    for (const [host, header] of [
      ['https://vercel.com/', 'a=1'],
      ['https://github.com/', 'b=2'],
    ] as const) {
      const r = parseSetCookie(header, { url: new URL(host), now: NOW }, { isPublicSuffix, now: NOW });
      if (r.ok) s.upsert(r.cookie);
    }

    const out = compileSession(session({ store: s }), new RuleIds(), undefined, { now: NOW });
    // Each host's variants, plus its registrable domain fallback's, plus the
    // Set-Cookie strip and the unknown-site navigation rule.
    expect(out.rules.length).toBe(22);
    expect(out.removeIds).toHaveLength(RULES_PER_SESSION);
    expect(out.overflowed).toEqual([]);
    expect(new Set(out.rules.map((r) => r.id)).size).toBe(out.rules.length);
  });

  /**
   * A session that has ever seen an IP origin, a router page or a local dev
   * server bound to an address, used to compile to nothing at all.
   *
   * The fallback rule is built against a synthetic unvisited subdomain of each
   * registrable domain, and `nvx-unvisited-subdomain.127.0.0.1` is not a host
   * the URL parser will accept: the trailing numeric label sends it down the
   * IPv4 path, where the rest of the name is a parse failure rather than a
   * hostname. The exception escaped compileSession, so the session got no
   * rules whatsoever and carried no cookies anywhere, for any site.
   */
  it('compiles a session holding an address without losing the rest of it', () => {
    const s = new CookieStore();
    for (const [url, header] of [
      ['http://127.0.0.1:8787/', 'idp=1'],
      ['https://vercel.com/', 'sid=2'],
    ] as const) {
      const r = parseSetCookie(header, { url: new URL(url), now: NOW }, { isPublicSuffix, now: NOW });
      if (!r.ok) throw new Error(`fixture cookie rejected: ${header} (${r.reason})`);
      s.upsert(r.cookie);
    }

    const out = compileSession(session({ store: s }), new RuleIds(), undefined, { now: NOW });

    expect(out.skipped).toEqual([]);

    // A host rule is anchored by urlFilter; a fallback is unanchored and
    // selects by requestDomains instead.
    const anchored = new Set(
      out.rules.map((r) => r.condition.urlFilter).filter((f): f is string => Boolean(f))
    );
    const fallbackDomains = new Set(
      out.rules.filter((r) => !r.condition.urlFilter).flatMap((r) => r.condition.requestDomains ?? [])
    );

    // The address gets its own host rule.
    expect([...anchored].some((f) => f.includes('127.0.0.1'))).toBe(true);
    // And no fallback, because it has no subdomains for one to cover.
    expect(fallbackDomains.has('127.0.0.1')).toBe(false);
    // The ordinary host it shares the session with keeps both, which is the
    // part that was actually broken: it used to get neither.
    expect([...anchored].some((f) => f.includes('vercel.com'))).toBe(true);
    expect(fallbackDomains.has('vercel.com')).toBe(true);
  });

  it('records a host it cannot compile rather than losing the session', () => {
    // There is no natural way to reach this any more, which is the point: the
    // guard has to hold for the next shape nobody anticipated, not for the one
    // that was found. A store whose hosts() lies is the cheapest stand-in.
    const s = store(['sid=abc']);
    const broken = Object.create(s) as CookieStore;
    Object.defineProperty(broken, 'hosts', { value: () => ['vercel.com', 'ho st'] });

    const out = compileSession(session({ store: broken }), new RuleIds(), undefined, { now: NOW });

    // Twice, because it is attempted once as a host and once as its own
    // fallback, and both are recorded rather than one masking the other.
    expect(out.skipped.map((x) => x.host)).toEqual(['ho st', 'ho st']);
    expect(out.rules.length).toBeGreaterThan(0);
    expect(
      out.rules.some((r) => (r.condition.urlFilter ?? '').includes('vercel.com'))
    ).toBe(true);
  });

  it('reports overflow instead of silently dropping a domain', () => {
    const s = new CookieStore();
    for (let i = 0; i < 400; i++) {
      const r = parseSetCookie(`c=1`, { url: new URL(`https://d${i}.com/`), now: NOW }, { isPublicSuffix, now: NOW });
      if (r.ok) s.upsert(r.cookie);
    }
    const out = compileSession(session({ store: s }), new RuleIds(), undefined, { now: NOW });
    expect(out.overflowed.length).toBeGreaterThan(0);
    expect(out.rules.length).toBeLessThanOrEqual(RULES_PER_SESSION);
  });

  it('keeps the host a tab is on even when the jar overflows the budget', () => {
    // The failure this guards against: a workday session accretes hundreds of
    // jar hosts, the budget overflows, and the host the user is signing into
    // right now is the one dropped, so its request falls through to the
    // browser jar and the sign-in redirect-loops. The active host must survive.
    const s = new CookieStore();
    for (let i = 0; i < 400; i++) {
      const r = parseSetCookie(`c=1`, { url: new URL(`https://d${i}.com/`), now: NOW }, { isPublicSuffix, now: NOW });
      if (r.ok) s.upsert(r.cookie);
    }
    const out = compileSession(
      session({ store: s, activeHosts: ['accounts.example.com'] }),
      new RuleIds(),
      undefined,
      { now: NOW }
    );

    expect(out.overflowed.length).toBeGreaterThan(0);
    // The active host is never in the overflow set, and its rules are present.
    expect(out.overflowed).not.toContain('accounts.example.com');
    expect(
      out.rules.some((r) => (r.condition.urlFilter ?? '').includes('accounts.example.com'))
    ).toBe(true);
  });

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Recognises the catch-all a strict compile adds.
   *  Note     |  Scoped to the session's tabs, no domain, no url filter;
   *           |  its action removes the Cookie header, stripping the
   *           |  browser jar from any host without a specific rule.
   * ------------------------------------------------------------------
   */
  const isCatchAll = (r) =>
    Array.isArray(r.condition.tabIds) &&
    !r.condition.requestDomains &&
    !r.condition.urlFilter &&
    (r.condition.resourceTypes?.length ?? 0) > 1 &&
    !r.condition.domainType &&
    r.action.requestHeaders?.[0]?.header === 'cookie' &&
    r.action.requestHeaders[0].operation === 'remove';

  describe('fail-closed (strict)', () => {
    it('adds a tab-scoped catch-all that strips out-of-scope cookies, only under strict', () => {
      const s = session({ tabIds: [7] });
      const strict = compileSession(s, new RuleIds(), undefined, { now: NOW, strict: true });
      const open = compileSession(s, new RuleIds(), undefined, { now: NOW });

      const catchAll = strict.rules.find(isCatchAll);
      expect(catchAll).toBeDefined();
      expect(catchAll.condition.tabIds).toEqual([7]);
      // Fail-open has no such rule: an out-of-scope host falls through to the jar.
      expect(open.rules.find(isCatchAll)).toBeUndefined();
    });

    it('keeps the catch-all even when the jar overflows the budget', () => {
      // The catch-all is compiled first, so an overflow can only ever drop a
      // background host rule and never the rule that closes the tab.
      const jar = new CookieStore();
      for (let i = 0; i < 400; i++) {
        const r = parseSetCookie(`c=1`, { url: new URL(`https://d${i}.com/`), now: NOW }, { isPublicSuffix, now: NOW });
        if (r.ok) jar.upsert(r.cookie);
      }
      const out = compileSession(session({ store: jar, tabIds: [7] }), new RuleIds(), undefined, {
        now: NOW,
        strict: true,
      });
      expect(out.overflowed.length).toBeGreaterThan(0);
      expect(out.rules.find(isCatchAll)).toBeDefined();
    });

    it('does not add a catch-all for a session with no open tabs', () => {
      const out = compileSession(session({ tabIds: [] }), new RuleIds(), undefined, {
        now: NOW,
        strict: true,
      });
      expect(out.rules.find(isCatchAll)).toBeUndefined();
    });
  });

  describe('cache isolation', () => {
    const isCacheRule = (r) =>
      r.action.responseHeaders?.[0]?.header === 'cache-control' &&
      r.action.responseHeaders[0].operation === 'set' &&
      r.action.responseHeaders[0].value === 'no-store';

    it('adds a tab-scoped no-store response rule only under cacheIsolation', () => {
      const s = session({ tabIds: [7] });
      const on = compileSession(s, new RuleIds(), undefined, { now: NOW, cacheIsolation: true });
      const off = compileSession(s, new RuleIds(), undefined, { now: NOW });

      const rule = on.rules.find(isCacheRule);
      expect(rule).toBeDefined();
      expect(rule.condition.tabIds).toEqual([7]);
      expect(off.rules.find(isCacheRule)).toBeUndefined();
    });

    it('is independent of the fail-closed catch-all and can coexist with it', () => {
      const out = compileSession(session({ tabIds: [7] }), new RuleIds(), undefined, {
        now: NOW,
        strict: true,
        cacheIsolation: true,
      });
      expect(out.rules.find(isCatchAll)).toBeDefined();
      expect(out.rules.find(isCacheRule)).toBeDefined();
    });

    it('does not add it for a session with no open tabs', () => {
      const out = compileSession(session({ tabIds: [] }), new RuleIds(), undefined, {
        now: NOW,
        cacheIsolation: true,
      });
      expect(out.rules.find(isCacheRule)).toBeUndefined();
    });
  });

  it('keeps ids inside the session block', () => {
    const ids = new RuleIds();
    const out = compileSession(session(), ids, undefined, { now: NOW });
    const { base, limit } = ids.blockFor('work');
    for (const r of out.rules) {
      expect(r.id).toBeGreaterThanOrEqual(base);
      expect(r.id).toBeLessThan(limit);
    }
  });
});

describe('RuleIds slot recycling', () => {
  it('reuses a released slot rather than walking the counter forever', () => {
    const ids = new RuleIds();
    const first = ids.blockFor('a').base;
    ids.blockFor('b');
    ids.releaseSession('a');
    expect(ids.blockFor('c').base).toBe(first);
  });

  it('returns the full id range on release so rules can be withdrawn first', () => {
    const ids = new RuleIds();
    const { base } = ids.blockFor('a');
    const freed = ids.releaseSession('a');
    expect(freed[0]).toBe(base);
    expect(freed.at(-1)).toBe(base + RULES_PER_SESSION - 1);
  });

  it('keeps enough room for a realistic number of sessions', () => {
    // The block grew from 192 to 320 rules so a broad workday session stops
    // overflowing and dropping the auth host it is mid-sign-in on. That trades
    // some of the concurrent-session ceiling for the headroom, and 15 at once is
    // still well past what a person keeps live.
    expect(RuleIds.capacity(5000)).toBeGreaterThanOrEqual(15);
  });
});

describe('federated sign-in, the identity provider case', () => {
  // A staff account and a student account behind one Okta tenant. Both the
  // service and the identity provider live under one registrable domain, so a
  // single rule set covers the whole redirect chain, but only if the rule
  // exists before the first request.
  it('covers a domain the tab is on even when the jar is empty', () => {
    const fresh = session({ store: new CookieStore(), activeHosts: ['monash.edu'] });
    const out = compileSession(fresh, new RuleIds(), undefined, { now: NOW });

    expect(cookieRules(out.rules).length).toBeGreaterThan(0);
    for (const r of cookieRules(out.rules)) {
      expect(r.condition.requestDomains).toEqual(['monash.edu']);
      expect(setValue(r as never)).toEqual({ header: 'cookie', operation: 'remove' });
    }
  });

  it('carries a host-only identity provider cookie to its own host, and nowhere else', () => {
    // Okta sets a host-only cookie on identity.monash.edu. It must reach that
    // host and must not be handed to learning.monash.edu, which is exactly
    // what a registrable-domain-wide rule would have done.
    const st = store(['okta_session=STUDENT; Path=/'], 'https://identity.monash.edu/');
    const s = session({ store: st, activeHosts: ['learning.monash.edu'] });
    const out = compileSession(s, new RuleIds(), undefined, { now: NOW });

    const idp = cookieRules(out.rules).filter((r) => r.condition.urlFilter?.includes('//identity.monash.edu'));
    const learning = cookieRules(out.rules).filter((r) => r.condition.urlFilter?.includes('//learning.monash.edu'));
    const fallback = cookieRules(out.rules).filter((r) => !r.condition.urlFilter);

    expect(idp.length).toBe(5);
    expect(learning.length).toBe(5);
    expect(fallback.length).toBe(5);

    const firstParty = (rs: typeof out.rules) =>
      setValue(rs.find((r) => r.condition.domainType === 'firstParty') as never);

    expect(firstParty(idp)?.value).toContain('STUDENT');
    // The service and the unvisited-subdomain fallback get a clean slate
    // rather than the identity provider's session.
    expect(firstParty(learning)).toEqual({ header: 'cookie', operation: 'remove' });
    expect(firstParty(fallback)).toEqual({ header: 'cookie', operation: 'remove' });

    // And the host rules must outrank the fallback, or the clean slate wins.
    expect(idp[0]!.priority).toBeGreaterThan(fallback[0]!.priority);
  });

  it('sends a domain-scoped cookie to every subdomain, including unvisited ones', () => {
    // Set with Domain=monash.edu, so the browser would send it everywhere
    // under monash.edu. The fallback rule is what reproduces that.
    const st = store(['sso=SHARED; Domain=monash.edu; Path=/'], 'https://identity.monash.edu/');
    const s = session({ store: st, activeHosts: ['learning.monash.edu'] });
    const out = compileSession(s, new RuleIds(), undefined, { now: NOW });

    const firstParty = (pred: (r: (typeof out.rules)[number]) => boolean) =>
      setValue(cookieRules(out.rules).find((r) => pred(r) && r.condition.domainType === 'firstParty') as never);

    expect(firstParty((r) => !r.condition.urlFilter)?.value).toContain('SHARED');
    expect(firstParty((r) => Boolean(r.condition.urlFilter?.includes('//learning.monash.edu')))?.value).toContain(
      'SHARED'
    );
  });

  it('does not duplicate a host present in both the jar and the tabs', () => {
    const s = session({ activeHosts: ['vercel.com'] });
    const out = compileSession(s, new RuleIds(), undefined, { now: NOW });
    // One host rule set and one fallback set, not two of either.
    expect(cookieRules(out.rules)).toHaveLength(10);
    expect(cookieRules(out.rules).filter((r) => r.condition.urlFilter)).toHaveLength(5);
    expect(cookieRules(out.rules).filter((r) => !r.condition.urlFilter)).toHaveLength(5);
  });

  it('keeps the apex host rule alongside its fallback', () => {
    // An apex is its own registrable domain. Collapsing the two would drop
    // every host-only cookie set on the apex itself.
    const s = session({
      store: store(['apex=A; Path=/'], 'https://vercel.com/'),
      activeHosts: ['vercel.com'],
    });
    const out = compileSession(s, new RuleIds(), undefined, { now: NOW });

    const anchored = cookieRules(out.rules).filter((r) => r.condition.urlFilter?.startsWith('|https://vercel.com'));
    const fallback = cookieRules(out.rules).filter((r) => !r.condition.urlFilter);

    expect(anchored).toHaveLength(5);
    expect(fallback).toHaveLength(5);

    const firstParty = (rs: typeof out.rules) =>
      setValue(rs.find((r) => r.condition.domainType === 'firstParty') as never);

    expect(firstParty(anchored)?.value).toContain('apex=A');
    expect(firstParty(fallback)).toEqual({ header: 'cookie', operation: 'remove' });
  });

  it('strict mode adds a catch-all below every domain rule', () => {
    const s = session({ activeHosts: ['vercel.com'] });
    const out = compileSession(s, new RuleIds(), undefined, { now: NOW, strict: true });

    const catchAll = cookieRules(out.rules).filter((r) => !r.condition.requestDomains);
    expect(catchAll).toHaveLength(1);
    expect(catchAll[0]!.condition.tabIds).toEqual([7]);
    expect(setValue(catchAll[0] as never)).toEqual({ header: 'cookie', operation: 'remove' });

    for (const r of cookieRules(out.rules).filter((x) => x.condition.requestDomains)) {
      expect(r.priority).toBeGreaterThan(catchAll[0]!.priority);
    }
  });

  it('emits no catch-all when strict is off', () => {
    const s = session({ activeHosts: ['vercel.com'] });
    const out = compileSession(s, new RuleIds(), undefined, { now: NOW });
    expect(cookieRules(out.rules).every((r) => r.condition.requestDomains)).toBe(true);
  });
});

/**
 * The rule that carries a single sign-on assertion home.
 *
 * A defaulted-Lax cookie rides a cross-site POST for two minutes, so the
 * unsafe-method rule has to carry it, and then has to stop. A compiled rule
 * cannot notice time passing on its own, so the compiler says when it expires
 * and the engine comes back.
 */
describe('the Lax unsafe window, through the compiler', () => {
  const jar = () => store(['MDL_SSP_SessID=SSP_1; Secure'], 'https://vercel.com/');
  // The cross-site POST: a POST from the site itself carries everything and is
  // not on borrowed time.
  const unsafe = (rules: { condition: { requestMethods?: string[]; domainType?: string } }[]) =>
    rules.find((r) => r.condition.requestMethods?.includes('post') && r.condition.domainType === 'thirdParty');

  it('carries every cookie on a same-site POST, with no window', () => {
    const strictJar = store(['sid=S; SameSite=Strict', 'csrf=C; SameSite=Lax'], 'https://vercel.com/');
    const out = compileDomain(session({ store: strictJar }), 'vercel.com', counter(), { now: NOW + 600_000 });
    const sameSite = out.rules.find(
      (r) => r.condition.requestMethods?.includes('post') && r.condition.domainType === 'firstParty'
    );
    expect(setValue(sameSite as never)?.value).toContain('sid=S');
    expect(setValue(sameSite as never)?.value).toContain('csrf=C');
    // And the cross-site POST still withholds them, as the browser would.
    expect(setValue(unsafe(out.rules) as never)).toEqual({ header: 'cookie', operation: 'remove' });
  });

  it('carries a fresh state cookie on the cross-site POST rule', () => {
    const out = compileDomain(session({ store: jar() }), 'vercel.com', counter(), { now: NOW });
    expect(setValue(unsafe(out.rules) as never)?.value).toContain('MDL_SSP_SessID=SSP_1');
  });

  it('drops it once the window has closed', () => {
    const out = compileDomain(session({ store: jar() }), 'vercel.com', counter(), {
      now: NOW + 120_001,
    });
    expect(setValue(unsafe(out.rules) as never)).toEqual({ header: 'cookie', operation: 'remove' });
  });

  it('reports when the rule stops being true, so it can be rebuilt', () => {
    const fresh = compileDomain(session({ store: jar() }), 'vercel.com', counter(), { now: NOW });
    expect(fresh.expiresAt).toBe(NOW + 120_000);

    const aged = compileDomain(session({ store: jar() }), 'vercel.com', counter(), {
      now: NOW + 120_001,
    });
    // Nothing is riding on borrowed time, so there is nothing to come back for.
    expect(aged.expiresAt).toBeNull();
  });

  it('reports the earliest expiry across a whole session', () => {
    const s = new CookieStore();
    for (const [header, at] of [
      ['a=1; Secure', NOW],
      ['b=2; Secure', NOW + 30_000],
    ] as const) {
      const r = parseSetCookie(header, { url: new URL('https://vercel.com/'), now: at }, { isPublicSuffix, now: at });
      if (!r.ok) throw new Error(r.reason);
      s.upsert(r.cookie);
    }
    const out = compileSession(session({ store: s }), new RuleIds(), undefined, { now: NOW + 1000 });
    expect(out.expiresAt).toBe(NOW + 120_000);
  });
});

describe('path rules stay on the host a cookie reaches', () => {
  it('does not give a sibling host rules for paths only another host uses', () => {
    const s = new CookieStore();
    for (const [h, url] of [
      ['GMAIL_LF=1; Path=/mail/u/0', 'https://mail.google.com/mail/u/0/'],
      ['__utma=1; Domain=workspace.google.com; Path=/intl/en-US/gmail/', 'https://workspace.google.com/intl/en-US/gmail/'],
      ['LSID=1; Path=/', 'https://accounts.google.com/'],
    ] as const) {
      const r = parseSetCookie(h, { url: new URL(url), now: NOW }, { isPublicSuffix, now: NOW });
      if (!r.ok) throw new Error(r.reason);
      s.upsert(r.cookie);
    }
    const out = compileSession(
      session({ store: s, activeHosts: ['accounts.google.com'] }),
      new RuleIds(),
      undefined,
      { now: NOW }
    );
    const filters = out.rules.map((r) => r.condition.urlFilter ?? '');
    expect(filters.some((f) => f.startsWith('|https://accounts.google.com/'))).toBe(false);
    expect(filters.some((f) => f.startsWith('|https://mail.google.com/mail/u/0'))).toBe(true);
  });
});

describe('what a managed tab never hands the browser', () => {
  it('never lets a sign-in provider through as an allowed third party', () => {
    const out = compileSession(
      session({ blockThirdParty: true, allowedParties: ['google.com', 'microsoftonline.com', 'cdn.example'] }),
      new RuleIds(),
      undefined,
      { now: NOW }
    );
    const tp = out.rules.find((r) => r.condition.domainType === 'thirdParty' && !r.condition.urlFilter && !r.condition.requestDomains);
    expect(tp?.condition.excludedRequestDomains).toEqual(['cdn.example']);
  });

  it('strips the headers the browser would act on with the profile', () => {
    const out = compileSession(session(), new RuleIds(), undefined, { now: NOW });
    const strip = out.rules.find((r) => r.action.responseHeaders?.some((h) => h.header === 'set-cookie'));
    const names = strip!.action.responseHeaders!.map((h) => h.header);
    expect(names).toEqual(expect.arrayContaining(['secure-session-registration', 'google-accounts-signin']));
  });
});

describe('fallbacks for deeper cookie domains', () => {
  it('carries a .console.aws.amazon.com cookie to a console region nobody has visited', () => {
    const s = new CookieStore();
    for (const [h, url] of [
      ['state=S; Domain=console.aws.amazon.com; Path=/; Secure', 'https://console.aws.amazon.com/'],
      ['top=T; Domain=amazon.com; Path=/; Secure', 'https://www.amazon.com/'],
    ] as const) {
      const r = parseSetCookie(h, { url: new URL(url), now: NOW }, { isPublicSuffix, now: NOW });
      if (!r.ok) throw new Error(r.reason);
      s.upsert(r.cookie);
    }
    const out = compileSession(session({ store: s, activeHosts: ['console.aws.amazon.com'] }), new RuleIds(), undefined, { now: NOW });
    const top = (d: string) =>
      out.rules.filter(
        (r) => r.condition.requestDomains?.[0] === d && r.condition.resourceTypes?.includes('main_frame') && !r.condition.urlFilter
      );
    const deep = top('console.aws.amazon.com');
    const shallow = top('amazon.com');
    expect(deep.length).toBeGreaterThan(0);
    const value = deep[0]!.action.requestHeaders![0]!.value ?? '';
    expect(value).toContain('state=S');
    expect(value).toContain('top=T');
    expect(deep[0]!.priority).toBeGreaterThan(shallow[0]!.priority);
    const host = out.rules.find((r) => r.condition.urlFilter === '|https://console.aws.amazon.com^');
    expect(host!.priority).toBeGreaterThan(deep[0]!.priority);
  });
});
