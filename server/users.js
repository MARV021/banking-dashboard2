// Per-user accounts, replacing the old single shared DASHBOARD_PASSWORD.
// Password hashes (bcrypt) are already safe to store as-is — no need for the
// AES layer used in store.js, since a proper one-way hash can't be reversed
// even if this file leaks.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function load() {
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function persist(users) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

function addUser(email, password) {
  const users = load();
  const key = email.toLowerCase().trim();
  users[key] = { email: key, passwordHash: bcrypt.hashSync(password, 12) };
  persist(users);
}

function removeUser(email) {
  const users = load();
  const key = email.toLowerCase().trim();
  const existed = key in users;
  delete users[key];
  persist(users);
  return existed;
}

function verify(email, password) {
  const users = load();
  const user = users[email?.toLowerCase().trim()];
  if (!user) return false;
  return bcrypt.compareSync(password, user.passwordHash);
}

function count() {
  return Object.keys(load()).length;
}

module.exports = { addUser, removeUser, verify, count };
