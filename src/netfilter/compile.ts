/**
 * Compiling a session's jar into declarativeNetRequest rules.
 *
 * The shape here follows what the M0 probe actually confirmed on Chrome 151
 * and Opera 134: tabIds conditions work, tabIds [-1] matches service worker
 * traffic, modifyHeaders with operation "set" replaces the Cookie header
 * outright, and domainType splits first from third party.
 *
 * Three facts drive the design.
 *
 * 1. "set" replaces rather than appends, so a managed tab never sees the
 *    profile jar. That is the whole isolation guarantee.
 * 2. A missing rule is not neutral. With no rule the browser sends its own
 *    cookies, so a session holding nothing for a domain still needs a rule,
 *    one that removes the header.
 * 3. A rule covers a whole domain but cookies are path scoped, so distinct
 *    paths need distinct rules ordered by specificity.
 */

import {
  emit,
  isSafeMethod,
  LAX_UNSAFE_WINDOW_MS,
  withinLaxUnsafeWindow,
  type EmitContext,
} from '../jar/emit.js';
import type { Cookie } from '../jar/cookie.js';
import type { CompileOptions, ResourceType, Rule, RuleCondition, SessionView } from './types.js';
import { canHaveSubdomains, registrableDomain } from '../jar/psl.js';

/**
 * Rule ids are partitioned so a session's rules can be removed wholesale.
 *
 * Rules are per host rather than per registrable domain, and a real site uses
 * several: www, api, identity, static. 320 covers roughly 75 hosts at four
 * variants each and still leaves room for about 15 concurrent sessions inside
 * the platform ceiling of 5000.
 *
 * Raised from 192 after a real workday session (one "IBL" session pinned to
 * eight work domains, then browsed across Google, Atlassian, Slack, Bitrise,
 * BrowserStack, Firebase and more) overflowed constantly and dropped the rules
 * for whichever auth host it reached last, which was exactly the sign-in the
 * user was in the middle of. The budget is only half the fix: a jar accretes
 * hosts without bound over a long session, so no fixed block fits forever. The
 * other half is compileSession compiling the hosts a tab is actually open on
 * before the rest, so overflow can only ever drop a background jar host and
 * never the page in front of the user. See compileSession.
 */
export const RULES_PER_SESSION = 320;

/**
 * How many rules one host costs. Exported because the adoption estimate has to
 * track it exactly: an estimate that runs low tells the user their selection
 * fits and then silently drops the hosts that did not.
 */
export const RULES_PER_HOST = 4;
export const RULE_ID_BASE = 1000;

const VARIANTS: readonly EmitContext[] = ['first-party', 'third-party', 'top-level'];

/**
 * A top level navigation compiles to two rules, not one, because SameSite=Lax
 * rides a cross-site navigation only when the method is safe.
 *
 * Without the split, the assertion an identity provider POSTs back to a service
 * carries that service's own session cookie, which the browser itself would
 * have withheld. The endpoint binds its assertion to a session the browser is
 * not actually using, and the site bounces you back to the identity provider
 * forever. One extra rule per host is a cheap price for a sign-in that works.
 */
const SAFE_METHODS = ['get', 'head'];
const UNSAFE_METHODS = ['post', 'put', 'patch', 'delete', 'options', 'connect', 'other'];

interface Variant {
  context: EmitContext;
  /** Undefined means every method, which is right for subresources. */
  methods?: string[];
  /** What to tell the jar, so its answer matches the condition above it. */
  method?: string;
}

const RULE_VARIANTS: readonly Variant[] = [
  { context: 'first-party' },
  { context: 'third-party' },
  { context: 'top-level', methods: SAFE_METHODS, method: 'GET' },
  { context: 'top-level', methods: UNSAFE_METHODS, method: 'POST' },
];

const SUBRESOURCE_TYPES: ResourceType[] = [
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
];

/**
 * Deterministic id allocation. Ids must be stable across recompiles so an
 * update replaces a rule rather than accumulating duplicates, and must be
 * derivable without persisting a map.
 */
export class RuleIds {
  private readonly sessionSlots = new Map<string, number>();
  /**
   * Slots are recycled. Without this, creating and deleting sessions over a
   * long-lived browser session walks the slot counter upward forever and
   * eventually pushes live sessions past the rule ceiling, which shows up as
   * isolation quietly failing for whichever session was unlucky.
   */
  private readonly freeSlots: number[] = [];
  private nextSlot = 0;

  slotFor(sessionId: string): number {
    let slot = this.sessionSlots.get(sessionId);
    if (slot === undefined) {
      slot = this.freeSlots.pop() ?? this.nextSlot++;
      this.sessionSlots.set(sessionId, slot);
    }
    return slot;
  }

  /**
   * Frees a slot and returns every id in it, so the caller can withdraw the
   * rules before the slot is handed to another session. Reusing a slot whose
   * rules are still live would give the new session the old one's headers.
   */
  releaseSession(sessionId: string): number[] {
    const slot = this.sessionSlots.get(sessionId);
    if (slot === undefined) return [];
    this.sessionSlots.delete(sessionId);
    this.freeSlots.push(slot);
    const base = RULE_ID_BASE + slot * RULES_PER_SESSION;
    return Array.from({ length: RULES_PER_SESSION }, (_, i) => base + i);
  }

  /** Sessions that can be tracked at once before the ceiling is reached. */
  static capacity(maxRules: number): number {
    return Math.floor(maxRules / RULES_PER_SESSION);
  }

  /** Ids are assigned in compile order within a session's block. */
  blockFor(sessionId: string): { base: number; limit: number } {
    const base = RULE_ID_BASE + this.slotFor(sessionId) * RULES_PER_SESSION;
    return { base, limit: base + RULES_PER_SESSION };
  }

  idsFor(sessionId: string): number[] {
    const { base } = this.blockFor(sessionId);
    return Array.from({ length: RULES_PER_SESSION }, (_, i) => base + i);
  }
}

function defaultScheme(domain: string): 'https:' | 'http:' {
  return domain === 'localhost' || domain.endsWith('.localhost') || domain === '127.0.0.1'
    ? 'http:'
    : 'https:';
}

/**
 * Distinct cookie paths for a domain, most specific first. Sending a header
 * built for "/" to a path-scoped cookie's path would under-send; sending the
 * path-scoped one everywhere would over-send. Both are wrong, so each distinct
 * path gets its own rule and priority resolves the overlap.
 */
function pathsFor(cookies: Cookie[]): string[] {
  const paths = new Set<string>(['/']);
  for (const c of cookies) paths.add(c.path);
  return [...paths].sort((a, b) => b.length - a.length);
}

/**
 * A host rule is anchored to that exact host, a fallback rule is not.
 *
 * requestDomains matches subdomains, so without the anchor a rule for
 * example.com would also claim identity.example.com and hand it the apex's
 * host-only cookies. Anchoring keeps each host to itself and lets the
 * registrable-domain fallback own everything nobody has visited yet, which is
 * exactly how the browser scopes cookies.
 */
function conditionFor(
  variant: Variant,
  host: string,
  tabIds: number[],
  path: string,
  scheme: 'https:' | 'http:',
  isFallback: boolean
): RuleCondition {
  const base: RuleCondition = {
    requestDomains: [isFallback ? host : registrableDomain(host)],
    tabIds,
  };

  if (!isFallback) {
    // The ^ separator matches any character that is not a letter, digit, _, -,
    // . or %. That covers both the / of a default port and the : of an
    // explicit one, so the anchor survives http://host:8787 while still
    // refusing host.evil.com, where the next character is a dot.
    base.urlFilter =
      path === '/' ? `|${scheme}//${host}^` : `||${host}${path}`;
  } else if (path !== '/') {
    base.urlFilter = `||${host}${path}`;
  }

  switch (variant.context) {
    case 'first-party':
      return { ...base, domainType: 'firstParty', resourceTypes: SUBRESOURCE_TYPES };
    case 'third-party':
      return { ...base, domainType: 'thirdParty', resourceTypes: SUBRESOURCE_TYPES };
    case 'top-level':
      return {
        ...base,
        resourceTypes: ['main_frame'],
        ...(variant.methods ? { requestMethods: [...variant.methods] } : {}),
      };
  }
}

/**
 * A host rule outranks the registrable-domain fallback, and a longer path
 * outranks a shorter one. identity.example.com must beat the example.com
 * fallback, or a host-only session cookie is replaced by the fallback's empty
 * header and the sign-in is lost.
 */
function priorityFor(_host: string, path: string, isFallback: boolean): number {
  if (isFallback) return path === '/' ? PRIORITY_FALLBACK : PRIORITY_FALLBACK + 1 + path.length;
  return Math.min(path === '/' ? PRIORITY_HOST : PRIORITY_HOST + 1 + path.length, 1000);
}

/**
 * Three tiers. The catch-all removes cookies from anything out of scope, the
 * fallback carries domain-scoped cookies to subdomains nobody has visited yet,
 * and host rules carry the real thing.
 */
const PRIORITY_CATCH_ALL = 1;
const PRIORITY_FALLBACK = 2;
const PRIORITY_HOST = 4;

/**
 * Removes the Cookie header for anything the session has no specific rule for.
 * Only emitted in strict mode, because it also signs a managed tab out of
 * every unrelated site.
 */
function catchAllRule(tabIds: number[], id: number): Rule {
  return {
    id,
    priority: PRIORITY_CATCH_ALL,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'remove' }],
    },
    condition: { tabIds },
  };
}

/**
 * Strips the Cookie header from third party requests the session has no rule
 * for, which is every tracker on every page it visits.
 *
 * Narrower than the catch-all above on purpose. That one takes first party
 * requests too, which signs a managed tab out of any site the session has not
 * been to yet; this one leaves navigation alone and only removes what the
 * session was never going to be able to answer for anyway.
 *
 * It sits at the bottom priority, so a third party the session genuinely holds
 * cookies for keeps its own host rule and still works. An identity provider in
 * an iframe is third party too, and breaking that would break single sign-on.
 */
function thirdPartyRule(tabIds: number[], id: number, allowed: string[] = []): Rule {
  // Excluded on the rule rather than answered by a higher priority one of its
  // own. An allowed party is not being given anything: it is being left exactly
  // as the browser would have it, which is one condition rather than a second
  // rule that has to out-rank this one and be kept in step with it.
  const spared = [...new Set(allowed.filter(Boolean))].sort();
  return {
    id,
    priority: PRIORITY_CATCH_ALL,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'cookie', operation: 'remove' }],
    },
    condition: {
      tabIds,
      domainType: 'thirdParty',
      ...(spared.length ? { excludedRequestDomains: spared } : {}),
    },
  };
}

/**
 * Forces every response a managed tab receives to be uncacheable.
 *
 * The honest version of per-session cache isolation. Chrome partitions the HTTP
 * cache by top-frame site, not by session, so two same-origin tabs that are
 * different sessions share one cache partition, and there is no web API to give
 * them separate caches short of separate profiles. What is reachable is
 * suppression: a session's tabs can be made to never cache, which closes the
 * same-origin cross-session cache channel (a site stashing an id in a cacheable
 * resource under one session and reading it back under another) at the cost of
 * the cache. Opt-in, because that cost is real; off, the cache is shared and the
 * channel is a disclosed low-severity residual.
 */
function cacheRule(tabIds: number[], id: number): Rule {
  return {
    id,
    priority: PRIORITY_CATCH_ALL,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [{ header: 'cache-control', operation: 'set', value: 'no-store' }],
    },
    condition: { tabIds },
  };
}

export interface CompiledDomain {
  domain: string;
  rules: Rule[];
  /** Header bytes dropped because the budget was exceeded, for diagnostics. */
  truncated: number;
  /**
   * When these rules stop being correct, or null if they do not expire.
   *
   * A rule is a photograph of an answer, and one answer here is time dependent:
   * a defaulted-Lax cookie rides a cross-site POST only for its first two
   * minutes. After that the rule says yes to something the browser would refuse,
   * so the caller is told when to ask again.
   */
  expiresAt: number | null;
}

/**
 * A synthetic host used only to compute the fallback header for a registrable
 * domain. Emitting against it yields exactly the cookies that would reach a
 * subdomain nobody has visited: domain-scoped ones match, host-only ones do
 * not, which is what the browser itself would do.
 */
const UNVISITED = 'nvx-unvisited-subdomain';

/** `https://host:8787` to `https://host`. See the note at the call site. */
function schemeAndHost(origin: string): string {
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.hostname.toLowerCase()}`;
  } catch {
    return origin;
  }
}

/**
 * Compiles the rules for one host.
 *
 * Host, not registrable domain. A cookie set by identity.example.com without a
 * Domain attribute is host-only and is never sent to example.com, so a rule
 * built for the apex but matching the subdomain would carry an empty header
 * and delete the session it was supposed to carry. That is the failure mode
 * behind a federated sign-in silently reverting to the wrong account.
 */
export function compileHost(
  session: SessionView,
  host: string,
  nextId: () => number,
  opts: CompileOptions = {},
  isFallback = false
): CompiledDomain {
  const now = opts.now ?? Date.now();
  const registrable = registrableDomain(host);
  const scheme = (opts.schemeFor ?? defaultScheme)(host);
  const rules: Rule[] = [];
  let truncated = 0;

  const tabScopes: number[][] = [];
  if (session.tabIds.length) tabScopes.push([...session.tabIds]);
  // Confirmed by the M0 probe: this attributes service worker traffic, which
  // is what lets the worker stay alive instead of being blocked. Matched on the
  // origin the rule is being built for, not its registrable domain, because a
  // worker registration is scoped to an origin.
  //
  // The port is dropped for the comparison, because a rule cannot express one:
  // the urlFilter is anchored at the host and matches every port on it. So a
  // session owning the worker on any port of this scheme and host gets the
  // rule. Over-granting across ports of one host beats the alternative, which
  // is a rule that never matches on a development origin.
  if (session.serviceWorkerOrigins.some((o) => schemeAndHost(o) === `${scheme}//${host}`)) {
    tabScopes.push([-1]);
  }
  if (!tabScopes.length) return { domain: host, rules, truncated, expiresAt: null };

  const emitHost = isFallback ? `${UNVISITED}.${host}` : host;
  const cookies = session.store.forDomain(registrable);
  let expiresAt: number | null = null;

  for (const path of pathsFor(cookies)) {
    const url = new URL(`${scheme}//${emitHost}${path === '/' ? '/' : `${path}/`}`);

    for (const variant of RULE_VARIANTS) {
      const result = emit(session.store, url, variant.context, {
        now,
        ...(variant.method ? { method: variant.method } : {}),
        ...(opts.strictOnTopLevel !== undefined
          ? { strictOnTopLevel: opts.strictOnTopLevel }
          : {}),
        ...(opts.maxHeaderBytes !== undefined ? { maxBytes: opts.maxHeaderBytes } : {}),
      });
      truncated += result.truncated.length;

      // Only the unsafe-method variant can be carrying a cookie on borrowed
      // time. Noting it here rather than scanning the jar keeps the expiry tied
      // to what actually went into a rule.
      if (!isSafeMethod(variant.method)) {
        for (const c of result.included) {
          if (!withinLaxUnsafeWindow(c, now)) continue;
          const until = c.created + LAX_UNSAFE_WINDOW_MS;
          if (expiresAt === null || until < expiresAt) expiresAt = until;
        }
      }

      for (const tabIds of tabScopes) {
        rules.push({
          id: nextId(),
          priority: priorityFor(host, path, isFallback),
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              result.header
                ? { header: 'cookie', operation: 'set', value: result.header }
                : // No cookies for this session here. Without an explicit
                  // remove the browser falls back to its own jar, which is
                  // precisely the leak the design exists to prevent.
                  { header: 'cookie', operation: 'remove' },
            ],
          },
          condition: conditionFor(variant, host, tabIds, path, scheme, isFallback),
        });
      }
    }
  }

  return { domain: host, rules, truncated, expiresAt };
}

/** Retained for callers that think in domains. */
export const compileDomain = compileHost;

export interface CompiledSession {
  sessionId: string;
  rules: Rule[];
  removeIds: number[];
  overflowed: string[];
  truncated: number;
  /**
   * Hosts that could not be compiled at all, with the reason.
   *
   * Different from overflowed, which is a host that would have compiled fine
   * and did not fit in the budget. This is a host the compiler could not make
   * sense of, and the only ones seen so far came from the URL parser refusing
   * a synthetic name.
   *
   * It exists because the alternative is what used to happen: one unusable
   * host threw, the exception escaped compileSession, and the session ended up
   * with no rules whatsoever. The session it happened to then carried nothing,
   * which does not read as a failure from the outside, it reads as the
   * extension quietly not working.
   */
  skipped: { host: string; reason: string }[];
  /** Earliest moment one of these rules goes stale. See CompiledDomain. */
  expiresAt: number | null;
}

/**
 * Compiles every domain the session knows about. Domains beyond the session's
 * rule budget are reported rather than silently dropped, because a silently
 * missing rule means the profile jar leaks into a managed tab.
 */
export function compileSession(
  session: SessionView,
  ids: RuleIds,
  domains?: string[],
  opts: CompileOptions = {}
): CompiledSession {
  const { base, limit } = ids.blockFor(session.id);
  let cursor = base;
  const nextId = () => cursor++;

  const rules: Rule[] = [];
  const overflowed: string[] = [];
  let truncated = 0;
  let expiresAt: number | null = null;

  // Two things are unioned here, and both matter.
  //
  // Hosts the jar knows about, so every cookie actually gets carried, and
  // hosts the session's tabs are on, so a brand new session has rules before
  // its first request rather than inheriting the profile jar.
  const hosts = new Set<string>(domains ?? []);
  if (!domains) {
    for (const h of session.store.hosts()) hosts.add(h);
    for (const h of session.activeHosts) hosts.add(h);
  }

  // One fallback per registrable domain, carrying only the domain-scoped
  // cookies, so a subdomain nobody has visited yet is still covered rather
  // than falling through to the browser.
  // The apex keeps its host rule as well as gaining a fallback. They are not
  // the same rule: the host rule is anchored and carries the apex's own
  // host-only cookies, the fallback is unanchored and carries only the
  // domain-scoped ones onward to subdomains nobody has visited. Collapsing the
  // two loses every host-only cookie on the apex.
  //
  // Only for hosts that can have a subdomain. An address cannot, and building
  // the synthetic one for it throws inside the URL parser rather than yielding
  // a useless rule, which took the whole session's flush down with it.
  const fallbacks = new Set<string>();
  for (const h of hosts) {
    const registrable = registrableDomain(h);
    if (canHaveSubdomains(registrable)) fallbacks.add(registrable);
  }

  if (opts.strict && session.tabIds.length) {
    rules.push(catchAllRule([...session.tabIds], nextId()));
  } else if (session.blockThirdParty && session.tabIds.length) {
    rules.push(thirdPartyRule([...session.tabIds], nextId(), session.allowedParties ?? []));
  }

  // Independent of the cookie catch-all above, since it touches a response header
  // rather than the request, and compiled first alongside it so an overflow can
  // only ever drop a background host rule and never the cache suppression.
  if (opts.cacheIsolation && session.tabIds.length) {
    rules.push(cacheRule([...session.tabIds], nextId()));
  }

  const targets: { host: string; fallback: boolean }[] = [
    ...[...fallbacks].map((host) => ({ host, fallback: true })),
    ...[...hosts].map((host) => ({ host, fallback: false })),
  ];

  // Compile the hosts a tab is actually open on before the rest, so when the
  // budget overflows it can only ever drop a background jar host and never the
  // page in front of the user.
  //
  // The jar accretes a host for every site the session has ever touched, and
  // that set only grows, so a long-lived session eventually needs more rules
  // than any fixed block holds. Which hosts got dropped used to be down to Set
  // insertion order, which meant the host the user was in the middle of signing
  // into, added last, was the first to lose its rules. A dropped auth host has
  // no rule, so its request falls through to the browser's own jar, and the
  // sign-in bounces between provider and service until the browser gives up.
  // That is the redirect loop. Ordering active hosts first cannot fail that way:
  // a host a tab is on this instant keeps its rules, and only hosts nothing is
  // looking at can overflow. Stable, so within a tier the original order holds.
  const active = new Set(session.activeHosts);
  const activeDomains = new Set([...active].map((h) => registrableDomain(h)));
  const rank = (t: { host: string; fallback: boolean }): number => {
    if (!t.fallback && active.has(t.host)) return 0;
    if (t.fallback && activeDomains.has(t.host)) return 1;
    return 2;
  };
  targets.sort((a, b) => rank(a) - rank(b));

  const skipped: { host: string; reason: string }[] = [];

  for (const { host, fallback } of targets) {
    // Per host, so one host nobody anticipated cannot cost the session every
    // other rule it was owed. Hosts come from wherever the user browsed, which
    // means the set of shapes this has to survive is not enumerable in advance.
    try {
      const probe = compileHost(session, host, () => cursor, opts, fallback);
      if (cursor + probe.rules.length > limit) {
        overflowed.push(host);
        continue;
      }
      const compiled = compileHost(session, host, nextId, opts, fallback);
      rules.push(...compiled.rules);
      truncated += compiled.truncated;
      if (compiled.expiresAt !== null && (expiresAt === null || compiled.expiresAt < expiresAt)) {
        expiresAt = compiled.expiresAt;
      }
    } catch (e) {
      skipped.push({ host, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    sessionId: session.id,
    rules,
    removeIds: ids.idsFor(session.id),
    overflowed,
    truncated,
    skipped,
    expiresAt,
  };
}
