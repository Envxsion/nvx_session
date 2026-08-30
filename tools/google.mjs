/**
 * What Google's multi-login state actually looks like, and whether it can be
 * reordered without signing out.
 *
 * The question this answers: `authuser=0` is the default account, the index
 * comes from an ordered list, and the received wisdom is that the only way to
 * change the order is to sign out of everything and sign back in with the one
 * you want first. Is that true, or is it just that nobody exposed the mutation?
 *
 * TWO STAGES, AND THEY ARE NOT THE SAME RISK.
 *
 * Stage one is read only. It fetches the account list Chromium itself uses and
 * takes an inventory of the cookies that carry the session. Nothing is written
 * and nothing can be lost.
 *
 * Stage two signs an account out, which is the only mutation Google exposes
 * anywhere near this, and watches whether the remaining accounts re-index. It
 * runs only with `--mutate` and it can sign you out of every account, not just
 * the one named. That is not a hypothetical: it is what happened to the author
 * of this repository the week this file was written, by a different route.
 *
 * A note on where it runs, because it changed the risk assessment. Copying the
 * profile to a scratch directory isolates the LOCAL state, so a read-only pass
 * on a copy is genuinely safe. It does NOT isolate stage two: `Logout` is a
 * request to Google's servers that revokes the session there, and the real
 * profile's cookies point at the same server-side session. A copy protects the
 * cookies on disk and nothing that matters.
 *
 * VALUES ARE NEVER PRINTED. Every cookie named below is a live credential. This
 * reports names, domains, flags and sizes, which is everything the question
 * needs and nothing that would end up in a terminal scrollback.
 *
 *   node tools/google.mjs                 read only
 *   node tools/google.mjs --mutate        signs an account out. See above.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { connect, browserEndpoint } from './cdp.mjs';

const MUTATE = process.argv.includes('--mutate');
const KEEP = process.argv.includes('--keep');

/**
 * A copy, because Chrome refuses to open a debugging port on the default
 * profile at all:
 *
 *   DevTools remote debugging requires a non-default data directory.
 *
 * Which is the correct behaviour and worth stating plainly: the platform is
 * defending against exactly the thing this script does. The copy is deleted on
 * exit unless --keep, and while it exists it holds a full set of live session
 * cookies in a temp directory.
 */
const SOURCE = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
const CHROME = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');

if (!existsSync(CHROME)) {
  console.error(`no chrome at ${CHROME}`);
  process.exit(1);
}
if (!existsSync(SOURCE)) {
  console.error(`no profile at ${SOURCE}`);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'nvx-google-'));
console.log(`copying the profile to ${profile}`);
console.log('  this is a full set of live session cookies. it is removed on exit.\n');

// Default and Local State are enough to carry the signed-in session. Copying
// the whole User Data tree drags in caches measured in gigabytes.
for (const part of ['Local State', join('Default', 'Cookies'), join('Default', 'Preferences'), join('Default', 'Login Data')]) {
  const from = join(SOURCE, part);
  if (!existsSync(from)) continue;
  cpSync(from, join(profile, part), { recursive: true, force: true });
}

const PORT = 9310 + Math.floor(Math.random() * 60);
const child = spawn(
  CHROME,
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

function done(code) {
  try {
    process.kill(child.pid);
  } catch {
    /* already gone */
  }
  if (!KEEP) {
    setTimeout(() => {
      try {
        rmSync(profile, { recursive: true, force: true });
        console.log('\nprofile copy removed');
      } catch {
        console.log(`\ncould not remove ${profile}, delete it by hand`);
      }
      process.exit(code);
    }, 1500);
  } else {
    console.log(`\nprofile copy kept at ${profile}`);
    process.exit(code);
  }
}
process.on('SIGINT', () => done(130));

const endpoint = await browserEndpoint(PORT);
const browser = await connect(endpoint.webSocketDebuggerUrl);
const page = await browser.send('Target.createTarget', { url: 'https://myaccount.google.com/' });
const sid = (await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }))
  .sessionId;
await new Promise((r) => setTimeout(r, 5000));

const evaluate = async (expression, ms = 30_000) => {
  const r = await browser.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    { sessionId: sid, timeout: ms }
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'failed');
  return r.result.value;
};

/**
 * The list Chromium itself asks for when it renders the account switcher.
 * Returns a JSON array whose order is the `authuser` order.
 */
async function listAccounts() {
  const raw = await evaluate(
    `fetch('https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', { credentials: 'include' })
       .then((r) => r.text())
       .catch((e) => 'ERR ' + e)`
  );
  try {
    const parsed = JSON.parse(String(raw));
    // Shape is [tag, [[ ...account ], ...]]. The address is the field worth
    // reading; everything else in the row is display state.
    const rows = Array.isArray(parsed?.[1]) ? parsed[1] : [];
    return rows.map((row, i) => ({
      index: i,
      email: typeof row?.[3] === 'string' ? row[3] : '(unreadable)',
      valid: row?.[9],
    }));
  } catch {
    return { raw: String(raw).slice(0, 200) };
  }
}

/** Names and shapes only. Never values. */
async function jar() {
  const { cookies } = await browser.send('Network.getAllCookies', {}, { sessionId: sid });
  return cookies
    .filter((c) => /(^|\.)google\.com$/.test(c.domain.replace(/^\./, '')))
    .map((c) => ({
      name: c.name,
      domain: c.domain,
      httpOnly: c.httpOnly,
      secure: c.secure,
      size: c.value.length,
      session: c.session,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

console.log('stage one, read only\n');

const before = await listAccounts();
console.log('accounts, in authuser order:');
if (Array.isArray(before)) {
  for (const a of before) console.log(`  authuser=${a.index}  ${a.email}`);
} else {
  console.log(`  could not read the list: ${JSON.stringify(before)}`);
}

const cookies = await jar();
console.log(`\n${cookies.length} cookies on google.com. names and shapes only:`);
for (const c of cookies) {
  console.log(
    `  ${c.name.padEnd(28)} ${c.domain.padEnd(20)} ${String(c.size).padStart(5)}b` +
      `${c.httpOnly ? ' httpOnly' : ''}${c.session ? ' session' : ''}`
  );
}

/**
 * The question the inventory answers on its own: is the ordering carried in a
 * cookie this side could edit, or is it server-side state the cookies merely
 * key into. If every account shares one `SID` rather than each having its own,
 * there is nothing here to reorder, and stage two is the only remaining lever.
 */
const perAccount = cookies.filter((c) => /^(__Secure-)?\d*PSID|ACCOUNT_CHOOSER|LSID|OSID/i.test(c.name));
console.log(
  `\nlooks per account: ${perAccount.length ? perAccount.map((c) => c.name).join(', ') : 'none'}`
);

if (!MUTATE) {
  console.log('\nstage two not run. pass --mutate to sign an account out and watch the indices.');
  console.log('read the header of this file before you do.');
  done(0);
} else {
  console.log('\nstage two, which signs an account out\n');

  const target = Array.isArray(before) && before.length > 1 ? before[before.length - 1] : null;
  if (!target) {
    console.log('  fewer than two accounts readable, nothing to reorder');
    done(0);
  } else {
    console.log(`  signing out authuser=${target.index}, ${target.email}`);
    await evaluate(
      `fetch('https://accounts.google.com/Logout?authuser=${target.index}', { credentials: 'include' })
         .then((r) => r.status).catch((e) => 'ERR ' + e)`
    );
    await new Promise((r) => setTimeout(r, 4000));

    const after = await listAccounts();
    console.log('\naccounts afterwards:');
    if (Array.isArray(after)) {
      for (const a of after) console.log(`  authuser=${a.index}  ${a.email}`);
      const lost = Array.isArray(before) ? before.length - after.length : 0;
      console.log(
        `\n  ${lost === 1 ? 'one account signed out, the rest kept their session' : lost > 1 ? `${lost} accounts signed out, so it cascaded` : 'nothing changed'}`
      );
    } else {
      console.log(`  ${JSON.stringify(after)}`);
    }
    done(0);
  }
}
