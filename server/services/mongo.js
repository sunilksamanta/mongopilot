const { MongoClient } = require('mongodb');
const config = require('../config');
const { state } = require('../store');
const { splitHostPort, isLocalHost } = require('./netutil');

// Management connections go through localhost (instances always bind 127.0.0.1);
// `host`/`port` are only overridden to reach a replica set primary on another server.
function uriFor(inst, { includeAuth = true, host = '127.0.0.1', port = inst.port } = {}) {
  const auth =
    includeAuth && inst.authEnabled && inst.adminUser
      ? `${encodeURIComponent(inst.adminUser)}:${encodeURIComponent(config.decrypt(inst.adminPassEnc))}@`
      : '';
  const authSource = auth ? '&authSource=admin' : '';
  return `mongodb://${auth}${host}:${port}/?directConnection=true${authSource}`;
}

// opts.auth = false connects without credentials (hello, localhost-exception bootstrap)
async function withClient(inst, fn, { auth = true, host, port } = {}) {
  const client = new MongoClient(uriFor(inst, { includeAuth: auth, host, port }), {
    serverSelectionTimeoutMS: 4000,
    connectTimeoutMS: 4000,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

const hello = (inst) => withClient(inst, (c) => c.db('admin').command({ hello: 1 }), { auth: false });

// Writes on a replica set member must go to the primary, which may be another
// local instance or (for sets spanning servers) a remote host.
async function withPrimary(inst, fn) {
  if (!inst.replSet) return withClient(inst, fn);
  // ask this member first, then the set's other local members (this one may be down)
  const peers = [inst, ...state.instances.filter((i) => i.replSet === inst.replSet && i !== inst)];
  let h = null;
  let lastErr = null;
  for (const m of peers) {
    try {
      h = await hello(m);
      if (h.isWritablePrimary) return withClient(m, fn);
      if (h.primary) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!h && lastErr) throw lastErr;
  if (!h.primary) {
    throw new Error(`Replica set "${inst.replSet}" has no primary right now (an election may be in progress); try again in a few seconds`);
  }
  const [host, port] = splitHostPort(h.primary);
  const local = state.instances.find((i) => i.replSet === inst.replSet && i.port === port && isLocalHost(host));
  if (local) return withClient(local, fn);
  return withClient(inst, fn, { host, port });
}

const SYSTEM_DBS = ['admin', 'local', 'config'];

module.exports = {
  uriFor,
  withClient,
  withPrimary,
  hello,
  SYSTEM_DBS,

  ping: (inst) => withClient(inst, (c) => c.db('admin').command({ ping: 1 })),

  serverStatus: (inst) => withClient(inst, (c) => c.db('admin').command({ serverStatus: 1 })),

  buildInfo: (inst) => withClient(inst, (c) => c.db('admin').command({ buildInfo: 1 })),

  listDatabases: (inst) =>
    withClient(inst, async (c) => (await c.db('admin').admin().listDatabases()).databases),

  createDatabase: (inst, db, collection) =>
    withPrimary(inst, (c) => c.db(db).createCollection(collection || 'init')),

  dropDatabase: (inst, db) => {
    if (SYSTEM_DBS.includes(db)) throw new Error(`Refusing to drop system database "${db}"`);
    return withPrimary(inst, (c) => c.db(db).dropDatabase());
  },

  listCollections: (inst, db) =>
    withClient(inst, (c) => c.db(db).listCollections({}, { nameOnly: true }).toArray()),

  listUsers: (inst) =>
    withClient(
      inst,
      async (c) => (await c.db('admin').command({ usersInfo: { forAllDBs: true } })).users
    ),

  createUser: (inst, { username, password, db = 'admin', roles }) =>
    withPrimary(inst, (c) => c.db(db).command({ createUser: username, pwd: password, roles })),

  dropUser: (inst, db, username) =>
    withPrimary(inst, (c) => c.db(db).command({ dropUser: username })),

  changeUserPassword: (inst, db, username, password) =>
    withPrimary(inst, (c) => c.db(db).command({ updateUser: username, pwd: password })),
};
