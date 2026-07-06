const axios = require('axios');

const BASE = process.env.PLAID_ENV === 'production'
  ? 'https://production.plaid.com'
  : 'https://sandbox.plaid.com';
const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET    = process.env.PLAID_SECRET;

function client() {
  return axios.create({
    baseURL: BASE,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function createLinkToken() {
  const { data } = await client().post('/link/token/create', {
    client_id: CLIENT_ID,
    secret: SECRET,
    client_name: 'Business Banking Dashboard',
    country_codes: ['GB', 'US'],
    language: 'en',
    user: { client_user_id: 'business-user' },
    products: ['transactions'],
  });
  return data.link_token;
}

async function exchangePublicToken(publicToken) {
  const { data } = await client().post('/item/public_token/exchange', {
    client_id: CLIENT_ID,
    secret: SECRET,
    public_token: publicToken,
  });
  return data.access_token;
}

async function getAccounts(accessToken) {
  const { data } = await client().post('/accounts/get', {
    client_id: CLIENT_ID,
    secret: SECRET,
    access_token: accessToken,
  });
  return data.accounts || [];
}

async function getTransactions(accessToken) {
  const end   = new Date().toISOString().split('T')[0];
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const { data } = await client().post('/transactions/get', {
    client_id: CLIENT_ID,
    secret: SECRET,
    access_token: accessToken,
    start_date: start,
    end_date: end,
    options: { count: 50 },
  });
  return data.transactions || [];
}

async function getItem(accessToken) {
  const { data } = await client().post('/item/get', {
    client_id: CLIENT_ID,
    secret: SECRET,
    access_token: accessToken,
  });
  return data.item || null;
}

async function getInstitution(institutionId) {
  try {
    const { data } = await client().post('/institutions/get_by_id', {
      client_id: CLIENT_ID,
      secret: SECRET,
      institution_id: institutionId,
      country_codes: ['GB', 'US'],
    });
    return data.institution || null;
  } catch { return null; }
}

module.exports = {
  createLinkToken,
  exchangePublicToken,
  getAccounts,
  getTransactions,
  getItem,
  getInstitution,
};
