/**
 * SameSite and the request method.
 *
 * This is the rule the jar was missing, and it is the one that decides whether
 * a federated sign-in works. RFC 6265bis sends a SameSite=Lax cookie on a
 * cross-site top level navigation only when the method is safe. A SAML
 * assertion comes back from an identity provider as a cross-site POST, so a jar
 * that ignores the method hands that endpoint a session cookie the browser
 * itself would have withheld.
 *
 * Every check here passed trivially before the fix because nothing anywhere
 * told the jar what the method was.
 *
 * Then the rule met a real sign-in and turned out to be half of one. Chrome
 * carves out the first two minutes of a cookie that got Lax by default rather
 * than by request, and sends it on a cross-site top level POST anyway, for
 * exactly this traffic. Enforcing the specification without the carve-out sent
 * the assertion POST with no cookies at all and Moodle answered invalidsesskey.
 * Both halves are pinned below: the withholding, and the window that makes SSO
 * survive it.
 */

import { describe, expect, it } from 'vitest';
import { parseSetCookie } from '../src/jar/cookie.js';
import { isPublicSuffix } from '../src/jar/psl.js';
import { CookieStore } from '../src/jar/store.js';
import { emit, eligible, isSafeMethod, LAX_UNSAFE_WINDOW_MS } from '../src/jar/emit.js';
import { contextFor } from '../src/observer/capture.js';

const NOW = 1_700_000_000_000;
const SITE = new URL('https://learning.example.edu/auth/saml2/acs');

function cookie(header: string) {
  const r = parseSetCookie(header, { url: SITE, now: NOW }, { isPublicSuffix });
  if (!r.ok) throw new Error(r.reason);
  return r.cookie;
}

function store(...headers: string[]) {
  const s = new CookieStore();
  for (const h of headers) s.upsert(cookie(h));
  return s;
}

describe('safe methods', () => {
  it('are GET and HEAD, case insensitively', () => {
    expect(isSafeMethod('GET')).toBe(true);
    expect(isSafeMethod('head')).toBe(true);
    expect(isSafeMethod('POST')).toBe(false);
    expect(isSafeMethod('put')).toBe(false);
  });

  // Every caller that does not know the method is compiling a rule for
  // navigations in general, and treating those as GET is the lenient reading.
  it('default to safe when nothing said', () => {
    expect(isSafeMethod(undefined)).toBe(true);
    expect(isSafeMethod('')).toBe(true);
  });
});

describe('eligibility on a cross-site top level navigation', () => {
  const lax = cookie('MDL_SSP_SessID=abc; Path=/; Secure');
  const askedForLax = cookie('asked=1; Path=/; Secure; SameSite=Lax');
  const strict = cookie('locked=1; Path=/; Secure; SameSite=Strict');
  const none = cookie('open=1; Path=/; Secure; SameSite=None');
  const OLD = NOW + LAX_UNSAFE_WINDOW_MS + 1;

  it('sends Lax on a GET, which is a link click or a redirect', () => {
    expect(eligible(lax, SITE, 'top-level', { now: NOW, method: 'GET' })).toBe(true);
  });

  /**
   * The one that matters, and the one that took two goes to get right. A cookie
   * older than the window is withheld from a cross-site POST, which is what
   * stops an identity provider's assertion binding to a session the browser was
   * not using.
   */
  it('withholds an aged Lax cookie on a POST, which is how a SAML assertion arrives', () => {
    expect(eligible(lax, SITE, 'top-level', { now: OLD, method: 'POST' })).toBe(false);
  });

  /**
   * And the other half. A cookie that got Lax by default and was set moments
   * ago rides the POST, because Chrome does the same and single sign-on is
   * built on it. Without this the assertion arrives with an empty Cookie header
   * and the site cannot match the request it started.
   */
  it('sends a fresh defaulted-Lax cookie on a POST, as Chrome does', () => {
    expect(eligible(lax, SITE, 'top-level', { now: NOW, method: 'POST' })).toBe(true);
    expect(eligible(lax, SITE, 'top-level', { now: NOW + 119_000, method: 'POST' })).toBe(true);
    expect(eligible(lax, SITE, 'top-level', { now: NOW + 120_001, method: 'POST' })).toBe(false);
  });

  /**
   * The carve-out is for cookies that never asked. A site that wrote
   * SameSite=Lax deliberately gets exactly what it asked for, at any age.
   */
  it('does not extend the window to an explicit SameSite=Lax', () => {
    expect(askedForLax.sameSiteDefaulted).toBe(false);
    expect(lax.sameSiteDefaulted).toBe(true);
    expect(eligible(askedForLax, SITE, 'top-level', { now: NOW, method: 'POST' })).toBe(false);
  });

  it('withholds Strict on a POST even with the lenient top level policy', () => {
    expect(
      eligible(strict, SITE, 'top-level', { now: NOW, method: 'POST', strictOnTopLevel: true })
    ).toBe(false);
  });

  it('still sends SameSite=None on a POST, which is the point of None', () => {
    expect(eligible(none, SITE, 'top-level', { now: NOW, method: 'POST' })).toBe(true);
  });
});

describe('eligibility on a same-site request', () => {
  const lax = cookie('MoodleSession=abc; Path=/; Secure');
  const strict = cookie('locked=1; Path=/; Secure; SameSite=Strict');

  /**
   * A login form posting to its own origin is same-site, and dropping its
   * cookies would break every sign-in on a managed tab. The method must not
   * matter here at all.
   */
  it('sends everything on a POST to its own site', () => {
    expect(eligible(lax, SITE, 'first-party', { now: NOW, method: 'POST' })).toBe(true);
    expect(eligible(strict, SITE, 'first-party', { now: NOW, method: 'POST' })).toBe(true);
  });
});

describe('classifying a navigation', () => {
  const acs = 'https://learning.example.edu/auth/saml2/acs';

  it('calls a same-site navigation first party, whatever the method', () => {
    expect(
      contextFor({ type: 'main_frame', url: acs, initiator: 'https://learning.example.edu' })
    ).toBe('first-party');
    // A subdomain is still the same site.
    expect(contextFor({ type: 'main_frame', url: acs, initiator: 'https://sso.example.edu' })).toBe(
      'first-party'
    );
  });

  it('calls a cross-site navigation top level', () => {
    expect(contextFor({ type: 'main_frame', url: acs, initiator: 'https://idp.okta.com' })).toBe(
      'top-level'
    );
  });

  // Typed in the address bar or opened from a bookmark. The browser sends Lax
  // there, so the lenient reading is the correct one.
  it('treats a navigation with no initiator as top level', () => {
    expect(contextFor({ type: 'main_frame', url: acs })).toBe('top-level');
    expect(contextFor({ type: 'main_frame', url: acs, initiator: 'null' })).toBe('top-level');
  });

  it('leaves subresource classification alone', () => {
    expect(
      contextFor({ type: 'xmlhttprequest', url: acs, initiator: 'https://learning.example.edu' })
    ).toBe('first-party');
    expect(contextFor({ type: 'xmlhttprequest', url: acs, initiator: 'https://idp.okta.com' })).toBe(
      'third-party'
    );
  });
});

describe('what a SAML assertion actually carries', () => {
  const jar = store(
    'MoodleSession=SESSION_1; Path=/; Secure',
    'MDL_SSP_SessID=SSP_1; Path=/; Secure',
    'saml_state=S; Path=/; Secure; SameSite=None'
  );

  const AGED = NOW + LAX_UNSAFE_WINDOW_MS + 1;

  /**
   * The shape that broke the sign-in. Moodle stores its SAML request state in
   * MDL_SSP_SessID and the assertion comes back as a cross-site POST moments
   * later, so the state cookie has to survive the trip. It does, because it is
   * inside the window, and that is the whole reason the window exists.
   */
  it('carries the state the site set moments ago when the provider posts back', () => {
    const header = emit(jar, SITE, 'top-level', { now: NOW, method: 'POST' }).header;
    expect(header).toContain('saml_state=S');
    expect(header).toContain('MDL_SSP_SessID=SSP_1');
  });

  it('carries only SameSite=None once the state is no longer fresh', () => {
    const header = emit(jar, SITE, 'top-level', { now: AGED, method: 'POST' }).header;
    expect(header).toBe('saml_state=S');
  });

  it('carries the session cookies once the site navigates itself', () => {
    const header = emit(jar, SITE, 'first-party', { now: NOW, method: 'GET' }).header;
    expect(header).toContain('MoodleSession=SESSION_1');
    expect(header).toContain('MDL_SSP_SessID=SSP_1');
  });

  /**
   * The regression, stated as the failure it caused: without the method the jar
   * hands the SSO endpoint a session id it was not expecting, the assertion is
   * bound to the wrong session, and the site bounces you back to the identity
   * provider forever.
   */
  it('does not hand the endpoint an aged session id it did not expect', () => {
    const withoutMethod = emit(jar, SITE, 'top-level', { now: AGED }).header;
    const asPost = emit(jar, SITE, 'top-level', { now: AGED, method: 'POST' }).header;
    expect(withoutMethod).toContain('MDL_SSP_SessID');
    expect(asPost).not.toContain('MDL_SSP_SessID');
  });
});
