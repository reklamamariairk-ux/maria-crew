-- Залоченный ежедневный набор вопросов квиза для каждого сотрудника.
-- При первом открытии квиза в этот день генерируется набор из 5 вопросов
-- и сохраняется здесь, чтобы набор оставался одинаковым весь день.

CREATE TABLE IF NOT EXISTS quiz_sessions (
  id            SERIAL PRIMARY KEY,
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  quiz_date     DATE NOT NULL,         -- иркутская дата (CURRENT_DATE AT ZONE)
  question_ids  INTEGER[] NOT NULL,    -- ID вопросов в порядке показа
  UNIQUE (employee_id, quiz_date)
);

CREATE INDEX IF NOT EXISTS idx_quiz_sessions_emp_date ON quiz_sessions(employee_id, quiz_date DESC);
