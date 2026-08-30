/**
 * What a fingerprint posture is, as data.
 *
 * A persona is a declarative description of one coherent machine. It is never
 * executed and never touches a browser API: the compiler in `compile.ts` turns
 * it into a patch bundle, and the mask in `src/mask/` applies whatever bundle it
 * is handed. Keeping those apart is what makes surface coverage auditable, and
 * it is the only reason any of this is testable without a browser.
 *
 * The descriptor carries the whole of the section 10 table even though only
 * canvas is compiled today. That is deliberate rather than aspirational: the
 * validator's entire job is checking a machine for internal contradiction, and
 * it cannot do that against a descriptor that only holds one surface. What must
 * not happen is the product implying it applies a field it merely stores, which
 * is why the compiled bundle carries an explicit `applied` list and every
 * surface absent from it is reported as unhandled rather than quietly assumed.
 */

/**
 * Mirror is the shipped default and fabricates nothing. Standardize puts every
 * session on one shared normalised machine, which lowers uniqueness across the
 * whole population running it. Persona gives each session its own coherent
 * machine, seeded so it never changes.
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
 * Canvas noise parameters.
 *
 * Sub-perceptual and sparse. Full frame per pixel noise is measurably slow on a
 * large canvas, and timing is itself a detection vector, so one pixel in
 * `stride` is touched and the choice of which is a pure function of position.
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
 * WebGL, which is two separate lies with different failure modes.
 *
 * The strings are what `getParameter` reports for the vendor and renderer, and
 * they are the single most read fingerprint value after the canvas. They have to
 * match the claimed OS: an Apple GPU on a Windows platform is the textbook
 * incoherence, and the validator refuses it.
 *
 * The pixels are `readPixels`, which is what a WebGL fingerprint hash actually
 * consumes, and they take the same seeded sparse treatment as the 2D canvas for
 * the same reasons.
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
 * Audio.
 *
 * `bits` counts mantissa bits rather than whole levels, so the change is
 * relative rather than absolute: a loud sample moves more in magnitude than a
 * quiet one and both move by the same proportion, which is what keeps it below
 * hearing everywhere in the buffer rather than only where it happens to be
 * quiet.
 */
export interface AudioPatch {
  seed: number;
  stride: number;
  bits: number;
}

/**
 * The navigator, which is four fields and four arguments for stopping there.
 *
 * `userAgent` and `brands` are the browser's own name, and normalising them is
 * the whole point: they are the fields that put an Opera or an Edge user in a
 * bucket of one. `appVersion` is not listed because it is the user agent minus
 * its prefix and is derived rather than chosen; leaving it real while the user
 * agent moves is a one line contradiction.
 *
 * `cores` and `memory` are bucketed counts with no counterpart anywhere else in
 * the platform, so normalising them cannot contradict anything. The most a page
 * loses is sizing a worker pool to the wrong number.
 *
 * What is deliberately absent is `maxTouchPoints`, and the reason is the same
 * one that keeps the screen out of this build entirely. Touch capability is
 * readable from CSS through `(any-pointer: coarse)`, which the engine evaluates
 * and a content script cannot reach, so a navigator claiming no touch on a
 * machine whose stylesheet says otherwise is a contradiction manufactured by
 * the mask. A real value nobody masked is better than that.
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
