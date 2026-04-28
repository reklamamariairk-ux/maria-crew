import { pool } from '../db/pool';
import { irkutskDate } from './streak.service';

export interface QuizQuestion {
  id: number;
  question: string;
  options: string[];
  correctIndex: number;
  category: string;
}

export async function getDailyQuestions(employeeId: number): Promise<{ questions: QuizQuestion[]; alreadyDone: boolean }> {
  const today = irkutskDate();

  // Check if already answered 5+ questions today (по иркутскому дню)
  const { rows: todayAttempts } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM quiz_attempts
     WHERE employee_id = $1
       AND (answered_at AT TIME ZONE 'Asia/Irkutsk')::date = $2::date`,
    [employeeId, today]
  );
  const doneCount = parseInt(todayAttempts[0]?.count ?? '0', 10);
  if (doneCount >= 5) return { questions: [], alreadyDone: true };

  // Questions not answered in last 7 days
  const { rows } = await pool.query<QuizQuestion>(
    `SELECT id, question, options, correct_index AS "correctIndex", category
     FROM quiz_questions
     WHERE is_active = true
       AND id NOT IN (
         SELECT question_id FROM quiz_attempts
         WHERE employee_id = $1 AND answered_at > NOW() - INTERVAL '7 days'
       )
     ORDER BY RANDOM()
     LIMIT 5`,
    [employeeId]
  );

  // If not enough fresh questions, top-up from all active
  if (rows.length < 5) {
    const usedIds = rows.map(r => r.id);
    const { rows: extra } = await pool.query<QuizQuestion>(
      `SELECT id, question, options, correct_index AS "correctIndex", category
       FROM quiz_questions
       WHERE is_active = true
         AND id != ALL($1)
       ORDER BY RANDOM()
       LIMIT $2`,
      [usedIds.length ? usedIds : [0], 5 - rows.length]
    );
    rows.push(...extra);
  }

  // Strip correctIndex before sending to client
  return {
    questions: rows.map(q => ({ ...q, correctIndex: -1 })),
    alreadyDone: false,
    // We keep the full questions server-side; client submits answers one-by-one
  } as unknown as { questions: QuizQuestion[]; alreadyDone: boolean };
}

export async function getDailyQuestionsWithAnswers(employeeId: number): Promise<{ questions: QuizQuestion[]; alreadyDone: boolean }> {
  const today = new Date().toISOString().split('T')[0];

  const { rows: todayAttempts } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM quiz_attempts
     WHERE employee_id = $1 AND answered_at::date = $2`,
    [employeeId, today]
  );
  const doneCount = parseInt(todayAttempts[0]?.count ?? '0', 10);
  if (doneCount >= 5) return { questions: [], alreadyDone: true };

  const { rows } = await pool.query<QuizQuestion>(
    `SELECT id, question, options, correct_index AS "correctIndex", category
     FROM quiz_questions
     WHERE is_active = true
       AND id NOT IN (
         SELECT question_id FROM quiz_attempts
         WHERE employee_id = $1 AND answered_at > NOW() - INTERVAL '7 days'
       )
     ORDER BY RANDOM()
     LIMIT 5`,
    [employeeId]
  );

  if (rows.length < 5) {
    const usedIds = rows.map(r => r.id);
    const { rows: extra } = await pool.query<QuizQuestion>(
      `SELECT id, question, options, correct_index AS "correctIndex", category
       FROM quiz_questions
       WHERE is_active = true
         AND id != ALL($1)
       ORDER BY RANDOM()
       LIMIT $2`,
      [usedIds.length ? usedIds : [0], 5 - rows.length]
    );
    rows.push(...extra);
  }

  return { questions: rows, alreadyDone: false };
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
  const coinsEarned = isCorrect ? 2 : 0;

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
