/**
 * Увольнение: регекс 1С-пометки + fire/restore с замоканными БД и VPN-панелью.
 * Панельные ошибки не должны блокировать увольнение (vpn: 'unavailable').
 */
import { FIRED_NAME_RE } from '../services/employeeFire.service';

jest.mock('../db/pool', () => ({ pool: { query: jest.fn() } }));
jest.mock('../services/vpn.service', () => ({
  vpnConfigured: jest.fn(() => true),
  panelUserAction: jest.fn(),
}));
jest.mock('../services/audit.service', () => ({ logAudit: jest.fn(() => Promise.resolve()) }));

import { pool } from '../db/pool';
import { vpnConfigured, panelUserAction } from '../services/vpn.service';
import { fireEmployee, restoreEmployee, applyVpnFired } from '../services/employeeFire.service';

const mockQuery = pool.query as jest.Mock;
const mockAction = panelUserAction as jest.Mock;
const mockConfigured = vpnConfigured as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigured.mockReturnValue(true);
});

describe('FIRED_NAME_RE — 1С-пометка «не работает»', () => {
  test.each([
    'Иванова А.А. (не работает)',
    'Иванова НЕ РАБОТАЕТ',
    'Петров не  работает с 01.07',
    'Сидорова(неработает)',
  ])('ловит: %s', (name) => expect(FIRED_NAME_RE.test(name)).toBe(true));

  test.each([
    'Иванова Анна',
    'Работаева Надежда',
    'Неработкин Иван',   // «неработк» ≠ «не работает»
    'Мастер работ Ается',
  ])('не ловит: %s', (name) => expect(FIRED_NAME_RE.test(name)).toBe(false));
});

describe('fireEmployee', () => {
  test('увольняет, отзывает оба ключа, vpn=ok', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, name: 'Тест', firedAt: '2026-07-30' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [{ vpnName: 'Тест' }] });                            // employee_vpn
    mockAction.mockResolvedValue({ ok: true });
    const r = await fireEmployee(5, 'manual', 'admin#1');
    expect(r).toMatchObject({ id: 5, vpn: 'ok' });
    expect(mockAction).toHaveBeenCalledWith('Тест', 'revoke');
    expect(mockAction).toHaveBeenCalledWith('Тест', 'phone/revoke');
  });

  test('панель лежит — увольнение ПРОХОДИТ, vpn=unavailable', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, name: 'Тест', firedAt: '2026-07-30' }] })
      .mockResolvedValueOnce({ rows: [{ vpnName: 'Тест' }] });
    mockAction.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await fireEmployee(5, 'manual');
    expect(r).toMatchObject({ id: 5, vpn: 'unavailable' });
  });

  test('нет VPN-маппинга — vpn=no_vpn, панель не дёргается', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, name: 'Тест', firedAt: '2026-07-30' }] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await fireEmployee(5, 'auto_1c');
    expect(r).toMatchObject({ vpn: 'no_vpn' });
    expect(mockAction).not.toHaveBeenCalled();
  });

  test('сотрудник не найден — null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await fireEmployee(999, 'manual')).toBeNull();
  });
});

describe('restoreEmployee', () => {
  test('возвращает и реактивирует оба ключа', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, name: 'Тест', firedAt: null }] })
      .mockResolvedValueOnce({ rows: [{ vpnName: 'Тест' }] });
    mockAction.mockResolvedValue({ ok: true });
    const r = await restoreEmployee(5, 'admin#1');
    expect(r).toMatchObject({ id: 5, vpn: 'ok', firedAt: null });
    expect(mockAction).toHaveBeenCalledWith('Тест', 'reactivate');
    expect(mockAction).toHaveBeenCalledWith('Тест', 'phone/reactivate');
  });
});

describe('applyVpnFired', () => {
  test('ошибка ТОЛЬКО телефонного действия не портит результат (ключа может не быть)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ vpnName: 'Тест' }] });
    mockAction
      .mockResolvedValueOnce({ ok: true })                 // revoke ПК
      .mockRejectedValueOnce(new Error('no phone'));       // phone/revoke
    expect(await applyVpnFired(5, true)).toBe('ok');
  });

  test('vpn не сконфигурирован — no_vpn', async () => {
    mockConfigured.mockReturnValue(false);
    expect(await applyVpnFired(5, true)).toBe('no_vpn');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
