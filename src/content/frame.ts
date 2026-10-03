/**
 * ------------------------------------------------------------------
 *  Title    |  Frame agent
 *  Ref      |  agent.ts (top frame), shim.ts, frame.hello, nvx.jar
 *  ID       |  M4 (storage shim, subframes)
 * ------------------------------------------------------------------
 *  Purpose  |  Tell the storage shim in a subframe which session its
 *           |  tab is in, and carry its cookie traffic.
 *  How      |  The top frame's agent owns the port, the icon and the
 *           |  chooser; a subframe needs none of that, only the
 *           |  handshake. So this is that handshake and nothing else,
 *           |  over one-shot messages the worker answers from the
 *           |  sender's own tab and frame address.
 *  Why      |  Without it a cross-origin frame never learned its
 *           |  session, fell back to the origin's shared storage after
 *           |  two seconds, and read the browser's own cookie jar.
 *  Note     |  A classic script: no imports or exports.
 *  Author   |  Ojas Kekre, 02/10/2026
 * ------------------------------------------------------------------
 */

(function nvxFrameAgent(): void {
  // The top frame has the full agent; this one is only for frames inside it.
  if (window.top === window) return;
  const scope = globalThis as unknown as { __nvxFrame?: boolean };
  if (scope.__nvxFrame) return;
  scope.__nvxFrame = true;

  const ANNOUNCE = '__nvx.storage.ready';
  const rawDispatch = EventTarget.prototype.dispatchEvent;
  const rawListen = EventTarget.prototype.addEventListener;

  let channel = '';
  let answer: Record<string, unknown> | null = null;

  function toShim(kind: string, detail: Record<string, unknown> = {}): void {
    if (!channel) return;
    try {
      rawDispatch.call(document, new CustomEvent(`${channel}.${kind}`, { detail: JSON.stringify(detail) }));
    } catch {
      /* the document went away */
    }
  }

  /** The session's cookies this frame's own host can see, so the page never receives another site's. */
  function ownCookies(list: unknown): Record<string, unknown>[] {
    if (!Array.isArray(list)) return [];
    const host = location.hostname;
    return list.filter((c): c is Record<string, unknown> => {
      if (!c || typeof c !== 'object') return false;
      const d = (c as { d?: unknown }).d;
      if (typeof d !== 'string' || !d) return false;
      return (c as { h?: unknown }).h === true ? host === d : host === d || host.endsWith(`.${d}`);
    });
  }

  // First announcement only: the shim speaks before any page script exists, so
  // a later one can only be a page trying to open a channel of its own.
  rawListen.call(document, ANNOUNCE, (e: Event) => {
    if (channel) return;
    try {
      const raw = JSON.parse(String((e as CustomEvent).detail ?? '{}')) as { channel?: unknown };
      if (typeof raw.channel !== 'string' || !raw.channel) return;
      channel = raw.channel;
    } catch {
      return;
    }

    rawListen.call(document, `${channel}.cookie`, (ev: Event) => {
      try {
        const raw = JSON.parse(String((ev as CustomEvent).detail ?? '{}')) as { value?: unknown };
        if (typeof raw.value !== 'string' || !raw.value) return;
        // No address is sent: the worker uses the one the browser stamps on the
        // message, so a write can only ever apply to this frame's own site.
        void chrome.runtime.sendMessage({ kind: 'frame.cookie', value: raw.value }).catch(() => undefined);
      } catch {
        /* malformed, and the shim is the only thing that sends these */
      }
    });

    // Synchronous, so the shim holds its writes rather than deciding it is on an
    // unmanaged page.
    toShim('wait');
    if (answer) toShim('commit', answer);
  });

  void chrome.runtime
    .sendMessage({ kind: 'frame.hello' })
    .then((reply: unknown) => {
      if (!reply || typeof reply !== 'object') return;
      const r = reply as { sid?: unknown; persona?: unknown; idb?: unknown; cookies?: unknown };
      answer = {
        sid: typeof r.sid === 'string' ? r.sid : null,
        fork: false,
        persona: typeof r.persona === 'string' ? r.persona : null,
        idb: r.idb === true,
        cookies: ownCookies(r.cookies),
      };
      toShim('commit', answer);
    })
    .catch(() => {
      /* no worker to answer; the shim keeps writes in memory rather than leak them */
    });

  // Cookies the session gained or lost elsewhere, so this frame's reads stay
  // current without a reload.
  chrome.runtime.onMessage.addListener((msg: unknown) => {
    if (!msg || typeof msg !== 'object' || (msg as { kind?: unknown }).kind !== 'nvx.jar') return;
    const cookies = ownCookies((msg as { cookies?: unknown }).cookies);
    if (cookies.length) toShim('jar', { cookies });
  });
})();
