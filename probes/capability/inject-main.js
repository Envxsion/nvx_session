/**
 * ------------------------------------------------------------------
 *  Title    |  MAIN world handshake probe
 *  Ref      |  inject-iso.js, background.js liveInjectionOrder
 *  ID       |  M0 (capability probe)
 * ------------------------------------------------------------------
 *  Purpose  |  Stand in for the mask bootstrap and answer one thing:
 *           |  by the time MAIN runs, has ISOLATED left the config?
 *  Note     |  If it reports missing, DESIGN sec 04 path B does not
 *           |  work and per-tab posture on a shared origin needs T2.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */
(() => {
  const el = document.documentElement;
  const prior = el.getAttribute('data-nvx-seq');
  el.setAttribute('data-nvx-seq', prior ? `${prior},main` : 'main');
  el.setAttribute('data-nvx-main-at', String(performance.now()));

  let verdict = 'missing';
  try {
    verdict = sessionStorage.getItem('__nvx_iso_seed') ? 'ok' : 'missing';
    sessionStorage.setItem('__nvx_probe_seed', verdict);
  } catch (e) {
    try {
      sessionStorage.setItem('__nvx_probe_seed', `error:${e.name}`);
    } catch {}
  }

  el.setAttribute('data-nvx-handshake', verdict);

  // The page has not run yet, so these are the pristine values the mask would
  // be responsible for patching. Recorded so a later run can diff against them.
  el.setAttribute(
    'data-nvx-pristine',
    JSON.stringify({
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? null,
      documentReadyState: document.readyState,
      hasBody: Boolean(document.body),
    })
  );
})();
