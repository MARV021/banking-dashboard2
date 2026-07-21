const axios = require('axios');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const API_URL = process.env.ENABLEBANKING_API_URL || 'https://api.enablebanking.com';

function getPrivateKey() {
  if (process.env.ENABLEBANKING_PRIVATE_KEY_PATH) {
    return fs.readFileSync(process.env.ENABLEBANKING_PRIVATE_KEY_PATH, 'utf8');
  }
  return process.env.ENABLEBANKING_PRIVATE_KEY;
}

// App-level auth: every request is signed with the app's own private key,
// not a per-user access token — the consent (session) is what scopes access.
function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 },
    getPrivateKey(),
    { algorithm: 'RS256', header: { typ: 'JWT', alg: 'RS256', kid: process.env.ENABLEBANKING_APP_ID } }
  );
}

function api() {
  return axios.create({
    baseURL: API_URL,
    headers: { Authorization: `Bearer ${appJwt()}` },
  });
}

async function getAspsps(country = 'GB') {
  const { data } = await api().get('/aspsps', { params: { country } });
  return data.aspsps || [];
}

// Kicks off the bank's own login/consent screen — returns the URL to redirect the user to
async function startAuth({ aspspName, country, redirectUrl, state }) {
  const { data } = await api().post('/auth', {
    access: { valid_until: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString() },
    aspsp: { name: aspspName, country },
    state,
    redirect_url: redirectUrl,
    psu_type: 'personal',
  });
  return data.url;
}

// Exchanges the ?code=... from the redirect for a session covering the linked accounts
async function createSession(code) {
  const { data } = await api().post('/sessions', { code });
  return data; // { session_id, accounts: [...] }
}

async function getBalances(accountUid) {
  const { data } = await api().get(`/accounts/${accountUid}/balances`);
  return data.balances || [];
}

async function getTransactions(accountUid) {
  const { data } = await api().get(`/accounts/${accountUid}/transactions`);
  return data.transactions || [];
}

module.exports = {
  getAspsps,
  startAuth,
  createSession,
  getBalances,
  getTransactions,
};
