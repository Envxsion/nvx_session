/**
 * ------------------------------------------------------------------
 *  Title    |  User agent normalisation
 *  Ref      |  standardUserAgent, standardBrands, secChUa, mask/index.ts
 *  ID       |  M3 (fingerprint)
 * ------------------------------------------------------------------
 *  Purpose  |  Normalise the user agent and brand list rather than
 *           |  fabricating them.
 *  How      |  A Chromium user agent is the frozen string plus a browser
 *           |  token (` OPR/`, ` Edg/`, `HeadlessChrome`); removing the
 *           |  token lands on plain Chrome. The `Sec-CH-UA` list is
 *           |  taken as it comes, its GREASE and Chromium entries left
 *           |  as they are, and only the entry naming the browser is
 *           |  replaced.
 *  Note     |  This puts the user in the largest bucket and keeps the
 *           |  Chromium version real, which a written-down UA cannot, so
 *           |  it is recomputed from the running browser. Copied into
 *           |  `src/mask/index.ts` and held there by test.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

export interface Brand {
  brand: string;
  version: string;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Detect Chromium's greased brand entry.
 *  How      |  The phrase is always some spelling of "Not A Brand" with
 *           |  random punctuation, so match the phrase rather than one
 *           |  spelling.
 *  Note     |  Getting it wrong is not cosmetic: a GREASE entry mistaken
 *           |  for a browser name would be rewritten to Google Chrome,
 *           |  a grease-free list no Chromium sends.
 * ------------------------------------------------------------------
 */
export function isGreaseBrand(brand: string): boolean {
  return /not[^a-z0-9]*a[^a-z0-9]*brand/i.test(brand);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The plain Chrome user agent for whatever Chromium this
 *           |  actually is.
 *  How      |  Rebuilt from the real string's parts. Three things vary
 *           |  and all three are read from it: the platform token
 *           |  (frozen per OS, stays real), the Chromium major (keeps
 *           |  the browser honest), and whether it is a mobile build.
 *  Bug-Fix  |  The first form cut everything after `Safari/537.36`, but
 *           |  Yandex and Samsung write their token before it and
 *           |  survived untouched. A normalisation that silently does
 *           |  nothing is worse than none, since everything downstream
 *           |  then agrees with the unnormalised string.
 *  Note     |  A string not of this shape is returned untouched:
 *           |  presenting Chrome from a non-Chromium browser contradicts
 *           |  every feature test.
 * ------------------------------------------------------------------
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
 * ------------------------------------------------------------------
 *  Purpose  |  The brand list with the browser's own name replaced by
 *           |  Google Chrome.
 *  How      |  Order is preserved because order is part of the greasing.
 *           |  The replacement takes Chromium's version, not the
 *           |  browser's own: Opera 134 is Chromium 150, and keeping 134
 *           |  beside a Chromium entry saying 150 is a disagreement the
 *           |  validator refuses.
 *  Note     |  A list with no browser entry is a plain Chromium build,
 *           |  and one is appended to match Chrome's shape. A list with
 *           |  no Chromium entry to take a version from is returned
 *           |  untouched.
 * ------------------------------------------------------------------
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
 * ------------------------------------------------------------------
 *  Purpose  |  The `Sec-CH-UA` header for a brand list.
 *  How      |  Structured field syntax: each entry is the brand as a
 *           |  quoted string with a `v` parameter, joined by comma
 *           |  space.
 *  Note     |  Must be byte identical to what the page reports through
 *           |  `navigator.userAgentData.brands` or the two disagree.
 * ------------------------------------------------------------------
 */
export function secChUa(brands: Brand[]): string {
  return brands.map((b) => `"${b.brand.replace(/"/g, '')}";v="${b.version}"`).join(', ');
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Whether the user agent and brand list can both be
 *           |  normalised.
 *  Note     |  They move together or not at all. A list with no Chromium
 *           |  entry is one `standardBrands` returns untouched, so
 *           |  normalising the UA anyway would leave Chrome beside a
 *           |  brand list still naming the real browser; the whole
 *           |  surface comes off instead. No brand list at all is fine:
 *           |  an insecure origin has no `userAgentData` and is sent no
 *           |  hints, so there is nothing to contradict.
 * ------------------------------------------------------------------
 */
export function canNormalise(brands: Brand[] | undefined): boolean {
  return !brands?.length || brands.some((b) => b.brand === 'Chromium');
}

/** The Chromium major version a user agent claims, or null if it claims none. */
export function chromiumMajor(ua: string): number | null {
  const found = /(?:Headless)?Chrome\/(\d+)/.exec(ua);
  return found ? Number(found[1]) : null;
}
