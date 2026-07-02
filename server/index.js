const express = require('express');
const path = require('path');
const config = require('./config');
const { authRequired } = require('./middleware/auth');
const monitor = require('./services/monitor');
const backup = require('./services/backup');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api', authRequired);
app.use('/api/system', require('./routes/system'));
app.use('/api/versions', require('./routes/versions'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/instances', require('./routes/instances'));
app.use('/api/firewall', require('./routes/firewall'));
app.use('/api/backups', require('./routes/backups'));

app.use(express.static(path.join(__dirname, '..', 'public')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[mongopilot]', err.message || err);
  res.status(err.statusCode || 500).json({ error: String(err.message || err) });
});

app.listen(config.port, config.host, () => {
  console.log(
    `[mongopilot] listening on http://${config.host}:${config.port}` +
      (config.devMode ? '  (dev mode — login: admin / admin)' : '')
  );
});

monitor.start();
backup.applySchedules();
