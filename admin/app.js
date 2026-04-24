// ── State ────────────────────────────────────────────────────────────────────
const state = {
  token: sessionStorage.getItem('mc_token') || '',
  storeId: null,
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  stores: [],
  employees: [],
  currentTab: 'metrics',
};

const MONTH_NAMES = ['', 'Январь','Февраль','Март','Апрель','Май','Июнь',
                     'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const COIN_LABELS = {
  checklist_day:'Чек-лист 100%', review:'Именной отзыв', cake_order:'Торт на заказ',
  substitution:'Подмена коллеги', mentoring:'Наставничество', idea:'Идея внедрена',
  spend:'Обмен в Store', manual:'Вручную',
};

// ── API ──────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api${path}`, opts);
  if (res.status === 401) { logout(); return null; }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Ошибка сети' }));
    throw new Error(err.error || 'Ошибка');
  }
  return res.json();
}

// ── Auth ─────────────────────────────────────────────────────────────────────
async function login() {
  const secret = document.getElementById('secret-input').value;
  try {
    const data = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    }).then(r => r.json());
    if (!data.token) throw new Error('Неверный ключ');
    state.token = data.token;
    sessionStorage.setItem('mc_token', data.token);
    showApp();
  } catch (e) {
    document.getElementById('login-error').textContent = e.message;
  }
}

function logout() {
  sessionStorage.removeItem('mc_token');
  state.token = '';
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-screen').style.display = 'flex';
}

// ── App init ─────────────────────────────────────────────────────────────────
async function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  updatePeriodLabels();
  await loadStores();
}

async function loadStores() {
  state.stores = await api('GET', '/stores') || [];
  const sel = document.getElementById('store-select');
  sel.innerHTML = '<option value="">— Все точки —</option>';
  state.stores.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name;
    sel.appendChild(opt);
  });
}

function onStoreChange() {
  state.storeId = parseInt(document.getElementById('store-select').value) || null;
  refreshCurrentTab();
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  state.currentTab = tab;
  refreshCurrentTab();
}

function refreshCurrentTab() {
  if (state.currentTab === 'metrics')     loadMetrics();
  if (state.currentTab === 'coins')       loadCoinEmployees();
  if (state.currentTab === 'exchanges')   loadExchanges();
  if (state.currentTab === 'employees')   loadEmployees();
  if (state.currentTab === 'leaderboard') loadLeaderboard();
}

// ── Period ────────────────────────────────────────────────────────────────────
function changePeriod(delta) {
  state.month += delta;
  if (state.month > 12) { state.month = 1; state.year++; }
  if (state.month < 1)  { state.month = 12; state.year--; }
  updatePeriodLabels();
  refreshCurrentTab();
}

function updatePeriodLabels() {
  const label = `${MONTH_NAMES[state.month]} ${state.year}`;
  ['period-label', 'lb-period-label'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = label;
  });
}

// ── Метрики ───────────────────────────────────────────────────────────────────
async function loadMetrics() {
  if (!state.storeId) {
    document.getElementById('metrics-tbody').innerHTML = '<tr><td colspan="5" class="empty">Выберите точку в шапке</td></tr>';
    document.getElementById('metrics-store-ratings').classList.add('hidden');
    return;
  }

  document.getElementById('metrics-store-ratings').classList.remove('hidden');

  const rows = await api('GET', `/metrics?storeId=${state.storeId}&year=${state.year}&month=${state.month}`);
  const employees = await api('GET', `/stores/${state.storeId}/employees`);

  // Объединяем сотрудников с их метриками
  const metricMap = {};
  (rows || []).forEach(r => metricMap[r.employeeId] = r);

  const tbody = document.getElementById('metrics-tbody');
  if (!employees || employees.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Нет активных сотрудников</td></tr>';
    return;
  }

  tbody.innerHTML = employees.filter(e => e.isActive).map(e => {
    const m = metricMap[e.id] || {};
    return `<tr data-employee-id="${e.id}">
      <td><strong>${esc(e.name)}</strong></td>
      <td><input type="number" class="m-mystery" min="0" max="100" step="0.1" value="${m.mysteryShopperScore ?? ''}" placeholder="—"></td>
      <td><input type="number" class="m-reviews" min="0" max="10" step="1" value="${m.reviewsCount ?? 0}"></td>
      <td><input type="number" class="m-checklist" min="0" max="100" step="0.1" value="${m.checklistPercent ?? ''}" placeholder="—"></td>
      <td><input type="number" class="m-revenue" min="0" max="300" step="0.1" value="${m.revenuePercent ?? ''}" placeholder="—"></td>
    </tr>`;
  }).join('');
}

async function saveMetrics() {
  if (!state.storeId) { toast('Выберите точку'); return; }

  const rows = document.querySelectorAll('#metrics-tbody tr[data-employee-id]');
  const batch = [];
  rows.forEach(row => {
    const id = parseInt(row.dataset.employeeId);
    const val = sel => { const v = row.querySelector(sel).value; return v === '' ? undefined : parseFloat(v); };
    batch.push({
      employeeId: id, storeId: state.storeId, year: state.year, month: state.month,
      mysteryShopperScore: val('.m-mystery'),
      reviewsCount: parseInt(row.querySelector('.m-reviews').value) || 0,
      checklistPercent: val('.m-checklist'),
      revenuePercent: val('.m-revenue'),
    });
  });

  try {
    await api('POST', '/metrics/batch', batch);
    toast('✅ Метрики сохранены');
  } catch (e) { toast('❌ ' + e.message); }
}

async function processMonth() {
  if (!state.storeId) { toast('Выберите точку'); return; }
  if (!confirm(`Обработать ${MONTH_NAMES[state.month]} ${state.year}?\n\nБудут рассчитаны MVP и начислены карточки. Сотрудники получат уведомления.`)) return;

  const avgRatingScore = parseFloat(document.getElementById('store-rating-score').value) || 0;
  const revenuePercent = parseFloat(document.getElementById('store-revenue-percent').value) || 0;

  const btn = document.getElementById('process-btn');
  btn.disabled = true; btn.textContent = '⏳ Обработка...';

  try {
    const result = await api('POST', '/metrics/process', {
      year: state.year, month: state.month,
      storeRatings: [{ storeId: state.storeId, avgRatingScore, revenuePercent }],
    });
    const processed = result.results?.[0];
    const mvp = processed?.employees?.find(e => e.isMvp);
    toast(`✅ Готово! MVP: ${mvp?.name ?? '—'} (${mvp?.mvpScore?.toFixed(2) ?? '—'} б.)`);
    loadMetrics();
  } catch (e) { toast('❌ ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '⚡ Обработать месяц (MVP + карточки + уведомления)'; }
}

// ── Монеты ────────────────────────────────────────────────────────────────────
async function loadCoinEmployees() {
  if (!state.storeId) return;
  const emps = await api('GET', `/stores/${state.storeId}/employees`) || [];
  state.employees = emps.filter(e => e.isActive);

  const sel = document.getElementById('coin-employee');
  sel.innerHTML = '<option value="">— выбери —</option>';
  state.employees.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id; opt.textContent = e.name;
    sel.appendChild(opt);
  });
  sel.onchange = loadCoinHistory;

  // показывать/скрывать поле суммы для manual
  document.getElementById('coin-reason').onchange = function() {
    document.getElementById('manual-amount-label').classList.toggle('hidden', this.value !== 'manual');
  };
}

async function loadCoinHistory() {
  const id = document.getElementById('coin-employee').value;
  if (!id) return;
  const history = await api('GET', `/coins/history/${id}?limit=15`) || [];
  const balance = await api('GET', `/coins/balance/${id}`);

  const tbody = document.getElementById('coins-history-tbody');
  if (history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Нет операций</td></tr>'; return;
  }
  tbody.innerHTML = history.map(t => `<tr>
    <td>${formatDate(t.createdAt)}</td>
    <td style="color:${t.amount > 0 ? 'var(--green)' : 'var(--red)'};font-weight:600">
      ${t.amount > 0 ? '+' : ''}${t.amount}
    </td>
    <td>${COIN_LABELS[t.reason] ?? t.reason}</td>
    <td>${esc(t.note ?? '')}</td>
  </tr>`).join('');

  toast(`Баланс: ${balance?.balance ?? '?'} монет`);
}

async function awardCoins() {
  const employeeId = parseInt(document.getElementById('coin-employee').value);
  const reason = document.getElementById('coin-reason').value;
  const note = document.getElementById('coin-note').value;
  const isManual = reason === 'manual';
  const amount = isManual ? parseInt(document.getElementById('coin-amount').value) : undefined;

  if (!employeeId) { toast('Выберите сотрудника'); return; }

  try {
    await api('POST', '/coins/award', { employeeId, reason, amount, note: note || undefined });
    toast('✅ Монеты начислены');
    loadCoinHistory();
  } catch (e) { toast('❌ ' + e.message); }
}

// ── Заявки ────────────────────────────────────────────────────────────────────
async function loadExchanges() {
  const status = document.getElementById('exchanges-status').value;
  const params = status ? `?status=${status}` : '';
  const data = await api('GET', `/exchanges${params}`) || [];

  const tbody = document.getElementById('exchanges-tbody');
  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">Нет заявок</td></tr>`; return;
  }
  tbody.innerHTML = data.map(ex => `<tr>
    <td>${esc(ex.employeeName)}</td>
    <td>${esc(ex.storeName)}</td>
    <td>${esc(ex.prizeName)}</td>
    <td>${ex.cardsSpent}</td>
    <td>${ex.coinsSpent}</td>
    <td>${formatDate(ex.createdAt)}</td>
    <td><span class="badge badge-${ex.status}">${statusLabel(ex.status)}</span></td>
    <td>
      ${ex.status === 'pending' ? `
        <div class="row-actions">
          <button class="btn btn-success" onclick="updateExchange(${ex.id},'fulfilled')">Выдать</button>
          <button class="btn btn-danger"  onclick="updateExchange(${ex.id},'rejected')">Откл.</button>
        </div>` : '—'}
    </td>
  </tr>`).join('');
}

async function updateExchange(id, status) {
  try {
    await api('PUT', `/exchanges/${id}`, { status, processedBy: 1 });
    toast(status === 'fulfilled' ? '✅ Приз выдан' : '❌ Заявка отклонена');
    loadExchanges();
  } catch (e) { toast('❌ ' + e.message); }
}

// ── Сотрудники ────────────────────────────────────────────────────────────────
async function loadEmployees() {
  if (!state.storeId) {
    document.getElementById('employees-tbody').innerHTML = '<tr><td colspan="8" class="empty">Выберите точку</td></tr>';
    return;
  }
  const emps = await api('GET', `/stores/${state.storeId}/employees`) || [];

  const summaries = await Promise.all(emps.map(e => api('GET', `/employees/${e.id}/summary`)));

  const tbody = document.getElementById('employees-tbody');
  if (emps.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">Нет сотрудников</td></tr>'; return;
  }
  tbody.innerHTML = summaries.filter(Boolean).map(s => `<tr>
    <td><strong>${esc(s.name)}</strong></td>
    <td style="color:var(--muted);font-size:13px">${s.telegramUsername ? '@' + esc(s.telegramUsername) : '—'}</td>
    <td>${roleLabel(s.role)}</td>
    <td>${s.availableCards}</td>
    <td>${s.coinBalance}</td>
    <td>${s.uniqueHeroes}/12</td>
    <td>${s.isActive ? '<span class="badge badge-approved">Активен</span>' : '<span class="badge badge-rejected">Неактивен</span>'}</td>
    <td>
      ${s.isActive
        ? `<button class="btn btn-ghost" onclick="toggleEmployee(${s.id}, false)">Деактив.</button>`
        : `<button class="btn btn-ghost" onclick="toggleEmployee(${s.id}, true)">Активировать</button>`}
    </td>
  </tr>`).join('');
}

function showAddEmployee() {
  document.getElementById('add-employee-form').classList.toggle('hidden');
}

async function addEmployee() {
  const name = document.getElementById('new-emp-name').value.trim();
  const role = document.getElementById('new-emp-role').value;
  const telegramUsername = document.getElementById('new-emp-username').value.trim();
  if (!name || !state.storeId) { toast('Введите имя и выберите точку'); return; }
  try {
    await api('POST', '/employees', { name, storeId: state.storeId, role, telegramUsername: telegramUsername || undefined });
    toast('✅ Сотрудник добавлен');
    document.getElementById('add-employee-form').classList.add('hidden');
    document.getElementById('new-emp-name').value = '';
    document.getElementById('new-emp-username').value = '';
    loadEmployees();
  } catch (e) { toast('❌ ' + e.message); }
}

async function toggleEmployee(id, isActive) {
  try {
    await api('PUT', `/employees/${id}`, { isActive });
    loadEmployees();
  } catch (e) { toast('❌ ' + e.message); }
}

// ── Рейтинги ─────────────────────────────────────────────────────────────────
async function loadLeaderboard() {
  document.getElementById('lb-period-label').textContent = `${MONTH_NAMES[state.month]} ${state.year}`;

  const [empData, storeData] = await Promise.all([
    state.storeId
      ? api('GET', `/leaderboard/employees?storeId=${state.storeId}&year=${state.year}&month=${state.month}`)
      : Promise.resolve([]),
    api('GET', `/leaderboard/stores?year=${state.year}&month=${state.month}`),
  ]);

  const RANK = ['🥇','🥈','🥉'];
  const empTbody = document.getElementById('lb-employees-tbody');
  if (!empData || empData.length === 0) {
    empTbody.innerHTML = state.storeId
      ? '<tr><td colspan="4" class="empty">Нет данных за этот период</td></tr>'
      : '<tr><td colspan="4" class="empty">Выберите точку</td></tr>';
  } else {
    empTbody.innerHTML = empData.map((e, i) => `<tr>
      <td>${RANK[i] ?? i+1}</td>
      <td>${esc(e.name)} ${e.isMvp ? '<span class="badge badge-mvp">MVP</span>' : ''}</td>
      <td>${e.mvpScore !== null ? Number(e.mvpScore).toFixed(2) : '—'}</td>
      <td>${e.cardsCount}</td>
    </tr>`).join('');
  }

  const storeTbody = document.getElementById('lb-stores-tbody');
  if (!storeData || storeData.length === 0) {
    storeTbody.innerHTML = '<tr><td colspan="3" class="empty">Нет данных</td></tr>';
  } else {
    storeTbody.innerHTML = storeData.map((s, i) => `<tr>
      <td>${RANK[i] ?? i+1}</td>
      <td>${esc(s.storeName)} ${s.isTop ? '⭐' : ''}</td>
      <td>${s.totalScore !== null ? Number(s.totalScore).toFixed(1) : '—'}</td>
    </tr>`).join('');
  }
}

// ── Утилиты ───────────────────────────────────────────────────────────────────
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return `${dt.getDate()} ${['','янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'][dt.getMonth()+1]}`;
}

function statusLabel(s) {
  return { pending:'Ожидает', approved:'Одобрена', rejected:'Отклонена', fulfilled:'Выдана' }[s] ?? s;
}

function roleLabel(r) {
  return { employee:'Сотрудник', manager:'Руководитель', admin:'Админ' }[r] ?? r;
}

// ── Старт ─────────────────────────────────────────────────────────────────────
if (state.token) showApp();
