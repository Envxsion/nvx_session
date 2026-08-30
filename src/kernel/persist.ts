/**
 * ------------------------------------------------------------------
 *  Title    |  Write-through persistence
 *  Ref      |  registry.ts, journal.ts, jar/store.ts
 *  ID       |  Persistence
 * ------------------------------------------------------------------
 *  Purpose  |  Persist sessions, jars and settings so a cold worker
 *           |  wake rehydrates rather than rebuilds.
 *  How      |  The MV3 worker is killed after ~30s idle, so the kernel
 *           |  holds cache and storage holds truth. Every mutation
 *           |  lands before it is acknowledged.
 *  Author   |  Ojas Kekre, 25/08/2026
 * ------------------------------------------------------------------
 */

import { LEVELS, type Level } from './journal.js';
import { CookieStore, type StoreSnapshot } from '../jar/store.js';
import type { Binding, Session, SessionId } from './registry.js';
import { ANON_SESSION_ID, Registry } from './registry.js';
import { cleanDanger, type Danger } from '../guard/policy.js';

export const SCHEMA_VERSION = 1;

export interface PersistedSession {
  id: SessionId;
  label: string;
  color: string;
  group?: string;
  pinned: string[];
  /** Absent in state written before families existed. */
  family?: string[];
  forked?: string[];
  danger?: Danger;
  thirdParty?: 'allow' | 'block';
  allowedParties?: string[];
  createdAt: number;
  lastSeen: number;
  jar: StoreSnapshot;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Profile-scope preferences, kept beside the sessions
 *           |  rather than inside them.
 *  Note     |  Absent in state written by an earlier build, which is
 *           |  why every reader goes through withDefaults.
 * ------------------------------------------------------------------
 */
export interface Settings {
  /** Stamp the session mark onto the favicon of every managed tab. */
  paint: boolean;
  /** Also gather a session's tabs into a native tab group where one exists. */
  group: boolean;
  /**
   * Rewrite the Cookie header per request through the debugger, rather than
   * compiling rules ahead of time.
   *
   * Off by default, and that is a measurement rather than a preference.
   * `Fetch.continueRequest` can set a Cookie header but cannot stop the network
   * service adding one afterwards, so a request the interceptor decides should
   * carry nothing goes out carrying the browser's own jar. The declarative
   * rules can express that removal and do. Until the interceptor can too, it
   * weakens isolation rather than strengthening it.
   */
  exact: boolean;
  /**
   * The fingerprint posture, at profile scope.
   *
   * Mirror is the shipped default and fabricates nothing, because six of your
   * own accounts sharing one device fingerprint is unremarkable and what raises
   * a flag is incoherence. Standardize puts every session on one shared
   * normalised machine, which only lowers uniqueness because everybody running
   * it lands in the same place.
   *
   * Persona gives each session its own machine, seeded from the same per origin
   * token the storage namespace uses, so it is stable while the session exists
   * and matches up on no other site. It is the only posture that needs a channel
   * into the page, because the mask is registered by url and a session belongs
   * to a tab; see section 04 and the note at the top of `src/mask/index.ts`.
   */
  posture: 'mirror' | 'standardize' | 'persona';
  /**
   * How much of what the extension does is written to the journal on disk.
   *
   * `info` by default, which is every decision that moved a tab, a session or a
   * cookie and nothing else. `debug` adds the routine traffic and is what a bug
   * report wants. `warn` and `error` are for somebody who wants the journal to
   * hold only the things that went wrong.
   *
   * A level rather than an on switch, because "off" is the setting people
   * choose before the bug happens and regret afterwards, and the journal
   * deliberately holds nothing worth protecting: see `src/kernel/journal.ts`.
   */
  logLevel: Level;
  /**
   * Everything off, without losing anything.
   *
   * No rules, no header rewriting, no picker, no scripts: every tab behaves as
   * it would with the extension removed, while the sessions and their jars sit
   * exactly where they are. It exists because the first question when a site
   * starts misbehaving is whether this extension is the cause, and until there
   * was a pause the only way to answer it was to uninstall, which throws away
   * every session to run one experiment.
   *
   * It is also the honest answer to a site this cannot yet handle. A federated
   * sign-in that will not complete is better paused than fought.
   */
  paused: boolean;
  /**
   * Sites this extension has been told to leave alone, as registrable domains.
   *
   * Not the same as leaving a tab unmanaged, which is a per-tab answer that
   * dies with the browser session and is the right shape for "not this time".
   * This is the durable one: "never manage this site", which is what somebody
   * needs when a site and this extension cannot work together and the only
   * alternatives on offer were deleting the session or uninstalling.
   *
   * It is also where the sign-in loop detector puts a site it has just stopped
   * fighting, so the release outlives the tab that discovered the problem.
   */
  released: string[];
  /**
   * Whether the user has agreed to send anonymous usage counts.
   *
   * Off unless the user turns it on, which for a product whose whole promise is
   * that your data does not leak is the only defensible default. Nothing is
   * sent while this is false, and nothing is sent at all unless the build was
   * given an endpoint to send to; see `src/kernel/telemetry.ts`. What can ever
   * be sent is a fixed allowlist of counts and flags, never a URL, a domain, a
   * cookie or anything about which sites you use.
   */
  telemetry: boolean;
  /**
   * Whether the one-time telemetry question has been answered, either way.
   *
   * Separate from `telemetry` because "off because you said no" and "off
   * because we never asked" are different states, and only the second should
   * ever raise the question. Once this is true the consent card never shows
   * again, whichever way it was answered.
   */
  telemetryAsked: boolean;
  /**
   * Whether the first-run caution about federated sign-out has been seen.
   *
   * An isolated session presents a provider a partial set of its cookies, which
   * a federated login can read as a stolen session and answer by signing the
   * account out or looping. The extension stops the loop, but a user should meet
   * that possibility before it meets them. Shown once on the home view until
   * acknowledged, then never again, the same shape as telemetryAsked.
   */
  cautionAcked: boolean;
  /**
   * Fail closed: strip cookies from every host a managed tab touches that the
   * session does not own, not just the ones already in its jar.
   *
   * The default is fail-open, under the reliability-first doctrine: a host the
   * session has no rule for falls through to the browser's own jar, which keeps
   * unrelated sites signed in inside a managed tab at the cost of that one seam.
   * Fail closed removes the seam: nothing leaves a managed tab unless the session
   * owns it, full isolation, at the cost of being signed out of unrelated sites
   * in that tab. A Pro capability (`fail_closed`), so absence reads as off, and
   * it only takes effect while the feature is entitled; the preference is kept
   * either way so it returns on its own when a licence covers it again.
   */
  failClosed: boolean;
  /**
   * Cache isolation: force every response a managed tab receives to be
   * uncacheable, so nothing a site stashes in the shared HTTP cache under one
   * session can be read back under another on the same origin.
   *
   * Off by default. The honest form of per-session cache, since Chrome partitions
   * the HTTP cache by site, not by session, and exposes no way to give same-origin
   * tabs separate caches; suppression is the reachable approximation. A Pro
   * capability (`cache_isolation`), so absence reads as off, and it only takes
   * effect while the feature is entitled, the preference kept either way.
   */
  cacheIsolation: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  paint: true,
  group: false,
  exact: false,
  posture: 'mirror',
  logLevel: 'info',
  paused: false,
  released: [],
  telemetry: false,
  telemetryAsked: false,
  cautionAcked: false,
  failClosed: false,
  cacheIsolation: false,
});

export function withDefaults(raw: unknown): Settings {
  const s = (raw ?? {}) as Partial<Settings>;
  return {
    paint: typeof s.paint === 'boolean' ? s.paint : DEFAULT_SETTINGS.paint,
    group: typeof s.group === 'boolean' ? s.group : DEFAULT_SETTINGS.group,
    exact: typeof s.exact === 'boolean' ? s.exact : DEFAULT_SETTINGS.exact,
    // An unknown posture, from a future build or a corrupted file, falls back
    // to the one that fabricates nothing. Whatever went wrong, presenting a
    // half understood machine is the worse outcome.
    posture:
      s.posture === 'standardize' || s.posture === 'persona'
        ? s.posture
        : DEFAULT_SETTINGS.posture,
    logLevel: LEVELS.includes(s.logLevel as Level) ? (s.logLevel as Level) : DEFAULT_SETTINGS.logLevel,
    // Absent in state written before the pause existed, and absence reads as
    // running. A profile that has never been paused has not asked to be.
    paused: s.paused === true,
    // Absence reads as "nothing released", which is the direction that manages
    // a site rather than the one that silently stops.
    released: Array.isArray(s.released)
      ? [...new Set(s.released.filter((d): d is string => typeof d === 'string' && d.length > 0))].sort()
      : [],
    // Both absent in state written before telemetry existed, and absence is the
    // safe reading: not consented, and not yet asked.
    telemetry: s.telemetry === true,
    telemetryAsked: s.telemetryAsked === true,
    // Absent before the caution existed, and absence reads as not yet seen, so
    // an existing install meets it on the next open rather than never.
    cautionAcked: s.cautionAcked === true,
    // Absent before fail-closed existed, and absence reads as off, which is the
    // reliability-first default: fall through to the browser jar rather than sign
    // the user out of unrelated sites in a managed tab.
    failClosed: s.failClosed === true,
    // Absent before cache isolation existed, and absence reads as off: the cache
    // is shared, which costs nothing until a site actively abuses it.
    cacheIsolation: s.cacheIsolation === true,
  };
}

export interface PersistedState {
  version: number;
  sessions: PersistedSession[];
  bindings: Binding[];
  settings?: Settings;
  /**
   * The blast-radius audit trail. Kept beside the sessions rather than inside
   * them, because an entry has to outlive the session it names: "which session
   * hit that endpoint" is asked after somebody deleted the session in a panic.
   */
  audit?: unknown[];
  savedAt: number;
}

export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

const KEY = 'nvx.state.v1';
/**
 * ------------------------------------------------------------------
 *  Purpose  |  The previous good state, kept so a corrupt or truncated
 *           |  write is survivable.
 *  Note     |  Losing the jar loses every signed-in session at once,
 *           |  the worst non-security outcome here, and silently.
 * ------------------------------------------------------------------
 */
const BACKUP = 'nvx.state.backup';

export function serialise(
  registry: Registry,
  opts: { now?: number; settings?: Settings; audit?: unknown[] } = {}
): PersistedState {
  return {
    version: SCHEMA_VERSION,
    savedAt: opts.now ?? Date.now(),
    settings: withDefaults(opts.settings),
    ...(opts.audit ? { audit: opts.audit } : {}),
    sessions: registry.listSessions().map((s) => ({
      id: s.id,
      label: s.label,
      color: s.color,
      ...(s.group !== undefined ? { group: s.group } : {}),
      pinned: s.pinned,
      family: s.family,
      forked: s.forked,
      danger: s.danger,
      thirdParty: s.thirdParty,
      allowedParties: s.allowedParties ?? [],
      createdAt: s.createdAt,
      lastSeen: s.lastSeen,
      // An ephemeral session is a holding pen rather than an account, and its
      // jar is meant to be empty. Writing one out is how it comes back: an
      // in-memory clear is undone the next time state is read, and the identity
      // it was holding outlives the tab that was parked in it.
      jar: s.ephemeral ? { version: 1, cookies: [] } : s.store.toSnapshot(),
    })),
    bindings: registry.listBindings(),
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Structural validation before anything is trusted.
 *  Note     |  A crash can leave state from an older build or an
 *           |  unanticipated shape. Throwing would discard every
 *           |  session; skipping a bad entry keeps the rest.
 * ------------------------------------------------------------------
 */
export function looksValid(state: unknown): state is PersistedState {
  if (!state || typeof state !== 'object') return false;
  const s = state as Partial<PersistedState>;
  return (
    typeof s.version === 'number' &&
    Array.isArray(s.sessions) &&
    Array.isArray(s.bindings)
  );
}

function validSession(p: unknown): p is PersistedSession {
  if (!p || typeof p !== 'object') return false;
  const s = p as Partial<PersistedSession>;
  return (
    typeof s.id === 'string' &&
    s.id.length > 0 &&
    typeof s.label === 'string' &&
    Boolean(s.jar) &&
    Array.isArray((s.jar as StoreSnapshot | undefined)?.cookies)
  );
}

function validBinding(b: unknown): b is Binding {
  if (!b || typeof b !== 'object') return false;
  const x = b as Partial<Binding>;
  return typeof x.tabId === 'number' && typeof x.sessionId === 'string';
}

export function deserialise(state: PersistedState): Registry {
  const registry = new Registry();
  if (state.version !== SCHEMA_VERSION) return registry;

  for (const p of state.sessions.filter(validSession)) {
    /**
     * ------------------------------------------------------------------
     *  Purpose  |  Derive the ephemeral flag here rather than trust the
     *           |  snapshot: a restore is where the flag went missing,
     *           |  and a pen that returns without it becomes a real
     *           |  account, offers itself in the picker, and keeps what
     *           |  a waiting tab was handed.
     *  Note     |  Matches the exact id, not the reserved prefix: every
     *           |  internal suite names throwaways from that namespace,
     *           |  and emptying their jars on restore is what a restore
     *           |  test exists to catch.
     * ------------------------------------------------------------------
     */
    const ephemeral = p.id === ANON_SESSION_ID;
    const session: Session = {
      id: p.id,
      label: p.label,
      color: p.color,
      ...(p.group !== undefined ? { group: p.group } : {}),
      pinned: p.pinned ?? [],
      // Absent in state written before families existed. Empty is the safe
      // reading: the session simply has not been observed anywhere yet, and
      // the next sign-in records it again.
      family: Array.isArray(p.family) ? p.family.filter((d): d is string => typeof d === 'string') : [],
      ...(ephemeral ? { ephemeral: true } : {}),
      store: ephemeral ? new CookieStore() : CookieStore.fromSnapshot(p.jar),
      // Absent in state written before M4. An empty list means every origin is
      // still unforked, which is the safe reading: the copy happens once, on
      // arrival, and only into a namespace that has nothing in it.
      forked: Array.isArray(p.forked) ? p.forked.filter((o) => typeof o === 'string') : [],
      danger: cleanDanger(p.danger),
      // Absent in state written before the control existed. Those sessions were
      // created when third parties were passed through, so they keep that
      // behaviour rather than having it changed underneath them by an upgrade.
      thirdParty: p.thirdParty === 'block' ? 'block' : 'allow',
      // Absent in state written before the block had holes in it. Empty is the
      // safe reading in the only direction that matters: it blocks something
      // that was being let through rather than letting through something that
      // was being blocked.
      allowedParties: Array.isArray(p.allowedParties)
        ? p.allowedParties.filter((d): d is string => typeof d === 'string' && d.length > 0)
        : [],
      createdAt: p.createdAt,
      lastSeen: p.lastSeen,
    };
    registry.createSession(session);
  }

  for (const b of state.bindings.filter(validBinding)) {
    registry.bind(b.tabId, b.sessionId, {
      windowId: b.windowId,
      url: b.url,
      origin: 'restored',
      now: b.boundAt,
    });
    if (b.sealed) registry.seal(b.tabId);
  }

  return registry;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Coalesce writes.
 *  How      |  A page load can produce dozens of cookie changes, each
 *           |  dirtying the whole state blob; writing per change would
 *           |  serialise the entire jar dozens of times per load.
 * ------------------------------------------------------------------
 */
export class Persistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private writing: Promise<void> | null = null;

  constructor(
    private readonly area: StorageArea,
    private readonly registry: Registry,
    private readonly opts: {
      debounceMs?: number;
      onError?: (e: unknown) => void;
      /** Read at write time, so a preference changed between writes is caught. */
      settings?: () => Settings;
      audit?: () => unknown[];
    } = {}
  ) {}

  schedule(): void {
    this.pending = true;
    if (this.timer) return;
    this.timer = setTimeout(() => void this.save(), this.opts.debounceMs ?? 400);
  }

  async save(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    this.pending = false;

    const run = async () => {
      try {
        // The previous good state is promoted to backup before the new one
        // lands, so there is always one intact copy on disk.
        const prior: Record<string, unknown> = await this.area.get(KEY).catch(() => ({}));
        const next = serialise(this.registry, {
          ...(this.opts.settings ? { settings: this.opts.settings() } : {}),
          ...(this.opts.audit ? { audit: this.opts.audit() } : {}),
        });
        const write: Record<string, unknown> = { [KEY]: next };
        if (looksValid(prior[KEY])) write[BACKUP] = prior[KEY];
        await this.area.set(write);
      } catch (e) {
        // Quota is the realistic failure. Losing the write is survivable
        // because rules are already live; losing it silently is not, because
        // the next cold wake would restore a stale jar.
        this.pending = true;
        this.opts.onError?.(e);
      }
    };

    const next = this.writing ? this.writing.then(run, run) : run();
    this.writing = next.catch(() => undefined);
    return next;
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Load state, falling back to the backup when the
   *           |  primary is unusable.
   *  Note     |  Returns which copy was used, so a crash recovery is
   *           |  visible rather than silent.
   * ------------------------------------------------------------------
   */
  static async load(
    area: StorageArea
  ): Promise<{
    registry: Registry;
    settings: Settings;
    audit: unknown[];
    source: 'primary' | 'backup';
  } | null> {
    const raw = await area.get([KEY, BACKUP]).catch(() => ({}) as Record<string, unknown>);

    for (const [key, source] of [
      [KEY, 'primary'],
      [BACKUP, 'backup'],
    ] as const) {
      const state = raw[key];
      if (!looksValid(state)) continue;
      try {
        return {
          registry: deserialise(state),
          settings: withDefaults(state.settings),
          audit: Array.isArray(state.audit) ? state.audit : [],
          source,
        };
      } catch {
        /* try the next copy */
      }
    }
    return null;
  }

  static async clear(area: StorageArea): Promise<void> {
    await area.remove([KEY, BACKUP]);
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Reconcile restored bindings against the tabs that
 *           |  actually exist.
 *  Note     |  A binding for a closed tab must go, or it keeps a dead
 *           |  tab id in a live rule. One for a tab that merely
 *           |  navigated must stay, however far it travelled.
 * ------------------------------------------------------------------
 */
export interface LiveTab {
  id?: number | undefined;
  url?: string | undefined;
  windowId?: number | undefined;
}

/** A binding whose tab is gone, kept so a restored tab can be matched to it. */
export interface Orphan {
  url: string;
  sessionId: SessionId;
}

export function reconcile(
  registry: Registry,
  liveTabs: LiveTab[]
): { kept: number[]; dropped: number[]; dirty: SessionId[]; orphans: Orphan[] } {
  const live = new Map<number, LiveTab>();
  for (const t of liveTabs) {
    if (typeof t.id === 'number') live.set(t.id, t);
  }

  const kept: number[] = [];
  const dropped: number[] = [];
  const orphans: Orphan[] = [];
  const dirty = new Set<SessionId>();

  for (const b of registry.listBindings()) {
    const tab = live.get(b.tabId);
    if (!tab) {
      dirty.add(b.sessionId);
      registry.unbind(b.tabId);
      dropped.push(b.tabId);
      // Kept rather than forgotten. Across a browser restart every tab comes
      // back with a new id, so every binding lands here even though the tabs
      // themselves survived. Dropping the id is correct; dropping the knowledge
      // of which session that url belonged to is what logs the user out of
      // everything they had open.
      if (b.url) orphans.push({ url: b.url, sessionId: b.sessionId });
      continue;
    }

    // Deliberately NOT dropped when the origin changed.
    //
    // An earlier version treated a changed origin as a recycled tab id. That is
    // wrong and actively harmful: a federated sign-in navigates from the
    // service to the identity provider and back, so a tab that crossed origins
    // while the worker slept is the normal case, and unbinding it hands the
    // very next request to the profile jar. That is the wrong-account failure
    // this project exists to prevent.
    //
    // Chrome assigns tab ids monotonically within a browser session and does
    // not recycle them, so a surviving id is the same tab. Across a restart the
    // question does not arise, because session rules are cleared and onStartup
    // recompiles from scratch.
    if (tab.url) registry.navigated(b.tabId, tab.url);
    if (typeof tab.windowId === 'number') registry.movedWindow(b.tabId, tab.windowId);
    dirty.add(b.sessionId);
    kept.push(b.tabId);
  }

  return { kept, dropped, dirty: [...dirty], orphans };
}


