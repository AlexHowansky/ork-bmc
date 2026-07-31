/**
 * Password hashing and policy.
 *
 * Argon2id at OWASP's recommended cost (19 MiB, 2 iterations, 1 lane).
 * Bun implements this natively, so there is no third-party crypto dependency.
 */
import { config } from '../config.ts';
import { validationFailed } from '../errors.ts';

const ARGON2_OPTIONS = {
  algorithm: 'argon2id',
  memoryCost: 19_456, // KiB
  timeCost: 2,
} as const;

/**
 * Upper bound on accepted passwords. Argon2's cost is dominated by its memory
 * parameter rather than input length, but refusing megabyte "passwords" keeps
 * the hash path bounded regardless.
 */
const MAX_PASSWORD_LENGTH = 1024;

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    // A malformed hash in the database must read as "wrong password", never as
    // a crash that distinguishes this account from any other.
    return false;
  }
}

/**
 * A throwaway hash verified against when no account matches, so a login attempt
 * for an unknown email costs the same wall-clock time as one for a real
 * account. Without this, response latency alone enumerates valid addresses.
 */
let decoyHash: Promise<string> | undefined;

export async function wastePasswordVerifyTime(password: string): Promise<void> {
  decoyHash ??= hashPassword('decoy-password-never-matches-anything');
  await verifyPassword(password, await decoyHash);
}

/** Validates a new password against policy. Throws `AppError` with field messages. */
export function assertPasswordAcceptable(password: string, field = 'password'): void {
  if (password.length < config.minPasswordLength) {
    throw validationFailed({
      [field]: `Password must be at least ${config.minPasswordLength} characters long.`,
    });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw validationFailed({
      [field]: `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`,
    });
  }
}
