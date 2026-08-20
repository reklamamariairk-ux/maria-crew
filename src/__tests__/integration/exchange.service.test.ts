import { newTestPool, seedEmployee, TestPool } from './setup';

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

import { requestExchange, processExchange } from '../../services/exchange.service';

beforeEach(() => {
  ({ pool: testPool } = newTestPool());
});

async function seedPrize(
  coins = 50,
  cards = 0,
  workspace: 'retail' | 'office' = 'retail',
): Promise<number> {
  const { rows } = await testPool.query(
    `INSERT INTO prizes (name, prize_type, cards_required, coins_required, workspace)
     VALUES ('Кофе', 'coffee', $1, $2, $3) RETURNING id`,
    [cards, coins, workspace]
  );
  return (rows[0] as { id: number }).id;
}

describe('exchange.service: requestExchange', () => {
  it('создаёт заявку и списывает монеты', async () => {
    const { employeeId } = await seedEmployee(testPool);
    const prizeId = await seedPrize(50);
    // Дать сотруднику 100 монет
    await testPool.query(`INSERT INTO coin_transactions (employee_id, amount, reason) VALUES ($1, 100, 'manual')`, [employeeId]);

    const exchange = await requestExchange(employeeId, prizeId);
    expect(exchange.status).toBe('pending');
    expect(Number(exchange.coinsSpent)).toBe(50);

    // Баланс уменьшился на 50
    const { rows } = await testPool.query(
      `SELECT COALESCE(SUM(amount), 0)::int AS balance FROM coin_transactions WHERE employee_id = $1`,
      [employeeId]
    );
    expect((rows[0] as { balance: number }).balance).toBe(50);
  });

  it('бросает если не хватает монет', async () => {
    const { employeeId } = await seedEmployee(testPool);
    const prizeId = await seedPrize(50);
    // Только 30 на балансе
    await testPool.query(`INSERT INTO coin_transactions (employee_id, amount, reason) VALUES ($1, 30, 'manual')`, [employeeId]);

    await expect(requestExchange(employeeId, prizeId))
      .rejects.toThrow(/недостаточно монет/i);
  });

  it('бросает если приз не найден', async () => {
    const { employeeId } = await seedEmployee(testPool);
    await expect(requestExchange(employeeId, 99999))
      .rejects.toThrow(/не найден/i);
  });

  it('офисный сотрудник может заказать только из офисного магазина', async () => {
    const { employeeId } = await seedEmployee(testPool);
    const { rows: officeStores } = await testPool.query(
      `INSERT INTO stores (name, workspace) VALUES ('Офис', 'office') RETURNING id`,
    );
    const officeStoreId = (officeStores[0] as { id: number }).id;
    await testPool.query(
      `INSERT INTO office_employee_memberships (employee_id, office_store_id) VALUES ($1, $2)`,
      [employeeId, officeStoreId],
    );
    const retailPrizeId = await seedPrize(0, 0, 'retail');
    const officePrizeId = await seedPrize(0, 0, 'office');

    await expect(requestExchange(employeeId, retailPrizeId))
      .rejects.toThrow(/недоступен/i);

    const exchange = await requestExchange(employeeId, officePrizeId);
    const { rows } = await testPool.query(
      `SELECT workspace FROM store_exchanges WHERE id = $1`,
      [exchange.id],
    );
    expect((rows[0] as { workspace: string }).workspace).toBe('office');
  });

  it('розничный сотрудник не может заказать офисный приз', async () => {
    const { employeeId } = await seedEmployee(testPool);
    const officePrizeId = await seedPrize(0, 0, 'office');

    await expect(requestExchange(employeeId, officePrizeId))
      .rejects.toThrow(/недоступен/i);
  });
});

describe('exchange.service: processExchange (race condition)', () => {
  async function makePendingExchange() {
    const { employeeId } = await seedEmployee(testPool);
    const prizeId = await seedPrize(50);
    await testPool.query(`INSERT INTO coin_transactions (employee_id, amount, reason) VALUES ($1, 100, 'manual')`, [employeeId]);
    return await requestExchange(employeeId, prizeId);
  }

  it('обработка pending → fulfilled работает', async () => {
    const ex = await makePendingExchange();
    const result = await processExchange(ex.id, 'fulfilled', null);
    expect(result.status).toBe('fulfilled');
  });

  it('повторная обработка уже fulfilled — БРОСАЕТ (race-condition защита)', async () => {
    const ex = await makePendingExchange();
    await processExchange(ex.id, 'fulfilled', null);

    // Попытка обработать снова — должна упасть, иначе можем «выдать приз дважды»
    await expect(processExchange(ex.id, 'fulfilled', null))
      .rejects.toThrow(/уже обработана/i);
    await expect(processExchange(ex.id, 'rejected', null))
      .rejects.toThrow(/уже обработана/i);
  });

  it('повторная обработка уже rejected — БРОСАЕТ (race-condition защита)', async () => {
    const ex = await makePendingExchange();
    await processExchange(ex.id, 'rejected', null, 'причина');

    // После отклонения — нельзя «выдать» (иначе двойные ресурсы: возврат + приз)
    await expect(processExchange(ex.id, 'fulfilled', null))
      .rejects.toThrow(/уже обработана/i);
  });

  it('rejected возвращает монеты на баланс', async () => {
    const ex = await makePendingExchange();
    // После requestExchange баланс был 50 (было 100, потратили 50)

    await processExchange(ex.id, 'rejected', null);

    const { rows } = await testPool.query(
      `SELECT COALESCE(SUM(amount), 0)::int AS balance FROM coin_transactions WHERE employee_id = $1`,
      [ex.employeeId]
    );
    // 100 - 50 (spend) + 50 (возврат) = 100
    expect((rows[0] as { balance: number }).balance).toBe(100);
  });
});
