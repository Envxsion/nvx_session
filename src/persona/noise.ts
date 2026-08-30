/**
 * Seeded canvas noise.
 *
 * The determinism rule from section 03: a fingerprint surface returns the same
 * value for the same input for the lifetime of the session. Per call
 * randomisation is the single easiest way to be caught, because the probe is
 * `toDataURL()` twice and a diff. So there is no randomness here at all. Every
 * value is a pure function of the seed and the pixel's position, which makes it
 * stable across reloads, restarts and windows for free rather than by keeping
 * state anywhere.
 *
 * This file is the reference implementation. `src/mask/index.ts` carries a byte
 * for byte copy of `mix32` and `applyCanvasNoise`, because a MAIN world content
 * script is a classic script and cannot import anything, and because section 17
 * requires zero dependencies in the mask: every byte in that world is detection
 * surface. `tests/persona.test.ts` asserts the two agree rather than trusting
 * them to, the same arrangement `src/store/keys.ts` has with the storage shim.
 */

/**
 * A 32 bit mix of a seed and a coordinate pair.
 *
 * Not a hash for any security purpose. It has to be cheap, stable across
 * engines, and spread three small integers over the word well enough that
 * neighbouring pixels do not correlate. `Math.imul` rather than `*` because
 * multiplying past 2^53 silently loses the low bits that carry the mixing.
 */
export function mix32(seed: number, x: number, y: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (x + 0x85ebca6b), 0xcc9e2d51) >>> 0;
  h = ((h << 15) | (h >>> 17)) >>> 0;
  h = Math.imul(h ^ (y + 0xc2b2ae35), 0x1b873593) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * The same idea applied to audio samples.
 *
 * Audio fingerprinting renders an oscillator through a compressor in an
 * `OfflineAudioContext` and hashes the samples, or reads an `AnalyserNode`. The
 * output is float rather than byte, so "replace the low bits" needs a different
 * handle: the mantissa. Viewing the buffer as unsigned words and forcing the low
 * bits of each touched sample changes it by a relative epsilon, which is
 * idempotent for the same reason the canvas version is, and inaudible by
 * construction rather than by choosing a small number.
 *
 * Two kinds of sample are skipped, and both matter.
 *
 * Anything not finite. An infinity has an all ones exponent and a zero mantissa,
 * so writing bits into it produces a NaN, which would turn a loud sample into a
 * broken one rather than a slightly different one.
 *
 * And exact zero. Silence is genuinely common in an audio buffer, a freshly
 * constructed one is entirely zero, and forcing bits into a zero makes a
 * denormal around 1e-45. Inaudible, but a page that allocates a buffer and reads
 * it straight back would find it non-zero, which is a tell for nothing gained:
 * silence carries no fingerprint.
 */
export function applyAudioNoise(
  data: Float32Array,
  p: { seed: number; stride: number; bits: number }
): number {
  const { seed, stride, bits } = p;
  if (stride < 1 || bits < 1 || bits > 20) return 0;

  let words: Uint32Array;
  try {
    words = new Uint32Array(data.buffer, data.byteOffset, data.length);
  } catch {
    return 0;
  }

  const mask = (1 << bits) - 1;
  const total = data.length;
  let touched = 0;

  for (let block = 0; block * stride < total; block++) {
    const h = mix32(seed, block & 0xffff, block >>> 16);
    const index = block * stride + (h % stride);
    if (index >= total) continue;

    const sample = data[index] as number;
    if (sample === 0 || !Number.isFinite(sample)) continue;

    const raw = words[index] as number;
    const next = ((raw & ~mask) | ((h >>> 16) & mask)) >>> 0;
    if (next === raw) continue;
    words[index] = next;
    touched++;
  }

  return touched;
}

/**
 * A 32 bit seed for one surface, from the persona's seed material.
 *
 * FNV-1a, which is the right size of tool for turning a string into a number
 * deterministically. Section 10 specifies HKDF over the session key, and that is
 * what supplies `material` once Persona lands; this is the mixing step after it,
 * and is not itself a key derivation. Naming both parts here so nobody later
 * reads this as the security boundary, because it is not one.
 */
export function surfaceSeed(material: string, surface: string): number {
  const s = `${material}/${surface}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Rewrites the low bits of a sparse, seeded subset of pixels, in place, and
 * reports how many it changed.
 *
 * Three rules that look like details and are not.
 *
 * It replaces low bits rather than adding to them, which makes it idempotent:
 * running it twice gives the same buffer as running it once. That is not
 * tidiness, it is a coherence requirement. A site can read a canvas two ways,
 * `getImageData` directly, or `toDataURL` decoded back into a canvas and read.
 * On a real machine those agree. With additive noise they cannot, because the
 * second path is noised on the way out and again on the way back in, and the
 * disagreement is a signal nothing on a real machine produces. Forcing bits to
 * a seeded value survives the round trip unchanged.
 *
 * Fully transparent pixels are skipped. Their colour channels do not survive a
 * PNG encode, so perturbing one changes what `getImageData` returns and not what
 * `toDataURL` produces, which is the same disagreement by another route.
 *
 * And a pixel whose bits already match is left alone and not counted, so the
 * touched count means pixels actually changed rather than pixels considered.
 */
export function applyCanvasNoise(
  data: Uint8ClampedArray | number[],
  width: number,
  height: number,
  p: { seed: number; stride: number; bits: number }
): number {
  const { seed, stride, bits } = p;
  if (stride < 1 || bits < 1 || bits > 8) return 0;
  const mask = (1 << bits) - 1;
  const total = width * height;
  let touched = 0;

  /**
   * One pixel per block, rather than testing every pixel and keeping one in
   * `stride`.
   *
   * The first version hashed every pixel and threw away 96 results out of 97,
   * which made the cost proportional to the canvas rather than to the number of
   * pixels actually changed. Measured on a 512 by 512 encode it was the
   * difference between four times native and close to native, and section 11
   * lists a canvas patch timing anomaly as its own detection vector, so this is
   * a hardening change and not an optimisation.
   *
   * The offset inside each block comes from the hash, so the result is not a
   * lattice: consecutive blocks put their changed pixel in unrelated places. It
   * also guarantees coverage, which the old form did not: a small probe canvas
   * could come back entirely untouched depending on where its pixels fell.
   */
  for (let block = 0; block * stride < total; block++) {
    const h = mix32(seed, block & 0xffff, block >>> 16);
    const index = block * stride + (h % stride);
    if (index >= total) continue;

    const i = index * 4;
    if (data[i + 3] === 0) continue;

    const at = i + ((h >>> 8) % 3);
    const v = (data[at] as number) & 0xff;
    const next = (v & ~mask) | ((h >>> 16) & mask);
    if (next === v) continue;
    data[at] = next;
    touched++;
  }

  return touched;
}
