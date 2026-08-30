/**
 * The persona compiler, the validator, and the mask's copy of the noise.
 *
 * Everything here is pure. The mask itself needs a browser and is proved by the
 * fingerprint suite; what this file is for is the part that can be wrong without
 * a browser noticing, which is most of it.
 *
 * The last describe block is the important one. The mask runs in the MAIN world
 * of a page, so it is a classic script that cannot import, and section 17 asks
 * for zero dependencies in it besides. That means the noise algorithm exists
 * twice. Two implementations of the same maths is two chances to be right
 * differently, and the failure would be silent and severe: the compiled bundle
 * and the running mask would disagree about what a canvas should look like, and
 * every determinism guarantee downstream would be about nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyAudioNoise, applyCanvasNoise, mix32, surfaceSeed } from '../src/persona/noise.js';
import {
  AUDIO_BITS,
  AUDIO_STRIDE,
  CANVAS_BITS,
  CANVAS_STRIDE,
  cardFor,
  CARDS,
  compile,
  standardFor,
  vendorOf,
} from '../src/persona/compile.js';
import { validate } from '../src/persona/validate.js';
import {
  canNormalise,
  chromiumMajor,
  isGreaseBrand,
  secChUa,
  standardBrands,
  standardUserAgent,
} from '../src/persona/useragent.js';
import {
  compilePosture,
  MAX_POSTURE_HOSTS,
  POSTURE_ID_BASE,
  POSTURE_RULES,
} from '../src/persona/headers.js';
import { keepVoices } from '../src/persona/voices.js';
import type { Persona } from '../src/persona/types.js';

const REAL = { os: 'windows' as const, timezone: 'Australia/Melbourne', locale: 'en-AU' };
const STANDARD = standardFor(REAL);
const PATCH = { seed: surfaceSeed(STANDARD.seed, 'canvas'), stride: CANVAS_STRIDE, bits: CANVAS_BITS };

/** An opaque field of mid grey, which is the worst case for noise being seen. */
function field(w: number, h: number, alpha = 255): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 128;
    data[i * 4 + 1] = 128;
    data[i * 4 + 2] = 128;
    data[i * 4 + 3] = alpha;
  }
  return data;
}

describe('the noise', () => {
  /**
   * The determinism rule, and the whole reason none of this uses Math.random.
   * The probe is toDataURL() twice and a diff, and it costs an attacker nothing.
   */
  it('gives the same answer for the same drawing, every time', () => {
    const a = field(64, 64);
    const b = field(64, 64);
    applyCanvasNoise(a, 64, 64, PATCH);
    applyCanvasNoise(b, 64, 64, PATCH);
    expect([...a]).toEqual([...b]);
  });

  it('changes something on a probe-sized canvas', () => {
    // The common probes draw text into something around 220 by 30. A stride
    // that comes back clean on that is a mask nobody installed.
    const data = field(220, 30);
    const touched = applyCanvasNoise(data, 220, 30, PATCH);
    expect(touched).toBeGreaterThan(10);
  });

  it('stays sub-perceptual', () => {
    const before = field(96, 96);
    const after = field(96, 96);
    applyCanvasNoise(after, 96, 96, PATCH);
    let changed = 0;
    for (let i = 0; i < before.length; i++) {
      const delta = Math.abs((after[i] as number) - (before[i] as number));
      expect(delta).toBeLessThanOrEqual((1 << CANVAS_BITS) - 1);
      if (delta) changed++;
    }
    // One channel of one pixel at a time, and sparse. Anything approaching the
    // whole frame is both visible and measurably slow, and section 11 lists the
    // timing as its own detection vector.
    expect(changed).toBeGreaterThan(0);
    expect(changed / (96 * 96)).toBeLessThan(0.05);
  });

  /**
   * The round trip, and the reason this replaces bits instead of adding to them.
   *
   * A site can read one canvas two ways: getImageData directly, or toDataURL
   * decoded back into a canvas and read. On a real machine those agree. With
   * additive noise they cannot, because the second path is noised on the way out
   * and again on the way back in, and two surfaces disagreeing about one canvas
   * is a signal no real machine produces. Idempotence is what makes them agree,
   * so it is a correctness property rather than a tidiness one.
   */
  it('is idempotent, so a decode and re-read matches a direct read', () => {
    const once = field(80, 80);
    applyCanvasNoise(once, 80, 80, PATCH);

    const twice = Uint8ClampedArray.from(once);
    const changedOnSecondPass = applyCanvasNoise(twice, 80, 80, PATCH);

    expect(changedOnSecondPass).toBe(0);
    expect([...twice]).toEqual([...once]);
  });

  /**
   * A transparent pixel's colour channels do not survive a PNG encode, so
   * perturbing one moves what getImageData returns and not what toDataURL
   * produces. A site hashing both would see two surfaces disagree about one
   * canvas, which is a stronger signal than no spoofing at all.
   */
  it('leaves fully transparent pixels alone', () => {
    const data = field(48, 48, 0);
    expect(applyCanvasNoise(data, 48, 48, PATCH)).toBe(0);
    expect([...data]).toEqual([...field(48, 48, 0)]);
  });

  /**
   * Saturated images are where additive noise misbehaved: adding to 255 either
   * wraps to black, which is not sub-perceptual by any reading, or clamps and
   * loses the noise. Replacing low bits does neither, and the change stays
   * inside one level at both ends of the range.
   */
  it('works at both ends of the range without wrapping or vanishing', () => {
    for (const level of [0, 255]) {
      const data = new Uint8ClampedArray(48 * 48 * 4);
      for (let i = 0; i < 48 * 48; i++) {
        data[i * 4] = level;
        data[i * 4 + 1] = level;
        data[i * 4 + 2] = level;
        data[i * 4 + 3] = 255;
      }
      const touched = applyCanvasNoise(data, 48, 48, PATCH);
      expect(touched).toBeGreaterThan(0);
      for (let i = 0; i < 48 * 48; i++) {
        for (let c = 0; c < 3; c++) {
          expect(Math.abs((data[i * 4 + c] as number) - level)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('never touches alpha', () => {
    const data = field(64, 64, 200);
    applyCanvasNoise(data, 64, 64, PATCH);
    for (let i = 0; i < 64 * 64; i++) expect(data[i * 4 + 3]).toBe(200);
  });

  it('spreads across the word rather than correlating with position', () => {
    // Consecutive blocks landing in step would put the noise in a lattice and
    // make the whole subset predictable from one sample.
    const seen = new Set<number>();
    for (let x = 0; x < 40; x++) for (let y = 0; y < 40; y++) seen.add(mix32(1, x, y) % 97);
    expect(seen.size).toBeGreaterThan(80);
  });

  /**
   * Cost proportional to what changes, not to the canvas.
   *
   * The first version hashed every pixel and discarded 96 of every 97 results,
   * which put a measurable delay on encoding a large canvas. Section 11 lists a
   * canvas patch timing anomaly as its own vector, so this is a hardening
   * property with a test rather than an optimisation somebody might undo.
   */
  it('touches the buffer a bounded number of times, whatever its size', () => {
    let hashes = 0;
    const counted = { ...PATCH };
    // A million pixels at one in 97 is about ten thousand blocks. Anything
    // approaching the pixel count means the loop went back to testing each one.
    const big = field(1000, 1000);
    const before = performance.now();
    const touched = applyCanvasNoise(big, 1000, 1000, counted);
    const ms = performance.now() - before;
    hashes = Math.ceil((1000 * 1000) / counted.stride);

    expect(touched).toBeLessThanOrEqual(hashes);
    expect(touched).toBeGreaterThan(hashes / 4);
    // Generous, because this runs on whatever machine is to hand. It is here to
    // catch a return to per pixel work, which is a hundredfold, not a jitter.
    expect(ms).toBeLessThan(120);
  });

  /**
   * A small canvas is the one fingerprinters actually use, and the old form
   * could leave one entirely untouched depending on where its pixels fell.
   */
  it('always changes something, even on a tiny canvas', () => {
    for (const [w, h] of [
      [16, 16],
      [32, 8],
      [220, 30],
    ] as const) {
      expect(applyCanvasNoise(field(w, h), w, h, PATCH), `${w}x${h}`).toBeGreaterThan(0);
    }
  });

  it('is stable for a given seed and surface', () => {
    expect(surfaceSeed('nvx.standard.v1', 'canvas')).toBe(surfaceSeed('nvx.standard.v1', 'canvas'));
    expect(surfaceSeed('nvx.standard.v1', 'canvas')).not.toBe(
      surfaceSeed('nvx.standard.v1', 'webgl')
    );
    expect(surfaceSeed('a', 'canvas')).not.toBe(surfaceSeed('b', 'canvas'));
  });
});

describe('the audio noise', () => {
  const AUDIO = { seed: surfaceSeed(STANDARD.seed, 'audio'), stride: AUDIO_STRIDE, bits: AUDIO_BITS };

  /** A rendered tone, which is what an audio fingerprint actually hashes. */
  function tone(n: number): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.sin(i / 7) * 0.5;
    return out;
  }

  it('gives the same samples for the same render, every time', () => {
    const a = tone(4096);
    const b = tone(4096);
    applyAudioNoise(a, AUDIO);
    applyAudioNoise(b, AUDIO);
    expect([...a]).toEqual([...b]);
  });

  /**
   * getChannelData hands back a live view rather than a copy, so a second read
   * sees whatever the first one left behind. Without idempotence the buffer
   * would drift every time anybody looked at it, which is the loudest possible
   * version of the instability this whole design avoids.
   */
  it('is idempotent, because getChannelData returns a live view', () => {
    const once = tone(4096);
    applyAudioNoise(once, AUDIO);
    const twice = Float32Array.from(once);
    expect(applyAudioNoise(twice, AUDIO)).toBe(0);
    expect([...twice]).toEqual([...once]);
  });

  it('stays inaudible', () => {
    const before = tone(4096);
    const after = Float32Array.from(before);
    applyAudioNoise(after, AUDIO);
    for (let i = 0; i < before.length; i++) {
      const a = before[i] as number;
      const b = after[i] as number;
      if (a === b) continue;
      // Relative, because the bits are mantissa bits. One part in a thousand is
      // about sixty decibels down.
      expect(Math.abs(b - a) / Math.abs(a)).toBeLessThan(1e-3);
    }
  });

  it('changes enough of a render to move a hash', () => {
    const data = tone(44100);
    const touched = applyAudioNoise(data, AUDIO);
    expect(touched).toBeGreaterThan(1000);
  });

  /**
   * An infinity has an all ones exponent and a zero mantissa, so writing bits
   * into it makes a NaN: a loud sample would become a broken one rather than a
   * slightly different one.
   */
  it('leaves anything not finite alone', () => {
    const data = new Float32Array(512).fill(Infinity);
    data[3] = NaN;
    data[5] = -Infinity;
    applyAudioNoise(data, AUDIO);
    for (let i = 0; i < data.length; i++) {
      if (i === 3) expect(Number.isNaN(data[i])).toBe(true);
      else expect(Number.isFinite(data[i])).toBe(false);
    }
  });

  /**
   * Silence is common, a freshly constructed buffer is entirely zero, and a
   * page that allocates one and reads it straight back would find it non-zero
   * for no gain: silence carries no fingerprint.
   */
  it('leaves silence silent', () => {
    const data = new Float32Array(4096);
    expect(applyAudioNoise(data, AUDIO)).toBe(0);
    expect(data.every((v) => v === 0)).toBe(true);
  });
});

describe('the compiler', () => {
  it('compiles Mirror to a bundle that patches nothing', () => {
    const out = compile(STANDARD, 'mirror');
    expect(out.applied).toEqual([]);
    expect(out.canvas).toBeNull();
    expect(out.webgl).toBeNull();
    expect(out.audio).toBeNull();
  });

  it('compiles Standardize to the surfaces it patches, and says which', () => {
    const out = compile(STANDARD, 'standardize');
    expect(out.applied).toEqual(['canvas', 'webgl', 'audio', 'navigator', 'voices']);
    expect(out.canvas).toEqual(PATCH);
    expect(out.webgl).toMatchObject({ vendor: STANDARD.gpu.vendor, renderer: STANDARD.gpu.renderer });
  });

  /**
   * The bucket only lowers uniqueness if everybody lands in the same place. A
   * per-install seed would give each user their own stable fingerprint, which is
   * worse than doing nothing at all, so this is a constant and must stay one.
   */
  it('gives every install the same Standardize seed', () => {
    const melbourne = compile(standardFor(REAL), 'standardize');
    const tokyo = compile(
      standardFor({ os: 'windows', timezone: 'Asia/Tokyo', locale: 'ja-JP' }),
      'standardize'
    );
    expect(tokyo.canvas?.seed).toBe(melbourne.canvas?.seed);
    expect(tokyo.webgl?.seed).toBe(melbourne.webgl?.seed);
  });

  it('gives each surface its own seed', () => {
    const out = compile(STANDARD, 'standardize');
    // One number behind both would let anybody who works out the scheme derive
    // the second surface from the first.
    expect(out.webgl?.seed).not.toBe(out.canvas?.seed);
    expect(out.audio?.seed).not.toBe(out.canvas?.seed);
    expect(out.audio?.seed).not.toBe(out.webgl?.seed);
  });

  /**
   * One bucket per OS rather than one bucket, because claiming a different
   * operating system than the machine runs is what the validator refuses below
   * tier 2. Presenting Windows to every Mac user would be incoherence
   * introduced by the feature meant to prevent it.
   */
  it('describes a machine that passes its own validator on every OS', () => {
    for (const os of ['windows', 'macos', 'linux'] as const) {
      const p = standardFor({ os, timezone: 'Europe/London', locale: 'en-GB' });
      expect(validate(p, { realOs: os }), `${os} bucket`).toMatchObject({ ok: true });
    }
  });

  /**
   * Every card in the table, not just the one an OS falls back to. A renderer
   * string naming a backend that operating system does not have is the textbook
   * incoherence, and the table is the place it would be introduced.
   */
  it('describes a card that passes its own validator, for every entry in the table', () => {
    for (const [key, card] of Object.entries(CARDS)) {
      const os = key.split(':')[0] as 'windows' | 'macos' | 'linux';
      const p = { ...standardFor({ os, timezone: 'UTC', locale: 'en-US' }), gpu: card };
      expect(validate(p, { realOs: os }), key).toMatchObject({ ok: true });
    }
  });

  it('never presents a GPU that belongs to another OS', () => {
    for (const os of ['windows', 'macos', 'linux'] as const) {
      const other = (['windows', 'macos', 'linux'] as const).filter((o) => o !== os);
      for (const o of other) {
        expect(validate({ ...standardFor({ os, timezone: 'UTC', locale: 'en-US' }), os: o }, { realOs: o }).ok).toBe(
          false
        );
      }
    }
  });

  /**
   * The defect probing WebGPU found. The table used to hold one card per
   * operating system, so an AMD machine was told it had an NVIDIA card while
   * `navigator.gpu`, which is not masked, went on reporting AMD. The vendor is
   * corroborated by WebGPU, by the capability limits, by the extension list and
   * by shader precision, so it is not something that can be faked at this tier.
   */
  it('keeps the vendor the machine actually has', () => {
    const amd = 'ANGLE (AMD, AMD Radeon(TM) 8060S Graphics (0x00001586) Direct3D11 vs_5_0 ps_5_0, D3D11)';
    const chosen = cardFor('windows', amd);
    expect(vendorOf(chosen!.renderer)).toBe('amd');
    expect(chosen!.renderer).not.toBe(amd);
  });

  it('recognises the vendor from a renderer string on every platform form', () => {
    expect(vendorOf('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('nvidia');
    expect(vendorOf('ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)')).toBe('apple');
    expect(vendorOf('ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL 4.6)')).toBe('intel');
    expect(vendorOf('AMD Radeon Pro 5500M OpenGL Engine')).toBe('amd');
    expect(vendorOf('Mali-G78')).toBeNull();
  });

  /**
   * An Intel Mac names both Intel and Metal, and Apple Silicon names both Apple
   * and Metal, so the backend cannot be what decides it.
   */
  it('does not read an Apple backend as an Apple card', () => {
    expect(
      vendorOf('ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics, Unspecified Version)')
    ).toBe('intel');
  });

  /**
   * Nothing is claimed where it cannot be claimed with confidence. These strings
   * have an exact format per platform and one invented badly is its own tell.
   */
  it('leaves a combination it has no card for alone', () => {
    expect(cardFor('linux', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.6)')).toBeNull();
    expect(cardFor('windows', 'Mali-G78')).toBeNull();
  });

  /**
   * Timezone and locale are checked against the exit IP by anybody who cares,
   * and a Melbourne address reporting a London clock is exactly the incoherence
   * the design exists to avoid. So the bucket does not fabricate them.
   */
  it('keeps the real clock and language rather than the bucket to', () => {
    expect(STANDARD.timezone).toBe(REAL.timezone);
    expect(STANDARD.locale).toBe(REAL.locale);
  });

  it('describes a machine that passes its own validator', () => {
    expect(validate(STANDARD, { realOs: 'windows' })).toMatchObject({ ok: true, problems: [] });
  });
});

/**
 * The user agent is the one surface that is normalised rather than invented, so
 * what is being tested here is that the normalisation lands on plain Chrome from
 * every direction and never invents anything on the way.
 */
describe('the user agent', () => {
  const OPERA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 OPR/134.0.0.0';
  const CHROME =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

  it('takes the browser token off and leaves everything before it', () => {
    expect(standardUserAgent(OPERA)).toBe(CHROME);
    expect(standardUserAgent(`${CHROME} Edg/150.0.0.0`)).toBe(CHROME);
    expect(standardUserAgent(`${CHROME} Vivaldi/7.0`)).toBe(CHROME);
  });

  it('leaves a plain Chrome exactly as it found it', () => {
    expect(standardUserAgent(CHROME)).toBe(CHROME);
  });

  /**
   * The one difference that is not a suffix. An automation build says
   * HeadlessChrome in the middle of the string, and a cut alone would leave it
   * there.
   */
  it('rewrites the headless build in place', () => {
    expect(standardUserAgent(OPERA.replace('Chrome/', 'HeadlessChrome/'))).toBe(CHROME);
  });

  /**
   * The bug that shipped. The first form cut everything after `Safari/537.36`,
   * assuming the browser token is a suffix. For these two it is not, so the
   * normalisation silently did nothing, and every check downstream agreed with
   * it because the header rules published the same unnormalised string.
   */
  it('removes a browser token that sits before the Safari one', () => {
    const yandex =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 YaBrowser/24.10.0.0 Safari/537.36';
    expect(standardUserAgent(yandex)).toBe(CHROME);
  });

  it('keeps a mobile build mobile while still removing its brand', () => {
    const samsung =
      'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36';
    // The platform token stays, because it is real and the operating system is
    // not something this posture changes. Claiming a desktop Safari token beside
    // an Android platform would be a contradiction manufactured by the fix.
    expect(standardUserAgent(samsung)).toBe(
      'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Mobile Safari/537.36'
    );
  });

  it('refuses a shape it cannot state the canonical form of', () => {
    // A Chromium string with no Safari token. Emitting one would be inventing.
    const odd =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0';
    expect(standardUserAgent(odd)).toBe(odd);
  });

  /**
   * Whatever it emits has to survive being run through again, or the header and
   * the page can disagree the moment one of them normalises twice.
   */
  it('is idempotent', () => {
    for (const ua of [OPERA, CHROME, `${CHROME} Edg/150.0.0.0`]) {
      const once = standardUserAgent(ua);
      expect(standardUserAgent(once)).toBe(once);
    }
  });

  /**
   * Presenting Chrome from something that is not Chromium would contradict
   * every feature test a page can run, which is the opposite of the point.
   */
  it('refuses to make a Chrome out of something that is not one', () => {
    const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';
    expect(standardUserAgent(firefox)).toBe(firefox);
  });

  it('keeps the version the browser actually is', () => {
    // A written down version is right for one release. This one cannot go
    // stale, because it is never written down.
    expect(chromiumMajor(standardUserAgent(OPERA.replace(/150/g, '162')))).toBe(162);
  });

  // ------------------------------------------------------------- the brands

  const GREASE = { brand: 'Not;A=Brand', version: '8' };
  const OPERA_BRANDS = [GREASE, { brand: 'Chromium', version: '150' }, { brand: 'Opera GX', version: '134' }];

  it('recognises a greased entry however it is spelled', () => {
    for (const spelling of ['Not;A=Brand', 'Not_A Brand', 'Not.A/Brand', 'Not?A_Brand', 'Not A;Brand']) {
      expect(isGreaseBrand(spelling), spelling).toBe(true);
    }
    for (const real of ['Chromium', 'Google Chrome', 'Opera GX', 'Microsoft Edge', 'Brave']) {
      expect(isGreaseBrand(real), real).toBe(false);
    }
  });

  it('replaces only the browser and keeps the order it was given', () => {
    expect(standardBrands(OPERA_BRANDS)).toEqual([
      GREASE,
      { brand: 'Chromium', version: '150' },
      { brand: 'Google Chrome', version: '150' },
    ]);
  });

  /**
   * The subtle one. A browser numbers its releases separately from the engine,
   * so keeping Opera's own 134 would leave Google Chrome and Chromium claiming
   * different versions in one list, which no Chrome has ever sent.
   */
  it('gives the replacement the engine version, not the browser version', () => {
    const out = standardBrands(OPERA_BRANDS);
    const chrome = out.find((b) => b.brand === 'Google Chrome');
    expect(chrome?.version).toBe('150');
  });

  it('gives a plain Chromium the name Chrome has', () => {
    const out = standardBrands([GREASE, { brand: 'Chromium', version: '150' }]);
    expect(out).toContainEqual({ brand: 'Google Chrome', version: '150' });
  });

  it('leaves a list it cannot make sense of alone', () => {
    const odd = [{ brand: 'Some Browser', version: '1' }];
    expect(standardBrands(odd)).toBe(odd);
  });

  /**
   * The two have to move together. A list with no Chromium entry cannot be
   * normalised, and normalising the user agent anyway would leave a page
   * claiming Chrome beside a brand list still naming the browser it really is,
   * which is a contradiction inside one navigator rather than a disguise.
   */
  it('leaves the user agent alone when the brand list cannot be normalised', () => {
    const odd = [{ brand: 'Some Browser', version: '1' }];
    expect(canNormalise(odd)).toBe(false);
    const persona = standardFor({ ...REAL, userAgent: OPERA, brands: odd });
    expect(persona.userAgent).toBe(OPERA);
    expect(persona.brands).toEqual(odd);
  });

  it('normalises both when it can', () => {
    expect(canNormalise(OPERA_BRANDS)).toBe(true);
    const persona = standardFor({ ...REAL, userAgent: OPERA, brands: OPERA_BRANDS });
    expect(persona.userAgent).toBe(CHROME);
  });

  /** No brand list at all is not a failure: an origin sent no hints has nothing
   * to contradict. */
  it('normalises the user agent when there is no brand list to reconcile', () => {
    expect(canNormalise(undefined)).toBe(true);
    expect(standardFor({ ...REAL, userAgent: OPERA }).userAgent).toBe(CHROME);
  });

  it('formats the header the way the browser does', () => {
    expect(secChUa(standardBrands(OPERA_BRANDS))).toBe(
      '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"'
    );
  });

  /**
   * The header and the page are two reports of one list, and a page can read
   * both. They agree here because they are the same function over the same
   * input, which is the only arrangement that cannot drift.
   */
  it('puts the same list in the header as in the persona', () => {
    const persona = standardFor({ ...REAL, userAgent: OPERA, brands: OPERA_BRANDS });
    const { rules } = compilePosture({ hosts: ['example.com'], agent: { userAgent: persona.userAgent, brands: persona.brands ?? [] } });
    const hint = rules
      .flatMap((r) => r.action.requestHeaders ?? [])
      .find((h) => h.header === 'sec-ch-ua');
    expect(hint?.value).toBe(secChUa(persona.brands!));
  });
});

/**
 * The voice list, which the live suite can only prove does not break: every
 * voice on the machine it runs on is English, so the filter has nothing to
 * remove there. This is where the removing is actually tested.
 */
describe('the voice list', () => {
  const v = (name: string, lang: string, isDefault = false) => ({ name, lang, default: isDefault });

  const WINDOWS_EN_AU = [
    v('Microsoft David - English (United States)', 'en-US', true),
    v('Microsoft James - English (Australia)', 'en-AU'),
    v('Microsoft Catherine - English (Australia)', 'en-AU'),
    v('Microsoft Mark - English (United States)', 'en-US'),
    v('Microsoft Zira - English (United States)', 'en-US'),
  ];

  it('keeps every voice for a language the browser says it reads', () => {
    const out = keepVoices(WINDOWS_EN_AU, ['en-AU', 'en']);
    expect(out).toHaveLength(5);
  });

  /**
   * The bit worth removing. An installed language pack is a fact about the
   * machine that nothing else on the page would predict, unlike the languages
   * the browser advertises in the request it just sent.
   */
  it('drops a pack for a language the browser never claims to read', () => {
    const withPack = [...WINDOWS_EN_AU, v('Microsoft Haruka - Japanese', 'ja-JP'), v('Microsoft Hedda', 'de-DE')];
    const out = keepVoices(withPack, ['en-AU', 'en']);
    expect(out.map((x) => x.lang)).not.toContain('ja-JP');
    expect(out.map((x) => x.lang)).not.toContain('de-DE');
    expect(out).toHaveLength(5);
  });

  it('keeps a pack the browser does claim to read', () => {
    const withPack = [...WINDOWS_EN_AU, v('Microsoft Haruka - Japanese', 'ja-JP')];
    expect(keepVoices(withPack, ['en-AU', 'ja']).map((x) => x.lang)).toContain('ja-JP');
  });

  /**
   * The default is what a page reaches for when it has no preference, so
   * removing it would change what the machine sounds like rather than what it
   * reveals.
   */
  it('never hides the default, even when its language does not match', () => {
    const odd = [v('Kyoko', 'ja-JP', true), v('Microsoft Zira', 'en-US')];
    const out = keepVoices(odd, ['en-US']);
    expect(out[0]?.name).toBe('Kyoko');
    expect(out).toHaveLength(2);
  });

  it('puts the default first and sorts the rest', () => {
    const out = keepVoices(WINDOWS_EN_AU, ['en']);
    expect(out[0]?.default).toBe(true);
    const rest = out.slice(1).map((x) => `${x.lang} ${x.name}`);
    expect(rest).toEqual([...rest].sort());
  });

  /** Install order carries real bits, so two machines with one set agree. */
  it('gives the same order whatever order it was handed', () => {
    const shuffled = [WINDOWS_EN_AU[2]!, WINDOWS_EN_AU[0]!, WINDOWS_EN_AU[4]!, WINDOWS_EN_AU[1]!, WINDOWS_EN_AU[3]!];
    expect(keepVoices(shuffled, ['en'])).toEqual(keepVoices(WINDOWS_EN_AU, ['en']));
  });

  /**
   * A filter with nothing to filter against would empty the list for everybody,
   * which is a capability removal rather than a normalisation.
   */
  it('leaves the list alone when the browser advertises no language', () => {
    expect(keepVoices(WINDOWS_EN_AU, [])).toHaveLength(5);
  });

  it('has nothing to say about a list that has not loaded yet', () => {
    expect(keepVoices([], ['en'])).toEqual([]);
  });

  it('is idempotent', () => {
    const once = keepVoices(WINDOWS_EN_AU, ['en-AU']);
    expect(keepVoices(once, ['en-AU'])).toEqual(once);
  });
});

describe('the posture header rules', () => {
  const AGENT = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0 Safari/537.36',
    brands: [{ brand: 'Chromium', version: '150' }, { brand: 'Google Chrome', version: '150' }],
  };
  const compiled = (over: Partial<Parameters<typeof compilePosture>[0]> = {}) =>
    compilePosture({ hosts: ['example.com', 'localhost'], agent: AGENT, ...over });

  it('rewrites nothing under Mirror', () => {
    expect(compiled({ agent: null }).rules).toEqual([]);
  });

  it('rewrites nothing when no host is managed', () => {
    expect(compiled({ hosts: [] }).rules).toEqual([]);
  });

  it('stays inside its own id band', () => {
    for (const rule of compiled().rules) {
      expect(rule.id).toBeGreaterThanOrEqual(POSTURE_ID_BASE);
      expect(rule.id).toBeLessThan(POSTURE_ID_BASE + POSTURE_RULES);
      // The guard's band starts at 100 and the session band at 1000. An id
      // landing in either replaces a rule rather than adding one, and the rule
      // it replaced fails silently.
      expect(rule.id).toBeLessThan(100);
    }
    expect(new Set(compiled().rules.map((r) => r.id)).size).toBe(compiled().rules.length);
  });

  /**
   * A navigation is matched by where it is going because the document it
   * produces is masked only when its own url matches. A subresource is matched
   * by where it came from because it produces no document at all: its user
   * agent is the fetching page's, wherever it is going.
   */
  it('matches navigations by destination and subresources by origin', () => {
    const rules = compiled().rules;
    const navs = rules.filter((r) => r.condition.resourceTypes?.includes('main_frame'));
    const subs = rules.filter((r) => r.condition.excludedResourceTypes?.includes('main_frame'));

    expect(navs.length).toBeGreaterThan(0);
    expect(subs.length).toBeGreaterThan(0);
    for (const r of navs) {
      expect(r.condition.requestDomains).toEqual(['example.com', 'localhost']);
      expect(r.condition.initiatorDomains).toBeUndefined();
    }
    for (const r of subs) {
      expect(r.condition.initiatorDomains).toEqual(['example.com', 'localhost']);
      expect(r.condition.requestDomains).toBeUndefined();
    }
  });

  /**
   * Excluding the two navigation types rather than listing the dozen
   * subresource ones. A type added to the platform later is covered rather than
   * quietly left carrying the real browser.
   */
  it('covers subresource types it has never heard of', () => {
    const subs = compiled().rules.filter((r) => r.condition.excludedResourceTypes);
    for (const r of subs) expect(r.condition.resourceTypes).toBeUndefined();
  });

  it('sets the user agent on every scheme', () => {
    const ua = compiled().rules.filter((r) =>
      (r.action.requestHeaders ?? []).some((h) => h.header === 'user-agent')
    );
    expect(ua.length).toBe(2);
    for (const r of ua) expect(r.condition.urlFilter).toBeUndefined();
  });

  /**
   * Measured rather than assumed, and the assumption was wrong: Chromium sends
   * client hints to http://localhost. A rule gated on https would have left the
   * real brand list on the wire beside a normalised user agent on exactly the
   * origin the suite runs against.
   */
  it('sets the brand hints wherever the browser sends them', () => {
    const filters = compiled()
      .rules.filter((r) => (r.action.requestHeaders ?? []).some((h) => h.header === 'sec-ch-ua'))
      .map((r) => r.condition.urlFilter);
    for (const origin of ['|https://', '|http://localhost^', '|http://127.0.0.1^']) {
      expect(filters).toContain(origin);
    }
    expect(filters.every(Boolean)).toBe(true);
  });

  /**
   * The separator class, so a loopback prefix cannot be extended into an
   * ordinary insecure hostname that merely starts the same way.
   */
  it('does not treat localhost.example.com as a loopback origin', () => {
    const filters = compiled().rules.map((r) => r.condition.urlFilter);
    expect(filters).not.toContain('|http://localhost');
  });

  /**
   * `set` in this API is unconditional, so replacing these would send them to
   * every origin that never asked for one, which no browser does.
   */
  it('removes the brand hints it cannot answer rather than inventing them', () => {
    const edits = compiled().rules.flatMap((r) => r.action.requestHeaders ?? []);
    const full = edits.filter((h) => h.header === 'sec-ch-ua-full-version-list');
    expect(full.length).toBeGreaterThan(0);
    for (const h of full) expect(h.operation).toBe('remove');
  });

  /**
   * A domain the mask could not reach has to leave both conditions, not one.
   * A masked page's subresources are matched by where they came from, so an
   * origin that dropped out has to stop being an initiator as well as stop
   * being a destination.
   */
  it('withdraws a degraded host from both the navigation and the subresource rule', () => {
    const rules = compiled({ excluded: ['localhost'] }).rules;
    const navs = rules.filter((r) => r.condition.resourceTypes?.includes('main_frame'));
    const subs = rules.filter((r) => r.condition.excludedResourceTypes?.includes('main_frame'));

    expect(navs.length).toBeGreaterThan(0);
    expect(subs.length).toBeGreaterThan(0);
    for (const r of navs) expect(r.condition.excludedRequestDomains).toEqual(['localhost']);
    for (const r of subs) expect(r.condition.excludedInitiatorDomains).toEqual(['localhost']);
  });

  it('leaves the exclusion off entirely when nothing has been withdrawn', () => {
    for (const r of compiled().rules) {
      expect(r.condition.excludedRequestDomains).toBeUndefined();
      expect(r.condition.excludedInitiatorDomains).toBeUndefined();
    }
  });

  /**
   * A host can be both managed and withdrawn, and the exclusion is what has to
   * win: the rules still exist for the other hosts in the same condition.
   */
  it('keeps rewriting the hosts that did not refuse', () => {
    const rules = compiled({ excluded: ['localhost'] }).rules;
    for (const r of rules) {
      const domains = r.condition.requestDomains ?? r.condition.initiatorDomains ?? [];
      expect(domains).toContain('example.com');
    }
  });

  it('says which hosts did not fit rather than losing them quietly', () => {
    const many = Array.from({ length: MAX_POSTURE_HOSTS + 5 }, (_, i) => `h${i}.example`);
    const out = compilePosture({ hosts: many, agent: AGENT });
    expect(out.dropped.length).toBe(5);
    for (const r of out.rules) {
      const domains = r.condition.requestDomains ?? r.condition.initiatorDomains ?? [];
      expect(domains.length).toBe(MAX_POSTURE_HOSTS);
    }
  });

  /**
   * A script cannot enter a document that already exists, so a tab open before
   * the posture was chosen keeps the real canvas, audio and navigator for the
   * life of that document. Rewriting its headers anyway makes it report one
   * browser to itself and another to the network, and nothing does that by
   * accident, so the tab would be more identifiable than if this feature had
   * never been switched on. Measured on a real profile with fifty tabs open:
   * the page said OPR/134 and its own fetch arrived as Chrome/150.
   */
  describe('tabs older than the mask', () => {
    it('are left out of every rule rather than half covered', () => {
      const out = compiled({ unmasked: [7, 12] });
      expect(out.rules.length).toBeGreaterThan(0);
      for (const r of out.rules) expect(r.condition.excludedTabIds).toEqual([7, 12]);
    });

    it('are absent from the conditions when there are none, rather than empty', () => {
      for (const r of compiled().rules) {
        expect('excludedTabIds' in r.condition).toBe(false);
      }
      for (const r of compiled({ unmasked: [] }).rules) {
        expect('excludedTabIds' in r.condition).toBe(false);
      }
    });

    it('are excluded on the resource rules too, not only on navigations', () => {
      const out = compiled({ unmasked: [3] });
      const sub = out.rules.filter((r) => r.condition.initiatorDomains);
      expect(sub.length).toBeGreaterThan(0);
      for (const r of sub) expect(r.condition.excludedTabIds).toEqual([3]);
    });

    it('survive a list with the same tab twice', () => {
      for (const r of compiled({ unmasked: [4, 4, 4] }).rules) {
        expect(r.condition.excludedTabIds).toEqual([4]);
      }
    });

    /**
     * `chrome.tabs.TAB_ID_NONE` is -1 and reaches here through any code path
     * that stores a tab id it never had. The API rejects a negative id and a
     * rejected batch takes every posture rule with it, which would turn one
     * stray value into the whole feature being off.
     */
    it('drop an id no tab can have rather than letting the batch be refused', () => {
      for (const r of compiled({ unmasked: [-1, 9] }).rules) {
        expect(r.condition.excludedTabIds).toEqual([9]);
      }
    });

    it('leave the host exclusions alone', () => {
      const out = compiled({ unmasked: [2], excluded: ['bank.example'] });
      const nav = out.rules.filter((r) => r.condition.requestDomains);
      expect(nav.length).toBeGreaterThan(0);
      for (const r of nav) {
        expect(r.condition.excludedRequestDomains).toEqual(['bank.example']);
        expect(r.condition.excludedTabIds).toEqual([2]);
      }
    });
  });
});

describe('the validator', () => {
  const good = (over: Partial<Persona> = {}): Persona => ({ ...STANDARD, ...over });
  const codes = (p: Persona, realOs: 'windows' | 'macos' | 'linux' = 'windows') =>
    validate(p, { realOs }).problems.map((x) => x.code);

  it('refuses an Apple GPU on Windows', () => {
    expect(
      codes(good({ gpu: { vendor: 'Apple', renderer: 'Apple M2 Pro' } }))
    ).toContain('gpu.mismatch');
  });

  it('refuses a platform string that belongs to another OS', () => {
    expect(codes(good({ platform: 'MacIntel' }))).toContain('platform.mismatch');
  });

  it('refuses a user agent that names another OS', () => {
    expect(
      codes(good({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/151.0.0.0' }))
    ).toContain('ua.mismatch');
  });

  /**
   * The brand list and the user agent are two statements of one version and a
   * page reads both in a line. This is the shape a half finished rewrite takes.
   */
  it('refuses a brand list whose version disagrees with the user agent', () => {
    const brands = [
      { brand: 'Not;A=Brand', version: '8' },
      { brand: 'Chromium', version: '151' },
      { brand: 'Google Chrome', version: '134' },
    ];
    expect(codes(good({ brands }))).toContain('brands.version');
  });

  it('refuses a brand list with no greased entry', () => {
    const brands = [{ brand: 'Chromium', version: '151' }];
    expect(codes(good({ userAgent: STANDARD.userAgent, brands }))).toContain('brands.grease');
  });

  it('accepts the list the normaliser produces', () => {
    const major = String(chromiumMajor(STANDARD.userAgent));
    const brands = standardBrands([
      { brand: 'Not;A=Brand', version: '8' },
      { brand: 'Chromium', version: major },
      { brand: 'Opera GX', version: '134' },
    ]);
    expect(codes(good({ brands }))).toEqual([]);
  });

  it('refuses a deviceMemory the spec never reports', () => {
    expect(codes(good({ memory: 6 }))).toContain('memory.unbucketed');
    expect(codes(good({ memory: 8 }))).not.toContain('memory.unbucketed');
  });

  it('refuses an implausible core count', () => {
    expect(codes(good({ cores: 0 }))).toContain('cores.implausible');
    expect(codes(good({ cores: 512 }))).toContain('cores.implausible');
    expect(codes(good({ cores: 6.5 }))).toContain('cores.implausible');
  });

  it('refuses a mobile user agent on a desktop screen', () => {
    expect(
      codes(
        good({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Mobile) Chrome/151.0.0.0',
          screen: { width: 1920, height: 1080, dpr: 1 },
        })
      )
    ).toContain('screen.mismatch');
  });

  it('refuses a device pixel ratio no display reports', () => {
    expect(codes(good({ screen: { width: 1920, height: 1080, dpr: 1.37 } }))).toContain(
      'dpr.implausible'
    );
  });

  it('refuses a language that is not the head of the language list', () => {
    expect(codes(good({ locale: 'en-AU', languages: ['fr-FR', 'en-AU'] }))).toContain(
      'languages.head'
    );
  });

  it('refuses a clock that disagrees with the language', () => {
    expect(
      codes(good({ timezone: 'Asia/Tokyo', locale: 'en-AU', languages: ['en-AU'] }))
    ).not.toContain('zone.language');
    expect(
      codes(good({ timezone: 'Australia/Melbourne', locale: 'ja-JP', languages: ['ja-JP'] }))
    ).toContain('zone.language');
  });

  /**
   * Request headers can be rewritten, but the browser negotiates client hint
   * availability per origin and a declarative rule cannot model that, so an OS
   * change below tier 2 puts the headers and the page in disagreement.
   */
  it('refuses to change the OS below tier 2', () => {
    expect(codes(good(), 'macos')).toContain('tier.oschange');
    expect(codes(good({ tier: 2 }), 'macos')).not.toContain('tier.oschange');
    expect(codes(good(), 'windows')).not.toContain('tier.oschange');
  });

  /**
   * A rule that did not run is not a rule that passed. Folding the two together
   * would either refuse a valid persona because a caller omitted an input, or
   * report clean for a check nobody performed.
   */
  it('reports what it could not check rather than passing it', () => {
    const v = validate(good());
    expect(v.unchecked).toContain('tier.oschange');
    expect(v.problems.map((p) => p.code)).not.toContain('tier.oschange');

    const exotic = validate(good({ timezone: 'Antarctica/Casey' }), { realOs: 'windows' });
    expect(exotic.unchecked).toContain('zone.language');
  });

  it('says what is wrong rather than which rule fired', () => {
    for (const p of validate(good({ memory: 6, cores: 0 }), { realOs: 'windows' }).problems) {
      expect(p.message.length).toBeGreaterThan(30);
      expect(p.field).toBeTruthy();
    }
  });
});
