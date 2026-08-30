/**
 * ------------------------------------------------------------------
 *  Title    |  Public suffix checks
 *  Ref      |  cookie.ts, store.ts, DESIGN sec 08
 *  ID       |  M1 (cookie jar)
 * ------------------------------------------------------------------
 *  Purpose  |  Refuse a cookie scoped to a public suffix like
 *           |  ".co.uk", as browsers do.
 *  How      |  A compact rule set covering the suffixes seen in
 *           |  practice, standing in for the full Public Suffix List
 *           |  until it is compiled to a trie at build time.
 *  Note     |  Conservative: unknown two-label names under a known
 *           |  multi-level TLD are treated as public, so the failure
 *           |  mode is rejecting a cookie, not over-sharing one.
 *  Author   |  Ojas Kekre, 17/08/2026
 * ------------------------------------------------------------------
 */

const SINGLE_LABEL_IS_PUBLIC = true;

/** Second-level suffixes under which registrations happen. */
const MULTI_LEVEL = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'gov.in', 'ac.in',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za',
  'com.mx', 'org.mx', 'gob.mx',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'com.tw', 'net.tw', 'org.tw', 'gov.tw', 'edu.tw',
  'co.kr', 'ne.kr', 'or.kr', 'go.kr', 're.kr',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.pl', 'net.pl', 'org.pl', 'gov.pl',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn',
  'com.eg', 'net.eg', 'org.eg', 'gov.eg',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa',
  'com.ng', 'net.ng', 'org.ng', 'gov.ng',
  'com.pk', 'net.pk', 'org.pk', 'gov.pk',
  'com.co', 'net.co', 'org.co',
  'com.ec', 'com.pe', 'com.uy', 'com.ve', 'com.do', 'com.gt',
]);

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Hosting suffixes where each label is a separate owner.
 *  Note     |  Treating these as public keeps two projects on one
 *           |  platform from setting cookies for each other.
 * ------------------------------------------------------------------
 */
const PRIVATE_SUFFIXES = new Set([
  'github.io', 'githubusercontent.com', 'gitlab.io', 'pages.dev', 'workers.dev',
  'vercel.app', 'netlify.app', 'now.sh', 'herokuapp.com', 'koyeb.app',
  'appspot.com', 'firebaseapp.com', 'web.app', 'cloudfunctions.net',
  'azurewebsites.net', 'cloudapp.net', 'amazonaws.com', 's3.amazonaws.com',
  'onrender.com', 'fly.dev', 'railway.app', 'surge.sh', 'glitch.me',
  'blogspot.com', 'wordpress.com', 'tumblr.com', 'myshopify.com',
  'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'loca.lt',
]);

/**
 * ------------------------------------------------------------------
 *  Purpose  |  localhost and bare hostnames have no registrable
 *           |  domain, so a Domain attribute on them is rejected.
 * ------------------------------------------------------------------
 */
/**
 * ------------------------------------------------------------------
 *  Purpose  |  A name is a public suffix when it is one, not when it
 *           |  merely ends with one.
 *  Note     |  "co.uk" is a public suffix, "shop.co.uk" a
 *           |  registration under it.
 *  Bug-Fix  |  Conflating the two made every registrable domain one
 *           |  label too long, grouping rules under the wrong key and
 *           |  splitting a session's cookies across rule sets.
 * ------------------------------------------------------------------
 */
export function isPublicSuffix(domain: string): boolean {
  const host = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost') return true;

  const labels = host.split('.');
  if (labels.length === 1) return SINGLE_LABEL_IS_PUBLIC;

  return MULTI_LEVEL.has(host) || PRIVATE_SUFFIXES.has(host);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  IPv4 dotted quad, or IPv6 in the bracketed form a URL
 *           |  hostname uses.
 *  Note     |  Strict about the quad: a loose check would catch a
 *           |  real all-digits hostname, which is legal, and treat it
 *           |  as an address.
 * ------------------------------------------------------------------
 */
export function isIpLiteral(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) return true;
  const parts = h.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Whether a host can have a subdomain at all.
 *  How      |  An address cannot, nor a host whose last label is all
 *           |  digits: the URL parser reads it as IPv4, so the
 *           |  synthetic subdomain is a failed address that throws.
 *  Bug-Fix  |  The compiler builds a fallback rule for a synthetic
 *           |  unvisited subdomain of every registrable domain, and a
 *           |  session that saw an IP origin, router page or dev
 *           |  server threw and took down the whole flush: no rules,
 *           |  no cookies, only "Invalid URL" in the log.
 * ------------------------------------------------------------------
 */
export function canHaveSubdomains(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h || isIpLiteral(h)) return false;
  const last = h.split('.').pop() ?? '';
  return !/^\d+$/.test(last);
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The registrable domain, used to group cookies into
 *           |  rule sets and to decide first vs third party.
 * ------------------------------------------------------------------
 */
export function registrableDomain(domain: string): string {
  const host = domain.trim().toLowerCase().replace(/\.$/, '');

  // An address is not a name and has no registrable domain, so it compares as
  // itself. Taking the last two labels of 127.0.0.1 gives "0.1", which is not
  // wrong in an interesting way: it silently groups every address ending in
  // those octets together and matches nothing a rule is built for. Reached in
  // practice through a development origin and through a session's family.
  if (isIpLiteral(host)) return host;

  const labels = host.split('.');
  if (labels.length <= 1) return host;

  for (let take = 2; take <= labels.length; take++) {
    const candidate = labels.slice(-take).join('.');
    if (!isPublicSuffix(candidate)) return candidate;
  }
  return host;
}

export function sameSite(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}
