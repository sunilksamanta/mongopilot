const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ETC_PATH = '/etc/mongopilot/config.json';
const DEV_ROOT = path.join(__dirname, '..', 'dev-data');

let cfg;
let cfgFile;
let devMode = false;

if (fs.existsSync(ETC_PATH)) {
  cfgFile = ETC_PATH;
  cfg = JSON.parse(fs.readFileSync(ETC_PATH, 'utf8'));
} else {
  // Dev mode: no /etc/mongopilot/config.json — run locally with admin/admin
  devMode = true;
  cfgFile = path.join(DEV_ROOT, 'config.json');
  if (!fs.existsSync(cfgFile)) {
    fs.mkdirSync(DEV_ROOT, { recursive: true });
    const bcrypt = require('bcryptjs');
    cfg = {
      host: '127.0.0.1',
      port: 8455,
      adminUser: 'admin',
      adminPassHash: bcrypt.hashSync('admin', 10),
      jwtSecret: crypto.randomBytes(32).toString('hex'),
      dataDir: path.join(DEV_ROOT, 'data'),
      binDir: path.join(DEV_ROOT, 'mongodb'),
    };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    console.log('[mongopilot] Dev mode: created dev-data/config.json (login: admin / admin)');
  } else {
    cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  }
}

for (const d of [
  cfg.dataDir,
  cfg.binDir,
  path.join(cfg.dataDir, 'instances'),
  path.join(cfg.dataDir, 'backups'),
]) {
  fs.mkdirSync(d, { recursive: true });
}

// Secrets at rest (instance admin passwords, S3 keys) are AES-256-GCM
// encrypted with a key derived from the app's jwtSecret.
const encKey = crypto.createHash('sha256').update(cfg.jwtSecret + ':enc').digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join('.');
}

function decrypt(blob) {
  const [iv, tag, data] = String(blob).split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
}

function saveAdminPassHash(hash) {
  cfg.adminPassHash = hash;
  module.exports.adminPassHash = hash;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
}

module.exports = {
  ...cfg,
  devMode,
  isLinux: os.platform() === 'linux',
  encrypt,
  decrypt,
  saveAdminPassHash,
};
