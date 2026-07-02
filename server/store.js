const fs = require('fs');
const path = require('path');
const config = require('./config');

const STATE_PATH = path.join(config.dataDir, 'state.json');
const DEFAULTS = { instances: [], s3: null, backupHistory: [] };

let state;
try {
  state = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) };
} catch {
  state = { ...DEFAULTS };
}

function save() {
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

module.exports = { state, save };
