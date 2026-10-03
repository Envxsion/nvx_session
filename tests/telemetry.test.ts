/**
 * ------------------------------------------------------------------
 *  Title    |  Telemetry cannot leak
 *  Ref      |  kernel/telemetry.ts
 *  ID       |  test (telemetry)
 * ------------------------------------------------------------------
 *  Purpose  |  Proves the one property that matters: it can never send
 *           |  anything it should not.
 *  Note     |  Feeds the text path an adversarial string (a URL, a
 *           |  domain, a cookie value) and asserts none survives into a
 *           |  payload. Both consent and a configured endpoint gate
 *           |  every send, and turning it off erases what it kept. The
 *           |  queue, batching and daily rollups are in
 *           |  telemetry-queue.test.ts.
 *  Author   |  Ojas Kekre, 24/08/2026
 * ------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';
import {
  Telemetry,
  TELEMETRY_DAILY_KEY,
  TELEMETRY_ID_KEY,
  TELEMETRY_QUEUE_KEY,
  TELEMETRY_SCHEMA,
  bucket,
  cleanEnv,
  daysBucket,
  isUuidV4,
  slug,
  uuidV4,
} from '../src/kernel/telemetry.js';
import { make, envelopes, ID_A, ID_B } from './telemetry-fakes.js';

const USAGE = {
  sessions: 4,
  tabs: 9,
  sinceInstallDays: 20,
  burners: 1,
  maxSessionTabs: 5,
  maxSessionRules: 120,
  tier: 'free' as const,
  posture: 'mirror' as const,
  askNewSites: true,
  quiet: 2,
};

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
    expect(slug('a'.repeat(200)).length).toBeLessThanOrEqual(40);
  });
});

describe('both switches gate every send', () => {
  it('sends nothing without consent', async () => {
    const { t, sent } = make({ consent: false });
    await t.ready();
    t.startup();
    t.sessionCreated(3);
    t.count('replay_hop');
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

  it('writes nothing at all when it is off', async () => {
    const { t, storage } = make({ consent: false });
    await t.ready();
    t.startup();
    t.count('settle_wait');
    t.timing('flush', 12);
    await t.settled();
    await t.flush();
    expect(storage.map.has(TELEMETRY_ID_KEY)).toBe(false);
    expect(storage.map.has(TELEMETRY_QUEUE_KEY)).toBe(false);
    expect(storage.map.has(TELEMETRY_DAILY_KEY)).toBe(false);
  });

  it('sends when consented and configured, stamped with the wire version', async () => {
    const { t, sent } = make();
    await t.ready();
    t.startup();
    await t.flush();
    expect(envelopes(sent).length).toBe(1);
    expect(TELEMETRY_SCHEMA).toBe(3);
    expect(JSON.parse(sent[0]!.body).schema).toBe(3);
  });
});

describe('what goes out is an allowlist', () => {
  it('carries version, platform, channel and a sequence on every envelope', async () => {
    const { t, sent } = make({ channel: 'dev' });
    await t.ready();
    t.startup();
    t.sessionCreated(2);
    await t.flush();
    const all = envelopes(sent);
    expect(all.map((e) => e.seq)).toEqual([1, 2]);
    for (const e of all) {
      expect(e.v).toBe('1.2.3');
      expect(e.mv).toBe(3);
      expect(e.channel).toBe('dev');
      expect(isUuidV4(e.id)).toBe(true);
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
    (t.error as (c: string) => void)('https://mail.google.com/inbox?SID=SECRETCOOKIEVALUE');
    await t.flush();
    const e = envelopes(sent)[0]!;
    const category = String((e.data as { category: unknown }).category);
    expect(category).not.toMatch(/[./:?=]/);
    expect(category).not.toContain('mail.google.com');
    expect(category.length).toBeLessThanOrEqual(40);
    expect(e.event).toBe('error');
  });

  it('sends only the major.minor an update came from', async () => {
    const { t, sent } = make();
    await t.ready();
    t.update('1.4.2.7');
    t.update('not a version');
    await t.flush();
    expect(envelopes(sent).map((e) => e.data)).toEqual([{ from: '1.4' }, { from: '0.0' }]);
  });
});

describe('the install id', () => {
  it('is minted once and stays stable across events', async () => {
    const { t, sent, storage } = make({ ids: [ID_A, ID_B] });
    await t.ready();
    t.startup();
    t.sessionCreated(1);
    await t.flush();
    expect(new Set(envelopes(sent).map((e) => e.id))).toEqual(new Set([ID_A]));
    expect(storage.map.get(TELEMETRY_ID_KEY)).toBe(ID_A);
  });

  it('reuses a valid id already in storage rather than minting a new one', async () => {
    const { t, sent } = make({ seed: { [TELEMETRY_ID_KEY]: ID_B }, ids: [ID_A] });
    await t.ready();
    t.startup();
    await t.flush();
    expect(envelopes(sent)[0]!.id).toBe(ID_B);
  });

  it('replaces a stored id that is not a UUID v4, and a minted one that is not either', async () => {
    const { t, sent, storage } = make({ seed: { [TELEMETRY_ID_KEY]: 'lx1-abc' }, ids: ['not-a-uuid'] });
    await t.ready();
    t.startup();
    await t.flush();
    const id = envelopes(sent)[0]!.id;
    expect(isUuidV4(id)).toBe(true);
    expect(storage.map.get(TELEMETRY_ID_KEY)).toBe(id);
  });

  it('the fallback generator always makes a valid v4', () => {
    for (let i = 0; i < 50; i++) expect(isUuidV4(uuidV4())).toBe(true);
    expect(isUuidV4(uuidV4((b) => b.fill(255)))).toBe(true);
    expect(isUuidV4(uuidV4((b) => b.fill(0)))).toBe(true);
  });
});

describe('turning it off unwrites what it kept', () => {
  it('purge erases the id, the queue and the rollup, and once off nothing more is sent', async () => {
    const { t, sent, storage, setConsent, fail } = make();
    await t.ready();
    fail(503);
    t.startup();
    t.count('replay_hop');
    await t.flush();
    await t.settled();
    expect(storage.map.has(TELEMETRY_ID_KEY)).toBe(true);
    expect(storage.map.has(TELEMETRY_QUEUE_KEY)).toBe(true);
    expect(storage.map.has(TELEMETRY_DAILY_KEY)).toBe(true);

    setConsent(false);
    await t.purge();
    await t.settled();
    expect(storage.map.has(TELEMETRY_ID_KEY)).toBe(false);
    expect(storage.map.has(TELEMETRY_QUEUE_KEY)).toBe(false);
    expect(storage.map.has(TELEMETRY_DAILY_KEY)).toBe(false);

    fail(204);
    const before = sent.length;
    t.startup();
    t.sessionCreated(2);
    await t.flush();
    expect(sent.length).toBe(before);
  });
});

describe('telemetry never fails the product', () => {
  it('swallows a network error', async () => {
    const { t } = make({ postThrows: true });
    await t.ready();
    t.startup();
    await expect(t.flush()).resolves.toBeUndefined();
  });

  it('survives a storage area that throws on every call', async () => {
    const { t } = make({ brokenStorage: true });
    await t.ready();
    t.startup();
    t.count('settle_wait');
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
    expect(junk).toEqual({ os: 'other', arch: 'other', browser: 'other', browser_major: 0, lang: 'other', tz: 14 });
  });

  it('strips a region from a valid language', () => {
    expect(cleanEnv({ lang: 'fr-CA' }).lang).toBe('other');
    expect(cleanEnv({ lang: 'fr' }).lang).toBe('fr');
  });
});

describe('the device profile rides only on the daily beat', () => {
  it('leaves install, update and startup with no env fields', async () => {
    const { t, sent } = make();
    t.setEnv({ os: 'macos', arch: 'arm64', browser: 'chrome', browser_major: 130, lang: 'de', tz: 1 });
    await t.ready();
    t.install();
    t.startup();
    await t.flush();
    expect(envelopes(sent).map((e) => e.data)).toEqual([{}, {}]);
  });

  it('carries a complete env, engagement and configuration on the beat, all bucketed', async () => {
    const { t, sent } = make();
    t.setEnv({ os: 'windows', arch: 'x86-64', browser: 'edge', browser_major: 120, lang: 'en', tz: -5 });
    await t.ready();
    t.active(USAGE);
    await t.flush();
    const e = envelopes(sent)[0]!;
    expect(e.event).toBe('active');
    expect(e.data).toEqual({
      os: 'windows',
      arch: 'x86-64',
      browser: 'edge',
      browser_major: 120,
      lang: 'en',
      tz: -5,
      sessions: '4-6',
      tabs: '7-12',
      since_install: '8-30',
      burners: '1',
      max_session_tabs: '4-6',
      max_session_rules: '100-249',
      tier: 'free',
      posture: 'mirror',
      ask_new: true,
      quiet: '2-3',
    });
    expect(JSON.stringify(e.data)).not.toMatch(/"(9|20|120)"/);
  });

  it('still sends a complete, valid env when none could be read', async () => {
    const { t, sent } = make();
    await t.ready();
    t.active(USAGE);
    await t.flush();
    expect(envelopes(sent)[0]!.data).toMatchObject({
      os: 'other',
      arch: 'other',
      browser: 'other',
      browser_major: 0,
      lang: 'other',
      tz: 0,
    });
  });
});
