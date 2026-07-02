const express = require('express');
const os = require('os');
const config = require('../config');
const { detectOS } = require('../services/system');
const monitor = require('../services/monitor');
const { state } = require('../store');
const pkg = require('../../package.json');

const router = express.Router();

router.get('/', (req, res) => {
  const osi = detectOS();
  res.json({
    app: { name: pkg.name, version: pkg.version, node: process.version, devMode: config.devMode },
    os: {
      pretty: osi.pretty,
      family: osi.family,
      arch: os.arch(),
      hostname: os.hostname(),
      uptime: os.uptime(),
      cpus: os.cpus().length,
    },
    instanceCount: state.instances.length,
  });
});

router.get('/metrics', (req, res) => res.json(monitor.systemMetrics()));

module.exports = router;
