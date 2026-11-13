import crypto from 'crypto';
import { dbQuery, withTransaction, DbClientLike } from './pool.ts';
import { ALL_MANAGED_TABLES } from './migrations.ts';
import {
  AdminAlertNotification,
  AIGenerationRecord,
  CaptionApprovalStatus,
  CaptionRecord,
  CaptionSource,
  ClientObservation,
  CompanyBrandProfile,
  CreativeContext,
  DriveImageItem,
  PostCategory,
  PostGroup,
  PostStatus,
  PublishAttemptRecord,
  PublishLockInfo,
  RejectionFeedback,
  TenantAccount,
  TenantStatus,
  UserProfile,
} from '../types/index.ts';
import {
  decryptInstagramToken,
  encryptInstagramToken,
  normalizeAndEncryptTenantToken,
} from '../services/instagramCore.ts';
import { groupAndSortDriveItems, normalizeCategoria } from '../utils/postHelpers.ts';

/**
 * Resolves the encryption key for Instagram tokens in PostgreSQL.
 * Prioritizes TOKEN_ENCRYPTION_KEY (Etapa 8), falling back to JWT_SECRET for legacy compatibility.
 */
export function getTokenEncryptionKey(): string {
  const dedicated = String(process.env.TOKEN_ENCRYPTION_KEY || '').trim();
  if (dedicated && !dedicated.includes('<CHAVE_DE_CRIPTOGRAFIA>')) {
    return dedicated;
  }
  return String(process.env.JWT_SECRET || 'ato_super_secret_key_2026_998877').trim();
}

/**
 * Resolves a plaintext token from a TenantAccount using TOKEN_ENCRYPTION_KEY or legacy JWT_SECRET.
 */
export function resolveTenantTokenWithFallback(tenant: TenantAccount): string {
  const primaryKey = getTokenEncryptionKey();
  const jwtFallbackKey = String(process.env.JWT_SECRET || 'ato_super_secret_key_2026_998877').trim();

  if (tenant.encryptedAccessToken) {
    const decPrimary = decryptInstagramToken(tenant.encryptedAccessToken, primaryKey);
    if (decPrimary) return decPrimary;
    if (jwtFallbackKey !== primaryKey) {
      const decFallback = decryptInstagramToken(tenant.encryptedAccessToken, jwtFallbackKey);
      if (decFallback) return decFallback;
    }
  }
  return String(tenant.accessToken || tenant.access_token || '').trim();
}

export function hashPasswordSha256(password: string): string {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function toIsoOrUndefined(val: any): string | undefined {
  if (!val) return undefined;
  if (val instanceof Date) return val.toISOString();
  const parsed = Date.parse(String(val));
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function parseJsonSafe<T>(val: any, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val as T;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

// ============================================================================
// 1. MODULE: USERS & ADMIN AUTH
// ============================================================================

export async function ensureDefaultAdminUser(): Promise<void> {
  const adminId = 'user_admin_ato';
  const adminEmail = 'admin@atodev.com.br';
  const passwordHash = hashPasswordSha256('666666');

  await dbQuery(
    `
    INSERT INTO users (id, email, name, password_hash, role, status, permissions, updated_at)
    VALUES ($1, $2, $3, $4, 'ADMIN', 'APROVADO', $5::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      password_hash = EXCLUDED.password_hash,
      role = 'ADMIN',
      status = 'APROVADO',
      updated_at = NOW()
    `,
    [
      adminId,
      adminEmail,
      'Administrador ATO',
      passwordHash,
      JSON.stringify(['ALL', 'MANAGE_TENANTS', 'APPROVE_POSTS', 'PUBLISH_INSTAGRAM', 'GENERATE_AI']),
    ]
  );
}

export async function authenticateAdminUser(
  email: string,
  password: string
): Promise<UserProfile | null> {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const hash = hashPasswordSha256(password);

  const res = await dbQuery<{
    id: string;
    email: string;
    name: string;
    password_hash: string;
    role: 'ADMIN' | 'TENANT';
    status: TenantStatus;
  }>('SELECT id, email, name, password_hash, role, status FROM users WHERE LOWER(email) = $1 LIMIT 1', [
    cleanEmail,
  ]);

  if (res.rows.length > 0) {
    const row = res.rows[0];
    if (row.password_hash === hash && row.role === 'ADMIN') {
      await dbQuery('UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [row.id]);
      return {
        id: row.id,
        email: row.email,
        nome: row.name,
        role: row.role,
        status: row.status,
      };
    }
  }

  return null;
}

export async function authenticateSocialHubUser(
  email: string,
  password: string
): Promise<{ user: UserProfile; tenant?: TenantAccount } | null> {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const hash = hashPasswordSha256(password);

  const res = await dbQuery<{
    id: string;
    email: string;
    name: string;
    password_hash: string | null;
    role: 'ADMIN' | 'TENANT';
    status: TenantStatus;
    company_id: string | null;
    instagram_account_id: string | null;
  }>(
    'SELECT id, email, name, password_hash, role, status, company_id, instagram_account_id FROM users WHERE LOWER(email) = $1 LIMIT 1',
    [cleanEmail]
  );

  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (!row.password_hash || row.password_hash !== hash) {
    return null;
  }

  await dbQuery('UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [row.id]);

  if (row.role === 'ADMIN') {
    return {
      user: {
        id: row.id,
        email: row.email,
        nome: row.name,
        role: 'ADMIN',
        status: row.status,
      },
    };
  }

  let tenant: TenantAccount | null = null;
  if (row.instagram_account_id) {
    tenant = await getInstagramAccountByIdOrUser(row.instagram_account_id);
  }
  if (!tenant) {
    const fallbackTenantId = row.id.replace(/^usr_/, '');
    tenant = await getInstagramAccountByIdOrUser(fallbackTenantId);
  }

  const userProfile: UserProfile = {
    id: row.id,
    email: row.email,
    nome: tenant?.nome || row.name,
    role: 'TENANT',
    tenantId: tenant?.id || row.instagram_account_id || undefined,
    companyId: tenant?.companyId || row.company_id || undefined,
    instagramUserId: tenant?.instagramUserId || undefined,
    instagramUsername: tenant?.username || undefined,
    status: tenant?.status || row.status || 'AGUARDANDO_APROVACAO',
    driveFolderName: tenant?.driveFolderName || null,
    driveFolderId: tenant?.driveFolderId || null,
    connectionStatus: tenant?.connectionStatus || 'DESCONECTADO',
    tokenIssuedAt: tenant?.tokenIssuedAt,
    tokenExpiresAt: tenant?.tokenExpiresAt,
    grantedScopes: tenant?.grantedScopes || [],
  };

  return {
    user: userProfile,
    tenant: tenant || undefined,
  };
}

export async function registerSocialHubUser(input: {
  name: string;
  email: string;
  password: string;
  companyName?: string;
}): Promise<{ user: UserProfile; tenant: TenantAccount }> {
  const cleanEmail = String(input.email || '').trim().toLowerCase();
  const cleanName = String(input.name || '').trim();
  const cleanCompany = String(input.companyName || '').trim();
  const passwordHash = hashPasswordSha256(input.password);

  return await withTransaction(async (tx) => {
    const existingEmail = await tx.query<{ id: string }>(
      'SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1',
      [cleanEmail]
    );
    if (existingEmail.rows.length > 0) {
      throw new Error('Já existe uma conta cadastrada com este e-mail.');
    }

    const slug = (cleanCompany || cleanName || cleanEmail.split('@')[0])
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32);
    const nowSuffix = Date.now().toString().slice(-6);
    const tenantId = `tenant_${slug || 'cliente'}_${nowSuffix}`;
    const userId = `usr_${tenantId}`;
    const placeholderUsername = `cadastro_${slug || 'cliente'}_${nowSuffix}`;
    const displayLabel = cleanCompany ? `${cleanName} (${cleanCompany})` : cleanName;
    const nowIso = new Date().toISOString();

    await tx.query(
      `
      INSERT INTO instagram_accounts (
        id, company_id, username, nome, instagram_user_id, account_type, avatar_url,
        drive_folder_name, drive_folder_id, status, encrypted_access_token, token_type,
        granted_scopes, connection_status, has_valid_token, requested_at, updated_at
      ) VALUES (
        $1, NULL, $2, $3, $4, NULL, NULL,
        NULL, NULL, 'AGUARDANDO_APROVACAO', NULL, 'LONG_LIVED',
        '[]'::jsonb, 'DESCONECTADO', FALSE, $5, NOW()
      )
      `,
      [tenantId, placeholderUsername, displayLabel, `pending_ig_${nowSuffix}`, nowIso]
    );

    await tx.query(
      `
      INSERT INTO users (
        id, email, name, password_hash, role, status, company_id, instagram_account_id, permissions, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'TENANT', 'AGUARDANDO_APROVACAO', NULL, $5, $6::jsonb, NOW(), NOW()
      )
      `,
      [
        userId,
        cleanEmail,
        displayLabel,
        passwordHash,
        tenantId,
        JSON.stringify(['VIEW_COMPANY_POSTS', 'APPROVE_POSTS']),
      ]
    );

    const tenant: TenantAccount = {
      id: tenantId,
      companyId: null,
      username: placeholderUsername,
      nome: displayLabel,
      instagramUserId: `pending_ig_${nowSuffix}`,
      driveFolderName: null,
      driveFolderId: null,
      status: 'AGUARDANDO_APROVACAO',
      connectionStatus: 'DESCONECTADO',
      hasValidToken: false,
      grantedScopes: [],
      requestedAt: nowIso,
    };

    const user: UserProfile = {
      id: userId,
      email: cleanEmail,
      nome: displayLabel,
      role: 'TENANT',
      tenantId,
      status: 'AGUARDANDO_APROVACAO',
      driveFolderName: null,
      driveFolderId: null,
      connectionStatus: 'DESCONECTADO',
      grantedScopes: [],
    };

    return { user, tenant };
  });
}

export async function upsertUserForInstagramAccount(
  tenant: TenantAccount,
  tx?: DbClientLike
): Promise<void> {
  const runner = tx ? tx.query.bind(tx) : dbQuery;
  const cleanUsername = tenant.username.replace(/^@/, '').trim().toLowerCase();
  const syntheticEmail = `${cleanUsername}@instagram.ato.hub`;

  const existingRes = await runner<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 OR instagram_account_id = $2 OR LOWER(email) = LOWER($3) LIMIT 1`,
    [`usr_${tenant.id}`, tenant.id, syntheticEmail]
  );
  const userId = existingRes.rows[0]?.id || `usr_${tenant.id}`;

  await runner(
    `
    INSERT INTO users (
      id, email, name, role, status, company_id, instagram_account_id, permissions, last_login_at, updated_at
    ) VALUES ($1, $2, $3, 'TENANT', $4, $5, $6, $7::jsonb, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      email = CASE
        WHEN users.email IS NULL OR users.email LIKE '%@instagram.ato.hub' THEN EXCLUDED.email
        ELSE users.email
      END,
      name = COALESCE(users.name, EXCLUDED.name),
      status = EXCLUDED.status,
      company_id = COALESCE(EXCLUDED.company_id, users.company_id),
      instagram_account_id = EXCLUDED.instagram_account_id,
      last_login_at = NOW(),
      updated_at = NOW()
    `,
    [
      userId,
      syntheticEmail,
      tenant.nome || tenant.username,
      tenant.status || 'AGUARDANDO_APROVACAO',
      tenant.companyId || null,
      tenant.id,
      JSON.stringify(['VIEW_COMPANY_POSTS', 'APPROVE_POSTS', 'PUBLISH_INSTAGRAM', 'GENERATE_AI']),
    ]
  );
}

// ============================================================================
// 2. MODULE: COMPANIES & BRAND EDITORIAL IDENTITY
// ============================================================================

function mapCompanyRow(row: any): CompanyBrandProfile {
  return {
    id: row.id,
    name: row.name,
    driveFolderId: row.drive_folder_id,
    driveFolderName: row.drive_folder_name,
    driveFolderUrl: row.drive_folder_url,
    segment: row.segment,
    brandVoice: row.brand_voice,
    targetAudience: row.target_audience,
    defaultCta: row.default_cta,
    defaultHashtags: row.default_hashtags,
    aiGuidelines: row.ai_guidelines,
    createdAt: toIsoOrUndefined(row.created_at),
    updatedAt: toIsoOrUndefined(row.updated_at),
  };
}

export async function upsertCompany(
  input: {
    id?: string;
    name: string;
    driveFolderId?: string | null;
    driveFolderName?: string;
    driveFolderUrl?: string | null;
    segment?: string | null;
    brandVoice?: string | null;
    targetAudience?: string | null;
    defaultCta?: string | null;
    defaultHashtags?: string | null;
    aiGuidelines?: string | null;
  },
  tx?: DbClientLike
): Promise<CompanyBrandProfile> {
  const runner = tx ? tx.query.bind(tx) : dbQuery;
  const cleanName = String(input.name || input.driveFolderName || 'Ato').trim();
  const folderName = String(input.driveFolderName || cleanName).trim();
  const companyId = String(
    input.id || input.driveFolderId || `comp_${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
  ).trim();

  // Default editorial profile for ATO when creating for the first time
  const isAto = cleanName.toLowerCase() === 'ato' || cleanName.toLowerCase() === 'ato.vc';
  const defaultSegment = isAto
    ? 'Agência de Posicionamento Digital, Branding e Performance'
    : input.segment || null;
  const defaultVoice = isAto
    ? 'Estratégico, direto, contemporâneo e orientado a resultados reais, sem clichês publicitários.'
    : input.brandVoice || null;

  const existingByName = await runner<any>(
    'SELECT * FROM companies WHERE LOWER(name) = LOWER($1) OR LOWER(drive_folder_name) = LOWER($2) OR id = $3 LIMIT 1',
    [cleanName, folderName, companyId]
  );

  if (existingByName.rows.length > 0) {
    const existing = existingByName.rows[0];
    const upd = await runner<any>(
      `
      UPDATE companies SET
        drive_folder_id = COALESCE($2, drive_folder_id),
        drive_folder_name = COALESCE($3, drive_folder_name),
        drive_folder_url = COALESCE($4, drive_folder_url),
        segment = COALESCE($5, segment),
        brand_voice = COALESCE($6, brand_voice),
        target_audience = COALESCE($7, target_audience),
        default_cta = COALESCE($8, default_cta),
        default_hashtags = COALESCE($9, default_hashtags),
        ai_guidelines = COALESCE($10, ai_guidelines),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        existing.id,
        input.driveFolderId || null,
        folderName || null,
        input.driveFolderUrl || null,
        input.segment !== undefined ? input.segment : null,
        input.brandVoice !== undefined ? input.brandVoice : null,
        input.targetAudience !== undefined ? input.targetAudience : null,
        input.defaultCta !== undefined ? input.defaultCta : null,
        input.defaultHashtags !== undefined ? input.defaultHashtags : null,
        input.aiGuidelines !== undefined ? input.aiGuidelines : null,
      ]
    );
    return mapCompanyRow(upd.rows[0]);
  }

  const ins = await runner<any>(
    `
    INSERT INTO companies (
      id, name, drive_folder_id, drive_folder_name, drive_folder_url,
      segment, brand_voice, target_audience, default_cta, default_hashtags, ai_guidelines,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
    RETURNING *
    `,
    [
      companyId,
      cleanName,
      input.driveFolderId || companyId,
      folderName,
      input.driveFolderUrl || null,
      defaultSegment,
      defaultVoice,
      input.targetAudience || null,
      input.defaultCta || null,
      input.defaultHashtags || null,
      input.aiGuidelines || null,
    ]
  );
  return mapCompanyRow(ins.rows[0]);
}

export async function listCompanies(): Promise<CompanyBrandProfile[]> {
  const res = await dbQuery<any>(
    `SELECT * FROM companies WHERE LOWER(name) != 'ato social midia' ORDER BY name ASC`
  );
  return res.rows.map(mapCompanyRow);
}

export async function getCompanyByIdOrFolder(
  identifier?: string | null
): Promise<CompanyBrandProfile | null> {
  if (!identifier) return null;
  const clean = String(identifier).trim();
  if (!clean) return null;

  const res = await dbQuery<any>(
    `
    SELECT * FROM companies
    WHERE id = $1
       OR drive_folder_id = $1
       OR LOWER(name) = LOWER($1)
       OR LOWER(drive_folder_name) = LOWER($1)
    LIMIT 1
    `,
    [clean]
  );
  return res.rows[0] ? mapCompanyRow(res.rows[0]) : null;
}

// ============================================================================
// 3. MODULE: INSTAGRAM ACCOUNTS (TENANTS)
// ============================================================================

function mapInstagramAccountRow(row: any): TenantAccount {
  return {
    id: row.id,
    companyId: row.company_id || null,
    username: row.username,
    nome: row.nome,
    instagramUserId: row.instagram_user_id,
    account_type: row.account_type || undefined,
    avatarUrl: row.avatar_url || undefined,
    driveFolderName: row.drive_folder_name || null,
    driveFolderId: row.drive_folder_id || null,
    status: (row.status as TenantStatus) || 'PENDENTE',
    encryptedAccessToken: row.encrypted_access_token || undefined,
    tokenType: row.token_type || 'LONG_LIVED',
    tokenIssuedAt: toIsoOrUndefined(row.token_issued_at),
    tokenExpiresAt: toIsoOrUndefined(row.token_expires_at),
    lastTokenRefreshAt: toIsoOrUndefined(row.last_token_refresh_at),
    grantedScopes: parseJsonSafe<string[]>(row.granted_scopes, []),
    connectionStatus: row.connection_status || 'CONECTADO',
    lastConnectionError: row.last_connection_error || null,
    reconnectionRequiredAt: toIsoOrUndefined(row.reconnection_required_at) || null,
    hasValidToken: Boolean(row.has_valid_token),
    requestedAt: toIsoOrUndefined(row.requested_at),
    approvedAt: toIsoOrUndefined(row.approved_at),
    lastSyncAt: toIsoOrUndefined(row.last_sync_at),
  };
}

export async function listInstagramAccounts(): Promise<TenantAccount[]> {
  const res = await dbQuery<any>(
    `
    SELECT * FROM instagram_accounts
    ORDER BY created_at DESC
    `
  );
  return res.rows.map(mapInstagramAccountRow);
}

export async function getInstagramAccountByIdOrUser(
  identifier?: string | null
): Promise<TenantAccount | null> {
  if (!identifier) return null;
  const clean = String(identifier).replace(/^@/, '').trim();
  if (!clean) return null;

  const res = await dbQuery<any>(
    `
    SELECT * FROM instagram_accounts
    WHERE id = $1
       OR instagram_user_id = $1
       OR LOWER(username) = LOWER($1)
    LIMIT 1
    `,
    [clean]
  );
  return res.rows[0] ? mapInstagramAccountRow(res.rows[0]) : null;
}

export async function upsertInstagramAccount(
  account: TenantAccount,
  tx?: DbClientLike
): Promise<TenantAccount> {
  const runner = tx ? tx.query.bind(tx) : dbQuery;
  const encKey = getTokenEncryptionKey();
  const cleanUsername = String(account.username || '').replace(/^@/, '').trim();

  // Check if username or id already exists in PostgreSQL
  const existingRes = await runner<any>(
    `
    SELECT * FROM instagram_accounts
    WHERE id = $1 OR LOWER(username) = LOWER($2) OR instagram_user_id = $3
    ORDER BY CASE WHEN id = $1 THEN 0 WHEN LOWER(username) = LOWER($2) THEN 1 ELSE 2 END
    LIMIT 1
    `,
    [account.id, cleanUsername, account.instagramUserId || account.id]
  );

  const existingRow = existingRes.rows[0];
  const effectiveId = existingRow?.id || account.id;

  // If the incoming account has no token but PostgreSQL already holds an encrypted token,
  // inherit the stored token unless the caller explicitly marked a new connection error
  const incomingPlain = resolveTenantTokenWithFallback(account);
  const existingPlain = existingRow
    ? resolveTenantTokenWithFallback(mapInstagramAccountRow(existingRow))
    : '';
  const effectivePlain = incomingPlain || existingPlain;

  const accountWithMergedToken: TenantAccount = {
    ...account,
    id: effectiveId,
    companyId: account.companyId || existingRow?.company_id || null,
    driveFolderName: account.driveFolderName ?? existingRow?.drive_folder_name ?? null,
    driveFolderId: account.driveFolderId ?? existingRow?.drive_folder_id ?? null,
    tokenIssuedAt:
      account.tokenIssuedAt || toIsoOrUndefined(existingRow?.token_issued_at),
    tokenExpiresAt:
      account.tokenExpiresAt || toIsoOrUndefined(existingRow?.token_expires_at),
    lastTokenRefreshAt:
      account.lastTokenRefreshAt || toIsoOrUndefined(existingRow?.last_token_refresh_at),
    grantedScopes:
      Array.isArray(account.grantedScopes) && account.grantedScopes.length > 0
        ? account.grantedScopes
        : parseJsonSafe<string[]>(existingRow?.granted_scopes, []),
    ...(effectivePlain
      ? { encryptedAccessToken: encryptInstagramToken(effectivePlain, encKey) }
      : {}),
  };

  const normalized = normalizeAndEncryptTenantToken(accountWithMergedToken, encKey);

  // If caller explicitly marked RECONEXAO_NECESSARIA with a reason, honor it
  if (account.connectionStatus === 'RECONEXAO_NECESSARIA' && account.lastConnectionError) {
    normalized.connectionStatus = 'RECONEXAO_NECESSARIA';
    normalized.hasValidToken = false;
    normalized.lastConnectionError = account.lastConnectionError;
    normalized.reconnectionRequiredAt =
      account.reconnectionRequiredAt || new Date().toISOString();
  }

  let companyId = normalized.companyId || null;
  if (normalized.driveFolderName && normalized.driveFolderName.toLowerCase() !== 'ato social midia') {
    const comp = await upsertCompany(
      {
        id: normalized.driveFolderId || undefined,
        name: normalized.driveFolderName,
        driveFolderId: normalized.driveFolderId,
        driveFolderName: normalized.driveFolderName,
      },
      tx
    );
    companyId = comp.id;
  }

  const res = await runner<any>(
    `
    INSERT INTO instagram_accounts (
      id, company_id, username, nome, instagram_user_id, account_type, avatar_url,
      drive_folder_name, drive_folder_id, status, encrypted_access_token, token_type,
      token_issued_at, token_expires_at, last_token_refresh_at, granted_scopes,
      connection_status, last_connection_error, reconnection_required_at, has_valid_token,
      requested_at, approved_at, last_sync_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12,
      $13, $14, $15, $16::jsonb,
      $17, $18, $19, $20,
      $21, $22, $23, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      company_id = COALESCE(EXCLUDED.company_id, instagram_accounts.company_id),
      username = EXCLUDED.username,
      nome = EXCLUDED.nome,
      instagram_user_id = EXCLUDED.instagram_user_id,
      account_type = COALESCE(EXCLUDED.account_type, instagram_accounts.account_type),
      avatar_url = COALESCE(EXCLUDED.avatar_url, instagram_accounts.avatar_url),
      drive_folder_name = EXCLUDED.drive_folder_name,
      drive_folder_id = EXCLUDED.drive_folder_id,
      status = EXCLUDED.status,
      encrypted_access_token = COALESCE(EXCLUDED.encrypted_access_token, instagram_accounts.encrypted_access_token),
      token_type = COALESCE(EXCLUDED.token_type, instagram_accounts.token_type),
      token_issued_at = COALESCE(EXCLUDED.token_issued_at, instagram_accounts.token_issued_at),
      token_expires_at = COALESCE(EXCLUDED.token_expires_at, instagram_accounts.token_expires_at),
      last_token_refresh_at = COALESCE(EXCLUDED.last_token_refresh_at, instagram_accounts.last_token_refresh_at),
      granted_scopes = EXCLUDED.granted_scopes,
      connection_status = EXCLUDED.connection_status,
      last_connection_error = EXCLUDED.last_connection_error,
      reconnection_required_at = EXCLUDED.reconnection_required_at,
      has_valid_token = EXCLUDED.has_valid_token,
      requested_at = COALESCE(EXCLUDED.requested_at, instagram_accounts.requested_at),
      approved_at = COALESCE(EXCLUDED.approved_at, instagram_accounts.approved_at),
      last_sync_at = COALESCE(EXCLUDED.last_sync_at, instagram_accounts.last_sync_at),
      updated_at = NOW()
    RETURNING *
    `,
    [
      effectiveId,
      companyId,
      cleanUsername,
      normalized.nome || cleanUsername,
      normalized.instagramUserId,
      normalized.account_type || null,
      normalized.avatarUrl || null,
      normalized.driveFolderName || null,
      normalized.driveFolderId || null,
      normalized.status || 'PENDENTE',
      normalized.encryptedAccessToken || null,
      normalized.tokenType || 'LONG_LIVED',
      normalized.tokenIssuedAt || null,
      normalized.tokenExpiresAt || null,
      normalized.lastTokenRefreshAt || null,
      JSON.stringify(normalized.grantedScopes || []),
      normalized.connectionStatus || 'CONECTADO',
      normalized.lastConnectionError ?? null,
      normalized.reconnectionRequiredAt ?? null,
      Boolean(normalized.hasValidToken),
      normalized.requestedAt || new Date().toISOString(),
      normalized.approvedAt || null,
      normalized.lastSyncAt || null,
    ]
  );

  const saved = mapInstagramAccountRow(res.rows[0]);
  await upsertUserForInstagramAccount(saved, tx);
  return saved;
}

export async function deleteInstagramAccountFromDb(id: string): Promise<boolean> {
  const res = await dbQuery('DELETE FROM instagram_accounts WHERE id = $1', [id]);
  return (res.rowCount || 0) > 0;
}

// ============================================================================
// 4. MODULE: EDITORIAL (POSTS, MEDIA_ASSETS, POST_MEDIA, CAPTIONS, APPROVALS, REJECTIONS)
// ============================================================================

export async function getPostGroupByIdFromDb(postId: string): Promise<PostGroup | null> {
  const all = await listPostGroupsFromDb({ postId });
  return all[0] || null;
}

export async function listPostGroupsFromDb(filters?: {
  postId?: string;
  tenantId?: string;
  companyId?: string;
  driveFolderName?: string;
  pastaClienteId?: string;
}): Promise<PostGroup[]> {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters?.postId) {
    params.push(filters.postId);
    conditions.push(`p.id = $${params.length}`);
  }
  if (filters?.tenantId) {
    params.push(filters.tenantId);
    conditions.push(`(p.instagram_account_id = $${params.length} OR p.scheduled_account_id = $${params.length})`);
  }
  if (filters?.companyId) {
    params.push(filters.companyId);
    conditions.push(`p.company_id = $${params.length}`);
  }
  if (filters?.driveFolderName && filters.driveFolderName !== 'ALL') {
    params.push(filters.driveFolderName);
    conditions.push(
      `(LOWER(p.drive_folder_name) = LOWER($${params.length}) OR LOWER(p.pasta_cliente_nome) = LOWER($${params.length}))`
    );
  }
  if (filters?.pastaClienteId && filters.pastaClienteId !== 'ALL') {
    params.push(filters.pastaClienteId);
    conditions.push(`p.pasta_cliente_id = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const postsRes = await dbQuery<any>(
    `SELECT * FROM posts p ${whereClause} ORDER BY p.data_criacao DESC, p.id ASC`,
    params
  );

  if (postsRes.rows.length === 0) {
    return [];
  }

  const postIds = postsRes.rows.map((r) => r.id);

  // Load media items via post_media join media_assets
  const mediaRes = await dbQuery<any>(
    `
    SELECT pm.post_id, pm.ordem AS pm_ordem, m.*
    FROM post_media pm
    JOIN media_assets m ON m.drive_file_id = pm.drive_file_id
    WHERE pm.post_id = ANY($1::varchar[])
    ORDER BY pm.ordem ASC, m.nome ASC
    `,
    [postIds]
  );

  // Load publication attempts
  const attemptsRes = await dbQuery<any>(
    `
    SELECT * FROM publication_attempts
    WHERE post_id = ANY($1::varchar[])
    ORDER BY attempt_number ASC, started_at ASC
    `,
    [postIds]
  );

  // Load captions history
  const captionsRes = await dbQuery<any>(
    `
    SELECT * FROM captions
    WHERE post_id = ANY($1::varchar[])
    ORDER BY version_number DESC, created_at DESC
    `,
    [postIds]
  );

  const mediaByPost = new Map<string, DriveImageItem[]>();
  for (const m of mediaRes.rows) {
    const item: DriveImageItem = {
      driveFileId: m.drive_file_id,
      nome: m.nome,
      categoria: m.categoria as PostCategory,
      loteNome: m.lote_nome,
      viewUrl: m.view_url,
      thumbnailUrl: m.thumbnail_url,
      downloadUrl: m.download_url || undefined,
      mimeType: m.mime_type || 'image/png',
      dataCriacao: toIsoOrUndefined(m.data_criacao) || new Date().toISOString(),
      status: (m.status as PostStatus) || 'PENDENTE',
      ordem: m.pm_ordem ?? m.ordem ?? 1,
      tenantId: m.instagram_account_id || undefined,
      driveFolderName: m.drive_folder_name || undefined,
      pastaClienteNome: m.pasta_cliente_nome || undefined,
      pastaClienteId: m.pasta_cliente_id || undefined,
      pastaUrl: m.pasta_url || undefined,
      rejectionFeedback: parseJsonSafe<RejectionFeedback | undefined>(m.rejection_feedback, undefined),
    };
    const arr = mediaByPost.get(m.post_id) || [];
    arr.push(item);
    mediaByPost.set(m.post_id, arr);
  }

  const attemptsByPost = new Map<string, PublishAttemptRecord[]>();
  for (const a of attemptsRes.rows) {
    const rec: PublishAttemptRecord = {
      attemptNumber: a.attempt_number,
      startedAt: toIsoOrUndefined(a.started_at) || new Date().toISOString(),
      finishedAt: toIsoOrUndefined(a.finished_at) || new Date().toISOString(),
      accountId: a.instagram_account_id || '',
      igUserId: a.ig_user_id || '',
      containerId: a.container_id || undefined,
      childContainerIds: parseJsonSafe<string[]>(a.child_container_ids, []),
      mediaId: a.media_id || undefined,
      permalink: a.permalink || undefined,
      status: a.status,
      httpStatus: a.http_status ?? undefined,
      metaErrorCode: a.meta_error_code ?? undefined,
      metaErrorSubcode: a.meta_error_subcode ?? undefined,
      errorMessage: a.error_message || undefined,
    };
    const arr = attemptsByPost.get(a.post_id) || [];
    arr.push(rec);
    attemptsByPost.set(a.post_id, arr);
  }

  const captionsByPost = new Map<string, CaptionRecord[]>();
  for (const c of captionsRes.rows) {
    const cap: CaptionRecord = {
      id: c.id,
      postId: c.post_id,
      companyId: c.company_id || null,
      versionNumber: c.version_number,
      content: c.content,
      source: (c.source as CaptionSource) || 'MANUAL',
      aiGenerationId: c.ai_generation_id || null,
      isSelected: Boolean(c.is_selected),
      approvalStatus: (c.approval_status as CaptionApprovalStatus) || 'DRAFT',
      createdBy: c.created_by || null,
      approvedBy: c.approved_by || null,
      approvedAt: toIsoOrUndefined(c.approved_at) || null,
      createdAt: toIsoOrUndefined(c.created_at) || new Date().toISOString(),
    };
    const arr = captionsByPost.get(c.post_id) || [];
    arr.push(cap);
    captionsByPost.set(c.post_id, arr);
  }

  return postsRes.rows.map((p) => {
    const items = (mediaByPost.get(p.id) || []).map((it) => ({
      ...it,
      status: (p.status as PostStatus) || it.status,
      caption: p.caption ?? undefined,
      activeCaptionId: p.active_caption_id || null,
      captionApproved: Boolean(p.caption_approved),
      captionSource: (p.caption_source as CaptionSource) || 'MANUAL',
      scheduledAt: toIsoOrUndefined(p.scheduled_at),
      scheduledTimezone: p.scheduled_timezone || 'America/Sao_Paulo',
      scheduledAccountId: p.scheduled_account_id || p.instagram_account_id || undefined,
      publishedAt: toIsoOrUndefined(p.published_at),
      instagramMediaId: p.instagram_media_id || undefined,
      instagramContainerId: p.instagram_container_id || undefined,
      childContainerIds: parseJsonSafe<string[]>(p.child_container_ids, []),
      instagramPermalink: p.instagram_permalink || undefined,
      approvedAt: toIsoOrUndefined(p.approved_at),
      approvedBy: p.approved_by || undefined,
      isApprovedForSchedule: Boolean(p.is_approved_for_schedule),
      publishAttempts: p.publish_attempts || 0,
      lastAttemptAt: toIsoOrUndefined(p.last_attempt_at),
      nextRetryAt: toIsoOrUndefined(p.next_retry_at) || null,
      failureReason: p.failure_reason || null,
      publishLock: parseJsonSafe<PublishLockInfo | null>(p.publish_lock, null),
      publishHistory: attemptsByPost.get(p.id) || [],
    }));

    return {
      id: p.id,
      loteNome: p.lote_nome,
      categoria: p.categoria as PostCategory,
      nome: p.nome,
      dataCriacao: toIsoOrUndefined(p.data_criacao) || new Date().toISOString(),
      status: (p.status as PostStatus) || 'PENDENTE',
      caption: p.caption ?? undefined,
      activeCaptionId: p.active_caption_id || null,
      captionApproved: Boolean(p.caption_approved),
      captionSource: (p.caption_source as CaptionSource) || 'MANUAL',
      captionsHistory: captionsByPost.get(p.id) || [],
      scheduledAt: toIsoOrUndefined(p.scheduled_at),
      scheduledTimezone: p.scheduled_timezone || 'America/Sao_Paulo',
      scheduledAccountId: p.scheduled_account_id || p.instagram_account_id || undefined,
      publishedAt: toIsoOrUndefined(p.published_at),
      instagramMediaId: p.instagram_media_id || undefined,
      instagramContainerId: p.instagram_container_id || undefined,
      childContainerIds: parseJsonSafe<string[]>(p.child_container_ids, []),
      instagramPermalink: p.instagram_permalink || undefined,
      approvedAt: toIsoOrUndefined(p.approved_at),
      approvedBy: p.approved_by || undefined,
      isApprovedForSchedule: Boolean(p.is_approved_for_schedule),
      publishAttempts: p.publish_attempts || 0,
      lastAttemptAt: toIsoOrUndefined(p.last_attempt_at),
      nextRetryAt: toIsoOrUndefined(p.next_retry_at) || null,
      failureReason: p.failure_reason || null,
      publishLock: parseJsonSafe<PublishLockInfo | null>(p.publish_lock, null),
      publishHistory: attemptsByPost.get(p.id) || [],
      items,
      tenantId: p.instagram_account_id || undefined,
      companyId: p.company_id || undefined,
      driveFolderName: p.drive_folder_name || undefined,
      pastaClienteNome: p.pasta_cliente_nome || undefined,
      pastaClienteId: p.pasta_cliente_id || undefined,
      pastaUrl: p.pasta_url || undefined,
      rejectionFeedback: parseJsonSafe<RejectionFeedback | undefined>(p.rejection_feedback, undefined),
    };
  });
}

/**
 * Persists a PostGroup and its DriveImageItems into posts, media_assets, post_media, and schedules.
 */
export async function upsertPostGroupToDb(
  group: PostGroup,
  tx?: DbClientLike
): Promise<void> {
  const runner = tx ? tx.query.bind(tx) : dbQuery;

  const folderName = (group.pastaClienteNome || group.driveFolderName || 'Ato').trim();
  let companyId = group.companyId || null;

  if (!companyId && folderName && folderName.toLowerCase() !== 'ato social midia') {
    const comp = await upsertCompany(
      {
        id: group.pastaClienteId || undefined,
        name: folderName,
        driveFolderId: group.pastaClienteId || null,
        driveFolderName: folderName,
        driveFolderUrl: group.pastaUrl || null,
      },
      tx
    );
    companyId = comp.id;
  }

  let igAccountId = group.scheduledAccountId || group.tenantId || null;
  if (igAccountId) {
    const checkAcc = await runner<{ id: string }>(
      'SELECT id FROM instagram_accounts WHERE id = $1 LIMIT 1',
      [igAccountId]
    );
    if (checkAcc.rows.length === 0) {
      igAccountId = null;
    }
  } else if (companyId || folderName) {
    const byFolder = await runner<{ id: string }>(
      `
      SELECT id FROM instagram_accounts
      WHERE company_id = $1 OR LOWER(drive_folder_name) = LOWER($2)
      LIMIT 1
      `,
      [companyId, folderName]
    );
    if (byFolder.rows[0]) {
      igAccountId = byFolder.rows[0].id;
    }
  }

  await runner(
    `
    INSERT INTO posts (
      id, company_id, instagram_account_id, lote_nome, nome, categoria, status,
      caption, active_caption_id, caption_approved, caption_source,
      drive_folder_name, pasta_cliente_nome, pasta_cliente_id, pasta_url,
      scheduled_at, scheduled_timezone, scheduled_account_id, published_at,
      instagram_media_id, instagram_container_id, child_container_ids, instagram_permalink,
      approved_at, approved_by, is_approved_for_schedule, publish_attempts,
      last_attempt_at, next_retry_at, failure_reason, publish_lock, rejection_feedback,
      data_criacao, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11,
      $12, $13, $14, $15,
      $16, $17, $18, $19,
      $20, $21, $22::jsonb, $23,
      $24, $25, $26, $27,
      $28, $29, $30, $31::jsonb, $32::jsonb,
      $33, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      company_id = COALESCE(EXCLUDED.company_id, posts.company_id),
      instagram_account_id = COALESCE(EXCLUDED.instagram_account_id, posts.instagram_account_id),
      lote_nome = EXCLUDED.lote_nome,
      nome = EXCLUDED.nome,
      categoria = EXCLUDED.categoria,
      status = EXCLUDED.status,
      caption = COALESCE(EXCLUDED.caption, posts.caption),
      active_caption_id = COALESCE(EXCLUDED.active_caption_id, posts.active_caption_id),
      caption_approved = EXCLUDED.caption_approved,
      caption_source = COALESCE(EXCLUDED.caption_source, posts.caption_source),
      drive_folder_name = COALESCE(EXCLUDED.drive_folder_name, posts.drive_folder_name),
      pasta_cliente_nome = COALESCE(EXCLUDED.pasta_cliente_nome, posts.pasta_cliente_nome),
      pasta_cliente_id = COALESCE(EXCLUDED.pasta_cliente_id, posts.pasta_cliente_id),
      pasta_url = COALESCE(EXCLUDED.pasta_url, posts.pasta_url),
      scheduled_at = EXCLUDED.scheduled_at,
      scheduled_timezone = COALESCE(EXCLUDED.scheduled_timezone, posts.scheduled_timezone),
      scheduled_account_id = COALESCE(EXCLUDED.scheduled_account_id, posts.scheduled_account_id),
      published_at = COALESCE(EXCLUDED.published_at, posts.published_at),
      instagram_media_id = COALESCE(EXCLUDED.instagram_media_id, posts.instagram_media_id),
      instagram_container_id = COALESCE(EXCLUDED.instagram_container_id, posts.instagram_container_id),
      child_container_ids = EXCLUDED.child_container_ids,
      instagram_permalink = COALESCE(EXCLUDED.instagram_permalink, posts.instagram_permalink),
      approved_at = COALESCE(EXCLUDED.approved_at, posts.approved_at),
      approved_by = COALESCE(EXCLUDED.approved_by, posts.approved_by),
      is_approved_for_schedule = EXCLUDED.is_approved_for_schedule,
      publish_attempts = EXCLUDED.publish_attempts,
      last_attempt_at = COALESCE(EXCLUDED.last_attempt_at, posts.last_attempt_at),
      next_retry_at = EXCLUDED.next_retry_at,
      failure_reason = EXCLUDED.failure_reason,
      publish_lock = EXCLUDED.publish_lock,
      rejection_feedback = COALESCE(EXCLUDED.rejection_feedback, posts.rejection_feedback),
      updated_at = NOW()
    `,
    [
      group.id,
      companyId,
      igAccountId,
      group.loteNome,
      group.nome,
      group.categoria,
      group.status || 'PENDENTE',
      group.caption ?? null,
      group.activeCaptionId ?? null,
      Boolean(group.captionApproved ?? group.isApprovedForSchedule),
      group.captionSource || 'MANUAL',
      folderName || null,
      folderName || null,
      group.pastaClienteId || null,
      group.pastaUrl || null,
      group.scheduledAt || null,
      group.scheduledTimezone || 'America/Sao_Paulo',
      igAccountId,
      group.publishedAt || null,
      group.instagramMediaId || null,
      group.instagramContainerId || null,
      JSON.stringify(group.childContainerIds || []),
      group.instagramPermalink || null,
      group.approvedAt || null,
      group.approvedBy || null,
      Boolean(group.isApprovedForSchedule),
      group.publishAttempts || 0,
      group.lastAttemptAt || null,
      group.nextRetryAt ?? null,
      group.failureReason ?? null,
      group.publishLock ? JSON.stringify(group.publishLock) : null,
      group.rejectionFeedback ? JSON.stringify(group.rejectionFeedback) : null,
      group.dataCriacao || new Date().toISOString(),
    ]
  );

  for (let idx = 0; idx < group.items.length; idx++) {
    const item = group.items[idx];
    const ordem = item.ordem ?? idx + 1;

    await runner(
      `
      INSERT INTO media_assets (
        drive_file_id, company_id, instagram_account_id, nome, categoria, lote_nome,
        view_url, thumbnail_url, download_url, mime_type, status, ordem,
        drive_folder_name, pasta_cliente_nome, pasta_cliente_id, pasta_url,
        rejection_feedback, data_criacao, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16,
        $17::jsonb, $18, NOW()
      )
      ON CONFLICT (drive_file_id) DO UPDATE SET
        company_id = COALESCE(EXCLUDED.company_id, media_assets.company_id),
        instagram_account_id = COALESCE(EXCLUDED.instagram_account_id, media_assets.instagram_account_id),
        nome = EXCLUDED.nome,
        categoria = EXCLUDED.categoria,
        lote_nome = EXCLUDED.lote_nome,
        view_url = EXCLUDED.view_url,
        thumbnail_url = EXCLUDED.thumbnail_url,
        download_url = COALESCE(EXCLUDED.download_url, media_assets.download_url),
        mime_type = EXCLUDED.mime_type,
        status = EXCLUDED.status,
        ordem = EXCLUDED.ordem,
        drive_folder_name = COALESCE(EXCLUDED.drive_folder_name, media_assets.drive_folder_name),
        pasta_cliente_nome = COALESCE(EXCLUDED.pasta_cliente_nome, media_assets.pasta_cliente_nome),
        pasta_cliente_id = COALESCE(EXCLUDED.pasta_cliente_id, media_assets.pasta_cliente_id),
        pasta_url = COALESCE(EXCLUDED.pasta_url, media_assets.pasta_url),
        rejection_feedback = COALESCE(EXCLUDED.rejection_feedback, media_assets.rejection_feedback),
        -- Veio do Drive agora, então o arquivo existe: remove qualquer marca de indisponível anterior.
        indisponivel = FALSE,
        indisponivel_em = NULL,
        updated_at = NOW()
      `,
      [
        item.driveFileId,
        companyId,
        igAccountId,
        item.nome,
        item.categoria,
        item.loteNome,
        item.viewUrl,
        item.thumbnailUrl,
        item.downloadUrl || null,
        item.mimeType || 'image/png',
        group.status || item.status || 'PENDENTE',
        ordem,
        folderName || null,
        folderName || null,
        item.pastaClienteId || group.pastaClienteId || null,
        item.pastaUrl || group.pastaUrl || null,
        item.rejectionFeedback ? JSON.stringify(item.rejectionFeedback) : null,
        item.dataCriacao || group.dataCriacao || new Date().toISOString(),
      ]
    );

    const pmId = `pm_${group.id}_${item.driveFileId}`;
    await runner(
      `
      INSERT INTO post_media (id, post_id, drive_file_id, ordem)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (post_id, drive_file_id) DO UPDATE SET ordem = EXCLUDED.ordem
      `,
      [pmId, group.id, item.driveFileId, ordem]
    );
  }

  // Sync schedules table when scheduledAt is present
  if (group.scheduledAt) {
    const schedId = `sched_${group.id}`;
    await runner(
      `
      INSERT INTO schedules (
        id, post_id, instagram_account_id, scheduled_at, scheduled_timezone,
        status, retry_count, next_retry_at, lock_instance_id, lock_acquired_at, lock_expires_at, last_error, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11, $12, NOW()
      )
      ON CONFLICT (post_id) DO UPDATE SET
        instagram_account_id = COALESCE(EXCLUDED.instagram_account_id, schedules.instagram_account_id),
        scheduled_at = EXCLUDED.scheduled_at,
        scheduled_timezone = EXCLUDED.scheduled_timezone,
        status = EXCLUDED.status,
        retry_count = EXCLUDED.retry_count,
        next_retry_at = EXCLUDED.next_retry_at,
        lock_instance_id = EXCLUDED.lock_instance_id,
        lock_acquired_at = EXCLUDED.lock_acquired_at,
        lock_expires_at = EXCLUDED.lock_expires_at,
        last_error = EXCLUDED.last_error,
        updated_at = NOW()
      `,
      [
        schedId,
        group.id,
        igAccountId,
        group.scheduledAt,
        group.scheduledTimezone || 'America/Sao_Paulo',
        group.status,
        group.publishAttempts || 0,
        group.nextRetryAt || null,
        group.publishLock?.instanceId || null,
        group.publishLock?.acquiredAt || null,
        group.publishLock?.expiresAt || null,
        group.failureReason || null,
      ]
    );
  } else {
    await runner('DELETE FROM schedules WHERE post_id = $1', [group.id]);
  }
}

export async function deletePostGroupFromDb(postId: string): Promise<boolean> {
  return await withTransaction(async (tx) => {
    const mediaRes = await tx.query<{ drive_file_id: string }>(
      'SELECT drive_file_id FROM post_media WHERE post_id = $1',
      [postId]
    );
    const fileIds = mediaRes.rows.map((r) => r.drive_file_id);
    const delPost = await tx.query('DELETE FROM posts WHERE id = $1', [postId]);
    if (fileIds.length > 0) {
      await tx.query('DELETE FROM media_assets WHERE drive_file_id = ANY($1::varchar[])', [fileIds]);
    }
    return (delPost.rowCount || 0) > 0;
  });
}

// ============================================================================
// 5. MODULE: CAPTIONS, GEMINI AI AUDIT & RE-APPROVAL ENFORCEMENT
// ============================================================================

export async function recordAIGenerationInDb(
  record: Omit<AIGenerationRecord, 'createdAt'> & { createdAt?: string },
  tx?: DbClientLike
): Promise<AIGenerationRecord> {
  const runner = tx ? tx.query.bind(tx) : dbQuery;
  const createdAt = record.createdAt || new Date().toISOString();

  await runner(
    `
    INSERT INTO ai_generations (
      id, post_id, company_id, model, objective, theme, briefing, tone, cta,
      include_hashtags, used_multimodal_image, generated_text, status, error_message, latency_ms, created_by, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      $10, $11, $12, $13, $14, $15, $16, $17
    )
    `,
    [
      record.id,
      record.postId || null,
      record.companyId || null,
      record.model,
      record.objective || null,
      record.theme || null,
      record.briefing || null,
      record.tone || null,
      record.cta || null,
      Boolean(record.includeHashtags),
      Boolean(record.usedMultimodalImage),
      record.generatedText || null,
      record.status,
      record.errorMessage || null,
      record.latencyMs ?? null,
      record.createdBy || null,
      createdAt,
    ]
  );

  return {
    ...record,
    createdAt,
  };
}

/**
 * Saves a new caption version (from Gemini AI or manual edit) and associates it with the post.
 * CRITICAL RULE (Etapa 7):
 * If the post was already approved (APROVADO or AGENDADO) and the caption text changed,
 * the modified version requires re-approval before publication!
 */
export async function saveCaptionForPostTx(params: {
  postId: string;
  content: string;
  source: CaptionSource;
  aiGenerationId?: string | null;
  createdBy?: string | null;
  approveImmediately?: boolean;
}): Promise<{
  caption: CaptionRecord;
  post: PostGroup;
  requiresReapproval: boolean;
}> {
  const savedMeta = await withTransaction(async (tx) => {
    const postRes = await tx.query<any>('SELECT * FROM posts WHERE id = $1 LIMIT 1', [
      params.postId,
    ]);
    if (postRes.rows.length === 0) {
      throw new Error(`Postagem "${params.postId}" não encontrada no PostgreSQL.`);
    }
    const postRow = postRes.rows[0];
    const previousCaption = String(postRow.caption || '').trim();
    const newCaption = String(params.content || '').trim();
    const captionChanged = previousCaption !== newCaption;

    const wasApprovedOrScheduled =
      postRow.status === 'APROVADO' ||
      postRow.status === 'AGENDADO' ||
      Boolean(postRow.is_approved_for_schedule) ||
      Boolean(postRow.caption_approved);

    const requiresReapproval =
      !params.approveImmediately && wasApprovedOrScheduled && captionChanged;

    const verRes = await tx.query<{ max_ver: number }>(
      'SELECT COALESCE(MAX(version_number), 0) AS max_ver FROM captions WHERE post_id = $1',
      [params.postId]
    );
    const nextVersion = Number(verRes.rows[0]?.max_ver || 0) + 1;

    // Deselect previous captions for this post
    await tx.query('UPDATE captions SET is_selected = FALSE WHERE post_id = $1', [params.postId]);

    const captionId = `cap_${params.postId}_${nextVersion}_${Date.now()}`;
    const approvalStatus: CaptionApprovalStatus = params.approveImmediately
      ? 'APPROVED'
      : requiresReapproval
      ? 'PENDING_APPROVAL'
      : 'DRAFT';
    const nowIso = new Date().toISOString();

    await tx.query(
      `
      INSERT INTO captions (
        id, post_id, company_id, version_number, content, source, ai_generation_id,
        is_selected, approval_status, created_by, approved_by, approved_at, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        TRUE, $8, $9, $10, $11, $12
      )
      `,
      [
        captionId,
        params.postId,
        postRow.company_id || null,
        nextVersion,
        newCaption,
        params.source,
        params.aiGenerationId || null,
        approvalStatus,
        params.createdBy || null,
        params.approveImmediately ? params.createdBy || 'Sistema' : null,
        params.approveImmediately ? nowIso : null,
        nowIso,
      ]
    );

    let nextPostStatus: PostStatus = postRow.status;
    let nextIsApprovedForSchedule = Boolean(postRow.is_approved_for_schedule);
    let nextCaptionApproved = Boolean(postRow.caption_approved);

    if (params.approveImmediately) {
      nextCaptionApproved = true;
      nextIsApprovedForSchedule = true;
    } else if (requiresReapproval) {
      nextPostStatus = 'PENDENTE_APROVACAO';
      nextCaptionApproved = false;
      nextIsApprovedForSchedule = false;
      await tx.query('DELETE FROM schedules WHERE post_id = $1', [params.postId]);
    }

    await tx.query(
      `
      UPDATE posts SET
        caption = $2,
        active_caption_id = $3,
        caption_source = $4,
        caption_approved = $5,
        status = $6,
        is_approved_for_schedule = $7,
        publish_lock = NULL,
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        params.postId,
        newCaption,
        captionId,
        params.source,
        nextCaptionApproved,
        nextPostStatus,
        nextIsApprovedForSchedule,
      ]
    );

    if (requiresReapproval) {
      await tx.query(
        `
        UPDATE media_assets SET status = $2, updated_at = NOW()
        WHERE drive_file_id IN (SELECT drive_file_id FROM post_media WHERE post_id = $1)
        `,
        [params.postId, nextPostStatus]
      );
    }

    const captionRecord: CaptionRecord = {
      id: captionId,
      postId: params.postId,
      companyId: postRow.company_id || null,
      versionNumber: nextVersion,
      content: newCaption,
      source: params.source,
      aiGenerationId: params.aiGenerationId || null,
      isSelected: true,
      approvalStatus,
      createdBy: params.createdBy || null,
      approvedBy: params.approveImmediately ? params.createdBy || 'Sistema' : null,
      approvedAt: params.approveImmediately ? nowIso : null,
      createdAt: nowIso,
    };

    return { captionRecord, requiresReapproval };
  });

  const updatedPost = await getPostGroupByIdFromDb(params.postId);
  return {
    caption: savedMeta.captionRecord,
    post: updatedPost!,
    requiresReapproval: savedMeta.requiresReapproval,
  };
}

export async function recordApprovalInDb(
  params: {
    postId: string;
    caption: string;
    action: 'APPROVE_ONLY' | 'APPROVE_AND_SCHEDULE' | 'APPROVE_AND_PUBLISH_NOW';
    approvedBy: string;
    scheduledAtUtc?: string | null;
    scheduledTimezone?: string;
    scheduledAccountId?: string | null;
  },
  tx?: DbClientLike
): Promise<void> {
  const runner = tx ? tx.query.bind(tx) : dbQuery;
  const nowIso = new Date().toISOString();

  // Ensure the approved caption is recorded and marked APPROVED in captions table
  const postRes = await runner<any>('SELECT * FROM posts WHERE id = $1 LIMIT 1', [params.postId]);
  if (postRes.rows.length === 0) return;
  const postRow = postRes.rows[0];

  let activeCaptionId = postRow.active_caption_id;
  const cleanCaption = String(params.caption ?? postRow.caption ?? '').trim();

  if (cleanCaption !== String(postRow.caption || '').trim() || !activeCaptionId) {
    const verRes = await runner<{ max_ver: number }>(
      'SELECT COALESCE(MAX(version_number), 0) AS max_ver FROM captions WHERE post_id = $1',
      [params.postId]
    );
    const nextVer = Number(verRes.rows[0]?.max_ver || 0) + 1;
    activeCaptionId = `cap_${params.postId}_${nextVer}_${Date.now()}`;
    await runner('UPDATE captions SET is_selected = FALSE WHERE post_id = $1', [params.postId]);
    await runner(
      `
      INSERT INTO captions (
        id, post_id, company_id, version_number, content, source, is_selected,
        approval_status, created_by, approved_by, approved_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, 'APPROVED', $7, $7, $8, $8)
      `,
      [
        activeCaptionId,
        params.postId,
        postRow.company_id || null,
        nextVer,
        cleanCaption,
        postRow.caption_source || 'MANUAL',
        params.approvedBy,
        nowIso,
      ]
    );
  } else if (activeCaptionId) {
    await runner(
      `
      UPDATE captions SET approval_status = 'APPROVED', approved_by = $2, approved_at = $3
      WHERE id = $1
      `,
      [activeCaptionId, params.approvedBy, nowIso]
    );
  }

  const approvalId = `appr_${params.postId}_${Date.now()}`;
  await runner(
    `
    INSERT INTO approvals (id, post_id, caption_id, action, approved_caption, approved_by, approved_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [approvalId, params.postId, activeCaptionId || null, params.action, cleanCaption, params.approvedBy, nowIso]
  );

  const nextStatus: PostStatus =
    params.action === 'APPROVE_AND_SCHEDULE' ? 'AGENDADO' : 'APROVADO';

  await runner(
    `
    UPDATE posts SET
      status = $2,
      caption = $3,
      active_caption_id = $4,
      caption_approved = TRUE,
      approved_at = $5,
      approved_by = $6,
      is_approved_for_schedule = TRUE,
      scheduled_at = COALESCE($7, scheduled_at),
      scheduled_timezone = COALESCE($8, scheduled_timezone),
      scheduled_account_id = COALESCE($9, scheduled_account_id, instagram_account_id),
      failure_reason = NULL,
      next_retry_at = NULL,
      publish_lock = NULL,
      updated_at = NOW()
    WHERE id = $1
    `,
    [
      params.postId,
      nextStatus,
      cleanCaption,
      activeCaptionId || null,
      nowIso,
      params.approvedBy,
      params.scheduledAtUtc !== undefined ? params.scheduledAtUtc : null,
      params.scheduledTimezone || 'America/Sao_Paulo',
      params.scheduledAccountId || null,
    ]
  );

  await runner(
    `
    UPDATE media_assets SET status = $2, updated_at = NOW()
    WHERE drive_file_id IN (SELECT drive_file_id FROM post_media WHERE post_id = $1)
    `,
    [params.postId, nextStatus]
  );

  if (params.action === 'APPROVE_AND_SCHEDULE' && params.scheduledAtUtc) {
    const schedId = `sched_${params.postId}`;
    await runner(
      `
      INSERT INTO schedules (
        id, post_id, instagram_account_id, scheduled_at, scheduled_timezone,
        status, retry_count, next_retry_at, lock_instance_id, lock_acquired_at, lock_expires_at, last_error, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 'AGENDADO', 0, NULL, NULL, NULL, NULL, NULL, NOW())
      ON CONFLICT (post_id) DO UPDATE SET
        instagram_account_id = COALESCE(EXCLUDED.instagram_account_id, schedules.instagram_account_id),
        scheduled_at = EXCLUDED.scheduled_at,
        scheduled_timezone = EXCLUDED.scheduled_timezone,
        status = 'AGENDADO',
        retry_count = 0,
        next_retry_at = NULL,
        lock_instance_id = NULL,
        lock_acquired_at = NULL,
        lock_expires_at = NULL,
        last_error = NULL,
        updated_at = NOW()
      `,
      [
        schedId,
        params.postId,
        params.scheduledAccountId || postRow.instagram_account_id || null,
        params.scheduledAtUtc,
        params.scheduledTimezone || 'America/Sao_Paulo',
      ]
    );
  }
}

export async function recordRejectionInDb(params: {
  postId: string;
  driveFileId: string;
  pastaClienteId: string;
  pastaNome: string;
  originalFilename: string;
  novoNomeArquivo: string;
  tags: string[];
  motivo: string;
  rejectedBy?: string;
  dataReprovacao: string;
  renameItemFn: (originalName: string) => string;
}): Promise<PostGroup | null> {
  await withTransaction(async (tx) => {
    const rejectionFeedback: RejectionFeedback = {
      tags: params.tags,
      motivo: params.motivo,
      novoNomeArquivo: params.novoNomeArquivo,
      dataReprovacao: params.dataReprovacao,
      pastaClienteId: params.pastaClienteId,
      driveFileId: params.driveFileId,
    };

    const rejId = `rej_${params.postId}_${Date.now()}`;
    await tx.query(
      `
      INSERT INTO rejections (
        id, post_id, drive_file_id, pasta_cliente_id, pasta_nome,
        original_filename, novo_nome_arquivo, tags, motivo, rejected_by, data_reprovacao
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
      `,
      [
        rejId,
        params.postId,
        params.driveFileId,
        params.pastaClienteId,
        params.pastaNome,
        params.originalFilename,
        params.novoNomeArquivo,
        JSON.stringify(params.tags),
        params.motivo,
        params.rejectedBy || 'Cliente/Admin',
        params.dataReprovacao,
      ]
    );

    await tx.query(
      `
      UPDATE posts SET
        status = 'REPROVADO',
        is_approved_for_schedule = FALSE,
        caption_approved = FALSE,
        rejection_feedback = $2::jsonb,
        publish_lock = NULL,
        updated_at = NOW()
      WHERE id = $1
      `,
      [params.postId, JSON.stringify(rejectionFeedback)]
    );

    await tx.query('DELETE FROM schedules WHERE post_id = $1', [params.postId]);

    const itemsRes = await tx.query<{ drive_file_id: string; nome: string }>(
      `
      SELECT m.drive_file_id, m.nome
      FROM media_assets m
      JOIN post_media pm ON pm.drive_file_id = m.drive_file_id
      WHERE pm.post_id = $1
      `,
      [params.postId]
    );

    for (const item of itemsRes.rows) {
      const renamed = params.renameItemFn(item.nome);
      await tx.query(
        `
        UPDATE media_assets SET
          status = 'REPROVADO',
          nome = $2,
          rejection_feedback = $3::jsonb,
          updated_at = NOW()
        WHERE drive_file_id = $1
        `,
        [item.drive_file_id, renamed, JSON.stringify(rejectionFeedback)]
      );
    }
  });

  return await getPostGroupByIdFromDb(params.postId);
}

// ============================================================================
// 6. MODULE: TRANSACTIONAL SCHEDULING & PUBLICATION HISTORY
// ============================================================================

export async function acquirePostScheduleLockInDb(
  postId: string,
  workerId: string,
  nowMs: number
): Promise<{ acquired: boolean; post?: PostGroup; reason?: string }> {
  const outcome = await withTransaction(async (tx) => {
    const res = await tx.query<any>(
      'SELECT * FROM posts WHERE id = $1 FOR UPDATE',
      [postId]
    );
    if (res.rows.length === 0) {
      return { acquired: false, reason: 'POST_NOT_FOUND' };
    }

    const p = res.rows[0];
    if (p.status !== 'AGENDADO') {
      return { acquired: false, reason: `INVALID_STATUS_${p.status}` };
    }
    if (!p.is_approved_for_schedule) {
      return { acquired: false, reason: 'NOT_APPROVED_FOR_SCHEDULE' };
    }
    if (!p.scheduled_at) {
      return { acquired: false, reason: 'MISSING_SCHEDULED_AT' };
    }

    const schedMs = Date.parse(toIsoOrUndefined(p.scheduled_at) || '');
    if (Number.isNaN(schedMs) || schedMs > nowMs) {
      return { acquired: false, reason: 'NOT_DUE_YET' };
    }

    if (p.next_retry_at) {
      const retryMs = Date.parse(toIsoOrUndefined(p.next_retry_at) || '');
      if (!Number.isNaN(retryMs) && retryMs > nowMs) {
        return { acquired: false, reason: 'WAITING_BACKOFF_RETRY' };
      }
    }

    const lock = parseJsonSafe<PublishLockInfo | null>(p.publish_lock, null);
    if (lock && lock.expiresAt) {
      const expMs = Date.parse(lock.expiresAt);
      if (!Number.isNaN(expMs) && expMs > nowMs) {
        return { acquired: false, reason: 'ALREADY_LOCKED' };
      }
    }

    const lockIso = new Date(nowMs).toISOString();
    const lockExpiresIso = new Date(nowMs + 5 * 60 * 1000).toISOString();
    const lockObj: PublishLockInfo = {
      instanceId: workerId,
      acquiredAt: lockIso,
      expiresAt: lockExpiresIso,
    };

    await tx.query(
      `
      UPDATE posts SET
        status = 'PUBLICANDO',
        publish_lock = $2::jsonb,
        updated_at = NOW()
      WHERE id = $1
      `,
      [postId, JSON.stringify(lockObj)]
    );

    await tx.query(
      `
      UPDATE media_assets SET status = 'PUBLICANDO', updated_at = NOW()
      WHERE drive_file_id IN (SELECT drive_file_id FROM post_media WHERE post_id = $1)
      `,
      [postId]
    );

    await tx.query(
      `
      UPDATE schedules SET
        status = 'PUBLICANDO',
        lock_instance_id = $2,
        lock_acquired_at = $3,
        lock_expires_at = $4,
        updated_at = NOW()
      WHERE post_id = $1
      `,
      [postId, workerId, lockIso, lockExpiresIso]
    );

    return { acquired: true };
  });

  if (!outcome.acquired) {
    return outcome;
  }

  const lockedPost = await getPostGroupByIdFromDb(postId);
  return { acquired: true, post: lockedPost || undefined };
}

export async function recordPublicationAttemptAndOutcomeInDb(params: {
  postId: string;
  tenant: TenantAccount;
  origin: 'IMMEDIATE' | 'SCHEDULER';
  caption: string;
  ok: boolean;
  finalStatus: PostStatus;
  attemptRecord: PublishAttemptRecord;
  containerId?: string;
  childContainerIds?: string[];
  instagramMediaId?: string;
  permalink?: string;
  publishedAt?: string;
  nextRetryAt?: string | null;
  failureReason?: string | null;
}): Promise<PostGroup | null> {
  await withTransaction(async (tx) => {
    const postExists = await tx.query<{ id: string }>(
      `SELECT id FROM posts WHERE id = $1 LIMIT 1`,
      [params.postId]
    );
    if (postExists.rows.length === 0) {
      return;
    }

    const attemptId = `att_${params.postId}_${params.attemptRecord.attemptNumber}_${Date.now()}`;
    await tx.query(
      `
      INSERT INTO publication_attempts (
        id, post_id, instagram_account_id, ig_user_id, attempt_number, origin,
        container_id, child_container_ids, media_id, permalink, status,
        http_status, meta_error_code, meta_error_subcode, error_message,
        started_at, finished_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8::jsonb, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17
      )
      `,
      [
        attemptId,
        params.postId,
        params.tenant.id,
        params.attemptRecord.igUserId,
        params.attemptRecord.attemptNumber,
        params.origin,
        params.containerId || params.attemptRecord.containerId || null,
        JSON.stringify(params.childContainerIds || params.attemptRecord.childContainerIds || []),
        params.instagramMediaId || params.attemptRecord.mediaId || null,
        params.permalink || params.attemptRecord.permalink || null,
        params.attemptRecord.status,
        params.attemptRecord.httpStatus ?? null,
        params.attemptRecord.metaErrorCode ?? null,
        params.attemptRecord.metaErrorSubcode ?? null,
        params.attemptRecord.errorMessage || null,
        params.attemptRecord.startedAt,
        params.attemptRecord.finishedAt,
      ]
    );

    if (params.ok && params.instagramMediaId) {
      const histId = `pubhist_${params.postId}_${params.instagramMediaId}`;
      await tx.query(
        `
        INSERT INTO publication_history (
          id, post_id, company_id, instagram_account_id, ig_user_id,
          container_id, child_container_ids, instagram_media_id, permalink, caption, published_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
        ON CONFLICT (id) DO NOTHING
        `,
        [
          histId,
          params.postId,
          params.tenant.companyId || null,
          params.tenant.id,
          params.attemptRecord.igUserId,
          params.containerId || null,
          JSON.stringify(params.childContainerIds || []),
          params.instagramMediaId,
          params.permalink || null,
          params.caption,
          params.publishedAt || new Date().toISOString(),
        ]
      );
    }

    await tx.query(
      `
      UPDATE posts SET
        status = $2,
        instagram_account_id = COALESCE($3, instagram_account_id),
        scheduled_account_id = COALESCE($3, scheduled_account_id),
        caption = COALESCE($4, caption),
        published_at = COALESCE($5, published_at),
        instagram_container_id = COALESCE($6, instagram_container_id),
        child_container_ids = $7::jsonb,
        instagram_media_id = COALESCE($8, instagram_media_id),
        instagram_permalink = COALESCE($9, instagram_permalink),
        publish_attempts = $10,
        last_attempt_at = $11,
        next_retry_at = $12,
        failure_reason = $13,
        publish_lock = NULL,
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        params.postId,
        params.finalStatus,
        params.tenant.id,
        params.caption,
        params.ok ? params.publishedAt || new Date().toISOString() : null,
        params.containerId || null,
        JSON.stringify(params.childContainerIds || []),
        params.instagramMediaId || null,
        params.permalink || null,
        params.attemptRecord.attemptNumber,
        params.attemptRecord.startedAt,
        params.nextRetryAt ?? null,
        params.failureReason ?? null,
      ]
    );

    await tx.query(
      `
      UPDATE media_assets SET
        status = $2,
        updated_at = NOW()
      WHERE drive_file_id IN (SELECT drive_file_id FROM post_media WHERE post_id = $1)
      `,
      [params.postId, params.finalStatus]
    );

    await tx.query(
      `
      UPDATE schedules SET
        status = $2,
        retry_count = $3,
        next_retry_at = $4,
        lock_instance_id = NULL,
        lock_acquired_at = NULL,
        lock_expires_at = NULL,
        last_error = $5,
        updated_at = NOW()
      WHERE post_id = $1
      `,
      [
        params.postId,
        params.finalStatus,
        params.attemptRecord.attemptNumber,
        params.nextRetryAt ?? null,
        params.failureReason ?? null,
      ]
    );
  });

  return await getPostGroupByIdFromDb(params.postId);
}

// ============================================================================
// 7. MODULE: OPERATIONAL LOGS, ALERTS & SCHEDULER RUNS
// ============================================================================

export async function addAdminAlertInDb(
  alert: Omit<AdminAlertNotification, 'id' | 'createdAt' | 'resolved'>,
  tx?: DbClientLike
): Promise<void> {
  const runner = tx ? tx.query.bind(tx) : dbQuery;

  const existing = await runner<{ id: string }>(
    `
    SELECT id FROM operational_logs
    WHERE category = 'ADMIN_ALERT' AND resolved = FALSE AND tenant_id = $1 AND type = $2
    LIMIT 1
    `,
    [alert.tenantId, alert.type]
  );

  if (existing.rows.length > 0) {
    await runner(
      `
      UPDATE operational_logs SET message = $2, created_at = NOW()
      WHERE id = $1
      `,
      [existing.rows[0].id, alert.message]
    );
    return;
  }

  const alertId = `alert_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await runner(
    `
    INSERT INTO operational_logs (
      id, category, type, tenant_id, username, post_id, message, resolved, created_at
    ) VALUES ($1, 'ADMIN_ALERT', $2, $3, $4, $5, $6, FALSE, NOW())
    `,
    [
      alertId,
      alert.type,
      alert.tenantId,
      alert.username,
      alert.postId || null,
      alert.message,
    ]
  );
}

export async function listUnresolvedAdminAlertsFromDb(): Promise<AdminAlertNotification[]> {
  const res = await dbQuery<any>(
    `
    SELECT * FROM operational_logs
    WHERE category = 'ADMIN_ALERT' AND resolved = FALSE
    ORDER BY created_at DESC
    LIMIT 50
    `
  );

  return res.rows.map((r) => ({
    id: r.id,
    type: r.type,
    tenantId: r.tenant_id || '',
    username: r.username || '',
    postId: r.post_id || undefined,
    message: r.message || '',
    createdAt: toIsoOrUndefined(r.created_at) || new Date().toISOString(),
    resolved: Boolean(r.resolved),
    resolvedAt: toIsoOrUndefined(r.resolved_at),
  }));
}

export async function resolveAdminAlertInDb(alertId: string): Promise<void> {
  await dbQuery(
    `UPDATE operational_logs SET resolved = TRUE, resolved_at = NOW() WHERE id = $1`,
    [alertId]
  );
}

export async function resolveAdminAlertsForTenantInDb(
  tenantId: string,
  tx?: DbClientLike
): Promise<void> {
  const runner = tx ? tx.query.bind(tx) : dbQuery;
  await runner(
    `
    UPDATE operational_logs
    SET resolved = TRUE, resolved_at = NOW()
    WHERE category = 'ADMIN_ALERT' AND tenant_id = $1 AND resolved = FALSE
    `,
    [tenantId]
  );
}

export async function recordSchedulerRunInDb(summary: {
  runId: string;
  startedAt: string;
  finishedAt: string;
  processedCount: number;
  publishedCount: number;
  failedCount: number;
  skippedCount: number;
}): Promise<void> {
  await dbQuery(
    `
    INSERT INTO operational_logs (id, category, type, message, payload, resolved, created_at)
    VALUES ($1, 'SCHEDULER_RUN', 'CRON_RUN', $2, $3::jsonb, TRUE, $4)
    ON CONFLICT (id) DO NOTHING
    `,
    [
      `run_${summary.runId}`,
      `Processados: ${summary.processedCount}, Publicados: ${summary.publishedCount}, Falhas: ${summary.failedCount}`,
      JSON.stringify(summary),
      summary.startedAt,
    ]
  );
}

export async function listRecentSchedulerRunsFromDb(limit = 15): Promise<any[]> {
  const res = await dbQuery<any>(
    `
    SELECT payload FROM operational_logs
    WHERE category = 'SCHEDULER_RUN'
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return res.rows.map((r) => parseJsonSafe(r.payload, {})).filter(Boolean);
}

export async function recordTokenRefreshRunInDb(summary: {
  runId: string;
  executedAt: string;
  checked: number;
  refreshed: number;
  skippedRecent: number;
  skippedHealthy: number;
  markedReconnection: number;
  transientErrors: number;
  details: any[];
}): Promise<void> {
  await dbQuery(
    `
    INSERT INTO operational_logs (id, category, type, message, payload, resolved, created_at)
    VALUES ($1, 'TOKEN_REFRESH_RUN', 'DAILY_TOKEN_REFRESH', $2, $3::jsonb, TRUE, $4)
    ON CONFLICT (id) DO NOTHING
    `,
    [
      `tokrun_${summary.runId}`,
      `Verificados: ${summary.checked}, Renovados: ${summary.refreshed}, Saudáveis: ${summary.skippedHealthy}, Transitórios: ${summary.transientErrors}`,
      JSON.stringify(summary),
      summary.executedAt,
    ]
  );
}

export async function logOperationalActionInDb(params: {
  action: string;
  tenantId?: string | null;
  postId?: string | null;
  message: string;
  payload?: any;
}): Promise<void> {
  const id = `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await dbQuery(
    `
    INSERT INTO operational_logs (id, category, type, tenant_id, post_id, message, payload, resolved, created_at)
    VALUES ($1, 'AUDIT_LOG', $2, $3, $4, $5, $6::jsonb, TRUE, NOW())
    `,
    [
      id,
      params.action,
      params.tenantId || null,
      params.postId || null,
      params.message,
      JSON.stringify(params.payload || {}),
    ]
  ).catch((err) => {
    console.warn('[Operational Log] Falha ao registrar log:', err?.message);
  });
}

export async function getLastTokenRefreshRunFromDb(): Promise<{
  runId: string;
  executedAt: string;
  checked: number;
  refreshed: number;
  transientErrors: number;
  details?: any[];
} | null> {
  const res = await dbQuery<any>(
    `
    SELECT payload, created_at FROM operational_logs
    WHERE category = 'TOKEN_REFRESH_RUN'
    ORDER BY created_at DESC
    LIMIT 1
    `
  );
  if (res.rows.length === 0) return null;
  const parsed = parseJsonSafe<any>(res.rows[0].payload, null);
  if (!parsed) return null;
  return {
    runId: parsed.runId || 'tokrun',
    executedAt: parsed.executedAt || toIsoOrUndefined(res.rows[0].created_at) || new Date().toISOString(),
    checked: Number(parsed.checked || 0),
    refreshed: Number(parsed.refreshed || 0),
    transientErrors: Number(parsed.transientErrors || 0),
    details: parsed.details,
  };
}

// ============================================================================
// 8. INVENTORY & DIAGNOSTIC COUNTS
// ============================================================================

export async function getDatabaseTableCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ALL_MANAGED_TABLES) {
    try {
      const res = await dbQuery<{ cnt: string | number }>(`SELECT COUNT(*) AS cnt FROM ${table}`);
      counts[table] = Number(res.rows[0]?.cnt || 0);
    } catch {
      counts[table] = 0;
    }
  }
  return counts;
}

// ============================================================================
// 9. MEDIA HIDING & VISIBILITY PER USER
// ============================================================================

export async function hideMediaForUserInDb(userId: string, postId: string): Promise<void> {
  const id = `hide_${userId}_${postId}`.slice(0, 128);
  await dbQuery(
    `
    INSERT INTO user_hidden_media (id, user_id, post_id, hidden_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (user_id, post_id) DO UPDATE SET hidden_at = NOW()
    `,
    [id, userId, postId]
  );
}

export async function unhideMediaForUserInDb(userId: string, postId: string): Promise<void> {
  await dbQuery(
    `DELETE FROM user_hidden_media WHERE user_id = $1 AND post_id = $2`,
    [userId, postId]
  );
}

export async function getHiddenPostIdsForUserFromDb(userId: string): Promise<string[]> {
  try {
    const res = await dbQuery<{ post_id: string }>(
      `SELECT post_id FROM user_hidden_media WHERE user_id = $1`,
      [userId]
    );
    return res.rows.map((r) => r.post_id);
  } catch {
    return [];
  }
}

export async function unhideMediaForAllUsersInDb(postId: string): Promise<void> {
  await dbQuery(`DELETE FROM user_hidden_media WHERE post_id = $1`, [postId]);
}

/** Marca a mídia como indisponível (arquivo inexistente no Drive). Ela deixa de aparecer nas listagens. */
export async function markMediaUnavailableInDb(driveFileId: string): Promise<void> {
  await dbQuery(
    `UPDATE media_assets
     SET indisponivel = TRUE, indisponivel_em = COALESCE(indisponivel_em, NOW()), updated_at = NOW()
     WHERE drive_file_id = $1 AND indisponivel = FALSE`,
    [driveFileId]
  );
}

/** Lista os ids das mídias marcadas como indisponíveis (usado para filtrar a resposta em memória). */
export async function listUnavailableMediaIdsFromDb(): Promise<string[]> {
  const res = await dbQuery<{ drive_file_id: string }>(
    `SELECT drive_file_id FROM media_assets WHERE indisponivel = TRUE`
  );
  return res.rows.map((r) => r.drive_file_id);
}

export async function getAllHiddenPostsMapFromDb(): Promise<Map<string, { userId: string; hiddenAt: string }>> {
  try {
    const res = await dbQuery<{ post_id: string; user_id: string; hidden_at: any }>(
      `SELECT DISTINCT ON (post_id) post_id, user_id, hidden_at FROM user_hidden_media ORDER BY post_id, hidden_at DESC`
    );
    const map = new Map<string, { userId: string; hiddenAt: string }>();
    for (const row of res.rows) {
      map.set(row.post_id, {
        userId: row.user_id,
        hiddenAt: toIsoOrUndefined(row.hidden_at) || new Date().toISOString(),
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

// ============================================================================
// 10. CONTROLLED TEST RECORDS PREVIEW & RESET ROUTINE
// ============================================================================

export interface TestRecordCandidate {
  id: string;
  nome: string;
  loteNome: string;
  status: string;
  categoria: string;
  driveFolderName: string | null;
  scheduledAt: string | null;
  publishedAt: string | null;
  publishAttempts: number;
  failureReason: string | null;
  instagramAccountId: string | null;
  isUpload: boolean;
  isTestCandidate: boolean;
  matchReasons: string[];
}

export async function getTestRecordsPreviewFromDb(): Promise<{
  totalPosts: number;
  candidatesCount: number;
  candidates: TestRecordCandidate[];
}> {
  const res = await dbQuery<any>(
    `
    SELECT id, nome, lote_nome, categoria, status, scheduled_at, published_at,
           instagram_account_id, scheduled_account_id, publish_attempts, failure_reason,
           drive_folder_name, origem, is_archived_test
    FROM posts
    ORDER BY created_at DESC
    `
  );

  const candidates: TestRecordCandidate[] = [];

  for (const row of res.rows) {
    const matchReasons: string[] = [];
    const idLower = String(row.id || '').toLowerCase();
    const nomeLower = String(row.nome || '').toLowerCase();
    const loteLower = String(row.lote_nome || '').toLowerCase();

    if (row.status === 'PUBLICADO' || row.published_at) {
      matchReasons.push('Post enviado/publicado (pode ser retornado para Não Enviado)');
    }
    if (row.publish_attempts > 0) {
      matchReasons.push(`Possui ${row.publish_attempts} tentativa(s) de envio`);
    }
    if (row.status === 'AGENDADO' || row.status === 'PUBLICANDO' || row.status === 'CANCELADO' || row.status === 'REPROVADO') {
      matchReasons.push(`Status modificado em testes (${row.status})`);
    }
    if (idLower.includes('test') || idLower.includes('saas') || idLower.includes('imm') || idLower.includes('sched')) {
      matchReasons.push('ID contém padrão de teste');
    }
    if (nomeLower.includes('teste') || loteLower.includes('teste') || nomeLower.includes('test') || loteLower.includes('test')) {
      matchReasons.push('Título ou Lote identificado como teste');
    }
    if (row.is_archived_test) {
      matchReasons.push('Já marcado como arquivado de teste');
    }

    const isTestCandidate = matchReasons.length > 0 || res.rows.length <= 100;
    if (isTestCandidate) {
      candidates.push({
        id: row.id,
        nome: row.nome,
        loteNome: row.lote_nome,
        status: row.status,
        categoria: row.categoria,
        driveFolderName: row.drive_folder_name,
        scheduledAt: toIsoOrUndefined(row.scheduled_at) || null,
        publishedAt: toIsoOrUndefined(row.published_at) || null,
        publishAttempts: Number(row.publish_attempts || 0),
        failureReason: row.failure_reason || null,
        instagramAccountId: row.scheduled_account_id || row.instagram_account_id || null,
        isUpload: row.origem === 'UPLOAD' || idLower.startsWith('upload_'),
        isTestCandidate: true,
        matchReasons: matchReasons.length > 0 ? matchReasons : ['Post pronto para reset de estado'],
      });
    }
  }

  return {
    totalPosts: res.rows.length,
    candidatesCount: candidates.length,
    candidates,
  };
}

export async function resetTestRecordsInDb(params: {
  scope: 'ALL_CANDIDATES' | 'SELECTED_IDS';
  selectedIds?: string[];
  action?: string;
  adminUser: string;
}): Promise<{
  success: boolean;
  message: string;
  affectedCount: number;
  backupSnapshotId: string;
}> {
  const { scope, selectedIds = [], adminUser } = params;

  let targetPostIds: string[] = [];
  if (selectedIds.length > 0) {
    targetPostIds = selectedIds.filter(Boolean);
  } else {
    const preview = await getTestRecordsPreviewFromDb();
    targetPostIds = preview.candidates.map((c) => c.id);
  }

  if (targetPostIds.length === 0) {
    const allPostsRes = await dbQuery<{ id: string }>(`SELECT id FROM posts`);
    targetPostIds = allPostsRes.rows.map((r) => r.id);
  }

  if (targetPostIds.length === 0) {
    return {
      success: true,
      message: 'Nenhum registro encontrado no banco de dados para reset.',
      affectedCount: 0,
      backupSnapshotId: '',
    };
  }

  const snapshotData = await dbQuery(
    `SELECT * FROM posts WHERE id = ANY($1::varchar[])`,
    [targetPostIds]
  );
  const backupSnapshotId = `snap_reset_${Date.now()}`;
  await logOperationalActionInDb({
    action: 'TEST_RESET_BACKUP',
    message: `Backup automático pré-reset de ${snapshotData.rows.length} registros por ${adminUser}`,
    payload: { backupSnapshotId, records: snapshotData.rows },
  }).catch(() => {});

  // Executa o reset completo e unificado: reseta postagens canceladas, agendadas, postadas, reprovadas ou com erro de volta para "Pendente"
  const resetRes = await dbQuery(
    `
    UPDATE posts
    SET status = 'PENDENTE',
        published_at = NULL,
        instagram_media_id = NULL,
        instagram_container_id = NULL,
        child_container_ids = '[]'::jsonb,
        instagram_permalink = NULL,
        publish_attempts = 0,
        last_attempt_at = NULL,
        next_retry_at = NULL,
        failure_reason = NULL,
        publish_lock = NULL,
        approved_at = NULL,
        approved_by = NULL,
        is_approved_for_schedule = FALSE,
        caption_approved = FALSE,
        is_archived_test = FALSE,
        rejection_feedback = NULL,
        updated_at = NOW()
    WHERE id = ANY($1::varchar[])
    `,
    [targetPostIds]
  );

  await dbQuery(
    `
    UPDATE media_assets
    SET status = 'PENDENTE',
        rejection_feedback = NULL,
        updated_at = NOW()
    WHERE drive_file_id IN (SELECT drive_file_id FROM post_media WHERE post_id = ANY($1::varchar[]))
    `,
    [targetPostIds]
  ).catch(() => {});

  await dbQuery(
    `DELETE FROM schedules WHERE post_id = ANY($1::varchar[])`,
    [targetPostIds]
  ).catch(() => {});

  // Limpa empresas órfãs que não possuem postagens ou contas conectadas
  await deleteOrphanCompaniesInDb().catch(() => {});

  const affectedCount = resetRes.rowCount || targetPostIds.length;

  return {
    success: true,
    message: `${affectedCount} postagem(ns) foram totalmente resetadas para o estado inicial "Pendente" limpo (agendamentos, envios, cancelamentos e erros limpos). Backup de segurança salvo: ${backupSnapshotId}.`,
    affectedCount,
    backupSnapshotId,
  };
}

export async function deleteOrphanCompaniesInDb(): Promise<number> {
  try {
    const res = await dbQuery<any>(
      `
      DELETE FROM companies
      WHERE LOWER(name) NOT IN ('ato', 'ato.vc', 'ato social midia')
        AND id NOT IN (SELECT DISTINCT company_id FROM posts WHERE company_id IS NOT NULL)
        AND LOWER(drive_folder_name) NOT IN (SELECT DISTINCT LOWER(drive_folder_name) FROM posts WHERE drive_folder_name IS NOT NULL)
        AND LOWER(drive_folder_name) NOT IN (SELECT DISTINCT LOWER(pasta_cliente_nome) FROM posts WHERE pasta_cliente_nome IS NOT NULL)
        AND id NOT IN (SELECT DISTINCT company_id FROM instagram_accounts WHERE company_id IS NOT NULL)
        AND LOWER(drive_folder_name) NOT IN (SELECT DISTINCT LOWER(drive_folder_name) FROM instagram_accounts WHERE drive_folder_name IS NOT NULL)
        AND id NOT IN (SELECT DISTINCT company_id FROM users WHERE company_id IS NOT NULL)
      `
    );
    return res.rowCount || 0;
  } catch (err: any) {
    console.warn('[Orphan Companies Cleanup] Aviso ao remover empresas órfãs:', err?.message);
    return 0;
  }
}

// ============================================================================
// 11. MODULE: CLIENT OBSERVATIONS & CREATIVE MEMORY
// ============================================================================

export async function resolveCompanyRecordForSession(params: {
  userId?: string | null;
  tenantId?: string | null;
  instagramUsername?: string | null;
  driveFolderName?: string | null;
  companyIdInput?: string | null;
}): Promise<CompanyBrandProfile> {
  const { userId, tenantId, instagramUsername, driveFolderName, companyIdInput } = params;

  // 1. Direct match if companyIdInput or driveFolderName refers to an existing company
  if (companyIdInput) {
    const matched = await getCompanyByIdOrFolder(companyIdInput);
    if (matched) return matched;
  }
  if (driveFolderName) {
    const matched = await getCompanyByIdOrFolder(driveFolderName);
    if (matched) return matched;
  }

  // 2. Check instagram_accounts table for company_id or drive_folder_name
  if (tenantId || instagramUsername) {
    const igAccount = await getInstagramAccountByIdOrUser(tenantId || instagramUsername);
    if (igAccount) {
      if (igAccount.companyId) {
        const matched = await getCompanyByIdOrFolder(igAccount.companyId);
        if (matched) return matched;
      }
      if (igAccount.driveFolderName) {
        const matched = await getCompanyByIdOrFolder(igAccount.driveFolderName);
        if (matched) return matched;
      }
    }
  }

  // 3. Check users table for company_id
  if (userId) {
    try {
      const userRes = await dbQuery<{ company_id: string }>(
        `SELECT company_id FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      if (userRes.rows[0]?.company_id) {
        const matched = await getCompanyByIdOrFolder(userRes.rows[0].company_id);
        if (matched) return matched;
      }
    } catch {}
  }

  // 4. Fallback: Determine company name to create or upsert
  const rawName = (
    driveFolderName ||
    companyIdInput ||
    instagramUsername ||
    'Ato'
  ).trim();
  const cleanName = rawName.toLowerCase() === 'ato.vc' ? 'Ato' : rawName;

  // Use upsertCompany to create or retrieve the company record cleanly in PostgreSQL
  const company = await upsertCompany({
    name: cleanName,
    driveFolderName: cleanName,
  });

  // Link the company to instagram_accounts / users if applicable
  if (tenantId || instagramUsername) {
    const cleanUser = (instagramUsername || tenantId || '').replace(/^@/, '').trim();
    await dbQuery(
      `UPDATE instagram_accounts SET company_id = $1 WHERE id = $2 OR LOWER(username) = LOWER($3)`,
      [company.id, tenantId || '', cleanUser]
    ).catch(() => {});
  }
  if (userId) {
    await dbQuery(
      `UPDATE users SET company_id = $1 WHERE id = $2`,
      [company.id, userId]
    ).catch(() => {});
  }

  return company;
}

export async function listClientObservationsFromDb(params: {
  companyId?: string | null;
  tenantId?: string | null;
  includeInactive?: boolean;
}): Promise<ClientObservation[]> {
  // Purge test script record if exists
  await dbQuery(
    `DELETE FROM client_observations WHERE LOWER(author_name) LIKE '%test script%' OR LOWER(content) LIKE '%teste de integração%'`
  ).catch(() => {});

  const { companyId, tenantId, includeInactive = false } = params;
  let query = `
    SELECT id, company_id, tenant_id, user_id, author_name, content, type, is_active,
           sync_status, last_synced_at, created_at, updated_at
    FROM client_observations
    WHERE LOWER(author_name) NOT LIKE '%test script%'
      AND LOWER(content) NOT LIKE '%teste de integração%'
  `;
  const values: any[] = [];

  if (companyId) {
    values.push(companyId);
    query += ` AND company_id = $${values.length}`;
  } else if (tenantId) {
    values.push(tenantId);
    query += ` AND (tenant_id = $${values.length} OR company_id = $${values.length})`;
  }

  if (!includeInactive) {
    query += ` AND is_active = TRUE`;
  }

  query += ` ORDER BY created_at DESC`;

  const res = await dbQuery<any>(query, values);
  return res.rows.map((r) => ({
    id: r.id,
    companyId: r.company_id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    authorName: r.author_name,
    content: r.content,
    type: r.type,
    isActive: Boolean(r.is_active),
    syncStatus: r.sync_status,
    lastSyncedAt: toIsoOrUndefined(r.last_synced_at) || null,
    createdAt: toIsoOrUndefined(r.created_at) || new Date().toISOString(),
    updatedAt: toIsoOrUndefined(r.updated_at) || new Date().toISOString(),
    // Frontend compatibility properties:
    is_active: Boolean(r.is_active),
    sync_status: r.sync_status,
    author_name: r.author_name,
    company_id: r.company_id,
  }));
}

export async function createClientObservationInDb(
  obs: Omit<ClientObservation, 'createdAt' | 'updatedAt'>
): Promise<ClientObservation> {
  const nowIso = new Date().toISOString();
  const obsId =
    obs.id && String(obs.id).trim()
      ? String(obs.id).trim()
      : `obs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  await dbQuery(
    `
    INSERT INTO client_observations (
      id, company_id, tenant_id, user_id, author_name, content, type, is_active, sync_status, last_synced_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
    )
    `,
    [
      obsId,
      obs.companyId,
      obs.tenantId || null,
      obs.userId,
      obs.authorName || null,
      obs.content,
      obs.type || 'PONTUAL',
      obs.isActive !== false,
      obs.syncStatus || 'PENDING',
      obs.lastSyncedAt || null,
      nowIso,
      nowIso,
    ]
  );

  return {
    ...obs,
    id: obsId,
    createdAt: nowIso,
    updatedAt: nowIso,
    // Frontend compatibility properties:
    is_active: obs.isActive !== false,
    sync_status: obs.syncStatus || 'PENDING',
    author_name: obs.authorName || null,
    company_id: obs.companyId,
  };
}

export async function getNextObservationVersionForCompany(companyIdOrFolder: string): Promise<number> {
  const company = await getCompanyByIdOrFolder(companyIdOrFolder);
  if (!company) return 1;
  try {
    const res = await dbQuery<{ observation_version: number }>(
      `
      UPDATE companies
      SET observation_version = COALESCE(observation_version, 0) + 1, updated_at = NOW()
      WHERE id = $1
      RETURNING observation_version
      `,
      [company.id]
    );
    return res.rows[0]?.observation_version || 1;
  } catch {
    return 1;
  }
}

export async function updateClientObservationInDb(
  id: string,
  updates: Partial<ClientObservation>,
  requestingUserId: string,
  isAdmin: boolean = false
): Promise<ClientObservation | null> {
  const checkRes = await dbQuery<any>(`SELECT * FROM client_observations WHERE id = $1 LIMIT 1`, [id]);
  if (checkRes.rows.length === 0) return null;

  const row = checkRes.rows[0];
  if (!isAdmin && row.user_id !== requestingUserId) {
    throw new Error('Acesso negado: você só pode editar ou desativar suas próprias observações.');
  }

  const nowIso = new Date().toISOString();
  const newContent = updates.content !== undefined ? String(updates.content).trim() : row.content;
  const newType = updates.type !== undefined ? updates.type : row.type;
  const newIsActive = updates.isActive !== undefined ? updates.isActive : row.is_active;
  const newSyncStatus = updates.syncStatus !== undefined ? updates.syncStatus : 'PENDING';

  await dbQuery(
    `
    UPDATE client_observations
    SET content = $1, type = $2, is_active = $3, sync_status = $4, updated_at = $5
    WHERE id = $6
    `,
    [newContent, newType, newIsActive, newSyncStatus, nowIso, id]
  );

  return {
    id: row.id,
    companyId: row.company_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    authorName: row.author_name,
    content: newContent,
    type: newType,
    isActive: Boolean(newIsActive),
    syncStatus: newSyncStatus,
    lastSyncedAt: toIsoOrUndefined(row.last_synced_at) || null,
    createdAt: toIsoOrUndefined(row.created_at) || new Date().toISOString(),
    updatedAt: nowIso,
    // Frontend compatibility properties:
    is_active: Boolean(newIsActive),
    sync_status: newSyncStatus,
    author_name: row.author_name,
    company_id: row.company_id,
  };
}

export async function updateClientObservationSyncStatusInDb(
  id: string,
  syncStatus: 'PENDING' | 'SYNCED' | 'FAILED',
  lastSyncedAt?: string
): Promise<void> {
  const syncedAt = lastSyncedAt || (syncStatus === 'SYNCED' ? new Date().toISOString() : null);
  await dbQuery(
    `
    UPDATE client_observations
    SET sync_status = $1, last_synced_at = COALESCE($2, last_synced_at), updated_at = NOW()
    WHERE id = $3
    `,
    [syncStatus, syncedAt, id]
  );
}

export async function generateClientObservationsMarkdown(companyIdOrFolder: string): Promise<{
  markdownContent: string;
  activeCount: number;
  companyName: string;
  driveFolderId?: string;
  driveFolderName: string;
}> {
  let company = await getCompanyByIdOrFolder(companyIdOrFolder);
  let companyName = company?.name || companyIdOrFolder;
  let driveFolderName = company?.driveFolderName || companyName;
  let companyId = company?.id || companyIdOrFolder;

  const obsList = await listClientObservationsFromDb({
    companyId,
    includeInactive: false,
  });

  const permanents = obsList.filter((o) => o.type === 'PERMANENTE');
  const pontuals = obsList.filter((o) => o.type === 'PONTUAL');

  const nowSp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  let md = `# ORIENTAÇÕES E OBSERVAÇÕES DO CLIENTE\n\n`;
  md += `**Empresa:** ${companyName}\n`;
  md += `**Última Atualização:** ${nowSp} (BRT -03:00)\n\n`;
  md += `> Este arquivo é mantido automaticamente pelo ATO Social Hub a partir dos feedbacks e direcionamentos fornecidos pelo cliente.\n\n`;

  md += `---\n\n`;
  md += `## 📌 DIRETRIZES PERMANENTES DA MARCA\n`;
  if (permanents.length === 0) {
    md += `*Nenhuma diretriz permanente registrada no momento.*\n`;
  } else {
    for (const p of permanents) {
      const author = p.authorName ? ` (por ${p.authorName})` : '';
      const dateStr = new Date(p.createdAt).toLocaleDateString('pt-BR');
      md += `- **[${dateStr}]** ${p.content}${author}\n`;
    }
  }

  md += `\n---\n\n`;
  md += `## 🎯 SUGESTÕES PONTUAIS PARA AS PRÓXIMAS CRIAÇÕES\n`;
  if (pontuals.length === 0) {
    md += `*Nenhuma sugestão pontual registrada para as próximas artes.*\n`;
  } else {
    for (const pt of pontuals) {
      const author = pt.authorName ? ` (por ${pt.authorName})` : '';
      const dateStr = new Date(pt.createdAt).toLocaleDateString('pt-BR');
      md += `- **[${dateStr}]** ${pt.content}${author}\n`;
    }
  }

  md += `\n\n---\n*Gerado automaticamente pelo ATO Social Hub. Fonte da verdade: PostgreSQL.*`;

  return {
    markdownContent: md,
    activeCount: obsList.length,
    companyName,
    driveFolderId: company?.driveFolderId || undefined,
    driveFolderName,
  };
}

export async function getConsolidatedCreativeContextForCompany(
  companyIdOrFolder: string
): Promise<{
  companyName: string;
  observations: ClientObservation[];
  rejectionMemory: Array<{ originalFilename: string; motivo: string; tags: string[]; dataReprovacao: string }>;
  formattedPromptContext: string;
}> {
  let company = await getCompanyByIdOrFolder(companyIdOrFolder);
  let companyName = company?.name || companyIdOrFolder;
  let companyId = company?.id || companyIdOrFolder;

  const observations = await listClientObservationsFromDb({
    companyId,
    includeInactive: false,
  });

  let rejectionMemory: Array<{ originalFilename: string; motivo: string; tags: string[]; dataReprovacao: string }> = [];
  try {
    const rejectionsRes = await dbQuery<any>(
      `
      SELECT original_filename, novo_nome_arquivo, motivo, tags, data_reprovacao
      FROM rejections
      WHERE pasta_nome = $1 OR pasta_cliente_id = $1 OR post_id IN (SELECT id FROM posts WHERE company_id = $2)
      ORDER BY data_reprovacao DESC
      LIMIT 15
      `,
      [companyName, companyId]
    );

    rejectionMemory = rejectionsRes.rows.map((r) => ({
      originalFilename: r.original_filename || r.novo_nome_arquivo,
      motivo: r.motivo,
      tags: Array.isArray(r.tags) ? r.tags : [],
      dataReprovacao: toIsoOrUndefined(r.data_reprovacao) || new Date().toISOString(),
    }));
  } catch (err) {
    console.warn('[Creative Context] Aviso ao buscar memória de reprovações:', err);
  }

  let promptText = `=== MEMÓRIA CRIATIVA INTELIGENTE DA EMPRESA: ${companyName} ===\n\n`;

  const permanents = observations.filter((o) => o.type === 'PERMANENTE');
  const pontuals = observations.filter((o) => o.type === 'PONTUAL');

  if (permanents.length > 0) {
    promptText += `[DIRETRIZES PERMANENTES E REGRAS DE MARCA DO CLIENTE]:\n`;
    permanents.forEach((p, idx) => {
      promptText += `${idx + 1}. ${p.content}\n`;
    });
    promptText += `\n`;
  }

  if (pontuals.length > 0) {
    promptText += `[ORIENTAÇÕES E SUGESTÕES PONTUAIS PARA AS PRÓXIMAS ARTES]:\n`;
    pontuals.forEach((p, idx) => {
      promptText += `${idx + 1}. ${p.content}\n`;
    });
    promptText += `\n`;
  }

  if (rejectionMemory.length > 0) {
    promptText += `[MEMÓRIA DE REPROVAÇÕES PASSADAS - O QUE NUNCA REPETIR]:\n`;
    rejectionMemory.forEach((r, idx) => {
      const tagsStr = r.tags.length > 0 ? ` (Tags: ${r.tags.join(', ')})` : '';
      promptText += `${idx + 1}. Arquivo: "${r.originalFilename}" -> Motivo da Rejeição: "${r.motivo}"${tagsStr}\n`;
    });
    promptText += `\n`;
  }

  if (observations.length === 0 && rejectionMemory.length === 0) {
    promptText += `Nenhuma observação ou histórico de reprovação registrado no momento para este cliente.\n`;
  }

  return {
    companyName,
    observations,
    rejectionMemory,
    formattedPromptContext: promptText.trim(),
  };
}
