import { pool } from './pool';

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 12 основных героев
    const heroes = [
      { name: 'Пекарь Антон',    description: 'Мастер слоёного теста' },
      { name: 'Кондитер Света',  description: 'Королева торта на заказ' },
      { name: 'Баристо Макс',    description: 'Кофейный волшебник' },
      { name: 'Кассир Аня',      description: 'Быстрее всех в кассе' },
      { name: 'Уборщик Гена',    description: 'Идеальный чек-лист каждый день' },
      { name: 'Наставник Ирина', description: 'Обучила уже 10 новичков' },
      { name: 'Продавец Дима',   description: 'Король апсейла' },
      { name: 'Декоратор Оля',   description: 'Витрина, как в журнале' },
      { name: 'Технолог Борис',  description: 'Хранитель рецептов' },
      { name: 'Логист Женя',     description: 'Всегда вовремя и без потерь' },
      { name: 'Менеджер Катя',   description: 'Лучший тайный покупатель боится' },
      { name: 'Основатель Мария',description: 'Легендарная карточка. Редкая.' },
    ];

    for (let i = 0; i < heroes.length; i++) {
      await client.query(
        `INSERT INTO heroes (name, description, sort_order)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [heroes[i].name, heroes[i].description, i + 1]
      );
    }
    console.log('  → heroes seeded');

    // 4 лимитных сезонных героя
    const limited = [
      { name: 'Ice Breaker',     season: 'summer' },
      { name: 'Upsale King',     season: 'autumn' },
      { name: 'Holiday Star',    season: 'winter' },
      { name: 'Rookie of Season',season: 'spring' },
    ];
    for (let i = 0; i < limited.length; i++) {
      await client.query(
        `INSERT INTO heroes (name, is_limited, season, sort_order)
         VALUES ($1, true, $2, $3)
         ON CONFLICT DO NOTHING`,
        [limited[i].name, limited[i].season, 100 + i]
      );
    }
    console.log('  → limited heroes seeded');

    // 16 точек (реальные адреса с maria-irk.ru)
    const stores = [
      { name: 'Ржанова',                  address: 'ул. Ржанова, 45/2' },
      { name: 'Дьяконова',                address: 'ул. Э. Дьяконова, 10' },
      { name: 'Байкальская 295Б',          address: 'ул. Байкальская, 295Б' },
      { name: 'Рабочая',                  address: 'ул. Рабочая, 2а/4' },
      { name: 'Лермонтова 81/5',           address: 'ул. Лермонтова, 81/5' },
      { name: 'ТЦ Сезон',                 address: 'ул. Свердлова, 36' },
      { name: 'Пушкина',                  address: 'ул. Пушкина, 9' },
      { name: 'Верхняя Набережная',        address: 'ул. Верхняя Набережная, 161/16' },
      { name: 'Баррикад',                 address: 'ул. Баррикад, 153' },
      { name: 'Лермонтова 343/8',          address: 'ул. Лермонтова, 343/8' },
      { name: 'Ядринцева',                address: 'ул. Ядринцева, 90' },
      { name: 'Депутатская',              address: 'ул. Депутатская, 51' },
      { name: 'Байкальская 141',           address: 'ул. Байкальская, 141' },
      { name: 'Юбилейный',                address: 'мкр. Юбилейный, 56' },
      { name: 'Жукова',                   address: 'пр-т Жукова, 11/4' },
      { name: 'Декабрьских Событий',       address: 'ул. Декабрьских Событий, 103' },
    ];
    for (const s of stores) {
      await client.query(
        `INSERT INTO stores (name, address) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [s.name, s.address]
      );
    }
    console.log('  → stores seeded');

    // Каталог призов Maria Store
    const prizes = [
      // Обмен карточек
      { name: 'Торт или пирог «Мария»',         type: 'cake',         cards: 3,  coins: 0,  order: 1 },
      { name: 'Сертификат 1 500₽ (Ozon/кино)',  type: 'certificate',  cards: 5,  coins: 0,  order: 2 },
      { name: 'Денежная премия 3 000₽',         type: 'cash',         cards: 7,  coins: 0,  order: 3 },
      { name: 'Премия 5 000₽ + выбор смен',     type: 'shift_choice', cards: 10, coins: 0,  order: 4 },
      { name: 'Золотой бейдж 7 000₽ + выходной',type: 'golden_badge', cards: 12, coins: 0,  order: 5 },
      // Обмен монет
      { name: 'Кофе + десерт в «Марии»',        type: 'coffee',       cards: 0,  coins: 10, order: 10 },
      { name: 'Скидка 30% на торт на заказ',    type: 'discount',     cards: 0,  coins: 20, order: 11 },
      { name: 'Мерч Maria Crew',                type: 'merch',        cards: 0,  coins: 30, order: 12 },
      { name: 'Сертификат 2 000₽ (Ozon/WB)',    type: 'certificate',  cards: 0,  coins: 50, order: 13 },
      { name: 'Доп. перерыв 15 мин.',           type: 'break',        cards: 0,  coins: 15, order: 14 },
    ];

    for (const p of prizes) {
      await client.query(
        `INSERT INTO prizes (name, prize_type, cards_required, coins_required, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [p.name, p.type, p.cards, p.coins, p.order]
      );
    }
    console.log('  → prizes seeded');

    await client.query('COMMIT');
    console.log('✓ Seed complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
