const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const config = require('../config');
const { state, save } = require('../store');
const { run } = require('./system');
const jobs = require('./jobs');

const tasks = new Map(); // instance name -> cron task

function s3Settings() {
  if (!state.s3) return null;
  return {
    region: state.s3.region,
    bucket: state.s3.bucket,
    prefix: state.s3.prefix || 'mongopilot',
    accessKeyId: config.decrypt(state.s3.accessKeyIdEnc),
    secretAccessKey: config.decrypt(state.s3.secretAccessKeyEnc),
  };
}

function publicSettings() {
  if (!state.s3) return null;
  return {
    region: state.s3.region,
    bucket: state.s3.bucket,
    prefix: state.s3.prefix || 'mongopilot',
    accessKeyIdMasked: '••••' + config.decrypt(state.s3.accessKeyIdEnc).slice(-4),
  };
}

function setS3Settings({ region, bucket, prefix, accessKeyId, secretAccessKey }) {
  if (!region || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('region, bucket, accessKeyId and secretAccessKey are all required');
  }
  state.s3 = {
    region: String(region).trim(),
    bucket: String(bucket).trim(),
    prefix: String(prefix || 'mongopilot').trim().replace(/\/+$/, ''),
    accessKeyIdEnc: config.encrypt(String(accessKeyId).trim()),
    secretAccessKeyEnc: config.encrypt(String(secretAccessKey).trim()),
  };
  save();
}

function s3Client(s) {
  return new S3Client({
    region: s.region,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
  });
}

async function applyRetention(inst, s, log) {
  const keep = inst.backupSchedule?.retention;
  if (!keep || keep < 1) return;
  const client = s3Client(s);
  const res = await client.send(
    new ListObjectsV2Command({ Bucket: s.bucket, Prefix: `${s.prefix}/${inst.name}/` })
  );
  const objs = (res.Contents || []).sort((a, b) => b.LastModified - a.LastModified);
  for (const o of objs.slice(keep)) {
    log(`Retention: deleting old backup ${o.Key}`);
    await client.send(new DeleteObjectCommand({ Bucket: s.bucket, Key: o.Key }));
  }
}

function runBackup(inst) {
  const s = s3Settings();
  if (!s) throw new Error('S3 backup settings are not configured (Backups page)');
  const mongodump = path.join(config.binDir, 'tools', 'bin', 'mongodump');
  if (!fs.existsSync(mongodump)) {
    throw new Error('mongodump is not installed yet — install any MongoDB version first (it bundles the database tools)');
  }

  const job = jobs.create('backup', { instance: inst.name });
  const log = (m) => jobs.logTo(job, m);

  (async () => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(config.dataDir, 'backups', `${inst.name}-${ts}.archive.gz`);
    try {
      const args = ['--host', '127.0.0.1', '--port', String(inst.port), `--archive=${file}`, '--gzip'];
      if (inst.authEnabled) {
        args.push(
          '-u', inst.adminUser,
          '-p', config.decrypt(inst.adminPassEnc),
          '--authenticationDatabase', 'admin'
        );
      }
      log(`Running mongodump for instance "${inst.name}" ...`);
      await run(mongodump, args);
      const size = fs.statSync(file).size;
      const key = `${s.prefix}/${inst.name}/${path.basename(file)}`;
      log(`Uploading ${(size / 1048576).toFixed(1)} MB to s3://${s.bucket}/${key}`);
      const upload = new Upload({
        client: s3Client(s),
        params: { Bucket: s.bucket, Key: key, Body: fs.createReadStream(file) },
      });
      await upload.done();
      state.backupHistory.unshift({
        instance: inst.name,
        key,
        sizeBytes: size,
        at: new Date().toISOString(),
        status: 'ok',
      });
      state.backupHistory = state.backupHistory.slice(0, 200);
      save();
      log('Backup uploaded successfully');
      await applyRetention(inst, s, log).catch((e) => log(`Retention cleanup failed: ${e.message}`));
      jobs.finish(job);
    } catch (e) {
      state.backupHistory.unshift({
        instance: inst.name,
        at: new Date().toISOString(),
        status: 'failed',
        error: String(e.message || e),
      });
      state.backupHistory = state.backupHistory.slice(0, 200);
      save();
      jobs.finish(job, e);
    } finally {
      fs.rmSync(file, { force: true });
    }
  })();

  return job;
}

function setSchedule(inst, schedule) {
  if (schedule) {
    if (!cron.validate(schedule.cron)) throw new Error(`Invalid cron expression: ${schedule.cron}`);
    inst.backupSchedule = { cron: schedule.cron, retention: Number(schedule.retention) || null };
  } else {
    inst.backupSchedule = null;
  }
  save();
  applySchedules();
}

function applySchedules() {
  for (const [, t] of tasks) t.stop();
  tasks.clear();
  for (const inst of state.instances) {
    if (inst.backupSchedule?.cron) {
      tasks.set(
        inst.name,
        cron.schedule(inst.backupSchedule.cron, () => {
          try {
            runBackup(inst);
          } catch (e) {
            console.error(`[backup] scheduled backup for ${inst.name} failed to start:`, e.message);
          }
        })
      );
    }
  }
}

module.exports = { s3Settings, publicSettings, setS3Settings, runBackup, setSchedule, applySchedules };
