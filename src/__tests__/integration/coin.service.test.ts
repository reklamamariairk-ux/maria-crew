import { newTestPool, seedEmployee, TestPool } from './setup';

// Подменяем pool в db/pool на тестовый — каждый describe-блок свой.
let testPool: TestPool;
jest.mock('../../db/pool', () => ({
  get pool() { return testPool; },
  camelizeRow: <T,>(row: Record<string, unknown>): T => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
    }
    return out as T;
  },
}));

// Импорт ПОСЛЕ jest.mock — иначе сервис захватит настоящий pool.
import { earn, spend, getBalance } from '../../services/coin.service';

beforeEach(() => {
  ({ pool: testPool } = newTestPool());
});

describe('coin.service: earn', () => {
  it('начисляет монеты + getBalance возвращает сумму', async () => {
    const { employeeId } = await seedEmployee(testPool);

    await earn({ employeeId, reason: 'quiz' });
    await earn({ employeeId, reason: 'quiz' });
    await earn({ employeeId, reason: 'review' }); // +10

    const balance = await getBalance(employeeId);
    expect(balance).toBe(1 + 1 + 10); // 2 монеты от quiz + 10 за review
  });

  it('manual с явной суммой работает', async () => {
    const { employeeId } = await seedEmployee(testPool);

    await earn({ employeeId, reason: 'manual', amount: 50, note: 'Премия' });
    expect(await getBalance(employeeId)).toBe(50);
  });

  it('бросает если сумма = 0', async () => {
    const { employeeId } = await seedEmployee(testPool);

    await expect(earn({ employeeId, reason: 'manual', amount: 0 }))
      .rejects.toThrow(/не может быть равна нулю/i);
  });
});

describe('coin.service: списания (отрицательные суммы)', () => {
  it('штраф bad_review = -5: списывает с положительного баланса', async () => {
    const { employeeId } = await seedEmployee(testPool);

    // Сначала заработал 10
    await earn({ employeeId, reason: 'mentoring' });
    expect(await getBalance(employeeId)).toBe(10);

    // Штраф bad_review = -5
    await earn({ employeeId, reason: 'bad_review' });
    expect(await getBalance(employeeId)).toBe(5);
  });

  it('штраф больше баланса: списывается только то, что есть (не уходит в минус)', async () => {
    const { employeeId } = await seedEmployee(testPool);

    // Только 5 монет за отзыв — но штраф проверяем с меньшим балансом (+3 знания)
    await earn({ employeeId, reason: 'knowledge_applied' });
    expect(await getBalance(employeeId)).toBe(3);

    // Штраф bad_review = -5, но баланс уйти ниже 0 не должен
    await earn({ employeeId, reason: 'bad_review' });
    expect(await getBalance(employeeId)).toBe(0);
  });

  it('бросает если баланс пустой', async () => {
    const { employeeId } = await seedEmployee(testPool);

    await expect(earn({ employeeId, reason: 'bad_review' }))
      .rejects.toThrow(/нечего списывать/i);
  });
});

describe('coin.service: spend (обмен в магазине)', () => {
  it('списывает указанную сумму', async () => {
    const { employeeId } = await seedEmployee(testPool);
    await earn({ employeeId, reason: 'mentoring' });
    await earn({ employeeId, reason: 'mentoring' }); // 20 баланс

    await spend({ employeeId, amount: 15, note: 'Кофе' });
    expect(await getBalance(employeeId)).toBe(5);
  });

  it('бросает если не хватает', async () => {
    const { employeeId } = await seedEmployee(testPool);
    await earn({ employeeId, reason: 'review' }); // 3 баланс

    await expect(spend({ employeeId, amount: 100 }))
      .rejects.toThrow(/недостаточно монет/i);
  });

  it('бросает если сумма <= 0', async () => {
    const { employeeId } = await seedEmployee(testPool);
    await expect(spend({ employeeId, amount: 0 }))
      .rejects.toThrow(/положительной/i);
    await expect(spend({ employeeId, amount: -5 }))
      .rejects.toThrow(/положительной/i);
  });
});

// getMonthlySummary использует AT TIME ZONE 'Asia/Irkutsk' — pg-mem
// этого синтаксиса не поддерживает. Тестируется через unit-тесты
// (irkutskDate) и интеграционно вручную на проде.
