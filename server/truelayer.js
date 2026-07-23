const axios = require('axios');
const store = require('./store');

const AUTH_URL = process.env.TRUELAYER_AUTH_URL || 'https://auth.truelayer-sandbox.com';
const API_URL  = process.env.TRUELAYER_API_URL  || 'https://api.truelayer-sandbox.com';

// uk-cs-mock only exists in Sandbox (fake test banks). Production needs the
// real UK provider set, otherwise the bank picker has nothing to show.
const PROVIDERS = process.env.TRUELAYER_PROVIDERS
  || (AUTH_URL.includes('sandbox') ? 'uk-cs-mock' : 'uk-ob-all uk-oauth-all');

function getAuthUrl() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.TRUELAYER_CLIENT_ID,
    redirect_uri:  process.env.REDIRECT_URI,
    scope:         'info accounts balance cards transactions offline_access',
    providers:     PROVIDERS,
  });
  return `${AUTH_URL}/?${params.toString()}`;
}

async function exchangeCode(code) {
  const { data } = await axios.post(`${AUTH_URL}/connect/token`, new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     process.env.TRUELAYER_CLIENT_ID,
    client_secret: process.env.TRUELAYER_CLIENT_SECRET,
    redirect_uri:  process.env.REDIRECT_URI,
    code,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data;
}

async function refreshToken(conn) {
  const { data } = await axios.post(`${AUTH_URL}/connect/token`, new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     process.env.TRUELAYER_CLIENT_ID,
    client_secret: process.env.TRUELAYER_CLIENT_SECRET,
    refresh_token: conn.refreshToken,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  store.updateTokens(conn.id, {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:    Date.now() + data.expires_in * 1000,
  });

  return data.access_token;
}

// Returns a valid access token, refreshing if needed
async function ensureFreshToken(conn) {
  if (Date.now() < conn.expiresAt - 60_000) return conn.accessToken;
  return refreshToken(conn);
}

function api(token) {
  return axios.create({
    baseURL: API_URL,
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function getInfo(token) {
  try {
    const { data } = await api(token).get('/data/v1/info');
    return data.results?.[0] || null;
  } catch { return null; }
}

async function getAccounts(token) {
  const { data } = await api(token).get('/data/v1/accounts');
  return data.results || [];
}

async function getBalance(token, accountId) {
  const { data } = await api(token).get(`/data/v1/accounts/${accountId}/balance`);
  return data.results?.[0] || null;
}

async function getTransactions(token, accountId) {
  // Last 30 days
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const to   = new Date().toISOString().split('T')[0];
  const { data } = await api(token).get(
    `/data/v1/accounts/${accountId}/transactions?from=${from}&to=${to}`
  );
  return data.results || [];
}

async function getCards(token) {
  try {
    const { data } = await api(token).get('/data/v1/cards');
    return data.results || [];
  } catch { return []; }
}

async function getCardBalance(token, accountId) {
  try {
    const { data } = await api(token).get(`/data/v1/cards/${accountId}/balance`);
    return data.results?.[0] || null;
  } catch { return null; }
}

async function getCardTransactions(token, accountId) {
  try {
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const to   = new Date().toISOString().split('T')[0];
    const { data } = await api(token).get(
      `/data/v1/cards/${accountId}/transactions?from=${from}&to=${to}`
    );
    return data.results || [];
  } catch { return []; }
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  ensureFreshToken,
  getInfo,
  getAccounts,
  getBalance,
  getTransactions,
  getCards,
  getCardBalance,
  getCardTransactions,
};
