/**
 * ------------------------------------------------------------------
 *  Title    |  Problem reports
 *  Ref      |  popup Help view, src/pro/docs/licensing-and-abuse-brief.md
 *  ID       |  report
 * ------------------------------------------------------------------
 *  Purpose  |  Turn "it broke" into something that can be fixed: what
 *           |  the user wrote, plus the state and recent journal of the
 *           |  extension, shown to them in full before it is sent.
 *  How      |  A pure builder over what the worker already knows. Site
 *           |  names are left out unless the user asks for them: hosts
 *           |  are dropped, and any host-shaped word in a journal line
 *           |  becomes "a site". Session names become "session 1, 2..."
 *           |  because people name them after employers and clients.
 *  Note     |  No cookie, url, path or query is ever in the journal
 *           |  (journal.ts enforces that), so the worst a report can
 *           |  carry is the site names the user opted into.
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import type { Entry } from '../kernel/journal.js';

export interface ReportInput {
  text: string;
  expected: string;
  email: string;
  diagnostics: boolean;
  includeSites: boolean;
}

export interface ReportFacts {
  version: string;
  tier: string;
  channel: string;
  device: string;
  browserVersion: string;
  settings: Record<string, unknown>;
  sessions: { label: string; tabs: number; sites: number }[];
  managedTabs: number;
  released: string[];
  journal: Entry[];
  now: number;
}

/** How much of the journal goes along: enough to see the run-up, not the week. */
export const REPORT_JOURNAL = 80;
export const REPORT_TEXT_MAX = 4000;

const HOSTISH = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;

/** Validates and trims what the user typed; null fields are refused with a reason. */
export function cleanInput(raw: Record<string, unknown>): ReportInput | { error: string } {
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (text.length < 10) return { error: 'too_short' };
  const email = typeof raw.email === 'string' ? raw.email.trim() : '';
  if (email && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) return { error: 'bad_email' };
  return {
    text: text.slice(0, REPORT_TEXT_MAX),
    expected: typeof raw.expected === 'string' ? raw.expected.trim().slice(0, REPORT_TEXT_MAX) : '',
    email: email.slice(0, 320),
    diagnostics: raw.diagnostics !== false,
    includeSites: raw.includeSites === true,
  };
}

/** The diagnostics block, exactly as it would be sent. */
export function diagnostics(facts: ReportFacts, includeSites: boolean): Record<string, unknown> {
  const names = new Map<string, string>();
  facts.sessions.forEach((s, i) => names.set(s.label, `session ${i + 1}`));
  const scrub = (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined;
    let out = s;
    if (!includeSites) out = out.replace(HOSTISH, 'a site');
    for (const [label, alias] of names) if (label) out = out.split(label).join(alias);
    return out;
  };
  return {
    version: facts.version,
    tier: facts.tier,
    channel: facts.channel,
    device: facts.device,
    browser: facts.browserVersion,
    settings: facts.settings,
    sessions: facts.sessions.map((s, i) => ({ name: `session ${i + 1}`, tabs: s.tabs, sites: s.sites })),
    managedTabs: facts.managedTabs,
    released: includeSites ? facts.released : facts.released.length,
    journal: facts.journal.slice(-REPORT_JOURNAL).map((e) => ({
      ago: Math.max(0, Math.round((facts.now - e.at) / 1000)),
      level: e.level,
      area: e.area,
      event: scrub(e.event),
      ...(e.detail ? { detail: scrub(e.detail) } : {}),
      ...(e.session ? { session: names.get(e.session) ?? 'a session' } : {}),
      ...(includeSites && e.host ? { host: e.host } : {}),
      ...(e.count > 1 ? { count: e.count } : {}),
    })),
  };
}

/** The whole report body. */
export function buildReport(
  input: ReportInput,
  facts: ReportFacts,
  id: string
): Record<string, unknown> {
  return {
    id,
    text: input.text,
    ...(input.expected ? { expected: input.expected } : {}),
    ...(input.email ? { email: input.email } : {}),
    version: facts.version,
    ...(input.diagnostics ? { diagnostics: diagnostics(facts, input.includeSites) } : {}),
  };
}

/** Plain text for the clipboard, for when the report cannot be sent from here. */
export function reportText(report: Record<string, unknown>): string {
  const lines = [`NVX Session problem report ${String(report.id)}`, '', String(report.text)];
  if (report.expected) lines.push('', 'Expected:', String(report.expected));
  if (report.diagnostics) lines.push('', 'Diagnostics:', JSON.stringify(report.diagnostics, null, 2));
  return lines.join('\n');
}
