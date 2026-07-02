const express = require('express');
const { asyncHandler } = require('../util');
const firewall = require('../services/firewall');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await firewall.listRules());
}));

router.post('/allow', asyncHandler(async (req, res) => {
  const { port, cidr } = req.body || {};
  res.json(await firewall.allow(port, cidr || 'any'));
}));

router.post('/revoke', asyncHandler(async (req, res) => {
  const { port, cidr } = req.body || {};
  res.json(await firewall.revoke(port, cidr || 'any'));
}));

module.exports = router;
