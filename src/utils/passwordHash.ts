import crypto from 'crypto';

/**
 * Hash de senha com scrypt (salgado, custo configurável) e verificação em tempo constante.
 * Formato: scrypt$N$r$p$<salt base64>$<hash base64>
 *
 * Compatibilidade: hashes antigos (SHA-256 hexadecimal, sem sal) continuam sendo aceitos no login
 * e devem ser regravados em scrypt assim que a senha for validada (needsRehash = true).
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function legacySha256(password: string): string {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyPassword(
  password: string,
  stored: string | null | undefined
): { ok: boolean; needsRehash: boolean } {
  if (!stored) return { ok: false, needsRehash: false };

  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 6) return { ok: false, needsRehash: false };
    const [, n, r, p, saltB64, hashB64] = parts;
    try {
      const expected = Buffer.from(hashB64, 'base64');
      const derived = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
      });
      return { ok: safeEqual(derived, expected), needsRehash: false };
    } catch {
      return { ok: false, needsRehash: false };
    }
  }

  // Legado: SHA-256 hexadecimal sem sal.
  const legacy = legacySha256(password);
  const ok = safeEqual(Buffer.from(legacy, 'utf8'), Buffer.from(stored, 'utf8'));
  return { ok, needsRehash: ok };
}

/** Hash que nunca corresponde a nenhuma senha (conta sem login habilitado). */
export function unusablePasswordHash(): string {
  return `disabled$${crypto.randomBytes(24).toString('hex')}`;
}
