const net = require('net');
const os = require('os');
const dns = require('dns').promises;

// Hostname or IPv4 address (what MongoDB accepts in a replica set member "host").
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function localAddresses() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ iface, address: a.address });
    }
  }
  return out;
}

function isLoopback(host) {
  return host === 'localhost' || /^127\./.test(host) || host === '::1';
}

function isLocalHost(host) {
  return isLoopback(host) || host === os.hostname() || localAddresses().some((a) => a.address === host);
}

// "host:port" -> [host, port]; tolerates "[ipv6]:port"
function splitHostPort(s) {
  const str = String(s || '');
  const i = str.lastIndexOf(':');
  if (i <= 0) return [str, NaN];
  return [str.slice(0, i).replace(/^\[|\]$/g, ''), Number(str.slice(i + 1))];
}

// true when nothing on this machine is listening on the port
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

function tcpReachable(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function resolveIPv4(host) {
  if (net.isIP(host)) return host;
  return (await dns.lookup(host, { family: 4 })).address;
}

module.exports = {
  HOST_RE,
  localAddresses,
  isLoopback,
  isLocalHost,
  splitHostPort,
  portFree,
  tcpReachable,
  resolveIPv4,
};
