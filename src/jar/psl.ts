/**
 * Public suffix checks.
 *
 * Without this a malicious or careless Set-Cookie can scope a cookie to
 * ".co.uk" and have it sent to every site under that suffix. Browsers refuse
 * that, so the jar must too.
 *
 * This is a compact rule set covering the suffixes that actually appear in
 * practice, not the full Public Suffix List. DESIGN.html section 08 calls for
 * the real list compiled to a binary trie; that is a build-time task and this
 * stands in until then. It is deliberately conservative: unknown two-label
 * names under a known multi-level TLD are treated as public suffixes, so the
 * failure mode is rejecting a cookie rather than over-sharing one.
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
 * Hosting suffixes where each label is a separate owner. Treating these as
 * public matters: two different projects on the same platform must not be able
 * to set cookies for each other.
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
 * localhost and bare hostnames have no registrable domain, so a Domain
 * attribute on them is meaningless and is rejected.
 */
/**
 * A name is a public suffix when it *is* one, not when it merely ends with
 * one. The distinction matters: "co.uk" is a public suffix, "shop.co.uk" is a
 * registration under it. Conflating the two made every registrable domain one
 * label too long, which would have grouped rules under the wrong key and split
 * a single session's cookies across rule sets.
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
 * IPv4 dotted quad, or IPv6 in the bracketed form a URL hostname uses.
 *
 * Deliberately strict about the quad: four labels of digits, each within range.
 * A loose check would catch a real hostname made only of digits, which is legal
 * and would then be treated as an address.
 */
export function isIpLiteral(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) return true;
  const parts = h.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Whether a host can have a subdomain at all.
 *
 * An address cannot. Neither can anything the URL parser will try to read as
 * one: a host whose last label is all digits sends the parser down the IPv4
 * path, and `nvx-unvisited-subdomain.127.0.0.1` is not a failed hostname there
 * but a failed address, which throws rather than returning a name.
 *
 * That mattered. The compiler builds a fallback rule for a synthetic
 * unvisited subdomain of every registrable domain a session touches, and one
 * session that had ever seen an IP origin, a router page or a local dev
 * server, threw inside the compile and took down the flush for that session
 * entirely. No rules installed, no cookies carried, and nothing in the log but
 * "Invalid URL".
 */
export function canHaveSubdomains(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h || isIpLiteral(h)) return false;
  const last = h.split('.').pop() ?? '';
  return !/^\d+$/.test(last);
}

/**
 * The registrable domain, used to group cookies into rule sets and to decide
 * first party versus third party.
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
