import { Router } from 'express';
import { adminAuth } from './middleware/adminAuth';
import authRoutes      from './routes/auth';
import webappRoutes    from './routes/webapp';
import storeRoutes     from './routes/stores';
import employeeRoutes  from './routes/employees';
import metricsRoutes   from './routes/metrics';
import coinsRoutes     from './routes/coins';
import exchangeRoutes  from './routes/exchanges';
import leaderboardRoutes from './routes/leaderboard';
import quizRoutes from './routes/quiz';

const router = Router();

// Логин не требует auth
router.use('/auth', authRoutes);

// Mini App — использует Telegram initData, не admin-токен
router.use('/webapp', webappRoutes);

// Всё остальное — требует Bearer-токен
router.use(adminAuth);
router.use('/stores',      storeRoutes);
router.use('/employees',   employeeRoutes);
router.use('/metrics',     metricsRoutes);
router.use('/coins',       coinsRoutes);
router.use('/exchanges',   exchangeRoutes);
router.use('/leaderboard', leaderboardRoutes);
router.use('/quiz',       quizRoutes);

export default router;
