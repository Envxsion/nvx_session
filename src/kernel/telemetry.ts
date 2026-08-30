/**
 * Anonymous usage counts, built so the product cannot leak what it exists to
 * protect.
 *
 * The whole design follows from one fact about extensions: a published build is
 * a zip anyone can unpack and read, so any credential shipped in it is public.
 * There is therefore no database key here and there never can be. This module
 * knows one thing, an endpoint URL, and that endpoint is a thin ingest function
 * the author runs which holds the real credentials on its own server. The
 * extension only ever POSTs to it. See TELEMETRY.md for the endpoint's contract.
 *
 * Two independent switches gate every send, and both must be on:
 *
 *   - consent. Off unless the user turned it on. For a product whose promise is
 *     that your data does not leave, opt-in is the only honest default.
 *   - a configured endpoint. Absent in every build except the store build,
 *     where it is injected at package time from an environment variable, so a
 *     developer running an unpacked build sends nothing and needs no server.
 *
 * And what can ever be sent is an allowlist, not a blocklist. Every event is
 * built by a typed method below out of a fixed set of primitive fields: a
 * version, a bucketed count, a value from a closed enum, a boolean, a sanitised
 * slug. There is deliberately no method that accepts a free-form string, so a
 * URL, a domain, a cookie or an account label has no path into a payload even
 * by mistake. That is the guarantee the tests pin.
 *
 * Nothing here can fail the product. Every network path swallows its own error
 * and drops the batch, because a telemetry outage must never be something the
 * user feels.
 */

import type { StorageArea } from './persist.js';

/** Where the durable, anonymous install id lives. */
export const TELEMETRY_ID_KEY = 'nvx.telemetry.id';

/**
 * The wire-format version, sent on every batch as `schema`.
 *
 * Bumped only when the shape of an envelope changes, so the endpoint can accept
 * more than one version during a rollout and reject a shape it does not know
 * rather than guess. The event and field allowlists can grow without a bump; a
 * bump is for a change to the envelope itself.
 */
export const TELEMETRY_SCHEMA = 2;

/**
 * The closed set of events. Anything not here cannot be sent, because there is
 * no method to send it.
 */
export type TelemetryEvent =
  | 'install'
  | 'update'
  | 'startup'
  | 'active'
  | 'session_created'
  | 'posture_changed'
  | 'feature_used'
  | 'error';

/**
 * The device profile, sent with install, update, startup and the daily active
 * beat so the operator can see the shape of the audience without seeing a
 * person in it.
 *
 * Every field is deliberately coarse. The point is to know "how many people on
 * macOS arm64 running Opera", not to build something that narrows to one
 * browser. So the operating system, architecture and browser are closed enums;
 * the browser version is the major number only; the language is the primary
 * subtag with no region; and the timezone is a whole-hour offset, not a named
 * zone or a location. None of it is a fingerprinting vector the way a screen
 * size, a canvas hash or a font list would be, and none of those is collected,
 * because the product exists to defeat exactly that.
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

/** The counts on the daily active beat: engagement and retention, both bucketed. */
export interface TelemetryUsage {
  /** Sessions in existence, bucketed. */
  sessions: string;
  /** Tabs currently under management, bucketed. */
  tabs: string;
  /** Days since install, bucketed, so retention cohorts fall out without a date. */
  since_install: string;
}

/**
 * The closed set of features a `feature_used` event may name. A fixed enum
 * rather than a string, so the field can never carry anything but one of these.
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
 * The closed set of error categories.
 *
 * Closed on purpose, and this is the load-bearing decision for the no-leak
 * promise. An error is the one thing tempting to describe in free text, and
 * free text is exactly where a URL or a cookie would ride out. So there is no
 * free-text path: a caller can only name one of these, which say what broke
 * without saying anything about the user. `slug` still runs over the value as a
 * backstop, but the type is what makes a leak impossible rather than unlikely.
 */
export type TelemetryError =
  | 'boot_failed'
  | 'flush_failed'
  | 'apply_failed'
  | 'compile_failed'
  | 'adopt_failed'
  | 'native_failed'
  // The anomaly signals. Each names a class of live failure the operator wants
  // to see the rate of across installs, and each is still only a category: no
  // host, no count, no value. Sent at most once per install per day (see the
  // anomaly() guard in the background), because in a real incident these fire
  // hundreds of times and the rate matters, not the volume.
  //
  // rule_overflow: a session needed more rules than its budget, so some hosts
  //   went unisolated. The failure behind the federated sign-in loops.
  // signin_loop:   a sign-in was looping and the site was released to stop it.
  // foreign_cookie: the browser's own jar reached a managed tab, the isolation
  //   failure the whole product exists to prevent.
  | 'rule_overflow'
  | 'signin_loop'
  | 'foreign_cookie';

/** The only value types a payload field may hold. No objects, no arrays. */
type Scalar = string | number | boolean;

export interface TelemetryEnvelope {
  /** A random id generated once per install, tied to no identity. */
  id: string;
  /** The build version, from the manifest. */
  v: string;
  /** Manifest version, 2 or 3, so the two platforms can be told apart. */
  mv: 2 | 3;
  event: TelemetryEvent;
  at: number;
  data: Record<string, Scalar>;
}

/**
 * Everything this module needs from the outside, injected so it holds no
 * reference to `chrome` and runs unchanged under a test.
 */
export interface TelemetryPorts {
  storage: StorageArea;
  /** The ingest URL, or null when the build was given none. */
  endpoint: () => string | null;
  /** Whether the user has consented. */
  consented: () => boolean;
  /** POST the body to the URL. Rejects on any failure; the caller swallows it. */
  post: (url: string, body: string) => Promise<void>;
  now: () => number;
  /** A fresh random id, e.g. crypto.randomUUID. */
  newId: () => string;
}

/**
 * Buckets a raw count into a coarse range.
 *
 * The exact number of sessions somebody runs is more than telemetry needs and
 * edges toward a fingerprint, so it is never sent; the bucket is. The ranges
 * are wide on purpose.
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
 * Reduces an error label to a bare slug.
 *
 * The one place a caller passes text, and so the one place text is scrubbed:
 * lowercased, everything but letters, digits and underscores dropped, and
 * truncated hard. A URL, a stack line or a message handed in here comes out as
 * a short slug with the punctuation that made it identifying removed, so even a
 * careless caller cannot turn an error into a leak.
 */
export function slug(raw: string): string {
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'unknown';
}

/**
 * Buckets days-since-install into retention cohorts.
 *
 * The exact age of an install edges toward a timestamp, so it is never sent;
 * the cohort is. Wide bands, chosen so day one, the first week, the first
 * month and beyond each fall out on their own.
 */
export function daysBucket(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '0';
  if (days <= 1) return '1';
  if (days <= 7) return '2-7';
  if (days <= 30) return '8-30';
  if (days <= 90) return '31-90';
  return '90+';
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

/**
 * Forces an env object onto the allowlist, whatever it was handed.
 *
 * Every field is coerced to its closed set or coarsened: an unknown OS, arch or
 * browser becomes `other`; a version becomes a non-negative integer; a language
 * that is not a bare two or three letter subtag becomes `other`, which also
 * strips any region a caller left on; and the timezone is rounded to a whole
 * hour and clamped to the real range. So even a caller that fabricates an env
 * cannot push anything identifying through it.
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
        ? Math.floor(raw.browser_major as number)
        : 0,
    lang: /^[a-z]{2,3}$/.test(lang) ? lang : 'other',
    tz: Number.isFinite(tz) ? Math.max(-14, Math.min(14, Math.round(tz))) : 0,
  };
}

export class Telemetry {
  private queue: TelemetryEnvelope[] = [];
  private id: string | null = null;
  private env: TelemetryEnv | null = null;

  constructor(
    private readonly ports: TelemetryPorts,
    private readonly meta: { version: string; mv: 2 | 3 }
  ) {}

  /** Both switches on: the user agreed and the build has somewhere to send to. */
  private live(): boolean {
    return this.ports.consented() && Boolean(this.ports.endpoint());
  }

  /**
   * Loads the install id, minting one on first use. Cheap to call repeatedly;
   * it does its work once. Never runs while telemetry is off, so a profile that
   * never consents never gets an id written at all.
   */
  async ready(): Promise<void> {
    if (this.id || !this.live()) return;
    try {
      const held = await this.ports.storage.get([TELEMETRY_ID_KEY]);
      let id = typeof held[TELEMETRY_ID_KEY] === 'string' ? (held[TELEMETRY_ID_KEY] as string) : '';
      if (!id) {
        id = this.ports.newId();
        await this.ports.storage.set({ [TELEMETRY_ID_KEY]: id });
      }
      this.id = id;
    } catch {
      /* no id, no sends; the product does not care */
    }
  }

  private enqueue(event: TelemetryEvent, data: Record<string, Scalar>): void {
    if (!this.live()) return;
    this.queue.push({
      id: this.id ?? 'pending',
      v: this.meta.version,
      mv: this.meta.mv,
      event,
      at: this.ports.now(),
      data,
    });
    void this.flush();
  }

  /**
   * Records the device profile, cleaned onto the allowlist, so the lifecycle
   * events that follow can carry it. Set once at boot; cheap to set again.
   */
  setEnv(env: Partial<TelemetryEnv>): void {
    this.env = cleanEnv(env);
  }

  /** The env as flat payload fields, or nothing if it was never set. */
  private envData(): Record<string, Scalar> {
    return this.env ? { ...this.env } : {};
  }

  // The typed events. Each builds its own payload from allowlisted values, and
  // none takes a free-form string, which is what makes a leak structurally
  // impossible rather than merely unlikely.

  install(reason: 'install' | 'update'): void {
    this.enqueue(reason === 'update' ? 'update' : 'install', this.envData());
  }

  startup(): void {
    this.enqueue('startup', this.envData());
  }

  /**
   * The once-a-day heartbeat. Carries the device profile plus the engagement
   * and retention buckets, and is what turns a pile of installs into a picture
   * of who keeps using it. The caller fires it at most once per day; nothing
   * here enforces that, because "once a day" is a property of when it is called,
   * not of the payload.
   */
  active(usage: TelemetryUsage): void {
    this.enqueue('active', {
      ...this.envData(),
      sessions: usage.sessions,
      tabs: usage.tabs,
      since_install: usage.since_install,
    });
  }

  /** How many sessions exist, as a bucket, never the exact number or which. */
  sessionCreated(total: number): void {
    this.enqueue('session_created', { sessions: bucket(total) });
  }

  postureChanged(posture: 'mirror' | 'standardize' | 'persona'): void {
    this.enqueue('posture_changed', { posture });
  }

  feature(name: TelemetryFeature): void {
    this.enqueue('feature_used', { feature: name });
  }

  /**
   * `category` is a value from a closed set, so nothing about the error but its
   * kind can be sent. `slug` runs anyway as a backstop against a caller who
   * casts around the type.
   */
  error(category: TelemetryError): void {
    this.enqueue('error', { category: slug(category) });
  }

  /**
   * Sends whatever is queued, in one request. Silent on every failure, and a
   * no-op when either switch is off, so a caller can flush freely.
   */
  async flush(): Promise<void> {
    const url = this.ports.endpoint();
    if (!this.live() || !url || !this.queue.length) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await this.ports.post(url, JSON.stringify({ schema: TELEMETRY_SCHEMA, batch }));
    } catch {
      /* the batch is dropped rather than retried; telemetry is not worth memory */
    }
  }

  /**
   * Forgets everything, for when consent is withdrawn: the queue is dropped and
   * the install id is erased, so turning telemetry off also removes the only
   * durable thing it ever wrote.
   */
  async purge(): Promise<void> {
    this.queue = [];
    this.id = null;
    try {
      await this.ports.storage.remove([TELEMETRY_ID_KEY]);
    } catch {
      /* best effort; there is nothing to fall back to */
    }
  }
}
