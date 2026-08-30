# NVX Capability Probe

M0 of the plan in `DESIGN.html`. Nothing in the product gets built until this
has run on both browsers, because three load-bearing assumptions are unverified
and a desk check cannot settle any of them.

Presence checks are not enough. An API can exist on an object and still no-op,
reject the one option that matters, or silently ignore a condition. Every probe
here calls the real API with the exact shape NVX Session depends on.

## Run it

```
node tools/fixture/server.mjs
```

Leave that running. Then load the extension unpacked:

- **Chrome** `chrome://extensions`, enable Developer mode, Load unpacked, select
  `probes/capability`
- **Opera GX** `opera://extensions`, enable Developer mode, Load unpacked, same
  folder. For the MV2 run, rename `manifest.mv2.json` over `manifest.json` in a
  copy of the folder and load that separately.

Click the toolbar button. Run **API surface** first, then **Functional**.
Then **Copy report** and paste the JSON back.

## What each functional test decides

| Test | Question | If it fails |
| --- | --- | --- |
| `cookieSubstitution` | Does `operation:"set"` on the `Cookie` header actually replace what the browser would send, scoped to one tab? | The core bet in §02 is wrong and the whole architecture changes. This is the one that matters most. |
| `stripVersusObserve` | Does a non-blocking observer still see `Set-Cookie` when a rule removes it? | Spike 1. Capture moves to the reconcile fallback: let cookies land, harvest and delete via `cookies.onChanged`. Correctness is unaffected, hygiene degrades. |
| `injectionOrder` | Does the ISOLATED world run before MAIN at `document_start`, reliably? | Spike 3. Delivery path B in §04 is dead, and per-tab posture on a shared origin needs T2 unconditionally. |
| `serviceWorkerAttribution` | Do service worker requests really carry `tabId -1`? | Expected to fail on MV3. A pass would mean the §07 gap does not apply and mitigation (a) is unnecessary. |

`injectionOrder` runs five times. Ordering that holds once and not five times is
worse than ordering that never holds, because it produces a bug that only
appears under load.

## What the MV2 run decides

One row: `webRequest.blocking`. If Opera GX accepts a blocking listener, the
second `netfilter` backend in §09 is real, and on your main browser both the
service worker gap and the rule flush race disappear. If it does not, the MV3
path is the only path and §09 loses its second column.

## Notes

- The probe requests broad permissions on purpose. It is a diagnostic and is
  never distributed.
- Fonts fall back to system faces here. The product bundles subset woff2 files;
  the probe does not, so it can load with no build step.
- `runtime.dynamicUrl` reports **fail** when the extension id appears in a
  web-accessible resource URL, because that makes the extension probeable from
  any page. It is testing `use_dynamic_url`, not the probe itself.
