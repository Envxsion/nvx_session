/**
 * Adopting what is already signed in.
 *
 * Setting this up by signing in again, everywhere, is the reason people abandon
 * session managers on the first evening. The profile jar already holds every
 * account the browser is carrying, and it is readable, so the first run can
 * offer those back as sessions rather than asking for them.
 *
 * Adoption copies. It never clears the profile jar, so an unmanaged tab keeps
 * working exactly as it did and a mistake costs nothing but a deleted session.
 */

import { byteLength, hasIllegalOctet, type Cookie, type SameSite } from '../jar/cookie.js';
import { isPublicSuffix, registrableDomain } from '../jar/psl.js';
import { RULES_PER_HOST, RULES_PER_SESSION } from '../netfilter/compile.js';
import { identityFrom, readJwt, type Identity } from './identity.js';

/** The subset of chrome.cookies.Cookie this depends on. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string | undefined;
  session?: boolean | undefined;
  expirationDate?: number | undefined;
  partitionKey?: unknown;
}

function sameSiteOf(raw: string | undefined, secure: boolean): SameSite {
  switch ((raw ?? '').toLowerCase()) {
    case 'strict':
      return 'strict';
    // The browser's wire name for SameSite=None.
    case 'no_restriction':
      return secure ? 'none' : 'lax';
    case 'lax':
      return 'lax';
    default:
      return 'lax';
  }
}

/**
 * The browser reports a domain-scoped cookie with a leading dot and a host-only
 * cookie without one, but also reports hostOnly directly. The flag is
 * authoritative; the dot is presentation.
 */
export function fromBrowserCookie(c: BrowserCookie, now = Date.now()): Cookie | null {
  const name = c.name?.trim();
  const domain = (c.domain ?? '').trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (!name || !domain) return null;

  const hostOnly = Boolean(c.hostOnly);
  // Only a domain-scoped cookie is checked, which is the same rule the parser
  // applies to an explicit Domain attribute. A host-only cookie on a public
  // suffix is ordinary: localhost is a public suffix, and so is every
  // single-label intranet name, and refusing those would mean never adopting a
  // development session.
  if (!hostOnly && isPublicSuffix(domain)) return null;

  // The same rejection the parser applies. These values are concatenated into a
  // Cookie header, and a jar that accepts what the parser refuses would make
  // adoption a way around the check rather than a shortcut past the sign-in.
  if (hasIllegalOctet(name) || hasIllegalOctet(c.value ?? '')) return null;

  const secure = Boolean(c.secure);
  const value = c.value ?? '';
  const path = c.path && c.path.startsWith('/') ? c.path : '/';

  // Every invariant parseSetCookie enforces, enforced again here.
  //
  // Adoption is the one way into the jar that does not come off the wire, so it
  // is the one way a cookie could arrive holding guarantees it does not meet: a
  // __Host- name that is not actually host-scoped, or a pair over the 4096 byte
  // ceiling. Chrome enforces these on its own writes, but another extension
  // calling chrome.cookies.set does not have to, and emission downstream trusts
  // the prefix to mean what it says.
  if (byteLength(`${name}=${value}`) > 4096) return null;
  if (name.startsWith('__Secure-') && !secure) return null;
  if (name.startsWith('__Host-') && (!secure || !hostOnly || path !== '/')) return null;

  const expires =
    c.session === true || c.expirationDate === undefined
      ? null
      : Math.round(c.expirationDate * 1000);
  if (expires !== null && expires <= now) return null;

  return {
    name,
    value,
    domain,
    hostOnly,
    path,
    secure,
    httpOnly: Boolean(c.httpOnly),
    sameSite: sameSiteOf(c.sameSite, secure),
    // The browser reports "unspecified" for a cookie that carried no SameSite,
    // so the distinction survives adoption too. Note that created is stamped as
    // now rather than the cookie's real birth, which the browser does not
    // expose, so an adopted cookie sits inside the Lax-unsafe window for its
    // first two minutes. That errs towards a sign-in working.
    sameSiteDefaulted: (c.sameSite ?? 'unspecified').toLowerCase() === 'unspecified',
    partitioned: false,
    expires,
    created: now,
    lastAccess: now,
  };
}

/**
 * Names that carry a session rather than a preference.
 *
 * This is a ranking hint for the list order, not a filter. Adoption always
 * copies every cookie on a chosen domain, because guessing which ones matter is
 * how you adopt a login that then fails on its first CSRF check.
 */
const AUTH_NAME = /sess|sid$|^sid|token|auth|login|logged|identity|account|credential|jwt|oauth|sso/i;
/** Names that look like auth but are set for everyone, signed in or not. */
const DECOY_NAME = /^(csrf|xsrf|_csrf|consent|cookieconsent|gdpr|locale|lang|theme|tz|timezone)/i;

export interface AdoptionCandidate {
  /** Registrable domain, which is the unit a user recognises as "a site". */
  domain: string;
  hosts: string[];
  cookies: Cookie[];
  identity: Identity | null;
  /** Higher means more likely to be a real signed-in account. */
  score: number;
  /** Whether a tab is open here right now. */
  open: boolean;
  /** The soonest expiry among the cookies that carry an identity. */
  expires: number | null;
}

export interface CandidateOptions {
  now?: number;
  /** Registrable domains with a tab open, which outrank everything else. */
  openDomains?: Iterable<string>;
}

export function candidatesFrom(
  browserCookies: BrowserCookie[],
  opts: CandidateOptions = {}
): AdoptionCandidate[] {
  const now = opts.now ?? Date.now();
  const open = new Set(opts.openDomains ?? []);
  const byDomain = new Map<string, Cookie[]>();

  for (const raw of browserCookies) {
    const cookie = fromBrowserCookie(raw, now);
    if (!cookie) continue;
    const domain = registrableDomain(cookie.domain);
    if (!domain) continue;
    const bucket = byDomain.get(domain);
    if (bucket) bucket.push(cookie);
    else byDomain.set(domain, [cookie]);
  }

  const out: AdoptionCandidate[] = [];
  for (const [domain, cookies] of byDomain) {
    const hosts = [...new Set(cookies.map((c) => c.domain))].sort();
    const identity = identityFrom(cookies);
    out.push({
      domain,
      hosts,
      cookies,
      identity,
      score: scoreDomain(cookies, identity, open.has(domain), now),
      open: open.has(domain),
      expires: identityExpiry(cookies, identity),
    });
  }

  // Open ranks, here and in the group sort, but it does not score. Where
  // somebody is looking is a good reason to show a thing first and no evidence
  // at all that they are signed into it. See scoreDomain.
  return out.sort(
    (a, b) =>
      b.score - a.score || Number(b.open) - Number(a.open) || a.domain.localeCompare(b.domain)
  );
}

/**
 * Below this, a session cookie is too short-lived to be a login.
 *
 * Every server framework hands an anonymous visitor a session cookie on their
 * first page, and from the outside it is indistinguishable from a real one:
 * same name, same httpOnly, same opacity. What does separate them is how long
 * it is meant to last. Being signed in is a thing a site intends to remember;
 * an anonymous session is scaffolding for the current visit and is issued for
 * minutes.
 *
 * Reported by the user before it was measured: a site they had only read a few
 * pages of was offered as an account, and the thing they noticed was that it
 * expired within the hour.
 */
const LOGIN_HORIZON_MS = 6 * 60 * 60 * 1000;

function scoreDomain(
  cookies: Cookie[],
  identity: Identity | null,
  open: boolean,
  now: number
): number {
  let score = 0;
  // A readable account name is the strongest evidence there is: it means a
  // token in this jar literally says who you are.
  if (identity) score += 6;

  /**
   * A tab being open is deliberately worth nothing here.
   *
   * It used to be worth three, which was enough on its own to carry a domain
   * with one anonymous session cookie over the line and label it as an account.
   * That is the wrong kind of evidence for the question: an open tab says where
   * somebody is looking, not who they are, and a site you have merely been
   * reading is exactly the case that has a tab open. It still ranks, in
   * `candidatesFrom` and in the group sort, which is where it belongs.
   */
  void open;

  let authNames = 0;
  let opaque = 0;
  let durable = 0;
  for (const c of cookies) {
    if (DECOY_NAME.test(c.name)) continue;
    const lasts = c.expires === null ? 0 : c.expires - now;
    if (AUTH_NAME.test(c.name)) authNames++;
    // An httpOnly cookie with a long opaque value and a real expiry is what a
    // server-side session looks like whatever it happens to be called.
    if (c.httpOnly && c.secure && c.value.length >= 24) opaque++;
    // And one the site intends to still honour tomorrow is what being signed in
    // looks like, as opposed to being in the middle of a visit.
    if (lasts >= LOGIN_HORIZON_MS && (AUTH_NAME.test(c.name) || c.httpOnly)) durable++;
    if (readJwt(c.value)) score += 1;
  }

  score += Math.min(authNames, 3) * 2;
  score += Math.min(opaque, 3);
  // Weighted like an auth name, because it is the same claim made about time:
  // a site that means to still honour this cookie next week has decided to
  // remember somebody, and remembering somebody is what being signed in is.
  score += Math.min(durable, 3) * 2;

  /**
   * One weak signal is not a login.
   *
   * A single auth-named cookie scores two on its own and one opaque httpOnly
   * value another, and together they used to clear the bar with an open tab's
   * three on top. But one cookie called `session`, opaque, httpOnly, expiring
   * within the hour and naming nobody, is the single most common thing in any
   * jar: it is what an anonymous visit leaves behind. Alone it is not evidence.
   *
   * Narrow on purpose. A second auth cookie, a second opaque value, anything
   * durable or any readable name lifts it straight back out, so this only ever
   * catches the case where there was exactly one thing to go on.
   */
  const thin = authNames <= 1 && opaque <= 1 && durable === 0;
  if (!identity && thin) score = Math.min(score, SIGNED_IN_SCORE - 1);
  return score;
}

/**
 * When the thing that identifies you stops being valid, or null when nothing
 * here identifies you.
 *
 * Guarded on the identity rather than reading any token in the jar. Plenty of
 * cookies are JWTs without being logins: a signed consent record, an anonymous
 * analytics token, a CSRF token some frameworks issue as one. Reading their
 * `exp` and presenting it as when your account expires attaches an alarming and
 * meaningless clock to a site you have never signed into, which is exactly what
 * was reported.
 */
function identityExpiry(cookies: Cookie[], identity: Identity | null): number | null {
  if (!identity) return null;
  let soonest: number | null = null;
  for (const c of cookies) {
    const jwt = readJwt(c.value);
    const t = jwt?.exp ?? null;
    if (t === null) continue;
    if (soonest === null || t < soonest) soonest = t;
  }
  return soonest;
}

/** Above this a candidate is offered as a signed-in account rather than a site. */
export const SIGNED_IN_SCORE = 5;

export function looksSignedIn(c: AdoptionCandidate): boolean {
  return c.score >= SIGNED_IN_SCORE;
}

/**
 * A name for the session this candidate would become. The account the token
 * names beats the domain, because "you@monash.edu" is the thing being chosen
 * between and "monash.edu" is not.
 */
export function proposedLabel(c: AdoptionCandidate): string {
  if (c.identity) return c.identity.label;
  return c.domain;
}

/**
 * Rules a selection would compile to.
 *
 * Four per host and four per registrable domain fallback, plus the catch-all.
 * Four rather than three because a top level navigation compiles to two rules,
 * split on whether the method is safe. Selecting half a profile would silently
 * overflow the per-session budget and drop hosts, so the count is surfaced
 * before the session is created rather than reported as a warning afterwards.
 *
 * This has to track the compiler exactly. An estimate that runs low is worse
 * than no estimate: it tells the user their selection fits and then drops the
 * hosts that did not.
 */
export function estimateRules(candidates: AdoptionCandidate[]): number {
  const hosts = new Set<string>();
  const domains = new Set<string>();
  for (const c of candidates) {
    domains.add(c.domain);
    for (const h of c.hosts) hosts.add(h);
  }
  return hosts.size * RULES_PER_HOST + domains.size * RULES_PER_HOST + 1;
}

export function fitsBudget(candidates: AdoptionCandidate[]): boolean {
  return estimateRules(candidates) <= RULES_PER_SESSION;
}

/**
 * One account, however many sites it signs into.
 *
 * The candidate list is per registrable domain, because that is the unit the
 * jar and the rule compiler work in. It is not the unit a person thinks in. A
 * profile signed into one university account holds cookies for the portal, the
 * identity provider and the learning system, and offering those as three
 * sessions asks the user to know which three things are the same thing, which is
 * exactly the knowledge this feature exists to save them.
 *
 * So candidates whose readable identity is the same string become one proposal.
 * The identity comes from a token in the jar that literally says who you are, so
 * two domains sharing one is close to proof rather than a heuristic: it means
 * the same account name is signed in at both.
 *
 * Everything else stays on its own. Grouping by anything weaker, shared parent
 * domain or proximity in time, would silently merge two accounts into one
 * session, and a session holding two accounts is the failure this whole product
 * is about. When in doubt the answer is more proposals, not fewer: splitting one
 * account across two sessions is an inconvenience the user can fix in the panel,
 * and merging two accounts into one is a sign-in as the wrong person.
 */
export interface AdoptionGroup {
  /** Stable across a rescan, so a selection can be remembered. */
  key: string;
  label: string;
  members: AdoptionCandidate[];
  /** The best evidence any member has. */
  score: number;
  /** True when any member looks like a real signed-in account. */
  signedIn: boolean;
  /** True when any member has a tab open right now. */
  open: boolean;
  /** Whether this group's domains fit inside one session's rule budget. */
  fits: boolean;
  /** The soonest identity expiry among the members, when any is known. */
  expires: number | null;
}

export function groupCandidates(candidates: AdoptionCandidate[]): AdoptionGroup[] {
  const byIdentity = new Map<string, AdoptionCandidate[]>();
  const alone: AdoptionCandidate[] = [];

  for (const c of candidates) {
    const label = c.identity?.label?.trim();
    // An identity that is just the domain back again is not evidence of
    // anything: it would merge every site that happens to name itself.
    if (label && label.toLowerCase() !== c.domain.toLowerCase()) {
      const bucket = byIdentity.get(label);
      if (bucket) bucket.push(c);
      else byIdentity.set(label, [c]);
    } else {
      alone.push(c);
    }
  }

  const groups: AdoptionGroup[] = [];
  const make = (label: string, members: AdoptionCandidate[]): AdoptionGroup => {
    const expiries = members.map((m) => m.expires).filter((e): e is number => e !== null);
    return {
      key: members
        .map((m) => m.domain)
        .sort()
        .join(','),
      label,
      members,
      score: Math.max(...members.map((m) => m.score)),
      signedIn: members.some(looksSignedIn),
      open: members.some((m) => m.open),
      fits: fitsBudget(members),
      expires: expiries.length ? Math.min(...expiries) : null,
    };
  };

  for (const [label, members] of byIdentity) groups.push(make(label, members));
  for (const c of alone) groups.push(make(proposedLabel(c), [c]));

  /**
   * Open tabs first, then score.
   *
   * The other way round for a long time, which put whatever the jar considered
   * most account-shaped at the top of a list of three hundred. On a used profile
   * that is very often something signed into years ago and forgotten. What
   * somebody wants to see on the first screen is the thing they have open, so
   * that is what is at the top; score still decides everything within each half.
   */
  return groups.sort(
    (a, b) =>
      Number(b.open) - Number(a.open) ||
      b.score - a.score ||
      a.label.localeCompare(b.label)
  );
}

/**
 * What to tick before the user has touched anything.
 *
 * Only what looks like a signed-in account, and only what fits. A first run that
 * pre-selects a hundred sites is a first run where the button nobody read
 * creates a session holding the whole profile, and the estimate would be over
 * budget anyway.
 *
 * Capped, because a heavy profile can hold thirty of these and thirty sessions
 * on the first screen is not a setup, it is a mess somebody has to undo.
 */
export const PRESELECT_CAP = 8;

/**
 * What is ticked before the user has touched anything.
 *
 * Accounts with a tab open first, and that ordering is the whole point rather
 * than a refinement. The screen was built around the jar, which holds every
 * domain this browser has ever been given a cookie by, and offered the most
 * account-shaped of them. But somebody installing this has fifty tabs open and
 * a reason they wanted it, and that reason is sitting in those tabs: the
 * question in their head is "sort out what I am looking at", not "audit my
 * cookie jar". An account you have open right now is one you can recognise, and
 * one where the result of adopting it is visible immediately.
 *
 * Signed in and fitting are still required. An open tab is a reason to rank
 * something first, never on its own a reason to believe there is an account
 * there, which is the distinction `scoreDomain` exists to keep.
 */
export function preselected(groups: AdoptionGroup[]): AdoptionGroup[] {
  const eligible = groups.filter((g) => g.signedIn && g.fits);
  return [...eligible.filter((g) => g.open), ...eligible.filter((g) => !g.open)].slice(
    0,
    PRESELECT_CAP
  );
}
