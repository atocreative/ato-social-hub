import crypto from 'crypto';
import { dbQuery } from '../db/pool.ts';
import { hashPassword } from '../utils/passwordHash.ts';

/**
 * Provisionamento de login (e-mail/senha) para empresas já existentes.
 *
 * Contexto: antes, entrar com o Instagram criava a sessão da empresa sem e-mail nem senha. Agora a
 * autenticação no Social Hub é separada da autorização do Instagram, então essas empresas precisam de um login.
 * Nada é removido: cria o usuário (ou habilita a senha do usuário automático do Instagram, que não tinha senha) e recusa qualquer empresa que já tenha login com senha.
 */

export interface TenantWithoutLogin {
  id: string;
  username: string;
  nome: string;
  status: string;
  connectionStatus: string;
  driveFolderName: string | null;
  companyId: string | null;
  instagramUserId: string | null;
  hasValidToken: boolean;
  /** Usuário já ligado a esta empresa (ex.: criado automaticamente ao conectar o Instagram). */
  existingUserId: string | null;
  existingUserEmail: string | null;
}

/** Somente leitura. */
export async function listTenantsWithoutLogin(): Promise<TenantWithoutLogin[]> {
  // "Sem login" = não existe usuário da empresa com senha. O usuário automático criado ao conectar o
  // Instagram (e-mail sintético @instagram.ato.hub, sem senha) não conta como login.
  const res = await dbQuery<any>(
    `
    SELECT a.id, a.username, a.nome, a.status, a.connection_status, a.drive_folder_name,
           a.company_id, a.instagram_user_id, a.has_valid_token,
           eu.id AS existing_user_id, eu.email AS existing_user_email
      FROM instagram_accounts a
      LEFT JOIN LATERAL (
        SELECT u.id, u.email FROM users u
         WHERE u.role = 'TENANT' AND (u.instagram_account_id = a.id OR u.id = 'usr_' || a.id)
         LIMIT 1
      ) eu ON TRUE
     WHERE NOT EXISTS (
       SELECT 1 FROM users u
        WHERE u.role = 'TENANT'
          AND (u.instagram_account_id = a.id OR u.id = 'usr_' || a.id)
          AND u.password_hash IS NOT NULL AND u.password_hash <> '' AND u.password_hash NOT LIKE 'disabled$%'
     )
     ORDER BY a.username
    `
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    username: r.username,
    nome: r.nome,
    status: r.status,
    connectionStatus: r.connection_status,
    driveFolderName: r.drive_folder_name || null,
    companyId: r.company_id || null,
    instagramUserId: r.instagram_user_id || null,
    hasValidToken: Boolean(r.has_valid_token),
    existingUserId: r.existing_user_id || null,
    existingUserEmail: r.existing_user_email || null,
  }));
}

export function generateStrongPassword(): string {
  // 24 caracteres, alfabeto sem símbolos ambíguos.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export interface TenantLoginPlan {
  tenantId: string;
  email: string;
  action: 'ENABLE_PASSWORD_ON_EXISTING_USER' | 'INSERT_USER';
  userId: string;
  /** Vínculos que permanecem exatamente como estão (nada é movido ou removido). */
  preserved: { companyId: string | null; instagramAccountId: string; instagramUserId: string | null };
  tenantName: string;
  tenantStatus: string;
}

/**
 * Simulação SEM escrita: valida e descreve o que seria feito. Lança erro nos mesmos casos em que a criação recusa.
 */
export async function planTenantLogin(input: { tenantId: string; email: string; name?: string }): Promise<TenantLoginPlan> {
  const email = String(input.email || '').trim().toLowerCase();
  if (!email.includes('@') || email.length < 5) throw new Error('E-mail inválido.');

  const tenantRes = await dbQuery<any>(
    `SELECT id, nome, status, company_id, instagram_user_id FROM instagram_accounts WHERE id = $1 LIMIT 1`,
    [input.tenantId]
  );
  const tenant = tenantRes.rows[0];
  if (!tenant) throw new Error(`Empresa "${input.tenantId}" não encontrada.`);

  const existingForTenant = await dbQuery<any>(
    `SELECT id, email, password_hash FROM users WHERE role = 'TENANT' AND (instagram_account_id = $1 OR id = $2) LIMIT 1`,
    [tenant.id, `usr_${tenant.id}`]
  );
  const existingUser = existingForTenant.rows[0];
  const hasPassword =
    existingUser && existingUser.password_hash && !String(existingUser.password_hash).startsWith('disabled$');
  if (hasPassword) {
    throw new Error('Esta empresa já possui um login com senha. Nada foi alterado.');
  }
  const existingEmail = await dbQuery<any>(`SELECT id FROM users WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1`, [
    email,
    existingUser?.id || '',
  ]);
  if (existingEmail.rows.length > 0) {
    throw new Error('Já existe um usuário com este e-mail. Nada foi alterado.');
  }

  return {
    tenantId: tenant.id,
    email,
    action: existingUser ? 'ENABLE_PASSWORD_ON_EXISTING_USER' : 'INSERT_USER',
    userId: existingUser?.id || `usr_${tenant.id}`,
    preserved: { companyId: tenant.company_id || null, instagramAccountId: tenant.id, instagramUserId: tenant.instagram_user_id || null },
    tenantName: tenant.nome,
    tenantStatus: tenant.status,
  };
}

/**
 * Cria o login de UMA empresa. Recusa se a empresa já tiver login com senha ou se o e-mail já estiver em uso.
 * Só acrescenta/habilita credenciais: company_id, instagram_account_id e a conta Instagram não são tocados.
 * Retorna a senha gerada (exibida uma única vez; só o hash scrypt é gravado).
 */
export async function createTenantLogin(input: {
  tenantId: string;
  email: string;
  name?: string;
  password?: string;
}): Promise<{ userId: string; email: string; password: string }> {
  const plan = await planTenantLogin(input);
  const password = input.password || generateStrongPassword();
  if (password.length < 12) throw new Error('A senha precisa ter ao menos 12 caracteres.');

  if (plan.action === 'ENABLE_PASSWORD_ON_EXISTING_USER') {
    // Usuário automático do Instagram (sem senha): habilita o login preservando o ID e os vínculos.
    await dbQuery(`UPDATE users SET email = $2, password_hash = $3, updated_at = NOW() WHERE id = $1`, [
      plan.userId,
      plan.email,
      hashPassword(password),
    ]);
  } else {
    await dbQuery(
      `
      INSERT INTO users (id, email, name, password_hash, role, status, company_id, instagram_account_id, permissions, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'TENANT', $5, $6, $7, '[]'::jsonb, NOW(), NOW())
      `,
      [plan.userId, plan.email, input.name || plan.tenantName, hashPassword(password), plan.tenantStatus, plan.preserved.companyId, plan.tenantId]
    );
  }
  return { userId: plan.userId, email: plan.email, password };
}
