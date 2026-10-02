import * as argon2 from 'argon2';

/**
 * Admin passwords. Argon2id at the OWASP minimum parameters, which is what
 * makes a stolen `password_hash` column expensive rather than useful.
 * Patients have no password - they sign in by OTP only.
 */
const HASH_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

/**
 * The cost parameters are read from the digest itself, so they are not passed
 * here - an old hash still verifies after `HASH_OPTIONS` is raised. A
 * malformed or foreign digest is a failed sign-in rather than a 500.
 */
export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(digest, plain);
  } catch {
    return false;
  }
}
