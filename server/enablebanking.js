const axios = require('axios');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const BASE = process.env.ENABLE_API_BASE || 'https://api.enablebanking.com';

function privateKey() {
  if (process.env.ENABLE_PRIVATE_KEY) {
    return process.env.ENABLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  if (process.env.ENABLE_PRIVATE_KEY_PATH) {
    return fs.readFileSync(process.env.ENABLE_PRIVATE_KEY_PATH, 'utf8');
  }
  throw new Error('Enable Banking private key is not configured');
}

function isConfigured() {
  return Boolean(
    process.env.ENABLE_APP_ID &&
    (process.env.ENABLE_PRIVATE_KEY || process.env.ENABLE_PRIVATE_KEY_PATH)
  );
}

// Every request carries a short-lived RS256 JWT signed with the application's
// private key; the application id goes in the `kid` header.
function client() {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 },
    privateKey(),
    { algorithm: 'RS256', header: { typ: 'JWT', alg: 'RS256', kid: process.env.ENABLE_APP_ID } }
  );
  return axios.create({
    baseURL: BASE,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });
}

let bankCache = { at: 0, banks: [] };

async function getBanks(country = 'GB') {
  if (Date.now() - bankCache.at < 60 * 60 * 1000 && bankCache.banks.length) return bankCache.banks;
  const { data } = await client().get('/aspsps', { params: { country } });
  bankCache = { at: Date.now(), banks: data.aspsps || [] };
  return bankCache.banks;
}

async function startAuth({ bankName, country = 'GB', psuType = 'personal', state, redirectUrl }) {
  const banks = await getBanks(country);
  const bank = banks.find(b => b.name === bankName);
  if (!bank) throw new Error('Unknown bank');

  // Consent can't outlast the bank's own maximum; stay a minute under it.
  const maxSeconds = bank.maximum_consent_validity || 90 * 86400;
  const validUntil = new Date(Date.now() + Math.min(maxSeconds, 180 * 86400) * 1000 - 60_000).toISOString();

  const { data } = await client().post('/auth', {
    access: { valid_until: validUntil },
    aspsp: { name: bank.name, country },
    state,
    redirect_url: redirectUrl,
    psu_type: psuType,
  });
  return data.url;
}

async function createSession(code) {
  const { data } = await client().post('/sessions', { code });
  return data;
}

async function deleteSession(sessionId) {
  try { await client().delete(`/sessions/${sessionId}`); } catch { /* best effort */ }
}

const num = b => (b?.balance_amount?.amount != null ? Number(b.balance_amount.amount) : null);

function pickBalance(balances = [], fallbackCurrency) {
  const by = type => balances.find(b => b.balance_type === type);
  const current = by('CLBD') || by('ITBD') || by('OPBD') || balances[0];
  const available = by('CLAV') || by('ITAV') || by('XPCD');
  return {
    current: num(current),
    available: available ? num(available) : null,
    currency: current?.balance_amount?.currency || fallbackCurrency || 'GBP',
  };
}

function mapTransaction(t) {
  const isCredit = t.credit_debit_indicator === 'CRDT';
  const amount = Number(t.transaction_amount?.amount || 0);
  const counterparty = isCredit ? t.debtor?.name : t.creditor?.name;
  const reference = Array.isArray(t.remittance_information) ? t.remittance_information.join(' ') : '';
  return {
    description: counterparty || reference || 'Transaction',
    amount: isCredit ? amount : -amount,
    timestamp: t.booking_date || t.value_date || t.transaction_date || null,
    transaction_classification: [],
  };
}

async function getTransactions(c, uid) {
  const dateFrom = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const out = [];
  let key = null;
  for (let page = 0; page < 10; page++) {
    const { data } = await c.get(`/accounts/${uid}/transactions`, {
      params: { date_from: dateFrom, ...(key ? { continuation_key: key } : {}) },
    });
    out.push(...(data.transactions || []));
    key = data.continuation_key;
    if (!key) break;
  }
  return out;
}

function maskedAccountNumber(acct) {
  const id = acct.iban || acct.other || '';
  return id ? `•••• ${String(id).slice(-4)}` : '';
}

async function loadConnection(conn) {
  const c = client();
  const accounts = await Promise.all((conn.accounts || []).map(async acct => {
    const [{ data: bal }, txns] = await Promise.all([
      c.get(`/accounts/${acct.uid}/balances`),
      getTransactions(c, acct.uid),
    ]);
    return {
      account_id: acct.uid,
      display_name: acct.details || acct.name || acct.iban || 'Account',
      account_type: 'account',
      account_number: { number: maskedAccountNumber(acct) },
      balance: pickBalance(bal.balances, acct.currency),
      transactions: txns
        .map(mapTransaction)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    };
  }));
  return { accounts, cards: [] };
}

module.exports = {
  isConfigured, getBanks, startAuth, createSession, deleteSession, loadConnection,
  _internal: { pickBalance, mapTransaction },
};
