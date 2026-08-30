# NVX Session

Many accounts on one site, in one window, with a separate session per tab.

Sign into your work account in one tab and your personal account in the next.
Both stay signed in. Neither can see the other. No profile switching, no
incognito window that forgets everything the moment you close it, and no second
browser.

The concrete win: **no more Google opening a work link as your personal
account.** When you have several Google accounts signed in, Google silently
picks one as the default, and things you open without thinking go to it, which
is how work documents end up shared from the wrong address. Give each account
its own session and that stops: a session signed into only your work account
has work as the default there, because it is the only account in it. You never
pick wrong, because there is nothing to pick. See the guide chapter "Google, and
the default account trap".

---

## What it actually does

A browser keeps one cookie jar per profile. Every tab shares it, which is why
signing into a second account on the same site signs you out of the first.

NVX gives each session its own jar and decides, per request, which jar that
request is allowed to see. A tab belongs to a session, so a request from that
tab carries that session's cookies and nothing else. The browser's own jar is
held back from managed tabs entirely.

That is the whole idea. Everything below is consequences of it.

### What it is not

It is not anonymity. Sites still see your IP address, your browser, your
screen. Two sessions are separate from each other, not hidden from the site.

It is not a sandbox. A page in a session can still do everything a page can do.
The isolation is of identity, not of capability.

It is not a password manager. It keeps you signed in as somebody; it has no
idea who they are or what their password is.

---

## Installing it

There is no store listing yet, so it loads unpacked.

```
npm install
npm run build          # produces dist/
```

Then in the browser: open the extensions page, turn on developer mode, choose
"Load unpacked", and pick the `dist` folder.

Opera GX, Chrome, Edge and anything else on Chromium 128 or newer will run it.
There is also a manifest v2 build (`npm run build:mv2`, into `dist-mv2/`) for
browsers that still refuse v3. It isolates cookies identically and gives up
web storage isolation, which v2 cannot express. The popup tells you which
build you are on.

---

## The first run

Installed onto a browser you have been using for years, it opens one screen,
once. That screen reads what the profile is already carrying, ranks it by how
much it looks like a real signed-in account rather than a preference cookie,
and groups the sites that belong to one account together: a university login
covers the portal, the sign-in page and the learning system, and those arrive
as one proposal rather than three.

Tick what you want and press once. Each proposal becomes a session, its cookies
are copied in, and the tabs you already have open on those sites move into it
without reloading, because the cookies are identical.

Nothing happens before the button and nothing is destroyed by it. Adoption
copies, so the browser's own jar is exactly as it was afterwards, every
unmanaged tab keeps working, and undoing the whole thing is deleting a session.
**Not now** is a real answer.

It opens itself only on a genuine first install, and only once per profile, and
it is behind **Sessions &rsaquo; Set up from profile** whenever you want it
back. Grouping happens on a readable account name only, never on a shared
parent domain: merging two accounts into one session is the failure this whole
product exists to prevent, so when in doubt it offers more proposals rather than
fewer.

---

## The popup

The toolbar button is the whole product. It opens on **home**, which answers
the one question worth asking mid-task: who am I on this tab, and can I be
somebody else.

### Home

The top of it is the session this tab is in, by name, colour and shape. Under
that is every session you could move it to, and the last row makes a new one.

Pressing a row rebinds the tab and reloads it. Nothing is sent to the site
until you press something.

Three readings sit at the bottom.

- **isolation** says `clean` while every request in a managed tab carried
  exactly the cookies its session holds. If it does not, see
  [When isolation breaks](#when-isolation-breaks).
- **third parties** counts the trackers that were handed cookies, which is
  what makes two sessions correlatable by somebody watching from outside.
- **managed** is how many tabs are currently in a session.

### Sessions

Make one, name it, colour it, and pin the domains it is for.

**Pinning** a domain says this session is for this site. A pinned domain that
exactly one session claims binds new tabs automatically, which is what makes a
session feel like a container. A domain that two or more sessions claim is
ambiguous, so those tabs get asked about instead. See
[the picker](#when-you-get-asked).

**Delete** arms before it acts. The first press turns the row red and tells you
what the second one costs: how many cookies go, which site you are signed out
of, and how many tabs are left unmanaged. It gives up after six seconds, on
Escape, or if you click anywhere else. There is no undo once the second press
lands, which is why it says so.

Two ways in from what you already have, and they are different jobs.

**Set up from profile** reopens [the first run screen](#the-first-run): it reads
the whole profile and proposes one session per account it can recognise, several
at a time.

**Adopt existing** is the other half. One session, out of exactly the sites you
pick, with a name and a colour you choose. Cookies are copied rather than moved
in both, so the tabs you have open keep working exactly as they do now.

Every session also shows **also signs in at**, which is a list it learned
rather than one you typed. A session that signed in at an identity provider
picks it up automatically, and it is shown because a session covering somewhere
unexpected is worth being able to see rather than infer.

### Tabs

Every open tab, which session it is in, and a picker to change it. **Choose**
asks the question in the page, for a tab you want to re-pick deliberately.

### Trail

Requests with a blast radius: deletes, terminations, anything the catalog knows
can destroy something. Every session is watched. What happens next is the
session's **blast radius** setting, in its editor:

- **Off** interrupts nothing and still records, because a session nobody is
  guarding is the one you end up asking questions about later.
- **Warn** shows a card in the page. Nothing is stopped. This is the default.
- **Production** refuses the request outright, tells the page why, and lets you
  allow that one endpoint for five minutes.

### Parties

Who else was on the pages your sessions visited, and which site pulled them in.
Going to one site fires requests to a dozen others, and a tracker handed the
same identifier from all your sessions makes them one person to anyone counting.

Each session decides for itself whether third parties get cookies. New sessions
**block** by default. That is the one default here that changes what goes on
the wire without being asked, and the reasoning is that a session exists to be
separate. What it costs is an embedded third party you are signed into
appearing signed out, which is visible, one click to reverse, and listed here
with the evidence.

Blocking third parties does not break single sign-on. A top-level hop to an
identity provider is not a third-party request, and there is a test that holds
that true.

### Storage

Cookies are half an identity. Sites that keep their token in `localStorage` are
only isolated if the shim reached the page, so this says plainly which origins
are isolated and which are running through untouched. An honest "shared" here
is better than a claim on a settings screen that is not true.

Manifest v2 cannot do this at all and says so.

### Journal

What the extension did, kept on disk. Every tab that joined a session and which
of the four rules claimed it, every session made or deleted, every adoption,
every request the blast radius guard refused, and everything that failed.

The browser's console is erased by the extension going quiet, by the browser
closing and by a restart, which are the three things that happen between
noticing something and being asked what happened. So this outlives all three.

Nothing sensitive is in it, by construction rather than by care at the call
sites: no cookie values, no storage values, no request bodies, and no query
strings. Query strings are removed rather than filtered, because that is where
sign-in codes and password reset tokens travel and a filter is only a list of
the parameter names somebody thought of.

**Record** sets how much is kept. *Decisions* is the default and is every time a
tab, a session or a cookie moved. *Everything* adds the routine traffic and is
what a bug report wants. **Export** writes the whole thing out as a text file.

### Guide

Every feature, one chapter each, in the fewest words that are still true, with
diagrams. Chapters open one at a time in the popup, or the whole thing takes a
tab at full width. It ends on what the product does not do, which is not an
appendix: a guide listing only capabilities is why people conclude a tool is
broken when it is working exactly as designed.

### Settings

**Fingerprint** is the posture, and it applies to the whole profile.

- **Mirror** is the default and fabricates nothing. Your real machine, unchanged.
  This is a real answer rather than the absence of one: several of your own
  accounts sharing one device is unremarkable, and what actually raises a flag is
  incoherence. Randomising makes you weirder, not safer.
- **Standardize** puts every session on one shared, normalised machine. It lowers
  how identifiable you are across the whole population running it, and that only
  works because everybody lands in the same place rather than each getting their
  own private disguise.
- **Persona** gives each session its own machine: its own canvas, WebGL and audio
  noise, its own graphics model within the vendor your machine actually has, and
  its own core and memory counts. Stable for as long as the session exists and
  different on every site it visits, so two sites comparing notes cannot match one
  session up between them. This is the posture that stops two of your accounts
  being linked by the machine they run on, which is the one thing separate cookie
  jars cannot do on their own.

A persona is a Standardize machine with a different fingerprint rather than a
different computer, and the difference matters. The operating system is
corroborated by client hint negotiation, the user agent by your own request
headers, the timezone and locale by your address, and the screen by a media
query the browser answers where no extension can reach. Varying any of those per
session produces a machine that contradicts itself, which is louder than a
machine that is merely common. So what moves is what nothing else can check.

The first document of a brand new tab is the one case a per-session posture
cannot be told about in advance, because a session belongs to a tab and the
patch is registered by address. It resolves late instead, on the first read of a
masked surface rather than when it installs, and the answer lands while the
document is still on the wire. Where it has not, the page reads the Standardize
bucket and never your real machine: Persona never degrades below the posture
underneath it.

Under the control is a list of what is masked and what is not, and it is worth
reading. Five surfaces are masked today: the canvas, WebGL, audio, the navigator
and your installed speech voices. That last one is worth a sentence: the voices
your machine has installed say a great deal about which operating system it is
and which language packs are on it, so voices for a language your browser never
claims to read are hidden, since those are the part nothing else on the page
would have predicted. Nothing is invented and your default voice is never hidden,
so anything that speaks still speaks.

Everything else in the fingerprint is your real machine, and several
entries are named as things that cannot close at this level rather than as things
not written yet. Fonts need rasterisation, which no content script can reach.
Client hint negotiation is per origin and no declarative rule can model it, which
is why changing the claimed operating system needs the debugger tier. WebGL
shader precision changes what a page compiles, so normalising it could change
what renders rather than only what is measured. The screen size, the pixel ratio
and touch capability are all readable from a stylesheet, which the browser
evaluates somewhere no extension can reach, so a masked screen would be
contradicted by the page's own media queries. That is worse than leaving it real,
because it is a contradiction the mask would be making itself. And your list of
cameras and microphones is one the browser already blanks out until you grant
permission, so all that is left is whether you own a camera at all, which cannot
be hidden without breaking the button that uses it.

Standardize has one bucket per operating system rather than one bucket overall.
Claiming a different OS than the machine actually runs is the incoherence the
whole design exists to avoid, and it is what the validator refuses. Three buckets
is still a bucket: what matters is that everybody on the same OS lands in the
same place.

The graphics card works the same way and for the same reason: the bucket keeps
the vendor your machine actually has and normalises the model. Your GPU vendor is
named by WebGPU, which nothing here fakes, and it shapes the WebGL capability
numbers, the extension list and shader precision, so claiming a different one
would be contradicted by any of them. The model is where nearly all of the
identifying detail is anyway. A combination there is no confident entry for is
left alone rather than guessed at.

What the mask does: a sparse, seeded subset of pixels has its lowest bit
rewritten, on the 2D canvas and on WebGL readPixels alike, and WebGL reports the
bucket's graphics card rather than yours. Audio takes the same treatment in the
mantissa of the samples. The same drawing always produces the same result,
forever, because anything else is caught by reading the canvas twice and
comparing. It reaches inside Workers too, and if it cannot, it takes itself back
off, because a page whose worker and main thread disagree about one canvas is in
a state no real machine produces and that is worse than not masking at all.

The navigator is the one that works differently, and it is the only surface here
that is normalised rather than invented. A Chromium user agent is a frozen string
plus a browser token, so Opera's ` OPR/134.0.0.0` comes off and what is left is
plain Chrome exactly, at the real engine version. The brand list behind
`Sec-CH-UA` gets the same treatment: the greased entry the browser generated is
kept as it is and only the name is replaced. Nothing is written down, so nothing
goes stale, which matters more here than anywhere else: a persona carrying a
version number still claims it a year later, and a browser claiming a version
whose features it has and whose absent features it lacks is a louder signal than
any single fingerprint.

That surface has a half that is not in the page. `navigator.userAgent` and the
`User-Agent` header are two reports of one fact, and rewriting only the one the
page can see would hand every server the exact contradiction this is meant to
prevent, so the request headers are rewritten to match on the same hosts, from
the same function, and the suite checks them against each other rather than
against a value typed into a test twice. If the headers cannot be installed, the
mask is not registered at all.

Two ways a session can mark its tabs.

- **Mark tab icons** stamps the session colour onto the favicon of every tab it
  owns. Works everywhere. On by default.
- **Group tabs natively** also gathers a session into a browser tab group. Off
  by default, because it rearranges tabs you arranged, and in Opera it would
  fight the Tab Islands you already made. Not every browser has the API; where
  it is missing the control says so instead of failing quietly.

---

## When you get asked

Most of the browser is not ours and is left alone. A tab is only asked about
when the answer is genuinely unknown: you are navigating to a domain that two
or more sessions cover, and picking either one for you would sign you in as
somebody you did not ask for.

When that happens the navigation is **held**. The tab shows a picker instead of
the site, and the site is not contacted at all until you answer. That matters
more than it sounds: a federated site redirects to its identity provider within
a second, and whatever jar the tab was holding while it waited is the account
the sign-in completes as. Asking over the top of the page does not work, because
the redirect destroys the question before you can answer it.

You can answer with a session, or with **just this once**, which leaves the tab
unmanaged on that domain and stops asking.

Closing a tab is remembered, so reopening it with Ctrl+Shift+T puts it back in
the session it was in and says so. One close earns one reopen. The visit after
that is a fresh question, because a memory that keeps answering is a memory that
eventually answers wrongly.

---

## When isolation breaks

The isolation reading on home counts requests where a managed tab carried a
cookie its session does not own. That means something outside NVX wrote to that
jar, and it is the one failure the whole design exists to prevent, so it is not
quiet about it: the home view takes an alarm across the top and the toolbar
button carries a badge.

Only that kind of mismatch reaches the toolbar. Two others are counted and
deliberately not badged:

- **stale** is a cookie that rotated while a request was in flight. It happens
  at least once per hop of every ordinary sign-in.
- **missing** is usually a rule that had not landed yet.

Showing the total taught a previous reader to diagnose a loop that was not
there, and a badge that lights up during a normal login is worse than no badge.

**Recount** does not dismiss anything. It restarts the measurement, which is
the only honest way to clear a count.

---

## Diagnostics

At the bottom of the popup, or Alt+Shift+S. It is the one surface that stayed a
full page, because every suite in it opens real tabs to measure against and a
popup closes the moment it loses focus.

Most of the suites need the test origin running:

```
npm run fixture
```

- **Isolation** creates two throwaway sessions, proves they cannot see each
  other, and removes them again.
- **Restore** proves bindings survive the worker being shut down and restarted.
- **Mark** proves the favicon channel, including that a page cannot forge one.
- **Storage** proves web storage isolation on a real page.
- **Mask** proves the fingerprint: that it changes, that it never moves again,
  that it reaches inside a Worker, that the browser it names on the wire is the
  one it names in the page, and that it fails closed when it cannot.
- **Guard** proves the blast radius levels do what they say.

**Copy report** puts the whole run on the clipboard as JSON, which is the right
thing to attach to a bug. So does **Export** in the Journal view, and the two
answer different questions: the report is what a suite measured just now, and
the journal is what actually happened to your tabs over the last few days.

---

## When something is wrong

**A site asks for a password even though that session is signed in elsewhere on
the same site.** Cookies set without a `Domain` attribute belong to one host
only, which is the browser's rule and not ours: being signed into
`staff.example.edu` genuinely does not sign you into `learning.example.edu`
unless the site said so. If the session holds the identity provider's cookie
the second site should bounce through it silently. Check **also signs in at** on
that session; if the provider is not listed, the session has not signed in
through it yet.

**A tab joined the wrong session without asking.** It was inherited from
somewhere: a link opened from a tab in that session, or a reopen memory. Move it
from the popup, and the move sticks.

**A tab keeps reloading.** Check the isolation reading first. If it says
`clean`, the loop is between the site and its identity provider rather than
anything here, and the usual cause is a half-signed-in state: the session holds
part of a sign-in chain and not the rest. Deleting that session and signing in
again from scratch resolves it, and if it does not, run the Isolation suite and
attach the report.

**Nothing is isolated at all and there is no error.** Look at the worker log for
`could not compile rules`. A host the compiler cannot make sense of is skipped
and reported rather than taking the session down with it, but a skipped host is
a host whose cookies are not being carried, which looks exactly like a site
behaving normally.

**Sessions disappeared after restarting the browser.** They should not. Session
cookies inside them are dropped on a browser restart, which is deliberate and
matches what the browser does to its own: a cookie with no expiry is supposed to
die with the browser, and one that outlives it sends a site a session token it
already threw away, which is its own infinite redirect.

---

## Development

```
npm test               # unit
npm run typecheck
npm run build          # dist/,     manifest v3
npm run build:mv2      # dist-mv2/, manifest v2
npm run check          # every shipped script parses
npm run fixture        # the test origin on :8787
npm run e2e            # the real browser, against the fixture
node tools/dev.mjs opera         # a browser with it loaded and some state in it
node tools/shot.mjs opera out.png --seed --popup [--view=tabs]
```

`tools/` holds the dev helpers the commands above use.

---

## Open core

NVX Session is open core. This repository is the free product under GPL-3.0, and
it is complete on its own: it builds and runs the free extension with no other
dependency.

The paid Pro features live in a separate private repository, mounted here as a
git submodule at `src/pro/`:

- cross device sync of the session structure, end to end encrypted;
- per session IndexedDB and Cache isolation;
- a coherent per session fingerprint persona;
- exact per request cookie control through the debugger.

That folder is empty in a normal clone. The build detects its absence and
produces the free product, so `npm install && npm run build` works with no
submodule and no extra setup. Nothing in the free build depends on the Pro code,
and the free build ships none of it.

## Licence

GPL-3.0. See `LICENSE`. The copyleft is deliberate: a distributed modification of
the free product has to carry its own source too.
