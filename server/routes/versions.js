const express = require('express');
const { asyncHandler } = require('../util');
const versions = require('../services/versions');
const jobs = require('../services/jobs');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const installed = versions.installedVersions();
  let catalog = [];
  let catalogError = null;
  try {
    catalog = await versions.fetchCatalog(req.query.refresh === '1');
  } catch (e) {
    catalogError = String(e.message || e);
  }
  res.json({ installed, toolsInstalled: versions.toolsInstalled(), catalog, catalogError });
}));

router.post('/install', asyncHandler(async (req, res) => {
  const { version } = req.body || {};
  if (!version) return res.status(400).json({ error: 'version is required' });
  const job = jobs.create('install-version', { version });
  versions
    .install(version, (m) => jobs.logTo(job, m))
    .then(() => jobs.finish(job))
    .catch((e) => jobs.finish(job, e));
  res.json({ jobId: job.id });
}));

router.delete('/:version', asyncHandler(async (req, res) => {
  versions.removeVersion(req.params.version);
  res.json({ ok: true });
}));

module.exports = router;
