/**
 * ------------------------------------------------------------------
 *  Title    |  The audit trail
 *  Ref      |  catalog.ts, guard.ts
 *  ID       |  M3 (guard)
 * ------------------------------------------------------------------
 *  Purpose  |  Record which session hit which endpoint, bounded and
 *           |  persisted.
 *  Note     |  You ask the question after something has gone wrong, so
 *           |  it is recorded as it happens; a trail that does not
 *           |  survive the worker being terminated is not one. Pure:
 *           |  no browser APIs, no timers.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

import type { Severity } from './catalog.js';

export type Action = 'logged' | 'warned' | 'blocked';

export interface AuditEntry {
  at: number;
  sessionId: string;
  /** Copied rather than looked up later, so a deleted session still reads. */
  sessionLabel: string;
  method: string;
  url: string;
  /** The catalog entry id, so an old entry still names the rule that fired. */
  rule: string;
  what: string;
  severity: Severity;
  action: Action;
  /** How many identical events this row stands for. */
  count: number;
}

const DEFAULT_CAP = 250;
/** Two identical requests this close together are one action, not two. */
const COLLAPSE_MS = 4000;

export class AuditLog {
  private entries: AuditEntry[] = [];

  constructor(private readonly cap = DEFAULT_CAP) {}

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Record an event, collapsing an immediate repeat into
   *           |  the previous row.
   *  Note     |  A page retrying a failed DELETE three times is one
   *           |  thing that happened; without this, a retry loop
   *           |  buries the entry somebody is looking for.
   * ------------------------------------------------------------------
   */
  add(entry: Omit<AuditEntry, 'count'>): AuditEntry {
    const last = this.entries[this.entries.length - 1];
    if (
      last &&
      last.sessionId === entry.sessionId &&
      last.url === entry.url &&
      last.method === entry.method &&
      last.action === entry.action &&
      entry.at - last.at < COLLAPSE_MS
    ) {
      last.count++;
      last.at = entry.at;
      return last;
    }

    const row: AuditEntry = { ...entry, count: 1 };
    this.entries.push(row);
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - this.cap);
    }
    return row;
  }

  /** Newest first, which is the order anyone reads a log in. */
  recent(n = 50): AuditEntry[] {
    return this.entries.slice(-n).reverse();
  }

  all(): AuditEntry[] {
    return [...this.entries];
  }

  counts(): { total: number; blocked: number; warned: number } {
    let blocked = 0;
    let warned = 0;
    for (const e of this.entries) {
      if (e.action === 'blocked') blocked += e.count;
      else if (e.action === 'warned') warned += e.count;
    }
    return { total: this.entries.length, blocked, warned };
  }

  forSession(sessionId: string): AuditEntry[] {
    return this.entries.filter((e) => e.sessionId === sessionId);
  }

  clear(): void {
    this.entries = [];
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Restore from persisted state, dropping anything
   *           |  malformed rather than throwing.
   *  Note     |  A trail that refuses to load because one row is wrong
   *           |  loses the other two hundred.
   * ------------------------------------------------------------------
   */
  load(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const out: AuditEntry[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const e = r as Partial<AuditEntry>;
      if (typeof e.at !== 'number' || typeof e.url !== 'string') continue;
      out.push({
        at: e.at,
        sessionId: String(e.sessionId ?? ''),
        sessionLabel: String(e.sessionLabel ?? ''),
        method: String(e.method ?? ''),
        url: e.url,
        rule: String(e.rule ?? ''),
        what: String(e.what ?? ''),
        severity: e.severity === 'destructive' ? 'destructive' : 'notable',
        action: e.action === 'blocked' ? 'blocked' : e.action === 'warned' ? 'warned' : 'logged',
        count: typeof e.count === 'number' && e.count > 0 ? e.count : 1,
      });
    }
    this.entries = out.slice(-this.cap);
  }
}
