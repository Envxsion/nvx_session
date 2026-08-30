/**
 * MAIN world, document_start.
 *
 * Stands in for the real mask bootstrap. Its only job in this probe is to
 * answer one question: by the time it runs, has the ISOLATED world already
 * left the config where it can be read synchronously?
 *
 * If this reports missing, delivery path B in DESIGN.html section 04 does not
 * work and per-tab posture on a shared origin requires the T2 tier.
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
