/**
 * The entitlement gate, checked from the attacker's side.
 *
 * The security claim is narrow and load-bearing: only a token that verifies
 * under a key we ship, has not expired, and is bound to this device may unlock a
 * feature, and every other input resolves to the free product. So these tests
 * sign real Ed25519 tokens with a throwaway key and then try to get a feature
 * unlocked with a tampered payload, a foreign device, an expired claim, an
 * unknown key, and a forged algorithm, asserting each one stays free. The one
 * positive path (a valid token unlocks exactly its features) is here too, but
 * the weight is on the refusals.
 */

import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  Entitlement,
  FEATURES,
  b64urlToBytes,
  b64urlToString,
  decideFromToken,
  type EntitlementPorts,
  type LicenseClaims,
} from '../src/kernel/entitlement.js';

const { subtle } = webcrypto;

let privateKey: CryptoKey;
let pubRawB64: string;

/** Ed25519 verify wired to Node's WebCrypto, the same call the worker makes. */
const verify = async (pub: Uint8Array, sig: Uint8Array, data: Uint8Array): Promise<boolean> => {
  const key = await subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
  return subtle.verify('Ed25519', key, sig, data);
};

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
function b64urlStr(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

async function sign(
  claims: Partial<LicenseClaims>,
  opts: { alg?: string; kid?: string } = {}
): Promise<string> {
  const header = { alg: opts.alg ?? 'EdDSA', kid: opts.kid ?? 'k1' };
  const h = b64urlStr(JSON.stringify(header));
  const p = b64urlStr(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${h}.${p}`);
  const sig = new Uint8Array(await subtle.sign('Ed25519', privateKey, data));
  return `${h}.${p}.${b64url(sig)}`;
}

/** A full valid claim set for this device, in the far future. */
function claims(over: Partial<LicenseClaims> = {}): Partial<LicenseClaims> {
  return {
    v: 1,
    id: 'lic-1',
    tier: 'pro',
    feat: ['idb_isolation', 'fail_closed'],
    iat: 1_000_000_000,
    exp: 2_000_000_000,
    kid: 'k1',
    dev: 'dev-1',
    ...over,
  };
}

function ports(over: Partial<EntitlementPorts> = {}): EntitlementPorts {
  return {
    buildTier: () => 'pro',
    deviceId: () => 'dev-1',
    kids: { k1: pubRawB64 },
    verify,
    now: () => 1_500_000_000_000, // ms; 1.5e9 s, between iat and exp
    ...over,
  };
}

beforeAll(async () => {
  const kp = (await subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  privateKey = kp.privateKey;
  pubRawB64 = b64url(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
});

describe('decideFromToken, the positive path', () => {
  it('unlocks exactly the features a valid pro token lists', async () => {
    const d = await decideFromToken(await sign(claims()), ports());
    expect(d.tier).toBe('pro');
    expect(d.features.has('idb_isolation')).toBe(true);
    expect(d.features.has('fail_closed')).toBe(true);
    expect(d.features.has('exact_mode')).toBe(false);
  });

  it('unlocks every feature for a max_access token with feat "*"', async () => {
    const d = await decideFromToken(
      await sign(claims({ tier: 'max_access', feat: '*' })),
      ports()
    );
    expect(d.tier).toBe('max_access');
    for (const f of FEATURES) expect(d.features.has(f)).toBe(true);
  });
});

describe('decideFromToken refuses everything that is not a valid bound token', () => {
  it('a free build ignores even a perfect token', async () => {
    const d = await decideFromToken(await sign(claims()), ports({ buildTier: () => 'free' }));
    expect(d.tier).toBe('free');
    expect(d.reason).toBe('build_free');
  });

  it('an expired token resolves to free', async () => {
    const d = await decideFromToken(await sign(claims({ exp: 1_400_000_000 })), ports());
    expect(d.tier).toBe('free');
    expect(d.reason).toBe('expired');
  });

  it('a token bound to another device resolves to free', async () => {
    const d = await decideFromToken(await sign(claims({ dev: 'someone-else' })), ports());
    expect(d.tier).toBe('free');
    expect(d.reason).toBe('wrong_device');
  });

  it('a tampered payload fails the signature and resolves to free', async () => {
    const token = await sign(claims());
    const [h, p, s] = token.split('.');
    // Re-encode the payload with an escalated tier but keep the old signature.
    const forged = b64urlStr(JSON.stringify(claims({ tier: 'max_access', feat: '*' })));
    const d = await decideFromToken(`${h}.${forged}.${s}`, ports());
    expect(d.tier).toBe('free');
    expect(d.reason).toBe('bad_token');
    // And the original coordinates are unused for good measure.
    expect(p).not.toBe(forged);
  });

  it('an unknown kid resolves to free', async () => {
    const d = await decideFromToken(await sign(claims(), { kid: 'k9' }), ports());
    expect(d.tier).toBe('free');
    // kid mismatch header-vs-payload is caught as bad_token before the map;
    // a matching but unshipped kid is unknown_kid.
    const matched = await sign(claims({ kid: 'k9' }), { kid: 'k9' });
    const d2 = await decideFromToken(matched, ports());
    expect(d2.reason).toBe('unknown_kid');
  });

  it('a token that names any algorithm but EdDSA resolves to free', async () => {
    const d = await decideFromToken(await sign(claims(), { alg: 'none' }), ports());
    expect(d.tier).toBe('free');
    expect(d.reason).toBe('bad_token');
  });

  it('garbage that is not three dotted parts resolves to free', async () => {
    for (const junk of ['', 'a', 'a.b', 'a.b.c.d', '...', 'not a token']) {
      const d = await decideFromToken(junk, ports());
      expect(d.tier).toBe('free');
    }
  });

  it('a missing local device id fails closed even with a valid token', async () => {
    const d = await decideFromToken(await sign(claims()), ports({ deviceId: () => null }));
    expect(d.tier).toBe('free');
    expect(d.reason).toBe('wrong_device');
  });
});

describe('Entitlement caches and recomputes on change', () => {
  it('reads the cached decision and only recomputes when the token changes', async () => {
    let verifies = 0;
    const counting: EntitlementPorts = ports({
      verify: async (pub, sig, data) => {
        verifies++;
        return verify(pub, sig, data);
      },
    });
    const e = new Entitlement(counting);
    const token = await sign(claims());

    await e.setToken(token);
    expect(e.tier()).toBe('pro');
    expect(e.entitled('idb_isolation')).toBe(true);
    expect(verifies).toBe(1);

    // Same token again: no re-verify, gate checks are pure reads.
    await e.setToken(token);
    expect(verifies).toBe(1);
    expect(e.entitled('fail_closed')).toBe(true);

    // Clearing drops to free.
    await e.setToken(null);
    expect(e.isPro()).toBe(false);
    expect(e.entitled('idb_isolation')).toBe(false);
  });

  it('fires onChange only when the grant actually changes', async () => {
    const changes: string[] = [];
    const e = new Entitlement(ports({ onChange: (d) => changes.push(d.tier) }));

    await e.setToken(await sign(claims())); // free -> pro
    await e.setToken(await sign(claims())); // same token, same grant: no change
    await e.setToken(await sign(claims({ tier: 'max_access', feat: '*' }))); // pro -> max_access
    await e.setToken(null); // -> free
    await e.setToken(null); // still free: no change

    expect(changes).toEqual(['pro', 'max_access', 'free']);
  });

  it('re-verifies an unchanged token once the device id arrives late', async () => {
    let dev: string | null = null;
    const e = new Entitlement(ports({ deviceId: () => dev }));
    const token = await sign(claims());

    await e.setToken(token);
    expect(e.isPro()).toBe(false); // no device yet: wrong_device

    dev = 'dev-1';
    await e.setToken(token); // same string, but the stale wrong_device recomputes
    expect(e.tier()).toBe('pro');
  });
});

describe('base64url helpers', () => {
  it('round-trips text and rejects non-base64url input', () => {
    expect(b64urlToString(b64urlStr('héllo'))).toBe('héllo');
    expect(b64urlToBytes('has space')).toBeNull();
    expect(b64urlToBytes('has+plus')).toBeNull();
    expect(b64urlToBytes('a')).toBeNull(); // length % 4 === 1 is never valid
  });
});
