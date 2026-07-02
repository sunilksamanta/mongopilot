const os = require('os');
const { run } = require('./system');
const config = require('../config');
const { state } = require('../store');
const mongo = require('./mongo');

const WINDOW = 240; // samples kept (~1h at 15s)
const INTERVAL_MS = 15000;

const series = new Map(); // instance name -> sample array
let sys = [];
let prevCpu = null;
const prevOps = new Map();

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

async function sampleSystem(t) {
  const cur = cpuSnapshot();
  let cpuPct = 0;
  if (prevCpu) {
    const dt = cur.total - prevCpu.total;
    cpuPct = dt > 0 ? Math.round((1 - (cur.idle - prevCpu.idle) / dt) * 100) : 0;
  }
  prevCpu = cur;

  let disk = null;
  try {
    const r = await run('df', ['-kP', config.dataDir]);
    const parts = r.stdout.trim().split('\n').pop().split(/\s+/);
    disk = { totalKB: +parts[1], usedKB: +parts[2], availKB: +parts[3] };
  } catch {}

  sys.push({
    t,
    cpuPct,
    load: os.loadavg()[0],
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    disk,
  });
  if (sys.length > WINDOW) sys.shift();
}

async function sampleInstance(inst, t) {
  let point = { t, ok: false };
  try {
    const ss = await mongo.serverStatus(inst);
    const ops = ss.opcounters || {};
    const prev = prevOps.get(inst.name);
    let opsRead = null;
    let opsWrite = null;
    if (prev) {
      const dts = (t - prev.t) / 1000;
      if (dts > 0) {
        opsRead = Math.max(0, (Number(ops.query) + Number(ops.getmore) - prev.read) / dts);
        opsWrite = Math.max(
          0,
          (Number(ops.insert) + Number(ops.update) + Number(ops.delete) - prev.write) / dts
        );
      }
    }
    prevOps.set(inst.name, {
      t,
      read: Number(ops.query) + Number(ops.getmore),
      write: Number(ops.insert) + Number(ops.update) + Number(ops.delete),
    });
    point = {
      t,
      ok: true,
      connections: Number(ss.connections?.current ?? 0),
      residentMB: ss.mem ? Number(ss.mem.resident) : null,
      opsRead: opsRead == null ? null : +opsRead.toFixed(1),
      opsWrite: opsWrite == null ? null : +opsWrite.toFixed(1),
      netIn: ss.network ? Number(ss.network.bytesIn) : null,
      netOut: ss.network ? Number(ss.network.bytesOut) : null,
      uptime: Number(ss.uptime ?? 0),
    };
  } catch {
    prevOps.delete(inst.name);
  }
  let arr = series.get(inst.name);
  if (!arr) {
    arr = [];
    series.set(inst.name, arr);
  }
  arr.push(point);
  if (arr.length > WINDOW) arr.shift();
}

async function sample() {
  const t = Date.now();
  await sampleSystem(t);
  await Promise.all(state.instances.map((inst) => sampleInstance(inst, t)));
}

function start() {
  sample().catch(() => {});
  setInterval(() => sample().catch(() => {}), INTERVAL_MS).unref();
}

module.exports = {
  start,
  instanceMetrics: (name) => series.get(name) || [],
  systemMetrics: () => sys,
};
