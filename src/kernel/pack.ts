/**
 * ------------------------------------------------------------------
 *  Title    |  Site packs
 *  Ref      |  entitlement.ts (same keys), netfilter/compile.ts
 *           |  (setPackExtras), src/pro/docs/licensing-and-abuse-brief.md
 *  ID       |  pack
 * ------------------------------------------------------------------
 *  Purpose  |  Sign-in knowledge that reaches Pro between releases: new
 *           |  identity providers, and headers a provider started using
 *           |  that act on the browser's own account state.
 *  How      |  The licence server signs a pack with the licence keys
 *           |  (EdDSA, same kid set), bound to this device and short
 *           |  lived, and hands it only to a device with an active
 *           |  licence. This module verifies it offline and returns the
 *           |  cleaned data; the worker applies it through
 *           |  setPackExtras. Free builds never fetch one, and get the
 *           |  same fixes in the next release.
 *  Why      |  Data, not code: remote code is not allowed in a store
 *           |  extension, and data that only a valid licence can fetch
 *           |  is something a patched copy cannot fake. A cracked build
 *           |  stays frozen at the day it was cracked.
 *  Safety   |  A pack can only add. It can never name a security header
 *           |  (CSP, HSTS, frame and cross-origin policy, cookies,
 *           |  authorisation) and every list is capped, so even a
 *           |  leaked signing key cannot use a pack to weaken a page.
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { ascii, b64urlToBytes, b64urlToString } from './entitlement.js';

export interface PackData {
  idps: string[];
  responseHeaders: string[];
  requestHeaders: string[];
}

export interface PackClaims {
  v: 1;
  typ: 'pack';
  seq: number;
  iat: number;
  exp: number;
  kid: string;
  dev: string;
  data: PackData;
}

export interface PackPorts {
  kids: Record<string, string>;
  verify: (pubkey: Uint8Array, sig: Uint8Array, data: Uint8Array) => Promise<boolean>;
  deviceId: () => string | null;
  /** Trusted now, in ms: never earlier than the latest server time seen. */
  now: () => number;
}

export type PackResult =
  | { ok: true; claims: PackClaims }
  | { ok: false; reason: 'bad' | 'unknown_kid' | 'expired' | 'wrong_device' };

const MAX_IDPS = 200;
const MAX_HEADERS = 24;
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Headers a pack may never remove. Removing any of them would weaken the page
 * (CSP, HSTS, framing, isolation) or break sign-in itself (cookies, auth), and
 * no sign-in fix needs to.
 */
const FORBIDDEN_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
  'x-xss-protection',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'www-authenticate',
  'origin',
  'host',
  'location',
  'content-type',
]);

/** Request headers are narrower still: only the account-signal families. */
const REQUEST_FAMILIES = /^(?:x-ms-|x-chrome-|x-goog-|sec-session-|google-accounts-)/;

function cleanList(raw: unknown, ok: (s: string) => boolean, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const v = x.trim().toLowerCase();
    if (ok(v)) out.add(v);
    if (out.size >= max) break;
  }
  return [...out].sort();
}

/** The pack's data with everything unsafe or malformed dropped. */
export function cleanPackData(raw: unknown): PackData {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const header = (h: string) => HEADER.test(h) && !FORBIDDEN_HEADERS.has(h);
  return {
    idps: cleanList(d.idps, (s) => DOMAIN.test(s), MAX_IDPS),
    responseHeaders: cleanList(d.responseHeaders, header, MAX_HEADERS),
    requestHeaders: cleanList(d.requestHeaders, (h) => header(h) && REQUEST_FAMILIES.test(h), MAX_HEADERS),
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Pack token -> verified, cleaned claims.
 *  Note     |  The header must say typ "nvx-pack" and the payload typ
 *           |  "pack", so a licence token can never be read as a pack
 *           |  or the other way round, though both share the keys.
 * ------------------------------------------------------------------
 */
export async function openPack(token: string, ports: PackPorts): Promise<PackResult> {
  if (typeof token !== 'string' || token.length > 64_000) return { ok: false, reason: 'bad' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'bad' };
  const [h, p, s] = parts as [string, string, string];
  const hj = b64urlToString(h);
  const pj = b64urlToString(p);
  const sig = b64urlToBytes(s);
  if (!hj || !pj || !sig) return { ok: false, reason: 'bad' };
  let header: { alg?: unknown; kid?: unknown; typ?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(hj);
    payload = JSON.parse(pj);
  } catch {
    return { ok: false, reason: 'bad' };
  }
  if (header?.alg !== 'EdDSA' || header.typ !== 'nvx-pack' || typeof header.kid !== 'string') {
    return { ok: false, reason: 'bad' };
  }
  if (!payload || payload.typ !== 'pack' || payload.v !== 1 || payload.kid !== header.kid) {
    return { ok: false, reason: 'bad' };
  }
  const pub = ports.kids[header.kid] ? b64urlToBytes(ports.kids[header.kid]!) : null;
  if (!pub) return { ok: false, reason: 'unknown_kid' };
  let ok = false;
  try {
    ok = await ports.verify(pub, sig, ascii(`${h}.${p}`));
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, reason: 'bad' };

  const { seq, iat, exp, dev } = payload as { seq?: unknown; iat?: unknown; exp?: unknown; dev?: unknown };
  if (typeof seq !== 'number' || typeof iat !== 'number' || typeof exp !== 'number' || typeof dev !== 'string') {
    return { ok: false, reason: 'bad' };
  }
  if (exp * 1000 < ports.now()) return { ok: false, reason: 'expired' };
  if (dev !== ports.deviceId()) return { ok: false, reason: 'wrong_device' };
  return {
    ok: true,
    claims: { v: 1, typ: 'pack', seq, iat, exp, kid: header.kid, dev, data: cleanPackData(payload.data) },
  };
}
