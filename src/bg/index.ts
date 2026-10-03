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
import { BUILD } from '../build-config.js';
import { mintStamp } from '../kernel/stamp.js';
import { TrustedClock } from '../kernel/clock.js';
import { openPack, type PackData, type PackPorts } from '../kernel/pack.js';
import { requestStripHeaders, responseStripHeaders, setPackExtras } from '../netfilter/compile.js';
import { buildReport, cleanInput, diagnostics, reportText, type ReportFacts } from './report.js';
import {
  DEFAULT_SETTINGS,
  Persistence,
  reconcile,
  type Orphan,
  type Settings,
} from '../kernel/persist.js';
import { Ephemeral, type EphemeralArea } from '../kernel/ephemeral.js';
import { Telemetry, uuidV4, type DailyCounter, type TelemetryChannel, type TelemetryError } from '../kernel/telemetry.js';
import { Entitlement, FEATURES, type Feature } from '../kernel/entitlement.js';
// License and Sync come through the Pro gate: the committed default is an inert
// free stub, and a Pro build swaps in the real classes from the private
// submodule. Their types are the shared, public ones in pro-types.js.
import { License, Sync } from '../kernel/pro.js';
import type { SyncConfig, SyncSession } from '../kernel/pro-types.js';
import { Journal, LEVELS, formatJournal, type Area, type Level } from '../kernel/journal.js';
import { ANON_SESSION_ID, Registry, domainOf, originOf, type Session, type SessionId } from '../kernel/registry.js';
import { browserDnrApi, DnrBackend } from '../netfilter/dnr.js';
import { captureSetCookie, contextFor } from '../observer/capture.js';
import { compare, DesyncLog } from '../observer/desync.js';
import { ThirdPartyLog } from '../observer/thirdparty.js';
import { emit } from '../jar/emit.js';
// Static only. Dynamic import() is disallowed in a ServiceWorkerGlobalScope by
// the HTML specification, so lazy loading a module here fails at runtime with
// no build-time warning.
import { CookieStore } from '../jar/store.js';
import { cookieKey, parseSetCookie, type Cookie } from '../jar/cookie.js';
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
import { HUES, MAX_ICON_CANDIDATES, rankIcons, type IconCandidate } from '../paint/badge.js';
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
import { IDENTITY_PROVIDERS, RULE_ID_BASE, RULES_PER_SESSION } from '../netfilter/compile.js';
import { blockingIsReal, BlockingNetfilter, browserBlockingApi, type Owner, extraHeaders } from '../netfilter/blocking.js';
import type { Netfilter } from '../netfilter/types.js';
import { browserDebuggerApi, ExactInterceptor } from '../netfilter/exact.js';
import { actionApi, badgeApi, canScopeAgent, initiatorOf, injectAgent, portableScripts } from '../platform.js';
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
 *  Purpose  |  Which audience an install belongs to: the store, or a
 *           |  developer's unpacked build.
 *  How      |  The dev tier says so at build time. An unpacked load of
 *           |  any tier says so through management.getSelf, which needs
 *           |  no permission. Sent as a tag, so dev rows can be filtered
 *           |  out rather than lost.
 * ------------------------------------------------------------------
 */
let telemetryChannel: TelemetryChannel = BUILD.tier === 'dev' ? 'dev' : 'store';
try {
  const mgmt = (chrome as { management?: { getSelf?: () => Promise<{ installType?: string }> } }).management;
  void mgmt
    ?.getSelf?.()
    ?.then((self) => {
      if (self?.installType === 'development') telemetryChannel = 'dev';
    })
    .catch(() => undefined);
} catch {
  /* absent on this platform; the build tier stands */
}

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
      const url = BUILD.telemetryEndpoint;
      return typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
    },
    consented: () => settings.telemetry,
    post: async (url, body) => {
      const stamp = await telemetryStamp(body);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(stamp ? { 'x-nvx-stamp': stamp } : {}) },
        body,
        keepalive: true,
      });
      return res.status;
    },
    now: () => Date.now(),
    // Always a UUID v4, which is the only id shape the server accepts.
    newId: () => (typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : uuidV4()),
    channel: () => telemetryChannel,
  },
  {
    version: chrome.runtime.getManifest().version,
    mv: chrome.runtime.getManifest().manifest_version === 2 ? 2 : 3,
  }
);

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Today's work stamp for this install's telemetry.
 *  How      |  Minted once per install per UTC day and kept in memory
 *           |  and session storage, so a worker restart does not pay
 *           |  for it again. See kernel/stamp.ts for why.
 * ------------------------------------------------------------------
 */
let stampHeld: { key: string; stamp: string } | null = null;
let stampMinting: Promise<string | null> | null = null;
async function telemetryStamp(body: string): Promise<string | null> {
  let id = '';
  try {
    id = String((JSON.parse(body) as { batch?: { id?: unknown }[] }).batch?.[0]?.id ?? '');
  } catch {
    return null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${id}/${day}`;
  if (stampHeld?.key === key) return stampHeld.stamp;
  const got: Record<string, unknown> = (await sessionArea?.get('nvx.stamp').catch(() => null)) ?? {};
  const saved = got['nvx.stamp'] as { key: string; stamp: string } | undefined;
  if (saved?.key === key) {
    stampHeld = saved;
    return saved.stamp;
  }
  stampMinting ??= mintStamp('telemetry', id, Date.now()).finally(() => (stampMinting = null));
  const stamp = await stampMinting;
  if (stamp) {
    stampHeld = { key, stamp };
    await sessionArea?.set({ 'nvx.stamp': stampHeld }).catch(() => undefined);
  }
  return stamp;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Count what escaped every handler.
 *  Note     |  Only where it was caught and the error's constructor
 *           |  name go out, once a day each; the message and stack can
 *           |  carry a URL, so neither is read.
 * ------------------------------------------------------------------
 */
try {
  self.addEventListener('error', (e: ErrorEvent) => telemetry.exception('uncaught', e?.error));
  self.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) =>
    telemetry.exception('rejection', e?.reason)
  );
} catch {
  /* no global to listen on */
}

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
  return BUILD.tier === 'pro' ? 'pro' : 'free';
}
function manifestLicense(): { endpoint?: unknown; keys?: unknown } {
  return BUILD.license ?? {};
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

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A hint that two browsers are on the same computer, so a
 *           |  licence counts them as one device.
 *  How      |  Coarse traits every Chromium browser on a machine shares
 *           |  (OS and version, CPU architecture and cores, memory
 *           |  class, GPU, time zone), hashed together with the licence
 *           |  key. The key in the hash makes it a different value for
 *           |  every licence, so it cannot follow anybody anywhere.
 *  Why      |  An extension cannot read a hardware id, and that is a
 *           |  good thing. Nothing here is a lock: the server only ever
 *           |  uses a matching hint to be generous (one seat instead of
 *           |  two), never to refuse, so a spoofed or changed hint costs
 *           |  at most a seat and gains at most what the server caps.
 * ------------------------------------------------------------------
 */
async function machineHint(key: string): Promise<string | null> {
  const nav = globalThis.navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { getHighEntropyValues?: (h: string[]) => Promise<Record<string, unknown>> };
  };
  const hi = await nav.userAgentData
    ?.getHighEntropyValues?.(['platform', 'platformVersion', 'architecture', 'bitness'])
    .catch(() => null);
  if (!hi) return null;
  let gpu = '';
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl') as WebGLRenderingContext | null;
    gpu = String(gl?.getParameter(gl.RENDERER) ?? '');
  } catch {
    /* no WebGL in this worker: the hint is just coarser */
  }
  const traits = [
    hi.platform,
    // Major version only: a point update to the OS should not split a machine.
    String(hi.platformVersion ?? '').split('.')[0],
    hi.architecture,
    hi.bitness,
    nav.hardwareConcurrency ?? '',
    nav.deviceMemory ?? '',
    gpu.replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/,\s*D3D\d+.*$/i, ''),
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
  ].join('|');
  const canon = key.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`nvx-machine-v1|${canon}|${traits}`))
  );
  let b64 = '';
  for (const b of bytes) b64 += String.fromCharCode(b);
  return btoa(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}

// eslint-disable-next-line prefer-const -- assigned just below; entitlement's
// deviceId port reads it, so it has to be referenceable before license exists.
let license: License;
/** The licence signing keys this build trusts, for tokens and site packs alike. */
const LICENSE_KIDS: Record<string, string> = (() => {
  const raw = manifestLicense().keys;
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [kid, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[kid] = v;
    }
  }
  return out;
})();
async function verifySigned(pub: Uint8Array, sig: Uint8Array, data: Uint8Array): Promise<boolean> {
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
}
/** Licence expiry and packs are measured on this, so setting the date back does nothing. */
const clock = new TrustedClock(storage);
const entitlement = new Entitlement({
  buildTier,
  deviceId: () => (license ? license.deviceId() : null),
  kids: LICENSE_KIDS,
  verify: verifySigned,
  now: () => clock.now(),
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
    // Our own server's time, over https: the floor the trusted clock keeps.
    clock.observe(Date.parse(res.headers.get('date') ?? ''));
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  },
  deviceLabel: () => deviceLabelText(),
  machineHint: (key) => machineHint(key),
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
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Hold, apply and refresh the Pro site pack.
 *  How      |  Stored as the signed token and re-verified on every
 *           |  apply, so a pack edited on disk is simply ignored.
 *           |  Applied only while the licence unlocks Pro; a lapse
 *           |  clears it back to the built-in knowledge. A pack with a
 *           |  lower sequence than the one held is refused, so an old
 *           |  pack cannot be replayed over a newer one.
 * ------------------------------------------------------------------
 */
const PACK_KEY = 'nvx.pack';
const PACK_DAY_KEY = 'nvx.pack.day';
const NO_PACK: PackData = { idps: [], responseHeaders: [], requestHeaders: [] };
const packPorts: PackPorts = {
  kids: LICENSE_KIDS,
  verify: verifySigned,
  deviceId: () => (license ? license.deviceId() : null),
  now: () => clock.now(),
};
let packApplied = JSON.stringify(NO_PACK);
let packSeq = 0;
async function applyStoredPack(): Promise<void> {
  const held: Record<string, unknown> = await storage.get([PACK_KEY]).catch(() => ({}));
  const token = held[PACK_KEY];
  const opened = entitlement.isPro() && typeof token === 'string' ? await openPack(token, packPorts) : null;
  const data = opened?.ok ? opened.claims.data : NO_PACK;
  if (opened?.ok) packSeq = Math.max(packSeq, opened.claims.seq);
  const key = JSON.stringify(data);
  if (key === packApplied) return;
  packApplied = key;
  setPackExtras(data);
  note('info', 'life', opened?.ok ? 'a site pack is in use' : 'the site pack was cleared', {
    detail: opened?.ok ? `pack ${opened.claims.seq}, ${data.idps.length} extra providers` : opened?.reason ?? 'not Pro',
  });
  engine.markDirty(registry.listSessions().map((x) => x.id));
  await engine.flush();
}
async function maybeFetchPack(): Promise<void> {
  if (!entitlement.isPro() || !licensePossible()) return;
  const day = new Date(clock.now()).toISOString().slice(0, 10);
  const held: Record<string, unknown> = await storage.get([PACK_DAY_KEY]).catch(() => ({}));
  if (held[PACK_DAY_KEY] === day) return;
  const token = await license.pack();
  if (!token) return;
  const opened = await openPack(token, packPorts);
  if (!opened.ok) {
    note('warn', 'life', 'a site pack was refused', { detail: opened.reason });
    return;
  }
  await storage.set({ [PACK_DAY_KEY]: day });
  if (opened.claims.seq < packSeq) return;
  await storage.set({ [PACK_KEY]: token });
  await applyStoredPack();
}

function applyEntitlements(): void {
  void applyStoredPack();
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
  return BUILD.tier === 'dev';
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
/** The hour stamp for the tighter check used near a billing boundary or after a lapse. */
const LICENSE_REFRESH_HOUR_KEY = 'nvx.license.refreshedHour';

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
    // A token that ran out while the worker stayed up stops here, not at the
    // next restart.
    await entitlement.recheck();
    if (clock.rolledBack()) {
      note('warn', 'life', 'the system clock is behind the last time NVX saw', {
        detail: 'licence expiry is measured from the later time',
      });
    }
    void maybeFetchPack();
    const now = clock.now();
    const d = entitlement.current();
    const exp = d.claims ? d.claims.exp * 1000 : 0;
    // Near a billing boundary, or already lapsed, check hourly instead of daily,
    // so a renewal that lands is picked up within the hour rather than tomorrow.
    const urgent =
      license.status().lapse !== null ||
      d.reason === 'expired' ||
      (exp > 0 && exp - now < 3 * 86_400_000);
    const key = urgent ? LICENSE_REFRESH_HOUR_KEY : LICENSE_REFRESH_KEY;
    const stamp = new Date(now).toISOString().slice(0, urgent ? 13 : 10);
    const held = await storage.get([key]);
    if (held[key] === stamp) return;
    // Stamped only once the server actually answered, so an offline morning or
    // a host error page does not use up the check.
    if (await license.refresh()) await storage.set({ [key]: stamp });
  } catch {
    /* a missed refresh is harmless; the held token stands until its exp */
  }
}

/** The Pro tier snapshot the popup renders, shared by `state` and the licence commands. */
function licenseSnapshot(): {
  tier: ReturnType<Entitlement['tier']>;
  entitlements: Feature[];
  version: string;
  buildTier: string;
  license: {
    present: boolean;
    device: string | null;
    lapse: string | null;
    possible: boolean;
    deviceLabel: string;
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
    version: chrome.runtime.getManifest().version,
    buildTier: BUILD.tier,
    license: {
      present: license.status().present,
      device: license.status().device,
      lapse: license.status().lapse,
      possible: licensePossible(),
      deviceLabel: deviceLabelText(),
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
        forked: [FORK_NEVER],
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
 *  Purpose  |  Write the install clock if it is missing.
 *  Note     |  The one telemetry key written without consent: a bare
 *           |  local timestamp, never sent itself, so the days-since-
 *           |  install cohort counts from install rather than opt-in.
 * ------------------------------------------------------------------
 */
async function ensureInstalledAt(): Promise<void> {
  try {
    const held = await storage.get([INSTALLED_AT_KEY]);
    if (typeof held[INSTALLED_AT_KEY] !== 'number') await storage.set({ [INSTALLED_AT_KEY]: Date.now() });
  } catch {
    /* the beat falls back to now */
  }
}
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
/** The pre-v3 anomaly day stamp. No longer written; still erased on opt-out. */
const ANOMALY_KEY = 'nvx.telemetry.anomaly';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Send an isolation signal or fault.
 *  Note     |  Deduped to once per install per day inside the
 *           |  telemetry module, which keeps the day marker with the
 *           |  rest of the daily rollup. A no-op while telemetry is off.
 * ------------------------------------------------------------------
 */
function anomaly(category: TelemetryError): void {
  telemetry.error(category);
}

/** Bump a daily counter. A no-op while telemetry is off. */
function tally(key: DailyCounter, n = 1): void {
  telemetry.count(key, n);
}

/** The most rules any session compiled to, or zero on the blocking backend. */
function engineRules(): number {
  return engine instanceof Engine ? engine.maxSessionRules : 0;
}

/** Sessions, managed tabs, burners and the busiest session right now: raw, bucketed by the beat. */
function usageNow(): { sessions: number; tabs: number; burners: number; maxTabs: number } {
  const sessions = registry.listSessions().filter((s) => s.id !== ANON);
  const counts = sessions.map((s) => registry.tabsFor(s.id).length);
  const tabs = counts.reduce((n, c) => n + c, 0);
  const burners = sessions.filter((s) => s.ephemeral).length;
  return { sessions: sessions.length, tabs, burners, maxTabs: Math.max(0, ...counts) };
}
type UsagePeak = { sessions?: number; tabs?: number; burners?: number; maxTabs?: number; rules?: number };

/** Fold a reading into a stored peak, field by field. */
function peakOf(prev: UsagePeak, now: ReturnType<typeof usageNow>, rules: number): Required<UsagePeak> {
  return {
    sessions: Math.max(now.sessions, Number(prev.sessions) || 0),
    tabs: Math.max(now.tabs, Number(prev.tabs) || 0),
    burners: Math.max(now.burners, Number(prev.burners) || 0),
    maxTabs: Math.max(now.maxTabs, Number(prev.maxTabs) || 0),
    rules: Math.max(rules, Number(prev.rules) || 0),
  };
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
      const held = await storage.get([USAGE_PEAK_KEY]);
      const prev = (held[USAGE_PEAK_KEY] as UsagePeak | undefined) ?? {};
      const next = peakOf(prev, usageNow(), engineRules());
      if ((Object.keys(next) as (keyof UsagePeak)[]).some((k) => next[k] !== prev[k])) {
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
    const rules = engineRules();
    const peak = peakOf((held[USAGE_PEAK_KEY] as UsagePeak | undefined) ?? {}, now, rules);
    await storage.set({
      [LAST_ACTIVE_KEY]: today,
      [INSTALLED_AT_KEY]: installedAt,
      [USAGE_PEAK_KEY]: peakOf({}, now, rules),
    });
    await ensureEnv();
    telemetry.active({
      sessions: peak.sessions,
      tabs: peak.tabs,
      sinceInstallDays: (Date.now() - installedAt) / 86_400_000,
      burners: peak.burners,
      maxSessionTabs: peak.maxTabs,
      maxSessionRules: peak.rules,
      tier: entitlement.tier() === 'free' ? 'free' : 'pro',
      posture: settings.posture,
      askNewSites: settings.askNewSites === true,
      quiet: settings.quiet.length,
    });
    // The beat is also when the day's queue goes out, since there is no alarm.
    void telemetry.flush();
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
      anomaly('rule_overflow');
      tally('overflow_events');
      tally('overflow_hosts', domains.length);
      // Which sign-in providers lost their rule, mapped onto the fixed list
      // inside telemetry; every other dropped host is counted as one "other".
      const idps = new Set(domains.map((d) => registrableDomain(d)).filter((d) => IDENTITY_PROVIDERS.has(d)));
      for (const d of idps) telemetry.idpIssue(d, 'overflow');
      if (domains.some((d) => !IDENTITY_PROVIDERS.has(registrableDomain(d)))) telemetry.idpIssue('', 'overflow');
    },
    onFlushed: (ms, ok) => {
      telemetry.timing('flush', ms);
      if (!ok) anomaly('flush_failed');
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
        anomaly('apply_failed');
        tally('apply_failed');
      }
      if (r.dropped.length) {
        note('error', 'rules', 'rules dropped past the browser ceiling', {
          session: r.sessions.join(', '),
          detail: `${r.dropped.length} of ${r.dropped.length + r.added} did not fit, so those hosts are not isolated`,
        });
        anomaly('apply_failed');
        tally('apply_failed');
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
  // Worker traffic is nobody's: a managed page is refused a worker, so a
  // request with no tab comes from an unmanaged tab's worker or the browser
  // itself, and giving it a session's jar leaked that session to the profile.
  const binding = registry.binding(details.tabId);
  const session = binding ? registry.getSession(binding.sessionId) : undefined;
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
    stripRequest: () => requestStripHeaders(),
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
function makeExact() {
  const exactApi = browserDebuggerApi();
  return exactApi && !blockingIsReal()
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
}
let exact = makeExact();
// The Pro build asks for the debugger permission only when a feature needs it,
// so the interceptor can only exist once that is granted.
chrome.permissions?.onAdded?.addListener((p) => {
  if (!exact && p.permissions?.includes('debugger')) {
    exact = makeExact();
    syncExact();
  }
});

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
    forked: [FORK_NEVER],
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
  // A hop NVX asked for again is not the site looping. Counting replays tripped
  // the detector on an Okta sign-in that was recovering, and it released Okta
  // for every session.
  // A browser that gave up while NVX was retrying gave up on NVX's retries,
  // not on the site, so that is not a reason to release it either.
  if (now < (recovering.get(tabId) ?? 0)) {
    if (definite) {
      hopReplays.set(tabId, Array.from({ length: 4 }, () => now));
      chainReplays.set(tabId, Array.from({ length: 3 }, () => now));
      hopPending.delete(tabId);
      recarryDue.delete(tabId);
      note('warn', 'session', 'a sign-in kept bouncing, so NVX stopped retrying it', { tabId, host: domain });
      tally('loop_suppressed');
      telemetry.idpIssue(domain, 'replay_exhausted');
    }
    return;
  }
  const recent = (hops.get(tabId) ?? []).filter(([, at]) => now - at < LOOP_WINDOW_MS);
  recent.push([domain, now]);
  hops.set(tabId, recent);

  const here = recent.filter(([d]) => d === domain).length;
  if (!definite && here < LOOP_HOPS) return;

  hops.delete(tabId);
  const session = registry.getSession(binding.sessionId);

  /**
   * Never a sign-in provider. Releasing one is profile wide: every session's
   * sign-in there falls back to the browser's own cookies, so two accounts end
   * up sharing one provider session, which is the exact thing NVX exists to
   * prevent. The tab stops being retried instead, and is told why.
   */
  if (IDENTITY_PROVIDERS.has(domain)) {
    hopReplays.set(tabId, Array.from({ length: 4 }, () => now));
    chainReplays.set(tabId, Array.from({ length: 3 }, () => now));
    hopPending.delete(tabId);
    recarryDue.delete(tabId);
    note('warn', 'session', 'a sign-in kept bouncing, so NVX stopped retrying it', {
      session: session?.label ?? binding.sessionId,
      tabId,
      host: domain,
      detail: `${here} navigations in ${LOOP_WINDOW_MS / 1000} seconds; the site stays managed because it signs people in`,
    });
    noteInTab(tabId, 'This sign-in kept bouncing. NVX stopped retrying', '#c4614a', domain);
    tally('loop_idp_stopped');
    telemetry.idpIssue(domain, 'loop_stopped');
    return;
  }

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
  anomaly('signin_loop');
  tally('loop_released');

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

  // The browser's own new-tab page is never a site to ask about, even where it
  // is served from the web (Edge loads ntp.msn.com, Chrome with a third-party
  // search engine a google.com page). Asking held every new tab at the picker.
  if (NEW_TAB_PAGES.test(url)) return;
  const domain = domainOf(url);
  if (!domain) return;
  // Released is permanent and profile wide, so it is checked before anything
  // that could claim the tab, including the reopen memory.
  if (isReleased(domain)) return;
  if (decided.get(tabId)?.has(domain)) return;
  // Read now, before anything below waits: a fast page commits during those
  // waits, and a site recorded as visited by its own navigation was never
  // asked about.
  const seenBefore = visitedSites.get(tabId)?.has(domain) ?? false;
  const lastOn = lastSite.get(tabId);

  // A tab opened from another is that tab's business, and that answer comes
  // before any other. The created event usually binds it first, but it waits
  // on the worker like everything else, and a navigation that got here first
  // fell through to the reopen memory or the picker: a popup sign-in parked at
  // the picker, and a link from one session opened in the other because a tab
  // of the other on that site had just been closed.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const typed = await typedNavigation(tabId, url);
  if (registry.binding(tabId) || held.has(tabId)) return;
  // Chrome also gives a tab opened with Ctrl+T or the new-tab button the tab
  // that was active as its opener, so closing it goes back there. That tab did
  // not open anything. Only a navigation a page started (a link, a redirect,
  // window.open, "open link in new tab") takes its opener's session; one the
  // user started from the address bar, a bookmark or the new-tab page does not.
  const source =
    navigationSource.get(tabId) ?? (typed === true || newTabPage(tab) ? undefined : tab?.openerTabId);
  const openerSession = typeof source === 'number' ? registry.binding(source)?.sessionId : undefined;
  if (openerSession && openerSession !== ANON) {
    touched(
      registry.bind(tabId, openerSession, {
        windowId: windowId ?? chrome.windows.WINDOW_ID_NONE,
        url,
        origin: 'opener',
      }),
      true
    );
    noteBinding(tabId, openerSession, 'opened from a tab already in this session', url);
    return;
  }

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
    // A site nobody has decided about yet, opened from a fresh tab: asked before
    // it loads, which is the only moment the answer can still matter. Not a link
    // followed inside a page, which would ask on every click, and not a tab that
    // came from another one, which already has its answer in its opener.
    // Opera hides search-results pages, and every request they start, from
    // extensions (unless the user allows it), so a result clicked there shows
    // no request at all. Its navigation is still reported, so the page the tab
    // was last on stands in for the initiator.
    const fromSearch = typed === null && !!lastOn && CHOOSING_PAGES.test(lastOn) && lastOn !== domain;
    const userChose =
      typed === true || fromSearch
        ? !seenBefore && Date.now() - startedAt > 10_000
        : typed === null && freshTab(tab, tabId);
    if (settings.askNewSites && !settings.quiet.includes(domain) && userChose) {
      note('info', 'tab', 'asked about a new site', { tabId, url });
      tally('picker_shown_new');
      await holdForChoice(tabId, url);
      return;
    }
    note('debug', 'tab', 'left unmanaged, no session covers it', { tabId, url });
    return;
  }
  note('info', 'tab', 'held at the picker, more than one session covers it', { tabId, url });
  tally('picker_shown_multi');
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

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Whether a navigation starts from a fresh tab.
 *  How      |  The tab still shows what it had before the navigation:
 *           |  the new-tab page, a blank page or nothing at all is a
 *           |  fresh tab; a site is a page the user was already on.
 *           |  A tab opened by another one is never fresh, since its
 *           |  opener decides.
 * ------------------------------------------------------------------
 */
const FRESH_PAGES = /^(?:$|about:blank|chrome:\/\/(?:newtab|new-tab-page)|chrome-search:\/\/|edge:\/\/newtab|opera:\/\/startpage|brave:\/\/newtab|vivaldi:\/\/newtab)/i;
const NEW_TAB_PAGES =
  /^(?:chrome:\/\/(?:newtab|new-tab-page)|chrome-search:\/\/|edge:\/\/newtab|opera:\/\/startpage|brave:\/\/newtab|vivaldi:\/\/newtab|https:\/\/www\.google\.[a-z.]+\/_\/chrome\/newtab|https:\/\/ntp\.msn\.(?:com|cn)\/edge\/ntp|about:(?:newtab|home))/i;
function newTabPage(tab: chrome.tabs.Tab | null): boolean {
  return !!tab && NEW_TAB_PAGES.test(tab.url ?? '');
}
function freshTab(tab: chrome.tabs.Tab | null, tabId: number): boolean {
  if (!tab) return false;
  if (navigationSource.has(tabId)) return false;
  // Ctrl+T sets an opener too (see routeUnboundTab), so the new-tab page wins
  // over it. A blank tab with an opener is a window.open not yet reported by
  // onCreatedNavigationTarget, and belongs to its opener.
  if (newTabPage(tab)) return true;
  if (typeof tab.openerTabId === 'number') return false;
  return FRESH_PAGES.test(tab.url ?? '');
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Whether the user started this navigation themselves.
 *  How      |  The request for a top-level page carries an initiator
 *           |  when a page started it (a link, a form, a redirect,
 *           |  script, a link opened in a new tab) and none when the
 *           |  browser did: the address bar, a bookmark, a new-tab-page
 *           |  tile. That is recorded by onBeforeRequest, which fires a
 *           |  moment after onBeforeNavigate, so this waits briefly for
 *           |  it. True: the user's own. False: a page's. Null: no
 *           |  request was seen in time, and the caller falls back to
 *           |  what the tab was showing.
 *  Why      |  The tab's own url and opener are not reliable for this:
 *           |  Ctrl+T gives a tab an opener, and the reported url can
 *           |  already be the destination by the time it is read.
 * ------------------------------------------------------------------
 */
const navStarts = new Map<number, { url: string; user: boolean; at: number }>();
/**
 * Where people choose a site rather than land on one: search engines and
 * answer engines. A result clicked there is the user picking a destination,
 * exactly like typing it, so it is asked about; a link inside an ordinary page
 * is that page's business and is not.
 */
const CHOOSING_PAGES =
  /^(?:google\.[a-z.]{2,12}|bing\.com|duckduckgo\.com|yahoo\.(?:com|co\.jp)|search\.yahoo\.com|baidu\.com|yandex\.[a-z.]{2,8}|ya\.ru|ecosia\.org|brave\.com|startpage\.com|qwant\.com|kagi\.com|naver\.com|daum\.net|seznam\.cz|sogou\.com|so\.com|perplexity\.ai|chatgpt\.com|you\.com|presearch\.com|mojeek\.com)$/;
function fromChoosingPage(initiator: string | undefined, url: string): boolean {
  if (!initiator) return false;
  const from = domainOf(initiator);
  return !!from && CHOOSING_PAGES.test(from) && from !== domainOf(url);
}
/** Sites each tab has shown, so a reload or Back to one is not a new site. */
const visitedSites = new Map<number, Set<string>>();
/** The site each tab last committed, for the Opera search-page fallback above. */
const lastSite = new Map<number, string>();
/** When the browser started, so restored tabs loading at launch are not asked about. */
let startedAt = 0;
const BROWSER_INITIATORS = /^(?:chrome|chrome-search|chrome-untrusted|edge|brave|opera|vivaldi):/i;
const sameDoc = (a: string, b: string) => a.split('#')[0] === b.split('#')[0];
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return undefined;
    // Firefox reports originUrl, not initiator; initiatorOf reads either.
    const initiator = initiatorOf(d as { initiator?: string; originUrl?: string });
    navStarts.set(d.tabId, {
      url: d.url,
      user: !initiator || BROWSER_INITIATORS.test(initiator) || fromChoosingPage(initiator, d.url),
      at: Date.now(),
    });
    return undefined;
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }
);
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0 || !/^https?:/i.test(d.url)) return;
  const domain = domainOf(d.url);
  if (!domain) return;
  const seen = visitedSites.get(d.tabId) ?? new Set<string>();
  seen.add(domain);
  visitedSites.set(d.tabId, seen);
  lastSite.set(d.tabId, domain);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  navStarts.delete(tabId);
  visitedSites.delete(tabId);
  lastSite.delete(tabId);
});
async function typedNavigation(tabId: number, url: string): Promise<boolean | null> {
  for (let i = 0; i < 12; i++) {
    const n = navStarts.get(tabId);
    if (n && sameDoc(n.url, url) && Date.now() - n.at < 5_000) return n.user;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
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
      forked: [FORK_NEVER],
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

chrome.tabs.onAttached.addListener(() => scheduleRegroup());
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.pinned !== undefined || change.groupId !== undefined) scheduleRegroup();
});

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
  // The window comes from the tab strip, not the binding: most bindings are
  // made before the tab's window is known (onBeforeNavigate carries none), and
  // a tab dragged to another window keeps its old one. Pinned tabs cannot be in
  // a group, and one in the list made the browser refuse the whole session.
  const tabs = await chrome.tabs.query({ windowType: 'normal' }).catch(() => [] as chrome.tabs.Tab[]);
  const live = new Map<number, chrome.tabs.Tab>();
  for (const t of tabs) if (typeof t.id === 'number' && !t.pinned) live.set(t.id, t);
  const bindings = registry
    .listBindings()
    .filter((b) => b.sessionId !== ANON && live.has(b.tabId))
    .map((b) => ({ ...b, windowId: live.get(b.tabId)!.windowId }));
  const sessions = registry.listSessions().filter((s) => s.id !== ANON);
  const applied = await applyGroups(api, planGroups(sessions, bindings));

  // The browser drops a new tab into the group of the tab it opened beside, so
  // a tab can sit in Work's group while belonging to Home or to no session at
  // all. A group carrying a session's name is a claim about every tab in it.
  if (typeof chrome.tabs.ungroup === 'function') {
    const owner = new Map(bindings.map((b) => [b.tabId, b.sessionId]));
    const byLabel = new Map(sessions.map((s) => [s.label, s.id]));
    const stray: number[] = [];
    for (const t of tabs) {
      if (typeof t.id !== 'number' || (t.groupId ?? -1) < 0) continue;
      const g = await chrome.tabGroups.get(t.groupId!).catch(() => null);
      const claimed = g?.title ? byLabel.get(g.title) : undefined;
      if (claimed && owner.get(t.id) !== claimed) stray.push(t.id);
    }
    if (stray.length) {
      await chrome.tabs.ungroup(stray as [number, ...number[]]).catch(() => undefined);
      // A stray that belongs to another session goes to that session's group.
      if (stray.some((id) => owner.has(id))) await applyGroups(api, planGroups(sessions, bindings));
    }
  }
  return applied;
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
  // Every normal window, not the bindings' windows, which are often unknown.
  const all = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => [] as chrome.windows.Window[]);
  for (const windowId of all.map((w) => w.id).filter((id): id is number => typeof id === 'number')) {
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
/**
 * ------------------------------------------------------------------
 *  Purpose  |  A session's script-readable cookies for one page, in
 *           |  the shape the shim's document.cookie view keeps.
 *  Note     |  HttpOnly cookies never leave the worker, exactly as a
 *           |  browser never shows them to script.
 * ------------------------------------------------------------------
 */
interface PageCookie {
  n: string;
  v: string;
  d: string;
  p: string;
  h: boolean;
  s: boolean;
  e: number | null;
}
function toPageCookie(c: Cookie): PageCookie {
  return { n: c.name, v: c.value, d: c.domain, p: c.path, h: c.hostOnly, s: c.secure, e: c.expires };
}
function pageCookies(session: Session, url: string): PageCookie[] {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return [];
  }
  const now = Date.now();
  const out: PageCookie[] = [];
  for (const c of session.store.all()) {
    if (c.httpOnly) continue;
    if (c.expires !== null && c.expires <= now) continue;
    const visible = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`);
    if (visible) out.push(toPageCookie(c));
  }
  return out;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Tell every page in a session that its cookies changed.
 *  How      |  Batched per session for a moment, then broadcast to the
 *           |  session's tabs; each frame's agent keeps only the cookies
 *           |  its own host can see before the page is told anything.
 * ------------------------------------------------------------------
 */
const jarPending = new Map<SessionId, Cookie[]>();
let jarTimer: ReturnType<typeof setTimeout> | null = null;
function pushJar(sessionId: SessionId, cookies: Cookie[]): void {
  const visible = cookies.filter((c) => !c.httpOnly);
  if (!visible.length) return;
  jarPending.set(sessionId, [...(jarPending.get(sessionId) ?? []), ...visible]);
  if (jarTimer) return;
  jarTimer = setTimeout(() => {
    jarTimer = null;
    const batch = [...jarPending];
    jarPending.clear();
    for (const [sid, list] of batch) {
      const message = { kind: 'nvx.jar', cookies: list.map(toPageCookie) };
      for (const tabId of registry.tabsFor(sid)) {
        chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
      }
    }
  }, 30);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Put one document.cookie write into the session store.
 *  Note     |  The address is the sending frame's own, as the browser
 *           |  reports it, so a page can only ever write its own site.
 *           |  Script can neither set an HttpOnly cookie nor overwrite
 *           |  one, so neither can this.
 * ------------------------------------------------------------------
 */
function acceptPageCookie(tabId: number, value: string, url: string): void {
  if (!value || !url) return;
  const binding = registry.binding(tabId);
  if (!binding) return;
  const session = registry.getSession(binding.sessionId);
  if (!session || session.id === ANON) return;
  const result = captureSetCookie({ url, responseHeaders: [{ name: 'set-cookie', value }] });
  if (!result.cookies.length) return;
  const held = session.store.all();
  const taken: Cookie[] = [];
  for (const cookie of result.cookies) {
    if (cookie.httpOnly) continue;
    const shadowed = held.some(
      (c) => c.httpOnly && c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path
    );
    if (shadowed) continue;
    session.store.upsert(cookie);
    taken.push(cookie);
  }
  if (!taken.length) return;
  scheduleCookieFlush(session.id);
  pushJar(session.id, taken);
  // A script that sets a cookie and navigates at once is the same race as a
  // response that does, so it gets the same fast path and the same check.
  noteFreshCookies(tabId, taken);
  void engine.patch?.(session.id, [hostOf(url)].filter(Boolean));
  // The page may already have navigated: a script that writes a cookie and
  // sets location in the same breath sends the next page before this message
  // arrives. That load is looked at after the fact and asked for again if it
  // left without the cookie, unless it is the page that wrote it.
  const last = lastMainSend.get(tabId);
  if (last && Date.now() - last.at < 2000 && last.url !== url && last.method.toUpperCase() === 'GET') {
    try {
      if (checkRecarry(tabId, new URL(last.url), last.sent)) replayHop(tabId, last.url);
    } catch {
      /* not a url, so nothing to ask for again */
    }
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The storage answer for one frame of a tab.
 *  Note     |  Shared by the top frame's port and the one-shot frame
 *           |  agent, so the two can never disagree about a session.
 * ------------------------------------------------------------------
 */
function storageAnswer(
  tabId: number,
  url: string,
  topFrame: boolean
): { sid: string | null; fork: boolean; persona: string | null; idb: boolean; cookies: PageCookie[] } {
  const binding = registry.binding(tabId);
  const session = binding ? registry.getSession(binding.sessionId) : undefined;
  const origin = originOf(url || binding?.url || '');

  // The anonymous holding session deliberately carries no identity, and giving
  // it a storage namespace would make it one.
  const sid = session && session.id !== ANON ? session.id : null;
  // Only the top frame of a session that was adopted from the profile copies the
  // origin's own storage; a session the user started fresh begins empty, as it
  // should, or it would arrive holding the profile's account.
  const fork = Boolean(
    topFrame && sid && origin && !session!.forked.includes(FORK_NEVER) && !session!.forked.includes(origin)
  );

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

  const cookies = session && sid ? pageCookies(session, url || binding?.url || '') : [];
  return { sid: namespace, fork, persona, idb, cookies };
}

function answerStorage(tabId: number, port: chrome.runtime.Port, url: string): void {
  try {
    port.postMessage({ kind: 'storage.commit', ...storageAnswer(tabId, url, true) });
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
  if (!session || session.forked.includes(origin) || session.forked.includes(FORK_NEVER)) return;
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

/** Whether two URLs share an origin. False when either is missing or unparseable. */
function sameOrigin(a: string, b: string | undefined): boolean {
  if (!b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
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
      if (msg?.kind === 'settle') {
        tally('settle_wait');
        await whenReady();
        await (engine.settle ? engine.settle() : engine.flush());
        try {
          port.postMessage({ kind: 'settle.ready' });
        } catch {
          /* the page went away while it waited */
        }
        return;
      }
      if (msg?.kind === 'child.wait') {
        await whenReady();
        await childBound(tabId);
        try {
          port.postMessage({ kind: 'child.ready' });
        } catch {
          /* the page went away while it waited */
        }
        return;
      }
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
        // The address must be the sending frame's own origin, which the browser
        // vouches for in port.sender. A page cannot use this path to plant a
        // cookie for any other site.
        if (!sameOrigin(url, port.sender?.url)) return;
        acceptPageCookie(tabId, value, url);
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
  if (!ready) ready = timedBoot();
  return ready;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Boot, measured: how long it took, how often a worker
 *           |  starts, and whether it failed.
 *  Note     |  The result is passed through untouched, so a failed boot
 *           |  still rejects for its callers exactly as before.
 * ------------------------------------------------------------------
 */
function timedBoot(): Promise<void> {
  const startedAt = Date.now();
  const run = boot();
  run.then(
    () => {
      tally('worker_boots');
      telemetry.timing('boot', Date.now() - startedAt);
    },
    () => anomaly('boot_failed')
  );
  return run;
}

const AGENT_SCRIPT_ID = 'nvx-agent';
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Marks a session that must never copy an origin's own
 *           |  storage in.
 *  Why      |  Copying is for a session adopted from the signed-in
 *           |  profile, which would otherwise arrive signed out. A
 *           |  session the user starts fresh is for a second account,
 *           |  and copying would hand it the profile's first one.
 * ------------------------------------------------------------------
 */
const FORK_NEVER = '*';
const SHIM_SCRIPT_ID = 'nvx-storage';
const FRAME_SCRIPT_ID = 'nvx-frame';
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
    const ids = [AGENT_SCRIPT_ID, FRAME_SCRIPT_ID, SHIM_SCRIPT_ID, MASK_SCRIPT_ID, POLICY_SCRIPT_ID];
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({
        ids: existing.map((s) => s.id),
      });
    }
    if (!matches.length) return;
    await chrome.scripting.registerContentScripts(portableScripts([
      {
        id: AGENT_SCRIPT_ID,
        js: ['src/content/agent.js'],
        matches,
        runAt: 'document_start',
        world: 'ISOLATED',
        allFrames: false,
        persistAcrossSessions: false,
      },
      {
        // Subframes only (it returns at once in a top frame): the storage
        // handshake a frame needs so its shim learns the tab's session instead
        // of falling back to the origin's shared storage. Before the shim, so its
        // listener exists when the shim announces.
        id: FRAME_SCRIPT_ID,
        js: ['src/content/frame.js'],
        matches,
        runAt: 'document_start',
        world: 'ISOLATED',
        allFrames: true,
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
        // An about:blank or srcdoc frame is its own realm with the raw origin
        // store and the browser's jar, reachable from the page through
        // contentWindow, so it gets the shim too.
        matchOriginAsFallback: true,
        persistAcrossSessions: false,
      },
    ]));
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
  //
  // Cookie rules are the exception: they are withdrawn in the same update that
  // installs this worker's own (see replaceOnNextFlush), because clearing them
  // here and rebuilding several awaits later left every managed tab with no rule
  // in between. The guard and persona bands are cleared now, as before.
  let staleCookieIds: number[] = [];
  try {
    const stale = await backend.current();
    const other = stale.filter((r) => r.id < RULE_ID_BASE).map((r) => r.id);
    staleCookieIds = stale.filter((r) => r.id >= RULE_ID_BASE).map((r) => r.id);
    if (other.length) await backend.apply([], other);
    if (stale.length) {
      note('info', 'rules', 'replacing rules a previous worker left', {
        detail: `${stale.length} rule(s)`,
      });
    }
  } catch (e) {
    note('error', 'rules', 'could not clear stale rules', { detail: String(e) });
    anomaly('apply_failed');
    tally('apply_failed');
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
  // Decided before any tab id is trusted: after a restart the ids are reused.
  const fresh = await browserJustStarted();
  const { kept, dropped, dirty, orphans } = reconcile(registry, tabs, { restart: fresh });
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

  // Before the compile below, so no rule is ever built carrying a cookie the
  // browser itself would have thrown away when it closed.
  if (fresh) dropSessionCookies();

  // Every session recompiles on boot, in one update with the withdrawal of what
  // the previous worker installed, so a managed tab is never without a rule.
  const everySession = registry.listSessions().map((s) => s.id);
  if (engine instanceof Engine && everySession.length) {
    engine.replaceOnNextFlush(staleCookieIds);
    engine.markDirty(everySession);
    await engine.flush();
  } else {
    if (staleCookieIds.length) await backend.apply([], staleCookieIds).catch(() => undefined);
    if (dirty.length || fresh) {
      engine.markDirty(dirty);
      await engine.flush();
    }
  }
  // After the flush, so a tab put back into a session compiles from settled
  // state rather than racing the recompile above.
  if (fresh) await restoreAfterRestart();
  // The baseline the first entitlement change measures against. Set before the
  // registration below so a licence that later unlocks Persona transitions from
  // what boot actually registered, not from a stale default that would mark
  // already-masked tabs as needing it.
  // The stored licence goes into the gate first, so posture and registration
  // below see the real tier. Left until later, every worker restart booted as
  // free and the token's arrival then unmasked a Pro user's open tabs. It is a
  // storage read and one signature check; a failure still boots, as free.
  // The clock floor first, so the token is judged against the latest real time
  // this install has seen rather than whatever the system clock now says.
  await clock.load();
  await license.init().catch(() => undefined);
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
  void ensureInstalledAt();
  // No alarms permission, so boot is one of the moments the queue is sent:
  // after the beat, so a new day's rollup goes in the same batch.
  void telemetry
    .ready()
    .then(() => maybeActive())
    .then(() => telemetry.flush());
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

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The toolbar mark, in the colour of the session the tab is
 *           |  in.
 *  How      |  Per tab, so switching tabs switches the colour with no
 *           |  event of ours: the browser keeps each tab's icon. Drawn
 *           |  from the same three rings as the logo, on an
 *           |  OffscreenCanvas, and only redrawn when a tab's colour
 *           |  actually changed. An unmanaged tab gets the stock icon.
 * ------------------------------------------------------------------
 */
const tinted = new Map<number, string>();
const ICON_RINGS = [
  { r: 14.5, gap: 66, turn: 0, o: 1 },
  { r: 9.5, gap: 78, turn: 132, o: 0.68 },
  { r: 4.5, gap: 96, turn: 262, o: 0.4 },
];
function ringIcon(size: number, color: string): ImageData | null {
  if (typeof OffscreenCanvas !== 'function') return null;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const k = size / 34;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2 * k, size <= 16 ? 1.6 : 1.4);
  ctx.strokeStyle = color;
  for (const ring of ICON_RINGS) {
    const start = ((ring.turn + ring.gap / 2) * Math.PI) / 180;
    const end = ((ring.turn + 360 - ring.gap / 2) * Math.PI) / 180;
    ctx.globalAlpha = ring.o;
    ctx.beginPath();
    ctx.arc(17 * k, 17 * k, ring.r * k, start, end);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(17 * k, 17 * k, 1.8 * k, 0, Math.PI * 2);
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}
function tintToolbar(): void {
  // browserAction on manifest v2 (Firefox, Opera's v2 build), same setIcon.
  const scope = chrome as unknown as { action?: typeof chrome.action; browserAction?: typeof chrome.action };
  const api = scope.action ?? scope.browserAction;
  if (!api?.setIcon) return;
  const want = new Map<number, string>();
  if (!settings.paused) {
    for (const b of registry.listBindings()) {
      if (b.sessionId === ANON) continue;
      const s = registry.getSession(b.sessionId);
      if (s) want.set(b.tabId, HUES[s.color] ?? (/^#[0-9a-f]{6}$/i.test(s.color) ? s.color : HUES.cyan!));
    }
  }
  for (const [tabId, color] of want) {
    if (tinted.get(tabId) === color) continue;
    const s16 = ringIcon(16, color);
    const s32 = ringIcon(32, color);
    if (!s16 || !s32) return;
    tinted.set(tabId, color);
    void api.setIcon({ tabId, imageData: { 16: s16, 32: s32 } }).catch(() => tinted.delete(tabId));
  }
  for (const tabId of [...tinted.keys()]) {
    if (want.has(tabId)) continue;
    tinted.delete(tabId);
    void api.setIcon({ tabId, path: { 16: 'icons/16.png', 32: 'icons/32.png' } }).catch(() => undefined);
  }
}
chrome.tabs.onRemoved.addListener((tabId) => tinted.delete(tabId));

function touched(mutation: { dirty: SessionId[]; needsReload: number[] }, immediate = false): void {
  queueMicrotask(tintToolbar);
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
    await engine.flush();
    if (opened) settleChild(tab.openerTabId!);
    recoverEarly(tab.id);
  })();
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The tab a page opened, named by the browser itself.
 *  Why      |  openerTabId is not reliably set on a tab a page opens
 *           |  with window.open or target=_blank, and without it the
 *           |  new tab looked unrelated: it was held at the picker, or
 *           |  matched to whichever session had last closed a tab on
 *           |  that site, which put one account's link in the other
 *           |  account. This event always names the source tab.
 * ------------------------------------------------------------------
 */
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Finish a redirect the hold rule stopped, once its
 *           |  cookies are in the rules.
 *  How      |  The response arrives without its Location and settles
 *           |  as a page at the url that redirected. Two things have to
 *           |  be true before the tab goes on: the patch carrying the
 *           |  cookies has landed, and that page has committed. Then the
 *           |  tab is sent on with location.replace, so the back button
 *           |  does not land on the empty stop. A tab update is the
 *           |  fallback if the page cannot be scripted.
 *  Note     |  A 307 or 308 keeps its method and body, which this cannot
 *           |  replay, so those go on as a GET and say so.
 * ------------------------------------------------------------------
 */
const heldRedirects = new Map<number, { from: string; to: string; ready: boolean; committed: boolean; at: number }>();
function heldTarget(url: string, headers?: chrome.webRequest.HttpHeader[]): string | null {
  const loc = headers?.find((h) => h.name.toLowerCase() === 'location')?.value;
  const cookie = headers?.some((h) => h.name.toLowerCase() === 'set-cookie');
  if (!loc || !cookie) return null;
  try {
    return new URL(loc, url).href;
  } catch {
    return null;
  }
}
function holdRedirect(tabId: number, from: string, to: string, status: number, method: string): void {
  heldRedirects.set(tabId, { from, to, ready: false, committed: false, at: Date.now() });
  // The hops a hold causes are NVX's own, not the site looping, so they must
  // not count toward the loop detector. Without this, a sign-in with several
  // held hops in a row could be released as a loop it never was.
  markRecovering(tabId, 6000);
  tally('hold_redirect');
  if ((status === 307 || status === 308) && method.toUpperCase() !== 'GET') {
    note('warn', 'tab', 'a held redirect kept its method, which cannot be replayed, so it went on as a GET', { tabId, url: to });
  }
  setTimeout(() => releaseHeld(tabId, 'timeout'), 3000);
}
function releaseHeld(tabId: number, why: 'ready' | 'committed' | 'timeout'): void {
  const h = heldRedirects.get(tabId);
  if (!h) return;
  if (why === 'ready') h.ready = true;
  if (why === 'committed') h.committed = true;
  if (why !== 'timeout' && !(h.ready && h.committed)) return;
  heldRedirects.delete(tabId);
  // Covers the hop this release is about to cause.
  markRecovering(tabId, 4000);
  tally(why === 'ready' ? 'hold_ready' : why === 'committed' ? 'hold_committed' : 'hold_timeout');
  if (why === 'timeout') telemetry.idpIssue(hostOf(h.to), 'hold_timeout');
  void (async () => {
    const done = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: (u: string) => location.replace(u),
        args: [h.to],
        injectImmediately: true,
      })
      .then(() => true, () => false);
    if (!done) await chrome.tabs.update(tabId, { url: h.to }).catch(() => undefined);
  })();
}
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const h = heldRedirects.get(details.tabId);
  if (h && details.url === h.from) releaseHeld(details.tabId, 'committed');
});

const navigationSource = new Map<number, number>();
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  navigationSource.set(details.tabId, details.sourceTabId);
  setTimeout(() => navigationSource.delete(details.tabId), 60_000);
  void (async () => {
    await whenReady();
    const from = registry.binding(details.sourceTabId);
    if (!from || from.sessionId === ANON) return;
    const existing = registry.binding(details.tabId);
    if (existing?.sessionId === from.sessionId) {
      settleChild(details.sourceTabId);
      return;
    }
    if (held.has(details.tabId)) held.delete(details.tabId);
    touched(
      registry.bind(details.tabId, from.sessionId, {
        windowId: chrome.windows.WINDOW_ID_NONE,
        url: details.url,
        origin: 'opener',
      }),
      true
    );
    noteBinding(details.tabId, from.sessionId, 'opened from a tab already in this session', details.url);
    await engine.flush();
    settleChild(details.sourceTabId);
    recoverEarly(details.tabId);
  })();
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A new tab's first request, sent before the tab was in
 *           |  its session.
 *  Why      |  The tab is bound when the browser reports it, which is
 *           |  after it has started loading, and a rule scoped to its
 *           |  id cannot exist before then. So a link or window.open
 *           |  into a new tab arrived with no cookies, or the profile's.
 *           |  A GET is loaded again once the rules are in. A POST
 *           |  cannot be, so the page holds those until the tab is
 *           |  ready (childBound below, and the shim's form hold).
 * ------------------------------------------------------------------
 */
const earlyUnbound = new Map<number, { method: string; url: string; at: number }>();
const recovered = new Set<number>();
function recoverEarly(tabId: number): void {
  const early = earlyUnbound.get(tabId);
  earlyUnbound.delete(tabId);
  if (!early || Date.now() - early.at > 5000 || recovered.has(tabId)) return;
  if (early.method.toUpperCase() !== 'GET') return;
  recovered.add(tabId);
  void chrome.tabs.update(tabId, { url: early.url }).catch(() => undefined);
}

/** Pages waiting for a tab they are about to open to be in their session. */
const childWaiters = new Map<number, (() => void)[]>();
function childBound(openerTabId: number): Promise<void> {
  return new Promise((resolve) => {
    const list = childWaiters.get(openerTabId) ?? [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    list.push(finish);
    childWaiters.set(openerTabId, list);
    setTimeout(finish, 2500);
  });
}
function settleChild(openerTabId: number): void {
  const list = childWaiters.get(openerTabId);
  if (!list) return;
  childWaiters.delete(openerTabId);
  for (const go of list) go();
}

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
    // Saved and regrouped now, not on whatever changes next: a tab dragged to
    // another window should land in its session's group there.
    persistence.schedule();
    scheduleRegroup();
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

/**
 * ------------------------------------------------------------------
 *  Purpose  |  What a problem report knows about this install.
 *  Note     |  Counts and settings, never a cookie or a url. Session
 *           |  names and site names are scrubbed by report.ts unless
 *           |  the user asks for site names.
 * ------------------------------------------------------------------
 */
let lastReportAt = 0;
async function reportFacts(): Promise<ReportFacts> {
  const bindings = registry.listBindings();
  const sessions = registry
    .listSessions()
    .filter((s) => s.id !== ANON)
    .map((s) => ({
      label: s.label,
      tabs: bindings.filter((b) => b.sessionId === s.id).length,
      sites: s.store.domains().length,
    }));
  const ua = (globalThis.navigator?.userAgent ?? '') as string;
  return {
    version: chrome.runtime.getManifest().version,
    tier: entitlement.tier(),
    channel: telemetryChannel,
    device: deviceLabelText(),
    browserVersion: /(?:Chrome|Edg|OPR)\/(\d+)/.exec(ua)?.[0] ?? 'unknown',
    settings: {
      posture: settings.posture,
      paused: settings.paused,
      exact: settings.exact,
      paint: settings.paint,
      group: settings.group,
      askNewSites: settings.askNewSites,
      neverAsk: settings.quiet.length,
      telemetry: settings.telemetry,
      logLevel: settings.logLevel,
    },
    sessions,
    managedTabs: bindings.filter((b) => b.sessionId !== ANON).length,
    released: [...settings.released],
    journal: await journal.all(),
    now: Date.now(),
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Let our own site hand a key straight to the extension.
 *  How      |  externally_connectable lets only https://session.nvx.sh
 *           |  and https://nvx.sh send here, and the sender's origin is
 *           |  checked again regardless. Two messages: a ping (is NVX
 *           |  installed, which version, is Pro on) and activate, which
 *           |  runs the same activation as typing the key in the popup.
 *  Why      |  After paying, or after a recovery email, the key arrives
 *           |  on a page of ours. Copying it into a popup is the step
 *           |  people get wrong or never finish.
 *  Note     |  Nothing is readable from outside: no key, no token, no
 *           |  device id, no session, no site. Activations from outside
 *           |  are limited to five a minute.
 * ------------------------------------------------------------------
 */
const SITE_ORIGINS = new Set(['https://session.nvx.sh', 'https://nvx.sh']);
const externalActivations: number[] = [];
chrome.runtime.onMessageExternal?.addListener((raw, sender, reply) => {
  let origin = '';
  try {
    origin = sender.origin ?? new URL(sender.url ?? '').origin;
  } catch {
    origin = '';
  }
  if (!SITE_ORIGINS.has(origin)) return false;
  const msg = (raw ?? {}) as { type?: unknown; key?: unknown; transfer?: unknown };
  void (async () => {
    await whenReady();
    if (msg.type === 'nvx.ping') {
      reply({
        installed: true,
        version: chrome.runtime.getManifest().version,
        canActivate: licensePossible(),
        pro: entitlement.tier() !== 'free',
      });
      return;
    }
    if (msg.type === 'nvx.activate' && typeof msg.key === 'string') {
      if (!licensePossible()) {
        reply({ ok: false, reason: 'free_build' });
        return;
      }
      const now = Date.now();
      while (externalActivations.length && now - externalActivations[0]! > 60_000) externalActivations.shift();
      if (externalActivations.length >= 5) {
        reply({ ok: false, reason: 'rate' });
        return;
      }
      externalActivations.push(now);
      const result = await license.activate(msg.key.slice(0, 64), { transfer: msg.transfer === true });
      note(result.ok ? 'info' : 'warn', 'life', 'a licence key arrived from the NVX site', {
        detail: result.ok ? 'activated' : result.reason,
      });
      // The seat list is what the page needs to offer the move; nothing else
      // about the result leaves.
      reply(result);
      return;
    }
    reply({ ok: false, reason: 'unknown' });
  })();
  return true;
});

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
    // The new host goes into the registry first, so the flush below builds its
    // rule. Without this nothing was dirty and the flush did nothing, leaving a
    // brand new site to the bottom-priority navigation rule.
    touched(registry.navigated(details.tabId, details.url));
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
  })();
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Count a hop only when the page moved by itself.
 *  Why      |  A loop is redirects. Counting every navigation start
 *           |  meant reloading a page a few times, or paging through a
 *           |  site that does full loads, read as a loop and released
 *           |  the whole site. A commit the browser marks as a client
 *           |  redirect (script or meta refresh) counts; anything the
 *           |  user started does not. Server redirects are counted as
 *           |  they happen, in onBeforeRedirect.
 * ------------------------------------------------------------------
 */
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!(details.transitionQualifiers ?? []).includes('client_redirect')) return;
  void (async () => {
    await whenReady();
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
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Follow a server redirect to a new host as it happens.
 *  How      |  onBeforeNavigate fires once per navigation, not per hop,
 *           |  so a sign-in that redirects through an identity provider
 *           |  would otherwise only reach the registry on commit.
 *  Note     |  Observational: the next hop may leave before the rule
 *           |  lands, and the navigation rule covers that moment.
 * ------------------------------------------------------------------
 */
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.tabId < 0) return;
    void (async () => {
      await whenReady();
      if (!registry.binding(details.tabId)) return;
      touched(registry.navigated(details.tabId, details.redirectUrl));
      await engine.flush();
      await noteHop(details.tabId, details.redirectUrl);
    })();
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }
);

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

const onResponse = (details: chrome.webRequest.OnHeadersReceivedDetails): undefined => {
    void (async () => {
      await whenReady();
      // Only a managed tab's own responses. An unmanaged tab, or a worker, is
      // the profile talking: its Set-Cookie is the profile's, and filing it
      // under whichever session sat on the origin put the profile account's
      // rotated cookies beside a session's own and signed that session out.
      const binding = registry.binding(details.tabId);
      const session = binding ? registry.getSession(binding.sessionId) : undefined;
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
      // The response's Set-Cookie never reached the browser's jar (a rule strips
      // it), so the session's pages learn about it from here instead.
      pushJar(session.id, result.cookies);
      if (binding) noteFreshCookies(details.tabId, result.cookies);
      // Holding a redirect is a declarative rule's job (it takes the Location
      // off); the blocking backend reads the jar as each hop leaves, so there
      // is nothing to hold and the hop goes on by itself.
      const held =
        binding &&
        engine instanceof Engine &&
        details.type === 'main_frame' &&
        details.statusCode >= 300 &&
        details.statusCode < 400
          ? heldTarget(details.url, details.responseHeaders)
          : null;
      if (held) holdRedirect(details.tabId, details.url, held, details.statusCode, details.method);

      // A cookie set on a navigation response has to be in the rule before the
      // redirect that reads it back leaves, or the site sees the header without
      // the cookie it just set and declares cookies disabled, which is the
      // "Cookies are disabled" wall a SAML sign-in hits mid-chain. So a
      // navigation response recompiles now rather than on the deferred schedule.
      // A managed tab's own requests flush at once too: a sign-in
      // page sets its cookies from a fetch and navigates the moment it answers,
      // which is how Google's password step met a rule without the cookie its
      // previous step set and showed "Cookies are disabled". Only background
      // traffic, a service worker's, keeps coalescing. This narrows the race but
      // cannot close it: the listener is observational, so the browser can still
      // issue the next request before the rule lands, and the recarry catches that.
      if (binding) {
        const hosts = [hostOf(details.url), ...result.cookies.filter((c) => c.hostOnly).map((c) => c.domain)];
        if (held) hosts.push(hostOf(held));
        await engine.patch?.(session.id, hosts.filter(Boolean));
        if (engine instanceof Engine) telemetry.patchRules(engine.patchRules);
        if (held) releaseHeld(details.tabId, 'ready');
      }
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
};

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Keep a managed tab's Set-Cookie (and the account
 *           |  headers) out of the browser's own jar on manifest v2.
 *  How      |  v3 does this with a declarative rule (compile.ts
 *           |  setCookieRule). v2 has no rules, so a blocking listener
 *           |  removes the same list, after handing the untouched
 *           |  response to onResponse so the session still files the
 *           |  cookies. One listener, so the order is not left to the
 *           |  browser.
 *  Why      |  Without it, every session's cookies also landed in the
 *           |  profile jar on Firefox and Opera's v2 build, and an
 *           |  unmanaged tab carried whichever account signed in last.
 * ------------------------------------------------------------------
 */
if (blockingIsReal()) {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      onResponse(details);
      if (settings.paused || details.tabId < 0) return undefined;
      const binding = registry.binding(details.tabId);
      if (!binding) return undefined;
      const strip = new Set(responseStripHeaders());
      const all = details.responseHeaders ?? [];
      const kept = all.filter((h) => !strip.has(h.name.toLowerCase()));
      return kept.length === all.length ? undefined : { responseHeaders: kept };
    },
    { urls: ['http://*/*', 'https://*/*'] },
    ['blocking', 'responseHeaders', ...extraHeaders()]
  );
} else {
  chrome.webRequest.onHeadersReceived.addListener(onResponse, { urls: ['http://*/*', 'https://*/*'] }, [
    'responseHeaders',
    ...extraHeaders(),
  ]);
}

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
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Load a page again when its request beat the cookie a
 *           |  redirect had just set.
 *  Why      |  A sign-in answers with a redirect that sets the session
 *           |  cookie, and the browser follows it in milliseconds. The
 *           |  rule that carries the new cookie is built from the
 *           |  observer, which cannot hold the request, so that next
 *           |  hop can leave without it and the site shows the user as
 *           |  signed out. Found in the browser: a fast host lost the
 *           |  race every time. The request's real Cookie header says
 *           |  whether it did; if so the page loads once more, now with
 *           |  the rule in place. Once per tab per ten seconds.
 * ------------------------------------------------------------------
 */
const freshCookies = new Map<number, { cookies: Cookie[]; at: number }>();
/**
 * Where each tab's current navigation started, and how. A race lost mid-chain
 * (Google's sign-in sets a cookie, redirects, and rejects the hop that arrives
 * without it) ends on an error page, and reloading that page asks the error
 * again; the chain has to start over. Only a GET is replayed: a POST that is
 * re-run as a GET would be a different request, so that case reloads the page.
 */
const chainStart = new Map<number, { requestId: string; url: string; method: string }>();
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return undefined;
    const held = chainStart.get(details.tabId);
    if (held?.requestId === details.requestId) return undefined; // a redirect hop, same chain
    chainStart.set(details.tabId, { requestId: details.requestId, url: details.url, method: details.method });
    return undefined;
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }
);
const recarryDue = new Set<number>();
/** Each managed tab's latest page load, for a cookie that arrives after it left. */
const lastMainSend = new Map<number, { url: string; method: string; sent: string; at: number }>();
const lastRecarry = new Map<number, number>();
const chainReplays = new Map<number, number[]>();

function noteFreshCookies(tabId: number, cookies: Cookie[]): void {
  const now = Date.now();
  const live = cookies.filter((c) => c.expires === null || c.expires > now);
  if (!live.length) return;
  // Accumulated across responses inside the window, since a sign-in step sets
  // cookies from several fetches before it navigates, and keeping only the
  // last response's forgot the one the server was about to check for.
  const held = freshCookies.get(tabId);
  const keep = held && now - held.at <= 5000 ? held.cookies.filter((c) => !live.some((n) => n.name === c.name && n.domain === c.domain && n.path === c.path)) : [];
  freshCookies.set(tabId, { cookies: [...keep, ...live], at: now });
}

function checkRecarry(tabId: number, url: URL, sent: string): boolean {
  const fresh = freshCookies.get(tabId);
  if (!fresh || Date.now() - fresh.at > 5000) return false;
  const host = url.hostname;
  // By name. A cookie sent with its previous value is not missing: load
  // balancers and session layers rotate a value on every response (Monash's do)
  // and accept the one before, and treating each rotation as a miss made every
  // hop a retry and every retry another rotation, until the browser gave up on
  // the redirects. Only a cookie the request did not carry at all is asked again.
  const pairs = new Set(
    sent
      .split(';')
      .map((p) => p.split('=')[0]!.trim())
      .filter(Boolean)
  );
  const missed = fresh.cookies.some(
    (c) =>
      (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`)) &&
      url.pathname.startsWith(c.path) &&
      (!c.secure || url.protocol === 'https:') &&
      !pairs.has(c.name)
  );
  if (missed) recarryDue.add(tabId);
  else freshCookies.delete(tabId);
  return missed;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Ask again for the one hop that left without a cookie it
 *           |  was just given.
 *  Why      |  The browser follows a redirect the moment it arrives,
 *           |  and a rule cannot be in place by then: the extension
 *           |  only hears about the cookie as the next hop leaves. Server
 *           |  speed does not help. Replaying the whole chain once it
 *           |  had finished worked only for one race per chain and once
 *           |  per ten seconds, so a sign-in that raced at two hops never
 *           |  recovered. A GET hop is asked for again as soon as the
 *           |  rule is in, which supersedes the request still in flight.
 *           |  A few per tab, then the chain replay below takes over.
 * ------------------------------------------------------------------
 */
const hopReplays = new Map<number, number[]>();
/** Until when a tab's hops are NVX's own replays rather than the site's. */
const recovering = new Map<number, number>();
/** Extend a tab's recovery window, never shorten it. */
function markRecovering(tabId: number, ms: number): void {
  const until = Date.now() + ms;
  if ((recovering.get(tabId) ?? 0) < until) recovering.set(tabId, until);
}
function replayHop(tabId: number, url: string): void {
  const now = Date.now();
  const recent = (hopReplays.get(tabId) ?? []).filter((at) => now - at < 15_000);
  if (recent.length >= 4) {
    telemetry.idpIssue(hostOf(url), 'replay_exhausted');
    return;
  }
  hopReplays.set(tabId, [...recent, now]);
  tally('replay_hop');
  recarryDue.delete(tabId);
  recovering.set(tabId, now + 6000);
  note('info', 'tab', 'asked again for a hop that left without a cookie it was just given', { tabId, url });
  // The load in flight is stopped first, from inside the tab, and then asked for
  // again. Waiting for it to finish let a site that restarts sign-in on a miss
  // (Moodle sending the tab back to Okta with a new request) run a whole lap
  // before the replay, and the laps kept coming. Navigating to the url already
  // loading is taken as nothing to do, which is why it is stopped rather than
  // replaced. If the stop cannot be injected, the replay waits for the load to
  // settle instead, as before.
  hopPending.set(tabId, url);
  void (async () => {
    await engine.flush();
    const stopped = await chrome.scripting
      .executeScript({ target: { tabId }, func: () => window.stop(), injectImmediately: true })
      .then(() => true, () => false);
    if (!stopped || hopPending.get(tabId) !== url) return;
    hopPending.delete(tabId);
    await chrome.tabs.update(tabId, { url }).catch(() => undefined);
  })();
}
const hopPending = new Map<number, string>();
function settleHop(tabId: number): boolean {
  const url = hopPending.get(tabId);
  if (url === undefined) return false;
  hopPending.delete(tabId);
  void (async () => {
    await engine.flush();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if ((tab.url ?? '') === url) await chrome.tabs.reload(tabId).catch(() => undefined);
    else await chrome.tabs.update(tabId, { url }).catch(() => undefined);
  })();
  return true;
}
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId === 0) settleHop(details.tabId);
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0 && settleHop(details.tabId)) return;
  if (details.frameId !== 0 || !recarryDue.delete(details.tabId)) return;
  freshCookies.delete(details.tabId);
  const now = Date.now();
  // Three chain replays in twenty seconds, enough for a chain that races at
  // more than one hop, and still bounded so a site that never accepts can only
  // cost a few loads. The loop detector watches the same tab regardless.
  const recent = (chainReplays.get(details.tabId) ?? []).filter((at) => now - at < 20_000);
  if (recent.length >= 3) {
    telemetry.idpIssue(hostOf(details.url), 'replay_exhausted');
    return;
  }
  chainReplays.set(details.tabId, [...recent, now]);
  tally('replay_chain');
  lastRecarry.set(details.tabId, now);
  recovering.set(details.tabId, now + 8000);
  void (async () => {
    await whenReady();
    // The rule may still be landing; settle it before asking again.
    await engine.flush();
    const start = chainStart.get(details.tabId);
    if (start && start.method.toUpperCase() === 'GET' && start.url !== details.url) {
      await chrome.tabs.update(details.tabId, { url: start.url }).catch(() => undefined);
    } else {
      await chrome.tabs.reload(details.tabId).catch(() => undefined);
    }
  })();
});

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    void (async () => {
      await whenReady();
      const binding = registry.binding(details.tabId);
      if (!binding) {
        if (details.type === 'main_frame' && details.tabId >= 0) {
          earlyUnbound.set(details.tabId, { method: details.method, url: details.url, at: Date.now() });
        }
        return;
      }
      const session = registry.getSession(binding.sessionId);
      if (!session) return;
      const firstLoad = !binding.sealed && Date.now() - binding.boundAt < 5000;

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
        ...(initiatorOf(details as { initiator?: string; originUrl?: string })
          ? { initiator: initiatorOf(details as { initiator?: string; originUrl?: string }) }
          : {}),
      });
      const expected = emit(session.store, url, context).header;
      const sent = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'cookie')?.value;
      if (details.type === 'main_frame') {
        lastMainSend.set(details.tabId, { url: details.url, method: details.method, sent: sent ?? '', at: Date.now() });
      }
      if (details.type === 'main_frame' && checkRecarry(details.tabId, url, sent ?? '') && details.method.toUpperCase() === 'GET') {
        replayHop(details.tabId, details.url);
      }

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
      // A tab's first page load went out before its rules did. Loaded again
      // once, as a GET can be.
      if (
        firstLoad &&
        details.type === 'main_frame' &&
        details.method.toUpperCase() === 'GET' &&
        !recovered.has(details.tabId)
      ) {
        recovered.add(details.tabId);
        void engine.flush().then(() => chrome.tabs.update(details.tabId, { url: details.url }).catch(() => undefined));
      }

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
        // Transient when the rules simply had not landed yet: the tab's first
        // load, a tab bound or moved moments ago, a sign-in NVX is replaying,
        // or a rule write still in flight. Counted either way; only a real one
        // raises the signal.
        const sentAt = Date.now();
        const transient =
          firstLoad ||
          sentAt - binding.boundAt < 5000 ||
          sentAt < (recovering.get(details.tabId) ?? 0) ||
          (engine instanceof Engine && engine.busy);
        tally(transient ? 'foreign_transient' : 'foreign_real');
        if (!transient) anomaly('foreign_cookie');
        note('error', 'jar', 'a request carried a cookie it should not have', {
          session: session.label,
          url: details.url,
          // Names only, never values: which cookies, and whether each was
          // foreign, missing or stale, is what makes the line worth reading.
          detail: result.events.map((e) => `${e.kind}: ${e.names.join(' ')}`).join('; '),
        });
        engine.markDirty([session.id]);
        void engine.flush();
        paintAlarm();
      }
    })();
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['requestHeaders', ...extraHeaders()]
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
  // The suites need a local fixture server, so only a developer build opens them.
  if (!devUnlock()) return;
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
/**
 * ------------------------------------------------------------------
 *  Purpose  |  Rebuild the context menu, one rebuild at a time.
 *  Why      |  It is called from several places without waiting, and
 *           |  two overlapping removeAll calls both ran before either
 *           |  set of creates, so the second set hit "duplicate id"
 *           |  errors on the extensions page. A request made while one
 *           |  is running is folded into a single follow-up.
 * ------------------------------------------------------------------
 */
let menusBusy = false;
let menusAgain = false;
function rebuildMenus(): void {
  if (!chrome.contextMenus) return;
  if (menusBusy) {
    menusAgain = true;
    return;
  }
  menusBusy = true;
  chrome.contextMenus.removeAll(() => {
    try {
      buildMenus();
    } finally {
      menusBusy = false;
      if (menusAgain) {
        menusAgain = false;
        rebuildMenus();
      }
    }
  });
}

function buildMenus(): void {
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
    if (reason === 'install') {
      // The install clock, for the days-since-install cohort on the active beat.
      // Written whatever the consent, because it is a local timestamp that never
      // leaves on its own, and a cohort measured from opt-in would be wrong.
      // Set once and never overwritten, so an update does not reset the age.
      await ensureInstalledAt();
      telemetry.install();
      // Only counts as reported if consent was already on so the send could
      // actually leave. With consent off, the send was dropped and the marker
      // stays absent, so the first opt-in knows to send the install it missed.
      if (settings.telemetry) await storage.set({ [INSTALL_REPORTED_KEY]: Date.now() });
    } else if (reason === 'update') {
      // An unpacked reload fires update with the same version; that is a
      // developer pressing reload, not a release reaching anyone.
      const from = details?.previousVersion ?? '';
      if (from && from !== chrome.runtime.getManifest().version) {
        telemetry.update(from);
        if (settings.telemetry) await storage.set({ [INSTALL_REPORTED_KEY]: Date.now() });
      }
    }
    void telemetry.flush();
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
  startedAt = Date.now();
  void noteLifecycle('onStartup');
  void whenReady().then(async () => {
    await telemetry.ready();
    telemetry.startup();
    await maybeActive();
    void telemetry.flush();
  });
  // Session rules die with the browser session, so a restart has to recompile
  // everything rather than trust what the registry remembers. Chained onto the
  // boot already running rather than starting a second: two boots at once each
  // reconciled the same registry, so the second found no orphans and the tabs
  // were never put back, and its rule clear undid the first one's install.
  ready = whenReady().then(async () => {
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
 *           |  worker waking or the extension updating.
 *  How      |  chrome.storage.session clears when the browser session
 *           |  ends, and also when the extension is updated. An update
 *           |  changes the version and a restart does not, so the
 *           |  version recorded in local storage tells them apart.
 *  Bug-Fix  |  This used to count surviving bindings by tab id, but a
 *           |  restarted browser reuses ids, so a remembered id could
 *           |  match a different restored tab. That counted as the
 *           |  browser still running, kept the wrong binding (another
 *           |  account on the same site), and skipped the restore.
 *  Note     |  onStartup is not usable: in Opera GX loaded from the
 *           |  command line it does not fire. Reloading an unpacked
 *           |  copy without changing its version reads as a restart,
 *           |  which only costs a developer a restore by url.
 * ------------------------------------------------------------------
 */
const LAST_VERSION_KEY = 'nvx.lastVersion';
async function browserJustStarted(): Promise<boolean> {
  const area = (chrome.storage as { session?: chrome.storage.StorageArea }).session;
  // Manifest v2 has no session area, and its background page dies with the
  // browser, so every boot there really is a new browser session.
  if (!area) return true;
  try {
    const seen = await area.get('nvx.browserSession');
    await area.set({ 'nvx.browserSession': Date.now() });
    if (seen['nvx.browserSession']) return false;
    const version = chrome.runtime.getManifest().version;
    const held = await storage.get([LAST_VERSION_KEY]);
    await storage.set({ [LAST_VERSION_KEY]: version });
    // A first install has nothing to restore; an update keeps every tab id.
    return held[LAST_VERSION_KEY] === version;
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
  /**
   * The subframe handshake, the other content-script messages accepted here.
   *
   * Both are answered from what the browser stamps on the message, the sender's
   * tab and frame address, never from anything the frame says about itself, so
   * a frame can only learn its own tab's session and only write its own site.
   */
  if (msg?.kind === 'frame.hello' || msg?.kind === 'frame.cookie') {
    const tabId = sender.tab?.id;
    const url = sender.url ?? '';
    if ((sender.id && sender.id !== chrome.runtime.id) || typeof tabId !== 'number' || !url) {
      reply(null);
      return false;
    }
    void whenReady().then(() => {
      if (msg.kind === 'frame.hello') {
        reply(storageAnswer(tabId, url, false));
        return;
      }
      acceptPageCookie(tabId, typeof msg.value === 'string' ? msg.value : '', url);
      reply({ ok: true });
    });
    return true;
  }
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
          telemetryPossible:
            typeof BUILD.telemetryEndpoint === 'string' && /^https:\/\//.test(BUILD.telemetryEndpoint),
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
          forked: [FORK_NEVER],
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
        tally('burner_created');
        const id: SessionId = `s_${Date.now().toString(36)}`;
        registry.createSession({
          id,
          label: 'Burner',
          color: cleanColor(msg.color),
          pinned: [],
          store: new CookieStore(),
          family: [],
          forked: [FORK_NEVER],
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
        const covering = chooserOptionsFor(host);
        // A site no session has yet is a different question: which of your
        // sessions should this be, so every session is offered, the ones that
        // already know the site first.
        const known = new Set(covering.map((o) => o.sessionId));
        const others = covering.length >= 2
          ? []
          : registry
              .listSessions()
              .filter((s) => s.id !== ANON && !s.ephemeral && !known.has(s.id))
              .sort((a, b) => b.lastSeen - a.lastSeen)
              .map((s) => ({ sessionId: s.id, label: s.label, color: s.color, cookies: 0 }));
        reply({
          ok: true,
          reason: covering.length >= 2 ? 'ambiguous' : 'new',
          host,
          domain: domainOf(`https://${host}/`) || host,
          palette: [...RAMP],
          options: [...covering, ...others].map((o) => ({
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
            color: typeof msg.color === 'string' ? cleanColor(msg.color) : nextColor(),
            pinned: domain ? [domain] : [],
            store: new CookieStore(),
            family: [],
            forked: [FORK_NEVER],
            danger: DEFAULT_DANGER,
    thirdParty: DEFAULT_THIRD_PARTY,
            createdAt: Date.now(),
            lastSeen: Date.now(),
          });
          void registerAgent();
        }

        // Remembered: the site goes into the chosen session, so a fresh tab on it
        // opens there without asking, or onto the quiet list, so it is never
        // asked about again. Only the question for two sessions on one site is
        // asked every time, because that is the one with no right default.
        if (msg.create === true) tally('pick_created');
        else if (sessionId) tally('pick_chosen');
        else tally('pick_unmanaged');
        if (msg.remember === true && domain) {
          const chosen = sessionId ? registry.getSession(sessionId) : undefined;
          tally(chosen ? 'pick_remember' : 'pick_quiet');
          if (chosen && !chosen.pinned.includes(domain)) {
            chosen.pinned = [...chosen.pinned, domain].sort();
            void registerAgent();
          } else if (!chosen && !settings.quiet.includes(domain)) {
            settings = { ...settings, quiet: [...settings.quiet, domain].sort() };
          }
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
          tally('release_manual');
          telemetry.feature('release');
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
          askNewSites: typeof msg.askNewSites === 'boolean' ? msg.askNewSites : before.askNewSites,
          quiet: Array.isArray(msg.quiet)
            ? [...new Set((msg.quiet as unknown[]).filter((d): d is string => typeof d === 'string' && d.length > 0 && d.length < 254))].sort()
            : before.quiet,
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
            // The install clock is normally already there, written at install
            // whatever the consent; this only covers an install from before
            // that was true.
            await ensureInstalledAt();
            const held = await storage.get([INSTALL_REPORTED_KEY]);
            // The install that fired before consent was dropped and never
            // retried, so send it now, once. Without this no install is ever
            // recorded, since nobody can consent before installing.
            if (!held[INSTALL_REPORTED_KEY]) {
              telemetry.install();
              await storage.set({ [INSTALL_REPORTED_KEY]: Date.now() });
            }
            recordUsage();
            await maybeActive();
            void telemetry.flush();
          } else {
            await telemetry.purge();
            // The id, the queue and the day's rollup are gone; the day stamp,
            // the peak and the reported marker go with them. The install
            // clock stays: it was written before consent, is never sent on its
            // own, and is the local fact that makes the cohort right if the
            // user opts in again.
            await storage.remove([LAST_ACTIVE_KEY, USAGE_PEAK_KEY, INSTALL_REPORTED_KEY, ANOMALY_KEY]);
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
        if (result.ok) void maybeFetchPack();
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
       * Problem reports from the Help view. The preview is the exact
       * diagnostics block a send would carry, so what the user reads is what
       * leaves. A send goes to the report endpoint with a work stamp; without
       * an endpoint, or when it fails, the plain text comes back for the
       * popup to copy, and nothing is lost.
       */
      case 'reportPreview': {
        reply({ preview: diagnostics(await reportFacts(), msg.includeSites === true) });
        return;
      }
      case 'sendReport': {
        const input = cleanInput(msg as Record<string, unknown>);
        if ('error' in input) {
          reply({ ok: false, reason: 'rejected', error: input.error });
          return;
        }
        const id = (typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : uuidV4()).slice(0, 8);
        const report = buildReport(input, await reportFacts(), id);
        const fallback = reportText(report);
        const url = BUILD.reportEndpoint;
        if (!url || !/^https:\/\//.test(url)) {
          reply({ ok: false, reason: 'no_endpoint', fallback });
          return;
        }
        if (Date.now() - lastReportAt < 60_000) {
          reply({ ok: false, reason: 'rate', fallback });
          return;
        }
        lastReportAt = Date.now();
        try {
          const stamp = await mintStamp('report', id, Date.now());
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(stamp ? { 'x-nvx-stamp': stamp } : {}) },
            body: JSON.stringify(report),
          });
          if (res.ok) {
            note('info', 'life', 'a problem report was sent', { detail: id });
            reply({ ok: true, id });
            return;
          }
          reply({ ok: false, reason: res.status === 429 ? 'rate' : 'rejected', fallback });
        } catch {
          reply({ ok: false, reason: 'network', fallback });
        }
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
        tally('sync_enable');
        const result = await sync.enable(typeof msg.passphrase === 'string' ? msg.passphrase : '');
        reply({ result, sync: sync.status() });
        return;
      }
      case 'syncNow': {
        if (!featureOn('sync')) {
          reply({ ok: false, reason: 'disabled', sync: sync.status() });
          return;
        }
        tally('sync_now');
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
          tally('adopt_run');
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
              ready = timedBoot();
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
          forked: registry.listSessions().map((s) => ({ id: s.id, origins: s.forked.filter((o) => o !== FORK_NEVER).length })),
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
  })().catch((e: unknown) => {
    // A command that throws still answers, with the reason, so the control that
    // sent it can say so instead of sitting there doing nothing.
    console.error('[nvx] command failed', msg?.cmd, e);
    try {
      reply({ error: e instanceof Error ? e.message : String(e) });
    } catch {
      /* already answered before it threw */
    }
  });
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
        forked: [FORK_NEVER],
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
      // Through touched, like every real binding, so groups, the toolbar and
      // the mark follow exactly as they would in use.
      touched(m);
      await engine.flush();
      return m;
    },
    seed: seedCookie,
    regroup: () => regroup(),
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
          ready = timedBoot();
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
