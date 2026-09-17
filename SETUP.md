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
PLAID_REDIRECT_URI=https://localhost:3000/plaid/oauth-callback
```

**Coutts (and most UK banks) need one extra step.** Coutts is on the UK Open
Banking network, which Plaid Link only supports via its OAuth redirect flow —
the non-OAuth flow used by US banks won't work for it. To enable that:

1. In the Plaid Dashboard, go to **Team Settings → API → Allowed redirect URIs**
2. Add `https://localhost:3000/plaid/oauth-callback` exactly (must match `PLAID_REDIRECT_URI` above, protocol and path included)
3. For a real Production connection, also add your production URL there once you have one

Without this, connecting Coutts through Plaid Link will fail or get stuck after you log in on Coutts' site.

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

Note: Sandbox only has fake test institutions, not the real Coutts — it's for
testing the flow, not real Coutts data. To connect your actual Coutts account
you need Production access (next section).

---

## Going to production (real accounts, real cost)

1. Apply for Production access in the Plaid dashboard
2. Swap in your **Production** secret and set `PLAID_ENV=production`
3. ✅ Done — `server/store.js` now encrypts tokens/transactions at rest (`server/crypto.js`), and `server/users.js` replaces the old shared password with per-colleague logins (`node scripts/manage-users.js add <email> <password>`)
4. Use HTTPS with a real certificate, not the local `mkcert` cert — handled automatically once deployed (see below)

---

## Deploying publicly (Render)

Everything above runs on your own Mac only. To make it reachable from the internet:

1. **Sign up at [render.com](https://render.com)** yourself — I can't create this account for you, and it needs your own GitHub OAuth approval to connect the repo.
2. Push this repo to GitHub if it isn't already (it is — `MARV021/banking-dashboard2`).
3. In Render: **New → Blueprint**, point it at this repo. It'll read [render.yaml](render.yaml), which is already set up with:
   - A **persistent Disk** mounted at the `data/` path — without this, Render's filesystem resets on every restart/deploy and you'd lose all connected banks and user accounts. This requires the **Starter** plan (~$7/month), not the free tier.
   - Every env var this app needs, pre-listed so Render prompts you for each one instead of you hunting through `.env`.
4. When Render prompts for the env vars marked "generate on deploy," use **fresh** values — don't reuse anything from `.env` or from any chat history:
   ```bash
   openssl rand -hex 32   # run twice: once for SESSION_SECRET, once for ENCRYPTION_KEY
   ```
5. Set `APP_URL` and `PLAID_REDIRECT_URI` to your real Render URL, e.g. `https://banking-dashboard.onrender.com` and `https://banking-dashboard.onrender.com/plaid/oauth-callback`.
6. Register that exact redirect URI in the Plaid dashboard (**Team Settings → API → Allowed redirect URIs**) — separately for Sandbox and, later, Production.
7. Once deployed, open Render's **Shell** tab for the service and run:
   ```bash
   node scripts/manage-users.js add ohudson@marv.com "a-new-real-password"
   node scripts/manage-users.js add finance@marv.com "a-different-new-password"
   ```
   (Don't reuse the two passwords from earlier in this conversation for the live, public version — generate new ones directly in that shell.)
8. Visit your Render URL, log in, and test connecting a bank the same way as locally.

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
