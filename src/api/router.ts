import { Router, Request, Response, NextFunction } from 'express';
import { adminAuth, requireRole } from './middleware/adminAuth';
import { rateLimit } from './middleware/rateLimit';
import adminUsersRoutes from './routes/adminUsers';
import authRoutes      from './routes/auth';
import webappRoutes    from './routes/webapp';
import storeRoutes     from './routes/stores';
import employeeRoutes  from './routes/employees';
import metricsRoutes   from './routes/metrics';
import coinsRoutes     from './routes/coins';
import exchangeRoutes  from './routes/exchanges';
import leaderboardRoutes from './routes/leaderboard';
import quizRoutes from './routes/quiz';
import challengeRoutes from './routes/challenges';
import cardRoutes from './routes/cards';
import heroRoutes from './routes/heroes';
import prizeRoutes from './routes/prizes';
import auditRoutes from './routes/audit';
import configRoutes from './routes/config';
import dashboardRoutes from './routes/dashboard';
import notifyRoutes from './routes/notify';
import v1AuthRoutes from './routes/v1Auth';
import v1DevicesRoutes from './routes/v1Devices';
import v1AccountRoutes from './routes/v1Account';
import v1NotificationsRoutes from './routes/v1Notifications';
import backupRoutes from './routes/backup';

const router = Router();

// Логин не требует auth — но защищаем от перебора паролей: 10 попыток за 15 минут с IP
router.use('/auth', rateLimit(10, 15 * 60 * 1000), authRoutes);

// Mobile API v1 — JWT-авторизация по PIN из Telegram. Внутренние rate-limit'ы свои.
router.use('/v1/auth', v1AuthRoutes);
router.use('/v1/devices', v1DevicesRoutes);
router.use('/v1/account', v1AccountRoutes);
router.use('/v1/notifications', v1NotificationsRoutes);

// Mini App — использует Telegram initData, не admin-токен; ограничение: 60 запросов/мин с IP
router.use('/webapp', rateLimit(60, 60_000), webappRoutes);

// Публичный cloudinary-конфиг (только cloud_name + upload_preset, секретов нет)
router.get('/config/cloudinary', (_req, res) => {
  const cloudName    = process.env.CLOUDINARY_CLOUD_NAME    ?? '';
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET ?? '';
  res.json({ cloudName, uploadPreset, enabled: !!(cloudName && uploadPreset) });
});

// Всё остальное — требует Bearer-токен
router.use(adminAuth);

// Метаданные текущего админа — нужны фронту, чтобы спрятать недоступные разделы
router.get('/me/admin', (req: Request, res: Response): void => {
  res.json({ id: req.adminUserId, role: req.adminRole });
});

// ── Защита монетных операций (только superadmin + coin_admin) ──────────────
const allowCoinWrite = requireRole('superadmin', 'coin_admin');
const denyForCoinAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (req.adminRole === 'coin_admin') {
    res.status(403).json({ error: 'Эта операция недоступна для роли «Только монеты»' });
    return;
  }
  next();
};

// coin_admin может только: POST /coins/award, POST /employees/bulk-coins,
// и читать списки (GET ... /coins, /employees, /stores).
// Все остальные write-операции запрещены.

router.use('/coins',       coinsRoutes);                          // POST /award защитим внутри роутера
router.use('/employees',   employeeRoutes);                       // POST /bulk-coins тоже внутри
router.use('/stores',      denyForCoinAdmin, storeRoutes);
router.use('/metrics',     denyForCoinAdmin, metricsRoutes);
router.use('/exchanges',   denyForCoinAdmin, exchangeRoutes);
router.use('/leaderboard', denyForCoinAdmin, leaderboardRoutes);
router.use('/quiz',        denyForCoinAdmin, quizRoutes);
router.use('/challenges',  denyForCoinAdmin, challengeRoutes);
router.use('/cards',       denyForCoinAdmin, cardRoutes);
router.use('/heroes',      denyForCoinAdmin, heroRoutes);
router.use('/prizes',      denyForCoinAdmin, prizeRoutes);
router.use('/audit',       denyForCoinAdmin, auditRoutes);
router.use('/notify',      denyForCoinAdmin, notifyRoutes);

// /config: GET доступен всем, PUT (PUT /mvp) — только superadmin
router.use('/config', (req: Request, res: Response, next: NextFunction): void => {
  if (req.method !== 'GET' && req.adminRole !== 'superadmin') {
    res.status(403).json({ error: 'Только суперадмин может менять настройки' });
    return;
  }
  next();
}, configRoutes);

// Дашборд — все роли
router.use('/dashboard', dashboardRoutes);

// Управление админ-пользователями — только superadmin
router.use('/admin-users', requireRole('superadmin'), adminUsersRoutes);

// Бэкап БД — только superadmin
router.use('/backup', denyForCoinAdmin, backupRoutes);

export default router;
