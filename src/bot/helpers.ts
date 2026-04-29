const MONTHS_RU = [
  '', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

const MONTHS_RU_GENITIVE = [
  '', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function monthName(month: number, genitive = false): string {
  return genitive ? MONTHS_RU_GENITIVE[month] : MONTHS_RU[month];
}

export function currentPeriod(): { year: number; month: number } {
  const irk = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return { year: irk.getUTCFullYear(), month: irk.getUTCMonth() + 1 };
}

const RANK_EMOJI = ['🥇', '🥈', '🥉'];
export function rankEmoji(rank: number): string {
  return RANK_EMOJI[rank - 1] ?? `${rank}.`;
}

export function coinReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    checklist_day:       'Чек-лист 100%',
    review:              'Именной отзыв',
    cake_order:          'Торт на заказ',
    substitution:        'Подмена коллеги',
    mentoring:           'Наставничество',
    idea:                'Идея внедрена',
    training_meeting:    'Собрание по обучению',
    knowledge_applied:   'Применение знаний',
    bad_review:          'Отрицательный отзыв',
    dirty_store:         'Нарушение стандартов чистоты',
    training_resistance: 'Сопротивление обучению',
    spend:               'Обмен в Store',
    manual:              'Начисление',
    quiz:                'Квиз',
    checkin:             'Вход в приложение',
  };
  return labels[reason] ?? reason;
}

export function cardSourceLabel(source: string): string {
  const labels: Record<string, string> = {
    mystery_shopper: 'Тайный покупатель',
    review:          'Отзыв гостя',
    checklist:       'Чек-лист 100%',
    plan:            'План 105%+',
    mvp:             'MVP точки',
    team_bonus:      'Топ-точка',
    seasonal:        'Сезонный челлендж',
    certification:   'Аттестация',
    manual:          'Начисление',
  };
  return labels[source] ?? source;
}

/** Форматирует дату «22 апр» */
export function shortDate(d: Date): string {
  return `${d.getDate()} ${monthName(d.getMonth() + 1, true).slice(0, 3)}`;
}

/** Экранирует HTML-спецсимволы */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
