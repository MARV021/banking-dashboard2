// Live refresh interval in milliseconds
const REFRESH_MS = 30_000;

const TXN_PAGE = 50;

let refreshTimer = null;
let allData = [];
let txnBankFilter = 'all';
let txnCategory = 'all';

const CATEGORIES = ['business', 'personal'];
let txnLimit = TXN_PAGE;

// ── Collapsed bank cards (persisted per-browser) ───────────────────────────────
function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem('collapsedBanks') || '[]'));
  } catch {
    return new Set();
  }
}
function saveCollapsed(set) {
  try { localStorage.setItem('collapsedBanks', JSON.stringify([...set])); } catch {}
}
let collapsedBanks = loadCollapsed();

function toggleBankCollapse(id) {
  if (collapsedBanks.has(id)) collapsedBanks.delete(id);
  else collapsedBanks.add(id);
  saveCollapsed(collapsedBanks);
  document.querySelector(`[data-connection-id="${id}"]`)?.classList.toggle('collapsed');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// From/To pickers show dd/mm/yyyy but keep the underlying input value as
// yyyy-mm-dd, which is what the filter compares against.
const datePickers = {};
function initDatePickers() {
  ['txnFrom', 'txnTo'].forEach(id => {
    datePickers[id] = flatpickr(`#${id}`, {
      dateFormat: 'Y-m-d',
      altInput: true,
      altFormat: 'd/m/Y',
      altInputClass: 'bank-filter date-input',
      allowInput: true,
      locale: { firstDayOfWeek: 1 },
      onChange: onTxnFilterChange,
    });
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initDatePickers();
  loadMe();
  handleUrlParams();
  if (!resumePlaidOAuthIfNeeded()) {
    refresh();
    refreshTimer = setInterval(refresh, REFRESH_MS);
  }
});

// Admins can connect/disconnect banks and see the activity log; viewers only
// see data. The server enforces this too, this just hides the buttons.
async function loadMe() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return;
    const me = await res.json();
    document.body.classList.remove('role-unknown');
    document.body.classList.add(`role-${me.role}`);
    document.getElementById('userBadge').innerHTML = `${esc(me.email)}<span class="role">${esc(me.role)}</span>`;
  } catch {}
}

function handleUrlParams() {
  const p = new URLSearchParams(location.search);
  if (p.get('connected') === 'true') showNotif('Bank connected successfully!', 'success');
  if (p.get('error')) showNotif('Error: ' + p.get('error'), 'error');
  if (p.get('connected') || p.get('error')) {
    history.replaceState(null, '', '/');
  }
}

// ── Plaid OAuth resume ───────────────────────────────────────────────────────
// After a UK Open Banking login (e.g. Coutts), Plaid redirects the browser
// back to PLAID_REDIRECT_URI with an oauth_state_id query param. Link must be
// re-opened with the *same* link_token used before the redirect, plus the
// full return URL, to complete the connection.
function resumePlaidOAuthIfNeeded() {
  const p = new URLSearchParams(location.search);
  if (!p.get('oauth_state_id')) return false;

  const linkToken = sessionStorage.getItem('plaid_link_token');
  if (!linkToken) {
    showNotif('Bank connection expired — please try connecting again.', 'error');
    history.replaceState(null, '', '/');
    return false;
  }

  const handler = Plaid.create({
    token: linkToken,
    receivedRedirectUri: window.location.href,
    onSuccess: onPlaidSuccess,
    onExit: onPlaidExit,
  });
  handler.open();
  sessionStorage.removeItem('plaid_link_token');
  history.replaceState(null, '', '/');
  return true;
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
  const groupCards = cat => document.querySelector(`#group-${cat} .group-cards`);

  const txnSection = document.getElementById('txnFeedSection');

  if (!data.length) {
    empty.style.display = 'flex';
    CATEGORIES.forEach(cat => {
      groupCards(cat).innerHTML = '';
      document.getElementById(`group-${cat}`).style.display = 'none';
    });
    txnSection.style.display = 'none';
    updateSummary([], 0, 0, 0);
    return;
  }

  empty.style.display = 'none';
  txnSection.style.display = 'block';

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
    const container = groupCards(bank.category);
    const html = buildBankCard(bank);
    if (existing && existing.parentElement === container) {
      existing.outerHTML = html;
    } else {
      existing?.remove();
      container.insertAdjacentHTML('beforeend', html);
    }
  });

  CATEGORIES.forEach(cat => {
    const banks = data.filter(b => b.category === cat);
    document.getElementById(`group-${cat}`).style.display = banks.length ? 'block' : 'none';
    // Only show a section total when its accounts share one currency
    const currencies = new Set(banks.flatMap(b => [...b.accounts, ...b.cards].map(a => a.balance?.currency || a.currency || 'GBP')));
    document.getElementById(`total-${cat}`).textContent = currencies.size === 1
      ? fmt(banks.reduce((sum, b) => sum + bankBalance(b), 0), [...currencies][0])
      : '';
  });

  renderUnifiedTransactions(data);
}

function bankBalance(bank) {
  return [...bank.accounts, ...bank.cards].reduce((sum, acct) => {
    const bal = acct.balance?.available ?? acct.balance?.current;
    return bal != null ? sum + bal : sum;
  }, 0);
}

// ── Unified transaction feed ────────────────────────────────────────────────────
function allTransactions(data) {
  const all = [];
  data.forEach(bank => {
    [...bank.accounts, ...bank.cards].forEach(acct => {
      const currency = acct.balance?.currency || acct.currency || 'GBP';
      (acct.transactions || []).forEach(t => {
        all.push({
          ...t,
          connectionId: bank.connectionId,
          category: bank.category,
          bankLabel: bank.label,
          accountName: acct.display_name,
          currency,
        });
      });
    });
  });
  all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return all;
}

function txnFilters() {
  return {
    q: document.getElementById('txnSearch').value.trim().toLowerCase(),
    direction: document.getElementById('txnDirection').value,
    from: document.getElementById('txnFrom').value,
    to: document.getElementById('txnTo').value,
  };
}

function filteredTransactions(data) {
  const { q, direction, from, to } = txnFilters();
  return allTransactions(data).filter(t => {
    if (!inSelectedBanks(t)) return false;
    if (direction === 'in' && !(t.amount > 0)) return false;
    if (direction === 'out' && !(t.amount < 0)) return false;
    const day = (t.timestamp || '').slice(0, 10);
    if (from && (!day || day < from)) return false;
    if (to && (!day || day > to)) return false;
    if (q) {
      const haystack = `${t.description || ''} ${t.bankLabel || ''} ${t.accountName || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

// Business/personal and bank filters, shared by the transaction list, the
// monthly summary and the CSV export.
function inSelectedBanks(t) {
  if (txnCategory !== 'all' && t.category !== txnCategory) return false;
  if (txnBankFilter !== 'all' && t.connectionId !== txnBankFilter) return false;
  return true;
}

function renderUnifiedTransactions(data) {
  const filterEl = document.getElementById('txnBankFilter');
  const listEl   = document.getElementById('txnFeedList');
  const moreEl   = document.getElementById('txnShowMore');

  // Rebuild the bank filter for the chosen section, keeping the current
  // selection if it's still valid
  const banks = data.filter(b => txnCategory === 'all' || b.category === txnCategory);
  const options = ['<option value="all">All banks</option>']
    .concat(banks.map(bank => `<option value="${bank.connectionId}">${esc(bank.label)}</option>`));
  filterEl.innerHTML = options.join('');
  if (!banks.some(b => b.connectionId === txnBankFilter)) txnBankFilter = 'all';
  filterEl.value = txnBankFilter;

  renderMonthlySummary(data);

  const list = filteredTransactions(data);
  document.getElementById('txnCount').textContent = list.length ? `(${list.length})` : '';

  if (!list.length) {
    listEl.innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:20px 0">No matching transactions</div>';
    moreEl.style.display = 'none';
    return;
  }

  listEl.innerHTML = list.slice(0, txnLimit).map(t => buildTxnRow(t, t.currency, true)).join('');
  moreEl.style.display = list.length > txnLimit ? 'block' : 'none';
  moreEl.textContent = `Show more (${list.length - txnLimit} left)`;
}

function onTxnFilterChange() {
  txnCategory = document.getElementById('txnCategory').value;
  txnBankFilter = document.getElementById('txnBankFilter').value;
  txnLimit = TXN_PAGE;
  renderUnifiedTransactions(allData);
}

function clearTxnFilters() {
  document.getElementById('txnSearch').value = '';
  Object.values(datePickers).forEach(picker => picker.clear(false));
  document.getElementById('txnDirection').value = 'all';
  document.getElementById('txnCategory').value = 'all';
  document.getElementById('txnBankFilter').value = 'all';
  onTxnFilterChange();
}

function showMoreTxns() {
  txnLimit += TXN_PAGE;
  renderUnifiedTransactions(allData);
}

// ── Monthly summary ────────────────────────────────────────────────────────────
// Money in / out per calendar month for the selected bank. Only the most
// common currency is summed, since adding different currencies together would
// be meaningless.
function renderMonthlySummary(data) {
  const section = document.getElementById('monthSection');
  const txns = allTransactions(data)
    .filter(t => t.timestamp && inSelectedBanks(t));

  const perCurrency = new Map();
  txns.forEach(t => perCurrency.set(t.currency, (perCurrency.get(t.currency) || 0) + 1));
  const currency = [...perCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'GBP';

  const months = new Map();
  txns.filter(t => t.currency === currency).forEach(t => {
    const key = t.timestamp.slice(0, 7);
    const m = months.get(key) || { in: 0, out: 0 };
    if (t.amount > 0) m.in += t.amount; else m.out += -t.amount;
    months.set(key, m);
  });

  const rows = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6);
  if (!rows.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const max = Math.max(...rows.map(([, m]) => Math.max(m.in, m.out)), 1);
  const pct = v => `${Math.max((v / max) * 100, 0.5).toFixed(1)}%`;

  document.getElementById('monthNote').textContent =
    'Based on transactions loaded from your banks' + (perCurrency.size > 1 ? ` · ${currency} only` : '');

  document.getElementById('monthList').innerHTML = rows.map(([key, m]) => {
    const label = new Date(`${key}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    const net = m.in - m.out;
    return `
    <div class="month-row">
      <div class="month-label">${label}</div>
      <div class="month-bars">
        <div class="month-bar"><span class="bar in" style="width:${pct(m.in)}"></span>In ${fmt(m.in, currency)}</div>
        <div class="month-bar"><span class="bar out" style="width:${pct(m.out)}"></span>Out ${fmt(m.out, currency)}</div>
      </div>
      <div class="month-net ${net < 0 ? 'negative' : ''}"><span class="month-net-label">Net</span>${net >= 0 ? '+' : ''}${fmt(net, currency)}</div>
    </div>`;
  }).join('');
}

// ── CSV export ─────────────────────────────────────────────────────────────────
// Exports whatever the filters currently show. Text cells starting with
// = + - @ are prefixed with ' so Excel doesn't run them as formulas.
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function exportCsv() {
  const list = filteredTransactions(allData);
  if (!list.length) { showNotif('No transactions to export', 'error'); return; }

  const header = ['Date', 'Description', 'Amount', 'Currency', 'Section', 'Bank', 'Account'];
  const lines = [header.join(',')].concat(list.map(t => [
    csvCell((t.timestamp || '').slice(0, 10)),
    csvCell(t.description),
    (t.amount ?? 0).toFixed(2),
    csvCell(t.currency),
    csvCell(t.category === 'personal' ? 'Personal' : 'Business'),
    csvCell(t.bankLabel),
    csvCell(t.accountName),
  ].join(',')));

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);

  fetch('/api/audit/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: list.length }),
  }).catch(() => {});
}

// ── Activity log (admins) ──────────────────────────────────────────────────────
const ACTIVITY_LABELS = {
  login_success: 'Logged in',
  login_failed: 'Failed login',
  '2fa_failed': 'Wrong 2FA code',
  '2fa_enrolled': 'Set up two-step login',
  logout: 'Logged out',
  bank_connected: 'Connected a bank',
  bank_disconnected: 'Disconnected a bank',
  bank_moved: 'Moved a bank between sections',
  transactions_exported: 'Exported transactions',
  user_added: 'User added or password reset',
  user_role_changed: 'User role changed',
  user_2fa_reset: 'User 2FA reset',
  user_removed: 'User removed',
};
const ACTIVITY_WARN = new Set(['login_failed', '2fa_failed', 'bank_disconnected', 'user_removed']);

async function openActivity() {
  const listEl = document.getElementById('activityList');
  listEl.innerHTML = '<div class="activity-detail">Loading…</div>';
  document.getElementById('activityDialog').showModal();
  try {
    const res = await fetch('/api/audit');
    const entries = await res.json();
    if (!res.ok) throw new Error(entries.error || 'Could not load activity');
    if (!entries.length) { listEl.innerHTML = '<div class="activity-detail">No activity recorded yet.</div>'; return; }
    listEl.innerHTML = entries.map(e => {
      const when = new Date(e.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const details = [
        e.email,
        e.bank && `${e.bank}${e.provider ? ` (${e.provider})` : ''}`,
        e.category && (e.category === 'personal' ? 'Personal' : 'Business'),
        e.target && `user ${e.target}`,
        e.role && `role ${e.role}`,
        e.rows != null && `${e.rows} rows`,
        e.ip && `IP ${e.ip}`,
      ].filter(Boolean).map(esc).join(' · ');
      return `
      <div class="activity-row">
        <div class="activity-time">${when}</div>
        <div>
          <div class="activity-event ${ACTIVITY_WARN.has(e.event) ? 'warn' : ''}">${esc(ACTIVITY_LABELS[e.event] || e.event)}</div>
          <div class="activity-detail">${details}</div>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    listEl.innerHTML = `<div class="activity-detail">${esc(err.message)}</div>`;
  }
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
  const collapsed = collapsedBanks.has(bank.connectionId);

  let bankTotal = 0, currency = 'GBP';
  items.forEach(acct => {
    const bal = acct.balance?.available ?? acct.balance?.current
      ?? acct.balance?.total_available ?? acct.balance?.total_current;
    if (bal != null) bankTotal += bal;
    currency = acct.balance?.currency || acct.currency || currency;
  });

  return `
  <div class="bank-card${collapsed ? ' collapsed' : ''}" data-connection-id="${bank.connectionId}">
    <div class="bank-card-header" onclick="if (!event.target.closest('button, select')) toggleBankCollapse('${bank.connectionId}')">
      <div class="bank-card-title">
        <span class="collapse-arrow">&#9656;</span>
        <div class="bank-avatar" style="background:${color}">${initial}</div>
        <div>
          <div>${esc(bank.label)}</div>
          <div class="bank-meta">${esc(bank.provider)} &middot; ${items.length} account${items.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div class="bank-actions">
        <span class="bank-total">${fmt(bankTotal, currency)}</span>
        <span class="fetching-badge" title="Last updated ${new Date(bank.fetchedAt).toLocaleTimeString()}">
          Updated ${timeAgo(bank.fetchedAt)}
        </span>
        <select class="bank-filter category-select admin-only" title="Section" onchange="setCategory('${bank.connectionId}', this.value)">
          ${CATEGORIES.map(c => `<option value="${c}"${bank.category === c ? ' selected' : ''}>${c === 'business' ? 'Business' : 'Personal'}</option>`).join('')}
        </select>
        <button class="btn-danger admin-only" onclick="disconnect('${bank.connectionId}')">Disconnect</button>
      </div>
    </div>
    ${bank.error ? `<div class="bank-error">${esc(bank.error)}</div>` : ''}
    <div class="accounts-grid">
      ${items.map(acct => buildAccountPanel(acct)).join('')}
    </div>
  </div>`;
}

function buildAccountPanel(acct) {
  const isCard = acct.card_type != null;
  const balance = acct.balance;

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
  </div>`;
}

function buildTxnRow(t, currency, showBank = false) {
  const amount  = t.amount ?? 0;
  const isCredit = amount > 0 || t.transaction_type === 'CREDIT';
  const desc    = t.description || t.merchant?.name || 'Transaction';
  const date    = t.timestamp ? new Date(t.timestamp).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '';
  const icon    = txnIcon(t.transaction_classification?.[0] || t.transaction_category || '');
  const sub     = showBank && t.bankLabel
    ? `${date} &middot; ${esc(t.bankLabel)}${t.accountName ? ' &middot; ' + esc(t.accountName) : ''}`
    : date;

  return `
  <div class="txn-row">
    <div class="txn-left">
      <div class="txn-icon">${icon}</div>
      <div>
        <div class="txn-desc" title="${esc(desc)}">${esc(desc)}</div>
        <div class="txn-date">${sub}</div>
      </div>
    </div>
    <div class="txn-amount ${isCredit ? 'credit' : 'debit'}">
      ${isCredit ? '+' : ''}${fmt(Math.abs(amount), currency)}
    </div>
  </div>`;
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function onPlaidSuccess(public_token, metadata) {
  const category = sessionStorage.getItem('plaid_category') || 'business';
  sessionStorage.removeItem('plaid_category');
  await fetch('/api/exchange-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_token, metadata, category }),
  });
  showNotif('Bank connected successfully!', 'success');
  refresh();
  if (!refreshTimer) refreshTimer = setInterval(refresh, REFRESH_MS);
}

function onPlaidExit(err) {
  if (err) showNotif('Connection cancelled', 'error');
}

// Ask which section the bank belongs in before opening Plaid Link.
function connectBank() {
  document.getElementById('categoryDialog').showModal();
}

async function startConnect(category) {
  document.getElementById('categoryDialog').close();
  // sessionStorage (not a variable) so the choice survives a UK bank's OAuth
  // redirect, after which the page reloads and resumes Link.
  sessionStorage.setItem('plaid_category', category);
  try {
    const res = await fetch('/api/create-link-token', { method: 'POST' });
    const { link_token, error } = await res.json();
    if (error) { showNotif('Error: ' + error, 'error'); return; }

    // Needed to resume the flow after a UK Open Banking (e.g. Coutts) OAuth
    // redirect, since Link must be reopened with this exact same token.
    sessionStorage.setItem('plaid_link_token', link_token);

    const handler = Plaid.create({
      token: link_token,
      onSuccess: onPlaidSuccess,
      onExit: onPlaidExit,
    });
    handler.open();
  } catch (err) {
    showNotif('Failed to open bank connection', 'error');
  }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
}

async function setCategory(id, category) {
  const res = await fetch(`/api/connections/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    showNotif(body.error || 'Could not move this bank', 'error');
  }
  refresh();
}

async function disconnect(id) {
  if (!confirm('Disconnect this bank account?')) return;
  const res = await fetch(`/api/connections/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    showNotif(body.error || 'Could not disconnect', 'error');
  }
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
