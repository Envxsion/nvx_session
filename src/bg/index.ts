/**
 * ------------------------------------------------------------------
 *  Title    |  Service worker entry
 *  Ref      |  kernel/engine.ts, netfilter, persona, guard, jar
 *  ID       |  M0 (service worker)
 * ------------------------------------------------------------------
 *  Purpose  |  Wire browser events to the kernel.
 *  How      |  A tab is bound and its rules live before its first
 *           |  request, so tab creation and navigation flush at once, not
 *           |  through the debounce. The worker is killed when idle, so
 *           |  every handler awaits readiness on a possible cold start.
 *  Author   |  Ojas Kekre, 25/08/2026
 * ------------------------------------------------------------------
 */

import { Engine } from '../kernel/engine.js';
import {
  DEFAULT_SETTINGS,
  Persistence,
  reconcile,
  type Orphan,
  type Settings,
} from '../kernel/persist.js';
import { Ephemeral, type EphemeralArea } from '../kernel/ephemeral.js';
import { Telemetry, bucket as bucketCount, daysBucket, type TelemetryError } from '../kernel/telemetry.js';
import { Entitlement, FEATURES, type Feature } from '../kernel/entitlement.js';
// License and Sync come through the Pro gate: the committed default is an inert
// free stub, and a Pro build swaps in the real classes from the private
// submodule. Their types are the shared, public ones in pro-types.js.
import { License, Sync } from '../kernel/pro.js';
import type { SyncConfig, SyncSession } from '../kernel/pro-types.js';
import { Journal, LEVELS, formatJournal, type Area, type Level } from '../kernel/journal.js';
import { ANON_SESSION_ID, Registry, domainOf, originOf, type SessionId } from '../kernel/registry.js';
import { browserDnrApi, DnrBackend } from '../netfilter/dnr.js';
import { captureSetCookie, contextFor } from '../observer/capture.js';
import { compare, DesyncLog } from '../observer/desync.js';
import { ThirdPartyLog } from '../observer/thirdparty.js';
import { emit } from '../jar/emit.js';
// Static only. Dynamic import() is disallowed in a ServiceWorkerGlobalScope by
// the HTML specification, so lazy loading a module here fails at runtime with
// no build-time warning.
import { CookieStore } from '../jar/store.js';
import { cookieKey, parseSetCookie } from '../jar/cookie.js';
import { isPublicSuffix } from '../jar/psl.js';
import { runSelfTest } from './selftest.js';
import { runRestoreTest } from './restoretest.js';
import { runPaintTest } from './painttest.js';
import { runStorageTest } from './storagetest.js';
import { runGuardTest } from './guardtest.js';
import { runChainTest } from './chaintest.js';
import { runMaskTest } from './masktest.js';
import { compile, standardFor, UNAPPLIED, type RealMachine } from '../persona/compile.js';
import { compilePosture, MAX_POSTURE_HOSTS, postureIds } from '../persona/headers.js';
import type { Brand } from '../persona/useragent.js';
import type { Os } from '../persona/types.js';
import { namespaceFor } from '../store/keys.js';
import { identityAcross, identityFrom } from '../kernel/identity.js';
import { hostOf } from '../kernel/registry.js';
import { registrableDomain } from '../jar/psl.js';
import { MAX_ICON_CANDIDATES, rankIcons, type IconCandidate } from '../paint/badge.js';
import { Painter } from '../paint/render.js';
import { applyGroups, browserGroupApi, planGroups } from '../paint/groups.js';
import {
  candidatesFrom,
  estimateRules,
  fitsBudget,
  groupCandidates,
  looksSignedIn,
  preselected,
  proposedLabel,
  type AdoptionCandidate,
} from '../kernel/adopt.js';
import { RULES_PER_SESSION } from '../netfilter/compile.js';
import {
  blockingIsReal,
  BlockingNetfilter,
  browserBlockingApi,
  type Owner,
} from '../netfilter/blocking.js';
import type { Netfilter } from '../netfilter/types.js';
import { browserDebuggerApi, ExactInterceptor } from '../netfilter/exact.js';
import { actionApi, badgeApi, canScopeAgent, injectAgent } from '../platform.js';
import { NativeHost } from '../native/client.js';
import { cleanDanger, decide, DEFAULT_DANGER, type Danger } from '../guard/policy.js';
import { Guard, UNLOCK_MS } from '../guard/guard.js';
import { CATALOG } from '../guard/catalog.js';
import type { AuditEntry } from '../guard/audit.js';

const storage: import('../kernel/persist.js').StorageArea = {
  get: (keys) => chrome.storage.local.get(keys as never),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys as never),
};

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The storage area scoped to the browser session, not the
 *           |  profile.
 *  Note     |  Absent on MV2, where the persistent background page
 *           |  already has that lifetime.
 * ------------------------------------------------------------------
 */
const sessionArea: EphemeralArea | null = (() => {
  const area = (chrome.storage as { session?: chrome.storage.StorageArea }).session;
  if (!area) return null;
  return {
    get: (keys) => area.get(keys as never),
    set: (items) => area.set(items),
  };
})();

let registry = new Registry();
let settings: Settings = { ...DEFAULT_SETTINGS };
let persistence = new Persistence(storage, registry, {
  settings: () => settings,
  audit: () => guard.audit.all(),
});
const backend = new DnrBackend(browserDnrApi());
const desync = new DesyncLog();
const painter = new Painter();

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Anonymous usage counts, off unless consented and given an
 *           |  endpoint.
 *  Note     |  The endpoint is a public ingest URL from a manifest field
 *           |  the store build injects; an unpacked build has none. No
 *           |  credential here. See telemetry.ts, TELEMETRY.md.
 * ------------------------------------------------------------------
 */
const telemetry = new Telemetry(
  {
    storage,
    endpoint: () => {
      const field = (chrome.runtime.getManifest() as { nvx_telemetry?: { endpoint?: unknown } })
        .nvx_telemetry;
      const url = field?.endpoint;
      return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
    },
    consented: () => settings.telemetry,
    post: async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
      });
      if (!res.ok) throw new Error(`telemetry endpoint ${res.status}`);
    },
    now: () => Date.now(),
    newId: () =>
      typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  },
  {
    version: chrome.runtime.getManifest().version,
    mv: chrome.runtime.getManifest().manifest_version === 2 ? 2 : 3,
  }
);

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The Pro tier gate and its licence, section 30.
 *  How      |  Like telemetry, a pure part holding only public material
 *           |  and a wired part that reaches the network. Both fail open
 *           |  to the free product.
 *  Note     |  Tier, endpoint and keys come from manifest fields the
 *           |  build stamps. A free build carries none and is inert.
 * ------------------------------------------------------------------
 */
function buildTier(): 'free' | 'pro' {
  return (chrome.runtime.getManifest() as { nvx_tier?: unknown }).nvx_tier === 'pro' ? 'pro' : 'free';
}
function manifestLicense(): { endpoint?: unknown; keys?: unknown } {
  return (
    (chrome.runtime.getManifest() as { nvx_license?: { endpoint?: unknown; keys?: unknown } })
      .nvx_license ?? {}
  );
}
/** Whether this build can activate a licence at all: pro tier with an endpoint. */
function licensePossible(): boolean {
  const url = manifestLicense().endpoint;
  return buildTier() === 'pro' && typeof url === 'string' && /^https:\/\//.test(url);
}

/** A coarse device label for the studio's seat list, no more identifying than the telemetry env. */
const OS_LABEL: Record<string, string> = {
  win: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  cros: 'ChromeOS',
  android: 'Android',
};
let cachedOsLabel = '';
function deviceLabelText(): string {
  const ua = (globalThis.navigator?.userAgent ?? '') as string;
  const { browser } = detectBrowser(ua);
  const b = browser === 'other' ? 'Browser' : browser[0]!.toUpperCase() + browser.slice(1);
  return `${cachedOsLabel || 'Device'}, ${b}`;
}

// eslint-disable-next-line prefer-const -- assigned just below; entitlement's
// deviceId port reads it, so it has to be referenceable before license exists.
let license: License;
const entitlement = new Entitlement({
  buildTier,
  deviceId: () => (license ? license.deviceId() : null),
  kids: (() => {
    const raw = manifestLicense().keys;
    const out: Record<string, string> = {};
    if (raw && typeof raw === 'object') {
      for (const [kid, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string') out[kid] = v;
      }
    }
    return out;
  })(),
  verify: async (pub, sig, data) => {
    try {
      const key = await crypto.subtle.importKey('raw', pub as BufferSource, { name: 'Ed25519' }, false, [
        'verify',
      ]);
      return await crypto.subtle.verify('Ed25519', key, sig as BufferSource, data as BufferSource);
    } catch {
      // An engine without Ed25519 in WebCrypto cannot verify, so the token
      // unlocks nothing and the user stays on the free product. Safe degradation.
      return false;
    }
  },
  now: () => Date.now(),
  // Every licence edge case (activated, expired, revoked, paused, seat moved
  // away) lands here as a decision change, and re-applies the feature effects so
  // a Pro capability turns on and off mid-session without a reload. See
  // applyEntitlements.
  onChange: () => applyEntitlements(),
});
license = new License({
  storage,
  endpoint: () => {
    const url = manifestLicense().endpoint;
    return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
  },
  post: async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  },
  deviceLabel: () => deviceLabelText(),
  now: () => Date.now(),
  newId: () =>
    typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  onToken: async (t) => {
    await entitlement.setToken(t);
  },
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Cross-device sync of the session structure, the Pro sync
 *           |  feature.
 *  How      |  Only the shape of the sessions syncs, never the cookie
 *           |  jars, which stay on the device that earned them.
 *  Note     |  End to end encrypted, zero-knowledge. See
 *           |  src/kernel/sync.ts.
 * ------------------------------------------------------------------
 */
const sync = new Sync({
  storage,
  endpoint: () => {
    const base = manifestLicense().endpoint;
    return typeof base === 'string' && /^https:\/\//.test(base) ? `${base}/sync` : null;
  },
  post: async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  },
  crypto: {
    subtle: crypto.subtle,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
  },
  now: () => Date.now(),
  credentials: () => license.credentials(),
  readConfig: () => syncReadConfig(),
  applyConfig: (merged) => syncApplyConfig(merged),
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Re-apply every Pro feature's effect to match the current
 *           |  entitlement.
 *  How      |  Called on boot and on every entitlement change, so a
 *           |  feature comes on or off with nothing to reload. Each
 *           |  feature degrades to its free behaviour.
 *  Note     |  Today IndexedDB isolation is the live one, carried in the
 *           |  storage handshake.
 * ------------------------------------------------------------------
 */
function applyEntitlements(): void {
  // IndexedDB isolation: re-push the storage handshake so the shim picks up the
  // current gate. A same-session re-push is cheap and the shim updates its flag
  // even when the session id has not changed.
  for (const tabId of agents.keys()) pushStorage(tabId);
  // Exact cookie control: attach or detach the interceptor to match the gate.
  syncExact();
  if (!effectiveExact()) void exact?.releaseAll();
  // Fail closed: strict is resolved per flush from settings and the licence, so a
  // licence gained or lost changes what every session compiles to. Recompile them
  // all so the change is live, not deferred to the next time each happens to
  // dirty on its own.
  engine.markDirty(registry.listSessions().map((x) => x.id));
  void engine.flush();
  // Persona: a machine-per-session feature gained or lost changes the effective
  // posture, so run the same transition the settings handler runs, which marks
  // existing documents before the rules move so nothing is left incoherent.
  void applyPostureChange(lastLivePosture, livePosture());
}

/** The effective posture the rules were last built for, so a change can be detected. */
let lastLivePosture: Settings['posture'] = 'mirror';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Apply a change in the effective posture across every tab.
 *  How      |  Mark existing documents before the rules move, register
 *           |  the scripts and rules for the new posture, then re-answer
 *           |  every tab.
 *  Note     |  The marking is load-bearing: a script cannot enter a
 *           |  document that already exists, so a tab open when the
 *           |  posture leaves Mirror is left real until it reloads.
 * ------------------------------------------------------------------
 */
async function applyPostureChange(
  beforeEff: Settings['posture'],
  afterEff: Settings['posture']
): Promise<void> {
  lastLivePosture = afterEff;
  if (afterEff === beforeEff) {
    // No effective change: the registration signature is unchanged, so this is a
    // no-op, but it keeps the one path that reaches registerAgent from a posture
    // concern in one place.
    await registerAgent();
    return;
  }
  if (afterEff === 'mirror') {
    unmaskedTabs.clear();
    ephemeral.schedule();
  } else if (beforeEff === 'mirror') {
    for (const t of await chrome.tabs.query({})) {
      if (typeof t.id === 'number') unmaskedTabs.add(t.id);
    }
    await ephemeral.save();
    if (unmaskedTabs.size) {
      note('info', 'mask', 'tabs left real until they load again', {
        detail: `${unmaskedTabs.size} open when the posture changed, and a script cannot enter a document that already exists`,
      });
    }
  }
  await registerAgent();
  for (const tabId of agents.keys()) pushStorage(tabId);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The feature gate, the one answer to "is this Pro
 *           |  capability available".
 *  How      |  On when the licence entitles it, or on a dev build, which
 *           |  unlocks every feature locally so the self-tests run.
 *  Note     |  Every effective* helper funnels through here so dev and
 *           |  licence cannot drift.
 * ------------------------------------------------------------------
 */
function devUnlock(): boolean {
  return (chrome.runtime.getManifest() as { nvx_tier?: unknown }).nvx_tier === 'dev';
}
function featureOn(feature: Feature): boolean {
  return devUnlock() || entitlement.entitled(feature);
}

/** Whether IndexedDB isolation is active for a tab a session owns. */
function idbIsolationOn(): boolean {
  return featureOn('idb_isolation');
}

/** Exact cookie control, only when the user asked for it and the feature is available. */
function effectiveExact(): boolean {
  return settings.exact && featureOn('exact_mode');
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The posture actually in effect.
 *  How      |  The user's choice, unless it is Persona and that feature
 *           |  is unavailable, when it degrades to Mirror. The preference
 *           |  is kept, so Persona returns on its own once unlocked.
 * ------------------------------------------------------------------
 */
function effectivePosture(p: Settings['posture']): Settings['posture'] {
  return p === 'persona' && !featureOn('os_persona') ? 'mirror' : p;
}
function livePosture(): Settings['posture'] {
  return effectivePosture(settings.posture);
}

/** Last day the licence was refreshed against the server, so it happens once a day, not every wake. */
const LICENSE_REFRESH_KEY = 'nvx.license.refreshedAt';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Refresh the licence at most once per calendar day.
 *  How      |  The worker wakes constantly in MV3, so a stored day stamp
 *           |  throttles it, like the active beat.
 *  Note     |  A no-op on a free build or before a key is entered.
 * ------------------------------------------------------------------
 */
async function maybeRefreshLicense(): Promise<void> {
  if (!licensePossible() || !license.status().present) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const held = await storage.get([LICENSE_REFRESH_KEY]);
    if (held[LICENSE_REFRESH_KEY] === today) return;
    await storage.set({ [LICENSE_REFRESH_KEY]: today });
    await license.refresh();
  } catch {
    /* a missed refresh is harmless; the held token stands until its exp */
  }
}

/** The Pro tier snapshot the popup renders, shared by `state` and the licence commands. */
function licenseSnapshot(): {
  tier: ReturnType<Entitlement['tier']>;
  entitlements: Feature[];
  license: {
    present: boolean;
    device: string | null;
    possible: boolean;
    buildPro: boolean;
    dev: boolean;
    reason: string | null;
    exp: number | null;
    note: string | null;
  };
} {
  const d = entitlement.current();
  return {
    tier: entitlement.tier(),
    // Through featureOn, not entitlement.entitled, so a dev build reports every
    // feature as available and the settings screen unlocks the same controls the
    // worker does. Otherwise the UI would lock what the worker has already
    // unlocked for local development.
    entitlements: FEATURES.filter((f) => featureOn(f)),
    license: {
      present: license.status().present,
      device: license.status().device,
      possible: licensePossible(),
      buildPro: buildTier() === 'pro',
      dev: devUnlock(),
      reason: d.reason ?? null,
      exp: d.claims?.exp ?? null,
      note: d.claims?.note ?? null,
    },
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  This device's session structure, the subset that syncs.
 *  Note     |  The cookie jars, the derived families and the
 *           |  forked-origin bookkeeping are left out: they are contents
 *           |  or local state, not structure.
 * ------------------------------------------------------------------
 */
function syncReadConfig(): SyncConfig {
  const sessions: SyncSession[] = registry
    .listSessions()
    .filter((s) => s.id !== ANON && !reservedId(s.id) && !s.ephemeral)
    .map((s) => ({
      id: s.id,
      label: s.label,
      color: s.color,
      ...(s.group !== undefined ? { group: s.group } : {}),
      pinned: s.pinned ?? [],
      family: s.family ?? [],
      thirdParty: s.thirdParty === 'block' ? 'block' : 'allow',
      allowedParties: s.allowedParties ?? [],
      danger: s.danger,
      createdAt: s.createdAt,
      lastSeen: s.lastSeen,
    }));
  return { v: 1, sessions, updatedAt: Date.now() };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Apply a merged structure to the registry.
 *  How      |  Create sessions new here with an empty jar, update the
 *           |  metadata of existing ones, never touch a jar. Returns how
 *           |  many it created or changed.
 *  Note     |  A session from another device is a shell to sign into
 *           |  here, the DBSC-aligned model.
 * ------------------------------------------------------------------
 */
function syncApplyConfig(merged: SyncConfig): number {
  let changed = 0;
  const dirty: SessionId[] = [];
  for (const s of merged.sessions) {
    if (!s || typeof s.id !== 'string' || s.id === ANON || reservedId(s.id)) continue;
    const existing = registry.getSession(s.id);
    if (existing) {
      let d = false;
      const label = cleanLabel(s.label, existing.label);
      if (existing.label !== label) ((existing.label = label), (d = true));
      const color = cleanColor(s.color);
      if (existing.color !== color) ((existing.color = color), (d = true));
      const pinned = cleanPinned(s.pinned);
      if (existing.pinned.join('\n') !== pinned.join('\n')) ((existing.pinned = pinned), (d = true));
      const tp = cleanThirdParty(s.thirdParty);
      if (existing.thirdParty !== tp) ((existing.thirdParty = tp), (d = true));
      if (s.group !== undefined && existing.group !== s.group) ((existing.group = s.group), (d = true));
      if (d) (changed++, dirty.push(s.id));
    } else {
      registry.createSession({
        id: s.id,
        label: cleanLabel(s.label, s.id),
        color: cleanColor(s.color),
        ...(s.group !== undefined ? { group: s.group } : {}),
        pinned: cleanPinned(s.pinned),
        store: new CookieStore(),
        family: Array.isArray(s.family) ? s.family.filter((x): x is string => typeof x === 'string') : [],
        forked: [],
        danger: cleanDanger(s.danger),
        thirdParty: cleanThirdParty(s.thirdParty),
        allowedParties: Array.isArray(s.allowedParties)
          ? s.allowedParties.filter((x): x is string => typeof x === 'string')
          : [],
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
        lastSeen: typeof s.lastSeen === 'number' ? s.lastSeen : Date.now(),
      });
      changed++;
      dirty.push(s.id);
    }
  }
  if (changed) {
    engine.markDirty(dirty);
    void engine.flush();
    guard.markDirty(dirty);
    void guard.flush();
    for (const id of dirty) repaintSession(id);
    void registerAgent();
    scheduleRegroup();
    rebuildMenus();
    persistence.schedule();
  }
  return changed;
}

/** Last day sync ran against the server, so a background sync happens once a day, not every wake. */
const SYNC_AT_DAY_KEY = 'nvx.sync.day';

/** Runs a background sync at most once per calendar day, gated on the feature and a stored passphrase. */
async function maybeSync(): Promise<void> {
  if (!featureOn('sync') || !sync.status().enabled) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const held = await storage.get([SYNC_AT_DAY_KEY]);
    if (held[SYNC_AT_DAY_KEY] === today) return;
    await storage.set({ [SYNC_AT_DAY_KEY]: today });
    await sync.sync();
  } catch {
    /* a missed sync is harmless; the structure stands and the next wake retries */
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The coarse device profile telemetry attaches to its
 *           |  lifecycle events.
 *  How      |  Read from platform APIs and the user agent, mapped onto
 *           |  closed sets. Low resolution throughout: OS family not
 *           |  build, browser major not full version.
 *  Note     |  None of it is a fingerprinting surface.
 * ------------------------------------------------------------------
 */
function detectBrowser(ua: string): { browser: string; major: number } {
  const pick = (re: RegExp): number => {
    const m = re.exec(ua);
    return m ? Number(m[1]) : 0;
  };
  if (/OPR\/|Opera/.test(ua)) return { browser: 'opera', major: pick(/OPR\/(\d+)/) };
  if (/Edg\//.test(ua)) return { browser: 'edge', major: pick(/Edg\/(\d+)/) };
  if (/Vivaldi/.test(ua)) return { browser: 'vivaldi', major: pick(/Vivaldi\/(\d+)/) };
  if (/\bArc\//.test(ua)) return { browser: 'arc', major: pick(/Chrome\/(\d+)/) };
  if (/Chrome\//.test(ua)) return { browser: 'chrome', major: pick(/Chrome\/(\d+)/) };
  return { browser: 'other', major: 0 };
}

let envReady: Promise<void> | null = null;
function ensureEnv(): Promise<void> {
  if (envReady) return envReady;
  envReady = (async () => {
    const info = await chrome.runtime.getPlatformInfo().catch(() => null);
    const osMap: Record<string, string> = {
      win: 'windows',
      mac: 'macos',
      linux: 'linux',
      cros: 'chromeos',
      android: 'android',
      openbsd: 'other',
    };
    const archMap: Record<string, string> = {
      'x86-64': 'x86-64',
      arm64: 'arm64',
      arm: 'arm64',
      'x86-32': 'x86-32',
    };
    const ua = (globalThis.navigator?.userAgent ?? '') as string;
    const { browser, major } = detectBrowser(ua);
    const lang = (chrome.i18n?.getUILanguage?.() ?? 'en').split('-')[0] ?? 'en';
    // getTimezoneOffset is minutes and positive when behind UTC, so negate to a
    // conventional offset: UTC+10 comes back as -600 and becomes 10.
    const tz = -Math.round(new Date().getTimezoneOffset() / 60);
    telemetry.setEnv({
      os: (osMap[info?.os ?? ''] ?? 'other') as never,
      arch: (archMap[info?.arch ?? ''] ?? 'other') as never,
      browser: browser as never,
      browser_major: major,
      lang,
      tz,
    });
  })().catch(() => undefined);
  return envReady;
}

/** When this install first ran, and the last day it was seen active. */
const INSTALLED_AT_KEY = 'nvx.telemetry.installedAt';
const LAST_ACTIVE_KEY = 'nvx.telemetry.lastActive';
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Whether the install or update event has actually been sent
 *           |  once.
 *  How      |  Consent is off by default, so the install signal is
 *           |  dropped before opt-in and nothing retries it. This marker
 *           |  lets the first opt-in send the install it missed, once.
 * ------------------------------------------------------------------
 */
const INSTALL_REPORTED_KEY = 'nvx.telemetry.installReported';
/** The high-water engagement reading accumulated since the last beat. */
const USAGE_PEAK_KEY = 'nvx.telemetry.peak';
/** Which anomaly categories have been sent today, so each goes at most once a day. */
const ANOMALY_KEY = 'nvx.telemetry.anomaly';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Send an anomaly signal at most once per install per
 *           |  calendar day.
 *  How      |  The anomaly categories fire in bursts when something is
 *           |  wrong; the operator needs the daily rate per category, not
 *           |  the storm, so this dedupes on a stored day stamp.
 *  Note     |  The category is a closed enum with no host, count or
 *           |  value.
 * ------------------------------------------------------------------
 */
const anomalyToday = new Set<string>();
async function anomaly(category: TelemetryError): Promise<void> {
  if (!settings.telemetry) return;
  const today = new Date().toISOString().slice(0, 10);
  const key = `${today}:${category}`;
  // A synchronous fast path, so a burst in one worker cannot race the store.
  if (anomalyToday.has(key)) return;
  anomalyToday.add(key);
  try {
    const held = await storage.get([ANOMALY_KEY]);
    const rec = held[ANOMALY_KEY] as { day?: string; sent?: string[] } | undefined;
    const sent = rec && rec.day === today ? new Set(rec.sent ?? []) : new Set<string>();
    if (sent.has(category)) return;
    sent.add(category);
    await storage.set({ [ANOMALY_KEY]: { day: today, sent: [...sent] } });
    telemetry.error(category);
  } catch {
    /* an unsent anomaly is not worth a thrown anything */
  }
}

/** Sessions and managed tabs right now: the raw counts the beat then buckets. */
function usageNow(): { sessions: number; tabs: number } {
  const sessions = registry.listSessions().filter((s) => s.id !== ANON);
  const tabs = sessions.reduce((n, s) => n + registry.tabsFor(s.id).length, 0);
  return { sessions: sessions.length, tabs };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Keep a running high-water mark of engagement across the
 *           |  day.
 *  How      |  The daily beat samples at the first wake of a day, when
 *           |  engagement is least representative. Accumulating the peak
 *           |  from every state change lets the beat report something
 *           |  real.
 *  Note     |  A no-op while telemetry is off.
 * ------------------------------------------------------------------
 */
function recordUsage(): void {
  if (!settings.telemetry) return;
  void (async () => {
    try {
      const now = usageNow();
      const held = await storage.get([USAGE_PEAK_KEY]);
      const prev = (held[USAGE_PEAK_KEY] as { sessions?: number; tabs?: number } | undefined) ?? {};
      const next = {
        sessions: Math.max(now.sessions, Number(prev.sessions) || 0),
        tabs: Math.max(now.tabs, Number(prev.tabs) || 0),
      };
      if (next.sessions !== prev.sessions || next.tabs !== prev.tabs) {
        await storage.set({ [USAGE_PEAK_KEY]: next });
      }
    } catch {
      /* a missed sample is not worth a thrown anything */
    }
  })();
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Fire the once-a-day active beat, at most once per calendar
 *           |  day.
 *  How      |  Retention needs a heartbeat that repeats while used and
 *           |  stops when not. A stored day stamp gates it; it carries
 *           |  engagement buckets and the days-since-install cohort,
 *           |  never a date.
 *  Note     |  Serialised behind one in-flight promise so boot and
 *           |  onStartup cannot each send.
 * ------------------------------------------------------------------
 */
let activeInFlight: Promise<void> | null = null;
function maybeActive(): Promise<void> {
  if (activeInFlight) return activeInFlight;
  activeInFlight = activeOnce().finally(() => {
    activeInFlight = null;
  });
  return activeInFlight;
}

async function activeOnce(): Promise<void> {
  if (!settings.telemetry) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const held = await storage.get([LAST_ACTIVE_KEY, INSTALLED_AT_KEY, USAGE_PEAK_KEY]);
    if (held[LAST_ACTIVE_KEY] === today) return;
    const installedAt =
      typeof held[INSTALLED_AT_KEY] === 'number' ? (held[INSTALLED_AT_KEY] as number) : Date.now();
    // Report the peak accumulated since the last beat, which is the real
    // engagement of the window just ended, then start a fresh window from the
    // reading now. The current reading is folded in too, so a beat is never
    // lower than the live state at the moment it fires.
    const now = usageNow();
    const peak = (held[USAGE_PEAK_KEY] as { sessions?: number; tabs?: number } | undefined) ?? {};
    const sessions = Math.max(now.sessions, Number(peak.sessions) || 0);
    const tabs = Math.max(now.tabs, Number(peak.tabs) || 0);
    await storage.set({
      [LAST_ACTIVE_KEY]: today,
      [INSTALLED_AT_KEY]: installedAt,
      [USAGE_PEAK_KEY]: now,
    });
    await ensureEnv();
    telemetry.active({
      sessions: bucketCount(sessions),
      tabs: bucketCount(tabs),
      since_install: daysBucket((Date.now() - installedAt) / 86_400_000),
    });
  } catch {
    /* a missed heartbeat is not worth a thrown boot */
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The native host, optional by design.
 *  Note     |  The Store build cannot ship a binary, so every host
 *           |  capability has a degraded path and absence is normal.
 * ------------------------------------------------------------------
 */
const native = new NativeHost();
/**
 * ------------------------------------------------------------------
 *  Purpose  |  The blast-radius guard.
 *  Note     |  Its rules live in their own id band below the sessions',
 *           |  so a session with many hosts cannot spend its guardrails
 *           |  unnoticed.
 * ------------------------------------------------------------------
 */
const guard = new Guard(
  backend,
  () =>
    registry.listSessions().map((s) => ({
      id: s.id,
      label: s.label,
      danger: s.danger,
      tabIds: registry.tabsFor(s.id),
    })),
  undefined,
  /**
   * Never silent. A session past the band is still watched and still logged,
   * but nothing it does is refused, and a guardrail that is quietly absent is
   * worse than one that was never offered.
   *
   * Journalled rather than only logged, because this cannot happen on the
   * profile anybody develops against. It needs more sessions than the band has
   * ids for, which means it arrives on a heavily used browser, months in, to
   * somebody who has no reason to have a console open. The journal is the only
   * place that reader will ever look.
   */
  (ids) =>
    note('error', 'guard', 'more sessions than the guard has rule ids for', {
      detail: `${ids.length} watched but not refused: ${ids.join(', ')}`,
    })
);
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Tabs whose document is older than the mask, left entirely
 *           |  real until they load again.
 *  How      |  A content script only enters a document as it loads, so
 *           |  switching the posture on cannot reach a page already
 *           |  sitting there. Covering only its headers is worse than
 *           |  nothing: the page reports one browser and its requests
 *           |  another.
 *  Note     |  A tab leaves the set the moment it navigates. Mirrored
 *           |  into chrome.storage.session; losing it silently puts the
 *           |  incoherence back.
 * ------------------------------------------------------------------
 */
const unmaskedTabs = new Set<number>();

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Origins observed using IndexedDB, the one storage this
 *           |  extension does not separate.
 *  Note     |  Browser-session scoped, not persisted: it is what pages
 *           |  did while this browser was open, not a claim about the
 *           |  site in general.
 * ------------------------------------------------------------------
 */
const idbSites = new Set<string>();

/** Hosts each session most recently overflowed, so a sign-in step can name a dropped rule. */
const lastOverflow = new Map<SessionId, Set<string>>();

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Coalesce the recompile that a page-set cookie triggers.
 *  How      |  A chatty page writes document.cookie many times a second;
 *           |  writes are gathered and one flush follows a short quiet,
 *           |  still inside a network round trip.
 * ------------------------------------------------------------------
 */
let cookieFlushTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCookieFlush(sessionId: SessionId): void {
  engine.markDirty([sessionId]);
  persistence.schedule();
  if (cookieFlushTimer) return;
  cookieFlushTimer = setTimeout(() => {
    cookieFlushTimer = null;
    void engine.flush();
  }, 40);
}

/** Icon candidates last reported per tab, so a rebind repaints without a round trip. */
const lastIcons = new Map<number, IconCandidate[]>();
/** What each tab is currently wearing, so a burst of events sends one message. */
const paintedAs = new Map<number, string>();

function declarativeEngine(): Engine {
  return new Engine(registry, backend, {
    enabled: () => !settings.paused,
    // Fail-closed, the Pro feature: strip cookies from every out-of-scope host a
    // managed tab touches, not just the ones the jar already holds, so a host the
    // session has no rule for sends nothing rather than falling through to the
    // browser's own jar. Read per flush, because both the setting and the licence
    // that entitles it can change while the worker is alive.
    strictWhen: () => settings.failClosed && featureOn('fail_closed'),
    // Cache isolation, the Pro feature: force a session's tabs to not cache, so
    // the shared HTTP cache cannot carry state across sessions on one origin. Read
    // per flush, same as strict, since setting and licence can both change live.
    cacheWhen: () => settings.cacheIsolation && featureOn('cache_isolation'),
    onOverflow: (session, domains) => {
      // Kept so the per-step sign-in log can say a navigation landed on a host
      // whose rule was dropped, which is the difference between "this loop is
      // the site's problem" and "this loop is ours". Keyed by session id, which
      // is what onOverflow hands over.
      lastOverflow.set(session, new Set(domains));
      note('warn', 'rules', 'a session exceeded its rule budget', {
        session,
        detail: `dropped ${domains.join(', ')}`,
      });
      void anomaly('rule_overflow');
    },
    /**
     * Both of these mean a managed tab has stopped being isolated, and neither
     * can happen on a small profile: a rejection needs a rule shape nothing in
     * the suites produces, and a drop needs the browser's whole session rule
     * ceiling to be full. The leak counter would eventually notice the symptom,
     * a request carrying a cookie its session does not own, but nothing would
     * ever say why. So they are recorded where the answer is looked for.
     */
    onReport: (r) => {
      if (r.rejected.length) {
        note('error', 'rules', 'the browser refused rules', {
          session: r.sessions.join(', '),
          detail: r.rejected
            .slice(0, 4)
            .map((x) => `${x.rule.id}: ${x.error}`)
            .join(' | '),
        });
        telemetry.error('apply_failed');
      }
      if (r.dropped.length) {
        note('error', 'rules', 'rules dropped past the browser ceiling', {
          session: r.sessions.join(', '),
          detail: `${r.dropped.length} of ${r.dropped.length + r.added} did not fit, so those hosts are not isolated`,
        });
        telemetry.error('apply_failed');
      }
    },
  });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Who owns a request, for the blocking backend.
 *  How      |  A tab id resolves through its binding. A request with no
 *           |  tab is worker traffic, looked up by who owns the origin at
 *           |  the moment it is asked.
 * ------------------------------------------------------------------
 */
function ownerOf(details: { tabId: number; url: string }): Owner {
  const binding = registry.binding(details.tabId);
  const session = binding
    ? registry.getSession(binding.sessionId)
    : details.tabId < 0
      ? ownerSessionFor(details.url)
      : undefined;
  return session ? { id: session.id, store: session.store } : null;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The backend is chosen once, by manifest version.
 *  Note     |  Not by feature detection: on MV3 a blocking listener is
 *           |  accepted and then ignored, so the API being present proves
 *           |  nothing.
 * ------------------------------------------------------------------
 */
function buildNetfilter(): Netfilter {
  if (!blockingIsReal()) return declarativeEngine();
  const api = browserBlockingApi();
  if (!api) {
    console.warn('[nvx] manifest is v2 but webRequest is missing, falling back to rules');
    return declarativeEngine();
  }
  const filter = new BlockingNetfilter(api, ownerOf, {
    // Manifest v2 has no rules to install, so the guard enforces itself here.
    // The observation listener has already recorded the decision; this is only
    // the refusal.
    veto: (details, sessionId) => {
      if (!GUARDED_METHODS.has(details.method?.toUpperCase() ?? '')) return false;
      const session = sessionId ? registry.getSession(sessionId) : undefined;
      if (!session || cleanDanger(session.danger) !== 'block') return false;
      // Named verdict, not decided: `decided` is the chooser's map of tabs
      // that have already answered, and shadowing it here would read as that.
      const verdict = decide({ url: details.url, method: details.method ?? '' }, 'block', CATALOG);
      if (verdict?.action !== 'blocked') return false;
      return !guard.unlocksFor(session.id).some((u) => u.rule === verdict.finding.entry.id);
    },
    onError: (err, details) =>
      console.error('[nvx] the blocking rewrite threw, request went out unmodified', details.url, err),
  });
  filter.install();
  console.info('[nvx] blocking backend active: no rule ceiling, no flush race');
  return filter;
}

let engine: Netfilter = buildNetfilter();

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Exact per-request rewriting, for the declarative backend
 *           |  only.
 *  How      |  The declarative backend installs rules before a request
 *           |  leaves, and a redirect chain does not wait; measured on
 *           |  Moodle behind Okta, every hop went out stale and looped.
 *  Note     |  Costs a visible infobar, so it is a setting rather than an
 *           |  assumption.
 * ------------------------------------------------------------------
 */
const exactApi = browserDebuggerApi();
const exact =
  exactApi && !blockingIsReal()
    ? new ExactInterceptor(exactApi, ownerOf, {
        onError: (err, where) => console.error(`[nvx] exact ${where} failed`, err),
        onLost: (tabId, reason) => {
          // The tab is unprotected until the rules are back, so this is the one
          // path that must not wait for a debounce.
          console.warn(`[nvx] exact mode lost on tab ${tabId}: ${reason}`);
          const binding = registry.binding(tabId);
          if (binding) {
            engine.markDirty([binding.sessionId]);
            void engine.flush();
          }
        },
      })
    : null;

/** Domains a tab's session has an opinion about, for the interception scope. */
function watchedDomains(sessionId: SessionId, url: string): string[] {
  const session = registry.getSession(sessionId);
  if (!session) return [];
  const out = new Set<string>(session.store.domains());
  for (const p of session.pinned) {
    const d = domainOf(`https://${p}/`) || p;
    if (d) out.add(d);
  }
  const here = domainOf(url);
  if (here) out.add(here);
  return [...out];
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Bring interception in line with the bindings.
 *  How      |  Called from the one place every mutation passes through,
 *           |  so a tab that gains, loses or changes a session is engaged
 *           |  or released with no separate bookkeeping.
 * ------------------------------------------------------------------
 */
function syncExact(): void {
  if (!exact) return;
  const wanted = new Map<number, SessionId>();
  if (effectiveExact()) {
    for (const b of registry.listBindings()) {
      if (b.sessionId === ANON) continue;
      wanted.set(b.tabId, b.sessionId);
    }
  }
  for (const tabId of exact.liveTabs()) {
    if (!wanted.has(tabId)) void exact.release(tabId);
  }
  for (const [tabId, sessionId] of wanted) {
    const url = registry.binding(tabId)?.url ?? '';
    void exact.engage(tabId, watchedDomains(sessionId, url)).then((r) => {
      if (!r.ok && r.reason) console.info(`[nvx] tab ${tabId} keeps rules only: ${r.reason}`);
    });
  }
}

let ready: Promise<void> | null = null;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The chooser.
 *  How      |  A federated site signs you in before you were asked; this
 *           |  offers an account picker because the jar is ours to
 *           |  withhold. ANON is a real session with a permanently empty
 *           |  jar, bound first so the first request carries nothing.
 * ------------------------------------------------------------------
 */
const ANON = ANON_SESSION_ID;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Registrable domains a tab has already answered for, so it
 *           |  is asked once.
 *  Note     |  Session scoped, not worker scoped: an answer given five
 *           |  minutes ago outlives the worker that heard it.
 * ------------------------------------------------------------------
 */
const decided = new Map<number, Set<string>>();
const agents = new Map<number, chrome.runtime.Port>();

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A question that has been asked but not answered, held
 *           |  against the tab.
 *  How      |  The chooser is a DOM overlay, so it dies with the
 *           |  document. A federated site redirects within a second,
 *           |  taking the question with it.
 *  Note     |  Holding it here re-renders the same question on each hop
 *           |  and remembers where the chain started.
 * ------------------------------------------------------------------
 */
interface Pending {
  /** Where the question was raised, and where answering returns to. */
  url: string;
  host: string;
  options: ReturnType<typeof chooserOptionsFor>;
}
const pending = new Map<number, Pending>();

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Tabs whose navigation is being held at the picker, and
 *           |  where they were going.
 *  Note     |  Set before anything is awaited, so two listeners noticing
 *           |  the same navigation cannot each send the tab to the
 *           |  picker.
 * ------------------------------------------------------------------
 */
const held = new Map<number, string>();

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Which session a closed tab was in, by origin.
 *  How      |  A reopened tab knows nothing; without this it lands
 *           |  unbound, gets asked again, and reads as signed out. An
 *           |  hour is the span in which reopening is plainly the same
 *           |  work.
 *  Note     |  The hour is only real because this map is mirrored into
 *           |  session storage. See ephemeral.ts.
 * ------------------------------------------------------------------
 */
const REOPEN_WINDOW_MS = 60 * 60 * 1000;
const REOPEN_MEMORY = 60;
const recentlyClosed = new Map<string, { sessionId: SessionId; at: number }[]>();

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Mirror the two maps above into storage that outlives the
 *           |  worker.
 *  How      |  Read through a closure rather than handed the maps, so it
 *           |  always writes what is live.
 * ------------------------------------------------------------------
 */
/**
 * ------------------------------------------------------------------
 *  Purpose  |  What the extension did, kept on disk.
 *  How      |  Every console line goes through note below and lands here,
 *           |  and so do decisions that never had a console line. The
 *           |  console is erased by a restart, a close and a reboot, the
 *           |  three events between noticing and being asked.
 *  Note     |  Nothing sensitive reaches it; the rules are enforced in
 *           |  journal.ts.
 * ------------------------------------------------------------------
 */
const journal = new Journal(storage, {
  floor: () => settings.logLevel,
  onError: (e) => console.warn('[nvx] the journal could not be written', e),
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Say something, once, to both places that need to hear it.
 *  How      |  The console is for whoever has devtools open now; the
 *           |  journal is for whoever reads it an hour later. Writing to
 *           |  one and not the other is how the two drift.
 * ------------------------------------------------------------------
 */
function note(
  level: Level,
  area: Area,
  event: string,
  extra: { detail?: string; session?: string; tabId?: number; host?: string; url?: string } = {}
): void {
  journal.write({ level, area, event, ...extra });
  if (level === 'debug') return;
  const parts = [
    `[nvx] ${event}`,
    extra.session ? `session=${extra.session}` : '',
    typeof extra.tabId === 'number' ? `tab=${extra.tabId}` : '',
    extra.host ?? '',
    extra.detail ?? '',
  ].filter(Boolean);
  const line = parts.join(' ');
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

const ephemeral = new Ephemeral(
  sessionArea,
  () => ({ reopen: recentlyClosed, decided, unmasked: unmaskedTabs }),
  { onError: (e) => console.warn('[nvx] session state could not be written', e) }
);

/** Bindings whose tabs were gone at the last boot, waiting for a browser start. */
let lastOrphans: Orphan[] = [];

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Third parties seen in each session's tabs, kept per
 *           |  session.
 *  Note     |  That is the unit the setting applies to and the unit the
 *           |  user reads it in.
 * ------------------------------------------------------------------
 */
const thirdParties = new Map<SessionId, ThirdPartyLog>();

function thirdPartyLog(sessionId: SessionId): ThirdPartyLog {
  let log = thirdParties.get(sessionId);
  if (!log) {
    log = new ThirdPartyLog();
    thirdParties.set(sessionId, log);
  }
  return log;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Record a closed tab so reopening it rejoins the session it
 *           |  was in.
 *  How      |  A queue per origin, consumed rather than remembered. A
 *           |  queue gets the count right: three tabs closed in Work earn
 *           |  three reopens, and the fourth visit is a question.
 *  Bug-Fix  |  A single entry silently joined every later visit for an
 *           |  hour, the "it assumed I was the student account" report.
 *           |  Popping most recent first unwinds two sessions in close
 *           |  order.
 * ------------------------------------------------------------------
 */
const REOPEN_PER_ORIGIN = 8;

function rememberClosedTab(tabId: number): void {
  const binding = registry.binding(tabId);
  if (!binding) return;
  const session = registry.getSession(binding.sessionId);
  if (!session || reservedId(session.id)) return;
  const origin = originOf(binding.url);
  if (!origin) return;

  const queue = recentlyClosed.get(origin) ?? [];
  queue.push({ sessionId: session.id, at: Date.now() });
  // Bounded per origin as well as overall. A page that opens and closes tabs on
  // itself should not be able to fill this on its own.
  if (queue.length > REOPEN_PER_ORIGIN) queue.splice(0, queue.length - REOPEN_PER_ORIGIN);
  // Re-inserted, so this origin becomes the newest key and the eviction below
  // takes the genuinely least recent one.
  recentlyClosed.delete(origin);
  recentlyClosed.set(origin, queue);

  // Bounded, oldest first. A map that only grows is a leak in a worker that is
  // meant to be cheap enough to leave running.
  while (recentlyClosed.size > REOPEN_MEMORY) {
    const oldest = recentlyClosed.keys().next().value;
    if (oldest === undefined) break;
    recentlyClosed.delete(oldest);
  }
  ephemeral.schedule();
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The session a tab on this url was in until recently, if it
 *           |  still exists.
 *  How      |  Consumes what it returns. One close earns one reopen;
 *           |  after that a domain two sessions cover is a question, not
 *           |  a guess.
 * ------------------------------------------------------------------
 */
/**
 * ------------------------------------------------------------------
 *  Purpose  |  The same answer, without taking it.
 *  How      |  The picker draws a "last used here" hint, and drawing it
 *           |  must not spend the memory that the next Ctrl+Shift+T
 *           |  needs.
 *  Note     |  The window is a tab closing on the same origin while the
 *           |  picker is on screen, milliseconds wide and real.
 * ------------------------------------------------------------------
 */
function peekRemembered(url: string): SessionId | null {
  const origin = originOf(url);
  if (!origin) return null;
  const queue = recentlyClosed.get(origin);
  if (!queue?.length) return null;
  const now = Date.now();
  for (let i = queue.length - 1; i >= 0; i--) {
    const seen = queue[i]!;
    if (now - seen.at > REOPEN_WINDOW_MS) return null;
    if (registry.getSession(seen.sessionId)) return seen.sessionId;
  }
  return null;
}

function rememberedFor(url: string): SessionId | null {
  const origin = originOf(url);
  if (!origin) return null;
  const queue = recentlyClosed.get(origin);
  if (!queue?.length) return null;

  const now = Date.now();
  let answer: SessionId | null = null;
  while (queue.length) {
    const seen = queue.pop()!;
    if (now - seen.at > REOPEN_WINDOW_MS) {
      // Expired, and so is everything under it: the queue is in close order.
      queue.length = 0;
      break;
    }
    // A session deleted since the tab closed is not an answer, but the entry
    // below it may still be one.
    if (registry.getSession(seen.sessionId)) {
      answer = seen.sessionId;
      break;
    }
  }
  if (!queue.length) recentlyClosed.delete(origin);
  // Consuming is a mutation like recording one. Without this a worker that
  // restarts after a reopen finds the entry still there and rejoins a second
  // tab that should have been asked about, which is the exact failure the queue
  // was introduced to stop.
  ephemeral.schedule();
  return answer;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Which sessions this tab could be, not which already have
 *           |  an account here.
 *  How      |  A session holding cookies for the domain is an identity to
 *           |  resume; a session pinning the domain is the user having
 *           |  said this session is for this site.
 *  Note     |  Leaving the second kind out makes signing in as a second
 *           |  account impossible.
 * ------------------------------------------------------------------
 */
function chooserOptionsFor(host: string) {
  const domain = domainOf(`https://${host}/`) || host;
  return registry
    .sessionsCovering(domain)
    .map((id) => registry.getSession(id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s) && s!.id !== ANON)
    .map((s) => {
      const held = s.store.forDomain(domain);
      const identity = identityFrom(held);
      return {
        sessionId: s.id,
        label: s.label,
        color: s.color,
        ...(identity ? { identity: identity.label } : {}),
        cookies: held.length,
      };
    });
}

function ensureAnonymous(): void {
  const existing = registry.getSession(ANON);
  if (existing) {
    // Restored from a snapshot written before it was marked ephemeral, so the
    // flag is reapplied and whatever an older build let it keep is dropped.
    existing.ephemeral = true;
    if (existing.store.size) {
      existing.store.clear();
      engine.markDirty([ANON]);
      persistence.schedule();
    }
    return;
  }
  registry.createSession({
    id: ANON,
    label: 'Not signed in',
    color: 'grey',
    pinned: [],
    store: new CookieStore(),
    family: [],
    forked: [],
    danger: DEFAULT_DANGER,
    thirdParty: DEFAULT_THIRD_PARTY,
    ephemeral: true,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  });
}

/** Every session the user could put this tab in, for a deliberate re-pick. */
function allOptionsFor(host: string) {
  const domain = domainOf(`https://${host}/`) || host;
  return registry
    .listSessions()
    .filter((s) => s.id !== ANON)
    .map((s) => {
      const identity = identityFrom(s.store.forDomain(domain));
      return {
        sessionId: s.id,
        label: s.label,
        color: s.color,
        ...(identity ? { identity: identity.label } : {}),
        cookies: s.store.forDomain(domain).length,
      };
    });
}

async function maybeOfferChoice(tabId: number, url: string, force = false): Promise<boolean> {
  const host = hostOf(url);
  if (!host) return false;
  const registrable = domainOf(url);
  if (!force && decided.get(tabId)?.has(registrable)) return false;

  const options = force ? allOptionsFor(host) : chooserOptionsFor(host);
  if (!options.length) return false;

  const binding = registry.binding(tabId);
  const current = binding?.sessionId ?? null;

  // Bound to a real session that could sign in here, and it is the only
  // candidate. Nothing to choose.
  if (
    !force &&
    current &&
    current !== ANON &&
    options.length === 1 &&
    options[0]!.sessionId === current
  ) {
    return false;
  }

  // A forced re-pick is the user deliberately switching a tab they are looking
  // at. Withholding the jar first would sign them out of the page they asked
  // about before they had chosen anything.
  const parked = !force && (!binding || current === ANON);
  if (parked) {
    // Withhold everything until the choice is made, so the page cannot sign
    // the user in behind the prompt.
    ensureAnonymous();
    if (!binding) {
      const m = registry.bind(tabId, ANON, {
        windowId: chrome.windows.WINDOW_ID_NONE,
        url,
        origin: 'manual',
      });
      engine.markDirty(m.dirty);
      await engine.flush();
    }
  }

  // A parked tab has nothing to lose by an injection and everything to lose by
  // silence: waiting for an agent that has not connected yet means the question
  // is never asked, and the tab signs in under whatever it was parked as.
  const port = force || parked ? await ensureAgent(tabId) : (agents.get(tabId) ?? null);
  if (!port) return false;
  // Held before posting, so a redirect that lands before the user answers can
  // put the same question up again rather than losing it.
  if (parked && !pending.has(tabId)) pending.set(tabId, { url, host, options });
  try {
    port.postMessage({ kind: 'chooser', host, options, currentSessionId: current });
    return true;
  } catch {
    agents.delete(tabId);
    return false;
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Put an unanswered question back up after a navigation
 *           |  destroyed it.
 *  How      |  The question is the one raised where the chain started,
 *           |  not a fresh one. An identity provider is a stop on the
 *           |  way, and no session covers it, so recomputing would offer
 *           |  nothing.
 * ------------------------------------------------------------------
 */
async function reoffer(tabId: number, url: string): Promise<boolean> {
  const held = pending.get(tabId);
  if (!held) return maybeOfferChoice(tabId, url);
  const port = await ensureAgent(tabId);
  if (!port) return false;
  try {
    port.postMessage({
      kind: 'chooser',
      host: held.host,
      options: held.options,
      currentSessionId: ANON,
    });
    return true;
  } catch {
    agents.delete(tabId);
    return false;
  }
}

/** A short note in the page, for something already done on the user's behalf. */
function noteInTab(tabId: number, text: string, accent: string, strong?: string): void {
  const port = agents.get(tabId);
  if (!port) return;
  try {
    port.postMessage({ kind: 'note', text, accent, ...(strong ? { strong } : {}) });
  } catch {
    agents.delete(tabId);
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  What an unbound tab does when it is about to load
 *           |  something.
 *  How      |  Four answers, in order of how much the user has told us: a
 *           |  reopened tab rejoins, a domain one session pins joins it,
 *           |  a domain several cover is held at the picker, anything
 *           |  else is left alone.
 *  Note     |  Holding rather than asking over the page is the whole
 *           |  change. Measured: an empty holding pen looped a Moodle
 *           |  sign-in; a populated one signed the second tab in as the
 *           |  first.
 * ------------------------------------------------------------------
 */
/**
 * ------------------------------------------------------------------
 *  Purpose  |  One line per binding, the question the journal exists to
 *           |  answer.
 *  Note     |  "My tab ended up in the wrong account" is the one report
 *           |  that cannot be reproduced on demand; the answer is which
 *           |  of the four rules claimed the tab.
 * ------------------------------------------------------------------
 */
function noteBinding(tabId: number, sessionId: SessionId, why: string, url: string): void {
  note('info', 'tab', 'bound', {
    tabId,
    session: registry.getSession(sessionId)?.label ?? sessionId,
    detail: why,
    url,
  });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Sites this extension has been told to leave alone,
 *           |  permanently.
 *  Note     |  The earlier escape hatches were per-tab, unbinding, or
 *           |  deleting a session; none was "this site and this extension
 *           |  cannot work together, stop trying".
 * ------------------------------------------------------------------
 */
function isReleased(domain: string): boolean {
  return settings.released.includes(domain);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A tab that is in a session before it makes its first
 *           |  request.
 *  How      |  A federated login breaks on a partial cookie set, so the
 *           |  binding and rules are in place first: an empty tab, bound,
 *           |  flushed, scripts registered, then pointed at the site.
 *  Note     |  The domain is pinned too, so the account sticks and the
 *           |  picker becomes the switcher.
 * ------------------------------------------------------------------
 */
async function openInSession(
  sessionId: string,
  raw: string
): Promise<{ ok: boolean; tabId?: number; reason?: string }> {
        const session = registry.getSession(sessionId);
        if (!session) {
          return { ok: false, reason: 'no such session' };
        }
        const target = raw.trim();
        const url = /^https?:\/\//i.test(target)
          ? target
          : target
            ? `https://${target}`
            : '';
        const domain = url ? domainOf(url) : '';

        if (domain && !session.pinned.includes(domain)) {
          session.pinned = [...session.pinned, domain].sort();
        }

        let tab: chrome.tabs.Tab;
        try {
          tab = await chrome.tabs.create({ url: 'about:blank', active: true });
        } catch (e) {
          return { ok: false, reason: String(e) };
        }
        if (typeof tab.id !== 'number') {
          return { ok: false, reason: 'the tab could not be opened' };
        }

        touched(
          registry.bind(tab.id, session.id, {
            windowId: tab.windowId ?? chrome.windows.WINDOW_ID_NONE,
            url: url || 'about:blank',
            origin: 'manual',
          }),
          true
        );
        noteBinding(tab.id, session.id, 'opened to sign in', url || 'about:blank');
        // Rules and scripts in place before the real navigation, which is the
        // point of the whole command.
        await engine.flush();
        await registerAgent();
        pushStorage(tab.id);
        persistence.schedule();

        if (url) {
          try {
            await chrome.tabs.update(tab.id, { url });
          } catch {
            /* the tab closed while this was being set up */
          }
        }
        repaintSession(session.id);
        return { ok: true, tabId: tab.id };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Stop managing a site, everywhere, and put its open tabs
 *           |  back.
 *  Note     |  Unbinding the tabs is the half that matters; adding the
 *           |  domain only stops the next claim.
 * ------------------------------------------------------------------
 */
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Reserved rule id for the move guard.
 *  How      |  Sits in the gap between the posture band (10..25) and the
 *           |  guard band (100+), so it collides with nothing. One id
 *           |  covers any number of tabs via condition.tabIds.
 * ------------------------------------------------------------------
 */
const MOVE_BLOCK_ID = 30;
/** Above every compiled priority, so the transient block dominates. */
const PRIORITY_MOVE_BLOCK = 2000;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Serialise moves so two of them cannot interleave.
 *  How      |  A batch move rebinds several tabs then recompiles; two at
 *           |  once could rebind a tab twice and flush a registry the
 *           |  other is editing. Chaining makes the second wait.
 * ------------------------------------------------------------------
 */
let moving: Promise<unknown> = Promise.resolve();

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The last single-tab move made with no surface open to undo
 *           |  it.
 *  How      |  A move from the menu or a shortcut happens with the popup
 *           |  closed, so this remembers the one most recent such move
 *           |  for the popup to offer back.
 *  Note     |  Cleared when undone, when the tab moves again, or when it
 *           |  closes.
 * ------------------------------------------------------------------
 */
interface LastMove {
  tabId: number;
  from: SessionId | null;
  to: SessionId | null;
  label: string;
  at: number;
}
let lastMove: LastMove | null = null;
/**
 * ------------------------------------------------------------------
 *  Purpose  |  How long a closed-surface move stays offered for undo.
 *  Note     |  Long enough to open the popup and notice, short enough
 *           |  that it is never a stale surprise.
 * ------------------------------------------------------------------
 */
const LAST_MOVE_TTL_MS = 90_000;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Move many tabs into one session at once, with no window
 *           |  where a tab leaks the wrong account.
 *  How      |  Ten moves one at a time is ten windows for a half-applied
 *           |  request, so the whole batch is one operation with one
 *           |  recompile, wrapped in a block naming every moving tab at a
 *           |  priority above the header rewrites.
 *  Note     |  Those tabs cannot request for the few ms the swap takes,
 *           |  the correct trade: a request that waits is fine, one that
 *           |  carries the wrong cookies is the whole failure.
 * ------------------------------------------------------------------
 */
async function moveTabs(
  tabIds: number[],
  sessionId: string | null,
  opts: { remember?: boolean } = {}
): Promise<{ ok: boolean; moved: number; reloaded: number; reason?: string }> {
  const run = async (): Promise<{ ok: boolean; moved: number; reloaded: number; reason?: string }> => {
    const ids = [...new Set(tabIds)].filter((n) => typeof n === 'number' && n >= 0);
    if (!ids.length) return { ok: false, moved: 0, reloaded: 0, reason: 'nothing selected' };
    if (sessionId !== null && !registry.getSession(sessionId)) {
      return { ok: false, moved: 0, reloaded: 0, reason: 'no such session' };
    }

    // For a remembered single-tab move, where it was, captured before the move
    // rebinds it, so the popup can offer to put it back.
    const priorSession =
      opts.remember && ids.length === 1 ? registry.binding(ids[0]!)?.sessionId ?? null : undefined;

    // Any other move of the same tab makes a remembered undo point at the wrong
    // state, so it is dropped rather than left to mislead.
    if (lastMove && priorSession === undefined && ids.includes(lastMove.tabId)) lastMove = null;

    // Block first, so no moving tab can send a request under the wrong identity
    // while the swap is in flight. Only on the declarative backend; the MV2
    // blocking listener resolves ownership per request at send time and has no
    // such window to close.
    const blocked = engine instanceof Engine;
    if (blocked) {
      await backend
        .apply(
          [
            {
              id: MOVE_BLOCK_ID,
              priority: PRIORITY_MOVE_BLOCK,
              action: { type: 'block' },
              condition: { tabIds: ids },
            },
          ],
          []
        )
        .catch(() => undefined);
    }

    const affected = new Set<SessionId>();
    const toReload: number[] = [];
    let moved = 0;

    for (const tabId of ids) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const url = tab?.url ?? registry.binding(tabId)?.url ?? '';
      if (sessionId === null) {
        const m = registry.unbind(tabId);
        touched(m);
        for (const id of m.dirty) affected.add(id);
      } else {
        const m = registry.bind(tabId, sessionId, {
          windowId: tab?.windowId ?? chrome.windows.WINDOW_ID_NONE,
          url,
          origin: 'manual',
        });
        touched(m);
        for (const id of m.dirty) affected.add(id);
        for (const id of m.needsReload) toReload.push(id);
        noteBinding(tabId, sessionId, 'moved in a batch', url);
      }
      resetStorageStamp(tabId);
      storageState.delete(tabId);
      moved++;
    }

    // One recompile for the whole batch.
    engine.markDirty([...affected]);
    await engine.flush();

    // New rules are live, so the block can come off. Order matters: remove the
    // block only after the flush, or a tab would resume under the old rules.
    if (blocked) {
      await backend.apply([], [MOVE_BLOCK_ID]).catch(() => undefined);
    }

    for (const tabId of ids) pushStorage(tabId);
    await registerAgent();
    persistence.schedule();

    // Sealed tabs have already spoken under their old identity, which rules
    // cannot retract, so they reload to speak again under the new one. Unsealed
    // tabs simply continue, now covered.
    let reloaded = 0;
    for (const tabId of new Set(toReload)) {
      try {
        await chrome.tabs.reload(tabId);
        reloaded++;
      } catch {
        /* the tab closed during the move */
      }
    }

    if (sessionId) repaintSession(sessionId);
    note('info', 'tab', 'moved a batch of tabs', {
      session: sessionId ? registry.getSession(sessionId)?.label ?? sessionId : 'unbound',
      detail: `${moved} tab(s), ${reloaded} reloaded`,
    });

    // Remember a move the popup could not offer to undo at the time, so it can
    // the next time it opens. Only for single-tab moves from a closed surface,
    // and only when the tab actually changed session.
    if (priorSession !== undefined && priorSession !== sessionId) {
      lastMove = {
        tabId: ids[0]!,
        from: priorSession,
        to: sessionId,
        label: sessionId ? registry.getSession(sessionId)?.label ?? sessionId : 'no session',
        at: Date.now(),
      };
    }
    return { ok: true, moved, reloaded };
  };

  const next = moving.then(run, run);
  moving = next.catch(() => undefined);
  return next;
}

async function releaseSite(domain: string, why: string): Promise<number> {
  if (!domain || isReleased(domain)) return 0;
  settings = { ...settings, released: [...settings.released, domain].sort() };

  let freed = 0;
  for (const binding of registry.listBindings()) {
    if (domainOf(binding.url) !== domain) continue;
    touched(registry.unbind(binding.tabId));
    resetStorageStamp(binding.tabId);
    pushStorage(binding.tabId);
    storageState.delete(binding.tabId);
    void paintTab(binding.tabId);
    freed++;
  }

  await engine.flush();
  persistence.schedule();
  await persistence.save();
  await registerAgent();

  note('warn', 'session', 'a site was released', {
    host: domain,
    detail: `${why}; ${freed} tab(s) handed back to the browser`,
  });
  return freed;
}

async function unreleaseSite(domain: string): Promise<void> {
  if (!isReleased(domain)) return;
  settings = { ...settings, released: settings.released.filter((d) => d !== domain) };
  persistence.schedule();
  await persistence.save();
  await registerAgent();
  note('info', 'session', 'a released site is managed again', { host: domain });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A sign-in that will not finish, caught while it is still
 *           |  recoverable.
 *  How      |  Two signals, believed differently. ERR_TOO_MANY_REDIRECTS
 *           |  is the browser giving up, so one is enough. Counting
 *           |  main-frame hops to one registrable domain catches loops
 *           |  that never reach the browser limit: eight in fifteen
 *           |  seconds, which a real sign-in never does.
 *  Note     |  A partial cookie set at a federated provider reads as
 *           |  stolen, and the provider answers by invalidating the
 *           |  account everywhere.
 * ------------------------------------------------------------------
 */
const LOOP_HOPS = 8;
const LOOP_WINDOW_MS = 15_000;
/** Per tab, the recent main frame arrivals, as [domain, at]. */
const hops = new Map<number, Array<[string, number]>>();

/**
 * ------------------------------------------------------------------
 *  Purpose  |  One journal line per step of a managed sign-in.
 *  How      |  A federated sign-in fails at one host: a dropped rule so
 *           |  the browser jar goes out, or a host with no cookie so the
 *           |  provider sees a signed-out set. Recording the host,
 *           |  whether its rule survived, and how many cookies are held
 *           |  turns "it looped" into why.
 *  Note     |  No cookie values and no query string.
 * ------------------------------------------------------------------
 */
function noteSignInStep(tabId: number, sessionId: SessionId, url: string): void {
  const host = hostOf(url);
  if (!host) return;
  const session = registry.getSession(sessionId);
  if (!session) return;
  const registrable = registrableDomain(host);
  const held = session.store.forDomain(registrable).length;
  const dropped = lastOverflow.get(sessionId)?.has(host) ?? false;
  note('debug', 'session', 'sign-in step', {
    session: session.label,
    tabId,
    host,
    detail: dropped
      ? 'no rule: this host was dropped past the budget, so it carries the browser jar and can loop'
      : `rule present, ${held} cookie(s) held for ${registrable}`,
  });
}

async function noteHop(tabId: number, url: string, definite = false): Promise<void> {
  const binding = registry.binding(tabId);
  // Only a managed tab. An unmanaged one looping is the site's own business and
  // nothing here caused it, so saying so would be noise at best and a false
  // accusation at worst.
  if (!binding || settings.paused) return;
  const domain = domainOf(url);
  if (!domain || isReleased(domain)) return;

  const now = Date.now();
  const recent = (hops.get(tabId) ?? []).filter(([, at]) => now - at < LOOP_WINDOW_MS);
  recent.push([domain, now]);
  hops.set(tabId, recent);

  const here = recent.filter(([d]) => d === domain).length;
  if (!definite && here < LOOP_HOPS) return;

  hops.delete(tabId);
  const session = registry.getSession(binding.sessionId);

  /**
   * Released rather than reported.
   *
   * Asking first is the wrong shape here: the loop is already running, every
   * further hop is another partial cookie set arriving at a provider that is
   * counting them, and the question would be asked in a tab that is spinning.
   * Releasing stops it immediately, costs nothing that was working, and is one
   * press to undo from the panel. The alternative on offer was an account
   * invalidated everywhere.
   */
  const freed = await releaseSite(
    domain,
    definite ? 'the browser gave up on a redirect chain' : `${here} hops in ${LOOP_WINDOW_MS / 1000}s`
  );

  note('error', 'session', 'a sign-in loop was stopped', {
    session: session?.label ?? binding.sessionId,
    tabId,
    host: domain,
    detail: definite
      ? 'the browser reported too many redirects in a managed tab, so this site is no longer managed'
      : `${here} navigations to the same site in ${LOOP_WINDOW_MS / 1000} seconds, so this site is no longer managed`,
  });
  void anomaly('signin_loop');

  noteInTab(
    tabId,
    'This sign-in was looping, so NVX let go of',
    '#c4614a',
    domain
  );
  loopReport = { domain, at: now, session: session?.label ?? null, freed };
  paintAlarm();

  try {
    await chrome.tabs.reload(tabId);
  } catch {
    /* the tab went away while this was being decided */
  }
}

/** The last loop stopped, so the panel can offer to undo it. */
let loopReport: { domain: string; at: number; session: string | null; freed: number } | null = null;

async function routeUnboundTab(tabId: number, url: string, windowId?: number): Promise<void> {
  if (!/^https?:/i.test(url)) return;
  // Paused means every tab is an ordinary tab, which has to include the ones
  // opened while paused. Claiming them and then not isolating them would be the
  // worst of both: a tab that says it is in a session and is not.
  if (settings.paused) return;
  if (registry.binding(tabId) || held.has(tabId)) return;

  const domain = domainOf(url);
  if (!domain) return;
  // Released is permanent and profile wide, so it is checked before anything
  // that could claim the tab, including the reopen memory.
  if (isReleased(domain)) return;
  if (decided.get(tabId)?.has(domain)) return;

  const remembered = rememberedFor(url);
  if (remembered) {
    const session = registry.getSession(remembered)!;
    touched(
      registry.bind(tabId, remembered, {
        windowId: windowId ?? chrome.windows.WINDOW_ID_NONE,
        url,
        origin: 'restored',
      }),
      true
    );
    // Said out loud rather than done quietly. A tab rejoining an account is
    // exactly the kind of decision that has to be visible.
    noteBinding(tabId, remembered, 'reopened into the session it was closed in', url);
    setTimeout(() => noteInTab(tabId, 'Reopened in', session.color, session.label), 700);
    return;
  }

  const only = registry.sessionForUrl(url);
  if (only) {
    touched(
      registry.bind(tabId, only, {
        windowId: windowId ?? chrome.windows.WINDOW_ID_NONE,
        url,
        origin: 'pin',
      }),
      true
    );
    noteBinding(tabId, only, 'the only session that covers this domain', url);
    return;
  }

  if (registry.sessionsCovering(domain).length < 2) {
    note('debug', 'tab', 'left unmanaged, no session covers it', { tabId, url });
    return;
  }
  note('info', 'tab', 'held at the picker, more than one session covers it', { tabId, url });
  await holdForChoice(tabId, url);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Put restored tabs back in their sessions, and ask about
 *           |  the ones that cannot be answered.
 *  How      |  Every tab returns with a new id, so matching by url is the
 *           |  only continuity. Exact url first, then origin.
 *  Note     |  Two sessions open on one place is genuinely unknown;
 *           |  guessing signs the user in as the other account, so those
 *           |  are held.
 * ------------------------------------------------------------------
 */
async function restoreAfterRestart(): Promise<void> {
  const orphans = lastOrphans;
  lastOrphans = [];
  if (!orphans.length) return;

  // Seeded into the same memory a closed tab writes to, so restored tabs are
  // put back by the ordinary path as they navigate, with the same note. Tabs
  // arrive over the seconds after launch rather than all at once, so a single
  // sweep would miss most of them.
  const byOrigin = new Map<string, SessionId[]>();
  for (const o of orphans) {
    if (!registry.getSession(o.sessionId) || o.sessionId === ANON) continue;
    const origin = originOf(o.url);
    if (!origin) continue;
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), o.sessionId]);
  }

  let seeded = 0;
  for (const [origin, sessions] of byOrigin) {
    // Two sessions open on one origin is the case this exists for and the one
    // it must not guess at: picking either signs the user in as somebody they
    // did not ask for. Left unseeded, so those tabs are held and asked about.
    if (new Set(sessions).size !== 1) continue;
    if (recentlyClosed.has(origin)) continue;
    // One entry per tab that was open, because the memory is consumed on use
    // and three restored tabs need three answers.
    const at = Date.now();
    recentlyClosed.set(
      origin,
      sessions.map((sessionId) => ({ sessionId, at }))
    );
    seeded += sessions.length;
  }
  if (seeded) {
    ephemeral.schedule();
    note('info', 'tab', 'tabs can be put back after the restart', {
      detail: `${seeded} tab(s)`,
    });
  }

  // The tabs that already exist. Anything slower comes through onBeforeNavigate.
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const url = tab.url ?? tab.pendingUrl ?? '';
    if (typeof tab.id !== 'number' || !/^https?:/i.test(url)) continue;
    await routeUnboundTab(tab.id, url, tab.windowId);
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Record that a tab is meant to be unmanaged here, so the
 *           |  picker leaves it be.
 *  How      |  The same answer as "just this once", reachable to anything
 *           |  that already knows what it wants.
 * ------------------------------------------------------------------
 */
function leaveUnmanaged(tabId: number, url: string): void {
  const domain = domainOf(url);
  if (!domain) return;
  const set = decided.get(tabId) ?? new Set<string>();
  set.add(domain);
  decided.set(tabId, set);
  ephemeral.schedule();
}

/** Replaces the navigation with the picker, so the site is never contacted. */
async function holdForChoice(tabId: number, url: string): Promise<void> {
  held.set(tabId, url);
  const to = `${chrome.runtime.getURL('chooser.html')}?tab=${tabId}&url=${encodeURIComponent(url)}`;
  try {
    await chrome.tabs.update(tabId, { url: to });
  } catch {
    // The tab went away mid-decision. Releasing the hold matters more than the
    // failure: a tab id is reused, and a stale hold would swallow the next
    // navigation that landed on it.
    held.delete(tabId);
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Inject the agent on demand for a tab that has none.
 *  How      |  The agent is registered only for hosts a session cares
 *           |  about, so a re-pick may reach a tab with no agent.
 *           |  Injecting keeps the panel button working everywhere.
 * ------------------------------------------------------------------
 */
async function ensureAgent(tabId: number): Promise<chrome.runtime.Port | null> {
  const existing = agents.get(tabId);
  if (existing) return existing;
  if (!(await injectAgent(tabId, 'src/content/agent.js'))) return null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const port = agents.get(tabId);
    if (port) return port;
  }
  return null;
}

// ------------------------------------------------------------------- mark

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Repaint one tab's mark.
 *  How      |  The composite is cached by icon, colour and label, so ten
 *           |  tabs on one site in one session is a single fetch and
 *           |  canvas pass.
 *  Note     |  A tab with no binding is told to put the site's own icon
 *           |  back.
 * ------------------------------------------------------------------
 */
async function paintTab(tabId: number): Promise<void> {
  const port = agents.get(tabId);
  if (!port) return;

  const binding = registry.binding(tabId);
  const session = binding ? registry.getSession(binding.sessionId) : undefined;

  // Repainting a tab with what it is already wearing costs a message and a DOM
  // pass for nothing, and the events that trigger this fire in bursts.
  const send = (dataUrl: string) => {
    if (paintedAs.get(tabId) === dataUrl) return;
    paintedAs.set(tabId, dataUrl);
    try {
      port.postMessage(dataUrl ? { kind: 'paint', dataUrl } : { kind: 'unpaint' });
    } catch {
      agents.delete(tabId);
      paintedAs.delete(tabId);
    }
  };

  // Paused means this extension is doing nothing, so a session dot on a tab is a
  // claim it is not backing up: the tab is an ordinary tab, isolating nothing.
  // Strip the mark from every tab while paused (the agent ports outlive a pause,
  // so the unpaint reaches them and the real favicon comes back), and let the
  // resume repaint put it back. Same chokepoint as paint-off and no-session, so
  // every repaint trigger honours it without each one having to know.
  if (!settings.paint || settings.paused || !session) {
    send('');
    return;
  }

  try {
    const out = await painter.paint({
      // Scoped to the site the tab is actually on. The candidate list came out
      // of that page's DOM, so on a hostile page it is attacker-chosen, and the
      // composite is handed back as a data URL the page can read.
      sources: rankIcons(lastIcons.get(tabId) ?? [], { site: domainOf(binding?.url ?? '') }),
      color: session.color,
      label: session.label,
    });
    // The binding can change while a fetch is in flight, and applying the mark
    // of a session the tab has since left is worse than not marking it at all.
    if (registry.binding(tabId)?.sessionId !== session.id) return;
    send(out.dataUrl);
  } catch (e) {
    console.warn('[nvx] could not paint tab', tabId, e);
  }
}

const PAINT_PROBE = '__nvx_paint_probe';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Stand up a real session that owns the fixture domain's
 *           |  worker traffic, so the forgery check has a live
 *           |  cookie-setting rule to be defeated by.
 *  Note     |  Without it the check fetches a domain nothing owns and
 *           |  passes for the wrong reason.
 * ------------------------------------------------------------------
 */
const armPaintProbe = async (fixture: string) => {
  const disarm = async () => {
    for (const tabId of registry.tabsFor(PAINT_PROBE)) {
      await chrome.tabs.remove(tabId).catch(() => undefined);
    }
    await dropProbeSession(PAINT_PROBE);
  };

  try {
    const url = new URL(fixture);
    registry.createSession({
      id: PAINT_PROBE,
      label: PAINT_PROBE,
      color: 'grey',
      pinned: [],
      store: new CookieStore(),
      family: [],
      forked: [],
      danger: DEFAULT_DANGER,
    thirdParty: DEFAULT_THIRD_PARTY,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });

    const parsed = parseSetCookie(
      'probe=MUST_NOT_LEAK; Path=/',
      { url: new URL(`${url.origin}/`) },
      { isPublicSuffix }
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    registry.getSession(PAINT_PROBE)!.store.upsert(parsed.cookie);

    // Ownership of a domain's worker traffic follows from having a tab there.
    const win = await chrome.windows.getCurrent();
    const tab = await chrome.tabs.create({
      url: `${url.origin}/page?probe=1`,
      active: false,
      windowId: win.id,
    });
    const m = registry.bind(tab.id!, PAINT_PROBE, {
      windowId: win.id ?? chrome.windows.WINDOW_ID_NONE,
      url: `${url.origin}/page?probe=1`,
      origin: 'manual',
    });
    engine.markDirty([...m.dirty, PAINT_PROBE]);
    await engine.flush();

    const live = await backend.current();
    const armed = live.some(
      (r) =>
        (r.condition.tabIds ?? []).includes(-1) &&
        r.action.requestHeaders?.some((h) => h.operation === 'set')
    );
    return { armed, disarm };
  } catch (e) {
    console.warn('[nvx] could not arm the forgery probe', e);
    return { armed: false, disarm };
  }
};

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Remove a diagnostic probe session from whatever registry
 *           |  is live now.
 *  Note     |  The restore suite reboots the worker, replacing registry
 *           |  and engine; holding the old objects would clean up into a
 *           |  discarded copy.
 * ------------------------------------------------------------------
 */
async function dropProbeSession(id: SessionId): Promise<void> {
  touched(registry.deleteSession(id));
  await engine.retire(id);
  persistence.schedule();
  await persistence.save();
}

function repaintSession(sessionId: SessionId): void {
  for (const tabId of registry.tabsFor(sessionId)) void paintTab(tabId);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Repaint tabs a session-keyed repaint cannot reach.
 *  How      |  Unbinding loses the tab id from the mutation and deleting
 *           |  a session orphans its tabs, so sweeping the agents catches
 *           |  both. The dedup makes a no-op sweep free.
 * ------------------------------------------------------------------
 */
function repaintOrphans(): void {
  for (const tabId of agents.keys()) {
    if (!registry.binding(tabId)) void paintTab(tabId);
  }
}

function repaintAll(): void {
  for (const tabId of agents.keys()) void paintTab(tabId);
}

// ----------------------------------------------------------------- groups

let groupTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Native tab groups, where the browser has them.
 *  How      |  Debounced because binding a session's tabs fires one event
 *           |  per tab and each regroup is several round trips into the
 *           |  tab strip.
 * ------------------------------------------------------------------
 */
function scheduleRegroup(): void {
  if (!settings.group || groupTimer) return;
  groupTimer = setTimeout(() => {
    groupTimer = null;
    void regroupIfEnabled();
  }, 300);
}

async function regroup(): Promise<number> {
  const api = browserGroupApi();
  if (!api) return 0;
  return applyGroups(api, planGroups(registry.listSessions(), registry.listBindings()));
}

/** Scheduled work re-reads the preference, which can change inside the delay. */
async function regroupIfEnabled(): Promise<number> {
  return settings.group ? regroup() : 0;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Undo grouping when the preference is turned off.
 *  Note     |  Only groups carrying a session's name are touched, so a
 *           |  group made by hand survives.
 * ------------------------------------------------------------------
 */
async function ungroupAll(): Promise<void> {
  const api = browserGroupApi();
  if (!api || typeof chrome.tabs.ungroup !== 'function') return;
  const labels = new Set(registry.listSessions().map((s) => s.label));
  const windows = new Set(registry.listBindings().map((b) => b.windowId));
  for (const windowId of windows) {
    if (windowId < 0) continue;
    try {
      const groups = await api.query({ windowId });
      const ours = new Set(groups.filter((g) => labels.has(g.title ?? '')).map((g) => g.id));
      if (!ours.size) continue;
      const tabs = await chrome.tabs.query({ windowId });
      const ids = tabs
        .filter((t) => typeof t.id === 'number' && ours.has(t.groupId ?? -1))
        .map((t) => t.id!);
      if (ids.length) await chrome.tabs.ungroup(ids as [number, ...number[]]);
    } catch {
      /* the window closed mid-flight */
    }
  }
}

// ---------------------------------------------------------------- storage

/**
 * ------------------------------------------------------------------
 *  Purpose  |  What each tab's shim reported it settled on, for the panel
 *           |  and the suite.
 *  Note     |  Cache only: the shim is the authority on its own document.
 * ------------------------------------------------------------------
 */
interface StorageReport {
  sid: string | null;
  mode: string;
  forked: number;
  origin: string;
  at: number;
}
const storageState = new Map<number, StorageReport>();

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Answer the shim's one question: which session is this tab,
 *           |  and should it take a copy of the origin's own storage on
 *           |  the way in.
 *  Note     |  A tab with no binding gets a null session, which puts the
 *           |  shim into passthrough. Answering nothing at all would park
 *           |  it forever.
 * ------------------------------------------------------------------
 */
function answerStorage(tabId: number, port: chrome.runtime.Port, url: string): void {
  const binding = registry.binding(tabId);
  const session = binding ? registry.getSession(binding.sessionId) : undefined;
  const origin = originOf(url || binding?.url || '');

  // The anonymous holding session deliberately carries no identity, and giving
  // it a storage namespace would make it one.
  const sid = session && session.id !== ANON ? session.id : null;
  const fork = Boolean(sid && origin && !session!.forked.includes(origin));

  /**
   * The shim is handed a namespace, never the session id.
   *
   * It used to be the id, and the id is the same string on every origin in the
   * session, so anything that could read it could link the user across every
   * site they visited. The shim writes it into key names and into the tab
   * stamp, both of which a page reaches through a same-origin `about:blank`
   * frame, so "the shim knows it" and "the page knows it" are the same
   * statement. The fix is that the shim never learns it: it is given a token
   * derived from the id and the origin, uses it exactly as it used the id, and
   * has nothing to leak.
   */
  const namespace = sid && origin ? namespaceFor(sid, origin) : sid;

  /**
   * The mask's seed material, which is the same token and is not a coincidence.
   *
   * A persona has to be stable for a session, different between sessions, and
   * unlinkable across origins, which is exactly the list the storage namespace
   * was designed against. Deriving a second token from the same inputs would be
   * two names for one value, and one of them would eventually drift.
   *
   * Sent only under the Persona posture, because its presence in the tab is how
   * the mask learns which posture it is running under: the mask is a static file
   * at `document_start` with no channel to ask over. Sent as `null` otherwise,
   * so switching back to Standardize clears the key rather than leaving the
   * previous posture's persona in the tab.
   */
  const persona = livePosture() === 'persona' ? namespace : null;

  /**
   * Whether the shim should isolate IndexedDB for this tab: the Pro feature is
   * entitled and a real session owns the tab. When off, the shim leaves
   * IndexedDB native and shared, the disclosed free behaviour, and still reports
   * that the site uses it so the Storage view can name the gap. When on, the shim
   * namespaces each database under this session, and the shared-use report is
   * suppressed because there is no longer a gap to disclose.
   */
  const idb = sid !== null && idbIsolationOn();

  try {
    port.postMessage({ kind: 'storage.commit', sid: namespace, fork, persona, idb });
  } catch {
    /* the tab went away between asking and being answered */
  }
}

function noteStorageState(
  tabId: number,
  state: { sid: string | null; mode: string; forked: number; url: string }
): void {
  const origin = originOf(state.url || registry.binding(tabId)?.url || '');

  /**
   * The shim reports the namespace it committed to, which is no longer a session
   * id, so this turns it back into one before anything else sees it.
   *
   * By computing rather than by lookup, and the difference matters: a tab that
   * committed from its stamp is reporting a token this worker never issued,
   * possibly from before it restarted. Deriving the expected token for each
   * session on this origin and comparing answers that case too, and a token
   * matching nothing is reported as exactly that rather than as a session.
   */
  const named = (() => {
    if (!state.sid || !origin) return state.sid;
    for (const s of registry.listSessions()) {
      if (namespaceFor(s.id, origin) === state.sid) return s.id;
    }
    return null;
  })();

  storageState.set(tabId, {
    sid: named,
    mode: state.mode,
    forked: state.forked,
    origin,
    at: Date.now(),
  });

  if (state.mode !== 'live' || !named || !origin) return;
  const session = registry.getSession(named);
  if (!session || session.forked.includes(origin)) return;
  // Recorded whether or not anything was actually copied. The question the flag
  // answers is "has this session arrived here before", and a first arrival that
  // found nothing to copy is still an arrival.
  session.forked.push(origin);
  persistence.schedule();
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Tell a tab's shim to forget the session it stamped into
 *           |  sessionStorage.
 *  How      |  The stamp is read before the worker is asked; after a
 *           |  rebind it names the previous session, so the reload would
 *           |  hand the page the old account's storage for a few ms.
 * ------------------------------------------------------------------
 */
function resetStorageStamp(tabId: number): void {
  const port = agents.get(tabId);
  if (!port) return;
  try {
    port.postMessage({ kind: 'storage.reset' });
  } catch {
    agents.delete(tabId);
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Re-answer a tab that is already running, for a rebind that
 *           |  did not need a reload.
 *  Note     |  Without this the shim keeps writing into the session the
 *           |  tab was in when its document loaded.
 * ------------------------------------------------------------------
 */
function pushStorage(tabId: number): void {
  const port = agents.get(tabId);
  if (!port) return;
  answerStorage(tabId, port, registry.binding(tabId)?.url ?? '');
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'nvx-agent') return;
  const tabId = port.sender?.tab?.id;
  if (typeof tabId !== 'number') return;
  agents.set(tabId, port);
  // Painted only if this tab's icons are already known, which is the reconnect
  // case. Painting a fresh tab here would show a generated tile for the tenth
  // of a second before its real icon is reported, and a flash of the wrong mark
  // is worse than a mark that lands slightly late.
  void whenReady().then(() => {
    if (lastIcons.has(tabId)) void paintTab(tabId);
  });

  port.onMessage.addListener((msg) => {
    void (async () => {
      if (msg?.kind === 'storage.hello') {
        await whenReady();
        answerStorage(tabId, port, typeof msg.url === 'string' ? msg.url : '');
        return;
      }
      if (msg?.kind === 'guard.unlock') {
        await whenReady();
        const binding = registry.binding(tabId);
        if (!binding || typeof msg.rule !== 'string') return;
        // The rule id is checked against the catalog rather than trusted: this
        // arrives from a content script, and an unlock for an arbitrary string
        // would be harmless but an unlock nobody can see is not.
        if (!CATALOG.some((e) => e.id === msg.rule)) return;
        guard.unlock(binding.sessionId, msg.rule, UNLOCK_MS);
        await guard.flush();
        return;
      }
      if (msg?.kind === 'storage.state') {
        await whenReady();
        noteStorageState(tabId, {
          sid: typeof msg.sid === 'string' ? msg.sid : null,
          mode: typeof msg.mode === 'string' ? msg.mode : '',
          forked: typeof msg.forked === 'number' ? msg.forked : 0,
          url: typeof msg.url === 'string' ? msg.url : '',
        });
        return;
      }
      /**
       * An origin that keeps something in IndexedDB, which this extension does
       * not separate between sessions.
       *
       * Recorded per registrable domain rather than per session, because the
       * fact is about the origin: IndexedDB is shared, so if one session's tab
       * put a token there, every session on that site can read it. Naming the
       * site is the difference between a disclaimer nobody can apply and a
       * disclosure somebody can act on.
       */
      if (msg?.kind === 'storage.idb') {
        await whenReady();
        const domain = domainOf(typeof msg.url === 'string' ? msg.url : '');
        if (domain && !idbSites.has(domain)) {
          idbSites.add(domain);
          ephemeral.schedule();
          note('info', 'storage', 'a site keeps data in IndexedDB, which is shared', {
            host: domain,
            detail: 'sessions on this site can read each other there',
          });
        }
        return;
      }
      /**
       * A cookie the page set with document.cookie.
       *
       * document.cookie writes to the browser's own jar, not the session store,
       * and the header rewrite then overrides the Cookie header from the store,
       * so a cookie set this way never reaches the wire. A site that sets a probe
       * cookie and reads it back on its next request, which is exactly how Google
       * and Slack decide whether cookies work, sees it vanish and declares
       * cookies disabled, then loops. Routing the write into the store is what
       * makes the next request carry it. The value already went to the native jar
       * too, so the page's own reads are unchanged; this only teaches the store.
       */
      if (msg?.kind === 'page.cookie') {
        await whenReady();
        const value = typeof msg.value === 'string' ? msg.value : '';
        const url = typeof msg.url === 'string' ? msg.url : '';
        if (!value || !url) return;
        const binding = registry.binding(tabId);
        if (!binding) return;
        const session = registry.getSession(binding.sessionId);
        if (!session || session.id === ANON) return;
        // Parsed through the same path a Set-Cookie response header takes, so
        // one code path decides what is a valid cookie and a page cannot push a
        // shape a server never could.
        const result = captureSetCookie({
          url,
          responseHeaders: [{ name: 'set-cookie', value }],
        });
        if (!result.cookies.length) return;
        for (const cookie of result.cookies) session.store.upsert(cookie);
        scheduleCookieFlush(session.id);
        return;
      }
      if (msg?.kind === 'icons') {
        await whenReady();
        // Shape-checked at the boundary. This arrives from a content script in
        // a page, so it is the least trusted input the worker takes.
        const raw: unknown[] = Array.isArray(msg.candidates) ? msg.candidates : [];
        lastIcons.set(
          tabId,
          raw
            .slice(0, MAX_ICON_CANDIDATES * 4)
            .filter((c): c is IconCandidate => Boolean(c) && typeof c === 'object')
            .map((c) => ({
              href: typeof c.href === 'string' ? c.href.slice(0, 2048) : '',
              ...(typeof c.type === 'string' ? { type: c.type.slice(0, 64) } : {}),
              ...(typeof c.sizes === 'string' ? { sizes: c.sizes.slice(0, 64) } : {}),
            }))
        );
        await paintTab(tabId);
        return;
      }
      if (msg?.kind !== 'chose') return;
      await whenReady();
      const here = port.sender?.tab?.url ?? registry.binding(tabId)?.url ?? '';
      const held = pending.get(tabId);
      pending.delete(tabId);
      // Answering mid-chain answers for where the chain started, so the tab
      // goes back there rather than reloading a spent SAMLRequest. Both domains
      // count as decided: the one that was asked about, and the one the user
      // happened to be looking at when they answered.
      const url = held?.url ?? here;
      const set = decided.get(tabId) ?? new Set<string>();
      for (const u of [url, here]) {
        const registrable = domainOf(u);
        if (registrable) set.add(registrable);
      }
      decided.set(tabId, set);
      ephemeral.schedule();

      if (msg.sessionId) {
        touched(
          registry.bind(tabId, msg.sessionId, {
            windowId: chrome.windows.WINDOW_ID_NONE,
            url,
            origin: 'manual',
          })
        );
      } else {
        // Declined. Hand the tab back to ordinary browser behaviour.
        touched(registry.unbind(tabId));
      }
      // The document about to be replaced stamped whichever session it settled
      // on, and the reload below reads that stamp before the worker answers.
      resetStorageStamp(tabId);
      storageState.delete(tabId);
      await engine.flush();
      try {
        // Same URL is a reload; a different one restarts the sign-in from where
        // it began, which is the only way the chosen session gets to be the one
        // the identity provider hands its assertion to.
        if (url && url !== here) await chrome.tabs.update(tabId, { url });
        else await chrome.tabs.reload(tabId);
      } catch {
        /* tab closed while deciding */
      }
    })();
  });

  port.onDisconnect.addListener(() => {
    if (agents.get(tabId) !== port) return;
    agents.delete(tabId);
    // A navigation tears down the content script and builds a new one, which
    // starts with no mark applied. Forgetting what the old document was wearing
    // is what makes the next one get painted at all.
    paintedAs.delete(tabId);
  });
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Every entry point funnels through this.
 *  Note     |  A cold worker must not process an event against an empty
 *           |  registry, which would look like an unmanaged tab and let
 *           |  the profile jar through.
 * ------------------------------------------------------------------
 */
function whenReady(): Promise<void> {
  if (!ready) ready = boot();
  return ready;
}

const AGENT_SCRIPT_ID = 'nvx-agent';
const SHIM_SCRIPT_ID = 'nvx-storage';
const MASK_SCRIPT_ID = 'nvx-mask';
const POLICY_SCRIPT_ID = 'nvx-policy';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The machine this is actually running on.
 *  How      |  Only the two fields the bucket refuses to fabricate. A
 *           |  Melbourne address reporting a London clock is the
 *           |  incoherence the posture design avoids, so Standardize
 *           |  takes timezone and locale from here.
 * ------------------------------------------------------------------
 */
function realMachine(): RealMachine {
  let timezone = 'UTC';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    /* a worker without a zone database is not a reason to fail */
  }

  // The same test the mask makes, and it has to be, because the mask picks its
  // GPU bucket from its own copy of this and the two answering differently
  // would put a Windows renderer string on a machine the panel calls a Mac.
  const ua = navigator.userAgent;
  const os: Os = /Mac OS X/.test(ua) ? 'macos' : /Windows NT/.test(ua) ? 'windows' : 'linux';

  /**
   * The user agent and the brand list come from here too, and the reason is the
   * same one that keeps the clock real: the normalised form is the real one with
   * the browser's own name taken out, so the Chromium version stays true and the
   * greased brand entry stays the one this browser generated. A written down
   * user agent is correct for one release and a contradiction afterwards.
   *
   * The page derives the same values from its own `navigator`, which is the same
   * browser, so the two agree by construction rather than by being kept in sync.
   */
  const brands = (navigator as unknown as { userAgentData?: { brands?: Brand[] } }).userAgentData
    ?.brands;

  return {
    os,
    timezone,
    locale: chrome.i18n?.getUILanguage?.() || 'en-US',
    userAgent: ua,
    ...(brands?.length ? { brands: brands.map((b) => ({ ...b })) } : {}),
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Domains where the mask could not reach a worker, so the
 *           |  posture comes off there entirely.
 *  How      |  The mask takes itself off inside the document, but its
 *           |  request headers belong to worker rules a MAIN script
 *           |  cannot reach. So both layers come off together, excluded
 *           |  from the header rules and the mask match set.
 *  Note     |  Domains not origins, and held in memory: a policy is a
 *           |  property of the site today, and the signal arrives again
 *           |  on the next load.
 * ------------------------------------------------------------------
 */
const degraded = new Set<string>();

async function degrade(host: string): Promise<void> {
  if (degraded.has(host)) return;
  degraded.add(host);
  note('warn', 'mask', 'the posture came off an origin that refuses our worker', {
    host,
  });
  // The signature carries the degraded set, so this is what makes the
  // registration actually rebuild rather than deciding nothing changed.
  await registerAgent();
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The request headers that have to agree with the patched
 *           |  navigator.
 *  How      |  Installed before the mask is registered, and the mask is
 *           |  not registered if this fails. A navigator saying Chrome
 *           |  while requests say Opera is the exact incoherence, so
 *           |  losing the canvas noise is the cheaper failure.
 * ------------------------------------------------------------------
 */
async function applyPostureRules(hosts: string[]): Promise<void> {
  const agent =
    livePosture() === 'mirror'
      ? null
      : (() => {
          const persona = standardFor(realMachine());
          return { userAgent: persona.userAgent, brands: persona.brands ?? [] };
        })();

  const { rules, dropped } = compilePosture({
    hosts,
    agent,
    excluded: [...degraded],
    unmasked: [...unmaskedTabs],
  });
  /**
   * Recorded, because the hosts past the line keep the mask and lose the
   * headers, and that is the exact incoherence the posture exists to prevent:
   * the page reports one browser and its requests report another. It takes a
   * profile with more than two hundred and fifty managed hosts to reach, which
   * is to say it only ever happens to somebody who has been using this for a
   * long time on a large profile, and never to anybody testing it.
   */
  if (dropped.length) {
    note('warn', 'mask', 'more managed hosts than the posture covers', {
      detail: `${dropped.length} past the ${MAX_POSTURE_HOSTS} host limit keep the mask without the matching headers: ${dropped.slice(0, 6).join(', ')}`,
    });
  }
  await backend.apply(rules, postureIds());
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The fingerprint mask, registered only when a posture asks
 *           |  for it.
 *  How      |  Under Mirror it is not registered at all, since a MAIN
 *           |  world script on every page is real cost and detection
 *           |  surface. matchOriginAsFallback covers about:blank and
 *           |  srcdoc frames, a High severity vector per section 11.
 *  Note     |  The shim does not set it: storage in an about:blank frame
 *           |  is the parent's, and a second set of proxies over one
 *           |  store is wrong.
 * ------------------------------------------------------------------
 */
function maskRegistration(
  matches: string[]
): chrome.scripting.RegisteredContentScript[] {
  if (livePosture() === 'mirror') return [];
  /**
   * A domain that refused the mask's worker is excluded here as well as from
   * the header rules, and the pair is the point. Taking the headers off alone
   * would leave the page patched and its requests real, which is the same
   * contradiction the withdrawal exists to end, pointing the other way.
   */
  const excludeMatches = [...degraded].map((h) => `*://*.${h}/*`).sort();
  return [
    {
      id: MASK_SCRIPT_ID,
      js: ['src/mask/index.js'],
      matches,
      ...(excludeMatches.length ? { excludeMatches } : {}),
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: false,
    } as chrome.scripting.RegisteredContentScript,
    /**
     * The mask's ears, in the isolated world and in every frame it runs in.
     *
     * Registered with the mask rather than with the agent because it has to
     * cover exactly what the mask covers: the agent is top frame only, since it
     * binds tabs and draws the chooser, so a policy refusing the mask's worker
     * inside an iframe was never heard and that frame kept its headers
     * rewritten over a page the mask had already left.
     *
     * Not excluded on a degraded domain, and that is deliberate: it is the only
     * thing that would notice a site that stopped refusing, and it costs one
     * listener.
     */
    {
      id: POLICY_SCRIPT_ID,
      js: ['src/content/policy.js'],
      matches,
      runAt: 'document_start',
      world: 'ISOLATED',
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: false,
    } as chrome.scripting.RegisteredContentScript,
  ];
}
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Every host this extension is managing, what both the
 *           |  scripts and the posture headers must cover.
 *  How      |  Read from the sessions, not the tabs: a session's hosts
 *           |  outlive any particular tab, and a rule that appears only
 *           |  while a tab is open is missing exactly when the tab is
 *           |  opened.
 * ------------------------------------------------------------------
 */
function postureHosts(): string[] {
  if (settings.paused) return [];
  const hosts = new Set<string>();
  for (const s of registry.listSessions()) {
    for (const h of s.store.hosts()) hosts.add(domainOf(`https://${h}/`) || h);
    for (const p of s.pinned) hosts.add(domainOf(`https://${p}/`) || p);
  }
  for (const b of registry.listBindings()) {
    const d = domainOf(b.url);
    if (d) hosts.add(d);
  }
  return [...hosts].filter((h) => h && !h.includes('/')).sort();
}

/** Sentinel, so the first call registers even when the match set is empty. */
let registeredMatches: string | null = null;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The agent is registered only for hosts a session actually
 *           |  cares about.
 *  How      |  Registering for every site keeps a port open on every
 *           |  page, which keeps the worker alive permanently. Scoping
 *           |  keeps it warm exactly while you are somewhere it matters,
 *           |  which is when the child-tab race happens.
 * ------------------------------------------------------------------
 */
function registerAgent(): Promise<void> {
  // Serialised. Registration is an unregister followed by a register, so two
  // overlapping calls can interleave into a state where the later one's
  // unregister removes the earlier one's registration and nothing is left.
  registering = registering.then(reallyRegisterAgent, reallyRegisterAgent);
  return registering;
}

let registering: Promise<void> = Promise.resolve();

async function reallyRegisterAgent(): Promise<void> {
  // MV2 declares the agent in the manifest and cannot scope it, so there is
  // nothing to register and nothing to keep in sync.
  if (!canScopeAgent()) return;

  // One list, two consumers. The scripts and the header rules must cover the
  // same hosts or a page is masked in one half and real in the other, so they
  // come from one function rather than from two that agree today.
  const hostList = postureHosts();
  const matches = hostList.map((h) => `*://*.${h}/*`);

  // Registering is not free: it tears every existing injection down and puts it
  // back. Bindings change constantly and their domains rarely do, so the work
  // is skipped whenever the resulting match set is the one already installed.
  //
  // The posture is part of the signature, not just the match set. Turning the
  // mask on changes which scripts are registered without changing which hosts
  // they cover, and a signature that only tracked hosts would decide there was
  // nothing to do.
  // The degraded set is part of the signature for the same reason the posture
  // is: a domain leaving the mask's reach changes what is registered without
  // changing which hosts are managed, and a signature that only tracked hosts
  // would decide there was nothing to do.
  const signature = `${livePosture()}\n${[...degraded].sort().join(',')}\n${matches.join('\n')}`;
  if (signature === registeredMatches) return;
  registeredMatches = signature;

  /**
   * The headers go on first, and their failure takes the mask with them.
   *
   * The order is the guarantee. Rules installed after the script would leave a
   * window where the page reports one browser and its requests report another,
   * and a rule set that never installs at all would leave that window open
   * permanently.
   */
  try {
    await applyPostureRules(hostList);
  } catch (e) {
    registeredMatches = null;
    note('error', 'mask', 'could not install the posture headers, so the mask stays off', {
      detail: String(e),
    });
    telemetry.error('compile_failed');
    await chrome.scripting
      .unregisterContentScripts({ ids: [MASK_SCRIPT_ID, POLICY_SCRIPT_ID] })
      .catch(() => undefined);
    return;
  }

  try {
    const ids = [AGENT_SCRIPT_ID, SHIM_SCRIPT_ID, MASK_SCRIPT_ID, POLICY_SCRIPT_ID];
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({
        ids: existing.map((s) => s.id),
      });
    }
    if (!matches.length) return;
    await chrome.scripting.registerContentScripts([
      {
        id: AGENT_SCRIPT_ID,
        js: ['src/content/agent.js'],
        matches,
        runAt: 'document_start',
        world: 'ISOLATED',
        allFrames: false,
        persistAcrossSessions: false,
      },
      /**
       * The mask before the shim, and the order is load bearing.
       *
       * Registered scripts run in the order they are registered, and the mask's
       * first statement captures the origin's real `sessionStorage` object. The
       * shim replaces that property with a proxy which hides the extension's own
       * keys from the page, and the mask's persona material is one of those
       * keys, so a mask that ran second would be told there is nothing there and
       * every session would quietly fall back to the shared bucket.
       *
       * Measured rather than assumed, twice. `sessionStorage` is an own property
       * of `window` on Chromium rather than an accessor on `Window.prototype`,
       * so there is no second route back to the real object once it has been
       * shadowed. And the fingerprint suite fails on exactly this if the order
       * ever changes, rather than the product going quiet.
       */
      ...maskRegistration(matches),
      {
        // MAIN, because it has to replace the page's own localStorage before
        // the page's own scripts read it, and an ISOLATED world has its own
        // storage the page never sees.
        //
        // allFrames, unlike the agent: a same-origin iframe shares the tab's
        // storage, so leaving it native would let a framed sign-in write
        // straight into the origin's shared keys. A frame has no agent, so it
        // takes its session from the sessionStorage stamp and falls back to
        // passthrough on the first load of a tab, which is the honest limit.
        id: SHIM_SCRIPT_ID,
        js: ['src/content/shim.js'],
        matches,
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
        persistAcrossSessions: false,
      },
    ]);
  } catch (e) {
    // The signature is cleared so the next attempt retries rather than
    // believing a registration that never landed.
    registeredMatches = null;
    note('error', 'life', 'could not register the page agent', { detail: String(e) });
  }
}

async function boot(): Promise<void> {
  const loaded = await Persistence.load(storage);
  if (loaded) {
    if (loaded.source === 'backup') {
      note('warn', 'life', 'primary state was unusable, recovered from backup');
    }
    registry = loaded.registry;
    settings = loaded.settings;
    persistence = new Persistence(storage, registry, {
      settings: () => settings,
      audit: () => guard.audit.all(),
    });
    guard.audit.load(loaded.audit);
    // The blocking backend holds no per-session state, so it survives a reload
    // untouched; only the declarative one has rules to rebuild.
    if (engine instanceof Engine) engine = declarativeEngine();
  }

  // Session rules outlive the service worker, but the slot map that produced
  // their ids does not. A restarted worker hands slots out afresh, so a session
  // can be handed a slot whose previous occupant's rules are still live and
  // still rewriting headers. Clearing everything first is the only way to be
  // sure what is installed matches what the kernel believes.
  try {
    const stale = await backend.current();
    if (stale.length) {
      await backend.apply([], stale.map((r) => r.id));
      note('info', 'rules', 'cleared rules a previous worker left', {
        detail: `${stale.length} rule(s)`,
      });
    }
  } catch (e) {
    note('error', 'rules', 'could not clear stale rules', { detail: String(e) });
    telemetry.error('apply_failed');
  }

  // Its jar is meant to be permanently empty and an older build let it fill up,
  // so the invariant is restored here rather than the next time a chooser
  // happens to be raised.
  if (registry.getSession(ANON)) ensureAnonymous();

  // What the previous worker knew and the heap did not carry. Before the
  // reconcile below, because `restoreAfterRestart` seeds the same map and
  // deliberately refuses to overwrite an origin that already has an answer.
  //
  // Merged key by key with what is live rather than assigned over it. Boot runs
  // again inside one worker, both when the restore suite exercises the cold
  // path in place and after a browser start, and at that point the maps hold
  // decisions newer than anything storage has. Live wins; storage fills gaps.
  {
    const restored = await ephemeral.load();
    let filled = 0;
    for (const [origin, queue] of restored.reopen) {
      if (recentlyClosed.has(origin)) continue;
      recentlyClosed.set(origin, queue);
      filled += queue.length;
    }
    for (const [tabId, domains] of restored.decided) {
      if (decided.has(tabId)) continue;
      decided.set(tabId, domains);
    }
    /**
     * Restored before any rule is compiled, because the wrong answer here is
     * not a missing convenience but a live incoherence: a tab whose document
     * predates the mask, whose headers this worker is about to start rewriting
     * because it no longer remembers that it should not.
     */
    for (const tabId of restored.unmasked) unmaskedTabs.add(tabId);
    if (filled) {
      note('debug', 'life', 'closed tabs can still be reopened', { detail: `${filled} tab(s)` });
    }
    if (unmaskedTabs.size) {
      note('debug', 'mask', 'tabs still older than the posture', {
        detail: `${unmaskedTabs.size} left real until they load again`,
      });
    }
  }


  const tabs = await chrome.tabs.query({});
  const { kept, dropped, dirty, orphans } = reconcile(registry, tabs);
  if (dropped.length) {
    note('info', 'life', 'dropped stale bindings on wake', {
      detail: `${dropped.length} binding(s)`,
    });
  }
  // Stashed rather than acted on unconditionally. A worker wakes many times
  // inside one browser session, and re-adopting tabs on every wake would take
  // over tabs the user deliberately left unmanaged.
  lastOrphans = orphans;

  // Burners do not outlive their tabs, so an ephemeral session that is not the
  // holding pen and has no live tab left is one whose tab is gone, and it is
  // dropped here rather than lingering empty across a restart. The boot recompile
  // below clears its rules with everyone else's.
  for (const s of registry.listSessions()) {
    if (s.ephemeral && s.id !== ANON && registry.tabsFor(s.id).length === 0) {
      registry.deleteSession(s.id);
    }
  }

  const fresh = await newBrowserSession(kept.length);
  // Before the compile below, so no rule is ever built carrying a cookie the
  // browser itself would have thrown away when it closed.
  if (fresh) dropSessionCookies();

  if (dirty.length || fresh) {
    engine.markDirty(dirty);
    await engine.flush();
  }
  // After the flush, so a tab put back into a session compiles from settled
  // state rather than racing the recompile above.
  if (fresh) await restoreAfterRestart();
  // The baseline the first entitlement change measures against. Set before the
  // registration below so a licence that later unlocks Persona transitions from
  // what boot actually registered, not from a stale default that would mark
  // already-masked tabs as needing it.
  lastLivePosture = livePosture();
  await registerAgent();
  rebuildMenus();
  // Loads or mints the anonymous id, but only if telemetry is actually on; a
  // profile that never consents never gets one written. Record the restored
  // session and tab counts into the engagement peak first, so a passive user
  // whose tabs came back is measured even if nothing changes afterwards, then
  // the once-a-day active beat, which its own day stamp keeps to once per day
  // across the many times a worker wakes.
  recordUsage();
  void telemetry.ready().then(() => maybeActive());
  // The Pro licence, if any: load the stored token into the gate, cache the
  // coarse OS name for the device label, and refresh against the server at most
  // once a day. All no-ops on a free build. Deliberately not awaited into the
  // boot critical path, because entitlement fails open and no free behaviour
  // waits on it.
  void chrome.runtime
    .getPlatformInfo()
    .then((i) => {
      cachedOsLabel = OS_LABEL[i?.os ?? ''] ?? 'Device';
    })
    .catch(() => undefined);
  void license.init().then(() => {
    void maybeRefreshLicense();
    // After the licence, because sync authenticates as it. A background sync runs
    // at most once a day and is a no-op without the feature and a passphrase.
    void sync.init().then(() => maybeSync());
  });
  // The stale-rule clear above took the guard's rules with it, since they are
  // session rules like any other. Recompiling every session is the only way
  // what is installed matches what the kernel believes.
  guard.markAllDirty();
  await guard.flush();
  syncExact();
  persistence.schedule();
}

function touched(mutation: { dirty: SessionId[]; needsReload: number[] }, immediate = false): void {
  if (mutation.dirty.length) {
    // Every change to who owns which tab passes through here, so it is the one
    // place the daily beat's engagement peak can watch without scattering calls.
    recordUsage();
    engine.markDirty(mutation.dirty);
    // Guard rules are scoped to a session's tabs, so anything that changes who
    // owns which tab makes them stale in exactly the same way cookie rules are.
    guard.markDirty(mutation.dirty);
    void guard.flush();
    if (immediate) void engine.flush();
    persistence.schedule();
    // Identity channels are downstream of the same events that dirty rules, so
    // they hang off the one place every mutation already passes through.
    void registerAgent();
    syncExact();
    for (const id of mutation.dirty) repaintSession(id);
    repaintOrphans();
    scheduleRegroup();
  }
  for (const tabId of mutation.needsReload) {
    // The tab has already spoken under a different identity. Rules cannot
    // retract that, so the page starts again with the correct one.
    //
    // The stamp goes first. It names the session this tab was in, the reload
    // reads it before the worker can be asked, and a stale one would hand the
    // new session's page the old account's storage for the first few
    // milliseconds. Clearing it costs one message and closes that entirely.
    resetStorageStamp(tabId);
    storageState.delete(tabId);
    void engine.flush().then(() => chrome.tabs.reload(tabId).catch(() => undefined));
  }
}

// ------------------------------------------------------------------- tabs

chrome.tabs.onCreated.addListener((tab) => {
  void (async () => {
    await whenReady();
    if (typeof tab.id !== 'number') return;
    const start = (tab.pendingUrl ?? tab.url ?? '').trim();
    const startsAtAsite = /^https?:/i.test(start);

    /**
     * Opener inheritance for a tab that is a child of another, whether it starts
     * at its destination or at about:blank.
     *
     * A tab opened from a link belongs to whatever session opened it: a link
     * clicked inside Work is Work's business wherever it points. Some of those
     * carry the destination from the moment they exist, but most web apps,
     * Slack among them, open a link with window.open, which starts the tab at
     * about:blank and navigates it a moment later. Gating inheritance on an http
     * url at creation meant every one of those children lost its session and
     * opened unmanaged, which is the reported bug: a Slack link in Work opened
     * in no session at all.
     *
     * A tab opened with the keyboard is not a child of anything and must not
     * inherit. Opera sets openerTabId on it anyway, to whichever tab was in
     * front, and a new tab typed into once inherited the session behind it and
     * signed the user into the wrong account without asking. The signature that
     * separates the two is the start url: a keyboard tab lands on the browser's
     * new-tab page (chrome://newtab, an Opera startpage), never about:blank, so
     * about:blank-with-an-opener is window.open and a new-tab page is not.
     */
    const isOpenerChild = startsAtAsite || start === 'about:blank';
    const sessionId = registry.resolveForNewTab({
      ...(isOpenerChild && typeof tab.openerTabId === 'number'
        ? { openerTabId: tab.openerTabId }
        : {}),
      ...(startsAtAsite ? { url: tab.pendingUrl ?? tab.url ?? '' } : {}),
    });
    // Opener inheritance is right for a real session and wrong for the holding
    // pen: a child of a tab that has not decided yet has not decided either, and
    // binding it here would hide it from the hold and let it load unanswered.
    if (!sessionId || sessionId === ANON) return;

    const opened = typeof tab.openerTabId === 'number';
    touched(
      registry.bind(tab.id, sessionId, {
        windowId: tab.windowId ?? chrome.windows.WINDOW_ID_NONE,
        url: tab.pendingUrl ?? tab.url ?? '',
        origin: opened ? 'opener' : 'pin',
      }),
      true
    );
    noteBinding(
      tab.id,
      sessionId,
      opened ? 'opened from a tab already in this session' : 'the only session that covers it',
      tab.pendingUrl ?? tab.url ?? ''
    );
  })();
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url) return;
  void (async () => {
    await whenReady();
    // Icons belong to a document, not to a tab. Carrying the previous site's
    // candidates across a cross-host navigation would composite the wrong glyph
    // for as long as it takes the new page to report its own.
    if (hostOf(change.url!) !== hostOf(registry.binding(tabId)?.url ?? '')) {
      lastIcons.delete(tabId);
    }

    const existing = registry.binding(tabId);
    if (existing) {
      touched(registry.navigated(tabId, change.url!), true);
      persistence.schedule();
      // ANON is a placeholder, not an answer. The tab was parked there to keep
      // every jar off the wire while the choice was pending, and on an ordinary
      // site the user answers and moves on.
      //
      // A federated site does not wait. It redirects to its identity provider
      // inside a second, and the redirect destroys the chooser along with the
      // rest of the document before anyone can click it. Measured on Monash:
      // the tab reached Okta still parked in ANON, and since a bound tab was
      // never asked again it stayed there for the whole sign-in, which puts a
      // second account in the same session as the first all over again.
      //
      // So the question is asked again each time the chain lands somewhere new.
      // A question already in flight is re-rendered as it was, because the
      // identity provider is not what the user is choosing an account for and
      // the sessions that cover it are usually none.
      if (existing.sessionId === ANON) await reoffer(tabId, change.url!);
      return;
    }
    // The backstop. onBeforeNavigate is earlier and does this first for an
    // ordinary navigation, but not every way a tab acquires a url goes through
    // it, and an unbound tab on a covered domain must never be left running.
    await routeUnboundTab(tabId, change.url!, tab.windowId);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await whenReady();
    // Read before the binding is dropped, so reopening the tab can rejoin it.
    rememberClosedTab(tabId);
    decided.delete(tabId);
    ephemeral.schedule();
    pending.delete(tabId);
    held.delete(tabId);
    agents.delete(tabId);
    hops.delete(tabId);
    if (unmaskedTabs.delete(tabId)) ephemeral.schedule();
    lastIcons.delete(tabId);
    paintedAs.delete(tabId);
    storageState.delete(tabId);
    // A remembered undo whose tab is gone has nothing to act on.
    if (lastMove?.tabId === tabId) lastMove = null;
    // The session this tab belonged to, read before the unbind, so a burner can
    // be reaped the instant its last tab closes.
    const wasIn = registry.binding(tabId)?.sessionId ?? null;
    touched(registry.unbind(tabId));
    if (wasIn) await reapBurner(wasIn);
  })();
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A burner is a session that exists only for its tab.
 *  How      |  When its last tab closes there is nothing left to protect,
 *           |  so it and its jar are dropped, the whole promise of a
 *           |  burner tab.
 *  Note     |  A non-burner session outliving its tabs is the normal case
 *           |  and is left alone.
 * ------------------------------------------------------------------
 */
async function reapBurner(sessionId: SessionId): Promise<void> {
  const session = registry.getSession(sessionId);
  if (!session || !session.ephemeral || session.id === ANON) return;
  if (registry.tabsFor(sessionId).length > 0) return;
  note('info', 'session', 'burner cleared', { session: session.label });
  touched(registry.deleteSession(sessionId));
  await engine.retire(sessionId);
  await guard.retire(sessionId);
  void registerAgent();
  rebuildMenus();
  persistence.schedule();
}

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void (async () => {
    await whenReady();
    // The prerendered document is the one that survives, so its agent, its
    // icons and its mark move with the id rather than being rebuilt.
    const icons = lastIcons.get(removedTabId);
    if (icons) lastIcons.set(addedTabId, icons);
    lastIcons.delete(removedTabId);
    paintedAs.delete(removedTabId);
    touched(registry.replaceTab(removedTabId, addedTabId), true);
  })();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void (async () => {
    await whenReady();
    registry.activated(tabId);
  })();
});

chrome.tabs.onAttached.addListener((tabId, info) => {
  void (async () => {
    await whenReady();
    registry.movedWindow(tabId, info.newWindowId);
  })();
});

// ------------------------------------------------------------- navigation

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Take a tab out of the leave-it-real set and put the
 *           |  headers back on.
 *  Note     |  Costs one rule write per stale tab, once, then never again
 *           |  for that tab.
 * ------------------------------------------------------------------
 */
async function remask(tabId: number): Promise<void> {
  if (!unmaskedTabs.delete(tabId)) return;
  ephemeral.schedule();
  if (livePosture() === 'mirror') return;
  try {
    await applyPostureRules(postureHosts());
  } catch (e) {
    note('warn', 'mask', 'could not put the headers back on a reloaded tab', {
      tabId,
      detail: String(e),
    });
  }
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  void (async () => {
    await whenReady();
    await remask(details.tabId);
    const binding = registry.binding(details.tabId);
    if (!binding) {
      // The earliest point a url is known and the latest one at which nothing
      // has been requested yet, which is the only place a hold is worth
      // anything: one round trip later the site has already set a cookie.
      await routeUnboundTab(details.tabId, details.url);
      return;
    }
    // A stale rule during a top level navigation is the one case that logs you
    // out, so this waits rather than coalescing.
    await engine.flush();
    // The document this produces will have the mask, so the tab stops being an
    // exception. Done here rather than on commit because this is the last point
    // before anything is requested.
    await remask(details.tabId);
    // After the flush, so the step is logged against the rules that will
    // actually carry this navigation, not the ones from before it settled.
    noteSignInStep(details.tabId, binding.sessionId, details.url);
    await noteHop(details.tabId, details.url);
  })();
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The browser giving up, the one signal that needs no
 *           |  interpretation.
 *  How      |  ERR_TOO_MANY_REDIRECTS in a managed tab means a chain ran
 *           |  past Chromium's own limit, which no working sign-in does.
 *           |  Believed on sight: by now the loop has run twenty times.
 * ------------------------------------------------------------------
 */
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!/TOO_MANY_REDIRECTS/i.test(details.error ?? '')) return;
  void (async () => {
    await whenReady();
    await noteHop(details.tabId, details.url, true);
  })();
});

// ----------------------------------------------------------------- guard

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Blast radius, watched on every request.
 *  How      |  onBeforeRequest sees a request before it leaves and
 *           |  records the decision even when a rule is about to refuse
 *           |  it. Observation only: the refusal is a rule on MV3 and a
 *           |  veto in the blocking listener on MV2.
 * ------------------------------------------------------------------
 */
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Cheap enough to run inline for the overwhelming majority of traffic: one
    // method comparison rules out every GET before any regex is touched.
    if (!GUARDED_METHODS.has(details.method?.toUpperCase() ?? '')) return undefined;
    void (async () => {
      await whenReady();
      const binding = registry.binding(details.tabId);
      const session = binding ? registry.getSession(binding.sessionId) : undefined;
      // Only tabs this extension is managing. An unmanaged tab is the browser
      // behaving as it always did, and writing every DELETE the user makes
      // anywhere in the browser to disk would be a log of their activity that
      // nobody asked for and that protects nothing.
      if (!session || session.id === ANON) return;
      const noted = guard.note(
        { url: details.url, method: details.method },
        { id: session.id, label: session.label, danger: session.danger }
      );
      if (!noted) return;
      persistence.schedule();
      if (noted.decision.action === 'logged') return;
      // The audit trail already holds this in full. What the journal adds is
      // that it sits in one timeline beside whatever the tab was doing at the
      // time, which is how somebody works out why the request was made at all.
      note(noted.decision.action === 'blocked' ? 'warn' : 'info', 'guard', noted.decision.action, {
        session: session.label,
        tabId: details.tabId,
        url: details.url,
        detail: `${details.method} ${noted.entry.what}`,
      });
      warnInTab(details.tabId, noted.entry);
    })();
    return undefined;
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

/** Every method any catalog entry could match. A GET never reaches the guard. */
const GUARDED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Tell the tab what just happened.
 *  How      |  A warning is a transient card; a refusal is a persistent
 *           |  one carrying the only two choices, to accept it or to
 *           |  allow that one endpoint for a few minutes.
 * ------------------------------------------------------------------
 */
function warnInTab(tabId: number, entry: AuditEntry): void {
  const port = agents.get(tabId);
  if (!port) return;
  try {
    port.postMessage({
      kind: 'guard',
      action: entry.action,
      what: entry.what,
      rule: entry.rule,
      session: entry.sessionLabel,
      url: entry.url,
      method: entry.method,
    });
  } catch {
    agents.delete(tabId);
  }
}

// --------------------------------------------------------------- requests

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    void (async () => {
      await whenReady();
      const binding = registry.binding(details.tabId);
      const session = binding
        ? registry.getSession(binding.sessionId)
        : ownerSessionFor(details.url);
      if (!session) return;

      // The anonymous session is a holding pen, not an account, and its jar is
      // documented as permanently empty. Letting it keep what a parked tab was
      // handed makes every parked tab share one identity, which is the exact
      // collision the chooser is there to prevent: measured with five cookies
      // sitting in it after two sign-ins, one of them a live MoodleSession.
      if (session.id === ANON) return;

      const result = captureSetCookie({
        url: details.url,
        ...(details.responseHeaders ? { responseHeaders: details.responseHeaders } : {}),
      });
      if (!result.cookies.length) return;

      for (const cookie of result.cookies) session.store.upsert(cookie);
      engine.markDirty([session.id]);
      persistence.schedule();

      // A cookie set on a navigation response has to be in the rule before the
      // redirect that reads it back leaves, or the site sees the header without
      // the cookie it just set and declares cookies disabled, which is the
      // "Cookies are disabled" wall a SAML sign-in hits mid-chain. So a
      // navigation response recompiles now rather than on the deferred schedule.
      // A subresource cookie, which is far more frequent, keeps coalescing. This
      // narrows the race but cannot close it: the listener is observational, so
      // the browser can still issue the redirect before the rule lands.
      if (details.type === 'main_frame' || details.type === 'sub_frame') {
        await engine.flush();
      }

      // A top level response that set a cookie is this session signing in
      // somewhere. Subresources are excluded deliberately: a tracker in an
      // iframe of a managed page sets cookies too, and letting one join the
      // family would have the session claim half the ad network and start
      // holding tabs on it.
      if (details.type !== 'main_frame' || !binding) return;
      if (registry.noteFamily(session.id, details.url)) {
        const domain = domainOf(details.url);
        note('info', 'session', 'a session also signs in somewhere new', {
          session: session.label,
          host: domain,
        });
        noteInTab(details.tabId, 'Also covers', session.color, domain);
      }
    })();
    return undefined;
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders', 'extraHeaders']
);

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Desync detection reads onSendHeaders, not
 *           |  onBeforeSendHeaders.
 *  How      |  Measured on Opera 150: onBeforeSendHeaders reports the
 *           |  request before DNR rewrites it, so it sees the profile jar
 *           |  the rule is about to replace and calls every managed
 *           |  request a leak. onSendHeaders carries what actually goes
 *           |  on the wire.
 * ------------------------------------------------------------------
 */
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    void (async () => {
      await whenReady();
      const binding = registry.binding(details.tabId);
      if (!binding) return;
      const session = registry.getSession(binding.sessionId);
      if (!session) return;

      registry.seal(details.tabId);

      let url: URL;
      try {
        url = new URL(details.url);
      } catch {
        return;
      }

      const context = contextFor({
        type: details.type,
        url: details.url,
        ...(details.initiator ? { initiator: details.initiator } : {}),
      });
      const expected = emit(session.store, url, context).header;
      const sent = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'cookie')?.value;

      // Who else was on the page, and through whom. Recorded whatever the
      // setting says, because a control with no evidence behind it is a
      // preference nobody can reason about: the point of the list is to show
      // what the choice is actually about.
      if (context === 'third-party') {
        const party = domainOf(details.url);
        const via = domainOf(binding.url);
        if (party && via) {
          thirdPartyLog(session.id).note(party, via, !sent, Date.now());
          persistence.schedule();
        }

        // A third party the session allows through is meant to carry the
        // browser's own cookies: that is exactly what allowing it does. So its
        // cookies are not foreign, they are the point, and calling them a leak
        // is a false alarm that made the whole list read as broken while the
        // setting said allow. Only a third party the session is actually
        // blocking, or a first party, can carry a cookie it should not have.
        const allowed =
          session.thirdParty !== 'block' ||
          (party ? (session.allowedParties ?? []).includes(party) : false);
        if (allowed) return;
      }

      desync.observed();
      const result = compare(sent, expected);
      if (result.matched) return;

      for (const event of result.events) {
        desync.record({
          ...event,
          url: details.url,
          tabId: details.tabId,
          sessionId: session.id,
          context,
          at: Date.now(),
        });
      }
      // A foreign cookie means the profile jar reached a managed tab, which is
      // the failure this whole design exists to prevent. Never silent.
      if (result.events.some((e) => e.kind === 'foreign')) {
        note('error', 'jar', 'a request carried a cookie it should not have', {
          session: session.label,
          url: details.url,
          detail: result.events.join(', '),
        });
        void anomaly('foreign_cookie');
        engine.markDirty([session.id]);
        void engine.flush();
        paintAlarm();
      }
    })();
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['requestHeaders', 'extraHeaders']
);

// ------------------------------------------------------------------ alarm

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The toolbar button, when isolation is not holding.
 *  How      |  Everything above measures; this is the only thing that
 *           |  interrupts. Only foreign reaches the toolbar: stale fires
 *           |  once per hop of every sign-in and missing is usually a
 *           |  rule not landed yet.
 *  Note     |  A badge that is usually on is one nobody reads.
 * ------------------------------------------------------------------
 */
/** Only redrawn when the number changes, since this runs off a hot path. */
let badged = -1;

function paintAlarm(): void {
  const foreign = desync.snapshot().foreign;
  if (foreign === badged) return;
  badged = foreign;

  const api = badgeApi();
  if (!api) return;
  try {
    api.setBadgeText({ text: foreign ? (foreign > 99 ? '99+' : String(foreign)) : '' });
    api.setBadgeBackgroundColor({ color: '#c4614a' });
    api.setTitle({
      title: foreign
        ? `NVX Session: ${foreign} request${foreign === 1 ? '' : 's'} carried a cookie its session does not own`
        : 'NVX Session',
    });
  } catch {
    /* a browser without a badge is not a reason to stop isolating anything */
  }
}

// --------------------------------------------------------------- adoption

/** What the panel is shown. Cookie values never leave the worker. */
interface CandidateSummary {
  domain: string;
  hosts: string[];
  cookies: number;
  identity: string | null;
  signedIn: boolean;
  open: boolean;
  expires: number | null;
  label: string;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  One account, as the first run screen shows it.
 *  Note     |  A group rather than a domain, because a person has
 *           |  accounts and the jar has domains, and this screen
 *           |  translates between the two.
 * ------------------------------------------------------------------
 */
interface GroupSummary {
  key: string;
  label: string;
  domains: string[];
  cookies: number;
  signedIn: boolean;
  open: boolean;
  fits: boolean;
  /** How many tabs are open on this account right now. */
  openTabs?: number;
  expires: number | null;
  rules: number;
  /** Whether this arrives ticked. Decided in the kernel, not in the page. */
  preselect: boolean;
}

function summarise(c: AdoptionCandidate): CandidateSummary {
  return {
    domain: c.domain,
    hosts: c.hosts,
    cookies: c.cookies.length,
    identity: c.identity?.label ?? null,
    signedIn: looksSignedIn(c),
    open: c.open,
    expires: c.expires,
    label: proposedLabel(c),
  };
}

async function readCandidates(): Promise<AdoptionCandidate[]> {
  const [cookies, tabs] = await Promise.all([chrome.cookies.getAll({}), chrome.tabs.query({})]);
  const openDomains = tabs.map((t) => domainOf(t.url ?? '')).filter(Boolean);
  return candidatesFrom(cookies, { openDomains });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Everything the profile is already carrying, ranked by how
 *           |  much it looks like a signed-in account rather than a
 *           |  preference cookie.
 * ------------------------------------------------------------------
 */
async function scanForAdoption(): Promise<{
  candidates: CandidateSummary[];
  groups: GroupSummary[];
  total: number;
  tabs: number;
}> {
  try {
    const candidates = await readCandidates();
    const groups = groupCandidates(candidates);
    const ticked = new Set(preselected(groups).map((g) => g.key));

    // Per domain rather than a total, so each proposal can say how much of what
    // is on screen right now it accounts for. That number is the one somebody
    // reads first: a group with four of their tabs in it is recognisable in a
    // way that a group with a good cookie score is not.
    const web = (await chrome.tabs.query({})).filter((t) => /^https?:/i.test(t.url ?? ''));
    const tabsPer = new Map<string, number>();
    for (const t of web) {
      const d = domainOf(t.url ?? '');
      if (d) tabsPer.set(d, (tabsPer.get(d) ?? 0) + 1);
    }
    const openTabs = web.length;
    return {
      // A heavy profile holds thousands of domains and almost none of them are
      // accounts. Sending them all would be a slow list nobody reads.
      candidates: candidates.slice(0, 120).map(summarise),
      groups: groups.slice(0, 60).map((g) => ({
        key: g.key,
        label: g.label,
        domains: g.members.map((m) => m.domain),
        cookies: g.members.reduce((n, m) => n + m.cookies.length, 0),
        signedIn: g.signedIn,
        open: g.open,
        fits: g.fits,
        expires: g.expires,
        rules: estimateRules(g.members),
        preselect: ticked.has(g.key),
        openTabs: g.members.reduce((n, m) => n + (tabsPer.get(m.domain) ?? 0), 0),
      })),
      total: candidates.length,
      tabs: openTabs,
    };
  } catch (e) {
    note('error', 'adopt', 'could not read the profile jar', { detail: String(e) });
    telemetry.error('adopt_failed');
    return { candidates: [], groups: [], total: 0, tabs: 0 };
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Turn a selection into a session.
 *  Note     |  Copies, never moves. The profile jar is left as it was, so
 *           |  an unmanaged tab keeps working and undoing this costs only
 *           |  deleting the session.
 * ------------------------------------------------------------------
 */
async function adopt(msg: {
  domains?: unknown;
  label?: unknown;
  color?: unknown;
  bindOpenTabs?: unknown;
}): Promise<{ ok: boolean; id?: string; cookies?: number; tabs?: number; reason?: string }> {
  const wanted = new Set(
    Array.isArray(msg.domains) ? msg.domains.filter((d): d is string => typeof d === 'string') : []
  );
  if (!wanted.size) return { ok: false, reason: 'nothing selected' };

  const chosen = (await readCandidates()).filter((c) => wanted.has(c.domain));
  if (!chosen.length) return { ok: false, reason: 'those domains hold no cookies any more' };

  // Checked here, not only in the panel. A selection past the budget compiles
  // to a rule set that silently drops hosts, and a session that isolates some
  // of its domains and not others is worse than one that was never made.
  if (!fitsBudget(chosen)) {
    return {
      ok: false,
      reason: `${chosen.length} sites need ${estimateRules(chosen)} rules, over the ${RULES_PER_SESSION} a session gets`,
    };
  }

  const id: SessionId = `s_${Date.now().toString(36)}`;
  const store = new CookieStore();
  for (const candidate of chosen) {
    for (const cookie of candidate.cookies) store.upsert(cookie);
  }
  store.takeDirty();

  registry.createSession({
    id,
    label: cleanLabel(msg.label, proposedLabel(chosen[0]!)),
    color: cleanColor(msg.color),
    pinned: [...wanted],
    store,
    // Empty on purpose. The first managed load on each adopted origin copies
    // that origin's own localStorage into this session, so a session adopted
    // from a signed-in profile arrives signed in rather than merely holding
    // the right cookies.
    family: [],
    forked: [],
    danger: DEFAULT_DANGER,
    thirdParty: DEFAULT_THIRD_PARTY,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  });

  let bound = 0;
  if (msg.bindOpenTabs !== false) {
    // The tabs already open on these domains are the ones this session was
    // adopted from. Their cookies are identical, so binding them is invisible
    // rather than disruptive.
    for (const tab of await chrome.tabs.query({})) {
      if (typeof tab.id !== 'number' || !tab.url) continue;
      if (!wanted.has(domainOf(tab.url))) continue;
      if (registry.binding(tab.id)) continue;
      touched(
        registry.bind(tab.id, id, {
          windowId: tab.windowId ?? chrome.windows.WINDOW_ID_NONE,
          url: tab.url,
          origin: 'adopted',
        })
      );
      bound++;
    }
  }

  engine.markDirty([id]);
  await engine.flush();
  persistence.schedule();
  await persistence.save();
  await registerAgent();
  repaintSession(id);
  scheduleRegroup();

  /**
   * Recorded rather than only returned. Adoption is the largest single thing
   * this product does to a profile, it happens once, and "which sites did I put
   * in that session" is asked weeks later when the panel shows the answer after
   * the fact rather than the decision.
   */
  note('info', 'adopt', 'adopted a signed-in profile into a session', {
    session: registry.getSession(id)?.label ?? id,
    detail: `${chosen.length} site(s), ${store.size} cookie(s), ${bound} tab(s) bound: ${[...wanted].sort().join(', ')}`,
  });

  return { ok: true, id, cookies: store.size, tabs: bound };
}

// ------------------------------------------------------------- validation

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The identity ramp, in the order sessions are handed
 *           |  colours.
 *  How      |  Ordered so consecutive picks sit far apart on the wheel:
 *           |  the second session must not look like the first on a dim
 *           |  screen, and cyan followed by azure did.
 *  Note     |  This list and COLORS in panel.js are the same list in the
 *           |  same order.
 * ------------------------------------------------------------------
 */
const RAMP = ['cyan', 'coral', 'jade', 'violet', 'amber', 'azure', 'magenta', 'chalk'];
const MAX_LABEL = 64;
const MAX_PINNED = 64;

/** Reserved for machinery like the anonymous holding session. */
function reservedId(id: string): boolean {
  return id.startsWith('__nvx');
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  New sessions block third parties they have no cookies for.
 *  How      |  A session exists to be separate, and a tracker handed the
 *           |  same identifier from every session makes them one person
 *           |  to anyone counting.
 *  Note     |  The cost is an embedded third party appearing signed out,
 *           |  reversible in one click and listed with the evidence.
 * ------------------------------------------------------------------
 */
const DEFAULT_THIRD_PARTY: 'allow' | 'block' = 'block';

function cleanThirdParty(raw: unknown): 'allow' | 'block' {
  return raw === 'allow' || raw === 'block' ? raw : DEFAULT_THIRD_PARTY;
}

function cleanLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  // Control characters would corrupt a tab group title and the mark's letter.
  const trimmed = raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_LABEL);
  return trimmed || fallback;
}

function cleanColor(raw: unknown): string {
  return typeof raw === 'string' && RAMP.includes(raw) ? raw : nextColor();
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Pinned domains become content script match patterns, and
 *           |  one malformed entry makes registerContentScripts throw.
 *  Note     |  Registration is an unregister then a register, so that
 *           |  failure leaves none at all and the mark and chooser stop
 *           |  everywhere. Cleaned at the door.
 * ------------------------------------------------------------------
 */
function cleanPinned(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const host = entry.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
    if (!host || host.length > 253) continue;
    if (!/^[a-z0-9.-]+$/.test(host)) continue;
    if (!host.includes('.') && host !== 'localhost') continue;
    if (!out.includes(host)) out.push(host);
    if (out.length >= MAX_PINNED) break;
  }
  return out;
}

/** Spreads new sessions across the ramp rather than restarting at cyan. */
function nextColor(): string {
  const used = new Set(registry.listSessions().map((s) => s.color));
  return RAMP.find((c) => !used.has(c)) ?? RAMP[registry.listSessions().length % RAMP.length]!;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Normalise one cookie from an imported backup into a valid
 *           |  jar cookie, or null.
 *  How      |  A well-formed export round-trips exactly; this fills
 *           |  defaults for the hand-edited or foreign file and rejects
 *           |  anything without the three fields that cannot be
 *           |  defaulted.
 *  Note     |  The one place untrusted file contents enter the jar, so it
 *           |  validates.
 * ------------------------------------------------------------------
 */
function cleanImportedCookie(raw: unknown): import('../jar/cookie.js').Cookie | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') {
    return null;
  }
  const domain = c.domain.replace(/^\.+/, '').toLowerCase();
  if (!domain) return null;
  const now = Date.now();
  const ss = c.sameSite;
  return {
    name: c.name,
    value: c.value,
    domain,
    hostOnly: c.hostOnly === true,
    path: typeof c.path === 'string' && c.path ? c.path : '/',
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
    sameSite: ss === 'strict' || ss === 'lax' || ss === 'none' ? ss : 'lax',
    sameSiteDefaulted: c.sameSiteDefaulted === true,
    partitioned: c.partitioned === true,
    expires: typeof c.expires === 'number' ? c.expires : null,
    created: typeof c.created === 'number' ? c.created : now,
    lastAccess: typeof c.lastAccess === 'number' ? c.lastAccess : now,
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Put a cookie in a session's jar exactly as a Set-Cookie
 *           |  would.
 *  Note     |  Through the real parser, so a suite cannot seed something
 *           |  the browser would have rejected and then prove isolation
 *           |  about a cookie that could never exist.
 * ------------------------------------------------------------------
 */
async function seedCookie(sessionId: string, url: string, header: string): Promise<unknown> {
  await whenReady();
  const session = registry.getSession(sessionId);
  if (!session) throw new Error(`no session ${sessionId}`);
  const parsed = parseSetCookie(header, { url: new URL(url) }, { isPublicSuffix });
  if (!parsed.ok) throw new Error(`rejected: ${parsed.reason}`);
  session.store.upsert(parsed.cookie);
  engine.markDirty([sessionId]);
  await engine.flush();
  return parsed.cookie;
}

/** The session that owns an origin's service worker, for tabId -1 traffic. */
function ownerSessionFor(url: string) {
  const policy = registry.serviceWorkerPolicy(url);
  return policy.owner && !policy.contested ? registry.getSession(policy.owner) : undefined;
}

// ------------------------------------------------------------- lifecycle

/**
 * ------------------------------------------------------------------
 *  Purpose  |  One panel, not one per click.
 *  Note     |  Clicking the action repeatedly is the normal way to check
 *           |  on things, and spawning a tab each time buries the browser
 *           |  in identical panels.
 * ------------------------------------------------------------------
 */
async function openPanel(): Promise<void> {
  const url = chrome.runtime.getURL('diagnostics.html');
  const existing = await chrome.tabs.query({ url });
  const open = existing.find((t) => typeof t.id === 'number');
  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { active: true });
    if (typeof open.windowId === 'number') {
      await chrome.windows.update(open.windowId, { focused: true }).catch(() => undefined);
    }
    return;
  }
  await chrome.tabs.create({ url });
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Fires only when there is no popup to open, so it is dead
 *           |  while the manifest declares one.
 *  Note     |  Kept because it costs nothing and is correct for any build
 *           |  shipped without a popup. Alt+Shift+S and the popup's own
 *           |  link reach the panel now.
 * ------------------------------------------------------------------
 */
actionApi()?.onClicked.addListener(() => void openPanel());

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Move the active tab to the Nth session, for the keyboard
 *           |  shortcuts.
 *  How      |  N is the position in the session list the user sees,
 *           |  one-based. Out of range or no active tab is a quiet no-op.
 *  Note     |  The move is remembered so the popup can offer to undo it.
 * ------------------------------------------------------------------
 */
async function moveActiveToNth(n: number): Promise<void> {
  const sessions = registry.listSessions().filter((s) => s.id !== ANON);
  const target = sessions[n - 1];
  if (!target) return;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof active?.id !== 'number') return;
  await moveTabs([active.id], target.id, { remember: true });
  telemetry.feature('key_move');
}

chrome.commands?.onCommand.addListener((command) => {
  if (command === 'open-panel') {
    void openPanel();
    return;
  }
  const move = /^move-to-session-([1-9])$/.exec(command);
  if (move) void whenReady().then(() => moveActiveToNth(Number(move[1])));
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A record of which lifecycle events actually fire.
 *  How      |  They differ by how the extension is loaded: a command-line
 *           |  load never fires onStartup and fires onInstalled every
 *           |  launch; installed properly, the reverse. The difference
 *           |  decides whether a browser start can be detected.
 * ------------------------------------------------------------------
 */
async function noteLifecycle(event: string, detail = ''): Promise<void> {
  try {
    const key = 'nvx.lifecycle';
    const held = await storage.get([key]);
    const log = Array.isArray(held[key]) ? (held[key] as unknown[]) : [];
    log.push({ event, detail, at: Date.now() });
    await storage.set({ [key]: log.slice(-20) });
  } catch {
    /* diagnostics are never worth failing a boot over */
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Right-click a link, open it signed in as a chosen session.
 *  How      |  A work link should reach the work account in one action.
 *           |  It uses the same safe path as Sign in here, so the tab is
 *           |  in the session before the link is fetched.
 *  Note     |  Rebuilt whenever the sessions change.
 * ------------------------------------------------------------------
 */
/**
 * ------------------------------------------------------------------
 *  Purpose  |  The right-click menu, rebuilt whenever the session list
 *           |  changes.
 *  How      |  "Open link in session" sends a link into a session without
 *           |  opening it in the wrong one first; "This tab" moves the
 *           |  current tab or hands it back.
 *  Note     |  Gated on there being at least one real session; "hand
 *           |  back" is always offered and no-ops on an unbound tab.
 * ------------------------------------------------------------------
 */
function rebuildMenus(): void {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    const sessions = registry.listSessions().filter((x) => x.id !== ANON);
    if (!sessions.length) return;

    const onLink = chrome.contextMenus.create({
      id: 'nvx.open',
      title: 'Open link in session',
      contexts: ['link'],
    });
    for (const sn of sessions) {
      chrome.contextMenus.create({
        id: `nvx.open.${sn.id}`,
        parentId: onLink,
        title: sn.label,
        contexts: ['link'],
      });
    }

    const onPage = chrome.contextMenus.create({
      id: 'nvx.tab',
      title: 'This tab',
      contexts: ['page'],
    });
    for (const sn of sessions) {
      chrome.contextMenus.create({
        id: `nvx.move.${sn.id}`,
        parentId: onPage,
        title: `Move to ${sn.label}`,
        contexts: ['page'],
      });
    }
    chrome.contextMenus.create({
      id: 'nvx.sep',
      parentId: onPage,
      type: 'separator',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'nvx.unbind',
      parentId: onPage,
      title: 'Hand back to the browser',
      contexts: ['page'],
    });
  });
}

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const id = typeof info.menuItemId === 'string' ? info.menuItemId : '';

    if (id.startsWith('nvx.open.') && info.linkUrl) {
      const sessionId = id.slice('nvx.open.'.length);
      void whenReady().then(() => openInSession(sessionId, info.linkUrl!));
      return;
    }

    // The page actions target the tab that was right-clicked, through the same
    // guarded move the popup uses, so a menu move is exactly as safe as a
    // popup one.
    if (typeof tab?.id !== 'number') return;
    if (id.startsWith('nvx.move.')) {
      const sessionId = id.slice('nvx.move.'.length);
      void whenReady().then(async () => {
        await moveTabs([tab.id!], sessionId, { remember: true });
        telemetry.feature('context_move');
      });
      return;
    }
    if (id === 'nvx.unbind') {
      void whenReady().then(async () => {
        await moveTabs([tab.id!], null, { remember: true });
        telemetry.feature('context_move');
      });
    }
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  const reason = details?.reason ?? '';
  void noteLifecycle('onInstalled', reason);
  void whenReady().then(async () => {
    note('info', 'life', 'installed', { detail: reason });
    // Consent may already be on from a prior install (this fires on update
    // too), so make the id ready and the env known, then a single install or
    // update signal carrying the device profile.
    await telemetry.ready();
    await ensureEnv();
    if (reason === 'install') {
      // The install clock, for the days-since-install cohort on the active beat.
      // Set once and never overwritten, so an update does not reset the age.
      const held = await storage.get([INSTALLED_AT_KEY]);
      if (typeof held[INSTALLED_AT_KEY] !== 'number') {
        await storage.set({ [INSTALLED_AT_KEY]: Date.now() });
      }
      telemetry.install('install');
      // Only counts as reported if consent was already on so the send could
      // actually leave. With consent off, the send was dropped and the marker
      // stays absent, so the first opt-in knows to send the install it missed.
      if (settings.telemetry) await storage.set({ [INSTALL_REPORTED_KEY]: Date.now() });
    } else if (reason === 'update') {
      telemetry.install('update');
      if (settings.telemetry) await storage.set({ [INSTALL_REPORTED_KEY]: Date.now() });
    }
    /**
     * Nothing opens on its own at install.
     *
     * The setup screen used to auto-open here, on the reasoning that an
     * extension installed onto a years-old profile does nothing visible until
     * somebody finds it. But the screen read the whole profile and proposed one
     * session per account it recognised, which on a real profile is a wall of
     * sessions a new user has no frame to judge, and it landed as "does this
     * want a session for every tab?" rather than as help. A session is a group
     * of related tabs that share an account, made deliberately, so the first
     * move belongs to the user: the popup opens to an empty list with New
     * session, and Set up from profile is there in Settings for anyone who does
     * want the profile read for them.
     */
  });
});

async function openWelcome(): Promise<void> {
  const url = chrome.runtime.getURL('welcome.html');
  try {
    const existing = await chrome.tabs.query({ url });
    const open = existing.find((t) => typeof t.id === 'number');
    if (open?.id !== undefined) {
      await chrome.tabs.update(open.id, { active: true });
      return;
    }
    await chrome.tabs.create({ url, active: true });
  } catch (e) {
    note('warn', 'life', 'could not open the setup screen', { detail: String(e) });
  }
}
chrome.runtime.onStartup.addListener(() => {
  void noteLifecycle('onStartup');
  void whenReady().then(async () => {
    await telemetry.ready();
    await ensureEnv();
    telemetry.startup();
    void maybeActive();
  });
  // Session rules die with the browser session, so a restart has to recompile
  // everything rather than trust what the registry remembers.
  ready = boot().then(async () => {
    // boot has already dropped what a new browser session should drop and put
    // the tabs back, guarded by its own marker, so this only has to make sure
    // the rules exist. Kept because a browser that does fire it gets the work
    // done a little earlier.
    engine.markDirty(registry.listSessions().map((s) => s.id));
    await engine.flush();
  });
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Whether the browser itself has just started, not the
 *           |  worker waking or the extension reloading.
 *  How      |  chrome.storage.session clears when the browser session
 *           |  ends, but also on reload or update, so it is paired with
 *           |  the tabs: across a restart every tab returns with a new
 *           |  id, so one surviving binding proves the browser kept
 *           |  running.
 *  Note     |  onStartup is not usable: in Opera GX loaded from the
 *           |  command line it does not fire.
 * ------------------------------------------------------------------
 */
async function newBrowserSession(survivingBindings: number): Promise<boolean> {
  const area = (chrome.storage as { session?: chrome.storage.StorageArea }).session;
  // Manifest v2 has no session area, and its background page dies with the
  // browser, so every boot there really is a new browser session.
  if (!area) return true;
  try {
    const seen = await area.get('nvx.browserSession');
    await area.set({ 'nvx.browserSession': Date.now() });
    if (seen['nvx.browserSession']) return false;
    return survivingBindings === 0;
  } catch {
    // Refusing to answer is not answering yes. Dropping every session cookie
    // because a storage call failed would sign the user out for no reason.
    return false;
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Forget what the browser would have forgotten.
 *  How      |  A cookie with no expiry lasts a browser session, and this
 *           |  is where one ends; persisting the jar would keep them.
 *           |  Persistent cookies stay.
 *  Bug-Fix  |  A twelve-hour-old MoodleSession bounced between service
 *           |  and provider forever, one side also missing
 *           |  MDL_SSP_SessID, so that chain could never complete.
 * ------------------------------------------------------------------
 */
function dropSessionCookies(): void {
  let dropped = 0;
  const dirty: SessionId[] = [];
  for (const session of registry.listSessions()) {
    const doomed = session.store.all().filter((c) => c.expires === null);
    if (!doomed.length) continue;
    for (const c of doomed) {
      if (session.store.remove(cookieKey(c))) dropped++;
    }
    dirty.push(session.id);
  }
  if (!dropped) return;
  engine.markDirty(dirty);
  persistence.schedule();
  note('info', 'jar', 'dropped session cookies the browser would not have kept', {
    detail: `${dropped} cookie(s)`,
  });
}

// ------------------------------------------------------------------- api

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Commands come from the extension's own pages, never from a
 *           |  page.
 *  How      |  A content script shares this extension's message channel
 *           |  and runs in every managed tab; a compromised renderer
 *           |  could reach a surface where adoptScan alone lists every
 *           |  signed-in identity. A sender with a tab is a content
 *           |  script; the panel has none.
 * ------------------------------------------------------------------
 */
function fromOwnPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id && sender.id !== chrome.runtime.id) return false;

  // Not sender.tab. The panel is a page in a tab like any other, so that flag
  // is set for it too and rejecting on it locks the extension out of itself.
  // What actually separates the two is the document: a content script reports
  // the page's URL, which can never be under our own origin.
  const base = chrome.runtime.getURL('');
  const from = sender.url ?? '';
  const origin = sender.origin ?? '';
  return from.startsWith(base) || `${origin}/` === base;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  /**
   * The one message a content script is allowed to send, handled before the gate
   * below rather than by loosening it.
   *
   * It is safe to accept for two reasons that are worth stating separately.
   * **It names nothing:** which domain loses the posture comes from the sender
   * the browser stamps on the message, so a frame can only ever withdraw from
   * itself. And **it can only subtract:** the effect is less masking on that one
   * domain, which is a state any site can already reach by serving a policy that
   * refuses workers. There is no version of this that grants anything.
   */
  if (msg?.kind === 'mask.blocked') {
    if (sender.id && sender.id !== chrome.runtime.id) {
      reply({ error: 'not permitted' });
      return false;
    }
    const from = sender.origin || sender.url || '';
    void whenReady().then(async () => {
      const host = domainOf(from);
      if (host) await degrade(host);
    });
    reply({ ok: true });
    return false;
  }

  if (!fromOwnPage(sender)) {
    reply({ error: 'not permitted' });
    return false;
  }
  void (async () => {
    await whenReady();
    switch (msg?.cmd) {
      case 'state':
        reply({
          sessions: registry.listSessions().map((s) => {
            const identity = identityAcross(
              s.store.domains().map((d) => [d, s.store.forDomain(d)] as const),
              new Set(s.pinned.map((p) => registrableDomain(p)))
            );
            return {
              id: s.id,
              label: s.label,
              color: s.color,
              pinned: s.pinned,
              family: s.family,
              thirdParty: s.thirdParty,
              allowedParties: s.allowedParties ?? [],
              thirdParties: thirdPartyLog(s.id).ranked().slice(0, 40),
              cookies: s.store.size,
              tabs: registry.tabsFor(s.id),
              danger: s.danger,
              blastRadius: guard.audit.forSession(s.id).length,
              // The anonymous holding session is machinery, not something the
              // user made, so the panel has to be able to tell it apart.
              system: s.id === ANON,
              ...(identity ? { identity: identity.label, identityDomain: identity.domain } : {}),
            };
          }),
          bindings: registry.listBindings(),
          backend: engine instanceof Engine ? 'dnr' : 'blocking',
          settings,
          groupsAvailable: browserGroupApi() !== null,
          desync: desync.snapshot(),
          recentDesync: desync.recent(20),
          /**
           * What the mask does and, more to the point, what it does not.
           *
           * Sent rather than restated in the panel, because the one thing worse
           * than an unfinished surface is a settings screen implying it is
           * finished. Same rule the storage view already follows when it reports
           * an origin as shared.
           */
          /**
           * The last sign-in loop this stopped, so the panel can say what
           * happened and offer to put it back. Cleared when it is put back or
           * when the user dismisses it; a release the user made by hand does
           * not appear here, because there is nothing to explain.
           */
          loop: loopReport,
          released: settings.released,
          // The one move made with the popup closed that it can still offer to
          // take back. Sent so the home view can show an undo for a right-click
          // or keyboard move that had nowhere to put one at the time.
          lastMove:
            lastMove && Date.now() - lastMove.at < LAST_MOVE_TTL_MS
              ? { tabId: lastMove.tabId, label: lastMove.label, to: lastMove.to }
              : null,
          // Whether this build can send telemetry at all. The consent card and
          // toggle are pointless in a build with no endpoint, so the UI hides
          // them unless this is true. It says nothing about consent, only about
          // whether the machinery exists.
          telemetryPossible: (() => {
            const field = (
              chrome.runtime.getManifest() as { nvx_telemetry?: { endpoint?: unknown } }
            ).nvx_telemetry;
            return typeof field?.endpoint === 'string' && /^https:\/\//.test(field.endpoint);
          })(),
          // The Pro tier, section 30. `tier` and `entitlements` drive which
          // features the settings screen shows as unlocked; `license` drives the
          // Enter-licence and device-seat UI; `sync` drives the sync panel. All
          // inert on a free build, where `buildPro` is false and the popup shows
          // only the roadmap.
          ...licenseSnapshot(),
          sync: sync.status(),
          mask: {
            available: canScopeAgent(),
            applied: compile(standardFor(realMachine()), livePosture()).applied,
            unapplied: UNAPPLIED,
            /**
             * Tabs the posture is deliberately not covering, because their
             * documents are older than it is. Reported rather than inferred:
             * the setting says it is on, these tabs are not covered by it, and
             * the difference is only visible from in here.
             */
            unmasked: unmaskedTabs.size,
          },
        });
        return;

      case 'createSession': {
        const requested = typeof msg.id === 'string' ? msg.id : '';
        if (requested && reservedId(requested)) {
          reply({ ok: false, reason: 'that id is reserved' });
          return;
        }
        const id: SessionId = requested || `s_${Date.now().toString(36)}`;
        registry.createSession({
          id,
          label: cleanLabel(msg.label, id),
          color: cleanColor(msg.color),
          pinned: cleanPinned(msg.pinned),
          store: new CookieStore(),
          family: [],
          forked: [],
          danger: cleanDanger(msg.danger),
          thirdParty: cleanThirdParty(msg.thirdParty),
          createdAt: Date.now(),
          lastSeen: Date.now(),
        });
        persistence.schedule();
        void registerAgent();
        rebuildMenus();
        note('info', 'session', 'created', {
          session: cleanLabel(msg.label, id),
          detail: cleanPinned(msg.pinned).join(', ') || 'no pinned domains',
        });
        // Only how many sessions now exist, as a bucket, never their names or
        // pinned sites.
        telemetry.sessionCreated(registry.listSessions().filter((x) => x.id !== ANON).length);
        reply({ ok: true, id });
        return;
      }

      /**
       * A tab that is in a session before it makes its first request.
       *
       * This is the safe way to put an account into a session, and the whole
       * reason it exists as its own command rather than "create a tab and
       * navigate". A federated login is broken by being handed part of a cookie
       * set, so the binding and the rules have to be in place before the very
       * first request leaves. So: an empty tab, bound, the rules flushed, the
       * scripts registered, and only then pointed at the site. By the time the
       * sign-in page loads, the tab is already this session and nothing of the
       * profile's own login was ever on the wire.
       *
       * The domain is pinned to the session as well, so the account sticks:
       * the next time this site is opened it goes to this session on its own,
       * and if the same site later belongs to a second session the picker
       * starts asking, which is the account switcher the user actually wants.
       */
      case 'openInSession': {
        const out = await openInSession(msg.sessionId, typeof msg.url === 'string' ? msg.url : '');
        if (out?.ok) telemetry.feature('sign_in');
        reply(out);
        return;
      }

      /**
       * A burner tab: a fresh, throwaway session that clears itself when its tab
       * closes.
       *
       * The Chromium answer to Firefox's temporary containers, and a thing no
       * separate-profile tool does gracefully. It is an ephemeral session, so its
       * jar is never written to disk and it is reaped the moment its last tab
       * closes (see reapBurner), which makes it the honest tool for a one-off
       * sign-in you do not want lingering in any session afterwards.
       */
      case 'newBurner': {
        const id: SessionId = `s_${Date.now().toString(36)}`;
        registry.createSession({
          id,
          label: 'Burner',
          color: cleanColor(msg.color),
          pinned: [],
          store: new CookieStore(),
          family: [],
          forked: [],
          danger: cleanDanger(undefined),
          thirdParty: cleanThirdParty(undefined),
          ephemeral: true,
          createdAt: Date.now(),
          lastSeen: Date.now(),
        });
        persistence.schedule();
        const out = await openInSession(id, typeof msg.url === 'string' ? msg.url : '');
        // Opening it failed, so there is no tab that will ever close to reap it.
        if (!out?.ok) await reapBurner(id);
        reply({ ...out, id });
        return;
      }

      /**
       * Many tabs into one session, or out of every session, in one guarded
       * operation. See moveTabs.
       */
      case 'moveTabs': {
        const list = Array.isArray(msg.tabIds)
          ? msg.tabIds.filter((n: unknown): n is number => typeof n === 'number')
          : [];
        const to = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null;
        const out = await moveTabs(list, to);
        // A count, not which tabs or where. Only a real batch of more than one
        // is a bulk move worth a signal.
        if (out?.ok && out.moved > 1) telemetry.feature('bulk_move');
        reply(out);
        return;
      }

      /**
       * Takes back the last move made with the popup closed. Puts the tab back
       * where it was through the same guarded path, then forgets the move so it
       * is offered only once.
       */
      case 'undoLastMove': {
        if (!lastMove) {
          reply({ ok: false, reason: 'nothing to undo' });
          return;
        }
        const { tabId, from } = lastMove;
        lastMove = null;
        const out = await moveTabs([tabId], from);
        if (out?.ok) telemetry.feature('undo_move');
        reply(out);
        return;
      }

      /** Keeps the move; just stops offering to undo it. */
      case 'dismissLastMove': {
        lastMove = null;
        reply({ ok: true });
        return;
      }

      case 'bind':
        touched(
          registry.bind(msg.tabId, msg.sessionId, {
            windowId: msg.windowId ?? chrome.windows.WINDOW_ID_NONE,
            url: msg.url ?? '',
            origin: 'manual',
          }),
          true
        );
        noteBinding(msg.tabId, msg.sessionId, 'moved by hand', msg.url ?? '');
        // A binding change that did not need a reload still moves where this
        // document's storage lives, and the shim has no other way to hear it.
        pushStorage(msg.tabId);
        await engine.flush();
        reply({ ok: true });
        return;

      /**
       * Rename, recolour, repin. Adoption names a session from whatever its
       * tokens happened to say, which is the right guess and often not the
       * right name, so editing has to be as easy as accepting it.
       */
      case 'editSession': {
        const session = registry.getSession(msg.sessionId);
        if (!session) {
          reply({ ok: false, reason: 'no such session' });
          return;
        }
        const before = { label: session.label, color: session.color };
        if (msg.label !== undefined) session.label = cleanLabel(msg.label, session.label);
        if (msg.color !== undefined) session.color = cleanColor(msg.color);
        if (msg.pinned !== undefined) session.pinned = cleanPinned(msg.pinned);
        if (msg.danger !== undefined) {
          session.danger = cleanDanger(msg.danger);
          guard.markDirty([session.id]);
          void guard.flush();
        }

        persistence.schedule();
        void registerAgent();
        // The mark carries both the colour and the first letter of the label,
        // and a group carries the label as its title.
        if (session.label !== before.label || session.color !== before.color) {
          repaintSession(session.id);
          scheduleRegroup();
        }
        reply({
          ok: true,
          label: session.label,
          color: session.color,
          pinned: session.pinned,
          danger: session.danger,
        });
        return;
      }

      case 'deleteSession':
        note('warn', 'session', 'deleted', {
          session: registry.getSession(msg.sessionId)?.label ?? msg.sessionId,
        });
        touched(registry.deleteSession(msg.sessionId));
        await engine.retire(msg.sessionId);
        await guard.retire(msg.sessionId);
        persistence.schedule();
        void registerAgent();
        rebuildMenus();
        reply({ ok: true });
        return;

      /**
       * A session's jar, out to a file and back.
       *
       * Export hands the popup the session's cookie snapshot, which it saves as a
       * backup; import merges a saved snapshot into a session. It is the honest
       * counterpart to sync: sync deliberately never carries the jars, so a
       * deliberate, per-session backup is how a login is moved on purpose. The
       * caveat, the same one the DBSC finding names, is that a device-bound login
       * (a modern Google session) will not survive being carried to another
       * machine; a plain cookie session will.
       */
      case 'exportSession': {
        const session = registry.getSession(msg.sessionId);
        if (!session) {
          reply({ ok: false, reason: 'no such session' });
          return;
        }
        reply({ ok: true, label: session.label, snapshot: session.store.toSnapshot() });
        return;
      }
      case 'importSession': {
        const session = registry.getSession(msg.sessionId);
        if (!session) {
          reply({ ok: false, reason: 'no such session' });
          return;
        }
        const snap = msg.snapshot as { cookies?: unknown } | null;
        if (!snap || typeof snap !== 'object' || !Array.isArray(snap.cookies)) {
          reply({ ok: false, reason: 'that file is not an NVX session backup' });
          return;
        }
        let added = 0;
        for (const raw of snap.cookies) {
          const cookie = cleanImportedCookie(raw);
          if (!cookie) continue;
          try {
            session.store.upsert(cookie);
            added++;
          } catch {
            /* a single malformed cookie is skipped rather than failing the import */
          }
        }
        if (added) {
          engine.markDirty([session.id]);
          await engine.flush();
          persistence.schedule();
          await persistence.save();
          repaintSession(session.id);
        }
        reply({ ok: true, added });
        return;
      }

      case 'flush':
        await engine.flush();
        reply({ ok: true, rules: (await backend.current()).length });
        return;

      case 'tabs': {
        const all = await chrome.tabs.query({});
        reply(
          all.map((t) => ({
            id: t.id,
            title: t.title,
            url: t.url,
            windowId: t.windowId,
            active: t.active,
            sessionId: t.id !== undefined ? (registry.binding(t.id)?.sessionId ?? null) : null,
          }))
        );
        return;
      }

      /** What the held tab's picker shows. */
      case 'pickerOptions': {
        const host = hostOf(typeof msg.url === 'string' ? msg.url : '');
        // Peeked, not taken. See the note on peekRemembered.
        const remembered = peekRemembered(typeof msg.url === 'string' ? msg.url : '');
        reply({
          ok: true,
          options: chooserOptionsFor(host).map((o) => ({
            ...o,
            lastUsed: o.sessionId === remembered,
          })),
        });
        return;
      }

      /**
       * The answer. The tab has been sitting on the picker with nothing
       * requested, so this binds first, flushes, and only then navigates: the
       * first byte the site ever sees is already under the chosen session.
       */
      case 'pick': {
        const tabId = typeof msg.tabId === 'number' ? msg.tabId : -1;
        const url = typeof msg.url === 'string' ? msg.url : '';
        if (tabId < 0 || !/^https?:/i.test(url)) {
          reply({ ok: false, reason: 'nothing to open' });
          return;
        }
        held.delete(tabId);

        // Asked and answered. Without this the same navigation is held again
        // the moment it is released, which is a loop the user cannot leave.
        const domain = domainOf(url);
        if (domain) {
          const set = decided.get(tabId) ?? new Set<string>();
          set.add(domain);
          decided.set(tabId, set);
        }
        ephemeral.schedule();

        let sessionId: SessionId | null =
          typeof msg.sessionId === 'string' ? msg.sessionId : null;

        if (msg.create === true) {
          sessionId = `s_${Date.now().toString(36)}`;
          registry.createSession({
            id: sessionId,
            // Named after the site by default. A session called "s_m3k1" is one
            // the user has to open the panel to identify, on the one surface
            // that exists so they never have to.
            label: cleanLabel(msg.label, domain || 'New session'),
            color: nextColor(),
            pinned: domain ? [domain] : [],
            store: new CookieStore(),
            family: [],
            forked: [],
            danger: DEFAULT_DANGER,
    thirdParty: DEFAULT_THIRD_PARTY,
            createdAt: Date.now(),
            lastSeen: Date.now(),
          });
          void registerAgent();
        }

        if (sessionId && registry.getSession(sessionId)) {
          touched(
            registry.bind(tabId, sessionId, {
              windowId: chrome.windows.WINDOW_ID_NONE,
              url,
              origin: 'manual',
            }),
            true
          );
          noteBinding(tabId, sessionId, msg.create === true ? 'a new session, chosen at the picker' : 'chosen at the picker', url);
        } else {
          note('info', 'tab', 'left unmanaged, chosen at the picker', { tabId, url });
          // Unmanaged on purpose, which is a real answer rather than a refusal
          // to choose: the browser behaves exactly as it would without NVX.
          touched(registry.unbind(tabId));
        }
        resetStorageStamp(tabId);
        storageState.delete(tabId);
        persistence.schedule();
        await engine.flush();
        try {
          await chrome.tabs.update(tabId, { url });
        } catch {
          /* the tab closed while deciding */
        }
        reply({ ok: true, sessionId });
        return;
      }

      case 'unbind':
        touched(registry.unbind(msg.tabId));
        resetStorageStamp(msg.tabId);
        pushStorage(msg.tabId);
        storageState.delete(msg.tabId);
        await engine.flush();
        void paintTab(msg.tabId);
        reply({ ok: true });
        return;

      /**
       * Stops managing a site, or starts again.
       *
       * The escape hatch that was missing. Leaving a tab unmanaged is per tab
       * and dies with the browser session; unbinding is one tab; deleting the
       * session is everything. None of them says "this site and this extension
       * cannot work together", which is what somebody needs when a sign-in will
       * not complete, and what the loop detector needs somewhere to record.
       */
      case 'releaseSite': {
        const domain = typeof msg.domain === 'string' ? domainOf(`https://${msg.domain}/`) : '';
        if (!domain) {
          reply({ ok: false, reason: 'that is not a domain' });
          return;
        }
        if (msg.release === false) {
          await unreleaseSite(domain);
          if (loopReport?.domain === domain) loopReport = null;
        } else {
          await releaseSite(domain, 'released by hand');
        }
        reply({ ok: true, released: settings.released });
        return;
      }

      /** Read and understood. The release itself stands until it is undone. */
      case 'dismissLoop':
        loopReport = null;
        reply({ ok: true });
        return;

      case 'setSettings': {
        const before = settings;
        settings = {
          paint: typeof msg.paint === 'boolean' ? msg.paint : before.paint,
          group: typeof msg.group === 'boolean' ? msg.group : before.group,
          exact: typeof msg.exact === 'boolean' ? msg.exact : before.exact,
          logLevel: LEVELS.includes(msg.logLevel as Level)
            ? (msg.logLevel as Level)
            : before.logLevel,
          posture:
            msg.posture === 'mirror' ||
            msg.posture === 'standardize' ||
            msg.posture === 'persona'
              ? msg.posture
              : before.posture,
          paused: typeof msg.paused === 'boolean' ? msg.paused : before.paused,
          released: before.released,
          telemetry: typeof msg.telemetry === 'boolean' ? msg.telemetry : before.telemetry,
          // Answering the question, either way, is what sets this; it only ever
          // moves to true.
          telemetryAsked:
            before.telemetryAsked || typeof msg.telemetry === 'boolean' || msg.telemetryAsked === true,
          // Acknowledging the caution only ever moves it to true, so the card is
          // shown once and never returns.
          cautionAcked: before.cautionAcked || msg.cautionAcked === true,
          failClosed: typeof msg.failClosed === 'boolean' ? msg.failClosed : before.failClosed,
          cacheIsolation:
            typeof msg.cacheIsolation === 'boolean' ? msg.cacheIsolation : before.cacheIsolation,
        };
        persistence.schedule();
        await persistence.save();
        /**
         * Consent changed: on, mint the id and let events flow; off, drop the
         * queue and erase the id, so turning it off unwrites the one durable
         * thing it kept. Nothing is sent about the toggle itself.
         */
        if (settings.telemetry !== before.telemetry) {
          if (settings.telemetry) {
            await telemetry.ready();
            await ensureEnv();
            // A pre-consent install has no install clock; start it now so the
            // cohort is measured from first opt-in rather than not at all.
            const held = await storage.get([INSTALLED_AT_KEY, INSTALL_REPORTED_KEY]);
            if (typeof held[INSTALLED_AT_KEY] !== 'number') {
              await storage.set({ [INSTALLED_AT_KEY]: Date.now() });
            }
            // The install that fired before consent was dropped and never
            // retried, so send it now, once. Without this no install is ever
            // recorded, since nobody can consent before installing.
            if (!held[INSTALL_REPORTED_KEY]) {
              telemetry.install('install');
              await storage.set({ [INSTALL_REPORTED_KEY]: Date.now() });
            }
            recordUsage();
            void maybeActive();
          } else {
            await telemetry.purge();
            // The id is gone; the clock, the day stamp, the peak and the
            // reported marker go with it, so turning it off leaves nothing
            // durable behind.
            await storage.remove([
              INSTALLED_AT_KEY,
              LAST_ACTIVE_KEY,
              USAGE_PEAK_KEY,
              INSTALL_REPORTED_KEY,
              ANOMALY_KEY,
            ]);
            anomalyToday.clear();
          }
        }
        /**
         * Pausing withdraws everything and unpausing puts it back, and both go
         * through the same two calls because both are the same question asked
         * of every session at once.
         *
         * Recorded at error level on the way in, which is not what a deliberate
         * setting normally deserves. It earns it: a paused kernel is not
         * isolating anything, and somebody reading this journal a week later
         * needs to see that in the same colour as a failure, because as far as
         * the promise this extension makes is concerned it is one.
         */
        if (settings.paused !== before.paused) {
          note(settings.paused ? 'error' : 'info', 'life', settings.paused ? 'paused' : 'resumed', {
            detail: settings.paused
              ? 'no rules, no rewriting, no picker: every tab is an ordinary tab until this is turned back on'
              : 'isolation is back on for every session',
          });
          engine.markDirty(registry.listSessions().map((x) => x.id));
          await engine.flush();
          await registerAgent();
          repaintAll();
          if (settings.paused) telemetry.feature('pause');
        }
        if (settings.paint !== before.paint) repaintAll();
        if (settings.group !== before.group) {
          if (settings.group) await regroup();
          else await ungroupAll();
        }
        if (settings.exact !== before.exact) {
          syncExact();
          // Turning it off leaves tabs on rules alone, which are already
          // installed; turning it on has to take effect on the current page
          // rather than the next one, or the setting looks like it did nothing.
          // Gated on the effective value, not the raw setting, so toggling it
          // without the Pro feature entitled releases rather than attaches.
          if (!effectiveExact()) await exact?.releaseAll();
        }
        if (
          settings.failClosed !== before.failClosed ||
          settings.cacheIsolation !== before.cacheIsolation
        ) {
          // Strict and cache suppression each add a rule to every session, so
          // recompile them all and apply now, on the page in front of the user
          // rather than the next one. A no-op past the gate, since strictWhen and
          // cacheWhen also check the licence, but the recompile makes it take hold.
          engine.markDirty(registry.listSessions().map((x) => x.id));
          await engine.flush();
        }
        if (settings.posture !== before.posture) {
          // Logged on the raw change, because it records the choice the user
          // made, whether or not the machine-per-session feature lets it take
          // effect. The panel says "the change is real from the next navigation"
          // rather than letting them conclude the switch did nothing.
          note('info', 'mask', 'posture changed', {
            detail: `${before.posture} to ${settings.posture}`,
          });
          telemetry.postureChanged(settings.posture);
        }
        {
          // The actual work is driven by the effective posture, not the raw
          // setting, and runs through the same transition an entitlement change
          // uses, so a Persona a licence does not cover degrades to Mirror
          // without a broken half-applied state. And every tab is re-answered
          // inside applyPostureChange, because the mask reads its persona
          // material out of the tab at document_start, so what decides the next
          // page is what is sitting in the tab now.
          const beforeEff = effectivePosture(before.posture);
          const afterEff = livePosture();
          if (beforeEff !== afterEff) await applyPostureChange(beforeEff, afterEff);
        }
        reply({ ok: true, settings });
        return;
      }

      /**
       * The Pro licence, section 30. Three commands drive the settings screen:
       * activate a claim key on this device, remove it, and force a refresh. The
       * gate is updated as a side effect of each (via license -> onToken ->
       * entitlement), so every reply carries a fresh entitlement snapshot the
       * popup can render without a second round trip.
       */
      case 'enterLicense': {
        const key = typeof msg.key === 'string' ? msg.key : '';
        const result = await license.activate(key, { transfer: msg.transfer === true });
        reply({ result, ...licenseSnapshot() });
        return;
      }
      case 'removeLicense': {
        await license.remove();
        reply({ ok: true, ...licenseSnapshot() });
        return;
      }
      case 'refreshLicense': {
        await license.refresh();
        reply({ ok: true, ...licenseSnapshot() });
        return;
      }

      /**
       * Cross-device sync, the Pro `sync` feature. Enable stores a passphrase and
       * runs a first sync; sync now runs one on demand; disable forgets the
       * passphrase on this device. Each is refused unless the feature is entitled,
       * so a lapsed licence cannot keep syncing, and the reply carries the fresh
       * sync status the settings screen renders.
       */
      case 'syncEnable': {
        if (!featureOn('sync')) {
          reply({ ok: false, reason: 'disabled', sync: sync.status() });
          return;
        }
        const result = await sync.enable(typeof msg.passphrase === 'string' ? msg.passphrase : '');
        reply({ result, sync: sync.status() });
        return;
      }
      case 'syncNow': {
        if (!featureOn('sync')) {
          reply({ ok: false, reason: 'disabled', sync: sync.status() });
          return;
        }
        const result = await sync.sync();
        reply({ result, sync: sync.status() });
        return;
      }
      case 'syncDisable': {
        await sync.disable();
        reply({ ok: true, sync: sync.status() });
        return;
      }

      case 'regroup':
        reply({ ok: true, groups: await regroup() });
        return;

      /**
       * Re-picking a tab the user is looking at. The chooser normally appears
       * on its own when a navigation is genuinely ambiguous; this is the way to
       * ask for it when it is not, which is most of the time.
       */
      case 'choose': {
        decided.delete(msg.tabId);
        ephemeral.schedule();
        // A deliberate re-pick supersedes whatever was still in flight, and its
        // answer belongs to the tab's current page rather than to some earlier
        // chain the user has since navigated away from.
        pending.delete(msg.tabId);
        let url = registry.binding(msg.tabId)?.url ?? '';
        try {
          url = (await chrome.tabs.get(msg.tabId)).url ?? url;
        } catch {
          /* the tab closed; the stored url is the best that is left */
        }
        if (!hostOf(url)) {
          reply({ ok: false, reason: 'not-a-web-page' });
          return;
        }
        const shown = await maybeOfferChoice(msg.tabId, url, true);
        reply(shown ? { ok: true } : { ok: false, reason: 'no-agent' });
        return;
      }

      case 'adoptScan':
        reply(await scanForAdoption());
        return;

      case 'adopt':
        {
          const out = await adopt(msg);
          rebuildMenus();
          reply(out);
        }
        return;

      /**
       * The journal, for the panel.
       *
       * Newest first here and oldest first in the file, deliberately: a list on
       * screen is read from the top and a log file is read from the top too, but
       * the top of a file is the beginning. Reversing on the way out rather than
       * on the way in keeps one storage order and one meaning of "next".
       */
      case 'journal': {
        const entries = await journal.all();
        reply({
          ok: true,
          entries: entries.slice(-600).reverse(),
          total: entries.length,
          level: settings.logLevel,
        });
        return;
      }

      /**
       * The whole thing as a file.
       *
       * Handed back as text rather than downloaded from here, because a service
       * worker has no way to save a file and asking for the downloads permission
       * to write one text file is a worse trade than letting the page that asked
       * make the blob itself.
       */
      case 'journalFile': {
        await journal.flush();
        const entries = await journal.all();
        reply({
          ok: true,
          text: formatJournal(entries, [
            `build ${chrome.runtime.getManifest().version}`,
            `${entries.length} entries`,
            `level ${settings.logLevel}`,
          ]),
        });
        return;
      }

      case 'openWelcome':
        await openWelcome();
        reply({ ok: true });
        return;

      case 'journalClear':
        await journal.clear();
        note('info', 'life', 'the journal was cleared');
        reply({ ok: true });
        return;

      case 'restoretest':
        reply(
          await runRestoreTest(
            registry,
            engine,
            storage,
            async () => {
              // Re-runs the cold start path in place, which is what a worker
              // restart actually does: reload state, clear whatever rules the
              // previous worker left installed, recompile.
              ready = boot();
              await ready;
              return {
                rules: (await backend.current()).length,
                sessions: registry.listSessions().map((x) => x.id),
              };
            },
            () => backend.current(),
            settings,
            dropProbeSession
          )
        );
        return;

      case 'native':
        if (msg.refresh) native.reset();
        reply(await native.status());
        return;

      case 'painttest':
        reply(await runPaintTest(msg.fixture, armPaintProbe));
        return;

      case 'selftest':
        reply(
          await runSelfTest(
            registry,
            engine,
            desync,
            () => backend.current(),
            msg.fixture,
            leaveUnmanaged
          )
        );
        return;

      case 'chaintest':
        reply(
          await (globalThis as unknown as { __nvx: { chaintest: (f?: string) => unknown } }).__nvx.chaintest(
            typeof msg.fixture === 'string' ? msg.fixture : undefined
          )
        );
        return;

      case 'guardtest':
        reply(
          await runGuardTest(registry, engine, guard, {
            ...(typeof msg.fixture === 'string' ? { fixture: msg.fixture } : {}),
          })
        );
        return;

      case 'storagetest':
        reply(
          await runStorageTest(registry, engine, {
            refresh: async () => {
              // The signature guard would skip a re-register that produced the
              // same match set, and the suite needs the registration to have
              // actually landed before it navigates.
              registeredMatches = null;
              await registerAgent();
            },
            stateOf: (tabId) => storageState.get(tabId),
            leaveUnmanaged,
            ...(typeof msg.fixture === 'string' ? { fixture: msg.fixture } : {}),
          })
        );
        return;

      case 'guard':
        reply({
          catalog: CATALOG.filter((e) => e.severity === 'destructive').map((e) => ({
            id: e.id,
            what: e.what,
            service: e.service,
          })),
          counts: guard.audit.counts(),
          recent: guard.audit.recent(40),
          unlocks: registry.listSessions().flatMap((s) =>
            guard.unlocksFor(s.id).map((u) => ({ sessionId: s.id, ...u }))
          ),
        });
        return;

      case 'setDanger': {
        const session = registry.getSession(msg.sessionId);
        if (!session) {
          reply({ ok: false, reason: 'no such session' });
          return;
        }
        session.danger = cleanDanger(msg.danger);
        guard.markDirty([session.id]);
        await guard.flush();
        persistence.schedule();
        reply({ ok: true, danger: session.danger });
        return;
      }

      /**
       * Whether third parties this session has no cookies for get the browser's
       * own jar. Flushed rather than debounced: the user has just made a
       * decision about what leaves the machine, and the next request should
       * already obey it.
       */
      case 'setThirdParty': {
        const session = registry.getSession(msg.sessionId);
        if (!session) {
          reply({ ok: false, reason: 'no such session' });
          return;
        }
        session.thirdParty = cleanThirdParty(msg.thirdParty);
        engine.markDirty([session.id]);
        await engine.flush();
        persistence.schedule();
        reply({ ok: true, thirdParty: session.thirdParty });
        return;
      }

      /**
       * One third party spared from the block, or put back under it.
       *
       * The block is one switch over a list of very different things. A tracker
       * and an identity provider are both third party, and on a federated site
       * they arrive in the same page load, so the switch as it stood asked
       * somebody to choose between being followed and being able to sign in.
       * Measured on a real Google sign-in: the block took a host the flow
       * depends on and the page went into a redirect loop, which reads as the
       * site being broken rather than as a setting having been chosen.
       *
       * Per party, and only ever from the list of parties actually seen, so the
       * choice is made against evidence rather than from memory.
       */
      case 'allowParty': {
        const session = registry.getSession(msg.sessionId);
        if (!session) {
          reply({ ok: false, reason: 'no such session' });
          return;
        }
        const party = typeof msg.party === 'string' ? domainOf(`https://${msg.party}/`) : '';
        if (!party) {
          reply({ ok: false, reason: 'that is not a domain' });
          return;
        }
        const held = new Set(session.allowedParties ?? []);
        if (msg.allow === false) held.delete(party);
        else held.add(party);
        session.allowedParties = [...held].sort();
        engine.markDirty([session.id]);
        await engine.flush();
        persistence.schedule();
        note('info', 'session', msg.allow === false ? 'a third party is blocked again' : 'a third party is allowed through', {
          session: session.label,
          host: party,
        });
        reply({ ok: true, allowedParties: session.allowedParties });
        return;
      }

      /** Forgets what was seen, without changing whether it is allowed. */
      case 'clearThirdParties': {
        if (typeof msg.sessionId === 'string') thirdPartyLog(msg.sessionId).clear();
        else for (const log of thirdParties.values()) log.clear();
        persistence.schedule();
        reply({ ok: true });
        return;
      }

      /**
       * Letting one endpoint through for a few minutes. This exists because a
       * guardrail with no way past it is a guardrail people turn off entirely,
       * and an allowance that lapses on its own is a far better outcome than a
       * session left permanently unprotected.
       */
      case 'unlock': {
        if (!registry.getSession(msg.sessionId)) {
          reply({ ok: false, reason: 'no such session' });
          return;
        }
        const until = guard.unlock(msg.sessionId, String(msg.rule), UNLOCK_MS);
        await guard.flush();
        reply({ ok: true, until });
        return;
      }

      case 'clearAudit':
        guard.audit.clear();
        persistence.schedule();
        reply({ ok: true });
        return;

      case 'storage':
        reply({
          available: canScopeAgent(),
          tabs: [...storageState.entries()].map(([tabId, s]) => ({ tabId, ...s })),
          forked: registry.listSessions().map((s) => ({ id: s.id, origins: s.forked.length })),
          idb: [...idbSites].sort(),
        });
        return;

      case 'resetDesync':
        desync.reset();
        paintAlarm();
        reply({ ok: true });
        return;

      default:
        reply({ error: 'unknown command' });
    }
  })();
  return true;
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The surface below, reached from inside itself.
 *  How      |  A suite phase that wants a session wants what the driver
 *           |  would do, so it reaches the same entry point rather than a
 *           |  second path into the registry.
 *  Note     |  Lazy, because the object does not exist until the
 *           |  assignment underneath has run.
 * ------------------------------------------------------------------
 */
function nvxSurface(): {
  createSession: (id: string, pinned?: string[]) => Promise<string>;
  bind: (tabId: number, sessionId: string, url: string, windowId?: number) => Promise<unknown>;
} {
  return (
    globalThis as unknown as {
      __nvx: {
        createSession: (id: string, pinned?: string[]) => Promise<string>;
        bind: (tabId: number, sessionId: string, url: string, windowId?: number) => Promise<unknown>;
      };
    }
  ).__nvx;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Diagnostic surface.
 *  How      |  The integration suite drives the kernel through this
 *           |  rather than simulated events, so it exercises the same
 *           |  code a real tab does.
 *  Note     |  It exposes no capability the message API does not already
 *           |  grant, and is only reachable from the worker's own
 *           |  context.
 * ------------------------------------------------------------------
 */
Object.assign(globalThis, {
  __nvx: {
    get registry() {
      return registry;
    },
    get engine() {
      return engine;
    },
    /** Which netfilter is doing the work, for suites that assert on rules. */
    get backendName() {
      return engine instanceof Engine ? 'dnr' : 'blocking';
    },
    desync,
    backend,
    whenReady,
    /**
     * Declares a tab deliberately unmanaged, the same answer as "just this
     * once". A suite arranging a control tab has already made the choice the
     * picker exists to ask about, and being asked would stop the run.
     */
    async unmanaged(tabId: number, url: string) {
      await whenReady();
      leaveUnmanaged(tabId, url);
    },
    /** Navigations currently parked at the picker, for diagnosing a hold. */
    get held() {
      return [...held.entries()].map(([tabId, url]) => ({ tabId, url }));
    },
    /** Where a closed tab's session is remembered, so a reopen can rejoin it. */
    get reopen() {
      return [...recentlyClosed.entries()].map(([origin, queue]) => ({ origin, queue }));
    },
    /**
     * The journal, for the suite that asserts it is wired in at all.
     *
     * Its encoding is unit tested and its wiring was not, and the distinction
     * matters more here than usual: the whole value of a journal is that it
     * records what really happened, so a perfect encoder nothing calls is worth
     * nothing.
     */
    async journal() {
      await whenReady();
      await journal.flush();
      return journal.all();
    },
    async journalFile() {
      await whenReady();
      await journal.flush();
      return formatJournal(await journal.all(), ['suite']);
    },
    async clearJournal() {
      await whenReady();
      await journal.clear();
    },
    /**
     * Rebuilds the content script registration from the current sessions.
     *
     * Every product path that changes the managed host set already calls this;
     * the scale suite needs it directly because it manufactures a profile wider
     * than any sequence of real actions would reach inside one run.
     */
    async registerAgent() {
      await whenReady();
      await registerAgent();
    },
    async setLogLevel(level: Level) {
      await whenReady();
      if (!LEVELS.includes(level)) return;
      settings = { ...settings, logLevel: level };
      await persistence.save();
    },
    async adoptScan() {
      await whenReady();
      return scanForAdoption();
    },
    /** Whether that memory is mirrored somewhere the worker's death cannot reach. */
    get reopenIsMirrored() {
      return ephemeral.live;
    },
    /**
     * Sites this extension has stopped managing, and the last loop that caused
     * one. Read from here rather than through the message API because a worker
     * does not receive its own `sendMessage`, so a suite driving the kernel
     * from inside it cannot ask the way a page does.
     */
    get released() {
      return [...settings.released];
    },
    /** Origins seen using IndexedDB, which nothing here separates. */
    get idbSites() {
      return [...idbSites].sort();
    },
    /**
     * Opens a tab already inside a session, the way the Sign in here button
     * does. On the surface so a suite exercises the real command rather than a
     * copy of its logic.
     */
    async openInSession(sessionId: string, url: string) {
      await whenReady();
      return openInSession(sessionId, url);
    },
    async moveTabs(tabIds: number[], sessionId: string | null) {
      await whenReady();
      return moveTabs(tabIds, sessionId);
    },
    get loop() {
      return loopReport;
    },
    async releaseSite(domain: string, release = true) {
      await whenReady();
      if (release) await releaseSite(domain, 'released by a suite');
      else {
        await unreleaseSite(domain);
        if (loopReport?.domain === domain) loopReport = null;
      }
      return [...settings.released];
    },
    /**
     * Empties the worker's copy of everything session scoped, without touching
     * the mirror, and puts back only what the mirror holds.
     *
     * This is what a manifest v3 eviction does, and a suite cannot otherwise
     * cause one from inside the worker it would be killing. Used to assert that
     * a closed tab is still reopenable across a restart; the browser level
     * version of the same check kills the worker over the debugger, which is
     * stronger and lives in `e2e.mjs`.
     */
    async recycleWorkerMemory() {
      await whenReady();
      await ephemeral.save();
      recentlyClosed.clear();
      decided.clear();
      unmaskedTabs.clear();
      const restored = await ephemeral.load();
      for (const [origin, queue] of restored.reopen) recentlyClosed.set(origin, queue);
      for (const [tabId, domains] of restored.decided) decided.set(tabId, domains);
      for (const tabId of restored.unmasked) unmaskedTabs.add(tabId);
      return { origins: recentlyClosed.size, tabs: decided.size, unmasked: unmaskedTabs.size };
    },
    async createSession(id: string, pinned: string[] = []) {
      await whenReady();
      registry.createSession({
        id,
        label: id,
        color: nextColor(),
        pinned,
        store: new CookieStore(),
        family: [],
        forked: [],
        danger: DEFAULT_DANGER,
        thirdParty: DEFAULT_THIRD_PARTY,
        createdAt: Date.now(),
        lastSeen: Date.now(),
      });
      persistence.schedule();
      return id;
    },
    /**
     * Records a third party sighting directly, for populating the list in a
     * screenshot or a suite. The real path needs a page that embeds a tracker,
     * which is not something to stand up for the sake of photographing a row.
     */
    note(sessionId: string, party: string, via: string, blocked = true) {
      thirdPartyLog(sessionId).note(party, via, blocked, Date.now());
      persistence.schedule();
    },
    async bind(tabId: number, sessionId: string, url: string, windowId = -1) {
      await whenReady();
      const m = registry.bind(tabId, sessionId, { windowId, url, origin: 'manual' });
      // Recorded here as well as in the message handler, because a suite that
      // binds through this path and asserts on the journal would otherwise be
      // testing a code path the product does not use.
      noteBinding(tabId, sessionId, 'moved by hand', url);
      engine.markDirty(m.dirty);
      await engine.flush();
      return m;
    },
    seed: seedCookie,
    async rules() {
      return backend.current();
    },
    /**
     * Exposed here rather than driven through runtime.sendMessage, because a
     * message sent from the worker is not delivered to the worker's own
     * listener, so the harness would wait forever for a reply that cannot come.
     */
    async scan() {
      await whenReady();
      return scanForAdoption();
    },
    async adopt(domains: string[], opts: Record<string, unknown> = {}) {
      await whenReady();
      return adopt({ domains, ...opts });
    },
    native,
    async painttest(fixture?: string) {
      await whenReady();
      return runPaintTest(fixture, armPaintProbe);
    },
    guard,
    exactTrace: () => exact?.recent() ?? [],
    async chaintest(fixture?: string) {
      await whenReady();
      return runChainTest(registry, engine, {
        setExact: async (on: boolean) => {
          settings = { ...settings, exact: on };
          if (!on) await exact?.releaseAll();
          syncExact();
          // Attaching is asynchronous and the navigation that follows is not
          // going to wait for it, so the suite does.
          await new Promise((r) => setTimeout(r, 700));
        },
        available: () => exact !== null,
        liveFor: (tabId: number) => exact?.isLive(tabId) ?? false,
        seed: seedCookie,
        ...(fixture ? { fixture } : {}),
      });
    },
    async masktest(fixture?: string) {
      await whenReady();
      return runMaskTest({
        setPosture: async (posture) => {
          settings = { ...settings, posture };
          // Keep the transition baseline in step with what this just registered,
          // so a later entitlement change does not measure from a stale posture.
          lastLivePosture = livePosture();
          await persistence.save();
          await registerAgent();
          // The same re-answer the settings handler makes, for the same reason:
          // what the next document reads is what is in the tab now.
          for (const tabId of agents.keys()) pushStorage(tabId);
          // A registered content script only reaches documents created after it
          // lands, and the suite navigates immediately afterwards. Without this
          // the first measurement is taken through the previous posture.
          await new Promise((r) => setTimeout(r, 600));
        },
        posture: () => livePosture(),
        /**
         * A domain that refuses the mask's worker stays refused for the life of
         * the worker, which is right in a browser and wrong in a suite: the
         * fixture origin is deliberately made to refuse partway through, and
         * every later run would then measure an origin the posture had already
         * been withdrawn from.
         */
        degraded: () => [...degraded],
        /**
         * Sessions, for the Persona phase, which is the first one that needs a
         * tab to be in one. Built from the same helpers the diagnostic surface
         * exposes rather than from a second path into the registry.
         */
        createSession: async (id, pinned) => {
          await nvxSurface().createSession(id, pinned);
        },
        bindTab: async (tabId, sessionId, url) => {
          await nvxSurface().bind(tabId, sessionId, url);
          // The shim only learns a new session when it is told, and a manual
          // bind does not reload the tab it is binding.
          pushStorage(tabId);
        },
        dropSession: async (id) => {
          registry.deleteSession(id);
          await engine.retire(id);
        },
        clearDegraded: async () => {
          if (!degraded.size) return;
          degraded.clear();
          await registerAgent();
        },
        // The compiler's answer rather than a string typed into a test twice,
        // so what is being asserted is that the page shows what the compiler
        // decided. The card is not in here: it is chosen by the machine's GPU
        // vendor, which a service worker cannot read, so the suite works it out
        // from what it measures under Mirror.
        os: realMachine().os,
        expect: (() => {
          const p = standardFor(realMachine());
          return {
            userAgent: p.userAgent,
            brands: p.brands ?? [],
            cores: p.cores,
            memory: p.memory,
          };
        })(),
        ...(fixture ? { fixture } : {}),
      });
    },
    async guardtest(fixture?: string) {
      await whenReady();
      return runGuardTest(registry, engine, guard, { ...(fixture ? { fixture } : {}) });
    },
    async storagetest(fixture?: string) {
      await whenReady();
      return runStorageTest(registry, engine, {
        refresh: async () => {
          registeredMatches = null;
          await registerAgent();
        },
        stateOf: (tabId: number) => storageState.get(tabId),
        leaveUnmanaged,
        ...(fixture ? { fixture } : {}),
      });
    },
    storageState() {
      return [...storageState.entries()].map(([tabId, s]) => ({ tabId, ...s }));
    },
    async restoretest() {
      await whenReady();
      return runRestoreTest(
        registry,
        engine,
        storage,
        async () => {
          ready = boot();
          await ready;
          return {
            rules: (await backend.current()).length,
            sessions: registry.listSessions().map((x) => x.id),
          };
        },
        () => backend.current(),
        settings,
        dropProbeSession
      );
    },
  },
});

void whenReady();
