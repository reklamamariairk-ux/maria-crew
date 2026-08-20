import { newTestPool, seedEmployee, TestPool } from './setup';

let testPool: TestPool;
jest.mock('../../db/pool', () => ({
  get pool() { return testPool; },
}));

import { upsertMetrics } from '../../services/rating.service';

beforeEach(() => {
  ({ pool: testPool } = newTestPool());
});

it('хранит офисные и розничные метрики одного сотрудника отдельно', async () => {
  const { employeeId, storeId: retailStoreId } = await seedEmployee(testPool);
  const { rows: officeStores } = await testPool.query(
    `INSERT INTO stores (name, workspace) VALUES ('Офис', 'office') RETURNING id`,
  );
  const officeStoreId = (officeStores[0] as { id: number }).id;

  await upsertMetrics({
    employeeId, storeId: retailStoreId, year: 2026, month: 8, reviewsCount: 3,
  }, 'retail');
  await upsertMetrics({
    employeeId, storeId: officeStoreId, year: 2026, month: 8, reviewsCount: 7,
  }, 'office');

  const { rows } = await testPool.query(
    `SELECT workspace, store_id AS "storeId", reviews_count AS "reviewsCount"
       FROM monthly_metrics WHERE employee_id = $1 ORDER BY workspace`,
    [employeeId],
  );
  expect(rows).toEqual([
    expect.objectContaining({ workspace: 'office', storeId: officeStoreId, reviewsCount: 7 }),
    expect.objectContaining({ workspace: 'retail', storeId: retailStoreId, reviewsCount: 3 }),
  ]);
});
