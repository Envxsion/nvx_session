/**
 * ------------------------------------------------------------------
 *  Title    |  declarativeNetRequest backend
 *  Ref      |  types.ts, compile.ts, blocking.ts
 *  ID       |  M2 (netfilter)
 * ------------------------------------------------------------------
 *  Purpose  |  Install compiled rules into the browser atomically and
 *           |  in order.
 *  Note     |  The failures that matter are quiet: a rejected batch
 *           |  keeps stale rules (a managed tab sends a stale
 *           |  identity), an overflow drops rules (the profile jar
 *           |  leaks). Both are silent unless this layer reports them.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

import type { NetFilterBackend, Rule } from './types.js';

export interface DnrApi {
  updateSessionRules(opts: { addRules?: Rule[]; removeRuleIds?: number[] }): Promise<void>;
  getSessionRules(): Promise<Rule[]>;
  readonly maxRules: number;
}

export interface ApplyReport {
  added: number;
  removed: number;
  /** Rules the browser refused, paired with why. Never silently discarded. */
  rejected: { rule: Rule; error: string }[];
  /** Rules dropped because the batch exceeded the platform ceiling. */
  dropped: Rule[];
  ms: number;
}

export class RuleLimitExceeded extends Error {
  constructor(
    readonly requested: number,
    readonly max: number
  ) {
    super(`rule batch of ${requested} exceeds the ceiling of ${max}`);
    this.name = 'RuleLimitExceeded';
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Drop duplicate rule ids before an update.
 *  Note     |  Chrome rejects duplicate ids in one call, and the
 *           |  compiler can emit the same id twice across a recompile
 *           |  of two domains. Last write wins, matching emit order.
 * ------------------------------------------------------------------
 */
export function dedupeById(rules: Rule[]): Rule[] {
  const byId = new Map<number, Rule>();
  for (const r of rules) byId.set(r.id, r);
  return [...byId.values()];
}

export class DnrBackend implements NetFilterBackend {
  readonly name = 'dnr' as const;

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Every apply is chained.
   *  Note     |  Two overlapping flushes would interleave remove and
   *           |  add phases, and since remove runs first, the loser's
   *           |  additions can be erased by the winner's removals.
   * ------------------------------------------------------------------
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly api: DnrApi) {}

  capacity(): number {
    return this.api.maxRules;
  }

  current(): Promise<Rule[]> {
    return this.api.getSessionRules();
  }

  apply(rules: Rule[], removeIds: number[]): Promise<void> {
    return this.applyReporting(rules, removeIds).then(() => undefined);
  }

  applyReporting(rules: Rule[], removeIds: number[]): Promise<ApplyReport> {
    const run = () => this.doApply(rules, removeIds);
    const next = this.tail.then(run, run);
    // A failed apply must not poison the chain for every later flush.
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async doApply(rules: Rule[], removeIds: number[]): Promise<ApplyReport> {
    const started = Date.now();
    const unique = dedupeById(rules);
    const removals = [...new Set(removeIds)];
    const dropped: Rule[] = [];

    let addRules = unique;
    if (unique.length > this.api.maxRules) {
      addRules = unique.slice(0, this.api.maxRules);
      dropped.push(...unique.slice(this.api.maxRules));
    }

    // Nothing to do is common during idle periods; skipping avoids waking the
    // rule engine for no reason.
    if (!addRules.length && !removals.length) {
      return { added: 0, removed: 0, rejected: [], dropped, ms: 0 };
    }

    try {
      await this.api.updateSessionRules({ addRules, removeRuleIds: removals });
      return {
        added: addRules.length,
        removed: removals.length,
        rejected: [],
        dropped,
        ms: Date.now() - started,
      };
    } catch (err) {
      // Removals are applied on their own before bisecting. Folding them into
      // the first half meant that when the first half was the failing one, the
      // removals were never applied at all and stale rules stayed live.
      if (removals.length) {
        try {
          await this.api.updateSessionRules({ removeRuleIds: removals });
        } catch {
          /* nothing further to do; the add failure is the one reported */
        }
      }
      const rejected = await this.isolate(addRules, err);
      return {
        added: addRules.length - rejected.length,
        removed: removals.length,
        rejected,
        dropped,
        ms: Date.now() - started,
      };
    }
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Bisect a rejected batch to name the rule at fault.
   *  How      |  A batch is atomic, so one bad rule rejects the lot
   *           |  and the error names a constraint, not an id.
   *  Note     |  Only runs on the error path, so the cost is paid once
   *           |  per bad rule. The alternative is a session that
   *           |  silently stops isolating with no indication why.
   * ------------------------------------------------------------------
   */
  private async isolate(
    rules: Rule[],
    original: unknown
  ): Promise<{ rule: Rule; error: string }[]> {
    if (rules.length === 0) {
      return [];
    }
    if (rules.length === 1) {
      return [{ rule: rules[0]!, error: message(original) }];
    }

    const mid = Math.floor(rules.length / 2);
    const bad: { rule: Rule; error: string }[] = [];

    for (const half of [rules.slice(0, mid), rules.slice(mid)]) {
      try {
        await this.api.updateSessionRules({ addRules: half });
      } catch (err) {
        bad.push(...(await this.isolate(half, err)));
      }
    }
    return bad;
  }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Adapt the live browser API to the injectable surface.
 *  Note     |  Returns an inert one when declarativeNetRequest is
 *           |  absent (the MV2 build, where blocking does the work).
 *  Bug-Fix  |  Reaching for the namespace unguarded threw at module
 *           |  scope and took the background page down, presenting as
 *           |  an extension that loaded and then did nothing.
 * ------------------------------------------------------------------
 */
export function browserDnrApi(): DnrApi {
  const dnr = (chrome as { declarativeNetRequest?: typeof chrome.declarativeNetRequest })
    .declarativeNetRequest;
  if (!dnr) {
    return {
      maxRules: 0,
      async updateSessionRules() {
        /* no rule engine here */
      },
      async getSessionRules() {
        return [];
      },
    };
  }
  return {
    maxRules: dnr.MAX_NUMBER_OF_SESSION_RULES ?? 5000,
    async updateSessionRules(opts) {
      await dnr.updateSessionRules(
        opts as unknown as chrome.declarativeNetRequest.UpdateRuleOptions
      );
    },
    async getSessionRules() {
      return (await dnr.getSessionRules()) as unknown as Rule[];
    },
  };
}
