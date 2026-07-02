const { MongoClient } = require('mongodb');
const config = require('../config');

// All management connections go through localhost; instances always bind 127.0.0.1.
function uriFor(inst, { includeAuth = true } = {}) {
  const auth =
    includeAuth && inst.authEnabled && inst.adminUser
      ? `${encodeURIComponent(inst.adminUser)}:${encodeURIComponent(config.decrypt(inst.adminPassEnc))}@`
      : '';
  const authSource = auth ? '&authSource=admin' : '';
  return `mongodb://${auth}127.0.0.1:${inst.port}/?directConnection=true${authSource}`;
}

async function withClient(inst, fn) {
  const client = new MongoClient(uriFor(inst), {
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

const SYSTEM_DBS = ['admin', 'local', 'config'];

module.exports = {
  uriFor,
  withClient,
  SYSTEM_DBS,

  ping: (inst) => withClient(inst, (c) => c.db('admin').command({ ping: 1 })),

  serverStatus: (inst) => withClient(inst, (c) => c.db('admin').command({ serverStatus: 1 })),

  buildInfo: (inst) => withClient(inst, (c) => c.db('admin').command({ buildInfo: 1 })),

  listDatabases: (inst) =>
    withClient(inst, async (c) => (await c.db('admin').admin().listDatabases()).databases),

  createDatabase: (inst, db, collection) =>
    withClient(inst, (c) => c.db(db).createCollection(collection || 'init')),

  dropDatabase: (inst, db) => {
    if (SYSTEM_DBS.includes(db)) throw new Error(`Refusing to drop system database "${db}"`);
    return withClient(inst, (c) => c.db(db).dropDatabase());
  },

  listCollections: (inst, db) =>
    withClient(inst, (c) => c.db(db).listCollections({}, { nameOnly: true }).toArray()),

  listUsers: (inst) =>
    withClient(
      inst,
      async (c) => (await c.db('admin').command({ usersInfo: { forAllDBs: true } })).users
    ),

  createUser: (inst, { username, password, db = 'admin', roles }) =>
    withClient(inst, (c) => c.db(db).command({ createUser: username, pwd: password, roles })),

  dropUser: (inst, db, username) =>
    withClient(inst, (c) => c.db(db).command({ dropUser: username })),

  changeUserPassword: (inst, db, username, password) =>
    withClient(inst, (c) => c.db(db).command({ updateUser: username, pwd: password })),
};
