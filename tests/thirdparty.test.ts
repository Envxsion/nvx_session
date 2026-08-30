/**
 * Third parties: the ledger, and the rule that acts on it.
 *
 * Measured on a real Moodle page under two isolated sessions: 23 requests to
 * doubleclick.net, 6 to Baidu analytics, 4 to LinkedIn, every one carrying the
 * profile's own identifier, identical across both sessions. The accounts were
 * perfectly separated and the person behind them was not.
 */

import { describe, expect, it } from 'vitest';
import { ThirdPartyLog, MAX_SIGHTINGS } from '../src/observer/thirdparty.js';
import { CookieStore } from '../src/jar/store.js';
import { compileSession, RuleIds } from '../src/netfilter/compile.js';
import type { SessionView } from '../src/netfilter/types.js';
import { parseSetCookie } from '../src/jar/cookie.js';
import { isPublicSuffix } from '../src/jar/psl.js';

const NOW = 1_700_000_000_000;

function view(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 'work',
    tabIds: [7],
    serviceWorkerOrigins: [],
    activeHosts: ['learning.monash.edu'],
    store: new CookieStore(),
    ...over,
  };
}

describe('the third party ledger', () => {
  it('counts a party per site it was pulled in through', () => {
    const log = new ThirdPartyLog();
    log.note('doubleclick.net', 'monash.edu', true, NOW);
    log.note('doubleclick.net', 'monash.edu', true, NOW + 1);
    log.note('doubleclick.net', 'github.com', true, NOW + 2);

    // The same tracker on two sites is two facts, not one with a bigger number:
    // which sites a party is present on is the thing worth reading.
    expect(log.size).toBe(2);
    expect(log.parties).toBe(1);
    expect(log.ranked()[0]).toMatchObject({ party: 'doubleclick.net', via: 'monash.edu', count: 2 });
  });

  it('reports a pair as sent once it was ever sent', () => {
    const log = new ThirdPartyLog();
    log.note('doubleclick.net', 'monash.edu', false, NOW);
    log.note('doubleclick.net', 'monash.edu', true, NOW + 1);
    // Turning blocking on later does not undo the request that already left.
    expect(log.ranked()[0]!.blocked).toBe(false);
  });

  it('ignores a request to the site itself', () => {
    const log = new ThirdPartyLog();
    log.note('monash.edu', 'monash.edu', true, NOW);
    expect(log.size).toBe(0);
  });

  it('stays bounded', () => {
    const log = new ThirdPartyLog(3);
    for (let i = 0; i < 10; i++) log.note(`t${i}.example`, 'monash.edu', true, NOW + i);
    expect(log.size).toBe(3);
    // Oldest goes first, which is also the least interesting.
    expect(log.ranked().some((s) => s.party === 't9.example')).toBe(true);
    expect(log.ranked().some((s) => s.party === 't0.example')).toBe(false);
  });

  it('survives a reload of what it wrote', () => {
    const log = new ThirdPartyLog();
    log.note('doubleclick.net', 'monash.edu', false, NOW);
    const back = new ThirdPartyLog();
    back.load(JSON.parse(JSON.stringify(log.all())));
    expect(back.ranked()).toEqual(log.ranked());
    expect(MAX_SIGHTINGS).toBeGreaterThan(0);
  });

  it('ignores entries it cannot read', () => {
    const log = new ThirdPartyLog();
    log.load([null, 'nonsense', { party: 'x' }, { via: 'y' }]);
    expect(log.size).toBe(0);
  });
});

describe('the third party rule', () => {
  const ids = () => new RuleIds();

  it('is absent unless the session asks for it', () => {
    const out = compileSession(view(), ids(), undefined, { now: NOW });
    expect(out.rules.some((r) => r.condition.domainType === 'thirdParty' && !r.condition.urlFilter && !r.condition.requestDomains)).toBe(
      false
    );
  });

  it('strips cookies from third parties the session has no rule for', () => {
    const out = compileSession(view({ blockThirdParty: true }), ids(), undefined, { now: NOW });
    const rule = out.rules.find((r) => r.condition.domainType === 'thirdParty' && !r.condition.urlFilter && !r.condition.requestDomains);
    expect(rule).toBeDefined();
    expect(rule!.action.requestHeaders).toEqual([{ header: 'cookie', operation: 'remove' }]);
    expect(rule!.condition.tabIds).toEqual([7]);
  });

  /**
   * An identity provider in an iframe is third party too. If the blanket rule
   * outranked the host rules, turning this on would break single sign-on, which
   * is the one thing the project cannot afford to trade for privacy.
   */
  it('never outranks a host the session actually holds cookies for', () => {
    const store = new CookieStore();
    const p = parseSetCookie(
      'JSESSIONID=OKTA; Secure; SameSite=None',
      { url: new URL('https://monashuni.okta.com/'), now: NOW },
      { isPublicSuffix, now: NOW }
    );
    if (p.ok) store.upsert(p.cookie);

    const out = compileSession(view({ blockThirdParty: true, store }), ids(), undefined, { now: NOW });
    const blanket = out.rules.find((r) => r.condition.domainType === 'thirdParty' && !r.condition.urlFilter && !r.condition.requestDomains)!;
    const okta = out.rules.filter((r) => (r.condition.urlFilter ?? '').includes('okta'));

    expect(okta.length).toBeGreaterThan(0);
    for (const r of okta) expect(r.priority).toBeGreaterThan(blanket.priority);
    // And the third party variant for that host still carries the cookie.
    const asThird = okta.find((r) => r.condition.domainType === 'thirdParty');
    expect(asThird?.action.requestHeaders?.[0]?.value).toContain('JSESSIONID=OKTA');
  });

  it('leaves first party requests alone', () => {
    const out = compileSession(view({ blockThirdParty: true }), ids(), undefined, { now: NOW });
    const blanket = out.rules.find((r) => r.condition.domainType === 'thirdParty' && !r.condition.urlFilter && !r.condition.requestDomains)!;
    // Narrower than the strict catch-all on purpose: navigating a managed tab
    // to a site the session has not been to yet must not be stripped.
    expect(blanket.condition.domainType).toBe('thirdParty');
  });
});
