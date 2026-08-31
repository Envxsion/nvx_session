/**
 * ------------------------------------------------------------------
 *  Title    |  Blocking webRequest backend
 *  Ref      |  netfilter/blocking.js, jar/store.js
 *  ID       |  test (blocking)
 * ------------------------------------------------------------------
 *  Purpose  |  Rewrites the Cookie header per request from the session
 *           |  jar, so the profile jar never reaches a managed tab.
 *  Note     |  Context rules must match the declarative backend, or the
 *           |  two disagree about the same request. See parity.test.ts.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BlockingNetfilter,
  rewriteHeaders,
  type BlockingApi,
  type HttpHeader,
  type RequestDetails,
} from '../src/netfilter/blocking.js';
import { parseSetCookie } from '../src/jar/cookie.js';
import { isPublicSuffix } from '../src/jar/psl.js';
import { CookieStore } from '../src/jar/store.js';

function jar(origin: string, ...headers: string[]): CookieStore {
  const store = new CookieStore();
  for (const h of headers) {
    const parsed = parseSetCookie(h, { url: new URL(origin) }, { isPublicSuffix });
    if (!parsed.ok) throw new Error(`fixture cookie rejected: ${parsed.reason}`);
    store.upsert(parsed.cookie);
  }
  return store;
}

function req(over: Partial<RequestDetails> = {}): RequestDetails {
  return {
    tabId: 1,
    url: 'https://example.com/page',
    type: 'xmlhttprequest',
    requestHeaders: [
      { name: 'Accept', value: '*/*' },
      { name: 'Cookie', value: 'profile_jar=LEAK' },
    ],
    ...over,
  };
}

const cookieOf = (headers: HttpHeader[]) =>
  headers.find((h) => h.name.toLowerCase() === 'cookie')?.value;

describe('rewriteHeaders', () => {
  const store = jar('https://example.com/', 'sid=WORK; Path=/');
  const owned = () => ({ id: 'work', store });

  it('replaces the browser cookie header with the session jar', () => {
    const out = rewriteHeaders(req(), owned)!;
    expect(cookieOf(out.headers)).toBe('sid=WORK');
    expect(out.sessionId).toBe('work');
  });

  it('leaves an unowned request exactly as the browser built it', () => {
    // Not the same as an owned request with an empty jar. Conflating the two is
    // how the profile jar reaches a managed tab.
    expect(rewriteHeaders(req(), () => null)).toBeNull();
  });

  it('removes the cookie header for an owned request with nothing to send', () => {
    const empty = { id: 'fresh', store: new CookieStore() };
    const out = rewriteHeaders(req(), () => empty)!;
    expect(cookieOf(out.headers)).toBeUndefined();
    expect(out.header).toBe('');
    // The rest of the request is untouched.
    expect(out.headers.map((h) => h.name)).toEqual(['Accept']);
  });

  it('never lets the profile jar survive', () => {
    for (const owner of [owned(), { id: 'fresh', store: new CookieStore() }]) {
      const out = rewriteHeaders(req(), () => owner)!;
      expect(cookieOf(out.headers) ?? '').not.toContain('profile_jar');
    }
  });

  it('keeps every other header', () => {
    const out = rewriteHeaders(
      req({
        requestHeaders: [
          { name: 'Accept', value: '*/*' },
          { name: 'Authorization', value: 'Bearer x' },
          { name: 'Cookie', value: 'profile_jar=LEAK' },
        ],
      }),
      owned
    )!;
    expect(out.headers.map((h) => h.name).sort()).toEqual(['Accept', 'Authorization', 'Cookie']);
  });

  it('strips a duplicated cookie header rather than adding a third', () => {
    const out = rewriteHeaders(
      req({
        requestHeaders: [
          { name: 'Cookie', value: 'a=1' },
          { name: 'cookie', value: 'b=2' },
        ],
      }),
      owned
    )!;
    expect(out.headers.filter((h) => h.name.toLowerCase() === 'cookie')).toHaveLength(1);
    expect(cookieOf(out.headers)).toBe('sid=WORK');
  });

  it('copes with a request that carried no headers at all', () => {
    const out = rewriteHeaders(req({ requestHeaders: undefined }), owned)!;
    expect(cookieOf(out.headers)).toBe('sid=WORK');
  });

  it('refuses a url it cannot parse rather than throwing', () => {
    expect(rewriteHeaders(req({ url: 'not a url' }), owned)).toBeNull();
  });

  // The context rules have to match the declarative backend's, or the two
  // backends disagree about the same request and only one of them is right.
  describe('SameSite, the same way the compiler does it', () => {
    const mixed = jar(
      'https://example.com/',
      'strict=S; Path=/; SameSite=Strict',
      'lax=L; Path=/; SameSite=Lax',
      'none=N; Path=/; SameSite=None; Secure'
    );
    const owner = () => ({ id: 'work', store: mixed });

    it('sends everything on a same-site subresource', () => {
      const out = rewriteHeaders(
        req({ initiator: 'https://example.com' }),
        owner
      )!;
      expect(out.header).toContain('strict=S');
      expect(out.header).toContain('lax=L');
      expect(out.header).toContain('none=N');
    });

    it('sends only None from a cross-site document', () => {
      const out = rewriteHeaders(req({ initiator: 'https://other.example' }), owner)!;
      expect(out.header).toBe('none=N');
    });

    it('treats a top level navigation as top level', () => {
      const out = rewriteHeaders(
        req({ type: 'main_frame', initiator: undefined }),
        owner
      )!;
      expect(out.header).toContain('lax=L');
    });

    it('honours strictOnTopLevel being turned off', () => {
      const out = rewriteHeaders(req({ type: 'main_frame' }), owner, {
        strictOnTopLevel: false,
      })!;
      expect(out.header).not.toContain('strict=S');
      expect(out.header).toContain('lax=L');
    });
  });

  it('respects path scoping', () => {
    const scoped = jar('https://example.com/', 'deep=D; Path=/admin', 'root=R; Path=/');
    const owner = () => ({ id: 'work', store: scoped });
    expect(rewriteHeaders(req({ url: 'https://example.com/' }), owner)!.header).toBe('root=R');
    expect(rewriteHeaders(req({ url: 'https://example.com/admin/x' }), owner)!.header).toContain(
      'deep=D'
    );
  });

  it('withholds a Secure cookie from an insecure origin', () => {
    const secure = jar('https://example.com/', 'sec=S; Path=/; Secure');
    const owner = () => ({ id: 'work', store: secure });
    expect(rewriteHeaders(req({ url: 'http://example.com/' }), owner)!.header).toBe('');
  });

  it('sends nothing for a host the session has no cookies on', () => {
    const out = rewriteHeaders(req({ url: 'https://elsewhere.test/' }), owned)!;
    expect(out.header).toBe('');
  });
});

describe('BlockingNetfilter', () => {
  function harness(resolve: Parameters<typeof rewriteHeaders>[1], opts = {}) {
    let installed: ((d: RequestDetails) => { requestHeaders?: HttpHeader[] } | undefined) | null =
      null;
    const api: BlockingApi = {
      addListener: (fn) => {
        installed = fn;
      },
      removeListener: () => {
        installed = null;
      },
    };
    const filter = new BlockingNetfilter(api, resolve, opts);
    return { filter, api, fire: (d: RequestDetails) => installed?.(d), get on() { return installed !== null; } };
  }

  it('rewrites through the installed listener', () => {
    const store = jar('https://example.com/', 'sid=WORK; Path=/');
    const h = harness(() => ({ id: 'work', store }));
    h.filter.install();
    expect(cookieOf(h.fire(req())!.requestHeaders!)).toBe('sid=WORK');
  });

  it('returns nothing for an unmanaged request, so the browser proceeds normally', () => {
    const h = harness(() => null);
    h.filter.install();
    expect(h.fire(req())).toBeUndefined();
  });

  it('installs once however many times it is asked', () => {
    const added = vi.fn();
    const store = new CookieStore();
    const api: BlockingApi = { addListener: added, removeListener: vi.fn() };
    const filter = new BlockingNetfilter(api, () => ({ id: 'x', store }));
    filter.install();
    filter.install();
    expect(added).toHaveBeenCalledTimes(1);
  });

  it('asks for the options the rewrite actually needs', () => {
    const added = vi.fn();
    const api: BlockingApi = { addListener: added, removeListener: vi.fn() };
    new BlockingNetfilter(api, () => null).install();
    const [, filter, extra] = added.mock.calls[0]!;
    expect(filter).toEqual({ urls: ['http://*/*', 'https://*/*'] });
    // Without extraHeaders the Cookie header is not even visible to modify.
    expect(extra).toEqual(['blocking', 'requestHeaders', 'extraHeaders']);
  });

  it('reports a throw rather than silently sending the profile jar', () => {
    const onError = vi.fn();
    const h = harness(() => {
      throw new Error('registry exploded');
    }, { onError });
    h.filter.install();
    expect(h.fire(req())).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('reports every rewrite so leak accounting still works', () => {
    const onRewrite = vi.fn();
    const store = jar('https://example.com/', 'sid=WORK; Path=/');
    const h = harness(() => ({ id: 'work', store }), { onRewrite });
    h.filter.install();
    h.fire(req());
    expect(onRewrite).toHaveBeenCalledOnce();
    expect(onRewrite.mock.calls[0]![0].header).toBe('sid=WORK');
  });

  it('stops touching requests once uninstalled', () => {
    const store = new CookieStore();
    const h = harness(() => ({ id: 'x', store }));
    h.filter.install();
    h.filter.uninstall();
    expect(h.on).toBe(false);
  });

  it('presents the flush engine surface as a no-op, because nothing is precompiled', async () => {
    const h = harness(() => null);
    h.filter.markDirty(['a', 'b']);
    expect(h.filter.pending).toBe(0);
    await expect(h.filter.flush()).resolves.toBeUndefined();
    await expect(h.filter.retire('a')).resolves.toBeUndefined();
  });
});
