/** «Торт месяца»: авто-выдача (только пока приза вида нет), ручное добавление, пороги. */
jest.mock('../db/pool', () => ({ pool: { query: jest.fn() } }));
jest.mock('../services/mvpConfig.service', () => ({ getMvpConfig: jest.fn() }));
jest.mock('../services/audit.service', () => ({ logAudit: jest.fn(() => Promise.resolve()) }));

import { pool } from '../db/pool';
import { getMvpConfig } from '../services/mvpConfig.service';
import { awardMonthlyCakes, addManualCakePrize } from '../services/cakePrize.service';

const mockQuery = pool.query as jest.Mock;
const mockCfg = getMvpConfig as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockCfg.mockResolvedValue({ mvpMinScore: 40 });
});

describe('awardMonthlyCakes', () => {
  test('первый прогон: топ-точка + лучший сотрудник, оба created', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })  // существующих призов нет
      .mockResolvedValueOnce({ rows: [{ storeId: 9, name: 'Баррикад', totalScore: '71.20' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ employeeId: 31, name: 'Виталина', storeId: 2, mvpScore: '88.00' }] })
      .mockResolvedValueOnce({ rows: [{ id: 2 }] });
    const w = await awardMonthlyCakes(2026, 7);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ kind: 'top_store', storeId: 9, created: true, score: 71.2 });
    expect(w[1]).toMatchObject({ kind: 'best_employee', employeeId: 31, created: true, score: 88 });
  });

  test('повторный прогон: призы вида уже есть → авто ничего не добавляет (и не шлёт)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ kind: 'top_store' }, { kind: 'best_employee' }] });
    const w = await awardMonthlyCakes(2026, 7);
    expect(w).toHaveLength(0);
    expect(mockQuery).toHaveBeenCalledTimes(1); // дальше даже не ходили
  });

  test('нет топ-точки; сотрудник ниже mvpMinScore → без призов', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })  // нет is_top
      .mockResolvedValueOnce({ rows: [{ employeeId: 5, name: 'Тест', storeId: 1, mvpScore: '12.00' }] });
    const w = await awardMonthlyCakes(2026, 7);
    expect(w).toHaveLength(0); // 12 < 40 — торт не уезжает кому попало
  });
});

describe('addManualCakePrize — «добавить ещё одного сотрудника»', () => {
  test('добавляет: created=true, баллы месяца подтянуты', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'Мария П.', storeId: 3, firedAt: null }] })
      .mockResolvedValueOnce({ rows: [{ mvpScore: '55.50' }] })
      .mockResolvedValueOnce({ rows: [{ id: 10 }] });
    const w = await addManualCakePrize(2026, 7, 7, 'admin#1');
    expect(w).toMatchObject({ kind: 'best_employee', employeeId: 7, created: true, score: 55.5 });
  });

  test('дубль того же сотрудника в месяце → created=false', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'Мария П.', storeId: 3, firedAt: null }] })
      .mockResolvedValueOnce({ rows: [] })   // без метрик месяца — score null
      .mockResolvedValueOnce({ rows: [] });  // conflict
    const w = await addManualCakePrize(2026, 7, 7);
    expect(w).toMatchObject({ created: false, score: null });
  });

  test('уволенному нельзя → null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 7, name: 'Экс', storeId: 3, firedAt: '2026-07-30' }] });
    expect(await addManualCakePrize(2026, 7, 7)).toBeNull();
  });
});
