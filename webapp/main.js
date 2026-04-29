/* global Telegram */
const API = '/api/webapp';
const REQUEST_TIMEOUT_MS = 30000;

let tg = null;
let initData = '';
let hasTelegramUser = false;
let tgUser = null;

let employee = null;
let currentTab = 'collection';
let storeTab = 'cards';
let prizesCache = null;
let myStatsCache = null;
let isNewUser = false;

// Quiz state
let quizQuestions = [];
let quizCurrentIdx = 0;
let quizResults = { correct: 0, coinsEarned: 0 };
const QUIZ_LABELS = ['А', 'Б', 'В', 'Г'];

const CATEGORY_LABELS = { product: 'Продукция', service: 'Сервис', crew: 'Команда' };

const HERO_ICONS = {
  1: '👨‍🍳', 2: '👩‍🍳', 3: '☕', 4: '💸', 5: '🧹', 6: '👩‍🏫',
  7: '🛍', 8: '🎨', 9: '🔬', 10: '📦', 11: '📋', 12: '👑',
};
const LIMITED_ICONS = {
  'Ice Breaker': '🏄', 'Upsale King': '🍂', 'Holiday Star': '⭐', 'Rookie of Season': '🌸',
};
const COIN_LABELS = {
  checklist_day: 'Чек-лист выполнен',
  review:        'Именной отзыв',
  cake_order:    'Заказ торта',
  substitution:  'Замена смены',
  mentoring:     'Наставничество',
  idea:          'Идея для компании',
  manual:        'Начисление от руководителя',
  spend:         'Обмен в Магазине',
  quiz:          'Квиз — правильный ответ',
  checkin:       'Ежедневный вход',
};
const MONTHS = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function withTimeout(promise, ms = REQUEST_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Сервер запускается. Подожди немного и открой приложение заново.')), ms)
    ),
  ]);
}

function setLoadingHint(message) {
  const el = document.getElementById('loading-copy');
  if (el) el.textContent = message;
}

function renderIcons() {
  if (window.lucide) lucide.createIcons();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function authMiniApp() {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await withTimeout(fetch(API + '/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData }),
      }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status >= 500 || res.status === 503) throw new Error(data.error || 'Maria Crew ещё запускается...');
        throw new Error(data.error || 'Не удалось войти в приложение');
      }
      return data;
    } catch (err) {
      lastError = err;
      if (attempt < 4) {
        setLoadingHint(`Запускаем Maria Crew... попытка ${attempt + 1} из 4`);
        await sleep(2500 * attempt);
      }
    }
  }
  throw lastError;
}

async function loadViewer() { return apiFetch('/me'); }

async function loadViewerWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await loadViewer();
    } catch (err) {
      lastError = err;
      if (String(err.message || '').includes('Не зарегистрирован')) throw err;
      if (attempt < 4) {
        setLoadingHint(`Загружаем данные... попытка ${attempt + 1} из 4`);
        await sleep(2500 * attempt);
      }
    }
  }
  throw lastError;
}

async function apiFetch(path, opts = {}, retries = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await withTimeout(fetch(API + path, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'tma ' + initData,
          ...(opts.headers || {}),
        },
      }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if ((res.status >= 500 || res.status === 0) && attempt < retries) {
          lastError = new Error(data.error || 'Ошибка сервера');
          await sleep(1500 * attempt);
          continue;
        }
        throw new Error(data.error || 'Ошибка сервера');
      }
      return data;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

function showBootError(message) {
  const loading = document.getElementById('loading');
  const regScreen = document.getElementById('reg-screen');
  const regErr = document.getElementById('reg-error-wrap');
  const regCopy = document.getElementById('reg-copy');
  const regStoreWrap = document.getElementById('reg-store-wrap');
  const regBtn = document.getElementById('reg-btn');
  if (loading) loading.style.display = 'none';
  if (regScreen) regScreen.style.display = 'block';
  if (regErr) regErr.style.display = 'block';
  if (regCopy) regCopy.textContent = message;
  if (regStoreWrap) regStoreWrap.style.display = 'none';
  if (regBtn) {
    regBtn.style.display = 'block';
    regBtn.textContent = 'Попробовать ещё раз';
    regBtn.disabled = false;
    regBtn.onclick = () => window.location.reload();
  }
}

function initTelegramContext() {
  const webApp = window.Telegram && window.Telegram.WebApp;
  if (!webApp) throw new Error('Открой приложение кнопкой из Telegram-бота Maria Crew.');
  tg = webApp;
  initData = tg.initData || '';
  hasTelegramUser = Boolean(tg.initDataUnsafe && tg.initDataUnsafe.user);
  tgUser = (tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
  try { tg.ready(); } catch {}
  try { tg.expand(); } catch {}
}

function escapeAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setAvatar(name) {
  const el = document.getElementById('avatar-text');
  if (!el) return;
  const letter = (name || '?')[0].toUpperCase();
  const photoUrl = (employee && employee.telegramPhotoUrl) || (tgUser && tgUser.photo_url) || '';
  el.textContent = letter;
  if (!photoUrl) return;
  const img = document.createElement('img');
  img.src = photoUrl;
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.onerror = () => { el.textContent = letter; };
  img.onload = () => { el.textContent = ''; el.appendChild(img); };
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function fmt(dateStr) {
  const d = new Date(dateStr);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m100 >= 11 && m100 <= 19) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}

function updateHeaderStats(stats) {
  document.getElementById('stat-cards').textContent  = stats.availableCards ?? '0';
  document.getElementById('stat-coins').textContent  = stats.coinBalance ?? '0';
  document.getElementById('stat-heroes').textContent = stats.uniqueHeroes ?? '0';
}

function updateStreakBadge(streak) {
  const badge = document.getElementById('streak-badge');
  const count = document.getElementById('streak-count');
  if (!badge || !count) return;
  count.textContent = streak.currentStreak || '0';
  if (streak.checkedInToday) {
    badge.classList.add('done');
    badge.title = 'Уже отмечался сегодня';
  } else {
    badge.classList.remove('done');
    badge.title = 'Отметиться (получить монеты)';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  initTelegramContext();
  if (!hasTelegramUser || !initData) {
    showBootError('Открой приложение кнопкой из Telegram-бота Maria Crew.');
    return;
  }

  try {
    setLoadingHint('Подключаемся к Maria Crew...');
    const data = await authMiniApp();
    // Не перетираем tgUser из initDataUnsafe — там лежит photo_url. Серверный user меньше.
    if (!tgUser && data.user) tgUser = data.user;

    if (data.employee && data.stats) {
      employee = { ...data.employee, ...data.stats };
      myStatsCache = employee;
      showApp({ availableCards: data.stats.availableCards ?? 0, coinBalance: data.stats.coinBalance ?? 0, uniqueHeroes: data.stats.uniqueHeroes ?? 0 });
    } else {
      try {
        setLoadingHint('Загружаем твои данные...');
        const me = await loadViewerWithRetry();
        employee = me; myStatsCache = me;
        showApp({ availableCards: me.availableCards ?? 0, coinBalance: me.coinBalance ?? 0, uniqueHeroes: me.uniqueHeroes ?? 0 });
      } catch (err) {
        if (String(err.message || '').includes('Не зарегистрирован')) { await loadRegScreen(); return; }
        throw err;
      }
    }
  } catch (err) {
    showBootError(err.message || 'Ошибка при входе в приложение');
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

async function loadRegScreen() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('reg-screen').style.display = 'block';
  document.getElementById('reg-error-wrap').style.display = 'none';
  document.getElementById('reg-store-wrap').style.display = 'block';
  document.getElementById('reg-btn').style.display = 'block';
  document.getElementById('reg-btn').textContent = 'Присоединиться к команде 🎉';
  document.getElementById('reg-btn').onclick = register;

  try {
    const stores = await withTimeout(fetch(API + '/stores')).then(r => r.json());
    const sel = document.getElementById('reg-store');
    sel.innerHTML = '<option value="">— выбери свою точку —</option>';
    stores.forEach(s => {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.name;
      sel.appendChild(o);
    });
  } catch {
    showToast('Не удалось загрузить список точек. Попробуй позже.');
  }
}

async function register() {
  const btn = document.getElementById('reg-btn');
  const storeId = parseInt(document.getElementById('reg-store').value);
  if (!storeId) {
    showToast('Выбери кондитерскую, в которой ты работаешь');
    tg?.HapticFeedback?.notificationOccurred('error');
    return;
  }
  btn.disabled = true; btn.textContent = 'Подключаемся...';
  try {
    const data = await apiFetch('/register', { method: 'POST', body: JSON.stringify({ storeId }) });
    employee = data.employee; isNewUser = true;
    tg?.HapticFeedback?.notificationOccurred('success');
    showWelcome(data.stats);
  } catch (err) {
    showToast(err.message || 'Ошибка регистрации. Попробуй ещё раз.');
    btn.disabled = false; btn.textContent = 'Присоединиться к команде 🎉';
    tg?.HapticFeedback?.notificationOccurred('error');
  }
}

function showWelcome(stats) {
  document.getElementById('reg-screen').style.display = 'none';
  document.getElementById('welcome-overlay').classList.add('show');
  window._pendingStats = stats;
}

window.closeWelcome = function () {
  document.getElementById('welcome-overlay').classList.remove('show');
  showApp(window._pendingStats || { availableCards: 0, coinBalance: 0, uniqueHeroes: 0 });
  if (isNewUser) switchTab('quiz');
};

// ── App shell ─────────────────────────────────────────────────────────────────

function showApp(stats) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('reg-screen').style.display = 'none';
  document.getElementById('welcome-overlay').classList.remove('show');
  document.getElementById('app').style.display = 'block';

  const name = employee.name || '?';
  setAvatar(name);
  document.getElementById('header-name').textContent = name;
  document.getElementById('header-store').textContent = '🏪 ' + (employee.storeName || '—');

  updateHeaderStats(stats);
  renderIcons(); // header stat-icons + bottom-nav + store-tabs static icons
  prizesCache = null;
  switchTab('collection');

  // Load streak info
  apiFetch('/streak').then(updateStreakBadge).catch(() => {});

  // Если у сотрудника нет номера телефона — попросим один раз
  maybeRequestPhoneOnce();
}

function maybeRequestPhoneOnce() {
  if (!employee || employee.phone) return;
  if (sessionStorage.getItem('phone_asked') === '1') return;
  if (!tg || typeof tg.requestContact !== 'function') return;
  // Маленькая задержка, чтобы интерфейс успел отрисоваться
  setTimeout(() => {
    sessionStorage.setItem('phone_asked', '1');
    try {
      tg.requestContact((shared) => {
        if (shared) {
          showToast('Спасибо! Номер сохранён.');
          // Бот получит контакт и сохранит сам — обновим объект employee
          employee.phone = '+saved';
        }
      });
    } catch {
      // requestContact доступен не везде — игнорируем ошибки
    }
  }, 1500);
}

// ── Tab routing ───────────────────────────────────────────────────────────────

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('nav-' + tab).classList.add('active');
  ({ collection: loadCollection, coins: loadCoins, quiz: loadQuiz, rating: loadRating, store: loadStore })[tab]?.();
}

function switchStoreTab(tab) {
  storeTab = tab;
  document.getElementById('store-tab-cards').classList.toggle('active', tab === 'cards');
  document.getElementById('store-tab-coins').classList.toggle('active', tab === 'coins');
  renderPrizes();
}

// ── Daily check-in / streak ───────────────────────────────────────────────────

window.doCheckin = async function () {
  const badge = document.getElementById('streak-badge');
  if (badge.classList.contains('done')) {
    showToast('Ты уже отметился сегодня! 🔥 Приходи завтра');
    return;
  }
  try {
    const result = await apiFetch('/checkin', { method: 'POST' });
    if (result.alreadyCheckedIn) {
      showToast('Ты уже отметился сегодня! 🔥 Приходи завтра');
      return;
    }
    tg?.HapticFeedback?.notificationOccurred('success');
    const msg = result.streakDay % 7 === 0
      ? `🏆 Неделя подряд! +${result.coinsEarned} монет`
      : `🔥 Серия ${result.streakDay} ${plural(result.streakDay,'день','дня','дней')} · +${result.coinsEarned} монет`;
    showToast(msg);
    updateStreakBadge({ checkedInToday: true, currentStreak: result.streakDay });
    loadDailyActionsBar();
    // Refresh coin balance in header
    apiFetch('/me').then(me => {
      myStatsCache = me;
      updateHeaderStats({ availableCards: me.availableCards, coinBalance: me.coinBalance, uniqueHeroes: me.uniqueHeroes });
    }).catch(() => {});
  } catch (err) {
    showToast(err.message || 'Ошибка. Попробуй ещё раз.');
  }
};

// ── Collection ────────────────────────────────────────────────────────────────

async function loadChallengeBanner() {
  const el = document.getElementById('challenge-banner');
  if (!el) return;
  try {
    const { challenge } = await apiFetch('/challenge');
    if (!challenge) { el.innerHTML = ''; return; }

    const SEASON_ICON = { spring: '🌸', summer: '🏄', autumn: '🍂', winter: '⭐' };
    const icon = SEASON_ICON[challenge.season] || '🏆';

    if (challenge.completed) {
      el.innerHTML = `
        <div class="challenge-card challenge-done">
          <div class="challenge-icon">${icon}</div>
          <div class="challenge-body">
            <div class="challenge-name">${escapeHtml(challenge.name)}</div>
            <div class="challenge-cond" style="color:var(--green);font-weight:700">✅ Челлендж выполнен! ${challenge.cardAwarded ? 'Карточка выдана.' : 'Ожидай карточку от руководителя.'}</div>
          </div>
        </div>`;
      return;
    }

    el.innerHTML = `
      <div class="challenge-card">
        <div class="challenge-icon">${icon}</div>
        <div class="challenge-body">
          <div class="challenge-label">Сезонный челлендж</div>
          <div class="challenge-name">${escapeHtml(challenge.name)}</div>
          <div class="challenge-cond">${escapeHtml(challenge.conditionDescription)}</div>
          <div class="challenge-footer">
            <span class="challenge-reward">🃏 Лимитная карточка «${escapeHtml(challenge.heroName)}»</span>
            <span class="challenge-days">${challenge.daysLeft} ${plural(challenge.daysLeft,'день','дня','дней')}</span>
          </div>
        </div>
      </div>`;
  } catch {
    el.innerHTML = '';
  }
}

async function loadDailyActionsBar() {
  const el = document.getElementById('daily-actions-bar');
  if (!el) return;
  try {
    const streak = await apiFetch('/streak');
    const checkedIn = streak.checkedInToday;
    const days = streak.currentStreak || 0;
    el.innerHTML = `
      <div class="daily-actions">
        <div class="daily-action${checkedIn ? ' done' : ''}" onclick="${checkedIn ? '' : 'doCheckin()'}">
          <span class="daily-action-icon">${checkedIn ? '✅' : '🔥'}</span>
          <span class="daily-action-label">${checkedIn ? 'Отметился' : 'Отметиться'}</span>
          <span class="daily-action-sub">${days} ${plural(days, 'день', 'дня', 'дней')} подряд</span>
        </div>
        <div class="daily-action" onclick="switchTab('quiz')">
          <span class="daily-action-icon">🧩</span>
          <span class="daily-action-label">Пройти квиз</span>
          <span class="daily-action-sub">+2 монеты за ответ</span>
        </div>
      </div>`;
  } catch { el.innerHTML = ''; }
}

async function loadCollection() {
  const grid = document.getElementById('hero-grid');
  grid.innerHTML = '<div class="empty"><div class="empty-icon">🃏</div><div class="empty-text">Загружаем...</div></div>';
  document.getElementById('collection-howto').innerHTML = '';
  loadDailyActionsBar();
  loadChallengeBanner();

  try {
    const { heroes, owned, mvpIds } = await apiFetch('/collection');
    const ownedSet = new Set(owned);
    const mvpSet = new Set(mvpIds);

    const mainHeroes    = heroes.filter(h => !h.isLimited);
    const limitedHeroes = heroes.filter(h =>  h.isLimited);
    const ownedMain  = mainHeroes.filter(h => ownedSet.has(h.id)).length;
    const totalMain  = mainHeroes.length;

    const pct = totalMain > 0 ? Math.round((ownedMain / totalMain) * 100) : 0;
    document.getElementById('collection-progress-text').textContent = `${ownedMain} из ${totalMain}`;
    document.getElementById('collection-progress-fill').style.width = pct + '%';

    const renderCard = (h) => {
      const isOwned = ownedSet.has(h.id);
      const isMvp   = mvpSet.has(h.id);
      const icon = HERO_ICONS[h.id] || LIMITED_ICONS[h.name] || '🎴';
      let cls = 'hero-card';
      if (isMvp) cls += ' mvp';
      else if (isOwned) cls += ' owned';
      else cls += ' locked';
      const badge = isMvp
        ? '<div class="hero-badge">★</div>'
        : isOwned ? '<div class="hero-badge green">✓</div>' : '';
      return `<div class="${cls}">${badge}<div class="hero-icon">${icon}</div><div class="hero-name">${escapeHtml(h.name)}</div></div>`;
    };

    let html = mainHeroes.map(renderCard).join('');
    if (limitedHeroes.length) {
      html += `<div style="grid-column:1/-1;padding:4px 0 2px"><div class="section-title">⚡ Лимитные</div></div>`;
      html += limitedHeroes.map(renderCard).join('');
    }
    grid.innerHTML = html;

    const howtoEl = document.getElementById('collection-howto');
    if (ownedMain === 0) {
      howtoEl.innerHTML = `
        <div class="howto-card">
          <div class="howto-title">💡 Как получить первую карточку?</div>
          <div class="howto-row"><span class="howto-row-icon">✅</span><div class="howto-row-text"><strong>Выполни чек-лист за смену</strong><span>Руководитель отмечает каждый день</span></div></div>
          <div class="howto-row"><span class="howto-row-icon">⭐</span><div class="howto-row-text"><strong>Получи именной отзыв от гостя</strong><span>Упомянули тебя по имени в отзыве</span></div></div>
          <div class="howto-row"><span class="howto-row-icon">📈</span><div class="howto-row-text"><strong>Выполни план продаж</strong><span>Хороший результат за месяц</span></div></div>
          <div class="howto-row"><span class="howto-row-icon">👑</span><div class="howto-row-text"><strong>Стань MVP месяца</strong><span>Лучший результат точки — особая карточка</span></div></div>
        </div>
        <p style="font-size:12px;color:var(--hint);text-align:center;padding-bottom:4px">Карточки выдаёт руководитель по итогам месяца</p>`;
    } else if (ownedMain < totalMain) {
      const need = totalMain - ownedMain;
      howtoEl.innerHTML = `
        <div class="howto-card" style="background:linear-gradient(135deg,#fff4f5,var(--brand-bg))">
          <div style="font-size:14px;font-weight:800;margin-bottom:6px">🏆 Соберёшь всех героев — откроется особый приз!</div>
          <div style="font-size:13px;color:var(--hint)">Осталось ещё <strong style="color:var(--brand)">${need} ${plural(need,'герой','героя','героев')}</strong>. Продолжай в том же духе!</div>
        </div>`;
    } else {
      howtoEl.innerHTML = `
        <div class="howto-card" style="background:linear-gradient(135deg,#e6f7ee,var(--green-bg));text-align:center">
          <div style="font-size:32px;margin-bottom:6px">🎊</div>
          <div style="font-size:16px;font-weight:900;color:var(--green)">Полная коллекция!</div>
          <div style="font-size:13px;color:var(--hint);margin-top:4px">Ты собрал всех 12 героев. Легенда команды!</div>
        </div>`;
    }
  } catch (err) {
    grid.innerHTML = `<div class="empty"><div class="empty-icon">😕</div><div class="empty-text">${err.message}</div></div>`;
  }
}

// ── Coins ─────────────────────────────────────────────────────────────────────

async function loadCoins() {
  document.getElementById('coins-balance').textContent  = '—';
  document.getElementById('coins-monthly').textContent  = '—';
  document.getElementById('coins-history').innerHTML =
    '<div class="empty"><div class="empty-icon">💰</div><div class="empty-text">Загружаем...</div></div>';

  try {
    const { balance, monthly, history } = await apiFetch('/coins');
    document.getElementById('coins-balance').textContent = balance;
    document.getElementById('coins-monthly').textContent = '+' + monthly;

    if (!history.length) {
      document.getElementById('coins-history').innerHTML = `
        <div class="howto-card">
          <div class="howto-title">💰 Как зарабатывать монеты?</div>
          <div class="howto-row"><span class="howto-row-icon">🧩</span><div class="howto-row-text"><strong>Квиз каждый день</strong><span>5 вопросов — до +10 монет за все правильные ответы</span></div></div>
          <div class="howto-row"><span class="howto-row-icon">🔥</span><div class="howto-row-text"><strong>Серия входов</strong><span>Нажми 🔥 в шапке каждый день. 7 дней = бонус ×4</span></div></div>
          <div class="howto-row"><span class="howto-row-icon">✅</span><div class="howto-row-text"><strong>Чек-лист за смену</strong><span>Руководитель начисляет монеты за хороший день</span></div></div>
          <div class="howto-row"><span class="howto-row-icon">⭐</span><div class="howto-row-text"><strong>Именной отзыв от гостя</strong><span>Тебя упомянули по имени в отзыве</span></div></div>
          <div class="howto-row"><span class="howto-row-icon">🎂</span><div class="howto-row-text"><strong>Торт на заказ</strong><span>Провёл продажу торта на заказ</span></div></div>
        </div>
        <p style="font-size:12px;color:var(--hint);text-align:center;padding-bottom:4px">Монеты начисляет руководитель + квиз и серия входов</p>`;
      return;
    }

    document.getElementById('coins-history').innerHTML = history.map(tx => {
      const pos = tx.amount > 0;
      return `<div class="tx-item">
        <div style="flex:1;min-width:0">
          <div class="tx-label">${COIN_LABELS[tx.reason] || tx.reason}</div>
          <div class="tx-date">${fmt(tx.createdAt)}</div>
        </div>
        <div class="tx-amount ${pos ? 'pos' : 'neg'}">${pos ? '+' : ''}${tx.amount}</div>
      </div>`;
    }).join('');
  } catch (err) {
    document.getElementById('coins-history').innerHTML =
      `<div class="empty"><div class="empty-icon">😕</div><div class="empty-text">${err.message}</div></div>`;
  }
}

// ── Quiz ──────────────────────────────────────────────────────────────────────

async function loadQuiz() {
  const container = document.getElementById('quiz-container');
  const firstBanner = document.getElementById('quiz-first-banner');
  container.innerHTML = '<div class="empty"><div class="empty-icon">🧩</div><div class="empty-text">Загружаем...</div></div>';
  if (firstBanner) firstBanner.style.display = 'none';

  try {
    const data = await apiFetch('/quiz/daily');

    if (data.alreadyDone) {
      container.innerHTML = `
        <div class="quiz-done-card">
          <div class="quiz-done-emoji">🌙</div>
          <div class="quiz-done-title">Квиз на сегодня пройден!</div>
          <div class="quiz-done-sub">Новые вопросы появятся завтра.<br>Заходи каждый день — знания растут вместе с монетами!</div>
        </div>`;
      return;
    }

    if (!data.questions || data.questions.length === 0) {
      container.innerHTML = '<div class="empty"><div class="empty-icon">🧩</div><div class="empty-text">Вопросы ещё не добавлены</div></div>';
      return;
    }

    if (firstBanner && isNewUser) {
      firstBanner.style.display = 'block';
      firstBanner.innerHTML = `
        <div class="first-quiz-banner">
          <div class="first-quiz-banner-icon">🎉</div>
          <div class="first-quiz-banner-text">
            <strong>Твой первый квиз!</strong>
            <span>Ответь правильно на все 5 вопросов — получи +10 монет прямо сейчас</span>
          </div>
        </div>`;
    }

    quizQuestions = data.questions;
    quizCurrentIdx = 0;
    quizResults = { correct: 0, coinsEarned: 0 };
    showQuizQuestion(container);
  } catch (err) {
    container.innerHTML = `<div class="empty"><div class="empty-icon">😕</div><div class="empty-text">${err.message}</div></div>`;
  }
}

function showQuizQuestion(container) {
  const c = container || document.getElementById('quiz-container');
  if (quizCurrentIdx >= quizQuestions.length) {
    showQuizResults(c);
    return;
  }

  const q = quizQuestions[quizCurrentIdx];
  const n     = quizCurrentIdx + 1;
  const total = quizQuestions.length;
  const pct   = Math.round(((n - 1) / total) * 100);
  const catLabel = CATEGORY_LABELS[q.category] || q.category;

  c.innerHTML = `
    <div class="quiz-card">
      <div class="quiz-header">
        <span class="quiz-progress-text">Вопрос ${n} из ${total}</span>
        <span class="quiz-category">${escapeHtml(catLabel)}</span>
      </div>
      <div class="quiz-bar-wrap"><div class="quiz-bar-fill" style="width:${pct}%"></div></div>
      <div class="quiz-question">${escapeHtml(q.question)}</div>
      <div class="quiz-options">
        ${q.options.map((opt, i) => `
          <button class="quiz-option" onclick="answerQuiz(${q.id},${i},this)" data-index="${i}">
            <span class="quiz-option-label">${QUIZ_LABELS[i]}</span>
            <span>${escapeHtml(opt)}</span>
          </button>`).join('')}
      </div>
    </div>`;
}

window.answerQuiz = async function (questionId, answerIndex, btn) {
  document.querySelectorAll('.quiz-option').forEach(b => b.disabled = true);
  tg?.HapticFeedback?.selectionChanged();

  try {
    const result = await apiFetch('/quiz/answer', { method: 'POST', body: JSON.stringify({ questionId, answerIndex }) });

    document.querySelectorAll('.quiz-option').forEach(b => {
      const idx = parseInt(b.dataset.index);
      if (idx === result.correctIndex)                   b.classList.add('correct');
      else if (idx === answerIndex && !result.isCorrect) b.classList.add('wrong');
      else                                               b.classList.add('dim');
    });

    if (result.isCorrect) {
      quizResults.correct++;
      quizResults.coinsEarned += result.coinsEarned;
      tg?.HapticFeedback?.notificationOccurred('success');
    } else {
      tg?.HapticFeedback?.notificationOccurred('error');
    }

    quizCurrentIdx++;
    setTimeout(() => showQuizQuestion(document.getElementById('quiz-container')), 1600);
  } catch (err) {
    showToast(err.message);
    document.querySelectorAll('.quiz-option').forEach(b => b.disabled = false);
  }
};

function showQuizResults(container) {
  const { correct, coinsEarned } = quizResults;
  const total = quizQuestions.length;
  const emoji = correct === total ? '🎉' : correct >= 3 ? '👏' : '💪';
  const title = correct === total ? 'Идеально!' : correct >= 3 ? 'Отлично!' : 'Неплохо!';

  container.innerHTML = `
    <div class="quiz-results-card">
      <div class="quiz-results-emoji">${emoji}</div>
      <div class="quiz-results-title">${title}</div>
      <div class="quiz-results-score">${correct} из ${total} правильных ответов</div>
      ${coinsEarned > 0
        ? `<div class="quiz-results-coins">+${coinsEarned} ${plural(coinsEarned,'монета','монеты','монет')}</div>`
        : '<div style="font-size:14px;color:var(--hint);margin-bottom:16px">Монеты начисляются за правильные ответы</div>'}
      <div class="quiz-results-note">Новые вопросы появятся завтра 🌙</div>
    </div>`;

  tg?.HapticFeedback?.notificationOccurred(correct === total ? 'success' : 'warning');

  // Refresh header balance if earned coins
  if (coinsEarned > 0) {
    apiFetch('/me').then(me => {
      myStatsCache = me;
      updateHeaderStats({ availableCards: me.availableCards, coinBalance: me.coinBalance, uniqueHeroes: me.uniqueHeroes });
    }).catch(() => {});
  }
}

// ── Rating ────────────────────────────────────────────────────────────────────

async function loadRating() {
  document.getElementById('rating-list').innerHTML =
    '<div class="empty"><div class="empty-icon">⭐</div><div class="empty-text">Загружаем...</div></div>';

  document.getElementById('rating-info-block').innerHTML = `
    <div class="rating-info">
      <span class="rating-info-icon">ℹ️</span>
      <div class="rating-info-text">Рейтинг считается по MVP-баллам за текущий месяц. MVP-балл — оценка твоей работы: чек-листы, отзывы, план продаж и другие показатели.</div>
    </div>`;

  try {
    const { ranking } = await apiFetch('/rating');
    if (!ranking.length) {
      document.getElementById('rating-list').innerHTML = `
        <div class="empty">
          <div class="empty-icon">📊</div>
          <div class="empty-text">Рейтинг за этот месяц ещё не сформирован.<br><br>Данные появятся после того, как руководитель внесёт показатели.</div>
        </div>`;
      return;
    }
    const MEDALS = ['🥇','🥈','🥉'];
    document.getElementById('rating-list').innerHTML = ranking.map((r, i) => {
      const isMe = r.employeeId === employee.id;
      const score = r.mvpScore !== null && r.mvpScore !== undefined
        ? `${Number(r.mvpScore).toFixed(1)} очков`
        : 'нет оценки';
      return `<div class="lb-item${isMe ? ' lb-me' : ''}">
        <div class="lb-rank">${MEDALS[i] || (i + 1)}</div>
        <div class="lb-name">${escapeHtml(r.name)}${r.isMvp ? ' <span class="lb-mvp">MVP</span>' : ''}</div>
        <div class="lb-score">${score}</div>
      </div>`;
    }).join('');
  } catch (err) {
    document.getElementById('rating-list').innerHTML =
      `<div class="empty"><div class="empty-icon">😕</div><div class="empty-text">${err.message}</div></div>`;
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

async function loadStore() {
  document.getElementById('store-prizes').innerHTML =
    '<div class="empty"><div class="empty-icon">🛍</div><div class="empty-text">Загружаем...</div></div>';
  document.getElementById('store-goal').innerHTML = '';

  try {
    const [prizes, me] = await Promise.all([
      prizesCache ? Promise.resolve(prizesCache) : apiFetch('/prizes'),
      myStatsCache ? Promise.resolve(myStatsCache) : apiFetch('/me'),
    ]);
    prizesCache = prizes; myStatsCache = me;
    renderPrizes();
  } catch (err) {
    document.getElementById('store-prizes').innerHTML =
      `<div class="empty"><div class="empty-icon">😕</div><div class="empty-text">${err.message}</div></div>`;
  }
}

function renderPrizes() {
  if (!prizesCache || !myStatsCache) return;
  const isCards = storeTab === 'cards';
  const prizes  = isCards ? prizesCache.filter(p => p.cardsRequired > 0) : prizesCache.filter(p => p.coinsRequired > 0);
  const balance  = isCards ? (myStatsCache.availableCards || 0) : (myStatsCache.coinBalance || 0);
  const unit     = isCards ? 'карточек' : 'монет';

  const goalEl   = document.getElementById('store-goal');
  const nextPrize = prizes.find(p => (isCards ? p.cardsRequired : p.coinsRequired) > balance);

  if (nextPrize) {
    const cost = isCards ? nextPrize.cardsRequired : nextPrize.coinsRequired;
    const pct  = Math.min(100, Math.round((balance / cost) * 100));
    const need = cost - balance;
    goalEl.innerHTML = `
      <div class="goal-card">
        <div class="goal-card-title">🎯 До следующего приза</div>
        <div class="goal-card-prize">${escapeHtml(nextPrize.name)}</div>
        <div class="goal-bar-wrap"><div class="goal-bar-fill" style="width:${pct}%"></div></div>
        <div class="goal-card-sub">${balance} / ${cost} ${unit} — ещё <strong>${need}</strong></div>
      </div>`;
  } else if (prizes.length > 0) {
    goalEl.innerHTML = `
      <div class="goal-card" style="background:var(--green-bg)">
        <div style="font-size:24px;margin-bottom:6px">🎉</div>
        <div style="font-size:15px;font-weight:900;color:var(--green)">Можешь обменять!</div>
        <div style="font-size:13px;color:var(--hint);margin-top:4px">У тебя достаточно ${unit}. Выбирай приз!</div>
      </div>`;
  } else {
    goalEl.innerHTML = '';
  }

  if (!prizes.length) {
    document.getElementById('store-prizes').innerHTML =
      '<div class="empty"><div class="empty-icon">🛍</div><div class="empty-text">Призов пока нет</div></div>';
    return;
  }

  document.getElementById('store-prizes').innerHTML = prizes.map(p => {
    const cost      = isCards ? p.cardsRequired : p.coinsRequired;
    const canAfford = balance >= cost;
    const need      = cost - balance;
    return `<div class="prize-item${canAfford ? ' can-afford' : ''}">
      <div style="flex:1;min-width:0">
        <div class="prize-name">${escapeHtml(p.name)}</div>
        <div class="prize-cost">${cost} ${unit}</div>
        ${!canAfford ? `<div class="prize-need">ещё ${need} ${unit}</div>` : ''}
      </div>
      <button class="prize-btn ${canAfford ? 'can' : 'cant'}"
              onclick="${canAfford ? `doExchange(${p.id})` : ''}"
              ${canAfford ? '' : 'disabled'}>
        ${canAfford ? 'Обменять' : 'Мало'}
      </button>
    </div>`;
  }).join('');
}

async function doExchange(prizeId) {
  const prize = prizesCache && prizesCache.find(p => p.id === prizeId);
  const name = prize ? prize.name : 'приз';
  const confirmed = await new Promise(resolve => {
    if (tg && tg.showConfirm) tg.showConfirm(`Обменять на «${name}»?\n\nЗаявка уйдёт руководителю на подтверждение.`, resolve);
    else resolve(window.confirm(`Обменять на «${name}»? Заявка уйдёт руководителю.`));
  });
  if (!confirmed) return;

  try {
    await apiFetch('/exchange', { method: 'POST', body: JSON.stringify({ prizeId }) });
    showToast('✅ Заявка отправлена! Руководитель скоро подтвердит.');
    tg?.HapticFeedback?.notificationOccurred('success');
    // Сбрасываем кэш и пере-загружаем призы и баланс одним запросом
    prizesCache = null; myStatsCache = null;
    await loadStore();
    if (myStatsCache) {
      updateHeaderStats({
        availableCards: myStatsCache.availableCards,
        coinBalance:    myStatsCache.coinBalance,
        uniqueHeroes:   myStatsCache.uniqueHeroes,
      });
    }
  } catch (err) {
    showToast(err.message || 'Ошибка. Попробуй ещё раз.');
    tg?.HapticFeedback?.notificationOccurred('error');
  }
}

// ── Expose globals ────────────────────────────────────────────────────────────

window.register      = register;
window.switchTab     = switchTab;
window.switchStoreTab = switchStoreTab;
window.doExchange    = doExchange;

window.addEventListener('error', ev => {
  showBootError(ev.error?.message || ev.message || 'Ошибка запуска приложения');
});
window.addEventListener('unhandledrejection', ev => {
  const msg = ev.reason instanceof Error ? ev.reason.message : String(ev.reason || '');
  if (msg) showBootError(msg);
});
window.addEventListener('DOMContentLoaded', () => {
  init().catch(err => showBootError(err instanceof Error ? err.message : 'Ошибка запуска приложения'));
});
