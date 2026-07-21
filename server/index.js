require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const starling = require('./starling');
const enablebanking = require('./enablebanking');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

// Short-lived correlation of Enable Banking's `state` param -> which bank the
// user picked, so the callback can label the connection without another round trip.
const pendingEnableBankingAuth = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// ── Starling: direct Personal Access Token, no redirect flow needed ──────────
app.post('/api/connect/starling', async (req, res) => {
  const token = process.env.STARLING_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    return res.status(400).json({ error: 'Set STARLING_PERSONAL_ACCESS_TOKEN in .env first' });
  }
  try {
    const accounts = await starling.getAccounts(token);
    store.saveConnection({
      id: uuidv4(),
      label: 'Starling',
      provider: 'Starling',
      starling: true,
      accessToken: token,
      connectedAt: Date.now(),
    });
    res.json({ ok: true, accounts: accounts.length });
  } catch (err) {
    console.error('connect/starling error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to connect Starling — check the personal access token' });
  }
});

// ── Enable Banking: bank picker + PSD2 consent redirect flow ─────────────────
app.get('/api/aspsps', async (req, res) => {
  try {
    const aspsps = await enablebanking.getAspsps(req.query.country || 'GB');
    res.json(aspsps);
  } catch (err) {
    console.error('aspsps error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to load bank list' });
  }
});

app.get('/api/connect/enablebanking', async (req, res) => {
  const { aspsp, country } = req.query;
  if (!aspsp) return res.status(400).json({ error: 'aspsp is required' });

  try {
    const state = uuidv4();
    const redirectUrl = `${process.env.APP_URL}/auth/enablebanking/callback`;
    const url = await enablebanking.startAuth({
      aspspName: aspsp,
      country: country || 'GB',
      redirectUrl,
      state,
    });
    pendingEnableBankingAuth.set(state, { aspsp });
    res.json({ url });
  } catch (err) {
    console.error('connect/enablebanking error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to start bank connection' });
  }
});

app.get('/auth/enablebanking/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);

  const pending = pendingEnableBankingAuth.get(state);
  pendingEnableBankingAuth.delete(state);

  try {
    const ebSession = await enablebanking.createSession(code);
    store.saveConnection({
      id: uuidv4(),
      label: pending?.aspsp || 'Bank',
      provider: 'Enable Banking',
      sessionId: ebSession.session_id,
      accountUids: (ebSession.accounts || []).map(a => a.uid || a.account_id),
      connectedAt: Date.now(),
    });
    res.redirect('/?connected=true');
  } catch (err) {
    console.error('auth/enablebanking/callback error:', err.response?.data || err.message);
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

// ── Normalize each provider's shape into one the dashboard understands ───────
async function loadStarlingConnection(conn) {
  const accounts = await starling.getAccounts(conn.accessToken);

  const normalized = await Promise.all(accounts.map(async (acct) => {
    const [balance, identifiers, transactions] = await Promise.all([
      starling.getBalance(conn.accessToken, acct.accountUid),
      starling.getIdentifiers(conn.accessToken, acct.accountUid),
      starling.getTransactions(conn.accessToken, acct.accountUid, acct.defaultCategory),
    ]);

    return {
      account_id: acct.accountUid,
      display_name: acct.name || `Starling ${acct.accountType || ''}`.trim(),
      account_type: acct.accountType,
      account_number: {
        sort_code: identifiers?.sortCode || '',
        number: identifiers?.accountNumber || '',
      },
      balance: {
        current: (balance?.clearedBalance?.minorUnits ?? 0) / 100,
        available: (balance?.effectiveBalance?.minorUnits ?? balance?.clearedBalance?.minorUnits ?? 0) / 100,
        currency: balance?.clearedBalance?.currency || acct.currency || 'GBP',
      },
      transactions: transactions.slice(0, 20).map(t => ({
        description: t.counterPartyName || t.reference || 'Transaction',
        amount: (t.amount?.minorUnits ?? 0) / 100 * (t.direction === 'OUT' ? -1 : 1),
        timestamp: t.transactionTime,
        transaction_classification: t.spendingCategory ? [t.spendingCategory] : [],
      })),
    };
  }));

  return { accounts: normalized, cards: [] };
}

async function loadEnableBankingConnection(conn) {
  const accounts = await Promise.all((conn.accountUids || []).map(async (accountUid) => {
    const [balances, transactions] = await Promise.all([
      enablebanking.getBalances(accountUid),
      enablebanking.getTransactions(accountUid),
    ]);
    const balance = balances[0] || {};

    return {
      account_id: accountUid,
      display_name: balance.name || 'Account',
      account_type: balance.product || 'current',
      account_number: {
        number: balance.account_id?.iban || balance.account_id?.other?.identification || '',
      },
      balance: {
        current: Number(balance.balance_amount?.amount ?? 0),
        available: Number(balance.balance_amount?.amount ?? 0),
        currency: balance.balance_amount?.currency || 'GBP',
      },
      transactions: transactions.slice(0, 20).map(t => ({
        description: t.remittance_information?.[0] || t.creditor?.name || t.debtor?.name || 'Transaction',
        amount: Number(t.transaction_amount?.amount ?? 0),
        timestamp: t.booking_date || t.value_date,
        transaction_classification: [],
      })),
    };
  }));

  return { accounts, cards: [] };
}

// ── Live data: accounts + transactions for all connections ────────────────────
app.get('/api/data', async (req, res) => {
  const connections = store.getAll();
  if (!connections.length) return res.json([]);

  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      const { accounts, cards } = conn.provider === 'Starling'
        ? await loadStarlingConnection(conn)
        : await loadEnableBankingConnection(conn);

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
