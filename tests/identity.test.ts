/**
 * ------------------------------------------------------------------
 *  Title    |  Identity extraction
 *  Ref      |  kernel/identity.ts
 *  ID       |  test (identity)
 * ------------------------------------------------------------------
 *  Purpose  |  readJwt decodes a token, identityFrom reads the
 *           |  signed-in user from a jar, and soonestExpiry says when
 *           |  that identity lapses.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */
import { describe, expect, it } from 'vitest';
import { identityFrom, readJwt, soonestExpiry } from '../src/kernel/identity.js';
import { parseSetCookie, type Cookie } from '../src/jar/cookie.js';
import { isPublicSuffix } from '../src/jar/psl.js';

const NOW = 1_700_000_000_000;

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.signature`;
}

function cookie(name: string, value: string): Cookie {
  const r = parseSetCookie(`${name}=${value}`, { url: new URL('https://identity.monash.edu/'), now: NOW }, { isPublicSuffix, now: NOW });
  if (!r.ok) throw new Error(`fixture rejected: ${r.reason}`);
  return r.cookie;
}

describe('readJwt', () => {
  it('decodes a base64url payload with no padding', () => {
    const r = readJwt(jwt({ email: 'a@monash.edu', exp: 1800000000 }));
    expect(r?.claims.email).toBe('a@monash.edu');
    expect(r?.exp).toBe(1800000000 * 1000);
  });

  it('returns null for anything that is not a three-part token', () => {
    for (const v of ['', 'plain', 'a.b', 'a.b.c.d', 'a.!!!.c']) {
      expect(readJwt(v), v).toBeNull();
    }
  });

  it('returns null when the payload is not an object', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(readJwt(`x.${b64('a string')}.y`)).toBeNull();
  });

  it('tolerates a token with no exp', () => {
    expect(readJwt(jwt({ sub: 'abc' }))?.exp).toBeNull();
  });
});

describe('identityFrom', () => {
  it('prefers the most recognisable claim over whichever cookie came first', () => {
    const found = identityFrom([
      cookie('a', jwt({ sub: 'opaque-guid-0001' })),
      cookie('b', jwt({ email: 'ojas@monash.edu' })),
    ]);
    expect(found?.label).toBe('ojas@monash.edu');
    expect(found?.claim).toBe('email');
  });

  it('falls back to sub when nothing friendlier exists', () => {
    expect(identityFrom([cookie('a', jwt({ sub: 'u-1' }))])?.label).toBe('u-1');
  });

  it('reads the Okta style upn claim', () => {
    expect(identityFrom([cookie('okta', jwt({ upn: 'student@monash.edu' }))])?.label).toBe(
      'student@monash.edu'
    );
  });

  it('ignores cookies that are not tokens', () => {
    expect(identityFrom([cookie('plain', 'justavalue')])).toBeNull();
    expect(identityFrom([])).toBeNull();
  });

  it('rejects an absurdly long claim rather than rendering it', () => {
    expect(identityFrom([cookie('a', jwt({ email: 'x'.repeat(500) }))])).toBeNull();
  });
});

describe('soonestExpiry', () => {
  it('takes the earliest of cookie expiry and token expiry', () => {
    const c1 = { ...cookie('a', jwt({ exp: Math.floor((NOW + 60_000) / 1000) })), expires: NOW + 900_000 };
    const c2 = { ...cookie('b', 'plain'), expires: NOW + 300_000 };
    expect(soonestExpiry([c1, c2], NOW)).toBe(Math.floor((NOW + 60_000) / 1000) * 1000);
  });

  it('ignores anything already expired', () => {
    const c = { ...cookie('a', 'plain'), expires: NOW - 1000 };
    expect(soonestExpiry([c], NOW)).toBeNull();
  });

  it('returns null for a jar of session cookies', () => {
    expect(soonestExpiry([cookie('a', 'plain')], NOW)).toBeNull();
  });
});
