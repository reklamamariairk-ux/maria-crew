import { pickVpnName, VPN_ACTIONS } from '../services/vpn.service';

describe('vpn.service', () => {
  test('pickVpnName: без коллизии — имя как есть (с trim)', () => {
    expect(pickVpnName('  Иван Петров ', new Set())).toBe('Иван Петров');
  });

  test('pickVpnName: коллизии получают суффикс (2), (3)…', () => {
    const taken = new Set(['Иван', 'Иван (2)']);
    expect(pickVpnName('Иван', taken)).toBe('Иван (3)');
  });

  test('VPN_ACTIONS — закрытый whitelist действий панели', () => {
    expect([...VPN_ACTIONS].sort()).toEqual([
      'phone', 'phone/reactivate', 'phone/reissue', 'phone/revoke',
      'reactivate', 'reissue', 'revoke', 'unbind',
    ].sort());
    // Путь с обходом (например, ../login или произвольный) не в whitelist
    expect(VPN_ACTIONS.includes('..' as never)).toBe(false);
  });
});
