/**
 * Telemetry, checked for the one property that matters: it cannot leak.
 *
 * The product's whole promise is that your data does not leave, so the bar for
 * this module is not "does it send counts" but "can it ever send anything it
 * should not". The tests are written from that side. They feed the one text
 * path an adversarial string full of the exact things that must never go out, a
 * URL, a domain, a cookie value, and assert none of it survives into a payload.
 * They confirm both switches, consent and a configured endpoint, gate every
 * send. And they confirm turning it off erases the only durable thing it kept.
 */

import { describe, expect, it } from 'vitest';
import { Telemetry, bucket, daysBucket, cleanEnv, slug, TELEMETRY_ID_KEY } from '../src/kernel/telemetry.js';
import type { TelemetryPorts } from '../src/kernel/telemetry.js';

/** An in-memory storage area, the same shape the worker injects. */
function fakeStorage(seed: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    area: {
      get: async (keys: string | string[] | null) => {
        const list = keys === null ? [...map.keys()] : Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) if (map.has(k)) out[k] = map.get(k);
        return out;
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) map.set(k, v);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
      },
    },
    map,
  };
}

interface Sent {
  url: string;
  body: string;
}

/** A telemetry instance wired to fakes, plus the list of what it posted. */
function make(opts: {
  endpoint?: string | null;
  consent?: boolean;
  seed?: Record<string, unknown>;
  postThrows?: boolean;
  ids?: string[];
} = {}) {
  const sent: Sent[] = [];
  const storage = fakeStorage(opts.seed);
  let n = 0;
  const ids = opts.ids ?? ['id-fixed'];
  let clock = 1000;
  let consent = opts.consent ?? true;
  const ports: TelemetryPorts = {
    storage: storage.area,
    endpoint: () => (opts.endpoint === undefined ? 'https://ingest.example/t' : opts.endpoint),
    consented: () => consent,
    post: async (url, body) => {
      if (opts.postThrows) throw new Error('network down');
      sent.push({ url, body });
    },
    now: () => (clock += 1),
    newId: () => ids[n++ % ids.length]!,
  };
  const t = new Telemetry(ports, { version: '1.2.3', mv: 3 });
  return { t, sent, storage, setConsent: (v: boolean) => (consent = v) };
}

/** Every envelope across every posted batch, flattened. */
function envelopes(sent: Sent[]) {
  return sent.flatMap((s) => JSON.parse(s.body).batch as Array<Record<string, unknown>>);
}

describe('bucket coarsens a count', () => {
  it('maps counts to wide ranges and never returns the raw number', () => {
    expect(bucket(0)).toBe('0');
    expect(bucket(1)).toBe('1');
    expect(bucket(2)).toBe('2-3');
    expect(bucket(3)).toBe('2-3');
    expect(bucket(5)).toBe('4-6');
    expect(bucket(10)).toBe('7-12');
    expect(bucket(99)).toBe('13+');
    expect(bucket(-4)).toBe('0');
    expect(bucket(Number.NaN)).toBe('0');
  });
});

describe('slug strips a label to something that cannot identify', () => {
  it('reduces a URL or message to letters, digits and underscores', () => {
    expect(slug('https://mail.google.com/u/2/inbox')).toBe('https_mail_google_com_u_2_inbox');
    expect(slug('Failed: SID=abc123.def')).toBe('failed_sid_abc123_def');
    expect(slug('   ')).toBe('unknown');
    expect(slug('')).toBe('unknown');
  });

  it('truncates hard so a long string cannot be smuggled through', () => {
    const out = slug('a'.repeat(200));
    expect(out.length).toBeLessThanOrEqual(40);
  });
});

describe('both switches gate every send', () => {
  it('sends nothing without consent', async () => {
    const { t, sent } = make({ consent: false });
    await t.ready();
    t.startup();
    t.sessionCreated(3);
    await t.flush();
    expect(sent).toHaveLength(0);
  });

  it('sends nothing when the build has no endpoint', async () => {
    const { t, sent } = make({ endpoint: null });
    await t.ready();
    t.startup();
    await t.flush();
    expect(sent).toHaveLength(0);
  });

  it('never writes an install id when it is off', async () => {
    const { t, storage } = make({ consent: false });
    await t.ready();
    expect(storage.map.has(TELEMETRY_ID_KEY)).toBe(false);
  });

  it('sends when consented and configured', async () => {
    const { t, sent } = make();
    await t.ready();
    t.startup();
    await t.flush();
    expect(envelopes(sent).length).toBeGreaterThan(0);
  });

  it('stamps the wire-format version on every batch', async () => {
    const { t, sent } = make();
    await t.ready();
    t.startup();
    await t.flush();
    expect(JSON.parse(sent[0]!.body).schema).toBe(2);
  });
});

describe('what goes out is an allowlist', () => {
  it('carries the version and platform on every envelope', async () => {
    const { t, sent } = make();
    await t.ready();
    t.startup();
    await t.flush();
    for (const e of envelopes(sent)) {
      expect(e.v).toBe('1.2.3');
      expect(e.mv).toBe(3);
      expect(typeof e.id).toBe('string');
    }
  });

  it('sends a bucket for a session count, never the raw number', async () => {
    const { t, sent } = make();
    await t.ready();
    t.sessionCreated(9);
    await t.flush();
    const [e] = envelopes(sent);
    expect(e!.data).toEqual({ sessions: '7-12' });
    expect(JSON.stringify(e)).not.toContain('"9"');
  });

  it('destroys the structure a URL or cookie needs, even when one is forced in', async () => {
    const { t, sent } = make();
    await t.ready();
    // error takes a closed enum; casting past the type is the "forced in" case.
    // Even then the identifying structure, the dots, slashes, colon and query,
    // cannot survive, so a URL or a dotted domain is not reconstructable.
    (t.error as (c: string) => void)('https://mail.google.com/inbox?SID=SECRETCOOKIEVALUE');
    await t.flush();
    const category = String((envelopes(sent)[0]!.data as { category: unknown }).category);
    expect(category).not.toMatch(/[./:?=]/);
    expect(category).not.toContain('mail.google.com');
    expect(category.length).toBeLessThanOrEqual(40);
    expect(envelopes(sent)[0]!.event).toBe('error');
  });
});

describe('the install id', () => {
  it('is minted once and stays stable across events', async () => {
    const { t, sent, storage } = make({ ids: ['first', 'second'] });
    await t.ready();
    t.startup();
    t.sessionCreated(1);
    await t.flush();
    const ids = new Set(envelopes(sent).map((e) => e.id));
    expect(ids).toEqual(new Set(['first']));
    expect(storage.map.get(TELEMETRY_ID_KEY)).toBe('first');
  });

  it('reuses an id already in storage rather than minting a new one', async () => {
    const { t, sent } = make({ seed: { [TELEMETRY_ID_KEY]: 'kept' }, ids: ['new'] });
    await t.ready();
    t.startup();
    await t.flush();
    expect(envelopes(sent)[0]!.id).toBe('kept');
  });
});

describe('turning it off unwrites what it kept', () => {
  it('purge erases the id, and once off nothing more is sent', async () => {
    const { t, sent, storage, setConsent } = make();
    await t.ready();
    expect(storage.map.has(TELEMETRY_ID_KEY)).toBe(true);

    // The real sequence: the user turns telemetry off, which is what triggers
    // purge in the worker.
    setConsent(false);
    await t.purge();
    expect(storage.map.has(TELEMETRY_ID_KEY)).toBe(false);

    const before = sent.length;
    t.startup();
    t.sessionCreated(2);
    await t.flush();
    expect(sent.length).toBe(before);
  });
});

describe('telemetry never fails the product', () => {
  it('swallows a network error and drops the batch', async () => {
    const { t } = make({ postThrows: true });
    await t.ready();
    t.startup();
    await expect(t.flush()).resolves.toBeUndefined();
  });
});

describe('daysBucket coarsens an install age into a cohort', () => {
  it('never returns the raw day count', () => {
    expect(daysBucket(0)).toBe('0');
    expect(daysBucket(1)).toBe('1');
    expect(daysBucket(5)).toBe('2-7');
    expect(daysBucket(20)).toBe('8-30');
    expect(daysBucket(60)).toBe('31-90');
    expect(daysBucket(400)).toBe('90+');
  });
});

describe('cleanEnv forces the device profile onto the allowlist', () => {
  it('coerces unknowns to other and coarsens the rest', () => {
    expect(cleanEnv({ os: 'windows', arch: 'arm64', browser: 'opera', browser_major: 128, lang: 'en', tz: 10 }))
      .toEqual({ os: 'windows', arch: 'arm64', browser: 'opera', browser_major: 128, lang: 'en', tz: 10 });
    const junk = cleanEnv({
      os: 'haiku' as never,
      arch: 'risc' as never,
      browser: 'netscape' as never,
      browser_major: -3,
      lang: 'EN-AU-loud',
      tz: 999,
    });
    expect(junk.os).toBe('other');
    expect(junk.arch).toBe('other');
    expect(junk.browser).toBe('other');
    expect(junk.browser_major).toBe(0);
    // A region on the language is dropped, not sent.
    expect(junk.lang).toBe('other');
    // Timezone clamped to the real range.
    expect(junk.tz).toBe(14);
  });

  it('strips a region from a valid language', () => {
    expect(cleanEnv({ lang: 'fr-CA' }).lang).toBe('other');
    expect(cleanEnv({ lang: 'fr' }).lang).toBe('fr');
  });
});

describe('the device profile rides only where it should', () => {
  it('attaches env to install and startup, cleaned', async () => {
    const { t, sent } = make();
    t.setEnv({ os: 'macos', arch: 'arm64', browser: 'chrome', browser_major: 130, lang: 'de', tz: 1 });
    await t.ready();
    t.startup();
    await t.flush();
    expect(envelopes(sent)[0]!.data).toMatchObject({ os: 'macos', browser: 'chrome', browser_major: 130 });
  });

  it('carries engagement and retention on the active beat, all bucketed', async () => {
    const { t, sent } = make();
    t.setEnv({ os: 'windows', arch: 'x86-64', browser: 'edge', browser_major: 120, lang: 'en', tz: -5 });
    await t.ready();
    t.active({ sessions: bucket(4), tabs: bucket(9), since_install: daysBucket(20) });
    await t.flush();
    const e = envelopes(sent)[0]!;
    expect(e.event).toBe('active');
    expect(e.data).toMatchObject({
      os: 'windows',
      sessions: '4-6',
      tabs: '7-12',
      since_install: '8-30',
    });
    // No raw numbers escaped through the buckets.
    expect(JSON.stringify(e.data)).not.toContain('"9"');
    expect(JSON.stringify(e.data)).not.toContain('"20"');
  });

  it('sends no env fields when none was set', async () => {
    const { t, sent } = make();
    await t.ready();
    t.startup();
    await t.flush();
    expect(envelopes(sent)[0]!.data).toEqual({});
  });
});
