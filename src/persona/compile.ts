/**
 * ------------------------------------------------------------------
 *  Title    |  Descriptor to patch bundle
 *  Ref      |  noise.ts, useragent.ts, types.ts, standardFor, compile
 *  ID       |  M3 (fingerprint)
 * ------------------------------------------------------------------
 *  Purpose  |  Turn a persona descriptor into a plain-data patch
 *           |  bundle the mask applies.
 *  How      |  The bundle has no behaviour: the mask runs in a page's
 *           |  MAIN world and may not import anything, so every decision
 *           |  is made and tested here.
 *  Note     |  Surfaces that are described but not patched are reported
 *           |  as unapplied. See `applied` in the bundle.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

import { surfaceSeed } from './noise.js';
import { canNormalise, standardBrands, standardUserAgent, type Brand } from './useragent.js';
import type { Os, PatchBundle, Persona, Posture, Surface } from './types.js';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  How sparse the canvas noise is.
 *  How      |  One eligible pixel in 97 carries a change of at most one
 *           |  level on one channel, a compromise between two failures:
 *           |  too dense costs measurable time (a section 11 vector),
 *           |  too sparse leaves a small probe canvas untouched.
 *  Note     |  97 is prime so it cannot fall into step with a repeating
 *           |  pattern or a canvas width sharing a factor with the
 *           |  stride. On a 220 by 30 probe this touches ~60 pixels,
 *           |  enough to move a hash, below what an eye resolves.
 * ------------------------------------------------------------------
 */
export const CANVAS_STRIDE = 97;
export const CANVAS_BITS = 1;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Audio noise, which needs a different shape of number.
 *  How      |  The bits are mantissa bits, so the change is relative:
 *           |  a touched sample moves ~one part in two thousand, about
 *           |  sixty six dB down and inaudible everywhere in the buffer.
 *  Note     |  The stride is tighter than the canvas one because an
 *           |  audio fingerprint usually sums the whole buffer, so a
 *           |  change in a quiet render can round away. 44k samples at
 *           |  one in 17 is still under 3000 touched, which costs
 *           |  nothing.
 * ------------------------------------------------------------------
 */
export const AUDIO_STRIDE = 17;
export const AUDIO_BITS = 12;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The Standardize bucket: one normalised machine shared
 *           |  across every session.
 *  How      |  The seed is a published constant on purpose. A bucket
 *           |  only lowers uniqueness if everybody in it lands in the
 *           |  same place, so a per-install random seed would be worse
 *           |  than nothing. The machine described is the most common
 *           |  desktop configuration there is.
 *  Note     |  Timezone and locale are the real machine's, not the
 *           |  bucket's: they are checked against the exit IP, so
 *           |  `standardFor` takes them from the running browser rather
 *           |  than fabricating them.
 * ------------------------------------------------------------------
 */
/**
 * ------------------------------------------------------------------
 *  Purpose  |  One bucket per operating system, not one global bucket.
 *  Note     |  A single bucket would have to claim an OS the machine
 *           |  may not run, which the validator refuses below tier 2:
 *           |  headers can be rewritten but client hint availability is
 *           |  negotiated per origin, so headers and page would
 *           |  disagree. What matters is everybody on the same OS lands
 *           |  in the same place.
 * ------------------------------------------------------------------
 */
export const BUCKETS: Record<
  Os,
  { platform: string; userAgent: string; screen: Persona['screen'] }
> = {
  windows: {
    platform: 'Win32',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    screen: { width: 1920, height: 1080, dpr: 1 },
  },
  macos: {
    platform: 'MacIntel',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    screen: { width: 1512, height: 982, dpr: 2 },
  },
  linux: {
    platform: 'Linux x86_64',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    screen: { width: 1920, height: 1080, dpr: 1 },
  },
};

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The graphics card bucket, keyed by vendor rather than
 *           |  across vendors, normalising only the model.
 *  Bug-Fix  |  The first form put one card per OS (every Windows
 *           |  machine an RTX 3060). WebGPU is not masked and reports
 *           |  the real vendor untouched, so the page claimed NVIDIA in
 *           |  one API and AMD in another, worse than not masking.
 *  Note     |  The vendor is corroborated in too many places to fake
 *           |  (WebGPU, WebGL limits, extension list, shader
 *           |  precision), so it stays and only the model moves, where
 *           |  nearly all the entropy is. A combination not in the
 *           |  table is left alone rather than invented badly.
 *           |  `src/mask/index.ts` carries a copy;
 *           |  `tests/persona.test.ts` holds the two together.
 * ------------------------------------------------------------------
 */
export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple';

export const CARDS: Record<string, { vendor: string; renderer: string }> = {
  'windows:nvidia': {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  'windows:amd': {
    vendor: 'Google Inc. (AMD)',
    renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  'windows:intel': {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  'macos:apple': {
    vendor: 'Google Inc. (Apple)',
    renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
  },
  'linux:intel': {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
  },
};

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Which vendor made the card a renderer string describes.
 *  How      |  Read from the real string, not the OS, which does not
 *           |  decide it: a Windows machine can be any of three and a
 *           |  Mac can be two.
 *  Note     |  Order matters. An Apple Silicon renderer says both
 *           |  "Apple" and "Metal", and an ANGLE Metal string on an
 *           |  Intel Mac says "Metal" while naming Intel, so Apple is
 *           |  tested on its own token rather than the backend.
 * ------------------------------------------------------------------
 */
export function vendorOf(renderer: string): GpuVendor | null {
  if (/\bapple\b/i.test(renderer)) return 'apple';
  if (/\bnvidia\b|geforce|quadro/i.test(renderer)) return 'nvidia';
  if (/\bamd\b|radeon|\bati\b/i.test(renderer)) return 'amd';
  if (/\bintel\b|\bhd graphics\b|\biris\b/i.test(renderer)) return 'intel';
  return null;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The card to present, given the machine's real one.
 *  Note     |  Null leaves it alone, the answer for any combination
 *           |  this cannot state with confidence.
 * ------------------------------------------------------------------
 */
export function cardFor(os: Os, realRenderer: string): { vendor: string; renderer: string } | null {
  const vendor = vendorOf(realRenderer);
  if (!vendor) return null;
  return CARDS[`${os}:${vendor}`] ?? null;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  What the bucket takes from the machine rather than
 *           |  inventing.
 *  Note     |  Timezone and locale, checked against the exit IP. And
 *           |  the user agent and brand list: the normalised form is
 *           |  the real one with the browser's own name removed, so the
 *           |  Chromium version stays true. A written-down user agent
 *           |  is correct for one release, a contradiction after. See
 *           |  `useragent.ts`.
 * ------------------------------------------------------------------
 */
export interface RealMachine {
  os: Os;
  timezone: string;
  locale: string;
  userAgent?: string;
  brands?: Brand[];
  /**
   * The machine's real WebGL renderer string, which decides which card bucket it
   * lands in.
   *
   * Optional because the service worker cannot read one: there is no document
   * and no canvas there, so the only callers who can supply it are the page and
   * the suite measuring the page. Absent falls back to the operating system's
   * most common vendor, which is right for the validator and for anything
   * describing the shape of a persona, and is never what the mask uses: the mask
   * reads the real string from the context it was asked about.
   */
  renderer?: string;
}

/** What an OS most often ships with, for a caller who cannot read the real one. */
const LIKELY: Record<Os, GpuVendor> = { windows: 'nvidia', macos: 'apple', linux: 'intel' };

export function standardFor(real: RealMachine): Persona {
  const locale = real.locale || 'en-US';
  const bucket = BUCKETS[real.os] ?? BUCKETS.windows;
  /**
   * The two move together or neither moves.
   *
   * A brand list this cannot normalise, having no Chromium entry to take a
   * version from, would be left naming the real browser beside a user agent
   * claiming Chrome, which is a contradiction inside one navigator rather than a
   * disguise. So the whole surface degrades to the real values. The mask makes
   * the same decision from the same predicate, on the same browser, so the two
   * cannot land differently.
   */
  const normalisable = canNormalise(real.brands);
  const brands = real.brands?.length && normalisable ? standardBrands(real.brands) : real.brands;
  return {
    id: '__nvx_standard',
    label: 'Standard',
    os: real.os,
    platform: bucket.platform,
    // The literal is a fallback for a caller with no browser to ask, which is
    // every unit test. Anything running in one passes the real string.
    userAgent: real.userAgent
      ? normalisable
        ? standardUserAgent(real.userAgent)
        : real.userAgent
      : bucket.userAgent,
    ...(brands?.length ? { brands } : {}),
    gpu:
      (real.renderer ? cardFor(real.os, real.renderer) : null) ??
      CARDS[`${real.os}:${LIKELY[real.os]}`]!,
    cores: 8,
    memory: 8,
    screen: bucket.screen,
    timezone: real.timezone || 'UTC',
    locale,
    languages: [locale, ...(locale.startsWith('en') ? [] : ['en-US', 'en'])],
    // Published on purpose. See above.
    seed: 'nvx.standard.v1',
    tier: 1,
  };
}

// The persona fabrication (MODELS, MACHINES, draw, personaFor) is a Pro
// algorithm and lives in the private pro submodule, not here. Free builds use
// only Mirror and Standardize, which standardFor above and compile below
// provide. The full version is at src/pro/overlay/persona/compile.ts.

export function compile(persona: Persona, posture: Posture): PatchBundle {
  // Mirror fabricates nothing, so it compiles to a bundle that patches nothing
  // rather than to no bundle at all. The mask still installs, and installing a
  // bundle with no surfaces is how it stays a single code path.
  if (posture === 'mirror') {
    return {
      posture,
      personaId: persona.id,
      applied: [],
      canvas: null,
      webgl: null,
      audio: null,
      navigator: null,
    };
  }

  const applied: Surface[] = ['canvas', 'webgl', 'audio', 'navigator', 'voices'];

  return {
    posture,
    personaId: persona.id,
    applied,
    canvas: {
      seed: surfaceSeed(persona.seed, 'canvas'),
      stride: CANVAS_STRIDE,
      bits: CANVAS_BITS,
    },
    webgl: {
      // Its own seed, so the two surfaces cannot be correlated back to one
      // number by anybody who works out the scheme.
      seed: surfaceSeed(persona.seed, 'webgl'),
      stride: CANVAS_STRIDE,
      bits: CANVAS_BITS,
      vendor: persona.gpu.vendor,
      renderer: persona.gpu.renderer,
      sortExtensions: true,
    },
    audio: {
      seed: surfaceSeed(persona.seed, 'audio'),
      stride: AUDIO_STRIDE,
      bits: AUDIO_BITS,
    },
    navigator: {
      userAgent: persona.userAgent,
      brands: persona.brands ?? [],
      hardwareConcurrency: persona.cores,
      deviceMemory: persona.memory,
    },
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Surfaces the section 10 table names and this build does
 *           |  not patch yet.
 *  Note     |  Exported so the panel and manual read it rather than
 *           |  restate it. A settings screen implying an unfinished
 *           |  surface is finished is worse than the gap itself.
 * ------------------------------------------------------------------
 */
export const UNAPPLIED: Array<{ surface: string; why: string }> = [
  {
    surface: 'WebGL shader precision',
    why: 'reported precision changes what a page compiles, so normalising it can change what renders rather than only what is measured',
  },
  {
    surface: 'WebGPU',
    why: 'it names the real graphics vendor and nothing here fakes that, which is why the card bucket keeps the vendor rather than crossing it; its capability limits are the same residual the WebGL ones are',
  },
  {
    surface: 'screen size and pixel ratio',
    why: 'a stylesheet can ask the engine for the same numbers and read the answer back, and a content script cannot reach that, so a spoofed screen contradicts the page it is on',
  },
  {
    surface: 'touch points',
    why: 'the same reason as the screen: pointer capability is a media query the engine answers, and claiming no touch on a machine whose stylesheet says otherwise is a contradiction the mask would be making itself',
  },
  {
    surface: 'timezone and locale',
    why: 'checked against the exit address by anybody who cares, so the bucket keeps the real ones on purpose',
  },
  {
    surface: 'media devices',
    why: 'with no permission the browser already returns one blank entry per kind, so all that is left is whether you own a camera, and claiming one you do not have breaks the call button rather than hiding anything',
  },
  {
    surface: 'graphics capability limits',
    why: 'measured, and mostly not a tell: the WebGL numbers on Windows are the driver layer’s own caps rather than the card’s, so they read the same across vendors. WebGPU’s do vary, and normalising those would cap what a page may allocate rather than only what it can measure',
  },
  {
    surface: 'permission states',
    why: 'which permissions you have granted or denied is a real signal, and answering it falsely breaks the feature detection every site does before asking, so a page would ask for a camera it has already been refused',
  },
  {
    surface: 'battery and gamepads',
    why: 'both report nothing at all until there is something to report, and inventing a battery level is a value that has to keep moving plausibly forever or it becomes the tell',
  },
  {
    surface: 'text metrics',
    why: 'the width of rendered text is how fonts are really detected, and it is layout rather than a reading: a perturbed measureText that layout does not agree with is found by measuring the same string twice',
  },
  {
    surface: 'fonts',
    why: 'rasterisation is engine level and unreachable from a content script, so this does not close below tier 3',
  },
  {
    surface: 'UA client hints negotiation',
    why: 'the browser negotiates hint availability per origin and rules cannot model it, so an OS change needs tier 2',
  },
];
