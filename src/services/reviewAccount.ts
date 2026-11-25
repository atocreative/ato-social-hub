import { dbQuery } from '../db/pool.ts';
import { hashPassword } from '../utils/passwordHash.ts';
import { generateStrongPassword } from './tenantLogins.ts';

// Conta de avaliação para o revisor da Meta: empresa própria, SEM Instagram vinculado e SEM dados de clientes.
// O revisor entra com e-mail e senha e conecta a conta profissional de teste pelo fluxo normal (Conta → Conectar Instagram).
// Nenhuma validação é desativada: é um usuário TENANT comum, restrito à própria empresa.
export const REVIEW_COMPANY_ID = 'company_meta_review';
export const REVIEW_COMPANY_NAME = 'Meta Review Demo';
export const REVIEW_TENANT_ID = 'tenant_meta_review';
export const REVIEW_USER_ID = 'usr_meta_review';
export const REVIEW_PLACEHOLDER_USERNAME = 'cadastro_meta_review';

export interface ReviewAccountPlan {
  email: string;
  companyId: string;
  tenantId: string;
  userId: string;
  willCreate: { company: boolean; instagramPlaceholder: boolean; user: boolean };
}

export async function planReviewAccount(emailInput: string): Promise<ReviewAccountPlan> {
  const email = String(emailInput || '').trim().toLowerCase();
  if (!email.includes('@') || email.length < 5) throw new Error('E-mail inválido.');

  const user = await dbQuery<any>(`SELECT id FROM users WHERE id = $1 OR LOWER(email) = $2 LIMIT 1`, [REVIEW_USER_ID, email]);
  if (user.rows.length > 0) throw new Error('Já existe um usuário de avaliação ou com este e-mail. Nada foi alterado.');
  const tenant = await dbQuery<any>(`SELECT id FROM instagram_accounts WHERE id = $1 OR username = $2 LIMIT 1`, [
    REVIEW_TENANT_ID,
    REVIEW_PLACEHOLDER_USERNAME,
  ]);
  const company = await dbQuery<any>(`SELECT id FROM companies WHERE id = $1 OR name = $2 LIMIT 1`, [REVIEW_COMPANY_ID, REVIEW_COMPANY_NAME]);
  return {
    email,
    companyId: REVIEW_COMPANY_ID,
    tenantId: REVIEW_TENANT_ID,
    userId: REVIEW_USER_ID,
    willCreate: { company: company.rows.length === 0, instagramPlaceholder: tenant.rows.length === 0, user: true },
  };
}

/** Só INSERE registros próprios da conta de avaliação. Nunca altera empresas, contas ou usuários existentes. */
export async function createReviewAccount(input: { email: string; password?: string }): Promise<{ email: string; password: string; userId: string }> {
  const plan = await planReviewAccount(input.email);
  const password = input.password || generateStrongPassword();
  if (password.length < 12) throw new Error('A senha precisa ter ao menos 12 caracteres.');

  if (plan.willCreate.company) {
    await dbQuery(
      `INSERT INTO companies (id, name, drive_folder_name, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())`,
      [REVIEW_COMPANY_ID, REVIEW_COMPANY_NAME, REVIEW_COMPANY_NAME]
    );
  }
  if (plan.willCreate.instagramPlaceholder) {
    await dbQuery(
      `INSERT INTO instagram_accounts
         (id, company_id, username, nome, instagram_user_id, drive_folder_name, status, connection_status, has_valid_token, granted_scopes, requested_at, approved_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'APROVADO', 'DESCONECTADO', FALSE, '[]'::jsonb, NOW(), NOW(), NOW(), NOW())`,
      [REVIEW_TENANT_ID, REVIEW_COMPANY_ID, REVIEW_PLACEHOLDER_USERNAME, REVIEW_COMPANY_NAME, 'pending_ig_meta_review', REVIEW_COMPANY_NAME]
    );
  }
  await dbQuery(
    `INSERT INTO users (id, email, name, password_hash, role, status, company_id, instagram_account_id, permissions, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'TENANT', 'APROVADO', $5, $6, '[]'::jsonb, NOW(), NOW())`,
    [REVIEW_USER_ID, plan.email, 'Avaliação Meta', hashPassword(password), REVIEW_COMPANY_ID, REVIEW_TENANT_ID]
  );
  return { email: plan.email, password, userId: REVIEW_USER_ID };
}
