import { Router, Request, Response, NextFunction } from 'express';
import {
  createRequest,
  dispatchRequest,
  listRequests,
  getRequest,
  closeRequest,
  sendManagerMessage,
  getUnreadRequestCount,
  markRequestViewed,
} from '../../services/request.service';
import { logAudit } from '../../services/audit.service';

const router = Router();

// GET /api/requests?status=open|answered|closed
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const items = await listRequests({ status });
    res.json(items);
  } catch (err) { next(err); }
});

// GET /api/requests/unread-count — badge для sidebar (poll каждые 2 мин)
router.get('/unread-count', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const count = await getUnreadRequestCount();
    res.json({ count });
  } catch (err) { next(err); }
});

// GET /api/requests/:id — детали + responses. Помечает как viewed (badge -1).
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = await getRequest(id);
    if (!data) { res.status(404).json({ error: 'Запрос не найден' }); return; }
    // Mark viewed — но только если есть unread responses (избегаем лишних writes)
    await markRequestViewed(id).catch(() => {});
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/requests/:id/message — менеджер пишет в существующий запрос
router.post('/:id/message', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const { text } = req.body as { text: string };
    if (!text || !text.trim()) {
      res.status(400).json({ error: 'text обязателен' }); return;
    }
    const result = await sendManagerMessage({ requestId: id, text: text.trim(), adminUserId: req.adminUserId });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/requests — создать запрос + сразу разослать в Telegram
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as {
      targetEmployeeIds?: number[];
      targetEmployeeId?: number;
      targetStoreId?: number;
      requestText: string;
    };
    if (!body.requestText || !body.requestText.trim()) {
      res.status(400).json({ error: 'requestText обязателен' }); return;
    }
    const hasIds = Array.isArray(body.targetEmployeeIds) && body.targetEmployeeIds.length > 0;
    if (!hasIds && !body.targetEmployeeId && !body.targetStoreId) {
      res.status(400).json({ error: 'Укажите targetEmployeeIds, targetEmployeeId или targetStoreId' }); return;
    }

    const requestedBy = req.adminUserId ?? 0;
    const id = await createRequest({
      requestedBy,
      targetEmployeeIds: body.targetEmployeeIds,
      targetEmployeeId: body.targetEmployeeId,
      targetStoreId: body.targetStoreId,
      requestText: body.requestText.trim(),
    });

    const dispatch = await dispatchRequest(id);
    res.status(201).json({ id, ...dispatch });

    logAudit('request_create', {
      requestId: id,
      targetEmployeeId: body.targetEmployeeId ?? null,
      targetStoreId: body.targetStoreId ?? null,
      sent: dispatch.sent, skipped: dispatch.skipped,
    }).catch(() => {});
  } catch (err) { next(err); }
});

// POST /api/requests/:id/close — закрыть вручную
router.post('/:id/close', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const ok = await closeRequest(id);
    if (!ok) { res.status(404).json({ error: 'Запрос не найден или уже закрыт' }); return; }
    res.json({ ok: true });
    logAudit('request_close', { requestId: id }).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
