/**
 * Working out who a session actually is.
 *
 * Most modern auth cookies are JWTs, and we hold them, so the payload can be
 * read locally to label a session with the account it belongs to rather than
 * whatever the user typed. That turns the chooser from "session 1 or session 2"
 * into something you can actually pick from.
 *
 * Decode only. Signatures are never verified and nothing is trusted: this is a
 * display hint, not an authorisation decision, and it never leaves the machine.
 */

import type { Cookie } from '../jar/cookie.js';

/** Claims that carry a human-recognisable identity, best first. */
const CLAIMS = [
  'email',
  'preferred_username',
  'upn',
  'unique_name',
  'name',
  'login',
  'nickname',
  'sub',
];

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const pad = segment.length % 4 === 0 ? '' : '='.repeat(4 - (segment.length % 4));
    const json = atob(segment.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface Identity {
  label: string;
  claim: string;
  cookie: string;
  /** Epoch ms, when the token says so. Drives expiry warnings. */
  expires: number | null;
}

/**
 * A three-segment dot-separated value whose middle segment decodes to JSON is
 * a JWT for our purposes. Checking the shape rather than the algorithm avoids
 * an allowlist that would go stale.
 */
export function readJwt(value: string): { claims: Record<string, unknown>; exp: number | null } | null {
  const parts = value.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  const claims = decodeSegment(parts[1]);
  if (!claims) return null;
  const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  return { claims, exp };
}

export function identityFrom(cookies: Cookie[]): Identity | null {
  const found: Identity[] = [];

  for (const c of cookies) {
    const jwt = readJwt(c.value);
    if (!jwt) continue;
    for (const claim of CLAIMS) {
      const v = jwt.claims[claim];
      if (typeof v === 'string' && v.length > 0 && v.length < 128) {
        found.push({ label: v, claim, cookie: c.name, expires: jwt.exp });
        break;
      }
    }
  }

  if (!found.length) return null;
  // Prefer the most recognisable claim rather than whichever cookie happened
  // to come first.
  found.sort((a, b) => CLAIMS.indexOf(a.claim) - CLAIMS.indexOf(b.claim));
  return found[0]!;
}

export interface SessionIdentity extends Identity {
  domain: string;
}

/**
 * Who a whole session is, rather than who it is on one site.
 *
 * A session that has signed into six places holds six answers, and they may
 * genuinely differ: a work Google account and a personal GitHub can live in one
 * session quite legitimately. Pinned domains win, because those are the ones
 * the user said this session is for; after that the same claim ranking applies,
 * so an address beats a display name beats an opaque subject.
 */
export function identityAcross(
  byDomain: Iterable<readonly [string, Cookie[]]>,
  preferred: ReadonlySet<string> = new Set()
): SessionIdentity | null {
  const found: SessionIdentity[] = [];
  for (const [domain, cookies] of byDomain) {
    const identity = identityFrom(cookies);
    if (identity) found.push({ ...identity, domain });
  }
  if (!found.length) return null;

  found.sort((a, b) => {
    const pa = preferred.has(a.domain) ? 0 : 1;
    const pb = preferred.has(b.domain) ? 0 : 1;
    return (
      pa - pb ||
      CLAIMS.indexOf(a.claim) - CLAIMS.indexOf(b.claim) ||
      a.domain.localeCompare(b.domain)
    );
  });
  return found[0]!;
}

/**
 * The soonest expiry among a session's tokens, which is what the warming
 * scheduler should act on rather than a fixed interval.
 */
export function soonestExpiry(cookies: Cookie[], now = Date.now()): number | null {
  let soonest: number | null = null;
  for (const c of cookies) {
    const candidates = [c.expires, readJwt(c.value)?.exp ?? null];
    for (const t of candidates) {
      if (t === null || t <= now) continue;
      if (soonest === null || t < soonest) soonest = t;
    }
  }
  return soonest;
}
