import type { CookieStore } from '../jar/store.js';

export type SessionId = string;

export interface SessionView {
  id: SessionId;
  /** Tabs currently bound to this session. */
  tabIds: number[];
  /**
   * Origins whose service worker this session owns. Confirmed by the M0 probe:
   * a rule conditioned on tabIds [-1] does match service worker traffic, so
   * ownership is expressible rather than requiring the worker to be blocked
   * outright.
   *
   * Origins, because that is what a worker registration is scoped to. These
   * were registrable domains until M4, which made `app.example.com` and
   * `example.com` contest a worker neither of them shares.
   */
  serviceWorkerOrigins: string[];
  /**
   * Hostnames the session's tabs are currently on.
   *
   * Rules must cover these even when the jar holds nothing for them yet. A
   * domain with no rule is not neutral: the browser sends its own jar, so the
   * very first visit under a new session inherits whatever identity the
   * profile already had. On a federated site that is the whole failure, since
   * the identity provider sees the old session and signs you straight back in
   * as the wrong account without ever offering a choice.
   */
  activeHosts: string[];
  /**
   * Whether a third party this session has no cookies for should be handed the
   * browser's own jar. False leaves the leak in place, which is the browser's
   * behaviour and is what a session needing embedded third party logins wants.
   */
  blockThirdParty?: boolean;
  /**
   * Third parties this session is told to leave alone, as registrable domains.
   *
   * Blocking third parties is one switch over a list of very different things.
   * A tracker and a sign-in provider are both third party, and on a federated
   * site they arrive in the same page load, so an all-or-nothing switch means
   * choosing between being followed and being able to log in. Measured on a
   * real Google sign-in: the block took an asset host the flow depends on and
   * the result was a redirect loop, which reads as the site being broken rather
   * than as a setting having been chosen.
   *
   * So the block keeps a hole per party. Nothing is here unless the user put it
   * here, and the third parties view lists what was seen so the choice is made
   * against evidence rather than from memory.
   */
  allowedParties?: string[];
  store: CookieStore;
}

export interface CompileOptions {
  now?: number;
  strictOnTopLevel?: boolean;
  /**
   * Rules are compiled before any request exists, so the scheme has to be
   * assumed to decide whether Secure cookies are eligible. Everything is https
   * except explicit local development origins.
   */
  schemeFor?: (domain: string) => 'https:' | 'http:';
  maxHeaderBytes?: number;
  /**
   * Strip cookies from every other domain a managed tab touches, not just the
   * ones in scope. Full isolation, at the cost of being signed out of
   * unrelated sites inside a managed tab. Off by default under the
   * reliability first doctrine.
   */
  strict?: boolean;
  /**
   * Force every response a managed tab receives to be uncacheable, closing the
   * same-origin cross-session HTTP cache channel at the cost of the cache. Off by
   * default, and only the honest form of "per-session cache", since Chrome has no
   * API to give same-origin tabs separate caches. See cacheRule.
   */
  cacheIsolation?: boolean;
}

/**
 * Rule shapes are declared here as plain string unions rather than reused from
 * @types/chrome, which models these as TypeScript enums. The wire format is
 * strings, the compiler is pure and unit tested without a browser present, and
 * a local declaration keeps both true. The cast to the browser type happens
 * once, at the backend boundary.
 */
export type ResourceType =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'csp_report'
  | 'media'
  | 'websocket'
  | 'webtransport'
  | 'webbundle'
  | 'other';

export type HeaderOperation = 'append' | 'set' | 'remove';

export interface HeaderEdit {
  header: string;
  operation: HeaderOperation;
  value?: string;
}

export interface RuleCondition {
  requestDomains?: string[];
  excludedRequestDomains?: string[];
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  urlFilter?: string;
  /** RE2, matched against the whole url. Used by the guard, not the compiler. */
  regexFilter?: string;
  /** Lower case, as the API wants them. */
  requestMethods?: string[];
  tabIds?: number[];
  excludedTabIds?: number[];
  domainType?: 'firstParty' | 'thirdParty';
  resourceTypes?: ResourceType[];
  /**
   * The complement of `resourceTypes`, and not interchangeable with it. A rule
   * that means every subresource has to say so by exclusion: enumerating the
   * types that exist today leaves anything the platform adds later uncovered,
   * and an uncovered request is one that carries the real browser.
   */
  excludedResourceTypes?: ResourceType[];
}

export interface RuleAction {
  type: 'modifyHeaders' | 'block' | 'allow';
  requestHeaders?: HeaderEdit[];
  responseHeaders?: HeaderEdit[];
}

export interface Rule {
  id: number;
  priority: number;
  action: RuleAction;
  condition: RuleCondition;
}

export interface NetFilterBackend {
  readonly name: 'dnr' | 'blocking';
  apply(rules: Rule[], removeIds: number[]): Promise<void>;
  current(): Promise<Rule[]>;
  capacity(): number;
}

/**
 * What the worker actually drives.
 *
 * The declarative path compiles a session's jar into rules and has to get them
 * installed before the next request; the blocking path reads the jar at request
 * time and has nothing to install. Both answer to these three, and on the
 * blocking side all three are deliberately no-ops.
 */
export interface Netfilter {
  markDirty(sessions: Iterable<string>): void;
  flush(): Promise<void>;
  retire(sessionId: string): Promise<void>;
  readonly pending: number;
}
