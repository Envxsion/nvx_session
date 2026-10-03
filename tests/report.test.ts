/**
 * ------------------------------------------------------------------
 *  Title    |  Problem reports
 *  Ref      |  bg/report.ts
 *  ID       |  test (report)
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';
import { buildReport, cleanInput, diagnostics, reportText, type ReportFacts } from '../src/bg/report.js';

const facts: ReportFacts = {
  version: '1.0.0',
  tier: 'free',
  channel: 'store',
  device: 'Windows, Chrome',
  browserVersion: 'Chrome/154',
  settings: { paused: false },
  sessions: [
    { label: 'Acme Payroll', tabs: 2, sites: 5 },
    { label: 'Home', tabs: 1, sites: 3 },
  ],
  managedTabs: 3,
  released: ['monash.edu'],
  journal: [
    {
      at: 1000,
      level: 'warn',
      area: 'session',
      event: 'a sign-in loop was stopped',
      detail: 'okta.com bounced 9 times for Acme Payroll',
      session: 'Acme Payroll',
      host: 'okta.com',
      count: 1,
    },
  ],
  now: 61_000,
};

describe('report input', () => {
  it('refuses a too-short description and a malformed email', () => {
    expect(cleanInput({ text: 'broke' })).toEqual({ error: 'too_short' });
    expect(cleanInput({ text: 'it broke on sign in', email: 'nope' })).toEqual({ error: 'bad_email' });
  });

  it('trims, caps and defaults', () => {
    const r = cleanInput({ text: `  ${'x'.repeat(5000)}  `, email: ' a@b.co ' });
    if ('error' in r) throw new Error(r.error);
    expect(r.text.length).toBe(4000);
    expect(r.email).toBe('a@b.co');
    expect(r.diagnostics).toBe(true);
    expect(r.includeSites).toBe(false);
  });
});

describe('diagnostics', () => {
  it('drops site names and session names by default', () => {
    const d = diagnostics(facts, false);
    const text = JSON.stringify(d);
    expect(text).not.toContain('okta.com');
    expect(text).not.toContain('monash.edu');
    expect(text).not.toContain('Acme');
    expect(d.released).toBe(1);
    const entry = (d.journal as Record<string, unknown>[])[0]!;
    expect(entry.detail).toBe('a site bounced 9 times for session 1');
    expect(entry.session).toBe('session 1');
    expect(entry.host).toBeUndefined();
    expect(entry.ago).toBe(60);
  });

  it('keeps site names when asked, still never session names', () => {
    const text = JSON.stringify(diagnostics(facts, true));
    expect(text).toContain('okta.com');
    expect(text).toContain('monash.edu');
    expect(text).not.toContain('Acme');
  });

  it('leaves diagnostics out entirely when the user turns them off', () => {
    const input = cleanInput({ text: 'the picker never showed', diagnostics: false });
    if ('error' in input) throw new Error(input.error);
    const r = buildReport(input, facts, 'abcd1234');
    expect(r.diagnostics).toBeUndefined();
    expect(reportText(r)).toContain('abcd1234');
  });
});
