import { Router, Request, Response, NextFunction } from 'express';
import {
  createRequest,
  dispatchRequest,
  listRequests,
  getRequest,
  closeRequest,
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

// GET /api/requests/:id — детали + responses
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = await getRequest(id);
    if (!data) { res.status(404).json({ error: 'Запрос не найден' }); return; }
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/requests — создать запрос + сразу разослать в Telegram
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as {
      targetEmployeeId?: number;
      targetStoreId?: number;
      requestText: string;
    };
    if (!body.requestText || !body.requestText.trim()) {
      res.status(400).json({ error: 'requestText обязателен' }); return;
    }
    if (!body.targetEmployeeId && !body.targetStoreId) {
      res.status(400).json({ error: 'Укажите targetEmployeeId или targetStoreId' }); return;
    }
    if (body.targetEmployeeId && body.targetStoreId) {
      res.status(400).json({ error: 'Указывайте либо сотрудника, либо точку, не оба' }); return;
    }

    const requestedBy = req.adminUserId ?? 0;
    const id = await createRequest({
      requestedBy,
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
