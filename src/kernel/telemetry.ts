/**
 * ------------------------------------------------------------------
 *  Title    |  Anonymous usage counts
 *  Ref      |  persist.ts, TELEMETRY.md, the private telemetry server brief
 *  ID       |  Telemetry
 * ------------------------------------------------------------------
 *  Purpose  |  Opt-in, coarse usage counts, built so the product
 *           |  cannot leak what it exists to protect. No personal data.
 *  Guards   |  Two switches gate every send, both must be on: user
 *           |  consent (off by default), and a configured endpoint
 *           |  (absent outside the store build). What can be sent is an
 *           |  allowlist: bucketed counts, closed enums, booleans,
 *           |  sanitised slugs. No method takes a free-form string that
 *           |  reaches a payload, so a URL, domain, cookie or label has
 *           |  no path out. The one method that takes a host (idpIssue)
 *           |  maps it onto a fixed list of sign-in providers first and
 *           |  sends "other" for anything off that list. The tests pin
 *           |  both.
 *  How      |  Events go into a queue held in storage, so a worker that
 *           |  dies between an event and a send loses nothing. The
 *           |  queue is sent in batches when the caller flushes (boot,
 *           |  the daily beat, a full queue), never with a placeholder
 *           |  id, and a failed batch is tried once more. Hot paths do
 *           |  not send at all: they bump a counter for the day, and
 *           |  the day goes out as one daily_counts, idp_issue and perf
 *           |  set when it rolls over.
 *  Note     |  Nothing here can fail the product: every storage and
 *           |  network path swallows its error.
 *  Author   |  Ojas Kekre, 24/08/2026 (v3 queue and daily rollups 03/10/2026)
 * ------------------------------------------------------------------
 */

import type { StorageArea } from './persist.js';
import { IDENTITY_PROVIDERS } from '../netfilter/compile.js';

/** Where the durable, anonymous install id lives. */
export const TELEMETRY_ID_KEY = 'nvx.telemetry.id';
/** The unsent events, and the sequence counter that numbers them. */
export const TELEMETRY_QUEUE_KEY = 'nvx.telemetry.queue';
/** Today's counters, timings and once-a-day markers. */
export const TELEMETRY_DAILY_KEY = 'nvx.telemetry.daily';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The wire-format version, sent on every batch.
 *  Note     |  3 adds channel and seq to the envelope, drops the env
 *           |  block from install, update and startup, and adds the
 *           |  daily rollup events. See the server brief.
 * ------------------------------------------------------------------
 */
export const TELEMETRY_SCHEMA = 3;

/** The server's batch ceiling. A batch is cut at whichever limit comes first. */
export const MAX_BATCH = 50;
/** The server rejects a body over 8 KiB; this leaves room for the wrapper. */
export const MAX_BODY_BYTES = 7600;
/** A queue this long is flushed at once rather than waiting for the next beat. */
export const FLUSH_AT = 50;
/** The queue is capped so a profile that never reaches the server stays small. */
export const MAX_QUEUE = 200;
/** One send, plus one retry. A batch that fails twice is dropped. */
export const MAX_TRIES = 2;
/** Timing samples kept per day, oldest dropped first. */
const MAX_SAMPLES = 400;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The closed set of events.
 *  Note     |  Anything not here cannot be sent, because there is no
 *           |  method to send it.
 * ------------------------------------------------------------------
 */
export type TelemetryEvent =
  | 'install'
  | 'update'
  | 'startup'
  | 'active'
  | 'session_created'
  | 'posture_changed'
  | 'feature_used'
  | 'error'
  | 'daily_counts'
  | 'idp_issue'
  | 'perf'
  | 'exception';

/** Store installs, or a developer's unpacked build, which the dashboard filters out. */
export type TelemetryChannel = 'store' | 'dev';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The device profile, sent so the operator sees the shape
 *           |  of the audience without seeing a person in it.
 *  Note     |  Every field is deliberately coarse: OS, arch and browser
 *           |  are closed enums; the browser version is the major only;
 *           |  the language is the primary subtag; the timezone is a
 *           |  whole-hour offset. Rides only on the daily beat.
 * ------------------------------------------------------------------
 */
export type TelemetryOS = 'windows' | 'macos' | 'linux' | 'chromeos' | 'android' | 'other';
export type TelemetryArch = 'x86-64' | 'arm64' | 'x86-32' | 'other';
export type TelemetryBrowser =
  | 'chrome'
  | 'opera'
  | 'edge'
  | 'brave'
  | 'vivaldi'
  | 'arc'
  | 'other';

export interface TelemetryEnv {
  os: TelemetryOS;
  arch: TelemetryArch;
  browser: TelemetryBrowser;
  /** Major version only, e.g. 128. Zero when it could not be read. */
  browser_major: number;
  /** Primary language subtag, e.g. "en". No region, so no "en-AU". */
  lang: string;
  /** Whole-hour UTC offset, e.g. -5 or 10. A coarse region signal, not a place. */
  tz: number;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  What the daily beat is handed: raw readings, bucketed
 *           |  here.
 *  Note     |  Raw in, buckets out, so a caller cannot put an exact
 *           |  number on the wire by passing it pre-formatted.
 * ------------------------------------------------------------------
 */
export interface TelemetryUsage {
  sessions: number;
  tabs: number;
  sinceInstallDays: number;
  burners: number;
  maxSessionTabs: number;
  maxSessionRules: number;
  tier: 'free' | 'pro';
  posture: TelemetryPosture;
  askNewSites: boolean;
  quiet: number;
}

export type TelemetryPosture = 'mirror' | 'standardize' | 'persona';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The closed set of features a feature_used event may
 *           |  name.
 * ------------------------------------------------------------------
 */
export type TelemetryFeature =
  | 'bulk_move'
  | 'undo_move'
  | 'sign_in'
  | 'context_move'
  | 'key_move'
  | 'release'
  | 'pause';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The closed set of error categories, split by meaning.
 *  Note     |  A fault is the extension failing at something it tried.
 *           |  A signal is the extension working and seeing something
 *           |  worth a rate: a session over its rule budget, a sign-in
 *           |  loop it broke, a real foreign cookie. Both go out at
 *           |  most once per install per day, so a daily count of
 *           |  installs is an incidence rate, not a storm.
 * ------------------------------------------------------------------
 */
export type TelemetryFault =
  | 'boot_failed'
  | 'flush_failed'
  | 'apply_failed'
  | 'compile_failed'
  | 'adopt_failed';
export type TelemetrySignal = 'rule_overflow' | 'signin_loop' | 'foreign_cookie';
export type TelemetryError = TelemetryFault | TelemetrySignal;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The counters rolled up into one daily_counts event.
 *  Note     |  Each is sent as a bucket, and only when non-zero, so a
 *           |  missing key on the server means zero.
 * ------------------------------------------------------------------
 */
export const DAILY_COUNTERS = [
  'worker_boots',
  'replay_hop',
  'replay_chain',
  'hold_redirect',
  'hold_ready',
  'hold_committed',
  'hold_timeout',
  'settle_wait',
  'loop_released',
  'loop_idp_stopped',
  'loop_suppressed',
  'overflow_events',
  'overflow_hosts',
  'foreign_real',
  'foreign_transient',
  'apply_failed',
  'picker_shown_new',
  'picker_shown_multi',
  'pick_chosen',
  'pick_created',
  'pick_remember',
  'pick_quiet',
  'pick_unmanaged',
  'burner_created',
  'adopt_run',
  'sync_enable',
  'sync_now',
  'release_manual',
] as const;
export type DailyCounter = (typeof DAILY_COUNTERS)[number];

/** What went wrong with a sign-in provider, never which account or page. */
export const IDP_ISSUE_KINDS = ['loop_stopped', 'replay_exhausted', 'hold_timeout', 'overflow'] as const;
export type IdpIssueKind = (typeof IDP_ISSUE_KINDS)[number];

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The only provider names idp_issue can carry.
 *  Note     |  Mirrors IDENTITY_PROVIDERS, the list the rule compiler
 *           |  already treats as sign-in providers, plus "other". A
 *           |  change to that list changes the wire vocabulary, which
 *           |  a test pins so the server enum is updated with it.
 * ------------------------------------------------------------------
 */
export const TELEMETRY_IDPS: readonly string[] = [...IDENTITY_PROVIDERS].sort();
const IDP_SET: ReadonlySet<string> = new Set(TELEMETRY_IDPS);

/** Where an uncaught error was caught. */
export const EXCEPTION_WHERE = ['uncaught', 'rejection'] as const;
export type ExceptionWhere = (typeof EXCEPTION_WHERE)[number];
/** The constructor names an exception is reduced to. Never a message or stack. */
export const EXCEPTION_KINDS = [
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'DOMException',
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** The only value types a payload field may hold. No objects, no arrays. */
type Scalar = string | number | boolean;

export interface TelemetryEnvelope {
  /** A random UUID v4 generated once per install, tied to no identity. */
  id: string;
  /** The build version, from the manifest. */
  v: string;
  /** Manifest version, 2 or 3, so the two platforms can be told apart. */
  mv: 2 | 3;
  /** Store install or developer build. */
  channel: TelemetryChannel;
  /** Per-install sequence number, so a retried batch can be deduped. */
  seq: number;
  event: TelemetryEvent;
  at: number;
  data: Record<string, Scalar>;
}

/** An event waiting in the queue. The id is stamped only at send time. */
interface Queued {
  seq: number;
  v: string;
  event: TelemetryEvent;
  at: number;
  data: Record<string, Scalar>;
  tries: number;
}

interface QueueState {
  seq: number;
  items: Queued[];
}

/** One day's rollup. Held in storage so a worker restart keeps the count going. */
interface DailyState {
  day: string;
  counts: Partial<Record<DailyCounter, number>>;
  /** Keyed "idp|kind". The idp has already been mapped onto the allowlist. */
  idp: Record<string, number>;
  flush: number[];
  boot: number[];
  patch: number;
  /** Fault, signal and exception keys already sent today. */
  once: string[];
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Everything this module needs from the outside, injected.
 *  Note     |  Holds no reference to chrome, so it runs unchanged
 *           |  under a test.
 * ------------------------------------------------------------------
 */
export interface TelemetryPorts {
  storage: StorageArea;
  /** The ingest URL, or null when the build was given none. */
  endpoint: () => string | null;
  /** Whether the user has consented. */
  consented: () => boolean;
  /**
   * POST the body to the URL and resolve with the HTTP status. Rejects on a
   * network failure, which is retried like a 5xx.
   */
  post: (url: string, body: string) => Promise<number>;
  now: () => number;
  /** A fresh UUID v4. A non-UUID is replaced by a locally made one. */
  newId: () => string;
  /** Store or dev, read at send time. */
  channel: () => TelemetryChannel;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Bucket a raw count into a coarse range.
 *  Note     |  The exact count edges toward a fingerprint, so it is
 *           |  never sent; the bucket is. Ranges are wide on purpose.
 * ------------------------------------------------------------------
 */
export function bucket(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 3) return '2-3';
  if (n <= 6) return '4-6';
  if (n <= 12) return '7-12';
  return '13+';
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Bucket a count that runs into the hundreds, such as a
 *           |  session's rule count.
 * ------------------------------------------------------------------
 */
export function wideBucket(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 10) return '1-9';
  if (n < 50) return '10-49';
  if (n < 100) return '50-99';
  if (n < 250) return '100-249';
  if (n < 500) return '250-499';
  return '500+';
}

/** Bucket a duration in milliseconds. "none" when nothing was measured. */
export function msBucket(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'none';
  if (ms < 10) return '<10';
  if (ms < 50) return '10-49';
  if (ms < 100) return '50-99';
  if (ms < 250) return '100-249';
  if (ms < 500) return '250-499';
  if (ms < 1000) return '500-999';
  if (ms < 3000) return '1000-2999';
  return '3000+';
}

/** The nearest-rank percentile of a sample, or NaN when it is empty. */
export function percentile(samples: readonly number[], p: number): number {
  const xs = samples.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return Number.NaN;
  const rank = Math.min(xs.length, Math.max(1, Math.ceil((p / 100) * xs.length)));
  return xs[rank - 1]!;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Reduce an error label to a bare slug.
 *  Note     |  A backstop for a caller who casts around a closed type:
 *           |  lowercased, non-alphanumerics dropped, truncated hard,
 *           |  so a URL's identifying punctuation cannot survive.
 * ------------------------------------------------------------------
 */
export function slug(raw: string): string {
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'unknown';
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Bucket days-since-install into retention cohorts.
 * ------------------------------------------------------------------
 */
export function daysBucket(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '0';
  if (days <= 1) return '1';
  if (days <= 7) return '2-7';
  if (days <= 30) return '8-30';
  if (days <= 90) return '31-90';
  return '90+';
}

/** Major and minor of a version, e.g. "1.4" from "1.4.2.7". "0.0" when unreadable. */
export function majorMinor(version: unknown): string {
  const m = /^(\d{1,5})\.(\d{1,5})/.exec(String(version ?? ''));
  return m ? `${Number(m[1])}.${Number(m[2])}` : '0.0';
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Map a host onto the sign-in provider list.
 *  How      |  Walks the host's label suffixes, so accounts.google.com
 *           |  maps to google.com and a lookalike such as
 *           |  evilgoogle.com maps to nothing. Anything not on the list
 *           |  comes back "other", so no other domain can be sent.
 * ------------------------------------------------------------------
 */
export function idpOf(host: unknown): string {
  const labels = String(host ?? '')
    .toLowerCase()
    .replace(/\.$/, '')
    .split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    if (IDP_SET.has(candidate)) return candidate;
  }
  return 'other';
}

/** An error reduced to its constructor name, from a closed list. Never its message. */
export function errorKind(err: unknown): ExceptionKind {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) return 'DOMException';
  if (err instanceof Error) {
    const name = err.constructor?.name ?? err.name;
    return (EXCEPTION_KINDS as readonly string[]).includes(name) ? (name as ExceptionKind) : 'Error';
  }
  return 'Error';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether a string is a lowercase UUID v4, the only id shape the server accepts. */
export function isUuidV4(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A UUID v4 without crypto.randomUUID.
 *  Note     |  Uses getRandomValues when present and Math.random only
 *           |  as a last resort. Either way the result is a valid v4,
 *           |  which is what the server checks; it identifies nothing.
 * ------------------------------------------------------------------
 */
export function uuidV4(fill?: (bytes: Uint8Array) => void): string {
  const b = new Uint8Array(16);
  const g = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (fill) fill(b);
  else if (typeof g?.getRandomValues === 'function') g.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const OS_SET = new Set<TelemetryOS>(['windows', 'macos', 'linux', 'chromeos', 'android', 'other']);
const ARCH_SET = new Set<TelemetryArch>(['x86-64', 'arm64', 'x86-32', 'other']);
const BROWSER_SET = new Set<TelemetryBrowser>([
  'chrome',
  'opera',
  'edge',
  'brave',
  'vivaldi',
  'arc',
  'other',
]);
const POSTURE_SET = new Set<TelemetryPosture>(['mirror', 'standardize', 'persona']);

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Force an env object onto the allowlist, whatever it was
 *           |  handed.
 *  Note     |  Every field is coerced to its closed set or coarsened,
 *           |  so an empty or fabricated env still produces a complete,
 *           |  valid block rather than a missing one.
 * ------------------------------------------------------------------
 */
export function cleanEnv(raw: Partial<TelemetryEnv>): TelemetryEnv {
  const lang = String(raw.lang ?? '').toLowerCase();
  const tz = Number(raw.tz);
  return {
    os: OS_SET.has(raw.os as TelemetryOS) ? (raw.os as TelemetryOS) : 'other',
    arch: ARCH_SET.has(raw.arch as TelemetryArch) ? (raw.arch as TelemetryArch) : 'other',
    browser: BROWSER_SET.has(raw.browser as TelemetryBrowser)
      ? (raw.browser as TelemetryBrowser)
      : 'other',
    browser_major:
      Number.isFinite(raw.browser_major) && (raw.browser_major as number) > 0
        ? Math.min(999, Math.floor(raw.browser_major as number))
        : 0,
    lang: /^[a-z]{2,3}$/.test(lang) ? lang : 'other',
    tz: Number.isFinite(tz) ? Math.max(-14, Math.min(14, Math.round(tz))) : 0,
  };
}

/** The UTC calendar day of a timestamp, as YYYY-MM-DD. */
function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function freshDaily(day: string): DailyState {
  return { day, counts: {}, idp: {}, flush: [], boot: [], patch: 0, once: [] };
}

/** Accept a stored rollup only if it has the shape this build writes. */
function readDaily(raw: unknown): DailyState | null {
  const r = raw as Partial<DailyState> | undefined;
  if (!r || typeof r.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.day)) return null;
  return {
    day: r.day,
    counts: r.counts && typeof r.counts === 'object' ? { ...r.counts } : {},
    idp: r.idp && typeof r.idp === 'object' ? { ...r.idp } : {},
    flush: Array.isArray(r.flush) ? r.flush.filter((x) => typeof x === 'number').slice(-MAX_SAMPLES) : [],
    boot: Array.isArray(r.boot) ? r.boot.filter((x) => typeof x === 'number').slice(-MAX_SAMPLES) : [],
    patch: typeof r.patch === 'number' ? r.patch : 0,
    once: Array.isArray(r.once) ? r.once.filter((x) => typeof x === 'string') : [],
  };
}

function readQueue(raw: unknown): QueueState {
  const r = raw as Partial<QueueState> | undefined;
  const seq = typeof r?.seq === 'number' && Number.isFinite(r.seq) ? r.seq : 0;
  const items = Array.isArray(r?.items)
    ? r!.items.filter(
        (q): q is Queued =>
          !!q && typeof q.seq === 'number' && typeof q.event === 'string' && typeof q.data === 'object'
      )
    : [];
  return { seq, items: items.slice(-MAX_QUEUE) };
}

/** Statuses that will never succeed on a resend, so the batch is dropped at once. */
function permanent(status: number): boolean {
  return status === 400 || status === 413 || status === 415 || status === 422;
}

export class Telemetry {
  private id: string | null = null;
  private env: TelemetryEnv | null = null;
  private queue: QueueState = { seq: 0, items: [] };
  private daily: DailyState | null = null;
  private loaded = false;
  /** Every storage-touching step runs on this chain, one at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  private flushing: Promise<void> | null = null;
  private saving = false;
  private saveAgain = false;
  private patchSeen = { day: '', n: 0 };

  constructor(
    private readonly ports: TelemetryPorts,
    private readonly meta: { version: string; mv: 2 | 3 }
  ) {}

  /** Both switches on: the user agreed and the build has somewhere to send to. */
  private live(): boolean {
    return this.ports.consented() && Boolean(this.ports.endpoint());
  }

  /** Run a step after every step before it, swallowing its failure. */
  private run(step: () => Promise<void> | void): Promise<void> {
    const next = this.chain.then(step, step).catch(() => undefined);
    this.chain = next;
    return next;
  }

  /** Resolves once everything recorded so far has been applied. For tests and shutdown paths. */
  settled(): Promise<void> {
    return this.run(() => undefined);
  }

  /** Read the queue and today's rollup once, then roll the day over if it changed. */
  private async load(): Promise<void> {
    if (!this.loaded) {
      try {
        const held = await this.ports.storage.get([TELEMETRY_QUEUE_KEY, TELEMETRY_DAILY_KEY]);
        // Merged, not replaced: anything recorded before the read finished stays.
        const stored = readQueue(held[TELEMETRY_QUEUE_KEY]);
        this.queue = {
          seq: Math.max(stored.seq, this.queue.seq),
          items: [...stored.items, ...this.queue.items].slice(-MAX_QUEUE),
        };
        this.daily = readDaily(held[TELEMETRY_DAILY_KEY]) ?? this.daily;
      } catch {
        /* an unreadable store starts empty */
      }
      this.loaded = true;
    }
    // Off means nothing new is made, not even yesterday's rollup.
    if (this.live()) this.rollover();
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Close out a finished day: its counters, provider issues
   *           |  and timings become events, and a fresh day begins.
   *  Note     |  lag says how many days ago the rollup was for, since a
   *           |  browser left closed for a week rolls over late.
   * ------------------------------------------------------------------
   */
  private rollover(): void {
    const today = dayOf(this.ports.now());
    const d = this.daily;
    if (d && d.day === today) return;
    this.daily = freshDaily(today);
    if (!d) return;
    const lag = Math.max(1, Math.round((Date.parse(today) - Date.parse(d.day)) / 86_400_000));
    const counts: Record<string, Scalar> = {};
    for (const key of DAILY_COUNTERS) {
      const n = d.counts[key] ?? 0;
      if (n > 0) counts[key] = bucket(n);
    }
    if (Object.keys(counts).length) this.push('daily_counts', { lag: bucket(lag), ...counts });
    for (const [key, n] of Object.entries(d.idp)) {
      const [idp, kind] = key.split('|');
      if (!idp || !kind || !(IDP_ISSUE_KINDS as readonly string[]).includes(kind)) continue;
      if (idp !== 'other' && !IDP_SET.has(idp)) continue;
      this.push('idp_issue', { lag: bucket(lag), idp, kind, count: bucket(n) });
    }
    if (d.flush.length || d.boot.length || d.patch > 0) {
      this.push('perf', {
        lag: bucket(lag),
        flush_n: bucket(d.flush.length),
        flush_p50: msBucket(percentile(d.flush, 50)),
        flush_p95: msBucket(percentile(d.flush, 95)),
        boot_n: bucket(d.boot.length),
        boot_p50: msBucket(percentile(d.boot, 50)),
        boot_p95: msBucket(percentile(d.boot, 95)),
        patch_rules: wideBucket(d.patch),
      });
    }
    this.saveQueue();
    this.saveDaily();
  }

  /** Add an envelope to the in-memory queue. Callers persist. */
  private push(event: TelemetryEvent, data: Record<string, Scalar>): void {
    this.queue.seq += 1;
    this.queue.items.push({ seq: this.queue.seq, v: this.meta.version, event, at: this.ports.now(), data, tries: 0 });
    if (this.queue.items.length > MAX_QUEUE) this.queue.items.splice(0, this.queue.items.length - MAX_QUEUE);
  }

  private saveQueue(): void {
    void this.ports.storage.set({ [TELEMETRY_QUEUE_KEY]: this.queue }).catch(() => undefined);
  }

  /** Coalesced: a burst of counter bumps costs one write in flight and one after it. */
  private saveDaily(): void {
    if (!this.daily) return;
    if (this.saving) {
      this.saveAgain = true;
      return;
    }
    this.saving = true;
    void (async () => {
      do {
        this.saveAgain = false;
        if (!this.daily) break;
        try {
          await this.ports.storage.set({ [TELEMETRY_DAILY_KEY]: this.daily });
        } catch {
          /* the next bump writes it again */
        }
      } while (this.saveAgain);
      this.saving = false;
    })();
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Load the install id, minting one on first use.
   *  Note     |  Never runs while telemetry is off, so a profile that
   *           |  never consents never gets an id written. A stored id
   *           |  that is not a UUID v4 (an older fallback) is replaced.
   * ------------------------------------------------------------------
   */
  async ready(): Promise<void> {
    if (this.id || !this.live()) return;
    try {
      const held = await this.ports.storage.get([TELEMETRY_ID_KEY]);
      let id = held[TELEMETRY_ID_KEY];
      if (!isUuidV4(id)) {
        const minted = String(this.ports.newId()).toLowerCase();
        id = isUuidV4(minted) ? minted : uuidV4();
        await this.ports.storage.set({ [TELEMETRY_ID_KEY]: id });
      }
      this.id = id as string;
    } catch {
      /* no id, no sends; the queue waits */
    }
  }

  private enqueue(event: TelemetryEvent, data: Record<string, Scalar>): void {
    if (!this.live()) return;
    void this.run(async () => {
      await this.load();
      this.push(event, data);
      this.saveQueue();
      if (this.queue.items.length >= FLUSH_AT) void this.flush();
    });
  }

  /** Touch today's rollup, if telemetry is on. */
  private withDay(edit: (d: DailyState) => void): void {
    if (!this.live()) return;
    void this.run(async () => {
      await this.load();
      edit(this.daily!);
      this.saveDaily();
    });
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Send an event at most once per install per day.
   *  Note     |  The marker lives in the daily rollup, so it survives
   *           |  the worker and resets with the day.
   * ------------------------------------------------------------------
   */
  private once(key: string, event: TelemetryEvent, data: Record<string, Scalar>): void {
    if (!this.live()) return;
    void this.run(async () => {
      await this.load();
      const d = this.daily!;
      if (d.once.includes(key)) return;
      d.once.push(key);
      this.saveDaily();
      this.push(event, data);
      this.saveQueue();
    });
  }

  /** Record the device profile, cleaned onto the allowlist, for the daily beat. */
  setEnv(env: Partial<TelemetryEnv>): void {
    this.env = cleanEnv(env);
  }

  // The typed events. Each builds its own payload from allowlisted values.

  install(): void {
    this.enqueue('install', {});
  }

  /** A version change. Only the major.minor it came from, never more. */
  update(from: string): void {
    this.enqueue('update', { from: majorMinor(from) });
  }

  startup(): void {
    this.enqueue('startup', {});
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  The once-a-day heartbeat: device profile plus the
   *           |  engagement, retention and configuration buckets.
   *  Note     |  The env is always complete: an env that could not be
   *           |  read goes out as "other" and zero rather than missing.
   * ------------------------------------------------------------------
   */
  active(u: TelemetryUsage): void {
    this.enqueue('active', {
      ...cleanEnv(this.env ?? {}),
      sessions: bucket(u.sessions),
      tabs: bucket(u.tabs),
      since_install: daysBucket(u.sinceInstallDays),
      burners: bucket(u.burners),
      max_session_tabs: bucket(u.maxSessionTabs),
      max_session_rules: wideBucket(u.maxSessionRules),
      tier: u.tier === 'pro' ? 'pro' : 'free',
      posture: POSTURE_SET.has(u.posture) ? u.posture : 'mirror',
      ask_new: u.askNewSites === true,
      quiet: bucket(u.quiet),
    });
  }

  /** How many sessions exist, as a bucket, never the exact number or which. */
  sessionCreated(total: number): void {
    this.enqueue('session_created', { sessions: bucket(total) });
  }

  postureChanged(posture: TelemetryPosture): void {
    this.enqueue('posture_changed', { posture: POSTURE_SET.has(posture) ? posture : 'mirror' });
  }

  feature(name: TelemetryFeature): void {
    this.enqueue('feature_used', { feature: name });
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Record a fault or signal by category, once a day.
   *  Note     |  slug runs anyway, a backstop against a caller who
   *           |  casts around the type.
   * ------------------------------------------------------------------
   */
  error(category: TelemetryError): void {
    const c = slug(category);
    this.once(`error:${c}`, 'error', { category: c });
  }

  /** Bump a daily counter. Nothing leaves until the day rolls over. */
  count(key: DailyCounter, n = 1): void {
    if (!(DAILY_COUNTERS as readonly string[]).includes(key) || !(n > 0)) return;
    this.withDay((d) => {
      d.counts[key] = (d.counts[key] ?? 0) + Math.floor(n);
    });
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Count a sign-in provider having trouble.
   *  Note     |  The host is mapped onto the fixed provider list here,
   *           |  before anything is stored, so only a list member or
   *           |  "other" is ever written or sent.
   * ------------------------------------------------------------------
   */
  idpIssue(host: string, kind: IdpIssueKind): void {
    if (!(IDP_ISSUE_KINDS as readonly string[]).includes(kind)) return;
    const key = `${idpOf(host)}|${kind}`;
    this.withDay((d) => {
      d.idp[key] = (d.idp[key] ?? 0) + 1;
    });
  }

  /** A timing sample for the daily perf rollup. */
  timing(kind: 'flush' | 'boot', ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.withDay((d) => {
      const list = kind === 'flush' ? d.flush : d.boot;
      list.push(Math.round(ms));
      if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
    });
  }

  /** The day's high-water mark of live fast-path patch rules. */
  patchRules(n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    // Called on a hot path, so a reading no higher than today's peak so far
    // costs nothing.
    const day = dayOf(this.ports.now());
    if (this.patchSeen.day === day && n <= this.patchSeen.n) return;
    this.patchSeen = { day, n };
    this.withDay((d) => {
      d.patch = Math.max(d.patch, Math.floor(n));
    });
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Record an uncaught error by where and what kind.
   *  Note     |  Only the constructor name, from a closed list. The
   *           |  message and stack can carry a URL, so neither is read.
   * ------------------------------------------------------------------
   */
  exception(where: ExceptionWhere, err: unknown): void {
    const w: ExceptionWhere = (EXCEPTION_WHERE as readonly string[]).includes(where) ? where : 'uncaught';
    const kind = errorKind(err);
    this.once(`exception:${w}:${kind}`, 'exception', { where: w, kind });
  }

  /** How many events are waiting. For tests and the flush threshold. */
  async pending(): Promise<number> {
    await this.run(() => this.load());
    return this.queue.items.length;
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Send what is queued, in batches the server accepts.
   *  How      |  Waits for the id: nothing goes out under a placeholder.
   *           |  A batch is cut at MAX_BATCH envelopes or MAX_BODY_BYTES.
   *           |  A 2xx removes it; a status that can never succeed drops
   *           |  it; anything else leaves it for one more try on the
   *           |  next flush, then drops it.
   *  Note     |  Silent on every failure, and a no-op when either
   *           |  switch is off, so a caller can flush freely.
   * ------------------------------------------------------------------
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    if (!this.live()) return;
    await this.run(() => this.load());
    for (let round = 0; round < 8; round++) {
      const url = this.ports.endpoint();
      if (!this.live() || !url || !this.id || !this.queue.items.length) return;
      const { taken, body, oversized } = this.cut(this.id);
      if (oversized.length) await this.run(() => this.drop(oversized));
      if (!taken.length) continue;
      let status = 0;
      try {
        status = await this.ports.post(url, body);
      } catch {
        status = 0;
      }
      if ((status >= 200 && status < 300) || permanent(status)) {
        await this.run(() => this.drop(taken));
        continue;
      }
      await this.run(() => {
        const seqs = new Set(taken);
        for (const q of this.queue.items) if (seqs.has(q.seq)) q.tries += 1;
        this.queue.items = this.queue.items.filter((q) => q.tries < MAX_TRIES);
        this.saveQueue();
      });
      return;
    }
  }

  private drop(seqs: number[]): void {
    const gone = new Set(seqs);
    this.queue.items = this.queue.items.filter((q) => !gone.has(q.seq));
    this.saveQueue();
  }

  /** The next batch: as many queued envelopes as fit both limits. */
  private cut(id: string): { taken: number[]; body: string; oversized: number[] } {
    const channel: TelemetryChannel = this.ports.channel() === 'dev' ? 'dev' : 'store';
    const batch: TelemetryEnvelope[] = [];
    const taken: number[] = [];
    const oversized: number[] = [];
    let body = '';
    for (const q of this.queue.items) {
      if (batch.length >= MAX_BATCH) break;
      const env: TelemetryEnvelope = {
        id,
        v: q.v,
        mv: this.meta.mv,
        channel,
        seq: q.seq,
        event: q.event,
        at: q.at,
        data: q.data,
      };
      const next = JSON.stringify({ schema: TELEMETRY_SCHEMA, batch: [...batch, env] });
      if (next.length > MAX_BODY_BYTES) {
        // One envelope alone too big can never be sent, so it goes.
        if (!batch.length) oversized.push(q.seq);
        break;
      }
      batch.push(env);
      taken.push(q.seq);
      body = next;
    }
    return { taken, body, oversized };
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Forget everything, for when consent is withdrawn.
   *  Note     |  The queue, the day's rollup and the install id are all
   *           |  erased, so turning telemetry off removes every durable
   *           |  thing it wrote.
   * ------------------------------------------------------------------
   */
  async purge(): Promise<void> {
    await this.run(async () => {
      this.queue = { seq: 0, items: [] };
      this.daily = null;
      this.id = null;
      this.patchSeen = { day: '', n: 0 };
      this.loaded = true;
      try {
        await this.ports.storage.remove([TELEMETRY_ID_KEY, TELEMETRY_QUEUE_KEY, TELEMETRY_DAILY_KEY]);
      } catch {
        /* best effort; there is nothing to fall back to */
      }
    });
  }
}
