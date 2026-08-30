/**
 * ------------------------------------------------------------------
 *  Title    |  Emitting a Cookie header for a request
 *  Ref      |  store.ts, cookie.ts, netfilter/compile.ts
 *  ID       |  M1 (cookie jar)
 * ------------------------------------------------------------------
 *  Purpose  |  Turn a jar into the Cookie header for a request
 *           |  context.
 *  How      |  Answers ahead of time, for each request shape a
 *           |  declarative rule can distinguish, since the rule is
 *           |  compiled before the request exists.
 *  Note     |  Getting the SameSite split wrong here is what logs you
 *           |  out.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

import { byteLength, isTrustworthy, type Cookie } from './cookie.js';
import type { CookieStore } from './store.js';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The request shapes a DNR condition can tell apart.
 *  Note     |  Each becomes one rule variant per (session, domain).
 * ------------------------------------------------------------------
 */
export type EmitContext =
  /** Subresource inside a same-site document. Everything is eligible. */
  | 'first-party'
  /** Subresource inside a cross-site document. SameSite=None only. */
  | 'third-party'
  /** Top level navigation. See the strictOnTopLevel note below. */
  | 'top-level';

export interface EmitOptions {
  /**
   * Whether SameSite=Strict cookies ride along on top level navigations.
   *
   * A declarative rule cannot see who initiated a navigation, so it cannot
   * distinguish a same-site link click or an address bar entry, where the
   * browser does send Strict, from a cross-site link click, where it does not.
   * The choice is therefore between occasionally sending Strict when the
   * browser would not, and never sending it on navigation at all.
   *
   * Default true, following the reliability first doctrine: the second option
   * logs you out when you type a URL, which is unacceptable, while the first
   * is a narrow deviation on cross-site entry. Exposed as a per-site policy
   * knob so a site that genuinely depends on Strict semantics can turn it off.
   */
  strictOnTopLevel?: boolean;
  /**
   * The request method, which decides whether a top level navigation may carry
   * SameSite=Lax at all.
   *
   * RFC 6265bis sends Lax on a cross-site top level navigation only when the
   * method is safe. A cross-site POST, which is exactly how a SAML assertion
   * comes back from an identity provider, must not carry them. Without this the
   * jar sends more than the browser would, and an SSO endpoint handed a session
   * cookie it was not expecting can bind its assertion to the wrong session.
   *
   * Absent means safe, because every caller that does not know the method is
   * compiling a rule for navigations in general, and treating those as GET is
   * both the common case and the lenient one.
   */
  method?: string;
  now?: number;
  /** Total header budget. Chrome drops oversized headers outright. */
  maxBytes?: number;
}

export const DEFAULT_MAX_HEADER_BYTES = 8192;

export interface EmitResult {
  header: string;
  included: Cookie[];
  /** Dropped because the header would have exceeded the budget. */
  truncated: Cookie[];
}

/** GET and HEAD, the only methods a cross-site navigation may carry Lax on. */
export function isSafeMethod(method?: string): boolean {
  if (!method) return true;
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Chrome's Lax-allowing-unsafe window.
 *  How      |  A defaulted-Lax cookie rides a cross-site top level
 *           |  POST for its first two minutes, so form POST single
 *           |  sign-on keeps working.
 *  Note     |  Measured: plain 6265bis here sent an assertion POST
 *           |  with no cookies, and Moodle answered invalidsesskey.
 * ------------------------------------------------------------------
 */
export const LAX_UNSAFE_WINDOW_MS = 2 * 60 * 1000;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Whether the carve-out applies to this cookie now.
 *  Note     |  Exported so the compiler knows a rule it built has an
 *           |  expiry date.
 * ------------------------------------------------------------------
 */
export function withinLaxUnsafeWindow(cookie: Cookie, now: number): boolean {
  return (
    cookie.sameSite === 'lax' &&
    cookie.sameSiteDefaulted &&
    now - cookie.created < LAX_UNSAFE_WINDOW_MS
  );
}

export function eligible(
  cookie: Cookie,
  url: URL,
  context: EmitContext,
  opts: EmitOptions = {}
): boolean {
  const now = opts.now ?? Date.now();
  if (cookie.expires !== null && cookie.expires <= now) return false;
  if (cookie.secure && !isTrustworthy(url)) return false;

  // Same-site requests are unaffected by the method: a form POST to your own
  // origin carries everything, and getting that wrong would break every login
  // form on a managed tab.
  const safe = isSafeMethod(opts.method);

  switch (cookie.sameSite) {
    case 'none':
      return true;
    case 'lax':
      if (context === 'first-party') return true;
      if (context !== 'top-level') return false;
      return safe || withinLaxUnsafeWindow(cookie, now);
    case 'strict':
      if (context === 'first-party') return true;
      if (context === 'top-level') return safe && opts.strictOnTopLevel !== false;
      return false;
  }
}

export function emit(
  store: CookieStore,
  url: URL,
  context: EmitContext,
  opts: EmitOptions = {}
): EmitResult {
  const now = opts.now ?? Date.now();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_HEADER_BYTES;

  const candidates = store
    .match(url, now)
    .filter((c) => eligible(c, url, context, { ...opts, now }));

  const included: Cookie[] = [];
  const truncated: Cookie[] = [];
  let used = 0;

  for (const c of candidates) {
    const piece = `${c.name}=${c.value}`;
    const cost = byteLength(piece) + (included.length ? 2 : 0);
    if (used + cost > maxBytes) {
      truncated.push(c);
      continue;
    }
    included.push(c);
    used += cost;
  }

  return {
    header: included.map((c) => `${c.name}=${c.value}`).join('; '),
    included,
    truncated,
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The three headers a (session, domain) pair needs, one
 *           |  per rule variant.
 *  Note     |  Returning them together keeps the compiler honest: it
 *           |  cannot emit a set covering only some contexts.
 * ------------------------------------------------------------------
 */
export function emitAll(
  store: CookieStore,
  url: URL,
  opts: EmitOptions = {}
): Record<EmitContext, EmitResult> {
  return {
    'first-party': emit(store, url, 'first-party', opts),
    'third-party': emit(store, url, 'third-party', opts),
    'top-level': emit(store, url, 'top-level', opts),
  };
}
