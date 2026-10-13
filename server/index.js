require('dotenv').config();
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const path = require('path');
const QRCode = require('qrcode');
const plaid = require('./plaid');
const store = require('./store');
const users = require('./users');
const totp = require('./totp');
const audit = require('./audit');
const { key: serverKey } = require('./crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Optional: seed/reset login accounts from env vars at boot. Useful on
// hosts (e.g. Render's free tier) with no persistent disk and no shell
// access, where you can't run scripts/manage-users.js directly. Set
// SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD (and _2, _3, ... for more accounts)
// in the host's env var UI, restart once, then remove/change the password
// vars so they aren't sitting live. Seeded accounts are admins.
for (const suffix of ['', '_2', '_3', '_4', '_5']) {
  const email = process.env[`SEED_ADMIN_EMAIL${suffix}`];
  const password = process.env[`SEED_ADMIN_PASSWORD${suffix}`];
  if (email && password) {
    users.addUser(email, password, 'admin');
    console.log(`Seeded login account for ${email} from env vars`);
  }
}

// A guessable session secret lets anyone forge a logged-in cookie, so never
// fall back to a fixed default. In production refuse to start; locally use a
// random one (which just means logins don't survive a restart).
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret === 'dev-secret' || sessionSecret.startsWith('change-this')) {
  if (IS_PROD) {
    console.error('SESSION_SECRET is missing or still the example value. Generate one with `openssl rand -hex 32`.');
    process.exit(1);
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set, using a random one for this run (logins reset on restart).');
} else if (sessionSecret.length < 32) {
  console.warn('SESSION_SECRET is shorter than 32 characters; consider `openssl rand -hex 32`.');
}

// Behind a reverse proxy (Render, Fly, etc.) this makes req.secure and
// req.ip reflect the real client, so the Secure cookie flag and rate
// limiting below work correctly once deployed.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Standard browser security headers. Plaid Link loads its script and iframe
// from cdn.plaid.com and talks to the Plaid API; everything else is same-origin.
// The pages still use inline onclick handlers, hence 'unsafe-inline'.
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.plaid.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://*.plaid.com",
      "connect-src 'self' https://*.plaid.com",
      "frame-src https://cdn.plaid.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  });
  if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json());
app.use(session({
  name: 'sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000,
  }
}));

// ── Per-user login gate (password + authenticator-app code) ───────────────────
// Each colleague has their own account (see server/users.js), managed via
// `node scripts/manage-users.js add <email> <password> [admin|viewer]` — not
// open signup, since only people you've explicitly added should see the
// connected banks. Everyone must use 2FA: first login walks them through
// setting it up.
const PUBLIC_PATHS = new Set([
  '/login', '/api/login', '/api/2fa/setup', '/api/2fa/verify', '/privacy.html', '/terms.html',
]);

const norm = email => String(email || '').toLowerCase().trim();

// Brute-force guard, keyed by IP + email together so one bad actor can't lock
// a real colleague out just by hammering their address with wrong passwords.
// Covers both the password step and the 2FA code step.
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const attemptKey = req => `${req.ip}:${norm(req.body?.email || req.session?.pending?.email)}`;

function loginRateLimit(req, res, next) {
  const key = attemptKey(req);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: now });
    return next();
  }
  entry.count += 1;
  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.first > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
}, LOGIN_WINDOW_MS).unref();

// New session id at each privilege change, so a session id seen before login
// can't be reused afterwards (session fixation).
const regenerateSession = req => new Promise((resolve, reject) => {
  req.session.regenerate(err => (err ? reject(err) : resolve()));
});

// Password checked, waiting for the 2FA code. Expires after 5 minutes.
const PENDING_TTL_MS = 5 * 60 * 1000;
function pendingLogin(req) {
  const p = req.session.pending;
  if (!p || Date.now() - p.at > PENDING_TTL_MS) return null;
  return p;
}

async function completeLogin(req, email) {
  loginAttempts.delete(attemptKey(req));
  await regenerateSession(req);
  req.session.authenticated = true;
  req.session.userEmail = email;
  audit.log('login_success', { email, ip: req.ip });
}

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.post('/api/login', loginRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || !users.verify(email, password)) {
      audit.log('login_failed', { email: norm(email) || null, ip: req.ip });
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    const user = users.get(email);
    await regenerateSession(req);
    req.session.pending = user.totpEnabled
      ? { email: user.email, at: Date.now() }
      : { email: user.email, at: Date.now(), setup: true, secret: totp.deriveSecret(serverKey(), user.email, password) };
    res.json({ next: user.totpEnabled ? '2fa' : 'setup-2fa' });
  } catch (err) { next(err); }
});

// First login: show the QR code / key to add to an authenticator app.
app.get('/api/2fa/setup', async (req, res, next) => {
  try {
    const p = pendingLogin(req);
    if (!p?.setup) return res.status(401).json({ error: 'Login expired, please start again' });
    const qr = await QRCode.toDataURL(totp.otpauthUrl(p.secret, p.email), { margin: 1, width: 200 });
    res.json({ secret: p.secret, qr });
  } catch (err) { next(err); }
});

app.post('/api/2fa/setup', loginRateLimit, async (req, res, next) => {
  try {
    const p = pendingLogin(req);
    if (!p?.setup) return res.status(401).json({ error: 'Login expired, please start again' });
    const counter = totp.verify(p.secret, req.body?.code);
    if (counter == null) {
      audit.log('2fa_failed', { email: p.email, ip: req.ip, stage: 'setup' });
      return res.status(401).json({ error: 'That code didn\'t match. Check the time on your phone and try again.' });
    }
    users.enableTotp(p.email, p.secret, counter);
    audit.log('2fa_enrolled', { email: p.email, ip: req.ip });
    await completeLogin(req, p.email);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/2fa/verify', loginRateLimit, async (req, res, next) => {
  try {
    const p = pendingLogin(req);
    if (!p || p.setup) return res.status(401).json({ error: 'Login expired, please start again' });
    const secret = users.getTotpSecret(p.email);
    const counter = secret ? totp.verify(secret, req.body?.code) : null;
    if (counter == null || !users.consumeTotpCounter(p.email, counter)) {
      audit.log('2fa_failed', { email: p.email, ip: req.ip });
      return res.status(401).json({ error: 'Incorrect code' });
    }
    await completeLogin(req, p.email);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/logout', (req, res) => {
  if (req.session.authenticated) audit.log('logout', { email: req.session.userEmail, ip: req.ip });
  req.session.destroy(() => res.json({ ok: true }));
});

// Role is looked up on every request (not cached in the session) so removing
// a user or downgrading them to viewer takes effect immediately.
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const user = req.session.authenticated ? users.get(req.session.userEmail) : null;
  if (user) {
    req.user = user;
    return next();
  }
  if (req.session.authenticated) req.session.destroy(() => {});
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  res.redirect('/login');
});

// Connecting and disconnecting banks, and viewing the activity log, are
// admin-only; viewers can see balances and transactions.
function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Only admins can do this' });
}

app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/me', (req, res) => {
  res.json({ email: req.user.email, role: req.user.role });
});

app.get('/api/audit', requireAdmin, (req, res) => {
  res.json(audit.recent(200));
});

// CSV exports are built in the browser; this just records that one happened.
app.post('/api/audit/export', (req, res) => {
  const rows = Number(req.body?.rows) || 0;
  audit.log('transactions_exported', { email: req.user.email, ip: req.ip, rows });
  res.json({ ok: true });
});

// ── Step 1: frontend requests a link token to open Plaid Link ────────────────
app.post('/api/create-link-token', requireAdmin, async (req, res) => {
  try {
    const linkToken = await plaid.createLinkToken();
    res.json({ link_token: linkToken });
  } catch (err) {
    console.error('create-link-token error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

// ── Step 2: frontend sends back the public token after bank login ─────────────
app.post('/api/exchange-token', requireAdmin, async (req, res) => {
  const { public_token, metadata } = req.body;
  try {
    const { accessToken, itemId } = await plaid.exchangePublicToken(public_token);
    const item        = await plaid.getItem(accessToken);
    const institution  = await plaid.getInstitution(item?.institution_id);

    const label = institution?.name || metadata?.institution?.name || 'Bank';
    store.saveConnection({
      id: crypto.randomUUID(),
      label,
      provider: institution?.name || 'Plaid',
      accessToken,
      itemId,
      transactionsCursor: null,
      transactions: [],
      connectedAt: Date.now(),
    });
    audit.log('bank_connected', { email: req.user.email, ip: req.ip, bank: label, provider: 'Plaid' });

    res.json({ ok: true });
  } catch (err) {
    console.error('exchange-token error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to connect bank' });
  }
});

// ── Plaid: OAuth redirect landing page ────────────────────────────────────────
// UK Open Banking institutions (Coutts included) send the user back here after
// they authenticate on the bank's own site. The client-side JS in dashboard.js
// detects the oauth_state_id query param and resumes the same Plaid Link flow.
app.get('/plaid/oauth-callback', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── List connections ──────────────────────────────────────────────────────────
app.get('/api/connections', (req, res) => {
  const connections = store.getAll().map(c => ({
    id: c.id,
    label: c.label,
    provider: c.provider,
    connectedAt: c.connectedAt,
  }));
  res.json(connections);
});

// ── Disconnect a bank ─────────────────────────────────────────────────────────
app.delete('/api/connections/:id', requireAdmin, async (req, res) => {
  const conn = store.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  store.remove(req.params.id);
  audit.log('bank_disconnected', { email: req.user.email, ip: req.ip, bank: conn.label, provider: conn.provider });
  res.json({ ok: true });
});

async function loadPlaidConnection(conn) {
  const [accounts, transactions] = await Promise.all([
    plaid.getAccounts(conn.accessToken),
    plaid.syncTransactions(conn),
  ]);

  const enriched = accounts.map(acct => ({
    account_id:   acct.account_id,
    display_name: acct.name,
    account_type: acct.subtype || acct.type,
    account_number: { number: acct.mask ? `•••• ${acct.mask}` : '' },
    balance: {
      current:   acct.balances.current,
      available: acct.balances.available,
      currency:  acct.balances.iso_currency_code || 'GBP',
    },
    transactions: transactions
      .filter(t => t.account_id === acct.account_id)
      .map(t => ({
        description: t.name,
        amount: -t.amount, // Plaid uses positive for money leaving the account
        timestamp: t.date,
        transaction_classification: t.category || [],
      })),
  }));

  return { accounts: enriched, cards: [] };
}

// ── Live data: accounts + transactions for all connections ────────────────────
app.get('/api/data', async (req, res) => {
  const connections = store.getAll();
  if (!connections.length) return res.json([]);

  const results = await Promise.all(
    connections.map(async (conn) => {
      const base = {
        connectionId: conn.id,
        label: conn.label,
        provider: conn.provider,
      };
      try {
        const { accounts, cards } = await loadPlaidConnection(conn);
        return { ...base, accounts, cards, fetchedAt: Date.now() };
      } catch (err) {
        console.error(`load ${conn.provider} connection failed:`, err.response?.data || err.message);
        const reason = err.response?.status === 401 || err.response?.status === 403
          ? 'Bank access has expired or been revoked — disconnect and reconnect it.'
          : 'Could not load this bank right now.';
        return { ...base, accounts: [], cards: [], fetchedAt: Date.now(), error: reason };
      }
    })
  );

  res.json(results);
});

const certPath = path.join(__dirname, '../certs/localhost.pem');
const keyPath  = path.join(__dirname, '../certs/localhost-key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  https.createServer({
    cert: fs.readFileSync(certPath),
    key:  fs.readFileSync(keyPath),
  }, app).listen(PORT, () => {
    console.log(`Banking dashboard running at https://localhost:${PORT}`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`Banking dashboard running at http://localhost:${PORT}`);
  });
}
