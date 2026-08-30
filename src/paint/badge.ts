/**
 * ------------------------------------------------------------------
 *  Title    |  The tab mark
 *  Ref      |  jar/psl.ts, stampChip, rankIcons, render.ts
 *  ID       |  M2 (paint)
 * ------------------------------------------------------------------
 *  Purpose  |  Draw a session's identifying disc into the corner of a
 *           |  site's own favicon.
 *  How      |  A session must be legible at 16px beside many tabs. The
 *           |  icon is left intact and a session disc is stamped into
 *           |  the lower right; with no decodable icon the disc becomes
 *           |  the whole mark and carries a letter.
 *  Note     |  Pure arithmetic over an RGBA buffer, no canvas, so the
 *           |  same code runs in the worker, the panel preview and a
 *           |  unit test.
 *  Author   |  Ojas Kekre, 17/08/2026
 * ------------------------------------------------------------------
 */

import { registrableDomain } from '../jar/psl.js';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Matches --void. The rim exists to separate the disc from whatever is under it. */
export const RIM: Rgb = { r: 0x08, g: 0x09, b: 0x0a };
export const PAPER: Rgb = { r: 0xef, g: 0xf0, b: 0xea };

/** The same values as --s-* in packages/ui/tokens.css, which is the source. */
export const HUES: Record<string, string> = {
  cyan: '#4fd6ea',
  azure: '#5a8cf0',
  violet: '#9a7bf5',
  magenta: '#e56ec4',
  coral: '#ef6f52',
  jade: '#3fcf8e',
  amber: '#eca93a',
  chalk: '#dfe4ec',
  /** Not a session hue. Reserved for the anonymous holding session. */
  grey: '#5c646b',
};

export function parseHex(hex: string): Rgb | null {
  const s = hex.trim().replace(/^#/, '');
  const full =
    s.length === 3
      ? s
          .split('')
          .map((c) => c + c)
          .join('')
      : s;
  if (full.length !== 6 || !/^[0-9a-f]{6}$/i.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** A colour name from the session ramp, a raw hex, or the cyan default. */
export function hueOf(color: string): Rgb {
  return parseHex(HUES[color] ?? color) ?? parseHex(HUES.cyan!)!;
}

/** WCAG relative luminance, used only to decide what a letter is drawn in. */
export function luminance(c: Rgb): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Pick the ink colour a letter is drawn in.
 *  Note     |  The session ramp is mid-luminance so no session shouts,
 *           |  which puts every hue near the threshold where light and
 *           |  dark ink are both legible. Comparing contrast ratios
 *           |  rather than luminance alone picks the better of the two.
 * ------------------------------------------------------------------
 */
export function inkFor(bg: Rgb): Rgb {
  const l = luminance(bg);
  const onDark = (l + 0.05) / (luminance(RIM) + 0.05);
  const onLight = (luminance(PAPER) + 0.05) / (l + 0.05);
  return onDark >= onLight ? RIM : PAPER;
}

export interface ChipGeometry {
  cx: number;
  cy: number;
  /** Radius of the coloured disc. */
  r: number;
  /** Width of the dark rim drawn outside it. */
  rim: number;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Disc geometry as proportions, not pixels, so the same
 *           |  mark holds at 16, 32 and 64.
 *  Note     |  The disc lands at forty percent of the icon's width.
 *           |  Smaller and it disappears at the size a tab strip
 *           |  renders; larger and it covers the glyph it annotates.
 * ------------------------------------------------------------------
 */
export function chipGeometry(size: number): ChipGeometry {
  const r = size * 0.2;
  const rim = Math.max(1, size * 0.05);
  const inset = size * 0.03;
  const c = size - r - rim - inset;
  return { cx: c, cy: c, r, rim };
}

/** Fractional area of one pixel covered by a circle, sampled on a 4x4 grid. */
function coverage(x: number, y: number, cx: number, cy: number, r: number): number {
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= r - 0.75) return 1;
  if (d >= r + 0.75) return 0;

  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4 - cx;
      const py = y + (sy + 0.5) / 4 - cy;
      if (px * px + py * py <= r * r) hits++;
    }
  }
  return hits / 16;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Source-over onto a non-premultiplied buffer, the format
 *           |  ImageData uses.
 *  Note     |  Compositing as though it were premultiplied leaves a
 *           |  dark fringe wherever the mark meets a transparent pixel,
 *           |  which is the entire rim.
 * ------------------------------------------------------------------
 */
function over(px: Uint8ClampedArray, i: number, c: Rgb, alpha: number): void {
  if (alpha <= 0) return;
  const da = px[i + 3]! / 255;
  const oa = alpha + da * (1 - alpha);
  if (oa <= 0) return;
  const mix = (s: number, d: number) => (s * alpha + d * da * (1 - alpha)) / oa;
  px[i] = mix(c.r, px[i]!);
  px[i + 1] = mix(c.g, px[i + 1]!);
  px[i + 2] = mix(c.b, px[i + 2]!);
  px[i + 3] = oa * 255;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Stamp the session disc into an RGBA buffer in place.
 *  How      |  The rim is laid across the full outer radius and the hue
 *           |  painted over it, rather than drawn as an annulus.
 *  Note     |  An annulus leaves a seam along the join where neither
 *           |  shape reaches full coverage.
 * ------------------------------------------------------------------
 */
export function stampChip(
  px: Uint8ClampedArray,
  size: number,
  hue: Rgb,
  rim: Rgb = RIM,
  geom: ChipGeometry = chipGeometry(size)
): void {
  const outer = geom.r + geom.rim;
  const x0 = Math.max(0, Math.floor(geom.cx - outer - 1));
  const x1 = Math.min(size - 1, Math.ceil(geom.cx + outer + 1));
  const y0 = Math.max(0, Math.floor(geom.cy - outer - 1));
  const y1 = Math.min(size - 1, Math.ceil(geom.cy + outer + 1));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const outerCov = coverage(x, y, geom.cx, geom.cy, outer);
      if (outerCov <= 0) continue;
      const i = (y * size + x) * 4;
      over(px, i, rim, outerCov);
      over(px, i, hue, coverage(x, y, geom.cx, geom.cy, geom.r));
    }
  }
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  One character, never two.
 *  Note     |  Two letters at sixteen pixels is a smudge. Iterating by
 *           |  code point rather than index keeps an emoji or a
 *           |  non-Latin script intact instead of emitting half a
 *           |  surrogate pair.
 * ------------------------------------------------------------------
 */
export function monogram(label: string): string {
  for (const ch of label.trim()) {
    // Extended_Pictographic rather than Emoji_Presentation, because a glyph
    // like an antenna is emoji without defaulting to emoji presentation, and a
    // session named after one should wear it rather than the next letter along.
    if (/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(ch)) {
      return ch.toLocaleUpperCase();
    }
  }
  return '?';
}

export interface TileGeometry {
  radius: number;
  fontSize: number;
  baseline: number;
  centre: number;
}

/** The fallback mark, when the site's own icon could not be decoded. */
export function tileGeometry(size: number): TileGeometry {
  return {
    radius: size * 0.22,
    fontSize: size * 0.66,
    baseline: size * 0.5,
    centre: size * 0.5,
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Identity of a painted result.
 *  Note     |  Two tabs on the same site in the same session produce
 *           |  the same key, so the icon is composited once and reused.
 * ------------------------------------------------------------------
 */
export function paintKey(source: string, color: string, label: string, size: number): string {
  return `${size}|${color}|${source || `mono:${monogram(label)}`}`;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Rank the icons a page declares.
 *  Note     |  Preference is a decode question, not a taste one.
 *           |  createImageBitmap has no SVG path in a worker, so a site
 *           |  offering both an SVG and a PNG must be read from the PNG
 *           |  or the composite is lost. Among raster candidates a
 *           |  larger declared size downsamples better than a 16 pixel
 *           |  source upscaled.
 * ------------------------------------------------------------------
 */
export interface IconCandidate {
  href: string;
  type?: string | undefined;
  sizes?: string | undefined;
}

export interface RankOptions {
  /**
   * Registrable domain of the page that declared these. Icons elsewhere are
   * dropped.
   *
   * The list comes out of a page's own DOM, so it is attacker-chosen on a
   * hostile site, and the worker fetches it with host permissions and hands the
   * result back as a data URL the page can read. Measured: declarativeNetRequest
   * does not apply to the extension's own requests, so this cannot forge an
   * authenticated one. What is left is an unauthenticated fetch whose result the
   * page can see, which off-site would make the extension a probe for hosts the
   * page cannot reach itself. Same-site means the page learns nothing it could
   * not have learned by fetching the icon directly.
   *
   * The cost is a site whose only icon lives on a CDN. Those fall back to
   * /favicon.ico on their own origin, which the agent always offers, and to the
   * generated tile if that is missing too.
   */
  site?: string | undefined;
  /** A page can declare a thousand icon links; each one is a fetch. */
  limit?: number;
}

export const MAX_ICON_CANDIDATES = 6;

export function rankIcons(candidates: IconCandidate[], opts: RankOptions = {}): string[] {
  const seen = new Set<string>();
  const scored: Array<{ href: string; score: number }> = [];

  for (const c of candidates) {
    const href = typeof c?.href === 'string' ? c.href.trim() : '';
    if (!href || seen.has(href)) continue;
    if (!/^https?:\/\//i.test(href)) continue;
    if (opts.site && !sameSite(href, opts.site)) continue;
    seen.add(href);

    const type = typeof c.type === 'string' ? c.type : '';
    const svg = /svg/i.test(type) || /\.svg(\?|#|$)/i.test(href);
    const px = largestSize(typeof c.sizes === 'string' ? c.sizes : undefined);
    // Anything at or above the 32 pixel target is equivalent; beyond that a
    // larger source is only a larger download.
    const fit = px === 0 ? 0 : px >= 32 ? 3 : px >= 16 ? 2 : 1;
    scored.push({ href, score: (svg ? 0 : 10) + fit });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? MAX_ICON_CANDIDATES)
    .map((s) => s.href);
}

function sameSite(href: string, site: string): boolean {
  try {
    return registrableDomain(new URL(href).hostname) === site;
  } catch {
    return false;
  }
}

function largestSize(sizes: string | undefined): number {
  if (!sizes) return 0;
  let best = 0;
  for (const token of sizes.split(/\s+/)) {
    const n = Number(token.split(/x/i)[0]);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}
