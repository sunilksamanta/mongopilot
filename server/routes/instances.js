const express = require('express');
const { asyncHandler } = require('../util');
const instances = require('../services/instances');
const mongo = require('../services/mongo');
const monitor = require('../services/monitor');
const backup = require('../services/backup');
const { state } = require('../store');

const router = express.Router();

function pub(inst) {
  const { adminPassEnc, ...rest } = inst;
  return rest;
}

router.get('/', asyncHandler(async (req, res) => {
  const out = await Promise.all(
    state.instances.map(async (inst) => ({ ...pub(inst), status: await instances.status(inst) }))
  );
  res.json(out);
}));

router.post('/', asyncHandler(async (req, res) => {
  res.json(pub(await instances.create(req.body || {})));
}));

router.get('/:name', asyncHandler(async (req, res) => {
  const inst = instances.get(req.params.name);
  res.json({ ...pub(inst), status: await instances.status(inst) });
}));

router.post('/:name/action', asyncHandler(async (req, res) => {
  await instances.action(req.params.name, (req.body || {}).action);
  res.json({ ok: true });
}));

router.put('/:name/config', asyncHandler(async (req, res) => {
  res.json(pub(await instances.updateConfig(req.params.name, req.body || {})));
}));

router.delete('/:name', asyncHandler(async (req, res) => {
  await instances.remove(req.params.name, { purgeData: req.query.purge === '1' });
  res.json({ ok: true });
}));

router.get('/:name/logs', asyncHandler(async (req, res) => {
  res.json({ log: instances.tailLog(req.params.name, Number(req.query.lines) || 200) });
}));

router.get('/:name/metrics', (req, res) => {
  res.json(monitor.instanceMetrics(req.params.name));
});

// ---- authentication / users ----

router.post('/:name/auth', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'username and a password of 8+ characters are required' });
  }
  res.json(pub(await instances.enableAuth(req.params.name, username, password)));
}));

router.get('/:name/users', asyncHandler(async (req, res) => {
  res.json(await mongo.listUsers(instances.get(req.params.name)));
}));

router.post('/:name/users', asyncHandler(async (req, res) => {
  const { username, password, db, roles } = req.body || {};
  if (!username || !password || !Array.isArray(roles) || !roles.length) {
    return res.status(400).json({ error: 'username, password and at least one role are required' });
  }
  await mongo.createUser(instances.get(req.params.name), { username, password, db, roles });
  res.json({ ok: true });
}));

router.put('/:name/users/:db/:username/password', asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'password of 8+ characters required' });
  }
  await mongo.changeUserPassword(instances.get(req.params.name), req.params.db, req.params.username, password);
  res.json({ ok: true });
}));

router.delete('/:name/users/:db/:username', asyncHandler(async (req, res) => {
  await mongo.dropUser(instances.get(req.params.name), req.params.db, req.params.username);
  res.json({ ok: true });
}));

// ---- databases ----

router.get('/:name/databases', asyncHandler(async (req, res) => {
  res.json(await mongo.listDatabases(instances.get(req.params.name)));
}));

router.post('/:name/databases', asyncHandler(async (req, res) => {
  const { db, collection } = req.body || {};
  if (!db) return res.status(400).json({ error: 'db name is required' });
  await mongo.createDatabase(instances.get(req.params.name), db, collection);
  res.json({ ok: true });
}));

router.delete('/:name/databases/:db', asyncHandler(async (req, res) => {
  await mongo.dropDatabase(instances.get(req.params.name), req.params.db);
  res.json({ ok: true });
}));

router.get('/:name/databases/:db/collections', asyncHandler(async (req, res) => {
  res.json(await mongo.listCollections(instances.get(req.params.name), req.params.db));
}));

// ---- backups ----

router.put('/:name/backup-schedule', asyncHandler(async (req, res) => {
  const inst = instances.get(req.params.name);
  const { cron, retention } = req.body || {};
  backup.setSchedule(inst, cron ? { cron, retention } : null);
  res.json(pub(inst));
}));

router.post('/:name/backup', asyncHandler(async (req, res) => {
  const job = backup.runBackup(instances.get(req.params.name));
  res.json({ jobId: job.id });
}));

module.exports = router;
