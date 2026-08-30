/**
 * Desync detection.
 *
 * Rule updates are asynchronous, so a request can leave between a cookie
 * changing and its rule landing. Rather than try to eliminate that, detect it:
 * compare the Cookie header a request actually carried against what the jar
 * says it should have carried, and report the difference.
 *
 * The counter this produces is the single number that says whether isolation
 * is working. It should sit at zero. Anything else is either a real leak or a
 * race worth understanding, and both are invisible without this.
 */

import type { EmitContext } from '../jar/emit.js';

export type DesyncKind =
  /** The request carried cookies the session does not hold. Worst case: this
   *  is the profile jar leaking into a managed tab. */
  | 'foreign'
  /** The session holds cookies the request did not carry. Usually a rule that
   *  had not landed yet. */
  | 'missing'
  /** Same names, different values. Almost always a rotation in flight. */
  | 'stale';

export interface DesyncEvent {
  kind: DesyncKind;
  url: string;
  tabId: number;
  sessionId: string;
  context: EmitContext;
  names: string[];
  at: number;
}

export interface Comparison {
  matched: boolean;
  events: Omit<DesyncEvent, 'url' | 'tabId' | 'sessionId' | 'context' | 'at'>[];
}

/**
 * Parses a Cookie request header into a name to value map. Duplicate names are
 * legal on the wire and the first occurrence is the one servers read, so later
 * duplicates are ignored rather than overwriting.
 */
export function parseCookieHeader(header: string | undefined | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    const name = seg.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    out.set(name, seg.slice(eq + 1).trim());
  }
  return out;
}

export function compare(sent: string | undefined | null, expected: string): Comparison {
  const a = parseCookieHeader(sent);
  const b = parseCookieHeader(expected);

  const foreign: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];

  for (const [name, value] of a) {
    if (!b.has(name)) foreign.push(name);
    else if (b.get(name) !== value) stale.push(name);
  }
  for (const name of b.keys()) {
    if (!a.has(name)) missing.push(name);
  }

  const events: Comparison['events'] = [];
  if (foreign.length) events.push({ kind: 'foreign', names: foreign.sort() });
  if (missing.length) events.push({ kind: 'missing', names: missing.sort() });
  if (stale.length) events.push({ kind: 'stale', names: stale.sort() });

  return { matched: events.length === 0, events };
}

export interface DesyncCounts {
  total: number;
  foreign: number;
  missing: number;
  stale: number;
  checked: number;
}

/**
 * Keeps a bounded log. Unbounded would grow without limit on a busy profile,
 * and the recent entries are the only ones anyone acts on.
 */
export class DesyncLog {
  private readonly events: DesyncEvent[] = [];
  private readonly counts: DesyncCounts = {
    total: 0,
    foreign: 0,
    missing: 0,
    stale: 0,
    checked: 0,
  };

  constructor(private readonly limit = 200) {}

  observed(): void {
    this.counts.checked++;
  }

  record(event: DesyncEvent): void {
    this.counts.total++;
    this.counts[event.kind]++;
    this.events.push(event);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
  }

  recent(n = 50): DesyncEvent[] {
    return this.events.slice(-n);
  }

  snapshot(): DesyncCounts {
    return { ...this.counts };
  }

  /** The number that matters. Zero means isolation is holding. */
  get clean(): boolean {
    return this.counts.total === 0;
  }

  reset(): void {
    this.events.length = 0;
    this.counts.total = 0;
    this.counts.foreign = 0;
    this.counts.missing = 0;
    this.counts.stale = 0;
    this.counts.checked = 0;
  }
}
