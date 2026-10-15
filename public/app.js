/* MongoPilot web UI — vanilla JS single-page app (hash routing, no build step) */

const APP = document.getElementById('app');
let token = localStorage.getItem('mp_token');
let who = localStorage.getItem('mp_user') || '';
let pollTimer = null;
// Incremented on every navigation; async renders check it so a slow request
// from the previous page can't overwrite the current page's DOM.
let epoch = 0;

/* ---------------- helpers ---------------- */

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    token = null;
    localStorage.removeItem('mp_token');
    renderLogin();
    throw new Error('Session expired — please log in again');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

/* wraps a handler: shows errors as toasts */
function act(fn) {
  return (...a) => Promise.resolve(fn(...a)).catch((e) => toast(e.message, 'err'));
}

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
}

function fmtUptime(s) {
  if (s == null) return '—';
  s = Math.floor(s);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function badge(st) {
  const map = { active: 'ok', running: 'ok', ok: 'ok', done: 'ok', inactive: 'muted', failed: 'err', activating: 'warn', unknown: 'muted' };
  return `<span class="badge ${map[st] || 'muted'}">${esc(st)}</span>`;
}

function drawChart(canvas, values, { color = '#5b9dff', format = (v) => String(Math.round(v)) } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = (canvas.width = canvas.clientWidth * dpr);
  const H = (canvas.height = canvas.clientHeight * dpr);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const pts = values.filter((v) => v != null && !isNaN(v));
  if (pts.length < 2) {
    ctx.fillStyle = '#5d6980';
    ctx.font = `${12 * dpr}px sans-serif`;
    ctx.fillText('collecting data…', 10 * dpr, 20 * dpr);
    return;
  }
  let min = Math.min(...pts), max = Math.max(...pts);
  if (min === max) { min = min - 1; max = max + 1; }
  const pad = 6 * dpr;
  const x = (i) => pad + ((W - 2 * pad) * i) / (pts.length - 1);
  const y = (v) => H - pad - ((H - 2 * pad) * (v - min)) / (max - min);
  ctx.beginPath();
  pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * dpr;
  ctx.stroke();
  ctx.lineTo(x(pts.length - 1), H - pad);
  ctx.lineTo(x(0), H - pad);
  ctx.closePath();
  ctx.fillStyle = color + '22';
  ctx.fill();
  ctx.fillStyle = '#98a2b8';
  ctx.font = `${11 * dpr}px sans-serif`;
  ctx.fillText(format(max), pad, 13 * dpr);
  ctx.fillText(format(min), pad, H - 8 * dpr);
}

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

/* ---------------- icons (inline SVG, stroke style) ---------------- */

const ICONS = {
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
  layers: '<path d="m12 2-10 5 10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  sliders: '<line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="18" x2="16" y2="22"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
  nodes: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M10.8 7.2 6.3 15.8"/><path d="m13.2 7.2 4.5 8.6"/><path d="M7.5 18h9"/>',
};

function icon(name, cls = '') {
  return `<svg class="icon${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/* brand mark: navigation arrow on the MongoDB-green tile */
const MARK = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#00ED64"/><path d="M16 7.2 23 21.6l-7-3.9-7 3.9z" fill="#0A0D13"/></svg>`;

function callout(kind, html) {
  return `<div class="callout ${kind}">${icon('alert')}<div>${html}</div></div>`;
}

/* every table gets a horizontal-scroll wrapper so wide data never breaks
   the layout on narrow screens; pages just render plain <table> markup */
new MutationObserver(() => {
  APP.querySelectorAll('table').forEach((t) => {
    if (!t.parentElement.classList.contains('table-wrap')) {
      const w = document.createElement('div');
      w.className = 'table-wrap';
      t.parentNode.insertBefore(w, t);
      w.appendChild(t);
    }
  });
}).observe(APP, { childList: true, subtree: true });

/* poll a background job until it finishes; streams its log into an element */
async function watchJob(jobId, logElId, onDone) {
  const tick = async () => {
    const job = await api('/jobs/' + jobId);
    const el = document.getElementById(logElId);
    if (el) {
      el.textContent = job.log.join('\n') + (job.error ? '\nERROR: ' + job.error : '');
      el.scrollTop = el.scrollHeight;
    }
    if (job.status === 'running') return setTimeout(() => tick().catch(() => {}), 1500);
    toast(job.status === 'done' ? `${job.type} finished` : `${job.type} failed: ${job.error}`, job.status === 'done' ? 'ok' : 'err');
    if (onDone) onDone(job);
  };
  tick().catch((e) => toast(e.message, 'err'));
}

/* ---------------- layout & routing ---------------- */

const NAV = [
  ['dashboard', 'Dashboard', 'gauge'],
  ['instances', 'Instances', 'database'],
  ['replsets', 'Replica Sets', 'nodes'],
  ['versions', 'Versions', 'layers'],
  ['firewall', 'Firewall', 'shield'],
  ['backups', 'Backups', 'archive'],
  ['settings', 'Settings', 'sliders'],
];

function layout(active, content) {
  APP.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href="#/dashboard">${MARK}<span class="brand-name">Mongo<em>Pilot</em></span></a>
        ${NAV.map(([k, label, ic]) => `<a class="nav-item ${k === active ? 'active' : ''}" href="#/${k}">${icon(ic)}<span>${label}</span></a>`).join('')}
        <div class="spacer"></div>
        <div class="whoami">
          <div class="avatar">${esc((who || '?').slice(0, 1))}</div>
          <div class="who-meta">
            <span class="who-name">${esc(who)}</span>
            <a href="#" class="who-out" onclick="h.logout();return false">Sign out</a>
          </div>
        </div>
      </aside>
      <main class="main">${content}</main>
    </div>`;
}

function route() {
  epoch++;
  clearInterval(pollTimer);
  pollTimer = null;
  if (!token) return renderLogin();
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [page, ...rest] = hash.split('/');
  const pages = {
    dashboard: pageDashboard,
    versions: pageVersions,
    instances: pageInstances,
    instance: pageInstance,
    replsets: pageReplSets,
    replset: pageReplSet,
    firewall: pageFirewall,
    backups: pageBackups,
    settings: pageSettings,
  };
  act(pages[page] || pageDashboard)(...rest);
}
window.addEventListener('hashchange', route);

/* ---------------- login ---------------- */

function renderLogin() {
  clearInterval(pollTimer);
  APP.innerHTML = `
    <div class="login-wrap"><div class="login-box card">
      <div class="login-brand">${MARK}<span>Mongo<em>Pilot</em></span></div>
      <p class="login-sub">MongoDB control panel</p>
      <label><span class="lbl">Username</span><input id="l-user" autocomplete="username" /></label>
      <label><span class="lbl">Password</span><input id="l-pass" type="password" autocomplete="current-password" /></label>
      <button class="primary" style="width:100%;margin-top:6px" onclick="h.login()">Sign in</button>
    </div></div>`;
  document.getElementById('l-pass').addEventListener('keydown', (e) => e.key === 'Enter' && h.login());
  document.getElementById('l-user').focus();
}

/* ---------------- pages ---------------- */

async function pageDashboard() {
  layout('dashboard', `<h1>Dashboard</h1><p class="page-sub">Server health and MongoDB instances at a glance.</p><div id="body" class="muted">Loading…</div>`);
  const ep = epoch;
  const load = act(async () => {
    const [info, metrics, insts] = await Promise.all([api('/system'), api('/system/metrics'), api('/instances')]);
    if (ep !== epoch) return;
    const last = metrics[metrics.length - 1] || {};
    const disk = last.disk;
    const body = document.getElementById('body');
    if (!body) return;
    body.innerHTML = `
      ${info.app.devMode ? callout('warn', `<b>Dev mode</b> — running without <code>/etc/mongopilot/config.json</code>. Instance/firewall operations need a Linux server.`) : ''}
      <div class="grid cols-4">
        <div class="card stat"><div class="label">CPU</div><div class="value">${last.cpuPct ?? '—'}%</div><div class="sub">load ${last.load?.toFixed(2) ?? '—'} · ${info.os.cpus} cores</div></div>
        <div class="card stat"><div class="label">Memory</div><div class="value">${last.memTotal ? Math.round((1 - last.memFree / last.memTotal) * 100) + '%' : '—'}</div><div class="sub">${fmtBytes(last.memTotal - last.memFree)} / ${fmtBytes(last.memTotal)}</div></div>
        <div class="card stat"><div class="label">Disk (data dir)</div><div class="value">${disk ? Math.round((disk.usedKB / disk.totalKB) * 100) + '%' : '—'}</div><div class="sub">${disk ? fmtBytes(disk.usedKB * 1024) + ' / ' + fmtBytes(disk.totalKB * 1024) : '—'}</div></div>
        <div class="card stat"><div class="label">Host</div><div class="value" style="font-size:15px">${esc(info.os.hostname)}</div><div class="sub">${esc(info.os.pretty)} · up ${fmtUptime(info.os.uptime)}</div></div>
      </div>
      <div class="card">
        <h2>MongoDB instances</h2>
        ${insts.length === 0 ? `<div class="muted">No instances yet — <a href="#/instances">create one</a>.</div>` : `
        <table><thead><tr><th>Name</th><th>Version</th><th>Port</th><th>Status</th><th>Auth</th><th>Memory</th><th></th></tr></thead><tbody>
          ${insts.map((i) => `<tr>
            <td><a href="#/instance/${i.name}">${esc(i.name)}</a></td>
            <td class="mono">${esc(i.version)}</td>
            <td class="mono">${i.port}</td>
            <td>${badge(i.status.state)}</td>
            <td>${i.authEnabled ? '<span class="badge ok">enabled</span>' : '<span class="badge warn">open</span>'}</td>
            <td>${fmtBytes(i.status.memoryBytes)}</td>
            <td><a class="rowlink" href="#/instance/${i.name}">Manage${icon('chevron')}</a></td>
          </tr>`).join('')}
        </tbody></table>`}
      </div>
      <div class="grid cols-2">
        <div class="card"><h2>CPU %</h2><canvas class="chart" id="c-cpu"></canvas></div>
        <div class="card"><h2>Memory used</h2><canvas class="chart" id="c-mem"></canvas></div>
      </div>`;
    drawChart(document.getElementById('c-cpu'), metrics.map((m) => m.cpuPct), { color: '#5b9dff', format: (v) => Math.round(v) + '%' });
    drawChart(document.getElementById('c-mem'), metrics.map((m) => m.memTotal - m.memFree), { color: '#00ed64', format: fmtBytes });
  });
  await load();
  pollTimer = setInterval(load, 10000);
}

async function pageVersions() {
  layout('versions', `<h1>MongoDB Versions</h1><p class="page-sub">Install Community releases from official tarballs. Multiple versions run side by side.</p><div id="body" class="muted">Loading catalog…</div>`);
  const ep = epoch;
  const data = await api('/versions');
  if (ep !== epoch) return;
  const body = document.getElementById('body');
  const bySeries = {};
  for (const c of data.catalog) (bySeries[c.series] ||= []).push(c);
  const seriesKeys = Object.keys(bySeries).sort((a, b) => parseFloat(b) - parseFloat(a));

  body.innerHTML = `
    ${data.catalogError ? callout('danger', `Could not load the release catalog: ${esc(data.catalogError)}`) : ''}
    <div class="card">
      <h2>Installed</h2>
      ${data.installed.length === 0 ? '<div class="muted">Nothing installed yet. Pick a series below.</div>' : `
      <table><thead><tr><th>Version</th><th></th></tr></thead><tbody>
        ${data.installed.map((v) => `<tr><td class="mono">${esc(v)}</td>
          <td><button class="sm danger" onclick="h.removeVersion('${esc(v)}')">Remove</button></td></tr>`).join('')}
      </tbody></table>`}
      <div class="mt muted">Database tools (mongodump/mongorestore): ${data.toolsInstalled ? '<span class="badge ok">installed</span>' : '<span class="badge warn">not installed — added automatically with the first version install</span>'}</div>
    </div>
    <h2 style="margin:20px 0 10px">Community releases available for this server</h2>
    <div class="grid cols-2">
      ${seriesKeys.map((s) => {
        const list = bySeries[s];
        const avail = list.filter((v) => v.available);
        const latest = avail[0];
        return `<div class="card">
          <div class="flex"><h2 class="mb0">MongoDB ${esc(s)}</h2>
            ${latest ? `<span class="badge info right">latest ${esc(latest.version)}</span>` : '<span class="badge muted right">no build for this OS</span>'}</div>
          ${latest ? `
          <div class="row mt">
            <label><span class="lbl">Version</span>
              <select id="sel-${esc(s)}">${avail.slice(0, 15).map((v) => `<option value="${esc(v.version)}">${esc(v.version)}${data.installed.includes(v.version) ? ' (installed)' : ''}</option>`).join('')}</select>
            </label>
            <button class="primary" onclick="h.installVersion('${esc(s)}')">Install</button>
          </div>` : `<div class="muted mt">MongoDB ${esc(s)} does not ship community builds for this OS/architecture.</div>`}
        </div>`;
      }).join('')}
    </div>
    <div class="card" id="job-card" style="display:none"><h2>Installation log</h2><pre class="log" id="job-log"></pre></div>`;
}

async function pageInstances() {
  layout('instances', `<h1>Instances</h1>
    <p class="page-sub">Each instance is a native <code>mongod</code> process with its own data directory, port and systemd unit.</p>
    <div class="card" id="create-card"><h2>New instance</h2><div class="muted">Loading…</div></div>
    <div class="card"><h2>Existing instances</h2><div id="inst-list" class="muted">Loading…</div></div>`);
  const ep = epoch;
  const [insts, vers] = await Promise.all([api('/instances'), api('/versions')]);
  if (ep !== epoch) return;

  // The create form is rendered ONCE — the status poll below must never
  // touch it, or it would wipe whatever the user is typing.
  const createForm = vers.installed.length === 0
    ? `<div class="muted">Install a MongoDB version first on the <a href="#/versions">Versions</a> page, then create instances here.</div>`
    : `<div class="row">
        <label><span class="lbl">Name</span><input id="ni-name" placeholder="e.g. main, analytics" /></label>
        <label><span class="lbl">Version</span><select id="ni-version">${vers.installed.map((v) => `<option>${esc(v)}</option>`).join('')}</select></label>
        <label><span class="lbl">Port</span><input id="ni-port" type="number" value="${27017 + insts.length}" /></label>
        <label><span class="lbl">Bind IP</span><input id="ni-bind" value="127.0.0.1" /></label>
        <button class="primary" onclick="h.createInstance()">Create & start</button>
      </div>
      <div class="muted mt">Each instance gets its own data directory, config and systemd service (<code>mongopilot-&lt;name&gt;</code>). Use bind IP <code>0.0.0.0</code> to listen on all interfaces (enable auth first!).</div>`;
  document.getElementById('create-card').innerHTML = `<h2>New instance</h2>${createForm}`;

  const renderList = (list) => {
    const el = document.getElementById('inst-list');
    if (!el) return;
    el.innerHTML = list.length === 0 ? '<div class="muted">None yet.</div>' : `
      <table><thead><tr><th>Name</th><th>Version</th><th>Port</th><th>Bind</th><th>Replica set</th><th>Status</th><th>Auth</th><th></th></tr></thead><tbody>
        ${list.map((i) => `<tr>
          <td><a href="#/instance/${i.name}">${esc(i.name)}</a></td>
          <td class="mono">${esc(i.version)}</td>
          <td class="mono">${i.port}</td>
          <td class="mono">${esc(i.bindIp)}</td>
          <td>${i.replSet ? `<a class="mono" href="#/replset/${esc(i.replSet)}">${esc(i.replSet)}</a>` : '<span class="muted">—</span>'}</td>
          <td>${badge(i.status.state)}</td>
          <td>${i.authEnabled ? '<span class="badge ok">on</span>' : '<span class="badge warn">off</span>'}</td>
          <td class="flex">
            <button class="sm" onclick="h.instAction('${i.name}','start')">Start</button>
            <button class="sm" onclick="h.instAction('${i.name}','restart')">Restart</button>
            <button class="sm" onclick="h.instAction('${i.name}','stop')">Stop</button>
            <a href="#/instance/${i.name}"><button class="sm">Manage</button></a>
          </td>
        </tr>`).join('')}
      </tbody></table>`;
  };
  renderList(insts);

  const poll = act(async () => {
    const list = await api('/instances');
    if (ep !== epoch) return;
    renderList(list);
  });
  pollTimer = setInterval(poll, 8000);
}

const TABS = [
  ['overview', 'Overview'],
  ['security', 'Security & Users'],
  ['databases', 'Databases'],
  ['metrics', 'Metrics'],
  ['backup', 'Backup'],
  ['logs', 'Logs'],
];

async function pageInstance(name, tab = 'overview') {
  if (!name) return pageInstances();
  layout('instances', `
    <h1>Instance: <span class="mono">${esc(name)}</span></h1>
    <div class="tabs">${TABS.map(([k, l]) => `<a class="tab ${k === tab ? 'active' : ''}" href="#/instance/${esc(name)}/${k}">${l}</a>`).join('')}</div>
    <div id="body" class="muted">Loading…</div>`);
  const fns = { overview: tabOverview, security: tabSecurity, databases: tabDatabases, metrics: tabMetrics, backup: tabBackup, logs: tabLogs };
  await (fns[tab] || tabOverview)(name);
}

async function tabOverview(name) {
  const ep = epoch;
  const i = await api('/instances/' + name);
  if (ep !== epoch) return;
  const body = document.getElementById('body');
  if (!body) return;
  const connStr = i.authEnabled
    ? `mongodb://${esc(i.adminUser)}:<password>@<server-ip>:${i.port}/?authSource=admin`
    : `mongodb://<server-ip>:${i.port}/`;
  const rsNote = i.replSet
    ? callout('info', `Member of replica set <a class="mono" href="#/replset/${esc(i.replSet)}">${esc(i.replSet)}</a>. Use the replica set page for its connection string, to add or remove members, or to delete it. Users and databases you change here apply to the whole set.`)
    : '';

  // Static part rendered once (the config form must survive polling);
  // only #ov-stats is refreshed by the status poll.
  body.innerHTML = `
    ${rsNote}
    <div class="grid cols-4" id="ov-stats"></div>
    <div class="card">
      <h2>Controls</h2>
      <div class="flex">
        <button onclick="h.instAction('${name}','start')">Start</button>
        <button onclick="h.instAction('${name}','restart')">Restart</button>
        <button onclick="h.instAction('${name}','stop')">Stop</button>
        ${i.replSet ? '' : `<button class="danger right" onclick="h.deleteInstance('${name}')">Delete instance…</button>`}
      </div>
    </div>
    <div class="card">
      <h2>Network configuration</h2>
      <div class="row">
        <label><span class="lbl">Port${i.replSet ? ' (fixed for replica set members)' : ''}</span><input id="cfg-port" type="number" value="${i.port}" ${i.replSet ? 'disabled' : ''} /></label>
        <label><span class="lbl">Bind IP (comma separated; 0.0.0.0 = all)</span><input id="cfg-bind" value="${esc(i.bindIp)}" /></label>
        <button class="primary" onclick="h.saveConfig('${name}')">Save & restart</button>
      </div>
      <div class="muted mt">Remember to also open the port for allowed client IPs on the <a href="#/firewall">Firewall</a> page.</div>
    </div>
    ${i.replSet ? '' : `<div class="card">
      <h2>Connection string</h2>
      <code>${connStr}</code>
    </div>`}
    <div class="muted">systemd unit: <code>mongopilot-${esc(name)}.service</code></div>`;

  const renderStats = (inst) => {
    const el = document.getElementById('ov-stats');
    if (!el) return;
    el.innerHTML = `
      <div class="card stat"><div class="label">Status</div><div class="value">${badge(inst.status.state)}</div><div class="sub">${inst.status.pid ? 'pid ' + inst.status.pid : ''}</div></div>
      <div class="card stat"><div class="label">Version</div><div class="value">${esc(inst.version)}</div></div>
      <div class="card stat"><div class="label">Memory</div><div class="value">${fmtBytes(inst.status.memoryBytes)}</div></div>
      <div class="card stat"><div class="label">Auth</div><div class="value">${inst.authEnabled ? '<span class="badge ok">enabled</span>' : '<span class="badge warn">open</span>'}</div></div>`;
  };
  renderStats(i);

  const poll = act(async () => {
    const inst = await api('/instances/' + name);
    if (ep !== epoch) return;
    renderStats(inst);
  });
  pollTimer = setInterval(poll, 8000);
}

const COMMON_ROLES = ['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin', 'readAnyDatabase', 'readWriteAnyDatabase', 'dbAdminAnyDatabase', 'userAdminAnyDatabase', 'clusterMonitor', 'backup', 'restore', 'root'];

async function tabSecurity(name) {
  const ep = epoch;
  const i = await api('/instances/' + name);
  if (ep !== epoch) return;
  const body = document.getElementById('body');
  if (!i.authEnabled) {
    body.innerHTML = `
      ${callout('warn', `<b>Authentication is disabled</b> — this instance accepts unauthenticated connections.`)}
      <div class="card">
        <h2>Enable authentication</h2>
        <p class="muted">${i.replSet
          ? `Applies to the whole replica set <b>${esc(i.replSet)}</b>: MongoPilot creates the root user on the primary, gives every member a shared keyfile, enables <code>security.authorization</code> and restarts all members together (a few seconds of downtime).`
          : 'Create the first admin (root) user — MongoPilot will then enable <code>security.authorization</code> and restart the instance.'}</p>
        <div class="row">
          <label><span class="lbl">Admin username</span><input id="au-user" value="admin" /></label>
          <label><span class="lbl">Admin password (8+ chars)</span><input id="au-pass" type="password" /></label>
          <button class="primary" onclick="h.enableAuth('${name}')">Enable authentication</button>
        </div>
      </div>`;
    return;
  }
  const users = await api(`/instances/${name}/users`).catch((e) => { toast(e.message, 'err'); return []; });
  if (ep !== epoch) return;
  body.innerHTML = `
    <div class="card">
      <h2>Users</h2>
      <table><thead><tr><th>User</th><th>Auth DB</th><th>Roles</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr>
          <td class="mono">${esc(u.user)}</td>
          <td class="mono">${esc(u.db)}</td>
          <td>${(u.roles || []).map((r) => `<span class="badge info">${esc(r.role)}@${esc(r.db)}</span>`).join(' ')}</td>
          <td class="flex">
            <button class="sm" onclick="h.changePassword('${name}','${esc(u.db)}','${esc(u.user)}')">Password…</button>
            <button class="sm danger" onclick="h.dropUser('${name}','${esc(u.db)}','${esc(u.user)}')">Drop</button>
          </td>
        </tr>`).join('')}
      </tbody></table>
    </div>
    <div class="card">
      <h2>Create user</h2>
      <div class="row">
        <label><span class="lbl">Username</span><input id="nu-user" /></label>
        <label><span class="lbl">Password</span><input id="nu-pass" type="password" /></label>
        <label><span class="lbl">Role</span><select id="nu-role">${COMMON_ROLES.map((r) => `<option>${r}</option>`).join('')}</select></label>
        <label><span class="lbl">On database</span><input id="nu-db" placeholder="e.g. myapp (admin for *AnyDatabase roles)" value="admin" /></label>
        <button class="primary" onclick="h.createUser('${name}')">Create</button>
      </div>
      <div class="muted mt">The user is created in the target database (its "auth DB"). Clients connect with <code>?authSource=&lt;auth db&gt;</code>.</div>
    </div>`;
}

async function tabDatabases(name) {
  const ep = epoch;
  const load = act(async () => {
    const dbs = await api(`/instances/${name}/databases`);
    if (ep !== epoch) return;
    const body = document.getElementById('body');
    if (!body) return;
    body.innerHTML = `
      <div class="card">
        <h2>Databases</h2>
        <table><thead><tr><th>Name</th><th>Size on disk</th><th></th></tr></thead><tbody>
          ${dbs.map((d) => `<tr>
            <td class="mono">${esc(d.name)}</td>
            <td>${fmtBytes(Number(d.sizeOnDisk))}</td>
            <td>${['admin', 'local', 'config'].includes(d.name) ? '<span class="badge muted">system</span>' : `<button class="sm danger" onclick="h.dropDb('${name}','${esc(d.name)}')">Drop</button>`}</td>
          </tr>`).join('')}
        </tbody></table>
      </div>
      <div class="card">
        <h2>Create database</h2>
        <div class="row">
          <label><span class="lbl">Database name</span><input id="nd-name" /></label>
          <label><span class="lbl">Initial collection</span><input id="nd-coll" value="init" /></label>
          <button class="primary" onclick="h.createDb('${name}')">Create</button>
        </div>
        <div class="muted mt">MongoDB creates databases lazily — an initial collection makes it visible immediately.</div>
      </div>`;
  });
  await load();
}

async function tabMetrics(name) {
  const body = document.getElementById('body');
  body.innerHTML = `
    <div class="grid cols-2">
      <div class="card"><h2>Connections</h2><canvas class="chart" id="m-conn"></canvas></div>
      <div class="card"><h2>Resident memory (MB)</h2><canvas class="chart" id="m-mem"></canvas></div>
      <div class="card"><h2>Reads /s</h2><canvas class="chart" id="m-read"></canvas></div>
      <div class="card"><h2>Writes /s</h2><canvas class="chart" id="m-write"></canvas></div>
    </div>
    <div class="muted">Sampled every 15s, last hour kept. Gaps mean the instance was unreachable.</div>`;
  const ep = epoch;
  const load = act(async () => {
    const m = await api(`/instances/${name}/metrics`);
    if (ep !== epoch || !document.getElementById('m-conn')) return;
    drawChart(document.getElementById('m-conn'), m.map((p) => p.connections), { color: '#5b9dff' });
    drawChart(document.getElementById('m-mem'), m.map((p) => p.residentMB), { color: '#00ed64' });
    drawChart(document.getElementById('m-read'), m.map((p) => p.opsRead), { color: '#f0b429', format: (v) => v.toFixed(1) });
    drawChart(document.getElementById('m-write'), m.map((p) => p.opsWrite), { color: '#f2555a', format: (v) => v.toFixed(1) });
  });
  await load();
  pollTimer = setInterval(load, 15000);
}

async function tabBackup(name) {
  const ep = epoch;
  const [i, settings, history] = await Promise.all([
    api('/instances/' + name),
    api('/backups/settings'),
    api('/backups/history?instance=' + encodeURIComponent(name)),
  ]);
  if (ep !== epoch) return;
  const body = document.getElementById('body');
  body.innerHTML = `
    ${!settings ? callout('warn', `S3 is not configured yet — set bucket &amp; credentials on the <a href="#/backups">Backups</a> page first.`) : `
    <div class="card"><h2>Destination</h2><code>s3://${esc(settings.bucket)}/${esc(settings.prefix)}/${esc(name)}/</code> <span class="muted">(${esc(settings.region)})</span></div>`}
    <div class="card">
      <h2>Schedule</h2>
      <div class="row">
        <label><span class="lbl">Cron expression (empty = disabled)</span><input id="bk-cron" value="${esc(i.backupSchedule?.cron || '')}" placeholder="0 3 * * *  (daily at 03:00)" /></label>
        <label><span class="lbl">Keep last N backups</span><input id="bk-ret" type="number" value="${i.backupSchedule?.retention ?? 7}" /></label>
        <button class="primary" onclick="h.saveSchedule('${name}')">Save schedule</button>
        <button onclick="h.runBackup('${name}')">Run backup now</button>
      </div>
    </div>
    <div class="card" id="job-card" style="display:none"><h2>Backup log</h2><pre class="log" id="job-log"></pre></div>
    <div class="card">
      <h2>History</h2>
      ${history.length === 0 ? '<div class="muted">No backups yet.</div>' : `
      <table><thead><tr><th>When</th><th>Status</th><th>Size</th><th>S3 key</th></tr></thead><tbody>
        ${history.map((hh) => `<tr>
          <td>${new Date(hh.at).toLocaleString()}</td>
          <td>${badge(hh.status)}</td>
          <td>${fmtBytes(hh.sizeBytes)}</td>
          <td class="mono">${esc(hh.key || hh.error || '')}</td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>`;
}

async function tabLogs(name) {
  const body = document.getElementById('body');
  body.innerHTML = `
    <div class="card">
      <div class="flex"><h2 class="mb0">mongod.log (last 200 lines)</h2><button class="sm right" onclick="h.refreshTab()">Refresh</button></div>
      <pre class="log mt" id="inst-log">Loading…</pre>
    </div>`;
  const ep = epoch;
  const r = await api(`/instances/${name}/logs`);
  if (ep !== epoch) return;
  const el = document.getElementById('inst-log');
  if (el) { el.textContent = r.log || '(log file is empty)'; el.scrollTop = el.scrollHeight; }
}

/* ---------------- replica sets ---------------- */

const RS_STATE_BADGE = { PRIMARY: 'ok', SECONDARY: 'info', ARBITER: 'muted', STARTUP: 'warn', STARTUP2: 'warn', RECOVERING: 'warn', ROLLBACK: 'warn' };

function rsBadge(st) {
  return `<span class="badge ${RS_STATE_BADGE[st] || 'err'}">${esc(st)}</span>`;
}

function rsHealth(rs) {
  const st = rs.status;
  if (!st.ok) return st.pending ? '<span class="badge warn">waiting to be added</span>' : '<span class="badge err">unreachable</span>';
  const total = st.members.length;
  if (!st.primary) return '<span class="badge err">no primary</span>';
  return `<span class="badge ${st.healthy === total ? 'ok' : 'warn'}">${st.healthy}/${total} healthy</span>`;
}

function isLoopbackHost(h) {
  return h === 'localhost' || /^127\./.test(h);
}

/* first port p where p .. p+count-1 are all unused by existing instances */
function freePortRange(insts, count, start = 27017) {
  const used = new Set(insts.map((i) => i.port));
  let p = start;
  while ([...Array(count).keys()].some((k) => used.has(p + k))) p++;
  return p;
}

async function pageReplSets() {
  layout('replsets', `<h1>Replica Sets</h1>
    <p class="page-sub">Highly available MongoDB: a primary plus secondaries that hold copies of the data and take over automatically on failure. Also required for transactions and change streams.</p>
    <div class="card"><h2>Your replica sets</h2><div id="rs-list" class="muted">Loading…</div></div>
    <div class="card" id="job-card" style="display:none"><h2>Progress</h2><pre class="log" id="job-log"></pre></div>
    <div id="rs-forms"></div>`);
  const ep = epoch;
  const [sets, vers, insts, hosts] = await Promise.all([api('/replsets'), api('/versions'), api('/instances'), api('/replsets/hosts')]);
  if (ep !== epoch) return;

  const renderList = (list) => {
    const el = document.getElementById('rs-list');
    if (!el) return;
    el.innerHTML = list.length === 0 ? '<div class="muted">None yet. Create one below, or convert an existing instance.</div>' : `
      <table><thead><tr><th>Name</th><th>Version</th><th>Members here</th><th>Primary</th><th>Health</th><th>Auth</th><th></th></tr></thead><tbody>
        ${list.map((r) => `<tr>
          <td><a class="mono" href="#/replset/${esc(r.name)}">${esc(r.name)}</a>${r.joined ? ' <span class="badge muted">joined</span>' : ''}</td>
          <td class="mono">${esc(r.version)}</td>
          <td>${r.members.map((m) => `<a class="mono" href="#/instance/${esc(m)}">${esc(m)}</a>`).join(', ') || '—'}</td>
          <td class="mono">${esc(r.status.primary || '—')}</td>
          <td>${rsHealth(r)}</td>
          <td>${r.authEnabled ? '<span class="badge ok">on</span>' : '<span class="badge warn">off</span>'}</td>
          <td><a class="rowlink" href="#/replset/${esc(r.name)}">Manage${icon('chevron')}</a></td>
        </tr>`).join('')}
      </tbody></table>`;
  };
  renderList(sets);

  const lan = hosts.addresses.map((a) => a.address);
  const hostOptions = [...new Set(['127.0.0.1', ...lan, hosts.hostname])].map((x) => `<option value="${esc(x)}"></option>`).join('');
  const versionOpts = vers.installed.map((v) => `<option>${esc(v)}</option>`).join('');
  const standalone = insts.filter((i) => !i.replSet);
  const nextName = (() => { let n = sets.length; while (sets.some((r) => r.name === 'rs' + n)) n++; return 'rs' + n; })();

  // forms are rendered once; the poll below only refreshes the list
  document.getElementById('rs-forms').innerHTML = vers.installed.length === 0
    ? `<div class="card"><h2>Create a replica set</h2><div class="muted">Install a MongoDB version first on the <a href="#/versions">Versions</a> page.</div></div>`
    : `
    <datalist id="rs-hosts">${hostOptions}</datalist>
    <div class="card">
      <h2>Create a replica set</h2>
      <div class="row">
        <label><span class="lbl">Replica set name</span><input id="rc-name" value="${esc(nextName)}" /></label>
        <label><span class="lbl">Version</span><select id="rc-version">${versionOpts}</select></label>
        <label><span class="lbl">Members</span><select id="rc-members">
          <option value="3" selected>3 (recommended)</option><option value="5">5</option><option value="7">7</option><option value="1">1 (no redundancy)</option>
        </select></label>
        <label><span class="lbl">First port</span><input id="rc-port" type="number" value="${freePortRange(insts, 7)}" /></label>
      </div>
      <div class="row mt">
        <label><span class="lbl">Bind IP</span><input id="rc-bind" value="127.0.0.1" onchange="h.rsBindChanged('rc')" /></label>
        <label><span class="lbl">Advertised host (address members &amp; clients use)</span><input id="rc-host" list="rs-hosts" value="127.0.0.1" /></label>
      </div>
      <label class="check mt"><input type="checkbox" id="rc-auth" checked onchange="document.getElementById('rc-authrow').style.display = this.checked ? '' : 'none'" /> Enable authentication (keyfile between members + root user)</label>
      <div class="row" id="rc-authrow">
        <label><span class="lbl">Admin username</span><input id="rc-user" value="admin" autocomplete="off" /></label>
        <label><span class="lbl">Admin password (8+ chars)</span><input id="rc-pass" type="password" autocomplete="new-password" /></label>
      </div>
      <div class="flex mt"><button class="primary" onclick="h.createReplSet()">Create replica set</button></div>
      <div class="muted mt">
        Members run on this server on consecutive ports (<code>&lt;name&gt;-1</code>, <code>&lt;name&gt;-2</code>, …), each with its own data directory and systemd unit.<br>
        <b>Apps on this server only</b>: keep bind and advertised host at <code>127.0.0.1</code>.
        <b>Apps or members on other servers</b>: bind <code>0.0.0.0</code> and advertise this server's private IP${lan.length ? ` (e.g. <code>${esc(lan[0])}</code>)` : ''} or DNS name, enable auth, and open the ports on the <a href="#/firewall">Firewall</a> page.
      </div>
    </div>
    <div class="grid cols-2">
      <div class="card">
        <h2>Convert an existing instance</h2>
        ${standalone.length === 0 ? '<div class="muted">No standalone instances to convert.</div>' : `
        <div class="row">
          <label><span class="lbl">Instance</span><select id="cv-inst">${standalone.map((i) => `<option value="${esc(i.name)}">${esc(i.name)} (port ${i.port})</option>`).join('')}</select></label>
          <label><span class="lbl">Replica set name</span><input id="cv-name" value="${esc(nextName)}" /></label>
        </div>
        <div class="row mt">
          <label><span class="lbl">Advertised host</span><input id="cv-host" list="rs-hosts" value="127.0.0.1" /></label>
          <button class="primary" onclick="h.convertReplSet()">Convert</button>
        </div>
        <div class="muted mt">Restarts the instance as a single-member replica set. Its data, users and backups stay as they are. Then add members from the replica set page.</div>`}
      </div>
      <div class="card">
        <h2>Join a replica set on another server</h2>
        <div class="row">
          <label><span class="lbl">Replica set name</span><input id="jn-name" placeholder="e.g. rs0" /></label>
          <label><span class="lbl">Version</span><select id="jn-version">${versionOpts}</select></label>
          <label><span class="lbl">Port</span><input id="jn-port" type="number" value="${freePortRange(insts, 1)}" /></label>
        </div>
        <div class="row mt">
          <label><span class="lbl">Bind IP</span><input id="jn-bind" value="0.0.0.0" /></label>
          <label><span class="lbl">This server's address</span><input id="jn-host" list="rs-hosts" value="${esc(lan[0] || hosts.hostname)}" /></label>
        </div>
        <label class="mt"><span class="lbl">Keyfile (from the replica set page on the other server; empty if it has no auth)</span><textarea id="jn-key" rows="3" spellcheck="false"></textarea></label>
        <div class="row">
          <label><span class="lbl">Admin username</span><input id="jn-user" value="admin" autocomplete="off" /></label>
          <label><span class="lbl">Admin password</span><input id="jn-pass" type="password" autocomplete="new-password" /></label>
          <button class="primary" onclick="h.joinReplSet()">Prepare member</button>
        </div>
        <div class="muted mt">Starts a member here that waits to be added. Then add it from the primary's server: Replica set → Add member → On another server.</div>
      </div>
    </div>`;

  pollTimer = setInterval(act(async () => {
    const list = await api('/replsets');
    if (ep !== epoch) return;
    renderList(list);
  }), 8000);
}

async function pageReplSet(name) {
  if (!name) return pageReplSets();
  layout('replsets', `
    <h1>Replica set: <span class="mono">${esc(name)}</span></h1>
    <div id="body" class="muted">Loading…</div>`);
  const ep = epoch;
  const [rs, insts, hosts] = await Promise.all([api('/replsets/' + name), api('/instances'), api('/replsets/hosts')]);
  if (ep !== epoch) return;
  const body = document.getElementById('body');
  const remoteOk = !isLoopbackHost(rs.advertiseHost);

  // static part rendered once (forms must survive polling)
  body.innerHTML = `
    ${rs.joined ? callout('info', `This server <b>joined</b> <span class="mono">${esc(name)}</span>; the set was created on another server. Membership changes go through the primary, wherever it runs.`) : ''}
    <div id="rs-alert"></div>
    <div class="grid cols-4" id="rs-stats"></div>
    <div class="card"><div class="flex"><h2 class="mb0">Members</h2><button class="sm right" onclick="h.rsStepDown('${esc(name)}')">Step down primary</button></div><div id="rs-members" class="mt"></div></div>
    <div class="card" id="job-card" style="display:none"><h2>Progress</h2><pre class="log" id="job-log"></pre></div>
    <div class="card">
      <h2>Add member</h2>
      <div class="row">
        <label><span class="lbl">On this server: port</span><input id="am-port" type="number" value="${freePortRange(insts, 1)}" /></label>
        <button class="primary" onclick="h.rsAddLocal('${esc(name)}')">Add member here</button>
      </div>
      <div class="row mt">
        <label><span class="lbl">On another server: host:port</span><input id="am-host" placeholder="10.0.0.12:27017" ${remoteOk ? '' : 'disabled'} /></label>
        <button onclick="h.rsAddRemote('${esc(name)}')" ${remoteOk ? '' : 'disabled'}>Add remote member</button>
      </div>
      <div class="muted mt">${remoteOk
        ? 'A remote member must first be prepared on its own server (Replica Sets → Join a replica set) with the keyfile below. New members copy all data (initial sync) before they can vote or serve reads.'
        : `Members advertise <code>${esc(rs.advertiseHost)}</code>, so this set can only grow on this server. To span servers, create a set that advertises this server's IP or DNS name.`}</div>
    </div>
    <div class="card">
      <h2>Connection string</h2>
      <code id="rs-conn">—</code>
      ${isLoopbackHost(rs.advertiseHost)
        ? `<div class="mt">${callout('warn', '<b>Only apps on this server can connect.</b> Members advertise a loopback address, so a driver on another machine would be sent to its own localhost. To connect from anywhere else, change <b>Network access</b> below.')}</div>`
        : '<div class="muted mt">Drivers discover the primary automatically and fail over on their own.</div>'}
    </div>
    ${rs.joined ? '' : `<div class="card">
      <h2>Network access</h2>
      <datalist id="rs-hosts">${[...new Set(['127.0.0.1', ...hosts.addresses.map((a) => a.address), hosts.hostname])].map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist>
      <div class="row">
        <label><span class="lbl">Bind IP (where members listen)</span><input id="na-bind" value="${esc(rs.bindIp)}" /></label>
        <label><span class="lbl">Advertised host (what clients connect to)</span><input id="na-host" list="rs-hosts" value="${esc(rs.advertiseHost)}" /></label>
        <button class="primary" onclick="h.rsNetwork('${esc(name)}')">Apply</button>
      </div>
      <div class="muted mt">
        <b>Reachable from other machines</b>: bind <code>0.0.0.0</code> and advertise this server's public IP${hosts.addresses.length ? ` (e.g. <code>${esc(hosts.addresses[0].address)}</code>)` : ''} or a DNS name pointing to it. Requires authentication.
        <b>This server only</b>: <code>127.0.0.1</code> for both.
        Members restart one at a time, so the set stays available and no data is touched. Then allow the ports on the <a href="#/firewall">Firewall</a> page, ideally only for the IPs that need them.
      </div>
    </div>`}
    ${rs.hasKeyFile ? `<div class="card">
      <h2>Keyfile</h2>
      <p class="muted">Members authenticate to each other with this shared secret. You need it when joining a member from another server. Treat it like a password.</p>
      <button class="sm" onclick="h.rsShowKey('${esc(name)}')">Reveal keyfile</button>
      <pre class="log mt" id="rs-key" style="display:none"></pre>
    </div>` : ''}
    <div class="card">
      <h2>Danger zone</h2>
      <div class="flex"><span class="muted">Stops and deletes ${rs.joined ? "this server's members" : 'every member on this server'}. Remove remote members first.</span>
      <button class="danger right" onclick="h.rsDelete('${esc(name)}')">Delete replica set…</button></div>
    </div>`;

  const render = (d) => {
    const st = d.status;
    const stats = document.getElementById('rs-stats');
    if (!stats) return;
    const primaryMember = st.ok ? st.members.find((m) => m.state === 'PRIMARY') : null;
    stats.innerHTML = `
      <div class="card stat"><div class="label">Health</div><div class="value">${rsHealth(d)}</div></div>
      <div class="card stat"><div class="label">Primary</div><div class="value mono" style="font-size:15px">${esc(st.primary || '—')}</div><div class="sub">${primaryMember?.instance ? 'instance ' + esc(primaryMember.instance) : primaryMember ? 'on another server' : ''}</div></div>
      <div class="card stat"><div class="label">Version</div><div class="value">${esc(d.version)}</div></div>
      <div class="card stat"><div class="label">Auth</div><div class="value">${d.authEnabled ? '<span class="badge ok">enabled</span>' : '<span class="badge warn">open</span>'}</div><div class="sub">${d.authEnabled ? 'keyfile + users' : '<a href="#/instance/' + esc(d.members[0] || '') + '/security">enable…</a>'}</div></div>`;
    document.getElementById('rs-alert').innerHTML = st.ok ? '' : callout(st.pending ? 'warn' : 'danger', esc(st.error));
    document.getElementById('rs-conn').textContent = st.connectionString || '—';
    const el = document.getElementById('rs-members');
    el.innerHTML = !st.ok ? '<div class="muted">Status unavailable.</div>' : `
      <table><thead><tr><th>Member</th><th>Instance</th><th>State</th><th>Lag</th><th>Syncing from</th><th>Message</th><th></th></tr></thead><tbody>
        ${st.members.map((m) => `<tr>
          <td class="mono">${esc(m.host)}${m.hidden ? ' <span class="badge muted">hidden</span>' : ''}${m.votes === 0 ? ' <span class="badge muted">non-voting</span>' : ''}</td>
          <td>${m.instance ? `<a class="mono" href="#/instance/${esc(m.instance)}">${esc(m.instance)}</a>` : '<span class="muted">other server</span>'}</td>
          <td>${rsBadge(m.state)}</td>
          <td>${m.lagSeconds == null ? '—' : m.lagSeconds + ' s'}</td>
          <td class="mono">${esc(m.syncSource || '—')}</td>
          <td class="muted" style="max-width:280px">${esc(m.message)}</td>
          <td>${st.members.length > 1 ? `<button class="sm danger" onclick="h.rsRemove('${esc(name)}','${esc(m.host)}',${m.instance ? 1 : 0})">Remove</button>` : ''}</td>
        </tr>`).join('')}
      </tbody></table>`;
  };
  render(rs);

  pollTimer = setInterval(act(async () => {
    const d = await api('/replsets/' + name);
    if (ep !== epoch) return;
    render(d);
  }), 5000);
}

async function pageFirewall() {
  layout('firewall', `<h1>Firewall</h1><p class="page-sub">Manage the IP allowlist for your MongoDB ports through <code>ufw</code> or <code>firewalld</code>.</p><div id="body" class="muted">Loading…</div>`);
  const ep = epoch;
  const fw = await api('/firewall');
  if (ep !== epoch) return;
  const body = document.getElementById('body');
  body.innerHTML = `
    <div class="card">
      <h2>Backend: ${badge(fw.backend)}</h2>
      ${fw.backend === 'none' ? '<div class="muted">No active firewall detected. Enable <code>ufw</code> (Ubuntu/Debian) or <code>firewalld</code> (RHEL/CentOS) on the server to manage IP allowlists from here.</div>' : ''}
      ${fw.backend === 'ufw-inactive' ? '<div class="muted">ufw is installed but inactive. Run <code>ufw enable</code> on the server (make sure SSH port 22 is allowed first!).</div>' : ''}
    </div>
    <div class="card">
      <h2>Allow access</h2>
      <div class="row">
        <label><span class="lbl">Port (e.g. a MongoDB instance port)</span><input id="fw-port" type="number" placeholder="27017" /></label>
        <label><span class="lbl">Source (CIDR, or "any")</span><input id="fw-cidr" placeholder="203.0.113.5/32" /></label>
        <button class="primary" onclick="h.fwAllow()">Allow</button>
        <button class="danger" onclick="h.fwRevoke()">Revoke</button>
      </div>
      <div class="muted mt">Also make sure the instance's <b>Bind IP</b> includes the interface clients connect to (Instance → Overview → Network configuration).</div>
    </div>
    ${fw.raw ? `<div class="card"><h2>Current rules</h2><pre class="log">${esc(fw.raw)}</pre></div>` : ''}`;
}

async function pageBackups() {
  layout('backups', `<h1>Backups</h1><p class="page-sub">Compressed <code>mongodump</code> archives uploaded to AWS S3, with per-instance schedules and retention.</p><div id="body" class="muted">Loading…</div>`);
  const ep = epoch;
  const [settings, history] = await Promise.all([api('/backups/settings'), api('/backups/history')]);
  if (ep !== epoch) return;
  const body = document.getElementById('body');
  body.innerHTML = `
    <div class="card">
      <h2>S3 destination ${settings ? '<span class="badge ok">configured</span>' : '<span class="badge warn">not configured</span>'}</h2>
      <div class="row">
        <label><span class="lbl">Region</span><input id="s3-region" value="${esc(settings?.region || '')}" placeholder="ap-south-1" /></label>
        <label><span class="lbl">Bucket</span><input id="s3-bucket" value="${esc(settings?.bucket || '')}" placeholder="my-backups" /></label>
        <label><span class="lbl">Key prefix</span><input id="s3-prefix" value="${esc(settings?.prefix || 'mongopilot')}" /></label>
      </div>
      <div class="row mt">
        <label><span class="lbl">Access key ID ${settings ? `(current: ${esc(settings.accessKeyIdMasked)})` : ''}</span><input id="s3-key" placeholder="AKIA…" /></label>
        <label><span class="lbl">Secret access key</span><input id="s3-secret" type="password" /></label>
        <button class="primary" onclick="h.saveS3()">Save settings</button>
      </div>
      <div class="muted mt">Credentials are stored encrypted (AES-256-GCM) on the server. Use an IAM user restricted to this bucket (s3:PutObject, s3:ListBucket, s3:DeleteObject).</div>
    </div>
    <div class="card">
      <h2>Backup history (all instances)</h2>
      ${history.length === 0 ? '<div class="muted">No backups yet. Schedule them per instance: Instance → Backup tab.</div>' : `
      <table><thead><tr><th>When</th><th>Instance</th><th>Status</th><th>Size</th><th>S3 key</th></tr></thead><tbody>
        ${history.map((hh) => `<tr>
          <td>${new Date(hh.at).toLocaleString()}</td>
          <td><a href="#/instance/${esc(hh.instance)}/backup">${esc(hh.instance)}</a></td>
          <td>${badge(hh.status)}</td>
          <td>${fmtBytes(hh.sizeBytes)}</td>
          <td class="mono">${esc(hh.key || hh.error || '')}</td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>`;
}

async function pageSettings() {
  layout('settings', `<h1>Settings</h1><p class="page-sub">Panel account and system information.</p><div id="body" class="muted">Loading…</div>`);
  const ep = epoch;
  const info = await api('/system');
  if (ep !== epoch) return;
  const body = document.getElementById('body');
  body.innerHTML = `
    <div class="card">
      <h2>Change panel password</h2>
      <div class="row">
        <label><span class="lbl">Current password</span><input id="cp-cur" type="password" /></label>
        <label><span class="lbl">New password (8+ chars)</span><input id="cp-new" type="password" /></label>
        <button class="primary" onclick="h.changePanelPassword()">Change</button>
      </div>
    </div>
    <div class="card">
      <h2>About</h2>
      <table>
        <tr><td>MongoPilot</td><td class="mono">v${esc(info.app.version)}${info.app.devMode ? ' (dev mode)' : ''}</td></tr>
        <tr><td>Node.js</td><td class="mono">${esc(info.app.node)}</td></tr>
        <tr><td>OS</td><td class="mono">${esc(info.os.pretty)} (${esc(info.os.arch)})</td></tr>
        <tr><td>Instances</td><td class="mono">${info.instanceCount}</td></tr>
      </table>
    </div>`;
}

/* ---------------- action handlers ---------------- */

window.h = {
  login: act(async () => {
    const r = await api('/auth/login', { method: 'POST', body: { username: val('l-user'), password: val('l-pass') } });
    token = r.token;
    who = r.username;
    localStorage.setItem('mp_token', token);
    localStorage.setItem('mp_user', who);
    location.hash = '#/dashboard';
    route();
  }),

  logout() {
    token = null;
    localStorage.removeItem('mp_token');
    renderLogin();
  },

  refreshTab() { route(); },

  installVersion: act(async (series) => {
    const version = val('sel-' + series);
    const r = await api('/versions/install', { method: 'POST', body: { version } });
    document.getElementById('job-card').style.display = '';
    toast(`Installing MongoDB ${version}…`);
    watchJob(r.jobId, 'job-log', () => route());
  }),

  removeVersion: act(async (version) => {
    if (!confirm(`Remove MongoDB ${version} binaries?`)) return;
    await api('/versions/' + version, { method: 'DELETE' });
    toast(`Removed ${version}`);
    route();
  }),

  createInstance: act(async () => {
    const body = { name: val('ni-name'), version: val('ni-version'), port: val('ni-port'), bindIp: val('ni-bind') };
    await api('/instances', { method: 'POST', body });
    toast(`Instance "${body.name}" created and started`);
    location.hash = `#/instance/${body.name}`;
  }),

  instAction: act(async (name, action) => {
    await api(`/instances/${name}/action`, { method: 'POST', body: { action } });
    toast(`${action} → ${name}`);
    setTimeout(route, 800);
  }),

  saveConfig: act(async (name) => {
    await api(`/instances/${name}/config`, { method: 'PUT', body: { port: val('cfg-port'), bindIp: val('cfg-bind') } });
    toast('Configuration saved, instance restarted');
    route();
  }),

  deleteInstance: act(async (name) => {
    if (!confirm(`Delete instance "${name}"? Its systemd service will be removed.`)) return;
    const purge = confirm('ALSO DELETE ITS DATA DIRECTORY?\n\nOK = delete data permanently\nCancel = keep data on disk');
    await api(`/instances/${name}?purge=${purge ? 1 : 0}`, { method: 'DELETE' });
    toast(`Instance "${name}" deleted`);
    location.hash = '#/instances';
  }),

  enableAuth: act(async (name) => {
    await api(`/instances/${name}/auth`, { method: 'POST', body: { username: val('au-user'), password: val('au-pass') } });
    toast('Authentication enabled — instance restarted');
    route();
  }),

  createUser: act(async (name) => {
    const db = val('nu-db') || 'admin';
    await api(`/instances/${name}/users`, {
      method: 'POST',
      body: { username: val('nu-user'), password: val('nu-pass'), db, roles: [{ role: val('nu-role'), db }] },
    });
    toast('User created');
    route();
  }),

  dropUser: act(async (name, db, user) => {
    if (!confirm(`Drop user ${user}@${db}?`)) return;
    await api(`/instances/${name}/users/${encodeURIComponent(db)}/${encodeURIComponent(user)}`, { method: 'DELETE' });
    toast('User dropped');
    route();
  }),

  changePassword: act(async (name, db, user) => {
    const password = prompt(`New password for ${user}@${db} (8+ chars):`);
    if (!password) return;
    await api(`/instances/${name}/users/${encodeURIComponent(db)}/${encodeURIComponent(user)}/password`, { method: 'PUT', body: { password } });
    toast('Password changed');
  }),

  createDb: act(async (name) => {
    await api(`/instances/${name}/databases`, { method: 'POST', body: { db: val('nd-name'), collection: val('nd-coll') } });
    toast('Database created');
    route();
  }),

  dropDb: act(async (name, db) => {
    if (!confirm(`DROP database "${db}"? This deletes all its data.`)) return;
    await api(`/instances/${name}/databases/${encodeURIComponent(db)}`, { method: 'DELETE' });
    toast(`Dropped ${db}`);
    route();
  }),

  fwAllow: act(async () => {
    await api('/firewall/allow', { method: 'POST', body: { port: val('fw-port'), cidr: val('fw-cidr') || 'any' } });
    toast('Rule added');
    route();
  }),

  fwRevoke: act(async () => {
    await api('/firewall/revoke', { method: 'POST', body: { port: val('fw-port'), cidr: val('fw-cidr') || 'any' } });
    toast('Rule removed');
    route();
  }),

  saveS3: act(async () => {
    await api('/backups/settings', {
      method: 'PUT',
      body: { region: val('s3-region'), bucket: val('s3-bucket'), prefix: val('s3-prefix'), accessKeyId: val('s3-key'), secretAccessKey: val('s3-secret') },
    });
    toast('S3 settings saved');
    route();
  }),

  saveSchedule: act(async (name) => {
    await api(`/instances/${name}/backup-schedule`, { method: 'PUT', body: { cron: val('bk-cron'), retention: val('bk-ret') } });
    toast('Backup schedule saved');
  }),

  runBackup: act(async (name) => {
    const r = await api(`/instances/${name}/backup`, { method: 'POST' });
    document.getElementById('job-card').style.display = '';
    toast('Backup started…');
    watchJob(r.jobId, 'job-log', () => route());
  }),

  changePanelPassword: act(async () => {
    await api('/auth/change-password', { method: 'POST', body: { currentPassword: val('cp-cur'), newPassword: val('cp-new') } });
    toast('Panel password changed');
    route();
  }),

  /* replica sets */

  rsBindChanged(prefix) {
    // binding beyond localhost usually means other machines connect, so they
    // need a reachable advertised address rather than 127.0.0.1
    const bind = val(prefix + '-bind');
    const host = document.getElementById(prefix + '-host');
    const lan = [...document.querySelectorAll('#rs-hosts option')].map((o) => o.value).find((x) => !isLoopbackHost(x) && /^[0-9.]+$/.test(x));
    if (host && bind && bind !== '127.0.0.1' && isLoopbackHost(host.value.trim()) && lan) host.value = lan;
  },

  startJob(jobId, onDone) {
    const card = document.getElementById('job-card');
    card.style.display = '';
    document.getElementById('job-log').textContent = '';
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    watchJob(jobId, 'job-log', onDone);
  },

  createReplSet: act(async () => {
    const withAuth = document.getElementById('rc-auth').checked;
    const name = val('rc-name');
    const r = await api('/replsets', {
      method: 'POST',
      body: {
        name,
        version: val('rc-version'),
        members: Number(val('rc-members')),
        port: val('rc-port'),
        bindIp: val('rc-bind'),
        advertiseHost: val('rc-host'),
        auth: withAuth ? { username: val('rc-user'), password: document.getElementById('rc-pass').value } : null,
      },
    });
    toast(`Creating replica set "${name}"…`);
    h.startJob(r.jobId, (job) => { if (job.status === 'done') location.hash = '#/replset/' + name; });
  }),

  convertReplSet: act(async () => {
    const name = val('cv-name');
    const inst = val('cv-inst');
    if (!confirm(`Convert "${inst}" into replica set "${name}"? The instance restarts; its data is kept.`)) return;
    const r = await api('/replsets/convert', { method: 'POST', body: { instance: inst, name, advertiseHost: val('cv-host') } });
    h.startJob(r.jobId, (job) => { if (job.status === 'done') location.hash = '#/replset/' + name; });
  }),

  joinReplSet: act(async () => {
    const name = val('jn-name');
    const keyFile = val('jn-key');
    const r = await api('/replsets/join', {
      method: 'POST',
      body: {
        name,
        version: val('jn-version'),
        port: val('jn-port'),
        bindIp: val('jn-bind'),
        advertiseHost: val('jn-host'),
        keyFile,
        auth: keyFile ? { username: val('jn-user'), password: document.getElementById('jn-pass').value } : null,
      },
    });
    h.startJob(r.jobId);
  }),

  rsAddLocal: act(async (name) => {
    const r = await api(`/replsets/${name}/members`, { method: 'POST', body: { type: 'local', port: val('am-port') } });
    h.startJob(r.jobId);
  }),

  rsAddRemote: act(async (name) => {
    const r = await api(`/replsets/${name}/members`, { method: 'POST', body: { type: 'remote', host: val('am-host') } });
    h.startJob(r.jobId);
  }),

  rsRemove: act(async (name, host, isLocal) => {
    if (!confirm(`Remove ${host} from replica set "${name}"?${isLocal ? '\n\nIts instance on this server will be stopped and deleted.' : ''}`)) return;
    const purge = isLocal ? confirm('ALSO DELETE ITS DATA DIRECTORY?\n\nOK = delete data permanently\nCancel = keep data on disk') : false;
    const r = await api(`/replsets/${name}/members/remove`, { method: 'POST', body: { host, purge } });
    h.startJob(r.jobId);
  }),

  rsNetwork: act(async (name) => {
    const bindIp = val('na-bind');
    const advertiseHost = val('na-host');
    if (!confirm(`Change network access for "${name}"?\n\nBind IP: ${bindIp}\nAdvertised host: ${advertiseHost}\n\nMembers restart one at a time; the set stays available.`)) return;
    const r = await api(`/replsets/${name}/network`, { method: 'PUT', body: { bindIp, advertiseHost } });
    h.startJob(r.jobId, (job) => { if (job.status === 'done') route(); });
  }),

  rsStepDown: act(async (name) => {
    if (!confirm('Step down the primary? A secondary takes over within seconds; clients reconnect automatically.')) return;
    await api(`/replsets/${name}/stepdown`, { method: 'POST' });
    toast('Primary stepped down; an election is running');
  }),

  rsShowKey: act(async (name) => {
    const r = await api(`/replsets/${name}/keyfile`);
    const el = document.getElementById('rs-key');
    el.textContent = r.keyFile || '(no keyfile)';
    el.style.display = '';
  }),

  rsDelete: act(async (name) => {
    if (!confirm(`Delete replica set "${name}"? All of its members on this server are stopped and their systemd services removed.`)) return;
    const purge = confirm('ALSO DELETE THE MEMBERS\' DATA DIRECTORIES?\n\nOK = delete data permanently\nCancel = keep data on disk');
    await api(`/replsets/${name}?purge=${purge ? 1 : 0}`, { method: 'DELETE' });
    toast(`Replica set "${name}" deleted`);
    location.hash = '#/replsets';
  }),
};

route();
