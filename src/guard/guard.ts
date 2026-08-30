/**
 * ------------------------------------------------------------------
 *  Title    |  The guard at runtime
 *  Ref      |  policy.ts, catalog.ts, audit.ts, netfilter/types.ts
 *  ID       |  M3 (guard)
 * ------------------------------------------------------------------
 *  Purpose  |  Hold the audit trail, decide what happens to a request,
 *           |  and keep block rules in step with their tabs.
 *  Note     |  Slot allocation is its own, in its own id band: sharing
 *           |  the session block would let a session with many hosts
 *           |  spend its guardrails on cookies, and that failure would
 *           |  be invisible in exactly the wrong direction.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

import type { Rule } from '../netfilter/types.js';
import { AuditLog, type AuditEntry } from './audit.js';
import type { GuardEntry } from './catalog.js';
import {
  cleanDanger,
  compileGuard,
  decide,
  guardIdsFor,
  guardSlotFits,
  type Danger,
  type Decision,
} from './policy.js';

export interface GuardBackend {
  apply(rules: Rule[], removeIds: number[]): Promise<void>;
}

export interface GuardSession {
  id: string;
  label: string;
  danger: Danger;
  tabIds: number[];
}

/** How long a "let it through this once" allowance lasts. */
export const UNLOCK_MS = 5 * 60 * 1000;

export class Guard {
  readonly audit = new AuditLog();
  private readonly slots = new Map<string, number>();
  private readonly free: number[] = [];
  private nextSlot = 0;
  /** sessionId to entry id to expiry. Deliberately not persisted. */
  private readonly unlocks = new Map<string, Record<string, number>>();
  private readonly dirty = new Set<string>();

  constructor(
    private readonly backend: GuardBackend,
    private readonly sessionsFor: () => GuardSession[],
    private readonly catalog?: readonly GuardEntry[],
    /** Told which sessions could not be given rules, so it is never silent. */
    private readonly onOverCapacity?: (sessionIds: string[]) => void
  ) {}

  private slotFor(sessionId: string): number {
    let slot = this.slots.get(sessionId);
    if (slot === undefined) {
      slot = this.free.pop() ?? this.nextSlot++;
      this.slots.set(sessionId, slot);
    }
    return slot;
  }

  /** Sessions that can hold block rules at once. Reported, never guessed at. */
  capacity(): number {
    let n = 0;
    for (const slot of this.slots.values()) if (guardSlotFits(slot)) n++;
    return n;
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  What to do about a request, and the audit row it
   *           |  produced.
   *  Note     |  Null for the overwhelming majority of traffic: this
   *           |  runs on every request, so the common path is one
   *           |  method check and a few failed regex tests.
   * ------------------------------------------------------------------
   */
  note(
    request: { url: string; method: string },
    session: { id: string; label: string; danger: Danger } | null,
    now = Date.now()
  ): { decision: Decision; entry: AuditEntry } | null {
    const danger = session ? cleanDanger(session.danger) : 'off';
    const decision = decide(request, danger, this.catalog);
    if (!decision) return null;

    // A temporarily allowed endpoint is not a non-event: it is recorded, and
    // recorded as allowed, because "I let that one through" is exactly the kind
    // of thing you want to find later.
    const allowed = session ? (this.unlocks.get(session.id)?.[decision.finding.entry.id] ?? 0) : 0;
    const action = decision.action === 'blocked' && allowed > now ? 'warned' : decision.action;

    const entry = this.audit.add({
      at: now,
      sessionId: session?.id ?? '',
      sessionLabel: session?.label ?? 'unmanaged',
      method: request.method.toUpperCase(),
      url: request.url,
      rule: decision.finding.entry.id,
      what: decision.finding.entry.what,
      severity: decision.finding.severity,
      action,
    });

    return { decision: { ...decision, action }, entry };
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Let one endpoint through for this session for a few
   *           |  minutes.
   *  Note     |  In memory only: a terminated worker loses the
   *           |  allowance, putting the guard back on rather than
   *           |  leaving a session unprotected. The right way to fail.
   * ------------------------------------------------------------------
   */
  unlock(sessionId: string, entryId: string, ms = UNLOCK_MS, now = Date.now()): number {
    const map = this.unlocks.get(sessionId) ?? {};
    map[entryId] = now + ms;
    this.unlocks.set(sessionId, map);
    this.dirty.add(sessionId);
    return map[entryId]!;
  }

  unlocksFor(sessionId: string, now = Date.now()): Array<{ rule: string; until: number }> {
    const map = this.unlocks.get(sessionId) ?? {};
    return Object.entries(map)
      .filter(([, until]) => until > now)
      .map(([rule, until]) => ({ rule, until }));
  }

  markDirty(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) this.dirty.add(id);
  }

  markAllDirty(): void {
    for (const s of this.sessionsFor()) this.dirty.add(s.id);
  }

  /** Recompiles every dirty session's block rules and installs them. */
  async flush(now = Date.now()): Promise<{
    installed: number;
    dropped: string[];
    unguarded: string[];
  }> {
    if (!this.dirty.size) return { installed: 0, dropped: [], unguarded: [] };
    const wanted = [...this.dirty];
    this.dirty.clear();

    const live = new Map(this.sessionsFor().map((s) => [s.id, s]));
    const rules: Rule[] = [];
    const removeIds: number[] = [];
    const dropped: string[] = [];
    const unguarded: string[] = [];

    for (const id of wanted) {
      const session = live.get(id);
      if (!session) {
        removeIds.push(...this.releaseSlot(id));
        continue;
      }
      const out = compileGuard(
        {
          sessionId: id,
          slot: this.slotFor(id),
          danger: cleanDanger(session.danger),
          tabIds: session.tabIds,
          unlocked: this.unlocks.get(id) ?? {},
          now,
        },
        this.catalog
      );
      if (out.overCapacity) unguarded.push(id);
      rules.push(...out.rules);
      removeIds.push(...out.removeIds);
      dropped.push(...out.dropped);
    }

    if (rules.length || removeIds.length) await this.backend.apply(rules, removeIds);
    if (unguarded.length) this.onOverCapacity?.(unguarded);
    return { installed: rules.length, dropped, unguarded };
  }

  private releaseSlot(sessionId: string): number[] {
    const slot = this.slots.get(sessionId);
    if (slot === undefined) return [];
    this.slots.delete(sessionId);
    this.free.push(slot);
    this.unlocks.delete(sessionId);
    return guardIdsFor(slot);
  }

  async retire(sessionId: string): Promise<void> {
    this.dirty.delete(sessionId);
    const ids = this.releaseSlot(sessionId);
    if (ids.length) await this.backend.apply([], ids);
  }

  /** Every guard id this instance could have installed, for a cold-start clear. */
  allIds(): number[] {
    const out: number[] = [];
    for (const slot of this.slots.values()) out.push(...guardIdsFor(slot));
    return out;
  }
}
