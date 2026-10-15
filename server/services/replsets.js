const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { state, save } = require('../store');
const { NAME_RE } = require('../util');
const instances = require('./instances');
const mongo = require('./mongo');
const jobs = require('./jobs');
const netutil = require('./netutil');
const { systemctl } = require('./system');

const MAX_MEMBERS = 7; // a replica set has at most 7 voting members
const KEYFILE_RE = /^[A-Za-z0-9+/=]{6,1024}$/;
const busy = new Set(); // replica set names with a job in flight

/* ---------------- helpers ---------------- */

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

function get(name) {
  const rs = state.replicaSets.find((r) => r.name === name);
  if (!rs) {
    const e = new Error(`No such replica set: ${name}`);
    e.statusCode = 404;
    throw e;
  }
  return rs;
}

function localMembers(rs) {
  return state.instances.filter((i) => i.replSet === rs.name).sort((a, b) => a.port - b.port);
}

function pub(rs) {
  const { adminPassEnc, keyFileEnc, ...rest } = rs;
  return { ...rest, hasKeyFile: !!keyFileEnc, members: localMembers(rs).map((i) => i.name) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${what}${lastErr ? ` (${lastErr.message})` : ''}`);
}

function runJob(type, rsName, fn) {
  if (busy.has(rsName)) throw badRequest(`Another operation is already running on replica set "${rsName}"`);
  busy.add(rsName);
  const job = jobs.create(type, { replicaSet: rsName });
  const log = (m) => jobs.logTo(job, m);
  Promise.resolve()
    .then(() => fn(log))
    .then(
      () => jobs.finish(job),
      (e) => jobs.finish(job, e)
    )
    .finally(() => busy.delete(rsName));
  return job;
}

function validateSetName(name) {
  name = String(name || '').trim();
  // members are named "<set>-<n>", which must still fit the instance name rules
  if (!NAME_RE.test(name) || name.length > 27) {
    throw badRequest('Replica set name must be 2-27 chars: lowercase letters, digits, hyphens; starting with a letter');
  }
  if (state.replicaSets.some((r) => r.name === name)) throw badRequest(`Replica set "${name}" already exists`);
  return name;
}

function validatePort(port) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw badRequest('Port must be 1024-65535');
  if (state.instances.some((i) => i.port === port)) throw badRequest(`Port ${port} is already used by another instance`);
  return port;
}

function validateAuth(auth) {
  if (!auth) return null;
  const username = String(auth.username || '').trim();
  const password = String(auth.password || '');
  if (!username) throw badRequest('Admin username is required when authentication is enabled');
  if (password.length < 8) throw badRequest('Admin password must be at least 8 characters');
  return { username, password };
}

function requireVersion(version) {
  if (!version || !fs.existsSync(path.join(config.binDir, version, 'bin', 'mongod'))) {
    throw badRequest(`MongoDB ${version || '(none)'} is not installed. Install it from the Versions page first`);
  }
}

// Validates the address members advertise in the replica set config. Every
// member and every client must be able to reach <advertiseHost>:<port>, and
// each mongod must recognise its own entry, so the address has to belong to
// this server. advertiseIp is set when the address must be added to bindIp.
async function resolveAdvertise(host) {
  host = String(host || '').trim() || '127.0.0.1';
  if (!netutil.HOST_RE.test(host)) throw badRequest(`Invalid advertised host "${host}"`);
  if (netutil.isLoopback(host)) return { advertiseHost: host, advertiseIp: null, loopback: true };
  let ip;
  try {
    ip = await netutil.resolveIPv4(host);
  } catch {
    throw badRequest(`Advertised host "${host}" does not resolve on this server`);
  }
  if (netutil.isLoopback(ip)) return { advertiseHost: host, advertiseIp: null, loopback: true };
  const local = netutil.localAddresses().some((a) => a.address === ip);
  return { advertiseHost: host, advertiseIp: local ? ip : null, loopback: false };
}

function nextMemberName(rsName) {
  for (let n = 1; ; n++) {
    const name = `${rsName}-${n}`;
    if (!state.instances.some((i) => i.name === name)) return name;
  }
}

function memberExtra(rs) {
  return {
    replSet: rs.name,
    authEnabled: !!rs.authEnabled,
    adminUser: rs.authEnabled ? rs.adminUser : null,
    adminPassEnc: rs.authEnabled ? rs.adminPassEnc : null,
  };
}

function newKeyFile() {
  // 756 random bytes -> 1008 base64 chars (keyfiles allow 6-1024 base64 chars)
  return crypto.randomBytes(756).toString('base64');
}

async function waitUp(inst) {
  await waitFor(`"${inst.name}" to accept connections`, () => mongo.hello(inst), { timeoutMs: 60000 });
}

async function checkReachable(rs, inst) {
  if (!(await netutil.tcpReachable(rs.advertiseHost, inst.port))) {
    throw new Error(
      `${rs.advertiseHost}:${inst.port} is not reachable. Members talk to each other on the advertised host, ` +
        `so make sure the bind IP covers it (use 0.0.0.0 or this server's IP) and that the firewall allows the port. ` +
        `Public / elastic cloud IPs are often NAT'ed and not usable here: use the private IP or a DNS name instead.`
    );
  }
}

async function findLocalPrimary(rs) {
  for (const m of localMembers(rs)) {
    try {
      if ((await mongo.hello(m)).isWritablePrimary) return m;
    } catch {}
  }
  return null;
}

// Runs fn(client) against the current primary (local or on another server).
async function withPrimaryOf(rs, fn) {
  let lastErr = null;
  for (const m of localMembers(rs)) {
    try {
      return await mongo.withPrimary(m, fn);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`Replica set "${rs.name}" has no member on this server`);
}

async function reconfig(rs, mutate) {
  return withPrimaryOf(rs, async (c) => {
    const { config: cfg } = await c.db('admin').command({ replSetGetConfig: 1 });
    mutate(cfg);
    cfg.version += 1;
    await c.db('admin').command({ replSetReconfig: cfg });
  });
}

async function memberState(rs, host) {
  const st = await withPrimaryOf(rs, (c) => c.db('admin').command({ replSetGetStatus: 1 }));
  return st.members.find((m) => m.name === host) || null;
}

// Waits for a newly added member to finish its initial sync. Large data sets can
// take much longer than a job should run, so a timeout is reported, not failed.
async function waitSynced(rs, host, log) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const m = await memberState(rs, host).catch(() => null);
    if (m) {
      if (m.stateStr !== last) {
        log(`${host} is ${m.stateStr}${m.lastHeartbeatMessage ? ` (${m.lastHeartbeatMessage})` : ''}`);
        last = m.stateStr;
      }
      if (m.state === 1 || m.state === 2) return true;
    }
    await sleep(2000);
  }
  log(`${host} has not finished its initial sync yet; it keeps syncing in the background, so watch its state on this page`);
  return false;
}

function connectionString(rs, hosts) {
  const auth = rs.authEnabled ? `${encodeURIComponent(rs.adminUser)}:<password>@` : '';
  const opts = [`replicaSet=${rs.name}`];
  if (rs.authEnabled) opts.push('authSource=admin');
  return `mongodb://${auth}${hosts.join(',')}/?${opts.join('&')}`;
}

/* ---------------- status ---------------- */

const STATE_ORDER = { PRIMARY: 0, SECONDARY: 1 };

async function status(rs) {
  const members = localMembers(rs);
  if (!members.length) return { ok: false, error: 'This replica set has no member on this server', members: [] };
  let lastErr = null;
  let notInitiated = false;
  for (const m of members) {
    try {
      const h = await mongo.hello(m);
      if (!h.setName) {
        notInitiated = true;
        continue;
      }
      const [st, { config: cfg }] = await mongo.withClient(m, (c) =>
        Promise.all([c.db('admin').command({ replSetGetStatus: 1 }), c.db('admin').command({ replSetGetConfig: 1 })])
      );
      const primary = st.members.find((x) => x.state === 1);
      const out = st.members.map((x) => {
        const cm = cfg.members.find((y) => y.host === x.name) || {};
        const [host, port] = netutil.splitHostPort(x.name);
        const local = members.find((i) => i.port === port && (netutil.isLocalHost(host) || host === rs.advertiseHost));
        const lag =
          primary && x.state === 2 && x.optimeDate && primary.optimeDate
            ? Math.max(0, Math.round((primary.optimeDate - x.optimeDate) / 1000))
            : null;
        return {
          id: x._id,
          host: x.name,
          state: x.stateStr,
          health: x.health,
          uptime: x.uptime ?? null,
          lagSeconds: lag,
          syncSource: x.syncSourceHost || '',
          // a primary's infoMessage ("Could not find member to sync from") is expected noise
          message: x.lastHeartbeatMessage || (x.state !== 1 && x.infoMessage) || '',
          priority: cm.priority ?? null,
          votes: cm.votes ?? null,
          hidden: !!cm.hidden,
          arbiterOnly: !!cm.arbiterOnly,
          instance: local ? local.name : null,
        };
      });
      out.sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || a.id - b.id);
      const hosts = cfg.members.filter((y) => !y.hidden && !y.arbiterOnly).map((y) => y.host);
      return {
        ok: true,
        primary: primary ? primary.name : null,
        healthy: out.filter((x) => x.health === 1 && ['PRIMARY', 'SECONDARY'].includes(x.state)).length,
        members: out,
        configVersion: cfg.version,
        connectionString: connectionString(rs, hosts),
      };
    } catch (e) {
      lastErr = e;
    }
  }
  if (notInitiated && rs.joined) {
    return {
      ok: false,
      pending: true,
      error: `Waiting to be added: on the server that runs the primary, open Replica Sets → ${rs.name} → Add member → "On another server" and enter ${members
        .map((m) => `${rs.advertiseHost}:${m.port}`)
        .join(', ')}`,
      members: [],
    };
  }
  if (notInitiated) return { ok: false, error: 'The replica set is not initiated yet', members: [] };
  let msg = lastErr ? lastErr.message : 'No member is reachable';
  if (rs.joined && /auth/i.test(msg)) {
    msg += '. If this member was just added, the admin user appears once its initial sync completes';
  }
  return { ok: false, error: msg, members: [] };
}

async function list() {
  return Promise.all(state.replicaSets.map(async (rs) => ({ ...pub(rs), status: await status(rs) })));
}

function hostSuggestions() {
  return {
    hostname: require('os').hostname(),
    addresses: netutil.localAddresses(),
  };
}

/* ---------------- create a new set on this server ---------------- */

async function create(spec) {
  instances.requireLinux();
  const name = validateSetName(spec.name);
  const count = Number(spec.members || 3);
  if (!Number.isInteger(count) || count < 1 || count > MAX_MEMBERS) {
    throw badRequest(`Members must be between 1 and ${MAX_MEMBERS}`);
  }
  requireVersion(spec.version);
  const basePort = Number(spec.port);
  const ports = [];
  for (let i = 0; i < count; i++) {
    const p = validatePort(basePort + i);
    if (!(await netutil.portFree(p))) throw badRequest(`Port ${p} is already in use by another process on this server`);
    ports.push(p);
  }
  for (let i = 1; i <= count; i++) {
    if (state.instances.some((x) => x.name === `${name}-${i}`)) throw badRequest(`An instance named "${name}-${i}" already exists`);
  }
  const auth = validateAuth(spec.auth);
  const adv = await resolveAdvertise(spec.advertiseHost);
  const bindIp = String(spec.bindIp || '127.0.0.1').trim();

  const rs = {
    name,
    version: spec.version,
    advertiseHost: adv.advertiseHost,
    advertiseIp: adv.advertiseIp,
    bindIp,
    authEnabled: !!auth,
    adminUser: auth ? auth.username : null,
    adminPassEnc: auth ? config.encrypt(auth.password) : null,
    keyFileEnc: auth ? config.encrypt(newKeyFile()) : null,
    joined: false,
    createdAt: new Date().toISOString(),
  };

  return runJob('create-replica-set', name, async (log) => {
    state.replicaSets.push(rs);
    save();
    const created = [];
    try {
      if (auth) log('Generated a shared keyfile for internal member authentication');
      if (adv.loopback && bindIp !== '127.0.0.1') {
        log(`Note: members advertise ${adv.advertiseHost}, so clients on other machines cannot use replica set discovery`);
      }
      for (let i = 0; i < count; i++) {
        const memberName = `${name}-${i + 1}`;
        log(`Creating member ${memberName} on port ${ports[i]}`);
        created.push(
          await instances.create({ name: memberName, version: rs.version, port: ports[i], bindIp }, memberExtra(rs))
        );
      }
      log('Waiting for all members to start');
      await Promise.all(created.map(waitUp));
      for (const m of created) await checkReachable(rs, m);

      const members = created.map((m, i) => ({ _id: i, host: `${rs.advertiseHost}:${m.port}` }));
      log(`Initiating replica set "${name}" with ${members.map((m) => m.host).join(', ')}`);
      // No users exist yet, so the localhost exception allows this even with keyfile auth on.
      await mongo.withClient(created[0], (c) => c.db('admin').command({ replSetInitiate: { _id: name, members } }), {
        auth: false,
      });

      log('Waiting for a primary to be elected');
      const primary = await waitFor('a primary to be elected', () => findLocalPrimary(rs), { timeoutMs: 90000 });
      log(`Primary elected: ${primary.name} (${rs.advertiseHost}:${primary.port})`);

      if (auth) {
        log(`Creating admin user "${auth.username}" (root)`);
        await mongo.withClient(
          primary,
          (c) =>
            c.db('admin').command({
              createUser: auth.username,
              pwd: auth.password,
              roles: [{ role: 'root', db: 'admin' }],
              writeConcern: { w: 'majority', wtimeout: 60000 },
            }),
          { auth: false }
        );
      }

      if (count > 1) {
        log('Waiting for secondaries to finish their initial sync');
        await waitFor(
          'all members to become healthy',
          async () => {
            const st = await mongo.withClient(primary, (c) => c.db('admin').command({ replSetGetStatus: 1 }));
            return st.members.every((m) => m.state === 1 || m.state === 2);
          },
          { timeoutMs: 180000, intervalMs: 2000 }
        );
      }
      log(`Replica set "${name}" is ready: 1 primary${count > 1 ? `, ${count - 1} secondar${count > 2 ? 'ies' : 'y'}` : ''}`);
      log(`Connection string: ${connectionString(rs, members.map((m) => m.host))}`);
    } catch (e) {
      log('Rolling back: removing the members created by this attempt');
      for (const m of created) {
        await instances.remove(m.name, { purgeData: true, force: true }).catch((err) => log(`  cleanup of ${m.name} failed: ${err.message}`));
      }
      state.replicaSets = state.replicaSets.filter((r) => r !== rs);
      save();
      throw e;
    }
  });
}

/* ---------------- convert a standalone instance (keeps its data) ---------------- */

async function convert(spec) {
  instances.requireLinux();
  const inst = instances.get(String(spec.instance || ''));
  if (inst.replSet) throw badRequest(`"${inst.name}" is already a member of replica set "${inst.replSet}"`);
  const name = validateSetName(spec.name);
  const adv = await resolveAdvertise(spec.advertiseHost);
  requireVersion(inst.version);

  const rs = {
    name,
    version: inst.version,
    advertiseHost: adv.advertiseHost,
    advertiseIp: adv.advertiseIp,
    bindIp: inst.bindIp,
    authEnabled: !!inst.authEnabled,
    adminUser: inst.authEnabled ? inst.adminUser : null,
    adminPassEnc: inst.authEnabled ? inst.adminPassEnc : null,
    keyFileEnc: inst.authEnabled ? config.encrypt(newKeyFile()) : null,
    joined: false,
    createdAt: new Date().toISOString(),
  };

  return runJob('convert-to-replica-set', name, async (log) => {
    state.replicaSets.push(rs);
    inst.replSet = name;
    save();
    let initiated = false;
    try {
      log(`Restarting "${inst.name}" with replSetName "${name}"${rs.keyFileEnc ? ' and a keyfile' : ''}`);
      await instances.writeArtifacts(inst);
      await systemctl.restart(instances.unitName(inst.name));
      await waitUp(inst);
      await checkReachable(rs, inst);
      const host = `${rs.advertiseHost}:${inst.port}`;
      log(`Initiating replica set "${name}" with ${host}`);
      await mongo.withClient(inst, (c) => c.db('admin').command({ replSetInitiate: { _id: name, members: [{ _id: 0, host }] } }));
      initiated = true;
      await waitFor('the instance to become primary', () => findLocalPrimary(rs), { timeoutMs: 90000 });
      log(`"${inst.name}" is now the primary of replica set "${name}"; your data is unchanged`);
      log('Add more members from the replica set page to get redundancy');
      log(`Connection string: ${connectionString(rs, [host])}`);
    } catch (e) {
      if (initiated) throw e; // the set exists; leave it for the user to inspect
      log(`Reverting "${inst.name}" to a standalone instance`);
      delete inst.replSet;
      state.replicaSets = state.replicaSets.filter((r) => r !== rs);
      save();
      await instances.writeArtifacts(inst).catch(() => {});
      await systemctl.restart(instances.unitName(inst.name)).catch(() => {});
      throw e;
    }
  });
}

/* ---------------- join a set whose primary runs on another server ---------------- */

async function join(spec) {
  instances.requireLinux();
  const name = validateSetName(spec.name);
  requireVersion(spec.version);
  const port = validatePort(spec.port);
  if (!(await netutil.portFree(port))) throw badRequest(`Port ${port} is already in use by another process on this server`);
  const keyFile = String(spec.keyFile || '').replace(/\s+/g, '');
  if (keyFile && !KEYFILE_RE.test(keyFile)) {
    throw badRequest('The keyfile must be 6-1024 base64 characters (copy it from the replica set page on the primary\'s server)');
  }
  const auth = keyFile ? validateAuth(spec.auth || {}) : null;
  const adv = await resolveAdvertise(spec.advertiseHost);
  if (adv.loopback) {
    throw badRequest('A member that joins from another server must advertise an address the other members can reach (this server\'s IP or DNS name), not 127.0.0.1');
  }
  const bindIp = String(spec.bindIp || '0.0.0.0').trim();
  const memberName = nextMemberName(name);

  const rs = {
    name,
    version: spec.version,
    advertiseHost: adv.advertiseHost,
    advertiseIp: adv.advertiseIp,
    bindIp,
    authEnabled: !!auth,
    adminUser: auth ? auth.username : null,
    adminPassEnc: auth ? config.encrypt(auth.password) : null,
    keyFileEnc: keyFile ? config.encrypt(keyFile) : null,
    joined: true,
    createdAt: new Date().toISOString(),
  };

  return runJob('join-replica-set', name, async (log) => {
    state.replicaSets.push(rs);
    save();
    let inst = null;
    try {
      log(`Creating member ${memberName} on port ${port}`);
      inst = await instances.create({ name: memberName, version: rs.version, port, bindIp }, memberExtra(rs));
      await waitUp(inst);
      await checkReachable(rs, inst);
      const host = `${rs.advertiseHost}:${port}`;
      log(`Member is running and waiting to be added to "${name}".`);
      log(`Next: on the server that runs the primary, open Replica Sets → ${name} → Add member → "On another server" and enter: ${host}`);
      log(`That server must be able to reach ${host} (open the port for it on the Firewall page), and this server must reach the existing members.`);
    } catch (e) {
      log('Rolling back');
      if (inst) await instances.remove(inst.name, { purgeData: true, force: true }).catch(() => {});
      state.replicaSets = state.replicaSets.filter((r) => r !== rs);
      save();
      throw e;
    }
  });
}

/* ---------------- membership changes ---------------- */

async function addMember(rsName, spec) {
  instances.requireLinux();
  const rs = get(rsName);
  if (spec.type === 'remote') return addRemoteMember(rs, spec);

  requireVersion(rs.version);
  const port = validatePort(spec.port);
  if (!(await netutil.portFree(port))) throw badRequest(`Port ${port} is already in use by another process on this server`);
  const memberName = nextMemberName(rs.name);

  return runJob('add-replica-set-member', rs.name, async (log) => {
    let inst = null;
    let added = false;
    const host = `${rs.advertiseHost}:${port}`;
    try {
      log(`Creating member ${memberName} on port ${port}`);
      inst = await instances.create({ name: memberName, version: rs.version, port, bindIp: rs.bindIp }, memberExtra(rs));
      await waitUp(inst);
      await checkReachable(rs, inst);
      log(`Adding ${host} to the replica set config`);
      await reconfig(rs, (cfg) => {
        if (cfg.members.length >= 50) throw new Error('A replica set can have at most 50 members');
        const voting = cfg.members.filter((m) => (m.votes ?? 1) > 0).length;
        const id = Math.max(-1, ...cfg.members.map((m) => m._id)) + 1;
        cfg.members.push(voting >= MAX_MEMBERS ? { _id: id, host, votes: 0, priority: 0 } : { _id: id, host });
      });
      added = true;
      log('Waiting for the initial sync to complete');
      await waitSynced(rs, host, log);
      log(`Member ${memberName} added`);
    } catch (e) {
      if (inst && !added) {
        log('Rolling back: removing the new member');
        await instances.remove(inst.name, { purgeData: true, force: true }).catch(() => {});
      }
      throw e;
    }
  });
}

async function addRemoteMember(rs, spec) {
  const raw = String(spec.host || '').trim();
  const [host, port] = netutil.splitHostPort(raw);
  if (!netutil.HOST_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw badRequest('Enter the remote member as host:port, e.g. 10.0.0.12:27017');
  }
  const self = await resolveAdvertise(rs.advertiseHost);
  if (self.loopback) {
    throw badRequest(
      `Members of "${rs.name}" advertise ${rs.advertiseHost}, which a remote server cannot reach. ` +
        'Replica sets spanning servers need members that advertise this server\'s IP or DNS name (create a new set with that, or convert using it).'
    );
  }
  if (netutil.isLoopback(host)) throw badRequest('A remote member cannot be a loopback address');

  return runJob('add-replica-set-member', rs.name, async (log) => {
    const target = `${host}:${port}`;
    log(`Checking that ${target} is reachable from this server`);
    if (!(await netutil.tcpReachable(host, port))) {
      throw new Error(`Cannot connect to ${target}. Check that mongod is running there, its bind IP includes that address, and its firewall allows this server`);
    }
    let h;
    try {
      h = await mongo.withClient({ port }, (c) => c.db('admin').command({ hello: 1 }), { auth: false, host, port });
    } catch (e) {
      throw new Error(`${target} accepted the connection but is not answering as MongoDB: ${e.message}`);
    }
    if (h.setName && h.setName !== rs.name) throw new Error(`${target} already belongs to replica set "${h.setName}"`);
    if (!h.setName && !h.isreplicaset) {
      throw new Error(`${target} is a standalone mongod. Start it with replSetName "${rs.name}" (on that server: Replica Sets → Join a replica set)`);
    }
    log(`Adding ${target} to the replica set config`);
    await reconfig(rs, (cfg) => {
      if (cfg.members.some((m) => m.host === target)) throw new Error(`${target} is already a member`);
      const voting = cfg.members.filter((m) => (m.votes ?? 1) > 0).length;
      const id = Math.max(-1, ...cfg.members.map((m) => m._id)) + 1;
      cfg.members.push(voting >= MAX_MEMBERS ? { _id: id, host: target, votes: 0, priority: 0 } : { _id: id, host: target });
    });
    log('Waiting for the initial sync to complete');
    await waitSynced(rs, target, log);
    log(`Member ${target} added`);
  });
}

async function removeMember(rsName, { host, purgeData = false }) {
  instances.requireLinux();
  const rs = get(rsName);
  host = String(host || '').trim();
  const st = await status(rs);
  if (!st.ok) throw badRequest(`Cannot read the replica set status: ${st.error}`);
  const member = st.members.find((m) => m.host === host);
  if (!member) throw badRequest(`${host} is not a member of "${rs.name}"`);
  if (st.members.length === 1) throw badRequest('This is the only member; delete the replica set instead');

  return runJob('remove-replica-set-member', rs.name, async (log) => {
    if (member.state === 'PRIMARY') {
      log(`${host} is the primary; stepping it down first`);
      await withPrimaryOf(rs, (c) => c.db('admin').command({ replSetStepDown: 60, secondaryCatchUpPeriodSecs: 15 })).catch(
        (e) => {
          // the server may drop the connection while stepping down
          if (!/not primary|connection|closed|interrupted/i.test(e.message)) throw e;
        }
      );
      await waitFor(
        'another member to become primary',
        async () => {
          const s = await status(rs);
          return s.primary && s.primary !== host;
        },
        { timeoutMs: 60000, intervalMs: 2000 }
      );
    }
    log(`Removing ${host} from the replica set config`);
    await reconfig(rs, (cfg) => {
      cfg.members = cfg.members.filter((m) => m.host !== host);
    });
    if (member.instance) {
      log(`Stopping and deleting local instance ${member.instance}${purgeData ? ' and its data' : ''}`);
      await instances.remove(member.instance, { purgeData, force: true });
    } else {
      log('That member runs on another server: stop or delete it there');
    }
    log(`${host} removed`);
  });
}

/* ---------------- network access (bind IP + advertised host) ---------------- */

function normalizeBind(list) {
  const parts = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
  // 0.0.0.0 already covers every interface; listing others next to it makes mongod fail to bind
  return parts.includes('0.0.0.0') ? '0.0.0.0' : parts.join(',');
}

// Restarts members one at a time so the set keeps a primary: secondaries
// first, then the primary after it has handed over to another member.
async function rollingRestart(rs, list, log) {
  const primary = await findLocalPrimary(rs);
  const order = [...list.filter((m) => m !== primary), ...list.filter((m) => m === primary)];
  for (const m of order) {
    if (m === primary && localMembers(rs).length > 1) {
      log(`Stepping down the primary ${m.name} so another member takes over`);
      await mongo.withClient(m, (c) => c.db('admin').command({ replSetStepDown: 60, secondaryCatchUpPeriodSecs: 15 })).catch((e) => {
        if (!/not primary|connection|closed|interrupted/i.test(e.message)) throw e;
      });
      await waitFor('another member to become primary', async () => {
        const p = await findLocalPrimary(rs);
        return p && p !== m;
      }, { timeoutMs: 60000 });
    }
    log(`Restarting ${m.name}`);
    await systemctl.restart(instances.unitName(m.name));
    await waitUp(m);
    await waitFor(`${m.name} to rejoin the set`, async () => {
      const h = await mongo.hello(m);
      return h.secondary || h.isWritablePrimary;
    }, { timeoutMs: 120000 });
  }
  await waitFor('a primary', () => findLocalPrimary(rs), { timeoutMs: 90000 });
}

// Changes where members listen and the address they advertise in the replica
// set config (what drivers connect to), without downtime for 2+ members.
async function updateNetwork(rsName, spec) {
  instances.requireLinux();
  const rs = get(rsName);
  const raw = String(spec.bindIp || '').trim() || '127.0.0.1';
  if (!/^[0-9a-fA-F.:,\s]+$/.test(raw)) throw badRequest('Bind IP must be IP addresses separated by commas, e.g. 0.0.0.0');
  const bindIp = normalizeBind(raw.split(','));
  const adv = await resolveAdvertise(spec.advertiseHost);
  const exposed = !adv.loopback || !bindIp.split(',').every((x) => netutil.isLoopback(x));
  if (exposed && !rs.authEnabled) {
    throw badRequest('Enable authentication first (Security & Users tab of any member): without it, anyone who can reach the ports gets full access to your data');
  }
  if (adv.loopback && bindIp !== '127.0.0.1') {
    throw badRequest(`With advertised host ${adv.advertiseHost}, drivers on other machines would be sent to their own localhost. Advertise this server's public/private IP or DNS name instead.`);
  }
  const st = await status(rs);
  if (!st.ok) throw badRequest(`Cannot read the replica set status: ${st.error}`);
  if (!st.primary) throw badRequest('The replica set has no primary right now; try again in a few seconds');
  if (st.members.some((m) => !m.instance)) {
    throw badRequest('Some members run on other servers; network settings can only be changed here when every member is on this server');
  }
  const members = localMembers(rs);

  return runJob('replica-set-network', rs.name, async (log) => {
    const oldBinds = members.map((m) => m.bindIp);
    let reconfigured = false;
    try {
      // 1. listen on the new addresses as well, so the set keeps working while it switches over
      const before = members.map((m) => instances.effectiveBindIp(m));
      for (const m of members) m.bindIp = normalizeBind([...bindIp.split(','), adv.advertiseIp || '']);
      save();
      for (const m of members) await instances.writeArtifacts(m);
      const changed = members.filter((m, i) => instances.effectiveBindIp(m) !== before[i]);
      if (changed.length) {
        log(`Binding members to ${instances.effectiveBindIp(changed[0])}`);
        await rollingRestart(rs, changed, log);
      }
      // 2. the new advertised address must reach every member
      for (const m of members) await checkReachable({ advertiseHost: adv.advertiseHost }, m);
      // 3. switch the replica set config to the new address
      log(`Updating the replica set config to advertise ${adv.advertiseHost}`);
      await reconfig(rs, (cfg) => {
        for (const cm of cfg.members) {
          const [, port] = netutil.splitHostPort(cm.host);
          if (members.some((m) => m.port === port)) cm.host = `${adv.advertiseHost}:${port}`;
        }
      });
      reconfigured = true;
      rs.advertiseHost = adv.advertiseHost;
      rs.advertiseIp = adv.advertiseIp;
      rs.bindIp = bindIp;
      for (const m of members) m.bindIp = bindIp;
      save();
      // the extra old address (if any) is dropped at the next restart
      for (const m of members) await instances.writeArtifacts(m);
      await waitFor('a primary', () => findLocalPrimary(rs), { timeoutMs: 60000 });
      const s = await status(rs);
      log('Done. Members now listen on ' + instances.effectiveBindIp(members[0]) + ` and advertise ${adv.advertiseHost}`);
      if (s.connectionString) log(`Connection string: ${s.connectionString}`);
      if (exposed) log('Remember: open these ports only to the IPs that need them (Firewall page), and use a strong password');
    } catch (e) {
      if (!reconfigured) {
        members.forEach((m, i) => (m.bindIp = oldBinds[i]));
        save();
        for (const m of members) await instances.writeArtifacts(m).catch(() => {});
        log('Kept the previous settings (members still listening on new addresses go back at their next restart)');
      }
      throw e;
    }
  });
}

async function stepDown(rsName) {
  instances.requireLinux();
  const rs = get(rsName);
  try {
    await withPrimaryOf(rs, (c) => c.db('admin').command({ replSetStepDown: 60, secondaryCatchUpPeriodSecs: 10 }));
  } catch (e) {
    if (!/connection|closed|interrupted/i.test(e.message)) throw e;
  }
}

// Turns on auth for a set that runs without it: creates the root user on the
// primary, then restarts every member with a shared keyfile + authorization.
async function enableAuth(rsName, username, password) {
  instances.requireLinux();
  const rs = get(rsName);
  if (rs.authEnabled) throw badRequest('Authentication is already enabled on this replica set');
  const auth = validateAuth({ username, password });
  const st = await status(rs);
  if (!st.ok) throw badRequest(`Cannot read the replica set status: ${st.error}`);
  if (st.members.some((m) => !m.instance)) {
    throw badRequest('Some members run on other servers; authentication can only be switched on here when every member is on this server');
  }
  await withPrimaryOf(rs, (c) =>
    c.db('admin').command({
      createUser: auth.username,
      pwd: auth.password,
      roles: [{ role: 'root', db: 'admin' }],
      writeConcern: { w: 'majority', wtimeout: 60000 },
    })
  );
  rs.authEnabled = true;
  rs.adminUser = auth.username;
  rs.adminPassEnc = config.encrypt(auth.password);
  rs.keyFileEnc = config.encrypt(newKeyFile());
  const members = localMembers(rs);
  for (const m of members) Object.assign(m, memberExtra(rs));
  save();
  for (const m of members) await instances.writeArtifacts(m);
  // all at once: members with and without a keyfile cannot talk to each other
  await Promise.all(members.map((m) => systemctl.restart(instances.unitName(m.name))));
  await waitFor('a primary after the restart', () => findLocalPrimary(rs), { timeoutMs: 90000 });
  return pub(rs);
}

async function remove(rsName, { purgeData = false } = {}) {
  instances.requireLinux();
  const rs = get(rsName);
  if (busy.has(rs.name)) throw badRequest(`Another operation is already running on replica set "${rs.name}"`);
  busy.add(rs.name);
  try {
    for (const m of localMembers(rs)) await instances.remove(m.name, { purgeData, force: true });
    state.replicaSets = state.replicaSets.filter((r) => r !== rs);
    save();
  } finally {
    busy.delete(rs.name);
  }
}

function keyFile(rsName) {
  const rs = get(rsName);
  return rs.keyFileEnc ? config.decrypt(rs.keyFileEnc) : null;
}

module.exports = {
  get,
  pub,
  list,
  status,
  hostSuggestions,
  create,
  convert,
  join,
  addMember,
  removeMember,
  stepDown,
  enableAuth,
  updateNetwork,
  remove,
  keyFile,
};
