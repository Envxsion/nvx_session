/**
 * ------------------------------------------------------------------
 *  Title    |  Site packs, trusted clock, licence recheck
 *  Ref      |  kernel/pack.ts, kernel/clock.ts, kernel/entitlement.ts,
 *           |  netfilter/compile.ts (setPackExtras)
 *  ID       |  test (pack)
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanPackData, openPack, type PackPorts } from '../src/kernel/pack.js';
import { TrustedClock, CLOCK_KEY } from '../src/kernel/clock.js';
import { Entitlement, decideFromToken, type EntitlementPorts } from '../src/kernel/entitlement.js';
import { IDENTITY_PROVIDERS, setPackExtras } from '../src/netfilter/compile.js';

const { subtle } = webcrypto;
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let pub: string;

const verify = async (k: Uint8Array, sig: Uint8Array, data: Uint8Array): Promise<boolean> => {
  const key = await subtle.importKey('raw', k, { name: 'Ed25519' }, false, ['verify']);
  return subtle.verify('Ed25519', key, sig, data);
};
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

async function sign(header: object, payload: object, key = privateKey): Promise<string> {
  const h = b64(JSON.stringify(header));
  const p = b64(JSON.stringify(payload));
  const sig = new Uint8Array(await subtle.sign('Ed25519', key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
}

const NOW = 1_800_000_000_000;
const packPayload = (over: object = {}) => ({
  v: 1,
  typ: 'pack',
  seq: 7,
  iat: NOW / 1000 - 60,
  exp: NOW / 1000 + 86_400,
  kid: 'k1',
  dev: 'dev-1',
  data: { idps: ['newidp.example'], responseHeaders: ['x-new-account-signal'], requestHeaders: ['x-ms-refreshtokencredential'] },
  ...over,
});
const HEADER = { alg: 'EdDSA', kid: 'k1', typ: 'nvx-pack' };

function ports(over: Partial<PackPorts> = {}): PackPorts {
  return { kids: { k1: pub }, verify, deviceId: () => 'dev-1', now: () => NOW, ...over };
}

beforeAll(async () => {
  const kp = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  privateKey = kp.privateKey;
  pub = Buffer.from(new Uint8Array(await subtle.exportKey('raw', kp.publicKey))).toString('base64url');
  otherKey = ((await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair).privateKey;
});

describe('openPack', () => {
  it('opens a valid pack for this device', async () => {
    const r = await openPack(await sign(HEADER, packPayload()), ports());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claims.seq).toBe(7);
    expect(r.claims.data.idps).toEqual(['newidp.example']);
    expect(r.claims.data.requestHeaders).toEqual(['x-ms-refreshtokencredential']);
  });

  it('refuses another signer, another device, an expired pack and an unknown kid', async () => {
    expect((await openPack(await sign(HEADER, packPayload(), otherKey), ports())).ok).toBe(false);
    expect(await openPack(await sign(HEADER, packPayload({ dev: 'dev-2' })), ports())).toEqual({
      ok: false,
      reason: 'wrong_device',
    });
    expect(await openPack(await sign(HEADER, packPayload({ exp: NOW / 1000 - 1 })), ports())).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(await openPack(await sign(HEADER, packPayload()), ports({ kids: {} }))).toEqual({
      ok: false,
      reason: 'unknown_kid',
    });
  });

  it('never reads a licence token as a pack', async () => {
    const licence = await sign({ alg: 'EdDSA', kid: 'k1' }, { ...packPayload(), typ: undefined, tier: 'pro' });
    expect((await openPack(licence, ports())).ok).toBe(false);
    const noTyp = await sign({ alg: 'EdDSA', kid: 'k1' }, packPayload());
    expect((await openPack(noTyp, ports())).ok).toBe(false);
  });

  it('drops security headers, malformed domains and request headers outside the account families', () => {
    const d = cleanPackData({
      idps: ['ok.example', 'not a domain', 'x', 'OK.example'],
      responseHeaders: ['content-security-policy', 'Strict-Transport-Security', 'set-cookie', 'x-fine'],
      requestHeaders: ['authorization', 'cookie', 'x-ms-fine', 'user-agent'],
    });
    expect(d.idps).toEqual(['ok.example']);
    expect(d.responseHeaders).toEqual(['x-fine']);
    expect(d.requestHeaders).toEqual(['x-ms-fine']);
  });
});

describe('setPackExtras', () => {
  afterEach(() => setPackExtras({}));

  it('adds providers and removes them again, never the built-in ones', () => {
    expect(IDENTITY_PROVIDERS.has('newidp.example')).toBe(false);
    setPackExtras({ idps: ['newidp.example'] });
    expect(IDENTITY_PROVIDERS.has('newidp.example')).toBe(true);
    setPackExtras({ idps: [] });
    expect(IDENTITY_PROVIDERS.has('newidp.example')).toBe(false);
    expect(IDENTITY_PROVIDERS.has('google.com')).toBe(true);
  });
});

function memStore(seed: Record<string, unknown> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => map.has(k)).map((k) => [k, map.get(k)])),
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
  };
}

describe('TrustedClock', () => {
  it('never goes back when the system clock is wound back', async () => {
    let sys = 1_000_000;
    const store = memStore();
    const c = new TrustedClock(store, () => sys);
    expect(c.now()).toBe(1_000_000);
    sys = 900_000;
    expect(c.now()).toBe(1_000_000);
    expect(c.rolledBack()).toBe(false); // within five minutes
    sys = 1_000;
    expect(c.now()).toBe(1_000_000);
    expect(c.rolledBack()).toBe(true);
  });

  it('remembers the floor across restarts and believes server time', async () => {
    const store = memStore({ [CLOCK_KEY]: 9_000_000_000 });
    const c = new TrustedClock(store, () => 1_000);
    await c.load();
    expect(c.now()).toBe(9_000_000_000);
    c.observe(9_500_000_000);
    expect(c.now()).toBe(9_500_000_000);
    expect(store.map.get(CLOCK_KEY)).toBe(9_500_000_000);
    c.observe(Number.NaN);
    c.observe(Date.UTC(2200, 0, 1));
    expect(c.now()).toBe(9_500_000_000);
  });
});

describe('licence against a wound-back clock', () => {
  const lic = (over: object = {}) => ({
    v: 1,
    id: 'l',
    tier: 'pro',
    feat: '*',
    iat: 2_000_000_000,
    exp: 2_000_000_000 + 14 * 86_400,
    kid: 'k1',
    dev: 'dev-1',
    ...over,
  });
  const eports = (now: () => number): EntitlementPorts => ({
    buildTier: () => 'pro',
    deviceId: () => 'dev-1',
    kids: { k1: pub },
    verify,
    now,
  });

  it('measures expiry from no earlier than the token was issued', async () => {
    // Clock set years back: the token was issued after "now", so now is taken
    // as its issue time, and the token is valid exactly as long as it was.
    const t = await sign({ alg: 'EdDSA', kid: 'k1' }, lic());
    expect((await decideFromToken(t, eports(() => 1_000))).tier).toBe('pro');
    // And a clock past exp is expired as before.
    expect((await decideFromToken(t, eports(() => (2_000_000_000 + 15 * 86_400) * 1000))).reason).toBe('expired');
  });

  it('recheck drops a token that expired while the worker stayed up', async () => {
    let now = 2_000_000_000_000;
    const changes: string[] = [];
    const e = new Entitlement({ ...eports(() => now), onChange: (d) => changes.push(d.tier) });
    await e.setToken(await sign({ alg: 'EdDSA', kid: 'k1' }, lic()));
    expect(e.tier()).toBe('pro');
    now += 15 * 86_400_000;
    await e.recheck();
    expect(e.tier()).toBe('free');
    expect(changes).toEqual(['pro', 'free']);
  });
});
