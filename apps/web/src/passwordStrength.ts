export type PasswordStrength = "weak" | "fair" | "strong";

/**
 * Every password field in the app enforces only a bare minLength=8 --
 * "aaaaaaaa" and "K7$mq!zX9pL" both pass that check identically, with
 * nothing telling a person which one is actually the weaker choice. This
 * is a plain point score (length brackets + character-class variety),
 * not a real entropy estimate -- good enough to nudge someone away from
 * the obviously-weak case without pretending to be a security audit.
 * Returns null for an empty password, so callers can hide the meter
 * entirely before anything has been typed.
 */
export function getPasswordStrength(password: string): PasswordStrength | null {
  if (password.length === 0) return null;
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/[0-9]/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  if (score <= 2) return "weak";
  if (score <= 3) return "fair";
  return "strong";
}
