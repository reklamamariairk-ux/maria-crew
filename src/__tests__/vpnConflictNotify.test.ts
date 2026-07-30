/**
 * «Ай-ай-ай»-страж: уведомление о попытке активации кода на втором устройстве.
 * Дедуп по conflict_at, пропуск несвязанных/уволенных, панель недоступна — тихо падает в safeRun.
 */
jest.mock('../db/pool', () => ({ pool: { query: jest.fn() } }));
jest.mock('../services/vpn.service', () => ({
  vpnConfigured: jest.fn(() => true),
  listPanelUsers: jest.fn(),
}));

import { pool } from '../db/pool';
import { vpnConfigured, listPanelUsers } from '../services/vpn.service';
import { vpnConflictNotify } from '../scheduler/jobs/vpnConflictNotify';

const mockQuery = pool.query as jest.Mock;
const mockList = listPanelUsers as jest.Mock;
const mockConfigured = vpnConfigured as jest.Mock;

const panelUser = (name: string, conflictAt: number | null) => ({
  name, port: 20001, status: 'active', online: false, todayBytes: 0, totalBytes: 0,
  lastSeen: null, pendingCode: false,
  codeConflict: conflictAt ? { at: conflictAt, count: 1 } : null,
  phoneShared: false, phone: null,
});

function primeDb(notified: Array<{ vpnName: string; notifiedConflictAt: string }>,
                 links: Array<{ vpnName: string; telegramId: string | null }>) {
  mockQuery
    .mockResolvedValueOnce({ rows: notified })  // vpn_conflict_notified
    .mockResolvedValueOnce({ rows: links })     // employee_vpn JOIN employees
    .mockResolvedValue({ rows: [] });           // upsert'ы
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigured.mockReturnValue(true);
});

test('новый конфликт у связанного сотрудника → одно сообщение + upsert', async () => {
  mockList.mockResolvedValue([panelUser('Вера', 1000), panelUser('Володя', null)]);
  primeDb([], [{ vpnName: 'Вера', telegramId: '111' }]);
  const send = jest.fn();
  await vpnConflictNotify(send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBe('111');
  expect(send.mock.calls[0][1]).toMatch(/Ай-ай-ай/);
  expect(send.mock.calls[0][1]).toMatch(/администратору/);
});

test('уже уведомляли про этот conflict_at → тишина', async () => {
  mockList.mockResolvedValue([panelUser('Вера', 1000)]);
  primeDb([{ vpnName: 'Вера', notifiedConflictAt: '1000' }], [{ vpnName: 'Вера', telegramId: '111' }]);
  const send = jest.fn();
  await vpnConflictNotify(send);
  expect(send).not.toHaveBeenCalled();
});

test('НОВАЯ попытка (conflict_at вырос) → уведомляем снова', async () => {
  mockList.mockResolvedValue([panelUser('Вера', 2000)]);
  primeDb([{ vpnName: 'Вера', notifiedConflictAt: '1000' }], [{ vpnName: 'Вера', telegramId: '111' }]);
  const send = jest.fn();
  await vpnConflictNotify(send);
  expect(send).toHaveBeenCalledTimes(1);
});

test('нет маппинга/TG → не шлём, но conflict_at запоминаем (не досылать после привязки)', async () => {
  mockList.mockResolvedValue([panelUser('Внешний', 1000)]);
  primeDb([], []);
  const send = jest.fn();
  await vpnConflictNotify(send);
  expect(send).not.toHaveBeenCalled();
  const upsert = mockQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO vpn_conflict_notified'));
  expect(upsert).toBeTruthy();
  expect(upsert![1]).toEqual(['Внешний', 1000]);
});

test('vpn не сконфигурирован → полный no-op', async () => {
  mockConfigured.mockReturnValue(false);
  const send = jest.fn();
  await vpnConflictNotify(send);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockQuery).not.toHaveBeenCalled();
});
