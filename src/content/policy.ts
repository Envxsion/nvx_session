/**
 * ------------------------------------------------------------------
 *  Title    |  Worker-policy listener
 *  Ref      |  securitypolicyviolation, mask.blocked, mask/index.ts
 *  ID       |  M3 (mask)
 * ------------------------------------------------------------------
 *  Purpose  |  One listener, in every frame, for the one thing the
 *           |  mask cannot report about itself: a CSP refusal of its
 *           |  worker.
 *  How      |  When a policy refuses the mask's worker the mask takes
 *           |  itself off, but the request headers it installed are
 *           |  out of a MAIN-world script's reach; this relays the
 *           |  refusal so the worker can withdraw them too.
 *  Note     |  It listens rather than relays: anything the mask can
 *           |  dispatch the page can too, so the isTrusted check on a
 *           |  SecurityPolicyViolationEvent is the authentication and
 *           |  must run where the page cannot reach. Its own script,
 *           |  not the agent, because the agent is top-frame only and
 *           |  a frame's refusal was never heard. Costs nothing until
 *           |  something is refused.
 *  Author   |  Ojas Kekre, 18/08/2026
 * ------------------------------------------------------------------
 */

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Only the directives that can actually stop a worker,
 *           |  and only a blob.
 *  Note     |  This test once included `script-src`, which describes
 *           |  much of the real web and would have withdrawn the
 *           |  posture almost everywhere. The blocked URI has to be
 *           |  ours too, since a page can have its own worker refused
 *           |  for reasons unrelated to us.
 * ------------------------------------------------------------------
 */
const WORKER_DIRECTIVES = /^(worker-src|child-src)/;

let reported = false;

document.addEventListener('securitypolicyviolation', (e) => {
  const ev = e as SecurityPolicyViolationEvent;
  // The authentication, and the whole reason this runs in an isolated world.
  if (!ev.isTrusted || reported) return;

  const directive = ev.effectiveDirective || ev.violatedDirective || '';
  if (!WORKER_DIRECTIVES.test(directive)) return;
  if (!String(ev.blockedURI ?? '').startsWith('blob')) return;

  reported = true;
  try {
    /**
     * The message names nothing. Which domain loses the posture is taken from
     * the sender the browser stamps on it, not from anything said here, so a
     * frame can only ever withdraw from itself. And what it asks for is strictly
     * less masking, so the worst a forged one could achieve is what a page can
     * already have by serving a policy.
     */
    chrome.runtime.sendMessage({ kind: 'mask.blocked' }, () => {
      // The worker may be asleep or gone. Reading lastError is what stops Chrome
      // logging an unchecked one to the page's own console, which would announce
      // the extension on a site that had just refused it.
      void chrome.runtime.lastError;
    });
  } catch {
    /* the extension is going away, and the next load reports again */
  }
});
