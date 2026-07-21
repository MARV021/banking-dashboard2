# Business Banking Dashboard — Setup Guide

## What this does
A live multi-bank dashboard for your own business accounts. Two free connection methods:
- **Starling** — direct Personal Access Token, no OAuth needed
- **Any other UK bank** — Open Banking via Enable Banking's free "Restricted Production" tier, limited to accounts you link yourself

Balances and transactions auto-refresh every 30 seconds.

---

## Step 1 — Connect Starling (optional)

1. Log into your Starling account at https://developer.starlingbank.com
2. Go to **Personal Access** → generate a token, scanning the QR code with the Starling app
3. Grant `account:read`, `balance:read`, `transaction:read` permissions
4. Copy the token into `.env`:
   ```
   STARLING_PERSONAL_ACCESS_TOKEN=your_token_here
   ```

---

## Step 2 — Connect other UK banks via Enable Banking (optional)

1. Sign up at https://enablebanking.com/sign-in/ (free, email-based)
2. Go to **API applications** → **Add a new application**
   - Keep it in the **Sandbox** environment while testing, switch to **Production** (Restricted mode) once ready for your real accounts
   - Set the redirect URL to `https://localhost:3000/auth/enablebanking/callback`
3. Registering downloads a private key file (`.pem`) — save it into `certs/enablebanking-private-key.pem`
4. Copy your application ID into `.env`:
   ```
   ENABLEBANKING_APP_ID=your_application_id_here
   ENABLEBANKING_PRIVATE_KEY_PATH=./certs/enablebanking-private-key.pem
   ```
5. **Activate Restricted Production** in the Enable Banking control panel by linking your own account(s) — this keeps it free. Adding other people's accounts moves you onto their paid tier.

---

## Step 3 — Install & run

```bash
cd banking-dashboard
npm install
npm start
```

Open https://localhost:3000 in your browser (accept the local dev certificate warning once).

---

## Step 4 — Connect your accounts

- Click **+ Starling** to instantly connect using the token from `.env`
- Click **+ Other Bank** to pick a UK bank from the list, then log in with your bank credentials on their own site (Enable Banking never sees or stores them)

Repeat for every account. Each bank gets its own card.

---

## Going to production

1. Switch the Enable Banking application from Sandbox to **Production (Restricted mode)** in their control panel
2. Update `APP_URL` to your real domain and register the matching redirect URL with Enable Banking
3. Replace the in-memory store (`server/store.js`) with a real database — Starling tokens and Enable Banking session IDs are sensitive and must be **encrypted at rest**
4. Use HTTPS with a real certificate (Let's Encrypt), not the local `mkcert` cert
5. Starling's personal token is tied to your own account only — it doesn't need a "production" switch

---

## Features

| Feature | Detail |
|---|---|
| Multiple banks | Connect Starling plus any number of other UK banks — each gets its own card |
| Live refresh | Balances + transactions update every 30 seconds |
| No paid aggregator | Starling direct + Enable Banking's free Restricted Production tier — $0/month for tracking your own accounts |
| Transaction icons | Auto-categorised with emoji |
| Disconnect | Remove any bank in one click |
