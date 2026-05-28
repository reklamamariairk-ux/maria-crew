// ── State ────────────────────────────────────────────────────────────────────
const state = {
  token: sessionStorage.getItem('mc_token') || '',
  role:  sessionStorage.getItem('mc_role')  || '',
  storeId: null,
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  stores: [],
  employees: [],
  // Челленджи, идущие сейчас, с coinReward > 0 — подмешиваем в селекты причин
  // на вкладке «Монеты», чтобы можно было одним кликом наградить за участие.
  activeChallenges: [],
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
  substitution:        'Подмена коллеги на другой точке',
  mentoring:           'Наставничество',
  idea:                'Идея внедрена',
  training_meeting:    'Собрание по обучению',
  knowledge_applied:   'Применение знаний',
  plan_100:            'Выполнение плана 100%',
  plan_105:            'Перевыполнение плана >105%',
  plan_dishes:         'Выполнение плана по блюдам',
  drinks:              'За напитки',
  quiz:                'Квиз',
  checkin:             'Вход в приложение',
  // Списания
  bad_review:          'Отрицательный отзыв гостя',
  dirty_store:         'Нарушение стандартов чистоты',
  training_resistance: 'Сопротивление обучению',
  // Служебные
  spend:               'Обмен в Store',
  manual:              'Вручную',
};

// ── API ──────────────────────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Дефолтные сообщения по HTTP-статусу для случая, когда бэк вернул не-JSON
// или поле `error` пустое. Цель — чтобы пользователь увидел конкретику,
// а не «Ошибка сети» при любой проблеме.
function _defaultMessageForStatus(status) {
  if (status === 400) return 'Запрос отклонён: проверь введённые данные';
  if (status === 404) return 'Не найдено — возможно, запись уже удалили';
  if (status === 409) return 'Конфликт: такая запись уже существует или используется';
  if (status === 422) return 'Некорректные данные';
  if (status === 429) return 'Слишком много запросов — подожди минуту';
  if (status >= 500) return 'Внутренняя ошибка сервера. Попробуй ещё раз через минуту.';
  return 'Что-то пошло не так';
}

async function api(method, path, body) {
  let res;
  try {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
    };
    if (body) opts.body = JSON.stringify(body);
    res = await fetch(`/api${path}`, opts);
  } catch {
    // Сеть упала — fetch отверг промис до получения ответа
    throw new ApiError(0, 'Нет связи с сервером. Проверь интернет и попробуй снова.');
  }
  if (res.status === 401) { logout(); return null; }
  if (res.status === 403) {
    const err = await res.json().catch(() => ({}));
    toast('⚠️ ' + (err.error || 'Недостаточно прав'));
    return null;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(res.status, err.error || _defaultMessageForStatus(res.status));
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
    ? 'Это временный пароль — задай свой постоянный (минимум 8 символов).'
    : 'Минимум 8 символов. Новый пароль должен отличаться от текущего и не быть в списке распространённых.';
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
    if (!res.ok) throw new ApiError(res.status, await res.text() || 'Ошибка экспорта');
    const csvText = await res.text();
    // Bail out если в ответе только BOM + строка заголовков (нет данных)
    const dataLines = csvText.split(/\r?\n/).filter(l => l.trim()).length;
    if (dataLines <= 1) {
      toast('⚠️ За этот период нет операций');
      return;
    }
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `coins_${from}_${to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast(`✅ Скачано: ${dataLines - 1} ${rowsWord(dataLines - 1)}`);
  } catch (e) { toastError(e); }
}

// ── Бэкап БД ──────────────────────────────────────────────────────────
async function downloadBackup(btn) {
  if (!confirm('Скачать полный бэкап базы данных?\n\nПроцесс может занять 5-30 секунд.')) return;
  const statusEl = document.getElementById('backup-status');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2"></i> Готовим...';
  if (statusEl) statusEl.textContent = 'Читаем все таблицы из БД...';
  renderIcons();
  try {
    const res = await fetch('/api/backup', {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || 'Ошибка ' + res.status);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    a.href = url;
    a.download = `maria-crew-backup-${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    const sizeMB = (blob.size / 1024 / 1024).toFixed(2);
    if (statusEl) statusEl.textContent = `✅ Скачано: ${sizeMB} МБ. Храни этот файл в надёжном месте.`;
    toast('✅ Бэкап скачан');
  } catch (e) {
    if (statusEl) statusEl.textContent = '❌ ' + (e.message || 'Ошибка');
    toastError(e);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
    renderIcons();
  }
}

async function submitChangePassword() {
  const oldPassword = document.getElementById('cpw-old').value;
  const newPassword = document.getElementById('cpw-new').value;
  if (!oldPassword || !newPassword) { toast('Заполни оба поля'); return; }
  if (newPassword.length < 8) { toast('Минимум 8 символов'); return; }
  if (oldPassword === newPassword) { toast('Новый пароль должен отличаться от старого'); return; }
  try {
    await api('POST', '/auth/change-password', { oldPassword, newPassword });
    state.requirePasswordChange = false;
    document.getElementById('modal-change-password').classList.add('hidden');
    toast('✅ Пароль обновлён');
  } catch (e) { toastError(e); }
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

function updateRequestsBadge(count) {
  const badge = document.getElementById('nav-requests-badge');
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

  // Всегда подтягиваем метаданные (id + role) — id нужен, чтобы заблокировать
  // суперадмину возможность менять СВОЮ же роль (UI-страховка; сервер тоже это
  // не позволит, но кнопка в UI должна сразу быть disabled)
  const meta = await api('GET', '/me/admin').catch(() => null);
  if (meta) {
    if (meta.role) {
      state.role = meta.role;
      sessionStorage.setItem('mc_role', state.role);
    }
    if (meta.id) state.adminUserId = meta.id;
  }
  applyRoleVisibility();

  updatePeriodLabels();
  renderIcons();
  await Promise.all([loadStores(), loadCloudinaryConfig(), loadActiveChallengesForCoins()]);
  switchTab('dashboard');

  // Раз в 2 минуты подтягиваем счётчики ожидающих заявок + unread-запросов
  const refreshBadges = async () => {
    try {
      const [ex, req] = await Promise.all([
        api('GET', '/exchanges?status=pending').catch(() => []),
        api('GET', '/requests/unread-count').catch(() => ({ count: 0 })),
      ]);
      updatePendingBadge(Array.isArray(ex) ? ex.length : 0);
      updateRequestsBadge(req?.count || 0);
    } catch { /* ignore */ }
  };
  refreshBadges();
  if (!state.pendingPoll) {
    state.pendingPoll = setInterval(refreshBadges, 120_000);
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

  // Селектор точки для массового начисления монет
  const bulkStore = document.getElementById('coin-bulk-store');
  if (bulkStore) {
    bulkStore.innerHTML = '<option value="">— выбери точку —</option>'
      + state.stores.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  }

  // Селектор точки для экспорта монет
  const coinsExportStore = document.getElementById('coins-export-store');
  if (coinsExportStore) {
    coinsExportStore.innerHTML = '<option value="">— все точки —</option>'
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
  if (state.currentTab === 'requests')    loadRequests();
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
    tbody.innerHTML = emptyRow(5, 'users', 'Нет сотрудников');
    renderIcons();
    return;
  }

  // Активные вверху, скрытые внизу с пометкой
  const sorted = employees.slice().sort((a, b) => {
    if (a.isActive === b.isActive) return a.name.localeCompare(b.name, 'ru');
    return a.isActive ? -1 : 1;
  });

  tbody.innerHTML = sorted.map(e => {
    const m = metricMap[e.id] || {};
    const nameCell = e.isActive
      ? `<strong>${esc(e.name)}</strong>`
      : `<strong style="color:var(--muted)">${esc(e.name)}</strong> <span class="badge badge-neutral" style="font-size:11px">скрыт</span>`;
    return `<tr data-employee-id="${e.id}">
      <td>${nameCell}</td>
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
  } catch (e) { toastError(e); }
}

async function processMonth() {
  if (!state.storeId) { toast('Выберите точку'); return; }
  if (!await confirmDialog({
    title: `Обработать ${MONTH_NAMES[state.month]} ${state.year}?`,
    message: 'Если ты ставил баллы вручную во вкладке «Рейтинги» — отмени и не запускай автообработку. Карточки за метрики и за лучшего сотрудника можно выдать вручную во вкладке «Карточки».',
    warning: 'Автообработка ПЕРЕЗАПИШЕТ баллы и статус «Лучший сотрудник», выставленные вручную, на значения, рассчитанные по метрикам.',
    confirmText: 'Обработать месяц',
    danger: true,
  })) return;

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
    toast(`✅ Готово! Лучший сотрудник: ${mvp?.name ?? '—'} (${mvp?.mvpScore?.toFixed(2) ?? '—'} б.)`);
    loadMetrics();
  } catch (e) { toastError(e); }
  finally { btn.disabled = false; btn.textContent = '⚡ Обработать месяц (баллы + карточки + уведомления)'; }
}

// ── Монеты ────────────────────────────────────────────────────────────────────
// Подгружаем активные челленджи и подмешиваем их в селекты причины (один и
// массовый). Челлендж попадает в список, если: is_active=true, сегодня внутри
// startDate..endDate, coinReward > 0. Без награды смысла награждать монетами нет.
async function loadActiveChallengesForCoins() {
  // /challenges защищён `denyForCoinAdmin` на бэке — для coin_admin запрос
  // вернул бы 403 и засорил тост-стек на каждом логине. Просто не запрашиваем.
  if (state.role === 'coin_admin') return;
  try {
    const list = await api('GET', '/challenges') || [];
    const today = new Date().toISOString().slice(0, 10);
    state.activeChallenges = list.filter(ch => {
      const start = String(ch.startDate ?? '').slice(0, 10);
      const end   = String(ch.endDate ?? '').slice(0, 10);
      return ch.isActive && (ch.coinReward ?? 0) > 0 && start <= today && end >= today;
    });
    populateReasonSelectsWithChallenges();
  } catch {
    // Не критично — селекты остаются с базовыми причинами
    state.activeChallenges = [];
  }
}

function populateReasonSelectsWithChallenges() {
  const html = state.activeChallenges.length === 0
    ? ''
    : `<optgroup label="Челленджи" data-challenges="1">${
        state.activeChallenges.map(ch =>
          `<option value="challenge:${ch.id}">${esc(ch.name)} (+${ch.coinReward})</option>`
        ).join('')
      }</optgroup>`;
  for (const id of ['coin-reason', 'bulk-coin-reason']) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    // Удаляем предыдущую группу (если перерисовываем)
    const prev = sel.querySelector('optgroup[data-challenges="1"]');
    if (prev) prev.remove();
    if (html) sel.insertAdjacentHTML('beforeend', html);
  }

  // Quick-pick chips на вкладке «Монеты» — один клик задаёт причину
  const quick = document.getElementById('coin-quick-challenges');
  const chipsBox = document.getElementById('coin-quick-challenges-chips');
  if (!quick || !chipsBox) return;
  if (state.activeChallenges.length === 0) {
    quick.classList.add('hidden');
    chipsBox.innerHTML = '';
    return;
  }
  chipsBox.innerHTML = state.activeChallenges.map(ch =>
    `<button type="button" class="challenge-chip" onclick="pickChallengeReason(${ch.id})">
      <i data-lucide="flame"></i>
      <span>${esc(ch.name)}</span>
      <span class="reward">+${ch.coinReward}</span>
    </button>`
  ).join('');
  quick.classList.remove('hidden');
  renderIcons();
}

// Клик по чипу: подставляем причину-челлендж в основной селектор и фокусируем
// поле сотрудника, если ещё не выбрано.
function pickChallengeReason(challengeId) {
  const sel = document.getElementById('coin-reason');
  if (!sel) return;
  sel.value = `challenge:${challengeId}`;
  onCoinReasonChange();
  const empSel = document.getElementById('coin-employee');
  if (empSel && !empSel.value) empSel.focus();
}

// Парсит значение "challenge:42" → { id, ch }. Возвращает null, если это не челлендж.
function parseChallengeReason(reason) {
  if (typeof reason !== 'string' || !reason.startsWith('challenge:')) return null;
  const id = parseInt(reason.slice('challenge:'.length), 10);
  if (!id) return null;
  const ch = state.activeChallenges.find(c => c.id === id);
  return ch ? { id, ch } : null;
}

async function loadCoinEmployees() {
  // Подгружаем челленджи в фоне — пусть лежат в селекте, как только админ откроет dropdown
  loadActiveChallengesForCoins();

  // Список сотрудников: либо точки, либо все. Показываем и скрытых — чтобы видеть
  // их историю и при необходимости начислить/списать. Скрытые помечены «(скрыт)».
  const path = state.storeId ? `/employees?storeId=${state.storeId}` : '/employees';
  const emps = await api('GET', path) || [];
  // Сначала активные, потом скрытые — чтобы свежие пользователи были вверху
  state.employees = (emps || []).slice().sort((a, b) => {
    if (a.isActive === b.isActive) return 0;
    return a.isActive ? -1 : 1;
  });

  document.getElementById('coins-history-tbody').innerHTML =
    '<tr><td colspan="4" class="empty">Выберите сотрудника</td></tr>';
  document.getElementById('coins-balance-display').textContent = '';

  const sel = document.getElementById('coin-employee');
  sel.innerHTML = '<option value="">— выбери —</option>';
  state.employees.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    const base = state.storeId ? e.name : `${e.name} — ${e.storeName ?? ''}`;
    opt.textContent = e.isActive ? base : `${base} (скрыт)`;
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

// Фиксированные суммы пресет-причин — синхронно с COIN_AMOUNTS на бэке.
// Используется только для UI-подсказки в селекте «Количество». Реальная сумма
// при пресет-причине берётся из earn() на бэке, что бы тут ни выбрал пользователь.
const COIN_REASON_AMOUNTS = {
  checklist_day:        1,
  review:               3,
  substitution:         5,
  mentoring:            10,
  idea:                 5,
  training_meeting:     5,
  knowledge_applied:    3,
  plan_100:             2,
  plan_105:             5,
  plan_dishes:          5,
  bad_review:          -5,
  dirty_store:         -5,
  training_resistance: -3,
};

function onCoinReasonChange() {
  const reason = document.getElementById('coin-reason').value;
  const amountInput = document.getElementById('coin-amount');

  // Челлендж — фиксированная награда из challenge.coinReward
  const ch = parseChallengeReason(reason);
  if (ch) {
    amountInput.value = String(ch.ch.coinReward);
    amountInput.disabled = true;
    amountInput.title = `Награда за челлендж «${ch.ch.name}» — ${ch.ch.coinReward}`;
    return;
  }

  // 'drinks' тоже manual-amount: сумму выбирает админ под конкретный случай
  if (reason === 'manual' || reason === 'drinks') {
    amountInput.disabled = false;
    if (reason === 'drinks' && (!amountInput.value || amountInput.value === '0')) {
      amountInput.value = '1';
    }
    amountInput.title = reason === 'drinks' ? 'Укажи сумму для начисления за напитки' : '';
  } else {
    const fixed = COIN_REASON_AMOUNTS[reason];
    if (fixed !== undefined) amountInput.value = String(fixed);
    amountInput.disabled = true;
    amountInput.title = `Сумма для «${COIN_LABELS[reason] ?? reason}» — фиксированная (${fixed > 0 ? '+' : ''}${fixed})`;
  }
}

function onCoinBulkScopeChange() {
  const scope = document.getElementById('coin-bulk-scope').value;
  document.getElementById('coin-bulk-store-wrap').classList.toggle('hidden', scope !== 'store');
}

function onCoinBulkReasonChange() {
  const reason = document.getElementById('coin-bulk-reason').value;
  const amountInput = document.getElementById('coin-bulk-amount');
  if (reason === 'manual' || reason === 'drinks') {
    amountInput.disabled = false;
    if (!amountInput.value || parseInt(amountInput.value, 10) <= 0) amountInput.value = '1';
    amountInput.title = reason === 'drinks' ? 'Сумма за напитки' : 'Произвольная сумма';
  } else {
    const fixed = COIN_REASON_AMOUNTS[reason];
    if (fixed !== undefined) amountInput.value = String(Math.max(1, fixed));
    amountInput.disabled = true;
    amountInput.title = `Сумма для «${COIN_LABELS[reason] ?? reason}» — фиксированная (+${fixed})`;
  }
}

async function awardCoinsBulk() {
  const scope = document.getElementById('coin-bulk-scope').value;
  const storeIdRaw = document.getElementById('coin-bulk-store').value;
  const reason = document.getElementById('coin-bulk-reason').value;
  const amount = parseInt(document.getElementById('coin-bulk-amount').value, 10);
  const note = document.getElementById('coin-bulk-note').value.trim();

  if (scope === 'store' && !storeIdRaw) { toast('Выберите точку'); return; }

  const isManualAmount = reason === 'manual' || reason === 'drinks';
  if (isManualAmount && (!Number.isFinite(amount) || amount <= 0)) {
    toast('Укажите положительное количество'); return;
  }
  const perEmployee = isManualAmount ? amount : COIN_REASON_AMOUNTS[reason];
  if (perEmployee <= 0) { toast('Массово только начисления (плюсовые)'); return; }

  // Собираем список активных сотрудников через существующий /employees?storeId=
  let employeeIds = [];
  try {
    const params = scope === 'store' ? `?storeId=${storeIdRaw}` : '';
    const employees = await api('GET', `/employees${params}`) || [];
    employeeIds = employees.filter(e => e.isActive !== false).map(e => e.id);
  } catch (e) {
    toastError(e); return;
  }

  if (employeeIds.length === 0) {
    toast('Нет активных сотрудников по выбранному фильтру'); return;
  }

  let scopeLabel;
  if (scope === 'store') {
    const store = state.stores.find(s => String(s.id) === String(storeIdRaw));
    scopeLabel = `точке «${store?.name ?? storeIdRaw}»`;
  } else {
    scopeLabel = 'всем активным сотрудникам';
  }

  const ok = await confirmDialog({
    title: 'Массовое начисление',
    message: `Начислить +${perEmployee} монет ${scopeLabel}?\nЗатронет ${employeeIds.length} сотрудников. Итого: ${perEmployee * employeeIds.length} монет.`,
    warning: 'Каждый получит уведомление в Telegram. Откатить можно только вручную по одному.',
    confirmText: `Начислить (${employeeIds.length})`,
  });
  if (!ok) return;

  // Existing endpoint: POST /api/employees/bulk-coins
  const payload = { employeeIds, reason, note: note || undefined };
  if (isManualAmount) payload.amount = amount;

  try {
    const result = await api('POST', '/employees/bulk-coins', payload);
    const total = perEmployee * (result.succeeded ?? 0);
    toast(`✅ Начислено ${result.succeeded}/${result.processed} сотрудникам по +${perEmployee} (всего ${total})`);
    document.getElementById('coin-bulk-note').value = '';
    document.getElementById('coin-bulk-reason').value = 'manual';
    document.getElementById('coin-bulk-amount').value = '1';
    onCoinBulkReasonChange();
  } catch (e) { toastError(e); }
}

async function awardCoins() {
  const employeeId = parseInt(document.getElementById('coin-employee').value);
  const rawReason = document.getElementById('coin-reason').value || 'manual';
  const amount = parseInt(document.getElementById('coin-amount').value, 10);
  const note = document.getElementById('coin-note').value;

  if (!employeeId) { toast('Выберите сотрудника'); return; }

  // Челлендж: реальная транзакция уходит как manual + note 'Челлендж: {name}',
  // сумма берётся из challenge.coinReward. Это позволяет переиспользовать
  // существующий /coins/award и видеть начисление в истории.
  const ch = parseChallengeReason(rawReason);
  let payload;
  let finalAmount;
  if (ch) {
    finalAmount = ch.ch.coinReward;
    // Стабильный паттерн `Челлендж #{id}:` нужен бэку для фильтрации истории
    // и подсчёта статистики (имена челленджей могут совпадать).
    const challengeNote = `Челлендж #${ch.ch.id}: ${ch.ch.name}` + (note ? ` — ${note}` : '');
    payload = { employeeId, reason: 'manual', amount: finalAmount, note: challengeNote };
  } else {
    const isManualAmount = rawReason === 'manual' || rawReason === 'drinks';
    if (isManualAmount && (isNaN(amount) || amount === 0)) {
      toast('Выбери количество'); return;
    }
    payload = { employeeId, reason: rawReason, note: note || undefined };
    if (isManualAmount) payload.amount = amount;
    finalAmount = isManualAmount ? amount : COIN_REASON_AMOUNTS[rawReason];
  }

  try {
    await api('POST', '/coins/award', payload);
    if (ch) {
      toast(`✅ Награда за «${ch.ch.name}»: +${finalAmount}`);
    } else {
      toast(finalAmount < 0 ? '✅ Монеты списаны' : '✅ Монеты начислены');
    }
    document.getElementById('coin-note').value = '';
    document.getElementById('coin-reason').value = 'manual';
    onCoinReasonChange();
    document.getElementById('coin-amount').value = '1';
    loadCoinHistory();
  } catch (e) { toastError(e); }
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
  tbody.innerHTML = data.map(ex => {
    const hasLink = !!ex.prizeExternalProductId;
    // 1С-significant: ✓ если документ создан, ⚠ retry если failed.
    let oneCBadge = '';
    if (ex.externalDocStatus === 'created' || ex.externalDocStatus === 'mock_created') {
      const isMock = ex.externalDocStatus === 'mock_created';
      const tip = `1С документ: ${esc(ex.externalDocId || '')}${isMock ? ' (mock — реальный endpoint ещё не подключён)' : ''}`;
      oneCBadge = `<div style="margin-top:4px;color:var(--green,#22c55e);font-size:11px" title="${tip}">${isMock ? '🧪' : '✓'} 1С: ${esc((ex.externalDocId || '').slice(0, 18))}${(ex.externalDocId || '').length > 18 ? '…' : ''}</div>`;
    } else if (ex.externalDocStatus === 'failed') {
      const tip = `Ошибка 1С: ${esc(ex.externalDocError || 'unknown')}`;
      oneCBadge = `<div style="margin-top:4px;color:var(--danger,#ef4444);font-size:11px" title="${tip}">⚠ 1С не выдал</div>`;
    } else if (ex.status === 'approved' && hasLink) {
      oneCBadge = `<div style="margin-top:4px;color:var(--muted);font-size:11px">⏳ ожидает 1С</div>`;
    }
    // Кнопки. При status=approved + failed добавляем «Повторить отправку в 1С».
    let actions = '';
    if (ex.status === 'pending') {
      actions = `<div class="row-actions">
        <button class="btn btn-success btn-sm" onclick="approveExchange(${ex.id}, ${hasLink ? 'true' : 'false'})"><i data-lucide="check"></i> ${hasLink ? 'Одобрить (→ 1С)' : 'Выдать'}</button>
        <button class="btn btn-danger btn-sm" onclick="updateExchange(${ex.id},'rejected')"><i data-lucide="x"></i> Отклонить</button>
      </div>`;
    } else if (ex.status === 'approved' && ex.externalDocStatus === 'failed') {
      actions = `<div class="row-actions">
        <button class="btn btn-primary btn-sm" onclick="retryExchange1c(${ex.id}, this)"><i data-lucide="refresh-cw"></i> Повторить 1С</button>
        <button class="btn btn-ghost btn-sm" onclick="updateExchange(${ex.id},'fulfilled')" title="Отметить выданным вручную (без записи в 1С)"><i data-lucide="check"></i> Выдано вручную</button>
      </div>`;
    } else if (ex.status === 'approved' && !ex.externalDocStatus) {
      // Approved но без 1С привязки (старая логика) — кнопка для finalize
      actions = `<div class="row-actions">
        <button class="btn btn-success btn-sm" onclick="updateExchange(${ex.id},'fulfilled')"><i data-lucide="check"></i> Подтвердить выдачу</button>
      </div>`;
    } else {
      actions = '<span class="text-muted">—</span>';
    }
    return `<tr>
      <td><strong>${esc(ex.employeeName)}</strong></td>
      <td class="col-hide-sm" style="color:var(--text-2);font-size:13px">${esc(ex.storeName)}</td>
      <td>
        ${esc(ex.prizeName)}
        ${hasLink ? `<div style="color:var(--muted);font-size:11px;margin-top:2px" title="Привязан товар 1С">🛒 ${esc(ex.prizeExternalProductName || ex.prizeExternalProductId)}</div>` : ''}
      </td>
      <td class="col-hide-sm">${ex.cardsSpent}</td>
      <td class="col-hide-xs">${ex.coinsSpent}</td>
      <td class="col-hide-xs" style="color:var(--muted);font-size:12px">${formatDate(ex.createdAt)}</td>
      <td>
        <span class="badge badge-${ex.status}">${statusLabel(ex.status)}</span>
        ${oneCBadge}
      </td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
  renderIcons();
}

// При нажатии «Одобрить» (с 1С) — отправляем status=approved, серверная логика
// сама попытается создать документ в 1С и (если успех) переведёт в fulfilled.
// Для призов без привязки используем прежний путь fulfilled напрямую.
async function approveExchange(id, hasOneCLink) {
  if (hasOneCLink) {
    await _doUpdateExchange(id, 'approved', null);
  } else {
    await _doUpdateExchange(id, 'fulfilled', null);
  }
}

async function retryExchange1c(id, btn) {
  btn.disabled = true; btn.textContent = '⏳';
  try {
    const r = await api('POST', `/exchanges/${id}/retry-1c`, {});
    if (r.externalDocStatus === 'created' || r.externalDocStatus === 'mock_created') {
      toast('✅ Документ создан в 1С');
    } else {
      toast('⚠ 1С снова отказал: ' + (r.externalDocError || 'unknown'));
    }
    loadExchanges();
  } catch (e) {
    toastError(e);
    btn.disabled = false; btn.textContent = '↻';
  }
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
  } catch (e) { toastError(e); }
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
    toastError(e);
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

  // Batch-запрос вместо N+1: одним вызовом получаем сводки по всем сотрудникам
  const path2 = state.storeId ? `/employees/summaries?storeId=${state.storeId}` : '/employees/summaries';
  employeeSummaries = await api('GET', path2).catch(() => ({})) || {};

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
      <td class="col-hide-sm">${renderEmployeeAvatar(e)}</td>
      <td><strong style="cursor:pointer;color:var(--pink)" onclick="showEmployeeModal(${e.id})">${esc(e.name)}</strong></td>
      <td class="col-hide-md" style="color:var(--muted);font-size:12px">${tgInfo}</td>
      <td>${renderStoreSelect(e.id, e.storeId)}</td>
      <td class="col-hide-sm">${renderRoleSelect(e.id, e.role)}</td>
      <td class="col-hide-md">${cards}</td>
      <td class="col-hide-sm">${coins}</td>
      <td class="col-hide-md">${heroes}</td>
      <td class="col-hide-sm" style="font-size:12px">${lastSeenLabel(e.lastSeenAt)}</td>
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
  const reason = selectEl.value;
  const amountInput = document.getElementById('bulk-coin-amount');
  const ch = parseChallengeReason(reason);
  if (ch) {
    // Челлендж — показываем поле суммы как readonly с зафиксированной наградой
    amountInput.value = String(ch.ch.coinReward);
    amountInput.style.display = 'inline-block';
    amountInput.readOnly = true;
    amountInput.title = `Награда за «${ch.ch.name}» — ${ch.ch.coinReward}`;
    return;
  }
  amountInput.readOnly = false;
  amountInput.title = '';
  const isManual = reason === 'manual' || reason === 'drinks';
  amountInput.style.display = isManual ? 'inline-block' : 'none';
  if (reason === 'drinks' && (!amountInput.value || amountInput.value === '0')) {
    amountInput.value = '1';
  }
}

const DEDUCTION_REASONS = new Set(['bad_review', 'dirty_store', 'training_resistance']);

async function bulkAwardCoins() {
  if (selectedEmployeeIds.size === 0) return;
  const rawReason = document.getElementById('bulk-coin-reason').value;
  if (!rawReason) { toast('Выбери причину'); return; }

  const ids = [...selectedEmployeeIds];
  const ch = parseChallengeReason(rawReason);

  let payload;
  let label, isDeduction;
  if (ch) {
    payload = {
      employeeIds: ids,
      reason: 'manual',
      amount: ch.ch.coinReward,
      note: `Челлендж #${ch.ch.id}: ${ch.ch.name}`,
    };
    label = `Челлендж: ${ch.ch.name} (+${ch.ch.coinReward})`;
    isDeduction = false;
  } else {
    const isManual = rawReason === 'manual' || rawReason === 'drinks';
    const amount = isManual ? parseInt(document.getElementById('bulk-coin-amount').value) : undefined;
    if (isManual && (isNaN(amount) || amount === 0)) { toast('Укажи сумму (можно отрицательную)'); return; }
    payload = { employeeIds: ids, reason: rawReason, amount };
    label = COIN_LABELS[rawReason] || rawReason;
    isDeduction = DEDUCTION_REASONS.has(rawReason) || (isManual && amount < 0);
  }

  const verb = isDeduction ? 'Списать монеты' : 'Начислить монеты';
  if (!await confirmDialog({
    title: `${verb}?`,
    message: `Причина: ${label}\nКоличество сотрудников: ${ids.length}`,
    confirmText: verb,
    danger: isDeduction,
  })) return;

  try {
    const result = await api('POST', '/employees/bulk-coins', payload);
    const action = isDeduction ? 'Списано' : 'Начислено';
    toast(`✅ ${action} ${result.succeeded} из ${result.processed}`);
    clearEmpSelection();
    loadEmployees();
  } catch (e) { toastError(e); }
}

async function bulkSetActive(isActive) {
  if (selectedEmployeeIds.size === 0) return;
  const ids = [...selectedEmployeeIds];
  const verb = isActive ? 'Активировать' : 'Деактивировать';
  if (!await confirmDialog({
    title: `${verb} сотрудников?`,
    message: `Будет затронуто: ${ids.length}`,
    warning: isActive ? '' : 'Деактивированные сотрудники перестанут получать монеты, карточки и уведомления.',
    confirmText: verb,
    danger: !isActive,
  })) return;
  try {
    await api('POST', '/employees/bulk-active', { employeeIds: ids, isActive });
    toast(`✅ ${isActive ? 'Активированы' : 'Деактивированы'}: ${ids.length}`);
    clearEmpSelection();
    loadEmployees();
  } catch (e) { toastError(e); }
}

async function changeEmployeeStore(id, selectEl) {
  const newStoreId = parseInt(selectEl.value, 10);
  const oldStoreId = parseInt(selectEl.dataset.current, 10);
  if (!newStoreId || newStoreId === oldStoreId) return;
  const newStoreName = state.stores.find(s => s.id === newStoreId)?.name || 'другую точку';
  if (!await confirmDialog({
    title: 'Перевести сотрудника?',
    message: `Новая точка: «${newStoreName}»`,
    confirmText: 'Перевести',
  })) {
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
    toastError(e);
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
  } catch (e) { toastError(e); }
}

async function toggleEmployee(id, isActive) {
  if (!isActive && !await confirmDialog({
    title: 'Скрыть сотрудника?',
    warning: 'Он перестанет получать монеты, карточки и уведомления.',
    confirmText: 'Скрыть',
    danger: true,
  })) return;
  try {
    await api('PUT', `/employees/${id}`, { isActive });
    loadEmployees();
  } catch (e) { toastError(e); }
}

// ── Рейтинги ─────────────────────────────────────────────────────────────────
async function loadLeaderboard() {
  document.getElementById('lb-period-label').textContent = `${MONTH_NAMES[state.month]} ${state.year}`;

  // Если точка выбрана — фильтруем; иначе показываем сотрудников всех точек
  const empUrl = state.storeId
    ? `/leaderboard/employees?storeId=${state.storeId}&year=${state.year}&month=${state.month}`
    : `/leaderboard/employees?year=${state.year}&month=${state.month}`;

  const [empData, storeData] = await Promise.all([
    api('GET', empUrl),
    api('GET', `/leaderboard/stores?year=${state.year}&month=${state.month}`),
  ]);

  const RANK = ['🥇','🥈','🥉'];
  const empTbody = document.getElementById('lb-employees-tbody');
  // Колонка «Точка» показывается только когда выбраны все точки
  const showStoreCol = !state.storeId;
  const colCount = showStoreCol ? 6 : 5;

  // Обновляем шапку таблицы (5 ↔ 6 колонок)
  const empThead = document.querySelector('#tab-leaderboard table thead tr');
  if (empThead) {
    empThead.innerHTML = showStoreCol
      ? `<th>#</th><th>Имя</th><th class="col-hide-sm">Точка</th><th style="width:90px">Баллы</th><th class="col-hide-sm" style="width:60px">Карт.</th><th style="width:130px">Действие</th>`
      : `<th>#</th><th>Имя</th><th style="width:90px">Баллы</th><th class="col-hide-sm" style="width:60px">Карт.</th><th style="width:130px">Действие</th>`;
  }

  if (!empData || empData.length === 0) {
    empTbody.innerHTML = emptyRow(colCount, 'trophy', 'Нет данных за этот период');
  } else {
    // Нумерация рангом 🥇🥈🥉 — только когда выбрана конкретная точка.
    // Когда показываем все точки скопом — рангу неоткуда взяться (он пер-точка), просто #.
    empTbody.innerHTML = empData.map((e, i) => {
      const score = e.mvpScore !== null ? Number(e.mvpScore).toFixed(2) : '';
      const isHidden = e.isActive === false;
      const nameStyle = isHidden ? ' style="color:var(--muted)"' : '';
      const hiddenBadge = isHidden ? ' <span class="badge badge-neutral" style="font-size:11px">скрыт</span>' : '';
      const rankCell = showStoreCol ? (i+1) : (RANK[i] ?? i+1);
      const storeCell = showStoreCol
        ? `<td class="col-hide-sm" style="font-size:13px;color:var(--text-2)">${esc(e.storeName ?? '—')}</td>`
        : '';
      const sid = e.storeId ?? 'null';
      return `<tr>
        <td><strong>${rankCell}</strong></td>
        <td><strong${nameStyle}>${esc(e.name)}</strong>${e.isMvp ? ' <span class="badge badge-mvp"><i data-lucide="star"></i> Лучший</span>' : ''}${hiddenBadge}</td>
        ${storeCell}
        <td><input type="number" step="0.01" min="0" max="200" class="lb-score-input"
            value="${score}" data-emp-id="${e.employeeId}"
            onchange="saveEmployeeScore(${e.employeeId}, ${sid}, this)"></td>
        <td class="col-hide-sm">${e.cardsCount}</td>
        <td>
          ${e.isMvp
            ? `<button class="btn btn-ghost btn-sm" onclick="unsetEmployeeMvp(${e.employeeId}, ${sid})" title="Снять статус"><i data-lucide="x"></i> Снять</button>`
            : `<button class="btn btn-ghost btn-sm" onclick="setEmployeeMvp(${e.employeeId}, ${sid})"><i data-lucide="star"></i> Сделать лучшим</button>`}
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
        <td><strong>${esc(s.storeName)}</strong>${s.isTop ? ' <span class="badge badge-mvp"><i data-lucide="crown"></i> Лучшая</span>' : ''}</td>
        <td><input type="number" step="0.1" min="0" max="200" class="lb-score-input"
            value="${score}" onchange="saveStoreScore(${s.storeId}, this)"></td>
        <td>
          ${s.isTop
            ? `<button class="btn btn-ghost btn-sm" onclick="unsetStoreTop(${s.storeId})" title="Снять статус"><i data-lucide="x"></i> Снять</button>`
            : `<button class="btn btn-ghost btn-sm" onclick="setStoreTop(${s.storeId})"><i data-lucide="crown"></i> Сделать лучшей</button>`}
        </td>
      </tr>`;
    }).join('');
  }
  renderIcons();
}

async function saveEmployeeScore(employeeId, storeId, inputEl) {
  if (!storeId) { toast('У сотрудника не задана точка — нельзя сохранить балл'); return; }
  const v = inputEl.value.trim();
  const mvpScore = v === '' ? null : parseFloat(v);
  inputEl.disabled = true;
  try {
    await api('PUT', `/leaderboard/employees/${employeeId}`, {
      year: state.year, month: state.month, storeId, mvpScore,
    });
    toast('✅ Балл сохранён');
  } catch (e) { toastError(e); }
  finally { inputEl.disabled = false; }
}

async function setEmployeeMvp(employeeId, storeId) {
  if (!storeId) { toast('У сотрудника не задана точка'); return; }
  if (!await confirmDialog({
    title: 'Назначить лучшего сотрудника?',
    message: 'С остальных в этой точке статус «Лучший» будет снят.',
    confirmText: 'Назначить',
  })) return;
  try {
    await api('PUT', `/leaderboard/employees/${employeeId}`, {
      year: state.year, month: state.month, storeId, isMvp: true,
    });
    toast('✅ Лучший сотрудник назначен');
    loadLeaderboard();
  } catch (e) { toastError(e); }
}

async function unsetEmployeeMvp(employeeId, storeId) {
  if (!storeId) { toast('У сотрудника не задана точка'); return; }
  if (!await confirmDialog({
    title: 'Снять статус «Лучший сотрудник»?',
    message: 'За этот месяц.',
    warning: 'Уже начисленные монеты и выданная особая карточка НЕ возвращаются — при необходимости откати их вручную.',
    confirmText: 'Снять',
    danger: true,
  })) return;
  try {
    await api('PUT', `/leaderboard/employees/${employeeId}`, {
      year: state.year, month: state.month, storeId, isMvp: false,
    });
    toast('✅ Статус снят');
    loadLeaderboard();
  } catch (e) { toastError(e); }
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
  } catch (e) { toastError(e); }
  finally { inputEl.disabled = false; }
}

async function setStoreTop(storeId) {
  if (!await confirmDialog({
    title: 'Назначить точку лучшей?',
    message: 'Команда получит бонусную карточку. С остальных точек статус «Лучшая» будет снят.',
    confirmText: 'Назначить',
  })) return;
  try {
    await api('PUT', `/leaderboard/stores/${storeId}`, {
      year: state.year, month: state.month, isTop: true,
    });
    toast('✅ Лучшая точка обновлена');
    loadLeaderboard();
  } catch (e) { toastError(e); }
}

async function unsetStoreTop(storeId) {
  if (!await confirmDialog({
    title: 'Снять статус «Лучшая точка»?',
    message: 'За этот месяц.',
    warning: 'Уже начисленные команде +30 монет и карточки team_bonus НЕ возвращаются — при необходимости откати их вручную.',
    confirmText: 'Снять',
    danger: true,
  })) return;
  try {
    await api('PUT', `/leaderboard/stores/${storeId}`, {
      year: state.year, month: state.month, isTop: false,
    });
    toast('✅ Статус снят');
    loadLeaderboard();
  } catch (e) { toastError(e); }
}

// ── Утилиты ───────────────────────────────────────────────────────────────────
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

// Унифицированный показ ошибок: 4xx — это «ты что-то ввёл не так» (⚠️),
// 5xx или нет связи — «у нас проблема» (❌).
function toastError(e) {
  const msg = (e && e.message) || 'Что-то пошло не так';
  const isUserError = e && e.status >= 400 && e.status < 500;
  toast((isUserError ? '⚠️ ' : '❌ ') + msg);
}

// ── Универсальный confirm-диалог ─────────────────────────────────────────────
// Возвращает Promise<boolean>. Заменяет нативный confirm(), который на мобиле
// обрезает текст и не различает деструктивные действия.
//
// Использование:
//   if (!await confirmDialog({ title: 'Удалить?', message: 'Восстановить нельзя.', danger: true, confirmText: 'Удалить' })) return;
//
// Поддерживает:
//   - title, message (строка; `\n\n` разделяет абзацы)
//   - warning (отдельная строка с иконкой ⚠️)
//   - danger (true → красная кнопка подтверждения)
//   - confirmText, cancelText
let _confirmResolver = null;
function confirmDialog({ title = 'Подтверждение', message = '', warning = '', danger = false, confirmText = 'Подтвердить', cancelText = 'Отмена' } = {}) {
  return new Promise((resolve) => {
    _confirmResolver = resolve;
    document.getElementById('confirm-title').textContent = title;

    const msgEl = document.getElementById('confirm-message');
    msgEl.innerHTML = '';
    String(message).split(/\n+/).filter(s => s.trim()).forEach(para => {
      const p = document.createElement('p');
      p.textContent = para;
      msgEl.appendChild(p);
    });

    const warnEl = document.getElementById('confirm-warning');
    if (warning) {
      document.getElementById('confirm-warning-text').textContent = warning;
      warnEl.classList.remove('hidden');
    } else {
      warnEl.classList.add('hidden');
    }

    const okBtn = document.getElementById('confirm-ok');
    okBtn.textContent = confirmText;
    okBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');

    document.getElementById('confirm-cancel').textContent = cancelText;

    document.addEventListener('keydown', _confirmKey);
    document.getElementById('modal-confirm').classList.remove('hidden');
    renderIcons();
    setTimeout(() => okBtn.focus(), 0);
  });
}
function _confirmOk()     { _confirmFinish(true); }
function _confirmCancel() { _confirmFinish(false); }
function _confirmFinish(value) {
  document.getElementById('modal-confirm').classList.add('hidden');
  document.removeEventListener('keydown', _confirmKey);
  const r = _confirmResolver; _confirmResolver = null;
  if (r) r(value);
}
function _confirmKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); _confirmCancel(); }
  else if (e.key === 'Enter') { e.preventDefault(); _confirmOk(); }
}

// Экранируем не только < > &, но и кавычки + апостроф — функция используется
// и в текстовом контенте, и в атрибутах (value, placeholder, title, alt).
// Без экранирования кавычки имя «Анна "X"» сломало бы атрибут.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  } catch (e) { toastError(e); }
}

async function toggleQuestion(id, isActive) {
  try {
    await api('PUT', `/quiz/${id}`, { isActive });
    loadQuizQuestions();
  } catch (e) { toastError(e); }
}

async function deleteQuestion(id) {
  if (!await confirmDialog({
    title: 'Удалить вопрос?',
    warning: 'Действие нельзя отменить.',
    confirmText: 'Удалить',
    danger: true,
  })) return;
  try {
    await api('DELETE', `/quiz/${id}`);
    toast('Вопрос удалён');
    loadQuizQuestions();
  } catch (e) { toastError(e); }
}

// ── CSV-импорт квиза ─────────────────────────────────────────────────────
function showImportQuiz() {
  const form = document.getElementById('import-quiz-form');
  form.classList.toggle('hidden');
  document.getElementById('quiz-import-result').innerHTML = '';
  document.getElementById('quiz-import-file').value = '';
  renderIcons();
}

function downloadQuizCsvTemplate() {
  // Скачиваем шаблон с парой примеров. BOM в начале — чтобы Excel сразу распознал UTF-8.
  const lines = [
    'question,option_a,option_b,option_c,option_d,correct,category',
    'Какой главный ингредиент торта «Прага»?,Шоколад,Ваниль,Карамель,Кофе,А,product',
    '"Сколько граммов в стандартной порции муссового торта?",100,150,180,250,Б,product',
    'Что делать если гость недоволен?,Молча отдать сдачу,Выслушать и решить,Позвать менеджера,Дать скидку всегда,Б,service',
  ];
  const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'quiz_template.csv'; a.click();
  URL.revokeObjectURL(url);
}

async function importQuizCsv() {
  const fileInput = document.getElementById('quiz-import-file');
  const resultEl  = document.getElementById('quiz-import-result');
  const file = fileInput.files?.[0];
  if (!file) { toast('Выбери CSV-файл'); return; }
  if (file.size > 2 * 1024 * 1024) { toast('Файл больше 2 МБ'); return; }

  resultEl.innerHTML = '<span style="color:var(--muted)">Загрузка...</span>';
  let csv;
  try {
    csv = await file.text();
  } catch (e) {
    resultEl.innerHTML = `<span style="color:var(--red)">Не удалось прочитать файл: ${esc(e.message)}</span>`;
    return;
  }

  try {
    const res = await api('POST', '/quiz/import', { csv });
    const errs = res.errors || [];
    const lines = [];
    if (res.added > 0) {
      lines.push(`<div style="color:var(--green);font-weight:600">✅ Добавлено: ${res.added} из ${res.total}</div>`);
    } else {
      lines.push(`<div style="color:var(--red);font-weight:600">❌ Не добавлено ничего из ${res.total}</div>`);
    }
    if (errs.length > 0) {
      const items = errs.slice(0, 50).map(e =>
        `<li>Строка ${e.line}: ${esc(e.message)}</li>`
      ).join('');
      const more = errs.length > 50 ? `<li>… и ещё ${errs.length - 50}</li>` : '';
      lines.push(`<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--text-2)">Ошибок: ${errs.length}</summary><ul style="margin:6px 0 0 18px;padding:0;color:var(--text-2)">${items}${more}</ul></details>`);
    }
    resultEl.innerHTML = lines.join('');
    if (res.added > 0) {
      toast(`✅ Добавлено: ${res.added}`);
      loadQuizQuestions();
    }
  } catch (e) {
    resultEl.innerHTML = `<span style="color:var(--red)">❌ ${esc(e.message)}</span>`;
  }
}

// ── Карточки ─────────────────────────────────────────────────────────────────
const CARD_SOURCE_LABELS = {
  mystery_shopper: 'Тайный покупатель',
  review:          'Именной отзыв',
  checklist:       'Чек-лист 100%',
  plan:            'Выполнение плана',
  mvp:             'Лучший сотрудник месяца',
  team_bonus:      'Бонус лучшей точки',
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
  // Показываем всех — активных и скрытых. Скрытые помечаем «(скрыт)».
  state.employees = (emps || []).slice().sort((a, b) => {
    if (a.isActive === b.isActive) return 0;
    return a.isActive ? -1 : 1;
  });

  const sel = document.getElementById('card-employee');
  sel.innerHTML = '<option value="">— выбери —</option>';
  state.employees.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    const base = state.storeId ? e.name : `${e.name} — ${e.storeName ?? ''}`;
    opt.textContent = e.isActive ? base : `${base} (скрыт)`;
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
        <div class="label">Лучших</div>
        <div class="value">${totalMvp}</div>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Герой</th><th>Источник</th><th>Период</th><th>Лучший</th><th>Статус</th><th>Действия</th>
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
  } catch (e) { toastError(e); }
}

async function revokeCard(id) {
  if (!await confirmDialog({
    title: 'Удалить карточку?',
    warning: 'Действие нельзя отменить.',
    confirmText: 'Удалить',
    danger: true,
  })) return;
  try {
    await api('DELETE', `/cards/${id}`);
    toast('Карточка удалена');
    loadEmployeeCards();
  } catch (e) { toastError(e); }
}

async function toggleCardSpent(id, isSpent) {
  try {
    await api('PATCH', `/cards/${id}/spent`, { isSpent });
    loadEmployeeCards();
  } catch (e) { toastError(e); }
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
  } catch (e) { toastError(e); }
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
  } catch (e) { toastError(e); }
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
  } catch (e) { toastError(e); }
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

let prizesCache = [];

async function loadPrizes() {
  const tbody = document.getElementById('prizes-tbody');
  tbody.innerHTML = skeletonRows(8, 5);
  prizesCache = await api('GET', '/prizes') || [];
  renderPrizes();
  loadCatalogStatus();
}

// ── 1С каталог: статус-бар + ручной refresh + autocomplete ─────────────────

async function loadCatalogStatus() {
  try {
    const s = await api('GET', '/catalog/status');
    const countEl = document.getElementById('catalog-row-count');
    const lastEl = document.getElementById('catalog-last-refresh');
    const errEl  = document.getElementById('catalog-error-badge');
    const errTxt = document.getElementById('catalog-error-text');
    if (!countEl) return;
    countEl.textContent = `${(s.rowCount || 0).toLocaleString('ru-RU')} товаров`;
    if (s.lastRefreshAt) {
      const d = new Date(s.lastRefreshAt);
      lastEl.textContent = d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
    } else {
      lastEl.textContent = 'никогда';
    }
    if (s.lastRefreshError) {
      errEl.classList.remove('hidden');
      errTxt.textContent = s.lastRefreshError.slice(0, 80);
    } else {
      errEl.classList.add('hidden');
    }
    if (!s.proxyConfigured) {
      lastEl.textContent += ' (прокси не настроен)';
    }
  } catch (e) { /* не критично — оставим «…» */ }
}

async function refreshCatalog() {
  const btn = document.getElementById('catalog-refresh-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader"></i> Загружаю...';
  renderIcons();
  try {
    const r = await api('POST', '/catalog/refresh');
    if (r.ok) {
      toast(`✅ Каталог обновлён: ${(r.total || 0).toLocaleString('ru-RU')} товаров`);
    } else {
      toast('⚠ ' + (r.reason || 'не удалось обновить'));
    }
  } catch (e) {
    toastError(e);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="refresh-cw"></i> Обновить из 1С';
    renderIcons();
    loadCatalogStatus();
  }
}

const MAX_PRIZE_ITEMS = 5;

// Рендерит список items {productId, name, qty} в контейнер. Каждая строка —
// inputs кода/qty/имени + кнопка удалить. Внизу кнопка «+ Добавить товар».
function renderItemsList(wrap, items) {
  wrap.innerHTML = '';
  wrap.classList.add('ext-items-list');
  const arr = (items && items.length) ? items.slice(0, MAX_PRIZE_ITEMS) : [{ productId: '', name: '', qty: 1 }];
  arr.forEach((it) => wrap.appendChild(makePrizeItemRow(it)));
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ext-add-btn';
  addBtn.textContent = '+ Добавить товар';
  addBtn.title = `Добавить ещё одну позицию (максимум ${MAX_PRIZE_ITEMS})`;
  addBtn.onclick = () => {
    const count = wrap.querySelectorAll('.ext-item').length;
    if (count >= MAX_PRIZE_ITEMS) { toast(`Максимум ${MAX_PRIZE_ITEMS} товаров на приз`); return; }
    const row = makePrizeItemRow({ productId: '', name: '', qty: 1 });
    wrap.insertBefore(row, addBtn);
    row.querySelector('.ext-code')?.focus();
  };
  wrap.appendChild(addBtn);
}

function makePrizeItemRow(item) {
  const row = document.createElement('div');
  row.className = 'ext-item';
  row.innerHTML = `
    <div class="ext-item-row">
      <input type="text" class="ext-code" value="${esc(item.productId || '')}" placeholder="код 1С" style="flex:1;font-size:11px">
      <input type="number" class="ext-qty" min="1" value="${item.qty || 1}" style="width:42px;font-size:11px;text-align:right" title="Количество">
      <button type="button" class="ext-remove" title="Удалить позицию">×</button>
    </div>
    <input type="text" class="ext-name" value="${esc(item.name || '')}" placeholder="название (опц.)" style="width:100%;font-size:11px;margin-top:3px">
  `;
  const codeEl = row.querySelector('.ext-code');
  const nameEl = row.querySelector('.ext-name');
  attachCatalogAutocomplete(codeEl, nameEl);
  row.querySelector('.ext-remove').onclick = () => {
    // Не даём удалить последнюю позицию — в add-form всегда должна быть хотя
    // бы одна (пустая считается «без привязки» при сохранении).
    const wrap = row.parentElement;
    if (wrap && wrap.querySelectorAll('.ext-item').length <= 1) {
      codeEl.value = '';
      nameEl.value = '';
      row.querySelector('.ext-qty').value = 1;
      return;
    }
    row.remove();
  };
  return row;
}

function collectPrizeItems(wrap) {
  if (!wrap) return [];
  return Array.from(wrap.querySelectorAll('.ext-item')).map(row => ({
    productId: (row.querySelector('.ext-code')?.value || '').trim(),
    name: (row.querySelector('.ext-name')?.value || '').trim() || null,
    qty: parseInt(row.querySelector('.ext-qty')?.value, 10) || 1,
  })).filter(it => it.productId);
}

// Привязывает autocomplete к паре input'ов «код 1С» и «название».
// При выборе элемента — оба поля заполняются автоматически. dispatchEvent
// нужен чтобы inline-редактор приза среагировал на изменение (если есть слушатели).
function attachCatalogAutocomplete(codeInput, nameInput) {
  if (!codeInput || codeInput.dataset.acAttached === '1') return;
  codeInput.dataset.acAttached = '1';

  // Оборачиваем input в .ac-wrap чтобы absolute-dropdown позиционировался относительно input'а.
  const wrap = document.createElement('div');
  wrap.className = 'ac-wrap';
  wrap.style.cssText = codeInput.style.cssText || '';
  codeInput.parentNode.insertBefore(wrap, codeInput);
  // Сохраняем оригинальный flex/width input'а.
  const origFlex = codeInput.style.flex;
  wrap.appendChild(codeInput);
  if (origFlex) wrap.style.flex = origFlex;
  codeInput.style.width = '100%';

  const dropdown = document.createElement('div');
  dropdown.className = 'ac-dropdown hidden';
  wrap.appendChild(dropdown);

  let timer = null;
  let activeIdx = -1;
  let items = [];

  const search = async (q) => {
    if (!q || q.length < 2) { hide(); return; }
    try {
      const r = await api('GET', `/catalog/search?q=${encodeURIComponent(q)}&limit=15`);
      items = (r && r.items) || [];
      activeIdx = -1;
      if (!items.length) {
        dropdown.innerHTML = '<div class="ac-empty">Ничего не найдено. Возможно, нужно обновить каталог.</div>';
        dropdown.classList.remove('hidden');
        return;
      }
      dropdown.innerHTML = items.map((it, i) => `
        <div class="ac-item" data-idx="${i}">
          <div><span class="code">${esc(it.code.trim())}</span></div>
          <div class="name">${esc(it.name || '')}</div>
          <div class="meta">${esc(it.groupName || '')}${it.unit ? ' · ' + esc(it.unit) : ''}</div>
        </div>
      `).join('');
      dropdown.classList.remove('hidden');
    } catch (e) { /* silent — пользователь сможет ввести руками */ }
  };

  const choose = (idx) => {
    const it = items[idx];
    if (!it) return;
    codeInput.value = it.code.trim();
    if (nameInput) nameInput.value = it.name || '';
    // Триггерим change чтобы любой external listener увидел изменение
    codeInput.dispatchEvent(new Event('change', { bubbles: true }));
    if (nameInput) nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    hide();
  };

  const hide = () => {
    dropdown.classList.add('hidden');
    activeIdx = -1;
  };

  codeInput.addEventListener('input', () => {
    clearTimeout(timer);
    const q = codeInput.value.trim();
    timer = setTimeout(() => search(q), 250);
  });

  codeInput.addEventListener('focus', () => {
    const q = codeInput.value.trim();
    if (q.length >= 2) search(q);
  });

  codeInput.addEventListener('keydown', (e) => {
    if (dropdown.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      updateActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      updateActive();
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      choose(activeIdx);
    } else if (e.key === 'Escape') {
      hide();
    }
  });

  function updateActive() {
    dropdown.querySelectorAll('.ac-item').forEach((el, i) => {
      el.classList.toggle('active', i === activeIdx);
      if (i === activeIdx) el.scrollIntoView({ block: 'nearest' });
    });
  }

  dropdown.addEventListener('mousedown', (e) => {
    // mousedown срабатывает ДО blur, чтобы клик успел отработать
    const item = e.target.closest('.ac-item');
    if (item) {
      e.preventDefault();
      choose(parseInt(item.dataset.idx, 10));
    }
  });

  codeInput.addEventListener('blur', () => {
    // Откладываем чтобы успел отработать mousedown по dropdown
    setTimeout(hide, 150);
  });
}

function renderPrizes() {
  const tbody = document.getElementById('prizes-tbody');
  const search = (document.getElementById('prizes-search')?.value ?? '').trim().toLowerCase();
  const list = !search ? prizesCache : prizesCache.filter(p =>
    (p.name || '').toLowerCase().includes(search) ||
    (p.description || '').toLowerCase().includes(search) ||
    (PRIZE_TYPE_LABELS[p.prizeType] || '').toLowerCase().includes(search)
  );
  if (prizesCache.length === 0) {
    tbody.innerHTML = emptyRow(9, 'gift', 'Призов нет — добавьте первый');
    renderIcons();
    return;
  }
  if (list.length === 0) {
    tbody.innerHTML = emptyRow(9, 'search-x', 'Ничего не найдено');
    renderIcons();
    return;
  }
  tbody.innerHTML = list.map(p => `<tr data-prize-id="${p.id}">
    <td style="color:var(--muted);font-size:12px">${p.id}</td>
    <td><input type="text" class="prize-name-in" value="${esc(p.name)}" style="width:100%"></td>
    <td class="col-hide-sm">
      <select class="prize-type-in" style="width:100%">
        ${Object.entries(PRIZE_TYPE_LABELS).map(([v, l]) =>
          `<option value="${v}"${v === p.prizeType ? ' selected' : ''}>${l}</option>`
        ).join('')}
      </select>
    </td>
    <td><input type="number" class="prize-cards-in" min="0" value="${p.cardsRequired}" style="width:80px;text-align:right"></td>
    <td><input type="number" class="prize-coins-in" min="0" value="${p.coinsRequired}" style="width:80px;text-align:right"></td>
    <td class="col-hide-md"><input type="number" class="prize-order-in" value="${p.sortOrder}" style="width:70px;text-align:right"></td>
    <td class="col-hide-md">
      <div class="prize-items-list" data-prize-id="${p.id}"></div>
    </td>
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
  // Рендерим список items в каждую строку (берём из prizesCache по id)
  tbody.querySelectorAll('.prize-items-list[data-prize-id]').forEach(wrap => {
    const id = parseInt(wrap.dataset.prizeId, 10);
    const prize = prizesCache.find(p => p.id === id);
    const items = (prize && Array.isArray(prize.externalItems)) ? prize.externalItems : [];
    // Если items пуст но external_product_id есть (миграция не накатилась
    // или backfill пропустил) — fallback на старые поля как single-item.
    const initial = items.length > 0
      ? items
      : (prize && prize.externalProductId
          ? [{ productId: prize.externalProductId, name: prize.externalProductName, qty: prize.externalQty || 1 }]
          : []);
    renderItemsList(wrap, initial);
  });
}

function showAddPrize() {
  const form = document.getElementById('add-prize-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) {
    // Рендерим один пустой item с подключённым autocomplete
    const wrap = document.getElementById('new-prize-items-list');
    if (wrap && !wrap.querySelector('.ext-item')) {
      renderItemsList(wrap, []);
    }
  }
}

async function addPrize() {
  const name        = document.getElementById('new-prize-name').value.trim();
  const prizeType   = document.getElementById('new-prize-type').value;
  const cardsRequired = parseInt(document.getElementById('new-prize-cards').value) || 0;
  const coinsRequired = parseInt(document.getElementById('new-prize-coins').value) || 0;
  const sortOrder   = parseInt(document.getElementById('new-prize-order').value) || 100;
  const description = document.getElementById('new-prize-desc').value.trim();
  const externalItems = collectPrizeItems(document.getElementById('new-prize-items-list'));
  if (!name) { toast('Введите название'); return; }
  if (cardsRequired === 0 && coinsRequired === 0) { toast('Укажи стоимость в карточках или монетах'); return; }
  try {
    await api('POST', '/prizes', {
      name, prizeType, cardsRequired, coinsRequired, sortOrder,
      description: description || undefined,
      externalItems,
    });
    toast('✅ Приз добавлен');
    document.getElementById('add-prize-form').classList.add('hidden');
    ['new-prize-name','new-prize-cards','new-prize-coins','new-prize-desc'].forEach(id => {
      document.getElementById(id).value = id === 'new-prize-cards' || id === 'new-prize-coins' ? '0' : '';
    });
    // Сбрасываем items-форму
    const wrap = document.getElementById('new-prize-items-list');
    if (wrap) renderItemsList(wrap, []);
    loadPrizes();
  } catch (e) { toastError(e); }
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
    externalItems: collectPrizeItems(row.querySelector('.prize-items-list')),
  };
  if (!body.name) { toast('Название не пустое'); return; }
  btn.disabled = true; btn.textContent = '⏳';
  try {
    await api('PUT', `/prizes/${id}`, body);
    toast('✅ Сохранено');
  } catch (e) { toastError(e); }
  finally { btn.disabled = false; btn.textContent = '💾'; }
}

async function deletePrize(id) {
  if (!await confirmDialog({
    title: 'Удалить приз?',
    message: 'Если на приз были заявки, удалить не получится — используй переключатель «Скрыть».',
    confirmText: 'Удалить',
    danger: true,
  })) return;
  try {
    await api('DELETE', `/prizes/${id}`);
    toast('Приз удалён');
    loadPrizes();
  } catch (e) { toastError(e); }
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
  rating_mvp_set:           '🏆 Лучший сотрудник назначен',
  rating_top_set:           '🏆 Лучшая точка',
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
  hero_create:              '🎨 Герой создан',
  hero_update:              '🎨 Герой обновлён',
  hero_delete:              '🎨 Герой удалён',
  challenge_create:         '🌸 Челлендж создан',
  challenge_update:         '🌸 Челлендж изменён',
  challenge_delete:         '🌸 Челлендж удалён',
  challenge_award:          '🌸 Карточка за челлендж выдана',
  broadcast:                '📢 Рассылка',
  admin_user_create:        '🛡 Админ создан',
  admin_user_update:        '🛡 Админ изменён',
  admin_user_delete:        '🛡 Админ удалён',
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
  tbody.innerHTML = skeletonRows(11, 4);
  const list = await api('GET', '/challenges') || [];
  if (list.length === 0) {
    tbody.innerHTML = emptyRow(11, 'flame', 'Нет челленджей — создайте первый');
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

    const coinReward = ch.coinReward ?? 0;
    const coinsCell = coinReward > 0
      ? `<strong style="color:var(--pink)">+${coinReward}</strong>`
      : '<span style="color:var(--muted)">—</span>';

    // storeIds === null => все точки. Иначе показываем имена через запятую.
    const storeIds = ch.storeIds || ch.store_ids;
    const storeNames = ch.storeNames || ch.store_names || [];
    const storesCell = !storeIds || storeIds.length === 0
      ? '<span style="color:var(--text-2);font-size:12px">все</span>'
      : `<span style="font-size:12px">${storeNames.map(n => esc(n)).join(', ') || `${storeIds.length} точек`}</span>`;

    return `<tr>
      <td style="color:var(--muted);font-size:12px">${ch.id}</td>
      <td><strong>${esc(ch.name)}</strong></td>
      <td>${SEASON_LABELS[ch.season] ?? ch.season}</td>
      <td>${ch.year}</td>
      <td style="font-size:12px;color:var(--muted)">${startStr} — ${endStr}</td>
      <td style="font-size:13px">${esc(ch.heroName ?? '—')}</td>
      <td>${coinsCell}</td>
      <td>${storesCell}</td>
      <td>${ch.entries ?? 0}</td>
      <td>${statusBadge}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-ghost btn-sm btn-icon" onclick="showChallengeHistory(${ch.id})" title="История начислений"><i data-lucide="history"></i></button>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="editChallenge(${ch.id})" title="Редактировать"><i data-lucide="pencil"></i></button>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="duplicateChallenge(${ch.id})" title="Копировать"><i data-lucide="copy"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteChallenge(${ch.id})" title="Удалить"><i data-lucide="trash-2"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
  renderIcons();
}

async function showChallengeHistory(id) {
  const modal = document.getElementById('modal-challenge-history');
  document.getElementById('chh-title').textContent = 'История начислений';
  document.getElementById('chh-meta').textContent = 'Загрузка...';
  document.getElementById('chh-tbody').innerHTML = `<tr><td colspan="4" class="empty">Загрузка...</td></tr>`;
  modal.classList.remove('hidden');
  renderIcons();

  try {
    const data = await api('GET', `/challenges/${id}/transactions`);
    if (!data) return;
    document.getElementById('chh-title').textContent = data.challengeName;
    document.getElementById('chh-meta').textContent = data.total === 0
      ? 'Пока ничего не начислено по этому челленджу'
      : `${data.total} начислений · ${data.coinsTotal} монет · ${data.uniqueEmployees} сотрудников`;

    const tbody = document.getElementById('chh-tbody');
    if (data.transactions.length === 0) {
      tbody.innerHTML = emptyRow(4, 'history', 'Нет начислений');
      renderIcons();
      return;
    }
    tbody.innerHTML = data.transactions.map(t => {
      // Из note вырезаем префикс «Челлендж #N: name» — оставляем только
      // комментарий админа после « — » (если был).
      const m = (t.note ?? '').match(/^Челлендж[^—]*(?: — (.*))?$/);
      const comment = m && m[1] ? m[1] : '';
      return `<tr>
        <td style="color:var(--muted);font-size:12px;white-space:nowrap">${formatDateTime(t.createdAt)}</td>
        <td><strong>${esc(t.employeeName)}</strong>${t.storeName ? `<br><span class="text-muted" style="font-size:12px">${esc(t.storeName)}</span>` : ''}</td>
        <td style="color:var(--green);font-weight:600">+${t.amount}</td>
        <td style="font-size:13px;color:var(--text-2)">${esc(comment) || '<span class="text-muted">—</span>'}${t.adminUsername ? ` <span class="text-muted" style="font-size:11px">(${esc(t.adminUsername)})</span>` : ''}</td>
      </tr>`;
    }).join('');
    renderIcons();
  } catch (e) { toastError(e); }
}

function closeChallengeHistory() {
  document.getElementById('modal-challenge-history').classList.add('hidden');
}

function formatDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  // Иркутское время для UI
  const irk = new Date(dt.getTime() + 8 * 60 * 60 * 1000);
  const day = irk.getUTCDate();
  const mon = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'][irk.getUTCMonth()];
  const hh = String(irk.getUTCHours()).padStart(2, '0');
  const mm = String(irk.getUTCMinutes()).padStart(2, '0');
  return `${day} ${mon}, ${hh}:${mm}`;
}

async function deleteChallenge(id) {
  if (!await confirmDialog({
    title: 'Удалить челлендж?',
    warning: 'Будут также удалены все записи участников.',
    confirmText: 'Удалить',
    danger: true,
  })) return;
  try {
    await api('DELETE', `/challenges/${id}`);
    toast('Челлендж удалён');
    loadChallenges();
  } catch (e) { toastError(e); }
}

// ID редактируемого челленджа. null => режим создания.
let editingChallengeId = null;

function closeChallengeForm() {
  document.getElementById('add-challenge-form').classList.add('hidden');
  editingChallengeId = null;
}

async function showAddChallenge() {
  // Создание нового челленджа: чистим форму
  editingChallengeId = null;
  document.getElementById('ch-form-title').textContent = 'Новый челлендж';
  document.getElementById('ch-save-btn').innerHTML = '<i data-lucide="check"></i> Создать';
  document.getElementById('ch-active-row').style.display = 'none';

  const form = document.getElementById('add-challenge-form');
  // Гарантируем что форма открыта (а не toggle, чтобы edit→addNew работал)
  form.classList.remove('hidden');

  // Сброс полей
  document.getElementById('ch-name').value = '';
  document.getElementById('ch-season').value = 'spring';
  document.getElementById('ch-year').value = new Date().getFullYear();
  document.getElementById('ch-coin-reward').value = '0';
  document.getElementById('ch-start').value = '';
  document.getElementById('ch-end').value = '';
  document.getElementById('ch-desc').value = '';
  document.getElementById('ch-condition').value = '';
  document.getElementById('ch-stores-all').checked = true;

  await refreshChallengeHeroSelect();
  renderChallengeStoresList();
  onChallengeStoresAllToggle();
  renderIcons();
}

/**
 * Заполняет форму челленджа значениями из существующей записи.
 * mode: 'edit' — режим редактирования (PUT), 'duplicate' — копия (POST новой записи).
 */
async function _prefillChallengeForm(id, mode) {
  const list = await api('GET', '/challenges') || [];
  const ch = list.find(c => c.id === id);
  if (!ch) { toast('Челлендж не найден'); return null; }

  if (mode === 'edit') {
    editingChallengeId = id;
    document.getElementById('ch-form-title').textContent = `Редактирование: ${ch.name}`;
    document.getElementById('ch-save-btn').innerHTML = '<i data-lucide="save"></i> Сохранить';
    document.getElementById('ch-active-row').style.display = '';
  } else {
    // duplicate — это создание новой записи на основе существующей
    editingChallengeId = null;
    document.getElementById('ch-form-title').textContent = `Новый челлендж (копия от «${ch.name}»)`;
    document.getElementById('ch-save-btn').innerHTML = '<i data-lucide="check"></i> Создать';
    document.getElementById('ch-active-row').style.display = 'none';
  }

  const form = document.getElementById('add-challenge-form');
  form.classList.remove('hidden');

  // Заполняем поля. Бэк возвращает поля в snake_case (start_date, end_date,
  // hero_id, condition_description), потому что SELECT *. Поддерживаем оба варианта.
  // Для duplicate — добавляем «(копия)» к имени, чтобы было видно что это новая запись.
  const nameVal = mode === 'duplicate' ? `${ch.name} (копия)` : (ch.name ?? '');
  document.getElementById('ch-name').value = nameVal;
  document.getElementById('ch-season').value = ch.season ?? 'spring';
  document.getElementById('ch-year').value = ch.year ?? new Date().getFullYear();
  document.getElementById('ch-coin-reward').value = String(ch.coinReward ?? ch.coin_reward ?? 0);
  document.getElementById('ch-start').value = (ch.startDate ?? ch.start_date ?? '').toString().slice(0,10);
  document.getElementById('ch-end').value = (ch.endDate ?? ch.end_date ?? '').toString().slice(0,10);
  document.getElementById('ch-desc').value = ch.description ?? '';
  document.getElementById('ch-condition').value = ch.conditionDescription ?? ch.condition_description ?? '';
  document.getElementById('ch-is-active').checked = ch.isActive ?? ch.is_active ?? true;

  // Точки
  const storeIds = ch.storeIds || ch.store_ids;
  document.getElementById('ch-stores-all').checked = !storeIds || storeIds.length === 0;
  await refreshChallengeHeroSelect(ch.heroId ?? ch.hero_id ?? undefined);
  renderChallengeStoresList();
  // Расставить чекбоксы точек
  if (storeIds && storeIds.length > 0) {
    storeIds.forEach(sid => {
      const cb = document.querySelector(`.ch-store-cb[data-store-id="${sid}"]`);
      if (cb) cb.checked = true;
    });
  }
  onChallengeStoresAllToggle();
  renderIcons();
}

async function editChallenge(id) {
  return _prefillChallengeForm(id, 'edit');
}

async function duplicateChallenge(id) {
  return _prefillChallengeForm(id, 'duplicate');
}

async function refreshChallengeHeroSelect(selectedId) {
  cardHeroes = await api('GET', '/heroes') || [];
  const sel = document.getElementById('ch-hero');
  sel.innerHTML = '<option value="">— без карточки —</option>';
  cardHeroes.filter(h => h.isLimited).forEach(h => {
    const opt = document.createElement('option');
    opt.value = h.id; opt.textContent = h.name;
    if (selectedId && h.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderChallengeStoresList() {
  const list = document.getElementById('ch-stores-list');
  if (!list) return;
  list.innerHTML = (state.stores || []).map(s => `
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
      <input type="checkbox" class="ch-store-cb" data-store-id="${s.id}">
      ${esc(s.name)}
    </label>
  `).join('');
}

function onChallengeStoresAllToggle() {
  const all = document.getElementById('ch-stores-all').checked;
  const list = document.getElementById('ch-stores-list');
  list.style.opacity = all ? '0.5' : '1';
  list.style.pointerEvents = all ? 'none' : 'auto';
  // При «Все точки» сбрасываем индивидуальные галочки
  if (all) {
    list.querySelectorAll('.ch-store-cb').forEach(cb => { cb.checked = false; });
  }
}

function toggleNewHeroForm() {
  const form = document.getElementById('ch-new-hero-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) {
    document.getElementById('ch-new-hero-name').value = '';
    document.getElementById('ch-new-hero-desc').value = '';
    document.getElementById('ch-new-hero-img').value = '';
    // Спрятать кнопку загрузки если Cloudinary не настроен
    document.getElementById('ch-new-hero-upload-btn').style.display = state.cloudinary.enabled ? '' : 'none';
  }
  renderIcons();
}

function uploadNewChallengeHeroImage() {
  if (!state.cloudinary.enabled) { toast('Cloudinary не настроен'); return; }
  const input = document.getElementById('ch-new-hero-file');
  input.value = '';
  input.click();
}

async function _onChallengeHeroFile(input) {
  const file = input.files[0];
  if (!file) return;
  const btn = document.getElementById('ch-new-hero-upload-btn');
  btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-2"></i>'; renderIcons();
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_preset', state.cloudinary.uploadPreset);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${state.cloudinary.cloudName}/image/upload`, {
      method: 'POST', body: fd,
    });
    if (!res.ok) throw new Error(`Cloudinary error ${res.status}`);
    const data = await res.json();
    document.getElementById('ch-new-hero-img').value = data.secure_url;
    toast('Фото загружено');
  } catch (e) {
    toastError(e);
  } finally {
    btn.disabled = false; btn.innerHTML = '<i data-lucide="upload"></i>'; renderIcons();
  }
}

async function createHeroFromChallenge() {
  const name        = document.getElementById('ch-new-hero-name').value.trim();
  const description = document.getElementById('ch-new-hero-desc').value.trim() || null;
  const imageUrl    = document.getElementById('ch-new-hero-img').value.trim() || null;
  if (!name) { toast('Введи имя карточки'); return; }
  // Сезон лимитки — берём из выбранного сезона челленджа для удобства
  const season = document.getElementById('ch-season').value || null;
  try {
    const hero = await api('POST', '/heroes', {
      name, description, imageUrl, isLimited: true, season, sortOrder: 100,
    });
    toast('✅ Карточка создана');
    await refreshChallengeHeroSelect(hero.id);
    document.getElementById('ch-new-hero-form').classList.add('hidden');
  } catch (e) { toastError(e); }
}

async function saveChallenge() {
  const name = document.getElementById('ch-name').value.trim();
  const season = document.getElementById('ch-season').value;
  const year = parseInt(document.getElementById('ch-year').value);
  const heroIdRaw = document.getElementById('ch-hero').value;
  // null значит «без карточки» (не путаем с undefined — undefined «не трогать»)
  const heroId = heroIdRaw === '' ? null : (parseInt(heroIdRaw, 10) || null);
  const startDate = document.getElementById('ch-start').value;
  const endDate = document.getElementById('ch-end').value;
  const description = document.getElementById('ch-desc').value.trim();
  const conditionDescription = document.getElementById('ch-condition').value.trim();
  const coinReward = parseInt(document.getElementById('ch-coin-reward').value, 10) || 0;

  // Точки: если стоит «Все» — null, иначе массив id отмеченных
  const allStores = document.getElementById('ch-stores-all').checked;
  let storeIds = null;
  if (!allStores) {
    storeIds = [...document.querySelectorAll('.ch-store-cb:checked')]
      .map(cb => parseInt(cb.dataset.storeId, 10))
      .filter(id => !isNaN(id));
    if (storeIds.length === 0) {
      toast('Выбери хотя бы одну точку или поставь «Все точки»'); return;
    }
  }

  if (!name || !season || !year || !startDate || !endDate) {
    toast('Заполните название, сезон, год, даты'); return;
  }
  if (new Date(startDate) >= new Date(endDate)) {
    toast('Дата начала должна быть раньше даты конца'); return;
  }
  if (coinReward < 0 || coinReward > 1000) {
    toast('Награда монетами должна быть 0..1000'); return;
  }
  if (!heroId && coinReward === 0) {
    toast('Укажи хотя бы одно вознаграждение — карточку или монеты'); return;
  }

  const payload = {
    name, season, year, heroId, startDate, endDate, description, conditionDescription,
    coinReward, storeIds,
  };

  try {
    if (editingChallengeId) {
      // Edit-режим: добавляем isActive из чекбокса
      payload.isActive = document.getElementById('ch-is-active').checked;
      await api('PUT', `/challenges/${editingChallengeId}`, payload);
      toast('✅ Челлендж обновлён');
    } else {
      await api('POST', '/challenges', payload);
      toast('✅ Челлендж создан');
    }
    closeChallengeForm();
    loadChallenges();
  } catch (e) { toastError(e); }
}

// Backward-compat — на случай, если какой-то inline onclick ещё ссылается
window.addChallenge = saveChallenge;

// ── Герои ─────────────────────────────────────────────────────────────────────
let heroesCache = [];

async function loadHeroes() {
  const tbody = document.getElementById('heroes-tbody');
  tbody.innerHTML = skeletonRows(7, 6);
  heroesCache = await api('GET', '/heroes') || [];
  renderHeroes();
}

function renderHeroes() {
  const tbody = document.getElementById('heroes-tbody');
  const search = (document.getElementById('heroes-search')?.value ?? '').trim().toLowerCase();
  const list = !search ? heroesCache : heroesCache.filter(h =>
    (h.name || '').toLowerCase().includes(search) ||
    (h.description || '').toLowerCase().includes(search)
  );
  if (heroesCache.length === 0) {
    tbody.innerHTML = emptyRow(7, 'image', 'Нет героев');
    renderIcons(); return;
  }
  if (list.length === 0) {
    tbody.innerHTML = emptyRow(7, 'search-x', 'Ничего не найдено');
    renderIcons(); return;
  }
  tbody.innerHTML = list.map(h => `<tr data-hero-id="${h.id}">
    <td style="color:var(--muted);font-size:12px">${h.id}</td>
    <td><input type="text" class="hero-name-input" value="${esc(h.name)}" style="width:120px;font-weight:600"></td>
    <td class="col-hide-sm">${h.isLimited ? '<span class="badge badge-mvp">Лимит</span>' : '<span class="badge badge-neutral">Основной</span>'}</td>
    <td class="col-hide-md"><input type="text" class="hero-desc-input" value="${esc(h.description ?? '')}" placeholder="..." style="width:100%"></td>
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
  } catch (e) { toastError(e); }
  finally { btn.disabled = false; btn.innerHTML = '<i data-lucide="save"></i>'; renderIcons(); }
}

async function deleteHero(id) {
  if (!await confirmDialog({
    title: 'Удалить героя?',
    warning: 'Действие нельзя отменить.',
    confirmText: 'Удалить',
    danger: true,
  })) return;
  try {
    await api('DELETE', `/heroes/${id}`);
    toast('Герой удалён');
    loadHeroes();
  } catch (e) { toastError(e); }
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
  } catch (e) { toastError(e); }
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
    toastError(e);
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
  document.getElementById('cfg-mvp-coins').value       = cfg.mvpCoinReward ?? 0;
  document.getElementById('cfg-top-store-coins').value = cfg.topStoreCoinReward ?? 0;
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
  } catch (e) { toastError(e); }
}

// ── Дашборд ───────────────────────────────────────────────────────────────────
const SEASON_LABELS_DASH = { spring: 'Весна', summer: 'Лето', autumn: 'Осень', winter: 'Зима' };

// ── Drill-down с дашборда ─────────────────────────────────────────────────────
// Стат-карты кликабельны — переключаемся в соответствующую вкладку с pre-set
// фильтром, чтобы цифра в дашборде сразу давала контекст к ответу «а это что?».
function dashGoToEmployees() {
  switchTab('employees');
}
function dashGoToPendingExchanges() {
  switchTab('exchanges');
  const statusSel = document.getElementById('exchanges-status');
  if (statusSel) {
    statusSel.value = 'pending';
    loadExchanges();
  }
}
function dashGoToCoinsExport() {
  switchTab('coins');
  // Подождём, пока вкладка отрисуется, и откроем форму экспорта на текущий месяц
  setTimeout(() => {
    const form = document.getElementById('coins-export-form');
    if (form && form.classList.contains('hidden')) {
      openCoinsExport();
    } else if (form) {
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, 60);
}

async function loadDashboard() {
  // Передаём текущий фильтр-точку — все блоки на дашборде подстраиваются.
  const url = state.storeId ? `/dashboard?storeId=${state.storeId}` : '/dashboard';
  // Подписываем scope (видно из заголовка, какая точка фильтруется)
  const scopeEl = document.getElementById('dash-scope');
  if (scopeEl) {
    const store = state.stores.find(s => s.id === state.storeId);
    scopeEl.textContent = store ? `Точка: ${store.name}` : 'Все точки';
  }
  const data = await api('GET', url);
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
      `<div class="dash-top3-row" onclick="showEmployeeModal(${e.id})" title="Открыть карточку сотрудника">
        <span style="font-size:20px">${medals[i] ?? ''}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px">${esc(e.name)}</div>
          <div style="font-size:12px;color:var(--text-3)">${esc(e.storeName)}</div>
        </div>
        <div style="font-weight:700;color:var(--pink)">${e.mvpScore} б.</div>
      </div>`
    ).join('');
  } else {
    top3El.innerHTML = '<p class="text-muted">Заполни метрики во вкладке «Метрики» — топ-3 появится автоматически.</p>';
  }

  // Top performers (текущий месяц, Иркутск). По сумме положительных монет
  // с разбивкой: квиз / чек-лист / челленджи / прочее.
  const perfEl = document.getElementById('dash-top-performers');
  const periodEl = document.getElementById('dash-perf-period');
  if (periodEl) {
    const irkNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
    periodEl.textContent = `· ${MONTH_NAMES[irkNow.getUTCMonth() + 1]} ${irkNow.getUTCFullYear()}`;
  }
  if (data.topPerformers && data.topPerformers.length > 0) {
    perfEl.innerHTML = data.topPerformers.map((p, i) => {
      const c = p.byCategory || {};
      const max = p.totalCoins || 1;
      const seg = (val, cls) => val > 0
        ? `<span class="perf-seg ${cls}" style="flex:${val}" title="${esc(cls)}: ${val}"></span>`
        : '';
      const chips = [
        c.quiz      > 0 ? `<span class="perf-chip" title="Квиз">🧠 ${c.quiz}</span>` : '',
        c.checklist > 0 ? `<span class="perf-chip" title="Чек-лист">✅ ${c.checklist}</span>` : '',
        c.challenge > 0 ? `<span class="perf-chip" title="Челленджи">🔥 ${c.challenge}</span>` : '',
        c.other     > 0 ? `<span class="perf-chip" title="Прочее">⭐ ${c.other}</span>` : '',
      ].filter(Boolean).join('');
      const rank = i < 3 ? ['🥇','🥈','🥉'][i] : `${i + 1}`;
      return `<div class="perf-row perf-row-link" onclick="showEmployeeModal(${p.id})" title="Открыть карточку сотрудника">
        <span class="perf-rank">${rank}</span>
        <div class="perf-body">
          <div class="perf-head">
            <span class="perf-name">${esc(p.name)}</span>
            <span class="perf-total">${p.totalCoins}</span>
          </div>
          <div class="perf-bar">${seg(c.quiz, 'q')}${seg(c.checklist, 'c')}${seg(c.challenge, 'h')}${seg(c.other, 'o')}</div>
          <div class="perf-meta">${esc(p.storeName ?? '')} ${chips ? '· ' + chips : ''}</div>
        </div>
      </div>`;
    }).join('');
  } else {
    perfEl.innerHTML = '<p class="text-muted">В этом месяце ещё никто ничего не получил</p>';
  }

  renderIcons();
  loadEngagement();
}

async function loadEngagement() {
  // Cache-busting + явный запрос свежих данных. Применяем фильтр-точку,
  // чтобы график вовлечённости соответствовал остальному дашборду.
  const storeParam = state.storeId ? `&storeId=${state.storeId}` : '';
  const data = await api('GET', `/employees/engagement?days=30${storeParam}&_=${Date.now()}`);
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

// ── Запросы сотрудникам ───────────────────────────────────────────────────────

const REQUEST_STATUS_LABELS = {
  open:     '<span style="color:#1976d2">● Открыт</span>',
  answered: '<span style="color:#388e3c">● Отвечен</span>',
  closed:   '<span style="color:var(--muted)">● Закрыт</span>',
};

async function loadRequests() {
  const tbody = document.getElementById('requests-tbody');
  if (!tbody) return;
  tbody.innerHTML = skeletonRows(6, 5);
  const status = document.getElementById('req-status-filter')?.value || '';
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const list = await api('GET', '/requests' + qs) || [];
  if (list.length === 0) {
    tbody.innerHTML = emptyRow(7, 'inbox', 'Запросов нет');
    renderIcons();
    return;
  }
  tbody.innerHTML = list.map(r => {
    let target;
    if (r.targetEmployeeName) {
      target = `👤 ${esc(r.targetEmployeeName)}`;
    } else if (r.targetStoreName) {
      target = `🏪 ${esc(r.targetStoreName)} <span style="color:var(--muted);font-size:11px">(${r.targetCount})</span>`;
    } else if (r.targetCount > 0) {
      const names = (r.targetNames || []).slice(0, 2).map(esc).join(', ');
      const more = r.targetCount > 2 ? ` +${r.targetCount - 2}` : '';
      target = `👥 ${names}${more}`;
    } else {
      target = '—';
    }
    const created = new Date(r.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
    return `<tr style="cursor:pointer" onclick="openRequestModal(${r.id})">
      <td style="color:var(--muted);font-size:12px">${r.id}</td>
      <td>${target}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.requestText)}</td>
      <td class="col-hide-sm">${r.responseCount} / ${r.notificationsSent}</td>
      <td>${REQUEST_STATUS_LABELS[r.status] || r.status}</td>
      <td class="col-hide-md" style="color:var(--muted);font-size:12px">${created}</td>
      <td onclick="event.stopPropagation()">
        ${r.status !== 'closed' ? `<button class="btn btn-ghost btn-sm" onclick="closeReq(${r.id})" title="Закрыть"><i data-lucide="x"></i></button>` : ''}
      </td>
    </tr>`;
  }).join('');
  renderIcons();
}

let reqEmployeesCache = [];

async function showNewRequest() {
  const form = document.getElementById('new-request-form');
  form.classList.toggle('hidden');
  if (form.classList.contains('hidden')) return;
  // Точки в фильтр
  const filterSel = document.getElementById('new-req-store-filter');
  filterSel.innerHTML = '<option value="">Все точки</option>'
    + (state.stores || []).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  // Сотрудники (один раз, потом фильтр по точке локально)
  if (reqEmployeesCache.length === 0) {
    const emps = await api('GET', '/employees') || [];
    reqEmployeesCache = emps.filter(e => e.isActive);
  }
  renderReqEmployees();
}

function renderReqEmployees() {
  const filter = document.getElementById('new-req-store-filter').value;
  const storeId = filter ? parseInt(filter, 10) : null;
  const wrap = document.getElementById('new-req-employees');
  const list = storeId ? reqEmployeesCache.filter(e => e.storeId === storeId) : reqEmployeesCache;
  if (list.length === 0) {
    wrap.innerHTML = '<p class="text-muted" style="font-size:13px;text-align:center;margin:14px 0">Нет активных сотрудников</p>';
    updateReqSelectedCount();
    return;
  }
  // Сохраняем уже выбранных — чтобы фильтр не сбрасывал
  const selectedBefore = new Set(
    Array.from(wrap.querySelectorAll('input[type=checkbox]:checked')).map(cb => parseInt(cb.value, 10))
  );
  wrap.innerHTML = list.map(e => {
    const checked = selectedBefore.has(e.id) ? 'checked' : '';
    const storeLabel = e.storeName ? ` <span style="color:var(--muted);font-size:11px">— ${esc(e.storeName)}</span>` : '';
    return `<label style="display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;border-radius:4px" onmouseover="this.style.background='var(--surface-2,#f0f0f0)'" onmouseout="this.style.background=''">
      <input type="checkbox" value="${e.id}" ${checked} onchange="updateReqSelectedCount()">
      <span>${esc(e.name)}${storeLabel}</span>
    </label>`;
  }).join('');
  updateReqSelectedCount();
}

function reqSelectAll(checked) {
  document.querySelectorAll('#new-req-employees input[type=checkbox]').forEach(cb => cb.checked = checked);
  updateReqSelectedCount();
}

function updateReqSelectedCount() {
  const cnt = document.querySelectorAll('#new-req-employees input[type=checkbox]:checked').length;
  document.getElementById('new-req-selected-count').textContent = cnt;
}

async function submitRequest() {
  const text = document.getElementById('new-req-text').value.trim();
  if (!text) { toast('Введи текст запроса'); return; }
  const ids = Array.from(document.querySelectorAll('#new-req-employees input[type=checkbox]:checked'))
    .map(cb => parseInt(cb.value, 10))
    .filter(Number.isFinite);
  if (ids.length === 0) { toast('Отметь хотя бы одного сотрудника'); return; }

  // Если выбран фильтр точки И отмечены ВСЕ из этой точки — передадим storeId
  // (бэк назначит target_store_id для красивого отображения «🏪 точка»).
  const filterStoreId = parseInt(document.getElementById('new-req-store-filter').value, 10) || null;
  const body = { requestText: text };
  if (filterStoreId) {
    const allOfStore = reqEmployeesCache.filter(e => e.storeId === filterStoreId);
    if (allOfStore.length === ids.length && allOfStore.every(e => ids.includes(e.id))) {
      body.targetStoreId = filterStoreId;
    } else {
      body.targetEmployeeIds = ids;
    }
  } else if (ids.length === 1) {
    body.targetEmployeeId = ids[0];
  } else {
    body.targetEmployeeIds = ids;
  }

  try {
    const res = await api('POST', '/requests', body);
    toast(`✅ Запрос отправлен. Доставлено: ${res.sent}, пропущено: ${res.skipped}`);
    document.getElementById('new-request-form').classList.add('hidden');
    document.getElementById('new-req-text').value = '';
    loadRequests();
  } catch (e) { toastError(e); }
}

async function closeReq(id) {
  const ok = await confirmDialog('Закрыть запрос?', 'Сотрудники больше не смогут на него отвечать.');
  if (!ok) return;
  try {
    await api('POST', `/requests/${id}/close`);
    toast('✅ Запрос закрыт');
    loadRequests();
  } catch (e) { toastError(e); }
}

let currentRequestId = null;

async function openRequestModal(id) {
  currentRequestId = id;
  const modal = document.getElementById('modal-request');
  modal.classList.remove('hidden');
  document.getElementById('modal-req-title').textContent = `Запрос #${id}`;
  document.getElementById('modal-req-input').value = '';
  await renderRequestChat(id);
  // Обновляем badge после mark viewed (бэк это делает в GET /:id)
  try {
    const r = await api('GET', '/requests/unread-count');
    updateRequestsBadge(r?.count || 0);
  } catch { /* ignore */ }
}

async function renderRequestChat(id) {
  const body = document.getElementById('modal-req-body');
  body.innerHTML = '<p class="text-muted">Загрузка...</p>';
  try {
    const data = await api('GET', `/requests/${id}`);
    const r = data.request;
    let target;
    if (r.targetEmployeeName) target = `👤 ${esc(r.targetEmployeeName)}`;
    else if (r.targetStoreName) target = `🏪 ${esc(r.targetStoreName)} (${r.targetCount})`;
    else target = `👥 ${(r.targetNames || []).slice(0, 5).map(esc).join(', ')}${r.targetCount > 5 ? ` +${r.targetCount - 5}` : ''}`;

    let html = `
      <div style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border)">
        <div style="color:var(--muted);font-size:12px;margin-bottom:4px">Кому: ${target} · ${REQUEST_STATUS_LABELS[r.status] || r.status}</div>
      </div>
      <div class="chat-msg employee">
        <div>
          <div class="chat-bubble"><div style="white-space:pre-wrap">${esc(r.requestText)}</div></div>
          <div class="chat-meta">${new Date(r.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })} · исходный запрос</div>
        </div>
      </div>
    `;

    // Все сообщения — chat-thread
    for (const resp of data.responses) {
      const side = resp.senderType === 'manager' ? 'manager' : 'employee';
      const time = new Date(resp.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
      let fileBlock = '';
      if (resp.fileUrl) {
        if (resp.fileType === 'photo') {
          fileBlock = `<a href="${resp.fileUrl}" target="_blank" rel="noopener"><img src="${resp.fileThumbnailUrl || resp.fileUrl}" alt="фото"></a>`;
        } else if (resp.fileType === 'video') {
          fileBlock = `<video src="${resp.fileUrl}" controls preload="metadata" poster="${resp.fileThumbnailUrl || ''}"></video>`;
        } else if (resp.fileType === 'document') {
          const fname = resp.fileName || 'файл';
          fileBlock = `<a href="${resp.fileUrl}" target="_blank" rel="noopener" download="${esc(fname)}" style="display:inline-flex;gap:6px;align-items:center;padding:4px 8px;border:1px solid var(--border);border-radius:4px;text-decoration:none;color:inherit;background:var(--surface);margin-top:4px;font-size:11px"><i data-lucide="file"></i> ${esc(fname)}</a>`;
        }
      }
      const meta = side === 'manager'
        ? (resp.adminUsername ? `👨‍💼 ${esc(resp.adminUsername)}` : '👨‍💼 руководитель')
        : `👤 ${esc(resp.employeeName)}`;
      html += `<div class="chat-msg ${side}">
        <div>
          <div class="chat-bubble">
            ${resp.textContent ? `<div style="white-space:pre-wrap">${esc(resp.textContent)}</div>` : ''}
            ${fileBlock}
          </div>
          <div class="chat-meta" style="text-align:${side === 'manager' ? 'right' : 'left'}">${meta} · ${time}</div>
        </div>
      </div>`;
    }

    body.innerHTML = html;
    // Прокрутим вниз чтобы видеть последнее сообщение
    body.scrollTop = body.scrollHeight;
    setTimeout(() => renderIcons(), 0);
  } catch (e) {
    body.innerHTML = `<p style="color:var(--red)">Ошибка: ${esc(e.message)}</p>`;
  }
}

async function sendManagerMessage() {
  if (!currentRequestId) return;
  const input = document.getElementById('modal-req-input');
  const btn = document.getElementById('modal-req-send-btn');
  const text = input.value.trim();
  if (!text) { toast('Введи текст'); return; }
  btn.disabled = true;
  try {
    const r = await api('POST', `/requests/${currentRequestId}/message`, { text });
    input.value = '';
    if (r.recipientsCount === 0) {
      toast('⚠ Отправлено в БД, но никому из получателей не доставлено');
    }
    await renderRequestChat(currentRequestId);
    loadRequests();
  } catch (e) {
    toastError(e);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

function closeRequestModal() {
  document.getElementById('modal-request').classList.add('hidden');
  currentRequestId = null;
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
  } catch (e) { toastError(e); }
  finally { btn.disabled = false; }
}

async function saveEmployeeEmail(id, btn) {
  const input = document.getElementById('emp-email-input');
  if (!input) return;
  const email = input.value.trim() || null;
  // Простая валидация формата (если не пустой)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast('⚠️ Неверный формат email'); return;
  }
  btn.disabled = true;
  try {
    await api('PUT', `/employees/${id}`, { email });
    toast('✅ Email сохранён');
  } catch (e) { toastError(e); }
  finally { btn.disabled = false; }
}

async function saveEmployeeName(id, btn) {
  const input = document.getElementById('emp-name-input');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { toast('⚠️ Имя не может быть пустым'); return; }
  if (name.length > 100) { toast('⚠️ Имя слишком длинное (максимум 100 символов)'); return; }
  btn.disabled = true;
  try {
    // PATCH /:id/name доступен всем админам, включая coin_admin —
    // в отличие от PUT, где coin_admin блокируется denyCoinAdminForWrites.
    await api('PATCH', `/employees/${id}/name`, { name });
    toast('✅ Имя обновлено');
    // Синхронизируем заголовок модалки + строку в таблице
    const title = document.getElementById('modal-emp-title');
    if (title) title.textContent = name;
    if (typeof loadEmployees === 'function') loadEmployees();
  } catch (e) { toastError(e); }
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

  // Редактирование имени — отдельный эндпоинт PATCH /employees/:id/name,
  // доступный всем админам (включая coin_admin). Опечатки в ФИО обычное
  // дело, незачем требовать superadmin/editor только ради этого.
  const nameEditor = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px;padding:12px;background:var(--bg-2,#f8f8f8);border-radius:8px">
      <i data-lucide="user" style="width:16px;height:16px;color:var(--text-2)"></i>
      <span style="font-size:13px;color:var(--text-2)">Имя:</span>
      <input type="text" id="emp-name-input" value="${esc(summary.name)}" maxlength="100" placeholder="Имя сотрудника" style="flex:1;min-width:140px">
      <button class="btn btn-primary btn-sm" onclick="saveEmployeeName(${summary.id}, this)"><i data-lucide="save"></i> Сохранить</button>
    </div>
  `;

  body.innerHTML = `
    ${nameEditor}
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

    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;padding:12px;background:var(--bg-2,#f8f8f8);border-radius:8px">
      <i data-lucide="phone" style="width:16px;height:16px;color:var(--text-2)"></i>
      <span style="font-size:13px;color:var(--text-2)">Телефон:</span>
      <input type="tel" id="emp-phone-input" value="${esc(summary.phone ?? '')}" placeholder="+7..." style="flex:1;min-width:140px">
      <button class="btn btn-primary btn-sm" onclick="saveEmployeePhone(${summary.id}, this)"><i data-lucide="save"></i> Сохранить</button>
    </div>

    <div style="display:flex;gap:8px;align-items:center;margin-bottom:20px;padding:12px;background:var(--bg-2,#f8f8f8);border-radius:8px">
      <i data-lucide="mail" style="width:16px;height:16px;color:var(--text-2)"></i>
      <span style="font-size:13px;color:var(--text-2)">Email:</span>
      <input type="email" id="emp-email-input" value="${esc(summary.email ?? '')}" placeholder="ivan@example.com" style="flex:1;min-width:180px">
      <button class="btn btn-primary btn-sm" onclick="saveEmployeeEmail(${summary.id}, this)"><i data-lucide="save"></i> Сохранить</button>
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
  if (!Array.isArray(rows) || rows.length === 0) {
    toast('⚠️ Нечего экспортировать — данных за этот период нет');
    return false;
  }
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
  toast(`✅ Скачано: ${rows.length} ${rowsWord(rows.length)}`);
  return true;
}

function rowsWord(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'строка';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'строки';
  return 'строк';
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
    ['Сотрудник','Тайный покупатель (0-100)','Отзывы','Чек-лист (%)','Выполнение плана (%)','Балл','Лучший месяца'],
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
    ['Место','Сотрудник','Точка','Балл','Лучший месяца','Карточек','Монет'],
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
  tbody.innerHTML = list.map(u => {
    const isMe = u.id === state.adminUserId;
    const meTag = isMe ? ' <span class="badge badge-neutral" style="font-size:10px">это ты</span>' : '';
    return `<tr data-uid="${u.id}" data-username="${esc(u.username)}">
    <td style="color:var(--muted);font-size:12px">${u.id}</td>
    <td><strong>${esc(u.username)}</strong>${meTag}</td>
    <td>
      <select onchange="updateAdminUserRole(${u.id}, this.value)" ${isMe ? 'disabled title="Нельзя менять свою роль"' : ''}>
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
      <button class="btn btn-ghost btn-sm" onclick="resetAdminPassword(${u.id})" title="Сменить пароль"${isMe ? ' disabled' : ''}><i data-lucide="key"></i></button>
      ${u.isActive
        ? `<button class="btn btn-ghost btn-sm" onclick="toggleAdminActive(${u.id}, false)"${isMe ? ' disabled title="Нельзя отключить себя"' : ''}><i data-lucide="user-x"></i> Отключить</button>`
        : `<button class="btn btn-ghost btn-sm" onclick="toggleAdminActive(${u.id}, true)"><i data-lucide="user-check"></i> Включить</button>`}
      <button class="btn btn-danger btn-sm btn-icon" onclick="deleteAdminUser(${u.id})" title="Удалить"${isMe ? ' disabled' : ''}><i data-lucide="trash-2"></i></button>
    </td>
  </tr>`;
  }).join('');
  renderIcons();
}

async function addAdminUser() {
  const username = document.getElementById('new-admin-username').value.trim();
  const password = document.getElementById('new-admin-password').value;
  const role     = document.getElementById('new-admin-role').value;
  if (!username) { toast('Введи логин'); return; }
  if (!password || password.length < 8) { toast('Пароль минимум 8 символов'); return; }
  try {
    await api('POST', '/admin-users', { username, password, role });
    toast('✅ Пользователь создан');
    document.getElementById('add-admin-form').classList.add('hidden');
    document.getElementById('new-admin-username').value = '';
    document.getElementById('new-admin-password').value = '';
    loadAdminUsers();
  } catch (e) { toastError(e); }
}

async function updateAdminUserRole(id, role) {
  try {
    await api('PUT', `/admin-users/${id}`, { role });
    toast('Роль обновлена');
  } catch (e) { toastError(e); loadAdminUsers(); }
}

async function toggleAdminActive(id, isActive) {
  try {
    await api('PUT', `/admin-users/${id}`, { isActive });
    toast(isActive ? 'Включён' : 'Отключён');
    loadAdminUsers();
  } catch (e) { toastError(e); }
}

// id и username админа, которому сейчас сбрасываем пароль (для модалки)
let _resetPwTargetId = null;

function resetAdminPassword(id) {
  // Находим username из текущего списка для подзаголовка модалки
  const row = document.querySelector(`#admin-users-tbody tr[data-uid="${id}"]`);
  const username = row?.dataset.username || '';
  _resetPwTargetId = id;
  document.getElementById('rpw-username').textContent = username || `id ${id}`;
  document.getElementById('rpw-input').value = '';
  document.getElementById('modal-reset-password').classList.remove('hidden');
  setTimeout(() => document.getElementById('rpw-input').focus(), 80);
  renderIcons();
}

function closeResetPasswordModal() {
  _resetPwTargetId = null;
  document.getElementById('modal-reset-password').classList.add('hidden');
}

async function confirmResetPassword() {
  const password = document.getElementById('rpw-input').value;
  if (!password || password.length < 8) { toast('Пароль минимум 8 символов'); return; }
  const id = _resetPwTargetId;
  if (!id) return;
  try {
    await api('PUT', `/admin-users/${id}`, { password });
    closeResetPasswordModal();
    toast('✅ Пароль обновлён. Пользователь сменит его при первом входе');
  } catch (e) { toastError(e); }
}

async function deleteAdminUser(id) {
  if (!await confirmDialog({
    title: 'Удалить учётную запись?',
    warning: 'Пользователь больше не сможет войти в админку.',
    confirmText: 'Удалить',
    danger: true,
  })) return;
  try {
    await api('DELETE', `/admin-users/${id}`);
    toast('Удалено');
    loadAdminUsers();
  } catch (e) { toastError(e); }
}

// ── Старт ─────────────────────────────────────────────────────────────────────
if (state.token) showApp();
