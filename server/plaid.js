const axios = require('axios');
const store = require('./store');

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
  return { accessToken: data.access_token, itemId: data.item_id };
}

async function getAccounts(accessToken) {
  const { data } = await client().post('/accounts/get', {
    client_id: CLIENT_ID,
    secret: SECRET,
    access_token: accessToken,
  });
  return data.accounts || [];
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

// /transactions/sync is Plaid's current recommended endpoint — cursor-based
// incremental updates instead of re-fetching a date range every poll, which
// fits a "live" dashboard better than the older /transactions/get.
async function syncTransactions(conn) {
  let cursor = conn.transactionsCursor || null;
  let added = [];
  let modified = [];
  let removed = [];
  let hasMore = true;

  while (hasMore) {
    const { data } = await client().post('/transactions/sync', {
      client_id: CLIENT_ID,
      secret: SECRET,
      access_token: conn.accessToken,
      cursor,
      count: 100,
    });
    added = added.concat(data.added || []);
    modified = modified.concat(data.modified || []);
    removed = removed.concat(data.removed || []);
    hasMore = data.has_more;
    cursor = data.next_cursor;
  }

  const removedIds = new Set(removed.map(r => r.transaction_id));
  const modifiedById = new Map(modified.map(t => [t.transaction_id, t]));
  const merged = (conn.transactions || [])
    .filter(t => !removedIds.has(t.transaction_id))
    .map(t => modifiedById.get(t.transaction_id) || t)
    .concat(added);

  // Keep the most recent 200 across all accounts so this doesn't grow forever
  merged.sort((a, b) => new Date(b.date) - new Date(a.date));
  const trimmed = merged.slice(0, 200);

  store.updateTransactions(conn.id, { cursor, transactions: trimmed });
  return trimmed;
}

module.exports = {
  createLinkToken,
  exchangePublicToken,
  getAccounts,
  getItem,
  getInstitution,
  syncTransactions,
};
