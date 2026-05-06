import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { listQuestions, createQuestion, updateQuestion, deleteQuestion, importQuestionsFromCsv } from '../../services/quiz.service';
import { logAudit } from '../../services/audit.service';
import { pool } from '../../db/pool';

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
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id' }); return; }
    await updateQuestion(id, req.body);
    res.json({ ok: true });
    logAudit('quiz_question_update', { questionId: id, changes: req.body }).catch(() => {});
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Неверный id' }); return; }
    await deleteQuestion(id);
    res.json({ ok: true });
    logAudit('quiz_question_delete', { questionId: id }, req.ip).catch(() => {});
  } catch (err) { next(err); }
});

// POST /api/quiz/import — массовый импорт из CSV.
// Body: { csv: string }. Принимаем как JSON, так и text/csv. Лимит 2MB —
// глобальный express.json() стоит на 100kb, для импорта поднимаем.
router.post(
  '/import',
  express.json({ limit: '2mb' }),
  express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const csv = typeof req.body === 'string'
        ? req.body
        : (req.body as { csv?: string })?.csv;
      if (typeof csv !== 'string' || !csv.trim()) {
        res.status(400).json({ error: 'Пустой CSV' });
        return;
      }
      const result = await importQuestionsFromCsv(csv);
      res.json(result);
      logAudit('quiz_question_import', { added: result.added, total: result.total, errorCount: result.errors.length }, req.ip).catch(() => {});
    } catch (err) { next(err); }
  }
);

// GET /api/quiz/analytics — статистика: самые сложные вопросы, результаты по категориям
router.get('/analytics', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [hardest, categories, summary] = await Promise.all([
      // Топ-10 вопросов по % неправильных ответов (мин. 5 попыток)
      pool.query<{
        questionId: number; question: string; category: string;
        totalAttempts: string; wrongAttempts: string; errorRate: string;
      }>(
        `SELECT qa.question_id AS "questionId",
                qq.question,
                qq.category,
                COUNT(*) AS "totalAttempts",
                COUNT(*) FILTER (WHERE NOT qa.is_correct) AS "wrongAttempts",
                ROUND(
                  100.0 * COUNT(*) FILTER (WHERE NOT qa.is_correct) / NULLIF(COUNT(*), 0),
                  1
                ) AS "errorRate"
         FROM quiz_attempts qa
         JOIN quiz_questions qq ON qq.id = qa.question_id
         GROUP BY qa.question_id, qq.question, qq.category
         HAVING COUNT(*) >= 5
         ORDER BY "errorRate" DESC
         LIMIT 10`
      ),
      // Результаты по категориям
      pool.query<{
        category: string; totalAttempts: string; correctAttempts: string; successRate: string;
      }>(
        `SELECT qq.category,
                COUNT(*) AS "totalAttempts",
                COUNT(*) FILTER (WHERE qa.is_correct) AS "correctAttempts",
                ROUND(
                  100.0 * COUNT(*) FILTER (WHERE qa.is_correct) / NULLIF(COUNT(*), 0),
                  1
                ) AS "successRate"
         FROM quiz_attempts qa
         JOIN quiz_questions qq ON qq.id = qa.question_id
         GROUP BY qq.category
         ORDER BY "successRate" ASC`
      ),
      // Общая сводка. Колонка в БД — answered_at (не attempted_at).
      // Считаем по иркутскому дню — синхронно с тем, как день определяется
      // во всех остальных местах системы.
      pool.query<{
        totalAttempts: string; uniqueEmployees: string; avgDailyAttempts: string;
      }>(
        `SELECT
           COUNT(*)                    AS "totalAttempts",
           COUNT(DISTINCT employee_id) AS "uniqueEmployees",
           ROUND(
             COUNT(*)::numeric
             / NULLIF(COUNT(DISTINCT (answered_at AT TIME ZONE 'Asia/Irkutsk')::date), 0),
             1
           ) AS "avgDailyAttempts"
         FROM quiz_attempts`
      ),
    ]);

    res.json({
      summary: summary.rows[0] ?? { totalAttempts: '0', uniqueEmployees: '0', avgDailyAttempts: '0' },
      hardestQuestions: hardest.rows,
      byCategory: categories.rows,
    });
  } catch (err) { next(err); }
});

export default router;
