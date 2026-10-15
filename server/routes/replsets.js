const express = require('express');
const { asyncHandler } = require('../util');
const replsets = require('../services/replsets');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await replsets.list());
}));

router.get('/hosts', (req, res) => {
  res.json(replsets.hostSuggestions());
});

router.post('/', asyncHandler(async (req, res) => {
  const job = await replsets.create(req.body || {});
  res.json({ jobId: job.id });
}));

router.post('/convert', asyncHandler(async (req, res) => {
  const job = await replsets.convert(req.body || {});
  res.json({ jobId: job.id });
}));

router.post('/join', asyncHandler(async (req, res) => {
  const job = await replsets.join(req.body || {});
  res.json({ jobId: job.id });
}));

router.get('/:name', asyncHandler(async (req, res) => {
  const rs = replsets.get(req.params.name);
  res.json({ ...replsets.pub(rs), status: await replsets.status(rs) });
}));

router.get('/:name/keyfile', (req, res) => {
  res.json({ keyFile: replsets.keyFile(req.params.name) });
});

router.post('/:name/members', asyncHandler(async (req, res) => {
  const job = await replsets.addMember(req.params.name, req.body || {});
  res.json({ jobId: job.id });
}));

router.post('/:name/members/remove', asyncHandler(async (req, res) => {
  const { host, purge } = req.body || {};
  const job = await replsets.removeMember(req.params.name, { host, purgeData: !!purge });
  res.json({ jobId: job.id });
}));

router.post('/:name/stepdown', asyncHandler(async (req, res) => {
  await replsets.stepDown(req.params.name);
  res.json({ ok: true });
}));

router.put('/:name/network', asyncHandler(async (req, res) => {
  const job = await replsets.updateNetwork(req.params.name, req.body || {});
  res.json({ jobId: job.id });
}));

router.post('/:name/auth', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  res.json(await replsets.enableAuth(req.params.name, username, password));
}));

router.delete('/:name', asyncHandler(async (req, res) => {
  await replsets.remove(req.params.name, { purgeData: req.query.purge === '1' });
  res.json({ ok: true });
}));

module.exports = router;
