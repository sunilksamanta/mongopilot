const { run } = require('./system');
const config = require('../config');

async function detectBackend() {
  if (!config.isLinux) return 'none';
  try {
    const r = await run('bash', ['-c', 'command -v ufw >/dev/null && ufw status | head -1'], { ignoreExitCode: true });
    if (/Status: active/.test(r.stdout)) return 'ufw';
    if (r.code === 0) return 'ufw-inactive';
  } catch {}
  try {
    const r = await run('firewall-cmd', ['--state'], { ignoreExitCode: true });
    if (/running/.test(r.stdout)) return 'firewalld';
  } catch {}
  return 'none';
}

async function listRules() {
  const backend = await detectBackend();
  if (backend === 'ufw') {
    const r = await run('ufw', ['status', 'numbered'], { ignoreExitCode: true });
    return { backend, raw: r.stdout };
  }
  if (backend === 'firewalld') {
    const r = await run('firewall-cmd', ['--list-all'], { ignoreExitCode: true });
    return { backend, raw: r.stdout };
  }
  return { backend, raw: '' };
}

function validate(port, cidr) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  if (cidr !== 'any' && !/^[0-9a-fA-F.:/]+$/.test(cidr)) throw new Error('Invalid source CIDR');
  return port;
}

async function allow(port, cidr = 'any') {
  const backend = await detectBackend();
  port = validate(port, cidr);
  if (backend === 'ufw') {
    if (cidr === 'any') await run('ufw', ['allow', `${port}/tcp`]);
    else await run('ufw', ['allow', 'from', cidr, 'to', 'any', 'port', String(port), 'proto', 'tcp']);
  } else if (backend === 'firewalld') {
    if (cidr === 'any') {
      await run('firewall-cmd', ['--permanent', `--add-port=${port}/tcp`]);
    } else {
      await run('firewall-cmd', [
        '--permanent',
        `--add-rich-rule=rule family="ipv4" source address="${cidr}" port port="${port}" protocol="tcp" accept`,
      ]);
    }
    await run('firewall-cmd', ['--reload']);
  } else {
    throw new Error('No active firewall detected (enable ufw or firewalld on the server first)');
  }
  return listRules();
}

async function revoke(port, cidr = 'any') {
  const backend = await detectBackend();
  port = validate(port, cidr);
  if (backend === 'ufw') {
    if (cidr === 'any') await run('ufw', ['delete', 'allow', `${port}/tcp`]);
    else await run('ufw', ['delete', 'allow', 'from', cidr, 'to', 'any', 'port', String(port), 'proto', 'tcp']);
  } else if (backend === 'firewalld') {
    if (cidr === 'any') {
      await run('firewall-cmd', ['--permanent', `--remove-port=${port}/tcp`]);
    } else {
      await run('firewall-cmd', [
        '--permanent',
        `--remove-rich-rule=rule family="ipv4" source address="${cidr}" port port="${port}" protocol="tcp" accept`,
      ]);
    }
    await run('firewall-cmd', ['--reload']);
  } else {
    throw new Error('No active firewall detected');
  }
  return listRules();
}

module.exports = { detectBackend, listRules, allow, revoke };
