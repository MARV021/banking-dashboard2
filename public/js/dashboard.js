// Live refresh interval in milliseconds
const REFRESH_MS = 30_000;

let refreshTimer = null;
let allData = [];

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  handleUrlParams();
  refresh();
  refreshTimer = setInterval(refresh, REFRESH_MS);
});

function handleUrlParams() {
  const p = new URLSearchParams(location.search);
  if (p.get('connected') === 'true') showNotif('Bank connected successfully!', 'success');
  if (p.get('error')) showNotif('Error: ' + p.get('error'), 'error');
  if (p.get('connected') || p.get('error')) {
    history.replaceState(null, '', '/');
  }
}

// ── Data fetching ─────────────────────────────────────────────────────────────
async function refresh() {
  setLiveState('fetching');
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allData = await res.json();
    render(allData);
    setLiveState('live');
  } catch (err) {
    setLiveState('error');
    console.error('Refresh failed:', err);
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(data) {
  const empty  = document.getElementById('emptyState');
  const feeds  = document.getElementById('feeds');

  if (!data.length) {
    empty.style.display = 'flex';
    feeds.innerHTML = '';
    updateSummary([], 0, 0, 0);
    return;
  }

  empty.style.display = 'none';

  // Summary totals
  let totalBalance = 0, totalAccounts = 0, totalTxns = 0;
  data.forEach(bank => {
    const items = [...bank.accounts, ...bank.cards];
    items.forEach(acct => {
      if (acct.balance?.available != null) totalBalance += acct.balance.available;
      else if (acct.balance?.current != null) totalBalance += acct.balance.current;
      totalTxns += acct.transactions?.length || 0;
    });
    totalAccounts += items.length;
  });
  updateSummary(totalBalance, data.length, totalAccounts, totalTxns);

  // Only re-render cards that changed (avoid full DOM thrash)
  const existing = new Set([...feeds.querySelectorAll('[data-connection-id]')].map(el => el.dataset.connectionId));
  const incoming = new Set(data.map(d => d.connectionId));

  // Remove stale
  existing.forEach(id => { if (!incoming.has(id)) feeds.querySelector(`[data-connection-id="${id}"]`)?.remove(); });

  data.forEach(bank => {
    const existing = feeds.querySelector(`[data-connection-id="${bank.connectionId}"]`);
    const html = buildBankCard(bank);
    if (existing) {
      existing.outerHTML = html;
    } else {
      feeds.insertAdjacentHTML('beforeend', html);
    }
  });
}

function updateSummary(balance, banks, accounts, txns) {
  document.getElementById('totalBalance').textContent  = typeof balance === 'number' ? fmt(balance, 'GBP') : '—';
  document.getElementById('totalBanks').textContent    = banks;
  document.getElementById('totalAccounts').textContent = accounts;
  document.getElementById('totalTxns').textContent     = txns;
}

// ── Bank card HTML ─────────────────────────────────────────────────────────────
function buildBankCard(bank) {
  const items = [...bank.accounts, ...bank.cards];
  const initial = (bank.label || bank.provider || 'B')[0].toUpperCase();
  const color = stringToColor(bank.connectionId);

  return `
  <div class="bank-card" data-connection-id="${bank.connectionId}">
    <div class="bank-card-header">
      <div class="bank-card-title">
        <div class="bank-avatar" style="background:${color}">${initial}</div>
        <div>
          <div>${esc(bank.label)}</div>
          <div class="bank-meta">${esc(bank.provider)} &middot; ${items.length} account${items.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div class="bank-actions">
        <span class="fetching-badge" title="Last updated ${new Date(bank.fetchedAt).toLocaleTimeString()}">
          Updated ${timeAgo(bank.fetchedAt)}
        </span>
        <button class="btn-danger" onclick="disconnect('${bank.connectionId}')">Disconnect</button>
      </div>
    </div>
    <div class="accounts-grid">
      ${items.map(acct => buildAccountPanel(acct)).join('')}
    </div>
  </div>`;
}

function buildAccountPanel(acct) {
  const isCard = acct.card_type != null;
  const balance = acct.balance;
  const txns = acct.transactions || [];

  const current   = balance?.current   ?? balance?.total_current ?? null;
  const available = balance?.available ?? balance?.total_available ?? null;
  const currency  = balance?.currency || acct.currency || 'GBP';

  const displayName = acct.display_name || acct.account_type || 'Account';
  const sortCode    = acct.account_number?.sort_code || '';
  const number      = acct.account_number?.number || acct.account_number?.iban || '';

  return `
  <div class="account-panel">
    <div class="account-header">
      <div>
        <div class="account-name">${esc(displayName)}</div>
        <div class="account-number">${sortCode ? sortCode + ' ' : ''}${number}</div>
      </div>
      <div class="account-type ${isCard ? 'card' : ''}">${isCard ? 'Card' : (acct.account_type || 'Account')}</div>
    </div>

    <div class="balance-block">
      <div class="balance-label">Current Balance</div>
      <div class="balance-amount ${current < 0 ? 'negative' : ''}">
        ${current != null ? fmt(current, currency) : '—'}
      </div>
      ${available != null && available !== current
        ? `<div class="balance-available">Available: ${fmt(available, currency)}</div>`
        : ''}
    </div>

    ${txns.length ? `
    <div class="txn-heading">Recent Transactions</div>
    <div class="txn-list">
      ${txns.slice(0, 6).map(t => buildTxnRow(t, currency)).join('')}
    </div>
    ${txns.length > 6 ? `<div class="show-more" onclick="this.parentElement.querySelector('.txn-list').innerHTML = ${JSON.stringify(txns.map(t => buildTxnRow(t, currency)).join(''))};this.remove()">Show all ${txns.length} transactions</div>` : ''}
    ` : '<div style="color:var(--muted);font-size:12px;text-align:center;padding:12px 0">No recent transactions</div>'}
  </div>`;
}

function buildTxnRow(t, currency) {
  const amount  = t.amount ?? 0;
  const isCredit = amount > 0 || t.transaction_type === 'CREDIT';
  const desc    = t.description || t.merchant?.name || 'Transaction';
  const date    = t.timestamp ? new Date(t.timestamp).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '';
  const icon    = txnIcon(t.transaction_classification?.[0] || t.transaction_category || '');

  return `
  <div class="txn-row">
    <div class="txn-left">
      <div class="txn-icon">${icon}</div>
      <div>
        <div class="txn-desc" title="${esc(desc)}">${esc(desc)}</div>
        <div class="txn-date">${date}</div>
      </div>
    </div>
    <div class="txn-amount ${isCredit ? 'credit' : 'debit'}">
      ${isCredit ? '+' : ''}${fmt(Math.abs(amount), currency)}
    </div>
  </div>`;
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function connectBank() {
  try {
    const res = await fetch('/api/create-link-token', { method: 'POST' });
    const { link_token, error } = await res.json();
    if (error) { showNotif('Error: ' + error, 'error'); return; }

    const handler = Plaid.create({
      token: link_token,
      onSuccess: async (public_token, metadata) => {
        await fetch('/api/exchange-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ public_token, metadata }),
        });
        showNotif('Bank connected successfully!', 'success');
        refresh();
      },
      onExit: (err) => {
        if (err) showNotif('Connection cancelled', 'error');
      },
    });
    handler.open();
  } catch (err) {
    showNotif('Failed to open bank connection', 'error');
  }
}

async function connectTrueLayer() {
  try {
    const res = await fetch('/api/connect-url');
    const { url, error } = await res.json();
    if (error) { showNotif('Error: ' + error, 'error'); return; }
    window.location.href = url;
  } catch (err) {
    showNotif('Failed to open bank connection', 'error');
  }
}

async function disconnect(id) {
  if (!confirm('Disconnect this bank account?')) return;
  await fetch(`/api/connections/${id}`, { method: 'DELETE' });
  refresh();
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setLiveState(state) {
  const ind = document.getElementById('liveIndicator');
  const upd = document.getElementById('lastUpdated');
  if (state === 'fetching') {
    upd.textContent = 'Updating…';
  } else if (state === 'live') {
    ind.style.color = 'var(--green)';
    upd.textContent = 'Updated ' + new Date().toLocaleTimeString();
  } else {
    ind.style.color = 'var(--red)';
    upd.textContent = 'Update failed';
  }
}

function showNotif(msg, type = 'success') {
  const el = document.getElementById('notif');
  el.innerHTML = `<div class="notif-inner notif-${type}">${esc(msg)}</div>`;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// ── Formatters ────────────────────────────────────────────────────────────────
function fmt(amount, currency = 'GBP') {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency', currency,
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(amount);
}

function timeAgo(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h},60%,40%)`;
}

function txnIcon(category) {
  const map = {
    'eating out': '🍔', 'food': '🛒', 'groceries': '🛒', 'shopping': '🛍️',
    'transport': '🚗', 'travel': '✈️', 'entertainment': '🎬', 'bills': '📄',
    'utilities': '💡', 'health': '💊', 'income': '💰', 'salary': '💰',
    'transfer': '↔️', 'atm': '🏧', 'fees': '💳', 'interest': '📈',
  };
  const key = (category || '').toLowerCase();
  for (const [k, v] of Object.entries(map)) if (key.includes(k)) return v;
  return '💳';
}
