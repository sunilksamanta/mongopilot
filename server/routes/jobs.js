const express = require('express');
const jobs = require('../services/jobs');

const router = express.Router();

router.get('/', (req, res) => res.json(jobs.list()));

router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job' });
  res.json(job);
});

module.exports = router;
