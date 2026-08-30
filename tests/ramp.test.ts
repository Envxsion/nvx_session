/**
 * The identity ramp lives in six files.
 *
 * It has to. The worker picks a colour, the badge painter turns it into pixels
 * on a favicon, the content script draws the chooser inside a page that cannot
 * see the extension's stylesheet, the tab group mapper turns it into one of the
 * browser's nine fixed group colours, the panel draws the swatch you pick from,
 * and the stylesheet is where the values actually come from. None of those can
 * import from another: three run in different worlds and one is CSS.
 *
 * So the guarantee is made here instead. Adding a colour to the ramp and
 * forgetting one of the five other places is a silent failure in every case: a
 * session comes out grey in one surface and correct in the rest, or worse, the
 * worker hands out a name the panel has no swatch for and the user cannot see
 * what colour their own session is.
 *
 * These read the files as text rather than importing them, because two of the
 * six are not modules this test could load.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUES } from '../src/paint/badge.js';
import { groupColorFor } from '../src/paint/groups.js';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Everything between the brackets of `const NAME = [ ... ]`, as strings. */
function arrayLiteral(source: string, name: string): string[] {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!m) throw new Error(`no array literal named ${name}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/** The keys of an object literal `const NAME: T = { ... }`. */
function objectKeys(source: string, name: string): string[] {
  const start = source.indexOf(`${name}`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('};', open);
  const body = source.slice(open + 1, close);
  return [...body.matchAll(/^\s*([a-z]+)\s*:/gm)].map((x) => x[1]!);
}

const RAMP = arrayLiteral(read('src/bg/index.ts'), 'const RAMP');

describe('the identity ramp', () => {
  it('is the eight the worker hands out', () => {
    expect(RAMP).toEqual(['cyan', 'coral', 'jade', 'violet', 'amber', 'azure', 'magenta', 'chalk']);
  });

  /**
   * Order, not just membership. The panel shows the colour a session is about
   * to be given before it is created, and the worker picks the fallback when
   * nothing was sent. If the two lists hold the same names in a different
   * order, the swatch the user was shown is not the colour they get, which is
   * a lie told quietly and only on the path where the panel omits the field.
   */
  it('is the same list in the same order in the panel', () => {
    // In base.js, which every surface loads. It moved there when the setup
    // screen and the guide needed it too, and the point of one copy is that
    // four surfaces cannot come to disagree about what colour a session is.
    expect(arrayLiteral(read('extension/base.js'), 'const COLORS')).toEqual(RAMP);
  });

  /**
   * And nowhere else. A second copy in any surface is the drift this test
   * exists to catch, and it would pass the check above while being wrong.
   */
  it('exists in exactly one place in the extension', () => {
    const carriers = [
      'extension/base.js',
      'extension/panel.js',
      'extension/popup.js',
      'extension/welcome.js',
      'extension/guide.js',
      'extension/guide-data.js',
      'extension/chooser.js',
    ].filter((f) => /const COLORS\s*=/.test(read(f)));
    expect(carriers).toEqual(['extension/base.js']);
  });

  it('has a hex for every name, in the stylesheet', () => {
    const css = read('packages/ui/tokens.css');
    for (const name of RAMP) {
      expect(css, `--s-${name} missing from tokens.css`).toMatch(
        new RegExp(`--s-${name}:\\s*#[0-9a-f]{6}`, 'i')
      );
    }
  });

  it('has the same hex in the badge painter as in the stylesheet', () => {
    const css = read('packages/ui/tokens.css');
    for (const name of RAMP) {
      const declared = new RegExp(`--s-${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1];
      expect(HUES[name]?.toLowerCase(), `badge hex for ${name}`).toBe(declared?.toLowerCase());
    }
  });

  /**
   * The content script cannot reach a stylesheet: it draws the chooser into a
   * page it does not own, in a shadow root, with no access to the extension's
   * tokens. So it carries its own copy and this is the only thing keeping it
   * honest.
   */
  it('has the same hex in the in-page chooser as in the badge painter', () => {
    const agent = read('src/content/agent.ts');
    for (const name of RAMP) {
      const declared = new RegExp(`\\b${name}:\\s*'(#[0-9a-f]{6})'`, 'i').exec(agent)?.[1];
      expect(declared?.toLowerCase(), `chooser hex for ${name}`).toBe(HUES[name]?.toLowerCase());
    }
  });

  it('maps every name to a real browser group colour', () => {
    const GROUP = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
    for (const name of RAMP) {
      expect(GROUP, `${name} maps outside the browser palette`).toContain(groupColorFor(name));
    }
  });

  /**
   * Two sessions that group to the same browser colour are two sessions the
   * tab strip cannot tell apart, which is the one job the group channel has.
   * Nine slots, eight names, so this is achievable and worth asserting.
   */
  it('gives each name its own group colour', () => {
    const used = RAMP.map((c) => groupColorFor(c));
    expect(new Set(used).size).toBe(RAMP.length);
  });

  it('never maps a real session to the holding session\'s grey by accident', () => {
    const mapped = objectKeys(read('src/paint/groups.ts'), 'NEAREST');
    for (const name of RAMP) {
      expect(mapped, `${name} has no entry in NEAREST, so it falls through to grey`).toContain(
        name
      );
    }
  });
});
