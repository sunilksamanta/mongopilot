const express = require('express');
const { asyncHandler } = require('../util');
const backup = require('../services/backup');
const { state } = require('../store');

const router = express.Router();

router.get('/settings', (req, res) => res.json(backup.publicSettings()));

router.put('/settings', asyncHandler(async (req, res) => {
  backup.setS3Settings(req.body || {});
  res.json(backup.publicSettings());
}));

router.get('/history', (req, res) => {
  const { instance } = req.query;
  let hist = state.backupHistory;
  if (instance) hist = hist.filter((h) => h.instance === instance);
  res.json(hist);
});

module.exports = router;
