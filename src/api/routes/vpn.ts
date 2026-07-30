import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import {
  vpnConfigured, listPanelUsers, addPanelUser, bulkAddPanelUsers, panelUserDetail, panelUserAction, panelApplyStatus,
  deletePanelUser, VpnEngineError, VpnEngineUnavailable, VPN_ACTIONS, VpnAction, pickVpnName,
} from '../../services/vpn.service';
import { sendBroadcast } from '../../bot/notifications/sender';

// Управление VPN из админки crew (только superadmin — навешено в router.ts).
// crew хранит маппинг employee_vpn, vpn-panel — сам движок ключей.

const router = Router();

function handlePanelError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof VpnEngineUnavailable) {
    res.status(502).json({ error: 'vpn_engine_unavailable' });
  } else if (err instanceof VpnEngineError) {
    res.status(err.status).json(err.body ?? { error: 'vpn_engine_error' });
  } else {
    next(err);
  }
}

async function vpnNameByEmployee(employeeId: number): Promise<string | null> {
  const r = await pool.query('SELECT vpn_name FROM employee_vpn WHERE employee_id = $1', [employeeId]);
  return r.rows.length ? (r.rows[0] as { vpnName: string }).vpnName : null;
}

// GET /api/vpn/overview — всё для вкладки VPN и экрана связки.
router.get('/overview', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!vpnConfigured()) { res.status(502).json({ error: 'vpn_engine_unavailable' }); return; }
    const [panelUsers, links, employees, applyStatus] = await Promise.all([
      listPanelUsers(),
      pool.query('SELECT employee_id, vpn_name FROM employee_vpn'),
      pool.query(`SELECT e.id, e.name, e.is_active, e.telegram_id IS NOT NULL AS has_telegram,
                         s.name AS store_name
                  FROM employees e LEFT JOIN stores s ON s.id = e.store_id`),
      panelApplyStatus().catch(() => ({ error: null })),
    ]);
    const byVpnName = new Map(links.rows.map((l: { employeeId: number; vpnName: string }) => [l.vpnName, l.employeeId]));
    const empById = new Map(employees.rows.map((e: { id: number }) => [e.id, e]));
    const linked = [];
    const unlinked = [];
    for (const pu of panelUsers) {
      const employeeId = byVpnName.get(pu.name);
      if (employeeId !== undefined && empById.has(employeeId)) {
        linked.push({ ...pu, employee: empById.get(employeeId) });
      } else {
        unlinked.push(pu);
      }
    }
    const linkedEmployeeIds = new Set(byVpnName.values());
    const employeesWithoutVpn = employees.rows.filter(
      (e: { id: number; isActive: boolean }) => !linkedEmployeeIds.has(e.id) && e.isActive);
    res.json({ linked, unlinked, employeesWithoutVpn, applyError: applyStatus.error });
  } catch (err) { handlePanelError(err, res, next); }
});

// POST /api/vpn/link {employeeId, vpnName} — связать существующего vpn-юзера.
router.post('/link', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const employeeId = Number(req.body?.employeeId);
    const vpnName = String(req.body?.vpnName ?? '').trim();
    if (!Number.isInteger(employeeId) || !vpnName) { res.status(400).json({ error: 'bad_request' }); return; }
    const panelUsers = await listPanelUsers();
    if (!panelUsers.some(u => u.name === vpnName)) { res.status(400).json({ error: 'vpn_user_not_found' }); return; }
    const emp = await pool.query('SELECT id, fired_at FROM employees WHERE id = $1', [employeeId]);
    if (!emp.rows.length) { res.status(400).json({ error: 'employee_not_found' }); return; }
    if (emp.rows[0].firedAt) { res.status(403).json({ error: 'employee_fired' }); return; }
    await pool.query(
      'INSERT INTO employee_vpn (employee_id, vpn_name) VALUES ($1, $2)', [employeeId, vpnName]);
    res.json({ ok: true });
  } catch (err) {
    // UNIQUE violation → уже связан (сотрудник или vpn-имя)
    if ((err as { code?: string }).code === '23505') { res.status(400).json({ error: 'already_linked' }); return; }
    handlePanelError(err, res, next);
  }
});

// DELETE /api/vpn/link/:employeeId — отвязать (ключ в панели остаётся, просто без связи).
router.delete('/link/:employeeId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await pool.query('DELETE FROM employee_vpn WHERE employee_id = $1', [Number(req.params.employeeId)]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/vpn/issue {employeeId} — создать vpn-юзера по имени сотрудника + связать.
router.post('/issue', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const employeeId = Number(req.body?.employeeId);
    if (!Number.isInteger(employeeId)) { res.status(400).json({ error: 'bad_request' }); return; }
    const emp = await pool.query('SELECT id, name, fired_at FROM employees WHERE id = $1', [employeeId]);
    if (!emp.rows.length) { res.status(400).json({ error: 'employee_not_found' }); return; }
    if (emp.rows[0].firedAt) { res.status(403).json({ error: 'employee_fired' }); return; }
    if (await vpnNameByEmployee(employeeId)) { res.status(400).json({ error: 'already_linked' }); return; }

    const taken = new Set((await listPanelUsers()).map(u => u.name));
    const vpnName = pickVpnName((emp.rows[0] as { name: string }).name, taken);

    const created = await addPanelUser(vpnName);
    await pool.query(
      'INSERT INTO employee_vpn (employee_id, vpn_name) VALUES ($1, $2)', [employeeId, vpnName]);
    res.json({ ok: true, vpnName, code: created.code, tgText: created.tgText });
  } catch (err) { handlePanelError(err, res, next); }
});

// POST /api/vpn/issue-bulk {employeeIds:[]} — массовая выдача + рассылка кодов в TG.
router.post('/issue-bulk', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const ids: number[] = Array.isArray(req.body?.employeeIds)
      ? req.body.employeeIds.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) { res.status(400).json({ error: 'bad_request' }); return; }

    const [emps, links, panelUsers] = await Promise.all([
      pool.query(`SELECT id, name, telegram_id::text AS telegram_id, fired_at FROM employees WHERE id = ANY($1)`, [ids]),
      pool.query('SELECT employee_id FROM employee_vpn'),
      listPanelUsers(),
    ]);
    const linkedIds = new Set(links.rows.map((l: { employeeId: number }) => l.employeeId));
    const taken = new Set(panelUsers.map(u => u.name));

    type Plan = { employeeId: number; name: string; vpnName: string; telegramId: string | null };
    const plan: Plan[] = [];
    const results: Array<Record<string, unknown>> = [];
    for (const e of emps.rows as Array<{ id: number; name: string; telegramId: string | null; firedAt?: string | null }>) {
      if (e.firedAt) { results.push({ employeeId: e.id, name: e.name, error: 'employee_fired' }); continue; }
      if (linkedIds.has(e.id)) { results.push({ employeeId: e.id, name: e.name, error: 'already_linked' }); continue; }
      const vpnName = pickVpnName(e.name, taken);
      taken.add(vpnName);
      plan.push({ employeeId: e.id, name: e.name, vpnName, telegramId: e.telegramId });
    }
    if (plan.length) {
      const bulk = await bulkAddPanelUsers(plan.map(p => p.vpnName));
      const createdByName = new Map(bulk.created.map(c => [c.name, c]));
      for (const p of plan) {
        const c = createdByName.get(p.vpnName);
        if (!c) {
          results.push({ employeeId: p.employeeId, name: p.name,
            error: bulk.errors.find(er => er.name === p.vpnName)?.error ?? 'issue_failed' });
          continue;
        }
        await pool.query('INSERT INTO employee_vpn (employee_id, vpn_name) VALUES ($1, $2)',
          [p.employeeId, p.vpnName]);
        let sent = false;
        if (p.telegramId) {
          // Персональное сообщение с кодом — по одному, бот сам переживает rate limit
          const r = await sendBroadcast([p.telegramId], c.tgText);
          sent = r.sent === 1;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        results.push({ employeeId: p.employeeId, name: p.name, vpnName: p.vpnName, code: c.code, sent });
      }
    }
    const issued = results.filter(r => r.code).length;
    const sentCount = results.filter(r => r.sent).length;
    res.json({ issued, sent: sentCount, results });
  } catch (err) { handlePanelError(err, res, next); }
});

// POST /api/vpn/issue-external {name} — VPN человеку вне crew (офис, подрядчик):
// юзер в панели без маппинга. Код показываем админу, TG-рассылки нет.
router.post('/issue-external', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.includes('/')) { res.status(400).json({ error: 'bad_request' }); return; }
    const taken = new Set((await listPanelUsers()).map(u => u.name));
    const vpnName = pickVpnName(name, taken);
    const created = await addPanelUser(vpnName);
    res.json({ ok: true, vpnName, code: created.code, tgText: created.tgText });
  } catch (err) { handlePanelError(err, res, next); }
});

// GET /api/vpn/external/:name — detail внешнего (непривязанного) vpn-юзера.
router.get('/external/:name', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const detail = await panelUserDetail(String(req.params.name));
    res.json({ linked: false, vpnName: String(req.params.name), ...detail });
  } catch (err) { handlePanelError(err, res, next); }
});

// POST /api/vpn/external/:name/:action(*) — действия панели для внешнего юзера.
router.post(/^\/external\/([^/]+)\/(.+)$/, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Express сам декодирует path-параметры; raw оставляем как fallback
    const name = (req.params as Record<string, string>)['0'];
    const action = (req.params as Record<string, string>)['1'];
    if (!VPN_ACTIONS.includes(action as VpnAction)) { res.status(400).json({ error: 'unknown_action' }); return; }
    res.json(await panelUserAction(name, action as VpnAction));
  } catch (err) { handlePanelError(err, res, next); }
});

// GET /api/vpn/employee/:id — карточка VPN сотрудника (detail панели).
router.get('/employee/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const vpnName = await vpnNameByEmployee(Number(req.params.id));
    if (!vpnName) { res.json({ linked: false }); return; }
    const detail = await panelUserDetail(vpnName);
    res.json({ linked: true, vpnName, ...detail });
  } catch (err) { handlePanelError(err, res, next); }
});

// POST /api/vpn/employee/:id/:action(*) — прокси действий панели по whitelist.
router.post(/^\/employee\/(\d+)\/(.+)$/, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Regex-роут: захваты лежат в params под числовыми ключами
    const idStr = (req.params as Record<string, string>)['0'];
    const action = (req.params as Record<string, string>)['1'];
    if (!VPN_ACTIONS.includes(action as VpnAction)) { res.status(400).json({ error: 'unknown_action' }); return; }
    const vpnName = await vpnNameByEmployee(Number(idStr));
    if (!vpnName) { res.status(400).json({ error: 'not_linked' }); return; }
    res.json(await panelUserAction(vpnName, action as VpnAction));
  } catch (err) { handlePanelError(err, res, next); }
});

// DELETE /api/vpn/employee/:id — полностью удалить VPN-доступ сотрудника:
// юзер стирается из панели (порты/ключи/коды), маппинг и дедуп-след уведомлений
// чистятся. Необратимо; «Выдать VPN» после этого создаст всё заново.
router.delete('/employee/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const employeeId = Number(req.params.id);
    if (!Number.isInteger(employeeId)) { res.status(400).json({ error: 'bad_request' }); return; }
    const vpnName = await vpnNameByEmployee(employeeId);
    if (!vpnName) { res.status(400).json({ error: 'not_linked' }); return; }
    await deletePanelUser(vpnName);
    await pool.query('DELETE FROM employee_vpn WHERE employee_id = $1', [employeeId]);
    await pool.query('DELETE FROM vpn_conflict_notified WHERE vpn_name = $1', [vpnName]);
    res.json({ ok: true });
  } catch (err) { handlePanelError(err, res, next); }
});

// DELETE /api/vpn/external/:name — то же для внешнего (вне crew) юзера панели.
router.delete('/external/:name', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const name = String(req.params.name ?? '').trim();
    if (!name) { res.status(400).json({ error: 'bad_request' }); return; }
    await deletePanelUser(name);
    await pool.query('DELETE FROM employee_vpn WHERE vpn_name = $1', [name]);
    await pool.query('DELETE FROM vpn_conflict_notified WHERE vpn_name = $1', [name]);
    res.json({ ok: true });
  } catch (err) { handlePanelError(err, res, next); }
});

export default router;
