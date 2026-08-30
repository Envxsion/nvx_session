const $ = (id) => document.getElementById(id);

const state = { env: null, static: [], live: [] };

const send = (msg) =>
  new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

const VERDICTS = ['pass', 'fail', 'blocked', 'absent'];

function paintEnv(env) {
  $('env').innerHTML = '';
  const fields = [
    ['browser', env.browser],
    ['chromium', env.chromiumVersion ?? 'unknown'],
    ['manifest', `v${env.manifestVersion}`],
    ['platform', env.platform ?? 'unknown'],
  ];
  if (env.operaVersion) fields.splice(1, 0, ['opera', env.operaVersion]);
  for (const [k, v] of fields) {
    const el = document.createElement('div');
    el.innerHTML = `<b>${k}</b><span></span>`;
    el.querySelector('span').textContent = v;
    $('env').append(el);
  }
}

function paintTally(node, rows) {
  node.innerHTML = '';
  for (const v of VERDICTS) {
    const n = rows.filter((r) => r.verdict === v).length;
    if (!n) continue;
    const el = document.createElement('span');
    el.className = `v-${v}`;
    el.innerHTML = `<i>${v}</i> `;
    el.append(document.createTextNode(String(n)));
    node.append(el);
  }
}

/**
 * Rows animate in on a short stagger so the eye can follow the fill rather
 * than being handed a finished block. The stagger is capped so a long list
 * never feels like it is loading slowly.
 */
function paintRows(node, rows) {
  node.innerHTML = '';
  if (!rows.length) {
    node.innerHTML = '<p class="empty">NOTHING RETURNED</p>';
    return;
  }
  rows.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = `row v-${r.verdict}`;
    el.style.animationDelay = `${Math.min(i * 22, 420)}ms`;

    const pip = document.createElement('span');
    pip.className = 'pip';

    const id = document.createElement('div');
    id.className = 'id';
    id.textContent = r.id;

    const detail = document.createElement('div');
    detail.className = 'detail';
    const verdict = document.createElement('span');
    verdict.className = 'verdict';
    verdict.textContent = r.verdict;
    if (typeof r.ms === 'number') {
      const ms = document.createElement('span');
      ms.className = 'ms';
      ms.textContent = `${r.ms}ms`;
      verdict.append(ms);
    }
    detail.append(verdict, document.createTextNode(r.detail ?? ''));

    el.append(pip, id, detail);
    node.append(el);
  });
}

/**
 * A button owns its own busy state, including its label. Width is fixed in CSS
 * so swapping the label never reflows the row.
 */
async function withBusy(btn, label, fn) {
  const original = btn.textContent;
  const siblings = [...document.querySelectorAll('.btn')];
  const wasDisabled = new Map(siblings.map((b) => [b, b.disabled]));
  siblings.forEach((b) => (b.disabled = true));
  btn.dataset.busy = '1';
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    delete btn.dataset.busy;
    btn.textContent = original;
    siblings.forEach((b) => (b.disabled = wasDisabled.get(b) ?? false));
  }
}

async function checkFixture() {
  const dot = $('fixture-dot');
  dot.className = 'dot busy';
  const r = await send({ cmd: 'fixture' });
  $('fixture-url').textContent = r.url;
  dot.className = `dot ${r.up ? 'up' : 'down'}`;
  $('fixture-hint').textContent = r.up
    ? ''
    : 'not reachable. run: node tools/fixture/server.mjs';
  return r.up;
}

$('run-static').addEventListener('click', () =>
  withBusy($('run-static'), 'Probing', async () => {
    const r = await send({ cmd: 'static' });
    state.env = r.env;
    state.static = r.results;
    paintEnv(r.env);
    paintRows($('rows-static'), r.results);
    paintTally($('tally-static'), r.results);
    $('export').disabled = false;
  })
);

$('run-live').addEventListener('click', () =>
  withBusy($('run-live'), 'Running', async () => {
    const up = await checkFixture();
    if (!up) {
      paintRows($('rows-live'), [
        {
          id: 'fixture',
          verdict: 'blocked',
          detail:
            'The fixture origin is not answering. Start it with: node tools/fixture/server.mjs',
        },
      ]);
      return;
    }
    const r = await send({ cmd: 'live' });
    state.live = r.results;
    paintRows($('rows-live'), r.results);
    paintTally($('tally-live'), r.results);
    $('export').disabled = false;
  })
);

$('export').addEventListener('click', () =>
  withBusy($('export'), 'Copied', async () => {
    await navigator.clipboard.writeText(
      JSON.stringify(
        { env: state.env, static: state.static, live: state.live, at: new Date().toISOString() },
        null,
        2
      )
    );
    await new Promise((r) => setTimeout(r, 700));
  })
);

checkFixture();
