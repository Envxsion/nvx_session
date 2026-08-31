/**
 * ------------------------------------------------------------------
 *  Title    |  The two backends must agree
 *  Ref      |  netfilter/compile.ts, netfilter/blocking.ts
 *  ID       |  test (backend parity)
 * ------------------------------------------------------------------
 *  Purpose  |  Declarative rules on Chrome and the blocking listener on
 *           |  Opera MV2 compute the Cookie header by different routes;
 *           |  they must never disagree, or one account behaves two ways.
 *  Note     |  Compiles a session, works out the rule the browser would
 *           |  match, and asserts blocking produces exactly that header.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';
import { compileHost } from '../src/netfilter/compile.js';
import type { Rule, SessionView } from '../src/netfilter/types.js';
import { rewriteHeaders, type RequestDetails } from '../src/netfilter/blocking.js';
import { parseSetCookie } from '../src/jar/cookie.js';
import { isPublicSuffix } from '../src/jar/psl.js';
import { CookieStore } from '../src/jar/store.js';

const NOW = 1_700_000_000_000;

function jar(origin: string, ...headers: string[]): CookieStore {
  const store = new CookieStore();
  for (const h of headers) {
    const parsed = parseSetCookie(h, { url: new URL(origin), now: NOW }, { isPublicSuffix, now: NOW });
    if (!parsed.ok) throw new Error(`fixture cookie rejected: ${parsed.reason} (${h})`);
    store.upsert(parsed.cookie);
  }
  return store;
}

function view(store: CookieStore, host: string): SessionView {
  return {
    id: 'work',
    tabIds: [1],
    serviceWorkerOrigins: [],
    activeHosts: [host],
    store,
  };
}

type Variant = 'first-party' | 'third-party' | 'top-level';

/** Recovers which context a compiled rule was emitted for. */
function variantOf(rule: Rule): Variant {
  if (rule.condition.resourceTypes?.includes('main_frame')) return 'top-level';
  return rule.condition.domainType === 'thirdParty' ? 'third-party' : 'first-party';
}

/** The path a compiled rule is scoped to, mirroring conditionFor. */
function pathOf(rule: Rule, host: string): string {
  const filter = rule.condition.urlFilter ?? '';
  const scoped = filter.match(new RegExp(`^\\|\\|${host.replace(/\./g, '\\.')}(/.*)$`));
  return scoped ? scoped[1]! : '/';
}

/** The header the browser would install for this request, per the compiler. */
function declarativeHeader(rules: Rule[], host: string, path: string, variant: Variant): string {
  const matching = rules.filter((r) => variantOf(r) === variant && pathOf(r, host) === path);
  expect(matching, `no compiled rule for ${variant} at ${path}`).not.toHaveLength(0);
  const action = matching[0]!.action.requestHeaders![0]!;
  return action.operation === 'set' ? (action.value ?? '') : '';
}

/** The header the blocking backend computes for the equivalent live request. */
function blockingHeader(
  store: CookieStore,
  url: string,
  variant: Variant,
  initiatorHost: string
): string {
  const details: RequestDetails = {
    tabId: 1,
    url,
    type: variant === 'top-level' ? 'main_frame' : 'xmlhttprequest',
    ...(variant === 'top-level'
      ? {}
      : {
          initiator:
            variant === 'first-party' ? `https://${initiatorHost}` : 'https://unrelated.example',
        }),
  };
  return rewriteHeaders(details, () => ({ id: 'work', store }), { now: NOW })!.header;
}

interface Case {
  name: string;
  host: string;
  cookies: string[];
  /** Request paths to compare at, each of which must exist as a compiled rule. */
  paths: string[];
}

const CASES: Case[] = [
  {
    name: 'a plain session cookie',
    host: 'example.com',
    cookies: ['sid=WORK; Path=/'],
    paths: ['/'],
  },
  {
    name: 'the full SameSite spread',
    host: 'example.com',
    cookies: [
      'strict=S; Path=/; SameSite=Strict',
      'lax=L; Path=/; SameSite=Lax',
      'none=N; Path=/; SameSite=None; Secure',
    ],
    paths: ['/'],
  },
  {
    name: 'path scoping',
    host: 'example.com',
    cookies: ['root=R; Path=/', 'deep=D; Path=/admin'],
    paths: ['/', '/admin'],
  },
  {
    name: 'a host-only cookie on a subdomain',
    host: 'identity.example.com',
    cookies: ['okta=O; Path=/'],
    paths: ['/'],
  },
  {
    name: 'a domain-scoped cookie',
    host: 'www.example.com',
    cookies: ['shared=X; Path=/; Domain=example.com'],
    paths: ['/'],
  },
  {
    name: 'secure and insecure together',
    host: 'example.com',
    cookies: ['plain=P; Path=/', 'sec=S; Path=/; Secure'],
    paths: ['/'],
  },
  {
    name: 'a session with nothing to send here',
    host: 'example.com',
    cookies: [],
    paths: ['/'],
  },
];

describe('the two backends agree', () => {
  for (const c of CASES) {
    for (const variant of ['first-party', 'third-party', 'top-level'] as Variant[]) {
      it(`${c.name}, ${variant}`, () => {
        const store = jar(`https://${c.host}/`, ...c.cookies);
        let id = 1000;
        const compiled = compileHost(view(store, c.host), c.host, () => id++, { now: NOW });

        for (const path of c.paths) {
          // A session with no cookies compiles no path rules beyond the root.
          if (!c.cookies.length && path !== '/') continue;

          const expected = declarativeHeader(compiled.rules, c.host, path, variant);
          const actual = blockingHeader(
            store,
            `https://${c.host}${path === '/' ? '/' : `${path}/`}`,
            variant,
            c.host
          );
          expect(actual, `${c.name} at ${path} under ${variant}`).toBe(expected);
        }
      });
    }
  }

  it('agrees that an empty jar means remove, not leave alone', () => {
    const store = new CookieStore();
    let id = 1000;
    const compiled = compileHost(view(store, 'example.com'), 'example.com', () => id++, {
      now: NOW,
    });

    // Every compiled rule for a session with nothing here must be an explicit
    // removal, and the blocking backend must produce an empty header for the
    // same request. Both mean "send no cookies", and neither means "leave the
    // browser's own jar in place".
    for (const rule of compiled.rules) {
      expect(rule.action.requestHeaders![0]!.operation).toBe('remove');
    }
    expect(blockingHeader(store, 'https://example.com/', 'first-party', 'example.com')).toBe('');
  });

  it('agrees when strictOnTopLevel is turned off', () => {
    const store = jar('https://example.com/', 'strict=S; Path=/; SameSite=Strict');
    let id = 1000;
    const compiled = compileHost(view(store, 'example.com'), 'example.com', () => id++, {
      now: NOW,
      strictOnTopLevel: false,
    });

    const expected = declarativeHeader(compiled.rules, 'example.com', '/', 'top-level');
    const actual = rewriteHeaders(
      { tabId: 1, url: 'https://example.com/', type: 'main_frame' },
      () => ({ id: 'work', store }),
      { now: NOW, strictOnTopLevel: false }
    )!.header;
    expect(actual).toBe(expected);
    expect(actual).not.toContain('strict=S');
  });
});
