import { Router, Request, Response, NextFunction } from 'express';
import {
  createRequest,
  dispatchRequest,
  listRequests,
  getRequest,
  closeRequest,
  deleteRequest,
  sendManagerMessage,
  getUnreadRequestCount,
  markRequestViewed,
  getOrCreateDirectThread,
} from '../../services/request.service';
import { logAudit } from '../../services/audit.service';
import { areEmployeesInWorkspace, isStoreInWorkspace, workspaceForRequest } from '../../services/adminWorkspace.service';

const router = Router();

// GET /api/requests?status=open|answered|closed
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const items = await listRequests({ status, workspace: workspaceForRequest(req) });
    res.json(items);
  } catch (err) { next(err); }
});

// GET /api/requests/unread-count — badge для sidebar (poll каждые 2 мин)
router.get('/unread-count', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const count = await getUnreadRequestCount(workspaceForRequest(req));
    res.json({ count });
  } catch (err) { next(err); }
});

// GET /api/requests/:id — детали + responses. Помечает как viewed (badge -1).
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const workspace = workspaceForRequest(req);
    const data = await getRequest(id, workspace);
    if (!data) { res.status(404).json({ error: 'Запрос не найден' }); return; }
    // Mark viewed — но только если есть unread responses (избегаем лишних writes)
    await markRequestViewed(id, workspace).catch(() => {});
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/requests/direct — открыть (или создать) личный чат с сотрудником.
// Возвращает { requestId } — id треда, который фронт сразу открывает в модалке.
// Сообщение НЕ шлётся: пустой тред, общение — обычными сообщениями.
router.post('/direct', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const employeeId = parseInt(String((req.body ?? {}).employeeId), 10);
    if (!Number.isFinite(employeeId) || employeeId <= 0) {
      res.status(400).json({ error: 'employeeId обязателен' }); return;
    }
    const workspace = workspaceForRequest(req);
    if (!(await areEmployeesInWorkspace([employeeId], workspace))) {
      res.status(403).json({ error: 'Сотрудник недоступен в текущем контуре' }); return;
    }
    const requestedBy = req.adminUserId ?? 0;
    const requestId = await getOrCreateDirectThread(employeeId, requestedBy, workspace);
    res.json({ requestId });
  } catch (err) { next(err); }
});

// POST /api/requests/:id/message — менеджер пишет в существующий запрос
router.post('/:id/message', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const body = req.body as {
      text?: string;
      fileUrl?: string;
      fileThumbnailUrl?: string;
      fileType?: 'photo' | 'video' | 'document';
      fileName?: string;
    };
    const hasFile = !!body.fileUrl && !!body.fileType;
    if (!body.text?.trim() && !hasFile) {
      res.status(400).json({ error: 'Нужен текст или файл' }); return;
    }
    const workspace = workspaceForRequest(req);
    if (!(await getRequest(id, workspace))) {
      res.status(403).json({ error: 'Диалог недоступен в текущем контуре' }); return;
    }
    const result = await sendManagerMessage({
      requestId: id,
      text: body.text?.trim(),
      fileUrl: body.fileUrl,
      fileThumbnailUrl: body.fileThumbnailUrl,
      fileType: body.fileType,
      fileName: body.fileName,
      adminUserId: req.adminUserId,
    });
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
    const workspace = workspaceForRequest(req);
    const employeeIds = Array.isArray(body.targetEmployeeIds) && body.targetEmployeeIds.length
      ? body.targetEmployeeIds
      : body.targetEmployeeId ? [body.targetEmployeeId] : [];
    if (employeeIds.length && !(await areEmployeesInWorkspace(employeeIds, workspace))) {
      res.status(403).json({ error: 'Один из сотрудников недоступен в текущем контуре' }); return;
    }
    if (body.targetStoreId && !(await isStoreInWorkspace(body.targetStoreId, workspace))) {
      res.status(403).json({ error: 'Команда недоступна в текущем контуре' }); return;
    }
    const id = await createRequest({
      requestedBy,
      workspace,
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
      workspace,
    }).catch(() => {});
  } catch (err) { next(err); }
});

// POST /api/requests/:id/close — закрыть вручную
router.post('/:id/close', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const workspace = workspaceForRequest(req);
    const ok = await closeRequest(id, workspace);
    if (!ok) { res.status(404).json({ error: 'Запрос не найден или уже закрыт' }); return; }
    res.json({ ok: true });
    logAudit('request_close', { requestId: id, workspace }).catch(() => {});
  } catch (err) { next(err); }
});

// DELETE /api/requests/:id — полное удаление с каскадом
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    const workspace = workspaceForRequest(req);
    const ok = await deleteRequest(id, workspace);
    if (!ok) { res.status(404).json({ error: 'Запрос не найден' }); return; }
    res.json({ ok: true });
    logAudit('request_delete', { requestId: id, workspace }).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
