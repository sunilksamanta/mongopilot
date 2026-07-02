const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || opts.ignoreExitCode) resolve({ code, stdout: out, stderr: err });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${(err || out).trim()}`));
    });
  });
}

let osInfo = null;

// Detect distro and build the list of MongoDB tarball "target" names that
// could match this machine (e.g. ubuntu2204, rhel90, rhel9).
function detectOS() {
  if (osInfo) return osInfo;
  const info = {
    platform: os.platform(),
    arch: os.arch(),
    id: 'unknown',
    versionId: '',
    pretty: os.platform() === 'darwin' ? 'macOS (dev mode)' : os.platform(),
    family: 'unknown',
    targets: [],
  };
  if (info.platform === 'linux' && fs.existsSync('/etc/os-release')) {
    const kv = {};
    for (const line of fs.readFileSync('/etc/os-release', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_0-9]+)=("?)(.*)\2$/);
      if (m) kv[m[1]] = m[3];
    }
    info.id = kv.ID || 'unknown';
    info.versionId = kv.VERSION_ID || '';
    info.pretty = kv.PRETTY_NAME || info.id;
    const like = `${info.id} ${kv.ID_LIKE || ''}`;
    if (/debian|ubuntu/.test(like)) info.family = 'debian';
    else if (/rhel|centos|fedora|rocky|alma|amzn/.test(like)) info.family = 'rhel';

    const major = (info.versionId || '').split('.')[0];
    if (info.id === 'ubuntu') {
      const v = info.versionId.replace('.', '');
      info.targets = [`ubuntu${v}`, 'ubuntu2404', 'ubuntu2204', 'ubuntu2004'];
    } else if (info.id === 'debian') {
      info.targets = [`debian${major}`, 'debian12', 'debian11'];
    } else if (info.id === 'amzn') {
      info.targets = ['amazon2023', 'amazon2', `rhel${major}`, `rhel${major}0`];
    } else if (info.family === 'rhel') {
      info.targets = [
        `rhel${major}`, `rhel${major}0`, `rhel${major}3`,
        'rhel9', 'rhel90', 'rhel93', 'rhel8', 'rhel80',
      ];
    }
    info.targets = [...new Set(info.targets)];
  }
  osInfo = info;
  return info;
}

const systemctl = {
  reload: () => run('systemctl', ['daemon-reload']),
  enable: (u) => run('systemctl', ['enable', u]),
  disable: (u) => run('systemctl', ['disable', u], { ignoreExitCode: true }),
  start: (u) => run('systemctl', ['start', u]),
  stop: (u) => run('systemctl', ['stop', u], { ignoreExitCode: true }),
  restart: (u) => run('systemctl', ['restart', u]),
  isActive: async (u) => {
    try {
      const r = await run('systemctl', ['is-active', u], { ignoreExitCode: true });
      return r.stdout.trim() || 'unknown';
    } catch {
      return 'unknown';
    }
  },
  show: async (u, props) => {
    const r = await run('systemctl', ['show', u, '--property=' + props.join(',')], { ignoreExitCode: true });
    const out = {};
    for (const line of r.stdout.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
  },
};

module.exports = { run, detectOS, systemctl };
