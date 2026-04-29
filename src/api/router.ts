import { Router } from 'express';
import { adminAuth } from './middleware/adminAuth';
import { rateLimit } from './middleware/rateLimit';
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

const router = Router();

// Логин не требует auth
router.use('/auth', authRoutes);

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
router.use('/stores',      storeRoutes);
router.use('/employees',   employeeRoutes);
router.use('/metrics',     metricsRoutes);
router.use('/coins',       coinsRoutes);
router.use('/exchanges',   exchangeRoutes);
router.use('/leaderboard', leaderboardRoutes);
router.use('/quiz',        quizRoutes);
router.use('/challenges',  challengeRoutes);
router.use('/cards',       cardRoutes);
router.use('/heroes',      heroRoutes);
router.use('/prizes',      prizeRoutes);
router.use('/audit',       auditRoutes);
router.use('/config',      configRoutes);
router.use('/dashboard',   dashboardRoutes);
router.use('/notify',      notifyRoutes);

export default router;
