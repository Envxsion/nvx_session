/**
 * One listener, in every frame, for the one thing the mask cannot report about
 * itself.
 *
 * When a policy refuses the mask's worker the mask takes itself off, and that is
 * only half a withdrawal: the request headers are rules the worker installed and
 * a MAIN world script has no channel to reach them. Without this the page ends up
 * reporting the real browser while its own requests report the normalised one,
 * which is the contradiction the withdrawal exists to end.
 *
 * Two things decide the shape of this file, and both are worth stating because
 * neither is obvious.
 *
 * **It listens rather than relays.** The mask hears the same event and could
 * simply pass it on, but anything the mask can dispatch the page can dispatch,
 * because they share a world. A fingerprinter that could ask to have the posture
 * withdrawn would just ask, and be handed the real machine. A
 * `SecurityPolicyViolationEvent` a page constructs carries `isTrusted: false` and
 * only the browser can raise a trusted one, so that check is the authentication
 * and this has to run somewhere the page cannot reach to make it worth anything.
 *
 * **It is its own script rather than part of the agent.** The agent is
 * registered on the top frame only, because it binds tabs and draws the chooser
 * and neither belongs in an iframe. A refusal inside a frame was therefore never
 * heard. Widening the agent would evaluate all of it in every frame for the sake
 * of one listener, so the listener moved here instead: thirty lines, one
 * listener, and nothing else to go wrong in a frame.
 *
 * It costs nothing until something is refused. No port is opened, no state is
 * kept, and the message is sent once.
 */

/**
 * Only the directives that can actually stop a worker, and only a blob.
 *
 * The mask's copy of this test was once broad enough to include `script-src`,
 * which describes an enormous share of the real web and would have withdrawn the
 * posture almost everywhere. The blocked URI has to be ours as well, because a
 * page can perfectly well have its own worker refused for reasons that have
 * nothing to do with us.
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
