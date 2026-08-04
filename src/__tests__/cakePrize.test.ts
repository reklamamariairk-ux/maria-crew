/** «Торт месяца»: топ-точка (пока приза вида нет) + все отмеченные is_mvp, ручное добавление. */
jest.mock('../db/pool', () => ({ pool: { query: jest.fn() } }));
jest.mock('../services/audit.service', () => ({ logAudit: jest.fn(() => Promise.resolve()) }));

import { pool } from '../db/pool';
import { awardMonthlyCakes, addManualCakePrize } from '../services/cakePrize.service';

const mockQuery = pool.query as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('awardMonthlyCakes', () => {
  test('первый прогон: топ-точка + ВСЕ отмеченные «Лучшие» (нескольким с одной точки), все created', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })  // существующих призов нет
      .mockResolvedValueOnce({ rows: [{ storeId: 9, name: 'Баррикад', totalScore: '71.20' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [  // все is_mvp месяца, двое с точки 2
        { employeeId: 31, name: 'Виталина', storeId: 2, mvpScore: '88.00' },
        { employeeId: 44, name: 'Ольга', storeId: 2, mvpScore: '75.50' },
        { employeeId: 57, name: 'Пётр', storeId: 5, mvpScore: null },
      ] })
      .mockResolvedValueOnce({ rows: [{ id: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 4 }] });
    const w = await awardMonthlyCakes(2026, 7);
    expect(w).toHaveLength(4);
    expect(w[0]).toMatchObject({ kind: 'top_store', storeId: 9, created: true, score: 71.2 });
    expect(w[1]).toMatchObject({ kind: 'best_employee', employeeId: 31, storeId: 2, created: true, score: 88 });
    expect(w[2]).toMatchObject({ kind: 'best_employee', employeeId: 44, storeId: 2, created: true, score: 75.5 });
    expect(w[3]).toMatchObject({ kind: 'best_employee', employeeId: 57, storeId: 5, created: true, score: null });
  });

  test('повторный прогон: старым created=false, отмеченному ПОСЛЕ прошлого прогона — created=true', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ kind: 'top_store' }, { kind: 'best_employee' }] })
      // top_store уже есть → селект точки пропускается; сразу is_mvp
      .mockResolvedValueOnce({ rows: [
        { employeeId: 31, name: 'Виталина', storeId: 2, mvpScore: '88.00' },
        { employeeId: 44, name: 'Ольга', storeId: 2, mvpScore: '75.50' },
      ] })
      .mockResolvedValueOnce({ rows: [] })          // Виталина: конфликт, торт уже был
      .mockResolvedValueOnce({ rows: [{ id: 9 }] }); // Ольга: отмечена позже — торт доезжает
    const w = await awardMonthlyCakes(2026, 7);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ employeeId: 31, created: false });
    expect(w[1]).toMatchObject({ employeeId: 44, created: true });
  });

  test('нет топ-точки и никто не отмечен → без призов', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })  // нет is_top
      .mockResolvedValueOnce({ rows: [] }); // нет is_mvp
    const w = await awardMonthlyCakes(2026, 7);
    expect(w).toHaveLength(0);
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
