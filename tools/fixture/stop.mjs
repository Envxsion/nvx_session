/**
 * ------------------------------------------------------------------
 *  Title    |  Fixture stop
 *  Ref      |  fixture/server.mjs
 *  ID       |  fixture
 * ------------------------------------------------------------------
 *  Purpose  |  Stops the fixture, and only the fixture.
 *  Note     |  Killing by process name would take out every node
 *           |  process. This resolves the pid on the port and
 *           |  confirms it answers as the fixture before touching it.
 *  Author   |  Ojas Kekre, 20/08/2026
 * ------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process';

const PORT = Number(process.env.NVX_FIXTURE_PORT ?? 8787);

let alive = false;
try {
  const r = await fetch(`http://localhost:${PORT}/echo`, { cache: 'no-store' });
  alive = r.ok && (await r.json())?.ok === true;
} catch {
  alive = false;
}

if (!alive) {
  console.log(`no nvx fixture answering on ${PORT}`);
  process.exit(0);
}

const pids = new Set();
try {
  const out =
    process.platform === 'win32'
      ? execFileSync('netstat', ['-ano', '-p', 'TCP']).toString()
      : execFileSync('lsof', ['-ti', `tcp:${PORT}`]).toString();

  if (process.platform === 'win32') {
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${PORT}`) || !line.includes('LISTENING')) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== '0') pids.add(pid);
    }
  } else {
    for (const pid of out.split(/\s+/).filter(Boolean)) pids.add(pid);
  }
} catch (e) {
  console.error(`could not resolve the listener: ${e.message}`);
  process.exit(1);
}

if (!pids.size) {
  console.error(`fixture answers on ${PORT} but no listening pid was found`);
  process.exit(1);
}

for (const pid of pids) {
  try {
    process.kill(Number(pid));
    console.log(`stopped fixture pid ${pid}`);
  } catch (e) {
    console.error(`could not stop pid ${pid}: ${e.message}`);
  }
}
