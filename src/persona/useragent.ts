/**
 * The user agent, normalised rather than fabricated.
 *
 * Every other surface in this directory invents a value. This one refuses to,
 * and the reason is worth stating because it is the difference between a
 * normalisation that ages well and one that becomes a lie.
 *
 * A Chromium user agent is the frozen string plus a browser token: Opera adds
 * ` OPR/134.0.0.0`, Edge adds ` Edg/151.0.0.0`, and the automation build says
 * `HeadlessChrome` where Chrome says `Chrome`. Everything before that token is
 * already identical across every Chromium on the same operating system, because
 * user agent reduction froze it there. So the entire brand difference lives in a
 * suffix, and removing the suffix lands on plain Chrome exactly.
 *
 * That matters twice over. It puts the user in the largest bucket that exists,
 * which is what a bucket is for. And it keeps the Chromium version real, which a
 * written down user agent cannot: a persona carrying `Chrome/151` still says 151
 * a year later, and a browser claiming a version whose features it has and whose
 * absent features it lacks is a stronger signal than any single fingerprint. The
 * bucket has to be recomputed from the browser it is running on, or it ages into
 * a contradiction.
 *
 * The same reasoning runs through the brand list behind `Sec-CH-UA`. Chromium
 * greases it with a deliberately malformed entry whose punctuation and position
 * are derived from the version, so writing one down is another thing that goes
 * stale. The real list is taken as it comes, its GREASE and Chromium entries are
 * left exactly as they are, and only the entry naming the browser is replaced.
 *
 * Copied into `src/mask/index.ts` and held there by test, for the same reason
 * the noise is: the mask runs at document_start in the MAIN world and may not
 * import anything.
 */

export interface Brand {
  brand: string;
  version: string;
}

/**
 * Chromium's greased entry, which every list carries and none of them agree on.
 *
 * The phrase is always some spelling of "Not A Brand" with random punctuation
 * between the words: `Not;A=Brand`, `Not_A Brand`, `Not.A/Brand`. Matching the
 * phrase rather than any one spelling is the only form of this test that keeps
 * working, and getting it wrong is not cosmetic: a GREASE entry mistaken for a
 * browser name would be rewritten to Google Chrome, producing a brand list with
 * no grease in it, which no Chromium has ever sent.
 */
export function isGreaseBrand(brand: string): boolean {
  return /not[^a-z0-9]*a[^a-z0-9]*brand/i.test(brand);
}

/**
 * The plain Chrome user agent for whatever Chromium this actually is.
 *
 * Rebuilt from the real string's parts rather than trimmed, and the difference
 * is a bug that shipped. The first form cut everything after `Safari/537.36`,
 * on the reasoning that the browser token is a suffix. It is not always: Yandex
 * writes `Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36` and Samsung writes
 * `SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36`, both of which
 * survived the cut untouched. A normalisation that silently does nothing is
 * worse than none, because everything downstream then agrees with it: the header
 * rules would have published the same unnormalised string and every coherence
 * check would have passed.
 *
 * So the shape is taken apart instead. Three things vary and all three are read
 * from the real string: the platform token, which is frozen per operating system
 * and stays real; the Chromium major, which keeps the browser honest about what
 * it can do; and whether this is a mobile build, because the canonical form says
 * `Mobile Safari` there and claiming otherwise contradicts the platform token
 * beside it.
 *
 * A string that does not have this shape is returned untouched. Presenting a
 * Chrome user agent from a browser that is not Chromium would contradict every
 * feature test a page can run, which is the opposite of what this is for.
 */
export function standardUserAgent(ua: string): string {
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

/**
 * The brand list with the browser's own name replaced by Google Chrome.
 *
 * Order is preserved because order is part of the greasing, and the header and
 * the page have to report the same sequence or they disagree about the same
 * browser.
 *
 * The replacement takes Chromium's version rather than the browser's own, and
 * that is the whole subtlety here. A browser numbers its releases separately:
 * Opera 134 is Chromium 150. Keeping 134 next to a Chromium entry saying 150
 * produces a list where Google Chrome and Chromium disagree, which no Chrome
 * has ever sent and which the validator refuses. The version that survives is
 * the engine's, because the engine is the thing the number describes.
 *
 * A list carrying no browser entry at all is a plain Chromium build, and one is
 * appended so the list has the shape Chrome's does. A list this cannot make
 * sense of, having no Chromium entry to take a version from, is returned
 * untouched.
 */
export function standardBrands(brands: Brand[]): Brand[] {
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

/**
 * The `Sec-CH-UA` header for a brand list.
 *
 * Structured field syntax: each entry is the brand as a quoted string with a
 * `v` parameter, joined by comma space. Chromium emits exactly this, and the
 * header has to be byte identical to what the page reports through
 * `navigator.userAgentData.brands` or the two disagree.
 */
export function secChUa(brands: Brand[]): string {
  return brands.map((b) => `"${b.brand.replace(/"/g, '')}";v="${b.version}"`).join(', ');
}

/**
 * Whether the user agent and the brand list can both be normalised.
 *
 * They have to move together or not at all, and this is the predicate that
 * decides it. A list with no Chromium entry is one `standardBrands` cannot make
 * sense of and returns untouched, and normalising the user agent anyway would
 * leave a page reporting Chrome beside a brand list still naming the browser it
 * really is, which is a contradiction in one object rather than a disguise. The
 * whole surface comes off instead.
 *
 * No brand list at all is a different case and is fine: an insecure origin has
 * no `userAgentData` and is sent no hints either, so there is nothing to
 * contradict.
 */
export function canNormalise(brands: Brand[] | undefined): boolean {
  return !brands?.length || brands.some((b) => b.brand === 'Chromium');
}

/** The Chromium major version a user agent claims, or null if it claims none. */
export function chromiumMajor(ua: string): number | null {
  const found = /(?:Headless)?Chrome\/(\d+)/.exec(ua);
  return found ? Number(found[1]) : null;
}
