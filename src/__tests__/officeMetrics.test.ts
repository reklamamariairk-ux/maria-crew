import { calculateOfficeScore, type OfficeMetricDefinition } from '../services/officeMetrics.service';

const definitions: OfficeMetricDefinition[] = [
  { id: 1, targetValue: 100, weight: 60, direction: 'higher' },
  { id: 2, targetValue: 10, weight: 40, direction: 'lower' },
];

describe('calculateOfficeScore', () => {
  it('возвращает 100 при выполнении всех норм', () => {
    expect(calculateOfficeScore(definitions, { 1: 100, 2: 10 })).toBe(100);
  });

  it('учитывает веса и направление показателей', () => {
    // Первый показатель выполнен на 50% => 50 баллов с весом 60.
    // Второй превышает допустимый максимум вдвое => 0 баллов с весом 40.
    expect(calculateOfficeScore(definitions, { 1: 50, 2: 20 })).toBe(30);
  });

  it('допускает перевыполнение до 120 баллов', () => {
    expect(calculateOfficeScore([definitions[0]], { 1: 150 })).toBe(120);
  });

  it('не штрафует показатель lower в пределах нормы', () => {
    expect(calculateOfficeScore([definitions[1]], { 2: 0 })).toBe(100);
  });

  it('игнорирует пустые, отключённые и нулевые по весу показатели', () => {
    expect(calculateOfficeScore([
      { ...definitions[0], isActive: false },
      { ...definitions[1], weight: 0 },
    ], { 1: 100, 2: 10 })).toBeNull();
    expect(calculateOfficeScore(definitions, {})).toBeNull();
  });
});
