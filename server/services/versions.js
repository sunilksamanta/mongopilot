const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const config = require('../config');
const { run, detectOS } = require('./system');
const { state } = require('../store');

// Official MongoDB release catalog (community tarballs live here too).
const FULL_JSON_URL = 'https://downloads.mongodb.org/full.json';
const TOOLS_VERSION = '100.10.0'; // mongodump/mongorestore etc.
const MIN_MAJOR = 5; // offer 5.0+

let catalogCache = { at: 0, data: null };

function archName() {
  return os.arch() === 'arm64' ? 'aarch64' : 'x86_64';
}

function cmpSemverDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pb[i] || 0) - (pa[i] || 0);
  return 0;
}

async function fetchCatalog(force = false) {
  if (!force && catalogCache.data && Date.now() - catalogCache.at < 3600e3) {
    return catalogCache.data;
  }
  const res = await fetch(FULL_JSON_URL);
  if (!res.ok) throw new Error(`Failed to fetch MongoDB catalog: HTTP ${res.status}`);
  const full = await res.json();
  const osi = detectOS();
  const arch = archName();
  const out = [];
  for (const v of full.versions || []) {
    if (!v.production_release) continue;
    const major = Number(v.version.split('.')[0]);
    if (!Number.isFinite(major) || major < MIN_MAJOR) continue;
    // "targeted" = distro-specific community build
    const dl = (v.downloads || []).find(
      (d) =>
        d.arch === arch &&
        d.edition === 'targeted' &&
        osi.targets.includes(d.target) &&
        d.archive?.url?.endsWith('.tgz')
    );
    out.push({
      version: v.version,
      series: v.version.split('.').slice(0, 2).join('.'),
      available: !!dl,
      url: dl ? dl.archive.url : null,
      date: v.date || null,
    });
  }
  out.sort((a, b) => cmpSemverDesc(a.version, b.version));
  catalogCache = { at: Date.now(), data: out };
  return out;
}

function installedVersions() {
  if (!fs.existsSync(config.binDir)) return [];
  return fs
    .readdirSync(config.binDir)
    .filter(
      (d) =>
        /^\d+\.\d+\.\d+$/.test(d) &&
        fs.existsSync(path.join(config.binDir, d, 'bin', 'mongod'))
    )
    .sort(cmpSemverDesc);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

async function extractTarball(tgz, destDir) {
  // Extract next to the destination so the final rename stays on one filesystem.
  const tmpDir = destDir + '.extract';
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  await run('tar', ['-xzf', tgz, '-C', tmpDir, '--strip-components=1']);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, destDir);
}

async function install(version, log = () => {}) {
  const catalog = await fetchCatalog();
  const entry = catalog.find((c) => c.version === version);
  if (!entry) throw new Error(`Unknown MongoDB version: ${version}`);
  if (!entry.available) throw new Error(`No community build of ${version} for this OS/architecture`);

  const destDir = path.join(config.binDir, version);
  if (fs.existsSync(path.join(destDir, 'bin', 'mongod'))) {
    log(`MongoDB ${version} is already installed`);
  } else {
    const tmp = path.join(os.tmpdir(), `mongodb-${version}.tgz`);
    log(`Downloading ${entry.url}`);
    await download(entry.url, tmp);
    log('Extracting...');
    await extractTarball(tmp, destDir);
    fs.rmSync(tmp, { force: true });
    if (!fs.existsSync(path.join(destDir, 'bin', 'mongod'))) {
      throw new Error('mongod binary missing after extraction');
    }
    log(`MongoDB ${version} installed to ${destDir}`);
  }
  await ensureTools(log);
}

function toolsDir() {
  return path.join(config.binDir, 'tools');
}

function toolsInstalled() {
  return fs.existsSync(path.join(toolsDir(), 'bin', 'mongodump'));
}

// mongodump/mongorestore ship separately as "database tools".
async function ensureTools(log = () => {}) {
  if (toolsInstalled()) return;
  const osi = detectOS();
  const arch = archName();
  let lastErr = null;
  for (const target of osi.targets) {
    const url = `https://fastdl.mongodb.org/tools/db/mongodb-database-tools-${target}-${arch}-${TOOLS_VERSION}.tgz`;
    try {
      log(`Downloading database tools: ${url}`);
      const tmp = path.join(os.tmpdir(), 'mongodb-tools.tgz');
      await download(url, tmp);
      await extractTarball(tmp, toolsDir());
      fs.rmSync(tmp, { force: true });
      log('Database tools (mongodump/mongorestore) installed');
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  log(`WARNING: could not install database tools: ${lastErr}`);
}

function removeVersion(version) {
  const inUse = state.instances.filter((i) => i.version === version).map((i) => i.name);
  if (inUse.length) {
    throw new Error(`Version ${version} is in use by instance(s): ${inUse.join(', ')}`);
  }
  const dir = path.join(config.binDir, version);
  if (!fs.existsSync(dir)) throw new Error(`Version ${version} is not installed`);
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  fetchCatalog,
  installedVersions,
  install,
  removeVersion,
  toolsInstalled,
  toolsDir,
  ensureTools,
};
