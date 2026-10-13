// Append-only activity log (who logged in, who connected or disconnected a
// bank, who exported data) so access can be reviewed periodically. One JSON
// object per line in data/audit.log.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');

function log(event, { email = null, ip = null, ...details } = {}) {
  const entry = { at: new Date().toISOString(), event, email, ip, ...details };
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error('audit log write failed:', err.message);
  }
}

function recent(limit = 200) {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).reverse().map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

module.exports = { log, recent };
