/**
 * ------------------------------------------------------------------
 *  Title    |  Cookie jar
 *  Ref      |  jar/cookie.ts, jar/psl.ts, jar/store.ts, jar/emit.ts
 *  ID       |  test (cookie jar)
 * ------------------------------------------------------------------
 *  Purpose  |  Parsing Set-Cookie, domain and path matching, the
 *           |  per-domain capped store, and the Cookie header emit.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */
import { describe, expect, it } from 'vitest';
import {
  defaultPath,
  domainMatches,
  parseSetCookie,
  pathMatches,
  type Cookie,
} from '../src/jar/cookie.js';
import { isPublicSuffix, registrableDomain } from '../src/jar/psl.js';
import { CookieStore, PER_DOMAIN_CAP } from '../src/jar/store.js';
import { emit, emitAll } from '../src/jar/emit.js';

const NOW = 1_700_000_000_000;
const opts = { isPublicSuffix, now: NOW };

const at = (u: string) => ({ url: new URL(u), now: NOW });

function parse(header: string, url = 'https://vercel.com/dashboard') {
  return parseSetCookie(header, at(url), opts);
}

function must(header: string, url?: string): Cookie {
  const r = parse(header, url);
  if (!r.ok) throw new Error(`expected parse to succeed, got ${r.reason} ${r.detail ?? ''}`);
  return r.cookie;
}

describe('parseSetCookie', () => {
  it('parses a bare pair and applies defaults', () => {
    const c = must('sid=abc123');
    expect(c).toMatchObject({
      name: 'sid',
      value: 'abc123',
      domain: 'vercel.com',
      hostOnly: true,
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'lax',
      expires: null,
    });
  });

  it('defaults path to the directory of the request, not the full path', () => {
    expect(must('a=1', 'https://vercel.com/teams/acme/settings').path).toBe('/teams/acme');
    expect(must('a=1', 'https://vercel.com/dashboard').path).toBe('/');
    expect(must('a=1', 'https://vercel.com/').path).toBe('/');
  });

  it('strips a leading dot from Domain and clears hostOnly', () => {
    const c = must('a=1; Domain=.vercel.com');
    expect(c.domain).toBe('vercel.com');
    expect(c.hostOnly).toBe(false);
  });

  it('rejects a Domain the request host does not match', () => {
    const r = parse('a=1; Domain=github.com');
    expect(r).toMatchObject({ ok: false, reason: 'domain-mismatch' });
  });

  it('rejects a Domain that is a public suffix', () => {
    expect(parseSetCookie('a=1; Domain=co.uk', at('https://shop.co.uk/'), opts)).toMatchObject({
      ok: false,
      reason: 'public-suffix',
    });
  });

  it('treats platform hosts as public suffixes so neighbours cannot collide', () => {
    expect(
      parseSetCookie('a=1; Domain=vercel.app', at('https://mine.vercel.app/'), opts)
    ).toMatchObject({ ok: false, reason: 'public-suffix' });
  });

  it('discards a header with no name', () => {
    expect(parse('novalue')).toMatchObject({ ok: false, reason: 'no-name' });
    expect(parse('=orphan')).toMatchObject({ ok: false, reason: 'no-name' });
  });

  it('honours Max-Age over Expires and treats non-positive as immediate', () => {
    expect(must('a=1; Max-Age=60').expires).toBe(NOW + 60_000);
    expect(
      must('a=1; Max-Age=60; Expires=Wed, 21 Oct 2099 07:28:00 GMT').expires
    ).toBe(NOW + 60_000);
    expect(must('a=1; Max-Age=0').expires).toBe(0);
    expect(must('a=1; Max-Age=-1').expires).toBe(0);
  });

  it('parses Expires when Max-Age is absent', () => {
    expect(must('a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT').expires).toBe(
      Date.parse('Wed, 21 Oct 2099 07:28:00 GMT')
    );
  });

  it('requires Secure for SameSite=None, as Chrome does', () => {
    expect(parse('a=1; SameSite=None')).toMatchObject({
      ok: false,
      reason: 'none-requires-secure',
    });
    expect(must('a=1; SameSite=None; Secure').sameSite).toBe('none');
  });

  it('defaults an unrecognised SameSite to lax', () => {
    expect(must('a=1; SameSite=banana').sameSite).toBe('lax');
    expect(must('a=1').sameSite).toBe('lax');
  });

  it('enforces the __Secure- prefix', () => {
    expect(parse('__Secure-a=1')).toMatchObject({ ok: false, reason: 'secure-prefix' });
    expect(must('__Secure-a=1; Secure').name).toBe('__Secure-a');
  });

  it('enforces every __Host- condition', () => {
    expect(parse('__Host-a=1')).toMatchObject({ ok: false, reason: 'host-prefix' });
    expect(parse('__Host-a=1; Secure; Domain=vercel.com; Path=/')).toMatchObject({
      ok: false,
      reason: 'host-prefix',
    });
    expect(
      parseSetCookie('__Host-a=1; Secure; Path=/sub', at('https://vercel.com/sub/x'), opts)
    ).toMatchObject({ ok: false, reason: 'host-prefix' });
    expect(must('__Host-a=1; Secure; Path=/').name).toBe('__Host-a');
  });

  it('allows Secure cookies on http localhost, as browsers do', () => {
    const r = parseSetCookie('__Secure-a=1; Secure', at('http://localhost:8787/'), opts);
    expect(r.ok).toBe(true);
  });

  it('rejects an oversized pair', () => {
    expect(parse(`a=${'x'.repeat(4200)}`)).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('unquotes a quoted value', () => {
    expect(must('a="hello"').value).toBe('hello');
  });
});

describe('matching primitives', () => {
  it('path-matches on segment boundaries only', () => {
    expect(pathMatches('/docs/api', '/docs')).toBe(true);
    expect(pathMatches('/docs', '/docs')).toBe(true);
    expect(pathMatches('/docsearch', '/docs')).toBe(false);
    expect(pathMatches('/docs/api', '/docs/')).toBe(true);
    expect(pathMatches('/', '/')).toBe(true);
  });

  it('domain-matches subdomains but never an IP', () => {
    expect(domainMatches('api.vercel.com', 'vercel.com')).toBe(true);
    expect(domainMatches('vercel.com', 'vercel.com')).toBe(true);
    expect(domainMatches('notvercel.com', 'vercel.com')).toBe(false);
    expect(domainMatches('127.0.0.1', '0.0.1')).toBe(false);
  });

  it('computes default paths', () => {
    expect(defaultPath(new URL('https://x.com/a/b/c'))).toBe('/a/b');
    expect(defaultPath(new URL('https://x.com/a'))).toBe('/');
  });

  it('finds registrable domains', () => {
    expect(registrableDomain('api.vercel.com')).toBe('vercel.com');
    expect(registrableDomain('shop.co.uk')).toBe('shop.co.uk');
    expect(registrableDomain('a.b.shop.co.uk')).toBe('shop.co.uk');
    expect(registrableDomain('localhost')).toBe('localhost');

    // An address has no registrable domain and compares as itself. The last two
    // labels of a dotted quad give "0.1", which groups unrelated addresses
    // together and matches nothing a rule was built for.
    expect(registrableDomain('127.0.0.1')).toBe('127.0.0.1');
    expect(registrableDomain('192.168.0.1')).toBe('192.168.0.1');
    expect(registrableDomain('[::1]')).toBe('[::1]');
    // Not an address: out of range, and a legal hostname made of digits.
    expect(registrableDomain('999.1.1.1')).toBe('1.1');
    expect(registrableDomain('1234.5678.com')).toBe('5678.com');
  });
});

describe('CookieStore', () => {
  const store = () => new CookieStore();

  it('replaces by name, domain and path, keeping the original creation time', () => {
    const s = store();
    s.upsert(must('sid=one'));
    const first = s.all()[0]!;
    s.upsert({ ...must('sid=two'), created: NOW + 5000 });
    expect(s.size).toBe(1);
    expect(s.all()[0]!.value).toBe('two');
    expect(s.all()[0]!.created).toBe(first.created);
  });

  it('treats a different path as a different cookie', () => {
    const s = store();
    s.upsert(must('sid=root', 'https://vercel.com/'));
    s.upsert(must('sid=deep', 'https://vercel.com/teams/x'));
    expect(s.size).toBe(2);
  });

  it('orders matches by longer path first, then creation time', () => {
    const s = store();
    s.upsert({ ...must('a=root', 'https://vercel.com/'), created: NOW });
    s.upsert({ ...must('b=deep', 'https://vercel.com/teams/x'), created: NOW + 10 });
    s.upsert({ ...must('c=root2', 'https://vercel.com/'), created: NOW + 20 });
    const names = s.match(new URL('https://vercel.com/teams/page'), NOW).map((c) => c.name);
    expect(names).toEqual(['b', 'a', 'c']);
  });

  it('does not match a host-only cookie against a subdomain', () => {
    const s = store();
    s.upsert(must('a=1'));
    expect(s.match(new URL('https://api.vercel.com/'), NOW)).toHaveLength(0);
    s.upsert(must('b=1; Domain=vercel.com'));
    expect(s.match(new URL('https://api.vercel.com/'), NOW).map((c) => c.name)).toEqual(['b']);
  });

  it('sweeps expired cookies and reports the domains touched', () => {
    const s = store();
    s.upsert(must('gone=1; Max-Age=10'));
    s.upsert(must('stays=1'));
    expect(s.sweep(NOW + 20_000)).toEqual(['vercel.com']);
    expect(s.all().map((c) => c.name)).toEqual(['stays']);
  });

  it('drops an already-expired cookie on upsert rather than storing it', () => {
    const s = store();
    s.upsert(must('sid=1'));
    s.upsert(must('sid=1; Max-Age=0'));
    expect(s.size).toBe(0);
  });

  it('enforces the per-domain cap by least recent access', () => {
    const s = store();
    for (let i = 0; i < PER_DOMAIN_CAP + 20; i++) {
      s.upsert({ ...must(`c${i}=1`), lastAccess: NOW + i });
    }
    expect(s.size).toBe(PER_DOMAIN_CAP);
    const names = new Set(s.all().map((c) => c.name));
    expect(names.has('c0')).toBe(false);
    expect(names.has(`c${PER_DOMAIN_CAP + 19}`)).toBe(true);
  });

  it('tracks dirty domains and clears them when taken', () => {
    const s = store();
    s.upsert(must('a=1'));
    expect(s.takeDirty()).toEqual(['vercel.com']);
    expect(s.takeDirty()).toEqual([]);
  });

  it('round-trips through a snapshot', () => {
    const s = store();
    s.upsert(must('a=1'));
    s.upsert(must('b=2; Domain=vercel.com; Secure; SameSite=None'));
    const back = CookieStore.fromSnapshot(s.toSnapshot());
    expect(back.all().map((c) => c.name).sort()).toEqual(['a', 'b']);
    expect(back.takeDirty()).toEqual([]);
  });
});

describe('emit', () => {
  const url = new URL('https://vercel.com/dashboard');

  function seeded() {
    const s = new CookieStore();
    s.upsert(must('strict=s; SameSite=Strict'));
    s.upsert(must('lax=l; SameSite=Lax'));
    s.upsert(must('none=n; SameSite=None; Secure'));
    return s;
  }

  it('sends everything in a first-party context', () => {
    const r = emit(seeded(), url, 'first-party', { now: NOW });
    expect(r.included.map((c) => c.name).sort()).toEqual(['lax', 'none', 'strict']);
  });

  it('sends only SameSite=None in a third-party context', () => {
    const r = emit(seeded(), url, 'third-party', { now: NOW });
    expect(r.included.map((c) => c.name)).toEqual(['none']);
  });

  it('includes Strict on top-level navigation by default', () => {
    const r = emit(seeded(), url, 'top-level', { now: NOW });
    expect(r.included.map((c) => c.name).sort()).toEqual(['lax', 'none', 'strict']);
  });

  it('drops Strict on top-level navigation when the policy knob is off', () => {
    const r = emit(seeded(), url, 'top-level', { now: NOW, strictOnTopLevel: false });
    expect(r.included.map((c) => c.name).sort()).toEqual(['lax', 'none']);
  });

  it('withholds Secure cookies from an insecure origin', () => {
    const s = new CookieStore();
    s.upsert(
      must('sec=1; Secure', 'https://example.com/')
    );
    const r = emit(s, new URL('http://example.com/'), 'first-party', { now: NOW });
    expect(r.included).toHaveLength(0);
  });

  it('builds a header in match order', () => {
    const s = new CookieStore();
    s.upsert({ ...must('a=1', 'https://vercel.com/'), created: NOW });
    s.upsert({ ...must('b=2', 'https://vercel.com/teams/x'), created: NOW + 1 });
    const r = emit(s, new URL('https://vercel.com/teams/x/y'), 'first-party', { now: NOW });
    expect(r.header).toBe('b=2; a=1');
  });

  it('truncates rather than emitting an oversized header', () => {
    const s = new CookieStore();
    s.upsert(must(`big=${'x'.repeat(3000)}`));
    s.upsert(must(`big2=${'y'.repeat(3000)}`));
    s.upsert(must('small=1'));
    const r = emit(s, url, 'first-party', { now: NOW, maxBytes: 4000 });
    expect(r.included.length).toBeGreaterThan(0);
    expect(r.truncated.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(r.header)).toBeLessThanOrEqual(4000);
  });

  it('emitAll covers every context the rule compiler needs', () => {
    const all = emitAll(seeded(), url, { now: NOW });
    expect(Object.keys(all).sort()).toEqual(['first-party', 'third-party', 'top-level']);
    expect(all['third-party'].header).toBe('none=n');
  });

  it('omits expired cookies', () => {
    const s = new CookieStore();
    s.upsert(must('gone=1; Max-Age=10'));
    const r = emit(s, url, 'first-party', { now: NOW + 20_000 });
    expect(r.included).toHaveLength(0);
  });
});
