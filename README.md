# NVX Session

**Every account you own, signed in at the same time, in one window — a separate login per tab.**

Sign into work in one tab and personal in the next. Both stay logged in. Neither
can see the other. No profile switching, no incognito window that forgets you the
second you close it, no second browser eating half your RAM.

---

## You have already had this bug

You are signed into your work Google and your personal Google. A coworker sends a
calendar link. You click it without thinking.

It opens as your *personal* account.

Now you are requesting access to a document you already own, or worse, you reply
from the wrong address and it is out before you notice. Google picked a default
for you, and it picked wrong, because it has no way to know which "you" is driving
this tab.

It is not just Google. It is the client Slack and your own Slack. The staging AWS
console and production. Two GitHub accounts. A test user and an admin user for the
very app you are building. The browser was designed for one person with one life,
and you are neither.

The usual fixes all cost something:

- **A second Chrome profile** — a whole separate window, 250 MB, and you are
  alt-tabbing between two browsers all day.
- **Incognito** — forgets everything the moment you close it, and gives you
  exactly *one* extra identity, not five.
- **Signing out and back in** — the entire reason you are reading this.

NVX takes a different bet: keep everything in the one window you already work in,
and make the tab — not the browser — decide who you are.

---

## How it stacks up

Plain version, no asterisks-you-need-a-lawyer-for:

| Tool | What it is | Stays in your browser | A login per tab | Controls fingerprint | RAM per account |
|---|---|:--:|:--:|:--:|:--:|
| **NVX Session** | Extension, swaps cookies per request | **Yes** | **Yes** | **Yes** \* | **~0 MB** |
| Chrome / Edge profiles | Built-in, one window each | Separate window | No | No | ~250 MB |
| Incognito | Built-in, temporary | Yes, but amnesiac | One extra only | No | ~150 MB |
| Firefox Containers | Engine-level, Firefox only | Firefox only | Yes | No | ~0 MB |
| SessionBox & clones | Extension, cookie swapping | Yes | Yes, but fragile | No | low |
| Anti-detect browsers | A patched browser per profile | No, you leave | Yes | Strongest | 300–800 MB |

\* Free ships a shared, normalised machine profile. Per-session personas — a
distinct, self-consistent fingerprint for each login — are the paid tier.

The market splits cleanly in two: session tools that ignore your fingerprint, and
anti-detect browsers that make you abandon the browser you actually work in. NVX
is built to sit in the gap nobody else covers — many identities, in your real
browser, with the fingerprint under your control.

Where it honestly loses: **Firefox Multi-Account Containers isolates deeper and is
free.** If you live in Firefox, you may not need this. NVX exists because most of
us live in a Chromium browser, where that engine-level door is locked.

---

## What it actually does

A browser keeps one cookie jar per profile. Every tab drinks from it, which is
exactly why signing into a second account on a site signs you out of the first.

NVX gives each session its own jar, and decides — for every single request — which
jar that request is allowed to see. A tab belongs to a session, so its requests
carry that session's cookies and nothing else. Your browser's own jar is held back
from managed tabs entirely.

That is the whole idea. Everything below is a consequence of it.

### What it is not

- **Not anonymity.** Sites still see your IP, your browser, your screen. Two
  sessions are separate from *each other*, not hidden from the *site*.
- **Not a sandbox.** A page in a session can do everything a page can do. What is
  isolated is identity, not capability.
- **Not a password manager.** It keeps you signed in as somebody. It has no idea
  who they are or what their password is.

---

## The first run, in one screen

Install it onto a browser you have used for years and it opens exactly one screen,
exactly once.

It reads what your profile is already carrying, ranks it by how much each thing
looks like a real signed-in account rather than a leftover preference cookie, and
groups the sites that belong to one account together. A university login covering
the portal, the sign-in page and the learning system arrives as *one* proposal,
not three.

Tick what you want. Press once. Each proposal becomes a session, its cookies are
copied in, and the tabs you already have open on those sites slide into it without
reloading — because the cookies are identical.

Nothing happens before that button, and nothing is destroyed by it. Adoption
**copies**; your browser's own jar is exactly as it was afterward, every unmanaged
tab keeps working, and undoing the whole thing is deleting a session. **Not now**
is a real answer, and it is behind *Sessions › Set up from profile* whenever you
want it back.

When it is unsure whether two logins are one account or two, it offers *more*
sessions rather than fewer. Merging two accounts into one session is the single
failure this entire product exists to prevent.

---

## Living in it

The toolbar button is the whole product. It opens on **home**, which answers the
one question worth asking mid-task: *who am I on this tab, and can I be somebody
else?*

- **Home** — the session this tab is in, and every session you could move it to.
  Press a row, the tab rebinds and reloads as that identity. Nothing reaches the
  site until you press. Three honest readings sit at the bottom: whether isolation
  is `clean`, how many trackers got cookies, how many tabs are managed.
- **Sessions** — make one, name it, colour it, and *pin* the domains it is for. A
  domain only one session claims binds new tabs automatically. A domain two
  sessions claim gets *asked about* instead of guessed.
- **Tabs** — every open tab, which session it is in, and a picker to move it.
- **Trail** — requests with a blast radius: deletes, terminations, anything that
  can destroy something. Each session chooses what to do — *warn* in the page, or
  *refuse* the request outright and let you allow that one endpoint for five
  minutes.
- **Parties** — who else was on the pages your sessions visited. New sessions
  **block** third-party cookies by default, because a session exists to be
  separate. (This does not break single sign-on — there is a test that holds that
  true.)
- **Storage** — cookies are only half an identity. Sites that keep their token in
  `localStorage` need the storage shim to reach the page, so this says plainly
  which origins are isolated and which are running through untouched. An honest
  "shared" beats a settings screen that lies.
- **Journal** — what the extension did, kept on disk, so it outlives the console
  being wiped by a restart. No cookie values, no request bodies, no query strings
  — query strings are *removed*, not filtered, because that is where sign-in codes
  and reset tokens travel.
- **Settings** — the **fingerprint** posture: *Mirror* (your real machine,
  unchanged — the default, because incoherence is louder than being common),
  *Standardize* (everyone on one shared, normalised machine), or *Persona* (a
  distinct, self-consistent machine per session — the paid tier).

When a navigation genuinely can't be resolved — you are heading to a domain two
sessions both cover — the tab is **held**. It shows a picker instead of the site,
and the site is not contacted at all until you answer. That matters: a federated
login redirects to its identity provider within a second, and asking *over* the
page loses the race every time.

---

## Installing it

There is no store listing yet, so it loads unpacked.

```
npm install
npm run build          # produces dist/
```

Then, in the browser: open the extensions page, turn on developer mode, choose
**Load unpacked**, and pick the `dist` folder.

Anything on **Chromium 128 or newer** runs it — Chrome, Edge, Opera, Opera GX,
Brave. There is also a Manifest V2 build (`npm run build:mv2`, into `dist-mv2/`)
for browsers that still refuse V3. It isolates cookies identically and gives up
web-storage isolation, which V2 cannot express. The popup tells you which build
you are on.

---

## Under the hood, briefly

The interesting move is **request-side substitution**. Most session extensions
swap the browser's stored cookies in and out as you switch — which races the
moment two tabs are busy at once. NVX never touches the stored jar. It rewrites the
`Cookie` header on the request as it leaves and captures `Set-Cookie` on the way
back, keeping each session's cookies in its own vault and out of the profile jar
entirely. Managed tabs and unmanaged tabs share the window and never see each
other's identity.

The full design — every rule, every edge case, every honest limit — lives in the
Pro repository's `DESIGN.html`. This README is the short version.

---

## Development

```
npm test               # unit tests
npm run typecheck
npm run build          # dist/,     Manifest V3
npm run build:mv2      # dist-mv2/, Manifest V2
npm run check          # every shipped script parses
npm run fixture        # the test origin on :8787
npm run e2e            # a real browser, against the fixture
```

`tools/` holds the dev helpers those commands use.

---

## Open core

NVX Session is **open core**. This repository is the free product under GPL-3.0,
and it is complete on its own — it builds and runs the free extension with no other
dependency.

The paid Pro features live in a separate private repository, mounted here as a git
submodule at `src/pro/`:

- cross-device sync of your session structure, end-to-end encrypted;
- per-session IndexedDB and Cache isolation;
- a coherent per-session fingerprint persona;
- exact per-request cookie control through the debugger.

That folder is **empty in a normal clone**. The build detects its absence and
produces the free product, so `npm install && npm run build` works with no
submodule and no extra setup. Nothing in the free build depends on the Pro code,
and the free build ships none of it.

---

## Licence

GPL-3.0 — see [`LICENSE`](LICENSE). The copyleft is deliberate: anyone who
distributes a modified build of the free product has to carry its source too.
