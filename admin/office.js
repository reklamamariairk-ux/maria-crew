const officeState = {
  token: sessionStorage.getItem('mc_token') || '',
  role: sessionStorage.getItem('mc_role') || '',
  teamId: '',
  teams: [],
  operators: [],
  definitions: [],
  metricsPayload: null,
  currentTab: 'dashboard',
  requirePasswordChange: false,
};

const MONTHS = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function renderIcons() {
  if (window.lucide) window.lucide.createIcons();
}

let toastTimer;
function toast(message) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.classList.remove('hidden');
  requestAnimationFrame(() => element.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.classList.remove('show');
    setTimeout(() => element.classList.add('hidden'), 180);
  }, 3200);
}

async function api(method, path, body) {
  let response;
  try {
    response = await fetch(`/api/office${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${officeState.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Нет связи с сервером. Проверь интернет и попробуй снова.');
  }
  if (response.status === 401) {
    logout();
    throw new Error('Сессия завершена');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Ошибка ${response.status}`);
  return payload;
}

async function login() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const error = document.getElementById('login-error');
  error.textContent = '';
  if (!username || !password) { error.textContent = 'Введи логин и пароль'; return; }
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.token) throw new Error(data.error || 'Неверный логин или пароль');
    officeState.token = data.token;
    officeState.role = data.role || '';
    officeState.requirePasswordChange = !!data.mustChangePassword;
    sessionStorage.setItem('mc_token', officeState.token);
    sessionStorage.setItem('mc_role', officeState.role);
    if (officeState.role !== 'office_admin' && officeState.role !== 'superadmin') {
      window.location.assign('/');
      return;
    }
    await showApp();
    if (officeState.requirePasswordChange) openChangePasswordModal(true);
  } catch (err) { error.textContent = err.message || 'Не удалось войти'; }
}

function logout() {
  sessionStorage.removeItem('mc_token');
  sessionStorage.removeItem('mc_role');
  officeState.token = '';
  officeState.role = '';
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-screen').style.display = 'flex';
}

async function showApp() {
  let meta;
  try {
    const response = await fetch('/api/me/admin', { headers: { Authorization: `Bearer ${officeState.token}` } });
    if (!response.ok) throw new Error('unauthorized');
    meta = await response.json();
  } catch {
    logout();
    return;
  }
  officeState.role = meta.role;
  sessionStorage.setItem('mc_role', officeState.role);
  if (officeState.role !== 'office_admin' && officeState.role !== 'superadmin') {
    window.location.replace('/');
    return;
  }

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('retail-workspace-link').style.display = officeState.role === 'superadmin' ? 'inline-flex' : 'none';
  setupPeriods();
  await loadTeams();
  switchTab(localStorage.getItem('mc_office_last_tab') || 'dashboard');
  renderIcons();
}

function setupPeriods() {
  const irk = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const currentYear = irk.getUTCFullYear();
  const currentMonth = irk.getUTCMonth() + 1;
  const month = document.getElementById('metrics-month');
  const year = document.getElementById('metrics-year');
  if (!month.options.length) {
    for (let i = 1; i <= 12; i++) month.add(new Option(MONTHS[i], String(i)));
    for (let i = currentYear - 2; i <= currentYear + 1; i++) year.add(new Option(String(i), String(i)));
  }
  month.value = String(currentMonth);
  year.value = String(currentYear);
}

function switchTab(tab) {
  if (!document.getElementById(`tab-${tab}`)) tab = 'dashboard';
  document.querySelectorAll('.nav-item[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  officeState.currentTab = tab;
  localStorage.setItem('mc_office_last_tab', tab);
  closeSidebar();
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'operators') loadOperators();
  if (tab === 'metrics') loadMetricsWorkspace();
  if (tab === 'teams') renderTeams();
  renderIcons();
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('visible');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}

function teamQuery() {
  return officeState.teamId ? `?teamId=${encodeURIComponent(officeState.teamId)}` : '';
}

async function loadTeams() {
  try {
    officeState.teams = await api('GET', '/teams');
    const selects = [document.getElementById('team-select'), document.getElementById('mobile-team-select')];
    for (const select of selects) {
      const current = select.value;
      select.innerHTML = '<option value="">— Все команды —</option>' + officeState.teams
        .filter(team => team.isActive)
        .map(team => `<option value="${team.id}">${esc(team.name)}</option>`).join('');
      select.value = current;
    }
    const operatorTeam = document.getElementById('operator-team');
    operatorTeam.innerHTML = '<option value="">Без команды</option>' + officeState.teams
      .filter(team => team.isActive)
      .map(team => `<option value="${team.id}">${esc(team.name)}</option>`).join('');
    renderTeams();
  } catch (err) { toast(err.message); }
}

function onTeamChange() {
  officeState.teamId = document.getElementById('team-select').value;
  document.getElementById('mobile-team-select').value = officeState.teamId;
  refreshCurrentTab();
}
function onMobileTeamChange() {
  officeState.teamId = document.getElementById('mobile-team-select').value;
  document.getElementById('team-select').value = officeState.teamId;
  refreshCurrentTab();
}
function refreshCurrentTab() { switchTab(officeState.currentTab); }

function renderTeams() {
  const body = document.getElementById('teams-body');
  if (!body) return;
  body.innerHTML = officeState.teams.length ? officeState.teams.map(team => `
    <tr>
      <td><strong>${esc(team.name)}</strong></td>
      <td>${Number(team.activeOperators || 0)}</td>
      <td>${team.isActive ? '<span class="badge badge-approved">Активна</span>' : '<span class="badge badge-neutral">Отключена</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="renameTeam(${team.id})"><i data-lucide="pencil"></i></button>
        <button class="btn btn-ghost btn-sm" onclick="toggleTeam(${team.id}, ${!team.isActive})">${team.isActive ? 'Отключить' : 'Включить'}</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="4"><div class="office-empty">Добавьте первую офисную команду</div></td></tr>';
  renderIcons();
}

async function addTeam() {
  const input = document.getElementById('new-team-name');
  const name = input.value.trim();
  if (!name) { toast('Укажи название команды'); return; }
  try {
    await api('POST', '/teams', { name });
    input.value = '';
    await loadTeams();
    toast('✅ Команда добавлена');
  } catch (err) { toast(err.message); }
}

async function renameTeam(id) {
  const team = officeState.teams.find(item => item.id === id);
  if (!team) return;
  const name = prompt('Название команды', team.name);
  if (name === null || !name.trim()) return;
  try { await api('PUT', `/teams/${id}`, { name: name.trim() }); await loadTeams(); toast('✅ Сохранено'); }
  catch (err) { toast(err.message); }
}

async function toggleTeam(id, isActive) {
  try { await api('PUT', `/teams/${id}`, { isActive }); await loadTeams(); toast('✅ Сохранено'); }
  catch (err) { toast(err.message); }
}

async function loadOperators() {
  const body = document.getElementById('operators-body');
  body.innerHTML = '<tr><td colspan="6"><div class="office-empty">Загрузка...</div></td></tr>';
  try {
    officeState.operators = await api('GET', `/operators${teamQuery()}`);
    body.innerHTML = officeState.operators.length ? officeState.operators.map(operator => `
      <tr>
        <td><strong>${esc(operator.name)}</strong>${operator.notes ? `<div class="text-muted" style="font-size:11px">${esc(operator.notes)}</div>` : ''}</td>
        <td>${esc(operator.teamName || 'Без команды')}</td>
        <td><div>${esc(operator.phone || '—')}</div><div class="text-muted" style="font-size:11px">${esc(operator.email || '')}</div></td>
        <td>${operator.joinedAt ? esc(String(operator.joinedAt).slice(0, 10)) : '—'}</td>
        <td>${operator.isActive ? '<span class="badge badge-approved">Активен</span>' : '<span class="badge badge-neutral">Уволен</span>'}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="editOperator(${operator.id})"><i data-lucide="pencil"></i></button><button class="btn btn-ghost btn-sm" onclick="toggleOperator(${operator.id}, ${!operator.isActive})">${operator.isActive ? 'Уволить' : 'Вернуть'}</button></td>
      </tr>`).join('') : '<tr><td colspan="6"><div class="office-empty">В этой выборке пока нет операторов</div></td></tr>';
    renderIcons();
  } catch (err) { body.innerHTML = `<tr><td colspan="6"><div class="office-empty">${esc(err.message)}</div></td></tr>`; }
}

function openOperatorForm(operator = null) {
  document.getElementById('operator-form').classList.remove('hidden');
  document.getElementById('operator-form-title').textContent = operator ? 'Редактировать оператора' : 'Новый оператор';
  document.getElementById('operator-id').value = operator?.id || '';
  document.getElementById('operator-name').value = operator?.name || '';
  document.getElementById('operator-team').value = operator?.teamId || officeState.teamId || '';
  document.getElementById('operator-phone').value = operator?.phone || '';
  document.getElementById('operator-email').value = operator?.email || '';
  document.getElementById('operator-joined').value = operator?.joinedAt ? String(operator.joinedAt).slice(0, 10) : '';
  document.getElementById('operator-notes').value = operator?.notes || '';
  document.getElementById('operator-name').focus();
}
function closeOperatorForm() { document.getElementById('operator-form').classList.add('hidden'); }
function editOperator(id) { const operator = officeState.operators.find(item => item.id === id); if (operator) openOperatorForm(operator); }

async function saveOperator() {
  const id = document.getElementById('operator-id').value;
  const body = {
    name: document.getElementById('operator-name').value.trim(),
    teamId: document.getElementById('operator-team').value || null,
    phone: document.getElementById('operator-phone').value.trim() || null,
    email: document.getElementById('operator-email').value.trim() || null,
    joinedAt: document.getElementById('operator-joined').value || null,
    notes: document.getElementById('operator-notes').value.trim() || null,
  };
  if (!body.name) { toast('Укажи имя оператора'); return; }
  try {
    await api(id ? 'PUT' : 'POST', id ? `/operators/${id}` : '/operators', body);
    closeOperatorForm();
    await loadOperators();
    toast('✅ Оператор сохранён');
  } catch (err) { toast(err.message); }
}

async function toggleOperator(id, isActive) {
  const action = isActive ? 'вернуть оператора' : 'уволить оператора';
  if (!confirm(`Точно ${action}?`)) return;
  try { await api('PUT', `/operators/${id}`, { isActive }); await loadOperators(); toast('✅ Сохранено'); }
  catch (err) { toast(err.message); }
}

async function loadDefinitions() {
  officeState.definitions = await api('GET', '/metric-definitions');
  renderDefinitions();
}

function renderDefinitions() {
  const body = document.getElementById('metric-definitions-body');
  body.innerHTML = officeState.definitions.length ? officeState.definitions.map(definition => `
    <tr>
      <td><input id="def-name-${definition.id}" class="input" value="${esc(definition.name)}" maxlength="100"></td>
      <td><input id="def-unit-${definition.id}" class="input" value="${esc(definition.unit)}" maxlength="24" style="width:90px"></td>
      <td><input id="def-target-${definition.id}" class="input" type="number" min="0" step="0.01" value="${definition.targetValue}" style="width:100px"></td>
      <td><input id="def-weight-${definition.id}" class="input" type="number" min="0" max="100" step="0.1" value="${definition.weight}" style="width:84px"></td>
      <td><select id="def-direction-${definition.id}" class="input"><option value="higher"${definition.direction === 'higher' ? ' selected' : ''}>Выше</option><option value="lower"${definition.direction === 'lower' ? ' selected' : ''}>Ниже</option></select></td>
      <td>${definition.isActive ? '<span class="badge badge-approved">Активен</span>' : '<span class="badge badge-neutral">Отключён</span>'}</td>
      <td style="text-align:right;white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="saveDefinition(${definition.id})"><i data-lucide="save"></i></button><button class="btn btn-ghost btn-sm" onclick="toggleDefinition(${definition.id}, ${!definition.isActive})">${definition.isActive ? 'Отключить' : 'Включить'}</button></td>
    </tr>`).join('') : '<tr><td colspan="7"><div class="office-empty">Добавьте показатели, по которым оцениваются операторы</div></td></tr>';
  renderIcons();
}

async function addMetricDefinition() {
  const body = {
    name: document.getElementById('metric-name').value.trim(),
    unit: document.getElementById('metric-unit').value.trim(),
    targetValue: Number(document.getElementById('metric-target').value),
    weight: Number(document.getElementById('metric-weight').value),
    direction: document.getElementById('metric-direction').value,
  };
  if (!body.name) { toast('Укажи название показателя'); return; }
  try {
    await api('POST', '/metric-definitions', body);
    document.getElementById('metric-name').value = '';
    document.getElementById('metric-unit').value = '';
    await loadDefinitions();
    await loadMetrics();
    toast('✅ Показатель добавлен');
  } catch (err) { toast(err.message); }
}

async function saveDefinition(id) {
  const body = {
    name: document.getElementById(`def-name-${id}`).value.trim(),
    unit: document.getElementById(`def-unit-${id}`).value.trim(),
    targetValue: Number(document.getElementById(`def-target-${id}`).value),
    weight: Number(document.getElementById(`def-weight-${id}`).value),
    direction: document.getElementById(`def-direction-${id}`).value,
  };
  try { await api('PUT', `/metric-definitions/${id}`, body); await loadDefinitions(); await loadMetrics(); toast('✅ Показатель сохранён'); }
  catch (err) { toast(err.message); }
}

async function toggleDefinition(id, isActive) {
  try { await api('PUT', `/metric-definitions/${id}`, { isActive }); await loadDefinitions(); await loadMetrics(); toast('✅ Сохранено'); }
  catch (err) { toast(err.message); }
}

async function loadMetricsWorkspace() {
  try { await loadDefinitions(); await loadMetrics(); }
  catch (err) { toast(err.message); }
}

async function loadMetrics() {
  const year = document.getElementById('metrics-year').value;
  const month = document.getElementById('metrics-month').value;
  if (!year || !month) return;
  const params = new URLSearchParams({ year, month });
  if (officeState.teamId) params.set('teamId', officeState.teamId);
  try {
    officeState.metricsPayload = await api('GET', `/metrics?${params}`);
    const definitions = officeState.metricsPayload.definitions;
    const operators = officeState.metricsPayload.operators;
    document.getElementById('metrics-head').innerHTML = `<tr><th>Оператор</th><th>Команда</th>${definitions.map(definition => `<th title="Норма: ${definition.targetValue}; вес: ${definition.weight}">${esc(definition.name)}${definition.unit ? `<br><span class="text-muted" style="font-size:10px">${esc(definition.unit)}</span>` : ''}</th>`).join('')}<th>Балл</th></tr>`;
    document.getElementById('metrics-body').innerHTML = operators.length ? operators.map(operator => `
      <tr><td><strong>${esc(operator.name)}</strong></td><td>${esc(operator.teamName || 'Без команды')}</td>${definitions.map(definition => `<td><input class="input office-metric-input" type="number" step="0.01" data-operator="${operator.id}" data-metric="${definition.id}" value="${operator.values[definition.id] ?? ''}"></td>`).join('')}<td class="office-score">${operator.score === null ? '—' : `${operator.score}`}</td></tr>`).join('') : `<tr><td colspan="${definitions.length + 3}"><div class="office-empty">Добавьте активных операторов</div></td></tr>`;
  } catch (err) { toast(err.message); }
}

async function saveMetrics() {
  const payload = officeState.metricsPayload;
  if (!payload) return;
  const items = payload.operators.map(operator => {
    const values = {};
    payload.definitions.forEach(definition => {
      const input = document.querySelector(`[data-operator="${operator.id}"][data-metric="${definition.id}"]`);
      values[definition.id] = input && input.value !== '' ? Number(input.value) : null;
    });
    return { operatorId: operator.id, values };
  });
  try {
    await api('PUT', '/metrics', { year: payload.year, month: payload.month, items });
    await loadMetrics();
    toast('✅ Метрики сохранены');
  } catch (err) { toast(err.message); }
}

async function loadDashboard() {
  try {
    const data = await api('GET', `/dashboard${teamQuery()}`);
    document.getElementById('dash-operators').textContent = data.activeOperators;
    document.getElementById('dash-teams').textContent = data.activeTeams;
    document.getElementById('dash-metrics').textContent = `${data.metricsFilled}/${data.activeOperators}`;
    document.getElementById('dash-period').textContent = `${MONTHS[data.month].toLowerCase()} ${data.year}`;
    const selected = officeState.teams.find(team => String(team.id) === String(officeState.teamId));
    document.getElementById('dash-scope').textContent = selected?.name || 'Все команды';
    document.getElementById('dash-top').innerHTML = data.topOperators.length ? data.topOperators.map((operator, index) => `
      <div class="office-top-row"><div class="office-rank">${index + 1}</div><div class="office-top-main"><div class="office-top-name">${esc(operator.name)}</div><div class="office-top-team">${esc(operator.teamName || 'Без команды')}</div></div><div class="office-score">${operator.score}</div></div>`).join('') : '<div class="office-empty">Нет заполненных метрик за текущий месяц</div>';
  } catch (err) { toast(err.message); }
  renderIcons();
}

function openChangePasswordModal(forced = false) {
  officeState.requirePasswordChange = forced || officeState.requirePasswordChange;
  document.getElementById('cpw-old').value = '';
  document.getElementById('cpw-new').value = '';
  document.getElementById('cpw-hint').textContent = forced ? 'Это временный пароль — задай постоянный.' : 'Минимум 8 символов.';
  document.getElementById('cpw-close-btn').style.display = forced ? 'none' : '';
  document.getElementById('cpw-cancel').style.display = forced ? 'none' : '';
  document.getElementById('modal-change-password').classList.remove('hidden');
  renderIcons();
}
function closeChangePasswordModal() { if (!officeState.requirePasswordChange) document.getElementById('modal-change-password').classList.add('hidden'); }

async function submitChangePassword() {
  const oldPassword = document.getElementById('cpw-old').value;
  const newPassword = document.getElementById('cpw-new').value;
  if (!oldPassword || !newPassword) { toast('Заполни оба поля'); return; }
  if (newPassword.length < 8) { toast('Минимум 8 символов'); return; }
  try {
    const response = await fetch('/api/auth/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${officeState.token}` },
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Не удалось сменить пароль');
    officeState.requirePasswordChange = false;
    document.getElementById('modal-change-password').classList.add('hidden');
    toast('✅ Пароль обновлён');
  } catch (err) { toast(err.message); }
}

window.addEventListener('DOMContentLoaded', () => {
  renderIcons();
  if (officeState.token) showApp();
});
