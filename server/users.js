// Per-user accounts, replacing the old single shared DASHBOARD_PASSWORD.
// Password hashes (bcrypt) are already safe to store as-is — no need for the
// AES layer used in store.js, since a proper one-way hash can't be reversed
// even if this file leaks. 2FA secrets *can* be used directly if leaked, so
// those are encrypted with the same key as store.js.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { encrypt, decrypt } = require('./crypto');

const DATA_DIR = path.join(__dirname, '../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const ROLES = ['admin', 'viewer'];

function load() {
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function persist(users) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

const norm = email => String(email || '').toLowerCase().trim();

// Accounts created before roles existed were all effectively admins, so they
// stay admins rather than silently losing access.
const roleOf = user => (ROLES.includes(user?.role) ? user.role : 'admin');

// Re-adding an existing user only resets their password (and role, if given),
// keeping their 2FA enrolment.
function addUser(email, password, role) {
  if (role && !ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  const users = load();
  const key = norm(email);
  const existing = users[key] || {};
  users[key] = {
    ...existing,
    email: key,
    passwordHash: bcrypt.hashSync(password, 12),
    role: role || existing.role || 'viewer',
  };
  persist(users);
}

function setRole(email, role) {
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  const users = load();
  const user = users[norm(email)];
  if (!user) return false;
  user.role = role;
  persist(users);
  return true;
}

function removeUser(email) {
  const users = load();
  const key = norm(email);
  const existed = key in users;
  delete users[key];
  persist(users);
  return existed;
}

function verify(email, password) {
  const user = load()[norm(email)];
  if (!user) return false;
  return bcrypt.compareSync(String(password), user.passwordHash);
}

function get(email) {
  const user = load()[norm(email)];
  if (!user) return null;
  return { email: user.email, role: roleOf(user), totpEnabled: Boolean(user.totpEnabled) };
}

// ── 2FA ──────────────────────────────────────────────────────────────────────
function getTotpSecret(email) {
  const user = load()[norm(email)];
  return user?.totpSecret ? decrypt(user.totpSecret) : null;
}

function enableTotp(email, secret, counter) {
  const users = load();
  const user = users[norm(email)];
  if (!user) return false;
  user.totpSecret = encrypt(secret);
  user.totpEnabled = true;
  user.totpLastCounter = counter;
  persist(users);
  return true;
}

// A TOTP code stays valid for its whole 30s window, so remember the last
// accepted step and refuse to accept that step (or an earlier one) again.
function consumeTotpCounter(email, counter) {
  const users = load();
  const user = users[norm(email)];
  if (!user || (user.totpLastCounter != null && counter <= user.totpLastCounter)) return false;
  user.totpLastCounter = counter;
  persist(users);
  return true;
}

function resetTotp(email) {
  const users = load();
  const user = users[norm(email)];
  if (!user) return false;
  delete user.totpSecret;
  delete user.totpEnabled;
  delete user.totpLastCounter;
  persist(users);
  return true;
}

function list() {
  return Object.values(load()).map(u => ({
    email: u.email, role: roleOf(u), totpEnabled: Boolean(u.totpEnabled),
  }));
}

function count() {
  return Object.keys(load()).length;
}

module.exports = {
  ROLES, addUser, setRole, removeUser, verify, get, list, count,
  getTotpSecret, enableTotp, consumeTotpCounter, resetTotp,
};
