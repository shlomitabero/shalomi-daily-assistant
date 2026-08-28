// Resolves a Decision Engine choice into concrete, deterministic effects.
// A free-text response is mapped to the closest fixed option by keyword —
// this keeps every outcome inside the same small, testable rule set instead
// of letting free text touch money directly (same principle as negotiation.js).

function inferChoiceFromText(text = '') {
  const t = text.toLowerCase();
  // `.{0,20}` keeps "let ... go" bounded and word-boundaried so it can't
  // match a "go" hidden inside an unrelated word (e.g. "let's neGOtiate").
  if (/\bfire\b|\bterminate\b|\blet\b.{0,20}\bgo\b/.test(t)) return 'fire';
  if (/\bequity\b|\bshares?\b|\bstake\b/.test(t)) return 'equity';
  if (/\bno\b|\brefuse\b|not going to|won'?t|\breject\b/.test(t)) return 'refuse';
  if (/\bnegotiate\b|meet.{0,15}\bmiddle\b|\bcompromise\b|\blower\b|\bhalf\b/.test(t)) return 'negotiate';
  return 'pay';
}

export function resolveDecision({ choice, freeText, employeeName }) {
  const key = choice ?? inferChoiceFromText(freeText ?? '');

  switch (key) {
    case 'pay':
      return {
        key: 'pay', salaryMultiplier: 1.3, qualityDelta: 4, loyaltyDelta: 15, ownershipDelta: 0, fired: false,
        resultText: `You gave ${employeeName} the full raise. Loyalty is way up.`,
      };
    case 'negotiate':
      return {
        key: 'negotiate', salaryMultiplier: 1.15, qualityDelta: 2, loyaltyDelta: 6, ownershipDelta: 0, fired: false,
        resultText: `You met ${employeeName} in the middle at a 15% raise.`,
      };
    case 'equity':
      return {
        key: 'equity', salaryMultiplier: 1, qualityDelta: 3, loyaltyDelta: 20, ownershipDelta: -2, fired: false,
        resultText: `You offered ${employeeName} a 2% equity stake instead of cash.`,
      };
    case 'refuse':
      return {
        key: 'refuse', salaryMultiplier: 1, qualityDelta: -6, loyaltyDelta: -25, ownershipDelta: 0, fired: false,
        resultText: `You refused. Morale took a real hit.`,
      };
    case 'fire':
      return {
        key: 'fire', salaryMultiplier: 1, qualityDelta: -10, loyaltyDelta: 0, ownershipDelta: 0, fired: true,
        resultText: `You let ${employeeName} go rather than negotiate.`,
      };
    default:
      return resolveDecision({ choice: 'negotiate', employeeName });
  }
}
