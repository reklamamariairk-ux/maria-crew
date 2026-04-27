import { Router, Request, Response, NextFunction } from 'express';
import { listQuestions, createQuestion, updateQuestion, deleteQuestion } from '../../services/quiz.service';

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
  } catch (err) { next(err); }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await updateQuestion(parseInt(req.params.id), req.body);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await deleteQuestion(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
