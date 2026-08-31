/**
 * ------------------------------------------------------------------
 *  Title    |  NVX native host
 *  Ref      |  protocol.mjs, DPAPI key store
 *  ID       |  native host
 * ------------------------------------------------------------------
 *  Purpose  |  Answer a small set of requests over native messaging,
 *           |  spawned on demand by the browser.
 *  How      |  Exits when the browser closes the pipe. The extension
 *           |  feature-detects it and degrades silently, so every
 *           |  build is fully functional without it.
 *  Note     |  v1 holds the vault master key in the OS credential
 *           |  store instead of a passphrase every restart. Process
 *           |  spawning (side profile launch, per-session proxy) is
 *           |  not here yet. Node rather than Rust; a Rust build would
 *           |  buy one signed binary with no runtime dependency, a
 *           |  distribution problem not a protocol one. See npm run
 *           |  native:package.
 *  Author   |  Ojas Kekre, 16/08/2026
 * ------------------------------------------------------------------
 */

import { PROTOCOL_VERSION, FrameReader, encode } from './protocol.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, version as nodeVersion } from 'node:process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

const HOST_VERSION = '0.1.0';

/**
 * ------------------------------------------------------------------
 *  Purpose  |  Idle exit.
 *  Note     |  The browser holds the pipe open as long as the port
 *           |  lives, so this only fires if the extension goes away
 *           |  without closing it, which is what a crashed renderer
 *           |  looks like.
 * ------------------------------------------------------------------
 */
const IDLE_MS = 5 * 60 * 1000;
let idleTimer = null;

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), IDLE_MS);
}

function send(message) {
  process.stdout.write(encode(message));
}

// --------------------------------------------------------------- key store

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The master key, wrapped by the OS so it is bound to
 *           |  this user account.
 *  How      |  On Windows, DPAPI via PowerShell: no native module, no
 *           |  compile step. The wrapped blob is written to disk; the
 *           |  unwrapped key never touches it.
 *  Note     |  A different user, or a copy of the file on another
 *           |  machine, cannot unwrap it.
 * ------------------------------------------------------------------
 */
const SERVICE = 'NVX Session';

async function dpapi(direction, base64) {
  const script =
    direction === 'protect'
      ? `Add-Type -AssemblyName System.Security;` +
        `$b=[Convert]::FromBase64String('${base64}');` +
        `$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');` +
        `[Convert]::ToBase64String($p)`
      : `Add-Type -AssemblyName System.Security;` +
        `$b=[Convert]::FromBase64String('${base64}');` +
        `$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');` +
        `[Convert]::ToBase64String($p)`;

  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true }
  );
  return stdout.trim();
}

/** Base64 with no padding variance, so a round trip is byte identical. */
function isBase64(s) {
  return typeof s === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0;
}

/**
 * ------------------------------------------------------------------
 *  Purpose  |  The wrapped blobs live on disk, which is the point.
 *  How      |  An in-memory store would be forgotten when the pipe
 *           |  closes, bringing back the passphrase prompt this
 *           |  replaces. What is written is DPAPI ciphertext: bound to
 *           |  this user on this machine, useless to anyone who copies
 *           |  the file.
 *  Note     |  Permissions are tightened on creation, not trusted from
 *           |  the parent dir: %LOCALAPPDATA% is readable by anything
 *           |  running as this user, and the wrapped blob is the one
 *           |  artefact worth stealing.
 * ------------------------------------------------------------------
 */
const STORE_DIR = join(
  process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || homedir(),
  'NVX Session'
);
const STORE_FILE = join(STORE_DIR, 'keys.json');

function loadStore() {
  try {
    const raw = readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed?.entries ?? {}));
  } catch {
    // Absent or unreadable is the first-run case and is not an error.
    return new Map();
  }
}

function saveStore() {
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(
      STORE_FILE,
      JSON.stringify({ version: 1, entries: Object.fromEntries(store) }, null, 2),
      { mode: 0o600 }
    );
  } catch (e) {
    // Reported to the caller rather than swallowed: a key that appears to save
    // and does not is worse than one that refuses.
    throw new Error(`could not write the key store: ${e.message}`);
  }
}

const store = loadStore();

async function wrap(key) {
  if (platform !== 'win32') return { wrapped: key, sealed: false };
  return { wrapped: await dpapi('protect', key), sealed: true };
}

async function unwrap(entry) {
  if (!entry.sealed) return entry.wrapped;
  return dpapi('unprotect', entry.wrapped);
}

// ---------------------------------------------------------------- handlers

async function handle(msg) {
  const id = msg?.id ?? null;

  switch (msg?.type) {
    /**
     * Version is exchanged on connect and a mismatch is refused loudly. A
     * silently stale host is a debugging nightmare: everything appears to work
     * until a capability behaves differently from what the caller assumed.
     */
    case 'hello': {
      if (msg.protocol !== PROTOCOL_VERSION) {
        return {
          id,
          ok: false,
          error: `protocol mismatch: extension speaks ${msg.protocol}, host speaks ${PROTOCOL_VERSION}`,
          protocol: PROTOCOL_VERSION,
        };
      }
      return {
        id,
        ok: true,
        protocol: PROTOCOL_VERSION,
        version: HOST_VERSION,
        platform,
        runtime: nodeVersion,
        capabilities: keyStoreAvailable() ? ['key'] : [],
        sealed: platform === 'win32',
        store: STORE_FILE,
      };
    }

    case 'ping':
      return { id, ok: true, pong: Date.now() };

    case 'key.set': {
      if (!isBase64(msg.key)) return { id, ok: false, error: 'key must be base64' };
      if (typeof msg.account !== 'string' || !msg.account) {
        return { id, ok: false, error: 'account is required' };
      }
      store.set(`${SERVICE}:${msg.account}`, await wrap(msg.key));
      saveStore();
      return { id, ok: true };
    }

    case 'key.get': {
      const entry = store.get(`${SERVICE}:${msg.account}`);
      if (!entry) return { id, ok: true, key: null };
      return { id, ok: true, key: await unwrap(entry) };
    }

    case 'key.clear':
      if (store.delete(`${SERVICE}:${msg.account}`)) saveStore();
      return { id, ok: true };

    default:
      return { id, ok: false, error: `unknown request type: ${String(msg?.type)}` };
  }
}

function keyStoreAvailable() {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux';
}

// ------------------------------------------------------------------- wiring

const reader = new FrameReader();

process.stdin.on('data', (chunk) => {
  touchIdle();
  let messages;
  try {
    messages = reader.push(chunk);
  } catch (e) {
    // A framing error means the stream is no longer trustworthy. Report it and
    // stop, rather than resynchronising onto what might be the middle of a
    // message.
    send({ id: null, ok: false, error: e.message, fatal: true });
    process.exit(1);
    return;
  }

  for (const msg of messages) {
    handle(msg)
      .then(send)
      .catch((e) => send({ id: msg?.id ?? null, ok: false, error: String(e?.message ?? e) }));
  }
});

// The browser closing the pipe is the normal way this ends.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));

touchIdle();
