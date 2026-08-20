/**
 * РЕГРЕСС на баг 30.07.2026: входящее сообщение сотрудника падало в РАССЫЛКУ
 * (где он 1 из N получателей), а не в его личный чат. Эти тесты держат инвариант
 * «входящее от сотрудника всегда идёт в личный тред, рассылки — только исходящие».
 * Интеграционные — реальный SQL через pg-mem, ловят именно логику маршрутизации.
 */
import { newTestPool, seedEmployee, TestPool } from './setup';

let testPool: TestPool;
jest.mock('../../db/pool', () => ({
  get pool() { return testPool; },
}));

import {
  createEmployeeInitiatedRequest,
  sendEmployeeMessage,
} from '../../services/employeeChat.service';

beforeEach(() => {
  ({ pool: testPool } = newTestPool());
});

// хелпер: создать рассылку на список сотрудников (как /api/requests массовая)
async function seedBroadcast(employeeIds: number[], text = 'Объявление всем'): Promise<number> {
  const { rows } = await testPool.query(
    `INSERT INTO employee_requests (requested_by, target_employee_id, target_store_id, initiated_by_employee_id, request_text)
     VALUES (1, NULL, NULL, NULL, $1) RETURNING id`, [text]);
  const reqId = (rows[0] as { id: number }).id;
  for (const eid of employeeIds) {
    await testPool.query(`INSERT INTO request_targets (request_id, employee_id) VALUES ($1, $2)`, [reqId, eid]);
  }
  return reqId;
}

async function countResponses(requestId: number): Promise<number> {
  const { rows } = await testPool.query(`SELECT COUNT(*)::int AS n FROM request_responses WHERE request_id = $1`, [requestId]);
  return (rows[0] as { n: number }).n;
}

describe('createEmployeeInitiatedRequest: входящее НЕ падает в рассылку', () => {
  it('сотрудник — получатель рассылки — пишет сам → создаётся ЛИЧНЫЙ тред, рассылка не тронута', async () => {
    const { employeeId, storeId } = await seedEmployee(testPool, { name: 'Аня' });
    const { employeeId: e2 } = await seedEmployee(testPool, { name: 'Борис', storeId });
    const bcastId = await seedBroadcast([employeeId, e2], 'Челлендж месяца');

    const { requestId } = await createEmployeeInitiatedRequest({ employeeId, text: 'Привет, вопрос по бонусам' });

    // главное: НЕ рассылка
    expect(requestId).not.toBe(bcastId);
    // в рассылке ноль ответов сотрудника
    expect(await countResponses(bcastId)).toBe(0);
    // созданный тред — личный входящий (initiated_by_employee_id = сотрудник)
    const { rows } = await testPool.query(
      `SELECT initiated_by_employee_id AS "initiatedBy", target_store_id AS "storeId", request_text AS "text"
       FROM employee_requests WHERE id = $1`, [requestId]);
    expect((rows[0] as { initiatedBy: number }).initiatedBy).toBe(employeeId);
    expect((rows[0] as { storeId: number | null }).storeId).toBeNull();
    expect((rows[0] as { text: string }).text).toContain('вопрос по бонусам');
  });

  it('повторное сообщение сотрудника продолжает ТОТ ЖЕ личный тред (не плодит новые)', async () => {
    const { employeeId } = await seedEmployee(testPool, { name: 'Вера' });
    await seedBroadcast([employeeId]); // есть рассылка-приманка

    const first = await createEmployeeInitiatedRequest({ employeeId, text: 'Первое' });
    const second = await createEmployeeInitiatedRequest({ employeeId, text: 'Второе' });

    expect(second.requestId).toBe(first.requestId);
    const { rows } = await testPool.query(`SELECT COUNT(*)::int AS n FROM employee_requests WHERE initiated_by_employee_id = $1`, [employeeId]);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('сотрудник продолжает свой DIRECT-чат (админ→он), а не создаёт второй тред', async () => {
    const { employeeId } = await seedEmployee(testPool, { name: 'Галя' });
    // direct-чат: target_employee_id = сотрудник + запись в request_targets
    const { rows: dr } = await testPool.query(
      `INSERT INTO employee_requests (requested_by, target_employee_id, request_text, status)
       VALUES (1, $1, '', 'open') RETURNING id`, [employeeId]);
    const directId = (dr[0] as { id: number }).id;
    await testPool.query(`INSERT INTO request_targets (request_id, employee_id) VALUES ($1, $2)`, [directId, employeeId]);

    const { requestId } = await createEmployeeInitiatedRequest({ employeeId, text: 'Отвечаю менеджеру' });
    expect(requestId).toBe(directId);
  });

  it('закрытый личный тред не переиспользуется — заводится новый открытый', async () => {
    const { employeeId } = await seedEmployee(testPool, { name: 'Дима' });
    await testPool.query(
      `INSERT INTO employee_requests (initiated_by_employee_id, request_text, status)
       VALUES ($1, 'Старое', 'closed')`, [employeeId]);

    const { requestId } = await createEmployeeInitiatedRequest({ employeeId, text: 'Новое обращение' });
    const { rows } = await testPool.query(`SELECT status FROM employee_requests WHERE id = $1`, [requestId]);
    expect((rows[0] as { status: string }).status).toBe('open');
  });

  it('после добавления в офис сотрудник не продолжает розничный диалог', async () => {
    const { employeeId } = await seedEmployee(testPool, { name: 'Оператор' });
    const retail = await createEmployeeInitiatedRequest({ employeeId, text: 'Розничный диалог' });
    const { rows: officeStores } = await testPool.query(
      `INSERT INTO stores (name, workspace) VALUES ('Офис', 'office') RETURNING id`,
    );
    const officeStoreId = (officeStores[0] as { id: number }).id;
    await testPool.query(
      `INSERT INTO office_employee_memberships (employee_id, office_store_id) VALUES ($1, $2)`,
      [employeeId, officeStoreId],
    );

    const office = await createEmployeeInitiatedRequest({ employeeId, text: 'Офисный диалог' });

    expect(office.requestId).not.toBe(retail.requestId);
    const { rows } = await testPool.query(
      `SELECT workspace FROM employee_requests WHERE id = $1`, [office.requestId],
    );
    expect((rows[0] as { workspace: string }).workspace).toBe('office');
  });
});

describe('sendEmployeeMessage: доступ только к своим тредам', () => {
  it('сотрудник может писать в рассылку, где он получатель (ответ на объявление)', async () => {
    const { employeeId } = await seedEmployee(testPool, { name: 'Женя' });
    const bcastId = await seedBroadcast([employeeId]);
    const res = await sendEmployeeMessage({ requestId: bcastId, employeeId, text: 'Понял, спасибо' });
    expect(res).not.toBeNull();
  });

  it('чужой тред недоступен (не получатель и не инициатор) → null', async () => {
    const { employeeId } = await seedEmployee(testPool, { name: 'Зоя' });
    const { employeeId: other } = await seedEmployee(testPool, { name: 'Костя' });
    const bcastId = await seedBroadcast([other]); // Костин, не Зоин
    const res = await sendEmployeeMessage({ requestId: bcastId, employeeId, text: 'лезу не в свой чат' });
    expect(res).toBeNull();
  });
});
