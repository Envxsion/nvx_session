/**
 * ------------------------------------------------------------------
 *  Title    |  Minimal CDP client
 *  Ref      |  connect, loadUnpacked, browserEndpoint
 *  ID       |  tools
 * ------------------------------------------------------------------
 *  Purpose  |  A dependency-free Chrome DevTools Protocol client.
 *  Note     |  Node 22 ships a global WebSocket, so this needs no
 *           |  dependencies, which matters for a diagnostic that runs
 *           |  before the project has a toolchain.
 *  Author   |  Ojas Kekre, 20/08/2026
 * ------------------------------------------------------------------
 */

export async function connect(wsUrl, { timeout = 10_000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('cdp connect timeout')), timeout);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error('cdp connect failed'));
    };
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  };

  return {
    /** opts: { sessionId, timeout }. Live probes create tabs and wait on
     *  navigation, so they need far longer than the connect default. */
    send(method, params = {}, opts = {}) {
      const { sessionId, timeout: ms = timeout } = opts;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`${method} timed out after ${ms}ms`));
          }
        }, ms);
      });
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Side-load an unpacked extension and return its id.
 *  How      |  Chrome removed --load-extension in M137, so on current
 *           |  Chrome this is the only route. Older Chromium (Opera
 *           |  GX) may still honour the flag.
 *  Note     |  Identify the extension by id, not by "some service
 *           |  worker exists": component extensions have workers too.
 * ------------------------------------------------------------------
 */
export async function loadUnpacked(browser, path) {
  try {
    const r = await browser.send('Extensions.loadUnpacked', { path });
    return { id: r.id, via: 'cdp' };
  } catch (e) {
    return { id: null, via: null, error: e.message };
  }
}

export async function findExtensionWorker(browser, id) {
  const { targetInfos } = await browser.send('Target.getTargets');
  return targetInfos.find(
    (t) =>
      (t.type === 'service_worker' || t.type === 'background_page') &&
      t.url.includes(`chrome-extension://${id}/`)
  );
}

export async function browserEndpoint(port, { tries = 60, waitMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const v = await r.json();
        if (v.webSocketDebuggerUrl) return v;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`no devtools endpoint on port ${port}`);
}
