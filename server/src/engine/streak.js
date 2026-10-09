// Daily streak — pure date-math so it's testable without mocking the clock
// via the DB. "Yesterday" is computed from the two YYYY-MM-DD keys
// directly rather than parsing/re-diffing dates, so it's unambiguous.
export function computeStreakUpdate({ lastDate, today, currentStreak }) {
  if (lastDate === today) return { streak: currentStreak, isNewDay: false };
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayKey = yesterday.toISOString().slice(0, 10);
  const streak = lastDate === yesterdayKey ? currentStreak + 1 : 1;
  return { streak, isNewDay: true };
}
