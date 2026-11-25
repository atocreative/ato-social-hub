import crypto from 'crypto';
import { dbQuery } from '../db/pool.ts';

/**
 * Armazenamento OAuth no PostgreSQL (compartilhado entre instâncias, com expiração e uso único).
 * Falha FECHADA: se o banco estiver indisponível, a conexão do Instagram não prossegue.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function newOpaqueSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export interface OAuthStateRecord {
  nonce: string;
  userId: string;
  role: 'ADMIN' | 'TENANT';
  tenantId: string | null;
  driveFolderName: string | null;
  redirectUri: string;
  browserBinding: string;
}

export async function createOAuthState(input: {
  nonce: string;
  userId: string;
  role: 'ADMIN' | 'TENANT';
  tenantId?: string | null;
  driveFolderName?: string | null;
  redirectUri: string;
  browserBindingHash: string;
}): Promise<void> {
  // Limpeza oportunista de registros expirados.
  await dbQuery(`DELETE FROM oauth_states WHERE expires_at < NOW() - INTERVAL '1 hour'`);
  await dbQuery(
    `INSERT INTO oauth_states
       (nonce, user_id, role, tenant_id, drive_folder_name, redirect_uri, browser_binding, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + ($8 || ' milliseconds')::interval)`,
    [
      input.nonce,
      input.userId,
      input.role,
      input.tenantId || null,
      input.driveFolderName || null,
      input.redirectUri,
      input.browserBindingHash,
      String(OAUTH_STATE_TTL_MS),
    ]
  );
}

/** Consome o state de forma atômica: só retorna se existir, não expirou e ainda não foi usado. */
export async function consumeOAuthState(nonce: string): Promise<OAuthStateRecord | null> {
  const res = await dbQuery<any>(
    `UPDATE oauth_states SET consumed_at = NOW()
      WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > NOW()
      RETURNING nonce, user_id, role, tenant_id, drive_folder_name, redirect_uri, browser_binding`,
    [nonce]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    nonce: row.nonce,
    userId: row.user_id,
    role: row.role,
    tenantId: row.tenant_id || null,
    driveFolderName: row.drive_folder_name || null,
    redirectUri: row.redirect_uri,
    browserBinding: row.browser_binding,
  };
}

/** Marca o código de autorização como usado. Retorna false se já tinha sido usado. */
export async function markOAuthCodeUsed(code: string): Promise<boolean> {
  await dbQuery(`DELETE FROM oauth_used_codes WHERE expires_at < NOW()`);
  const res = await dbQuery<any>(
    `INSERT INTO oauth_used_codes (code_hash, expires_at)
     VALUES ($1, NOW() + INTERVAL '1 day')
     ON CONFLICT (code_hash) DO NOTHING
     RETURNING code_hash`,
    [sha256Hex(code)]
  );
  return res.rows.length > 0;
}

export interface PendingAccountChoice {
  id: string;
  username: string;
}

export interface PendingConnectionRecord {
  id: string;
  userId: string;
  role: 'ADMIN' | 'TENANT';
  tenantId: string | null;
  driveFolderName: string | null;
  encryptedAccessToken: string;
  tokenType: string;
  tokenIssuedAt: string;
  tokenExpiresAt: string | null;
  grantedScopes: string[];
  accounts: PendingAccountChoice[];
}

export async function createPendingConnection(input: {
  id: string;
  secret: string;
  userId: string;
  role: 'ADMIN' | 'TENANT';
  tenantId?: string | null;
  driveFolderName?: string | null;
  encryptedAccessToken: string;
  tokenType: string;
  tokenIssuedAt: string;
  tokenExpiresAt?: string | null;
  grantedScopes: string[];
  accounts: PendingAccountChoice[];
}): Promise<void> {
  await dbQuery(`DELETE FROM oauth_pending_connections WHERE expires_at < NOW() - INTERVAL '1 hour'`);
  await dbQuery(
    `INSERT INTO oauth_pending_connections
      (id, secret_hash, user_id, role, tenant_id, drive_folder_name, encrypted_access_token, token_type,
       token_issued_at, token_expires_at, granted_scopes, accounts, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb, NOW() + ($13 || ' milliseconds')::interval)`,
    [
      input.id,
      sha256Hex(input.secret),
      input.userId,
      input.role,
      input.tenantId || null,
      input.driveFolderName || null,
      input.encryptedAccessToken,
      input.tokenType,
      input.tokenIssuedAt,
      input.tokenExpiresAt || null,
      JSON.stringify(input.grantedScopes),
      JSON.stringify(input.accounts),
      String(OAUTH_PENDING_TTL_MS),
    ]
  );
}

/**
 * Consome a conexão pendente (uso único) somente se o segredo confere e a conta escolhida
 * está entre as contas realmente autorizadas pelo usuário no diálogo da Meta.
 */
export async function consumePendingConnection(
  id: string,
  secret: string,
  chosenAccountId: string
): Promise<{ record: PendingConnectionRecord; account: PendingAccountChoice } | null> {
  const res = await dbQuery<any>(
    `UPDATE oauth_pending_connections SET consumed_at = NOW()
      WHERE id = $1 AND secret_hash = $2 AND consumed_at IS NULL AND expires_at > NOW()
        AND accounts @> $3::jsonb
      RETURNING *`,
    [id, sha256Hex(secret), JSON.stringify([{ id: chosenAccountId }])]
  );
  const row = res.rows[0];
  if (!row) return null;
  const accounts: PendingAccountChoice[] = Array.isArray(row.accounts) ? row.accounts : [];
  const account = accounts.find((a) => String(a.id) === String(chosenAccountId));
  if (!account) return null;
  return {
    account,
    record: {
      id: row.id,
      userId: row.user_id,
      role: row.role,
      tenantId: row.tenant_id || null,
      driveFolderName: row.drive_folder_name || null,
      encryptedAccessToken: row.encrypted_access_token,
      tokenType: row.token_type,
      tokenIssuedAt: new Date(row.token_issued_at).toISOString(),
      tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at).toISOString() : null,
      grantedScopes: Array.isArray(row.granted_scopes) ? row.granted_scopes : [],
      accounts,
    },
  };
}

/** Lista as contas de uma conexão pendente (sem token) para montar a tela de seleção. */
export async function getPendingAccounts(id: string, secret: string): Promise<PendingAccountChoice[] | null> {
  const res = await dbQuery<any>(
    `SELECT accounts FROM oauth_pending_connections
      WHERE id = $1 AND secret_hash = $2 AND consumed_at IS NULL AND expires_at > NOW()`,
    [id, sha256Hex(secret)]
  );
  const row = res.rows[0];
  return row ? (Array.isArray(row.accounts) ? row.accounts : []) : null;
}
