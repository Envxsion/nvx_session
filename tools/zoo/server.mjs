/**
 * ------------------------------------------------------------------
 *  Title    |  Sign-in pattern zoo
 *  Ref      |  tools/zoo/run.mjs, tools/fixture/server.mjs
 *  ID       |  tools (zoo)
 * ------------------------------------------------------------------
 *  Purpose  |  One page per sign-in mechanism, not per site, so a
 *           |  browser run can prove NVX sends what the browser would
 *           |  on every flow providers anywhere are built from.
 *  How      |  HTTPS on fake .test hosts the browser maps to this
 *           |  process. Each scenario is a short chain that sets a
 *           |  cookie and needs it back on a later step; the server
 *           |  records what each step actually received under a run
 *           |  token, and the runner reads that record over plain
 *           |  http. Nothing depends on the network.
 *  Note     |  node tools/zoo/server.mjs   (https 18443, control 18788)
 *  Author   |  Ojas Kekre, 03/10/2026
 * ------------------------------------------------------------------
 */

import { createServer as createHttps } from 'node:https';
import { createServer as createHttp } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTTPS_PORT = Number(process.env.ZOO_PORT ?? 18443);
const CONTROL_PORT = Number(process.env.ZOO_CONTROL ?? 18788);

// ----------------------------------------------------------- certificate

/** Self-signed, any name: the browser runs with certificate errors ignored. */
function certificate() {
  const dir = join(HERE, '.cert');
  const key = join(dir, 'key.pem');
  const crt = join(dir, 'crt.pem');
  if (!existsSync(key) || !existsSync(crt)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-keyout', key, '-out', crt, '-subj', '/CN=zoo.test',
      '-addext', 'subjectAltName=DNS:*.test,DNS:*.app.test,DNS:*.svc.test,DNS:*.console.svc.test,DNS:*.idp.test',
    ], { stdio: 'ignore' });
  }
  return { key: readFileSync(key), cert: readFileSync(crt) };
}

// ----------------------------------------------------------------- state

/** token -> { scenario, user, steps: [{ step, host, cookies }], result } */
const runs = new Map();

function record(t, step, req, extra = {}) {
  if (!t) return;
  const run = runs.get(t) ?? { steps: [], result: null };
  run.steps.push({ step, host: req.headers.host, method: req.method, cookies: Object.keys(cookiesOf(req)), ...extra });
  runs.set(t, run);
}

/**
 * The first verdict is kept, and the last one too. A step that failed and was
 * then retried by NVX without the user doing anything is a recovery, which is
 * worth knowing apart from both a clean pass and a failure.
 */
function finish(t, ok, user, why = '') {
  if (!t) return;
  const run = runs.get(t) ?? { steps: [], result: null };
  const verdict = { ok, user, why, at: Date.now() };
  if (!run.first) run.first = verdict;
  run.result = verdict;
  run.tries = (run.tries ?? 0) + 1;
  runs.set(t, run);
}

function cookiesOf(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

// --------------------------------------------------------------- helpers

const page = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>zoo</title>${head}</head><body>${body}</body></html>`;

function send(res, status, body, headers = {}, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(body);
}

const redirect = (res, to, cookies = [], status = 302) =>
  send(res, status, '', { location: to, ...(cookies.length ? { 'set-cookie': cookies } : {}) });

/** The scenario's own identity cookie, carrying the user and a nonce. */
const ident = (u) => `${u}.${Math.random().toString(36).slice(2, 8)}`;
const userOf = (v) => (v ? String(v).split('.')[0] : '');

/** The page every scenario ends on. The record is already written by then. */
const donePage = (t) => page(`<h1 id="zoo-done">done</h1><script>document.title='zoo done ${t}'</script>`);

const SEC = 'Path=/; Secure';

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(new URLSearchParams(b)));
  });
}

// ------------------------------------------------------------- scenarios

/**
 * Every scenario is keyed by its first path segment under /z/. Each ends by
 * calling finish(t, ok, user, why) on the step that needs the cookie, so a
 * failure says exactly which hop went without.
 */
const scenarios = {
  /** A cookie set on a 302 and needed by the very next hop. */
  async redirect(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return redirect(res, `/z/redirect/check?t=${t}`, [`zr_sid=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`]);
    }
    record(t, 'check', req);
    finish(t, Boolean(c.zr_sid), userOf(c.zr_sid), c.zr_sid ? '' : 'cookie set on a 302 missing on the next hop');
    return send(res, 200, donePage(t));
  },

  /** Google's cookie check: a test cookie, then a redirect to a sibling host that reads it. */
  async cookiecheck(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return redirect(res, `https://accounts.app.test/z/cookiecheck/check?t=${t}&u=${u}`, [
        `zc_test=1; Domain=app.test; ${SEC}; SameSite=Lax`,
      ]);
    }
    if (url.pathname.endsWith('/check')) {
      record(t, 'check', req);
      if (!c.zc_test) {
        finish(t, false, '', 'cookie check failed: "cookies are disabled"');
        return send(res, 200, donePage(t));
      }
      return redirect(res, `/z/cookiecheck/signed?t=${t}`, [`zc_sid=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`]);
    }
    record(t, 'signed', req);
    finish(t, Boolean(c.zc_sid), userOf(c.zc_sid), c.zc_sid ? '' : 'session cookie lost after the check');
    return send(res, 200, donePage(t));
  },

  /** A fetch sets the cookie and the page navigates the moment it answers. */
  async xhrnav(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return send(res, 200, page(`<script>
        fetch('/z/xhrnav/login?t=${t}&u=${u}', { method: 'POST', credentials: 'include' })
          .then(() => { location.href = '/z/xhrnav/check?t=${t}'; });
      </script>`));
    }
    if (url.pathname.endsWith('/login')) {
      record(t, 'login', req);
      return send(res, 200, '{}', { 'set-cookie': [`zx_sid=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`] }, 'application/json');
    }
    record(t, 'check', req);
    finish(t, Boolean(c.zx_sid), userOf(c.zx_sid), c.zx_sid ? '' : 'cookie set by a fetch missing on the navigation right after');
    return send(res, 200, donePage(t));
  },

  /** A fetch sets a CSRF cookie and the next fetch, a few ms later, must carry it. */
  async xhrchain(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return send(res, 200, page(`<script>
        fetch('/z/xhrchain/csrf?t=${t}&u=${u}', { method: 'POST', credentials: 'include' })
          .then(() => fetch('/z/xhrchain/submit?t=${t}', { method: 'POST', credentials: 'include' }))
          .then(() => { location.href = '/z/xhrchain/done?t=${t}'; });
      </script>`));
    }
    if (url.pathname.endsWith('/csrf')) {
      record(t, 'csrf', req);
      return send(res, 200, '{}', { 'set-cookie': [`zk_csrf=${ident(u)}; ${SEC}; SameSite=Strict`] }, 'application/json');
    }
    if (url.pathname.endsWith('/submit')) {
      record(t, 'submit', req);
      finish(t, Boolean(c.zk_csrf), userOf(c.zk_csrf), c.zk_csrf ? '' : 'CSRF cookie from one fetch missing on the next ("session expired")');
      return send(res, 200, '{}', {}, 'application/json');
    }
    return send(res, 200, donePage(t));
  },

  /** OAuth across sites: app state cookie out, identity provider hops, back with a code. */
  async oauth(req, res, url, t, u) {
    const c = cookiesOf(req);
    const host = req.headers.host;
    if (host === 'app.test' && url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return redirect(res, `https://idp.test/z/oauth/authorize?t=${t}&u=${u}`, [
        `zo_state=${t}; ${SEC}; HttpOnly; SameSite=Lax`,
      ]);
    }
    if (host === 'idp.test' && url.pathname.endsWith('/authorize')) {
      record(t, 'authorize', req);
      return redirect(res, `/z/oauth/authn?t=${t}&u=${u}`, [`zo_tx=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`]);
    }
    if (host === 'idp.test' && url.pathname.endsWith('/authn')) {
      record(t, 'authn', req);
      if (!c.zo_tx) {
        finish(t, false, '', 'identity provider lost its own transaction cookie mid-chain');
        return send(res, 200, donePage(t));
      }
      return redirect(res, `https://app.test/z/oauth/callback?t=${t}&code=${userOf(c.zo_tx)}`);
    }
    if (url.pathname.endsWith('/callback')) {
      record(t, 'callback', req);
      if (c.zo_state !== t) {
        finish(t, false, '', 'state cookie missing on the callback ("unauthorized")');
        return send(res, 200, donePage(t));
      }
      return redirect(res, `/z/oauth/check?t=${t}`, [`zo_sid=${ident(url.searchParams.get('code'))}; ${SEC}; HttpOnly; SameSite=Lax`]);
    }
    record(t, 'check', req);
    finish(t, Boolean(c.zo_sid), userOf(c.zo_sid), c.zo_sid ? '' : 'session cookie lost after the callback');
    return send(res, 200, donePage(t));
  },

  /** AWS: state scoped to a deeper domain, read back on a region host never visited. */
  async deep(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return redirect(res, `https://r${Math.floor(Math.random() * 1e6)}.console.svc.test/z/deep/callback?t=${t}`, [
        `zd_state=${ident(u)}; Domain=console.svc.test; ${SEC}; HttpOnly; SameSite=Lax`,
      ]);
    }
    record(t, 'callback', req);
    finish(t, Boolean(c.zd_state), userOf(c.zd_state), c.zd_state ? '' : 'deeper-domain cookie did not reach an unvisited region host');
    return send(res, 200, donePage(t));
  },

  /** SAML HTTP-POST binding: the identity provider posts a form back across sites. */
  async saml(req, res, url, t, u) {
    const c = cookiesOf(req);
    const host = req.headers.host;
    if (host === 'app.test' && url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return redirect(res, `https://idp.test/z/saml/sso?t=${t}&u=${u}`, [
        `zs_relay=${ident(u)}; ${SEC}; HttpOnly; SameSite=None`,
      ]);
    }
    if (host === 'idp.test') {
      record(t, 'sso', req);
      return send(res, 200, page(`<form id="f" method="post" action="https://app.test/z/saml/acs?t=${t}">
        <input type="hidden" name="SAMLResponse" value="${u}"></form><script>document.getElementById('f').submit()</script>`));
    }
    if (url.pathname.endsWith('/acs')) {
      record(t, 'acs', req);
      if (!c.zs_relay) {
        finish(t, false, '', 'SameSite=None relay cookie missing on the cross-site POST');
        return send(res, 200, donePage(t));
      }
      return redirect(res, `/z/saml/check?t=${t}`, [`zs_sid=${c.zs_relay}; ${SEC}; HttpOnly; SameSite=Lax`], 303);
    }
    record(t, 'check', req);
    finish(t, Boolean(c.zs_sid), userOf(c.zs_sid), c.zs_sid ? '' : 'session cookie lost after the assertion');
    return send(res, 200, donePage(t));
  },

  /** A form posted into a new tab, as AWS's "add session" does. */
  async newtab(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return send(
        res,
        200,
        page(`<form id="f" method="post" target="_blank" action="/z/newtab/create?t=${t}"><input name="x" value="1"></form>
        <script>setTimeout(() => document.getElementById('f').submit(), 300)</script>`),
        { 'set-cookie': [`zn_csrf=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`] }
      );
    }
    record(t, 'create', req);
    finish(t, Boolean(c.zn_csrf), userOf(c.zn_csrf), c.zn_csrf ? '' : 'new tab\'s first request (a POST) went out without the session');
    return send(res, 200, donePage(t));
  },

  /** A link opened in a new tab (GET), which can be recovered by loading it again. */
  async newtabget(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return send(
        res,
        200,
        page(`<script>setTimeout(() => window.open('/z/newtabget/landing?t=${t}', '_blank'), 300)</script>`),
        { 'set-cookie': [`zg_sid=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`] }
      );
    }
    record(t, 'landing', req);
    // The first try may go out early; the recovery loads it again, so only a
    // landing that carried the cookie counts, and only one ever has to.
    if (c.zg_sid) finish(t, true, userOf(c.zg_sid));
    else setTimeout(() => finish(t, false, '', 'new tab never carried the session'), 6000);
    return send(res, 200, donePage(t));
  },

  /** Popup OAuth: the provider runs in a popup and hands back by postMessage. */
  async popup(req, res, url, t, u) {
    const c = cookiesOf(req);
    const host = req.headers.host;
    if (host === 'app.test' && url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return send(res, 200, page(`<script>
        addEventListener('message', (e) => {
          if (e.origin !== 'https://idp.test') return;
          fetch('/z/popup/finish?t=${t}&code=' + encodeURIComponent(e.data), { method: 'POST', credentials: 'include' })
            .then(() => { location.href = '/z/popup/check?t=${t}'; });
        });
        setTimeout(() => window.open('https://idp.test/z/popup/authorize?t=${t}&u=${u}', 'idp', 'popup,width=400,height=400'), 300);
      </script>`));
    }
    if (host === 'idp.test' && url.pathname.endsWith('/authorize')) {
      record(t, 'authorize', req);
      return redirect(res, `/z/popup/consent?t=${t}`, [`zp_tx=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`]);
    }
    if (host === 'idp.test') {
      record(t, 'consent', req);
      if (!c.zp_tx) {
        finish(t, false, '', 'popup lost the provider\'s cookie mid-chain');
        return send(res, 200, donePage(t));
      }
      return send(res, 200, page(`<script>opener.postMessage(${JSON.stringify(userOf(c.zp_tx))}, 'https://app.test'); setTimeout(() => close(), 200)</script>`));
    }
    if (url.pathname.endsWith('/finish')) {
      record(t, 'finish', req);
      return send(res, 200, '{}', { 'set-cookie': [`zp_sid=${ident(url.searchParams.get('code'))}; ${SEC}; HttpOnly; SameSite=Lax`] }, 'application/json');
    }
    record(t, 'check', req);
    finish(t, Boolean(c.zp_sid), userOf(c.zp_sid), c.zp_sid ? '' : 'session missing after the popup handed back');
    return send(res, 200, donePage(t));
  },

  /** Silent renewal: a hidden identity-provider iframe that needs its SameSite=None cookie. */
  async silent(req, res, url, t, u) {
    const c = cookiesOf(req);
    const host = req.headers.host;
    if (host === 'app.test' && url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return redirect(res, `https://idp.test/z/silent/seed?t=${t}&u=${u}`);
    }
    if (host === 'idp.test' && url.pathname.endsWith('/seed')) {
      record(t, 'seed', req);
      return redirect(res, `https://app.test/z/silent/page?t=${t}`, [`zi_sess=${ident(u)}; ${SEC}; HttpOnly; SameSite=None`]);
    }
    if (host === 'app.test' && url.pathname.endsWith('/page')) {
      record(t, 'page', req);
      return send(res, 200, page(`<iframe src="https://idp.test/z/silent/frame?t=${t}" style="display:none"></iframe>`));
    }
    record(t, 'frame', req);
    finish(t, Boolean(c.zi_sess), userOf(c.zi_sess), c.zi_sess ? '' : 'hidden provider iframe went without its SameSite=None cookie');
    return send(res, 200, page('frame'));
  },

  /**
   * A session that has touched sixty hosts, then signs in on the last.
   * Pixels on every subdomain, the way analytics and cross-subdomain sync
   * fill a real session, so the rule budget is what is under test.
   */
  async manyhosts(req, res, url, t, u) {
    const c = cookiesOf(req);
    const HOSTS = 60;
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      const imgs = Array.from({ length: HOSTS }, (_, i) => `<img src="https://h${i + 1}.app.test/z/manyhosts/pix?n=${i + 1}" width="1" height="1">`).join('');
      return send(res, 200, page(`${imgs}<script>
        let left = ${HOSTS};
        for (const img of document.images) img.onload = img.onerror = () => { if (--left === 0) location.href = 'https://h${HOSTS}.app.test/z/manyhosts/login?t=${t}&u=${u}'; };
      </script>`));
    }
    if (url.pathname.endsWith('/pix')) {
      const n = url.searchParams.get('n');
      return send(res, 200, Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'), {
        'set-cookie': [`zm_h${n}=${'x'.repeat(40)}; ${SEC}; SameSite=None`, `zm_p${n}=1; Path=/z/manyhosts/p${n}; Secure; SameSite=None`],
      }, 'image/gif');
    }
    if (url.pathname.endsWith('/login')) {
      record(t, 'login', req);
      return redirect(res, `/z/manyhosts/check?t=${t}`, [`zm_sid=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`]);
    }
    record(t, 'check', req);
    finish(t, Boolean(c.zm_sid), userOf(c.zm_sid), c.zm_sid ? '' : 'sign-in on the last of many hosts lost its cookie (rule budget?)');
    return send(res, 200, donePage(t));
  },

  /** Large cookies, several of them, as AWS and Microsoft send. */
  async bigcookies(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      const blob = 'b'.repeat(3000);
      return redirect(res, `/z/bigcookies/check?t=${t}`, [
        `zb_a=${blob}; ${SEC}; SameSite=Lax`,
        `zb_b=${blob}; ${SEC}; SameSite=Lax`,
        `zb_sid=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`,
      ]);
    }
    record(t, 'check', req);
    const ok = Boolean(c.zb_sid && c.zb_a && c.zb_b);
    finish(t, ok, userOf(c.zb_sid), ok ? '' : `large cookies dropped (${['zb_a', 'zb_b', 'zb_sid'].filter((k) => !c[k]).join(',')})`);
    return send(res, 200, donePage(t));
  },

  /** A cookie scoped to a path, read under that path by a fetch. */
  async paths(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return redirect(res, `/z/paths/platform/d-1/login?t=${t}`, [
        `zpa_sid=${ident(u)}; Path=/z/paths/platform; Secure; HttpOnly; SameSite=Lax`,
      ]);
    }
    if (url.pathname.endsWith('/login')) {
      record(t, 'login', req);
      return send(res, 200, page(`<script>fetch('/z/paths/platform/d-1/api/execute?t=${t}', { method: 'POST', credentials: 'include' }).then(() => location.href = '/z/paths/done?t=${t}')</script>`));
    }
    if (url.pathname.endsWith('/execute')) {
      record(t, 'execute', req);
      finish(t, Boolean(c.zpa_sid), userOf(c.zpa_sid), c.zpa_sid ? '' : 'path-scoped cookie missing under its path');
      return send(res, 200, '{}', {}, 'application/json');
    }
    // Outside the path the cookie must not go.
    record(t, 'outside', req, { leaked: Boolean(c.zpa_sid) });
    return send(res, 200, donePage(t));
  },

  /** A form POST redirected with 307 to another host, body and method kept. */
  async post307(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return send(
        res,
        200,
        page(`<form id="f" method="post" action="/z/post307/a?t=${t}"><input name="u" value="${u}"></form><script>document.getElementById('f').submit()</script>`),
        { 'set-cookie': [`z7_sid=${ident(u)}; Domain=app.test; ${SEC}; HttpOnly; SameSite=Lax`] }
      );
    }
    if (url.pathname.endsWith('/a')) {
      record(t, 'a', req);
      return redirect(res, `https://api.app.test/z/post307/b?t=${t}`, [], 307);
    }
    record(t, 'b', req);
    const body = await readBody(req);
    const ok = Boolean(c.z7_sid) && req.method === 'POST' && userOf(c.z7_sid) === body.get('u');
    finish(t, ok, userOf(c.z7_sid), ok ? '' : `307 hop lost ${!c.z7_sid ? 'the cookie' : 'the POST body'}`);
    return send(res, 200, donePage(t));
  },

  /** A page with a service worker that fetches through it. */
  async worker(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/sw.js')) {
      return send(res, 200, `self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));
        self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));`, {}, 'text/javascript');
    }
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return send(
        res,
        200,
        page(`<script>
          const go = () => fetch('/z/worker/whoami?t=${t}', { credentials: 'include' }).then(() => location.href = '/z/worker/done?t=${t}');
          (navigator.serviceWorker ? navigator.serviceWorker.register('/z/worker/sw.js').then(() => navigator.serviceWorker.ready) : Promise.resolve())
            .then(() => new Promise((r) => setTimeout(r, 300)), () => null).then(go, go);
        </script>`),
        { 'set-cookie': [`zw_sid=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`] }
      );
    }
    if (url.pathname.endsWith('/whoami')) {
      record(t, 'whoami', req);
      finish(t, Boolean(c.zw_sid), userOf(c.zw_sid), c.zw_sid ? '' : 'fetch through the page lost its cookie');
      return send(res, 200, '{}', {}, 'application/json');
    }
    return send(res, 200, donePage(t));
  },

  /** document.cookie written by script, then a navigation that needs it. */
  async jscookie(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return send(res, 200, page(`<script>
        document.cookie = 'zj_sid=${u}.' + Math.random().toString(36).slice(2, 8) + '; path=/; Secure; SameSite=Lax';
        location.href = '/z/jscookie/check?t=${t}';
      </script>`));
    }
    record(t, 'check', req);
    finish(t, Boolean(c.zj_sid), userOf(c.zj_sid), c.zj_sid ? '' : 'cookie written by script missing on the next navigation');
    return send(res, 200, donePage(t));
  },

  /** A cookie set on a 200 page that moves on by meta refresh. */
  async meta(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return send(res, 200, page('', `<meta http-equiv="refresh" content="0;url=/z/meta/check?t=${t}">`), {
        'set-cookie': [`zme_sid=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`],
      });
    }
    record(t, 'check', req);
    finish(t, Boolean(c.zme_sid), userOf(c.zme_sid), c.zme_sid ? '' : 'cookie from a page left by meta refresh went missing');
    return send(res, 200, donePage(t));
  },
  /**
   * SameSite fidelity on a cross-site POST, the SAML and form_post case. A
   * None cookie goes, a Lax one must not: NVX has to send exactly what the
   * browser would, not more.
   */
  async samesite(req, res, url, t, u) {
    const c = cookiesOf(req);
    const host = req.headers.host;
    if (host === 'app.test' && url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return redirect(res, `https://idp.test/z/samesite/post?t=${t}&u=${u}`, [
        `zss_none=${ident(u)}; ${SEC}; SameSite=None`,
        `zss_lax=${ident(u)}; ${SEC}; SameSite=Lax`,
        `zss_strict=${ident(u)}; ${SEC}; SameSite=Strict`,
      ]);
    }
    if (host === 'idp.test') {
      record(t, 'post', req);
      return send(res, 200, page(`<form id="f" method="post" action="https://app.test/z/samesite/acs?t=${t}"><input name="x" value="1"></form><script>setTimeout(() => document.getElementById('f').submit(), 150)</script>`));
    }
    record(t, 'acs', req);
    const extra = ['zss_lax', 'zss_strict'].filter((k) => c[k]);
    const ok = Boolean(c.zss_none) && extra.length === 0;
    finish(t, ok, userOf(c.zss_none), ok ? '' : !c.zss_none ? 'SameSite=None cookie missing on a cross-site POST' : `over-sent on a cross-site POST: ${extra.join(',')}`);
    return send(res, 200, donePage(t));
  },

  /** Cookie prefix rules: an invalid __Host- cookie must be refused, a valid one kept. */
  async prefix(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return redirect(res, `/z/prefix/check?t=${t}`, [
        `__Host-zpx_ok=${ident(u)}; Path=/; Secure; SameSite=Lax`,
        `__Host-zpx_bad=${ident(u)}; Domain=app.test; Path=/; Secure; SameSite=Lax`,
        `__Secure-zpx_bad2=${ident(u)}; Path=/; SameSite=Lax`,
      ]);
    }
    record(t, 'check', req);
    const bad = ['__Host-zpx_bad', '__Secure-zpx_bad2'].filter((k) => c[k]);
    const ok = Boolean(c['__Host-zpx_ok']) && bad.length === 0;
    finish(t, ok, userOf(c['__Host-zpx_ok']), ok ? '' : !c['__Host-zpx_ok'] ? 'valid __Host- cookie missing' : `accepted an invalid prefixed cookie: ${bad.join(',')}`);
    return send(res, 200, donePage(t));
  },

  /**
   * Cross-site cookie sync by pixels, the Taobao to Tmall and Google to
   * YouTube shape: one sign-in sets cookies on several other sites, and the
   * session then has to be signed in on the last of them.
   */
  async xdomain(req, res, url, t, u) {
    const c = cookiesOf(req);
    const host = req.headers.host;
    if (host === 'a.test' && url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      const sites = ['b.test', 'c.test', 'd.test'];
      return send(res, 200, page(`${sites.map((h) => `<img src="https://${h}/z/xdomain/sync?u=${u}" width="1" height="1">`).join('')}<script>
        let left = ${sites.length};
        for (const i of document.images) i.onload = i.onerror = () => { if (--left === 0) location.href = 'https://d.test/z/xdomain/check?t=${t}'; };
      </script>`));
    }
    if (url.pathname.endsWith('/sync')) {
      return send(res, 200, Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'), {
        'set-cookie': [`zxd_sid=${ident(u)}; ${SEC}; HttpOnly; SameSite=None`],
      }, 'image/gif');
    }
    record(t, 'check', req);
    finish(t, Boolean(c.zxd_sid), userOf(c.zxd_sid), c.zxd_sid ? '' : 'cookie synced by a cross-site pixel missing on that site');
    return send(res, 200, donePage(t));
  },

  /** QR login: the page polls until the phone approves, and the approving poll sets the session. */
  async qrpoll(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return send(res, 200, page(`<script>
        const poll = () => fetch('/z/qrpoll/status?t=${t}&u=${u}', { credentials: 'include' }).then((r) => r.json()).then((s) => {
          if (s.approved) location.href = '/z/qrpoll/check?t=${t}';
          else setTimeout(poll, 150);
        });
        poll();
      </script>`), { 'set-cookie': [`zq_pre=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`] });
    }
    if (url.pathname.endsWith('/status')) {
      const run = runs.get(t) ?? { steps: [], result: null };
      run.polls = (run.polls ?? 0) + 1;
      runs.set(t, run);
      if (!c.zq_pre) {
        finish(t, false, '', 'QR status poll went without the pre-login cookie');
        return send(res, 200, '{"approved":false}', {}, 'application/json');
      }
      if (run.polls < 4) return send(res, 200, '{"approved":false}', {}, 'application/json');
      return send(res, 200, '{"approved":true}', { 'set-cookie': [`zq_sid=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`] }, 'application/json');
    }
    record(t, 'check', req);
    finish(t, Boolean(c.zq_sid), userOf(c.zq_sid), c.zq_sid ? '' : 'session set by the approving poll missing on the next page');
    return send(res, 200, donePage(t));
  },

  /** A prerendered page: speculation rules load the next page before it is shown. */
  async prerender(req, res, url, t, u) {
    const c = cookiesOf(req);
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return send(res, 200, page(`<a id="go" href="/z/prerender/target?t=${t}">next</a>
        <script type="speculationrules">{"prerender":[{"source":"list","urls":["/z/prerender/target?t=${t}"]}]}</script>
        <script>setTimeout(() => document.getElementById('go').click(), 1500)</script>`), {
        'set-cookie': [`zpr_sid=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`],
      });
    }
    record(t, 'target', req, { purpose: req.headers['sec-purpose'] ?? '' });
    if (c.zpr_sid) finish(t, true, userOf(c.zpr_sid));
    else finish(t, false, '', `prerendered page went without the session${req.headers['sec-purpose'] ? ' (prerender request)' : ''}`);
    return send(res, 200, donePage(t));
  },

  /**
   * Shared state between two sessions on one origin: BroadcastChannel, Web
   * Locks and localStorage. Alice and Bob run this at the same time; each must
   * hear nothing from the other, hold its own lock, and read back its own value.
   */
  async sharedstate(req, res, url, t, u) {
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return send(res, 200, page(`<script>
        const me = ${JSON.stringify(u)};
        const heard = [];
        const ch = new BroadcastChannel('zoo-auth');
        ch.onmessage = (e) => heard.push(e.data);
        localStorage.setItem('zoo-user', me);
        const lock = navigator.locks ? navigator.locks.request('zoo-leader', { ifAvailable: true }, (l) => {
          if (!l) return 'denied';
          return new Promise((r) => setTimeout(() => r('held'), 2500));
        }) : Promise.resolve('held');
        const tick = setInterval(() => ch.postMessage(me), 200);
        lock.then((got) => {
          clearInterval(tick);
          const others = heard.filter((h) => h !== me);
          const stored = localStorage.getItem('zoo-user');
          const q = new URLSearchParams({ t: '${t}', u: me, others: others.join(','), lock: got, stored });
          location.href = '/z/sharedstate/report?' + q;
        });
      </script>`));
    }
    record(t, 'report', req);
    const others = url.searchParams.get('others') ?? '';
    const lock = url.searchParams.get('lock') ?? '';
    const stored = url.searchParams.get('stored') ?? '';
    const problems = [];
    if (others) problems.push(`heard the other session on BroadcastChannel (${others})`);
    if (lock !== 'held') problems.push('Web Lock held by the other session');
    if (stored !== u) problems.push(`localStorage read "${stored}"`);
    finish(t, problems.length === 0, problems.length ? '' : u, problems.join('; '));
    return send(res, 200, donePage(t));
  },
  /**
   * Moodle and Okta: a service provider that, finding no session, starts a
   * fresh SAML sign-in every time, against a provider that is already signed
   * in and posts straight back. A missed session cookie is not an error page
   * here, it is another lap, and a fix that arrives late only adds laps.
   */
  async samlloop(req, res, url, t, u) {
    const c = cookiesOf(req);
    const host = req.headers.host;
    const run = runs.get(t) ?? { steps: [], result: null };
    if (host === 'app.test' && (url.pathname.endsWith('/start') || url.pathname.endsWith('/my'))) {
      record(t, url.pathname.endsWith('/start') ? 'start' : 'my', req);
      if (c.zsl_sess) {
        finish(t, (run.laps ?? 0) <= 2, userOf(c.zsl_sess), (run.laps ?? 0) <= 2 ? '' : `signed in only after ${run.laps} laps`);
        return send(res, 200, donePage(t));
      }
      run.laps = (run.laps ?? 0) + 1;
      runs.set(t, run);
      if (run.laps > 8) {
        finish(t, false, '', `looped ${run.laps} times between the service and the provider`);
        return send(res, 200, donePage(t));
      }
      const req2 = Math.random().toString(36).slice(2, 10);
      return redirect(res, `https://idp.test/z/samlloop/sso?t=${t}&u=${u}&r=${req2}`, [
        `zsl_state_${req2}=1; ${SEC}; HttpOnly; SameSite=None`,
      ]);
    }
    if (host === 'idp.test' && url.pathname.endsWith('/sso')) {
      record(t, 'sso', req);
      const r = url.searchParams.get('r');
      // Signed in already: the provider's own cookie, set on the first lap.
      return send(res, 200, page(`<form id="f" method="post" action="https://app.test/z/samlloop/acs?t=${t}&r=${r}">
        <input type="hidden" name="SAMLResponse" value="${u}"></form><script>document.getElementById('f').submit()</script>`), {
        'set-cookie': [`zsl_idp=${ident(u)}; ${SEC}; HttpOnly; SameSite=None`],
      });
    }
    if (url.pathname.endsWith('/acs')) {
      record(t, 'acs', req);
      const r = url.searchParams.get('r');
      const body = await readBody(req);
      if (!c[`zsl_state_${r}`]) {
        // State lost: start over, as an SP that cannot match the response does.
        return redirect(res, `/z/samlloop/my?t=${t}`, [], 303);
      }
      return redirect(res, `/z/samlloop/my?t=${t}`, [`zsl_sess=${ident(body.get('SAMLResponse') ?? '')}; ${SEC}; HttpOnly; SameSite=None`], 303);
    }
    return send(res, 404, page('no'));
  },
  /**
   * A load balancer that rotates a cookie on every response and accepts the
   * previous value, as Monash's does, through a six-hop redirect chain. The
   * session cookie is set once. NVX must not take a rotation for a miss: each
   * hop should be asked for once, or retries chase the rotation forever.
   */
  async rotating(req, res, url, t, u) {
    const c = cookiesOf(req);
    const n = Number(url.searchParams.get('n') ?? 0);
    const run = runs.get(t) ?? { steps: [], result: null };
    run.hits = run.hits ?? {};
    run.hits[n] = (run.hits[n] ?? 0) + 1;
    runs.set(t, run);
    const lb = `zlb=${Math.random().toString(36).slice(2)}; ${SEC}; SameSite=Lax`;
    if (url.pathname.endsWith('/start')) {
      record(t, 'start', req);
      return redirect(res, `/z/rotating/hop?t=${t}&n=1`, [lb, `zrt_sid=${ident(u)}; ${SEC}; HttpOnly; SameSite=Lax`]);
    }
    if (n < 6) {
      record(t, `hop${n}`, req);
      return redirect(res, `/z/rotating/hop?t=${t}&n=${n + 1}`, [lb]);
    }
    record(t, 'end', req);
    const repeats = Object.entries(run.hits).filter(([k, v]) => k !== '0' && v > 2).map(([k]) => k);
    const ok = Boolean(c.zrt_sid) && repeats.length === 0;
    finish(t, ok, userOf(c.zrt_sid), !c.zrt_sid ? 'session cookie lost in the chain' : repeats.length ? `hops asked for again and again: ${repeats.join(',')}` : '');
    return send(res, 200, donePage(t));
  },
};

/** The cookie that names the signed-in user, per scenario, for the isolation check. */
const IDENTITY = {
  redirect: ['app.test', 'zr_sid'],
  cookiecheck: ['accounts.app.test', 'zc_sid'],
  xhrnav: ['app.test', 'zx_sid'],
  xhrchain: ['app.test', 'zk_csrf'],
  oauth: ['app.test', 'zo_sid'],
  saml: ['app.test', 'zs_sid'],
  newtab: ['app.test', 'zn_csrf'],
  newtabget: ['app.test', 'zg_sid'],
  popup: ['app.test', 'zp_sid'],
  manyhosts: ['h60.app.test', 'zm_sid'],
  bigcookies: ['app.test', 'zb_sid'],
  worker: ['app.test', 'zw_sid'],
  jscookie: ['app.test', 'zj_sid'],
  meta: ['app.test', 'zme_sid'],
  post307: ['app.test', 'z7_sid'],
  xdomain: ['d.test', 'zxd_sid'],
  qrpoll: ['app.test', 'zq_sid'],
  prerender: ['app.test', 'zpr_sid'],
  samlloop: ['app.test', 'zsl_sess'],
  rotating: ['app.test', 'zrt_sid'],
};

// ---------------------------------------------------------------- server

/**
 * Every response waits this long first. A real site answers in tens of
 * milliseconds; this process answers in under one, which turns every race NVX
 * has into a loss. Zero is the stress test, the default is closer to life.
 */
const LATENCY_MS = Number(process.env.ZOO_LATENCY ?? 40);

const server = createHttps(certificate(), async (req, res) => {
  if (LATENCY_MS) await new Promise((r) => setTimeout(r, LATENCY_MS));
  const url = new URL(req.url, `https://${req.headers.host}`);
  const t = url.searchParams.get('t') ?? '';
  const u = url.searchParams.get('u') ?? '';
  try {
    if (url.pathname === '/z/whoami') {
      // Which user this session is now, by the scenario's identity cookie.
      const name = url.searchParams.get('c') ?? '';
      const c = cookiesOf(req);
      record(t, 'whoami', req);
      finish(t, true, userOf(c[name]), '');
      return send(res, 200, donePage(t));
    }
    if (url.pathname === '/favicon.ico') return send(res, 204, '');
    const name = url.pathname.split('/')[2];
    const handler = scenarios[name];
    if (!handler) return send(res, 404, page('no such scenario'));
    return await handler(req, res, url, t, u);
  } catch (e) {
    finish(t, false, '', `server error: ${e.message}`);
    return send(res, 500, page('error'));
  }
});

const control = createHttp((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/result') {
    const run = runs.get(url.searchParams.get('t') ?? '') ?? null;
    return send(res, 200, JSON.stringify(run), {}, 'application/json');
  }
  if (url.pathname === '/scenarios') {
    return send(res, 200, JSON.stringify({ names: Object.keys(scenarios), identity: IDENTITY }), {}, 'application/json');
  }
  if (url.pathname === '/health') return send(res, 200, 'ok', {}, 'text/plain');
  return send(res, 404, 'no', {}, 'text/plain');
});

server.listen(HTTPS_PORT, '127.0.0.1', () => {
  control.listen(CONTROL_PORT, '127.0.0.1', () => {
    console.log(`zoo: https ${HTTPS_PORT} (map *.test here), control http://127.0.0.1:${CONTROL_PORT}`);
  });
});
