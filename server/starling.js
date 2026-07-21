const axios = require('axios');

// Personal Access Token — generated once at https://developer.starlingbank.com,
// no OAuth dance needed since it only ever grants access to your own account.
const API_URL = process.env.STARLING_API_URL || 'https://api.starlingbank.com';

function api(token) {
  return axios.create({
    baseURL: API_URL,
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function getAccounts(token) {
  const { data } = await api(token).get('/api/v2/accounts');
  return data.accounts || [];
}

async function getIdentifiers(token, accountUid) {
  try {
    const { data } = await api(token).get(`/api/v2/accounts/${accountUid}/identifiers`);
    return data;
  } catch {
    return null;
  }
}

async function getBalance(token, accountUid) {
  const { data } = await api(token).get(`/api/v2/accounts/${accountUid}/balance`);
  return data;
}

// Last 30 days, matching the window used for the other providers
async function getTransactions(token, accountUid, categoryUid) {
  const minTransactionTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const maxTransactionTimestamp = new Date().toISOString();
  const { data } = await api(token).get(
    `/api/v2/feed/account/${accountUid}/category/${categoryUid}/transactions-between`,
    { params: { minTransactionTimestamp, maxTransactionTimestamp } }
  );
  return data.feedItems || [];
}

module.exports = {
  getAccounts,
  getIdentifiers,
  getBalance,
  getTransactions,
};
