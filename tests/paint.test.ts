import { describe, expect, it } from 'vitest';
import {
  chipGeometry,
  hueOf,
  inkFor,
  luminance,
  monogram,
  paintKey,
  parseHex,
  rankIcons,
  stampChip,
  tileGeometry,
  HUES,
  MAX_ICON_CANDIDATES,
  PAPER,
  RIM,
} from '../src/paint/badge.js';
import { applyGroups, groupColorFor, planGroups, type GroupApi } from '../src/paint/groups.js';
import type { Binding, Session } from '../src/kernel/registry.js';
import { CookieStore } from '../src/jar/store.js';

const SIZE = 32;

function blank(size = SIZE): Uint8ClampedArray {
  return new Uint8ClampedArray(size * size * 4);
}

function opaque(size = SIZE, v = 255): Uint8ClampedArray {
  const px = blank(size);
  px.fill(v);
  return px;
}

function at(px: Uint8ClampedArray, size: number, x: number, y: number) {
  const i = (y * size + x) * 4;
  return { r: px[i]!, g: px[i + 1]!, b: px[i + 2]!, a: px[i + 3]! };
}

describe('colour', () => {
  it('reads three and six digit hex', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('4fd6ea')).toEqual({ r: 0x4f, g: 0xd6, b: 0xea });
  });

  it('refuses anything that is not a colour', () => {
    for (const bad of ['', '#', 'nope', '#12345', 'rgb(1,2,3)', '#gggggg']) {
      expect(parseHex(bad)).toBeNull();
    }
  });

  it('resolves ramp names, raw hex and nonsense', () => {
    expect(hueOf('jade')).toEqual(parseHex(HUES.jade!));
    expect(hueOf('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hueOf('not-a-colour')).toEqual(parseHex(HUES.cyan!));
  });

  it('picks the ink with the better contrast, not a fixed one', () => {
    expect(inkFor({ r: 0, g: 0, b: 0 })).toEqual(PAPER);
    expect(inkFor({ r: 255, g: 255, b: 255 })).toEqual(RIM);
  });

  it('keeps every ramp hue legible under its chosen ink', () => {
    for (const [name, hex] of Object.entries(HUES)) {
      const bg = parseHex(hex)!;
      const ink = inkFor(bg);
      const light = Math.max(luminance(bg), luminance(ink));
      const dark = Math.min(luminance(bg), luminance(ink));
      const ratio = (light + 0.05) / (dark + 0.05);
      expect(ratio, `${name} against its ink`).toBeGreaterThan(3);
    }
  });
});

describe('chip geometry', () => {
  it('stays inside the icon at every size', () => {
    for (const size of [16, 32, 64, 128]) {
      const g = chipGeometry(size);
      expect(g.cx + g.r + g.rim).toBeLessThanOrEqual(size);
      expect(g.cy - g.r - g.rim).toBeGreaterThan(0);
    }
  });

  it('scales proportionally rather than by a fixed pixel count', () => {
    const a = chipGeometry(32);
    const b = chipGeometry(64);
    expect(b.r / b.cx).toBeCloseTo(a.r / a.cx, 5);
  });

  it('never lets the rim fall below a whole pixel, where it would vanish', () => {
    expect(chipGeometry(16).rim).toBe(1);
    expect(chipGeometry(8).rim).toBe(1);
  });

  it('lands in the lower right, where a favicon carries least meaning', () => {
    const g = chipGeometry(SIZE);
    expect(g.cx).toBeGreaterThan(SIZE / 2);
    expect(g.cy).toBeGreaterThan(SIZE / 2);
  });

  it('is wide enough to survive being drawn at sixteen pixels', () => {
    const g = chipGeometry(SIZE);
    expect((g.r * 2) / SIZE).toBeGreaterThan(0.3);
    expect((g.r * 2) / SIZE).toBeLessThan(0.5);
  });

  it('gives the fallback tile a readable letter', () => {
    const t = tileGeometry(SIZE);
    expect(t.fontSize).toBeGreaterThan(SIZE * 0.5);
    expect(t.centre).toBe(SIZE / 2);
  });
});

describe('stampChip', () => {
  const hue = hueOf('magenta');

  it('paints the hue at full strength in the middle of the disc', () => {
    const px = blank();
    stampChip(px, SIZE, hue);
    const g = chipGeometry(SIZE);
    const p = at(px, SIZE, Math.round(g.cx), Math.round(g.cy));
    expect(p).toEqual({ ...hue, a: 255 });
  });

  it('leaves the rest of the icon exactly as it was', () => {
    const px = opaque();
    stampChip(px, SIZE, hue);
    expect(at(px, SIZE, 0, 0)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(at(px, SIZE, 2, 20)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it('separates the disc from what is under it with a rim', () => {
    const px = opaque();
    stampChip(px, SIZE, hue);
    const g = chipGeometry(SIZE);
    // Just outside the disc, inside the rim.
    const x = Math.round(g.cx + g.r + g.rim / 2);
    const p = at(px, SIZE, x, Math.round(g.cy));
    expect(p.r).toBeLessThan(128);
    expect(p.g).toBeLessThan(128);
  });

  it('does not leave a dark fringe where it meets transparency', () => {
    // The bug this guards is compositing as though the buffer were
    // premultiplied, which stains every antialiased edge toward the rim.
    const px = blank();
    stampChip(px, SIZE, hue);
    const g = chipGeometry(SIZE);
    const inner = at(px, SIZE, Math.round(g.cx - g.r * 0.5), Math.round(g.cy));
    expect(inner).toEqual({ ...hue, a: 255 });
  });

  it('writes nothing outside its own bounding box', () => {
    const px = blank();
    stampChip(px, SIZE, hue);
    const g = chipGeometry(SIZE);
    const limit = g.cx - g.r - g.rim - 2;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (x > limit || y > limit) continue;
        expect(at(px, SIZE, x, y).a, `${x},${y}`).toBe(0);
      }
    }
  });

  it('works at the size a tab strip actually renders', () => {
    const px = blank(16);
    stampChip(px, 16, hue);
    const g = chipGeometry(16);
    expect(at(px, 16, Math.round(g.cx), Math.round(g.cy)).a).toBe(255);
  });
});

describe('monogram', () => {
  it('takes one character and uppercases it', () => {
    expect(monogram('work')).toBe('W');
    expect(monogram('  personal  ')).toBe('P');
  });

  it('skips punctuation to find something legible', () => {
    expect(monogram('__nvx')).toBe('N');
    expect(monogram('-- 7 --')).toBe('7');
  });

  it('never splits a surrogate pair', () => {
    const emoji = monogram('🛰 satellites');
    expect([...emoji].length).toBe(1);
    expect(emoji).toBe('🛰');
  });

  it('handles scripts with no case and no letters at all', () => {
    expect(monogram('日本語')).toBe('日');
    expect(monogram('   ')).toBe('?');
    expect(monogram('')).toBe('?');
  });
});

describe('paintKey', () => {
  it('separates sessions, sizes and sources', () => {
    const a = paintKey('https://x/i.png', 'jade', 'work', 32);
    expect(a).not.toBe(paintKey('https://x/i.png', 'coral', 'work', 32));
    expect(a).not.toBe(paintKey('https://y/i.png', 'jade', 'work', 32));
    expect(a).not.toBe(paintKey('https://x/i.png', 'jade', 'work', 16));
    expect(a).toBe(paintKey('https://x/i.png', 'jade', 'other', 32));
  });

  it('keys a generated tile on the letter, since there is no source', () => {
    expect(paintKey('', 'jade', 'work', 32)).toBe(paintKey('', 'jade', 'wombat', 32));
    expect(paintKey('', 'jade', 'work', 32)).not.toBe(paintKey('', 'jade', 'personal', 32));
  });
});

describe('rankIcons', () => {
  it('puts raster ahead of svg, because a worker cannot decode svg', () => {
    const ranked = rankIcons([
      { href: 'https://x/i.svg', type: 'image/svg+xml' },
      { href: 'https://x/i.png', type: 'image/png' },
    ]);
    expect(ranked[0]).toBe('https://x/i.png');
  });

  it('notices svg from the extension when no type is declared', () => {
    const ranked = rankIcons([
      { href: 'https://x/a.svg' },
      { href: 'https://x/b.ico' },
    ]);
    expect(ranked[0]).toBe('https://x/b.ico');
  });

  it('prefers a source at least as large as the target', () => {
    const ranked = rankIcons([
      { href: 'https://x/16.png', sizes: '16x16' },
      { href: 'https://x/64.png', sizes: '64x64' },
    ]);
    expect(ranked[0]).toBe('https://x/64.png');
  });

  it('drops duplicates and anything not fetchable', () => {
    const ranked = rankIcons([
      { href: 'https://x/i.png' },
      { href: 'https://x/i.png' },
      { href: 'data:image/png;base64,AA' },
      { href: 'chrome://favicon/x' },
      { href: '' },
    ]);
    expect(ranked).toEqual(['https://x/i.png']);
  });

  it('returns nothing rather than throwing when a page declares nothing', () => {
    expect(rankIcons([])).toEqual([]);
  });

  // The list comes out of a page's DOM, so on a hostile site it is
  // attacker-chosen, and the worker fetches it with host permissions and hands
  // the result back as a data URL the page can read.
  it('drops icons that are not on the site that declared them', () => {
    const ranked = rankIcons(
      [
        { href: 'https://internal.corp/admin.png' },
        { href: 'https://good.example/i.png' },
        { href: 'https://cdn.other/i.png' },
      ],
      { site: 'good.example' }
    );
    expect(ranked).toEqual(['https://good.example/i.png']);
  });

  it('counts a subdomain as the same site', () => {
    const ranked = rankIcons([{ href: 'https://assets.good.example/i.png' }], {
      site: 'good.example',
    });
    expect(ranked).toHaveLength(1);
  });

  it('caps how many icons one page can ask the worker to fetch', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ href: `https://good.example/${i}.png` }));
    expect(rankIcons(many, { site: 'good.example' }).length).toBe(MAX_ICON_CANDIDATES);
  });

  it('survives entries that are not the shape they claim', () => {
    const junk = [
      null,
      {},
      { href: 42 },
      { href: 'https://good.example/i.png', type: 7, sizes: {} },
    ] as unknown as Parameters<typeof rankIcons>[0];
    expect(rankIcons(junk, { site: 'good.example' })).toEqual(['https://good.example/i.png']);
  });

  it('refuses a scheme the worker has no business fetching', () => {
    const ranked = rankIcons(
      [
        { href: 'file:///etc/passwd' },
        { href: 'javascript:alert(1)' },
        { href: 'chrome-extension://abc/i.png' },
      ],
      { site: 'good.example' }
    );
    expect(ranked).toEqual([]);
  });
});

// ------------------------------------------------------------------ groups

function session(id: string, label: string, color: string): Session {
  return {
    id,
    label,
    color,
    pinned: [],
    store: new CookieStore(),
    createdAt: 0,
    lastSeen: 0,
  };
}

function binding(tabId: number, sessionId: string, windowId: number): Binding {
  return {
    tabId,
    sessionId,
    windowId,
    url: 'https://example.com/',
    origin: 'manual',
    sealed: false,
    boundAt: 0,
    lastActive: 0,
  };
}

describe('tab groups', () => {
  it('maps every session hue to the nearest group colour', () => {
    expect(groupColorFor('cyan')).toBe('cyan');
    expect(groupColorFor('azure')).toBe('blue');
    expect(groupColorFor('violet')).toBe('purple');
    expect(groupColorFor('magenta')).toBe('pink');
    expect(groupColorFor('coral')).toBe('orange');
    expect(groupColorFor('jade')).toBe('green');
    expect(groupColorFor('grey')).toBe('grey');
    expect(groupColorFor('#ff0000')).toBe('grey');
  });

  it('splits one session across windows, because a group cannot span them', () => {
    const plans = planGroups(
      [session('a', 'Work', 'jade')],
      [binding(1, 'a', 10), binding(2, 'a', 10), binding(3, 'a', 11), binding(4, 'a', 11)]
    );
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.windowId).sort()).toEqual([10, 11]);
    expect(plans[0]!.color).toBe('green');
  });

  it('leaves a lone tab ungrouped, since a group of one is only a border', () => {
    expect(planGroups([session('a', 'Work', 'jade')], [binding(1, 'a', 10)])).toEqual([]);
  });

  it('ignores bindings with no window and sessions that no longer exist', () => {
    const plans = planGroups(
      [session('a', 'Work', 'jade')],
      [binding(1, 'a', -1), binding(2, 'a', -1), binding(3, 'gone', 10), binding(4, 'gone', 10)]
    );
    expect(plans).toEqual([]);
  });

  it('reuses a group already carrying the session name', () => {
    const calls: unknown[] = [];
    const api: GroupApi = {
      query: async () => [{ id: 7, title: 'Work' }],
      group: async (opts) => {
        calls.push(opts);
        return opts.groupId ?? 99;
      },
      update: async () => undefined,
    };
    const plans = planGroups(
      [session('a', 'Work', 'jade')],
      [binding(1, 'a', 10), binding(2, 'a', 10)]
    );
    return applyGroups(api, plans).then((n) => {
      expect(n).toBe(1);
      expect(calls[0]).toMatchObject({ groupId: 7 });
    });
  });

  it('keeps grouping the rest when one window has gone away', async () => {
    let seen = 0;
    const api: GroupApi = {
      query: async () => [],
      group: async () => {
        seen++;
        if (seen === 1) throw new Error('no such window');
        return 5;
      },
      update: async () => undefined,
    };
    const plans = planGroups(
      [session('a', 'A', 'jade'), session('b', 'B', 'coral')],
      [binding(1, 'a', 10), binding(2, 'a', 10), binding(3, 'b', 11), binding(4, 'b', 11)]
    );
    expect(await applyGroups(api, plans)).toBe(1);
  });
});
