import { createHash } from 'node:crypto';

// A stable key for "this exact action, for this opportunity, on this day"
// so a crash-and-retry can never charge or order twice.
export function makeIdempotencyKey({ opportunityId, actionType, dateKey }) {
  return createHash('sha256').update(`${opportunityId}:${actionType}:${dateKey}`).digest('hex');
}

export function wasAlreadyPerformed(key, performedKeys) {
  return performedKeys.includes(key);
}
