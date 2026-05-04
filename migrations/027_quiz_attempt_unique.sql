-- Защита от двойного начисления монет за один вопрос в один день.
-- Без этого: пользователь может ответить на 3 вопроса, закрыть Mini App,
-- открыть заново и получить ещё +3 монеты, отвечая на те же вопросы.
-- Также apiFetch на клиенте ретраит при сетевых сбоях, что тоже может задвоить запись.
--
-- Сначала чистим возможные дубликаты, оставляя самую раннюю попытку за день.
DELETE FROM quiz_attempts a
USING quiz_attempts b
WHERE a.employee_id = b.employee_id
  AND a.question_id = b.question_id
  AND (a.answered_at AT TIME ZONE 'Asia/Irkutsk')::date
      = (b.answered_at AT TIME ZONE 'Asia/Irkutsk')::date
  AND a.id > b.id;

-- Уникальный индекс по (employee_id, question_id, иркутская дата ответа).
CREATE UNIQUE INDEX IF NOT EXISTS uq_quiz_attempts_emp_q_irkutsk_day
  ON quiz_attempts (
    employee_id,
    question_id,
    ((answered_at AT TIME ZONE 'Asia/Irkutsk')::date)
  );
