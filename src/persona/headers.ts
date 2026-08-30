/**
 * The request headers that have to agree with the patched navigator.
 *
 * Every other surface the mask touches is answerable inside the page. This one
 * is not: `navigator.userAgent` and the `User-Agent` header are two reports of
 * the same fact, and a page that reads one while its own origin reads the other
 * can be handed a contradiction by any server that cares to look. Rewriting the
 * page alone would manufacture exactly the incoherence the mask exists to
 * prevent, which is why this is compiled next to the mask rather than after it.
 *
 * Four decisions, each of which was a wrong answer first.
 *
 * Scope follows the mask exactly. The mask is registered for the hosts sessions
 * care about, so those are the hosts whose headers move, and both come from one
 * call in the worker for the reason that they must never be derived separately.
 *
 * Navigations are matched by where they are going and subresources by where
 * they came from. A navigation produces a document, and that document is masked
 * only when its own url matches, so `requestDomains` is the honest condition. A
 * subresource produces no document at all: its `User-Agent` is the fetching
 * document's, so it must move whenever the fetching document is masked and
 * wherever it is going, which is `initiatorDomains`. Conditioning subresources
 * on their destination instead would leave every third party a masked page
 * touches reading the real browser, and conditioning navigations on their
 * initiator would rewrite the headers of an unmasked iframe inside a masked
 * page, which is the same contradiction pointing the other way.
 *
 * Client hints are sent to potentially trustworthy origins, not to https. That
 * was measured rather than assumed, and the assumption was wrong: Chromium
 * sends `Sec-CH-UA` to `http://localhost` and `http://127.0.0.1`. A rule gated
 * on the scheme would have left the real brand list on the wire next to a
 * normalised user agent on exactly the origin the suite runs against.
 *
 * The high entropy brand hints are removed rather than replaced, and this is the
 * one place here that is a trade rather than a right answer. `set` in this API
 * is unconditional, so replacing them would send hints to every origin that
 * never asked for any, which no browser does and which announces itself. A hint
 * that was asked for and not answered is the smaller anomaly, and it is one a
 * permissions policy can produce on its own.
 */

import type { Rule } from '../netfilter/types.js';
import type { Brand } from './useragent.js';
import { secChUa } from './useragent.js';

/**
 * Rule ids for the posture live below the guard's band, which starts at 100.
 * The three bands must not meet: an id collision replaces a rule rather than
 * adding one, and the replaced rule fails silently.
 */
export const POSTURE_ID_BASE = 10;
export const POSTURE_RULES = 16;

export function postureIds(): number[] {
  return Array.from({ length: POSTURE_RULES }, (_, i) => POSTURE_ID_BASE + i);
}

/**
 * How many hosts one rule's condition will carry.
 *
 * The API caps the domain lists, and a rule that exceeds the cap is rejected
 * whole, which would take the header rewrite off for every host rather than the
 * ones past the line. Well above any real session count, and reported when it
 * bites rather than silently trimmed.
 */
export const MAX_POSTURE_HOSTS = 250;

/**
 * Where the browser sends client hints.
 *
 * Not a special case for a site: this is the platform's own potentially
 * trustworthy origin rule, which hint delivery follows and which https alone
 * does not describe. The trailing `^` is the API's separator class, matching
 * anything that is not a hostname character, so `|http://localhost^` covers
 * `http://localhost/` and `http://localhost:8787/` without also covering
 * `http://localhost.example.com/`, which is an ordinary insecure origin that
 * happens to start the same way.
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
