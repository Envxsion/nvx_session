/**
 * Descriptor to patch bundle.
 *
 * The bundle is plain data with no behaviour, because the thing that consumes it
 * runs in the MAIN world of a page and may not import anything. Everything that
 * needs thinking about happens here, where it can be tested; the mask applies
 * what it is given and makes no decisions of its own.
 *
 * One surface is compiled today. The others are described in the persona,
 * validated for coherence, and reported as unapplied, which is the honest shape
 * for a thing being built a slice at a time. See `applied` in the bundle.
 */

import { surfaceSeed } from './noise.js';
import { canNormalise, standardBrands, standardUserAgent, type Brand } from './useragent.js';
import type { Os, PatchBundle, Persona, Posture, Surface } from './types.js';

/**
 * How sparse the canvas noise is.
 *
 * One eligible pixel in 97 carries a change of at most one level on one channel.
 * The numbers are a compromise between two failure modes that pull opposite
 * ways. Too dense and the cost is measurable, which section 11 lists as its own
 * detection vector: full frame noise on a large canvas shows up in timing.  Too
 * sparse and a small probe canvas, and fingerprinting probes are small, comes
 * back untouched, which is the same as not being installed.
 *
 * 97 is prime so it cannot fall into step with a repeating pattern in the image
 * or with a canvas whose width shares a factor with the stride. At the 220 by 30
 * the common probes use, this touches something on the order of sixty pixels,
 * which is plenty to move a hash and far below anything an eye resolves.
 */
export const CANVAS_STRIDE = 97;
export const CANVAS_BITS = 1;

/**
 * Audio, which needs a different shape of number.
 *
 * The bits are mantissa bits, so the change is relative: a touched sample moves
 * by roughly one part in two thousand whatever its magnitude, which is about
 * sixty six decibels down and inaudible everywhere in the buffer rather than
 * only where it happens to be quiet.
 *
 * The stride is tighter than the canvas one because an audio fingerprint
 * usually reduces the whole buffer to a single sum, and a change to one sample
 * in ninety seven of a quiet render can round away entirely. Forty four
 * thousand samples at one in seventeen is still well under three thousand
 * touched, which costs nothing.
 */
export const AUDIO_STRIDE = 17;
export const AUDIO_BITS = 12;

/**
 * The shared bucket.
 *
 * Standardize puts every session on one normalised machine. The seed being a
 * published constant is not a weakness, it is the entire mechanism: a bucket
 * only lowers uniqueness if everybody in it lands in the same place, and a
 * per-install random seed would give every user their own stable fingerprint,
 * which is worse than doing nothing. That is the difference between this and
 * Persona, where the seed is per session and must not be guessable.
 *
 * The machine described is deliberately dull: the most common desktop
 * configuration there is. A bucket that nobody else is in is not a bucket.
 *
 * Two fields are the real machine's rather than the bucket's, and it matters
 * why. Timezone and locale are checked against the exit IP by anybody who cares,
 * and a Melbourne address reporting a London clock is exactly the incoherence
 * this whole design exists to avoid. So the bucket does not fabricate them, and
 * `standardFor` takes them from the browser it is running on.
 */
/**
 * One bucket per operating system, and the reason there is not just one.
 *
 * A single bucket would have to pick an OS, and claiming a different one than
 * the machine actually runs is exactly what the validator refuses below tier 2:
 * request headers can be rewritten but client hint availability is negotiated
 * per origin, so the headers and the page would disagree. Presenting Windows to
 * every Mac user would be incoherence introduced by the feature meant to prevent
 * it.
 *
 * Three buckets is still a bucket. What matters is that everybody on the same
 * OS lands in the same place, not that everybody lands in one place.
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
 * The graphics card, which is bucketed by vendor rather than across vendors, and
 * the reason is a defect this had until it was measured.
 *
 * The first form put one card per operating system: every Windows machine
 * reported an RTX 3060. Probing WebGPU on an AMD laptop showed what that
 * actually produces. `navigator.gpu` reports `vendor: "amd"`,
 * `architecture: "rdna-3"` and AMD subgroup sizes, untouched, because WebGPU is
 * not masked. So the page claimed NVIDIA in one API and AMD in another, which is
 * a contradiction a single line of script finds, and it is worse than not
 * masking at all.
 *
 * The vendor is corroborated in too many places to fake at this tier. WebGPU
 * names it. The WebGL capability limits are shaped by it: viewport dimensions,
 * point size range, uniform vector counts. So is the supported extension list,
 * and so is shader precision. Faking the vendor means faking all of those or
 * being caught by any one of them, which is the same argument that made the
 * operating system bucket per OS rather than global.
 *
 * So the vendor stays, and what gets normalised is the model, which is where
 * nearly all of the entropy is anyway: the machine this was written on reports
 * an "AMD Radeon(TM) 8060S Graphics (0x00001586)", an uncommon integrated part
 * carrying its PCI device id in the string. A common card of the same vendor is
 * a real bucket.
 *
 * A combination not in this table leaves the strings alone. That is deliberate
 * rather than a gap: these strings have an exact format per platform, and one
 * invented badly is its own tell, so nothing is claimed where it cannot be
 * claimed with confidence. The five here cover the overwhelming majority of
 * desktops.
 *
 * `src/mask/index.ts` carries a copy, because it has to choose synchronously
 * with no channel to ask over. `tests/persona.test.ts` holds the two together.
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
 * Which vendor made the card a renderer string describes.
 *
 * Read from the real string rather than from the operating system, because the
 * operating system does not decide it: a Windows machine can be any of three and
 * a Mac can be two.
 *
 * Order matters. An Apple Silicon renderer says both "Apple" and "Metal", and an
 * ANGLE Metal string on an Intel Mac says "Metal" while naming Intel, so Apple is
 * tested on its own token rather than on the backend.
 */
export function vendorOf(renderer: string): GpuVendor | null {
  if (/\bapple\b/i.test(renderer)) return 'apple';
  if (/\bnvidia\b|geforce|quadro/i.test(renderer)) return 'nvidia';
  if (/\bamd\b|radeon|\bati\b/i.test(renderer)) return 'amd';
  if (/\bintel\b|\bhd graphics\b|\biris\b/i.test(renderer)) return 'intel';
  return null;
}

/**
 * The card to present, given the machine's real one. Null leaves it alone,
 * which is the answer for any combination this cannot state with confidence.
 */
export function cardFor(os: Os, realRenderer: string): { vendor: string; renderer: string } | null {
  const vendor = vendorOf(realRenderer);
  if (!vendor) return null;
  return CARDS[`${os}:${vendor}`] ?? null;
}

/**
 * What the bucket takes from the machine rather than inventing.
 *
 * Timezone and locale, because they are checked against the exit IP by anybody
 * who cares. And now the user agent and its brand list, for a different reason:
 * the normalised form is the real one with the browser's own name taken out of
 * it, so the Chromium version stays true. A written down user agent is correct
 * for one release and a contradiction afterwards, since the browser still has
 * the features of the version it actually is. See `useragent.ts`.
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
 * Surfaces the section 10 table names and this build does not patch yet.
 *
 * Exported so the panel and the manual can read it rather than restate it. The
 * one thing worse than an unfinished surface is a settings screen implying it is
 * finished, which is the same rule the storage panel already follows when it
 * reports an origin as shared.
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
