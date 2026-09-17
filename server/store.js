// Persists connections (including access tokens and transaction history) to
// disk as AES-256-GCM encrypted blobs — see crypto.js. Each connection is
// encrypted whole, not just its access token, since transactions themselves
// are sensitive financial data too.
const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./crypto');

const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'connections.enc.json');

const connections = new Map();

function persist() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = {};
  for (const [id, conn] of connections) {
    out[id] = encrypt(JSON.stringify(conn));
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(out), { mode: 0o600 });
}

function load() {
  if (!fs.existsSync(DATA_FILE)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const [id, blob] of Object.entries(raw)) {
    try {
      connections.set(id, JSON.parse(decrypt(blob)));
    } catch (err) {
      console.error(`Failed to decrypt stored connection ${id}, skipping:`, err.message);
    }
  }
}

load();

module.exports = {
  saveConnection(conn) {
    connections.set(conn.id, conn);
    persist();
  },
  getAll() {
    return Array.from(connections.values());
  },
  get(id) {
    return connections.get(id);
  },
  remove(id) {
    connections.delete(id);
    persist();
  },
  count() {
    return connections.size;
  },
  updateTokens(id, { accessToken, refreshToken, expiresAt }) {
    const conn = connections.get(id);
    if (conn) {
      conn.accessToken  = accessToken;
      conn.refreshToken = refreshToken;
      conn.expiresAt    = expiresAt;
      persist();
    }
  },
  updateTransactions(id, { cursor, transactions }) {
    const conn = connections.get(id);
    if (conn) {
      conn.transactionsCursor = cursor;
      conn.transactions = transactions;
      persist();
    }
  },
};
