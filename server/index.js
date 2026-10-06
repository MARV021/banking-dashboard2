require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const plaid = require('./plaid');
const enable = require('./enablebanking');
const store = require('./store');
const users = require('./users');

const app = express();
const PORT = process.env.PORT || 3000;

// Optional: seed/reset login accounts from env vars at boot. Useful on
// hosts (e.g. Render's free tier) with no persistent disk and no shell
// access, where you can't run scripts/manage-users.js directly. Set
// SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD (and _2, _3, ... for more accounts)
// in the host's env var UI, restart once, then remove/change the password
// vars so they aren't sitting live.
for (const suffix of ['', '_2', '_3', '_4', '_5']) {
  const email = process.env[`SEED_ADMIN_EMAIL${suffix}`];
  const password = process.env[`SEED_ADMIN_PASSWORD${suffix}`];
  if (email && password) {
    users.addUser(email, password);
    console.log(`Seeded login account for ${email} from env vars`);
  }
}

// Behind a reverse proxy (Render, Fly, etc.) this makes req.secure and
// req.ip reflect the real client, so the Secure cookie flag and rate
// limiting below work correctly once deployed.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  }
}));

// ── Per-user login gate ───────────────────────────────────────────────────────
// Each colleague has their own account (see server/users.js), managed via
// `node scripts/manage-users.js add <email> <password>` — not open signup,
// since only people you've explicitly added should see the connected banks.
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/privacy.html', '/terms.html']);

// Brute-force guard, keyed by IP + email together so one bad actor can't lock
// a real colleague out just by hammering their address with wrong passwords.
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function loginRateLimit(req, res, next) {
  const key = `${req.ip}:${(req.body?.email || '').toLowerCase()}`;
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

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.post('/api/login', loginRateLimit, (req, res) => {
  const { email, password } = req.body;
  if (email && password && users.verify(email, password)) {
    loginAttempts.delete(`${req.ip}:${email.toLowerCase()}`);
    req.session.authenticated = true;
    req.session.userEmail = email.toLowerCase().trim();
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Incorrect email or password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, '../public')));

// ── Step 1: frontend requests a link token to open Plaid Link ────────────────
app.post('/api/create-link-token', async (req, res) => {
  try {
    const linkToken = await plaid.createLinkToken();
    res.json({ link_token: linkToken });
  } catch (err) {
    console.error('create-link-token error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

// ── Step 2: frontend sends back the public token after bank login ─────────────
app.post('/api/exchange-token', async (req, res) => {
  const { public_token, metadata } = req.body;
  try {
    const { accessToken, itemId } = await plaid.exchangePublicToken(public_token);
    const item        = await plaid.getItem(accessToken);
    const institution  = await plaid.getInstitution(item?.institution_id);

    store.saveConnection({
      id: uuidv4(),
      label: institution?.name || metadata?.institution?.name || 'Bank',
      provider: institution?.name || 'Plaid',
      accessToken,
      itemId,
      transactionsCursor: null,
      transactions: [],
      connectedAt: Date.now(),
    });

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

// ── Enable Banking: direct UK Open Banking connections ────────────────────────
function enableRedirectUrl() {
  return process.env.ENABLE_REDIRECT_URL
    || `${process.env.APP_URL || `http://localhost:${PORT}`}/enable/callback`;
}

app.get('/api/enable/banks', async (req, res) => {
  if (!enable.isConfigured()) {
    return res.status(501).json({ error: 'Enable Banking is not configured on the server' });
  }
  try {
    const banks = await enable.getBanks('GB');
    res.json({ banks: banks.map(b => b.name).sort() });
  } catch (err) {
    console.error('enable banks error:', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not load the bank list' });
  }
});

app.post('/api/enable/start', async (req, res) => {
  if (!enable.isConfigured()) {
    return res.status(501).json({ error: 'Enable Banking is not configured on the server' });
  }
  const { bankName, psuType } = req.body;
  if (!bankName || !['personal', 'business'].includes(psuType)) {
    return res.status(400).json({ error: 'Choose a bank and account type' });
  }
  try {
    const state = uuidv4();
    const url = await enable.startAuth({ bankName, psuType, state, redirectUrl: enableRedirectUrl() });
    req.session.enableAuth = { state, bankName, psuType };
    res.json({ url });
  } catch (err) {
    console.error('enable start error:', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not start the bank connection' });
  }
});

// The bank sends the user back here; `state` must match what we stored for
// this browser session before the one-time code is exchanged.
app.get('/enable/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const pending = req.session.enableAuth;
  delete req.session.enableAuth;

  if (error) return res.redirect(`/?error=${encodeURIComponent(String(error))}`);
  if (!pending || !code || state !== pending.state) {
    return res.redirect('/?error=Bank connection expired, please try again');
  }

  try {
    const session = await enable.createSession(code);
    store.saveConnection({
      id: uuidv4(),
      label: pending.psuType === 'business' ? `${pending.bankName} (Business)` : pending.bankName,
      provider: 'Enable Banking',
      sessionId: session.session_id,
      validUntil: session.access?.valid_until || null,
      accounts: (session.accounts || []).map(a => ({
        uid: a.uid,
        iban: a.account_id?.iban,
        other: a.account_id?.other?.identification,
        name: a.name,
        details: a.details,
        currency: a.currency,
      })),
      connectedAt: Date.now(),
    });
    res.redirect('/?connected=true');
  } catch (err) {
    console.error('enable callback error:', err.response?.data || err.message);
    res.redirect('/?error=Failed to connect bank');
  }
});

// Banks only allow a few unattended reads per account per day, so Enable
// Banking data is cached and refreshed manually or after the cache expires.
const enableCache = new Map();
const ENABLE_CACHE_MS = (Number(process.env.ENABLE_CACHE_MINUTES) || 360) * 60_000;

async function loadEnableConnection(conn) {
  const hit = enableCache.get(conn.id);
  if (hit && Date.now() - hit.at < ENABLE_CACHE_MS) return hit;
  const data = await enable.loadConnection(conn);
  const entry = { ...data, at: Date.now() };
  enableCache.set(conn.id, entry);
  return entry;
}

app.post('/api/connections/:id/refresh', (req, res) => {
  enableCache.delete(req.params.id);
  res.json({ ok: true });
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
app.delete('/api/connections/:id', async (req, res) => {
  const conn = store.get(req.params.id);
  if (conn?.provider === 'Enable Banking' && conn.sessionId) {
    await enable.deleteSession(conn.sessionId);
  }
  enableCache.delete(req.params.id);
  store.remove(req.params.id);
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
      .slice(0, 20)
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
        validUntil: conn.validUntil || null,
      };
      try {
        if (conn.provider === 'Enable Banking') {
          const { accounts, cards, at } = await loadEnableConnection(conn);
          return { ...base, accounts, cards, fetchedAt: at };
        }
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
