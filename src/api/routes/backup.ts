// /api/backup — выгрузка полного дампа БД для бэкапа.
// Только superadmin. Возвращает JSON-файл со всеми таблицами для скачивания.

import { Router, Request, Response, NextFunction } from 'express';
import { createBackup } from '../../services/backup.service';
import { logAudit } from '../../services/audit.service';
import { requireRole } from '../middleware/adminAuth';

const router = Router();

// GET /api/backup — скачать дамп БД
router.get('/', requireRole('superadmin'), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const backup = await createBackup();

    // Имя файла с датой Иркутска для удобства
    const irk = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const stamp = irk.toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const filename = `maria-crew-backup-${stamp}.json`;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(backup, null, 2));

    const totalRows = Object.values(backup.rowCounts).reduce((s, n) => s + (n > 0 ? n : 0), 0);
    logAudit('backup_download', { totalRows, tables: Object.keys(backup.rowCounts).length }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
