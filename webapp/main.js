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

const HERO_ICONS = {
  1: '👨‍🍳', 2: '👩‍🍳', 3: '☕', 4: '💸', 5: '🧹', 6: '👩‍🏫',
  7: '🛍', 8: '🎨', 9: '🔬', 10: '📦', 11: '📋', 12: '👑',
};
const LIMITED_ICONS = {
  'Ice Breaker': '🏄', 'Upsale King': '🍂', 'Holiday Star': '⭐', 'Rookie of Season': '🌸',
};
const COIN_LABELS = {
  checklist_day: 'Чек-лист выполнен',
  review: 'Именной отзыв',
  cake_order: 'Заказ торта',
  substitution: 'Замена смены',
  mentoring: 'Наставничество',
  idea: 'Идея для компании',
  manual: 'Начисление от руководителя',
  spend: 'Обмен в магазине',
};
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
        if (res.status >= 500 || res.status === 503) {
          throw new Error(data.error || 'Maria Crew ещё запускается...');
        }
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

async function loadViewer() {
  return apiFetch('/me');
}

async function loadViewerWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await loadViewer();
    } catch (err) {
      lastError = err;
      const message = String(err.message || '');
      if (message.includes('Не зарегистрирован')) throw err;
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
  if (!webApp) {
    throw new Error('Открой приложение кнопкой из Telegram-бота Maria Crew. В обычном браузере не работает.');
  }
  tg = webApp;
  initData = tg.initData || '';
  hasTelegramUser = Boolean(tg.initDataUnsafe && tg.initDataUnsafe.user);
  try { tg.ready(); } catch {}
  try { tg.expand(); } catch {}
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function fmt(dateStr) {
  const d = new Date(dateStr);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function updateHeaderStats(stats) {
  document.getElementById('stat-cards').textContent = stats.availableCards ?? '0';
  document.getElementById('stat-coins').textContent = stats.coinBalance ?? '0';
  document.getElementById('stat-heroes').textContent = stats.uniqueHeroes ?? '0';
}

async function refreshHeaderStats() {
  try {
    const me = await apiFetch('/me');
    myStatsCache = me;
    updateHeaderStats({
      availableCards: me.availableCards,
      coinBalance: me.coinBalance,
      uniqueHeroes: me.uniqueHeroes,
    });
  } catch {}
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  initTelegramContext();

  if (!hasTelegramUser || !initData) {
    showBootError('Открой приложение кнопкой из Telegram-бота Maria Crew. В обычном браузере авторизация не работает.');
    return;
  }

  try {
    setLoadingHint('Подключаемся к Maria Crew...');
    const data = await authMiniApp();
    tgUser = data.user || null;

    try {
      setLoadingHint('Загружаем твои данные...');
      const me = await loadViewerWithRetry();
      employee = me;
      myStatsCache = me;
      showApp({
        availableCards: me.availableCards ?? 0,
        coinBalance: me.coinBalance ?? 0,
        uniqueHeroes: me.uniqueHeroes ?? 0,
      });
    } catch (err) {
      if (String(err.message || '').includes('Не зарегистрирован')) {
        await loadRegScreen();
        return;
      }
      throw err;
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
      o.value = s.id;
      o.textContent = s.name;
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
    tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred('error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Подключаемся...';

  try {
    const data = await apiFetch('/register', {
      method: 'POST',
      body: JSON.stringify({ storeId }),
    });
    employee = data.employee;
    isNewUser = true;
    tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred('success');
    showWelcome(data.stats);
  } catch (err) {
    showToast(err.message || 'Ошибка регистрации. Попробуй ещё раз.');
    btn.disabled = false;
    btn.textContent = 'Присоединиться к команде 🎉';
    tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred('error');
  }
}

function showWelcome(stats) {
  document.getElementById('reg-screen').style.display = 'none';
  const overlay = document.getElementById('welcome-overlay');
  overlay.classList.add('show');
  window._pendingStats = stats;
}

window.closeWelcome = function () {
  const overlay = document.getElementById('welcome-overlay');
  overlay.classList.remove('show');
  showApp(window._pendingStats || { availableCards: 0, coinBalance: 0, uniqueHeroes: 0 });
};

// ── App shell ─────────────────────────────────────────────────────────────────

function showApp(stats) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('reg-screen').style.display = 'none';
  document.getElementById('welcome-overlay').classList.remove('show');
  document.getElementById('app').style.display = 'block';

  const name = employee.name || '?';
  document.getElementById('avatar-text').textContent = name[0].toUpperCase();
  document.getElementById('header-name').textContent = name;
  document.getElementById('header-store').textContent = '🏪 ' + (employee.storeName || '—');

  updateHeaderStats(stats);
  prizesCache = null;
  myStatsCache = null;
  switchTab('collection');
  refreshHeaderStats();
}

// ── Tab routing ───────────────────────────────────────────────────────────────

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('nav-' + tab).classList.add('active');
  ({ collection: loadCollection, coins: loadCoins, rating: loadRating, store: loadStore })[tab]?.();
}

function switchStoreTab(tab) {
  storeTab = tab;
  document.getElementById('store-tab-cards').classList.toggle('active', tab === 'cards');
  document.getElementById('store-tab-coins').classList.toggle('active', tab === 'coins');
  renderPrizes();
}

// ── Collection ────────────────────────────────────────────────────────────────

async function loadCollection() {
  const grid = document.getElementById('hero-grid');
  grid.innerHTML = '<div class="empty"><div class="empty-icon">🃏</div><div class="empty-text">Загружаем...</div></div>';
  document.getElementById('collection-howto').innerHTML = '';

  try {
    const { heroes, owned, mvpIds } = await apiFetch('/collection');
    const ownedSet = new Set(owned);
    const mvpSet = new Set(mvpIds);

    const mainHeroes = heroes.filter(h => !h.isLimited);
    const limitedHeroes = heroes.filter(h => h.isLimited);
    const ownedMain = mainHeroes.filter(h => ownedSet.has(h.id)).length;
    const totalMain = mainHeroes.length;

    // Progress bar
    const pct = totalMain > 0 ? Math.round((ownedMain / totalMain) * 100) : 0;
    document.getElementById('collection-progress-text').textContent = `${ownedMain} из ${totalMain}`;
    document.getElementById('collection-progress-fill').style.width = pct + '%';

    // Hero grid
    const renderCard = (h) => {
      const isOwned = ownedSet.has(h.id);
      const isMvp = mvpSet.has(h.id);
      const icon = HERO_ICONS[h.id] || LIMITED_ICONS[h.name] || '🎴';
      let cls = 'hero-card';
      if (isMvp) cls += ' mvp';
      else if (isOwned) cls += ' owned';
      else cls += ' locked';

      const badge = isMvp
        ? '<div class="hero-badge">★</div>'
        : isOwned ? '<div class="hero-badge green">✓</div>' : '';

      return `<div class="${cls}">${badge}<div class="hero-icon">${icon}</div><div class="hero-name">${h.name}</div></div>`;
    };

    let html = mainHeroes.map(renderCard).join('');

    if (limitedHeroes.length) {
      html += `<div style="grid-column:1/-1;padding:4px 0 2px">
        <div class="section-title" style="margin-bottom:8px">⚡ Лимитные</div>
      </div>`;
      html += limitedHeroes.map(renderCard).join('');
    }

    grid.innerHTML = html;

    // How-to block
    const howtoEl = document.getElementById('collection-howto');
    if (ownedMain === 0) {
      howtoEl.innerHTML = `
        <div class="howto-card">
          <div class="howto-title">💡 Как получить первую карточку?</div>
          <div class="howto-row">
            <span class="howto-row-icon">✅</span>
            <div class="howto-row-text">
              <strong>Выполни чек-лист за смену</strong>
              <span>Руководитель отмечает каждый день</span>
            </div>
          </div>
          <div class="howto-row">
            <span class="howto-row-icon">⭐</span>
            <div class="howto-row-text">
              <strong>Получи именной отзыв от гостя</strong>
              <span>Упомянули тебя по имени — уже повод</span>
            </div>
          </div>
          <div class="howto-row">
            <span class="howto-row-icon">📈</span>
            <div class="howto-row-text">
              <strong>Выполни план продаж</strong>
              <span>Покажи хороший результат за месяц</span>
            </div>
          </div>
          <div class="howto-row">
            <span class="howto-row-icon">👑</span>
            <div class="howto-row-text">
              <strong>Стань MVP месяца</strong>
              <span>Лучший результат точки — особая карточка</span>
            </div>
          </div>
          <div class="howto-row">
            <span class="howto-row-icon">🤝</span>
            <div class="howto-row-text">
              <strong>Наставничество</strong>
              <span>Помог новому сотруднику освоиться</span>
            </div>
          </div>
        </div>
        <p style="font-size:12px;color:var(--hint);text-align:center;padding-bottom:4px">
          Карточки выдаёт руководитель по итогам месяца
        </p>`;
    } else if (ownedMain < totalMain) {
      const need = totalMain - ownedMain;
      howtoEl.innerHTML = `
        <div class="howto-card" style="background:linear-gradient(135deg,#fff8f0,#ffe4d6)">
          <div style="font-size:14px;font-weight:700;margin-bottom:6px">🏆 Соберёшь всех героев — откроется особый приз!</div>
          <div style="font-size:13px;color:var(--hint)">Осталось собрать ещё <strong style="color:var(--accent)">${need} ${plural(need,'героя','героев','героев')}</strong>. Продолжай в том же духе!</div>
        </div>`;
    } else {
      howtoEl.innerHTML = `
        <div class="howto-card" style="background:linear-gradient(135deg,#f0fff4,#d4efdf);text-align:center">
          <div style="font-size:28px;margin-bottom:6px">🎊</div>
          <div style="font-size:15px;font-weight:800;color:var(--green)">Полная коллекция!</div>
          <div style="font-size:13px;color:var(--hint);margin-top:4px">Ты собрал всех 12 героев. Легенда команды!</div>
        </div>`;
    }
  } catch (err) {
    grid.innerHTML = `<div class="empty"><div class="empty-icon">😕</div><div class="empty-text">${err.message}</div></div>`;
  }
}

// ── Coins ─────────────────────────────────────────────────────────────────────

async function loadCoins() {
  document.getElementById('coins-balance').textContent = '—';
  document.getElementById('coins-monthly').textContent = '—';
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
          <div class="howto-row">
            <span class="howto-row-icon">✅</span>
            <div class="howto-row-text">
              <strong>Чек-лист за смену</strong>
              <span>Выполнил все пункты — руководитель начисляет монеты</span>
            </div>
          </div>
          <div class="howto-row">
            <span class="howto-row-icon">⭐</span>
            <div class="howto-row-text">
              <strong>Именной отзыв от гостя</strong>
              <span>Тебя упомянули по имени в отзыве</span>
            </div>
          </div>
          <div class="howto-row">
            <span class="howto-row-icon">🎂</span>
            <div class="howto-row-text">
              <strong>Заказ торта на заказ</strong>
              <span>Провёл продажу торта на заказ</span>
            </div>
          </div>
          <div class="howto-row">
            <span class="howto-row-icon">🔄</span>
            <div class="howto-row-text">
              <strong>Взял замену смены</strong>
              <span>Помог коллеге в трудную минуту</span>
            </div>
          </div>
          <div class="howto-row">
            <span class="howto-row-icon">👩‍🏫</span>
            <div class="howto-row-text">
              <strong>Наставничество</strong>
              <span>Обучал нового сотрудника</span>
            </div>
          </div>
          <div class="howto-row">
            <span class="howto-row-icon">💡</span>
            <div class="howto-row-text">
              <strong>Идея для компании</strong>
              <span>Предложил и внедрил полезную идею</span>
            </div>
          </div>
        </div>
        <p style="font-size:12px;color:var(--hint);text-align:center;padding-bottom:4px">
          Монеты начисляет руководитель. Потрать их в Магазине!
        </p>`;
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

// ── Rating ────────────────────────────────────────────────────────────────────

async function loadRating() {
  document.getElementById('rating-list').innerHTML =
    '<div class="empty"><div class="empty-icon">⭐</div><div class="empty-text">Загружаем...</div></div>';

  // Info block — always show
  document.getElementById('rating-info-block').innerHTML = `
    <div class="rating-info">
      <span class="rating-info-icon">ℹ️</span>
      <div class="rating-info-text">
        Рейтинг считается по MVP-баллам за текущий месяц. MVP-балл — это оценка твоей работы: чек-листы, отзывы, план продаж и другие показатели.
      </div>
    </div>`;

  try {
    const { ranking } = await apiFetch('/rating');

    if (!ranking.length) {
      document.getElementById('rating-list').innerHTML = `
        <div class="empty">
          <div class="empty-icon">📊</div>
          <div class="empty-text">
            Рейтинг за этот месяц ещё не сформирован.<br><br>
            Данные появятся после того, как руководитель внесёт показатели за текущий месяц.
          </div>
        </div>`;
      return;
    }

    const MEDALS = ['🥇', '🥈', '🥉'];
    document.getElementById('rating-list').innerHTML = ranking.map((r, i) => {
      const isMe = r.employeeId === employee.id;
      return `<div class="lb-item${isMe ? ' lb-me' : ''}">
        <div class="lb-rank">${MEDALS[i] || (i + 1)}</div>
        <div class="lb-name">${r.name}${r.isMvp ? ' <span class="lb-mvp">MVP</span>' : ''}</div>
        <div class="lb-score">${r.mvpScore ?? 0} очков</div>
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
    prizesCache = prizes;
    myStatsCache = me;
    renderPrizes();
  } catch (err) {
    document.getElementById('store-prizes').innerHTML =
      `<div class="empty"><div class="empty-icon">😕</div><div class="empty-text">${err.message}</div></div>`;
  }
}

function renderPrizes() {
  if (!prizesCache || !myStatsCache) return;

  const isCards = storeTab === 'cards';
  const prizes = isCards
    ? prizesCache.filter(p => p.cardsRequired > 0)
    : prizesCache.filter(p => p.coinsRequired > 0);

  const balance = isCards ? (myStatsCache.availableCards || 0) : (myStatsCache.coinBalance || 0);
  const unit = isCards ? 'карточек' : 'монет';

  // Goal card — nearest prize you can't afford yet
  const goalEl = document.getElementById('store-goal');
  const nextPrize = prizes.find(p => {
    const cost = isCards ? p.cardsRequired : p.coinsRequired;
    return cost > balance;
  });

  if (nextPrize) {
    const cost = isCards ? nextPrize.cardsRequired : nextPrize.coinsRequired;
    const pct = Math.min(100, Math.round((balance / cost) * 100));
    const need = cost - balance;
    goalEl.innerHTML = `
      <div class="goal-card">
        <div class="goal-card-title">🎯 ДО СЛЕДУЮЩЕГО ПРИЗА</div>
        <div class="goal-card-prize">${nextPrize.name}</div>
        <div class="goal-bar-wrap">
          <div class="goal-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="goal-card-sub">${balance} / ${cost} ${unit} — ещё <strong>${need}</strong></div>
      </div>`;
  } else if (prizes.length > 0) {
    goalEl.innerHTML = `
      <div class="goal-card" style="background:linear-gradient(135deg,#f0fff4,#d4efdf)">
        <div style="font-size:22px;margin-bottom:6px">🎉</div>
        <div style="font-size:15px;font-weight:800;color:var(--green)">Можешь обменять!</div>
        <div style="font-size:13px;color:var(--hint);margin-top:4px">У тебя достаточно ${unit} для обмена. Выбирай приз!</div>
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
    const cost = isCards ? p.cardsRequired : p.coinsRequired;
    const canAfford = balance >= cost;
    const need = cost - balance;

    return `<div class="prize-item${canAfford ? ' can-afford' : ''}">
      <div style="flex:1;min-width:0">
        <div class="prize-name">${p.name}</div>
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

  if (!confirm(`Обменять на «${name}»? Заявка уйдёт руководителю.`)) return;

  try {
    await apiFetch('/exchange', { method: 'POST', body: JSON.stringify({ prizeId }) });
    prizesCache = null;
    myStatsCache = null;
    showToast('✅ Заявка отправлена! Руководитель скоро подтвердит.');
    tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred('success');
    const me = await apiFetch('/me');
    myStatsCache = me;
    updateHeaderStats({ availableCards: me.availableCards, coinBalance: me.coinBalance, uniqueHeroes: me.uniqueHeroes });
    renderPrizes();
  } catch (err) {
    showToast(err.message || 'Ошибка. Попробуй ещё раз.');
    tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred('error');
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 19) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

window.register = register;
window.switchTab = switchTab;
window.switchStoreTab = switchStoreTab;
window.doExchange = doExchange;

window.addEventListener('error', event => {
  showBootError(event.error?.message || event.message || 'Ошибка запуска приложения');
});

window.addEventListener('unhandledrejection', event => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason || '');
  if (message) showBootError(message);
});

window.addEventListener('DOMContentLoaded', () => {
  init().catch(err => {
    showBootError(err instanceof Error ? err.message : 'Ошибка запуска приложения');
  });
});
