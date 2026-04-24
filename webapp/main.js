/* global Telegram */
const API = '/api/webapp';
const REQUEST_TIMEOUT_MS = 12000;

let tg = null;
let initData = '';
let hasTelegramUser = false;

let employee = null;
let currentTab = 'collection';
let storeTab = 'cards';
let prizesCache = null;
let myStatsCache = null;

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
  idea: 'Предложение',
  manual: 'Начисление',
  spend: 'Обмен в магазине',
};
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function withTimeout(promise, ms = REQUEST_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Сервер отвечает слишком долго. Попробуй ещё раз.')), ms)),
  ]);
}

async function apiFetch(path, opts = {}) {
  const res = await withTimeout(fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'tma ' + initData,
      ...(opts.headers || {}),
    },
  }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}

function showBootError(message) {
  const loading = document.getElementById('loading');
  const regScreen = document.getElementById('reg-screen');
  const regCopy = document.getElementById('reg-copy');
  const regStoreWrap = document.getElementById('reg-store-wrap');
  const regBtn = document.getElementById('reg-btn');

  if (loading) loading.style.display = 'none';
  if (regScreen) regScreen.style.display = 'block';
  if (regCopy) regCopy.textContent = message;
  if (regStoreWrap) regStoreWrap.style.display = 'none';
  if (regBtn) {
    regBtn.style.display = 'block';
    regBtn.textContent = 'Закрыть и открыть заново';
    regBtn.disabled = false;
    regBtn.onclick = () => window.location.reload();
  }
}

function initTelegramContext() {
  const webApp = window.Telegram && window.Telegram.WebApp;
  if (!webApp) {
    throw new Error('Telegram WebApp SDK не загрузился. Открой Maria Crew ещё раз из сообщения бота.');
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
  setTimeout(() => t.classList.remove('show'), 2800);
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
  } catch (err) {
    console.error('[webapp] header stats error:', err);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  initTelegramContext();

  if (!hasTelegramUser || !initData) {
    showBootError('Открой приложение кнопкой из Telegram-бота Maria Crew. В обычном браузере авторизация не работает.');
    return;
  }

  try {
    const res = await withTimeout(fetch(API + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    }));
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.registered) {
      employee = data.employee;
      showApp(data.stats ?? { availableCards: '—', coinBalance: '—', uniqueHeroes: '—' });
    } else if (res.ok && data.registered === false) {
      await loadRegScreen();
    } else {
      throw new Error(data.error || 'Не удалось авторизоваться в Mini App');
    }
  } catch (err) {
    showBootError(err.message || 'Ошибка входа в приложение');
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

async function loadRegScreen() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('reg-screen').style.display = 'block';
  document.getElementById('reg-copy').textContent =
    'Выбери свою кондитерскую, чтобы привязать аккаунт и открыть Maria Crew.';
  document.getElementById('reg-store-wrap').style.display = 'block';
  document.getElementById('reg-btn').style.display = 'block';
  document.getElementById('reg-btn').textContent = 'Присоединиться к команде 🎉';
  document.getElementById('reg-btn').onclick = register;

  try {
    const stores = await withTimeout(fetch(API + '/stores')).then(r => r.json());
    const sel = document.getElementById('reg-store');
    sel.innerHTML = '<option value="">— выбери точку —</option>';
    stores.forEach(s => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name;
      sel.appendChild(o);
    });
  } catch {
    showToast('Не удалось загрузить список точек');
  }
}

async function register() {
  const btn = document.getElementById('reg-btn');
  const storeId = parseInt(document.getElementById('reg-store').value);
  if (!storeId) { showToast('Выбери кондитерскую'); return; }

  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Подключаемся...';

  try {
    const data = await apiFetch('/register', {
      method: 'POST',
      body: JSON.stringify({ storeId }),
    });
    employee = data.employee;
    document.getElementById('reg-screen').style.display = 'none';
    showApp(data.stats);
    tg.HapticFeedback && tg.HapticFeedback.notificationOccurred('success');
  } catch (err) {
    showToast(err.message || 'Ошибка регистрации');
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ── App shell ─────────────────────────────────────────────────────────────────

function showApp(stats) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('reg-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  document.getElementById('avatar-text').textContent = (employee.name || '?')[0].toUpperCase();
  document.getElementById('header-name').textContent = employee.name || '—';
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
  grid.innerHTML = '<div class="empty">Загружаем...</div>';

  try {
    const { heroes, owned, mvpIds } = await apiFetch('/collection');
    const ownedSet = new Set(owned);
    const mvpSet = new Set(mvpIds);

    grid.innerHTML = heroes.map(h => {
      const isOwned = ownedSet.has(h.id);
      const isMvp = mvpSet.has(h.id);
      const icon = HERO_ICONS[h.id] || LIMITED_ICONS[h.name] || '🎴';
      const cls = 'hero-card' + (isMvp ? ' mvp' : isOwned ? ' owned' : '');
      const badge = isMvp
        ? '<div class="hero-badge">★</div>'
        : isOwned ? '<div class="hero-badge" style="background:var(--green)">✓</div>' : '';
      return `<div class="${cls}">${badge}<div class="hero-icon">${icon}</div><div class="hero-name">${h.name}</div></div>`;
    }).join('');
  } catch (err) {
    grid.innerHTML = `<div class="empty">${err.message}</div>`;
  }
}

// ── Coins ─────────────────────────────────────────────────────────────────────

async function loadCoins() {
  document.getElementById('coins-balance').textContent = '—';
  document.getElementById('coins-monthly').textContent = '—';
  document.getElementById('coins-history').innerHTML = '<div class="empty">Загружаем...</div>';

  try {
    const { balance, monthly, history } = await apiFetch('/coins');
    document.getElementById('coins-balance').textContent = balance;
    document.getElementById('coins-monthly').textContent = '+' + monthly;

    if (!history.length) {
      document.getElementById('coins-history').innerHTML = '<div class="empty">Транзакций пока нет</div>';
      return;
    }

    document.getElementById('coins-history').innerHTML = history.map(tx => {
      const pos = tx.amount > 0;
      return `<div class="tx-item">
        <div>
          <div class="tx-label">${COIN_LABELS[tx.reason] || tx.reason}</div>
          <div class="tx-date">${fmt(tx.createdAt)}</div>
        </div>
        <div class="tx-amount ${pos ? 'pos' : 'neg'}">${pos ? '+' : ''}${tx.amount}</div>
      </div>`;
    }).join('');
  } catch (err) {
    document.getElementById('coins-history').innerHTML = `<div class="empty">${err.message}</div>`;
  }
}

// ── Rating ────────────────────────────────────────────────────────────────────

async function loadRating() {
  document.getElementById('rating-list').innerHTML = '<div class="empty">Загружаем...</div>';

  try {
    const { ranking } = await apiFetch('/rating');

    if (!ranking.length) {
      document.getElementById('rating-list').innerHTML = '<div class="empty">Данных за этот месяц нет</div>';
      return;
    }

    const MEDALS = ['🥇', '🥈', '🥉'];
    document.getElementById('rating-list').innerHTML = ranking.map((r, i) => {
      const isMe = r.employeeId === employee.id;
      return `<div class="lb-item${isMe ? ' lb-me' : ''}">
        <div class="lb-rank">${MEDALS[i] || (i + 1)}</div>
        <div class="lb-name">${r.name}${r.isMvp ? '<span class="lb-mvp">MVP</span>' : ''}</div>
        <div class="lb-score">${(r.mvpScore ?? 0)} очков</div>
      </div>`;
    }).join('');
  } catch (err) {
    document.getElementById('rating-list').innerHTML = `<div class="empty">${err.message}</div>`;
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

async function loadStore() {
  document.getElementById('store-prizes').innerHTML = '<div class="empty">Загружаем...</div>';
  try {
    const [prizes, me] = await Promise.all([
      prizesCache ? Promise.resolve(prizesCache) : apiFetch('/prizes'),
      myStatsCache ? Promise.resolve(myStatsCache) : apiFetch('/me'),
    ]);
    prizesCache = prizes;
    myStatsCache = me;
    renderPrizes();
  } catch (err) {
    document.getElementById('store-prizes').innerHTML = `<div class="empty">${err.message}</div>`;
  }
}

function renderPrizes() {
  if (!prizesCache || !myStatsCache) return;

  const prizes = storeTab === 'cards'
    ? prizesCache.filter(p => p.cardsRequired > 0)
    : prizesCache.filter(p => p.coinsRequired > 0);

  if (!prizes.length) {
    document.getElementById('store-prizes').innerHTML = '<div class="empty">Нет доступных призов</div>';
    return;
  }

  document.getElementById('store-prizes').innerHTML = prizes.map(p => {
    const canAfford = storeTab === 'cards'
      ? myStatsCache.availableCards >= p.cardsRequired
      : myStatsCache.coinBalance >= p.coinsRequired;
    const cost = storeTab === 'cards'
      ? `${p.cardsRequired} карточек`
      : `${p.coinsRequired} монет`;

    return `<div class="prize-item">
      <div>
        <div class="prize-name">${p.name}</div>
        <div class="prize-cost">${cost}</div>
      </div>
      <button class="prize-btn ${canAfford ? 'can' : 'cant'}"
              onclick="doExchange(${p.id})"
              ${canAfford ? '' : 'disabled'}>${canAfford ? 'Обменять' : 'Мало'}</button>
    </div>`;
  }).join('');
}

async function doExchange(prizeId) {
  try {
    await apiFetch('/exchange', { method: 'POST', body: JSON.stringify({ prizeId }) });
    prizesCache = null;
    myStatsCache = null;
    showToast('✅ Заявка отправлена! Руководитель подтвердит.');
    tg.HapticFeedback && tg.HapticFeedback.notificationOccurred('success');

    // Refresh header stats
    const me = await apiFetch('/me');
    myStatsCache = me;
    updateHeaderStats({ availableCards: me.availableCards, coinBalance: me.coinBalance, uniqueHeroes: me.uniqueHeroes });
    renderPrizes();
  } catch (err) {
    showToast(err.message);
    tg.HapticFeedback && tg.HapticFeedback.notificationOccurred('error');
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
window.register = register;

window.addEventListener('error', event => {
  showBootError(event.error?.message || event.message || 'Ошибка запуска Mini App');
});

window.addEventListener('unhandledrejection', event => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  showBootError(message || 'Ошибка запуска Mini App');
});

window.addEventListener('DOMContentLoaded', () => {
  init().catch(err => {
    showBootError(err instanceof Error ? err.message : 'Ошибка запуска Mini App');
  });
});
