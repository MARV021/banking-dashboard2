require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const plaid = require('./plaid');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

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
    const accessToken = await plaid.exchangePublicToken(public_token);
    const item        = await plaid.getItem(accessToken);
    const institution = await plaid.getInstitution(item?.institution_id);

    const connectionId = uuidv4();
    store.saveConnection({
      id: connectionId,
      label: institution?.name || metadata?.institution?.name || 'Bank',
      provider: institution?.name || 'Unknown',
      accessToken,
      connectedAt: Date.now(),
    });

    res.json({ ok: true, connectionId });
  } catch (err) {
    console.error('exchange-token error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to connect bank' });
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

// ── Live data: accounts + transactions for all connections ────────────────────
app.get('/api/data', async (req, res) => {
  const connections = store.getAll();
  if (!connections.length) return res.json([]);

  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      const [accounts, transactions] = await Promise.allSettled([
        plaid.getAccounts(conn.accessToken),
        plaid.getTransactions(conn.accessToken),
      ]);

      const accountList = accounts.status === 'fulfilled' ? accounts.value : [];
      const txnList     = transactions.status === 'fulfilled' ? transactions.value : [];

      // Attach transactions to their account
      const enriched = accountList.map(acct => ({
        account_id:   acct.account_id,
        display_name: acct.name,
        account_type: acct.subtype || acct.type,
        account_number: { number: acct.mask ? `•••• ${acct.mask}` : '' },
        balance: {
          current:   acct.balances.current,
          available: acct.balances.available,
          currency:  acct.balances.iso_currency_code || 'GBP',
        },
        transactions: txnList
          .filter(t => t.account_id === acct.account_id)
          .slice(0, 20)
          .map(t => ({
            description: t.name,
            amount: -t.amount, // Plaid uses negative for debits
            timestamp: t.date,
            transaction_classification: t.category || [],
          })),
      }));

      return {
        connectionId: conn.id,
        label: conn.label,
        provider: conn.provider,
        accounts: enriched,
        cards: [],
        fetchedAt: Date.now(),
      };
    })
  );

  res.json(results.filter(r => r.status === 'fulfilled').map(r => r.value));
});

app.listen(PORT, () => {
  console.log(`Banking dashboard running at http://localhost:${PORT}`);
});
