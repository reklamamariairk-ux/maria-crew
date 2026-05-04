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
let quizAnsweredBefore = 0;        // сколько вопросов уже было отвечено сегодня до начала этой сессии
let quizTotalToday = 5;            // всего вопросов в дневной сессии
let quizResults = { correct: 0, coinsEarned: 0, byCategory: {} };
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
  checklist_day:       'Чек-лист выполнен',
  review:              'Именной отзыв',
  cake_order:          'Заказ торта',
  substitution:        'Замена смены',
  mentoring:           'Наставничество',
  idea:                'Идея для компании',
  training_meeting:    'Учебная встреча',
  knowledge_applied:   'Применил знания',
  manual:              'Начисление от руководителя',
  spend:               'Обмен в Магазине',
  quiz:                'Квиз — правильный ответ',
  checkin:             'Ежедневный вход',
  bad_review:          'Плохой отзыв',
  dirty_store:         'Не убрано в точке',
  training_resistance: 'Уход от обучения',
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
  sessionStorage.setItem('phone_asked', '1');

  const explanation =
    'Нужен твой номер телефона, чтобы начислять подарки и премии ' +
    'напрямую в 1С на твой профиль сотрудника.\n\n' +
    'Без номера система не сможет связать твою активность в Maria Crew ' +
    'с учётной записью в 1С.\n\nПоделиться номером?';

  // Сначала показываем предупреждение и только при согласии запрашиваем контакт.
  setTimeout(() => {
    const askContact = () => {
      try {
        tg.requestContact((shared) => {
          if (shared) {
            showToast('Спасибо! Номер сохранён.');
            employee.phone = '+saved';
          }
        });
      } catch { /* requestContact доступен не везде */ }
    };

    if (typeof tg.showConfirm === 'function') {
      tg.showConfirm(explanation, (ok) => { if (ok) askContact(); });
    } else if (typeof tg.showPopup === 'function') {
      tg.showPopup({
        title: 'Номер для 1С',
        message: explanation,
        buttons: [
          { id: 'yes', type: 'default', text: 'Поделиться' },
          { id: 'no',  type: 'cancel'  },
        ],
      }, (id) => { if (id === 'yes') askContact(); });
    } else {
      // Фоллбэк для старых клиентов Telegram
      if (window.confirm(explanation)) askContact();
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
  document.getElementById('store-tab-mine').classList.toggle('active', tab === 'mine');

  const isMine = tab === 'mine';
  document.getElementById('store-goal').style.display    = isMine ? 'none' : '';
  document.getElementById('store-prizes').style.display  = isMine ? 'none' : '';
  document.getElementById('store-mine').style.display    = isMine ? 'block' : 'none';

  if (isMine) loadMyExchanges();
  else renderPrizes();
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
          <span class="daily-action-sub">+1 монета за ответ</span>
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
    const { heroes, owned, mvpIds, counts } = await apiFetch('/collection');
    const ownedSet = new Set(owned);
    const mvpSet = new Set(mvpIds);
    const cardCounts = counts || {};

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
      const cnt     = cardCounts[h.id];
      const total   = cnt?.total || 0;
      const emoji = HERO_ICONS[h.id] || LIMITED_ICONS[h.name] || '🎴';
      let cls = 'hero-card';
      if (isMvp) cls += ' mvp';
      else if (isOwned) cls += ' owned';
      else cls += ' locked';
      // Бейдж сверху-справа: ★ для лучшего, ✓ для остальных в коллекции
      const badge = isMvp
        ? '<div class="hero-badge">★</div>'
        : isOwned ? '<div class="hero-badge green">✓</div>' : '';
      // Счётчик снизу-справа: показываем только если карточек больше одной
      const countBadge = total > 1 ? `<div class="hero-count">×${total}</div>` : '';
      // Картинка из админки или fallback на эмодзи
      const iconHtml = h.imageUrl
        ? `<div class="hero-icon hero-icon-img"><img src="${escapeAttr(h.imageUrl)}" alt="${escapeAttr(h.name)}" onerror="this.parentElement.textContent='${emoji}'"></div>`
        : `<div class="hero-icon">${emoji}</div>`;
      return `<div class="${cls}" onclick="openHeroModal(${h.id})">${badge}${countBadge}${iconHtml}<div class="hero-name">${escapeHtml(h.name)}</div></div>`;
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
          <div class="howto-row"><span class="howto-row-icon">👑</span><div class="howto-row-text"><strong>Стань лучшим сотрудником месяца</strong><span>Лучший результат точки — особая карточка со звездой</span></div></div>
        </div>
        <div class="howto-card" style="background:linear-gradient(135deg,#fff4f5,var(--brand-bg));margin-top:10px">
          <div style="font-size:14px;font-weight:800;margin-bottom:4px">🛍 Карточки можно тратить в Магазине</div>
          <div style="font-size:13px;color:var(--hint)">Обменивай их на торты, сертификаты и денежные премии — раздел «Магазин» → «Карточки».</div>
        </div>
        <p style="font-size:12px;color:var(--hint);text-align:center;padding-bottom:4px;margin-top:8px">Карточки выдаёт руководитель по итогам месяца</p>`;
    } else if (ownedMain < totalMain) {
      const need = totalMain - ownedMain;
      howtoEl.innerHTML = `
        <div class="howto-card" style="background:linear-gradient(135deg,#fff4f5,var(--brand-bg))">
          <div style="font-size:14px;font-weight:800;margin-bottom:6px">🏆 Собери всех 12 героев → «Золотой бейдж» + 7 000 ₽</div>
          <div style="font-size:13px;color:var(--hint)">Осталось ещё <strong style="color:var(--brand)">${need} ${plural(need,'герой','героя','героев')}</strong>. Продолжай в том же духе!</div>
        </div>
        <p style="font-size:12px;color:var(--hint);text-align:center;padding-top:8px;padding-bottom:4px">💡 Нажми на карточку, чтобы посмотреть детали. Карточки можно тратить в Магазине.</p>`;
    } else {
      howtoEl.innerHTML = `
        <div class="howto-card" style="background:linear-gradient(135deg,#e6f7ee,var(--green-bg));text-align:center">
          <div style="font-size:32px;margin-bottom:6px">🎊</div>
          <div style="font-size:16px;font-weight:900;color:var(--green)">Полная коллекция!</div>
          <div style="font-size:13px;color:var(--hint);margin-top:4px">Все ${totalMain} ${plural(totalMain, 'герой', 'героя', 'героев')} собраны. Загляни в Магазин — открыт «Золотой бейдж» + 7 000 ₽!</div>
        </div>`;
    }
  } catch (err) {
    grid.innerHTML = `<div class="empty"><div class="empty-icon">😕</div><div class="empty-text">${err.message}</div></div>`;
  }
}

// ── Модалка героя ─────────────────────────────────────────────────────────────

const SOURCE_LABELS = {
  mystery_shopper: { label: 'Тайный покупатель', icon: '🔍' },
  review:          { label: 'Именной отзыв',     icon: '⭐' },
  checklist:       { label: 'Чек-лист 100%',     icon: '✅' },
  plan:            { label: 'Выполнение плана',  icon: '📈' },
  mvp:             { label: 'Лучший сотрудник',  icon: '👑' },
  team_bonus:      { label: 'Лучшая точка',      icon: '🏆' },
  seasonal:        { label: 'Сезонный челлендж', icon: '🌸' },
  certification:   { label: 'Аттестация',        icon: '🎓' },
  manual:          { label: 'Вручную',           icon: '✋' },
};

window.openHeroModal = async function (heroId) {
  const backdrop = document.getElementById('hero-modal');
  const body = document.getElementById('hero-modal-body');
  body.innerHTML = '<div class="empty"><div class="empty-icon">⏳</div><div class="empty-text">Загружаем…</div></div>';
  backdrop.classList.add('show');
  try {
    const { hero, cards } = await apiFetch(`/collection/hero/${heroId}`);
    renderHeroModal(hero, cards);
  } catch (err) {
    body.innerHTML = `<div class="empty"><div class="empty-icon">😕</div><div class="empty-text">${err.message}</div><button class="hero-modal-close" style="margin-top:12px" onclick="closeHeroModal()">Закрыть</button></div>`;
  }
};

window.closeHeroModal = function () {
  document.getElementById('hero-modal').classList.remove('show');
};

function renderHeroModal(hero, cards) {
  const body = document.getElementById('hero-modal-body');
  const emoji = HERO_ICONS[hero.id] || LIMITED_ICONS[hero.name] || '🎴';
  const iconHtml = hero.imageUrl
    ? `<img src="${escapeAttr(hero.imageUrl)}" alt="${escapeAttr(hero.name)}" onerror="this.parentElement.textContent='${emoji}'">`
    : emoji;

  const total     = cards.length;
  const available = cards.filter(c => !c.isSpent).length;
  const subText = total === 0
    ? 'У тебя пока нет этой карточки'
    : `Карточек всего: ${total} · доступно: ${available}`;

  let cardsHtml = '';
  if (cards.length === 0) {
    cardsHtml = `
      <div class="hero-modal-section">Как получить</div>
      <div class="howto-card">
        <div class="howto-row"><span class="howto-row-icon">✅</span><div class="howto-row-text"><strong>Выполни чек-лист 100%</strong><span>За месяц без замечаний</span></div></div>
        <div class="howto-row"><span class="howto-row-icon">⭐</span><div class="howto-row-text"><strong>Именной отзыв</strong><span>Гость упомянул тебя по имени</span></div></div>
        <div class="howto-row"><span class="howto-row-icon">🔍</span><div class="howto-row-text"><strong>Тайный покупатель ≥ 90/100</strong><span>Высокая оценка по проверке</span></div></div>
        <div class="howto-row"><span class="howto-row-icon">📈</span><div class="howto-row-text"><strong>Выполнение плана ≥ 105%</strong><span>Перевыполнил план продаж</span></div></div>
        <div class="howto-row"><span class="howto-row-icon">👑</span><div class="howto-row-text"><strong>Лучший сотрудник месяца</strong><span>Получишь именно особую карточку (со звездой)</span></div></div>
      </div>`;
  } else {
    cardsHtml = `<div class="hero-modal-section">История этой карточки</div>` + cards.map(c => {
      const src   = SOURCE_LABELS[c.source] || { label: c.source, icon: '🃏' };
      const period = `${String(c.month).padStart(2,'0')}.${c.year}`;
      const tag    = c.isSpent
        ? '<span class="hcr-tag spent">Потрачена</span>'
        : c.isMvp
          ? '<span class="hcr-tag mvp">★ Особая</span>'
          : '<span class="hcr-tag active">Доступна</span>';
      return `
        <div class="hero-card-row${c.isSpent ? ' spent' : ''}">
          <span class="hcr-emoji">${src.icon}</span>
          <div style="flex:1;min-width:0">
            <div class="hcr-source">${escapeHtml(src.label)}</div>
            <div class="hcr-date">за ${period}</div>
          </div>
          ${tag}
        </div>`;
    }).join('');
  }

  body.innerHTML = `
    <div class="hero-modal-head">
      <div class="hero-modal-icon">${iconHtml}</div>
      <div style="flex:1;min-width:0">
        <div class="hero-modal-title">${escapeHtml(hero.name)}</div>
        <div class="hero-modal-sub">${escapeHtml(subText)}</div>
      </div>
    </div>
    ${hero.description ? `<div class="hero-modal-desc">${escapeHtml(hero.description)}</div>` : ''}
    ${total > 0 ? `
    <div class="hero-modal-stats">
      <div class="hero-modal-stat">
        <div class="hero-modal-stat-val">${total}</div>
        <div class="hero-modal-stat-lab">Всего получено</div>
      </div>
      <div class="hero-modal-stat">
        <div class="hero-modal-stat-val">${available}</div>
        <div class="hero-modal-stat-lab">Можно потратить</div>
      </div>
    </div>` : ''}
    ${cardsHtml}
    <button class="hero-modal-close" onclick="closeHeroModal()">Закрыть</button>
  `;
}

// ── Coins ─────────────────────────────────────────────────────────────────────

const COIN_ICONS = {
  checkin:             '🔥',
  quiz:                '🧩',
  checklist_day:       '✅',
  review:              '⭐',
  cake_order:          '🎂',
  substitution:        '🔄',
  mentoring:           '🎓',
  idea:                '💡',
  training_meeting:    '📚',
  knowledge_applied:   '🧠',
  manual:              '✋',
  spend:               '🛍',
  bad_review:          '⚠️',
  dirty_store:         '🧹',
  training_resistance: '🚫',
};

async function loadCoins() {
  document.getElementById('coins-balance').textContent  = '—';
  document.getElementById('coins-monthly').textContent  = '—';
  document.getElementById('coins-balance-unit').textContent = 'монет';
  document.getElementById('coins-monthly-sub').textContent  = 'за месяц';
  document.getElementById('coins-history').innerHTML =
    '<div class="empty"><div class="empty-icon">💰</div><div class="empty-text">Загружаем...</div></div>';

  try {
    const { balance, monthly, monthlySpent, history } = await apiFetch('/coins');
    document.getElementById('coins-balance').textContent = balance;
    document.getElementById('coins-balance-unit').textContent = pluralCoins(Number(balance) || 0);

    document.getElementById('coins-monthly').textContent = '+' + monthly;
    document.getElementById('coins-monthly-sub').textContent =
      monthlySpent > 0 ? `заработано · потрачено −${monthlySpent}` : 'заработано';

    if (!history.length) {
      document.getElementById('coins-history').innerHTML = `
        <div class="howto-card">
          <div class="howto-title">💰 Как зарабатывать монеты?</div>
          <div class="howto-row"><span class="howto-row-icon">🧩</span><div class="howto-row-text"><strong>Квиз каждый день</strong><span>5 вопросов — до +5 монет за все правильные ответы</span></div></div>
          <div class="howto-row"><span class="howto-row-icon">🔥</span><div class="howto-row-text"><strong>Серия входов</strong><span>Нажми 🔥 в шапке каждый день. Каждый 7-й день подряд = +5 бонусом</span></div></div>
          <div class="howto-row"><span class="howto-row-icon">✅</span><div class="howto-row-text"><strong>Чек-лист за смену</strong><span>Руководитель начисляет монеты за хороший день</span></div></div>
          <div class="howto-row"><span class="howto-row-icon">⭐</span><div class="howto-row-text"><strong>Именной отзыв от гостя</strong><span>Тебя упомянули по имени в отзыве</span></div></div>
          <div class="howto-row"><span class="howto-row-icon">🎓</span><div class="howto-row-text"><strong>Наставничество и обучение</strong><span>Подмена коллеги, идеи, применение знаний</span></div></div>
        </div>
        <p style="font-size:12px;color:var(--hint);text-align:center;padding-bottom:4px">Монеты начисляет руководитель + квиз и серия входов</p>`;
      return;
    }

    document.getElementById('coins-history').innerHTML = history.map(tx => {
      const pos   = tx.amount > 0;
      const icon  = COIN_ICONS[tx.reason] || (pos ? '+' : '−');
      const label = COIN_LABELS[tx.reason] || tx.reason;
      return `<div class="tx-item">
        <div class="tx-icon ${pos ? 'pos' : 'neg'}">${icon}</div>
        <div style="flex:1;min-width:0">
          <div class="tx-label">${escapeHtml(label)}</div>
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

    quizAnsweredBefore = data.answeredToday || 0;
    quizTotalToday    = data.totalToday    || 5;

    // Баннер «Твой первый квиз» — только для совсем нового сотрудника, который ещё не отвечал
    if (firstBanner && isNewUser && quizAnsweredBefore === 0) {
      firstBanner.style.display = 'block';
      firstBanner.innerHTML = `
        <div class="first-quiz-banner">
          <div class="first-quiz-banner-icon">🎉</div>
          <div class="first-quiz-banner-text">
            <strong>Твой первый квиз!</strong>
            <span>Ответь правильно на все ${quizTotalToday} вопросов — получи +${quizTotalToday} монет прямо сейчас</span>
          </div>
        </div>`;
    } else if (firstBanner && quizAnsweredBefore > 0) {
      // Сотрудник уже отвечал сегодня — баннер «продолжаем»
      firstBanner.style.display = 'block';
      firstBanner.innerHTML = `
        <div class="first-quiz-banner" style="background:linear-gradient(135deg,var(--gold-bg),#fff8e1);border-color:var(--gold)">
          <div class="first-quiz-banner-icon">⏯</div>
          <div class="first-quiz-banner-text">
            <strong>Продолжаем</strong>
            <span>Ты уже ответил на ${quizAnsweredBefore} из ${quizTotalToday} сегодня. Осталось ${quizTotalToday - quizAnsweredBefore}.</span>
          </div>
        </div>`;
    }

    quizQuestions = data.questions;
    quizCurrentIdx = 0;
    quizResults = { correct: 0, coinsEarned: 0, byCategory: {} };
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
  // Глобальный номер вопроса в дневной серии (учитываем уже отвеченные ранее)
  const globalN = quizAnsweredBefore + quizCurrentIdx + 1;
  const total   = quizTotalToday;
  // Прогресс — после ответа на N вопросов (т.е. бар у первого = 0%, у пятого = 80%, после ответа = 100%)
  const pct = Math.round(((globalN - 1) / total) * 100);
  const catLabel = CATEGORY_LABELS[q.category] || q.category || 'Вопрос';

  c.innerHTML = `
    <div class="quiz-card">
      <div class="quiz-header">
        <span class="quiz-progress-text">Вопрос ${globalN} из ${total}</span>
        ${q.category ? `<span class="quiz-category">${escapeHtml(catLabel)}</span>` : ''}
      </div>
      <div class="quiz-bar-wrap"><div class="quiz-bar-fill" style="width:${pct}%"></div></div>
      <div class="quiz-question">${escapeHtml(q.question)}</div>
      <div class="quiz-options">
        ${q.options.map((opt, i) => `
          <button class="quiz-option" onclick="answerQuiz(${q.id},${i},this,'${q.category}')" data-index="${i}">
            <span class="quiz-option-label">${QUIZ_LABELS[i]}</span>
            <span>${escapeHtml(opt)}</span>
          </button>`).join('')}
      </div>
      <div id="quiz-feedback" style="margin-top:14px;text-align:center;min-height:24px"></div>
    </div>`;
}

window.answerQuiz = async function (questionId, answerIndex, btn, category) {
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

    // Считаем разбивку по категориям
    const catKey = category || 'other';
    if (!quizResults.byCategory[catKey]) quizResults.byCategory[catKey] = { correct: 0, total: 0 };
    quizResults.byCategory[catKey].total++;

    // Мгновенный фидбэк прямо на карточке вопроса
    const fb = document.getElementById('quiz-feedback');
    if (result.isCorrect) {
      quizResults.correct++;
      quizResults.coinsEarned += result.coinsEarned;
      quizResults.byCategory[catKey].correct++;
      tg?.HapticFeedback?.notificationOccurred('success');
      if (fb) fb.innerHTML = result.coinsEarned > 0
        ? `<span style="display:inline-block;background:var(--gold-bg);color:var(--gold);font-weight:900;padding:6px 14px;border-radius:20px;font-size:13px;animation:pop 0.4s ease">+${result.coinsEarned} ${plural(result.coinsEarned, 'монета', 'монеты', 'монет')} 🎉</span>`
        : `<span style="color:var(--green);font-weight:700;font-size:13px">✓ Правильно!</span>`;
    } else {
      tg?.HapticFeedback?.notificationOccurred('error');
      if (fb) fb.innerHTML = `<span style="color:var(--brand);font-weight:700;font-size:13px">✗ Не угадал. Правильный ответ — ${QUIZ_LABELS[result.correctIndex]}</span>`;
    }

    quizCurrentIdx++;
    setTimeout(() => showQuizQuestion(document.getElementById('quiz-container')), 1800);
  } catch (err) {
    showToast(err.message);
    document.querySelectorAll('.quiz-option').forEach(b => b.disabled = false);
  }
};

function showQuizResults(container) {
  const { correct, coinsEarned, byCategory } = quizResults;
  const total = quizQuestions.length;
  // Градация: 0 — мотивация, 1-2 — норм, 3-4 — отлично, all correct — идеально
  let emoji, title, sub;
  if (correct === total && total > 0) { emoji = '🎉'; title = 'Идеально!';     sub = 'Все ответы верные'; }
  else if (correct >= Math.ceil(total * 0.7)) { emoji = '👏'; title = 'Отлично!'; sub = 'Хороший результат'; }
  else if (correct >= 1) { emoji = '💪'; title = 'Неплохо!';                       sub = 'В следующий раз будет ещё лучше'; }
  else                   { emoji = '🤝'; title = 'Не сдавайся';                    sub = 'Главное — продолжать. Завтра новые вопросы!'; }

  // Разбивка по категориям
  const catEntries = Object.entries(byCategory).filter(([, v]) => v.total > 0);
  const catBlock = catEntries.length
    ? `<div style="margin-top:14px;padding:12px;background:var(--cream);border-radius:12px">
         <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;color:var(--hint);margin-bottom:8px">По категориям</div>
         ${catEntries.map(([cat, v]) => {
           const label = CATEGORY_LABELS[cat] || cat;
           const ok    = v.correct === v.total;
           return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:13px">
             <span>${escapeHtml(label)}</span>
             <span style="font-weight:800;color:${ok ? 'var(--green)' : 'var(--text)'}">${v.correct}/${v.total}${ok ? ' ✓' : ''}</span>
           </div>`;
         }).join('')}
       </div>`
    : '';

  container.innerHTML = `
    <div class="quiz-results-card">
      <div class="quiz-results-emoji">${emoji}</div>
      <div class="quiz-results-title">${title}</div>
      <div class="quiz-results-score">${correct} из ${total} правильных${sub ? ` · ${sub}` : ''}</div>
      ${coinsEarned > 0
        ? `<div class="quiz-results-coins">+${coinsEarned} ${plural(coinsEarned,'монета','монеты','монет')}</div>`
        : '<div style="font-size:14px;color:var(--hint);margin-bottom:16px">Монет за этот блок ответов нет — попробуй завтра</div>'}
      ${catBlock}
      <div class="quiz-results-note" style="margin-top:14px">Новые вопросы появятся завтра 🌙</div>
    </div>`;

  tg?.HapticFeedback?.notificationOccurred(correct === total && total > 0 ? 'success' : 'warning');

  // Обновляем шапку, если получили монеты
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
  document.getElementById('rating-info-block').innerHTML = '';
  document.getElementById('stores-rating-list').innerHTML = '';

  try {
    const { ranking, stores, myStoreId } = await apiFetch('/rating');
    renderStoresRating(stores || [], myStoreId);

    const hasScore = (r) => r.mvpScore !== null && r.mvpScore !== undefined;
    const scored   = ranking.filter(hasScore);
    const unscored = ranking.filter(r => !hasScore(r));

    // Если ни у кого нет оценки — показываем понятное пустое состояние
    if (scored.length === 0) {
      document.getElementById('rating-info-block').innerHTML = `
        <div class="rating-info">
          <span class="rating-info-icon">ℹ️</span>
          <div class="rating-info-text">Рейтинг считается по баллам за месяц. Балл — оценка твоей работы: чек-листы, отзывы, план продаж и другие показатели. Кто наберёт больше всех — становится лучшим сотрудником месяца.</div>
        </div>`;
      document.getElementById('rating-list').innerHTML = `
        <div class="empty">
          <div class="empty-icon">📊</div>
          <div class="empty-text">Рейтинг за этот месяц ещё не сформирован.<br><br>Баллы появятся, когда руководитель внесёт показатели или нажмёт «Обработать месяц».</div>
        </div>`;
      return;
    }

    // Моя позиция (если есть оценка)
    const myIdx = scored.findIndex(r => r.employeeId === employee.id);
    const myEntry = myIdx >= 0 ? scored[myIdx] : null;
    const myInfo = myEntry
      ? `<strong>Ты на ${myIdx + 1} месте</strong> — ${Number(myEntry.mvpScore).toFixed(1)} ${pluralScore(Number(myEntry.mvpScore))}${myEntry.isMvp ? ' · ★ Лучший сотрудник' : ''}`
      : (unscored.some(r => r.employeeId === employee.id)
          ? '<strong>У тебя пока нет оценки</strong> · покажется, когда руководитель внесёт показатели'
          : '');
    document.getElementById('rating-info-block').innerHTML = `
      <div class="rating-info">
        <span class="rating-info-icon">ℹ️</span>
        <div class="rating-info-text">${myInfo || 'Рейтинг по баллам за месяц: чек-листы, отзывы, план продаж.'}</div>
      </div>`;

    const MEDALS = ['🥇','🥈','🥉'];
    let html = scored.map((r, i) => {
      const isMe = r.employeeId === employee.id;
      const score = `${Number(r.mvpScore).toFixed(1)} ${pluralScore(Number(r.mvpScore))}`;
      return `<div class="lb-item${isMe ? ' lb-me' : ''}">
        <div class="lb-rank">${MEDALS[i] || (i + 1)}</div>
        <div class="lb-name">${escapeHtml(r.name)}${r.isMvp ? ' <span class="lb-mvp">★ ЛУЧШИЙ</span>' : ''}</div>
        <div class="lb-score">${score}</div>
      </div>`;
    }).join('');

    if (unscored.length > 0) {
      html += `<div class="section-title" style="margin-top:18px;margin-bottom:8px">Без оценки</div>`;
      html += unscored.map(r => {
        const isMe = r.employeeId === employee.id;
        return `<div class="lb-item${isMe ? ' lb-me' : ''}">
          <div class="lb-rank">·</div>
          <div class="lb-name">${escapeHtml(r.name)}</div>
          <div class="lb-score">—</div>
        </div>`;
      }).join('');
    }

    document.getElementById('rating-list').innerHTML = html;
  } catch (err) {
    document.getElementById('rating-list').innerHTML =
      `<div class="empty"><div class="empty-icon">😕</div><div class="empty-text">${err.message}</div></div>`;
  }
}

function pluralScore(n) {
  // Русское склонение для дробных значений считаем как для целой части
  return plural(Math.floor(Math.abs(n)), 'очко', 'очка', 'очков');
}

function renderStoresRating(stores, myStoreId) {
  const el = document.getElementById('stores-rating-list');
  if (!el) return;

  // Только точки с реально выставленным баллом — без него ранжировать нельзя
  const ranked   = stores.filter(s => s.totalScore !== null && s.totalScore !== undefined);
  const unranked = stores.filter(s => s.totalScore === null || s.totalScore === undefined);

  if (ranked.length === 0) {
    el.innerHTML = `
      <div class="empty" style="padding:20px 16px">
        <div class="empty-icon" style="font-size:32px">🏪</div>
        <div class="empty-text">Рейтинг точек ещё не сформирован.<br>Появится, когда руководители внесут показатели.</div>
      </div>`;
    return;
  }

  const MEDALS = ['🥇','🥈','🥉'];
  let html = ranked.map((s, i) => {
    const isMine = s.storeId === myStoreId;
    const score  = `${Number(s.totalScore).toFixed(1)} ${pluralScore(Number(s.totalScore))}`;
    const tag    = s.isTop ? ' <span class="lb-mvp">★ ЛУЧШАЯ</span>' : '';
    const youTag = isMine ? ' <span style="font-size:11px;color:var(--brand);font-weight:700">· твоя</span>' : '';
    return `<div class="lb-item${isMine ? ' lb-me' : ''}">
      <div class="lb-rank">${MEDALS[i] || (i + 1)}</div>
      <div class="lb-name">${escapeHtml(s.storeName)}${tag}${youTag}</div>
      <div class="lb-score">${score}</div>
    </div>`;
  }).join('');

  if (unranked.length > 0) {
    html += `<div class="section-title" style="margin-top:14px;margin-bottom:8px">Без оценки</div>`;
    html += unranked.map(s => {
      const isMine = s.storeId === myStoreId;
      return `<div class="lb-item${isMine ? ' lb-me' : ''}">
        <div class="lb-rank">·</div>
        <div class="lb-name">${escapeHtml(s.storeName)}${isMine ? ' <span style="font-size:11px;color:var(--brand);font-weight:700">· твоя</span>' : ''}</div>
        <div class="lb-score">—</div>
      </div>`;
    }).join('');
  }

  // Если своя точка ранжирована — добавим хинт о бонусах за лучшую
  const myStore = ranked.find(s => s.storeId === myStoreId);
  if (myStore) {
    const myRank = ranked.indexOf(myStore) + 1;
    if (myStore.isTop) {
      html = `
        <div class="rating-info" style="background:linear-gradient(135deg,#fff8e1,var(--gold-bg));border:1.5px solid var(--gold);margin-bottom:10px">
          <span class="rating-info-icon">🏆</span>
          <div class="rating-info-text"><strong>Твоя точка — лучшая!</strong> Каждому в команде по итогам месяца — бонусная карточка героя.</div>
        </div>` + html;
    } else if (myRank > 1) {
      const top = ranked[0];
      const diff = (Number(top.totalScore) - Number(myStore.totalScore)).toFixed(1);
      html = `
        <div class="rating-info" style="margin-bottom:10px">
          <span class="rating-info-icon">📈</span>
          <div class="rating-info-text">Твоя точка на <strong>${myRank} месте</strong>. До лидера — <strong>${diff} ${pluralScore(parseFloat(diff))}</strong>. Если станете первыми — каждому бонусная карточка.</div>
        </div>` + html;
    }
  }

  el.innerHTML = html;
}

// ── Store ─────────────────────────────────────────────────────────────────────

let storeRequestId = 0;

async function loadStore() {
  document.getElementById('store-prizes').innerHTML =
    '<div class="empty"><div class="empty-icon">🛍</div><div class="empty-text">Загружаем...</div></div>';
  document.getElementById('store-goal').innerHTML = '';

  // Race-protection: каждый загрузочный запрос получает свой id;
  // если до завершения был запущен новый — старый отбрасываем.
  const myId = ++storeRequestId;

  try {
    const [prizes, me] = await Promise.all([
      prizesCache ? Promise.resolve(prizesCache) : apiFetch('/prizes'),
      myStatsCache ? Promise.resolve(myStatsCache) : apiFetch('/me'),
    ]);
    if (myId !== storeRequestId) return; // более свежий запрос уже идёт — не перезаписываем кэш
    prizesCache = prizes; myStatsCache = me;
    renderPrizes();
  } catch (err) {
    if (myId !== storeRequestId) return;
    document.getElementById('store-prizes').innerHTML =
      `<div class="empty"><div class="empty-icon">😕</div><div class="empty-text">${err.message}</div></div>`;
  }
}

function pluralCards(n) { return plural(n, 'карточка', 'карточки', 'карточек'); }
function pluralCoins(n) { return plural(n, 'монета', 'монеты', 'монет'); }

/** Полная стоимость приза в формате "3 карточки + 50 монет" или одиночно. */
function priceLabel(p) {
  const parts = [];
  if (p.cardsRequired > 0) parts.push(`${p.cardsRequired} ${pluralCards(p.cardsRequired)}`);
  if (p.coinsRequired > 0) parts.push(`${p.coinsRequired} ${pluralCoins(p.coinsRequired)}`);
  return parts.join(' + ');
}

/** Хватает ли ресурсов на приз (с учётом микс-стоимости карточки + монеты). */
function canAffordPrize(p, stats) {
  const cards = stats.availableCards || 0;
  const coins = stats.coinBalance || 0;
  if (p.cardsRequired > 0 && cards < p.cardsRequired) return false;
  if (p.coinsRequired > 0 && coins < p.coinsRequired) return false;
  return true;
}

function renderPrizes() {
  if (!prizesCache || !myStatsCache) return;
  const isCards = storeTab === 'cards';
  const prizes  = isCards ? prizesCache.filter(p => p.cardsRequired > 0) : prizesCache.filter(p => p.coinsRequired > 0);
  const balance = isCards ? (myStatsCache.availableCards || 0) : (myStatsCache.coinBalance || 0);
  const pluralUnit = isCards ? pluralCards : pluralCoins;
  const unitMany   = isCards ? 'карточек' : 'монет';

  const goalEl    = document.getElementById('store-goal');
  // «Следующий приз» — самый дешёвый по основной валюте вкладки, на который ещё не хватает.
  // Mixed-призы (карточки+монеты) учитывают canAfford полностью.
  const nextPrize = prizes
    .filter(p => !canAffordPrize(p, myStatsCache))
    .sort((a, b) => (isCards ? a.cardsRequired - b.cardsRequired : a.coinsRequired - b.coinsRequired))[0];

  if (nextPrize) {
    const cost = isCards ? nextPrize.cardsRequired : nextPrize.coinsRequired;
    const pct  = Math.min(100, Math.round((balance / cost) * 100));
    const need = Math.max(0, cost - balance);
    goalEl.innerHTML = `
      <div class="goal-card">
        <div class="goal-card-title">🎯 До следующего приза</div>
        <div class="goal-card-prize">${escapeHtml(nextPrize.name)}</div>
        <div class="goal-bar-wrap"><div class="goal-bar-fill" style="width:${pct}%"></div></div>
        <div class="goal-card-sub">${balance} / ${cost} ${pluralUnit(cost)}${need > 0 ? ` — ещё <strong>${need} ${pluralUnit(need)}</strong>` : ''}</div>
      </div>`;
  } else if (prizes.length > 0) {
    goalEl.innerHTML = `
      <div class="goal-card" style="background:var(--green-bg)">
        <div style="font-size:24px;margin-bottom:6px">🎉</div>
        <div style="font-size:15px;font-weight:900;color:var(--green)">Можешь обменять!</div>
        <div style="font-size:13px;color:var(--hint);margin-top:4px">У тебя достаточно ${unitMany}. Выбирай приз!</div>
      </div>`;
  } else {
    goalEl.innerHTML = '';
  }

  if (!prizes.length) {
    document.getElementById('store-prizes').innerHTML = `
      <div class="empty">
        <div class="empty-icon">🛍</div>
        <div class="empty-text">Здесь пока призов нет.<br>Загляни на вкладку «${isCards ? 'За монеты' : 'За карточки'}».</div>
      </div>`;
    return;
  }

  document.getElementById('store-prizes').innerHTML = prizes.map(p => {
    const canAfford = canAffordPrize(p, myStatsCache);
    const cost      = isCards ? p.cardsRequired : p.coinsRequired;
    const need      = Math.max(0, cost - balance);
    // Если приз mixed — показываем полную стоимость в подзаголовке, чтобы не вводить в заблуждение
    const isMixed = p.cardsRequired > 0 && p.coinsRequired > 0;
    const costLine = isMixed
      ? priceLabel(p)
      : `${cost} ${pluralUnit(cost)}`;
    return `<div class="prize-item${canAfford ? ' can-afford' : ''}">
      <div style="flex:1;min-width:0">
        <div class="prize-name">${escapeHtml(p.name)}</div>
        <div class="prize-cost">${costLine}</div>
        ${!canAfford && !isMixed ? `<div class="prize-need">ещё ${need} ${pluralUnit(need)}</div>` : ''}
        ${!canAfford && isMixed ? `<div class="prize-need">пока не хватает</div>` : ''}
      </div>
      <button class="prize-btn ${canAfford ? 'can' : 'cant'}"
              onclick="${canAfford ? `doExchange(${p.id}, this)` : ''}"
              ${canAfford ? '' : 'disabled'}>
        ${canAfford ? 'Обменять' : 'Мало'}
      </button>
    </div>`;
  }).join('');
}

let exchangeInFlight = false;
let myExchangesCache = null;

const EXCHANGE_STATUS = {
  pending:   { label: 'Ждёт подтверждения', icon: '⏳' },
  approved:  { label: 'Подтверждено',       icon: '✅' },
  fulfilled: { label: 'Приз выдан',          icon: '🎁' },
  rejected:  { label: 'Отклонено',           icon: '❌' },
};

async function loadMyExchanges(force = false) {
  const el = document.getElementById('store-mine');
  if (!el) return;
  if (!force && myExchangesCache) {
    renderMyExchanges();
    return;
  }
  el.innerHTML = '<div class="empty"><div class="empty-icon">🧾</div><div class="empty-text">Загружаем...</div></div>';
  try {
    const { exchanges } = await apiFetch('/exchanges/my');
    myExchangesCache = exchanges;
    renderMyExchanges();
  } catch (err) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">😕</div><div class="empty-text">${err.message}</div></div>`;
  }
}

function renderMyExchanges() {
  const el = document.getElementById('store-mine');
  if (!el || !myExchangesCache) return;

  if (myExchangesCache.length === 0) {
    el.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🧾</div>
        <div class="empty-text">Заявок пока нет.<br>Выбери приз во вкладке «Карточки» или «Монеты».</div>
      </div>`;
    return;
  }

  // Активные (pending/approved) сверху, потом обработанные (fulfilled/rejected)
  const active   = myExchangesCache.filter(e => e.status === 'pending' || e.status === 'approved');
  const archived = myExchangesCache.filter(e => e.status === 'fulfilled' || e.status === 'rejected');

  let html = '';
  if (active.length) {
    html += `<div class="section-title" style="margin-top:4px;margin-bottom:8px">В работе</div>`;
    html += active.map(renderExchangeItem).join('');
  }
  if (archived.length) {
    html += `<div class="section-title" style="margin-top:18px;margin-bottom:8px">История</div>`;
    html += archived.map(renderExchangeItem).join('');
  }
  el.innerHTML = html;
}

function renderExchangeItem(ex) {
  const status = EXCHANGE_STATUS[ex.status] || { label: ex.status, icon: '·' };
  const cards  = ex.cardsSpent > 0 ? `${ex.cardsSpent} ${pluralCards(ex.cardsSpent)}` : '';
  const coins  = ex.coinsSpent > 0 ? `${ex.coinsSpent} ${pluralCoins(ex.coinsSpent)}` : '';
  const cost   = [cards, coins].filter(Boolean).join(' + ');
  const date   = fmt(ex.createdAt);
  const noteBlock = ex.status === 'rejected' && ex.notes
    ? `<div class="exchange-note">Причина: ${escapeHtml(ex.notes)}</div>`
    : '';
  return `
    <div class="exchange-item">
      <div class="exchange-head">
        <div style="flex:1;min-width:0">
          <div class="exchange-name">${escapeHtml(ex.prizeName)}</div>
          <div class="exchange-cost">${cost || '—'}</div>
          <div class="exchange-date">${status.icon} ${date}</div>
        </div>
        <span class="exchange-status ${ex.status}">${escapeHtml(status.label)}</span>
      </div>
      ${noteBlock}
    </div>`;
}

async function doExchange(prizeId, btn) {
  if (exchangeInFlight) return; // защита от двойного клика до показа модалки
  exchangeInFlight = true;
  // Сразу блокируем все кнопки обмена визуально
  document.querySelectorAll('.prize-btn').forEach(b => { b.disabled = true; });

  try {
    const prize = prizesCache && prizesCache.find(p => p.id === prizeId);
    const name  = prize ? prize.name : 'приз';
    const cost  = prize ? priceLabel(prize) : '';
    const msg   = `Обменять на «${name}»?\n\n${cost ? `Стоимость: ${cost}\n\n` : ''}Заявка уйдёт руководителю на подтверждение.`;
    const confirmed = await new Promise(resolve => {
      if (tg && tg.showConfirm) tg.showConfirm(msg, resolve);
      else resolve(window.confirm(msg));
    });
    if (!confirmed) return;

    await apiFetch('/exchange', { method: 'POST', body: JSON.stringify({ prizeId }) });
    showToast('✅ Заявка отправлена! Руководитель скоро подтвердит.');
    tg?.HapticFeedback?.notificationOccurred('success');
    // Сбрасываем кэш и пере-загружаем призы, баланс и историю заявок
    prizesCache = null; myStatsCache = null; myExchangesCache = null;
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
  } finally {
    exchangeInFlight = false;
    // renderPrizes (вызванный в loadStore) перерисует кнопки заново — но если мы вышли по cancel,
    // нужно вернуть состояние кнопок вручную
    if (prizesCache) renderPrizes();
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
