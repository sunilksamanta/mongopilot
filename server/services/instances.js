const fs = require('fs');
const path = require('path');
const config = require('../config');
const { state, save } = require('../store');
const { run, systemctl } = require('./system');
const { NAME_RE } = require('../util');
const mongo = require('./mongo');

const UNIT_DIR = '/etc/systemd/system';

function unitName(name) {
  return `mongopilot-${name}.service`;
}

function instDir(name) {
  return path.join(config.dataDir, 'instances', name);
}

function get(name) {
  const inst = state.instances.find((x) => x.name === name);
  if (!inst) {
    const e = new Error(`No such instance: ${name}`);
    e.statusCode = 404;
    throw e;
  }
  return inst;
}

function requireLinux() {
  if (!config.isLinux) {
    throw new Error('This operation manages systemd services and requires a Linux server (you are in dev mode)');
  }
}

function effectiveBindIp(inst) {
  // The panel manages instances over localhost, so 127.0.0.1 must always be bound.
  let bind = (inst.bindIp || '127.0.0.1').trim();
  const parts = bind.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.includes('0.0.0.0') && !parts.includes('127.0.0.1')) parts.unshift('127.0.0.1');
  return parts.join(',');
}

function mongodConf(inst) {
  const dir = instDir(inst.name);
  const lines = [
    'storage:',
    `  dbPath: ${path.join(dir, 'data')}`,
    'systemLog:',
    '  destination: file',
    `  path: ${path.join(dir, 'mongod.log')}`,
    '  logAppend: true',
    'net:',
    `  port: ${inst.port}`,
    `  bindIp: ${effectiveBindIp(inst)}`,
    'processManagement:',
    '  fork: false',
  ];
  if (inst.authEnabled) {
    lines.push('security:', '  authorization: enabled');
  }
  return lines.join('\n') + '\n';
}

function unitFile(inst) {
  const mongod = path.join(config.binDir, inst.version, 'bin', 'mongod');
  const conf = path.join(instDir(inst.name), 'mongod.conf');
  return `[Unit]
Description=MongoDB ${inst.version} instance "${inst.name}" (managed by MongoPilot)
After=network.target

[Service]
Type=simple
User=mongopilot
Group=mongopilot
ExecStart=${mongod} --config ${conf}
Restart=on-failure
RestartSec=5
LimitNOFILE=64000
LimitNPROC=64000

[Install]
WantedBy=multi-user.target
`;
}

async function writeArtifacts(inst) {
  fs.writeFileSync(path.join(instDir(inst.name), 'mongod.conf'), mongodConf(inst));
  if (config.isLinux) {
    fs.writeFileSync(path.join(UNIT_DIR, unitName(inst.name)), unitFile(inst));
    await run('chown', ['-R', 'mongopilot:mongopilot', instDir(inst.name)]);
    await systemctl.reload();
  }
}

async function create({ name, version, port, bindIp = '127.0.0.1' }) {
  if (!NAME_RE.test(String(name || ''))) {
    throw new Error('Name must be 2-31 chars: lowercase letters, digits, hyphens; starting with a letter');
  }
  if (state.instances.some((i) => i.name === name)) throw new Error(`Instance "${name}" already exists`);
  port = Number(port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024-65535');
  if (state.instances.some((i) => i.port === port)) throw new Error(`Port ${port} is already used by another instance`);
  if (!fs.existsSync(path.join(config.binDir, version, 'bin', 'mongod'))) {
    throw new Error(`MongoDB ${version} is not installed — install it from the Versions page first`);
  }

  const inst = {
    name,
    version,
    port,
    bindIp: String(bindIp || '127.0.0.1').trim(),
    authEnabled: false,
    adminUser: null,
    adminPassEnc: null,
    backupSchedule: null,
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.join(instDir(name), 'data'), { recursive: true });
  await writeArtifacts(inst);
  if (config.isLinux) {
    await systemctl.enable(unitName(name));
    await systemctl.start(unitName(name));
  }
  state.instances.push(inst);
  save();
  return inst;
}

async function status(inst) {
  if (!config.isLinux) return { state: 'unknown', pid: null, memoryBytes: null, since: null };
  const st = await systemctl.isActive(unitName(inst.name));
  const props = await systemctl.show(unitName(inst.name), ['MainPID', 'MemoryCurrent', 'ActiveEnterTimestamp']);
  const mem = Number(props.MemoryCurrent);
  return {
    state: st,
    pid: Number(props.MainPID) || null,
    memoryBytes: Number.isFinite(mem) && mem > 0 ? mem : null,
    since: props.ActiveEnterTimestamp || null,
  };
}

async function action(name, act) {
  get(name);
  requireLinux();
  if (!['start', 'stop', 'restart'].includes(act)) throw new Error(`Invalid action: ${act}`);
  await systemctl[act](unitName(name));
}

async function updateConfig(name, { port, bindIp }) {
  const inst = get(name);
  if (port !== undefined && port !== null && port !== '') {
    port = Number(port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024-65535');
    if (state.instances.some((i) => i.name !== name && i.port === port)) {
      throw new Error(`Port ${port} is already used by another instance`);
    }
    inst.port = port;
  }
  if (bindIp !== undefined) inst.bindIp = String(bindIp).trim() || '127.0.0.1';
  await writeArtifacts(inst);
  save();
  if (config.isLinux) await systemctl.restart(unitName(name));
  return inst;
}

// Creates the first admin (root) user via the localhost exception,
// then turns on security.authorization and restarts the instance.
async function enableAuth(name, username, password) {
  const inst = get(name);
  if (inst.authEnabled) throw new Error('Authentication is already enabled on this instance');
  await mongo.withClient(inst, (c) =>
    c.db('admin').command({ createUser: username, pwd: password, roles: [{ role: 'root', db: 'admin' }] })
  );
  inst.authEnabled = true;
  inst.adminUser = username;
  inst.adminPassEnc = config.encrypt(password);
  await writeArtifacts(inst);
  save();
  if (config.isLinux) await systemctl.restart(unitName(name));
  return inst;
}

async function remove(name, { purgeData = false } = {}) {
  get(name);
  if (config.isLinux) {
    await systemctl.stop(unitName(name));
    await systemctl.disable(unitName(name));
    fs.rmSync(path.join(UNIT_DIR, unitName(name)), { force: true });
    await systemctl.reload();
  }
  state.instances = state.instances.filter((i) => i.name !== name);
  save();
  if (purgeData) fs.rmSync(instDir(name), { recursive: true, force: true });
}

function tailLog(name, lines = 200) {
  get(name);
  const p = path.join(instDir(name), 'mongod.log');
  if (!fs.existsSync(p)) return '';
  const size = fs.statSync(p).size;
  const start = Math.max(0, size - 128 * 1024);
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf8').split('\n').slice(-lines).join('\n');
}

module.exports = {
  get,
  create,
  status,
  action,
  updateConfig,
  enableAuth,
  remove,
  tailLog,
  instDir,
  unitName,
};
