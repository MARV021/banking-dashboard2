require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const truelayer = require('./truelayer');
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

// ── Step 1: frontend asks where to send the browser to connect a bank ────────
app.get('/api/connect-url', (req, res) => {
  res.json({ url: truelayer.getAuthUrl() });
});

// ── Step 2: TrueLayer redirects back here after the user logs into their bank ─
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

// ── Live data: accounts + transactions for all connections ────────────────────
app.get('/api/data', async (req, res) => {
  const connections = store.getAll();
  if (!connections.length) return res.json([]);

  const results = await Promise.allSettled(
    connections.map(async (conn) => {
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
