# Business Banking Dashboard — Setup Guide

## What this does
A live multi-bank dashboard powered by Plaid. Connect as many bank accounts as you want via Plaid Link. Balances and transactions auto-refresh every 30 seconds using Plaid's `/transactions/sync` endpoint.

**Cost note:** Plaid Sandbox (fake test banks) is free forever. Connecting real accounts in Production costs money — see pricing below.

---

## Step 1 — Create a Plaid account

1. Go to https://dashboard.plaid.com/signup and sign up (free)
2. Go to **Team Settings → Keys** to get your `client_id` and `secret`
3. Start in **Sandbox** — fake test banks, no real money, no cost

---

## Step 2 — Configure the app

Edit `.env`:
```
PLAID_CLIENT_ID=your_actual_client_id
PLAID_SECRET=your_sandbox_secret
PLAID_ENV=sandbox
```

---

## Step 3 — Install & run

```bash
cd banking-dashboard
npm install
npm start
```

Open https://localhost:3000 (accept the local dev certificate warning once).

---

## Step 4 — Connect a bank

1. Click **+ Connect Bank**
2. Plaid Link opens — in Sandbox, search for any bank name and log in with:
   - Username: `user_good`
   - Password: `pass_good`
3. You're redirected back and your live feed appears

---

## Going to production (real accounts, real cost)

1. Apply for Production access in the Plaid dashboard
2. Swap in your **Production** secret and set `PLAID_ENV=production`
3. Replace the in-memory store (`server/store.js`) with a real database — access tokens are sensitive and must be **encrypted at rest**
4. Use HTTPS with a real certificate, not the local `mkcert` cert

### Pricing (pay-as-you-go, per Vendr's reported figures — Plaid doesn't publish a public rate card)

| Product | Price per successful call |
|---|---|
| Balance | $0.05 – $0.15 |
| Auth | $0.10 – $0.25 |
| Identity | $0.15 – $0.30 |
| Transactions | $0.30 – $0.60 |
| Income | $1.00 – $3.00+ |

- Reported median annual spend across Plaid customers: **~$9,230/year** ($6,667–$45,000 typical range)
- Small-scale commercial minimums: **$1,000–$3,000/month**
- Implementation/onboarding fees on larger contracts: **$5,000–$25,000+**

This app only uses the **Transactions** and **Balance** products (via `/accounts/get` + `/transactions/sync`), so real usage would land toward the lower end of that table — but there's no way to get real Production pricing without applying through Plaid's dashboard.

---

## Features

| Feature | Detail |
|---|---|
| Multiple banks | Connect unlimited accounts — each gets its own card |
| Live refresh | Balances + transactions update every 30 seconds |
| Incremental sync | Uses `/transactions/sync` (cursor-based), not a full re-fetch every poll |
| Disconnect | Remove any bank in one click |
