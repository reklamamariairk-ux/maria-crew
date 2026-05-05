import { COIN_AMOUNTS } from '../services/coin.service';

describe('COIN_AMOUNTS — фиксация значений', () => {
  // Эти тесты документируют текущие значения наград.
  // При изменении — обнови И тесты, И тексты в Mini App / боте / напоминалках.
  // Без этого UI и сервер разойдутся (как однажды было: UI «+2», сервер «+1»).

  it('квиз = 1 монета за правильный ответ (до 5/день)', () => {
    expect(COIN_AMOUNTS.quiz).toBe(1);
  });

  it('ежедневный вход = 1 монета (бонус +5 за каждый 7-й день — в streak.service)', () => {
    expect(COIN_AMOUNTS.checkin).toBe(1);
  });

  it('чек-лист 100% = 1 монета', () => {
    expect(COIN_AMOUNTS.checklist_day).toBe(1);
  });

  it('именной отзыв = 3 монеты', () => {
    expect(COIN_AMOUNTS.review).toBe(3);
  });

  it('подмена коллеги = 5 монет', () => {
    expect(COIN_AMOUNTS.substitution).toBe(5);
  });

  it('наставничество = 10 монет (самая ценная активность)', () => {
    expect(COIN_AMOUNTS.mentoring).toBe(10);
  });

  it('идея внедрена = 5 монет', () => {
    expect(COIN_AMOUNTS.idea).toBe(5);
  });

  it('собрание по обучению = 5 монет', () => {
    expect(COIN_AMOUNTS.training_meeting).toBe(5);
  });

  it('применение знаний = 3 монеты', () => {
    expect(COIN_AMOUNTS.knowledge_applied).toBe(3);
  });

  it('штрафы — отрицательные', () => {
    expect(COIN_AMOUNTS.bad_review).toBe(-5);
    expect(COIN_AMOUNTS.dirty_store).toBe(-5);
    expect(COIN_AMOUNTS.training_resistance).toBe(-3);
  });
});
