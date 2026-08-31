/**
 * ------------------------------------------------------------------
 *  Title    |  Fingerprint mask
 *  Ref      |  active, applyCanvasNoise, wrap, offEverything
 *  ID       |  M3 (mask)
 * ------------------------------------------------------------------
 *  Purpose  |  Patch the canvas, WebGL, audio and navigator read
 *           |  surfaces so they return the same sub-perceptual noise
 *           |  for the same drawing. Runs in the MAIN world at
 *           |  document_start. A free build resolves every posture to
 *           |  the Standardize bucket.
 *  How      |  It cannot yield: patches must land before any page
 *           |  script, so nothing awaits and the bundle is a compiled
 *           |  constant (persona.test.ts asserts it equals the
 *           |  Standardize compile). It cannot import: every byte is
 *           |  detection surface, so mix32 and the noise loops are
 *           |  copied from src/persona and held by test.
 *  Note     |  It must be invisible: a patched function's toString
 *           |  must say [native code] and nothing may throw where the
 *           |  page can see. It must fail closed: an unreachable
 *           |  worker means the mask takes itself off rather than
 *           |  leaving two disagreeing fingerprints on one machine.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

(function nvxMask(inherited?: string): void {
  /**
   * The origin's real session store, captured before anything can replace it.
   *
   * First statement in the file, and the position is the whole of it. The
   * storage shim replaces `window.sessionStorage` with a proxy that hides the
   * extension's own keys from the page, and the mask's seed material is one of
   * those keys, so a mask that read the property later would read the proxy and
   * be told there is nothing there.
   *
   * Two things were measured to get here rather than assumed. `sessionStorage`
   * is an own property of `window` on Chromium and is **not** on
   * `Window.prototype`, so the prototype accessor that the shim's own notes name
   * as a way back to the real store does not exist on this engine; reading
   * through it returned the proxy every time. And registered content scripts run
   * in the order they are registered, so the worker lists the mask ahead of the
   * shim, which is what makes this capture the real object.
   *
   * If that order ever reverses this holds a proxy, `getItem` answers null, and
   * every persona falls back to the shared bucket: wrong, but coherent, and the
   * fingerprint suite fails loudly on it rather than the product going quiet.
   */
  const rawSession: Storage | null = (() => {
    try {
      return window.sessionStorage;
    } catch {
      // A sandboxed frame or an opaque origin, where there is no store at all.
      return null;
    }
  })();

  // ------------------------------------------------------------ the bundle

  /**
   * Compiled from the Standardize bucket. Held to `compile(standardFor(...))`
   * by test; nothing here may be edited by hand without that test moving too.
   */
  const BUNDLE = {
    posture: 'standardize',
    canvas: { seed: 0xd6f1521a, stride: 97, bits: 1 },
    webgl: { seed: 0x79cb17db, stride: 97, bits: 1, sortExtensions: true },
    audio: { seed: 0x5fcd2920, stride: 17, bits: 12 },
    /**
     * Only the two counts are constants. The user agent and its brand list are
     * derived here from the real ones rather than written down, because a
     * written down version is correct for one release and a contradiction
     * afterwards: the browser still has the features of the version it actually
     * is. See src/persona/useragent.ts.
     */
    navigator: { hardwareConcurrency: 8, deviceMemory: 8 },
  };

  // ----------------------------------------------------------- the persona

  // The per-session persona fabrication (a seeded machine and GPU-model draw)
  // is a Pro algorithm and lives only in the private submodule copy of this
  // file, src/pro/overlay/mask/index.ts. In a free build the mask resolves
  // every posture to the Standardize bucket, so active() below always returns
  // that and never fabricates.

  interface Active {
    canvas: { seed: number; stride: number; bits: number };
    webgl: { seed: number; stride: number; bits: number; sortExtensions: boolean };
    audio: { seed: number; stride: number; bits: number };
    navigator: { hardwareConcurrency: number; deviceMemory: number };
    material: string | null;
  }

  /**
   * The bundle actually in force, resolved on first use and cached.
   *
   * A surface that answered one way at ten milliseconds and another way at fifty
   * is the single loudest thing this file could do: reading a canvas twice and
   * diffing is the first probe anybody writes. So the first read fixes the
   * answer for the life of the document.
   *
   * In a free build that answer is always the Standardize bucket: there is no
   * persona material, and the per-session fabrication is a Pro algorithm in the
   * private submodule copy of this file.
   */
  let resolved: Active | null = null;

  function active(): Active {
    if (resolved) return resolved;
    // Free builds never fabricate a persona: the answer is always the
    // Standardize bucket. The per-session fabrication (draw, MODELS, MACHINES)
    // is a Pro algorithm and lives in the private submodule copy of this file,
    // src/pro/overlay/mask/index.ts.
    resolved = { ...BUNDLE, material: null };
    return resolved;
  }

  /**
   * The card table, bucketed by vendor rather than across vendors.
   *
   * Copied from CARDS in src/persona/compile.ts and held to it by test. It has
   * to be here because the choice is made inside a synchronous call with no
   * channel to ask over.
   *
   * A combination absent from the table leaves the strings alone, which is also
   * what an unrecognised vendor gets. Reporting a machine this cannot describe
   * would be worse than reporting the real one.
   */
  const CARDS: Record<string, { vendor: string; renderer: string }> = {
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

  /** Copied verbatim from src/persona/compile.ts. See the note at the top. */
  function vendorOf(renderer: string): GpuVendor | null {
    if (/\bapple\b/i.test(renderer)) return 'apple';
    if (/\bnvidia\b|geforce|quadro/i.test(renderer)) return 'nvidia';
    if (/\bamd\b|radeon|\bati\b/i.test(renderer)) return 'amd';
    if (/\bintel\b|\bhd graphics\b|\biris\b/i.test(renderer)) return 'intel';
    return null;
  }

  function osOf(): string {
    const ua = navigator.userAgent;
    if (/Mac OS X/.test(ua)) return 'macos';
    if (/Windows NT/.test(ua)) return 'windows';
    if (/(X11|Linux)/.test(ua)) return 'linux';
    return '';
  }

  /**
   * The handshake that replaced a global, and why there is one at all.
   *
   * This was `globalThis.__nvxMask = { off, on }`. Two things were wrong with
   * it, and the smaller one is that `off` was a live handle: any page could call
   * it and take the mask off itself. The larger one is that the property existed
   * at all. **Every patch below is spent making a replaced function
   * indistinguishable from a native one, and one enumerable name on `window`
   * answers the question all of them were avoiding.** An extension only a few
   * people run is a stronger identifier than any fingerprint it hides, so
   * announcing itself makes its user more identifiable rather than less.
   *
   * Nothing can be hidden on a global: `getOwnPropertyNames` finds a property
   * whatever its flags. So the mask keeps no property anywhere, and the two
   * things that needed one ask a question instead.
   *
   * `Function.prototype.toString` is already replaced by a trap that answers for
   * functions the mask patched. Asking it about a value that is not a function
   * at all is something the real one always refuses, so a string it answers
   * instead is a signal only the mask can produce. It is not a secret, since
   * anyone can read this file, but it has to be known rather than enumerated,
   * which is the difference between being found by a scan and being found by
   * somebody looking for us specifically.
   */
  const HANDSHAKE = '__nvx.mask.v1';

  function alreadyInstalled(): boolean {
    try {
      // The real one throws a TypeError on a string receiver, always.
      return Function.prototype.toString.call(HANDSHAKE as unknown as () => void) === HANDSHAKE;
    } catch {
      return false;
    }
  }
  if (alreadyInstalled()) return;

  /**
   * Kept as a guard rather than as the value. Every read below goes through
   * `active()`, because which seed applies is not known until something asks.
   */
  if (!BUNDLE.canvas) return;

  // --------------------------------------------------------------- the noise

  /** Copied verbatim from src/persona/noise.ts. See the note at the top. */
  function mix32(seed: number, x: number, y: number): number {
    let h = (seed ^ 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ (x + 0x85ebca6b), 0xcc9e2d51) >>> 0;
    h = ((h << 15) | (h >>> 17)) >>> 0;
    h = Math.imul(h ^ (y + 0xc2b2ae35), 0x1b873593) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    return (h ^ (h >>> 13)) >>> 0;
  }

  /** Copied verbatim from src/persona/noise.ts. See the note at the top. */
  function applyCanvasNoise(
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

  /** Copied verbatim from src/persona/noise.ts. See the note at the top. */
  function applyAudioNoise(
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

  // --------------------------------------------------------- the user agent

  interface Brand {
    brand: string;
    version: string;
  }

  type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple';

  /** Copied verbatim from src/persona/useragent.ts. See the note at the top. */
  function isGreaseBrand(brand: string): boolean {
    return /not[^a-z0-9]*a[^a-z0-9]*brand/i.test(brand);
  }

  /** Copied verbatim from src/persona/useragent.ts. See the note at the top. */
  function canNormalise(brands: Brand[] | undefined): boolean {
    return !brands?.length || brands.some((b) => b.brand === 'Chromium');
  }

  /** Copied verbatim from src/persona/useragent.ts. See the note at the top. */
  function standardUserAgent(ua: string): string {
    const shape = /^Mozilla\/5\.0 \(([^)]*)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) (.*)$/.exec(
      ua
    );
    if (!shape) return ua;

    const platform = shape[1] ?? '';
    const rest = shape[2] ?? '';

    const version = /\b(?:Headless)?Chrome\/(\d+)[\d.]*/.exec(rest);
    // No Safari token means a build whose canonical form this cannot state, and
    // emitting one would be inventing rather than normalising.
    if (!version || !/\bSafari\/537\.36\b/.test(rest)) return ua;

    const mobile = /\bMobile\b/.test(rest) ? 'Mobile ' : '';
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version[1]}.0.0.0 ${mobile}Safari/537.36`;
  }

  /** Copied verbatim from src/persona/useragent.ts. See the note at the top. */
  function standardBrands(brands: Brand[]): Brand[] {
    const chromium = brands.find((b) => b.brand === 'Chromium');
    if (!chromium) return brands;

    let named = false;
    const out: Brand[] = [];
    for (const b of brands) {
      if (b.brand === 'Chromium' || isGreaseBrand(b.brand)) {
        out.push(b);
        continue;
      }
      // A browser listing two names of its own would otherwise become two Google
      // Chrome entries, which is a shape nothing sends.
      if (named) continue;
      named = true;
      out.push({ brand: 'Google Chrome', version: chromium.version });
    }
    if (!named) out.push({ brand: 'Google Chrome', version: chromium.version });
    return out;
  }

  // ------------------------------------------------------- native disguise

  /**
   * One trap for every patched function, not a shim per function.
   *
   * `Function.prototype.toString` is the cheapest probe there is, and a
   * per-function override leaves a `toString` own-property on each patch, which
   * is itself the tell. A single trap over the prototype leaves one, and the
   * trap has to survive being asked about itself:
   * `Function.prototype.toString.call(Function.prototype.toString)` must come
   * back native too.
   */
  const patched = new WeakSet<object>();
  const nativeToString = Function.prototype.toString;
  /** Kept so failing closed can put the real one back. See offEverything. */
  const trapWas = Object.getOwnPropertyDescriptor(Function.prototype, 'toString');

  function native(fn: unknown): string {
    const name = (fn as { name?: string })?.name ?? '';
    return `function ${name}() { [native code] }`;
  }

  const trap = function toString(this: unknown): string {
    // The handshake, answered only for a receiver the real one would refuse
    // outright. See the note where HANDSHAKE is declared: this is what a second
    // evaluation asks instead of the mask leaving a property behind, and what
    // the suite asks instead of reading one.
    // Compared through String rather than by identity, because a receiver
    // arrives boxed in sloppy mode and primitive in strict, and this file is
    // evaluated both ways: as a classic content script in a document, and with
    // a strict prologue inside a worker blob.
    if ((typeof this === 'string' || this instanceof String) && String(this) === HANDSHAKE) {
      return HANDSHAKE;
    }
    if (patched.has(this as object)) return native(this);
    return nativeToString.call(this);
  };
  patched.add(trap);

  /**
   * Replaces a method and keeps the shape.
   *
   * `name` and `length` are own, non-writable, configurable properties on a real
   * function, and a replacement that reports the wrong ones is as detectable as
   * one that reports the wrong source. Assigning them back is not enough,
   * because assignment on a non-writable property silently does nothing in
   * sloppy mode and throws in strict.
   */
  /**
   * The whole original descriptor is kept, not the value it held.
   *
   * Failing closed has to put back what was there, and what was there is not
   * always a value: `navigator.userAgent` is an accessor, and a patched
   * constructor's `prototype` was made non-writable to match a native one, so a
   * restore that assigns silently does nothing. Handing `defineProperty` the
   * descriptor it gave us is the only form that is right for all three.
   */
  const originals: Array<{ target: object; key: string; desc: PropertyDescriptor }> = [];

  function remember(target: object, key: string, desc: PropertyDescriptor): void {
    if (originals.some((o) => o.target === target && o.key === key)) return;
    originals.push({ target, key, desc });
  }

  function replace<T extends object>(target: T, key: string, make: (orig: never) => unknown): void {
    const desc = Object.getOwnPropertyDescriptor(target, key);
    if (!desc || typeof desc.value !== 'function') return;
    const orig = desc.value as never;
    const next = make(orig) as (...a: unknown[]) => unknown;

    Object.defineProperty(next, 'name', { value: desc.value.name, configurable: true });
    Object.defineProperty(next, 'length', { value: desc.value.length, configurable: true });
    patched.add(next);

    remember(target, key, desc);
    Object.defineProperty(target, key, { ...desc, value: next });
  }

  /**
   * The same, for a property that is read rather than called.
   *
   * `navigator.userAgent` is an accessor on the prototype, and replacing it with
   * a data property is detectable in one line: the descriptor a page reads back
   * would have a `value` where every real browser has a `get`. The getter's own
   * name is `get userAgent` rather than `userAgent`, so it is copied rather than
   * assumed.
   */
  function replaceGetter<T extends object>(
    target: T,
    key: string,
    make: (orig: () => unknown) => () => unknown
  ): void {
    const desc = Object.getOwnPropertyDescriptor(target, key);
    if (!desc || typeof desc.get !== 'function') return;
    const orig = desc.get as () => unknown;
    const next = make(orig);

    Object.defineProperty(next, 'name', { value: orig.name, configurable: true });
    Object.defineProperty(next, 'length', { value: 0, configurable: true });
    patched.add(next);

    remember(target, key, desc);
    Object.defineProperty(target, key, { ...desc, get: next });
  }

  /** A fixed answer, for a property whose real one is never needed. */
  function fixGetter<T extends object>(target: T, key: string, value: unknown): void {
    replaceGetter(target, key, () => () => value);
  }

  // ------------------------------------------------------------- the canvas

  /**
   * Reading a canvas through our own copy rather than through the patched path.
   *
   * `toDataURL` has to encode the noised pixels, and the only way to get pixels
   * is `getImageData`, which is patched. Calling the patched one would noise a
   * buffer that is then noised again on the next read, and the two surfaces
   * would disagree about the same canvas. So the originals are held here and
   * every internal read goes through them.
   */
  const c2d = globalThis.CanvasRenderingContext2D?.prototype;
  const offc2d = (globalThis as { OffscreenCanvasRenderingContext2D?: { prototype: object } })
    .OffscreenCanvasRenderingContext2D?.prototype;

  const rawGetImageData = c2d?.getImageData;
  const rawOffGetImageData = (offc2d as { getImageData?: unknown } | undefined)?.getImageData;

  function noiseInPlace(image: ImageData): ImageData {
    applyCanvasNoise(image.data, image.width, image.height, active().canvas);
    return image;
  }

  /**
   * A copy of a canvas with the noise baked in, for the encoders.
   *
   * Returns null when anything is unavailable or the canvas has no pixels, and
   * every caller falls back to the untouched original in that case. A blank
   * image is a broken page; an unnoised one is only an unmasked read.
   */
  function blank(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
    return typeof document !== 'undefined' && typeof document.createElement === 'function'
      ? Object.assign(document.createElement('canvas'), { width: w, height: h })
      : new globalThis.OffscreenCanvas(w, h);
  }

  function noisedCopy(
    source: HTMLCanvasElement | OffscreenCanvas
  ): HTMLCanvasElement | OffscreenCanvas | null {
    try {
      const w = source.width;
      const h = source.height;
      if (!w || !h) return null;

      const copy = blank(w, h);
      const target = (copy as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null;
      if (!target) return null;

      /**
       * The pixels come out through drawImage rather than through the source's
       * own 2D context, and that is what covers a WebGL canvas.
       *
       * Asking a canvas that holds a WebGL context for a 2D one returns null,
       * so the first version of this bailed out and left `toDataURL` on every
       * WebGL canvas unmasked while `readPixels` on the same canvas was masked.
       * One canvas, two answers, which is the incoherence the whole design is
       * trying not to produce. `drawImage` accepts a canvas whatever context it
       * holds, so composing into a 2D copy and reading from there works for
       * both and needs no special case.
       */
      target.drawImage(source as CanvasImageSource, 0, 0);

      const read = rawGetImageData as
        | ((this: unknown, sx: number, sy: number, sw: number, sh: number) => ImageData)
        | undefined;
      const readOff = rawOffGetImageData as typeof read;
      const readFrom = copy instanceof globalThis.OffscreenCanvas ? readOff : read;
      if (!readFrom) return null;

      const image = noiseInPlace(readFrom.call(target, 0, 0, w, h));
      target.putImageData(image, 0, 0);
      return copy;
    } catch {
      return null;
    }
  }

  function patchContext(proto: object | undefined): void {
    if (!proto) return;
    replace(proto, 'getImageData', (orig: never) =>
      function getImageData(this: unknown, ...args: unknown[]) {
        const image = (orig as (...a: unknown[]) => ImageData).apply(this, args);
        try {
          return noiseInPlace(image);
        } catch {
          // A page that gets a broken read is a page that breaks. Returning the
          // real pixels is a failure of masking, not of the site.
          return image;
        }
      }
    );
  }

  patchContext(c2d);
  patchContext(offc2d);

  const canvasProto = globalThis.HTMLCanvasElement?.prototype;
  if (canvasProto) {
    replace(canvasProto, 'toDataURL', (orig: never) =>
      function toDataURL(this: HTMLCanvasElement, ...args: unknown[]) {
        const copy = noisedCopy(this);
        return (orig as (...a: unknown[]) => string).apply(copy ?? this, args);
      }
    );
    replace(canvasProto, 'toBlob', (orig: never) =>
      function toBlob(this: HTMLCanvasElement, ...args: unknown[]) {
        const copy = noisedCopy(this);
        return (orig as (...a: unknown[]) => void).apply(copy ?? this, args);
      }
    );
  }

  const offscreenProto = (globalThis as { OffscreenCanvas?: { prototype: object } }).OffscreenCanvas
    ?.prototype;
  if (offscreenProto) {
    replace(offscreenProto, 'convertToBlob', (orig: never) =>
      function convertToBlob(this: OffscreenCanvas, ...args: unknown[]) {
        const copy = noisedCopy(this);
        return (orig as (...a: unknown[]) => Promise<Blob>).apply(copy ?? this, args);
      }
    );
  }

  // -------------------------------------------------------------- the webgl

  /**
   * Two enum values that only exist once an extension has been asked for.
   *
   * `getParameter(VENDOR)` reports the browser's own generic string on every
   * machine and carries almost nothing. The values worth anything are behind
   * `WEBGL_debug_renderer_info`, and their numbers are fixed by that extension
   * rather than by the context, so they can be written down.
   */
  const UNMASKED_VENDOR = 0x9245;
  const UNMASKED_RENDERER = 0x9246;

  const webgl = BUNDLE.webgl;
  /**
   * Read at call time, not at install time. The seed differs per session under
   * Persona and the extension list sort does not, so only the seed is deferred.
   */

  /** Contexts that have obtained WEBGL_debug_renderer_info. See below. */
  const unmaskable = new WeakSet<object>();

  /**
   * The card is chosen when somebody asks, not when the mask installs.
   *
   * Choosing it needs the machine's real renderer string, and reading that needs
   * a WebGL context. Creating one at document_start on every managed page would
   * be real work on pages that never touch WebGL, and section 11 counts cost as
   * its own vector. Resolving it inside the first call that asks costs nothing,
   * because the caller already has a context to read from.
   *
   * `undefined` means not asked yet, `null` means asked and there is no bucket
   * for this machine, in which case the real strings go through untouched.
   */
  let card: { vendor: string; renderer: string } | null | undefined;

  function cardFrom(realRenderer: string): { vendor: string; renderer: string } | null {
    if (card !== undefined) return card;
    const vendor = vendorOf(realRenderer);
    const os = osOf();
    const bucket = vendor && os ? (CARDS[`${os}:${vendor}`] ?? null) : null;

    /**
     * A free build carries no persona material, so this is always the bucket's
     * own card. It leaves the real strings alone whenever there is no bucket for
     * the machine, so an unrecognised one is left entirely alone rather than
     * described badly.
     */
    // Free builds carry no persona material, so the card is always the bucket's
    // own. The persona model draw is a Pro algorithm in the submodule copy.
    card = bucket;
    return card;
  }

  for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext'] as const) {
    const proto = (globalThis as unknown as Record<string, { prototype: object } | undefined>)[name]
      ?.prototype;
    if (!proto) continue;

    {
      /**
       * Answer only for a context that actually holds the extension.
       *
       * The first version substituted on the enum alone, and that is a tell
       * rather than a mask. On a real machine `getParameter(0x9246)` without
       * having obtained `WEBGL_debug_renderer_info` returns null and raises
       * INVALID_ENUM; ours returned the renderer string to anybody who passed
       * the number, so one call on a fresh context found it. It also lied on a
       * driver that does not expose the extension at all, where the honest
       * answer is that there is nothing to unmask.
       */
      replace(proto, 'getExtension', (orig: never) =>
        function getExtension(this: unknown, name: string) {
          const ext = (orig as (this: unknown, n: string) => unknown).call(this, name);
          if (ext && String(name).toLowerCase() === 'webgl_debug_renderer_info') {
            unmaskable.add(this as object);
          }
          return ext;
        }
      );

      replace(proto, 'getParameter', (orig: never) =>
        function getParameter(this: unknown, pname: number) {
          const call = orig as (this: unknown, p: number) => unknown;
          if (
            unmaskable.has(this as object) &&
            (pname === UNMASKED_VENDOR || pname === UNMASKED_RENDERER)
          ) {
            // Read the real one through the original, which is both how the
            // vendor is decided and what gets returned when there is no bucket
            // for it.
            const real = cardFrom(String(call.call(this, UNMASKED_RENDERER) ?? ''));
            if (real) return pname === UNMASKED_VENDOR ? real.vendor : real.renderer;
          }
          return call.call(this, pname);
        }
      );
    }

    if (webgl.sortExtensions) {
      replace(proto, 'getSupportedExtensions', (orig: never) =>
        function getSupportedExtensions(this: unknown) {
          const list = (orig as (this: unknown) => string[] | null).call(this);
          // Sorted, never filtered. Order is driver dependent and carries real
          // bits; removing an entry would claim the driver cannot do something
          // it can, and a page that believed it would take a slower path or
          // fail outright.
          return list ? [...list].sort() : list;
        }
      );
    }

    /**
     * The pixels a WebGL fingerprint actually consumes.
     *
     * Same seeded, sparse, idempotent treatment as the 2D canvas, on its own
     * seed. Only the common 8 bit RGBA read is touched: a float or integer
     * buffer is a page doing real graphics work rather than fingerprinting, and
     * flipping bits in one would corrupt a computation rather than a hash.
     */
    replace(proto, 'readPixels', (orig: never) =>
      function readPixels(
        this: unknown,
        x: number,
        y: number,
        w: number,
        h: number,
        format: number,
        type: number,
        pixels: ArrayBufferView | null,
        ...rest: unknown[]
      ) {
        const out = (orig as (...a: unknown[]) => unknown).call(
          this,
          x,
          y,
          w,
          h,
          format,
          type,
          pixels,
          ...rest
        );
        try {
          const RGBA = 0x1908;
          const UNSIGNED_BYTE = 0x1401;
          if (
            format === RGBA &&
            type === UNSIGNED_BYTE &&
            pixels instanceof Uint8Array &&
            pixels.length >= w * h * 4
          ) {
            applyCanvasNoise(pixels as unknown as number[], w, h, active().webgl);
          }
        } catch {
          /* a read the page can still use beats a throw it cannot */
        }
        return out;
      }
    );
  }

  // -------------------------------------------------------------- the audio

  /**
   * Patch the read, not the render.
   *
   * An audio fingerprint runs an oscillator through a compressor in an
   * `OfflineAudioContext` and hashes the samples, or reads an `AnalyserNode` on
   * a live one. Both of those end at a typed array, and the array is the only
   * place worth standing: patching `startRendering` would mean rewriting an
   * `AudioBuffer` in flight, and there is no need when everything that reads one
   * has to come through here.
   *
   * `getChannelData` hands back a live view of the buffer rather than a copy, so
   * this changes the buffer itself. That is the right answer rather than a
   * compromise: every later reader sees the same thing, a second call returns
   * the same samples because the transform is idempotent, and if the page plays
   * the buffer it plays something nobody can hear the difference in.
   */
  const audio = BUNDLE.audio;

  const bufferProto = (globalThis as { AudioBuffer?: { prototype: object } }).AudioBuffer?.prototype;
  if (bufferProto && audio) {
    replace(bufferProto, 'getChannelData', (orig: never) =>
      function getChannelData(this: unknown, channel: number) {
        const data = (orig as (this: unknown, c: number) => Float32Array).call(this, channel);
        try {
          applyAudioNoise(data, active().audio);
        } catch {
          /* a buffer the page can still use beats a throw it cannot */
        }
        return data;
      }
    );

    // The copying read. It writes into the page's own array rather than handing
    // back the buffer's, so noising the source would not reach it.
    replace(bufferProto, 'copyFromChannel', (orig: never) =>
      function copyFromChannel(
        this: unknown,
        destination: Float32Array,
        channel: number,
        ...rest: unknown[]
      ) {
        const out = (orig as (...a: unknown[]) => unknown).call(
          this,
          destination,
          channel,
          ...rest
        );
        try {
          applyAudioNoise(destination, active().audio);
        } catch {
          /* as above */
        }
        return out;
      }
    );
  }

  const analyserProto = (globalThis as { AnalyserNode?: { prototype: object } }).AnalyserNode
    ?.prototype;
  if (analyserProto && audio) {
    replace(analyserProto, 'getFloatFrequencyData', (orig: never) =>
      function getFloatFrequencyData(this: unknown, array: Float32Array) {
        const out = (orig as (this: unknown, a: Float32Array) => unknown).call(this, array);
        try {
          applyAudioNoise(array, active().audio);
        } catch {
          /* as above */
        }
        return out;
      }
    );

    /**
     * The byte variants are quantised to 0..255 already, so they take the
     * integer treatment with a single low bit rather than the mantissa one. A
     * twelve bit mantissa change on a value that has been rounded to a byte
     * would either vanish or be enormous, depending where it landed.
     */
    for (const name of ['getByteFrequencyData', 'getByteTimeDomainData'] as const) {
      replace(analyserProto, name, (orig: never) =>
        function getByteData(this: unknown, array: Uint8Array) {
          const out = (orig as (this: unknown, a: Uint8Array) => unknown).call(this, array);
          try {
            // One row of samples, so the height is one and the width is the
            // length. The alpha check inside never fires on a three channel
            // stride, which is why this passes the length as a pixel count.
            const bytes = array as unknown as number[];
            const cur = active().audio;
            const p = { seed: cur.seed, stride: cur.stride, bits: 1 };
            for (let block = 0; block * p.stride < array.length; block++) {
              const h = mix32(p.seed, block & 0xffff, block >>> 16);
              const index = block * p.stride + (h % p.stride);
              if (index >= array.length) continue;
              const v = (bytes[index] as number) & 0xff;
              if (v === 0) continue;
              const next = (v & ~1) | ((h >>> 16) & 1);
              bytes[index] = next;
            }
          } catch {
            /* as above */
          }
          return out;
        }
      );
    }
  }

  // ----------------------------------------------------------- the navigator

  /**
   * The one surface here that is not answerable inside the page.
   *
   * `navigator.userAgent` and the `User-Agent` header are two reports of the
   * same fact, and rewriting only the one the page can see hands any server a
   * contradiction for free. The other half is compiled in
   * `src/persona/headers.ts` and installed by the worker before this script is
   * ever registered, so the two cannot be on at different times.
   *
   * Nothing is written down. The normalised user agent is the real one with the
   * browser's own token removed, which keeps the Chromium version true, and the
   * brand list is the real list with the browser's own name replaced, which
   * keeps the greased entry the browser generated. On a plain Chrome both are
   * already what they would be normalised to, and nothing is patched at all:
   * every patch is detection surface, and one that changes nothing is a pure
   * cost.
   */
  const nav = BUNDLE.navigator;
  const realBrands = (navigator as unknown as { userAgentData?: { brands?: Brand[] } }).userAgentData
    ?.brands;

  /**
   * The user agent and the brand list move together or neither moves.
   *
   * A list this cannot normalise would be left naming the real browser beside a
   * user agent claiming Chrome, which is a contradiction inside one navigator
   * rather than a disguise. The worker makes the same decision from the same
   * predicate on the same browser, so the page and the headers cannot land on
   * different sides of it.
   */
  const realUa = navigator.userAgent;
  const fakeUa = canNormalise(realBrands) ? standardUserAgent(realUa) : realUa;

  const navProtos: object[] = [];
  for (const name of ['Navigator', 'WorkerNavigator'] as const) {
    const proto = (globalThis as unknown as Record<string, { prototype: object } | undefined>)[name]
      ?.prototype;
    if (proto) navProtos.push(proto);
  }

  for (const proto of navProtos) {
    if (fakeUa !== realUa) {
      fixGetter(proto, 'userAgent', fakeUa);
      /**
       * `appVersion` is the user agent without its `Mozilla/` prefix, and it is
       * derived from the patched one rather than normalised on its own.
       *
       * It was normalised separately, and that broke the moment the normaliser
       * started matching on the shape of a whole user agent: `appVersion` does
       * not begin with `Mozilla/`, so it stopped matching and went back
       * untouched, leaving the page reporting a normalised `userAgent` beside an
       * `appVersion` that still named Opera. Deriving one from the other is what
       * makes them agree by construction instead of by coincidence, which is the
       * only reason this property is patched at all.
       */
      fixGetter(proto, 'appVersion', fakeUa.replace(/^Mozilla\//, ''));
    }

    /**
     * Counts, which are bucketed rather than removed. Neither has a counterpart
     * in CSS or in a request header, so normalising them cannot contradict
     * anything: the most a page loses is sizing a worker pool to eight.
     */
    replaceGetter(proto, 'hardwareConcurrency', () => () => active().navigator.hardwareConcurrency);
    if (Object.getOwnPropertyDescriptor(proto, 'deviceMemory')) {
      replaceGetter(proto, 'deviceMemory', () => () => active().navigator.deviceMemory);
    }
  }

  /**
   * The brand list, patched on its own prototype rather than by replacing the
   * object.
   *
   * Handing back a substitute for `navigator.userAgentData` would fail
   * `instanceof NavigatorUAData` and give the wrong prototype, both of which are
   * one line probes. Patching the accessors leaves the object the browser made
   * exactly where it was.
   */
  const uaDataProto = (globalThis as { NavigatorUAData?: { prototype: object } }).NavigatorUAData
    ?.prototype;
  const fakeBrands = realBrands?.length ? standardBrands(realBrands) : null;
  const brandsMoved =
    Boolean(fakeBrands) && JSON.stringify(fakeBrands) !== JSON.stringify(realBrands);

  if (uaDataProto && fakeBrands && brandsMoved) {
    // A fresh array each time, because the real accessor hands one back rather
    // than the same object twice, and a page that mutates what it is given must
    // not be able to change what the next reader sees.
    replaceGetter(uaDataProto, 'brands', () => () => fakeBrands.map((b) => ({ ...b })));

    replace(uaDataProto, 'toJSON', (orig: never) =>
      function toJSON(this: unknown) {
        const out = (orig as (this: unknown) => Record<string, unknown>).call(this);
        // The native one reads the browser's own state rather than the accessor
        // above it, so it answers with the real list unless it is told too.
        return { ...out, brands: fakeBrands.map((b) => ({ ...b })) };
      }
    );

    /**
     * The high entropy read, which is the same list at full precision plus the
     * fields nobody normalises.
     *
     * `uaFullVersion` and `fullVersionList` name the browser, so they take the
     * same treatment. Architecture, bitness, model and platform version are the
     * machine rather than the browser, and the machine is real here: this
     * posture keeps the operating system it is actually running on, so there is
     * nothing to reconcile.
     */
    replace(uaDataProto, 'getHighEntropyValues', (orig: never) =>
      function getHighEntropyValues(this: unknown, hints: string[]) {
        const call = orig as (this: unknown, h: unknown) => Promise<Record<string, unknown>>;
        // Anything that is not a list is the page's own error, and turning it
        // into a success by substituting one would be a behaviour change.
        if (!Array.isArray(hints)) return call.call(this, hints);

        /**
         * The full version list is always asked for, and trimmed back out if
         * the page did not want it.
         *
         * `uaFullVersion` is the browser's own full version, so on Opera it
         * reads 134.0.6998.0 where the user agent beside it says Chrome 150.
         * The number that belongs there is the engine's, and the only place to
         * read it is the full version list. Asking only for what the page asked
         * for meant a page requesting `uaFullVersion` alone got the real one:
         * the correction had nothing to derive itself from and silently did
         * nothing, which is the same failure shape as the user agent trim.
         */
        const wants = hints.includes('fullVersionList');
        const need = wants ? hints : [...hints, 'fullVersionList'];

        return call.call(this, need).then((out) => {
          const full = out.fullVersionList as Brand[] | undefined;
          const chromium = Array.isArray(full)
            ? full.find((b) => b.brand === 'Chromium')
            : undefined;

          const next: Record<string, unknown> = {};
          for (const key of Object.keys(out)) {
            // Handing back a hint nobody requested is its own tell.
            if (key === 'fullVersionList' && !wants) continue;
            next[key] = out[key];
          }

          if (Array.isArray(next.brands)) next.brands = fakeBrands.map((b) => ({ ...b }));
          if (Array.isArray(next.fullVersionList)) {
            next.fullVersionList = standardBrands(next.fullVersionList as Brand[]);
          }
          if (typeof next.uaFullVersion === 'string' && chromium) {
            next.uaFullVersion = chromium.version;
          }
          return next;
        });
      }
    );
  }

  // -------------------------------------------------------------- the voices

  /**
   * The installed speech voices, which are the strongest operating system tell
   * left in the page and were not in the applied list at all until somebody
   * asked whether the table had really been finished.
   *
   * The list here reads `Microsoft David`, `Mark` and `Zira` for en-US and
   * `James` and `Catherine` for en-AU. The first three ship with every English
   * Windows. The last two are an installed Australian language pack, and that
   * is the part worth removing: it is a fact about the machine that nothing else
   * the page can see would predict.
   *
   * So the rule is to keep what is already predictable and drop what is not.
   * A voice whose language the browser already advertises in
   * `navigator.languages` tells a page nothing it could not read from
   * `Accept-Language`. A voice for a language the browser never claims to read
   * is an optional pack, and those are what make one machine distinguishable
   * from the next.
   *
   * Three things this deliberately does not do. It does not fabricate voices:
   * `SpeechSynthesisVoice` has no constructor, so a made up list would be plain
   * objects with the wrong prototype, which is a one line find and would break
   * `speak`. It does not write any voice name down, because a written down list
   * ages with the operating system exactly the way a written down user agent
   * does. And it does not hide the default voice even when its language does not
   * match, because the default is the one a page reaches for when it has no
   * preference and removing it changes what the machine sounds like rather than
   * what it reveals.
   *
   * Returning an empty list is safe by construction here: `getVoices` already
   * returns nothing until the list has loaded, which is the entire reason
   * `onvoiceschanged` exists, so every page that uses this already handles it.
   */
  interface Voice {
    lang: string;
    name: string;
    default: boolean;
  }

  /** Copied verbatim from src/persona/voices.ts. See the note at the top. */
  function keepVoices<T extends Voice>(all: T[], languages: readonly string[]): T[] {
    if (!Array.isArray(all) || !all.length) return all;

    const spoken = new Set<string>();
    for (const tag of languages) {
      const primary = String(tag).split('-')[0];
      if (primary) spoken.add(primary.toLowerCase());
    }
    // A browser always reads at least one language, and a filter with nothing to
    // filter against would empty the list for everybody.
    if (!spoken.size) return all;

    const keep = all.filter((v) => {
      if (v.default) return true;
      const primary = String(v.lang ?? '').split('-')[0];
      return primary ? spoken.has(primary.toLowerCase()) : false;
    });

    /**
     * Sorted, for the same reason the WebGL extension list is: install order is a
     * fact about the machine and carries real bits. The default stays first,
     * because a page with no preference reaches for index zero and moving it
     * changes which voice speaks.
     */
    const rest = keep
      .filter((v) => !v.default)
      .sort((a, b) => String(a.lang).localeCompare(String(b.lang)) || String(a.name).localeCompare(String(b.name)));

    return [...keep.filter((v) => v.default), ...rest];
  }

  const speechProto = (globalThis as { SpeechSynthesis?: { prototype: object } }).SpeechSynthesis
    ?.prototype;
  if (speechProto) {
    replace(speechProto, 'getVoices', (orig: never) =>
      function getVoices(this: unknown) {
        const all = (orig as (this: unknown) => Voice[]).call(this);
        try {
          return keepVoices(all, navigator.languages ?? []);
        } catch {
          // A page with a voice list beats a page with an exception.
          return all;
        }
      }
    );
  }

  // ------------------------------------------------------------- the workers

  /**
   * Worker propagation, and the fail-closed rule.
   *
   * This is the most common failure in extension based spoofing: content scripts
   * do not run in worker scopes, so a fingerprinter that builds its canvas hash
   * inside a Worker with an OffscreenCanvas reads pristine values and sees them
   * disagree with the patched main thread. That mismatch is a stronger signal
   * than no spoofing at all, because nothing on a real machine produces it.
   *
   * So the constructor rewrites the script into a blob that runs this mask first
   * and then imports the original. When that cannot be done, and CSP worker-src
   * or a cross-origin script are the usual reasons, the mask takes itself back
   * off the main thread and lets the page see one real fingerprint rather than
   * two fabricated ones that do not match.
   */
  let source: string | null = null;
  try {
    source = nativeToString.call(nvxMask);
  } catch {
    source = null;
  }

  function wrap(url: string | URL, opts?: WorkerOptions): string | URL {
    if (!source) throw new Error('no source');
    const absolute = new URL(String(url), (globalThis as { location?: Location }).location?.href);
    // A module worker cannot importScripts, so the original is pulled in with a
    // static import instead and the mask runs before it either way.
    // The prologue is not decoration. This file is compiled as a strict module
    // body and evaluated here as a classic blob, and the difference is not
    // cosmetic: a failed defineProperty throws under strict and passes silently
    // under sloppy, so the worker copy would fail differently from the main
    // thread copy for the same reason.
    /**
     * Resolved here, so the worker and the page cannot land on different
     * machines. Asking `active()` rather than the store also fixes the page's
     * own answer at this moment, which is the point: constructing a worker to
     * fingerprint in is a read of the surface, whatever it returns.
     */
    const seed = JSON.stringify(active().material);
    const body =
      opts?.type === 'module'
        ? `'use strict';(${source})(${seed});\nimport ${JSON.stringify(absolute.href)};`
        : `'use strict';(${source})(${seed});\nimportScripts(${JSON.stringify(absolute.href)});`;
    return URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
  }

  /**
   * Failing closed leaves one thing behind, and it cannot be reached from here.
   *
   * The request headers are rewritten by rules the worker installed, and this
   * function has no way to withdraw them: a MAIN world script has no extension
   * channel. So after this runs the page reports the real browser while its own
   * requests still report the normalised one.
   *
   * That is smaller than what it replaces rather than free. The mismatch this
   * prevents, a masked document beside a pristine worker, is observable by page
   * script alone; the one it leaves needs a server willing to compare a header
   * against something the page told it. Closing it properly means excluding this
   * origin from the header rules, which needs a signal out through the isolated
   * agent and is per origin rather than global, because a policy on one site
   * says nothing about any other.
   */
  function offEverything(): void {
    for (const { target, key, desc } of originals) {
      try {
        Object.defineProperty(target, key, desc);
      } catch {
        /* nothing better to do, and throwing here is page visible */
      }
    }
    originals.length = 0;

    /**
     * The trap comes off last, and it has to come off at all.
     *
     * Failing closed means the page sees one real machine, and a
     * `Function.prototype.toString` that is not the browser's own is not that.
     * Comparing it against another realm's, an iframe's for instance, finds a
     * different function object where every real browser has the same one.
     * Leaving it installed made the whole point of failing closed conditional
     * on nobody looking one level further out.
     */
    if (trapWas) {
      try {
        Object.defineProperty(Function.prototype, 'toString', trapWas);
      } catch {
        /* as above */
      }
    }

    /**
     * Nothing is written to say the mask is off, because the trap that answered
     * the handshake has just been put back. Asking again returns to throwing,
     * which is the same answer a machine with no mask on it gives, and that is
     * the point of failing closed: not a flag saying so, but nothing left to
     * find.
     */
  }

  /**
   * Three ways to learn the wrap did not take, because one is not enough.
   *
   * The obvious one is the constructor throwing, and it was the only one here
   * first. Measured against a real `worker-src 'none'`, Chrome does not throw:
   * it constructs the object and reports the refusal as an event afterwards. So
   * a catch around the constructor caught nothing and the mask stayed on with a
   * worker that never ran it, which is the exact state this is supposed to
   * prevent.
   *
   * The second is a policy violation naming a directive that governs workers.
   * The third is the worker itself erroring, which covers a cross-origin script
   * the blob cannot import as well as a policy this does not recognise.
   *
   * All three are honest about a limit: only the first is synchronous. A page
   * that reads a canvas in the same tick as it constructs a worker sees the
   * masked value before the refusal arrives. Section 11 already carries that
   * residual under CSP hardened origins, and narrowing it further needs the
   * policy readable before any script runs, which no API offers.
   */
  /**
   * Only the directives that can actually stop a worker, and only a blob.
   *
   * `script-src` and `default-src` were in here and that was badly wrong. A page
   * whose policy blocks an inline script or a third party tag raises one of
   * those, and that describes an enormous share of the real web: the mask would
   * have taken itself off on ordinary sites, for a violation that had nothing to
   * do with a worker, and reported nothing while doing it. The feature would
   * have looked installed and done nothing.
   *
   * The blocked URI has to be ours as well as the directive being about workers,
   * because a page can perfectly well have its own worker refused for reasons
   * that are not about us.
   */
  const WORKER_DIRECTIVES = /^(worker-src|child-src)/;

  const doc = (globalThis as { document?: Document }).document;
  doc?.addEventListener('securitypolicyviolation', (e) => {
    const ev = e as SecurityPolicyViolationEvent;
    const directive = ev.effectiveDirective || ev.violatedDirective || '';
    const ours = (ev.blockedURI ?? '').startsWith('blob');
    if (ours && WORKER_DIRECTIVES.test(directive)) offEverything();
  });

  for (const name of ['Worker', 'SharedWorker'] as const) {
    const Ctor = (globalThis as unknown as Record<string, unknown>)[name] as
      | (new (u: string | URL, o?: WorkerOptions) => object)
      | undefined;
    if (typeof Ctor !== 'function') continue;

    const Patched = function (this: unknown, url: string | URL, opts?: WorkerOptions) {
      /**
       * A native constructor refuses to be called as a function, and a plain
       * function replacing one does not. `Worker('x')` without `new` throws a
       * TypeError on a real browser and quietly worked here, which is a one
       * line probe with no false positives.
       */
      if (!new.target) {
        throw new TypeError(
          `Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`
        );
      }
      try {
        const made = new Ctor(wrap(url, opts), opts) as EventTarget;
        // Added before the page can set its own handler, so this runs first and
        // the mask is already off by the time the page hears about it.
        made.addEventListener?.('error', () => offEverything(), { once: true });
        return made;
      } catch (e) {
        // A refusal to construct is not the same as our wrap failing, and
        // rethrowing the page's own error keeps a broken call broken rather
        // than silently succeeding against a different url.
        if (e instanceof TypeError && String(e.message).includes('new')) throw e;
        // Could not reach into the worker. One coherent fingerprint beats two
        // that disagree, so everything comes off and the original runs.
        offEverything();
        return new Ctor(url, opts);
      }
    } as unknown as new (u: string | URL, o?: WorkerOptions) => object;

    Object.defineProperty(Patched, 'name', { value: name, configurable: true });
    Object.defineProperty(Patched, 'length', { value: Ctor.length, configurable: true });
    /**
     * A normal function's `prototype` is writable; a native constructor's is
     * not. Assigning it left `Object.getOwnPropertyDescriptor(Worker,
     * 'prototype').writable` reading true where every real browser says false.
     * It is non-configurable either way, so this is the one shot at setting it.
     */
    Object.defineProperty(Patched, 'prototype', {
      value: Ctor.prototype,
      writable: false,
      enumerable: false,
    });
    patched.add(Patched);
    remember(globalThis, name, Object.getOwnPropertyDescriptor(globalThis, name)!);
    (globalThis as unknown as Record<string, unknown>)[name] = Patched;
  }

  // Installed last. Until every patch is in place the trap would report a
  // function as native before it is one, and the window is small but real.
  Object.defineProperty(Function.prototype, 'toString', {
    value: trap,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(trap, 'name', { value: 'toString', configurable: true });
  Object.defineProperty(trap, 'length', { value: 0, configurable: true });

})();
