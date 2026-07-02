const crypto = require('crypto');

const jobs = new Map();

function create(type, meta = {}) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    type,
    meta,
    status: 'running',
    log: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(id, job);
  return job;
}

function logTo(job, msg) {
  job.log.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function finish(job, error = null) {
  job.status = error ? 'failed' : 'done';
  job.error = error ? String(error.message || error) : null;
  job.finishedAt = new Date().toISOString();
}

function get(id) {
  return jobs.get(id);
}

function list() {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 50);
}

module.exports = { create, logTo, finish, get, list };
