/** «Торт месяца»: топ-точка + лучший сотрудник сети, идемпотентность, порог MVP. */
jest.mock('../db/pool', () => ({ pool: { query: jest.fn() } }));
jest.mock('../services/mvpConfig.service', () => ({ getMvpConfig: jest.fn() }));
jest.mock('../services/audit.service', () => ({ logAudit: jest.fn(() => Promise.resolve()) }));

import { pool } from '../db/pool';
import { getMvpConfig } from '../services/mvpConfig.service';
import { awardMonthlyCakes } from '../services/cakePrize.service';

const mockQuery = pool.query as jest.Mock;
const mockCfg = getMvpConfig as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockCfg.mockResolvedValue({ mvpMinScore: 40 });
});

test('топ-точка + лучший сотрудник: оба приза created', async () => {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ storeId: 9, name: 'Баррикад', totalScore: '71.20' }] }) // is_top
    .mockResolvedValueOnce({ rows: [{ id: 1 }] })                                             // insert store prize
    .mockResolvedValueOnce({ rows: [{ employeeId: 31, name: 'Виталина', storeId: 2, mvpScore: '88.00' }] }) // best
    .mockResolvedValueOnce({ rows: [{ id: 2 }] });                                            // insert employee prize
  const w = await awardMonthlyCakes(2026, 7);
  expect(w).toHaveLength(2);
  expect(w[0]).toMatchObject({ kind: 'top_store', storeId: 9, created: true, score: 71.2 });
  expect(w[1]).toMatchObject({ kind: 'best_employee', employeeId: 31, created: true, score: 88 });
});

test('повторный прогон: ON CONFLICT ничего не вставил → created=false (без повторных уведомлений)', async () => {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ storeId: 9, name: 'Баррикад', totalScore: '71.20' }] })
    .mockResolvedValueOnce({ rows: [] })  // conflict
    .mockResolvedValueOnce({ rows: [{ employeeId: 31, name: 'Виталина', storeId: 2, mvpScore: '88.00' }] })
    .mockResolvedValueOnce({ rows: [] }); // conflict
  const w = await awardMonthlyCakes(2026, 7);
  expect(w.every(x => x.created === false)).toBe(true);
});

test('нет топ-точки → только сотрудник; сотрудник ниже mvpMinScore → без приза', async () => {
  mockQuery
    .mockResolvedValueOnce({ rows: [] })  // нет is_top
    .mockResolvedValueOnce({ rows: [{ employeeId: 5, name: 'Тест', storeId: 1, mvpScore: '12.00' }] });
  const w = await awardMonthlyCakes(2026, 7);
  expect(w).toHaveLength(0); // 12 < 40 — торт не уезжает кому попало
});
