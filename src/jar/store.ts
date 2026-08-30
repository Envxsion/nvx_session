/**
 * ------------------------------------------------------------------
 *  Title    |  Per-session cookie store
 *  Ref      |  cookie.ts, psl.ts, netfilter/compile.ts
 *  ID       |  M1 (cookie jar)
 * ------------------------------------------------------------------
 *  Purpose  |  Hold one session's cookies, indexed for rule
 *           |  compilation.
 *  Note     |  One per session. It never touches the browser jar; the
 *           |  netfilter layer reads it to build the Cookie header a
 *           |  managed tab actually sends.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

import {
  type Cookie,
  cookieKey,
  domainMatches,
  isExpired,
  pathMatches,
} from './cookie.js';
import { registrableDomain } from './psl.js';

/** Chrome's own ceilings, mirrored so behaviour under NVX matches without it. */
export const PER_DOMAIN_CAP = 180;
export const TOTAL_CAP = 3300;

export interface StoreSnapshot {
  version: 1;
  cookies: Cookie[];
}

export class CookieStore {
  private readonly byKey = new Map<string, Cookie>();
  /** Registrable domain to keys, so rule compilation can page by domain. */
  private readonly byDomain = new Map<string, Set<string>>();
  private dirtyDomains = new Set<string>();

  get size(): number {
    return this.byKey.size;
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  The registrable domains whose contents changed since
   *           |  the last call.
   *  Note     |  The netfilter flush is driven off this rather than
   *           |  recompiling everything on every Set-Cookie.
   * ------------------------------------------------------------------
   */
  takeDirty(): string[] {
    const out = [...this.dirtyDomains];
    this.dirtyDomains = new Set();
    return out;
  }

  markDirty(domain: string): void {
    this.dirtyDomains.add(registrableDomain(domain));
  }

  upsert(cookie: Cookie): void {
    const key = cookieKey(cookie);
    const existing = this.byKey.get(key);

    // RFC 6265 section 5.3 step 11: replacing a cookie keeps the original
    // creation time. Ordering depends on it, so losing it reorders headers.
    const next: Cookie = existing
      ? { ...cookie, created: existing.created }
      : cookie;

    if (next.expires !== null && next.expires <= next.lastAccess) {
      this.remove(key);
      return;
    }

    this.byKey.set(key, next);
    const reg = registrableDomain(next.domain);
    let set = this.byDomain.get(reg);
    if (!set) {
      set = new Set();
      this.byDomain.set(reg, set);
    }
    set.add(key);
    this.dirtyDomains.add(reg);

    this.enforceCaps(reg);
  }

  remove(key: string): boolean {
    const c = this.byKey.get(key);
    if (!c) return false;
    this.byKey.delete(key);
    const reg = registrableDomain(c.domain);
    const set = this.byDomain.get(reg);
    if (set) {
      set.delete(key);
      if (set.size === 0) this.byDomain.delete(reg);
    }
    this.dirtyDomains.add(reg);
    return true;
  }

  /** Drops expired cookies and reports which domains were affected. */
  sweep(now: number): string[] {
    const touched = new Set<string>();
    for (const [key, c] of this.byKey) {
      if (isExpired(c, now)) {
        touched.add(registrableDomain(c.domain));
        this.remove(key);
      }
    }
    return [...touched];
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Every cookie that domain- and path-matches, in RFC
   *           |  6265 order: longer paths first, then earlier created.
   *  Note     |  SameSite and Secure filtering is emission's job, not
   *           |  the store's.
   * ------------------------------------------------------------------
   */
  match(url: URL, now: number): Cookie[] {
    const host = url.hostname.toLowerCase();
    const path = url.pathname || '/';
    const out: Cookie[] = [];

    for (const c of this.byKey.values()) {
      if (isExpired(c, now)) continue;
      if (c.hostOnly ? host !== c.domain : !domainMatches(host, c.domain)) continue;
      if (!pathMatches(path, c.path)) continue;
      out.push(c);
    }

    out.sort((a, b) =>
      b.path.length - a.path.length || a.created - b.created || a.name.localeCompare(b.name)
    );
    return out;
  }

  forDomain(registrable: string): Cookie[] {
    const keys = this.byDomain.get(registrable);
    if (!keys) return [];
    const out: Cookie[] = [];
    for (const k of keys) {
      const c = this.byKey.get(k);
      if (c) out.push(c);
    }
    return out;
  }

  domains(): string[] {
    return [...this.byDomain.keys()];
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Distinct cookie domains under a registrable domain.
   *  Note     |  Rules compile per host: a host-only cookie on
   *           |  identity.example.com is not sent to example.com, so a
   *           |  rule built for the apex and applied to the subdomain
   *           |  would carry an empty header and strip the session.
   * ------------------------------------------------------------------
   */
  hostsFor(registrable: string): string[] {
    const keys = this.byDomain.get(registrable);
    if (!keys) return [];
    const hosts = new Set<string>();
    for (const k of keys) {
      const c = this.byKey.get(k);
      if (c) hosts.add(c.domain);
    }
    return [...hosts];
  }

  /** Every distinct cookie domain in the jar. */
  hosts(): string[] {
    const out = new Set<string>();
    for (const c of this.byKey.values()) out.add(c.domain);
    return [...out];
  }

  all(): Cookie[] {
    return [...this.byKey.values()];
  }

  clear(): void {
    for (const reg of this.byDomain.keys()) this.dirtyDomains.add(reg);
    this.byKey.clear();
    this.byDomain.clear();
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Evict caps by least recent access.
   *  Note     |  Expired entries go first, so a jar full of dead
   *           |  cookies never evicts a live one.
   * ------------------------------------------------------------------
   */
  private enforceCaps(registrable: string): void {
    const keys = this.byDomain.get(registrable);
    if (keys && keys.size > PER_DOMAIN_CAP) {
      this.evict([...keys], keys.size - PER_DOMAIN_CAP);
    }
    if (this.byKey.size > TOTAL_CAP) {
      this.evict([...this.byKey.keys()], this.byKey.size - TOTAL_CAP);
    }
  }

  private evict(candidates: string[], count: number): void {
    const now = Date.now();
    const ranked = candidates
      .map((k) => [k, this.byKey.get(k)] as const)
      .filter((e): e is readonly [string, Cookie] => Boolean(e[1]))
      .sort((a, b) => {
        const ae = isExpired(a[1], now) ? 0 : 1;
        const be = isExpired(b[1], now) ? 0 : 1;
        return ae - be || a[1].lastAccess - b[1].lastAccess;
      });
    for (let i = 0; i < count && i < ranked.length; i++) {
      this.remove(ranked[i]![0]);
    }
  }

  toSnapshot(): StoreSnapshot {
    return { version: 1, cookies: this.all() };
  }

  static fromSnapshot(snap: StoreSnapshot): CookieStore {
    const store = new CookieStore();
    for (const c of snap.cookies) store.upsert(c);
    store.takeDirty();
    return store;
  }
}
