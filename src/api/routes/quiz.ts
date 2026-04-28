import { Router, Request, Response, NextFunction } from 'express';
import { listQuestions, createQuestion, updateQuestion, deleteQuestion } from '../../services/quiz.service';
import { logAudit } from '../../services/audit.service';

const router = Router();

router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const questions = await listQuestions();
    res.json(questions);
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { question, options, correctIndex, category } = req.body as {
      question: string; options: string[]; correctIndex: number; category?: string;
    };
    if (!question || !Array.isArray(options) || options.length !== 4 || correctIndex === undefined) {
      res.status(400).json({ error: 'question, options[4], correctIndex обязательны' });
      return;
    }
    const q = await createQuestion(question, options, correctIndex, category ?? 'product');
    res.status(201).json(q);
    logAudit('quiz_question_create', { questionId: q.id }).catch(() => {});
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    await updateQuestion(id, req.body);
    res.json({ ok: true });
    logAudit('quiz_question_update', { questionId: id, changes: req.body }).catch(() => {});
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id);
    await deleteQuestion(id);
    res.json({ ok: true });
    logAudit('quiz_question_delete', { questionId: id }).catch(() => {});
  } catch (err) { next(err); }
});

export default router;
