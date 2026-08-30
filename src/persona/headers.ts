/**
 * ------------------------------------------------------------------
 *  Title    |  Posture request headers
 *  Ref      |  netfilter/types.ts, useragent.ts, compilePosture
 *  ID       |  M3 (fingerprint)
 * ------------------------------------------------------------------
 *  Purpose  |  Rewrite the request headers that have to agree with the
 *           |  patched navigator.
 *  How      |  `navigator.userAgent` and the `User-Agent` header are
 *           |  two reports of one fact, so rewriting the page alone
 *           |  would manufacture the incoherence the mask prevents.
 *           |  Compiled next to the mask, from one worker call.
 *  Note     |  Four decisions, each a wrong answer first. Scope follows
 *           |  the mask. Navigations match on destination
 *           |  (`requestDomains`), subresources on initiator
 *           |  (`initiatorDomains`), since a subresource carries the
 *           |  fetching document's UA. Client hints go to potentially
 *           |  trustworthy origins, not just https: Chromium sends
 *           |  `Sec-CH-UA` to `http://localhost`. High entropy brand
 *           |  hints are removed rather than replaced, because `set` is
 *           |  unconditional and would send hints no origin asked for.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

import type { Rule } from '../netfilter/types.js';
import type { Brand } from './useragent.js';
import { secChUa } from './useragent.js';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Rule ids for the posture, below the guard's band at 100.
 *  Note     |  The bands must not meet: an id collision replaces a rule
 *           |  rather than adding one, and the replaced rule fails
 *           |  silently.
 * ------------------------------------------------------------------
 */
export const POSTURE_ID_BASE = 10;
export const POSTURE_RULES = 16;

export function postureIds(): number[] {
  return Array.from({ length: POSTURE_RULES }, (_, i) => POSTURE_ID_BASE + i);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  How many hosts one rule's condition will carry.
 *  Note     |  The API caps the domain lists and rejects an oversized
 *           |  rule whole, which would take the header rewrite off for
 *           |  every host. Well above any real session count, and
 *           |  reported when it bites rather than silently trimmed.
 * ------------------------------------------------------------------
 */
export const MAX_POSTURE_HOSTS = 250;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Where the browser sends client hints.
 *  How      |  The platform's own potentially-trustworthy origin rule,
 *           |  which hint delivery follows and https alone does not
 *           |  describe.
 *  Note     |  The trailing `^` is the API's separator class, so
 *           |  `|http://localhost^` covers `http://localhost/` and
 *           |  `http://localhost:8787/` but not
 *           |  `http://localhost.example.com/`, an ordinary insecure
 *           |  origin that starts the same way.
 * ------------------------------------------------------------------
 */
const HINTED_ORIGINS = ['|https://', '|http://localhost^', '|http://127.0.0.1^', '|http://[::1]^'];

export interface PostureAgent {
  /** What `navigator.userAgent` will report. Empty leaves the header alone. */
  userAgent: string;
  /** What `navigator.userAgentData.brands` will report. */
  brands: Brand[];
}

export interface PostureInput {
  hosts: string[];
  /** Null under Mirror, which rewrites nothing. */
  agent: PostureAgent | null;
  /**
   * Domains where the mask could not reach a worker and took itself off.
   *
   * Rewriting headers for a page that is no longer patched produces the same
   * contradiction the withdrawal exists to end, so the exclusion has to reach
   * both the navigation rule and the subresource rule: a masked page's
   * subresources are matched by where they came from, so an origin that dropped
   * out has to be excluded as an initiator as well as as a destination.
   */
  excluded?: string[];
  /**
   * Tabs whose current document predates the mask, and which must therefore be
   * left entirely real.
   *
   * A content script only enters a document as it loads, so every tab already
   * open when a posture is switched on keeps the browser's own canvas, audio
   * and navigator for the life of that document. Header rules have no such
   * limitation: they are installed on the host and apply to the next request
   * from any tab, including those. Rewriting the user agent there produces a
   * page that reports one browser and requests that report another, which is
   * not a weaker version of the posture but a stronger fingerprint than doing
   * nothing at all, because no ordinary browser is ever incoherent that way.
   *
   * Measured on a profile with fifty tabs already open: the page said
   * `OPR/134.0.0.0` and its own fetch arrived carrying `Chrome/150.0.0.0`.
   */
  unmasked?: number[];
}

export interface CompiledPosture {
  rules: Rule[];
  /** Hosts past the condition cap, so the caller can say so rather than lose them. */
  dropped: string[];
}

const NAVIGATIONS = ['main_frame', 'sub_frame'] as const;

export function compilePosture(input: PostureInput): CompiledPosture {
  const agent = input.agent;
  const hosts = [...new Set(input.hosts.filter(Boolean))].sort();
  if (!agent || !agent.userAgent || !hosts.length) return { rules: [], dropped: [] };

  const kept = hosts.slice(0, MAX_POSTURE_HOSTS);
  const dropped = hosts.slice(MAX_POSTURE_HOSTS);

  const ua = { header: 'user-agent', operation: 'set' as const, value: agent.userAgent };
  const hints = agent.brands.length
    ? [
        { header: 'sec-ch-ua', operation: 'set' as const, value: secChUa(agent.brands) },
        // See the note at the top: removed rather than replaced, because `set`
        // cannot be conditional on the header already being there.
        { header: 'sec-ch-ua-full-version-list', operation: 'remove' as const },
        { header: 'sec-ch-ua-full-version', operation: 'remove' as const },
      ]
    : [];

  let id = POSTURE_ID_BASE;
  const rules: Rule[] = [];
  const add = (headers: typeof hints, condition: Rule['condition']) => {
    if (!headers.length || id >= POSTURE_ID_BASE + POSTURE_RULES) return;
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: headers },
      condition,
    });
  };

  const off = [...new Set(input.excluded ?? [])].filter(Boolean).sort();
  const real = [...new Set(input.unmasked ?? [])].filter((id) => typeof id === 'number' && id >= 0);
  const leaveAlone = real.length ? { excludedTabIds: real } : {};

  const scopes: Rule['condition'][] = [
    {
      requestDomains: kept,
      ...(off.length ? { excludedRequestDomains: off } : {}),
      ...leaveAlone,
      resourceTypes: [...NAVIGATIONS],
    },
    {
      initiatorDomains: kept,
      ...(off.length ? { excludedInitiatorDomains: off } : {}),
      ...leaveAlone,
      // Everything that is not a navigation. Excluding the two rather than
      // enumerating the dozen means a resource type added to the platform later
      // is covered rather than quietly left real.
      excludedResourceTypes: [...NAVIGATIONS],
    },
  ];

  // The user agent goes on every scheme, because it is sent on every scheme.
  for (const scope of scopes) add([ua], scope);

  // The hints go only where the browser sends them.
  for (const scope of scopes) {
    for (const origin of HINTED_ORIGINS) add(hints, { ...scope, urlFilter: origin });
  }

  return { rules, dropped };
}
