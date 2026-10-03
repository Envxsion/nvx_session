/**
 * ------------------------------------------------------------------
 *  Title    |  Flush loop
 *  Ref      |  registry.ts, netfilter/compile.ts, netfilter/dnr.ts
 *  ID       |  Netfilter flush
 * ------------------------------------------------------------------
 *  Purpose  |  Coalesce cookie-driven recompiles into batched rule
 *           |  writes to the browser.
 *  How      |  Every Set-Cookie dirties a session; recompiling on each
 *           |  would call updateSessionRules hundreds of times per page
 *           |  load, so writes are debounced.
 *  Note     |  Hard exception: a stale rule during a top level
 *           |  navigation is the one case that logs you out, so
 *           |  navigation forces an immediate flush and waits for it.
 *  Author   |  Ojas Kekre, 19/08/2026
 * ------------------------------------------------------------------
 */

import { compileHost, compileSession, COOKIE_RULE_POOL, defaultScheme, RULE_ID_STRIDE, RULES_PER_SESSION, RuleIds } from '../netfilter/compile.js';
import type { CompileOptions, SessionView } from '../netfilter/types.js';
import type { ApplyReport, DnrBackend } from '../netfilter/dnr.js';
import { Registry, type SessionId } from './registry.js';

/** Fast-path rule ids, far above every session block. */
const PATCH_ID_BASE = 50_000_000;
const PATCH_CAPACITY = 150;
/** Above any host rule, whose priority tops out at 1000. */
const PATCH_PRIORITY_LIFT = 2000;

export interface EngineOptions extends CompileOptions {
  /** Trailing debounce. Long enough to absorb a page load's cookie burst. */
  debounceMs?: number;
  /** Ceiling on coalescing, so a slow trickle still lands. */
  maxWaitMs?: number;
  onReport?: (report: ApplyReport & { sessions: SessionId[] }) => void;
  onOverflow?: (sessionId: SessionId, domains: string[]) => void;
  /**
   * How long a flush that had work took, and whether it landed. A callback
   * rather than an import, so the kernel stays free of the telemetry module;
   * the worker turns it into the daily perf rollup and the flush_failed fault.
   */
  onFlushed?: (ms: number, ok: boolean) => void;
  /**
   * Whether to compile anything at all.
   *
   * False is the pause switch, and it is checked here rather than at the twenty
   * call sites that dirty a session because this is the one place every rule
   * has to pass through. A paused kernel compiles no rules and withdraws the
   * ones it has, so every managed tab returns to being an ordinary tab using
   * the browser's own jar, which is the state somebody wants when a site has
   * started behaving strangely and they need to know whether this is why.
   *
   * The sessions and their jars are untouched, so unpausing puts everything
   * back. That is the difference between this and uninstalling, and it is the
   * reason it can be the first thing to try rather than the last.
   */
  enabled?: () => boolean;
  /**
   * Whether to compile in strict (fail-closed) mode, resolved per flush.
   *
   * The compiler takes `strict` as a static boolean, but the answer here depends
   * on a setting and a licence that can both change while the worker is alive, so
   * this is a function read at flush time and folded onto the compile options.
   * Absent, the static `strict` stands.
   */
  strictWhen?: () => boolean;
  /** Whether to compile with per-session cache suppression, resolved per flush, like strictWhen. */
  cacheWhen?: () => boolean;
}

export class Engine {
  private readonly ids = new RuleIds();
  private readonly dirty = new Set<SessionId>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt = 0;
  private inFlight: Promise<void> | null = null;
  /** Rule ids a previous worker installed, withdrawn by the next flush. */
  private readonly leftover: number[] = [];
  /** Fast-path rules standing in for a host until the next full compile. */
  private readonly patches = new Map<SessionId, { ids: number[]; at: number }[]>();
  private patchCursor = 0;
  private readonly patchesInFlight = new Set<Promise<unknown>>();
  private lastBudget = 0;
  /** Flushes started and not yet finished, so a caller can tell a race from a leak. */
  private running = 0;
  /** Rules each session compiled to on its last full compile. */
  private readonly ruleCounts = new Map<SessionId, number>();
  /** Pending recompiles for rules that go stale on their own. */
  private readonly expiries = new Map<SessionId, { at: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly registry: Registry,
    private readonly backend: DnrBackend,
    private readonly opts: EngineOptions = {}
  ) {}

  private get debounceMs(): number {
    return this.opts.debounceMs ?? 40;
  }

  private get maxWaitMs(): number {
    return this.opts.maxWaitMs ?? 250;
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Re-dirty a session when one of its rules stops being
   *           |  true on its own.
   *  How      |  A rule is believed until something changes, which is
   *           |  fine for every input except time. A defaulted-Lax
   *           |  cookie is carried cross-site for two minutes then must
   *           |  not be, and nothing else on an idle tab says so.
   * ------------------------------------------------------------------
   */
  private expireAt(id: SessionId, at: number): void {
    const existing = this.expiries.get(id);
    if (existing) {
      if (existing.at <= at) return;
      clearTimeout(existing.timer);
    }
    const delay = Math.max(0, at - Date.now());
    const timer = setTimeout(() => {
      this.expiries.delete(id);
      this.markDirty([id]);
    }, delay);
    // Node keeps the process alive for a pending timer; a browser does not care
    // either way, and the tests would hang without this.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.expiries.set(id, { at, timer });
  }

  markDirty(sessions: Iterable<SessionId>): void {
    let added = false;
    for (const id of sessions) {
      if (!this.dirty.has(id)) {
        this.dirty.add(id);
        added = true;
      }
    }
    if (!added && this.timer) return;
    if (this.dirty.size === 0) return;
    this.schedule();
  }

  private schedule(): void {
    const now = Date.now();
    if (this.firstDirtyAt === 0) this.firstDirtyAt = now;

    // Past the ceiling the debounce stops extending, otherwise a steady
    // trickle of cookies would postpone the flush indefinitely.
    if (now - this.firstDirtyAt >= this.maxWaitMs) {
      void this.flush();
      return;
    }

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Force a flush and resolve once the rules are actually
   *           |  in the browser.
   *  Note     |  Callers awaiting this before releasing a navigation
   *           |  are why the design needs no reconcile fallback.
   * ------------------------------------------------------------------
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Overlapping flushes would compute rules from a registry snapshot that
    // the earlier flush is still writing. Chaining keeps the last writer
    // authoritative.
    const run = async () => {
      const sessions = [...this.dirty];
      this.dirty.clear();
      this.firstDirtyAt = 0;
      if (!sessions.length) return;
      const startedAt = Date.now();
      this.running += 1;
      try {
        await this.compileAndApply(sessions);
        this.opts.onFlushed?.(Date.now() - startedAt, true);
      } catch (e) {
        this.opts.onFlushed?.(Date.now() - startedAt, false);
        throw e;
      } finally {
        this.running -= 1;
      }
    };
    const next = this.inFlight ? this.inFlight.then(run, run) : run();
    this.inFlight = next.catch(() => undefined);
    return next;
  }

  /** Whether rules are being written right now, by a flush or a fast-path patch. */
  get busy(): boolean {
    return this.running > 0 || this.patchesInFlight.size > 0 || this.dirty.size > 0;
  }

  /** Fast-path patch rules currently installed. */
  get patchRules(): number {
    let n = 0;
    for (const list of this.patches.values()) for (const p of list) n += p.ids.length;
    return n;
  }

  /** The most rules any one session compiled to, as of each session's last compile. */
  get maxSessionRules(): number {
    let n = 0;
    for (const c of this.ruleCounts.values()) n = Math.max(n, c);
    return n;
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Withdraw rules a previous worker installed in the same
   *           |  update that installs this worker's.
   *  Why      |  Clearing them first and rebuilding a few awaits later
   *           |  left every managed tab with no rule in between, and the
   *           |  worker is usually woken by exactly the request that then
   *           |  went out carrying the browser's own cookies. Removals and
   *           |  additions in one update are atomic in the browser.
   * ------------------------------------------------------------------
   */
  replaceOnNextFlush(ids: Iterable<number>): void {
    this.leftover.push(...ids);
  }

  private async compileAndApply(sessions: SessionId[]): Promise<void> {
    const rules = [];
    const removeIds: number[] = [];

    const live = this.opts.enabled?.() ?? true;
    // Resolved once per flush, so every session in this batch compiles under the
    // same posture and a mid-flush change cannot split the batch.
    let compileOpts: CompileOptions =
      this.opts.strictWhen || this.opts.cacheWhen
        ? {
            ...this.opts,
            ...(this.opts.strictWhen ? { strict: this.opts.strictWhen() } : {}),
            ...(this.opts.cacheWhen ? { cacheIsolation: this.opts.cacheWhen() } : {}),
          }
        : this.opts;

    // The pool is split between the sessions that have tabs, since a session
    // with none installs nothing. A fixed share of 320 ran a session signed
    // into Google, Microsoft and AWS out of rules, and the host dropped was the
    // AWS console region its sign-in returned to. When the share changes,
    // every session with tabs recompiles in this same update, so the total
    // never passes the ceiling in between.
    const withTabs = this.registry.listSessions().filter((s) => this.registry.tabsFor(s.id).length).map((s) => s.id);
    const budget = Math.min(
      Math.max(Math.floor(COOKIE_RULE_POOL / Math.max(withTabs.length, 1)), RULES_PER_SESSION),
      RULE_ID_STRIDE
    );
    if (budget !== this.lastBudget) {
      this.lastBudget = budget;
      sessions = [...new Set([...sessions, ...withTabs])];
    }
    compileOpts = { ...compileOpts, budget };

    const startedAt = Date.now();
    for (const id of sessions) {
      // A full compile carries everything a patch carried, as long as it began
      // after the patch's cookie was stored.
      removeIds.push(...this.takePatches(id, startedAt));
      const session = live ? this.registry.getSession(id) : undefined;
      if (!session) {
        // Deleted mid-flight, or paused. Either way its rules must be
        // withdrawn, or they keep rewriting headers for tabs that no longer
        // belong to anything, or that the user has just asked to be left alone.
        removeIds.push(...this.takePatches(id, Infinity));
        removeIds.push(...this.ids.releaseSession(id));
        this.ruleCounts.delete(id);
        continue;
      }

      const { view, sessionOpts } = this.viewFor(id, session, compileOpts);
      const compiled = compileSession(view, this.ids, undefined, sessionOpts);
      this.ruleCounts.set(id, compiled.rules.length);
      rules.push(...compiled.rules);
      removeIds.push(...compiled.removeIds);

      if (compiled.overflowed.length) {
        this.opts.onOverflow?.(id, compiled.overflowed);
      }
      // Loud, because a host that could not be compiled is a host whose cookies
      // are not being carried, and the symptom of that is a site behaving as
      // though the extension were not installed rather than anything that looks
      // like an error.
      if (compiled.skipped.length) {
        for (const s of compiled.skipped) {
          console.error(`[nvx] could not compile rules for ${s.host} in ${id}: ${s.reason}`);
        }
      }
      if (compiled.expiresAt !== null) this.expireAt(id, compiled.expiresAt);
    }

    removeIds.push(...this.leftover.splice(0));
    const report = await this.backend.applyReporting(rules, removeIds);
    this.opts.onReport?.({ ...report, sessions });
  }

  private viewFor(
    id: SessionId,
    session: NonNullable<ReturnType<Registry['getSession']>>,
    compileOpts: CompileOptions
  ): { view: SessionView; sessionOpts: CompileOptions } {
    const view: SessionView = {
      id,
      tabIds: this.registry.tabsFor(id),
      // No worker rules. A managed page is refused a worker, so the only
      // tabless traffic on an origin is the profile's, and a session's
      // cookies on it leaked that session out of its tabs.
      serviceWorkerOrigins: [],
      activeHosts: this.registry.hostsFor(id),
      blockThirdParty: session.thirdParty === 'block',
      allowedParties: session.allowedParties ?? [],
      store: session.store,
    };
    // A host this session is on over plain http gets http-anchored rules.
    const http = new Set(this.registry.httpHostsFor(id));
    const sessionOpts: CompileOptions = http.size
      ? { ...compileOpts, schemeFor: (h: string) => (http.has(h) ? 'http:' : (compileOpts.schemeFor ?? defaultScheme)(h)) }
      : compileOpts;
    return { view, sessionOpts };
  }

  private takePatches(id: SessionId, before: number): number[] {
    const list = this.patches.get(id);
    if (!list) return [];
    const gone = list.filter((p) => p.at < before);
    const kept = list.filter((p) => p.at >= before);
    if (kept.length) this.patches.set(id, kept);
    else this.patches.delete(id);
    return gone.flatMap((p) => p.ids);
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Put a cookie a tab was just handed into the rules for
   *           |  that one host, now, ahead of the full compile.
   *  Why      |  A full compile rewrites every rule the session has,
   *           |  hundreds for a session signed into Google, and a sign-in
   *           |  page that sets a cookie from one fetch and sends the next
   *           |  a few milliseconds later beat it every time: AWS's
   *           |  sign-in answered "your session has expired". A handful
   *           |  of rules for one host lands far sooner. They sit above
   *           |  the host's own rules and are dropped by the next full
   *           |  compile, which carries the same cookies.
   * ------------------------------------------------------------------
   */
  async patch(id: SessionId, hosts: string[]): Promise<void> {
    const session = this.registry.getSession(id);
    if (!session || !(this.opts.enabled?.() ?? true) || !hosts.length) return;
    const at = Date.now();
    const { view, sessionOpts } = this.viewFor(id, session, this.opts);
    const rules = [];
    for (const host of new Set(hosts)) {
      try {
        const compiled = compileHost(view, host, () => PATCH_ID_BASE + (this.patchCursor++ % PATCH_CAPACITY), sessionOpts);
        for (const r of compiled.rules) rules.push({ ...r, priority: r.priority + PATCH_PRIORITY_LIFT });
      } catch {
        /* the full compile reports a host it cannot make sense of */
      }
    }
    if (!rules.length) return;
    const ids = rules.map((r) => r.id);
    // A slot reused from an older patch belongs to this one now.
    for (const [sid, list] of this.patches) {
      const pruned = list.map((p) => ({ ...p, ids: p.ids.filter((x) => !ids.includes(x)) })).filter((p) => p.ids.length);
      if (pruned.length) this.patches.set(sid, pruned);
      else this.patches.delete(sid);
    }
    const list = this.patches.get(id) ?? [];
    list.push({ ids, at });
    this.patches.set(id, list);
    const applying = this.backend.apply(rules, ids).catch(() => undefined);
    this.patchesInFlight.add(applying);
    await applying;
    this.patchesInFlight.delete(applying);
  }

  /**
   * Resolves once every rule already owed is in the browser: fast-path patches
   * in flight, then whatever the full compile has pending. A page that is about
   * to send something it cannot send twice waits on this.
   */
  async settle(): Promise<void> {
    // Only the fast path. Every cookie a managed tab is handed is patched in,
    // so waiting on the patches is enough for that tab, and waiting on a full
    // compile as well would put a whole-session rebuild in front of a page's
    // ordinary requests.
    await Promise.all([...this.patchesInFlight]);
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Withdraw a session's rules.
   *  How      |  Chained behind any running flush. Retiring out of band
   *           |  would let an in-flight compile re-add the very rules
   *           |  being withdrawn, leaving a deleted session still
   *           |  rewriting headers.
   * ------------------------------------------------------------------
   */
  async retire(sessionId: SessionId): Promise<void> {
    const run = async () => {
      this.dirty.delete(sessionId);
      const expiry = this.expiries.get(sessionId);
      if (expiry) {
        clearTimeout(expiry.timer);
        this.expiries.delete(sessionId);
      }
      const ids = [...this.takePatches(sessionId, Infinity), ...this.ids.releaseSession(sessionId)];
      if (ids.length) await this.backend.apply([], ids);
    };
    const next = this.inFlight ? this.inFlight.then(run, run) : run();
    this.inFlight = next.catch(() => undefined);
    return next;
  }

  get pending(): number {
    return this.dirty.size;
  }
}
