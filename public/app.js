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

function drawChart(canvas, values, { color = '#4f8ef7', format = (v) => String(Math.round(v)) } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = (canvas.width = canvas.clientWidth * dpr);
  const H = (canvas.height = canvas.clientHeight * dpr);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const pts = values.filter((v) => v != null && !isNaN(v));
  if (pts.length < 2) {
    ctx.fillStyle = '#667';
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
  ctx.fillStyle = '#8b93a7';
  ctx.font = `${11 * dpr}px sans-serif`;
  ctx.fillText(format(max), pad, 13 * dpr);
  ctx.fillText(format(min), pad, H - 8 * dpr);
}

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

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
  ['dashboard', 'Dashboard'],
  ['instances', 'Instances'],
  ['versions', 'Versions'],
  ['firewall', 'Firewall'],
  ['backups', 'Backups'],
  ['settings', 'Settings'],
];

function layout(active, content) {
  APP.innerHTML = `
    <div class="shell">
      <div class="sidebar">
        <div class="logo">🍃 Mongo<span>Pilot</span></div>
        ${NAV.map(([k, label]) => `<a class="nav-item ${k === active ? 'active' : ''}" href="#/${k}">${label}</a>`).join('')}
        <div class="spacer"></div>
        <div class="whoami">Signed in as <b>${esc(who)}</b><br/><a href="#" onclick="h.logout();return false">Log out</a></div>
      </div>
      <div class="main">${content}</div>
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
      <h1>🍃 Mongo<span style="color:var(--accent)">Pilot</span></h1>
      <label><span class="lbl">Username</span><input id="l-user" autocomplete="username" /></label>
      <label><span class="lbl">Password</span><input id="l-pass" type="password" autocomplete="current-password" /></label>
      <button class="primary" style="width:100%" onclick="h.login()">Sign in</button>
    </div></div>`;
  document.getElementById('l-pass').addEventListener('keydown', (e) => e.key === 'Enter' && h.login());
  document.getElementById('l-user').focus();
}

/* ---------------- pages ---------------- */

async function pageDashboard() {
  layout('dashboard', `<h1>Dashboard</h1><div id="body" class="muted">Loading…</div>`);
  const ep = epoch;
  const load = act(async () => {
    const [info, metrics, insts] = await Promise.all([api('/system'), api('/system/metrics'), api('/instances')]);
    if (ep !== epoch) return;
    const last = metrics[metrics.length - 1] || {};
    const disk = last.disk;
    const body = document.getElementById('body');
    if (!body) return;
    body.innerHTML = `
      ${info.app.devMode ? `<div class="card" style="border-color:var(--warn)">⚠️ <b>Dev mode</b> — running without <code>/etc/mongopilot/config.json</code>. Instance/firewall operations need a Linux server.</div>` : ''}
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
            <td><a href="#/instance/${i.name}">manage →</a></td>
          </tr>`).join('')}
        </tbody></table>`}
      </div>
      <div class="grid cols-2">
        <div class="card"><h2>CPU %</h2><canvas class="chart" id="c-cpu"></canvas></div>
        <div class="card"><h2>Memory used</h2><canvas class="chart" id="c-mem"></canvas></div>
      </div>`;
    drawChart(document.getElementById('c-cpu'), metrics.map((m) => m.cpuPct), { color: '#4f8ef7', format: (v) => Math.round(v) + '%' });
    drawChart(document.getElementById('c-mem'), metrics.map((m) => m.memTotal - m.memFree), { color: '#21ba6b', format: fmtBytes });
  });
  await load();
  pollTimer = setInterval(load, 10000);
}

async function pageVersions() {
  layout('versions', `<h1>MongoDB Versions</h1><div id="body" class="muted">Loading catalog…</div>`);
  const ep = epoch;
  const data = await api('/versions');
  if (ep !== epoch) return;
  const body = document.getElementById('body');
  const bySeries = {};
  for (const c of data.catalog) (bySeries[c.series] ||= []).push(c);
  const seriesKeys = Object.keys(bySeries).sort((a, b) => parseFloat(b) - parseFloat(a));

  body.innerHTML = `
    ${data.catalogError ? `<div class="card" style="border-color:var(--danger)">Could not load the release catalog: ${esc(data.catalogError)}</div>` : ''}
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
  layout('instances', `<h1>Instances</h1><div id="body" class="muted">Loading…</div>`);
  const ep = epoch;
  const load = act(async () => {
    const [insts, vers] = await Promise.all([api('/instances'), api('/versions')]);
    if (ep !== epoch) return;
    const body = document.getElementById('body');
    if (!body) return;
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
    body.innerHTML = `
      <div class="card"><h2>New instance</h2>${createForm}</div>
      <div class="card">
        <h2>Existing instances</h2>
        ${insts.length === 0 ? '<div class="muted">None yet.</div>' : `
        <table><thead><tr><th>Name</th><th>Version</th><th>Port</th><th>Bind</th><th>Status</th><th>Auth</th><th></th></tr></thead><tbody>
          ${insts.map((i) => `<tr>
            <td><a href="#/instance/${i.name}">${esc(i.name)}</a></td>
            <td class="mono">${esc(i.version)}</td>
            <td class="mono">${i.port}</td>
            <td class="mono">${esc(i.bindIp)}</td>
            <td>${badge(i.status.state)}</td>
            <td>${i.authEnabled ? '<span class="badge ok">on</span>' : '<span class="badge warn">off</span>'}</td>
            <td class="flex">
              <button class="sm" onclick="h.instAction('${i.name}','start')">Start</button>
              <button class="sm" onclick="h.instAction('${i.name}','restart')">Restart</button>
              <button class="sm" onclick="h.instAction('${i.name}','stop')">Stop</button>
              <a href="#/instance/${i.name}"><button class="sm">Manage</button></a>
            </td>
          </tr>`).join('')}
        </tbody></table>`}
      </div>`;
  });
  await load();
  pollTimer = setInterval(load, 8000);
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
  const load = act(async () => {
    const i = await api('/instances/' + name);
    if (ep !== epoch) return;
    const body = document.getElementById('body');
    if (!body) return;
    const connStr = i.authEnabled
      ? `mongodb://${esc(i.adminUser)}:<password>@<server-ip>:${i.port}/?authSource=admin`
      : `mongodb://<server-ip>:${i.port}/`;
    body.innerHTML = `
      <div class="grid cols-4">
        <div class="card stat"><div class="label">Status</div><div class="value">${badge(i.status.state)}</div><div class="sub">${i.status.pid ? 'pid ' + i.status.pid : ''}</div></div>
        <div class="card stat"><div class="label">Version</div><div class="value">${esc(i.version)}</div></div>
        <div class="card stat"><div class="label">Memory</div><div class="value">${fmtBytes(i.status.memoryBytes)}</div></div>
        <div class="card stat"><div class="label">Auth</div><div class="value">${i.authEnabled ? '<span class="badge ok">enabled</span>' : '<span class="badge warn">open</span>'}</div></div>
      </div>
      <div class="card">
        <h2>Controls</h2>
        <div class="flex">
          <button onclick="h.instAction('${name}','start')">Start</button>
          <button onclick="h.instAction('${name}','restart')">Restart</button>
          <button onclick="h.instAction('${name}','stop')">Stop</button>
          <button class="danger right" onclick="h.deleteInstance('${name}')">Delete instance…</button>
        </div>
      </div>
      <div class="card">
        <h2>Network configuration</h2>
        <div class="row">
          <label><span class="lbl">Port</span><input id="cfg-port" type="number" value="${i.port}" /></label>
          <label><span class="lbl">Bind IP (comma separated; 0.0.0.0 = all)</span><input id="cfg-bind" value="${esc(i.bindIp)}" /></label>
          <button class="primary" onclick="h.saveConfig('${name}')">Save & restart</button>
        </div>
        <div class="muted mt">Remember to also open the port for allowed client IPs on the <a href="#/firewall">Firewall</a> page.</div>
      </div>
      <div class="card">
        <h2>Connection string</h2>
        <code>${connStr}</code>
        <div class="muted mt">systemd unit: <code>mongopilot-${esc(name)}.service</code></div>
      </div>`;
  });
  await load();
  pollTimer = setInterval(load, 8000);
}

const COMMON_ROLES = ['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin', 'readAnyDatabase', 'readWriteAnyDatabase', 'dbAdminAnyDatabase', 'userAdminAnyDatabase', 'clusterMonitor', 'backup', 'restore', 'root'];

async function tabSecurity(name) {
  const ep = epoch;
  const i = await api('/instances/' + name);
  if (ep !== epoch) return;
  const body = document.getElementById('body');
  if (!i.authEnabled) {
    body.innerHTML = `
      <div class="card" style="border-color:var(--warn)">
        <h2>⚠️ Authentication is disabled</h2>
        <p class="muted">This instance accepts unauthenticated connections. Create the first admin (root) user — MongoPilot will then enable <code>security.authorization</code> and restart the instance.</p>
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
    drawChart(document.getElementById('m-conn'), m.map((p) => p.connections), { color: '#4f8ef7' });
    drawChart(document.getElementById('m-mem'), m.map((p) => p.residentMB), { color: '#21ba6b' });
    drawChart(document.getElementById('m-read'), m.map((p) => p.opsRead), { color: '#d9a520', format: (v) => v.toFixed(1) });
    drawChart(document.getElementById('m-write'), m.map((p) => p.opsWrite), { color: '#e5534b', format: (v) => v.toFixed(1) });
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
    ${!settings ? `<div class="card" style="border-color:var(--warn)">⚠️ S3 is not configured yet — set bucket & credentials on the <a href="#/backups">Backups</a> page first.</div>` : `
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

async function pageFirewall() {
  layout('firewall', `<h1>Firewall / IP allowlist</h1><div id="body" class="muted">Loading…</div>`);
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
  layout('backups', `<h1>Backups (AWS S3)</h1><div id="body" class="muted">Loading…</div>`);
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
  layout('settings', `<h1>Settings</h1><div id="body" class="muted">Loading…</div>`);
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
};

route();
