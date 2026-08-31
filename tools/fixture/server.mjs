/**
 * ------------------------------------------------------------------
 *  Title    |  NVX fixture origin
 *  Ref      |  probes/capability, run-probe.mjs
 *  ID       |  fixture
 * ------------------------------------------------------------------
 *  Purpose  |  A deterministic, offline test origin for the
 *           |  capability probes and, later, the M1 isolation suite.
 *  Note     |  Nothing depends on the network, so probe results are
 *           |  reproducible and comparable between Chrome and Opera
 *           |  GX.
 *  Author   |  Ojas Kekre, 20/08/2026
 * ------------------------------------------------------------------
 */

import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.NVX_FIXTURE_PORT ?? 8787);
const REPORTS = join(dirname(fileURLToPath(import.meta.url)), 'reports');
mkdirSync(REPORTS, { recursive: true });

const html = (body, head = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NVX fixture</title>${head}
<style>
  body{margin:0;background:#08090a;color:#eff0ea;
       font:14px/1.6 ui-monospace,Consolas,monospace;padding:28px}
  h1{font-size:13px;letter-spacing:.18em;color:#dcea4f;font-weight:400;margin:0 0 18px}
  pre{background:#14161a;border:1px solid rgba(239,240,234,.1);padding:14px;
      overflow:auto;white-space:pre-wrap;word-break:break-all}
  .k{color:#8a9096}
</style></head><body>${body}</body></html>`;

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store, no-cache, must-revalidate',
    'access-control-allow-origin': '*',
    ...extra,
  });
  res.end(body);
}

const json = (res, obj, extra) =>
  send(res, 200, 'application/json', JSON.stringify(obj, null, 2), extra);

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Cookie fixtures spanning the attribute space the jar
 *           |  in DESIGN.html section 08 has to reproduce.
 *  Note     |  Each run rotates the value so a stale cookie can never
 *           |  be mistaken for a fresh one.
 * ------------------------------------------------------------------
 */
function cookieSet(stamp) {
  return [
    `nvx_plain=p_${stamp}; Path=/`,
    `nvx_lax=l_${stamp}; Path=/; SameSite=Lax`,
    `nvx_strict=s_${stamp}; Path=/; SameSite=Strict`,
    `nvx_deep=d_${stamp}; Path=/deep`,
    `nvx_session_only=o_${stamp}; Path=/; HttpOnly`,
    `nvx_long=g_${stamp}; Path=/; Max-Age=86400`,
  ];
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    return send(res, 204, 'text/plain', '', {
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    });
  }

  // The probe posts here when it finishes, so no UI has to be driven to get
  // results out of a browser instance.
  if (path === '/report' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(res, 400, 'text/plain', 'bad json');
      }
      const tag = (parsed?.env?.browser ?? 'unknown').toLowerCase();
      const mv = parsed?.env?.manifestVersion ?? '?';
      const file = join(REPORTS, `${tag}-mv${mv}-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(parsed, null, 2));
      console.log(`\nREPORT RECEIVED  ${tag} mv${mv}  ->  ${file}`);
      json(res, { ok: true, file });
    });
    return;
  }

  // What the origin actually received. The probe compares this against what
  // the vault says should have been sent.
  if (path === '/echo') {
    return json(res, {
      ok: true,
      method: req.method,
      url: req.url,
      cookieHeader: req.headers.cookie ?? null,
      cookieCount: req.headers.cookie ? req.headers.cookie.split(';').length : 0,
      userAgent: req.headers['user-agent'] ?? null,
      secChUa: req.headers['sec-ch-ua'] ?? null,
      secChUaPlatform: req.headers['sec-ch-ua-platform'] ?? null,
      acceptLanguage: req.headers['accept-language'] ?? null,
      secFetchSite: req.headers['sec-fetch-site'] ?? null,
      secFetchMode: req.headers['sec-fetch-mode'] ?? null,
      nvxRoute: req.headers['x-nvx-route'] ?? null,
      at: Date.now(),
    });
  }

  /**
   * A federated sign-in, reduced to the two things that actually broke.
   *
   * Hop one sets a session cookie with no SameSite attribute, which every
   * browser treats as Lax. Hop two is served from 127.0.0.1, a different site
   * from localhost, and auto-submits a form back to us: a cross-site POST,
   * which is exactly how a SAML assertion comes home. A browser withholds Lax
   * cookies from that request. A cookie jar that ignores the request method
   * does not, and hands the endpoint a session id it was never meant to see.
   *
   * The final hop is a same-site GET, where the cookie must come back, so the
   * test can tell a correct withholding from simply losing the cookie.
   */
  /**
   * A sign-in that never completes, which is what a partial cookie set looks
   * like from the outside.
   *
   * The shape the Google failure had: every hop lands, decides the credentials
   * it was handed are not the ones it issued, and bounces back to the start.
   * `/loop` is the endless version, for the detector. `/loop?stop=N` completes
   * after N hops, which is what an ordinary federated sign-in does and what the
   * detector must not touch.
   */
  if (path === '/loop') {
    const n = Number(url.searchParams.get('n') ?? 0);
    const stop = Number(url.searchParams.get('stop') ?? 0);
    if (stop && n >= stop) {
      return send(res, 200, 'text/html', html(`<h1>signed in after ${n} hops</h1>`));
    }
    return send(res, 302, 'text/plain', '', {
      location: `/loop?n=${n + 1}${stop ? `&stop=${stop}` : ''}`,
    });
  }

  if (path === '/chain' || path.startsWith('/chain/')) {
    const jar = Object.fromEntries(
      (req.headers.cookie ?? '')
        .split(';')
        .map((p) => p.trim().split('='))
        .filter((p) => p[0])
        .map(([k, ...v]) => [k, v.join('=')])
    );
    const hops = Number(url.searchParams.get('hops') ?? 0);
    const to = (p, extra) => send(res, 303, 'text/plain', '', { location: p, ...extra });

    if (hops > 6) {
      return json(res, { ok: false, reason: 'the chain never advanced', jar });
    }

    if (path === '/chain') {
      // Two cookies, because the browser treats them differently and the whole
      // question lives in the gap.
      //
      // chain_a carries no SameSite attribute, so it is Lax by default, exactly
      // like MoodleSession. Chrome sends one of those on a cross-site POST for
      // its first two minutes, which is what keeps form POST single sign-on
      // working, so it is expected to arrive.
      //
      // chain_x asks for Lax explicitly. No carve-out applies and it must not
      // arrive. That one is the isolation guarantee.
      return to(`http://127.0.0.1:${PORT}/chain/idp?hops=${hops + 1}`, {
        'set-cookie': [
          `chain_a=A_${Date.now()}; Path=/`,
          `chain_x=X_${Date.now()}; Path=/; SameSite=Lax`,
        ],
      });
    }

    /**
     * Served from the other site. Auto-submits, so the POST is cross-site.
     *
     * It also answers the question that matters to anybody who turned third
     * party blocking on: did this hop arrive carrying the identity provider's
     * own session cookie. That is the difference between a sign-in that
     * completes silently and one that asks for a password, and on a real
     * tenant it is also the difference between working and bouncing between
     * service and provider forever.
     *
     * This hop is a top level navigation, not a subresource, and the request
     * comes from a different site than the document that started it. If a
     * blanket third party rule catches it, the provider sees an anonymous
     * visitor and the chain never advances.
     */
    if (path === '/chain/idp') {
      const idp = jar.idp_sid ? '1' : '0';
      return send(
        res,
        200,
        'text/html',
        `<!doctype html><meta charset="utf-8"><title>idp</title>` +
          `<form id="f" method="POST" action="http://localhost:${PORT}/chain/acs?hops=${hops + 1}&i=${idp}">` +
          `<input type="hidden" name="SAMLResponse" value="assertion"></form>` +
          `<script>document.getElementById('f').submit()</script>`
      );
    }

    // The assertion coming home. What should arrive is the freshly set
    // defaulted-Lax cookie and nothing that asked for Lax by name.
    if (path === '/chain/acs' && req.method === 'POST') {
      const defaulted = jar.chain_a ? '1' : '0';
      const explicit = jar.chain_x ? '1' : '0';
      const idp = url.searchParams.get('i') ?? '0';
      return to(`/chain/done?hops=${hops + 1}&d=${defaulted}&x=${explicit}&i=${idp}`, {
        'set-cookie': `chain_b=B_${jar.chain_a ?? 'none'}; Path=/`,
      });
    }

    if (path === '/chain/done') {
      const carriedDefaulted = url.searchParams.get('d') === '1';
      const carriedExplicit = url.searchParams.get('x') === '1';
      return json(res, {
        // Correct means three things at once: the state the site set moments
        // ago reached its own endpoint, a cookie that asked for Lax did not,
        // and the same-site GET that follows still carries the session.
        ok: carriedDefaulted && !carriedExplicit && Boolean(jar.chain_a),
        // Kept under the old name so a reader can line this up with the note in
        // STATUS about what leaked and when.
        leakedOnCrossSitePost: carriedExplicit,
        defaultedLaxRidesThePost: carriedDefaulted,
        explicitLaxWithheld: !carriedExplicit,
        sameSiteGetCarriesIt: Boolean(jar.chain_a),
        /** Whether the provider recognised the session it was handed. */
        idpRecognisedTheSession: url.searchParams.get('i') === '1',
        hops,
        chain_a: jar.chain_a ?? null,
        cookieHeader: req.headers.cookie ?? null,
      });
    }
  }

  // Something with a blast radius, for the guard suite. The path is what makes
  // it destructive: the generic catalog rule matches /destroy on any host, so
  // proving the guard does not need a real provider's endpoint to shoot at.
  if (path.startsWith('/danger/') && path.endsWith('/destroy')) {
    return json(res, { ok: true, destroyed: path.split('/')[2] ?? null, method: req.method });
  }

  // The control arm: the same shape, a harmless verb.
  if (path.startsWith('/danger/')) {
    return json(res, { ok: true, read: path.split('/')[2] ?? null, method: req.method });
  }

  if (path === '/set') {
    const stamp = url.searchParams.get('stamp') ?? String(Date.now());
    return json(res, { ok: true, set: cookieSet(stamp), stamp }, {
      'set-cookie': cookieSet(stamp),
    });
  }

  // Single Set-Cookie, for the strip-versus-observe test where one header
  // keeps the outcome table small.
  if (path === '/set-one') {
    const stamp = url.searchParams.get('stamp') ?? String(Date.now());
    return json(res, { ok: true, stamp }, {
      'set-cookie': `nvx_probe=v_${stamp}; Path=/; Max-Age=600`,
    });
  }

  if (path === '/worker.js') {
    return send(
      res,
      200,
      'application/javascript',
      `self.onmessage = async () => {
         let canvas = null;
         try {
           const c = new OffscreenCanvas(40, 12);
           const g = c.getContext('2d');
           g.textBaseline = 'top';
           g.font = '11px sans-serif';
           g.fillStyle = '#f60';
           g.fillRect(0, 0, 40, 12);
           g.fillStyle = '#069';
           g.fillText('nvx', 2, 1);
           const blob = await c.convertToBlob();
           const buf = new Uint8Array(await blob.arrayBuffer());
           let h = 2166136261;
           for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = Math.imul(h, 16777619); }
           canvas = (h >>> 0).toString(16);
         } catch (e) { canvas = 'error:' + e.name; }
         self.postMessage({
           scope: 'worker',
           masked: typeof self.__nvx_masked !== 'undefined',
           hardwareConcurrency: navigator.hardwareConcurrency,
           userAgent: navigator.userAgent,
           canvas,
         });
       };`
    );
  }

  if (path === '/sw.js') {
    return send(
      res,
      200,
      'application/javascript',
      `self.addEventListener('install', () => self.skipWaiting());
       self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
       self.addEventListener('message', async (e) => {
         try {
           const r = await fetch('/echo?from=sw', { credentials: 'include' });
           e.source.postMessage({ from: 'sw', body: await r.json() });
         } catch (err) {
           e.source.postMessage({ from: 'sw', error: String(err) });
         }
       });`,
      { 'service-worker-allowed': '/' }
    );
  }

  /**
   * A page that keeps something in IndexedDB, which is what Firebase, Supabase
   * and Auth0 all do with a token. Exists so the disclosure that names such
   * sites can be checked against a site that actually is one.
   */
  if (path === '/idb') {
    return send(
      res,
      200,
      'text/html',
      html(
        '<h1>indexeddb</h1><pre id="out">opening</pre>',
        `<script>
           const r = indexedDB.open('nvx_fixture', 1);
           r.onupgradeneeded = () => r.result.createObjectStore('kv');
           r.onsuccess = () => { document.getElementById('out').textContent = 'opened'; };
           r.onerror = () => { document.getElementById('out').textContent = 'failed'; };
         </script>`
      )
    );
  }

  if (path === '/page' || path === '/' || path.startsWith('/deep')) {
    return send(
      res,
      200,
      'text/html',
      html(`<h1>NVX FIXTURE // ${path}</h1>
<p class="k">
  This origin exists to be measured. Nothing here reaches the network, and every
  response is deterministic, so a difference between two runs is a difference in
  the browser rather than in the server.
</p>
<pre id="out">idle</pre>
<script>
  // Which content script worlds reached this document, in the order they ran.
  // Only the capability probe writes this attribute, so under any other
  // extension the honest answer is that nothing was measuring, which is not the
  // same as nothing having run. It used to say "no probe scripts ran" and read
  // like a failure on every ordinary visit.
  const out = document.getElementById('out');
  const seq = document.documentElement.getAttribute('data-nvx-seq');
  out.textContent = seq
    ? 'injection sequence: ' + seq
    : 'no capability probe attached. run: npm run probe -- opera';
</script>`)
    );
  }

  /**
   * The canvas fingerprint probe.
   *
   * Deliberately procedural rather than text based. The classic probe draws a
   * string, and text rasterisation is not available in a worker in the same
   * form, so a text probe could never be compared between the two. The whole
   * point here is comparing them: a content script does not run in a worker
   * scope, so a fingerprinter that builds its hash inside a Worker with an
   * OffscreenCanvas reads pristine values, and a page whose worker and main
   * thread disagree about the same drawing is in a state no real machine
   * produces. Section 11 ranks that Critical, above every other vector.
   *
   * So the same drawing is made three ways and hashed three ways.
   *
   *   direct     getImageData on the main thread
   *   encoded    toDataURL, hashed as the string
   *   roundTrip  that data url decoded back into a canvas and read again
   *   worker     the same drawing on an OffscreenCanvas inside a Worker
   *
   * roundTrip exists to catch the failure that additive noise would have: on a
   * real machine a decode and re-read agrees with a direct read, and it must
   * still agree once the mask is on.
   *
   * `?csp=1` sends a policy that forbids blob workers, which is how the mask's
   * fail-closed path is reached on purpose rather than hoped for.
   */
  if (path === '/fp') {
    const csp = url.searchParams.get('csp') === '1';
    return send(
      res,
      200,
      'text/html',
      `<!doctype html><meta charset="utf-8"><title>fp</title>` +
        `<body style="margin:0;background:#000"><pre id="out">measuring</pre>` +
        `<script>
  const out = document.getElementById('out');
  const report = { csp: ${csp} };

  function hash(input) {
    let h = 0x811c9dc5;
    if (typeof input === 'string') {
      for (let i = 0; i < input.length; i++) {
        h = (h ^ input.charCodeAt(i)) >>> 0;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    } else {
      for (let i = 0; i < input.length; i++) {
        h = (h ^ input[i]) >>> 0;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return (h >>> 0).toString(16);
  }

  // Identical to the worker's, on purpose. Anything that renders differently in
  // the two scopes would make the comparison meaningless rather than strict.
  function draw(ctx, w, h) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        ctx.fillStyle =
          'rgb(' + ((x * 7 + y * 3) % 256) + ',' + ((x * 11) % 256) + ',' + ((y * 13) % 256) + ')';
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  const W = 96, H = 48;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  draw(ctx, W, H);

  report.direct = hash(ctx.getImageData(0, 0, W, H).data);
  // Twice, because per call randomisation is the easiest thing there is to
  // catch and this is the probe that catches it.
  report.directAgain = hash(ctx.getImageData(0, 0, W, H).data);

  const url = canvas.toDataURL();
  report.encoded = hash(url);

  const img = new Image();
  img.onload = () => {
    const copy = document.createElement('canvas');
    copy.width = W; copy.height = H;
    const cctx = copy.getContext('2d');
    cctx.drawImage(img, 0, 0);
    report.roundTrip = hash(cctx.getImageData(0, 0, W, H).data);
    finish();
  };
  img.onerror = () => { report.roundTrip = 'error'; finish(); };
  img.src = url;

  // WebGL, which is two separate questions. The strings are what almost every
  // fingerprinter reads first. The pixels are what a serious one hashes.
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      report.glVendor = info ? String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)) : 'no-ext';
      report.glRenderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'no-ext';

      const ext = gl.getSupportedExtensions() || [];
      report.glExtSorted = ext.join(',') === [...ext].sort().join(',');

      gl.clearColor(0.25, 0.5, 0.75, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const px = new Uint8Array(64 * 64 * 4);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
      report.glPixels = hash(px);

      const px2 = new Uint8Array(64 * 64 * 4);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px2);
      report.glPixelsAgain = hash(px2);
    } else {
      report.glVendor = 'no-webgl';
    }
  } catch (e) {
    report.glVendor = 'threw';
    report.glError = String(e && e.message ? e.message : e);
  }

  // A WebGL canvas encoded rather than read. Asking one for a 2d context
  // returns null, so an encoder that goes through the source's own context
  // cannot mask it, and one canvas would answer two ways.
  try {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const gl2 = c.getContext('webgl', { preserveDrawingBuffer: true });
    if (gl2) {
      gl2.clearColor(0.25, 0.5, 0.75, 1);
      gl2.clear(gl2.COLOR_BUFFER_BIT);
      report.glEncoded = hash(c.toDataURL());
    }
  } catch (e) {
    report.glEncoded = 'threw';
  }

  // Anti introspection. Everything a page can ask about the shape of a function
  // it suspects has been replaced, and the two constructor probes that found
  // real defects.
  try {
    const native = (fn) => Function.prototype.toString.call(fn).includes('[native code]');
    report.tsGetImageData = native(CanvasRenderingContext2D.prototype.getImageData);
    report.tsToDataURL = native(HTMLCanvasElement.prototype.toDataURL);
    report.tsWorker = native(Worker);
    // The trap asked about itself, which is the probe that catches a trap
    // installed carelessly.
    report.tsItself = native(Function.prototype.toString);
    // A function that was never touched must still report its real source, or
    // the trap is answering for everything and is trivially found.
    report.tsPageFn = Function.prototype.toString.call(function marker() { return 1; }).includes('marker');

    const gid = CanvasRenderingContext2D.prototype.getImageData;
    report.shapeName = gid.name;
    report.shapeLength = gid.length;

    report.workerProtoWritable = Object.getOwnPropertyDescriptor(Worker, 'prototype').writable;
    try { Worker('/fp-worker.js'); report.workerNoNew = 'did not throw'; }
    catch (e) { report.workerNoNew = e instanceof TypeError ? 'TypeError' : String(e && e.name); }

    // getParameter for the unmasked enums, on a context that never asked for
    // the extension. Native returns null and raises INVALID_ENUM.
    const bare = document.createElement('canvas').getContext('webgl');
    report.glBareUnmasked = bare ? String(bare.getParameter(0x9246)) : 'no-webgl';
  } catch (e) {
    report.introspectError = String(e && e.message ? e.message : e);
  }

  // What the mask costs to encode. Timing is its own detection vector, so this
  // is measured rather than assumed, and compared against the same page with
  // the mask off.
  try {
    const big = document.createElement('canvas');
    big.width = 512; big.height = 512;
    const bctx = big.getContext('2d');
    draw(bctx, 64, 64);
    bctx.fillStyle = '#4080c0';
    bctx.fillRect(0, 0, 512, 512);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) big.toDataURL();
    report.encodeMs = Math.round(performance.now() - t0);
  } catch (e) {
    report.encodeMs = -1;
  }

  // Audio, the classic shape: an oscillator through a compressor, rendered
  // offline, then the samples hashed. Rendered twice from scratch, because the
  // guarantee is that two renders of the same graph agree, not merely that one
  // buffer reads the same twice.
  let audioDone = false;
  function renderTone() {
    const actx = new OfflineAudioContext(1, 8192, 44100);
    const osc = actx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 10000;
    const comp = actx.createDynamicsCompressor();
    osc.connect(comp);
    comp.connect(actx.destination);
    osc.start(0);
    return actx.startRendering().then((buf) => {
      const ch = buf.getChannelData(0);
      return {
        first: hash(new Uint8Array(ch.buffer, ch.byteOffset, ch.length * 4)),
        // The same array again. getChannelData hands back a live view, so a
        // transform that is not idempotent drifts on every read.
        second: hash(new Uint8Array(buf.getChannelData(0).buffer)),
      };
    });
  }
  try {
    Promise.all([renderTone(), renderTone()])
      .then(([a, b]) => {
        report.audio = a.first;
        report.audioReread = a.second;
        report.audioRerender = b.first;
        // A buffer nobody rendered into is silence, and silence must stay
        // silent or a page that allocates one and reads it back finds it noisy.
        const silent = new OfflineAudioContext(1, 256, 44100).createBuffer(1, 256, 44100);
        report.audioSilence = silent.getChannelData(0).every((v) => v === 0);
        audioDone = true;
        finish();
      })
      .catch((e) => {
        report.audio = 'error';
        report.audioError = String(e && e.message ? e.message : e);
        audioDone = true;
        finish();
      });
  } catch (e) {
    report.audio = 'threw';
    audioDone = true;
  }
  setTimeout(() => { if (!audioDone) { report.audio = 'timeout'; audioDone = true; finish(); } }, 6000);

  // The navigator, and the half of it that is not answerable in the page.
  //
  // A patched navigator.userAgent and an unpatched User-Agent header are two
  // reports of one fact, and any origin can hold them up against each other.
  // So this asks the origin what it actually received rather than trusting the
  // rule to have landed.
  try {
    report.ua = navigator.userAgent;
    report.appVersion = navigator.appVersion;
    report.cores = navigator.hardwareConcurrency;
    report.memory = navigator.deviceMemory;
    const uad = navigator.userAgentData;
    report.brands = (uad && uad.brands || []).map((b) => b.brand + ' ' + b.version).join(', ');
    // Replacing the object rather than patching its prototype is a one line
    // find, so this is the line.
    report.uaDataIntact = Boolean(uad) && uad instanceof NavigatorUAData;
    // An accessor replaced by a data property is another.
    const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    report.uaIsAccessor = Boolean(d && typeof d.get === 'function' && !('value' in d));
    report.tsUserAgent = Function.prototype.toString.call(d.get).includes('[native code]');
    report.uaGetterName = d.get.name;
  } catch (e) {
    report.navError = String(e && e.message ? e.message : e);
  }

  // What the engine says, which a content script cannot reach and therefore
  // must not contradict. A stylesheet can ask for the screen and the pixel
  // ratio and read the answer back, so a spoofed screen would be found by a
  // page comparing the two. This build does not spoof them, and this is the
  // check that keeps it that way.
  try {
    report.screenWidth = screen.width;
    report.screenHeight = screen.height;
    report.dpr = devicePixelRatio;
    report.mqScreenAgrees =
      matchMedia('(device-width: ' + screen.width + 'px)').matches &&
      matchMedia('(device-height: ' + screen.height + 'px)').matches;
    report.mqDprAgrees = matchMedia('(resolution: ' + devicePixelRatio + 'dppx)').matches;
    report.touchPoints = navigator.maxTouchPoints;
    report.mqCoarse = matchMedia('(any-pointer: coarse)').matches;
  } catch (e) {
    report.screenError = String(e && e.message ? e.message : e);
  }

  // WebGPU and the device list, neither of which is masked, and both of which
  // have to agree with something that is. The adapter names the real GPU vendor,
  // so the card bucket has to keep it: claiming NVIDIA in WebGL while WebGPU
  // says AMD is a contradiction one line of script finds.
  let gpuDone = false;
  try {
    const finishGpu = () => { gpuDone = true; finish(); };
    if (!navigator.gpu) { report.gpuVendor = 'absent'; finishGpu(); }
    else {
      navigator.gpu.requestAdapter().then((a) => {
        const info = a && a.info;
        report.gpuVendor = info ? info.vendor : 'no-info';
        report.gpuArchitecture = info ? info.architecture : '';
        finishGpu();
      }).catch((e) => {
        report.gpuVendor = 'error';
        report.gpuError2 = String(e && e.message ? e.message : e);
        finishGpu();
      });
    }
  } catch (e) {
    report.gpuVendor = 'threw';
    gpuDone = true;
  }
  setTimeout(() => { if (!gpuDone) { report.gpuVendor = 'timeout'; gpuDone = true; finish(); } }, 5000);

  // The installed speech voices, which are the strongest OS tell left in the
  // page. getVoices returns nothing until the list has loaded, which is why
  // onvoiceschanged exists, so this waits rather than reading once.
  let voicesDone = false;
  try {
    const readVoices = () => {
      const v = speechSynthesis.getVoices();
      if (!v.length) return false;
      report.voiceCount = v.length;
      report.voiceLangs = [...new Set(v.map((x) => x.lang))].sort().join(',');
      report.voiceNames = v.map((x) => x.name).join('|');
      report.voiceProto = Object.getPrototypeOf(v[0]).constructor.name;
      report.voiceDefaultFirst = v[0].default === true;
      voicesDone = true;
      finish();
      return true;
    };
    if (!readVoices()) speechSynthesis.onvoiceschanged = readVoices;
  } catch (e) {
    report.voiceCount = -1;
    voicesDone = true;
  }
  setTimeout(() => { if (!voicesDone) { report.voiceCount = 0; voicesDone = true; finish(); } }, 5000);

  let devicesDone = false;
  try {
    navigator.mediaDevices.enumerateDevices().then((list) => {
      // Kinds and counts only. With no permission every other field is empty
      // already, which is the browser having done the anonymising itself.
      report.deviceKinds = list.map((d) => d.kind).sort().join(',');
      report.deviceLabelled = list.some((d) => d.label !== '');
      devicesDone = true;
      finish();
    }).catch(() => { report.deviceKinds = 'error'; devicesDone = true; finish(); });
  } catch (e) {
    report.deviceKinds = 'threw';
    devicesDone = true;
  }
  setTimeout(() => { if (!devicesDone) { report.deviceKinds = 'timeout'; devicesDone = true; finish(); } }, 5000);

  let headersDone = false;
  try {
    fetch('/echo', { cache: 'no-store' })
      .then((r) => r.json())
      .then((got) => {
        report.sentUa = got.userAgent;
        report.sentChUa = got.secChUa;
        report.sentChUaPlatform = got.secChUaPlatform;
        headersDone = true;
        finish();
      })
      .catch((e) => {
        report.sentUa = 'error';
        report.headerError = String(e && e.message ? e.message : e);
        headersDone = true;
        finish();
      });
  } catch (e) {
    report.sentUa = 'threw';
    headersDone = true;
  }
  setTimeout(() => { if (!headersDone) { report.sentUa = 'timeout'; headersDone = true; finish(); } }, 5000);

  let workerDone = false;
  try {
    const worker = new Worker('/fp-worker.js');
    worker.onmessage = (e) => {
      report.worker = e.data.hash;
      report.workerUa = e.data.ua;
      report.workerCores = e.data.cores;
      report.workerBrands = e.data.brands;
      workerDone = true;
      finish();
    };
    worker.onerror = (e) => { report.worker = 'error'; report.workerError = String(e.message || e); workerDone = true; finish(); };
    worker.postMessage({ w: W, h: H });
  } catch (e) {
    report.worker = 'threw';
    report.workerError = String(e && e.message ? e.message : e);
    workerDone = true;
  }
  setTimeout(() => { if (!workerDone) { report.worker = 'timeout'; workerDone = true; finish(); } }, 4000);

  // Read again once the worker's fate is known.
  //
  // A mask that fails closed cannot un-noise a value the page already took, so
  // the first reading is whatever was true at parse time and says nothing about
  // what happened afterwards. This is the reading that does: if the mask took
  // itself off, this is the real canvas again, and if it stayed on the two
  // agree. Two different questions, and conflating them made a correct
  // implementation look broken.
  //
  // No backticks anywhere in this script. The whole route is one template
  // literal in the fixture, and a stray one ends it in the middle of a comment.
  function finish() {
    if (report.roundTrip === undefined || !workerDone || !audioDone || !headersDone) return;
    if (!gpuDone || !devicesDone || !voicesDone) return;
    // The handshake, not a global. The mask used to leave one on window, which
    // answered the one question every other patch in it was spent avoiding, so
    // the probe now asks the way the mask's own second evaluation does: through
    // a toString receiver the real one always refuses.
    try {
      const H = '__nvx.mask.v1';
      report.maskOn = Function.prototype.toString.call(H) === H;
    } catch (e) {
      report.maskOn = false;
    }
    report.afterWorker = hash(ctx.getImageData(0, 0, W, H).data);
    out.textContent = JSON.stringify(report);
  }
</script>`,
      csp ? { 'content-security-policy': "worker-src 'none'" } : {}
    );
  }

  /**
   * A page with no policy of its own holding a frame that has one.
   *
   * The refusal happens in the frame, so nothing the top document can hear
   * reports it. This is the case the isolated policy listener exists for: it is
   * registered in every frame, unlike the agent, which binds tabs and draws the
   * chooser and belongs only in the top one. If the posture is withdrawn after
   * loading this, the report can only have come from inside the frame.
   */
  if (path === '/fp-frame') {
    return send(
      res,
      200,
      'text/html',
      `<!doctype html><meta charset="utf-8"><title>fp-frame</title>` +
        `<body style="margin:0;background:#000"><pre id="out">{"frame":true}</pre>` +
        `<iframe src="/fp?csp=1" style="width:400px;height:200px;border:0"></iframe>`
    );
  }

  /**
   * The extension as a hostile page sees it.
   *
   * Everything here is what an ordinary inline script in a document head can do,
   * with no privileges of any kind. Three questions, in order of how bad the
   * answer is: does the extension announce itself by name, does it broadcast a
   * session identifier on a channel anyone can listen to, and will it take
   * instructions from the page it is supposed to be isolating.
   *
   * The listener is attached at parse time on purpose. A content script at
   * document_start runs before this, so this is the earliest a page can be
   * listening, and anything the extension says after this point is heard.
   */
  if (path === '/detect') {
    return send(
      res,
      200,
      'text/html',
      `<!doctype html><meta charset="utf-8"><title>detect</title>` +
        `<body style="margin:0;background:#000;color:#0f0"><pre id="out">watching</pre>` +
        `<script>
  const probe = { heard: [], sid: null, globals: [], events: 0 };
  window.__nvxProbe = probe;

  probe.globals = Object.getOwnPropertyNames(window).filter((k) => /nvx/i.test(k));

  for (const kind of ['ready', 'wait', 'commit', 'state', 'reset']) {
    document.addEventListener('__nvx.storage.' + kind, (e) => {
      probe.events++;
      probe.heard.push(kind);
      try {
        const detail = JSON.parse(String(e.detail || '{}'));
        if (typeof detail.sid === 'string') probe.sid = detail.sid;
      } catch (err) {
        /* not ours, or not json */
      }
      document.getElementById('out').textContent = JSON.stringify(probe);
    });
  }

  // Tell the shim it is in whatever session the caller names, which is what a
  // page would do once it had learned an identifier from the traffic above.
  probe.becomeSession = (sid) => {
    document.dispatchEvent(
      new CustomEvent('__nvx.storage.commit', { detail: JSON.stringify({ sid, fork: false }) })
    );
  };

  // The same instruction, sent before the extension's own answer arrives rather
  // than after it. A content script at document_start beats this script, but the
  // session id it is waiting for comes from the worker and arrives later, so a
  // page that speaks first is speaking into that window.
  const race = new URLSearchParams(location.search).get('as');
  if (race) {
    probe.becomeSession(race);
    try {
      probe.raced = localStorage.getItem('token');
    } catch (err) {
      probe.raced = 'threw';
    }
  }

  document.getElementById('out').textContent = JSON.stringify(probe);
</script>`
    );
  }

  if (path === '/fp-worker.js') {
    return send(
      res,
      200,
      'application/javascript',
      `function hash(input) {
         let h = 0x811c9dc5;
         for (let i = 0; i < input.length; i++) {
           h = (h ^ input[i]) >>> 0;
           h = Math.imul(h, 0x01000193) >>> 0;
         }
         return (h >>> 0).toString(16);
       }
       function draw(ctx, w, h) {
         for (let y = 0; y < h; y++) {
           for (let x = 0; x < w; x++) {
             ctx.fillStyle =
               'rgb(' + ((x * 7 + y * 3) % 256) + ',' + ((x * 11) % 256) + ',' + ((y * 13) % 256) + ')';
             ctx.fillRect(x, y, 1, 1);
           }
         }
       }
       self.onmessage = (e) => {
         const { w, h } = e.data;
         const canvas = new OffscreenCanvas(w, h);
         const ctx = canvas.getContext('2d');
         draw(ctx, w, h);
         self.postMessage({
           hash: hash(ctx.getImageData(0, 0, w, h).data),
           // A worker has its own navigator, and a mask that reaches the canvas
           // but not this one leaves the page and its worker reporting
           // different browsers, which is the same class of contradiction the
           // canvas check exists for.
           ua: navigator.userAgent,
           cores: navigator.hardwareConcurrency,
           brands: (navigator.userAgentData && navigator.userAgentData.brands || [])
             .map((b) => b.brand + ' ' + b.version)
             .join(', '),
         });
       };`
    );
  }

  if (path === '/sw-page') {
    return send(
      res,
      200,
      'text/html',
      html(`<h1>NVX FIXTURE // SERVICE WORKER</h1><pre id="out">registering...</pre>
<script>
  const out = document.getElementById('out');
  navigator.serviceWorker.register('/sw.js').then(async (reg) => {
    await navigator.serviceWorker.ready;
    navigator.serviceWorker.addEventListener('message', (e) => {
      out.textContent = JSON.stringify(e.data, null, 2);
      document.documentElement.setAttribute('data-nvx-sw', JSON.stringify(e.data));
    });
    (reg.active || navigator.serviceWorker.controller).postMessage('go');
  }).catch((e) => { out.textContent = 'register failed: ' + e; });
</script>`)
    );
  }

  if (path === '/open-target') {
    return send(
      res,
      200,
      'text/html',
      html(`<h1>NVX FIXTURE // OPENER</h1>
<p class="k">Measures how long a child tab takes to issue its first request.</p>
<button id="go" style="font:inherit;color:#08090a;background:#dcea4f;border:0;padding:10px 18px;cursor:pointer">
  OPEN CHILD TAB
</button>
<script>
  document.getElementById('go').onclick = () => {
    window.open('/echo?child=1&t=' + Date.now(), '_blank');
  };
</script>`)
    );
  }

  return send(res, 404, 'text/plain', 'nvx fixture: no such route');
});

/**
 * ------------------------------------------------------------------
 *  Purpose  |  A port in use is usually a fixture already running,
 *           |  which is fine and not worth a stack trace.
 *  Note     |  Anything else on the port is worth knowing about, so
 *           |  the two are distinguished rather than lumped together.
 * ------------------------------------------------------------------
 */
server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err;

  let mine = false;
  try {
    const r = await fetch(`http://localhost:${PORT}/echo`, { cache: 'no-store' });
    mine = r.ok && (await r.json())?.ok === true;
  } catch {
    mine = false;
  }

  if (mine) {
    console.log(`nvx fixture is already running on http://localhost:${PORT}`);
    console.log('nothing to do. leave it up, or stop it with: npm run fixture:stop');
    process.exit(0);
  }

  console.error(`port ${PORT} is taken by something that is not the nvx fixture.`);
  console.error(`free it, or run with a different port: NVX_FIXTURE_PORT=8788 npm run fixture`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`nvx fixture listening on http://localhost:${PORT}`);
  console.log('routes: /echo /set /set-one /page /deep /sw-page /open-target /report');
});
