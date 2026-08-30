/**
 * The declarativeNetRequest backend.
 *
 * Everything the compiler produces has to get into the browser atomically and
 * in order. The failure modes that matter here are quiet ones: a rejected
 * batch leaves the previous rules in place, which means a managed tab keeps
 * sending a stale identity, and an overflowing batch drops rules whose absence
 * lets the profile jar through. Both are silent unless this layer reports them.
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
 * Duplicate ids in one call are rejected outright by Chrome, and the compiler
 * can legitimately produce the same id twice across a recompile of two
 * domains. Last write wins, matching the order the compiler emitted them.
 */
export function dedupeById(rules: Rule[]): Rule[] {
  const byId = new Map<number, Rule>();
  for (const r of rules) byId.set(r.id, r);
  return [...byId.values()];
}

export class DnrBackend implements NetFilterBackend {
  readonly name = 'dnr' as const;

  /**
   * Every apply is chained. Two overlapping flushes would interleave their
   * remove and add phases, and because remove runs first inside a single call,
   * the loser's additions can be erased by the winner's removals.
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
   * A batch is atomic, so one malformed rule rejects the lot and the error
   * names a constraint rather than an id. Bisecting is the only way to learn
   * which rule was at fault, and it matters: the alternative is a session that
   * silently stops isolating with no indication why.
   *
   * Only runs on the error path, so the cost is paid once per bad rule.
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
 * Adapts the live browser API to the injectable surface used above.
 *
 * Returns an inert one when declarativeNetRequest is absent, which is the MV2
 * build: there the blocking backend does the work and nothing ever calls this.
 * Reaching for the namespace unguarded threw at module scope and took the whole
 * background page down with it, which presents as an extension that loaded and
 * then did nothing at all.
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
