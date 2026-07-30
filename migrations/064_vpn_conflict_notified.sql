-- Дедуп «ай-ай-ай»-уведомлений о попытке активации VPN-кода на втором устройстве:
-- помним, про какой conflict_at уже написали сотруднику в TG (панель обновляет
-- codes.conflict_at при каждой новой попытке — новая попытка = новое уведомление).
CREATE TABLE IF NOT EXISTS vpn_conflict_notified (
  vpn_name             TEXT PRIMARY KEY,
  notified_conflict_at BIGINT NOT NULL
);
