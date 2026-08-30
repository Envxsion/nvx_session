/**
 * ------------------------------------------------------------------
 *  Title    |  The persona descriptor
 *  Ref      |  compile.ts, src/mask/, Posture, PatchBundle
 *  ID       |  M3 (fingerprint)
 * ------------------------------------------------------------------
 *  Purpose  |  What a fingerprint posture is, as data.
 *  How      |  A persona is a declarative description of one coherent
 *           |  machine, never executed. The compiler turns it into a
 *           |  patch bundle and the mask applies it, which keeps surface
 *           |  coverage auditable and testable without a browser.
 *  Note     |  The descriptor carries the whole section 10 table though
 *           |  only some surfaces compile, so the validator can check
 *           |  for internal contradiction. The bundle carries an
 *           |  explicit `applied` list; any surface absent is reported
 *           |  as unhandled rather than assumed.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The three fingerprint postures.
 *  Note     |  Mirror is the shipped default and fabricates nothing.
 *           |  Standardize puts every session on one shared normalised
 *           |  machine, lowering uniqueness across the population.
 *           |  Persona is the per-session posture (Pro).
 * ------------------------------------------------------------------
 */
export type Posture = 'mirror' | 'standardize' | 'persona';

export type Os = 'windows' | 'macos' | 'linux';

/** Surfaces this build knows how to patch. Grows one slice at a time. */
export type Surface = 'canvas' | 'webgl' | 'audio' | 'navigator' | 'voices';

import type { Brand } from './useragent.js';

export interface Persona {
  id: string;
  label: string;

  /** The machine being described. Every field below has to agree with this. */
  os: Os;
  /** `navigator.platform`. Vestigial in the platform sense, still read widely. */
  platform: string;
  userAgent: string;
  /**
   * The `Sec-CH-UA` brand list, when one is known.
   *
   * Optional because it is not something a persona can be written down with:
   * Chromium greases the list with an entry whose spelling and position are
   * derived from the version, so the only correct value is the one the running
   * browser produced. Absent means the brand list is left alone, which is the
   * honest answer when there is nothing coherent to put there.
   */
  brands?: Brand[];

  gpu: { vendor: string; renderer: string };

  /** `navigator.hardwareConcurrency`. */
  cores: number;
  /** `navigator.deviceMemory`, in GiB. The spec buckets this; see the validator. */
  memory: number;

  screen: { width: number; height: number; dpr: number };

  /** IANA zone, for example `Australia/Melbourne`. */
  timezone: string;
  /** BCP 47, for example `en-AU`. Must be the head of `languages`. */
  locale: string;
  languages: string[];

  /**
   * Seed material. Every derived value comes from this and nothing is random at
   * read time, because per-call randomisation is trivially detected: call
   * `toDataURL()` twice and diff.
   *
   * For Standardize this is a published constant, and it being public is the
   * point: a bucket only lowers uniqueness if everybody in it shares it. For
   * Persona it will be an HKDF output over the session key, which is where the
   * word seed starts meaning something a site cannot guess.
   */
  seed: string;

  /**
   * 1 is everything reachable from a MAIN world content script. 2 needs the
   * debugger, and the validator refuses an OS change below it, because request
   * headers can be rewritten but client hint negotiation cannot be modelled by
   * rules.
   */
  tier: 1 | 2;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Canvas noise parameters.
 *  Note     |  Sub-perceptual and sparse. Full frame per-pixel noise is
 *           |  measurably slow on a large canvas and timing is itself a
 *           |  detection vector, so one pixel in `stride` is touched and
 *           |  which is a pure function of position.
 * ------------------------------------------------------------------
 */
export interface CanvasPatch {
  /** 32 bit, derived from the persona seed and the surface name. */
  seed: number;
  /** One eligible pixel in this many is perturbed. */
  stride: number;
  /**
   * How many low bits of the chosen channel are replaced. One means a change
   * of at most one level, which is the smallest difference a pixel can carry
   * and still move a hash.
   */
  bits: number;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  WebGL, two separate changes with different failure
 *           |  modes.
 *  Note     |  The strings are what `getParameter` reports for vendor
 *           |  and renderer, the most read fingerprint after the canvas,
 *           |  and must match the claimed OS: an Apple GPU on a Windows
 *           |  platform is the textbook incoherence the validator
 *           |  refuses. The pixels are `readPixels`, given the same
 *           |  seeded sparse treatment as the 2D canvas.
 * ------------------------------------------------------------------
 */
export interface WebglPatch {
  seed: number;
  stride: number;
  bits: number;
  vendor: string;
  renderer: string;
  /**
   * Sort the supported extension list.
   *
   * Order is driver dependent and carries real bits, and sorting is the only
   * normalisation here that is safe by construction: it neither claims a
   * capability the driver lacks, which would break a page that then used it,
   * nor hides one it has.
   */
  sortExtensions: boolean;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Audio noise parameters.
 *  Note     |  `bits` counts mantissa bits rather than whole levels, so
 *           |  the change is relative: a loud sample moves more in
 *           |  magnitude than a quiet one and both by the same
 *           |  proportion, which keeps it below hearing everywhere in
 *           |  the buffer.
 * ------------------------------------------------------------------
 */
export interface AudioPatch {
  seed: number;
  stride: number;
  bits: number;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The navigator, four fields and four reasons for stopping
 *           |  there.
 *  Note     |  `userAgent` and `brands` are the browser's own name, the
 *           |  fields that put an Opera or Edge user in a bucket of one.
 *           |  `appVersion` is derived from the user agent, so leaving
 *           |  it real would contradict. `cores` and `memory` are
 *           |  bucketed counts with no counterpart to contradict.
 *           |  `maxTouchPoints` is absent because touch is readable from
 *           |  CSS the mask cannot reach, so claiming no touch would be
 *           |  a contradiction it manufactures.
 * ------------------------------------------------------------------
 */
export interface NavigatorPatch {
  /** Empty means leave it alone, which is what an unrecognised browser gets. */
  userAgent: string;
  /** Empty means leave the brand list alone. */
  brands: Brand[];
  hardwareConcurrency: number;
  deviceMemory: number;
}

export interface PatchBundle {
  posture: Posture;
  /** Which persona produced this, for the panel and for diagnostics. */
  personaId: string;
  /**
   * Surfaces this bundle actually patches. Anything in the section 10 table and
   * not in here is untouched and must be reported that way rather than implied
   * to be handled.
   */
  applied: Surface[];
  canvas: CanvasPatch | null;
  webgl: WebglPatch | null;
  audio: AudioPatch | null;
  navigator: NavigatorPatch | null;
}
