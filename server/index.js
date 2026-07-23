require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const plaid = require('./plaid');
const truelayer = require('./truelayer');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ── Shared-password login gate ────────────────────────────────────────────────
// One password for everyone with access (colleagues viewing the same company
// accounts) — not per-user accounts, since there's only one set of connected
// banks to view, not one per person.
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/auth/callback']);

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Incorrect password' });
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

// ── TrueLayer: sandbox Open Banking redirect flow ────────────────────────────
app.get('/api/connect-url', (req, res) => {
  res.json({ url: truelayer.getAuthUrl() });
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);

  try {
    const tokens = await truelayer.exchangeCode(code);
    const info   = await truelayer.getInfo(tokens.access_token);

    store.saveConnection({
      id: uuidv4(),
      label: info?.full_name || 'Bank',
      provider: 'TrueLayer',
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt:    Date.now() + tokens.expires_in * 1000,
      connectedAt: Date.now(),
    });

    res.redirect('/?connected=true');
  } catch (err) {
    console.error('auth/callback error:', err.response?.data || err.message);
    res.redirect('/?error=Failed to connect bank');
  }
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
app.delete('/api/connections/:id', (req, res) => {
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

async function loadTrueLayerConnection(conn) {
  const token = await truelayer.ensureFreshToken(conn);

  const [accountList, cardList] = await Promise.all([
    truelayer.getAccounts(token),
    truelayer.getCards(token),
  ]);

  const accounts = await Promise.all(accountList.map(async (acct) => {
    const [balance, transactions] = await Promise.all([
      truelayer.getBalance(token, acct.account_id),
      truelayer.getTransactions(token, acct.account_id),
    ]);
    return {
      account_id: acct.account_id,
      display_name: acct.display_name,
      account_type: acct.account_type,
      account_number: acct.account_number,
      balance,
      transactions: transactions.slice(0, 20),
    };
  }));

  const cards = await Promise.all(cardList.map(async (card) => {
    const [balance, transactions] = await Promise.all([
      truelayer.getCardBalance(token, card.account_id),
      truelayer.getCardTransactions(token, card.account_id),
    ]);
    return {
      account_id: card.account_id,
      display_name: card.display_name,
      card_type: card.card_type,
      balance,
      transactions: transactions.slice(0, 20),
    };
  }));

  return { accounts, cards };
}

// ── Live data: accounts + transactions for all connections ────────────────────
app.get('/api/data', async (req, res) => {
  const connections = store.getAll();
  if (!connections.length) return res.json([]);

  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      const { accounts, cards } = conn.provider === 'TrueLayer'
        ? await loadTrueLayerConnection(conn)
        : await loadPlaidConnection(conn);

      return {
        connectionId: conn.id,
        label: conn.label,
        provider: conn.provider,
        accounts,
        cards,
        fetchedAt: Date.now(),
      };
    })
  );

  res.json(results.filter(r => r.status === 'fulfilled').map(r => r.value));
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
