/**
 * Date of birth in, age out.
 *
 * `patients.date_of_birth` is stored; age is NOT. FR-2.2 asks for age, but an
 * age column is wrong twice over: it is derivable, and it is wrong again on
 * every birthday. This is the one place that derives it.
 *
 * `date_of_birth` is a Postgres `DATE` - a calendar day with no time and no
 * zone. Everything here works in UTC so that the day stored is the day
 * entered, whatever the server or the phone is set to.
 */

/** `1990-04-17` -> a UTC-midnight Date, or null if it is not a real date. */
export function parseDateOfBirth(input: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return null;

  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  // Rejects 2026-02-30 and friends, which Date.UTC would happily roll forward.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** Back out again, so the API speaks the same `YYYY-MM-DD` it accepts. */
export function formatDateOfBirth(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Completed years. Someone born on 29 February is a year older on 1 March in
 * a non-leap year, which is what the month/day comparison below gives.
 */
export function ageFrom(dateOfBirth: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();

  const monthDelta = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  const beforeBirthday =
    monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dateOfBirth.getUTCDate());
  if (beforeBirthday) age -= 1;

  return age;
}

/** Nobody is born tomorrow, and nobody on this platform is 130. */
export function isPlausibleDateOfBirth(date: Date, now: Date = new Date()): boolean {
  if (date.getTime() > now.getTime()) return false;
  return ageFrom(date, now) <= 120;
}

/**
 * `Anita Sharma` -> `AS`. FR-9.2 puts initials, age and gender on the doctor's
 * appointment card rather than a name: the card is a list on a screen someone
 * else can see, and the doctor has the full record inside the consultation.
 */
export function initialsOf(fullName: string | null): string | null {
  if (!fullName) return null;
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  // First and last only - middle names would make the card ragged.
  const picked = parts.length === 1 ? [parts[0]] : [parts[0], parts[parts.length - 1]];
  return picked.map((part) => [...part][0]?.toUpperCase() ?? '').join('');
}
