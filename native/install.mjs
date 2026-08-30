/**
 * Registers the native host with every browser on this machine that will talk
 * to it.
 *
 *   node native/install.mjs <extension-id> [more ids...]
 *   node native/install.mjs --uninstall
 *
 * Native messaging is opt-in from both ends: the browser will only launch a
 * host that is registered, and the host manifest names exactly which extension
 * ids may connect. Get either half wrong and the port simply fails to open,
 * with no error anywhere except runtime.lastError.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, execPath } from 'node:process';

const run = promisify(execFile);

export const HOST_NAME = 'com.nvx.session';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE = join(ROOT, 'native');
const HOST_JS = join(NATIVE, 'host.mjs');
const LAUNCHER = join(NATIVE, 'nvx-host.bat');
const MANIFEST = join(NATIVE, `${HOST_NAME}.json`);

/**
 * Hives to write, in order of how likely they are to exist.
 *
 * Opera reads its own hive rather than Chrome's, and its path has moved between
 * versions, so every plausible one is written rather than probed: a stray
 * registry key under a browser that is not installed costs nothing, and a
 * missing one costs an afternoon of a port that will not open.
 */
const HIVES = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  'HKCU\\Software\\Opera Software\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
];

/**
 * Windows cannot launch a .mjs directly.
 *
 * Native messaging spawns the manifest's `path` as a process, and on Windows
 * that has to be something the shell can execute. A batch shim that forwards
 * to the current Node is the smallest thing that works and keeps the host
 * itself a plain script. A packaged build replaces this with the binary and
 * drops the shim entirely.
 */
function writeLauncher() {
  const bat = [
    '@echo off',
    'setlocal',
    `"${execPath}" "${HOST_JS}" %*`,
  ].join('\r\n');
  writeFileSync(LAUNCHER, `${bat}\r\n`, 'utf8');
  return LAUNCHER;
}

function writeManifest(ids, hostPath) {
  const manifest = {
    name: HOST_NAME,
    description: 'NVX Session native host',
    path: hostPath,
    type: 'stdio',
    // Both builds must be listed. The Store build and the GitHub build have
    // different ids, and an unlisted id is refused with no diagnostic.
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };
  mkdirSync(NATIVE, { recursive: true });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function reg(args) {
  try {
    await run('reg.exe', args, { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function install(ids) {
  if (platform !== 'win32') {
    console.error(`this installer is Windows only for now; ${platform} needs the per-user`);
    console.error('NativeMessagingHosts directory instead of the registry');
    process.exit(1);
  }

  const hostPath = writeLauncher();
  const manifest = writeManifest(ids, hostPath);

  console.log(`host      ${hostPath}`);
  console.log(`manifest  ${MANIFEST}`);
  console.log(`origins   ${manifest.allowed_origins.join(', ')}\n`);

  let written = 0;
  for (const hive of HIVES) {
    const ok = await reg(['add', `${hive}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f']);
    console.log(`  ${ok ? 'ok  ' : 'skip'}  ${hive}`);
    if (ok) written++;
  }

  if (!written) {
    console.error('\nno registry hive accepted the key, so no browser will launch the host');
    process.exit(1);
  }
  console.log(`\nregistered in ${written} hive(s). Restart the browser for it to take effect.`);
}

async function uninstall() {
  for (const hive of HIVES) {
    const ok = await reg(['delete', `${hive}\\${HOST_NAME}`, '/f']);
    console.log(`  ${ok ? 'removed' : 'absent '}  ${hive}`);
  }
  for (const f of [MANIFEST, LAUNCHER]) {
    rmSync(f, { force: true });
  }
  console.log('\nunregistered. The key store under %LOCALAPPDATA% is left alone.');
}

const args = process.argv.slice(2);
if (args.includes('--uninstall')) {
  await uninstall();
} else {
  const ids = args.filter((a) => !a.startsWith('--'));
  if (!ids.length) {
    console.error('usage: node native/install.mjs <extension-id> [more ids...]');
    console.error('       node native/install.mjs --uninstall');
    console.error('\nThe id is shown on chrome://extensions with developer mode on.');
    process.exit(1);
  }
  if (ids.some((id) => !/^[a-p]{32}$/.test(id))) {
    console.error('an extension id is 32 characters, a to p. Refusing rather than');
    console.error('writing a manifest the browser will silently ignore.');
    process.exit(1);
  }
  await install(ids);
}
