// Unit-тесты для JWT-подобных токенов сотрудников.
// БД-зависимые функции (requestPin, verifyPin) тестируются через интеграционные.

// effectiveAdminSecret читает env.ADMIN_SECRET — выставляем до импорта модуля.
process.env.ADMIN_SECRET = 'test-admin-secret-for-jwt-signing-do-not-use-in-prod';

import { signEmployeeToken, verifyEmployeeToken, normalizePhone } from '../services/employeeAuth.service';

describe('employeeAuth: JWT round-trip', () => {
  it('подписывает и верифицирует токен с правильным uid', () => {
    const exp = Date.now() + 60_000;
    const token = signEmployeeToken(42, exp);
    const payload = verifyEmployeeToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.uid).toBe(42);
    expect(payload!.scope).toBe('employee');
    expect(payload!.exp).toBe(exp);
  });

  it('отклоняет токен с истёкшим временем', () => {
    const token = signEmployeeToken(1, Date.now() - 1000);
    expect(verifyEmployeeToken(token)).toBeNull();
  });

  it('отклоняет токен с подделанной подписью', () => {
    const token = signEmployeeToken(1, Date.now() + 60_000);
    const tampered = token.slice(0, -3) + 'AAA';
    expect(verifyEmployeeToken(tampered)).toBeNull();
  });

  it('отклоняет мусор', () => {
    expect(verifyEmployeeToken('garbage')).toBeNull();
    expect(verifyEmployeeToken('')).toBeNull();
    expect(verifyEmployeeToken('a.b')).toBeNull();
  });

  it('отклоняет токены без точки-разделителя', () => {
    expect(verifyEmployeeToken('nodotaaaaa')).toBeNull();
  });
});

describe('employeeAuth: normalizePhone', () => {
  it('убирает плюсы, скобки, пробелы и тире', () => {
    expect(normalizePhone('+7 (999) 123-45-67')).toBe('79991234567');
    expect(normalizePhone('8-999-123-45-67')).toBe('89991234567');
    expect(normalizePhone('+79991234567')).toBe('79991234567');
  });

  it('пустая строка → пустая', () => {
    expect(normalizePhone('')).toBe('');
  });

  it('только цифры остаются', () => {
    expect(normalizePhone('abc123def456')).toBe('123456');
  });
});
