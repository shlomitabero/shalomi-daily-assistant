// The referral loop's rules, kept pure and separate from the DB writes
// that apply them (services/referral.js) so the "who gets credited, and
// under what conditions" logic is independently testable.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

export function createReferralCode(rng = Math.random, length = 7) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  }
  return code;
}

// A referral is creditable once: not self-referral, and this new user
// hasn't already redeemed a code.
export function shouldCreditReferral({ referrerId, newUserId, newUserAlreadyReferred }) {
  if (!referrerId) return false;
  if (referrerId === newUserId) return false;
  if (newUserAlreadyReferred) return false;
  return true;
}
