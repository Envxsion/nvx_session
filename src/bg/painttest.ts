/**
 * The mark, exercised against a real worker canvas.
 *
 * Unit tests prove the arithmetic. They cannot prove that OffscreenCanvas is
 * reachable from a service worker in this browser, that a font resolves well
 * enough to draw a letter, or that createImageBitmap decodes what a favicon
 * actually is. Those are the assumptions that break silently, and they only
 * answer honestly inside the browser they are being asked about.
 */

import { hueOf, parseHex, rankIcons, HUES, MAX_ICON_CANDIDATES } from '../paint/badge.js';
import { Painter, renderTile } from '../paint/render.js';
import type { Check } from './selftest.js';

export interface PaintTestResult {
  ok: boolean;
  checks: Check[];
  error?: string;
}

const SIZE = 32;

async function pngBlob(fill: string): Promise<Blob> {
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context in this worker');
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, SIZE, SIZE);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Counts how many of an image's pixels are close to a colour. */
async function pixelsNear(dataUrl: string, hex: string): Promise<number> {
  const target = parseHex(hex)!;
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (
      px[i + 3]! > 200 &&
      Math.abs(px[i]! - target.r) < 24 &&
      Math.abs(px[i + 1]! - target.g) < 24 &&
      Math.abs(px[i + 2]! - target.b) < 24
    ) {
      n++;
    }
  }
  return n;
}

/**
 * Can one of our own rules authenticate a fetch the worker makes?
 *
 * This is the question that decides how dangerous a page-declared icon URL is.
 * The painter fetches icons with host permissions, and declarativeNetRequest
 * rules carrying a session's Cookie header match `tabIds: [-1]`, which is the
 * bucket every non-tab request lands in. If those rules applied to the worker's
 * own fetches, a page could name any URL and have it sent authenticated as
 * somebody else's session.
 *
 * Measured on Opera GX 134 / Chromium 150: they do not. A rule setting a
 * session's cookie for the target domain was live, and the fetch arrived with
 * no Cookie header at all. Icons are still restricted to the declaring site, so
 * this is belt and braces, but it is asserted rather than assumed because it is
 * a browser behaviour nobody promised us and a future change would be silent.
 */
async function dnrCannotReachOurOwnFetch(
  probeUrl: string
): Promise<{ ran: boolean; sent: string | null }> {
  try {
    const res = await fetch(probeUrl, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) return { ran: false, sent: null };
    const body: unknown = await res.json();
    const header =
      body && typeof body === 'object' ? (body as { cookieHeader?: unknown }).cookieHeader : null;
    return { ran: true, sent: typeof header === 'string' ? header : null };
  } catch {
    return { ran: false, sent: null };
  }
}

/**
 * Puts a live cookie-setting rule on the fixture domain and tears it down again.
 *
 * Without this the forgery check asserts nothing: it would fetch a domain no
 * session owns, find no Cookie header, and pass for the wrong reason. The rule
 * has to exist and have to have matched for the absence of a header to mean
 * anything.
 */
export interface PaintTestArm {
  (fixture: string): Promise<{ armed: boolean; disarm: () => Promise<void> }>;
}

export async function runPaintTest(
  fixture = 'http://localhost:8787',
  arm?: PaintTestArm
): Promise<PaintTestResult> {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string) =>
    checks.push({ name, pass, ...(detail ? { detail } : {}) });

  try {
    if (typeof OffscreenCanvas === 'undefined') {
      return {
        ok: false,
        checks: [{ name: 'the worker has a canvas', pass: false }],
        error: 'OffscreenCanvas does not exist in this service worker',
      };
    }

    // ------------------------------------------------------- generated tile
    const tile = await renderTile(SIZE, 'jade', 'work');
    add('the worker can draw and encode a png', tile.dataUrl.startsWith('data:image/png;base64,'));
    add(
      'a letter renders, so a generated mark is not a blank square',
      tile.textRendered,
      tile.textRendered ? 'text' : 'fell back to a ring'
    );
    add(
      'the tile is actually the session colour',
      (await pixelsNear(tile.dataUrl, HUES.jade!)) > SIZE * SIZE * 0.4
    );

    // ----------------------------------------------------------- compositing
    const sources = new Map<string, Blob>();
    sources.set('https://fixture.invalid/icon.png', await pngBlob('#ffffff'));
    sources.set('https://fixture.invalid/icon.svg', new Blob(['<svg/>'], { type: 'image/svg+xml' }));

    let fetches = 0;
    const painter = new Painter(async (url) => {
      fetches++;
      const blob = sources.get(url);
      if (!blob) return new Response('', { status: 404 });
      return new Response(blob, { status: 200 });
    });

    const composited = await painter.paint({
      sources: ['https://fixture.invalid/icon.png'],
      color: 'magenta',
      label: 'work',
    });
    add('a raster icon composites', composited.source === 'https://fixture.invalid/icon.png');
    add(
      'the session disc lands on it',
      (await pixelsNear(composited.dataUrl, HUES.magenta!)) > 40,
      `${await pixelsNear(composited.dataUrl, HUES.magenta!)} px`
    );
    add(
      'the icon underneath survives',
      (await pixelsNear(composited.dataUrl, '#ffffff')) > SIZE * SIZE * 0.5
    );

    const before = fetches;
    await painter.paint({
      sources: ['https://fixture.invalid/icon.png'],
      color: 'magenta',
      label: 'work',
    });
    add('the same mark twice is one fetch', fetches === before, `${fetches} fetch(es) total`);

    const other = await painter.paint({
      sources: ['https://fixture.invalid/icon.png'],
      color: 'jade',
      label: 'work',
    });
    add('two sessions on one site get different marks', other.dataUrl !== composited.dataUrl);

    // ---------------------------------------------------------- degradation
    const svg = await painter.paint({
      sources: ['https://fixture.invalid/icon.svg'],
      color: 'coral',
      label: 'personal',
    });
    add(
      'an svg source falls back to a tile rather than throwing',
      svg.source === null && svg.dataUrl.startsWith('data:image/png')
    );

    const missing = await painter.paint({
      sources: ['https://fixture.invalid/gone.png'],
      color: 'coral',
      label: 'personal',
    });
    add('a missing icon falls back to a tile', missing.source === null);

    const afterFail = fetches;
    await painter.paint({
      sources: ['https://fixture.invalid/gone.png'],
      color: 'violet',
      label: 'other',
    });
    add('a source that failed once is not fetched again', fetches === afterFail);

    const nothing = await painter.paint({ sources: [], color: 'azure', label: 'zebra' });
    add(
      'a page declaring no icon still gets a mark',
      nothing.source === null && (await pixelsNear(nothing.dataUrl, HUES.azure!)) > 200
    );

    add('every ramp colour resolves', Object.keys(HUES).every((c) => hueOf(c) !== null));

    // ------------------------------------------------- the forgery question
    const armed = arm ? await arm(fixture) : { armed: false, disarm: async () => undefined };
    try {
      if (armed.armed) {
        const probe = await dnrCannotReachOurOwnFetch(`${fixture}/echo?probe=painter`);
        // Reaching the fixture is what makes the next check mean anything; the
        // rule being live is already established by arm() returning armed.
        add(
          'the probe domain answered, so the next check is not vacuous',
          probe.ran,
          probe.ran ? 'a cookie-setting rule is live for it' : 'fixture not reachable'
        );
        if (probe.ran) {
          add(
            'our own rules cannot authenticate the painter fetch',
            probe.sent === null,
            probe.sent === null ? 'no cookie header' : `LEAKED: ${probe.sent}`
          );
        }
      }
    } finally {
      await armed.disarm().catch(() => undefined);
    }

    add(
      'icons are restricted to the site that declared them',
      rankIcons([{ href: 'https://evil.example/i.png' }, { href: 'https://good.example/i.png' }], {
        site: 'good.example',
      }).length === 1
    );
    add(
      'a page cannot declare an unbounded number of icons',
      rankIcons(
        Array.from({ length: 500 }, (_, i) => ({ href: `https://good.example/${i}.png` })),
        { site: 'good.example' }
      ).length <= MAX_ICON_CANDIDATES,
      `capped at ${MAX_ICON_CANDIDATES}`
    );

    return { ok: checks.every((c) => c.pass), checks };
  } catch (e) {
    return { ok: false, checks, error: e instanceof Error ? e.message : String(e) };
  }
}
