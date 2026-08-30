/**
 * ------------------------------------------------------------------
 *  Title    |  Entitlement gate
 *  Ref      |  license.ts, pro.ts, manifest nvx_tier
 *  ID       |  Pro tier (DESIGN sec 30)
 * ------------------------------------------------------------------
 *  Purpose  |  Answers "may this Pro feature run", offline.
 *  Note     |  Free builds are inert. No token ever unlocks them.
 *  Author   |  Ojas Kekre, 27/08/2026
 * ------------------------------------------------------------------
 */

/**
 * The closed set of Pro capabilities, the same allowlist discipline the
 * telemetry events follow. A feature name has no path into anything but one of
 * these, so a typo is a compile error rather than a silently ungated feature.
 */
export type Feature =
  | 'idb_isolation'
  | 'fail_closed'
  | 'exact_mode'
  | 'worker_isolation'
  | 'os_persona'
  | 'cache_isolation'
  | 'sync';

export const FEATURES: readonly Feature[] = [
  'idb_isolation',
  'fail_closed',
  'exact_mode',
  'worker_isolation',
  'os_persona',
  'cache_isolation',
  'sync',
] as const;

/**
 * `free` is the shipped product with no licence. `pro` is the sold set. A
 * `max_access` licence entitles every feature and is the tester and comp grant,
 * distinguishable from a paid `pro` in the studio so a retention number can
 * exclude the people who were never going to pay.
 */
export type Tier = 'free' | 'pro' | 'max_access';

/** The build tier, read from the manifest once and never trusted from a token. */
export type BuildTier = 'free' | 'pro';

/**
 * The claims a token carries. Everything here is verified before it is trusted;
 * see `decideFromToken`. `dev` is the hard device binding this build enforces so
 * one licence unlocks one device at a time, and `feat` is either an explicit
 * list or `*` for everything (a `max_access` grant).
 */
export interface LicenseClaims {
  /** Format version, so the shape can change without a silent mis-parse. */
  v: number;
  /** Licence id, the row it derives from. Opaque to the client. */
  id: string;
  tier: Tier;
  /** Entitled features, or `*` for all of them. */
  feat: Feature[] | '*';
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. The longest a revoked-but-offline client runs. */
  exp: number;
  /** Key id, selects the public key, so a leaked key rolls without bricking tokens. */
  kid: string;
  /** The device this token is bound to. Must equal this install's device id. */
  dev: string;
  /** A tester label, never shown to the user. */
  note?: string;
}

/** What a verified licence resolves to. Free carries no features. */
export interface Decision {
  tier: Tier;
  features: Set<Feature>;
  /** Present only when a real token decided this, for the settings screen. */
  claims?: LicenseClaims;
  /** Why a token did not unlock, for the settings screen and nothing else. */
  reason?: 'none' | 'build_free' | 'bad_token' | 'expired' | 'wrong_device' | 'unknown_kid';
}

const FREE: Decision = { tier: 'free', features: new Set(), reason: 'none' };

/** Whether two decisions grant the same thing: same tier and same feature set. */
function sameDecision(a: Decision, b: Decision): boolean {
  if (a.tier !== b.tier) return false;
  if (a.features.size !== b.features.size) return false;
  for (const f of a.features) if (!b.features.has(f)) return false;
  return true;
}

/** Small clock skew tolerated on expiry, so a device a minute fast is not cut off. */
const SKEW_S = 120;

/**
 * Everything this module needs from the outside, injected so it holds no
 * reference to `chrome` or `crypto` and runs unchanged under a test with a real
 * or a stubbed verifier.
 */
export interface EntitlementPorts {
  /** The tier this build was compiled as. A `free` build ignores every token. */
  buildTier: () => BuildTier;
  /** This install's stable device id, the value a token's `dev` must equal. */
  deviceId: () => string | null;
  /**
   * kid to public key, base64url of the raw 32-byte Ed25519 public key. Embedded
   * in the build; a token signed under an unknown kid resolves to free.
   */
  kids: Record<string, string>;
  /** Ed25519 verify: does `sig` sign `data` under `pubkey`? Never throws to the caller. */
  verify: (pubkey: Uint8Array, sig: Uint8Array, data: Uint8Array) => Promise<boolean>;
  now: () => number;
  /**
   * Called whenever the decision actually changes: a licence activated, expired,
   * was revoked or paused, or a seat moved away. This is the reactive seam that
   * lets a Pro feature turn on and off mid-session without the user reloading. It
   * fires only on a real change, never on a no-op re-set, so a feature's
   * enable/disable is not run on every daily refresh that returned the same token.
   */
  onChange?: (decision: Decision) => void;
}

/** base64url to bytes. Returns null on anything that is not valid base64url. */
export function b64urlToBytes(s: string): Uint8Array | null {
  if (typeof s !== 'string' || /[^A-Za-z0-9_-]/.test(s)) return null;
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : s.length % 4 === 1 ? null : '';
  if (pad === null) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** base64url bytes to a UTF-8 string, or null if it is not valid UTF-8. */
export function b64urlToString(s: string): string | null {
  const bytes = b64urlToBytes(s);
  if (!bytes) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** ASCII bytes of a string, for the signed `header.payload` region. */
function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const KNOWN_TIERS = new Set<Tier>(['pro', 'max_access']);
const FEATURE_SET = new Set<string>(FEATURES);

/**
 * Structurally validates a decoded payload before any claim is trusted. A shape
 * that does not match is not a licence, and the difference between "malformed"
 * and "not present" is not worth distinguishing to the user: both are free.
 */
function validClaims(raw: unknown): raw is LicenseClaims {
  if (!raw || typeof raw !== 'object') return false;
  const c = raw as Partial<LicenseClaims>;
  if (typeof c.v !== 'number' || typeof c.id !== 'string' || typeof c.dev !== 'string') return false;
  if (typeof c.iat !== 'number' || typeof c.exp !== 'number' || typeof c.kid !== 'string') return false;
  if (!KNOWN_TIERS.has(c.tier as Tier)) return false;
  if (c.feat !== '*') {
    if (!Array.isArray(c.feat)) return false;
    if (!c.feat.every((f) => FEATURE_SET.has(f as string))) return false;
  }
  return true;
}

/** The feature set a validated claim entitles. `*` is every feature. */
function featuresOf(claims: LicenseClaims): Set<Feature> {
  return claims.feat === '*' ? new Set(FEATURES) : new Set(claims.feat);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Token -> decision.
 *  Note     |  Any bad path falls back to "free". Offline only.
 * ------------------------------------------------------------------
 */
export async function decideFromToken(
  token: string,
  ports: EntitlementPorts
): Promise<Decision> {
  // A free build never honours a token, whatever it says. This is the belt: even
  // a perfectly valid max_access token does nothing in the build the store ships.
  if (ports.buildTier() !== 'pro') return { ...FREE, reason: 'build_free' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ...FREE, reason: 'bad_token' };
  const [h, p, s] = parts as [string, string, string];

  const headerJson = b64urlToString(h);
  const payloadJson = b64urlToString(p);
  const sig = b64urlToBytes(s);
  if (!headerJson || !payloadJson || !sig) return { ...FREE, reason: 'bad_token' };

  let header: { alg?: string; kid?: string };
  let payload: unknown;
  try {
    header = JSON.parse(headerJson);
    payload = JSON.parse(payloadJson);
  } catch {
    return { ...FREE, reason: 'bad_token' };
  }

  // The algorithm is not negotiable. A token that names anything but EdDSA is
  // not one we will verify, so there is no algorithm to confuse.
  if (header?.alg !== 'EdDSA') return { ...FREE, reason: 'bad_token' };
  if (!validClaims(payload)) return { ...FREE, reason: 'bad_token' };
  const claims = payload;

  // The kid in the header and the kid in the payload must agree, and it must
  // name a key we ship. An unknown kid is a token signed by something we do not
  // trust, which is free, not an error.
  const kid = header.kid;
  if (typeof kid !== 'string' || kid !== claims.kid) return { ...FREE, reason: 'bad_token' };
  const pubB64 = ports.kids[kid];
  if (!pubB64) return { ...FREE, reason: 'unknown_kid' };
  const pubkey = b64urlToBytes(pubB64);
  if (!pubkey) return { ...FREE, reason: 'unknown_kid' };

  // The signature is checked before any claim is read as meaningful, so an
  // attacker cannot get us to act on a payload we have not authenticated.
  let ok = false;
  try {
    ok = await ports.verify(pubkey, sig, ascii(`${h}.${p}`));
  } catch {
    ok = false;
  }
  if (!ok) return { ...FREE, reason: 'bad_token' };

  const nowS = Math.floor(ports.now() / 1000);
  if (claims.exp + SKEW_S < nowS) return { ...FREE, reason: 'expired', claims };

  // The hard device binding. A token minted for another install unlocks nothing
  // here, which is what makes one licence one device at a time. A missing local
  // device id (should not happen once activated) also fails closed to free.
  const dev = ports.deviceId();
  if (!dev || dev !== claims.dev) return { ...FREE, reason: 'wrong_device', claims };

  return { tier: claims.tier, features: featuresOf(claims), claims };
}

/**
 * Holds the current decision and answers gate checks synchronously.
 *
 * `setToken` verifies and caches; `tier` and `entitled` read the cache and never
 * verify, so the check a Pro feature makes on every request is a set lookup. The
 * cache is recomputed only when the token string actually changes.
 */
export class Entitlement {
  private decision: Decision = FREE;
  private lastToken: string | null = null;

  constructor(private readonly ports: EntitlementPorts) {}

  /**
   * Sets (or clears, with null/empty) the current token and recomputes the
   * decision. Idempotent for an unchanged token, so it is safe to call on every
   * boot and after every refresh.
   */
  async setToken(token: string | null): Promise<Decision> {
    const t = token ?? '';
    if (t === (this.lastToken ?? '') && (t !== '' || this.lastToken !== null)) {
      // Unchanged. Recompute only when the device id may have arrived after the
      // token did, which is the one case a cached "wrong_device" could be stale.
      if (!(this.decision.reason === 'wrong_device')) return this.decision;
    }
    this.lastToken = token;
    const prev = this.decision;
    this.decision = t ? await decideFromToken(t, this.ports) : FREE;
    if (this.ports.onChange && !sameDecision(prev, this.decision)) {
      this.ports.onChange(this.decision);
    }
    return this.decision;
  }

  /** The current decision, for the settings screen. */
  current(): Decision {
    return this.decision;
  }

  tier(): Tier {
    return this.decision.tier;
  }

  entitled(feature: Feature): boolean {
    return this.decision.features.has(feature);
  }

  /** True for any paid or comped tier, for a coarse "is this a Pro user" check. */
  isPro(): boolean {
    return this.decision.tier !== 'free';
  }
}
