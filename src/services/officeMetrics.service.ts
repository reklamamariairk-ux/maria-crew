export interface OfficeMetricDefinition {
  id: number;
  targetValue: number;
  weight: number;
  direction: 'higher' | 'lower';
  isActive?: boolean;
}

/**
 * Считает единый балл из настраиваемых офисных показателей.
 *
 * higher: выполнение нормы = 100, перевыполнение допускается до 120.
 * lower: значение в пределах нормы = 100; превышение плавно уменьшает балл.
 * В расчёт входят только заполненные активные показатели с весом > 0.
 */
export function calculateOfficeScore(
  definitions: OfficeMetricDefinition[],
  values: Record<number, number | null | undefined>,
): number | null {
  let weightedTotal = 0;
  let totalWeight = 0;

  for (const definition of definitions) {
    if (definition.isActive === false || definition.weight <= 0) continue;
    const value = values[definition.id];
    if (value === null || value === undefined || !Number.isFinite(value)) continue;

    const target = Math.max(0, definition.targetValue);
    let score: number;
    if (definition.direction === 'higher') {
      if (target === 0) continue;
      score = Math.max(0, Math.min(120, (value / target) * 100));
    } else if (value <= target) {
      score = 100;
    } else {
      const scale = Math.max(target, 1);
      score = Math.max(0, 100 - ((value - target) / scale) * 100);
    }

    weightedTotal += score * definition.weight;
    totalWeight += definition.weight;
  }

  if (totalWeight === 0) return null;
  return Math.round((weightedTotal / totalWeight) * 10) / 10;
}
