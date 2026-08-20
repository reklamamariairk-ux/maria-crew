import type { Request } from 'express';
import { pool } from '../db/pool';

export type AdminWorkspace = 'office' | 'retail';

export function isOfficeWorkspace(req: Request): boolean {
  if (req.adminRole === 'office_admin') return true;
  return req.adminRole === 'superadmin'
    && String(req.header('x-workspace') ?? '').toLowerCase() === 'office';
}

export function workspaceForRequest(req: Request): AdminWorkspace {
  return isOfficeWorkspace(req) ? 'office' : 'retail';
}

export async function isStoreInWorkspace(storeId: number, workspace: AdminWorkspace): Promise<boolean> {
  if (!Number.isInteger(storeId) || storeId <= 0) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM stores WHERE id = $1 AND workspace = $2`,
    [storeId, workspace],
  );
  return rows.length === 1;
}

export async function isOfficeStore(storeId: number): Promise<boolean> {
  return isStoreInWorkspace(storeId, 'office');
}

export async function areEmployeesInWorkspace(
  employeeIds: number[],
  workspace: AdminWorkspace,
): Promise<boolean> {
  if (!employeeIds.length || employeeIds.some(id => !Number.isInteger(id) || id <= 0)) return false;
  const ids = [...new Set(employeeIds)];
  const { rows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM employees e
       LEFT JOIN stores s ON s.id = e.store_id
       LEFT JOIN office_employee_memberships oem ON oem.employee_id = e.id
      WHERE e.id = ANY($1::int[])
        AND (
          s.workspace = $2
          OR ($2 = 'office' AND oem.employee_id IS NOT NULL)
        )`,
    [ids, workspace],
  );
  return Number(rows[0]?.count ?? 0) === ids.length;
}

export async function areOfficeEmployees(employeeIds: number[]): Promise<boolean> {
  return areEmployeesInWorkspace(employeeIds, 'office');
}

export async function employeeWorkspace(employeeId: number): Promise<AdminWorkspace> {
  return (await employeeWorkspaceContext(employeeId)).workspace;
}

export async function employeeWorkspaceContext(employeeId: number): Promise<{
  workspace: AdminWorkspace;
  storeId: number | null;
}> {
  const { rows } = await pool.query<{
    workspace: string | null;
    officeMember: boolean;
    baseStoreId: number | null;
    officeStoreId: number | null;
  }>(
    `SELECT s.workspace,
            (oem.employee_id IS NOT NULL) AS "officeMember",
            e.store_id AS "baseStoreId",
            oem.office_store_id AS "officeStoreId"
       FROM employees e
       LEFT JOIN stores s ON s.id = e.store_id
       LEFT JOIN office_employee_memberships oem ON oem.employee_id = e.id
      WHERE e.id = $1`,
    [employeeId],
  );
  const row = rows[0];
  const workspace = row?.workspace === 'office' || row?.officeMember ? 'office' : 'retail';
  return {
    workspace,
    storeId: workspace === 'office' ? row?.officeStoreId ?? row?.baseStoreId ?? null : row?.baseStoreId ?? null,
  };
}
