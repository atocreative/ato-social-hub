import crypto from 'node:crypto';
import { dbQuery, withTransaction } from '../db/pool.ts';

export type AccessStatus = 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED';
export type MemberRole = 'OWNER' | 'MEMBER';

export class MembershipError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'MembershipError';
  }
}

const hex = (n: number) => crypto.randomBytes(n).toString('hex');
/** Regra para quem ainda não tem linha em memberships (dados anteriores): vínculo existente e situação não bloqueada = ACTIVE. */
const BLOCKED_STATUS = ['AGUARDANDO_APROVACAO', 'PENDENTE', 'REJEITADO', 'SUSPENSO'];
const legacyActive = (userStatus: unknown, hasLink: unknown, accountStatus?: unknown) =>
  Boolean(hasLink) && !BLOCKED_STATUS.includes(String(userStatus || '')) && !BLOCKED_STATUS.includes(String(accountStatus || ''));
const isPlaceholderTenant = (username: unknown, igId: unknown) =>
  String(username || '').toLowerCase().startsWith('cadastro_') || String(igId || '').startsWith('pending_ig_');

export interface FreshAccess {
  userId: string;
  role: 'ADMIN' | 'TENANT';
  accessStatus: AccessStatus;
  companyId: string | null;
  workspaceRole: MemberRole | null;
  tenant: null | {
    id: string;
    username: string;
    instagramUserId: string;
    driveFolderName: string | null;
    driveFolderId: string | null;
    status: string;
  };
  sessionsValidAfterMs: number | null;
}

/**
 * Estado de acesso VIGENTE de um usuário, sempre lido do PostgreSQL (nunca do JWT).
 * É o que impede o reuso de tokens antigos depois de aprovação, troca de empresa, suspensão ou exclusão.
 * Usuário sem linha em `memberships` (legado semeado direto) é tratado pela regra antiga: aprovado e com empresa/conta = ACTIVE.
 */
export async function loadFreshAccess(userId: string): Promise<FreshAccess | null> {
  const r = await dbQuery<any>(
    `SELECT u.id, u.role, u.status AS user_status, u.company_id AS u_company, u.instagram_account_id, u.workspace_role,
            u.sessions_valid_after, m.status AS m_status, m.company_id AS m_company, m.role AS m_role,
            ia.id AS ia_id, ia.username AS ia_username, ia.instagram_user_id AS ia_igid, ia.drive_folder_name AS ia_folder,
            ia.drive_folder_id AS ia_folder_id, ia.status AS ia_status, ia.company_id AS ia_company
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       LEFT JOIN instagram_accounts ia ON ia.id = u.instagram_account_id
      WHERE u.id = $1`,
    [userId]
  );
  const row = r.rows[0];
  if (!row) return null;
  const sva = row.sessions_valid_after ? new Date(row.sessions_valid_after).getTime() : null;
  if (row.role === 'ADMIN') {
    return { userId: row.id, role: 'ADMIN', accessStatus: 'ACTIVE', companyId: null, workspaceRole: null, tenant: null, sessionsValidAfterMs: sva };
  }
  let accessStatus: AccessStatus;
  if (row.m_status) accessStatus = row.m_status as AccessStatus;
  else accessStatus = legacyActive(row.user_status, row.u_company || row.instagram_account_id, row.ia_status) ? 'ACTIVE' : 'PENDING_APPROVAL';

  const active = accessStatus === 'ACTIVE';
  const companyId = active ? row.m_company || row.u_company || row.ia_company || null : null;
  // A conta da empresa é a que vale. Se o usuário aponta para um registro arquivado/desconectado (ex.: o Instagram foi
  // reconectado e o registro antigo foi liberado), usa a conta conectada de verdade da própria empresa.
  let own: { id: any; username: any; igid: any; folder: any; folderId: any; status: any } | null = row.ia_id
    ? { id: row.ia_id, username: row.ia_username, igid: row.ia_igid, folder: row.ia_folder, folderId: row.ia_folder_id, status: row.ia_status }
    : null;
  if (active && companyId) {
    const ownOk = row.ia_id && row.ia_company === companyId && !String(row.ia_igid || '').startsWith('liberada_');
    if (!ownOk) {
      const c = await dbQuery<any>(
        `SELECT id, username, instagram_user_id, drive_folder_name, drive_folder_id, status FROM instagram_accounts
          WHERE company_id = $1 AND instagram_user_id NOT LIKE 'liberada\_%'
          ORDER BY (connection_status = 'CONECTADO') DESC, (instagram_user_id NOT LIKE 'pending_ig_%') DESC, created_at ASC LIMIT 1`,
        [companyId]
      );
      const r0 = c.rows[0];
      if (r0) own = { id: r0.id, username: r0.username, igid: r0.instagram_user_id, folder: r0.drive_folder_name, folderId: r0.drive_folder_id, status: r0.status };
    }
  }
  const tenant =
    active && own
      ? {
          id: own.id,
          username: own.username,
          instagramUserId: own.igid,
          driveFolderName: own.folder || null,
          driveFolderId: own.folderId || null,
          status: own.status,
        }
      : null;
  return {
    userId: row.id,
    role: 'TENANT',
    accessStatus,
    companyId,
    workspaceRole: active ? ((row.m_role || row.workspace_role || 'MEMBER') as MemberRole) : null,
    tenant,
    sessionsValidAfterMs: sva,
  };
}

/** Rotas (relativas a /api) que um usuário ainda não aprovado pode usar: perfil, conectar Instagram, aceitar convite, sair e excluir a própria conta. */
const PENDING_ALLOWED: RegExp[] = [
  /^\/auth\/me$/,
  /^\/auth\/profile$/,
  /^\/auth\/instagram\/(url|sync-session|select)$/,
  /^\/invites\/accept$/,
  /^\/account\/delete$/,
  /^\/health$/,
];
export function isAllowedWhileNotActive(path: string): boolean {
  return PENDING_ALLOWED.some((re) => re.test(path.replace(/\/+$/, '') || '/'));
}

// ------------------------------------------------------------------ Operações administrativas

async function audit(
  tx: { query: (sql: string, p?: any[]) => Promise<any> },
  e: { actor: string; action: string; targetUserId?: string; targetEmail?: string; from?: string | null; to?: string | null; details?: any }
) {
  await tx.query(
    `INSERT INTO admin_audit_log (id, actor_user_id, action, target_user_id, target_email, company_from, company_to, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [`aud_${hex(8)}`, e.actor, e.action, e.targetUserId || null, e.targetEmail || null, e.from || null, e.to || null, JSON.stringify(e.details || {})]
  );
}

/** Conta da empresa que os membros enxergam: prefere a conectada de verdade; nunca a de outra empresa. */
async function pickCompanyTenant(tx: { query: (sql: string, p?: any[]) => Promise<any> }, companyId: string): Promise<string | null> {
  const r = await tx.query(
    `SELECT id FROM instagram_accounts WHERE company_id = $1
      ORDER BY (connection_status = 'CONECTADO') DESC, (instagram_user_id NOT LIKE 'pending_ig_%') DESC, created_at ASC LIMIT 1`,
    [companyId]
  );
  return r.rows[0]?.id || null;
}

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  createdAt: string | null;
  emailVerified: boolean;
  accessStatus: AccessStatus;
  companyId: string | null;
  companyName: string | null;
  workspaceRole: MemberRole | null;
  instagram: null | { id: string; username: string | null; connected: boolean; companyId: string | null };
  lastLoginAt: string | null;
  /** EMAIL_SIGNUP = cadastro com e-mail; INSTAGRAM_LEGACY = registro técnico criado por uma conexão Instagram antiga (e-mail @instagram.ato.hub, sem senha). */
  origin: 'EMAIL_SIGNUP' | 'INSTAGRAM_LEGACY';
}

/** Lista direto do PostgreSQL. Não depende de Google Drive, Meta nem do estado em memória. */
export async function listUsersForAdmin(): Promise<AdminUserRow[]> {
  const r = await dbQuery<any>(
    `SELECT u.id, u.name, u.email, u.created_at, u.email_verified_at, u.last_login_at, u.status AS user_status,
            u.company_id AS u_company, u.instagram_account_id, u.workspace_role,
            m.status AS m_status, m.company_id AS m_company, m.role AS m_role,
            c.name AS company_name,
            ia.id AS ia_id, ia.username AS ia_username, ia.instagram_user_id AS ia_igid, ia.connection_status AS ia_conn, ia.company_id AS ia_company, ia.status AS ia_status,
            pia.id AS p_id, pia.username AS p_username, pia.connection_status AS p_conn, pia.company_id AS p_company
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       LEFT JOIN companies c ON c.id = COALESCE(m.company_id, u.company_id)
       LEFT JOIN instagram_accounts ia ON ia.id = u.instagram_account_id
       LEFT JOIN instagram_accounts pia ON pia.connected_by_user_id = u.id
      WHERE u.role = 'TENANT'
      ORDER BY (COALESCE(m.status, 'PENDING_APPROVAL') = 'PENDING_APPROVAL') DESC, u.created_at DESC NULLS LAST`
  );
  const seen = new Set<string>();
  const out: AdminUserRow[] = [];
  for (const row of r.rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const status: AccessStatus =
      (row.m_status as AccessStatus) ||
      (legacyActive(row.user_status, row.u_company || row.instagram_account_id, row.ia_status) ? 'ACTIVE' : 'PENDING_APPROVAL');
    // Instagram "do usuário": a conexão que ele mesmo fez; senão a conta da empresa à qual está vinculado.
    const igSrc = row.p_id
      ? { id: row.p_id, username: row.p_username, igid: '', conn: row.p_conn, company: row.p_company }
      : row.ia_id
      ? { id: row.ia_id, username: row.ia_username, igid: row.ia_igid, conn: row.ia_conn, company: row.ia_company }
      : null;
    out.push({
      id: row.id,
      name: row.name,
      email: row.email,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      emailVerified: Boolean(row.email_verified_at),
      accessStatus: status,
      companyId: row.m_company || row.u_company || null,
      companyName: row.company_name || null,
      workspaceRole: status === 'ACTIVE' ? ((row.m_role || row.workspace_role || 'MEMBER') as MemberRole) : null,
      instagram: igSrc
        ? {
            id: igSrc.id,
            // Nunca devolve @ fabricado: conta provisória aparece sem username.
            username: isPlaceholderTenant(igSrc.username, igSrc.igid) ? null : igSrc.username,
            connected: igSrc.conn === 'CONECTADO' && !isPlaceholderTenant(igSrc.username, igSrc.igid),
            companyId: igSrc.company || null,
          }
        : null,
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
      origin: String(row.email || '').toLowerCase().endsWith('@instagram.ato.hub') ? 'INSTAGRAM_LEGACY' : 'EMAIL_SIGNUP',
    });
  }
  return out;
}

export async function listCompaniesForAdmin(): Promise<Array<{ id: string; name: string; members: number; instagramConnected: boolean }>> {
  const r = await dbQuery<any>(
    `SELECT c.id, c.name,
            (SELECT COUNT(*) FROM memberships m WHERE m.company_id = c.id AND m.status = 'ACTIVE')::int AS members,
            EXISTS (SELECT 1 FROM instagram_accounts ia WHERE ia.company_id = c.id AND ia.connection_status = 'CONECTADO'
                      AND ia.instagram_user_id NOT LIKE 'pending_ig_%') AS ig
       FROM companies c ORDER BY c.name ASC`
  );
  return r.rows.map((x: any) => ({ id: x.id, name: x.name, members: Number(x.members) || 0, instagramConnected: Boolean(x.ig) }));
}

async function lockTarget(tx: any, userId: string) {
  const u = await tx.query('SELECT id, email, role FROM users WHERE id = $1 FOR UPDATE', [userId]);
  const row = u.rows[0];
  if (!row) throw new MembershipError(404, 'NOT_FOUND', 'Usuário não encontrado.');
  if (row.role !== 'TENANT') throw new MembershipError(403, 'FORBIDDEN', 'Esta ação não vale para administradores.');
  return row as { id: string; email: string; role: string };
}

async function upsertMembership(tx: any, userId: string, v: { companyId: string | null; role: MemberRole; status: AccessStatus; actor: string; reason?: string | null }) {
  await tx.query(
    `INSERT INTO memberships (id, user_id, company_id, role, status, status_reason, requested_at, decided_at, decided_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW(),$7,NOW(),NOW())
     ON CONFLICT (user_id) DO UPDATE SET company_id = $3, role = $4, status = $5, status_reason = $6, decided_at = NOW(), decided_by = $7, updated_at = NOW()`,
    [`mem_${hex(8)}`, userId, v.companyId, v.role, v.status, v.reason || null, v.actor]
  );
}

async function syncUserColumns(tx: any, userId: string, companyId: string | null, role: MemberRole | null, tenantId: string | null, userStatus: string) {
  await tx.query(
    `UPDATE users SET company_id = $2, workspace_role = $3, instagram_account_id = $4, status = $5, updated_at = NOW() WHERE id = $1`,
    [userId, companyId, role, tenantId, userStatus]
  );
}

const cleanName = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ');

/** Aprova e vincula a uma empresa EXISTENTE ou cria uma nova. Nunca vincula pelo @ do Instagram nem por nome de pasta. */
export async function approveUser(
  actorId: string,
  userId: string,
  input: { companyId?: unknown; newCompanyName?: unknown; role?: unknown }
): Promise<{ companyId: string }> {
  const role: MemberRole = input.role === 'OWNER' ? 'OWNER' : 'MEMBER';
  return withTransaction(async (tx) => {
    const target = await lockTarget(tx, userId);
    const prev = await tx.query('SELECT company_id FROM memberships WHERE user_id = $1', [userId]);
    let companyId = String(input.companyId ?? '').trim();
    if (companyId) {
      const c = await tx.query('SELECT id FROM companies WHERE id = $1', [companyId]);
      if (c.rows.length === 0) throw new MembershipError(404, 'COMPANY_NOT_FOUND', 'Empresa não encontrada.');
    } else {
      const name = cleanName(input.newCompanyName);
      if (name.length < 2 || name.length > 120) throw new MembershipError(400, 'INVALID_COMPANY', 'Escolha uma empresa existente ou informe o nome da nova empresa.');
      const dup = await tx.query('SELECT 1 FROM companies WHERE LOWER(name) = LOWER($1) LIMIT 1', [name]);
      if (dup.rows.length > 0) throw new MembershipError(409, 'COMPANY_EXISTS', 'Já existe uma empresa com este nome. Selecione-a na lista.');
      companyId = `company_${hex(8)}`;
      // Pasta interna: nenhuma rota legada por nome de pasta pode colidir com outra empresa.
      await tx.query(`INSERT INTO companies (id, name, drive_folder_name, created_at, updated_at) VALUES ($1,$2,$3,NOW(),NOW())`, [companyId, name, `workspace_${hex(8)}`]);
    }
    let tenantId = await pickCompanyTenant(tx, companyId);
    if (!tenantId) {
      // Empresa sem conta de destino: cria o espaço técnico (sem @ real) onde o Instagram da EMPRESA será conectado.
      tenantId = `tenant_${hex(8)}`;
      const folder = (await tx.query('SELECT drive_folder_name, name FROM companies WHERE id = $1', [companyId])).rows[0];
      await tx.query(
        `INSERT INTO instagram_accounts
           (id, company_id, username, nome, instagram_user_id, drive_folder_name, status, connection_status, has_valid_token, granted_scopes, requested_at, approved_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'APROVADO','DESCONECTADO',FALSE,'[]'::jsonb,NOW(),NOW(),NOW(),NOW())`,
        [tenantId, companyId, `cadastro_${hex(6)}`, folder?.name || 'Empresa', `pending_ig_${hex(6)}`, folder?.drive_folder_name || `workspace_${hex(8)}`]
      );
    }
    await upsertMembership(tx, userId, { companyId, role, status: 'ACTIVE', actor: actorId });
    await syncUserColumns(tx, userId, companyId, role, tenantId, 'APROVADO');
    await audit(tx, { actor: actorId, action: 'USER_APPROVED', targetUserId: userId, targetEmail: target.email, from: prev.rows[0]?.company_id || null, to: companyId, details: { role } });
    return { companyId };
  });
}

async function setStatus(actorId: string, userId: string, status: 'REJECTED' | 'SUSPENDED', reason: unknown, action: string) {
  return withTransaction(async (tx) => {
    const target = await lockTarget(tx, userId);
    const prev = await tx.query('SELECT company_id, role FROM memberships WHERE user_id = $1', [userId]);
    const p = prev.rows[0];
    const companyId = status === 'SUSPENDED' ? p?.company_id || null : null; // suspenso mantém o vínculo para reativar; rejeitado não
    await upsertMembership(tx, userId, { companyId, role: (p?.role as MemberRole) || 'MEMBER', status, actor: actorId, reason: reason ? String(reason).slice(0, 500) : null });
    // O vínculo operacional deixa de valer já; os tokens antigos caem pelo corte de sessão.
    await tx.query(
      `UPDATE users SET status = $2, instagram_account_id = NULL, workspace_role = NULL, company_id = $3, sessions_valid_after = NOW(), updated_at = NOW() WHERE id = $1`,
      [userId, status === 'SUSPENDED' ? 'SUSPENSO' : 'REJEITADO', companyId]
    );
    await audit(tx, { actor: actorId, action, targetUserId: userId, targetEmail: target.email, from: p?.company_id || null, details: { reason: reason || null } });
  });
}
export const rejectUser = (actor: string, userId: string, reason?: unknown) => setStatus(actor, userId, 'REJECTED', reason, 'USER_REJECTED');
export const suspendUser = (actor: string, userId: string, reason?: unknown) => setStatus(actor, userId, 'SUSPENDED', reason, 'USER_SUSPENDED');

/** Reativa: volta ao vínculo anterior se existir; senão, à fila de aprovação. */
export async function reactivateUser(actorId: string, userId: string): Promise<{ accessStatus: AccessStatus }> {
  return withTransaction(async (tx) => {
    const target = await lockTarget(tx, userId);
    const m = (await tx.query('SELECT company_id, role FROM memberships WHERE user_id = $1', [userId])).rows[0];
    if (m?.company_id) {
      const tenantId = await pickCompanyTenant(tx, m.company_id);
      await upsertMembership(tx, userId, { companyId: m.company_id, role: m.role || 'MEMBER', status: 'ACTIVE', actor: actorId });
      await syncUserColumns(tx, userId, m.company_id, m.role || 'MEMBER', tenantId, 'APROVADO');
      await audit(tx, { actor: actorId, action: 'USER_REACTIVATED', targetUserId: userId, targetEmail: target.email, to: m.company_id });
      return { accessStatus: 'ACTIVE' as AccessStatus };
    }
    await upsertMembership(tx, userId, { companyId: null, role: 'MEMBER', status: 'PENDING_APPROVAL', actor: actorId });
    await syncUserColumns(tx, userId, null, null, null, 'AGUARDANDO_APROVACAO');
    await audit(tx, { actor: actorId, action: 'USER_REACTIVATED', targetUserId: userId, targetEmail: target.email });
    return { accessStatus: 'PENDING_APPROVAL' as AccessStatus };
  });
}

/** Troca a empresa de um usuário ATIVO. O acesso à anterior some na próxima requisição (estado lido do banco). */
export async function changeUserCompany(actorId: string, userId: string, companyId: unknown, role?: unknown) {
  const cid = String(companyId ?? '').trim();
  if (!cid) throw new MembershipError(400, 'INVALID_COMPANY', 'Informe a empresa.');
  return withTransaction(async (tx) => {
    const target = await lockTarget(tx, userId);
    const c = await tx.query('SELECT id FROM companies WHERE id = $1', [cid]);
    if (c.rows.length === 0) throw new MembershipError(404, 'COMPANY_NOT_FOUND', 'Empresa não encontrada.');
    const prev = (await tx.query('SELECT company_id, role, status FROM memberships WHERE user_id = $1', [userId])).rows[0];
    if (prev && prev.status !== 'ACTIVE') throw new MembershipError(409, 'NOT_ACTIVE', 'Aprove o usuário antes de trocar a empresa.');
    const newRole: MemberRole = role === 'OWNER' ? 'OWNER' : role === 'MEMBER' ? 'MEMBER' : (prev?.role as MemberRole) || 'MEMBER';
    const tenantId = await pickCompanyTenant(tx, cid);
    await upsertMembership(tx, userId, { companyId: cid, role: newRole, status: 'ACTIVE', actor: actorId });
    await syncUserColumns(tx, userId, cid, newRole, tenantId, 'APROVADO');
    await audit(tx, { actor: actorId, action: 'USER_COMPANY_CHANGED', targetUserId: userId, targetEmail: target.email, from: prev?.company_id || null, to: cid, details: { role: newRole } });
  });
}

export async function changeUserRole(actorId: string, userId: string, role: unknown) {
  if (role !== 'OWNER' && role !== 'MEMBER') throw new MembershipError(400, 'INVALID_ROLE', 'Papel inválido.');
  return withTransaction(async (tx) => {
    const target = await lockTarget(tx, userId);
    const m = (await tx.query('SELECT company_id, status FROM memberships WHERE user_id = $1', [userId])).rows[0];
    if (!m || m.status !== 'ACTIVE') throw new MembershipError(409, 'NOT_ACTIVE', 'O usuário precisa estar ativo em uma empresa.');
    await tx.query('UPDATE memberships SET role = $2, updated_at = NOW() WHERE user_id = $1', [userId, role]);
    await tx.query('UPDATE users SET workspace_role = $2, updated_at = NOW() WHERE id = $1', [userId, role]);
    await audit(tx, { actor: actorId, action: 'USER_ROLE_CHANGED', targetUserId: userId, targetEmail: target.email, to: m.company_id, details: { role } });
  });
}

/** Remove o vínculo com a empresa: o usuário volta à fila de aprovação, sem acesso operacional. */
export async function removeUserCompany(actorId: string, userId: string) {
  return withTransaction(async (tx) => {
    const target = await lockTarget(tx, userId);
    const prev = (await tx.query('SELECT company_id FROM memberships WHERE user_id = $1', [userId])).rows[0];
    await upsertMembership(tx, userId, { companyId: null, role: 'MEMBER', status: 'PENDING_APPROVAL', actor: actorId });
    await syncUserColumns(tx, userId, null, null, null, 'AGUARDANDO_APROVACAO');
    await audit(tx, { actor: actorId, action: 'USER_COMPANY_REMOVED', targetUserId: userId, targetEmail: target.email, from: prev?.company_id || null });
  });
}

/**
 * Exclui o usuário (identidade, vínculo e tokens de e-mail). NÃO apaga empresa, posts, agendamentos nem a conta
 * Instagram da empresa, e NÃO desconecta nenhum Instagram. A trilha de auditoria permanece com o e-mail registrado.
 */
export async function deleteUser(actorId: string, userId: string, confirmEmail: unknown) {
  return withTransaction(async (tx) => {
    const target = await lockTarget(tx, userId);
    if (userId === actorId) throw new MembershipError(409, 'SELF', 'Você não pode excluir a si mesmo.');
    if (String(confirmEmail ?? '').trim().toLowerCase() !== String(target.email).toLowerCase()) {
      throw new MembershipError(400, 'CONFIRMATION_MISMATCH', 'Digite o e-mail do usuário para confirmar a exclusão.');
    }
    const prev = (await tx.query('SELECT company_id FROM memberships WHERE user_id = $1', [userId])).rows[0];
    await tx.query(`UPDATE auth_tokens SET used_at = NOW() WHERE (user_id = $1 OR LOWER(email) = LOWER($2)) AND used_at IS NULL`, [userId, target.email]);
    await tx.query('UPDATE instagram_accounts SET connected_by_user_id = NULL WHERE connected_by_user_id = $1', [userId]);
    await tx.query('DELETE FROM memberships WHERE user_id = $1', [userId]);
    await tx.query('DELETE FROM users WHERE id = $1', [userId]);
    await audit(tx, { actor: actorId, action: 'USER_DELETED', targetUserId: userId, targetEmail: target.email, from: prev?.company_id || null });
  });
}

// ------------------------------------------------------------------ Contas Instagram (área própria)

/**
 * Registro antigo de uma conta Instagram que NÃO está mais conectada (desconectada, token inválido ou expirado)
 * e que impede uma nova conexão do mesmo Instagram. Não apaga nada: o registro é arquivado (token removido e
 * identificadores renomeados), mantendo empresa, posts e histórico para auditoria. Quem prova ser dono do Instagram
 * é a própria Meta, que acabou de autenticar a conta. Conta CONECTADA com token válido nunca é liberada por aqui.
 */
export async function releaseStaleInstagramAccount(accountId: string, actorId: string): Promise<boolean> {
  return withTransaction(async (tx) => {
    const a = (await tx.query(
      'SELECT id, company_id, connection_status, has_valid_token, token_expires_at FROM instagram_accounts WHERE id = $1 FOR UPDATE',
      [accountId]
    )).rows[0];
    if (!a) return false;
    const expired = a.token_expires_at ? new Date(a.token_expires_at).getTime() < Date.now() : false;
    // "Conectada" = estado CONECTADO e token dentro da validade. Desconexão do admin, reconexão necessária e token vencido liberam.
    const live = a.connection_status === 'CONECTADO' && !expired;
    if (live) return false;
    const tag = hex(4);
    await tx.query(
      `UPDATE instagram_accounts
          SET username = LEFT(username, 200) || '_liberada_' || $2,
              instagram_user_id = 'liberada_' || $2 || '_' || LEFT(instagram_user_id, 100),
              encrypted_access_token = NULL, has_valid_token = FALSE, connection_status = 'DESCONECTADO',
              last_connection_error = 'Conta arquivada: o Instagram foi conectado novamente em outro cadastro', updated_at = NOW()
        WHERE id = $1`,
      [accountId, tag]
    );
    await audit(tx, { actor: actorId, action: 'INSTAGRAM_RELEASED', from: a.company_id || null, details: { accountId } });
    return true;
  });
}


export async function listInstagramForAdmin() {
  const r = await dbQuery<any>(
    `SELECT ia.id, ia.username, ia.instagram_user_id, ia.company_id, c.name AS company_name, ia.status, ia.connection_status,
            ia.has_valid_token, ia.token_expires_at, ia.last_connection_error, ia.connected_by_user_id,
            u.name AS by_name, u.email AS by_email, ia.created_at
       FROM instagram_accounts ia
       LEFT JOIN companies c ON c.id = ia.company_id
       LEFT JOIN users u ON u.id = ia.connected_by_user_id
      ORDER BY ia.created_at DESC NULLS LAST`
  );
  return r.rows.map((x: any) => {
    const placeholder = isPlaceholderTenant(x.username, x.instagram_user_id);
    const expired = x.token_expires_at ? new Date(x.token_expires_at).getTime() < Date.now() : false;
    const needsReconnect = !placeholder && (x.connection_status !== 'CONECTADO' || !x.has_valid_token || expired || x.status === 'RECONEXAO_NECESSARIA');
    return {
      id: x.id,
      username: placeholder ? null : x.username,
      instagramUserId: placeholder ? null : x.instagram_user_id,
      connected: !placeholder && !needsReconnect,
      placeholder,
      companyId: x.company_id || null,
      companyName: x.company_name || null,
      authorizationStatus: x.status,
      connectionStatus: x.connection_status,
      needsReconnect,
      tokenExpiresAt: x.token_expires_at ? new Date(x.token_expires_at).toISOString() : null,
      connectedBy: x.connected_by_user_id ? { id: x.connected_by_user_id, name: x.by_name || null, email: x.by_email || null } : null,
      createdAt: x.created_at ? new Date(x.created_at).toISOString() : null,
    };
  });
}

/** Vincula uma conta Instagram SEM empresa a uma empresa. Conta já vinculada a outra empresa não é movida por aqui. */
export async function linkInstagramToCompany(actorId: string, accountId: string, companyId: unknown) {
  const cid = String(companyId ?? '').trim();
  return withTransaction(async (tx) => {
    const a = (await tx.query('SELECT id, company_id FROM instagram_accounts WHERE id = $1 FOR UPDATE', [accountId])).rows[0];
    if (!a) throw new MembershipError(404, 'NOT_FOUND', 'Conta não encontrada.');
    const c = (await tx.query('SELECT id FROM companies WHERE id = $1', [cid])).rows[0];
    if (!c) throw new MembershipError(404, 'COMPANY_NOT_FOUND', 'Empresa não encontrada.');
    if (a.company_id && a.company_id !== cid) throw new MembershipError(409, 'ALREADY_LINKED', 'Esta conta já pertence a outra empresa. Desconecte-a antes de vincular.');
    await tx.query('UPDATE instagram_accounts SET company_id = $2, updated_at = NOW() WHERE id = $1', [accountId, cid]);
    await audit(tx, { actor: actorId, action: 'INSTAGRAM_LINKED', to: cid, details: { accountId } });
  });
}

/** Revoga a autorização no Social Hub (apaga o token guardado). Não mexe em usuários nem na conta dentro do Instagram. */
export async function disconnectInstagram(actorId: string, accountId: string) {
  return withTransaction(async (tx) => {
    const a = (await tx.query('SELECT id, company_id FROM instagram_accounts WHERE id = $1 FOR UPDATE', [accountId])).rows[0];
    if (!a) throw new MembershipError(404, 'NOT_FOUND', 'Conta não encontrada.');
    await tx.query(
      `UPDATE instagram_accounts SET encrypted_access_token = NULL, has_valid_token = FALSE, connection_status = 'DESCONECTADO',
              last_connection_error = 'Desconectada pelo administrador', updated_at = NOW() WHERE id = $1`,
      [accountId]
    );
    await audit(tx, { actor: actorId, action: 'INSTAGRAM_DISCONNECTED', from: a.company_id || null, details: { accountId } });
  });
}
