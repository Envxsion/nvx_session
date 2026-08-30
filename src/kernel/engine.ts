/**
 * The flush loop.
 *
 * Every Set-Cookie dirties a session. Recompiling on each one would call
 * updateSessionRules hundreds of times during a single page load, so writes
 * are coalesced. But coalescing has a hard exception: a stale rule during a
 * top level navigation is the one case that logs you out, so navigation forces
 * an immediate flush and waits for it.
 */

import { compileSession, RuleIds } from '../netfilter/compile.js';
import type { CompileOptions, SessionView } from '../netfilter/types.js';
import type { ApplyReport, DnrBackend } from '../netfilter/dnr.js';
import { Registry, type SessionId } from './registry.js';

export interface EngineOptions extends CompileOptions {
  /** Trailing debounce. Long enough to absorb a page load's cookie burst. */
  debounceMs?: number;
  /** Ceiling on coalescing, so a slow trickle still lands. */
  maxWaitMs?: number;
  onReport?: (report: ApplyReport & { sessions: SessionId[] }) => void;
  onOverflow?: (sessionId: SessionId, domains: string[]) => void;
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
   * Re-dirties a session at the moment one of its rules stops being true.
   *
   * A rule is compiled once and then believed until something changes, which is
   * fine for every input except time. A defaulted-Lax cookie is carried on a
   * cross-site POST for two minutes and then must not be, and nothing else is
   * going to happen to say so on a tab the user has left sitting there.
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
   * Forces a flush and resolves once the rules are actually in the browser.
   * Callers awaiting this before releasing a navigation are the reason the
   * whole design does not need the reconcile fallback.
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
      await this.compileAndApply(sessions);
    };
    const next = this.inFlight ? this.inFlight.then(run, run) : run();
    this.inFlight = next.catch(() => undefined);
    return next;
  }

  private async compileAndApply(sessions: SessionId[]): Promise<void> {
    const rules = [];
    const removeIds: number[] = [];

    const live = this.opts.enabled?.() ?? true;
    // Resolved once per flush, so every session in this batch compiles under the
    // same posture and a mid-flush change cannot split the batch.
    const compileOpts: CompileOptions =
      this.opts.strictWhen || this.opts.cacheWhen
        ? {
            ...this.opts,
            ...(this.opts.strictWhen ? { strict: this.opts.strictWhen() } : {}),
            ...(this.opts.cacheWhen ? { cacheIsolation: this.opts.cacheWhen() } : {}),
          }
        : this.opts;

    for (const id of sessions) {
      const session = live ? this.registry.getSession(id) : undefined;
      if (!session) {
        // Deleted mid-flight, or paused. Either way its rules must be
        // withdrawn, or they keep rewriting headers for tabs that no longer
        // belong to anything, or that the user has just asked to be left alone.
        removeIds.push(...this.ids.releaseSession(id));
        continue;
      }

      const view: SessionView = {
        id,
        tabIds: this.registry.tabsFor(id),
        serviceWorkerOrigins: this.registry.serviceWorkerOriginsFor(id),
        activeHosts: this.registry.hostsFor(id),
        blockThirdParty: session.thirdParty === 'block',
        allowedParties: session.allowedParties ?? [],
        store: session.store,
      };

      const compiled = compileSession(view, this.ids, undefined, compileOpts);
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

    const report = await this.backend.applyReporting(rules, removeIds);
    this.opts.onReport?.({ ...report, sessions });
  }

  /**
   * Withdraws a session's rules.
   *
   * Chained behind any flush already running. Retiring out of band would let an
   * in-flight compile re-add the very rules being withdrawn, leaving a deleted
   * session still rewriting headers.
   */
  async retire(sessionId: SessionId): Promise<void> {
    const run = async () => {
      this.dirty.delete(sessionId);
      const expiry = this.expiries.get(sessionId);
      if (expiry) {
        clearTimeout(expiry.timer);
        this.expiries.delete(sessionId);
      }
      const ids = this.ids.releaseSession(sessionId);
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
