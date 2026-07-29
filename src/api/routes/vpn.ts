import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../../db/pool';
import {
  vpnConfigured, listPanelUsers, addPanelUser, panelUserDetail, panelUserAction,
  VpnEngineError, VpnEngineUnavailable, VPN_ACTIONS, VpnAction, pickVpnName,
} from '../../services/vpn.service';

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
    const [panelUsers, links, employees] = await Promise.all([
      listPanelUsers(),
      pool.query('SELECT employee_id, vpn_name FROM employee_vpn'),
      pool.query(`SELECT e.id, e.name, e.is_active, s.name AS store_name
                  FROM employees e LEFT JOIN stores s ON s.id = e.store_id`),
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
    res.json({ linked, unlinked, employeesWithoutVpn });
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
    const emp = await pool.query('SELECT id FROM employees WHERE id = $1', [employeeId]);
    if (!emp.rows.length) { res.status(400).json({ error: 'employee_not_found' }); return; }
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
    const emp = await pool.query('SELECT id, name FROM employees WHERE id = $1', [employeeId]);
    if (!emp.rows.length) { res.status(400).json({ error: 'employee_not_found' }); return; }
    if (await vpnNameByEmployee(employeeId)) { res.status(400).json({ error: 'already_linked' }); return; }

    const taken = new Set((await listPanelUsers()).map(u => u.name));
    const vpnName = pickVpnName((emp.rows[0] as { name: string }).name, taken);

    const created = await addPanelUser(vpnName);
    await pool.query(
      'INSERT INTO employee_vpn (employee_id, vpn_name) VALUES ($1, $2)', [employeeId, vpnName]);
    res.json({ ok: true, vpnName, code: created.code, tgText: created.tgText });
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

export default router;
