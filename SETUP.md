# Business Banking Dashboard — Setup Guide

## What this does
A live multi-bank dashboard for your business. Connect as many bank accounts as you want via TrueLayer's Open Banking link. Balances and transactions auto-refresh every 30 seconds.

---

## Step 1 — Create a TrueLayer account

1. Go to https://console.truelayer.com and sign up (free)
2. Create a new **Application**
3. In the app settings set **Redirect URI** to: `http://localhost:3000/auth/callback`
4. Copy your **Client ID** and **Client Secret**

> Use **Sandbox** mode first — it gives you fake test banks with no real money involved.

---

## Step 2 — Configure the app

```bash
cd banking-dashboard
cp .env.example .env
```

Edit `.env` and fill in your TrueLayer credentials:

```
TRUELAYER_CLIENT_ID=your_actual_client_id
TRUELAYER_CLIENT_SECRET=your_actual_client_secret
SESSION_SECRET=some-long-random-string-here
```

---

## Step 3 — Install & run

```bash
npm install
npm start
```

Open http://localhost:3000 in your browser.

---

## Step 4 — Connect your first bank

1. Click **+ Connect Bank**
2. TrueLayer's bank selector opens — choose your bank
3. Log in with your bank credentials (TrueLayer never stores them)
4. You're redirected back and your live feed appears

Repeat for every business account. Each bank gets its own card.

---

## Going to production

1. Change `TRUELAYER_AUTH_URL` and `TRUELAYER_API_URL` in `.env` to the live URLs:
   ```
   TRUELAYER_AUTH_URL=https://auth.truelayer.com
   TRUELAYER_API_URL=https://api.truelayer.com
   ```
2. Update `APP_URL` and `REDIRECT_URI` to your real domain
3. Add the production redirect URI in the TrueLayer console
4. Replace the in-memory store (`server/store.js`) with a real database — tokens contain sensitive data and must be **encrypted at rest**
5. Use HTTPS — required by TrueLayer in production

---

## Features

| Feature | Detail |
|---|---|
| Multiple banks | Connect unlimited accounts — each gets its own card |
| Live refresh | Balances + transactions update every 30 seconds |
| Token refresh | Access tokens silently refresh before they expire |
| Bank cards + current accounts | Both shown side by side |
| Transaction icons | Auto-categorised with emoji |
| Disconnect | Remove any bank in one click |
