/**
 * ------------------------------------------------------------------
 *  Title    |  Seeded canvas and audio noise
 *  Ref      |  mix32, applyCanvasNoise, applyAudioNoise, mask/index.ts
 *  ID       |  M3 (fingerprint)
 * ------------------------------------------------------------------
 *  Purpose  |  Sub-perceptual, deterministic noise for fingerprint
 *           |  surfaces.
 *  How      |  A surface returns the same value for the same input for
 *           |  the session's life, so there is no randomness: every
 *           |  value is a pure function of seed and position, stable
 *           |  across reloads and restarts for free.
 *  Note     |  The reference implementation. `src/mask/index.ts`
 *           |  carries a byte-for-byte copy, because a MAIN world
 *           |  classic script cannot import, and
 *           |  `tests/persona.test.ts` asserts the two agree.
 *  Author   |  Ojas Kekre, 17/08/2026
 * ------------------------------------------------------------------
 */

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A 32 bit mix of a seed and a coordinate pair.
 *  Note     |  Not a hash for any security purpose. It must be cheap,
 *           |  stable across engines, and spread three small integers
 *           |  over the word so neighbouring pixels do not correlate.
 *           |  `Math.imul` not `*`, since multiplying past 2^53 loses
 *           |  the low bits that carry the mixing.
 * ------------------------------------------------------------------
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
 * ------------------------------------------------------------------
 *  Purpose  |  The same idea applied to audio samples.
 *  How      |  The output is float, so the handle is the mantissa:
 *           |  viewing the buffer as unsigned words and forcing the low
 *           |  bits of a touched sample changes it by a relative
 *           |  epsilon, idempotent like the canvas version and
 *           |  inaudible by construction.
 *  Note     |  Two samples are skipped. Anything not finite, since
 *           |  writing bits into an infinity makes a NaN. And exact
 *           |  zero, since silence is common and forcing bits makes a
 *           |  denormal a buffer read straight back would find non-zero,
 *           |  a tell for nothing gained.
 * ------------------------------------------------------------------
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
 * ------------------------------------------------------------------
 *  Purpose  |  A 32 bit seed for one surface, from the persona's seed
 *           |  material.
 *  How      |  FNV-1a, the right size of tool for turning a string into
 *           |  a number deterministically. This is the mixing step
 *           |  after the key derivation that supplies `material`, not
 *           |  itself a key derivation.
 *  Note     |  Not the security boundary, so nobody later reads it as
 *           |  one.
 * ------------------------------------------------------------------
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
 * ------------------------------------------------------------------
 *  Purpose  |  Rewrite the low bits of a sparse, seeded subset of
 *           |  pixels in place, and report how many changed.
 *  How      |  It replaces low bits rather than adding, so it is
 *           |  idempotent, which is a coherence requirement: a site can
 *           |  read a canvas via `getImageData` or via `toDataURL`
 *           |  decoded back, and additive noise makes the two disagree
 *           |  in a way no real machine does.
 *  Note     |  Fully transparent pixels are skipped, since their colour
 *           |  channels do not survive a PNG encode. A pixel whose bits
 *           |  already match is left alone and not counted, so the
 *           |  count means pixels changed, not pixels considered.
 * ------------------------------------------------------------------
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
