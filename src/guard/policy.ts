/**
 * ------------------------------------------------------------------
 *  Title    |  Danger level to decision and rules
 *  Ref      |  catalog.ts, guard.ts, audit.ts, netfilter/types.ts
 *  ID       |  M3 (guard)
 * ------------------------------------------------------------------
 *  Purpose  |  Turn a session's danger level into a decision, and into
 *           |  block rules.
 *  How      |  Warn and log by default, refuse only where the user
 *           |  marked a production account. Block by default gets
 *           |  switched off; log only never stops the incident.
 *  Note     |  Pure, so the ordering and rule shapes are testable
 *           |  without a browser.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

import type { Rule } from '../netfilter/types.js';
import { blockable, classify, type Finding, type GuardEntry } from './catalog.js';
import type { Action } from './audit.js';

export type Danger = 'off' | 'warn' | 'block';

export const DEFAULT_DANGER: Danger = 'warn';

export function cleanDanger(raw: unknown): Danger {
  return raw === 'off' || raw === 'block' ? raw : DEFAULT_DANGER;
}

export interface Decision {
  finding: Finding;
  action: Action;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  What to do about a request at a given danger level.
 *  Note     |  notable never warns or blocks whatever the level; it is
 *           |  every DELETE on the web, recorded only so the trail is
 *           |  complete.
 * ------------------------------------------------------------------
 */
export function decide(
  request: { url: string; method: string },
  danger: Danger,
  catalog?: readonly GuardEntry[]
): Decision | null {
  const finding = classify(request, catalog);
  if (!finding) return null;
  if (finding.severity === 'notable') return { finding, action: 'logged' };
  if (danger === 'off') return { finding, action: 'logged' };
  return { finding, action: danger === 'block' ? 'blocked' : 'warned' };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Guard rule ids live below the session block base, in
 *           |  their own band.
 *  Note     |  Sharing the session's block would let a session with
 *           |  many hosts silently lose its guardrails to cookies: the
 *           |  isolating rules stay, the protecting ones do not.
 * ------------------------------------------------------------------
 */
export const GUARD_ID_BASE = 100;
export const GUARD_RULES_PER_SESSION = 32;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Where the session rule band starts; the guard's band
 *           |  sits below it.
 *  Note     |  The two must not meet: a guard rule landing on a cookie
 *           |  rule's id would replace it, and that session would stop
 *           |  isolating with nothing saying so. The worst failure
 *           |  here, from the feature meant to prevent bad outcomes.
 * ------------------------------------------------------------------
 */
export const GUARD_CAPACITY = Math.floor((1000 - GUARD_ID_BASE) / GUARD_RULES_PER_SESSION);

/** True while a slot's ids stay inside the guard's own band. */
export function guardSlotFits(slot: number): boolean {
  return slot >= 0 && slot < GUARD_CAPACITY;
}

export function guardIdsFor(slot: number): number[] {
  if (!guardSlotFits(slot)) return [];
  const base = GUARD_ID_BASE + slot * GUARD_RULES_PER_SESSION;
  return Array.from({ length: GUARD_RULES_PER_SESSION }, (_, i) => base + i);
}

export interface GuardCompileInput {
  sessionId: string;
  slot: number;
  danger: Danger;
  tabIds: number[];
  /** Entry ids temporarily allowed, with the moment the allowance lapses. */
  unlocked?: Record<string, number>;
  now?: number;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The block rules for one session.
 *  Note     |  Scoped to the session's own tabs, never [-1]: a request
 *           |  with no tab has no confirmable owner, and refusing a
 *           |  worker's request breaks the page with nothing to act
 *           |  on.
 * ------------------------------------------------------------------
 */
export function compileGuard(
  input: GuardCompileInput,
  catalog?: readonly GuardEntry[]
): { rules: Rule[]; removeIds: number[]; dropped: string[]; overCapacity?: true } {
  // Past the band, nothing is installed and nothing is withdrawn. Emitting
  // rules here would put them on top of a session's cookie rules and silently
  // stop that session isolating, which is far worse than a session that is
  // watched and logged but not refused.
  if (!guardSlotFits(input.slot)) {
    return { rules: [], removeIds: [], dropped: [], overCapacity: true };
  }

  const removeIds = guardIdsFor(input.slot);
  if (input.danger !== 'block' || !input.tabIds.length) {
    return { rules: [], removeIds, dropped: [] };
  }

  const now = input.now ?? Date.now();
  const unlocked = input.unlocked ?? {};
  const rules: Rule[] = [];
  const dropped: string[] = [];
  let next = GUARD_ID_BASE + input.slot * GUARD_RULES_PER_SESSION;
  const limit = next + GUARD_RULES_PER_SESSION;

  for (const entry of blockable(catalog)) {
    if ((unlocked[entry.id] ?? 0) > now) continue;
    if (next >= limit) {
      dropped.push(entry.id);
      continue;
    }
    rules.push({
      id: next++,
      // Above the cookie rules, which is not a contest DNR actually runs, but
      // it makes the intent legible to anyone reading the installed set.
      priority: 100,
      action: { type: 'block' },
      condition: {
        regexFilter: entry.url,
        requestMethods: entry.methods.map((m) => m.toLowerCase()),
        tabIds: [...input.tabIds],
      },
    });
  }

  return { rules, removeIds, dropped };
}

