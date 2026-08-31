/**
 * ------------------------------------------------------------------
 *  Title    |  Toolbar and listing icons
 *  Ref      |  popup.js rings, PNG encoder
 *  ID       |  tools
 * ------------------------------------------------------------------
 *  Purpose  |  Draw the toolbar and listing icons from the same
 *           |  geometry as the popup header mark.
 *  How      |  Generated from the numbers in popup.js, not a copy, so
 *           |  an icon is never nearly the logo. Three concentric
 *           |  broken rings, each further round the turn and fainter.
 *  Note     |  PNG is written by hand (deflate-stored plus a CRC) to
 *           |  avoid a toolchain for eleven kilobytes of pixels.
 *           |  node tools/icons.mjs
 *  Author   |  Ojas Kekre, 20/08/2026
 * ------------------------------------------------------------------
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'extension', 'icons');
mkdirSync(OUT, { recursive: true });

/** Signal, on the panel's own ground. Straight out of tokens.css. */
const INK = [220, 234, 79];
const GROUND = [8, 9, 10];

/** The same three rings the popup draws, in a 0..1 space so they scale. */
const RINGS = [
  { r: 14.5 / 34, gap: 66, turn: 0, w: 2 / 34, o: 1 },
  { r: 9.5 / 34, gap: 78, turn: 132, w: 2 / 34, o: 0.68 },
  { r: 4.5 / 34, gap: 96, turn: 262, w: 2 / 34, o: 0.4 },
];

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Supersampled, because a two pixel stroke at sixteen
 *           |  pixels across is one pixel of ring and one of aliasing.
 *  Note     |  The aliasing is what makes a small icon look like a
 *           |  smudge rather than a shape.
 * ------------------------------------------------------------------
 */
const SS = 4;

function render(size) {
  const n = size * SS;
  const px = new Float64Array(n * n);

  const cx = n / 2;
  const cy = n / 2;
  // Stroke and radius grow with the icon, but the smallest sizes need a
  // slightly heavier line or the rings disappear into the background.
  const bump = size <= 32 ? 1.45 : size <= 48 ? 1.2 : 1;

  for (const ring of RINGS) {
    const r = ring.r * n;
    const half = (ring.w * n * bump) / 2;
    const start = ring.turn;
    const sweep = 360 - ring.gap;

    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.hypot(dx, dy);
        if (Math.abs(d - r) > half) continue;
        // Clockwise from twelve o'clock, matching how the SVG dasharray reads.
        let a = (Math.atan2(dx, -dy) * 180) / Math.PI;
        if (a < 0) a += 360;
        let rel = a - start;
        if (rel < 0) rel += 360;
        if (rel > sweep) continue;
        const i = y * n + x;
        px[i] = Math.max(px[i], ring.o);
      }
    }
  }

  // Box filter back down to the real size, which is the whole point of SS.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          acc += px[(y * SS + sy) * n + (x * SS + sx)];
        }
      }
      const a = acc / (SS * SS);
      const o = (y * size + x) * 4;
      // Composited onto the panel ground rather than left transparent. A
      // transparent icon takes the colour of whatever toolbar it lands in, and
      // this one is a thin bright line that vanishes on a light one.
      for (let c = 0; c < 3; c++) {
        out[o + c] = Math.round(GROUND[c] + (INK[c] - GROUND[c]) * a);
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// ------------------------------------------------------------------ png

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function png(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    // Filter type 0, none. The images are tiny and predictable.
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const file = join(OUT, `${size}.png`);
  writeFileSync(file, png(render(size), size));
  console.log(`  ${size.toString().padStart(3)}  ${file}`);
}
console.log('\nicons written');
