export interface PasswordValidationResult {
  ok: boolean;
  error?: string;
  checks: {
    length: boolean;
    upper: boolean;
    lower: boolean;
    number: boolean;
    special: boolean;
    noPersonal: boolean;
  };
}

/**
 * Shared strong-password validator (spec S-4 / F-4.1):
 * - Strictly more than 8 characters (9–128 chars)
 * - At least 1 uppercase, 1 lowercase, 1 number, 1 special character
 * - Must not contain the student's ID or email username
 */
export function validateStrongPassword(
  password: string,
  context?: { studentId?: string | null; email?: string | null }
): PasswordValidationResult {
  const pwd = String(password || "");
  const length = pwd.length >= 9 && pwd.length <= 128;
  const upper = /[A-Z]/.test(pwd);
  const lower = /[a-z]/.test(pwd);
  const number = /[0-9]/.test(pwd);
  const special = /[^A-Za-z0-9]/.test(pwd);

  const lowerPwd = pwd.toLowerCase();
  let noPersonal = true;
  const sn = (context?.studentId || "").trim().toLowerCase();
  if (sn && sn.length >= 4 && lowerPwd.includes(sn)) noPersonal = false;
  const localPart = (context?.email || "").split("@")[0]?.trim().toLowerCase() || "";
  if (localPart && localPart.length >= 4 && lowerPwd.includes(localPart)) noPersonal = false;

  const checks = { length, upper, lower, number, special, noPersonal };
  if (!length) {
    return { ok: false, error: "Password must be more than 8 characters (at least 9 characters).", checks };
  }
  if (!upper || !lower || !number || !special) {
    return {
      ok: false,
      error: "Password must include uppercase, lowercase, a number, and a special character (e.g. !@#$%).",
      checks,
    };
  }
  if (!noPersonal) {
    return {
      ok: false,
      error: "Password must not contain your student number or email username.",
      checks,
    };
  }
  return { ok: true, checks };
}
