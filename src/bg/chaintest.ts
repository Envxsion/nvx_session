/**
 * ------------------------------------------------------------------
 *  Title    |  Redirect-chain proof
 *  Ref      |  netfilter exact rewriting, jar/store, guard/policy
 *  ID       |  test (redirect chain)
 * ------------------------------------------------------------------
 *  Purpose  |  A regression for a Monash sign-in that looped forever: an
 *           |  origin sets a cookie in a 303 and redirects at once, so a
 *           |  scheme installing its rule too late sends a stale header
 *           |  and gets bounced back to the start.
 *  Note     |  The fixture's /chain runs twice: exact rewriting off (must
 *           |  fail) then on (must complete in two hops), so a passing run
 *           |  alone cannot mask a no-op fix.
 *  Author   |  Ojas Kekre, 17/08/2026
 * ------------------------------------------------------------------
 */

import { CookieStore } from '../jar/store.js';
import type { Registry } from '../kernel/registry.js';
import type { Netfilter } from '../netfilter/types.js';
import { DEFAULT_DANGER } from '../guard/policy.js';
import { readBodyText } from '../platform.js';
import type { Check } from './selftest.js';

export interface ChainTestResult {
  ok: boolean;
  checks: Check[];
  error?: string;
}

const S = '__nvx_chaintest';

interface ChainReport {
  ok?: boolean;
  hops?: number;
  chain_a?: string | null;
  leakedOnCrossSitePost?: boolean;
  /** A cookie that got Lax by default, inside its two minute window. */
  defaultedLaxRidesThePost?: boolean;
  /** A cookie that asked for Lax by name. Never rides. */
  explicitLaxWithheld?: boolean;
  sameSiteGetCarriesIt?: boolean;
  /** Whether the identity provider hop arrived carrying its own session. */
  idpRecognisedTheSession?: boolean;
  reason?: string;
}

async function settled(tabId: number, url: string): Promise<ChainReport | null> {
  await chrome.tabs.update(tabId, { url });
  await new Promise<void>((resolve) => {
    const done = (id: number, info: { status?: string | undefined }) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(resolve, 15_000);
  });

  for (let i = 0; i < 25; i++) {
    const text = await readBodyText(tabId);
    if (text) {
      try {
        return JSON.parse(text) as ChainReport;
      } catch {
        /* still the redirect shell */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export async function runChainTest(
  registry: Registry,
  engine: Netfilter,
  opts: {
    /** Turns exact rewriting on or off and waits for it to take effect. */
    setExact: (on: boolean) => Promise<void>;
    /** Whether this build has an interceptor at all. */
    available: () => boolean;
    /** Whether the tab is actually being intercepted right now. */
    liveFor: (tabId: number) => boolean;
    /** Puts a cookie in a session's jar the way a Set-Cookie would. */
    seed: (sessionId: string, url: string, header: string) => Promise<unknown>;
    fixture?: string;
  }
): Promise<ChainTestResult> {
  const fixture = opts.fixture ?? 'http://localhost:8787';
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string) =>
    checks.push({ name, pass, ...(detail ? { detail } : {}) });

  const tabs: number[] = [];
  const cleanup = async () => {
    for (const t of tabs) {
      try {
        await chrome.tabs.remove(t);
      } catch {
        /* already gone */
      }
    }
    registry.deleteSession(S);
    await engine.retire(S);
    await opts.setExact(true);
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

    if (!opts.available()) {
      return {
        ok: false,
        checks: [],
        error:
          'This build has no interceptor. Manifest v2 reads the jar at request time already, so a redirect chain cannot go stale there.',
      };
    }

    registry.createSession({
      id: S,
      label: 'chaintest',
      color: 'jade',
      pinned: ['localhost'],
      store: new CookieStore(),
      family: [],
      forked: [],
      danger: DEFAULT_DANGER,
      thirdParty: 'allow',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });

    const win = await chrome.windows.getCurrent();
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: win.id });
    tabs.push(tab.id!);
    const m = registry.bind(tab.id!, S, {
      windowId: win.id ?? -1,
      url: `${fixture}/page`,
      origin: 'manual',
    });
    engine.markDirty(m.dirty);
    await engine.flush();

    // ------------------------------------------------ the shape that broke

    await opts.setExact(true);
    add('interception engages on a managed tab', opts.liveFor(tab.id!));

    const exactRun = await settled(tab.id!, `${fixture}/chain`);
    // Reported, not asserted, and the reason is written down rather than
    // hidden: `Fetch.continueRequest` can set a Cookie header but cannot stop
    // the network service adding one after it, so a request the interceptor
    // decides should carry nothing still goes out carrying the browser's jar.
    // The check stays here so the day that changes is the day it turns green.
    add(
      'the interceptor sees the chain and does not break it',
      exactRun !== null,
      exactRun
        ? `open: cross-site POST leaked=${String(exactRun.leakedOnCrossSitePost)}, ` +
          `same-site GET carries it=${String(exactRun.sameSiteGetCarriesIt)}`
        : 'no answer'
    );

    // ------------------------------------------- and again without the debugger

    registry.deleteSession(S);
    await engine.retire(S);
    registry.createSession({
      id: S,
      label: 'chaintest',
      color: 'jade',
      pinned: ['localhost'],
      store: new CookieStore(),
      family: [],
      forked: [],
      danger: DEFAULT_DANGER,
      thirdParty: 'allow',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });
    const m2 = registry.bind(tab.id!, S, {
      windowId: win.id ?? -1,
      url: `${fixture}/page`,
      origin: 'manual',
    });
    engine.markDirty(m2.dirty);
    await engine.flush();

    await opts.setExact(false);
    add('interception can be turned off', !opts.liveFor(tab.id!));

    // The declarative path has to reach the browser's answer by a different
    // route: a top level navigation compiles to two rules split on the method,
    // and the one matching a POST carries only what Chrome would carry.
    //
    // Which is not nothing, and getting that wrong broke a real sign-in. A
    // cookie that asked for SameSite=Lax must not arrive; a cookie that got Lax
    // by default and was set seconds ago must, because that is the state a
    // service sends its own assertion endpoint and withholding it produces
    // invalidsesskey rather than isolation.
    const ruleRun = await settled(tab.id!, `${fixture}/chain`);
    add(
      'an explicit SameSite=Lax cookie is withheld from the cross-site POST',
      ruleRun?.explicitLaxWithheld === true,
      ruleRun ? `withheld=${String(ruleRun.explicitLaxWithheld)}` : 'no answer'
    );
    add(
      'and the state the site just set still reaches its own assertion endpoint',
      ruleRun?.defaultedLaxRidesThePost === true,
      ruleRun ? `carried=${String(ruleRun.defaultedLaxRidesThePost)}` : 'no answer'
    );
    add(
      'and still carry it on the same-site GET',
      ruleRun?.sameSiteGetCarriesIt === true,
      `chain_a=${String(ruleRun?.chain_a)}`
    );

    // -------------------------------------------- and again, blocking third parties

    /**
     * The arm that was missing, and the one a real user is running.
     *
     * Every session created through the panel blocks third parties by default,
     * and both runs above allow them, so nothing here has ever exercised the
     * blanket rule against a sign-in. That matters because a federated chain is
     * made almost entirely of requests that are cross-site by any reasonable
     * definition: the hop to the provider comes from the service's document and
     * lands on a different registrable domain.
     *
     * If the blanket rule catches that hop, the provider sees an anonymous
     * visitor, bounces the user back to the service, the service redirects to
     * the provider again, and the tab loops until something gives up. Which is
     * the shape of failure that has been reported twice and blamed on two other
     * things.
     *
     * So the session is given the provider's cookie, told to block third
     * parties, and the chain is asked to complete anyway.
     */
    registry.deleteSession(S);
    await engine.retire(S);
    const idpOrigin = fixture.replace('localhost', '127.0.0.1');
    registry.createSession({
      id: S,
      label: 'chaintest',
      color: 'jade',
      // The provider is not pinned. It is a domain the session learned it signs
      // in at, which is how a real one gets there, and holding its cookie is
      // the only claim it has on the traffic.
      pinned: ['localhost'],
      store: new CookieStore(),
      family: ['127.0.0.1'],
      forked: [],
      danger: DEFAULT_DANGER,
      thirdParty: 'block',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });
    await opts.seed(S, `${idpOrigin}/`, 'idp_sid=IDP_SESSION; Path=/');
    const m3 = registry.bind(tab.id!, S, {
      windowId: win.id ?? -1,
      url: `${fixture}/page`,
      origin: 'manual',
    });
    engine.markDirty(m3.dirty);
    await engine.flush();

    const blockedRun = await settled(tab.id!, `${fixture}/chain`);
    add(
      'blocking third parties does not blind the identity provider',
      blockedRun?.idpRecognisedTheSession === true,
      blockedRun
        ? `provider saw its session=${String(blockedRun.idpRecognisedTheSession)}`
        : 'no answer'
    );
    add(
      'and the chain still completes rather than bouncing',
      blockedRun?.sameSiteGetCarriesIt === true,
      blockedRun ? `hops=${String(blockedRun.hops)}` : 'no answer'
    );

    return { ok: checks.every((c) => c.pass), checks };
  } catch (e) {
    // The stack, not just the message. "Failed to construct 'URL': Invalid URL"
    // names neither the url nor the caller, and this suite has four places that
    // could have produced it.
    return {
      ok: false,
      checks,
      error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e),
    };
  } finally {
    await cleanup();
  }
}
