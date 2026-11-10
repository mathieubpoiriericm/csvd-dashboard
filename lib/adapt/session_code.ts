/** Crockford base32 without I, L, O, U. */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 20; // 100 bits
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** The 20 characters, upper case, or null when the input is not a code. */
export function normaliseCode(input: string): string | null {
  const code = input
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (code.length !== CODE_LENGTH) return null;
  for (const c of code) if (!CODE_ALPHABET.includes(c)) return null;
  return code;
}

/** "ABCDE-FGHJK-MNPQR-STVWX" from a normalised code. */
export function formatCode(code: string): string {
  return code.match(/.{5}/g)!.join("-");
}

/** A new normalised code from `random` (crypto.getRandomValues by default). */
export function generateCode(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) =>
    crypto.getRandomValues(b),
): string {
  const bytes = random(new Uint8Array(CODE_LENGTH));
  // 32 symbols, so the low five bits carry no modulo bias.
  return Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join("");
}
