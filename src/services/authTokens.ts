import crypto from 'node:crypto';
import { dbQuery } from '../db/pool.ts';

// Tokens de e-mail (verificação, redefinição de senha, convite): aleatórios, de uso único, com validade,
// e guardados apenas como SHA-256. O valor bruto só existe no link enviado por e-mail.
export type TokenPurpose = 'EMAIL_VERIFY' | 'PASSWORD_RESET' | 'INVITE';

export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  EMAIL_VERIFY: 24 * 60 * 60 * 1000,
  PASSWORD_RESET: 60 * 60 * 1000,
  INVITE: 7 * 24 * 60 * 60 * 1000,
};

export interface AuthTokenRow {
  id: string;
  purpose: TokenPurpose;
  user_id: string | null;
  email: string;
  company_id: string | null;
  invited_by: string | null;
  payload: any;
}

export const hashToken = (raw: string) => crypto.createHash('sha256').update(String(raw)).digest('hex');
export const hashForBucket = (value: string) => crypto.createHash('sha256').update(String(value).toLowerCase()).digest('hex').slice(0, 24);

/** Emite um token novo e invalida os anteriores ainda não usados do mesmo tipo para o mesmo e-mail (e empresa, no convite). */
export async function issueToken(input: {
  purpose: TokenPurpose;
  email: string;
  userId?: string | null;
  companyId?: string | null;
  invitedBy?: string | null;
  payload?: Record<string, unknown> | null;
}): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const raw = crypto.randomBytes(32).toString('base64url');
  await dbQuery(
    `UPDATE auth_tokens SET used_at = NOW()
      WHERE purpose = $1 AND LOWER(email) = $2 AND used_at IS NULL AND COALESCE(company_id, '') = COALESCE($3, '')`,
    [input.purpose, email, input.companyId ?? null]
  );
  await dbQuery(
    `INSERT INTO auth_tokens (id, purpose, token_hash, user_id, email, company_id, invited_by, payload, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      `tok_${crypto.randomBytes(8).toString('hex')}`,
      input.purpose,
      hashToken(raw),
      input.userId ?? null,
      email,
      input.companyId ?? null,
      input.invitedBy ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
      new Date(Date.now() + TOKEN_TTL_MS[input.purpose]).toISOString(),
    ]
  );
  return raw;
}

/** Consulta sem consumir (usada só para pré-visualizar convites). */
export async function peekToken(raw: string, purpose: TokenPurpose): Promise<AuthTokenRow | null> {
  if (!raw || typeof raw !== 'string' || raw.length > 200) return null;
  const r = await dbQuery<AuthTokenRow>(
    `SELECT id, purpose, user_id, email, company_id, invited_by, payload FROM auth_tokens
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > NOW()`,
    [hashToken(raw), purpose]
  );
  return r.rows[0] || null;
}

/** Consome atomicamente: dois cliques simultâneos no mesmo link nunca passam os dois. */
export async function consumeToken(raw: string, purpose: TokenPurpose): Promise<AuthTokenRow | null> {
  if (!raw || typeof raw !== 'string' || raw.length > 200) return null;
  const r = await dbQuery<AuthTokenRow>(
    `UPDATE auth_tokens SET used_at = NOW()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > NOW()
      RETURNING id, purpose, user_id, email, company_id, invited_by, payload`,
    [hashToken(raw), purpose]
  );
  return r.rows[0] || null;
}

/**
 * Limite de tentativas por janela fixa, no PostgreSQL (vale para várias instâncias).
 * Retorna true se a tentativa ainda cabe no limite.
 */
export async function allowAttempt(bucket: string, max: number, windowSec: number): Promise<boolean> {
  const windowMs = windowSec * 1000;
  const start = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
  const r = await dbQuery<{ hits: number }>(
    `INSERT INTO auth_rate_limits (bucket, window_start, hits) VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET hits = auth_rate_limits.hits + 1
     RETURNING hits`,
    [bucket.slice(0, 190), start]
  );
  if (Math.random() < 0.02) {
    // Limpeza oportunista; falha aqui nunca bloqueia o fluxo.
    dbQuery(`DELETE FROM auth_rate_limits WHERE window_start < NOW() - INTERVAL '2 days'`).catch(() => {});
    dbQuery(`DELETE FROM auth_tokens WHERE expires_at < NOW() - INTERVAL '30 days'`).catch(() => {});
  }
  return Number(r.rows[0]?.hits || 0) <= max;
}
