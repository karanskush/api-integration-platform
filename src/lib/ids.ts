import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// 10 chars of [a-z0-9] ≈ 51 bits — plenty for unguessable ephemeral ids.
export function newId(length = 10): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function isValidId(id: string): boolean {
  return /^[a-z0-9]{10}$/.test(id);
}
