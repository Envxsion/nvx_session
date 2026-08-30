/**
 * Drives the native host the way the browser does.
 *
 * Unit tests cover the framing. They cannot cover whether the host actually
 * starts, whether the operating system's credential store is reachable, or
 * whether a key survives being wrapped and unwrapped, and those are the parts
 * that differ per machine.
 *
 *   node tools/native-check.mjs
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode, FrameReader, PROTOCOL_VERSION } from '../native/protocol.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = join(ROOT, 'native', 'host.mjs');

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const host = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'pipe'] });
const reader = new FrameReader();
const waiting = new Map();
let nextId = 1;

host.stdout.on('data', (chunk) => {
  for (const msg of reader.push(chunk)) {
    const resolveIt = waiting.get(msg.id);
    if (resolveIt) {
      waiting.delete(msg.id);
      resolveIt(msg);
    }
  }
});

let stderr = '';
host.stderr.on('data', (d) => (stderr += d.toString()));

function ask(message, ms = 15_000) {
  const id = nextId++;
  host.stdin.write(encode({ ...message, id }));
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    setTimeout(() => {
      if (waiting.delete(id)) reject(new Error(`${message.type} timed out after ${ms}ms`));
    }, ms);
  });
}

try {
  const hello = await ask({ type: 'hello', protocol: PROTOCOL_VERSION });
  console.log(
    `\nhost ${hello.version} on ${hello.platform}, protocol ${hello.protocol}` +
      `, capabilities [${(hello.capabilities ?? []).join(', ')}]\n`
  );

  check('the host starts and answers', hello.ok === true);
  check('protocol versions agree', hello.protocol === PROTOCOL_VERSION);
  check('a key store is available', (hello.capabilities ?? []).includes('key'));

  const mismatch = await ask({ type: 'hello', protocol: PROTOCOL_VERSION + 99 });
  check(
    'a protocol mismatch is refused loudly',
    mismatch.ok === false && String(mismatch.error).includes('mismatch'),
    mismatch.error ?? ''
  );

  const secret = randomBytes(32).toString('base64');
  const account = `check-${Date.now()}`;

  check('an absent key reads back as null', (await ask({ type: 'key.get', account })).key === null);

  const set = await ask({ type: 'key.set', account, key: secret });
  check('a key can be stored', set.ok === true, set.error ?? '');

  const got = await ask({ type: 'key.get', account });
  check(
    'the key survives the operating system round trip',
    got.key === secret,
    hello.sealed ? 'DPAPI wrapped' : 'held in memory, unsealed on this platform'
  );

  const bad = await ask({ type: 'key.set', account, key: 'not base64!!' });
  check('a malformed key is refused', bad.ok === false, bad.error ?? '');

  await ask({ type: 'key.clear', account });
  check('a cleared key is gone', (await ask({ type: 'key.get', account })).key === null);

  const unknown = await ask({ type: 'nonsense' });
  check('an unknown request is answered rather than ignored', unknown.ok === false);

  // The point of the host is surviving a browser restart, so the store has to
  // outlive the process. A second host is started to prove it.
  const persisted = `persist-${Date.now()}`;
  await ask({ type: 'key.set', account: persisted, key: secret });
  host.stdin.end();
  await new Promise((r) => setTimeout(r, 400));

  const second = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'pipe'] });
  const secondReader = new FrameReader();
  const secondWaiting = new Map();
  second.stdout.on('data', (chunk) => {
    for (const m of secondReader.push(chunk)) {
      const r = secondWaiting.get(m.id);
      if (r) { secondWaiting.delete(m.id); r(m); }
    }
  });
  const ask2 = (message) => {
    const id = nextId++;
    second.stdin.write(encode({ ...message, id }));
    return new Promise((resolve, reject) => {
      secondWaiting.set(id, resolve);
      setTimeout(() => { if (secondWaiting.delete(id)) reject(new Error('second host timed out')); }, 15000);
    });
  };

  const reread = await ask2({ type: 'key.get', account: persisted });
  check('a key survives the host exiting', reread.key === secret, hello.store ?? '');
  await ask2({ type: 'key.clear', account: persisted });
  second.stdin.end();

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (stderr.trim()) console.log(`\nhost stderr:\n${stderr}`);
  host.stdin.end();
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error(`\nnative check failed: ${e.message}`);
  if (stderr.trim()) console.error(`host stderr:\n${stderr}`);
  host.stdin.end();
  process.exit(2);
}
