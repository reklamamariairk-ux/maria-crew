import { pool } from '../db/pool';
import { irkutskDate } from './streak.service';

/** Возвращает залоченный на сегодня набор вопросов сотрудника.
 *  При первом вызове за день генерирует случайный набор и сохраняет его,
 *  чтобы все последующие вызовы в тот же иркутский день возвращали
 *  те же самые вопросы — у каждого сотрудника свой уникальный набор. */
async function getOrCreateDailySession(employeeId: number): Promise<number[]> {
  const today = irkutskDate();

  // Если сессия уже создана сегодня — возвращаем готовый набор
  const { rows: existing } = await pool.query<{ questionIds: number[] }>(
    `SELECT question_ids AS "questionIds"
     FROM quiz_sessions
     WHERE employee_id = $1 AND quiz_date = $2::date`,
    [employeeId, today]
  );
  if (existing[0]) return existing[0].questionIds;

  // Генерируем новый случайный набор: исключаем вопросы последних 7 дней
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM quiz_questions
     WHERE is_active = true
       AND id NOT IN (
         SELECT question_id FROM quiz_attempts
         WHERE employee_id = $1 AND answered_at > NOW() - INTERVAL '7 days'
       )
     ORDER BY RANDOM()
     LIMIT 5`,
    [employeeId]
  );

  let questionIds = rows.map(r => r.id);

  // Если свежих вопросов меньше 5 — добираем любые активные
  if (questionIds.length < 5) {
    const { rows: extra } = await pool.query<{ id: number }>(
      `SELECT id FROM quiz_questions
       WHERE is_active = true AND id != ALL($1)
       ORDER BY RANDOM()
       LIMIT $2`,
      [questionIds.length ? questionIds : [0], 5 - questionIds.length]
    );
    questionIds = [...questionIds, ...extra.map(r => r.id)];
  }

  // Сохраняем сессию; если другой запрос уже создал её — просто берём существующую
  await pool.query(
    `INSERT INTO quiz_sessions (employee_id, quiz_date, question_ids)
     VALUES ($1, $2, $3)
     ON CONFLICT (employee_id, quiz_date) DO NOTHING`,
    [employeeId, today, questionIds]
  );

  // Читаем финальное значение (на случай гонки)
  const { rows: final } = await pool.query<{ questionIds: number[] }>(
    `SELECT question_ids AS "questionIds"
     FROM quiz_sessions WHERE employee_id = $1 AND quiz_date = $2::date`,
    [employeeId, today]
  );
  return final[0]?.questionIds ?? questionIds;
}

export interface QuizQuestion {
  id: number;
  question: string;
  options: string[];
  correctIndex: number;
  category: string;
}

export async function getDailyQuestions(employeeId: number): Promise<{ questions: QuizQuestion[]; alreadyDone: boolean }> {
  const today = irkutskDate();

  // Проверяем — уже ответили на 5 вопросов сегодня?
  const { rows: todayAttempts } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM quiz_attempts
     WHERE employee_id = $1
       AND (answered_at AT TIME ZONE 'Asia/Irkutsk')::date = $2::date`,
    [employeeId, today]
  );
  const doneCount = parseInt(todayAttempts[0]?.count ?? '0', 10);
  if (doneCount >= 5) return { questions: [], alreadyDone: true };

  // Получаем/создаём залоченный на сегодня набор (уникальный для каждого)
  const questionIds = await getOrCreateDailySession(employeeId);

  // Загружаем вопросы в нужном порядке, пропуская уже отвеченные сегодня
  const { rows: answered } = await pool.query<{ questionId: number }>(
    `SELECT question_id AS "questionId" FROM quiz_attempts
     WHERE employee_id = $1
       AND (answered_at AT TIME ZONE 'Asia/Irkutsk')::date = $2::date`,
    [employeeId, today]
  );
  const answeredIds = new Set(answered.map(r => r.questionId));
  const remaining = questionIds.filter(id => !answeredIds.has(id));

  if (remaining.length === 0) return { questions: [], alreadyDone: true };

  const { rows } = await pool.query<QuizQuestion>(
    `SELECT id, question, options, correct_index AS "correctIndex", category
     FROM quiz_questions
     WHERE id = ANY($1) AND is_active = true`,
    [remaining]
  );

  // Восстанавливаем порядок из сессии
  const ordered = remaining
    .map(id => rows.find(r => r.id === id))
    .filter((q): q is QuizQuestion => q !== undefined);

  return {
    questions: ordered.map(q => ({ ...q, correctIndex: -1 })) as QuizQuestion[],
    alreadyDone: false,
  };
}

export async function getDailyQuestionsWithAnswers(employeeId: number): Promise<{ questions: QuizQuestion[]; alreadyDone: boolean }> {
  const today = irkutskDate();

  const { rows: todayAttempts } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM quiz_attempts
     WHERE employee_id = $1
       AND (answered_at AT TIME ZONE 'Asia/Irkutsk')::date = $2::date`,
    [employeeId, today]
  );
  const doneCount = parseInt(todayAttempts[0]?.count ?? '0', 10);
  if (doneCount >= 5) return { questions: [], alreadyDone: true };

  const questionIds = await getOrCreateDailySession(employeeId);

  const { rows } = await pool.query<QuizQuestion>(
    `SELECT id, question, options, correct_index AS "correctIndex", category
     FROM quiz_questions
     WHERE id = ANY($1) AND is_active = true`,
    [questionIds]
  );

  const ordered = questionIds
    .map(id => rows.find(r => r.id === id))
    .filter((q): q is QuizQuestion => q !== undefined);

  return { questions: ordered, alreadyDone: false };
}

export async function submitAnswer(
  employeeId: number,
  questionId: number,
  answerIndex: number
): Promise<{ isCorrect: boolean; correctIndex: number; coinsEarned: number }> {
  const { rows } = await pool.query<{ correctIndex: number }>(
    `SELECT correct_index AS "correctIndex" FROM quiz_questions WHERE id = $1 AND is_active = true`,
    [questionId]
  );
  if (!rows[0]) throw new Error('Вопрос не найден');

  const correctIndex = rows[0].correctIndex;
  const isCorrect = answerIndex === correctIndex;
  const coinsEarned = isCorrect ? 1 : 0;

  await pool.query(
    `INSERT INTO quiz_attempts (employee_id, question_id, is_correct, coins_earned)
     VALUES ($1, $2, $3, $4)`,
    [employeeId, questionId, isCorrect, coinsEarned]
  );

  if (coinsEarned > 0) {
    await pool.query(
      `INSERT INTO coin_transactions (employee_id, amount, reason, note)
       VALUES ($1, $2, 'quiz', 'Правильный ответ в квизе')`,
      [employeeId, coinsEarned]
    );
  }

  return { isCorrect, correctIndex, coinsEarned };
}

// Admin CRUD
export async function listQuestions(): Promise<QuizQuestion[]> {
  const { rows } = await pool.query<QuizQuestion & { isActive: boolean; createdAt: Date }>(
    `SELECT id, question, options, correct_index AS "correctIndex", category, is_active AS "isActive", created_at AS "createdAt"
     FROM quiz_questions ORDER BY id DESC`
  );
  return rows;
}

export async function createQuestion(
  question: string,
  options: string[],
  correctIndex: number,
  category: string
): Promise<QuizQuestion> {
  const { rows } = await pool.query<QuizQuestion>(
    `INSERT INTO quiz_questions (question, options, correct_index, category)
     VALUES ($1, $2, $3, $4)
     RETURNING id, question, options, correct_index AS "correctIndex", category`,
    [question, JSON.stringify(options), correctIndex, category]
  );
  return rows[0];
}

export async function updateQuestion(
  id: number,
  fields: Partial<{ question: string; options: string[]; correctIndex: number; category: string; isActive: boolean }>
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (fields.question !== undefined) { sets.push(`question = $${i++}`); vals.push(fields.question); }
  if (fields.options !== undefined) { sets.push(`options = $${i++}`); vals.push(JSON.stringify(fields.options)); }
  if (fields.correctIndex !== undefined) { sets.push(`correct_index = $${i++}`); vals.push(fields.correctIndex); }
  if (fields.category !== undefined) { sets.push(`category = $${i++}`); vals.push(fields.category); }
  if (fields.isActive !== undefined) { sets.push(`is_active = $${i++}`); vals.push(fields.isActive); }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE quiz_questions SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

export async function deleteQuestion(id: number): Promise<void> {
  await pool.query(`DELETE FROM quiz_questions WHERE id = $1`, [id]);
}
