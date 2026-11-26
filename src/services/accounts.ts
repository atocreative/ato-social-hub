import crypto from 'node:crypto';
import { dbQuery, withTransaction } from '../db/pool.ts';
import { getInstagramAccountByIdOrUser } from '../db/repository.ts';
import { hashPassword } from '../utils/passwordHash.ts';
import { consumeToken, issueToken, peekToken } from './authTokens.ts';
import { mailTemplates, sendMail, sendMailBackground } from './mailer.ts';
import type { UserProfile } from '../types/index.ts';

export class AccountError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COMMON_PASSWORDS = new Set([
  '1234567890', '12345678910', 'password123', 'password1234', 'senha12345', 'senha123456', 'qwertyuiop', '1q2w3e4r5t',
  'abcd123456', 'iloveyou123', '0123456789', '666666', '6666666666', 'atosocialhub',
]);

export const normalizeEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();

export function validateEmail(email: string) {
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new AccountError(400, 'INVALID_EMAIL', 'Informe um endereço de e-mail válido.');
}

export function validatePassword(password: string, email?: string) {
  if (typeof password !== 'string' || password.length < 10) throw new AccountError(400, 'WEAK_PASSWORD', 'A senha precisa ter pelo menos 10 caracteres.');
  if (password.length > 128) throw new AccountError(400, 'WEAK_PASSWORD', 'A senha pode ter no máximo 128 caracteres.');
  const lower = password.toLowerCase();
  const local = (email || '').split('@')[0];
  if (COMMON_PASSWORDS.has(lower) || (local.length >= 4 && lower.includes(local)) || /^(.)\1+$/.test(password) || /^\d+$/.test(password)) {
    throw new AccountError(400, 'WEAK_PASSWORD', 'Escolha uma senha menos previsível (evite sequências, só números ou partes do seu e-mail).');
  }
}

export interface SignupInput {
  name: unknown;
  email: unknown;
  password: unknown;
  acceptTerms: unknown;
}

/**
 * Cadastro público. NÃO cria usuário: guarda o pedido (com a senha já protegida) até o e-mail ser confirmado,
 * para que ninguém "reserve" o e-mail de outra pessoa com uma senha que só ele conhece.
 * A resposta é sempre a mesma, exista ou não conta com o e-mail (sem enumeração).
 */
export async function requestSignup(input: SignupInput): Promise<void> {
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(input.email);
  const password = String(input.password ?? '');
  if (name.length < 2 || name.length > 120) throw new AccountError(400, 'INVALID_NAME', 'Informe seu nome completo.');
  validateEmail(email);
  validatePassword(password, email);
  if (input.acceptTerms !== true) throw new AccountError(400, 'TERMS_REQUIRED', 'É necessário aceitar os Termos de Uso e a Política de Privacidade.');

  const passwordHash = hashPassword(password); // sempre calculado: o tempo de resposta não revela se o e-mail existe
  const existing = await dbQuery<{ id: string }>('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
  if (existing.rows.length > 0) {
    sendMailBackground(mailTemplates.alreadyRegistered(email));
    return;
  }
  const token = await issueToken({
    purpose: 'EMAIL_VERIFY',
    email,
    payload: { name, passwordHash, termsAcceptedAt: new Date().toISOString() },
  });
  sendMailBackground(mailTemplates.verifyEmail(email, name, token));
}

/** Confirma o e-mail e só então cria o usuário (TENANT, sem empresa e sem papel de administrador). */
export async function verifyEmailAndCreateUser(rawToken: string): Promise<{ userId: string }> {
  const tok = await consumeToken(rawToken, 'EMAIL_VERIFY');
  if (!tok || !tok.payload?.passwordHash) throw new AccountError(400, 'INVALID_TOKEN', 'Este link é inválido, expirou ou já foi usado. Peça um novo cadastro.');
  const userId = `usr_${crypto.randomBytes(8).toString('hex')}`;
  try {
    await dbQuery(
      `INSERT INTO users (id, email, name, password_hash, role, status, company_id, instagram_account_id, permissions,
                          email_verified_at, terms_accepted_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'TENANT', 'APROVADO', NULL, NULL, $5::jsonb, NOW(), $6, NOW(), NOW())`,
      [userId, tok.email, tok.payload.name, tok.payload.passwordHash, JSON.stringify(['VIEW_COMPANY_POSTS', 'APPROVE_POSTS']), tok.payload.termsAcceptedAt || new Date().toISOString()]
    );
  } catch (err: any) {
    if (String(err?.code) === '23505') throw new AccountError(409, 'ALREADY_EXISTS', 'Este e-mail já está cadastrado. Entre com a sua senha.');
    throw err;
  }
  return { userId };
}

/** Pedido de nova senha. Resposta idêntica exista ou não a conta. Administradores globais não usam este caminho. */
export async function requestPasswordReset(emailInput: unknown): Promise<void> {
  const email = normalizeEmail(emailInput);
  if (!EMAIL_RE.test(email) || email.length > 254) return;
  const u = await dbQuery<{ id: string; role: string; password_hash: string | null }>(
    'SELECT id, role, password_hash FROM users WHERE LOWER(email) = $1 LIMIT 1',
    [email]
  );
  const row = u.rows[0];
  if (!row || row.role !== 'TENANT' || !row.password_hash) return;
  const token = await issueToken({ purpose: 'PASSWORD_RESET', email, userId: row.id });
  sendMailBackground(mailTemplates.resetPassword(email, token));
}

export async function resetPassword(rawToken: string, newPassword: unknown): Promise<{ userId: string }> {
  const peek = await peekToken(rawToken, 'PASSWORD_RESET');
  if (!peek) throw new AccountError(400, 'INVALID_TOKEN', 'Este link é inválido, expirou ou já foi usado. Peça um novo.');
  validatePassword(String(newPassword ?? ''), peek.email);
  const tok = await consumeToken(rawToken, 'PASSWORD_RESET');
  if (!tok || !tok.user_id) throw new AccountError(400, 'INVALID_TOKEN', 'Este link é inválido, expirou ou já foi usado. Peça um novo.');
  await dbQuery(
    `UPDATE users SET password_hash = $2, sessions_valid_after = NOW(), updated_at = NOW() WHERE id = $1 AND role = 'TENANT'`,
    [tok.user_id, hashPassword(String(newPassword))]
  );
  // Qualquer outro link de redefinição pendente deixa de valer.
  await dbQuery(`UPDATE auth_tokens SET used_at = NOW() WHERE user_id = $1 AND purpose = 'PASSWORD_RESET' AND used_at IS NULL`, [tok.user_id]);
  return { userId: tok.user_id };
}

const hex = (n: number) => crypto.randomBytes(n).toString('hex');

/** Cria o espaço de trabalho (empresa + conta de destino provisória) e torna o usuário seu proprietário, numa transação. */
export async function createWorkspace(userId: string, input: { companyName: unknown; workspaceName?: unknown }): Promise<void> {
  const companyName = String(input.companyName ?? '').trim().replace(/\s+/g, ' ');
  const workspaceName = String(input.workspaceName ?? '').trim().replace(/\s+/g, ' ') || companyName;
  if (companyName.length < 2 || companyName.length > 120) throw new AccountError(400, 'INVALID_COMPANY', 'Informe o nome da empresa ou marca.');
  if (workspaceName.length > 120) throw new AccountError(400, 'INVALID_WORKSPACE', 'O nome do espaço de trabalho é muito longo.');

  await withTransaction(async (tx) => {
    const u = await tx.query<{ id: string; role: string; company_id: string | null; instagram_account_id: string | null }>(
      'SELECT id, role, company_id, instagram_account_id FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    const row = u.rows[0];
    if (!row) throw new AccountError(404, 'NOT_FOUND', 'Usuário não encontrado.');
    if (row.role !== 'TENANT') throw new AccountError(403, 'FORBIDDEN', 'Administradores não criam espaços de trabalho por aqui.');
    if (row.company_id || row.instagram_account_id) throw new AccountError(409, 'WORKSPACE_EXISTS', 'Você já possui um espaço de trabalho.');

    const companyId = `company_${hex(8)}`;
    const tenantId = `tenant_${hex(8)}`;
    // O nome da empresa é único no banco, mas o nome informado nunca vincula ninguém a empresa existente:
    // em colisão, o espaço novo recebe um sufixo interno e continua exclusivo deste usuário.
    // O nome também não pode coincidir com a pasta do Drive de nenhum cliente, porque várias rotas antigas
    // resolvem empresa e posts por nome de pasta.
    const taken = await tx.query(
      `SELECT 1 FROM companies WHERE LOWER(name) = LOWER($1) OR LOWER(COALESCE(drive_folder_name, '')) = LOWER($1)
       UNION ALL SELECT 1 FROM instagram_accounts WHERE LOWER(COALESCE(drive_folder_name, '')) = LOWER($1)
       UNION ALL SELECT 1 FROM posts WHERE LOWER(COALESCE(drive_folder_name, '')) = LOWER($1)
       LIMIT 1`,
      [companyName]
    );
    const storedName = taken.rows.length > 0 ? `${companyName} (${hex(2)})` : companyName;
    // A pasta do espaço novo é um identificador interno, nunca derivado do texto digitado: não colide com nada.
    const folderKey = `workspace_${hex(8)}`;

    await tx.query(
      `INSERT INTO companies (id, name, drive_folder_name, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())`,
      [companyId, storedName, folderKey]
    );
    await tx.query(
      `INSERT INTO instagram_accounts
         (id, company_id, username, nome, instagram_user_id, drive_folder_name, status, connection_status, has_valid_token, granted_scopes, requested_at, approved_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'APROVADO', 'DESCONECTADO', FALSE, '[]'::jsonb, NOW(), NOW(), NOW(), NOW())`,
      [tenantId, companyId, `cadastro_${hex(6)}`, workspaceName, `pending_ig_${hex(6)}`, folderKey]
    );
    await tx.query(
      `UPDATE users SET company_id = $2, instagram_account_id = $3, workspace_role = 'OWNER', updated_at = NOW() WHERE id = $1`,
      [userId, companyId, tenantId]
    );
  });
}

/** Perfil usado na sessão. Reflete sempre o estado atual do banco. */
export async function getUserProfile(userId: string): Promise<{ user: UserProfile; tenant?: any } | null> {
  const r = await dbQuery<any>(
    `SELECT id, email, name, role, status, company_id, instagram_account_id, workspace_role, email_verified_at FROM users WHERE id = $1`,
    [userId]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.role === 'ADMIN') {
    return { user: { id: row.id, email: row.email, nome: row.name, role: 'ADMIN', status: row.status } };
  }
  let tenant: any = null;
  if (row.instagram_account_id) tenant = await getInstagramAccountByIdOrUser(row.instagram_account_id);
  const user: UserProfile = {
    id: row.id,
    email: row.email,
    nome: tenant?.nome || row.name,
    role: 'TENANT',
    tenantId: tenant?.id || row.instagram_account_id || undefined,
    companyId: tenant?.companyId || row.company_id || undefined,
    instagramUserId: tenant?.instagramUserId || undefined,
    instagramUsername: tenant?.username || undefined,
    status: tenant?.status || row.status || 'APROVADO',
    driveFolderName: tenant?.driveFolderName || null,
    driveFolderId: tenant?.driveFolderId || null,
    connectionStatus: tenant?.connectionStatus || 'DESCONECTADO',
    tokenIssuedAt: tenant?.tokenIssuedAt,
    tokenExpiresAt: tenant?.tokenExpiresAt,
    grantedScopes: tenant?.grantedScopes || [],
    workspaceRole: row.workspace_role || undefined,
    emailVerified: Boolean(row.email_verified_at) || undefined,
    needsWorkspace: !row.company_id && !row.instagram_account_id,
  };
  return { user, tenant: tenant || undefined };
}

// ---------------------------------------------------------------- Convites

export interface InviterContext {
  id: string;
  role: 'ADMIN' | 'TENANT';
}

/** Admin convida para qualquer empresa existente; proprietário convida apenas para a própria. Papel concedido: sempre MEMBRO. */
export async function createInvite(inviter: InviterContext, input: { email: unknown; companyId?: unknown }): Promise<void> {
  const email = normalizeEmail(input.email);
  validateEmail(email);
  let companyId = String(input.companyId ?? '').trim();

  if (inviter.role === 'TENANT') {
    const me = await dbQuery<{ company_id: string | null; workspace_role: string | null }>('SELECT company_id, workspace_role FROM users WHERE id = $1', [inviter.id]);
    const mine = me.rows[0];
    if (!mine?.company_id || mine.workspace_role !== 'OWNER') throw new AccountError(403, 'FORBIDDEN', 'Somente o proprietário do espaço de trabalho pode convidar pessoas.');
    if (companyId && companyId !== mine.company_id) throw new AccountError(403, 'FORBIDDEN', 'Você só pode convidar para o seu próprio espaço de trabalho.');
    companyId = mine.company_id;
  } else if (inviter.role === 'ADMIN') {
    if (!companyId) throw new AccountError(400, 'INVALID_COMPANY', 'Informe a empresa do convite.');
  } else {
    throw new AccountError(403, 'FORBIDDEN', 'Acesso negado.');
  }

  const company = await dbQuery<{ id: string; name: string }>('SELECT id, name FROM companies WHERE id = $1', [companyId]);
  if (company.rows.length === 0) throw new AccountError(404, 'NOT_FOUND', 'Empresa não encontrada.');

  const existing = await dbQuery<{ role: string }>('SELECT role FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
  if (existing.rows[0]?.role === 'ADMIN') throw new AccountError(409, 'INVALID_INVITEE', 'Este e-mail não pode ser convidado.');

  const token = await issueToken({ purpose: 'INVITE', email, companyId, invitedBy: inviter.id });
  await sendMail(mailTemplates.invite(email, company.rows[0].name, token));
}

export async function previewInvite(rawToken: string): Promise<{ email: string; companyName: string; hasAccount: boolean } | null> {
  const tok = await peekToken(rawToken, 'INVITE');
  if (!tok || !tok.company_id) return null;
  const c = await dbQuery<{ name: string }>('SELECT name FROM companies WHERE id = $1', [tok.company_id]);
  if (c.rows.length === 0) return null;
  const u = await dbQuery('SELECT 1 FROM users WHERE LOWER(email) = $1', [tok.email]);
  return { email: tok.email, companyName: c.rows[0].name, hasAccount: u.rows.length > 0 };
}

export async function acceptInvite(input: { token: string; name?: unknown; password?: unknown; acceptTerms?: unknown; sessionUserId?: string | null }): Promise<{ userId: string }> {
  const peek = await peekToken(input.token, 'INVITE');
  if (!peek || !peek.company_id) throw new AccountError(400, 'INVALID_TOKEN', 'Este convite é inválido, expirou ou já foi usado.');
  const companyId = peek.company_id;

  const existing = await dbQuery<{ id: string; role: string; company_id: string | null; instagram_account_id: string | null }>(
    'SELECT id, role, company_id, instagram_account_id FROM users WHERE LOWER(email) = $1 LIMIT 1',
    [peek.email]
  );
  const ex = existing.rows[0];

  if (ex) {
    if (ex.role !== 'TENANT') throw new AccountError(409, 'INVALID_INVITEE', 'Este convite não pode ser aceito por esta conta.');
    if (input.sessionUserId !== ex.id) throw new AccountError(401, 'LOGIN_REQUIRED', 'Entre na sua conta com o e-mail convidado para aceitar o convite.');
    if (ex.company_id && ex.company_id !== companyId) {
      throw new AccountError(409, 'ALREADY_IN_WORKSPACE', 'Esta conta já pertence a outro espaço de trabalho. Use outro e-mail para este convite.');
    }
  } else {
    const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 120) throw new AccountError(400, 'INVALID_NAME', 'Informe seu nome completo.');
    validatePassword(String(input.password ?? ''), peek.email);
    if (input.acceptTerms !== true) throw new AccountError(400, 'TERMS_REQUIRED', 'É necessário aceitar os Termos de Uso e a Política de Privacidade.');
  }

  return await withTransaction(async (tx) => {
    const used = await tx.query(
      `UPDATE auth_tokens SET used_at = NOW() WHERE token_hash = $1 AND purpose = 'INVITE' AND used_at IS NULL AND expires_at > NOW() RETURNING id`,
      [crypto.createHash('sha256').update(input.token).digest('hex')]
    );
    if (used.rows.length === 0) throw new AccountError(400, 'INVALID_TOKEN', 'Este convite é inválido, expirou ou já foi usado.');
    const tenantRes = await tx.query<{ id: string }>('SELECT id FROM instagram_accounts WHERE company_id = $1 ORDER BY created_at ASC LIMIT 1', [companyId]);
    const tenantId = tenantRes.rows[0]?.id || null;

    if (ex) {
      await tx.query(
        `UPDATE users SET company_id = $2, instagram_account_id = COALESCE(instagram_account_id, $3),
                workspace_role = COALESCE(workspace_role, 'MEMBER'), email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW()
          WHERE id = $1`,
        [ex.id, companyId, tenantId]
      );
      return { userId: ex.id };
    }
    const userId = `usr_${hex(8)}`;
    await tx.query(
      `INSERT INTO users (id, email, name, password_hash, role, status, company_id, instagram_account_id, workspace_role, permissions,
                          email_verified_at, terms_accepted_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'TENANT', 'APROVADO', $5, $6, 'MEMBER', $7::jsonb, NOW(), NOW(), NOW(), NOW())`,
      [userId, peek.email, String(input.name).trim().replace(/\s+/g, ' '), hashPassword(String(input.password)), companyId, tenantId, JSON.stringify(['VIEW_COMPANY_POSTS', 'APPROVE_POSTS'])]
    );
    return { userId };
  });
}
