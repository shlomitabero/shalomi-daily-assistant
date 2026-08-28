// Rivalry (section 12), simplified to what the current data model can back
// honestly: the closest competitor by net worth right now. There's no
// historical snapshot table yet, so this deliberately doesn't fabricate a
// "gaining on you" trend — just an accurate live comparison.
export function findNearestRival(myProfileId, myNetWorth, rankRows) {
  const others = rankRows.filter((r) => r.profile_id !== myProfileId);
  if (!others.length) return null;
  let closest = others[0];
  for (const r of others) {
    if (Math.abs(r.net_worth_at - myNetWorth) < Math.abs(closest.net_worth_at - myNetWorth)) closest = r;
  }
  return closest;
}
