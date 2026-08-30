/**
 * ------------------------------------------------------------------
 *  Title    |  Compositing the tab mark
 *  Ref      |  badge.ts, Painter, composite, tile
 *  ID       |  M2 (paint)
 * ------------------------------------------------------------------
 *  Purpose  |  Composite a session's tab mark in the service worker.
 *  How      |  The worker holds host permissions, so fetching an icon
 *           |  cross-origin is not a CORS question, and a data URL
 *           |  drawn into a canvas never taints it, so the result reads
 *           |  back. A content script has neither.
 *  Note     |  createImageBitmap has no SVG decoder outside a document,
 *           |  so a raster icon is preferred and an SVG-only site falls
 *           |  back to the generated tile.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

import {
  chipGeometry,
  hueOf,
  inkFor,
  monogram,
  paintKey,
  stampChip,
  tileGeometry,
  type Rgb,
} from './badge.js';

export const ICON_SIZE = 32;

/** A favicon larger than this is a misconfiguration, not an icon. */
const MAX_BYTES = 1_048_576;
const FETCH_TIMEOUT_MS = 4000;

export interface PaintInput {
  /** Icon URLs in preference order, already ranked by rankIcons. */
  sources: string[];
  color: string;
  label: string;
  size?: number;
}

export interface PaintOutput {
  dataUrl: string;
  /** Which source was composited, or null when this is a generated tile. */
  source: string | null;
  key: string;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Cap on cached painted marks.
 *  Note     |  One entry is a base64 png of a 32 pixel icon, roughly
 *           |  two kilobytes. A session touching a thousand sites would
 *           |  otherwise hold megabytes in a worker meant to be cheap
 *           |  enough to forget about.
 * ------------------------------------------------------------------
 */
const CACHE_CAP = 300;

export class Painter {
  private readonly cache = new Map<string, PaintOutput>();
  /** Sources that failed to decode, so a broken icon is not refetched per tab. */
  private readonly failed = new Set<string>();
  private readonly inFlight = new Map<string, Promise<PaintOutput>>();

  constructor(private readonly fetcher: Fetcher = (u, i) => fetch(u, i)) {}

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
    this.failed.clear();
  }

  /**
   * ------------------------------------------------------------------
   *  Purpose  |  Paint a mark, coalescing concurrent requests for it.
   *  Note     |  Two tabs on the same site in the same session ask for
   *           |  the same mark at once. Sharing the in-flight promise
   *           |  means one fetch and one composite, not one per tab.
   * ------------------------------------------------------------------
   */
  async paint(input: PaintInput): Promise<PaintOutput> {
    const size = input.size ?? ICON_SIZE;
    const usable = input.sources.filter((s) => !this.failed.has(s));
    const key = paintKey(usable[0] ?? '', input.color, input.label, size);

    const hit = this.cache.get(key);
    if (hit) {
      // Reinsert, so Map iteration order is least recently used first and the
      // eviction below drops the mark of a site nobody has open.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }

    const running = this.inFlight.get(key);
    if (running) return running;

    const job = this.render(usable, input, size, key).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, job);
    return job;
  }

  private async render(
    sources: string[],
    input: PaintInput,
    size: number,
    key: string
  ): Promise<PaintOutput> {
    const hue = hueOf(input.color);

    for (const source of sources) {
      const bitmap = await this.decode(source);
      if (!bitmap) continue;
      try {
        const dataUrl = await composite(bitmap, size, hue);
        const out: PaintOutput = { dataUrl, source, key };
        this.remember(key, out);
        return out;
      } catch {
        this.failed.add(source);
      } finally {
        bitmap.close();
      }
    }

    const { dataUrl } = await tile(size, hue, monogram(input.label));
    // Keyed on the tile, not on the source that failed, so a later navigation
    // offering a decodable icon is not answered from this entry.
    const fallbackKey = paintKey('', input.color, input.label, size);
    const out: PaintOutput = { dataUrl, source: null, key: fallbackKey };
    this.remember(fallbackKey, out);
    if (fallbackKey !== key) this.remember(key, out);
    return out;
  }

  private remember(key: string, out: PaintOutput): void {
    this.cache.set(key, out);
    while (this.cache.size > CACHE_CAP) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  private async decode(source: string): Promise<ImageBitmap | null> {
    if (this.failed.has(source)) return null;
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), FETCH_TIMEOUT_MS);
    try {
      // Credentials are omitted deliberately. An icon is public, and a fetch
      // issued from the worker carries no tab id, so letting it pick up a jar
      // would be both pointless and the one direction this project never wants
      // traffic to flow.
      const res = await this.fetcher(source, {
        credentials: 'omit',
        cache: 'force-cache',
        signal: control.signal,
      });
      if (!res.ok) throw new Error(String(res.status));

      const blob = await res.blob();
      if (blob.size === 0 || blob.size > MAX_BYTES) throw new Error('unusable size');
      if (/svg/i.test(blob.type)) throw new Error('no svg decoder in a worker');

      return await createImageBitmap(blob);
    } catch {
      this.failed.add(source);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function surface(size: number): {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
} {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  return { canvas, ctx };
}

async function toDataUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunked because String.fromCharCode is applied to the array and a single
  // spread of a large buffer overflows the argument limit.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Draw the source icon to fill the square without
 *           |  distorting it, then stamp the session disc over it.
 *  Note     |  Non-square icons are centred rather than stretched: a
 *           |  stretched wordmark is less recognisable than a
 *           |  letterboxed one.
 * ------------------------------------------------------------------
 */
async function composite(bitmap: ImageBitmap, size: number, hue: Rgb): Promise<string> {
  const { canvas, ctx } = surface(size);
  const scale = Math.min(size / bitmap.width, size / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);

  const image = ctx.getImageData(0, 0, size, size);
  stampChip(image.data, size, hue);
  ctx.putImageData(image, 0, 0);
  return toDataUrl(canvas);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The generated mark, when no site icon can be decoded.
 *  How      |  Text in a worker canvas resolves against system fonts
 *           |  and may not render at all, so the letter is drawn and
 *           |  then looked for.
 *  Note     |  If it did not land, an inner ring takes its place so the
 *           |  tile still reads as deliberate rather than a blank square.
 * ------------------------------------------------------------------
 */
async function tile(
  size: number,
  hue: Rgb,
  letter: string
): Promise<{ dataUrl: string; textRendered: boolean }> {
  const { canvas, ctx } = surface(size);
  const g = tileGeometry(size);
  const ink = inkFor(hue);

  ctx.fillStyle = rgb(hue);
  roundRect(ctx, 0, 0, size, size, g.radius);
  ctx.fill();

  ctx.fillStyle = rgb(ink);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Never system-ui.
  //
  // Measured on Opera GX 134 (Chromium 150): setting a worker canvas font to
  // the system-ui generic and drawing with it kills the service worker
  // process outright, with no exception and no console entry. The extension
  // simply appears never to have booted. Named families and the other CSS
  // generics are fine, so the stack resolves the same faces by name instead.
  ctx.font = `600 ${g.fontSize}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.fillText(letter, g.centre, g.baseline);

  const textRendered = drewInk(ctx.getImageData(0, 0, size, size).data, ink);
  if (!textRendered) {
    ctx.strokeStyle = rgb(ink);
    ctx.lineWidth = Math.max(1.5, size * 0.09);
    ctx.beginPath();
    ctx.arc(g.centre, g.centre, size * 0.24, 0, Math.PI * 2);
    ctx.stroke();
  }

  return { dataUrl: await toDataUrl(canvas), textRendered };
}

function drewInk(px: Uint8ClampedArray, ink: Rgb): boolean {
  for (let i = 0; i < px.length; i += 4) {
    if (
      Math.abs(px[i]! - ink.r) < 40 &&
      Math.abs(px[i + 1]! - ink.g) < 40 &&
      Math.abs(px[i + 2]! - ink.b) < 40 &&
      px[i + 3]! > 200
    ) {
      return true;
    }
  }
  return false;
}

function rgb(c: Rgb): string {
  return `rgb(${c.r} ${c.g} ${c.b})`;
}

function roundRect(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Exposed so the in-browser suite can prove the canvas
 *           |  path works at runtime.
 *  Note     |  Whether the letter landed is measured, not assumed: a
 *           |  worker that cannot resolve a font fails silently and
 *           |  produces a plain square.
 * ------------------------------------------------------------------
 */
export async function renderTile(
  size: number,
  color: string,
  label: string
): Promise<{ dataUrl: string; textRendered: boolean }> {
  return tile(size, hueOf(color), monogram(label));
}

export { chipGeometry };
