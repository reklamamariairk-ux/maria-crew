import { pool } from '../db/pool';
import { irkutskDate } from './streak.service';
import { COIN_AMOUNTS } from './coin.service';

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

export async function getDailyQuestionsWithAnswers(
  employeeId: number
): Promise<{ questions: QuizQuestion[]; alreadyDone: boolean; answeredToday: number; totalToday: number }> {
  const today = irkutskDate();

  const { rows: todayAttempts } = await pool.query<{ questionId: number }>(
    `SELECT question_id AS "questionId" FROM quiz_attempts
     WHERE employee_id = $1
       AND (answered_at AT TIME ZONE 'Asia/Irkutsk')::date = $2::date`,
    [employeeId, today]
  );
  const answeredToday = todayAttempts.length;
  const questionIds = await getOrCreateDailySession(employeeId);
  const totalToday = questionIds.length;

  if (answeredToday >= 5) return { questions: [], alreadyDone: true, answeredToday, totalToday };
  const answeredIds = new Set(todayAttempts.map(r => r.questionId));
  const remaining = questionIds.filter(id => !answeredIds.has(id));
  if (remaining.length === 0) return { questions: [], alreadyDone: true, answeredToday, totalToday };

  const { rows } = await pool.query<QuizQuestion>(
    `SELECT id, question, options, correct_index AS "correctIndex", category
     FROM quiz_questions
     WHERE id = ANY($1) AND is_active = true`,
    [remaining]
  );

  const ordered = remaining
    .map(id => rows.find(r => r.id === id))
    .filter((q): q is QuizQuestion => q !== undefined);

  return { questions: ordered, alreadyDone: false, answeredToday, totalToday };
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
  const reward = isCorrect ? COIN_AMOUNTS.quiz : 0;

  // UNIQUE-индекс на (employee_id, question_id, иркутский день) защищает от
  // повторного ответа: ON CONFLICT DO NOTHING вернёт пустой rowCount, и тогда
  // монеты не начислим (ни в первый, ни во второй раз — иначе задвоится).
  const inserted = await pool.query(
    `INSERT INTO quiz_attempts (employee_id, question_id, is_correct, coins_earned)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (employee_id, question_id, ((answered_at AT TIME ZONE 'Asia/Irkutsk')::date))
     DO NOTHING`,
    [employeeId, questionId, isCorrect, reward]
  );

  const coinsEarned = (inserted.rowCount ?? 0) > 0 ? reward : 0;

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

// ── CSV-импорт ────────────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set([
  'product', 'service', 'crew', 'brand',
  'sales', 'upsell', 'loyalty', 'cashier', 'display',
]);

// Принимаемые обозначения правильного ответа: А-Г, A-D, 1-4, 0-3.
// Возвращает 0-based индекс или null, если значение невалидно.
function parseCorrectIndex(raw: string): number | null {
  const v = raw.trim().toUpperCase();
  const ruMap: Record<string, number> = { 'А': 0, 'Б': 1, 'В': 2, 'Г': 3 };
  if (v in ruMap) return ruMap[v];
  const enMap: Record<string, number> = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
  if (v in enMap) return enMap[v];
  if (v === '1') return 0;
  if (v === '2') return 1;
  if (v === '3') return 2;
  if (v === '4') return 3;
  if (v === '0') return 0;
  return null;
}

/**
 * Минимальный RFC 4180 парсер без зависимостей.
 * Поддерживает кавычки, удвоенные кавычки внутри кавычек, переносы внутри кавычек,
 * \r\n и \n. BOM в начале срезается.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field); rows.push(row);
      row = []; field = ''; i++; continue;
    }
    field += ch; i++;
  }

  // Последняя строка без trailing \n
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Отбрасываем полностью пустые строки (например, лишний \n в конце)
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

export interface CsvImportError {
  line: number;
  message: string;
}
export interface CsvImportResult {
  added: number;
  total: number;
  errors: CsvImportError[];
}

/**
 * Импорт вопросов из CSV. Шапка обязательна, ожидаемые колонки:
 *   question,option_a,option_b,option_c,option_d,correct,category
 * Значения correct: А/Б/В/Г (или A-D / 1-4 / 0-3). Категория из VALID_CATEGORIES.
 * Невалидные строки пропускаются, но возвращаются в errors[].
 */
export async function importQuestionsFromCsv(csv: string): Promise<CsvImportResult> {
  const rows = parseCsv(csv);
  if (rows.length === 0) {
    return { added: 0, total: 0, errors: [{ line: 0, message: 'Файл пуст' }] };
  }

  // Шапка — нормализуем и валидируем
  const header = rows[0].map(c => c.trim().toLowerCase());
  const expected = ['question', 'option_a', 'option_b', 'option_c', 'option_d', 'correct', 'category'];
  for (const col of expected) {
    if (!header.includes(col)) {
      return {
        added: 0,
        total: 0,
        errors: [{ line: 1, message: `В шапке нет колонки "${col}". Ожидается: ${expected.join(', ')}` }],
      };
    }
  }
  const idx: Record<string, number> = {};
  expected.forEach(c => { idx[c] = header.indexOf(c); });

  const errors: CsvImportError[] = [];
  const valid: { question: string; options: string[]; correctIndex: number; category: string }[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const lineNumber = r + 1; // в файле строки 1-based, шапка = 1
    const question = (cells[idx.question] ?? '').trim();
    const options = [
      (cells[idx.option_a] ?? '').trim(),
      (cells[idx.option_b] ?? '').trim(),
      (cells[idx.option_c] ?? '').trim(),
      (cells[idx.option_d] ?? '').trim(),
    ];
    const correctRaw = (cells[idx.correct] ?? '').trim();
    const category = (cells[idx.category] ?? '').trim().toLowerCase();

    if (!question) { errors.push({ line: lineNumber, message: 'Пустой вопрос' }); continue; }
    if (options.some(o => !o)) { errors.push({ line: lineNumber, message: 'Не все варианты ответов заполнены' }); continue; }

    const correctIndex = parseCorrectIndex(correctRaw);
    if (correctIndex === null) {
      errors.push({ line: lineNumber, message: `Некорректный correct: "${correctRaw}". Ожидается А/Б/В/Г` });
      continue;
    }
    if (!VALID_CATEGORIES.has(category)) {
      errors.push({ line: lineNumber, message: `Неизвестная категория: "${category}". Доступные: ${[...VALID_CATEGORIES].join(', ')}` });
      continue;
    }

    valid.push({ question, options, correctIndex, category });
  }

  // Bulk INSERT одной транзакцией — либо все валидные сохраняются, либо ничего
  let added = 0;
  if (valid.length > 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const q of valid) {
        await client.query(
          `INSERT INTO quiz_questions (question, options, correct_index, category)
           VALUES ($1, $2, $3, $4)`,
          [q.question, JSON.stringify(q.options), q.correctIndex, q.category]
        );
        added++;
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      added = 0;
      errors.push({ line: 0, message: `Ошибка БД: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      client.release();
    }
  }

  return { added, total: rows.length - 1, errors };
}
