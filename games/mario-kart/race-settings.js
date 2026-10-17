export const MAX_LAPS = 20;
export function normalizeLaps(value) {
  if (value === null || value === undefined || value === '') return 3;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(MAX_LAPS, Math.trunc(number))) : 3;
}
