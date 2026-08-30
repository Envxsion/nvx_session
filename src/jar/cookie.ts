/**
 * Cookie model and Set-Cookie parsing, following RFC 6265bis.
 *
 * The moment the browser jar is bypassed, every semantic it was handling
 * becomes ours. This file owns the parse half; matching and emission live in
 * store.ts and emit.ts.
 */

export type SameSite = 'strict' | 'lax' | 'none';

export interface Cookie {
  name: string;
  value: string;
  /** Always stored without a leading dot. */
  domain: string;
  /** True when the Set-Cookie carried an explicit Domain attribute, which is
   *  what decides whether subdomains match. */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  /**
   * True when the Set-Cookie carried no SameSite attribute and Lax was applied
   * as the default, as opposed to the site asking for Lax.
   *
   * The two are not interchangeable. Chrome sends a defaulted-Lax cookie on a
   * cross-site top level POST for the first two minutes of its life, and does
   * not extend that to an explicit SameSite=Lax. The carve-out exists so form
   * POST single sign-on keeps working, which is exactly the traffic this jar
   * has to get right, so the distinction has to survive parsing.
   */
  sameSiteDefaulted: boolean;
  partitioned: boolean;
  /** Epoch ms, or null for a session cookie. */
  expires: number | null;
  created: number;
  lastAccess: number;
}

export interface ParseContext {
  /** The URL the Set-Cookie arrived from. */
  url: URL;
  now?: number;
}

export type ParseFailure =
  | 'empty'
  | 'illegal-octet'
  | 'no-name'
  | 'domain-mismatch'
  | 'public-suffix'
  | 'secure-prefix'
  | 'host-prefix'
  | 'too-large'
  | 'none-requires-secure';

export type ParseResult =
  | { ok: true; cookie: Cookie }
  | { ok: false; reason: ParseFailure; detail?: string };

/** RFC 6265 says 4096 bytes for the whole name=value pair. */
const MAX_PAIR_BYTES = 4096;

/**
 * Chrome rejects SameSite=None without Secure. Matching that matters: a cookie
 * the browser would have dropped must not survive in our jar, or a session
 * behaves differently under NVX than without it, which is the one thing the
 * whole design cannot afford.
 */
export interface ParseOptions {
  isPublicSuffix: (domain: string) => boolean;
  /** http: origins on localhost are treated as trustworthy, as browsers do. */
  now?: number;
}

export function parseSetCookie(
  header: string,
  ctx: ParseContext,
  opts: ParseOptions
): ParseResult {
  const now = opts.now ?? ctx.now ?? Date.now();
  const raw = header.trim();
  if (!raw) return { ok: false, reason: 'empty' };

  const firstSemi = raw.indexOf(';');
  const pair = (firstSemi === -1 ? raw : raw.slice(0, firstSemi)).trim();
  const attrText = firstSemi === -1 ? '' : raw.slice(firstSemi + 1);

  if (byteLength(pair) > MAX_PAIR_BYTES) {
    return { ok: false, reason: 'too-large', detail: `${byteLength(pair)} bytes` };
  }

  const eq = pair.indexOf('=');
  // A Set-Cookie with no "=" is discarded. A leading "=" means an empty name,
  // which is also invalid.
  if (eq <= 0) return { ok: false, reason: 'no-name', detail: pair };

  const name = pair.slice(0, eq).trim();
  const value = stripQuotes(pair.slice(eq + 1).trim());
  if (!name) return { ok: false, reason: 'no-name' };

  // The jar's contents are concatenated straight into a Cookie header. A
  // control character or a semicolon smuggled through a Set-Cookie would let a
  // compromised origin forge additional cookies, or split the header entirely.
  // The browser rejects these before they reach its own jar, so this jar has to
  // as well or NVX would be strictly more permissive than not running it.
  if (hasIllegalOctet(name) || hasIllegalOctet(value)) {
    return { ok: false, reason: 'illegal-octet', detail: name };
  }

  const attrs = parseAttributes(attrText);
  const requestHost = canonicalHost(ctx.url.hostname);
  const secureContext = isTrustworthy(ctx.url);

  let domain = requestHost;
  let hostOnly = true;
  if (attrs.domain) {
    const candidate = canonicalHost(attrs.domain.replace(/^\./, ''));
    if (!candidate) return { ok: false, reason: 'domain-mismatch', detail: attrs.domain };
    if (opts.isPublicSuffix(candidate)) {
      return { ok: false, reason: 'public-suffix', detail: candidate };
    }
    if (!domainMatches(requestHost, candidate)) {
      return { ok: false, reason: 'domain-mismatch', detail: `${requestHost} vs ${candidate}` };
    }
    domain = candidate;
    hostOnly = false;
  }

  const path = attrs.path && attrs.path.startsWith('/') ? attrs.path : defaultPath(ctx.url);
  const secure = attrs.secure || false;
  const sameSite = normaliseSameSite(attrs.sameSite);
  // Unrecognised counts as absent, which is what the browser does with it: an
  // attribute it cannot read is an attribute the site did not successfully set.
  const declared = (attrs.sameSite ?? '').trim().toLowerCase();
  const sameSiteDefaulted = declared !== 'strict' && declared !== 'none' && declared !== 'lax';

  if (sameSite === 'none' && !secure) {
    return { ok: false, reason: 'none-requires-secure' };
  }

  // Prefixes are enforced by the browser, so they must be enforced here too.
  if (name.startsWith('__Secure-') && (!secure || !secureContext)) {
    return { ok: false, reason: 'secure-prefix' };
  }
  if (name.startsWith('__Host-')) {
    if (!secure || !secureContext || !hostOnly || path !== '/') {
      return { ok: false, reason: 'host-prefix' };
    }
  }

  return {
    ok: true,
    cookie: {
      name,
      value,
      domain,
      hostOnly,
      path,
      secure,
      httpOnly: attrs.httpOnly || false,
      sameSite,
      sameSiteDefaulted,
      partitioned: attrs.partitioned || false,
      expires: resolveExpiry(attrs, now),
      created: now,
      lastAccess: now,
    },
  };
}

interface Attributes {
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  partitioned?: boolean;
  maxAge?: string;
  expires?: string;
}

function parseAttributes(text: string): Attributes {
  const out: Attributes = {};
  if (!text.trim()) return out;

  for (const part of text.split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    const key = (eq === -1 ? seg : seg.slice(0, eq)).trim().toLowerCase();
    const val = eq === -1 ? '' : seg.slice(eq + 1).trim();

    switch (key) {
      case 'domain':
        if (val) out.domain = val;
        break;
      case 'path':
        if (val) out.path = val;
        break;
      case 'secure':
        out.secure = true;
        break;
      case 'httponly':
        out.httpOnly = true;
        break;
      case 'samesite':
        out.sameSite = val;
        break;
      case 'partitioned':
        out.partitioned = true;
        break;
      case 'max-age':
        out.maxAge = val;
        break;
      case 'expires':
        out.expires = val;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Max-Age wins over Expires when both are present, and a non-positive Max-Age
 * means expire immediately rather than "no expiry".
 */
function resolveExpiry(attrs: Attributes, now: number): number | null {
  if (attrs.maxAge !== undefined && attrs.maxAge !== '') {
    const n = Number(attrs.maxAge);
    if (Number.isFinite(n)) return n <= 0 ? 0 : now + n * 1000;
  }
  if (attrs.expires) {
    const t = Date.parse(attrs.expires);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function normaliseSameSite(value: string | undefined): SameSite {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'strict':
      return 'strict';
    case 'none':
      return 'none';
    case 'lax':
      return 'lax';
    default:
      // Chrome's default when the attribute is absent or unrecognised.
      return 'lax';
  }
}

/**
 * Control characters only.
 *
 * A semicolon can never reach a value, because the parser splits attributes on
 * the first one. A comma is forbidden by the grammar but Chrome accepts it and
 * real cookies contain it, so rejecting one here would break sites that work
 * without NVX. What genuinely cannot be tolerated is a CR, LF or NUL, since the
 * value is concatenated into a header and those would split or truncate it.
 */
export function hasIllegalOctet(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function stripQuotes(v: string): string {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

export function canonicalHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * RFC 6265 section 5.1.3. A host matches a cookie domain when it is identical,
 * or is a subdomain of it and is not an IP address.
 */
export function domainMatches(host: string, cookieDomain: string): boolean {
  if (host === cookieDomain) return true;
  if (isIpAddress(host)) return false;
  return host.endsWith(`.${cookieDomain}`);
}

/** RFC 6265 section 5.1.4. */
export function defaultPath(url: URL): string {
  const p = url.pathname;
  if (!p || !p.startsWith('/')) return '/';
  const lastSlash = p.lastIndexOf('/');
  if (lastSlash === 0) return '/';
  return p.slice(0, lastSlash);
}

/** RFC 6265 section 5.1.4, path-match. */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith('/')) return true;
  return requestPath.charAt(cookiePath.length) === '/';
}

export function isIpAddress(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(':');
}

/**
 * Secure-context rules as browsers apply them, so http://localhost can still
 * hold Secure cookies during development.
 */
export function isTrustworthy(url: URL): boolean {
  if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
  const h = canonicalHost(url.hostname);
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
}

export function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    if (c > 0xffff) i++;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

export function isExpired(c: Cookie, now: number): boolean {
  return c.expires !== null && c.expires <= now;
}

/** The key that makes a cookie unique within a jar. */
export function cookieKey(c: Pick<Cookie, 'domain' | 'path' | 'name'>): string {
  return `${c.domain} ${c.path} ${c.name}`;
}
