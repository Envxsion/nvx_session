/**
 * The consistency validator.
 *
 * Six of your own accounts sharing one device fingerprint is unremarkable, and
 * agencies do it daily. What raises a flag is incoherence: a Linux user agent
 * reporting Windows font metrics, an Apple GPU on a Windows platform, a timezone
 * that disagrees with the language. Randomising makes you weirder, not safer,
 * and a persona that contradicts itself is worse than no persona at all because
 * it is a signal that something is actively lying.
 *
 * So a persona that fails this cannot be saved. Not warned about, not saved with
 * a caveat. The whole value of the feature is that the thing it produces holds
 * together, and a validator you can click past is a validator that is not doing
 * the job.
 *
 * Pure, and deliberately so. Every rule here is a statement about a descriptor,
 * testable without a browser, and the list is meant to be read and argued with.
 */

import type { Os, Persona } from './types.js';
import { chromiumMajor, isGreaseBrand } from './useragent.js';

export interface Problem {
  /** Stable, for tests and for the panel to key off. */
  code: string;
  /** Which field to send the user to. */
  field: string;
  /** Written to be shown, so it says what is wrong rather than which rule fired. */
  message: string;
}

export interface Verdict {
  ok: boolean;
  problems: Problem[];
  /**
   * Rules that could not run, by code.
   *
   * Kept apart from `problems` on purpose. A rule that did not run is not a
   * persona that passed, and folding the two together would either refuse a
   * valid persona because the caller omitted an input, or report a clean
   * verdict for a check nobody performed. Both are worse than saying so.
   */
  unchecked: string[];
}

/**
 * `navigator.deviceMemory` is bucketed by the spec precisely so it cannot carry
 * much entropy. A machine claiming 6 or 12 is claiming a value no browser
 * reports, which identifies the liar rather than the machine.
 */
const MEMORY_BUCKETS = [0.25, 0.5, 1, 2, 4, 8];

/** What each OS puts in `navigator.platform`. */
const PLATFORMS: Record<Os, string[]> = {
  windows: ['Win32', 'Win64'],
  macos: ['MacIntel'],
  linux: ['Linux x86_64', 'Linux i686', 'Linux aarch64'],
};

/** The token each OS puts in its user agent. */
const UA_TOKENS: Record<Os, RegExp> = {
  windows: /Windows NT/,
  macos: /Mac OS X/,
  linux: /(X11|Linux)/,
};

/** Renderer strings that can only come from one OS. */
const GPU_TELLS: Array<{ pattern: RegExp; only: Os; what: string }> = [
  { pattern: /\bApple\s?(M[1-9]|GPU)/i, only: 'macos', what: 'an Apple silicon GPU' },
  { pattern: /ANGLE .*Direct3D/i, only: 'windows', what: 'a Direct3D backend' },
  { pattern: /\bMetal\b/i, only: 'macos', what: 'a Metal backend' },
];

/**
 * Timezones against the languages plausibly spoken where they are.
 *
 * Curated rather than complete, the same trade `psl.ts` makes and for the same
 * reason: the full mapping is a build artefact and this stands in until then.
 * Deliberately permissive. `en` is accepted nearly everywhere because it
 * genuinely is spoken nearly everywhere, so this catches the loud contradiction,
 * a Melbourne timezone claiming Japanese, and lets the arguable cases through.
 * A validator that rejects a real person's real setup teaches them to turn it
 * off.
 */
const ZONE_LANGUAGES: Record<string, string[]> = {
  'Australia/': ['en'],
  'Pacific/Auckland': ['en', 'mi'],
  'America/': ['en', 'es', 'fr', 'pt'],
  'Europe/London': ['en', 'cy', 'ga'],
  'Europe/Dublin': ['en', 'ga'],
  'Europe/Paris': ['en', 'fr', 'br'],
  'Europe/Berlin': ['en', 'de'],
  'Europe/Madrid': ['en', 'es', 'ca', 'gl', 'eu'],
  'Europe/Rome': ['en', 'it'],
  'Europe/Amsterdam': ['en', 'nl'],
  'Europe/Lisbon': ['en', 'pt'],
  'Europe/Warsaw': ['en', 'pl'],
  'Europe/Moscow': ['en', 'ru'],
  'Asia/Tokyo': ['en', 'ja'],
  'Asia/Seoul': ['en', 'ko'],
  'Asia/Shanghai': ['en', 'zh'],
  'Asia/Hong_Kong': ['en', 'zh'],
  'Asia/Taipei': ['en', 'zh'],
  'Asia/Kolkata': ['en', 'hi', 'bn', 'ta', 'te', 'mr'],
  'Asia/Jakarta': ['en', 'id'],
  'Asia/Singapore': ['en', 'zh', 'ms', 'ta'],
  'Africa/Johannesburg': ['en', 'af', 'zu', 'xh'],
  'Africa/Lagos': ['en', 'yo', 'ig', 'ha'],
};

function languagesForZone(zone: string): string[] | null {
  if (ZONE_LANGUAGES[zone]) return ZONE_LANGUAGES[zone]!;
  for (const [prefix, langs] of Object.entries(ZONE_LANGUAGES)) {
    if (prefix.endsWith('/') && zone.startsWith(prefix)) return langs;
  }
  return null;
}

/** Screen ratios a real display reports. Anything else is a fabricated number. */
const PIXEL_RATIOS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export interface ValidateOptions {
  /**
   * The machine this is actually running on. An OS change needs tier 2, and
   * without knowing the real OS there is no way to tell a change from a match.
   * Omitted means the check is skipped and said to be skipped, rather than
   * silently passing.
   */
  realOs?: Os;
}

export function validate(p: Persona, opts: ValidateOptions = {}): Verdict {
  const problems: Problem[] = [];
  const unchecked: string[] = [];
  const fail = (code: string, field: string, message: string) =>
    problems.push({ code, field, message });

  // -------------------------------------------------------------- the machine

  if (!Number.isInteger(p.cores) || p.cores < 1 || p.cores > 128) {
    fail(
      'cores.implausible',
      'cores',
      `${p.cores} CPU threads is not a machine anybody has. Real values run 1 to 128.`
    );
  }

  if (!MEMORY_BUCKETS.includes(p.memory)) {
    fail(
      'memory.unbucketed',
      'memory',
      `deviceMemory only ever reports ${MEMORY_BUCKETS.join(', ')}. ${p.memory} identifies the lie rather than the machine.`
    );
  }

  if (!PLATFORMS[p.os]?.includes(p.platform)) {
    fail(
      'platform.mismatch',
      'platform',
      `navigator.platform "${p.platform}" does not belong to ${p.os}. Expected one of ${PLATFORMS[p.os]?.join(', ')}.`
    );
  }

  if (!UA_TOKENS[p.os]?.test(p.userAgent)) {
    fail(
      'ua.mismatch',
      'userAgent',
      `The user agent does not identify as ${p.os}, but every other field does.`
    );
  }

  for (const tell of GPU_TELLS) {
    if (tell.pattern.test(p.gpu.renderer) && p.os !== tell.only) {
      fail(
        'gpu.mismatch',
        'gpu.renderer',
        `The renderer string claims ${tell.what}, which only exists on ${tell.only}.`
      );
    }
  }

  // ---------------------------------------------------------------- the brands

  /**
   * The brand list and the user agent are two statements of the same version,
   * and a page can read both in one line. A list naming 150 beside a user agent
   * naming 151 is not a machine, it is a rewrite that only got halfway.
   */
  if (p.brands?.length) {
    const major = chromiumMajor(p.userAgent);
    const named = p.brands.filter((b) => !isGreaseBrand(b.brand));

    if (major !== null) {
      const off = named.find((b) => Number(String(b.version).split('.')[0]) !== major);
      if (off) {
        fail(
          'brands.version',
          'brands',
          `The brand list says ${off.brand} ${off.version} while the user agent says ${major}. A page reads both.`
        );
      }
    }

    /**
     * Chromium greases every list it sends, so one without a greased entry is
     * one no browser produced. This fires when the phrase match in
     * `isGreaseBrand` fails to recognise a spelling and the entry is rewritten
     * to Google Chrome, which is the failure mode worth catching early.
     */
    if (!p.brands.some((b) => isGreaseBrand(b.brand))) {
      fail(
        'brands.grease',
        'brands',
        'Every Chromium brand list carries a deliberately malformed entry. One without it is a list nothing sends.'
      );
    }
  }

  // ---------------------------------------------------------------- the screen

  const mobileUa = /(Mobile|Android|iPhone|iPad)/.test(p.userAgent);
  if (mobileUa && p.screen.width >= 1024) {
    fail(
      'screen.mismatch',
      'screen',
      `A mobile user agent with a ${p.screen.width} pixel wide screen is a combination no device reports.`
    );
  }

  if (!PIXEL_RATIOS.includes(p.screen.dpr)) {
    fail(
      'dpr.implausible',
      'screen.dpr',
      `A device pixel ratio of ${p.screen.dpr} is not one displays report. Real values are ${PIXEL_RATIOS.join(', ')}.`
    );
  }

  if (p.screen.width < 1 || p.screen.height < 1) {
    fail('screen.empty', 'screen', 'A screen needs a positive width and height.');
  }

  // --------------------------------------------------------- locale and zone

  if (!p.languages.length) {
    fail('languages.empty', 'languages', 'A browser always reports at least one language.');
  } else if (p.languages[0] !== p.locale) {
    fail(
      'languages.head',
      'languages',
      `navigator.language is the head of navigator.languages, so "${p.locale}" and "${p.languages[0]}" cannot both be right.`
    );
  }

  const allowed = languagesForZone(p.timezone);
  const primary = (p.locale.split('-')[0] ?? '').toLowerCase();
  if (allowed && primary && !allowed.includes(primary)) {
    fail(
      'zone.language',
      'timezone',
      `A ${p.timezone} clock reporting "${p.locale}" is the kind of disagreement fingerprinters look for specifically.`
    );
  }

  // ------------------------------------------------------------------- tier

  if (opts.realOs === undefined) {
    unchecked.push('tier.oschange');
  } else if (p.os !== opts.realOs && p.tier < 2) {
    fail(
      'tier.oschange',
      'os',
      `Presenting ${p.os} on a ${opts.realOs} machine needs tier 2. Request headers can be rewritten, but the browser negotiates client hint availability per origin and rules cannot model that, so the headers and the page would disagree.`
    );
  }

  if (!p.seed) {
    fail('seed.missing', 'seed', 'Without seed material nothing derived from it is stable.');
  }

  if (!languagesForZone(p.timezone)) unchecked.push('zone.language');

  return { ok: problems.length === 0, problems, unchecked };
}
