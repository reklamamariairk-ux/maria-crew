// ── State ────────────────────────────────────────────────────────────────────
const state = {
  token: sessionStorage.getItem('mc_token') || '',
  role:  sessionStorage.getItem('mc_role')  || '',
  storeId: null,
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  stores: [],
  employees: [],
  currentTab: 'dashboard',
  cloudinary: { cloudName: '', uploadPreset: '', enabled: false },
};

const ROLE_LABEL = {
  superadmin: 'Суперадмин',
  editor:     'Админище',
  coin_admin: 'Администратор (монеты)',
};

// Единая точка истины: какие вкладки доступны какой роли.
// Используется и в applyRoleVisibility(), и в switchTab() — чтобы UI и навигация не разошлись.
const SUPERADMIN_ONLY_TABS = new Set(['adminUsers', 'settings']);
const COIN_ADMIN_TABS = new Set(['dashboard', 'coins', 'employees']);
const EDITOR_FORBIDDEN_TABS = new Set(['coins']);

function tabAllowed(tab, role) {
  if (role === 'superadmin') return true;
  if (SUPERADMIN_ONLY_TABS.has(tab)) return false;
  if (role === 'coin_admin') return COIN_ADMIN_TABS.has(tab);
  if (role === 'editor') return !EDITOR_FORBIDDEN_TABS.has(tab);
  return false;
}

// Lucide иконки рендерятся через lucide.createIcons() после каждой вставки HTML.
function renderIcons() {
  if (window.lucide) lucide.createIcons();
}

// Skeleton-плейсхолдер для таблиц
function skeletonRows(cols, rows = 5) {
  const cells = '<td><div class="skeleton"></div></td>'.repeat(cols);
  return Array(rows).fill(0).map(() => `<tr class="skeleton-row">${cells}</tr>`).join('');
}

function emptyState(icon, text) {
  return `<div class="empty"><i data-lucide="${icon}"></i><div>${esc(text)}</div></div>`;
}

function emptyRow(cols, icon, text) {
  return `<tr><td colspan="${cols}" class="empty"><i data-lucide="${icon}"></i><div>${esc(text)}</div></td></tr>`;
}

const MONTH_NAMES = ['', 'Январь','Февраль','Март','Апрель','Май','Июнь',
                     'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const COIN_LABELS = {
  // Начисления
  checklist_day:       'Чек-лист 100%',
  review:              'Именной отзыв',
  cake_order:          'Торт на заказ',
  substitution:        'Подмена коллеги',
  mentoring:           'Наставничество',
  idea:                'Идея внедрена',
  training_meeting:    'Собрание по обучению',
  knowledge_applied:   'Применение знаний',
  quiz:                'Квиз',
  checkin:             'Вход в приложение',
  // Списания
  bad_review:          'Отрицательный отзыв',
  dirty_store:         'Нарушение стандартов чистоты',
  training_resistance: 'Сопротивление обучению',
  // Служебные
  spend:               'Обмен в Store',
  manual:              'Вручную',
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
  if (res.status === 403) {
    const err = await res.json().catch(() => ({}));
    toast('⚠️ ' + (err.error || 'Недостаточно прав'));
    return null;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Ошибка сети' }));
    throw new Error(err.error || 'Ошибка');
  }
  return res.json();
}

// ── Auth ─────────────────────────────────────────────────────────────────────
async function login() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) {
    document.getElementById('login-error').textContent = 'Введи логин и пароль';
    return;
  }
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) throw new Error(data.error || 'Неверный логин или пароль');
    state.token = data.token;
    state.role  = data.role || '';
    state.requirePasswordChange = !!data.mustChangePassword;
    sessionStorage.setItem('mc_token', data.token);
    sessionStorage.setItem('mc_role', state.role);
    showApp();
    if (state.requirePasswordChange) {
      // Сразу принуждаем сменить временный пароль
      openChangePasswordModal(true);
    }
  } catch (e) {
    document.getElementById('login-error').textContent = e.message;
  }
}

function logout() {
  sessionStorage.removeItem('mc_token');
  sessionStorage.removeItem('mc_role');
  state.token = '';
  state.role = '';
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-screen').style.display = 'flex';
}

function openChangePasswordModal(forced = false) {
  const modal = document.getElementById('modal-change-password');
  document.getElementById('cpw-old').value = '';
  document.getElementById('cpw-new').value = '';
  document.getElementById('cpw-hint').textContent = forced
    ? 'Это временный пароль — задай свой постоянный (минимум 4 символа).'
    : 'Минимум 4 символа. Новый пароль должен отличаться от текущего.';
  document.getElementById('cpw-close-btn').style.display = forced ? 'none' : '';
  document.getElementById('cpw-cancel').style.display = forced ? 'none' : '';
  modal.classList.remove('hidden');
  renderIcons();
}

function closeChangePasswordModal() {
  if (state.requirePasswordChange) return; // блокируем закрытие при принудительной смене
  document.getElementById('modal-change-password').classList.add('hidden');
}

function openCoinsExport() {
  const form = document.getElementById('coins-export-form');
  form.classList.toggle('hidden');
  if (form.classList.contains('hidden')) return;
  // По умолчанию: с 1-го числа текущего месяца до сегодня
  const irk = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const y = irk.getUTCFullYear(), m = String(irk.getUTCMonth() + 1).padStart(2, '0');
  document.getElementById('coins-export-from').value = `${y}-${m}-01`;
  document.getElementById('coins-export-to').value = irk.toISOString().slice(0, 10);
  // Заполняем точки
  const sel = document.getElementById('coins-export-store');
  if (sel.options.length <= 1) {
    (state.stores || []).forEach(s => {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.name; sel.appendChild(o);
    });
  }
}

async function downloadCoinsCsv() {
  const from = document.getElementById('coins-export-from').value;
  const to   = document.getElementById('coins-export-to').value;
  const storeId = document.getElementById('coins-export-store').value;
  if (!from || !to) { toast('Укажи даты'); return; }
  const params = new URLSearchParams({ from, to });
  if (storeId) params.set('storeId', storeId);
  try {
    const res = await fetch(`/api/coins/export?${params.toString()}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) throw new Error(await res.text() || 'Ошибка экспорта');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `coins_${from}_${to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('✅ CSV выгружен');
  } catch (e) { toast('❌ ' + e.message); }
}

async function submitChangePassword() {
  const oldPassword = document.getElementById('cpw-old').value;
  const newPassword = document.getElementById('cpw-new').value;
  if (!oldPassword || !newPassword) { toast('Заполни оба поля'); return; }
  if (newPassword.length < 4) { toast('Минимум 4 символа'); return; }
  if (oldPassword === newPassword) { toast('Новый пароль должен отличаться от старого'); return; }
  try {
    await api('POST', '/auth/change-password', { oldPassword, newPassword });
    state.requirePasswordChange = false;
    document.getElementById('modal-change-password').classList.add('hidden');
    toast('✅ Пароль обновлён');
  } catch (e) { toast('❌ ' + e.message); }
}

function updatePendingBadge(count) {
  const badge = document.getElementById('nav-pending-badge');
  if (!badge) return;
  if (count && count > 0) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function applyRoleVisibility() {
  const r = state.role;
  document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
    const tab = btn.getAttribute('data-tab');
    btn.style.display = tabAllowed(tab, r) ? '' : 'none';
  });
  // role-superadmin-only — на любых других элементах вне меню
  document.querySelectorAll('.role-superadmin-only').forEach(el => {
    if (!el.classList.contains('nav-item')) {
      el.style.display = (r === 'superadmin') ? '' : 'none';
    }
  });
  document.querySelectorAll('.role-coins-write').forEach(el => {
    el.style.display = (r === 'superadmin' || r === 'coin_admin') ? '' : 'none';
  });
}

// ── App init ─────────────────────────────────────────────────────────────────
async function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');

  // Если роли нет в сессии (старый токен) — узнаём её с сервера
  if (!state.role) {
    const meta = await api('GET', '/me/admin').catch(() => null);
    if (meta && meta.role) {
      state.role = meta.role;
      sessionStorage.setItem('mc_role', state.role);
    }
  }
  applyRoleVisibility();

  updatePeriodLabels();
  renderIcons();
  await Promise.all([loadStores(), loadCloudinaryConfig()]);
  switchTab('dashboard');

  // Раз в 2 минуты подтягиваем количество ожидающих заявок (фон, безшумно)
  if (!state.pendingPoll) {
    state.pendingPoll = setInterval(async () => {
      try {
        const data = await api('GET', '/exchanges?status=pending');
        updatePendingBadge(Array.isArray(data) ? data.length : 0);
      } catch { /* ignore */ }
    }, 120_000);
  }
}

async function loadCloudinaryConfig() {
  const cfg = await api('GET', '/config/cloudinary').catch(() => null);
  if (cfg) state.cloudinary = cfg;
}

async function loadStores() {
  state.stores = await api('GET', '/stores') || [];
  populateStoreSelectors();
}

// Заполняет все селекторы точек: основной в сайдбаре + inline-пикеры
// в Метриках и Рейтингах. Все они синхронизируются с state.storeId.
function populateStoreSelectors() {
  const ids = ['store-select', 'metrics-store-picker', 'leaderboard-store-picker'];
  for (const id of ids) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    const current = state.storeId ? String(state.storeId) : '';
    sel.innerHTML = '<option value="">— Выбери точку —</option>'
      + state.stores.map(s => `<option value="${s.id}"${String(s.id) === current ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  }
  // Селектор точки в форме добавления сотрудника
  const newEmpStore = document.getElementById('new-emp-store');
  if (newEmpStore) {
    newEmpStore.innerHTML = '<option value="">— Выбери точку —</option>'
      + state.stores.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  }

  // Мобильный селектор точки в хедере
  const mobileStoreSel = document.getElementById('mobile-store-select');
  if (mobileStoreSel) {
    const current = state.storeId ? String(state.storeId) : '';
    mobileStoreSel.innerHTML = '<option value="">— Все точки —</option>'
      + state.stores.map(s => `<option value="${s.id}"${String(s.id) === current ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  }
}

function syncStoreSelectors() {
  const value = state.storeId ? String(state.storeId) : '';
  ['store-select', 'metrics-store-picker', 'leaderboard-store-picker', 'mobile-store-select'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel) sel.value = value;
  });
}

function onStoreChange() {
  state.storeId = parseInt(document.getElementById('store-select').value) || null;
  syncStoreSelectors();
  refreshCurrentTab();
}

function onMobileStoreChange() {
  state.storeId = parseInt(document.getElementById('mobile-store-select').value) || null;
  syncStoreSelectors();
  refreshCurrentTab();
}

// ── Mobile sidebar drawer ──────────────────────────────────────────────────

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('visible');
  document.body.style.overflow = 'hidden';
  renderIcons();
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
  document.body.style.overflow = '';
}

function setStoreFromInline(value) {
  state.storeId = parseInt(value) || null;
  syncStoreSelectors();
  refreshCurrentTab();
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  // Страховка: используем общий tabAllowed(), чтобы UI и навигация были согласованы.
  if (state.role && !tabAllowed(tab, state.role)) {
    if (SUPERADMIN_ONLY_TABS.has(tab)) toast('⚠️ Раздел доступен только суперадмину');
    else if (state.role === 'coin_admin') toast('⚠️ Раздел недоступен для роли «Только монеты»');
    else toast('⚠️ Раздел недоступен для твоей роли');
    tab = 'dashboard';
  }

  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  state.currentTab = tab;
  closeSidebar();
  // Сбрасываем состояние аналитики при переходе со вкладки квиза
  if (tab !== 'quiz') {
    quizAnalyticsVisible = false;
    const qa = document.getElementById('quiz-analytics');
    if (qa) { qa.classList.add('hidden'); qa.innerHTML = ''; }
  }
  refreshCurrentTab();
}

function refreshCurrentTab() {
  if (state.currentTab === 'dashboard')   loadDashboard();
  if (state.currentTab === 'metrics')     loadMetrics();
  if (state.currentTab === 'coins')       loadCoinEmployees();
  if (state.currentTab === 'exchanges')   loadExchanges();
  if (state.currentTab === 'employees')   loadEmployees();
  if (state.currentTab === 'leaderboard') loadLeaderboard();
  if (state.currentTab === 'quiz')        loadQuizQuestions();
  if (state.currentTab === 'cards')       loadCardEmployees();
  if (state.currentTab === 'storesAdmin') loadStoresAdmin();
  if (state.currentTab === 'prizes')      loadPrizes();
  if (state.currentTab === 'audit')       loadAudit();
  if (state.currentTab === 'challenges')  loadChallenges();
  if (state.currentTab === 'heroes')      loadHeroes();
  if (state.currentTab === 'settings')    loadMvpConfig();
  if (state.currentTab === 'adminUsers')  loadAdminUsers();
  if (state.currentTab === 'notify')      loadNotifyForm();
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
  const tbody = document.getElementById('metrics-tbody');
  if (!state.storeId) {
    tbody.innerHTML = emptyRow(5, 'store', 'Выбери точку в селекторе сверху или в боковой панели слева');
    document.getElementById('metrics-store-ratings').classList.add('hidden');
    renderIcons();
    return;
  }

  document.getElementById('metrics-store-ratings').classList.remove('hidden');
  tbody.innerHTML = skeletonRows(5, 5);

  const rows = await api('GET', `/metrics?storeId=${state.storeId}&year=${state.year}&month=${state.month}`);
  const employees = await api('GET', `/stores/${state.storeId}/employees`);

  // Объединяем сотрудников с их метриками
  const metricMap = {};
  (rows || []).forEach(r => metricMap[r.employeeId] = r);

  if (!employees || employees.length === 0) {
    tbody.innerHTML = emptyRow(5, 'users', 'Нет активных сотрудников');
    renderIcons();
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
  renderIcons();
}

async function saveMetrics() {
  if (!state.storeId) { toast('Выберите точку'); return; }

  const rows = document.querySelectorAll('#metrics-tbody tr[data-employee-id]');
  const batch = [];
  rows.forEach(row => {
    const id = parseInt(row.dataset.employeeId);
    const val = sel => { const v = row.querySelector(sel).value; return v === '' ? undefined : parseFloat(v); };
    const mystery   = val('.m-mystery');
    const reviews   = parseInt(row.querySelector('.m-reviews').value) || 0;
    const checklist = val('.m-checklist');
    const revenue   = val('.m-revenue');
    // Пустую строку не сохраняем (все 4 поля пустые/0)
    if (mystery === undefined && reviews === 0 && checklist === undefined && revenue === undefined) return;
    batch.push({
      employeeId: id, storeId: state.storeId, year: state.year, month: state.month,
      mysteryShopperScore: mystery,
      reviewsCount: reviews,
      checklistPercent: checklist,
      revenuePercent: revenue,
    });
  });

  if (batch.length === 0) { toast('Нечего сохранять — заполни хотя бы одно поле'); return; }

  try {
    await api('POST', '/metrics/batch', batch);
    toast(`✅ Сохранено: ${batch.length} ${batch.length === 1 ? 'запись' : (batch.length < 5 ? 'записи' : 'записей')}`);
    loadMetrics();
  } catch (e) { toast('❌ ' + e.message); }
}

async function processMonth() {
  if (!state.storeId) { toast('Выберите точку'); return; }
  if (!confirm(`Обработать ${MONTH_NAMES[state.month]} ${state.year}?\n\n⚠️ Внимание: автообработка ПЕРЕЗАПИШЕТ MVP-баллы и статус MVP, выставленные вручную во вкладке «Рейтинги», на значения, рассчитанные по метрикам.\n\nЕсли ты ставил баллы вручную — нажми «Отмена» и не запускай автообработку (карточки за метрики и MVP можно выдать вручную во вкладке «Карточки»).\n\nПродолжить автообработку?`)) return;

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
  // Список сотрудников: либо точки, либо все
  const path = state.storeId ? `/employees?storeId=${state.storeId}` : '/employees';
  const emps = await api('GET', path) || [];
  state.employees = emps.filter(e => e.isActive);

  document.getElementById('coins-history-tbody').innerHTML =
    '<tr><td colspan="4" class="empty">Выберите сотрудника</td></tr>';
  document.getElementById('coins-balance-display').textContent = '';

  const sel = document.getElementById('coin-employee');
  sel.innerHTML = '<option value="">— выбери —</option>';
  state.employees.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = state.storeId ? e.name : `${e.name} — ${e.storeName ?? ''}`;
    sel.appendChild(opt);
  });
  sel.onchange = loadCoinHistory;
}

async function loadCoinHistory() {
  const id = document.getElementById('coin-employee').value;
  const balanceEl = document.getElementById('coins-balance-display');
  if (!id) { balanceEl.textContent = ''; return; }

  const tbody = document.getElementById('coins-history-tbody');
  tbody.innerHTML = skeletonRows(4, 5);

  const [history, balance] = await Promise.all([
    api('GET', `/coins/history/${id}?limit=30`),
    api('GET', `/coins/balance/${id}`),
  ]);

  balanceEl.innerHTML = `Баланс: <strong style="color:var(--pink);font-size:15px">${balance?.balance ?? '?'}</strong> монет`;

  if (!history || history.length === 0) {
    tbody.innerHTML = emptyRow(4, 'coins', 'Нет операций');
    renderIcons(); return;
  }
  tbody.innerHTML = history.map(t => `<tr>
    <td style="color:var(--muted);font-size:12px">${formatDate(t.createdAt)}</td>
    <td style="color:${t.amount > 0 ? 'var(--green)' : 'var(--red)'};font-weight:600">
      ${t.amount > 0 ? '+' : ''}${t.amount}
    </td>
    <td style="font-size:13px">${COIN_LABELS[t.reason] ?? t.reason}</td>
    <td style="color:var(--text-2);font-size:12px">${esc(t.note ?? '')}</td>
  </tr>`).join('');
  renderIcons();
}

async function awardCoins() {
  const employeeId = parseInt(document.getElementById('coin-employee').value);
  const amount = parseInt(document.getElementById('coin-amount').value, 10);
  const note = document.getElementById('coin-note').value;

  if (!employeeId) { toast('Выберите сотрудника'); return; }
  if (isNaN(amount) || amount === 0) { toast('Выбери количество'); return; }

  try {
    await api('POST', '/coins/award', { employeeId, reason: 'manual', amount, note: note || undefined });
    toast(amount < 0 ? '✅ Монеты списаны' : '✅ Монеты начислены');
    document.getElementById('coin-note').value = '';
    document.getElementById('coin-amount').value = '1';
    loadCoinHistory();
  } catch (e) { toast('❌ ' + e.message); }
}

// ── Заявки ────────────────────────────────────────────────────────────────────
async function loadExchanges() {
  const status = document.getElementById('exchanges-status').value;
  const parts = [];
  if (status) parts.push(`status=${status}`);
  if (state.storeId) parts.push(`storeId=${state.storeId}`);
  const params = parts.length ? '?' + parts.join('&') : '';

  const tbody = document.getElementById('exchanges-tbody');
  tbody.innerHTML = skeletonRows(8, 5);
  const data = await api('GET', `/exchanges${params}`) || [];

  // Если фильтр = pending, бейдж обновляем по длине списка (без лишнего запроса)
  if (status === 'pending' && !state.storeId) {
    updatePendingBadge(data.length);
  }

  if (data.length === 0) {
    tbody.innerHTML = emptyRow(8, 'shopping-bag', 'Нет заявок');
    renderIcons(); return;
  }
  tbody.innerHTML = data.map(ex => `<tr>
    <td><strong>${esc(ex.employeeName)}</strong></td>
    <td style="color:var(--text-2);font-size:13px">${esc(ex.storeName)}</td>
    <td>${esc(ex.prizeName)}</td>
    <td>${ex.cardsSpent}</td>
    <td>${ex.coinsSpent}</td>
    <td style="color:var(--muted);font-size:12px">${formatDate(ex.createdAt)}</td>
    <td><span class="badge badge-${ex.status}">${statusLabel(ex.status)}</span></td>
    <td>
      ${ex.status === 'pending' ? `
        <div class="row-actions">
          <button class="btn btn-success btn-sm" onclick="updateExchange(${ex.id},'fulfilled')"><i data-lucide="check"></i> Выдать</button>
          <button class="btn btn-danger btn-sm" onclick="updateExchange(${ex.id},'rejected')"><i data-lucide="x"></i> Отклонить</button>
        </div>` : '<span class="text-muted">—</span>'}
    </td>
  </tr>`).join('');
  renderIcons();
}

let _pendingRejectId = null;

function updateExchange(id, status) {
  if (status === 'rejected') {
    _pendingRejectId = id;
    document.getElementById('reject-notes').value = '';
    document.getElementById('modal-reject').classList.remove('hidden');
    renderIcons();
    return;
  }
  _doUpdateExchange(id, status, null);
}

function closeRejectModal() {
  _pendingRejectId = null;
  document.getElementById('modal-reject').classList.add('hidden');
}

async function confirmReject() {
  const notes = document.getElementById('reject-notes').value.trim() || null;
  const id = _pendingRejectId;
  closeRejectModal();
  if (!id) return;
  await _doUpdateExchange(id, 'rejected', notes);
}

async function _doUpdateExchange(id, status, notes) {
  try {
    const body = { status };
    if (notes) body.notes = notes;
    await api('PUT', `/exchanges/${id}`, body);
    toast(status === 'fulfilled' ? '✅ Приз выдан' : '❌ Заявка отклонена');
    loadExchanges();
  } catch (e) { toast('❌ ' + e.message); }
}

// ── Сотрудники ────────────────────────────────────────────────────────────────
function renderEmployeeAvatar(s) {
  const letter = (s.name || '?')[0].toUpperCase();
  if (s.telegramPhotoUrl) {
    return `<img src="${esc(s.telegramPhotoUrl)}" alt="${esc(letter)}" class="emp-avatar" referrerpolicy="no-referrer">`;
  }
  return `<span class="emp-avatar emp-avatar-fallback">${esc(letter)}</span>`;
}

function lastSeenLabel(iso) {
  if (!iso) return '<span style="color:var(--gray)">не входил</span>';
  const d = new Date(iso);
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 2)    return '<span style="color:var(--green);font-weight:700">сейчас</span>';
  if (diffMin < 60)   return `${diffMin} мин назад`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)} ч назад`;
  return formatDate(iso);
}

function renderRoleSelect(empId, currentRole) {
  const roles = [
    { value: 'employee', label: 'Сотрудник' },
    { value: 'manager',  label: 'Руководитель' },
  ];
  const opts = roles.map(r =>
    `<option value="${r.value}"${r.value === currentRole ? ' selected' : ''}>${r.label}</option>`
  ).join('');
  return `<select class="emp-role-select" data-current="${currentRole}" onchange="changeEmployeeRole(${empId}, this)">${opts}</select>`;
}

async function changeEmployeeRole(id, selectEl) {
  const newRole = selectEl.value;
  const oldRole = selectEl.dataset.current;
  if (newRole === oldRole) return;
  selectEl.disabled = true;
  try {
    await api('PUT', `/employees/${id}`, { role: newRole });
    selectEl.dataset.current = newRole;
    toast(`✅ Роль изменена`);
  } catch (e) {
    selectEl.value = oldRole;
    toast('❌ ' + e.message);
  } finally {
    selectEl.disabled = false;
  }
}

function renderStoreSelect(empId, currentStoreId) {
  const opts = state.stores.map(s =>
    `<option value="${s.id}"${s.id === currentStoreId ? ' selected' : ''}>${esc(s.name)}</option>`
  ).join('');
  return `<select class="emp-store-select" data-emp-id="${empId}" data-current="${currentStoreId ?? ''}" onchange="changeEmployeeStore(${empId}, this)">${opts}</select>`;
}

let employeesCache = [];
let employeeSummaries = {};
const selectedEmployeeIds = new Set();

async function loadEmployees() {
  const tbody = document.getElementById('employees-tbody');
  tbody.innerHTML = skeletonRows(11, 6);
  selectedEmployeeIds.clear();
  const master = document.getElementById('emp-select-all');
  if (master) master.checked = false;
  updateBulkBar();

  const path = state.storeId ? `/employees?storeId=${state.storeId}` : '/employees';
  const list = await api('GET', path) || [];
  employeesCache = list;

  if (list.length === 0) {
    tbody.innerHTML = emptyRow(11, 'users', state.storeId ? 'Нет сотрудников на этой точке' : 'Нет сотрудников');
    renderIcons();
    return;
  }

  // Подгружаем сводки параллельно (карточки/монеты/герои)
  const summaries = await Promise.all(list.map(e => api('GET', `/employees/${e.id}/summary`).catch(() => null)));
  employeeSummaries = {};
  summaries.forEach((sum, i) => { if (sum) employeeSummaries[list[i].id] = sum; });

  renderEmployees();
}

function renderEmployees() {
  const tbody = document.getElementById('employees-tbody');
  const search = document.getElementById('emp-search').value.trim().toLowerCase();
  const list = !search ? employeesCache : employeesCache.filter(e => {
    const name = (e.name || '').toLowerCase();
    const username = (e.telegramUsername || '').toLowerCase();
    const store = (e.storeName || '').toLowerCase();
    return name.includes(search) || username.includes(search) || store.includes(search);
  });

  if (list.length === 0) {
    tbody.innerHTML = emptyRow(11, 'search-x', 'Ничего не найдено');
    renderIcons();
    return;
  }

  tbody.innerHTML = list.map(e => {
    const sum = employeeSummaries[e.id] || {};
    const cards   = sum.availableCards ?? '—';
    const coins   = sum.coinBalance    ?? '—';
    const heroes  = sum.uniqueHeroes !== undefined ? `${sum.uniqueHeroes}/12` : '—';
    const tgInfo = e.telegramUsername
      ? '@' + esc(e.telegramUsername)
      : (e.telegramId ? `id ${e.telegramId}` : '—');
    const checked = selectedEmployeeIds.has(e.id) ? ' checked' : '';
    return `<tr>
      <td><input type="checkbox" class="emp-row-select" data-emp-id="${e.id}" onchange="toggleEmployeeSelect(${e.id}, this)"${checked}></td>
      <td>${renderEmployeeAvatar(e)}</td>
      <td><strong style="cursor:pointer;color:var(--pink)" onclick="showEmployeeModal(${e.id})">${esc(e.name)}</strong></td>
      <td style="color:var(--muted);font-size:12px">${tgInfo}</td>
      <td>${renderStoreSelect(e.id, e.storeId)}</td>
      <td>${renderRoleSelect(e.id, e.role)}</td>
      <td>${cards}</td>
      <td>${coins}</td>
      <td>${heroes}</td>
      <td style="font-size:12px">${lastSeenLabel(e.lastSeenAt)}</td>
      <td>
        ${e.isActive
          ? `<button class="btn btn-ghost btn-sm" onclick="toggleEmployee(${e.id}, false)"><i data-lucide="user-x"></i> Скрыть</button>`
          : `<button class="btn btn-ghost btn-sm" onclick="toggleEmployee(${e.id}, true)"><i data-lucide="user-check"></i> Активировать</button>`}
      </td>
    </tr>`;
  }).join('');
  renderIcons();
}

function filterEmployees() { renderEmployees(); }

function toggleEmployeeSelect(id, checkbox) {
  if (checkbox.checked) selectedEmployeeIds.add(id);
  else selectedEmployeeIds.delete(id);
  updateBulkBar();
}

function toggleSelectAllEmployees(master) {
  const checkboxes = document.querySelectorAll('.emp-row-select');
  checkboxes.forEach(cb => {
    const id = parseInt(cb.dataset.empId, 10);
    cb.checked = master.checked;
    if (master.checked) selectedEmployeeIds.add(id);
    else selectedEmployeeIds.delete(id);
  });
  updateBulkBar();
}

function clearEmpSelection() {
  selectedEmployeeIds.clear();
  document.querySelectorAll('.emp-row-select').forEach(cb => cb.checked = false);
  const master = document.getElementById('emp-select-all');
  if (master) master.checked = false;
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('emp-bulk-bar');
  if (!bar) return;
  const n = selectedEmployeeIds.size;
  document.getElementById('emp-bulk-count').textContent = String(n);
  bar.classList.toggle('hidden', n === 0);
}

function onBulkReasonChange(selectEl) {
  const isManual = selectEl.value === 'manual';
  document.getElementById('bulk-coin-amount').style.display = isManual ? 'inline-block' : 'none';
}

const DEDUCTION_REASONS = new Set(['bad_review', 'dirty_store', 'training_resistance']);

async function bulkAwardCoins() {
  if (selectedEmployeeIds.size === 0) return;
  const reason = document.getElementById('bulk-coin-reason').value;
  if (!reason) { toast('Выбери причину'); return; }
  const isManual = reason === 'manual';
  const amount = isManual ? parseInt(document.getElementById('bulk-coin-amount').value) : undefined;
  if (isManual && (isNaN(amount) || amount === 0)) { toast('Укажи сумму (можно отрицательную)'); return; }

  const ids = [...selectedEmployeeIds];
  const label = COIN_LABELS[reason] || reason;
  const isDeduction = DEDUCTION_REASONS.has(reason) || (isManual && amount < 0);
  const verb = isDeduction ? 'Списать монеты' : 'Начислить монеты';
  if (!confirm(`${verb} (${label}) для ${ids.length} сотрудников?`)) return;

  try {
    const result = await api('POST', '/employees/bulk-coins', {
      employeeIds: ids, reason, amount,
    });
    const action = isDeduction ? 'Списано' : 'Начислено';
    toast(`✅ ${action} ${result.succeeded} из ${result.processed}`);
    clearEmpSelection();
    loadEmployees();
  } catch (e) { toast('❌ ' + e.message); }
}

async function bulkSetActive(isActive) {
  if (selectedEmployeeIds.size === 0) return;
  const ids = [...selectedEmployeeIds];
  const verb = isActive ? 'активировать' : 'деактивировать';
  if (!confirm(`${verb[0].toUpperCase() + verb.slice(1)} ${ids.length} сотрудников?`)) return;
  try {
    await api('POST', '/employees/bulk-active', { employeeIds: ids, isActive });
    toast(`✅ ${isActive ? 'Активированы' : 'Деактивированы'}: ${ids.length}`);
    clearEmpSelection();
    loadEmployees();
  } catch (e) { toast('❌ ' + e.message); }
}

async function changeEmployeeStore(id, selectEl) {
  const newStoreId = parseInt(selectEl.value, 10);
  const oldStoreId = parseInt(selectEl.dataset.current, 10);
  if (!newStoreId || newStoreId === oldStoreId) return;
  const newStoreName = state.stores.find(s => s.id === newStoreId)?.name || 'другую точку';
  if (!confirm(`Перевести сотрудника на «${newStoreName}»?`)) {
    selectEl.value = String(oldStoreId);
    return;
  }
  selectEl.disabled = true;
  try {
    await api('PUT', `/employees/${id}`, { storeId: newStoreId });
    selectEl.dataset.current = String(newStoreId);
    toast(`✅ Сотрудник переведён на «${newStoreName}»`);
    if (state.storeId && state.storeId !== newStoreId) loadEmployees();
  } catch (e) {
    selectEl.value = String(oldStoreId);
    toast('❌ ' + e.message);
  } finally {
    selectEl.disabled = false;
  }
}

function showAddEmployee() {
  document.getElementById('add-employee-form').classList.toggle('hidden');
}

async function addEmployee() {
  const name = document.getElementById('new-emp-name').value.trim();
  const role = document.getElementById('new-emp-role').value;
  const telegramUsername = document.getElementById('new-emp-username').value.trim();
  const storeId = parseInt(document.getElementById('new-emp-store').value) || null;
  if (!name) { toast('Введите имя сотрудника'); return; }
  if (!storeId) { toast('Выберите точку'); return; }
  try {
    await api('POST', '/employees', { name, storeId, role, telegramUsername: telegramUsername || undefined });
    toast('✅ Сотрудник добавлен');
    document.getElementById('add-employee-form').classList.add('hidden');
    document.getElementById('new-emp-name').value = '';
    document.getElementById('new-emp-username').value = '';
    document.getElementById('new-emp-store').value = '';
    loadEmployees();
  } catch (e) { toast('❌ ' + e.message); }
}

async function toggleEmployee(id, isActive) {
  if (!isActive && !confirm('Скрыть этого сотрудника? Он перестанет получать монеты, карточки и уведомления.')) return;
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
  if (!state.storeId) {
    empTbody.innerHTML = emptyRow(5, 'store', 'Выбери точку в селекторе сверху или в боковой панели');
  } else if (!empData || empData.length === 0) {
    empTbody.innerHTML = emptyRow(5, 'trophy', 'Нет данных за этот период');
  } else {
    empTbody.innerHTML = empData.map((e, i) => {
      const score = e.mvpScore !== null ? Number(e.mvpScore).toFixed(2) : '';
      return `<tr>
        <td><strong>${RANK[i] ?? i+1}</strong></td>
        <td><strong>${esc(e.name)}</strong>${e.isMvp ? ' <span class="badge badge-mvp"><i data-lucide="star"></i> MVP</span>' : ''}</td>
        <td><input type="number" step="0.01" min="0" max="200" class="lb-score-input"
            value="${score}" data-emp-id="${e.employeeId}"
            onchange="saveEmployeeScore(${e.employeeId}, this)"></td>
        <td>${e.cardsCount}</td>
        <td>
          ${e.isMvp
            ? '<button class="btn btn-ghost btn-sm" disabled><i data-lucide="star"></i> MVP</button>'
            : `<button class="btn btn-ghost btn-sm" onclick="setEmployeeMvp(${e.employeeId})"><i data-lucide="star"></i> Сделать MVP</button>`}
        </td>
      </tr>`;
    }).join('');
  }

  const storeTbody = document.getElementById('lb-stores-tbody');
  if (!storeData || storeData.length === 0) {
    storeTbody.innerHTML = emptyRow(4, 'trophy', 'Нет данных');
  } else {
    storeTbody.innerHTML = storeData.map((s, i) => {
      const score = s.totalScore !== null ? Number(s.totalScore).toFixed(1) : '';
      return `<tr>
        <td><strong>${RANK[i] ?? i+1}</strong></td>
        <td><strong>${esc(s.storeName)}</strong>${s.isTop ? ' <span class="badge badge-mvp"><i data-lucide="crown"></i> ТОП</span>' : ''}</td>
        <td><input type="number" step="0.1" min="0" max="200" class="lb-score-input"
            value="${score}" onchange="saveStoreScore(${s.storeId}, this)"></td>
        <td>
          ${s.isTop
            ? '<button class="btn btn-ghost btn-sm" disabled><i data-lucide="crown"></i> ТОП</button>'
            : `<button class="btn btn-ghost btn-sm" onclick="setStoreTop(${s.storeId})"><i data-lucide="crown"></i> Сделать ТОП</button>`}
        </td>
      </tr>`;
    }).join('');
  }
  renderIcons();
}

async function saveEmployeeScore(employeeId, inputEl) {
  const v = inputEl.value.trim();
  const mvpScore = v === '' ? null : parseFloat(v);
  inputEl.disabled = true;
  try {
    await api('PUT', `/leaderboard/employees/${employeeId}`, {
      year: state.year, month: state.month, storeId: state.storeId, mvpScore,
    });
    toast('✅ Балл сохранён');
  } catch (e) { toast('❌ ' + e.message); }
  finally { inputEl.disabled = false; }
}

async function setEmployeeMvp(employeeId) {
  if (!confirm('Сделать сотрудника MVP месяца? С остальных в этой точке статус MVP будет снят.')) return;
  try {
    await api('PUT', `/leaderboard/employees/${employeeId}`, {
      year: state.year, month: state.month, storeId: state.storeId, isMvp: true,
    });
    toast('✅ MVP назначен');
    loadLeaderboard();
  } catch (e) { toast('❌ ' + e.message); }
}

async function saveStoreScore(storeId, inputEl) {
  const v = inputEl.value.trim();
  const totalScore = v === '' ? null : parseFloat(v);
  inputEl.disabled = true;
  try {
    await api('PUT', `/leaderboard/stores/${storeId}`, {
      year: state.year, month: state.month, totalScore,
    });
    toast('✅ Балл сохранён, рейтинг точек пересчитан');
    loadLeaderboard();
  } catch (e) { toast('❌ ' + e.message); }
  finally { inputEl.disabled = false; }
}

async function setStoreTop(storeId) {
  if (!confirm('Назначить точку ТОПом месяца? Команда получит бонусную карточку. С остальных точек ТОП будет снят.')) return;
  try {
    await api('PUT', `/leaderboard/stores/${storeId}`, {
      year: state.year, month: state.month, isTop: true,
    });
    toast('✅ ТОП-точка обновлена');
    loadLeaderboard();
  } catch (e) { toast('❌ ' + e.message); }
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

// ── Квиз ─────────────────────────────────────────────────────────────────────
const QUIZ_LABELS = ['А','Б','В','Г'];
const QUIZ_CATS   = {
  product: 'Продукция',
  service: 'Сервис',
  crew:    'Команда',
  brand:   'Бренд',
  sales:   'Техники продаж',
  upsell:  'Допродажи',
  loyalty: 'Лояльность',
  cashier: 'Касса',
  display: 'Выкладка',
};

async function loadQuizQuestions() {
  const tbody = document.getElementById('quiz-tbody');
  tbody.innerHTML = skeletonRows(5, 5);
  const questions = await api('GET', '/quiz') || [];
  if (!questions.length) {
    tbody.innerHTML = emptyRow(5, 'brain', 'Вопросов нет — добавьте первый');
    renderIcons(); return;
  }
  tbody.innerHTML = questions.map(q => `<tr>
    <td style="color:var(--muted);font-size:12px">${q.id}</td>
    <td style="font-size:13px;max-width:480px">${esc(q.question)}</td>
    <td><span class="badge badge-neutral">${QUIZ_CATS[q.category] || q.category}</span></td>
    <td>${q.isActive
      ? '<span class="badge badge-approved"><i data-lucide="check"></i> Активен</span>'
      : '<span class="badge badge-neutral"><i data-lucide="eye-off"></i> Скрыт</span>'}</td>
    <td>
      <div class="row-actions">
        <button class="btn btn-ghost btn-sm" onclick="toggleQuestion(${q.id},${!q.isActive})"><i data-lucide="${q.isActive ? 'eye-off' : 'eye'}"></i> ${q.isActive ? 'Скрыть' : 'Показать'}</button>
        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteQuestion(${q.id})" title="Удалить"><i data-lucide="trash-2"></i></button>
      </div>
    </td>
  </tr>`).join('');
  renderIcons();
}

function showAddQuestion() {
  document.getElementById('add-question-form').classList.toggle('hidden');
}

async function addQuestion() {
  const question    = document.getElementById('q-question').value.trim();
  const options     = [0,1,2,3].map(i => document.getElementById(`q-opt${i}`).value.trim());
  const correctIndex = parseInt(document.getElementById('q-correct').value);
  const category    = document.getElementById('q-category').value;

  if (!question || options.some(o => !o)) { toast('Заполните вопрос и все варианты ответов'); return; }

  try {
    await api('POST', '/quiz', { question, options, correctIndex, category });
    toast('✅ Вопрос добавлен');
    document.getElementById('add-question-form').classList.add('hidden');
    document.getElementById('q-question').value = '';
    [0,1,2,3].forEach(i => document.getElementById(`q-opt${i}`).value = '');
    loadQuizQuestions();
  } catch (e) { toast('❌ ' + e.message); }
}

async function toggleQuestion(id, isActive) {
  try {
    await api('PUT', `/quiz/${id}`, { isActive });
    loadQuizQuestions();
  } catch (e) { toast('❌ ' + e.message); }
}

async function deleteQuestion(id) {
  if (!confirm('Удалить вопрос? Это действие нельзя отменить.')) return;
  try {
    await api('DELETE', `/quiz/${id}`);
    toast('Вопрос удалён');
    loadQuizQuestions();
  } catch (e) { toast('❌ ' + e.message); }
}

// ── Карточки ─────────────────────────────────────────────────────────────────
const CARD_SOURCE_LABELS = {
  mystery_shopper: 'Тайный покупатель',
  review:          'Именной отзыв',
  checklist:       'Чек-лист 100%',
  plan:            'Выполнение плана',
  mvp:             'MVP месяца',
  team_bonus:      'Бонус ТОП-точки',
  seasonal:        'Сезонный челлендж',
  manual:          'Вручную (руководитель)',
};

let cardHeroes = null;

async function loadCardEmployees() {
  const path = state.storeId ? `/employees?storeId=${state.storeId}` : '/employees';
  const [emps, heroes] = await Promise.all([
    api('GET', path),
    cardHeroes ? Promise.resolve(cardHeroes) : api('GET', '/heroes'),
  ]);
  cardHeroes = heroes || [];
  state.employees = (emps || []).filter(e => e.isActive);

  const sel = document.getElementById('card-employee');
  sel.innerHTML = '<option value="">— выбери —</option>';
  state.employees.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = state.storeId ? e.name : `${e.name} — ${e.storeName ?? ''}`;
    sel.appendChild(opt);
  });
  sel.onchange = loadEmployeeCards;

  const heroSel = document.getElementById('card-hero');
  heroSel.innerHTML = cardHeroes.map(h =>
    `<option value="${h.id}">${esc(h.name)}${h.isLimited ? ' ⚡ лимитная' : ''}</option>`
  ).join('');

  document.getElementById('card-list').innerHTML =
    '<div class="empty">Выбери сотрудника, чтобы увидеть его карточки</div>';
}

async function loadEmployeeCards() {
  const id = document.getElementById('card-employee').value;
  const wrap = document.getElementById('card-list');
  if (!id) {
    wrap.innerHTML = emptyState('layers', 'Выбери сотрудника');
    renderIcons(); return;
  }

  wrap.innerHTML = emptyState('loader', 'Загрузка...');
  renderIcons();
  const cards = await api('GET', `/cards/${id}`) || [];
  if (cards.length === 0) {
    wrap.innerHTML = emptyState('layers', 'У сотрудника ещё нет карточек');
    renderIcons(); return;
  }

  const available = cards.filter(c => !c.isSpent).length;
  const totalMvp  = cards.filter(c => c.isMvp).length;

  wrap.innerHTML = `
    <div class="stat-grid" style="margin-bottom:14px;grid-template-columns:repeat(3,1fr)">
      <div class="stat-card">
        <div class="stat-card-icon"><i data-lucide="layers"></i></div>
        <div class="label">Всего</div>
        <div class="value">${cards.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon" style="background:var(--green-bg);color:var(--green)"><i data-lucide="check-circle"></i></div>
        <div class="label">Доступно</div>
        <div class="value">${available}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-icon"><i data-lucide="star"></i></div>
        <div class="label">MVP</div>
        <div class="value">${totalMvp}</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Герой</th><th>Источник</th><th>Период</th><th>MVP</th><th>Статус</th><th>Действия</th>
        </tr></thead>
        <tbody>
          ${cards.map(c => `<tr>
            <td><strong>${esc(c.heroName)}</strong>${c.heroLimited ? ' <span class="badge badge-mvp"><i data-lucide="zap"></i> Лимит</span>' : ''}</td>
            <td style="font-size:13px;color:var(--text-2)">${CARD_SOURCE_LABELS[c.source] ?? c.source}</td>
            <td style="font-size:12px;color:var(--muted)">${String(c.month).padStart(2,'0')}.${c.year}</td>
            <td>${c.isMvp ? '<i data-lucide="star" style="color:var(--pink);width:16px;height:16px"></i>' : ''}</td>
            <td>${c.isSpent
              ? '<span class="badge badge-neutral"><i data-lucide="circle-slash"></i> Потрачена</span>'
              : '<span class="badge badge-approved"><i data-lucide="check"></i> Доступна</span>'}</td>
            <td>
              <div class="row-actions">
                <button class="btn btn-ghost btn-sm" onclick="toggleCardSpent(${c.id}, ${!c.isSpent})">
                  <i data-lucide="${c.isSpent ? 'rotate-ccw' : 'minus-circle'}"></i> ${c.isSpent ? 'Вернуть' : 'Списать'}
                </button>
                <button class="btn btn-danger btn-sm btn-icon" onclick="revokeCard(${c.id})" title="Удалить"><i data-lucide="trash-2"></i></button>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  renderIcons();
}

async function giveCard() {
  const employeeId = parseInt(document.getElementById('card-employee').value);
  const heroId     = parseInt(document.getElementById('card-hero').value);
  const source     = document.getElementById('card-source').value;
  const isMvp      = document.getElementById('card-mvp').checked;
  if (!employeeId) { toast('Выбери сотрудника'); return; }
  if (!heroId)     { toast('Выбери героя'); return; }
  try {
    await api('POST', '/cards', { employeeId, heroId, isMvp, source });
    toast('✅ Карточка выдана');
    document.getElementById('card-mvp').checked = false;
    loadEmployeeCards();
  } catch (e) { toast('❌ ' + e.message); }
}

async function revokeCard(id) {
  if (!confirm('Удалить эту карточку? Действие нельзя отменить.')) return;
  try {
    await api('DELETE', `/cards/${id}`);
    toast('Карточка удалена');
    loadEmployeeCards();
  } catch (e) { toast('❌ ' + e.message); }
}

async function toggleCardSpent(id, isSpent) {
  try {
    await api('PATCH', `/cards/${id}/spent`, { isSpent });
    loadEmployeeCards();
  } catch (e) { toast('❌ ' + e.message); }
}

// ── Точки (управление) ──────────────────────────────────────────────────────
async function loadStoresAdmin() {
  const tbody = document.getElementById('stores-admin-tbody');
  tbody.innerHTML = skeletonRows(5, 6);

  state.stores = await api('GET', '/stores') || [];
  if (state.stores.length === 0) {
    tbody.innerHTML = emptyRow(5, 'store', 'Нет точек');
    renderIcons();
    return;
  }

  tbody.innerHTML = state.stores.map(s => `<tr data-store-id="${s.id}">
    <td style="color:var(--muted);font-size:12px">${s.id}</td>
    <td><input type="text" class="store-name-input" value="${esc(s.name)}" data-original="${esc(s.name)}"></td>
    <td><input type="text" class="store-address-input" value="${esc(s.address ?? '')}" data-original="${esc(s.address ?? '')}"></td>
    <td><input type="text" class="store-gis2-input" placeholder="70000001xxxxxxxxx" value="${esc(s.gis2Id ?? '')}" data-original="${esc(s.gis2Id ?? '')}"></td>
    <td>
      <select class="store-active-select" data-original="${s.isActive}">
        <option value="true"${s.isActive ? ' selected' : ''}>Активна</option>
        <option value="false"${!s.isActive ? ' selected' : ''}>Скрыта</option>
      </select>
    </td>
    <td><button class="btn btn-primary btn-sm" onclick="saveStoreAdmin(${s.id}, this)"><i data-lucide="save"></i> Сохранить</button></td>
  </tr>`).join('');
  renderIcons();

  // Обновляем все селекторы точек (sidebar + inline в Метриках/Рейтингах)
  populateStoreSelectors();
}

async function saveStoreAdmin(id, btn) {
  const row = document.querySelector(`tr[data-store-id="${id}"]`);
  const nameEl    = row.querySelector('.store-name-input');
  const addressEl = row.querySelector('.store-address-input');
  const gis2El    = row.querySelector('.store-gis2-input');
  const activeEl  = row.querySelector('.store-active-select');

  const name = nameEl.value.trim();
  const address = addressEl.value.trim();
  const gis2Id = gis2El.value.trim();
  const isActive = activeEl.value === 'true';

  if (!name) { toast('Название не может быть пустым'); return; }

  btn.disabled = true; btn.textContent = '⏳';
  try {
    await api('PUT', `/stores/${id}`, { name, address: address || null, gis2Id: gis2Id || null, isActive });
    toast('✅ Точка обновлена');
    nameEl.dataset.original = name;
    addressEl.dataset.original = address;
    gis2El.dataset.original = gis2Id;
    activeEl.dataset.original = isActive;
    const s = state.stores.find(x => x.id === id);
    if (s) { s.name = name; s.address = address; s.gis2Id = gis2Id; s.isActive = isActive; }
    populateStoreSelectors();
  } catch (e) { toast('❌ ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Сохранить'; }
}

async function fetchGis2Rating() {
  if (!state.storeId) { toast('Выберите точку'); return; }
  const btn = document.getElementById('gis2-btn');
  btn.disabled = true; btn.textContent = '⏳';
  try {
    const data = await api('GET', `/stores/${state.storeId}/gis2-rating`);
    if (data?.rating != null) {
      document.getElementById('store-rating-score').value = data.rating.toFixed(2);
      toast(`✅ Рейтинг из 2ГИС: ${data.rating.toFixed(2)}`);
    }
  } catch (e) { toast('❌ ' + e.message); }
  finally { btn.disabled = false; btn.innerHTML = '<i data-lucide="map-pin"></i> из 2ГИС'; renderIcons(); }
}

async function addStore() {
  const name = document.getElementById('new-store-name').value.trim();
  const address = document.getElementById('new-store-address').value.trim();
  if (!name) { toast('Введите название точки'); return; }
  try {
    await api('POST', '/stores', { name, address: address || undefined });
    toast('✅ Точка создана');
    document.getElementById('new-store-name').value = '';
    document.getElementById('new-store-address').value = '';
    loadStoresAdmin();
  } catch (e) { toast('❌ ' + e.message); }
}

// ── Призы ─────────────────────────────────────────────────────────────────────
const PRIZE_TYPE_LABELS = {
  cake:         'Торт/пирог',
  certificate:  'Сертификат',
  cash:         'Премия',
  shift_choice: 'Выбор смен',
  golden_badge: 'Зол. бейдж',
  coffee:       'Кофе/десерт',
  discount:     'Скидка',
  merch:        'Мерч',
  break:        'Доп. перерыв',
};

async function loadPrizes() {
  const tbody = document.getElementById('prizes-tbody');
  tbody.innerHTML = skeletonRows(8, 5);
  const list = await api('GET', '/prizes') || [];
  if (list.length === 0) {
    tbody.innerHTML = emptyRow(8, 'gift', 'Призов нет — добавьте первый');
    renderIcons();
    return;
  }
  tbody.innerHTML = list.map(p => `<tr data-prize-id="${p.id}">
    <td style="color:var(--muted);font-size:12px">${p.id}</td>
    <td><input type="text" class="prize-name-in" value="${esc(p.name)}" style="width:100%"></td>
    <td>
      <select class="prize-type-in" style="width:100%">
        ${Object.entries(PRIZE_TYPE_LABELS).map(([v, l]) =>
          `<option value="${v}"${v === p.prizeType ? ' selected' : ''}>${l}</option>`
        ).join('')}
      </select>
    </td>
    <td><input type="number" class="prize-cards-in" min="0" value="${p.cardsRequired}" style="width:80px;text-align:right"></td>
    <td><input type="number" class="prize-coins-in" min="0" value="${p.coinsRequired}" style="width:80px;text-align:right"></td>
    <td><input type="number" class="prize-order-in" value="${p.sortOrder}" style="width:70px;text-align:right"></td>
    <td>
      <select class="prize-active-in" style="width:100%">
        <option value="true"${p.isActive ? ' selected' : ''}>Активен</option>
        <option value="false"${!p.isActive ? ' selected' : ''}>Скрыт</option>
      </select>
    </td>
    <td>
      <div class="row-actions">
        <button class="btn btn-primary btn-sm btn-icon" onclick="savePrize(${p.id}, this)" title="Сохранить"><i data-lucide="save"></i></button>
        <button class="btn btn-danger btn-sm btn-icon" onclick="deletePrize(${p.id})" title="Удалить"><i data-lucide="trash-2"></i></button>
      </div>
    </td>
  </tr>`).join('');
  renderIcons();
}

function showAddPrize() { document.getElementById('add-prize-form').classList.toggle('hidden'); }

async function addPrize() {
  const name        = document.getElementById('new-prize-name').value.trim();
  const prizeType   = document.getElementById('new-prize-type').value;
  const cardsRequired = parseInt(document.getElementById('new-prize-cards').value) || 0;
  const coinsRequired = parseInt(document.getElementById('new-prize-coins').value) || 0;
  const sortOrder   = parseInt(document.getElementById('new-prize-order').value) || 100;
  const description = document.getElementById('new-prize-desc').value.trim();
  if (!name) { toast('Введите название'); return; }
  if (cardsRequired === 0 && coinsRequired === 0) { toast('Укажи стоимость в карточках или монетах'); return; }
  try {
    await api('POST', '/prizes', { name, prizeType, cardsRequired, coinsRequired, sortOrder, description: description || undefined });
    toast('✅ Приз добавлен');
    document.getElementById('add-prize-form').classList.add('hidden');
    ['new-prize-name','new-prize-cards','new-prize-coins','new-prize-desc'].forEach(id =>
      document.getElementById(id).value = id === 'new-prize-cards' || id === 'new-prize-coins' ? '0' : '');
    loadPrizes();
  } catch (e) { toast('❌ ' + e.message); }
}

async function savePrize(id, btn) {
  const row = document.querySelector(`tr[data-prize-id="${id}"]`);
  const body = {
    name: row.querySelector('.prize-name-in').value.trim(),
    prizeType: row.querySelector('.prize-type-in').value,
    cardsRequired: parseInt(row.querySelector('.prize-cards-in').value) || 0,
    coinsRequired: parseInt(row.querySelector('.prize-coins-in').value) || 0,
    sortOrder: parseInt(row.querySelector('.prize-order-in').value) || 100,
    isActive: row.querySelector('.prize-active-in').value === 'true',
  };
  if (!body.name) { toast('Название не пустое'); return; }
  btn.disabled = true; btn.textContent = '⏳';
  try {
    await api('PUT', `/prizes/${id}`, body);
    toast('✅ Сохранено');
  } catch (e) { toast('❌ ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '💾'; }
}

async function deletePrize(id) {
  if (!confirm('Удалить приз? Если на него были заявки — приз не удалится, нужно «Скрыть» через переключатель.')) return;
  try {
    await api('DELETE', `/prizes/${id}`);
    toast('Приз удалён');
    loadPrizes();
  } catch (e) { toast('❌ ' + e.message); }
}

// ── Журнал действий ─────────────────────────────────────────────────────────
const AUDIT_ACTION_LABELS = {
  coin_award:               '💰 Монеты',
  card_grant:               '🃏 Карточка выдана',
  card_revoke:              '🃏 Карточка удалена',
  card_spent_toggle:        '🃏 Статус карточки',
  employee_create:          '👤 Сотрудник создан',
  employee_update:          '👤 Сотрудник изменён',
  employee_store_change:    '🏪 Перевод на точку',
  employee_deactivate:      '👤 Деактивация',
  employee_activate:        '👤 Активация',
  metrics_save:             '📊 Метрики',
  metrics_process:          '⚡ Обработка месяца',
  rating_score_set:         '🏆 Балл рейтинга',
  rating_mvp_set:           '🏆 MVP назначен',
  rating_top_set:           '🏆 ТОП-точка',
  exchange_fulfill:         '🎁 Приз выдан',
  exchange_reject:          '🎁 Заявка отклонена',
  store_create:             '🏪 Точка создана',
  store_update:             '🏪 Точка изменена',
  prize_create:             '🎁 Приз создан',
  prize_update:             '🎁 Приз изменён',
  prize_delete:             '🎁 Приз удалён',
  quiz_question_create:     '🧩 Вопрос добавлен',
  quiz_question_update:     '🧩 Вопрос изменён',
  quiz_question_delete:     '🧩 Вопрос удалён',
  config_update:            '⚙️ Настройки изменены',
  hero_update:              '🎨 Герой обновлён',
};

function formatAuditDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}`;
  const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  return `${date} ${time}`;
}

let auditPage = 1;
const AUDIT_PAGE_SIZE = 50;

async function loadAudit(page) {
  if (page !== undefined) auditPage = page;
  const tbody = document.getElementById('audit-tbody');
  tbody.innerHTML = skeletonRows(4, 8);
  const result = await api('GET', `/audit?page=${auditPage}&pageSize=${AUDIT_PAGE_SIZE}`);
  if (!result || result.total === 0) {
    tbody.innerHTML = emptyRow(4, 'file-clock', 'Журнал пуст');
    renderIcons();
    document.getElementById('audit-pagination').innerHTML = '';
    return;
  }
  tbody.innerHTML = result.data.map(row => `<tr>
    <td style="font-size:12px;color:var(--muted);white-space:nowrap">${formatAuditDateTime(row.createdAt)}</td>
    <td style="font-size:13px"><strong>${esc(AUDIT_ACTION_LABELS[row.action] || row.action)}</strong></td>
    <td style="font-size:12px;color:var(--muted)">${esc(row.performedBy ?? '—')}</td>
    <td style="font-size:12px;color:var(--text-2);font-family:'JetBrains Mono', ui-monospace, Menlo, monospace;word-break:break-all">${esc(JSON.stringify(row.details))}</td>
  </tr>`).join('');
  renderIcons();

  const pag = document.getElementById('audit-pagination');
  const { page: p, pages, total } = result;
  pag.innerHTML = `
    <button class="btn btn-ghost btn-sm" onclick="loadAudit(${p - 1})" ${p <= 1 ? 'disabled' : ''}>
      <i data-lucide="chevron-left"></i>
    </button>
    <span class="text-muted" style="font-size:13px">Стр. ${p} из ${pages} · ${total} записей</span>
    <button class="btn btn-ghost btn-sm" onclick="loadAudit(${p + 1})" ${p >= pages ? 'disabled' : ''}>
      <i data-lucide="chevron-right"></i>
    </button>`;
  renderIcons();
}

// ── Челленджи ─────────────────────────────────────────────────────────────────
const SEASON_LABELS = { spring: 'Весна', summer: 'Лето', autumn: 'Осень', winter: 'Зима' };

async function loadChallenges() {
  const tbody = document.getElementById('challenges-tbody');
  tbody.innerHTML = skeletonRows(9, 4);
  const list = await api('GET', '/challenges') || [];
  if (list.length === 0) {
    tbody.innerHTML = emptyRow(9, 'flame', 'Нет челленджей — создайте первый');
    renderIcons(); return;
  }
  tbody.innerHTML = list.map(ch => {
    const startStr = ch.startDate ? String(ch.startDate).slice(0,10) : '—';
    const endStr   = ch.endDate   ? String(ch.endDate).slice(0,10)   : '—';
    const today = new Date().toISOString().slice(0,10);
    const isCurrent = ch.isActive && startStr <= today && endStr >= today;
    const statusBadge = !ch.isActive
      ? '<span class="badge badge-neutral">Отключён</span>'
      : isCurrent
        ? '<span class="badge badge-approved">Активен</span>'
        : (endStr < today
            ? '<span class="badge badge-neutral">Завершён</span>'
            : '<span class="badge badge-pending">Запланирован</span>');
    return `<tr>
      <td style="color:var(--muted);font-size:12px">${ch.id}</td>
      <td><strong>${esc(ch.name)}</strong></td>
      <td>${SEASON_LABELS[ch.season] ?? ch.season}</td>
      <td>${ch.year}</td>
      <td style="font-size:12px;color:var(--muted)">${startStr} — ${endStr}</td>
      <td style="font-size:13px">${esc(ch.heroName ?? '—')}</td>
      <td>${ch.entries ?? 0}</td>
      <td>${statusBadge}</td>
      <td><button class="btn btn-danger btn-sm btn-icon" onclick="deleteChallenge(${ch.id})" title="Удалить"><i data-lucide="trash-2"></i></button></td>
    </tr>`;
  }).join('');
  renderIcons();
}

async function deleteChallenge(id) {
  if (!confirm('Удалить челлендж? Будут также удалены записи участников.')) return;
  try {
    await api('DELETE', `/challenges/${id}`);
    toast('Челлендж удалён');
    loadChallenges();
  } catch (e) { toast('❌ ' + e.message); }
}

async function showAddChallenge() {
  const form = document.getElementById('add-challenge-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) {
    if (!cardHeroes || !cardHeroes.length) {
      cardHeroes = await api('GET', '/heroes') || [];
    }
    const sel = document.getElementById('ch-hero');
    sel.innerHTML = '<option value="">— без карточки —</option>';
    cardHeroes.filter(h => h.isLimited).forEach(h => {
      const opt = document.createElement('option');
      opt.value = h.id; opt.textContent = h.name;
      sel.appendChild(opt);
    });
  }
}

async function addChallenge() {
  const name = document.getElementById('ch-name').value.trim();
  const season = document.getElementById('ch-season').value;
  const year = parseInt(document.getElementById('ch-year').value);
  const heroId = parseInt(document.getElementById('ch-hero').value) || undefined;
  const startDate = document.getElementById('ch-start').value;
  const endDate = document.getElementById('ch-end').value;
  const description = document.getElementById('ch-desc').value.trim();
  const conditionDescription = document.getElementById('ch-condition').value.trim();

  if (!name || !season || !year || !startDate || !endDate) {
    toast('Заполните название, сезон, год, даты'); return;
  }
  if (new Date(startDate) >= new Date(endDate)) {
    toast('Дата начала должна быть раньше даты конца'); return;
  }
  try {
    await api('POST', '/challenges', { name, season, year, heroId, startDate, endDate, description, conditionDescription });
    toast('✅ Челлендж создан');
    document.getElementById('add-challenge-form').classList.add('hidden');
    loadChallenges();
  } catch (e) { toast('❌ ' + e.message); }
}

// ── Герои ─────────────────────────────────────────────────────────────────────
async function loadHeroes() {
  const tbody = document.getElementById('heroes-tbody');
  tbody.innerHTML = skeletonRows(7, 6);
  const list = await api('GET', '/heroes') || [];
  if (list.length === 0) {
    tbody.innerHTML = emptyRow(7, 'image', 'Нет героев');
    renderIcons(); return;
  }
  tbody.innerHTML = list.map(h => `<tr data-hero-id="${h.id}">
    <td style="color:var(--muted);font-size:12px">${h.id}</td>
    <td><input type="text" class="hero-name-input" value="${esc(h.name)}" style="width:120px;font-weight:600"></td>
    <td>${h.isLimited ? '<span class="badge badge-mvp">Лимит</span>' : '<span class="badge badge-neutral">Основной</span>'}</td>
    <td><input type="text" class="hero-desc-input" value="${esc(h.description ?? '')}" placeholder="..." style="width:100%"></td>
    <td>
      <div style="display:flex;gap:6px;align-items:center">
        <input type="text" class="hero-img-input" value="${esc(h.imageUrl ?? '')}" placeholder="https://..." style="flex:1;min-width:0">
        ${state.cloudinary.enabled ? `<button class="btn btn-ghost btn-sm btn-icon" onclick="uploadHeroImage(${h.id})" title="Загрузить фото"><i data-lucide="upload"></i></button>` : ''}
      </div>
    </td>
    <td style="display:flex;gap:4px">
      <button class="btn btn-primary btn-sm btn-icon" onclick="saveHero(${h.id}, this)" title="Сохранить"><i data-lucide="save"></i></button>
      <button class="btn btn-danger btn-sm btn-icon" onclick="deleteHero(${h.id})" title="Удалить"><i data-lucide="trash-2"></i></button>
    </td>
  </tr>`).join('');
  renderIcons();
}

async function saveHero(id, btn) {
  const row = document.querySelector(`tr[data-hero-id="${id}"]`);
  const name        = row.querySelector('.hero-name-input').value.trim();
  const description = row.querySelector('.hero-desc-input').value.trim() || null;
  const imageUrl    = row.querySelector('.hero-img-input').value.trim() || null;
  if (!name) { toast('Имя не может быть пустым'); return; }
  btn.disabled = true; btn.textContent = '⏳';
  try {
    await api('PATCH', `/heroes/${id}`, { name, description, imageUrl });
    toast('✅ Герой обновлён');
  } catch (e) { toast('❌ ' + e.message); }
  finally { btn.disabled = false; btn.innerHTML = '<i data-lucide="save"></i>'; renderIcons(); }
}

async function deleteHero(id) {
  if (!confirm('Удалить этого героя? Это действие нельзя отменить.')) return;
  try {
    await api('DELETE', `/heroes/${id}`);
    toast('Герой удалён');
    loadHeroes();
  } catch (e) { toast('❌ ' + e.message); }
}

async function addHero() {
  const name        = document.getElementById('new-hero-name').value.trim();
  const description = document.getElementById('new-hero-desc').value.trim() || null;
  const isLimited   = document.getElementById('new-hero-type').value === 'limited';
  const season      = isLimited ? (document.getElementById('new-hero-season').value || null) : null;
  const sortOrder   = parseInt(document.getElementById('new-hero-order').value, 10) || 0;
  if (!name) { toast('Введи имя героя'); return; }
  try {
    await api('POST', '/heroes', { name, description, isLimited, season, sortOrder });
    toast('✅ Герой добавлен');
    document.getElementById('add-hero-form').classList.add('hidden');
    document.getElementById('new-hero-name').value = '';
    document.getElementById('new-hero-desc').value = '';
    document.getElementById('new-hero-type').value = 'main';
    document.getElementById('new-hero-season-wrap').style.display = 'none';
    document.getElementById('new-hero-order').value = '0';
    loadHeroes();
  } catch (e) { toast('❌ ' + e.message); }
}

function uploadHeroImage(heroId) {
  if (!state.cloudinary.enabled) { toast('Cloudinary не настроен'); return; }
  const input = document.getElementById('hero-file-input');
  input.dataset.heroId = heroId;
  input.value = '';
  input.click();
}

async function _onHeroFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  const heroId = parseInt(input.dataset.heroId, 10);
  const row = document.querySelector(`tr[data-hero-id="${heroId}"]`);
  if (!row) return;

  const uploadBtn = row.querySelector(`button[onclick="uploadHeroImage(${heroId})"]`);
  if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.innerHTML = '<i data-lucide="loader-2"></i>'; renderIcons(); }

  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', state.cloudinary.uploadPreset);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${state.cloudinary.cloudName}/image/upload`, {
      method: 'POST',
      body: fd,
    });
    if (!res.ok) throw new Error(`Cloudinary error ${res.status}`);
    const data = await res.json();
    const url = data.secure_url;

    row.querySelector('.hero-img-input').value = url;
    toast('Фото загружено — нажми «Сохранить»');
  } catch (e) {
    toast('❌ ' + e.message);
  } finally {
    if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.innerHTML = '<i data-lucide="upload"></i>'; renderIcons(); }
  }
}

// ── Аналитика квиза ──────────────────────────────────────────────────────────
let quizAnalyticsVisible = false;

async function loadQuizAnalytics() {
  const wrap = document.getElementById('quiz-analytics');
  if (quizAnalyticsVisible) {
    wrap.classList.add('hidden');
    quizAnalyticsVisible = false;
    return;
  }
  wrap.classList.remove('hidden');
  quizAnalyticsVisible = true;
  wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">Загрузка аналитики...</div>';

  const data = await api('GET', '/quiz/analytics');
  if (!data) { wrap.innerHTML = ''; return; }

  const { summary, hardestQuestions, byCategory } = data;
  const QUIZ_CATS_LABEL = QUIZ_CATS;

  wrap.innerHTML = `
    <div class="card card-pad">
      <p class="section-title">Статистика квиза</p>
      <div class="stat-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:18px">
        <div class="stat-card">
          <div class="label">Всего попыток</div>
          <div class="value">${Number(summary.totalAttempts).toLocaleString('ru')}</div>
        </div>
        <div class="stat-card">
          <div class="label">Активных участников</div>
          <div class="value">${summary.uniqueEmployees}</div>
        </div>
        <div class="stat-card">
          <div class="label">Средне попыток/день</div>
          <div class="value">${summary.avgDailyAttempts}</div>
        </div>
      </div>

      ${byCategory.length ? `
      <p class="section-title" style="margin-top:12px">По категориям</p>
      <div class="table-wrap" style="margin-bottom:18px">
        <table>
          <thead><tr><th>Категория</th><th>Попыток</th><th>Верных</th><th>% успеха</th></tr></thead>
          <tbody>${byCategory.map(c => `<tr>
            <td>${esc(QUIZ_CATS_LABEL[c.category] ?? c.category)}</td>
            <td>${Number(c.totalAttempts).toLocaleString('ru')}</td>
            <td>${Number(c.correctAttempts).toLocaleString('ru')}</td>
            <td>
              <span style="color:${c.successRate >= 70 ? 'var(--green)' : c.successRate >= 50 ? 'var(--yellow,#e6a800)' : 'var(--red)'}">
                ${c.successRate}%
              </span>
            </td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}

      ${hardestQuestions.length ? `
      <p class="section-title">Самые сложные вопросы (мин. 5 попыток)</p>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Вопрос</th>
            <th style="width:100px">Категория</th>
            <th style="width:90px">Попыток</th>
            <th style="width:110px">% ошибок</th>
          </tr></thead>
          <tbody>${hardestQuestions.map(q => `<tr>
            <td style="font-size:13px">${esc(q.question)}</td>
            <td><span class="badge badge-neutral">${QUIZ_CATS_LABEL[q.category] ?? q.category}</span></td>
            <td>${q.totalAttempts}</td>
            <td style="color:var(--red);font-weight:600">${q.errorRate}%</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : '<p class="text-muted">Недостаточно данных (нужно мин. 5 попыток на вопрос)</p>'}
    </div>`;
  renderIcons();
}

// ── Настройки MVP ─────────────────────────────────────────────────────────────
async function loadMvpConfig() {
  const cfg = await api('GET', '/config/mvp');
  if (!cfg) return;
  document.getElementById('cfg-mystery').value         = cfg.mysteryShopperWeight;
  document.getElementById('cfg-reviews-per-card').value = cfg.reviewsPerCard;
  document.getElementById('cfg-reviews-max').value     = cfg.reviewsMax;
  document.getElementById('cfg-checklist').value       = cfg.checklistWeight;
  document.getElementById('cfg-revenue-factor').value  = cfg.revenueWeightFactor;
  document.getElementById('cfg-revenue-max').value     = cfg.revenueMax;
  document.getElementById('cfg-mvp-coins').value       = cfg.mvpCoinReward ?? 50;
  document.getElementById('cfg-top-store-coins').value = cfg.topStoreCoinReward ?? 30;
  const upd = document.getElementById('cfg-last-updated');
  if (upd && cfg.updatedAt) {
    upd.textContent = `Последнее изменение: ${formatAuditDateTime(cfg.updatedAt)}`;
  }
}

async function saveMvpConfig() {
  const weights = {
    mysteryShopperWeight: parseFloat(document.getElementById('cfg-mystery').value),
    reviewsPerCard:       parseFloat(document.getElementById('cfg-reviews-per-card').value),
    reviewsMax:           parseFloat(document.getElementById('cfg-reviews-max').value),
    checklistWeight:      parseFloat(document.getElementById('cfg-checklist').value),
    revenueWeightFactor:  parseFloat(document.getElementById('cfg-revenue-factor').value),
    revenueMax:           parseFloat(document.getElementById('cfg-revenue-max').value),
  };
  if (Object.values(weights).some(v => isNaN(v) || v < 0 || v > 100)) {
    toast('Веса должны быть от 0 до 100'); return;
  }
  const coins = {
    mvpCoinReward:      parseInt(document.getElementById('cfg-mvp-coins').value, 10),
    topStoreCoinReward: parseInt(document.getElementById('cfg-top-store-coins').value, 10),
  };
  if (Object.values(coins).some(v => isNaN(v) || v < 0 || v > 10000)) {
    toast('Монеты должны быть от 0 до 10000'); return;
  }
  try {
    await api('PUT', '/config/mvp', { ...weights, ...coins });
    toast('✅ Настройки сохранены');
    loadMvpConfig();
  } catch (e) { toast('❌ ' + e.message); }
}

// ── Дашборд ───────────────────────────────────────────────────────────────────
const SEASON_LABELS_DASH = { spring: 'Весна', summer: 'Лето', autumn: 'Осень', winter: 'Зима' };

async function loadDashboard() {
  const data = await api('GET', '/dashboard');
  if (!data) return;

  document.getElementById('dash-active-emp-val').textContent = data.activeEmployees;
  document.getElementById('dash-coins-val').textContent = data.coinsIssuedThisMonth;

  const pendingEl = document.getElementById('dash-pending-ex-val');
  const pendingCard = document.getElementById('dash-pending-card');
  pendingEl.textContent = data.pendingExchanges;
  pendingCard.classList.toggle('has-pending', data.pendingExchanges > 0);
  updatePendingBadge(data.pendingExchanges);

  // Top-3 MVP
  const top3El = document.getElementById('dash-top3');
  if (data.top3Mvp && data.top3Mvp.length > 0) {
    const medals = ['🥇', '🥈', '🥉'];
    const periodLabel = data.mvpPeriod
      ? `<div style="font-size:12px;color:var(--text-3);margin-bottom:8px">за ${MONTH_NAMES[data.mvpPeriod.month]} ${data.mvpPeriod.year}</div>`
      : '';
    top3El.innerHTML = periodLabel + data.top3Mvp.map((e, i) =>
      `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:20px">${medals[i] ?? ''}</span>
        <div style="flex:1">
          <div style="font-weight:600;font-size:14px">${esc(e.name)}</div>
          <div style="font-size:12px;color:var(--text-3)">${esc(e.storeName)}</div>
        </div>
        <div style="font-weight:700;color:var(--pink)">${e.mvpScore} б.</div>
      </div>`
    ).join('');
  } else {
    top3El.innerHTML = '<p class="text-muted">Заполни метрики во вкладке «Метрики» — топ-3 появится автоматически.</p>';
  }

  // Active challenges
  const challEl = document.getElementById('dash-challenges');
  if (data.activeChallenges && data.activeChallenges.length > 0) {
    challEl.innerHTML = data.activeChallenges.map(c => {
      const pct = c.completionPercent;
      const label = `${SEASON_LABELS_DASH[c.season] ?? c.season} ${c.year}`;
      return `<div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <span style="font-size:13px;font-weight:600">${esc(c.name)}</span>
          <span style="font-size:12px;color:var(--text-3)">${label} · ${c.completedCount}/${c.totalCount ?? '?'} (${pct}%)</span>
        </div>
        <div style="background:var(--border);border-radius:999px;height:6px">
          <div style="background:var(--pink);border-radius:999px;height:6px;width:${pct}%;transition:width .4s"></div>
        </div>
      </div>`;
    }).join('');
  } else {
    challEl.innerHTML = '<p class="text-muted">Нет активных челленджей</p>';
  }

  renderIcons();
  loadEngagement();
}

async function loadEngagement() {
  // Cache-busting + явный запрос свежих данных
  const data = await api('GET', `/employees/engagement?days=30&_=${Date.now()}`);
  const el = document.getElementById('engagement-chart');
  if (!el) return;

  // Строим карту "дата → uniqueUsers" из ответа
  const byDate = new Map((data || []).map(d => [d.date, Number(d.uniqueUsers) || 0]));

  // Генерируем все 30 дней (Иркутск, UTC+8) включая сегодня — даже пустые
  const days = [];
  const irkNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(irkNow.getTime() - i * 24 * 60 * 60 * 1000);
    const iso = d.toISOString().slice(0, 10);
    days.push({ date: iso, uniqueUsers: byDate.get(iso) ?? 0 });
  }

  const totalCheckins = days.reduce((s, d) => s + d.uniqueUsers, 0);
  if (totalCheckins === 0) {
    el.innerHTML = '<p class="text-muted" style="font-size:13px">Нет чек-инов за последние 30 дней. Сотрудники должны нажать 🔥 в шапке приложения.</p>';
    return;
  }

  const maxVal = Math.max(...days.map(d => d.uniqueUsers), 1);
  const todayIso = days[days.length - 1].date;
  const bars = days.map(d => {
    const h = d.uniqueUsers > 0 ? Math.max(4, Math.round(d.uniqueUsers / maxVal * 60)) : 2;
    const shortDate = d.date.slice(5); // MM-DD
    const isToday = d.date === todayIso;
    return `<div class="eng-bar-wrap" title="${d.date}: ${d.uniqueUsers} чел.${isToday ? ' (сегодня)' : ''}">
      <div class="eng-bar${d.uniqueUsers === 0 ? ' eng-bar-empty' : ''}${isToday ? ' eng-bar-today' : ''}" style="height:${h}px"></div>
      <div class="eng-date${isToday ? ' eng-date-today' : ''}">${shortDate}</div>
    </div>`;
  }).join('');
  const updated = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `<div class="eng-chart">${bars}</div>
    <p class="text-muted" style="font-size:11px;margin-top:6px;text-align:right">Обновлено в ${updated}</p>`;
}

// ── Рассылка ──────────────────────────────────────────────────────────────────
async function loadNotifyForm() {
  // Заполняем выпадалки точек и сотрудников
  const storesSel = document.getElementById('notify-store');
  storesSel.innerHTML = '<option value="">— выбери —</option>'
    + (state.stores || []).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');

  const empsSel = document.getElementById('notify-employee');
  if (empsSel.options.length <= 1) {
    const emps = await api('GET', '/employees') || [];
    empsSel.innerHTML = '<option value="">— выбери —</option>'
      + emps.map(e => `<option value="${e.id}">${esc(e.name)}${e.storeName ? ` — ${esc(e.storeName)}` : ''}</option>`).join('');
  }
}

function onNotifyTargetChange() {
  const target = document.getElementById('notify-target').value;
  document.getElementById('notify-store-label').classList.toggle('hidden', target !== 'store');
  document.getElementById('notify-emp-label').classList.toggle('hidden', target !== 'employee');
}

async function sendNotification() {
  const message = document.getElementById('notify-message').value.trim();
  const target  = document.getElementById('notify-target').value;
  const storeId = parseInt(document.getElementById('notify-store').value) || undefined;
  const employeeId = parseInt(document.getElementById('notify-employee').value) || undefined;

  if (!message) { toast('Введи текст сообщения'); return; }
  if (target === 'store' && !storeId) { toast('Выбери точку'); return; }
  if (target === 'employee' && !employeeId) { toast('Выбери сотрудника'); return; }

  const resultEl = document.getElementById('notify-result');
  resultEl.textContent = 'Отправка...';
  resultEl.className = 'text-muted';

  try {
    const res = await api('POST', '/notify', { message, target, storeId, employeeId });
    if (res) {
      resultEl.textContent = `✅ Отправлено: ${res.sent}, не доставлено: ${res.failed}`;
      resultEl.className = 'notify-result-ok';
      if (res.warning) { resultEl.textContent += ` (${res.warning})`; }
      document.getElementById('notify-message').value = '';
    }
  } catch (e) {
    resultEl.textContent = '❌ ' + e.message;
    resultEl.className = 'notify-result-err';
  }
}

async function saveEmployeePhone(id, btn) {
  const input = document.getElementById('emp-phone-input');
  if (!input) return;
  const phone = input.value.trim() || null;
  btn.disabled = true;
  try {
    await api('PUT', `/employees/${id}`, { phone });
    toast('✅ Телефон сохранён');
  } catch (e) { toast('❌ ' + e.message); }
  finally { btn.disabled = false; }
}

// ── Карточка сотрудника (модалка) ─────────────────────────────────────────────
async function showEmployeeModal(id) {
  const modal = document.getElementById('modal-employee');
  const body  = document.getElementById('modal-emp-body');
  const title = document.getElementById('modal-emp-title');
  title.textContent = 'Загрузка...';
  body.innerHTML = '<p class="text-muted">Загрузка...</p>';
  modal.classList.remove('hidden');
  renderIcons();

  const [summary, coinHistory, exchanges] = await Promise.all([
    api('GET', `/employees/${id}/summary`),
    api('GET', `/coins/history/${id}?limit=15`),
    api('GET', `/exchanges?employeeId=${id}`),
  ]);

  if (!summary) { body.innerHTML = '<p class="text-muted">Ошибка загрузки</p>'; return; }

  title.textContent = summary.name;

  const roleLabel = { employee: 'Сотрудник', manager: 'Менеджер', admin: 'Администратор' };
  const lastSeen  = summary.lastSeenAt ? formatDate(summary.lastSeenAt) : 'Не заходил';

  body.innerHTML = `
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px">
      <div style="flex:1;min-width:200px">
        <div style="font-size:13px;color:var(--text-2);margin-bottom:4px">Точка</div>
        <div style="font-weight:600">${esc(summary.storeName ?? '—')}</div>
      </div>
      <div>
        <div style="font-size:13px;color:var(--text-2);margin-bottom:4px">Роль</div>
        <div>${roleLabel[summary.role] ?? summary.role}</div>
      </div>
      <div>
        <div style="font-size:13px;color:var(--text-2);margin-bottom:4px">Монет</div>
        <div style="font-weight:700;color:var(--pink)">${summary.coinBalance}</div>
      </div>
      <div>
        <div style="font-size:13px;color:var(--text-2);margin-bottom:4px">Карточек</div>
        <div style="font-weight:700">${summary.availableCards}</div>
      </div>
      <div>
        <div style="font-size:13px;color:var(--text-2);margin-bottom:4px">Героев</div>
        <div>${summary.uniqueHeroes}/12</div>
      </div>
      <div>
        <div style="font-size:13px;color:var(--text-2);margin-bottom:4px">Последний вход</div>
        <div style="font-size:13px">${lastSeen}</div>
      </div>
    </div>

    <div style="display:flex;gap:8px;align-items:center;margin-bottom:20px;padding:12px;background:var(--bg-2,#f8f8f8);border-radius:8px">
      <i data-lucide="phone" style="width:16px;height:16px;color:var(--text-2)"></i>
      <span style="font-size:13px;color:var(--text-2)">Телефон:</span>
      <input type="tel" id="emp-phone-input" value="${esc(summary.phone ?? '')}" placeholder="+7..." style="flex:1;min-width:140px">
      <button class="btn btn-primary btn-sm" onclick="saveEmployeePhone(${summary.id}, this)"><i data-lucide="save"></i> Сохранить</button>
    </div>

    <p class="section-title">Последние монеты</p>
    ${(coinHistory && coinHistory.length > 0)
      ? `<table style="width:100%;font-size:13px;margin-bottom:16px">
           <thead><tr><th>Дата</th><th>Сумма</th><th>Причина</th><th>Примечание</th></tr></thead>
           <tbody>${coinHistory.map(t => `<tr>
             <td style="color:var(--text-2)">${formatDate(t.createdAt)}</td>
             <td style="font-weight:600;color:${t.amount > 0 ? 'var(--green,#22c55e)' : 'var(--red,#ef4444)'}">${t.amount > 0 ? '+' : ''}${t.amount}</td>
             <td>${esc(COIN_LABELS[t.reason] ?? t.reason)}</td>
             <td style="color:var(--text-3)">${esc(t.note ?? '')}</td>
           </tr>`).join('')}</tbody>
         </table>`
      : '<p class="text-muted" style="margin-bottom:16px">Нет транзакций</p>'}

    <p class="section-title">Заявки на обмен</p>
    ${(exchanges && exchanges.length > 0)
      ? `<table style="width:100%;font-size:13px">
           <thead><tr><th>Дата</th><th>Приз</th><th>Карт.</th><th>Монет</th><th>Статус</th></tr></thead>
           <tbody>${exchanges.map(ex => `<tr>
             <td style="color:var(--text-2)">${formatDate(ex.createdAt)}</td>
             <td>${esc(ex.prizeName ?? '—')}</td>
             <td>${ex.cardsSpent}</td>
             <td>${ex.coinsSpent}</td>
             <td><span class="badge badge-${ex.status}">${statusLabel(ex.status)}</span></td>
           </tr>`).join('')}</tbody>
         </table>`
      : '<p class="text-muted">Нет заявок</p>'}
  `;
  renderIcons();
}

function closeEmployeeModal() {
  document.getElementById('modal-employee').classList.add('hidden');
}

// ── CSV Экспорт ───────────────────────────────────────────────────────────────
function downloadCsv(filename, headers, rows) {
  const escape = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function exportEmployeesCsv() {
  const emps = await api('GET', '/employees') || [];
  downloadCsv(
    `сотрудники_${new Date().toISOString().slice(0,10)}.csv`,
    ['ID','Имя','Точка','Роль','Активен','Монеты (требует запроса)','Telegram'],
    emps.map(e => [e.id, e.name, e.storeName ?? '', e.role, e.isActive ? 'Да' : 'Нет', '', e.telegramUsername ?? ''])
  );
}

async function exportMetricsCsv() {
  if (!state.storeId) { toast('Выберите точку'); return; }
  const [rows, employees] = await Promise.all([
    api('GET', `/metrics?storeId=${state.storeId}&year=${state.year}&month=${state.month}`),
    api('GET', `/stores/${state.storeId}/employees`),
  ]);
  const metricMap = {};
  (rows || []).forEach(r => { metricMap[r.employeeId] = r; });
  const emps = (employees || []).filter(e => e.isActive);
  downloadCsv(
    `метрики_${state.year}_${state.month}.csv`,
    ['Сотрудник','Тайный покупатель (0-100)','Отзывы','Чек-лист (%)','Выполнение плана (%)','MVP Score','MVP'],
    emps.map(e => {
      const m = metricMap[e.id] || {};
      return [e.name, m.mysteryShopperScore ?? '', m.reviewsCount ?? 0, m.checklistPercent ?? '', m.revenuePercent ?? '', m.mvpScore ?? '', m.isMvp ? 'Да' : ''];
    })
  );
}

async function exportLeaderboardCsv() {
  const params = state.storeId ? `?storeId=${state.storeId}&year=${state.year}&month=${state.month}` : `?year=${state.year}&month=${state.month}`;
  const data = await api('GET', `/leaderboard${params}`);
  if (!data) return;
  const emps = data.employees || data || [];
  downloadCsv(
    `рейтинг_${state.year}_${state.month}.csv`,
    ['Место','Сотрудник','Точка','MVP Score','MVP','Карточек','Монет'],
    emps.map((e, i) => [i+1, e.name ?? e.employeeName, e.storeName ?? '', e.mvpScore ?? '', e.isMvp ? 'Да' : '', e.cardsCount ?? '', e.coinsBalance ?? ''])
  );
}

// ── Доступы (управление админами, только суперадмин) ─────────────────────────

async function loadAdminUsers() {
  const tbody = document.getElementById('admin-users-tbody');
  tbody.innerHTML = skeletonRows(6, 4);
  const list = await api('GET', '/admin-users') || [];
  if (list.length === 0) {
    tbody.innerHTML = emptyRow(6, 'shield', 'Нет учётных записей');
    renderIcons(); return;
  }
  tbody.innerHTML = list.map(u => `<tr>
    <td style="color:var(--muted);font-size:12px">${u.id}</td>
    <td><strong>${esc(u.username)}</strong></td>
    <td>
      <select onchange="updateAdminUserRole(${u.id}, this.value)" ${u.id === state.adminUserId ? 'disabled' : ''}>
        <option value="superadmin"${u.role === 'superadmin' ? ' selected' : ''}>Суперадмин</option>
        <option value="editor"${u.role === 'editor' ? ' selected' : ''}>Админище — всё кроме монет</option>
        <option value="coin_admin"${u.role === 'coin_admin' ? ' selected' : ''}>Администратор — только монеты</option>
      </select>
    </td>
    <td style="font-size:12px;color:var(--muted)">${u.lastLoginAt ? formatDate(u.lastLoginAt) : '—'}</td>
    <td>${u.isActive
      ? '<span class="badge badge-approved">Активен</span>'
      : '<span class="badge badge-neutral">Отключён</span>'}</td>
    <td style="display:flex;gap:4px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" onclick="resetAdminPassword(${u.id})" title="Сменить пароль"><i data-lucide="key"></i></button>
      ${u.isActive
        ? `<button class="btn btn-ghost btn-sm" onclick="toggleAdminActive(${u.id}, false)"><i data-lucide="user-x"></i> Отключить</button>`
        : `<button class="btn btn-ghost btn-sm" onclick="toggleAdminActive(${u.id}, true)"><i data-lucide="user-check"></i> Включить</button>`}
      <button class="btn btn-danger btn-sm btn-icon" onclick="deleteAdminUser(${u.id})" title="Удалить"><i data-lucide="trash-2"></i></button>
    </td>
  </tr>`).join('');
  renderIcons();
}

async function addAdminUser() {
  const username = document.getElementById('new-admin-username').value.trim();
  const password = document.getElementById('new-admin-password').value;
  const role     = document.getElementById('new-admin-role').value;
  if (!username) { toast('Введи логин'); return; }
  if (!password || password.length < 4) { toast('Пароль минимум 4 символа'); return; }
  try {
    await api('POST', '/admin-users', { username, password, role });
    toast('✅ Пользователь создан');
    document.getElementById('add-admin-form').classList.add('hidden');
    document.getElementById('new-admin-username').value = '';
    document.getElementById('new-admin-password').value = '';
    loadAdminUsers();
  } catch (e) { toast('❌ ' + e.message); }
}

async function updateAdminUserRole(id, role) {
  try {
    await api('PUT', `/admin-users/${id}`, { role });
    toast('Роль обновлена');
  } catch (e) { toast('❌ ' + e.message); loadAdminUsers(); }
}

async function toggleAdminActive(id, isActive) {
  try {
    await api('PUT', `/admin-users/${id}`, { isActive });
    toast(isActive ? 'Включён' : 'Отключён');
    loadAdminUsers();
  } catch (e) { toast('❌ ' + e.message); }
}

async function resetAdminPassword(id) {
  const password = prompt('Введи новый пароль (минимум 4 символа):');
  if (!password) return;
  if (password.length < 4) { toast('Пароль минимум 4 символа'); return; }
  try {
    await api('PUT', `/admin-users/${id}`, { password });
    toast('✅ Пароль обновлён');
  } catch (e) { toast('❌ ' + e.message); }
}

async function deleteAdminUser(id) {
  if (!confirm('Удалить эту учётную запись?')) return;
  try {
    await api('DELETE', `/admin-users/${id}`);
    toast('Удалено');
    loadAdminUsers();
  } catch (e) { toast('❌ ' + e.message); }
}

// ── Старт ─────────────────────────────────────────────────────────────────────
if (state.token) showApp();
