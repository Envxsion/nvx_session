/**
 * Sessions and their tab bindings.
 *
 * Sessions are durable; tabs are ephemeral bindings to them. That split is
 * what makes multi-window synchronisation fall out for free: a session open in
 * three windows is three tab ids in one rule's tabIds array, with no
 * per-window state to reconcile.
 *
 * Pure state, no browser APIs, so every transition below is unit testable.
 */

import { registrableDomain } from '../jar/psl.js';
import { CookieStore } from '../jar/store.js';
import type { Danger } from '../guard/policy.js';

export type SessionId = string;

/**
 * The holding pen a tab waits in while the user decides which account it is.
 *
 * Named here rather than only in the worker because persistence has to know it:
 * it is the one session whose jar must never be written out, and the __nvx
 * prefix alone is too broad a test, since every internal suite names its
 * throwaway sessions from the same reserved namespace.
 */
export const ANON_SESSION_ID = '__nvx_anonymous';

export type BindOrigin = 'manual' | 'opener' | 'pin' | 'adopted' | 'restored';

export interface Session {
  id: SessionId;
  label: string;
  color: string;
  group?: string;
  /** Domains this session claims, so an unbound tab navigating there adopts it. */
  pinned: string[];
  /**
   * Registrable domains this session has been observed signing in at, as
   * opposed to the ones the user named.
   *
   * One identity routinely spans several domains: a service, its identity
   * provider, and whatever else the chain touches on the way. Holding cookies
   * for a domain already counts as covering it, which carries most of this, but
   * it stops being true the moment those cookies go: session cookies are
   * dropped when the browser closes, so the morning's first visit to the
   * identity provider would match nothing and fall through to the profile jar.
   *
   * Recorded from evidence rather than configuration, and only from a top level
   * response that set a cookie, so a tracker on a managed page cannot join a
   * family by setting one from an iframe.
   */
  family: string[];
  store: CookieStore;
  /**
   * Origins whose web storage this session has already taken a copy of.
   *
   * Adoption copies the origin's own `localStorage` into the session the first
   * time it lands there, for the same reason it copies cookies rather than
   * moving them: a session adopted from a signed-in profile that started with
   * an empty store would be signed out on arrival. Recorded so that a site
   * calling `clear()` and reloading does not silently get the copy back.
   */
  forked: string[];
  /**
   * How much this session's destructive requests are worth interrupting.
   *
   * Per session rather than global, because the whole reason you keep accounts
   * apart is that they have different consequences: a personal GitHub and a
   * client's production console do not want the same answer.
   */
  danger: Danger;
  /**
   * Whether requests to third parties this session has no cookies for carry the
   * browser's own jar.
   *
   * Left alone, they do: rules are compiled per host, a tracker is not a host
   * any session knows, and a missing rule means the profile jar goes out. The
   * same identifier then leaves every session, so two accounts that are
   * perfectly separated at the application layer are one person to anyone
   * counting requests.
   *
   * Per session rather than global, because the answer differs by what the
   * session is for: a session that has to load an embedded third party the user
   * is signed into needs those cookies, and a session kept apart from the rest
   * of the browser is the entire reason the feature exists.
   */
  thirdParty: 'allow' | 'block';
  /**
   * Third parties spared from the block, as registrable domains. Empty unless
   * the user put something here from the third parties view.
   */
  allowedParties?: string[];
  /**
   * A holding pen rather than an account: its jar stays empty and is never
   * written out.
   *
   * The anonymous session is the only one. A tab heading somewhere ambiguous is
   * parked in it so the first request carries nothing and the site shows its own
   * sign-in instead of an account. If it were allowed to keep what it was handed
   * it would become an identity, shared by every parked tab, which is the exact
   * collision the chooser exists to prevent.
   */
  ephemeral?: boolean;
  createdAt: number;
  lastSeen: number;
}

export interface Binding {
  tabId: number;
  sessionId: SessionId;
  windowId: number;
  url: string;
  origin: BindOrigin;
  /** Set once the tab has issued its first request under this binding. Used to
   *  decide whether a rebind can happen silently or needs a reload. */
  sealed: boolean;
  boundAt: number;
  lastActive: number;
}

export interface Mutation {
  /** Sessions whose rule set is now stale. */
  dirty: SessionId[];
  /** True when a tab's identity changed after it had already shipped a
   *  request, which cannot be fixed by rules alone and needs a reload. */
  needsReload: number[];
}

const NONE: Mutation = Object.freeze({ dirty: [], needsReload: [] });

export interface ServiceWorkerPolicy {
  /**
   * The origin the worker is registered under. Origin, not registrable domain:
   * a service worker's scope is an origin, so `https://app.example.com` and
   * `https://example.com` are two separate workers with two separate caches and
   * no shared state at all. Keying by registrable domain treats them as one and
   * suppresses both the moment two sessions occupy either.
   */
  origin: string;
  /** The session whose jar feeds the worker, via a tabIds [-1] rule. */
  owner: SessionId | null;
  /** True when more than one session has a tab on this origin, which makes
   *  worker traffic genuinely ambiguous. */
  contested: boolean;
  /** Sessions that must not use the worker while it is contested. */
  suppressed: SessionId[];
}

export class Registry {
  private readonly sessions = new Map<SessionId, Session>();
  private readonly bindings = new Map<number, Binding>();

  // ------------------------------------------------------------- sessions

  createSession(session: Session): void {
    this.sessions.set(session.id, session);
  }

  getSession(id: SessionId): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  deleteSession(id: SessionId): Mutation {
    if (!this.sessions.delete(id)) return NONE;
    const orphaned: number[] = [];
    for (const [tabId, b] of this.bindings) {
      if (b.sessionId === id) {
        this.bindings.delete(tabId);
        orphaned.push(tabId);
      }
    }
    // An orphaned tab has been shipping requests under a session that no
    // longer exists. Leaving it bound would keep stale rules alive; reloading
    // is the only way to give it a coherent identity again.
    const needsReload = orphaned.filter((t) => this.wasSealed(t));
    // The seal record is keyed by tab id and would otherwise outlive every
    // session the tab was ever bound to, growing without bound.
    for (const t of orphaned) this.sealedHistory.delete(t);
    return { dirty: [id], needsReload };
  }

  private readonly sealedHistory = new Set<number>();

  private wasSealed(tabId: number): boolean {
    return this.sealedHistory.has(tabId);
  }

  // ------------------------------------------------------------- bindings

  bind(
    tabId: number,
    sessionId: SessionId,
    opts: { windowId: number; url: string; origin: BindOrigin; now?: number }
  ): Mutation {
    if (!this.sessions.has(sessionId)) return NONE;
    const now = opts.now ?? Date.now();
    const prior = this.bindings.get(tabId);

    if (prior?.sessionId === sessionId) {
      prior.url = opts.url;
      prior.windowId = opts.windowId;
      prior.lastActive = now;
      return NONE;
    }

    this.bindings.set(tabId, {
      tabId,
      sessionId,
      windowId: opts.windowId,
      url: opts.url,
      origin: opts.origin,
      sealed: false,
      boundAt: now,
      lastActive: now,
    });

    const dirty = new Set<SessionId>([sessionId]);
    if (prior) dirty.add(prior.sessionId);

    // Rebinding a tab that has already sent requests changes who the origin
    // thinks it is talking to mid-conversation. Rules cannot retract what was
    // already sent, so the page has to start again.
    const needsReload = prior?.sealed ? [tabId] : [];
    return { dirty: [...dirty], needsReload };
  }

  unbind(tabId: number): Mutation {
    const b = this.bindings.get(tabId);
    if (!b) return NONE;
    this.bindings.delete(tabId);
    this.sealedHistory.delete(tabId);
    return { dirty: [b.sessionId], needsReload: [] };
  }

  /** Marks a tab as having shipped a request under its current binding. */
  seal(tabId: number): void {
    const b = this.bindings.get(tabId);
    if (b) {
      b.sealed = true;
      this.sealedHistory.add(tabId);
    }
  }

  /**
   * Prerender and back-forward cache activation swap one tab id for another
   * without any create or remove event. Missing this silently orphans the
   * binding and the new tab falls back to the profile jar.
   */
  replaceTab(oldTabId: number, newTabId: number): Mutation {
    const b = this.bindings.get(oldTabId);
    if (!b) return NONE;
    this.bindings.delete(oldTabId);
    this.bindings.set(newTabId, { ...b, tabId: newTabId });
    if (this.sealedHistory.delete(oldTabId)) this.sealedHistory.add(newTabId);
    return { dirty: [b.sessionId], needsReload: [] };
  }

  navigated(tabId: number, url: string, now = Date.now()): Mutation {
    const b = this.bindings.get(tabId);
    if (!b) return NONE;
    const before = hostOf(b.url);
    b.url = url;
    b.lastActive = now;
    const after = hostOf(url);
    // Compared by host, not registrable domain. Rules are host scoped, so
    // moving from a service to its identity provider under one registrable
    // domain still needs a recompile or the new host has no rule of its own.
    return before === after ? NONE : { dirty: [b.sessionId], needsReload: [] };
  }

  movedWindow(tabId: number, windowId: number): void {
    const b = this.bindings.get(tabId);
    if (b) b.windowId = windowId;
  }

  activated(tabId: number, now = Date.now()): void {
    const b = this.bindings.get(tabId);
    if (b) {
      b.lastActive = now;
      const s = this.sessions.get(b.sessionId);
      if (s) s.lastSeen = now;
    }
  }

  binding(tabId: number): Binding | undefined {
    return this.bindings.get(tabId);
  }

  sessionForTab(tabId: number): Session | undefined {
    const b = this.bindings.get(tabId);
    return b ? this.sessions.get(b.sessionId) : undefined;
  }

  tabsFor(sessionId: SessionId): number[] {
    const out: number[] = [];
    for (const b of this.bindings.values()) {
      if (b.sessionId === sessionId) out.push(b.tabId);
    }
    return out;
  }

  listBindings(): Binding[] {
    return [...this.bindings.values()];
  }

  // ------------------------------------------------------------ resolution

  /**
   * Which session a brand new tab should join. Opener inheritance wins over
   * pinning, because a tab opened from a managed tab is continuing that
   * session's work regardless of where it points.
   */
  resolveForNewTab(opts: { openerTabId?: number; url?: string }): SessionId | null {
    if (opts.openerTabId !== undefined) {
      const opener = this.bindings.get(opts.openerTabId);
      if (opener) return opener.sessionId;
    }
    return opts.url ? this.sessionForUrl(opts.url) : null;
  }

  /** The session pinning a domain, if exactly one does. */
  sessionForUrl(url: string): SessionId | null {
    const domain = domainOf(url);
    if (!domain) return null;
    const claims = this.listSessions().filter((s) =>
      s.pinned.some((p) => registrableDomain(p) === domain)
    );
    // Two sessions claiming one domain is a configuration the user has to
    // resolve. Guessing would silently pick an account for them.
    return claims.length === 1 ? claims[0]!.id : null;
  }

  // -------------------------------------------------- service worker policy

  /**
   * Confirmed by the M0 probe: a tabIds [-1] rule matches worker traffic. But
   * a worker is shared across every tab on its origin whatever session each tab
   * belongs to, so ownership is only unambiguous while one session has tabs
   * there. Contested is reported rather than resolved, so the caller can
   * suppress instead of silently feeding one session's jar to another's pages.
   *
   * Keyed by origin. An earlier version keyed by registrable domain, which
   * over-suppressed badly on exactly the sites this exists for: a session on
   * `github.com` and another on `gist.github.com` are on two different workers,
   * and treating them as one contest disabled worker attribution for both.
   */
  serviceWorkerPolicy(url: string): ServiceWorkerPolicy {
    const target = originOf(url);
    const byRecency = new Map<SessionId, number>();

    if (target) {
      for (const b of this.bindings.values()) {
        if (originOf(b.url) !== target) continue;
        const seen = byRecency.get(b.sessionId) ?? 0;
        if (b.lastActive > seen) byRecency.set(b.sessionId, b.lastActive);
      }
    }

    if (byRecency.size === 0) {
      return { origin: target, owner: null, contested: false, suppressed: [] };
    }

    const ranked = [...byRecency.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const owner = ranked[0]![0];
    return {
      origin: target,
      owner,
      contested: ranked.length > 1,
      suppressed: ranked.slice(1).map(([id]) => id),
    };
  }

  /**
   * Hostnames this session's tabs are currently on.
   *
   * The compiler needs these, not just the hosts the jar already knows, or a
   * new session's first navigation has no rule and inherits the profile jar.
   */
  hostsFor(sessionId: SessionId): string[] {
    const out = new Set<string>();
    for (const b of this.bindings.values()) {
      if (b.sessionId !== sessionId) continue;
      const h = hostOf(b.url);
      if (h) out.add(h);
    }
    return [...out];
  }

  /**
   * Sessions holding cookies for a domain. This is what makes an identity
   * chooser possible: when more than one session can sign in somewhere, the
   * choice belongs to the user rather than to whichever jar happened to be
   * consulted first.
   */
  sessionsWithIdentityFor(domain: string): SessionId[] {
    const target = registrableDomain(domain);
    return this.listSessions()
      .filter((s) => s.store.forDomain(target).length > 0)
      .map((s) => s.id);
  }

  /**
   * Sessions a tab on this domain could belong to: one holding an identity
   * here, or one pinning the domain and holding nothing yet.
   *
   * The second half is what makes a second account reachable. A session created
   * to sign in as somebody else is empty by definition, so a chooser built only
   * from sessionsWithIdentityFor cannot offer it, and the user is left picking
   * the account they were trying to get away from.
   *
   * Identity-bearing sessions come first, since resuming is the more common
   * answer, but an empty pinned session is always in the list.
   */
  sessionsCovering(domain: string): SessionId[] {
    const target = registrableDomain(domain);
    // An ephemeral session is a holding pen, never an answer. Counting it makes
    // a site with one real session look ambiguous, and offering it would let
    // the user pick the pen as though it were an account.
    const real = (id: SessionId) => !this.sessions.get(id)?.ephemeral;
    const withIdentity = new Set(this.sessionsWithIdentityFor(target).filter(real));
    const claiming = this.listSessions().filter(
      (s) =>
        !s.ephemeral &&
        (s.pinned.some((p) => registrableDomain(p) === target) || s.family.includes(target))
    );
    const out = [...withIdentity];
    for (const s of claiming) {
      if (!withIdentity.has(s.id)) out.push(s.id);
    }
    return out;
  }

  /**
   * Records that this session has signed in somewhere, returning whether that
   * was news. The caller decides whether news is worth telling the user about.
   */
  noteFamily(sessionId: SessionId, urlOrDomain: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.ephemeral) return false;
    // Callers have a url in hand at the point this is known, so both are taken.
    // Passing a url to registrableDomain silently produces nonsense rather than
    // failing, which is the kind of thing that only shows up as a domain the
    // family never matches.
    const target = domainOf(urlOrDomain) || registrableDomain(urlOrDomain);
    if (!target) return false;
    if (session.family.includes(target)) return false;
    // A domain the user already named is not a discovery, and duplicating it
    // would show the same place twice in the panel.
    if (session.pinned.some((p) => registrableDomain(p) === target)) return false;
    session.family.push(target);
    return true;
  }

  /** Every domain currently occupied by a bound tab. */
  activeDomains(): string[] {
    const out = new Set<string>();
    for (const b of this.bindings.values()) {
      const d = domainOf(b.url);
      if (d) out.add(d);
    }
    return [...out];
  }

  /** Every origin currently occupied by a bound tab. */
  activeOrigins(): string[] {
    const out = new Set<string>();
    for (const b of this.bindings.values()) {
      const o = originOf(b.url);
      if (o) out.add(o);
    }
    return [...out];
  }

  /** Origins this session owns the worker for, in the shape the compiler wants. */
  serviceWorkerOriginsFor(sessionId: SessionId): string[] {
    return this.activeOrigins().filter((o) => {
      const p = this.serviceWorkerPolicy(o);
      return p.owner === sessionId && !p.contested;
    });
  }
}

/** The exact hostname, for host-scoped rules. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Scheme and host, which is the unit a service worker registration is scoped
 * to. The port is deliberately kept: `http://localhost:8787` and
 * `http://localhost:3000` are different origins and different workers, and the
 * fixture depends on that being true.
 */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    return '';
  }
}

export function domainOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return registrableDomain(u.hostname);
  } catch {
    return '';
  }
}
