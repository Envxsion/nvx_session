/**
 * The guide, as data.
 *
 * One source, two presentations. The popup renders it as a stack of collapsible
 * chapters at 400 pixels; `guide.html` renders the same array full width with
 * the figures at full size. Writing it twice is how a tutorial comes to describe
 * a product that no longer exists, and a wrong guide is worse than none: it is a
 * confident answer.
 *
 * Every chapter answers three questions in the same order, because that is the
 * order somebody actually has them. What is this. Why would I care. What do I
 * press. Nothing here explains an implementation; if a sentence could only be
 * written by somebody who has read the source, it belongs in DESIGN.html.
 *
 * The figures are inline SVG. No external asset can load under the extension's
 * content security policy, and a diagram is worth more here than a screenshot,
 * which would go stale the first time a button moved.
 *
 * `LIMITS` at the bottom is not an appendix. Every one of those is something the
 * product cannot do, and a guide that lists only capabilities is the reason
 * people conclude a tool is broken when it is working exactly as designed.
 */

/* Figures. Drawn small and scaled by the container, so one definition serves
   the 400 pixel popup and the full page. */

const FIG = {
  /** Two tabs, two jars, one window. The whole product in one picture. */
  jars: `
<svg viewBox="0 0 320 132" role="img" aria-label="Two tabs in one window, each with its own cookie jar">
  <rect x="4" y="4" width="312" height="124" rx="2" class="f-frame"/>
  <text x="14" y="22" class="f-label">ONE WINDOW</text>
  <g>
    <rect x="16" y="34" width="130" height="30" rx="2" class="f-tab f-a"/>
    <text x="26" y="53" class="f-text">tab: work</text>
    <path d="M81 64 L81 82" class="f-link f-a-s"/>
    <rect x="16" y="82" width="130" height="34" rx="2" class="f-jar f-a"/>
    <text x="26" y="103" class="f-text">jar: work only</text>
  </g>
  <g>
    <rect x="174" y="34" width="130" height="30" rx="2" class="f-tab f-b"/>
    <text x="184" y="53" class="f-text">tab: personal</text>
    <path d="M239 64 L239 82" class="f-link f-b-s"/>
    <rect x="174" y="82" width="130" height="34" rx="2" class="f-jar f-b"/>
    <text x="184" y="103" class="f-text">jar: personal only</text>
  </g>
  <path d="M150 70 L170 70" class="f-cut"/>
  <path d="M154 62 L166 78 M166 62 L154 78" class="f-cut"/>
</svg>`,

  /** What happens when a tab navigates somewhere. The four answers. */
  route: `
<svg viewBox="0 0 320 186" role="img" aria-label="How a new tab is assigned to a session">
  <rect x="90" y="4" width="140" height="26" rx="2" class="f-tab"/>
  <text x="160" y="21" class="f-text f-mid">a tab opens a site</text>
  <path d="M160 30 L160 44" class="f-link"/>

  <rect x="34" y="44" width="252" height="26" rx="2" class="f-step"/>
  <text x="46" y="61" class="f-text">was a tab just closed here?</text>
  <text x="272" y="61" class="f-text f-yes f-end">yes</text>
  <path d="M286 57 L302 57 L302 176 L292 176" class="f-link f-yes-s"/>
  <path d="M160 70 L160 82" class="f-link"/>

  <rect x="34" y="82" width="252" height="26" rx="2" class="f-step"/>
  <text x="46" y="99" class="f-text">does exactly one session pin it?</text>
  <text x="272" y="99" class="f-text f-yes f-end">yes</text>
  <path d="M286 95 L296 95 L296 176 L292 176" class="f-link f-yes-s"/>
  <path d="M160 108 L160 120" class="f-link"/>

  <rect x="34" y="120" width="252" height="26" rx="2" class="f-step"/>
  <text x="46" y="137" class="f-text">do two or more cover it?</text>
  <text x="272" y="137" class="f-text f-ask f-end">ask</text>
  <path d="M160 146 L160 160" class="f-link"/>

  <rect x="34" y="160" width="130" height="22" rx="2" class="f-out f-plain"/>
  <text x="99" y="175" class="f-text f-mid">left alone</text>
  <rect x="182" y="160" width="110" height="22" rx="2" class="f-out f-bound"/>
  <text x="237" y="175" class="f-text f-mid">joins it</text>
</svg>`,

  /** The profile jar, lifted into sessions, without being emptied. */
  adopt: `
<svg viewBox="0 0 320 140" role="img" aria-label="Cookies copied from the profile into sessions">
  <rect x="10" y="42" width="112" height="56" rx="2" class="f-jar f-plain"/>
  <text x="66" y="66" class="f-text f-mid">the browser's</text>
  <text x="66" y="82" class="f-text f-mid">own jar</text>
  <text x="66" y="118" class="f-label f-mid">UNCHANGED</text>

  <path d="M126 60 L182 40" class="f-link f-a-s f-arrow"/>
  <path d="M126 80 L182 100" class="f-link f-b-s f-arrow"/>
  <text x="154" y="76" class="f-label f-mid f-copy">COPIED</text>

  <rect x="186" y="26" width="120" height="30" rx="2" class="f-jar f-a"/>
  <text x="246" y="46" class="f-text f-mid">work</text>
  <rect x="186" y="86" width="120" height="30" rx="2" class="f-jar f-b"/>
  <text x="246" y="106" class="f-text f-mid">personal</text>
</svg>`,

  /** One origin's storage, split by session, with the site's own left alone. */
  storage: `
<svg viewBox="0 0 320 128" role="img" aria-label="Local storage keys separated per session">
  <text x="14" y="20" class="f-label">site.com localStorage</text>
  <rect x="10" y="28" width="300" height="26" rx="2" class="f-row f-a"/>
  <text x="22" y="45" class="f-text">work sees</text>
  <text x="300" y="45" class="f-text f-end f-quiet">token = ...</text>
  <rect x="10" y="60" width="300" height="26" rx="2" class="f-row f-b"/>
  <text x="22" y="77" class="f-text">personal sees</text>
  <text x="300" y="77" class="f-text f-end f-quiet">token = ...</text>
  <rect x="10" y="92" width="300" height="26" rx="2" class="f-row f-plain"/>
  <text x="22" y="109" class="f-text">an unmanaged tab sees</text>
  <text x="300" y="109" class="f-text f-end f-quiet">the site's own</text>
</svg>`,

  /** The three postures, as three answers to one question. */
  posture: `
<svg viewBox="0 0 320 150" role="img" aria-label="Mirror, Standardize and Persona">
  <rect x="10" y="10" width="300" height="38" rx="2" class="f-row f-plain"/>
  <text x="22" y="27" class="f-text">Mirror</text>
  <text x="22" y="42" class="f-text f-quiet">every session shows your real machine</text>
  <rect x="10" y="56" width="300" height="38" rx="2" class="f-row f-a"/>
  <text x="22" y="73" class="f-text">Standardize</text>
  <text x="22" y="88" class="f-text f-quiet">every session shows one ordinary machine</text>
  <rect x="10" y="102" width="300" height="38" rx="2" class="f-row f-b"/>
  <text x="22" y="119" class="f-text">Persona</text>
  <text x="22" y="134" class="f-text f-quiet">each session shows a machine of its own</text>
</svg>`,

  /** What a third party sees when every session hands it the same id. */
  parties: `
<svg viewBox="0 0 320 130" role="img" aria-label="A tracker present in two sessions">
  <rect x="14" y="14" width="110" height="28" rx="2" class="f-tab f-a"/>
  <text x="69" y="32" class="f-text f-mid">work</text>
  <rect x="14" y="88" width="110" height="28" rx="2" class="f-tab f-b"/>
  <text x="69" y="106" class="f-text f-mid">personal</text>
  <path d="M124 28 L196 60" class="f-link f-a-s f-arrow"/>
  <path d="M124 102 L196 70" class="f-link f-b-s f-arrow"/>
  <rect x="200" y="50" width="106" height="30" rx="2" class="f-out f-alarm"/>
  <text x="253" y="70" class="f-text f-mid">one tracker</text>
  <text x="253" y="126" class="f-label f-mid f-alarm-t">SEES ONE PERSON</text>
</svg>`,
};

const GUIDE = [
  {
    id: 'idea',
    title: 'The idea',
    lede: 'Your browser keeps one cookie jar and every tab shares it. That is why signing into a second account signs you out of the first.',
    figure: FIG.jars,
    body: [
      'NVX gives each session its own jar and decides, for every single request, which jar that request is allowed to see. A tab belongs to a session, so it carries that session’s cookies and nothing else.',
      'Your browser’s own jar is held back from managed tabs entirely, so nothing leaks in either direction.',
    ],
    steps: [
      ['Two accounts, side by side', 'Open your work account in one tab and your personal one in the next. Both stay signed in.'],
      ['One window', 'No profile switching, no second browser, no incognito window that forgets everything when you close it.'],
    ],
  },

  {
    id: 'first-run',
    title: 'Setting up on a browser you already use',
    lede: 'You do not have to sign into anything again. Everything you are already signed into is sitting in the browser’s jar, and it can be lifted straight out.',
    figure: FIG.adopt,
    body: [
      'On the first run a setup screen opens by itself. It reads what the profile is carrying, works out which of it looks like a real signed-in account rather than a preference cookie, and groups the sites that belong to one account together.',
      'Cookies are copied, never moved. The browser’s own jar is left exactly as it was, so every tab you have open keeps working while you decide, and undoing a mistake costs nothing but deleting the session.',
    ],
    steps: [
      ['It ticks the obvious ones', 'Anything that looks like a signed-in account arrives ticked. Everything else is there to tick yourself.'],
      ['One account can be several sites', 'A university login covers the portal, the sign-in page and the learning system. Those arrive as one session, not three.'],
      ['Your open tabs come with it', 'Tabs already on those sites move into the new session. They do not reload and nothing changes for them, because the cookies are identical.'],
      ['You can do it again later', 'Sessions, then Set up from profile, reads the whole profile again and proposes one session per account. Adopt existing beside it is the other half: one session out of exactly the sites you pick, with a name and a colour you choose.'],
    ],
  },

  {
    id: 'home',
    title: 'Home: who am I on this tab',
    lede: 'The toolbar button opens on the one question worth asking mid-task.',
    body: [
      'The top of it is the session this tab is in, by name, colour and shape. Under that is every session you could move it to, and the last row makes a new one.',
      'Pressing a row rebinds the tab and reloads it. Nothing is sent to the site until you press something.',
    ],
    steps: [
      ['isolation', 'Says clean while every request in a managed tab carried exactly the cookies its session holds. If it stops saying clean, something outside NVX wrote to a jar, and that is the one failure worth interrupting you for.'],
      ['third parties', 'How many trackers were handed cookies. See the Parties chapter for why that number matters.'],
      ['managed', 'How many tabs are in a session right now.'],
    ],
  },

  {
    id: 'sessions',
    title: 'Sessions',
    lede: 'A session is a name, a colour and a list of sites it is for.',
    body: [
      'Pinning a domain says this session is for this site. A pinned domain that exactly one session claims takes new tabs automatically, which is what makes a session feel like a container.',
      'Every session also shows also signs in at, which it learned rather than being told. A session that signs in at an identity provider picks that up on its own, and it is shown because a session reaching somewhere unexpected is worth seeing rather than guessing at.',
    ],
    steps: [
      ['New session', 'Name it after the account, not the site. You will be picking between them later.'],
      ['Pinned domains', 'Comma separated. Add the sites this account is for.'],
      ['Blast radius', 'How careful to be about destructive requests in this session. See the Blast radius chapter.'],
      ['Delete arms before it acts', 'The first press turns the row red and tells you what the second one costs: how many cookies go, which site you are signed out of, how many tabs are left unmanaged. It gives up after six seconds or if you click elsewhere. There is no undo, which is why it says so first.'],
    ],
  },

  {
    id: 'google',
    title: 'Google, and the default account trap',
    lede: 'The problem this was built to fix, in the place it bites hardest.',
    body: [
      'Google does a thing that has quietly caused real damage: when you are signed into more than one account, it picks one as the default, and anything you open without thinking, a link a colleague sends, a doc, a login on another site, silently goes to that default. Work things end up opened as your personal account, or the reverse. You do not choose it and you often do not notice until something has already been shared to the wrong person.',
      'You cannot reorder which account is the default without signing out of all of them and signing back in in the order you want, because Google keeps that order on its own servers, not in your browser. There is no setting for it.',
      'So this does not try to reorder anything. It gives each version of you its own separate space. In a session that is signed into only your work Google account, work is the default, always, because it is the only one there. In a session signed into only your personal account, personal is the default there. Nothing to reorder, nothing to pick wrong: which account you are is decided by which session the tab is in, and you switch that the same way you switch anything else here.',
      'The everyday effect: a work link opened in your work session opens as work, full stop. It cannot quietly resolve to your personal account, because your personal account is not in that session at all.',
    ],
    steps: [
      ['Give a Google account a session', 'Usually you do not even make a session just for it. Put your work Google account in your Work session, alongside your work GitHub and everything else work. The account is one login inside a context, not a context of its own.'],
      ['Add it the safe way', 'On the session, press Sign in here and go to Google. You sign in normally and this session remembers only that account. The account you use elsewhere is never touched.'],
      ['Do not copy it in', 'Setting up from your profile copies the login you already have. For a Google account you keep using in your normal browser too, that copy can look to Google like a stolen session and sign you out of both. Sign in fresh instead. This is the one place where the easy button is the wrong one.'],
      ['Switching accounts is switching sessions', 'To be your other Google account, switch the tab to that session. Google\u2019s own account menu stops mattering, because each session only knows about its own account.'],
    ],
  },

  {
    id: 'picker',
    title: 'When you get asked',
    lede: 'Most of the browser is not ours and is left alone. You are only asked when the answer is genuinely unknown.',
    figure: FIG.route,
    body: [
      'When two or more of your sessions cover the same site, picking either one for you would sign you in as somebody you did not ask for. So the navigation is held: the tab shows a picker instead of the site, and the site is not contacted at all until you answer.',
      'That matters more than it sounds. A site with a company login redirects to its sign-in provider within a second, and whatever jar the tab was holding while it waited is the account the sign-in completes as. Asking over the top of the page does not work, because the redirect destroys the question before you can answer it.',
    ],
    steps: [
      ['Pick a session', 'The tab joins it and the site loads under that account.'],
      ['Just this once', 'Leaves the tab unmanaged on that site and stops asking about it.'],
      ['Ask me again', 'Tabs → Choose re-asks for any tab, whenever you want.'],
    ],
  },

  {
    id: 'reopen',
    title: 'Reopening a closed tab',
    lede: 'Ctrl+Shift+T puts the tab back in the session it was in, and says so.',
    body: [
      'Closing a tab is remembered for an hour. One close earns one reopen: the visit after that is a fresh question, because a memory that keeps answering is a memory that eventually answers wrongly.',
      'The memory survives the browser going quiet, which is not free: the part of the extension that holds it is shut down after thirty seconds of inactivity, so it is kept somewhere that outlives it.',
    ],
  },

  {
    id: 'tabs',
    title: 'Tabs',
    lede: 'Every open tab, which session it is in, and a picker to change it.',
    steps: [
      ['Choose', 'Asks the question inside the page, for a tab you want to re-pick deliberately.'],
      ['Moving a tab', 'Rebinds and reloads it, because a page that has already spoken as one account cannot be retracted, only started again as the other.'],
    ],
  },

  {
    id: 'storage',
    title: 'Web storage',
    lede: 'Cookies are half an identity. Plenty of sites keep their token in the browser’s local storage instead.',
    figure: FIG.storage,
    body: [
      'Local storage belongs to the site rather than to the tab, so without help two sessions on one site would read and overwrite each other’s tokens. Each session gets its own set of keys instead, and the site’s own data is left where it is for unmanaged tabs.',
      'The Storage view says plainly which origins are isolated and which are running through untouched. An honest “shared” there is worth more than a claim on a settings screen that is not true.',
    ],
    steps: [
      ['What it is not', 'This separates sessions from each other. It is not a vault: a page can still reach its own origin’s storage if it goes looking. Cookies do not have that limitation, because the jar never touches the browser’s store at all.'],
      ['On the manifest v2 build', 'Not available at all, and the view says so rather than implying otherwise.'],
    ],
  },

  {
    id: 'parties',
    title: 'Third parties',
    lede: 'Going to one site fires requests to a dozen others. A tracker handed the same identifier from all your sessions makes them one person to anybody counting.',
    figure: FIG.parties,
    body: [
      'The Parties view lists who else was on the pages your sessions visited and which site pulled them in.',
      'Each session decides for itself whether third parties get cookies, and new sessions block by default. That is the one default here that changes what goes on the wire without asking, and the reason is that a session exists to be separate.',
    ],
    steps: [
      ['What blocking costs', 'An embedded third party you are signed into can appear signed out. It is visible, it is one click to reverse, and it is listed here with the evidence.'],
      ['Single sign-on still works', 'A top-level hop to a sign-in provider is not a third-party request. There is a test that holds that true.'],
    ],
  },

  {
    id: 'trail',
    title: 'Blast radius',
    lede: 'Some requests cannot be undone. Deleting a repository, terminating an instance, emptying a bucket.',
    body: [
      'Every session is watched for requests like that, and the Trail view lists them. What happens when one is seen is the session’s own setting.',
    ],
    steps: [
      ['Off', 'Interrupts nothing and still records, because a session nobody is guarding is the one you end up asking questions about later.'],
      ['Warn', 'Shows a card in the page. Nothing is stopped. This is the default.'],
      ['Production', 'Refuses the request outright, tells the page why, and lets you allow that one endpoint for five minutes.'],
      ['Why it is per session', 'Your scratch account and your company’s production console want different answers, and they are different sessions.'],
    ],
  },

  {
    id: 'fingerprint',
    title: 'Fingerprint',
    lede: 'Cookies are not the only way two of your accounts can be matched up. A site can also measure the machine.',
    figure: FIG.posture,
    body: [
      'This is one setting for the whole profile, and the default fabricates nothing on purpose. Several of your own accounts sharing one device is unremarkable; what actually raises a flag is incoherence. Randomising makes you stranger, not safer.',
    ],
    steps: [
      ['Mirror', 'Your real machine, unchanged. The shipped default, and a real answer rather than the absence of one.'],
      ['Standardize', 'Every session shows one shared, ordinary machine. It only lowers how identifiable you are because everybody running it lands in the same place rather than each getting a private disguise.'],
      ['Persona', 'Each session shows a machine of its own, stable for as long as the session exists and different on every site it visits. This is the one that stops two of your accounts being matched by the machine they run on.'],
      ['What is masked', 'The canvas, WebGL, audio, the navigator and your installed speech voices. Under the control is a list of everything that is not masked, and why. Several of those cannot be closed at this level rather than being unwritten, and the list says which is which.'],
      ['Tabs you already had open', 'A fingerprint is changed by a script that runs before the page does, and that script cannot get into a page that has already loaded. So changing this setting does nothing to the tabs in front of you until you reload them, and those tabs are deliberately left completely alone in the meantime rather than half changed. The note under the control says how many are waiting.'],
    ],
  },

  {
    id: 'moving',
    title: 'Moving tabs in bulk',
    lede: 'Sorting a browser full of tabs into sessions without doing it one at a time.',
    body: [
      'Open the Tabs view and every open tab has a tick box. Tick the ones you want, or use All, or All on a site to grab every tab on the site you are looking at, then choose a session from Move to. They all go at once.',
      'It moves them as a single safe operation rather than one after another. While the move happens, those tabs are held for a few milliseconds so none of them can send a request under the wrong account midway through, and two moves at once wait for each other instead of tangling. You will not notice any of that; it is why moving ten tabs is as safe as moving one.',
    ],
    steps: [
      ['Tick what you want', 'Each tab has a box. All selects everything, All on a site selects every tab on the site the active tab is on, which is the common case.'],
      ['Move to a session', 'Pick it from the dropdown. Unbind hands them back to the browser instead.'],
      ['Undo if it was wrong', 'A move shows a short Undo. Press it and every tab goes back to the session it came from, even if they came from several, through the same safe path the move used.'],
      ['Right-click a link', 'Open link in session puts a link straight into a session without opening it first, which is the quick way to send a work link to your work account.'],
      ['Right-click the page', 'This tab moves the tab you are on into a session, or hands it back to the browser, without opening the popup at all.'],
    ],
  },

  {
    id: 'shortcuts',
    title: 'Moving by keyboard',
    lede: 'The fastest way to put the tab you are on into a session.',
    body: [
      'The active tab can go into a session by keyboard. Alt+1, Alt+2 and Alt+3 move it to your first, second and third session. Sessions past the third have a shortcut too, but you assign the keys yourself, because the browser only lets an extension suggest a few.',
      'A move by keyboard, or by the right-click menu, happens with the popup closed, so there is nowhere to show an undo at that moment. Instead the popup remembers it: the next time you open it you will see what was moved and where, with an Undo, for a minute and a half after. Open link in a session and switch a tab account still work the way they always did.',
    ],
    steps: [
      ['Alt+1, Alt+2, Alt+3', 'Move the active tab to your first, second or third session. The number is the position in the session list, so Alt+2 is always the second one.'],
      ['Assign the rest yourself', 'Sessions four and up have a command each with no key set. Open your browser\\u2019s extension shortcuts page and give them the keys you want.'],
      ['Undo from the popup', 'A keyboard or right-click move offers Undo the next time the popup opens, or Keep it to leave it. After ninety seconds it is just done.'],
    ],
  },

  {
    id: 'marks',
    title: 'Telling tabs apart',
    lede: 'Two ways a session can mark the tabs it owns.',
    steps: [
      ['Mark tab icons', 'Stamps the session colour onto the favicon of every tab it owns. Works everywhere, on by default.'],
      ['Group tabs natively', 'Also gathers a session into a browser tab group. Off by default, because it rearranges tabs you arranged. Not every browser has it; where it is missing the control says so rather than failing quietly.'],
    ],
  },

  {
    id: 'loop',
    title: 'When a sign-in will not finish',
    lede: 'The one failure this can cause that is worth knowing about in advance, and what it does about it on its own.',
    body: [
      'A big provider gives you several cookies that are meant to agree with each other, and checks that they do. A session holds a copy of them, taken at one moment. If that copy is not the whole picture, the site is handed part of a sign-in rather than all of it, and what it sees looks less like somebody signed out than like somebody using a stolen session. Sites answer that seriously.',
      'What you see is a page that reloads forever, or one that says your cookies are disabled. Nothing on screen connects either to this extension, which is the actual problem: it is not that it can happen, it is that you would have no reason to suspect the cause.',
      'So it watches for it. A managed tab that keeps being redirected back to the same site, or one where the browser gives up on a redirect chain, is a sign-in that is not going to complete. Rather than let it keep going, NVX stops managing that site, hands its tabs back to the browser and reloads. The site works again immediately, and the popup tells you what it did with a button to undo it.',
    ],
    steps: [
      ['You do not have to do anything', 'It releases the site on its own and reloads the tab. Continuing to fight a loop is what turns a failed sign-in into a bigger problem.'],
      ['It says so afterwards', 'A note on the first page of the popup names the site and offers to manage it again. Settings keeps the full list of released sites.'],
      ['Ordinary sign-ins are not touched', 'A real federated login is a handful of hops across two or three sites and completes. The check is deliberately set well above that.'],
      ['If you would rather it never manages a site', 'Release it yourself from Settings. That is permanent until you undo it, unlike "just this once" at the picker, which lasts until you close the browser.'],
    ],
  },

  {
    id: 'stop',
    title: 'Turning it off',
    lede: 'One button that makes every tab behave as though this were not installed, without losing anything.',
    body: [
      'Settings has a Pause everything button. It withdraws every rule, stops rewriting any cookies, stops asking you which session a tab belongs in, and takes the scripts out of your pages. Your sessions and everything in them stay exactly where they are, and pressing it again puts them all back.',
      'It is there because the first question when a site starts behaving strangely is whether this extension is the reason, and the only other way to answer that would be to uninstall, which throws away every session to run one experiment. If a site is misbehaving, pause first and reload it. If it still misbehaves, this was not the cause.',
    ],
    steps: [
      ['Pause everything', 'Settings, at the top. Everything off, nothing lost.'],
      ['If a login will not complete', 'Pause, finish signing in normally, then resume. A sign-in that fights the extension is better paused than fought.'],
      ['Removing it entirely', 'Your original cookies were copied, never moved, so they are still in the browser exactly as they were. Removing the extension leaves you signed into everything you were signed into before.'],
    ],
  },

  {
    id: 'journal',
    title: 'The journal',
    lede: 'What the extension did, kept on disk, so the answer is still there tomorrow.',
    body: [
      'Every decision that moved a tab, a session or a cookie is written down: which session a tab joined and which of the four rules claimed it, what an adoption took, what the guard refused. The browser’s console is erased by the extension going quiet, by the browser closing and by a restart, which are the three things that happen between noticing something and being asked what happened.',
      'Nothing sensitive is in it. No cookie values, no storage values, no query strings, no request bodies. Query strings are removed rather than filtered, because that is where sign-in codes and password reset tokens travel and a filter is only a list of the names somebody thought of.',
    ],
    steps: [
      ['Level', 'Info by default, which is every decision and nothing else. Debug adds the routine traffic and is what a bug report wants.'],
      ['Export', 'Writes the whole thing out as a text file you can read or attach to an issue.'],
      ['Clear', 'Empties it, on disk as well as on screen.'],
    ],
  },

  {
    id: 'broken',
    title: 'When isolation breaks',
    lede: 'The isolation reading counts requests where a managed tab carried a cookie its session does not own.',
    body: [
      'That means something outside NVX wrote to that jar, and it is the one failure the whole design exists to prevent, so it is not quiet about it: home takes an alarm across the top and the toolbar button carries a badge.',
      'Two other kinds of mismatch are counted and deliberately not badged. Stale is a cookie that rotated while a request was in flight, which happens at least once in every ordinary sign-in. Missing is usually a rule that had not landed yet. A badge that lights up during a normal login is worse than no badge.',
    ],
    steps: [
      ['Recount', 'Does not dismiss anything. It restarts the measurement, which is the only honest way to clear a count.'],
    ],
  },

  {
    id: 'diagnostics',
    title: 'Diagnostics',
    lede: 'At the bottom of the popup, or Alt+Shift+S.',
    body: [
      'The one surface that stayed a full page, because every suite in it opens real tabs to measure against and a popup closes the moment it loses focus.',
      'Isolation creates two throwaway sessions, proves they cannot see each other, and removes them again. Restore proves state survives a crash. Mark, Storage and Guard each prove their own half.',
    ],
  },
];

/**
 * What it does not do.
 *
 * Kept as its own list rather than scattered through the chapters, because
 * somebody deciding whether to trust this reads it in one go, and because a
 * guide listing only capabilities is why people conclude a tool is broken when
 * it is working exactly as designed.
 */
const LIMITS = [
  ['It is not anonymity', 'Sites still see your address, your browser and your screen. Two sessions are separate from each other, not hidden from the site.'],
  ['It is not a sandbox', 'A page in a session can still do everything a page can do. What is isolated is identity, not capability.'],
  ['It is not a password manager', 'It keeps you signed in as somebody. It has no idea who they are or what their password is.'],
  ['Local storage is separated, not sealed', 'Two sessions stop reading and overwriting each other, which is the whole bug. A page that goes looking can still reach its own origin’s storage.'],
  ['Databases are shared', 'IndexedDB and Cache Storage are not separated. The Storage view says so rather than implying otherwise.'],
  ['One address for everybody', 'Every session leaves from the same network address. Separating that needs a proxy, which is a different piece of software.'],
  ['A sign-in can loop the first time', 'If a site was already signed in before you put it in a session, it can be handed part of a login rather than all of it, and loop. NVX notices and stops managing that site by itself, but the cleanest way to avoid it entirely is to sign in fresh inside the session rather than adopting an account you are already using.'],
  ['Keep a big account in one place only', 'A session holds a copy of the cookies a site gave you, taken at the moment you set it up. If you keep using the same account in an ordinary tab as well, the site is being shown two different sets of cookies for one login, and a large provider treats that as somebody having stolen your session rather than as two tabs. Google’s answer to it was to sign out every account, not just the one. If an account matters, use it in its session or outside, not both.'],
  ['Blocking third parties can break a login', 'A sign-in provider is a third party too. Blocking the whole list is what turns a login into a page that reloads forever or says cookies are disabled. Open Third parties and click the one you need to let through: the list already says who was there.'],
  ['A fingerprint setting reaches the next page, not this one', 'Changing it cannot alter a page that has already loaded, so it takes effect as you move around rather than the moment you press it. Reload a tab to bring it forward.'],
];

// Read by popup.js and guide.js. Assigned rather than exported, because these
// are classic scripts sharing one global scope.
globalThis.NVX_GUIDE = GUIDE;
globalThis.NVX_LIMITS = LIMITS;
