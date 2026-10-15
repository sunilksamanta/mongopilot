const fs = require('fs');
const path = require('path');
const config = require('../config');
const { state, save } = require('../store');
const { run, systemctl } = require('./system');
const { NAME_RE } = require('../util');
const mongo = require('./mongo');
const { portFree } = require('./netutil');

const UNIT_DIR = '/etc/systemd/system';

function unitName(name) {
  return `mongopilot-${name}.service`;
}

function instDir(name) {
  return path.join(config.dataDir, 'instances', name);
}

function keyFilePath(name) {
  return path.join(instDir(name), 'keyfile');
}

function replSetOf(inst) {
  return inst.replSet ? (state.replicaSets || []).find((r) => r.name === inst.replSet) || null : null;
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
  // Replica set members reach each other on the advertised address, so it must be bound too.
  const rs = replSetOf(inst);
  if (rs && rs.advertiseIp && !parts.includes('0.0.0.0') && !parts.includes(rs.advertiseIp)) parts.push(rs.advertiseIp);
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
  const rs = replSetOf(inst);
  if (inst.replSet) {
    lines.push('replication:', `  replSetName: ${inst.replSet}`);
  }
  const sec = [];
  // Members of an authenticated replica set authenticate to each other with a shared keyfile.
  if (rs && rs.keyFileEnc) sec.push(`  keyFile: ${keyFilePath(inst.name)}`);
  if (inst.authEnabled) sec.push('  authorization: enabled');
  if (sec.length) lines.push('security:', ...sec);
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
  const rs = replSetOf(inst);
  const kf = keyFilePath(inst.name);
  if (rs && rs.keyFileEnc) {
    fs.writeFileSync(kf, config.decrypt(rs.keyFileEnc) + '\n');
    fs.chmodSync(kf, 0o400); // mongod refuses keyfiles readable by group/others
  } else {
    fs.rmSync(kf, { force: true });
  }
  fs.writeFileSync(path.join(instDir(inst.name), 'mongod.conf'), mongodConf(inst));
  if (config.isLinux) {
    fs.writeFileSync(path.join(UNIT_DIR, unitName(inst.name)), unitFile(inst));
    await run('chown', ['-R', 'mongopilot:mongopilot', instDir(inst.name)]);
    await systemctl.reload();
  }
}

// `extra` is used by the replica set service to create members
// (replSet, authEnabled, adminUser, adminPassEnc).
async function create({ name, version, port, bindIp = '127.0.0.1' }, extra = {}) {
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
  if (!(await portFree(port))) throw new Error(`Port ${port} is already in use by another process on this server`);

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
    ...extra,
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
    if (inst.replSet && port !== inst.port) {
      throw new Error(`"${name}" is a member of replica set "${inst.replSet}"; its port is part of the replica set config and cannot be changed here`);
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
  if (inst.replSet) throw new Error('This instance is a replica set member; enable authentication for the whole set instead');
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

// `force` is used by the replica set service after the member has left the set.
async function remove(name, { purgeData = false, force = false } = {}) {
  const inst = get(name);
  if (inst.replSet && !force) {
    throw new Error(`"${name}" is a member of replica set "${inst.replSet}"; remove it from the Replica Sets page so the set is reconfigured first`);
  }
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
  writeArtifacts,
  requireLinux,
  effectiveBindIp,
};
