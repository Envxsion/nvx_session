/**
 * ------------------------------------------------------------------
 *  Title    |  Telemetry queue, batching and daily rollups
 *  Ref      |  kernel/telemetry.ts
 *  ID       |  test (telemetry queue)
 * ------------------------------------------------------------------
 *  Purpose  |  Pins the v3 delivery rules: nothing goes out without a
 *           |  real id, the queue survives the worker, batches fit the
 *           |  server's limits, a failure is retried once, faults and
 *           |  exceptions are sent once a day, and hot-path counters
 *           |  roll up into one daily set.
 *  Note     |  Also pins the sign-in provider allowlist: only a member
 *           |  of IDENTITY_PROVIDERS or "other" can be sent, and the
 *           |  list itself is snapshotted so a change to it is a
 *           |  deliberate change to the server enum too.
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';
import {
  DAILY_COUNTERS,
  FLUSH_AT,
  MAX_BATCH,
  MAX_BODY_BYTES,
  TELEMETRY_IDPS,
  TELEMETRY_QUEUE_KEY,
  errorKind,
  idpOf,
  majorMinor,
  msBucket,
  percentile,
  wideBucket,
} from '../src/kernel/telemetry.js';
import { IDENTITY_PROVIDERS } from '../src/netfilter/compile.js';
import { DAY_MS, envelopes, fakeStorage, make } from './telemetry-fakes.js';

describe('nothing goes out under a placeholder id', () => {
  it('holds events recorded before ready, then sends them with the real id', async () => {
    const { t, sent } = make();
    t.install();
    t.startup();
    await t.flush();
    expect(sent).toHaveLength(0);
    await t.ready();
    await t.flush();
    const all = envelopes(sent);
    expect(all.map((e) => e.event)).toEqual(['install', 'startup']);
    expect(JSON.stringify(all)).not.toContain('pending');
  });
});

describe('the queue survives the worker', () => {
  it('a new instance on the same storage sends what the old one queued', async () => {
    const storage = fakeStorage();
    const first = make({ storage });
    first.t.startup();
    first.t.sessionCreated(2);
    await first.t.settled();
    expect((storage.map.get(TELEMETRY_QUEUE_KEY) as { items: unknown[] }).items).toHaveLength(2);

    // The worker died before flushing. A new one wakes and boots.
    const second = make({ storage });
    await second.t.ready();
    second.t.feature('pause');
    await second.t.flush();
    const all = envelopes(second.sent);
    expect(all.map((e) => e.event)).toEqual(['startup', 'session_created', 'feature_used']);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((storage.map.get(TELEMETRY_QUEUE_KEY) as { items: unknown[] }).items).toHaveLength(0);
  });
});

describe('batches fit the server', () => {
  it('cuts at the envelope ceiling and the body size, and sends everything', async () => {
    const { t, sent } = make();
    await t.ready();
    for (let i = 0; i < 120; i++) t.sessionCreated(i);
    await t.flush();
    expect(sent.length).toBeGreaterThan(2);
    for (const s of sent) {
      expect(s.body.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
      expect(JSON.parse(s.body).batch.length).toBeLessThanOrEqual(MAX_BATCH);
    }
    const seqs = envelopes(sent).map((e) => e.seq as number);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(await t.pending()).toBe(0);
  });

  it('flushes on its own once the queue reaches the threshold', async () => {
    const { t, sent } = make();
    await t.ready();
    for (let i = 0; i < FLUSH_AT - 1; i++) t.feature('pause');
    await t.settled();
    expect(sent).toHaveLength(0);
    t.feature('pause');
    await t.settled();
    await t.flush();
    expect(envelopes(sent)).toHaveLength(FLUSH_AT);
  });
});

describe('a failed send is retried once', () => {
  it('keeps a batch after a 5xx and drops it after a second failure', async () => {
    const { t, sent, fail } = make();
    await t.ready();
    t.startup();
    fail(503);
    await t.flush();
    expect(sent).toHaveLength(1);
    expect(await t.pending()).toBe(1);
    await t.flush();
    expect(sent).toHaveLength(2);
    expect(await t.pending()).toBe(0);
  });

  it('a retry that succeeds sends the same seq, so the server can dedupe it', async () => {
    const { t, sent, fail } = make();
    await t.ready();
    t.startup();
    fail(0);
    await t.flush();
    fail(204);
    await t.flush();
    const all = envelopes(sent);
    expect(all).toHaveLength(2);
    expect(all[0]!.seq).toBe(all[1]!.seq);
    expect(await t.pending()).toBe(0);
  });

  it('drops at once on a status that can never succeed', async () => {
    const { t, fail } = make();
    await t.ready();
    t.startup();
    fail(400);
    await t.flush();
    expect(await t.pending()).toBe(0);
  });

  it('keeps the queue through a network error', async () => {
    const { t } = make({ postThrows: true });
    await t.ready();
    t.startup();
    await t.flush();
    expect(await t.pending()).toBe(1);
  });
});

describe('faults, signals and exceptions go out once a day', () => {
  it('dedupes a burst within a day and sends again the next day', async () => {
    const { t, sent, advance } = make();
    await t.ready();
    for (let i = 0; i < 20; i++) t.error('apply_failed');
    t.error('foreign_cookie');
    await t.flush();
    expect(envelopes(sent).map((e) => (e.data as { category: string }).category)).toEqual([
      'apply_failed',
      'foreign_cookie',
    ]);
    // Recording is asynchronous; let it land on today before the clock moves.
    await t.settled();
    advance(DAY_MS);
    t.error('apply_failed');
    await t.flush();
    expect(envelopes(sent).filter((e) => e.event === 'error')).toHaveLength(3);
  });

  it('the day marker survives a worker restart', async () => {
    const storage = fakeStorage();
    const a = make({ storage });
    await a.t.ready();
    a.t.error('signin_loop');
    await a.t.flush();
    const b = make({ storage });
    await b.t.ready();
    b.t.error('signin_loop');
    await b.t.flush();
    expect(envelopes(b.sent).filter((e) => e.event === 'error')).toHaveLength(0);
  });

  it('reduces an exception to where and a constructor name, never the message', async () => {
    const { t, sent } = make();
    await t.ready();
    t.exception('uncaught', new TypeError('cannot read https://bank.example/?token=SECRET'));
    t.exception('uncaught', new TypeError('again'));
    t.exception('rejection', 'https://bank.example/');
    await t.flush();
    const all = envelopes(sent);
    expect(all.map((e) => e.data)).toEqual([
      { where: 'uncaught', kind: 'TypeError' },
      { where: 'rejection', kind: 'Error' },
    ]);
    expect(JSON.stringify(all)).not.toMatch(/bank|SECRET|again/);
  });

  it('maps error constructors onto the closed list', () => {
    class WeirdError extends Error {}
    expect(errorKind(new RangeError('x'))).toBe('RangeError');
    expect(errorKind(new SyntaxError('x'))).toBe('SyntaxError');
    expect(errorKind(new WeirdError('x'))).toBe('Error');
    expect(errorKind({ name: 'TypeError' })).toBe('Error');
    expect(errorKind(undefined)).toBe('Error');
  });
});

describe('hot-path counters roll up into one daily set', () => {
  it('sends nothing until the day ends, then one bucketed daily_counts', async () => {
    const { t, sent, advance } = make();
    await t.ready();
    for (let i = 0; i < 30; i++) t.count('settle_wait');
    t.count('replay_hop', 2);
    t.count('overflow_hosts', 5);
    await t.flush();
    expect(sent).toHaveLength(0);

    // Recording is asynchronous; let it land on today before the clock moves.
    await t.settled();
    advance(DAY_MS);
    await t.flush();
    const all = envelopes(sent);
    expect(all).toHaveLength(1);
    expect(all[0]!.event).toBe('daily_counts');
    expect(all[0]!.data).toEqual({ lag: '1', settle_wait: '13+', replay_hop: '2-3', overflow_hosts: '4-6' });
  });

  it('says how late a rollup is when the browser was closed for days', async () => {
    const { t, sent, advance } = make();
    await t.ready();
    t.count('worker_boots');
    // Recording is asynchronous; let it land on today before the clock moves.
    await t.settled();
    advance(5 * DAY_MS);
    await t.flush();
    expect(envelopes(sent)[0]!.data).toEqual({ lag: '4-6', worker_boots: '1' });
  });

  it('ignores a counter name that is not on the list', async () => {
    const { t, sent, advance } = make();
    await t.ready();
    (t.count as (k: string) => void)('mail.google.com');
    // Recording is asynchronous; let it land on today before the clock moves.
    await t.settled();
    advance(DAY_MS);
    await t.flush();
    expect(sent).toHaveLength(0);
  });

  it('has no counter that could name a site', () => {
    for (const k of DAILY_COUNTERS) expect(k).toMatch(/^[a-z_]+$/);
  });
});

describe('sign-in provider issues name only a provider from the fixed list', () => {
  it('maps hosts by label suffix and everything else to other', () => {
    expect(idpOf('accounts.google.com')).toBe('google.com');
    expect(idpOf('login.microsoftonline.com')).toBe('microsoftonline.com');
    expect(idpOf('acme.okta.com')).toBe('okta.com');
    expect(idpOf('login.yahoo.co.jp')).toBe('yahoo.co.jp');
    expect(idpOf('us-east-1.signin.aws')).toBe('signin.aws');
    expect(idpOf('GOOGLE.COM.')).toBe('google.com');
    expect(idpOf('evilgoogle.com')).toBe('other');
    expect(idpOf('google.com.evil.example')).toBe('other');
    expect(idpOf('moodle.university.edu')).toBe('other');
    expect(idpOf('com')).toBe('other');
    expect(idpOf('')).toBe('other');
  });

  it('every mapped value is a member of IDENTITY_PROVIDERS or other', () => {
    for (const host of ['a.b.github.com', 'x.y', 'login.gov', 'sso.jumpcloud.com', '127.0.0.1']) {
      const out = idpOf(host);
      expect(out === 'other' || IDENTITY_PROVIDERS.has(out)).toBe(true);
    }
  });

  it('rolls up per provider and kind, with counts bucketed and no other host sent', async () => {
    const { t, sent, advance } = make();
    await t.ready();
    t.idpIssue('accounts.google.com', 'loop_stopped');
    t.idpIssue('mail.google.com', 'loop_stopped');
    t.idpIssue('moodle.university.edu', 'replay_exhausted');
    t.idpIssue('acme.okta.com', 'hold_timeout');
    // Recording is asynchronous; let it land on today before the clock moves.
    await t.settled();
    advance(DAY_MS);
    await t.flush();
    const issues = envelopes(sent).filter((e) => e.event === 'idp_issue').map((e) => e.data);
    expect(issues).toEqual([
      { lag: '1', idp: 'google.com', kind: 'loop_stopped', count: '2-3' },
      { lag: '1', idp: 'other', kind: 'replay_exhausted', count: '1' },
      { lag: '1', idp: 'okta.com', kind: 'hold_timeout', count: '1' },
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/moodle|university|accounts\.|acme/);
  });

  it('pins the provider list, which the server enum mirrors', () => {
    expect(TELEMETRY_IDPS).toMatchInlineSnapshot(`
      [
        "alipay.com",
        "amazon.com",
        "apple.com",
        "atlassian.com",
        "auth0.com",
        "awsapps.com",
        "cloudflareaccess.com",
        "duosecurity.com",
        "facebook.com",
        "force.com",
        "github.com",
        "google.com",
        "jumpcloud.com",
        "kakao.com",
        "line.me",
        "live.com",
        "login.gov",
        "mail.ru",
        "microsoft.com",
        "microsoftonline-p.com",
        "microsoftonline.com",
        "msauth.net",
        "msftauth.net",
        "naver.com",
        "okta-emea.com",
        "okta-gov.com",
        "okta.com",
        "oktacdn.com",
        "oktapreview.com",
        "onelogin.com",
        "pingidentity.com",
        "pingone.com",
        "qq.com",
        "salesforce.com",
        "signin.aws",
        "taobao.com",
        "vk.com",
        "yahoo.co.jp",
        "yahoo.com",
        "yandex.com",
        "yandex.ru",
        "youtube.com",
      ]
    `);
  });
});

describe('perf rolls up timings as percentile buckets', () => {
  it('sends p50 and p95 buckets and the patch high-water mark, never a raw time', async () => {
    const { t, sent, advance } = make();
    await t.ready();
    for (let i = 1; i <= 100; i++) t.timing('flush', i);
    t.timing('boot', 420);
    t.patchRules(3);
    t.patchRules(12);
    t.patchRules(5);
    // Recording is asynchronous; let it land on today before the clock moves.
    await t.settled();
    advance(DAY_MS);
    await t.flush();
    const perf = envelopes(sent).find((e) => e.event === 'perf')!;
    expect(perf.data).toEqual({
      lag: '1',
      flush_n: '13+',
      flush_p50: '50-99',
      flush_p95: '50-99',
      boot_n: '1',
      boot_p50: '250-499',
      boot_p95: '250-499',
      patch_rules: '10-49',
    });
  });

  it('sends no perf event for a day with nothing measured', async () => {
    const { t, sent, advance } = make();
    await t.ready();
    t.count('replay_hop');
    // Recording is asynchronous; let it land on today before the clock moves.
    await t.settled();
    advance(DAY_MS);
    await t.flush();
    expect(envelopes(sent).some((e) => e.event === 'perf')).toBe(false);
  });
});

describe('the bucket helpers', () => {
  it('coarsen milliseconds, wide counts and versions', () => {
    expect(msBucket(Number.NaN)).toBe('none');
    expect(msBucket(3)).toBe('<10');
    expect(msBucket(49)).toBe('10-49');
    expect(msBucket(999)).toBe('500-999');
    expect(msBucket(5000)).toBe('3000+');
    expect(wideBucket(0)).toBe('0');
    expect(wideBucket(9)).toBe('1-9');
    expect(wideBucket(320)).toBe('250-499');
    expect(wideBucket(10_000)).toBe('500+');
    expect(majorMinor('2.10.3')).toBe('2.10');
    expect(majorMinor('')).toBe('0.0');
  });

  it('percentile is nearest rank and empty is NaN', () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });
});
