/**
 * Which requests are worth stopping.
 *
 * You keep separate accounts precisely because they have different
 * consequences. Deleting a client's project from the wrong session is a real
 * incident, and no session manager addresses it, because addressing it needs
 * something they do not have: knowledge of which session a request belongs to
 * at the moment it is made. We already inspect every request and already know
 * its session, so this is nearly free.
 *
 * Two tiers, and the split is what keeps it usable.
 *
 * `notable` is anything structurally destructive. It is logged and nothing
 * else, because a DELETE is also how you remove a draft, dismiss a
 * notification and close a tab you opened by mistake. Warning on those trains
 * people to dismiss warnings.
 *
 * `destructive` is a catalogued endpoint that removes something with a blast
 * radius: a project, a repository, a database, a zone. Those warn, and in a
 * session marked for it, they are refused.
 *
 * Patterns are RE2-compatible strings rather than RegExp literals on purpose:
 * the same string is compiled here for classification and handed to
 * declarativeNetRequest as a regexFilter for enforcement, so the thing that
 * warns and the thing that blocks cannot drift apart.
 */

export type Severity = 'notable' | 'destructive';

export interface GuardEntry {
  /** Stable, so an audit entry written months ago still names its rule. */
  id: string;
  /** Shown to the user. A sentence fragment completing "this would ...". */
  what: string;
  /** For grouping in the panel. Not used for matching. */
  service: string;
  methods: string[];
  /** Matched against the whole URL, RE2 syntax, as DNR requires. */
  url: string;
  severity: Severity;
}

/**
 * Catalogued endpoints. Deliberately small and specific.
 *
 * A large catalog of guesses is worse than a small catalog of certainties: a
 * guardrail that fires on something harmless is a guardrail that gets turned
 * off. Everything not listed still lands in the audit trail through the
 * generic rules below.
 */
export const CATALOG: readonly GuardEntry[] = Object.freeze([
  {
    id: 'vercel.project.delete',
    what: 'delete a Vercel project',
    service: 'Vercel',
    methods: ['DELETE'],
    url: '^https://api\\.vercel\\.com/v\\d+/projects/[^/?]+(\\?|$)',
    severity: 'destructive',
  },
  {
    id: 'vercel.deployment.delete',
    what: 'delete a Vercel deployment',
    service: 'Vercel',
    methods: ['DELETE'],
    url: '^https://api\\.vercel\\.com/v\\d+/deployments/[^/?]+(\\?|$)',
    severity: 'destructive',
  },
  {
    id: 'vercel.domain.delete',
    what: 'remove a domain from a Vercel project',
    service: 'Vercel',
    methods: ['DELETE'],
    url: '^https://api\\.vercel\\.com/v\\d+/(domains|projects/[^/]+/domains)/',
    severity: 'destructive',
  },
  {
    id: 'github.repo.delete',
    what: 'delete a GitHub repository',
    service: 'GitHub',
    methods: ['DELETE'],
    url: '^https://api\\.github\\.com/repos/[^/]+/[^/?]+(\\?|$)',
    severity: 'destructive',
  },
  {
    id: 'github.repo.delete.web',
    what: 'delete a GitHub repository',
    service: 'GitHub',
    methods: ['POST'],
    url: '^https://github\\.com/[^/]+/[^/]+/settings/(delete|transfer)',
    severity: 'destructive',
  },
  {
    id: 'github.branch.protection.delete',
    what: 'remove branch protection on GitHub',
    service: 'GitHub',
    methods: ['DELETE'],
    url: '^https://api\\.github\\.com/repos/[^/]+/[^/]+/branches/[^/]+/protection',
    severity: 'destructive',
  },
  {
    id: 'supabase.project.delete',
    what: 'delete a Supabase project',
    service: 'Supabase',
    methods: ['DELETE'],
    url: '^https://api\\.supabase\\.(com|io)/v\\d+/projects/[^/?]+(\\?|$)',
    severity: 'destructive',
  },
  {
    id: 'cloudflare.zone.delete',
    what: 'delete a Cloudflare zone',
    service: 'Cloudflare',
    methods: ['DELETE'],
    url: '^https://api\\.cloudflare\\.com/client/v4/zones/[^/?]+(\\?|$)',
    severity: 'destructive',
  },
  {
    id: 'netlify.site.delete',
    what: 'delete a Netlify site',
    service: 'Netlify',
    methods: ['DELETE'],
    url: '^https://api\\.netlify\\.com/api/v\\d+/sites/[^/?]+(\\?|$)',
    severity: 'destructive',
  },
  {
    id: 'stripe.refund',
    what: 'issue a Stripe refund',
    service: 'Stripe',
    methods: ['POST'],
    url: '^https://api\\.stripe\\.com/v\\d+/refunds',
    severity: 'destructive',
  },
  {
    id: 'aws.cli.terminate',
    what: 'terminate or delete an AWS resource',
    service: 'AWS',
    methods: ['POST'],
    url: '^https://[a-z0-9-]+\\.amazonaws\\.com/.*Action=(Terminate|Delete)',
    severity: 'destructive',
  },

  // The generic tier. These are why the catalog not being complete is
  // survivable: an internal tool nobody has catalogued still leaves a trail.
  {
    id: 'generic.delete',
    what: 'delete something',
    service: 'any',
    methods: ['DELETE'],
    url: '^https?://',
    severity: 'notable',
  },
  {
    id: 'generic.destroy.path',
    what: 'destroy or terminate something',
    service: 'any',
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    url: '^https?://[^/]+/[^?#]*/(destroy|terminate|purge|wipe|drop)(/|\\?|$)',
    severity: 'destructive',
  },
]);

/** Compiled once. A regex per request per entry would show up in the budget. */
const compiled = new WeakMap<readonly GuardEntry[], Array<{ entry: GuardEntry; re: RegExp }>>();

function compile(catalog: readonly GuardEntry[]): Array<{ entry: GuardEntry; re: RegExp }> {
  let out = compiled.get(catalog);
  if (out) return out;
  out = [];
  for (const entry of catalog) {
    try {
      out.push({ entry, re: new RegExp(entry.url) });
    } catch {
      // A pattern that does not compile is a catalog bug, not a request the
      // user should be stopped over. Skipped rather than thrown, so one bad
      // entry cannot take the whole guard offline.
      console.error('[nvx] guard entry has an unusable pattern', entry.id);
    }
  }
  compiled.set(catalog, out);
  return out;
}

export interface Finding {
  entry: GuardEntry;
  severity: Severity;
}

/**
 * The most severe entry matching a request, or null.
 *
 * Most severe rather than first, because the generic DELETE rule matches
 * everything a catalogued DELETE rule does, and reporting "delete something"
 * where "delete a Vercel project" applies would throw away the only part the
 * user needs to make a decision.
 */
export function classify(
  request: { url: string; method: string },
  catalog: readonly GuardEntry[] = CATALOG
): Finding | null {
  const method = request.method.toUpperCase();
  let best: Finding | null = null;
  for (const { entry, re } of compile(catalog)) {
    if (!entry.methods.includes(method)) continue;
    if (!re.test(request.url)) continue;
    if (!best || (best.severity === 'notable' && entry.severity === 'destructive')) {
      best = { entry, severity: entry.severity };
    }
  }
  return best;
}

/** Entries a session in blocking mode should have rules installed for. */
export function blockable(catalog: readonly GuardEntry[] = CATALOG): GuardEntry[] {
  return catalog.filter((e) => e.severity === 'destructive');
}
