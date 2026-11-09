import crypto from 'crypto';
import {
  AdminAlertNotification,
  ConnectionStatus,
  PostGroup,
  PublishAttemptRecord,
  TenantAccount,
} from '../types/index.ts';

// Login do Instagram (legado, conta pessoal/app antigo): host graph.instagram.com
export const IG_GRAPH_API_VERSION = 'v21.0';
export const IG_GRAPH_BASE_URL = 'https://graph.instagram.com';
// Login unificado (Facebook Login for Business + config_id): host graph.facebook.com
export const IG_UNIFIED_GRAPH_API_VERSION = 'v27.0';
export const IG_UNIFIED_GRAPH_BASE_URL = 'https://graph.facebook.com';
export const UNIFIED_TOKEN_TYPE = 'UNIFIED_BISU';
export type IgLoginMode = 'instagram_login' | 'unified';

/** Base da Graph API conforme o fluxo de login que emitiu o token da conta. */
export function igGraphBase(mode?: IgLoginMode): string {
  return mode === 'unified'
    ? `${IG_UNIFIED_GRAPH_BASE_URL}/${IG_UNIFIED_GRAPH_API_VERSION}`
    : IG_GRAPH_BASE_URL;
}

/** Contas do login unificado são marcadas com tokenType = UNIFIED_BISU; as antigas continuam como LONG_LIVED. */
export function loginModeForTenant(tenant?: { tokenType?: string } | null): IgLoginMode {
  return tenant?.tokenType === UNIFIED_TOKEN_TYPE ? 'unified' : 'instagram_login';
}
export const IG_OAUTH_DIALOG_URL = 'https://www.facebook.com/dialog/oauth';
export const DEFAULT_IG_LOGIN_CONFIG_ID = '1775718873720654';

export function getInstagramLoginConfigId(): string {
  return String(process.env.INSTAGRAM_CONFIG_ID || '').trim() || DEFAULT_IG_LOGIN_CONFIG_ID;
}

/**
 * Troca o `code` do login unificado por token de usuário de sistema (BISU).
 * GET https://graph.facebook.com/v27.0/oauth/access_token?client_id&client_secret&redirect_uri&code
 */
export async function exchangeUnifiedLoginCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ ok: boolean; accessToken: string; expiresInSeconds: number; raw: any; status: number }> {
  const fetchFn = getInstagramFetch();
  const query = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
  });
  const resp = await fetchFn(
    `${IG_UNIFIED_GRAPH_BASE_URL}/${IG_UNIFIED_GRAPH_API_VERSION}/oauth/access_token?${query.toString()}`,
    { method: 'GET' }
  );
  const raw = await resp.json().catch(() => ({}));
  const token = typeof raw?.access_token === 'string' ? raw.access_token.trim() : '';
  return {
    ok: resp.ok && Boolean(token),
    accessToken: token,
    expiresInSeconds:
      typeof raw?.expires_in === 'number' && raw.expires_in > 0
        ? raw.expires_in
        : DEFAULT_LONG_LIVED_EXPIRES_IN_SEC,
    raw,
    status: resp.status,
  };
}

/**
 * Lista as contas profissionais do Instagram atribuídas ao token (sem depender de Página do Facebook).
 * GET https://graph.facebook.com/v27.0/me/assigned_instagram_accounts?fields=id,username
 */
export async function fetchAssignedInstagramAccounts(accessToken: string): Promise<{
  ok: boolean;
  status: number;
  accounts: Array<{ id: string; username: string }>;
  raw: any;
}> {
  const fetchFn = getInstagramFetch();
  const query = new URLSearchParams({ fields: 'id,username', access_token: accessToken });
  const resp = await fetchFn(
    `${IG_UNIFIED_GRAPH_BASE_URL}/${IG_UNIFIED_GRAPH_API_VERSION}/me/assigned_instagram_accounts?${query.toString()}`,
    { method: 'GET' }
  );
  const raw = await resp.json().catch(() => ({}));
  const accounts = Array.isArray(raw?.data)
    ? raw.data
        .filter((a: any) => a && a.id)
        .map((a: any) => ({ id: String(a.id), username: String(a.username || '') }))
    : [];
  return { ok: resp.ok && !raw?.error, status: resp.status, accounts, raw };
}
export const REQUIRED_IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
];

const ENCRYPTION_PREFIX = 'enc:v1:';
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
const DEFAULT_LONG_LIVED_EXPIRES_IN_SEC = 60 * 24 * 60 * 60; // 60 days (5184000s)

// In-memory per-account concurrency locks for token refresh and post publishing
const inFlightTokenRefreshes = new Set<string>();
const inFlightPostPublishes = new Set<string>();

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let customFetchOverride: FetchLike | null = null;

export function setInstagramFetchOverride(fn: FetchLike | null) {
  customFetchOverride = fn;
}

export function getInstagramFetch(): FetchLike {
  return customFetchOverride || globalThis.fetch.bind(globalThis);
}

function deriveEncryptionKey(secret: string): Buffer {
  const safeSecret = secret || 'ato_default_encryption_secret_2026';
  return crypto.scryptSync(safeSecret, 'ato_instagram_token_salt_v1', 32);
}

/**
 * Encrypts an Instagram access token using AES-256-GCM.
 * Never logs or exposes plaintext tokens.
 */
export function encryptInstagramToken(plainToken: string, secretKey: string): string {
  const clean = String(plainToken || '').trim();
  if (!clean) return '';
  if (clean.startsWith(ENCRYPTION_PREFIX)) return clean;

  const key = deriveEncryptionKey(secretKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(clean, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted Instagram access token.
 * Transparently handles legacy plaintext tokens so they can be migrated on load/save.
 */
export function decryptInstagramToken(storedToken: string | undefined | null, secretKey: string): string {
  const raw = String(storedToken || '').trim();
  if (!raw) return '';
  if (!raw.startsWith(ENCRYPTION_PREFIX)) {
    return raw;
  }

  try {
    const payload = raw.slice(ENCRYPTION_PREFIX.length);
    const [ivHex, authTagHex, cipherHex] = payload.split(':');
    if (!ivHex || !authTagHex || !cipherHex) return '';

    const key = deriveEncryptionKey(secretKey);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(cipherHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Resolves the plaintext access token for a tenant account, trying TOKEN_ENCRYPTION_KEY first
 * and falling back to the provided secretKey / JWT_SECRET for transparent key rotation.
 */
export function resolveAccountAccessToken(
  tenant: TenantAccount | undefined | null,
  secretKey?: string
): string {
  if (!tenant) return '';

  const candidateKeys = Array.from(
    new Set(
      [
        String(process.env.TOKEN_ENCRYPTION_KEY || '').trim(),
        String(secretKey || '').trim(),
        String(process.env.JWT_SECRET || '').trim(),
        'ato_super_secret_key_2026_998877',
      ].filter((k) => Boolean(k && !k.includes('<CHAVE_DE_CRIPTOGRAFIA>')))
    )
  );

  const rawStored = tenant.encryptedAccessToken || tenant.accessToken || tenant.access_token || '';
  if (!rawStored) return '';

  if (!rawStored.startsWith(ENCRYPTION_PREFIX)) {
    return rawStored.trim();
  }

  for (const key of candidateKeys) {
    const dec = decryptInstagramToken(rawStored, key);
    if (dec) return dec;
  }

  return '';
}

/**
 * Evaluates whether a tenant's token is currently expired based on tokenExpiresAt.
 */
export function isAccountTokenExpired(tenant: TenantAccount, nowMs: number = Date.now()): boolean {
  if (!tenant.tokenExpiresAt) return false;
  const expMs = Date.parse(tenant.tokenExpiresAt);
  if (isNaN(expMs)) return false;
  return expMs <= nowMs;
}

/**
 * Checks whether the tenant has granted both required scopes:
 * instagram_business_basic and instagram_business_content_publish
 */
export function hasRequiredInstagramScopes(scopes?: string[]): {
  valid: boolean;
  missingScopes: string[];
} {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    // If scopes array wasn't explicitly populated on a legacy record, treat as valid unless explicitly incomplete
    return { valid: true, missingScopes: [] };
  }
  const normalized = new Set(scopes.map((s) => String(s).trim().toLowerCase()));
  const missing = REQUIRED_IG_SCOPES.filter((reqScope) => !normalized.has(reqScope));
  return {
    valid: missing.length === 0,
    missingScopes: missing,
  };
}

/**
 * Normalizes a TenantAccount in-place so plaintext tokens are encrypted at rest
 * and connectionStatus / token metadata are consistent.
 */
export function normalizeAndEncryptTenantToken(tenant: TenantAccount, secretKey: string): TenantAccount {
  const plain = resolveAccountAccessToken(tenant, secretKey);
  const nowIso = new Date().toISOString();

  if (plain) {
    tenant.encryptedAccessToken = encryptInstagramToken(plain, secretKey);
    delete tenant.accessToken;
    delete tenant.access_token;

    if (!tenant.tokenIssuedAt) {
      tenant.tokenIssuedAt = tenant.lastSyncAt || tenant.requestedAt || nowIso;
    }
    if (!tenant.tokenExpiresAt) {
      const issuedMs = Date.parse(tenant.tokenIssuedAt) || Date.now();
      tenant.tokenExpiresAt = new Date(
        issuedMs + DEFAULT_LONG_LIVED_EXPIRES_IN_SEC * 1000
      ).toISOString();
    }
    if (!Array.isArray(tenant.grantedScopes) || tenant.grantedScopes.length === 0) {
      tenant.grantedScopes = [...REQUIRED_IG_SCOPES];
    }

    const scopeCheck = hasRequiredInstagramScopes(tenant.grantedScopes);
    if (!scopeCheck.valid) {
      tenant.connectionStatus = 'ESCOPOS_INSUFICIENTES';
    } else if (isAccountTokenExpired(tenant)) {
      tenant.connectionStatus = 'RECONEXAO_NECESSARIA';
    } else if (!tenant.connectionStatus) {
      tenant.connectionStatus = 'CONECTADO';
    }
    tenant.hasValidToken = tenant.connectionStatus === 'CONECTADO';
  } else {
    delete tenant.accessToken;
    delete tenant.access_token;
    tenant.hasValidToken = false;
    if (!tenant.connectionStatus) {
      tenant.connectionStatus = 'RECONEXAO_NECESSARIA';
    }
  }

  return tenant;
}

export const IG_USER_MSG_PERSONAL_ACCOUNT =
  'Para conectar e publicar conteúdos, utilize uma conta profissional do Instagram.';
export const IG_USER_MSG_PERMISSION_RESTRICTED =
  'Não foi possível autorizar esta conta do Instagram. A integração ainda precisa de liberação para essa conta.';
export const IG_USER_MSG_TEMPORARY_ERROR =
  'Não foi possível concluir a conexão. Tente novamente.';

/**
 * Returns a safe copy of TenantAccount without any plaintext or encrypted token strings
 * for API responses to the frontend.
 */
export function sanitizeTenantForClient(tenant: TenantAccount, secretKey: string): TenantAccount {
  const plain = resolveAccountAccessToken(tenant, secretKey);
  const expired = isAccountTokenExpired(tenant);
  const scopeCheck = hasRequiredInstagramScopes(tenant.grantedScopes);

  let effectiveConnStatus: ConnectionStatus =
    tenant.connectionStatus || (plain ? 'CONECTADO' : 'RECONEXAO_NECESSARIA');

  if (!plain) {
    effectiveConnStatus =
      tenant.connectionStatus === 'DESCONECTADO' ? 'DESCONECTADO' : 'RECONEXAO_NECESSARIA';
  } else if (expired) {
    effectiveConnStatus = 'RECONEXAO_NECESSARIA';
  } else if (!scopeCheck.valid) {
    effectiveConnStatus = 'ESCOPOS_INSUFICIENTES';
  }

  const { accessToken: _a, access_token: _b, encryptedAccessToken: _c, ...safeRest } = tenant;
  return {
    ...safeRest,
    connectionStatus: effectiveConnStatus,
    hasValidToken: Boolean(plain && !expired && effectiveConnStatus === 'CONECTADO'),
    grantedScopes: tenant.grantedScopes || (plain ? [...REQUIRED_IG_SCOPES] : []),
  };
}

/**
 * Exchanges a short-lived Instagram token for a 60-day long-lived token:
 * GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=...&access_token=...
 */
export async function exchangeShortForLongLivedInstagramToken(params: {
  shortLivedToken: string;
  clientSecret: string;
  nowMs?: number;
}): Promise<{
  ok: boolean;
  accessToken: string;
  tokenType: string;
  expiresInSeconds: number;
  tokenIssuedAt: string;
  tokenExpiresAt: string;
  errorMessage?: string;
}> {
  const fetchFn = getInstagramFetch();
  const now = params.nowMs ?? Date.now();
  const issuedIso = new Date(now).toISOString();

  try {
    const query = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: params.clientSecret,
      access_token: params.shortLivedToken,
    });

    const resp = await fetchFn(`https://graph.instagram.com/access_token?${query.toString()}`, {
      method: 'GET',
    });

    const data = await resp.json().catch(() => ({}));
    if (
      resp.ok &&
      data &&
      typeof data.access_token === 'string' &&
      data.access_token.trim() !== ''
    ) {
      const expiresIn =
        typeof data.expires_in === 'number' && data.expires_in > 0
          ? data.expires_in
          : DEFAULT_LONG_LIVED_EXPIRES_IN_SEC;
      return {
        ok: true,
        accessToken: data.access_token.trim(),
        tokenType: 'LONG_LIVED',
        expiresInSeconds: expiresIn,
        tokenIssuedAt: issuedIso,
        tokenExpiresAt: new Date(now + expiresIn * 1000).toISOString(),
      };
    }

    const errMsg =
      data?.error?.message ||
      data?.error_message ||
      `HTTP ${resp.status} ao converter para token de longa duração`;
    return {
      ok: false,
      accessToken: params.shortLivedToken,
      tokenType: 'SHORT_LIVED',
      expiresInSeconds: 3600,
      tokenIssuedAt: issuedIso,
      tokenExpiresAt: new Date(now + 3600 * 1000).toISOString(),
      errorMessage: errMsg,
    };
  } catch (err: any) {
    return {
      ok: false,
      accessToken: params.shortLivedToken,
      tokenType: 'SHORT_LIVED',
      expiresInSeconds: 3600,
      tokenIssuedAt: issuedIso,
      tokenExpiresAt: new Date(now + 3600 * 1000).toISOString(),
      errorMessage: err?.message || 'Falha de rede na troca por token longo',
    };
  }
}

/**
 * Renews a long-lived Instagram token via:
 * GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=...
 *
 * Enforces:
 * - Never attempts to refresh an already-expired token.
 * - Requires token to be at least 24 hours old (when remaining validity > 30 days).
 * - Preventively renews tokens when 30 days or less remain before expiration (remainingMs <= 30 days)
 *   or when >= 30 days have elapsed since issue/refresh, or when forceIfEligible24h is true.
 * - Performs controlled retries on temporary network/5xx/429 errors without losing the current valid token.
 * - Prevents concurrent refreshes of the same account.
 * - Never overwrites a valid token if the refresh call fails.
 */
export async function refreshAccountLongLivedToken(params: {
  tenant: TenantAccount;
  secretKey: string;
  forceIfEligible24h?: boolean;
  nowMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  onPersist: () => void;
  onAdminAlert: (alert: Omit<AdminAlertNotification, 'id' | 'createdAt' | 'resolved'>) => void;
}): Promise<{
  status:
    | 'REFRESHED'
    | 'SKIPPED_NOT_DUE'
    | 'SKIPPED_TOO_YOUNG_24H'
    | 'SKIPPED_LOCKED'
    | 'EXPIRED_RECONNECT_REQUIRED'
    | 'REVOKED_RECONNECT_REQUIRED'
    | 'TRANSIENT_FAILURE_KEPT_VALID_TOKEN'
    | 'MISSING_TOKEN';
  message: string;
  tokenExpiresAt?: string;
  attemptsUsed?: number;
}> {
  // Tokens do login unificado não são renovados por ig_refresh_token (endpoint do Instagram Login antigo).
  if (loginModeForTenant(params.tenant) === 'unified') {
    return {
      status: 'SKIPPED_NOT_DUE',
      message:
        'Conta do login unificado: a renovação por ig_refresh_token não se aplica. Reconecte a conta quando o token expirar.',
    };
  }
  const {
    tenant,
    secretKey,
    forceIfEligible24h = false,
    maxRetries = 3,
    retryDelayMs = 50,
    onPersist,
    onAdminAlert,
  } = params;
  const now = params.nowMs ?? Date.now();
  const nowIso = new Date(now).toISOString();

  if (inFlightTokenRefreshes.has(tenant.id)) {
    return {
      status: 'SKIPPED_LOCKED',
      message: `Renovação já em andamento para @${tenant.username}.`,
    };
  }

  const currentToken = resolveAccountAccessToken(tenant, secretKey);
  if (!currentToken) {
    tenant.connectionStatus = 'RECONEXAO_NECESSARIA';
    tenant.reconnectionRequiredAt = tenant.reconnectionRequiredAt || nowIso;
    tenant.lastConnectionError = 'Token de acesso ausente. Reconexão necessária.';
    onPersist();
    onAdminAlert({
      type: 'RECONEXAO_NECESSARIA',
      tenantId: tenant.id,
      username: tenant.username,
      message: `A conta @${tenant.username} não possui token válido e precisa ser reconectada.`,
    });
    return {
      status: 'MISSING_TOKEN',
      message: `Conta @${tenant.username} sem token válido. Marcada como RECONEXAO_NECESSARIA.`,
    };
  }

  // 1. Never attempt to refresh an already-expired token as if it were valid
  if (isAccountTokenExpired(tenant, now)) {
    tenant.connectionStatus = 'RECONEXAO_NECESSARIA';
    tenant.reconnectionRequiredAt = nowIso;
    tenant.lastConnectionError = 'O token de longa duração expirou. Reconecte a conta do Instagram.';
    onPersist();
    onAdminAlert({
      type: 'RECONEXAO_NECESSARIA',
      tenantId: tenant.id,
      username: tenant.username,
      message: `O token da conta @${tenant.username} expirou em ${tenant.tokenExpiresAt}. Reconexão necessária.`,
    });
    return {
      status: 'EXPIRED_RECONNECT_REQUIRED',
      message: `Token de @${tenant.username} já expirado. Conta marcada como RECONEXAO_NECESSARIA.`,
    };
  }

  // 2. Evaluate token age and remaining validity window (<= 30 days to expire)
  const expMs = tenant.tokenExpiresAt ? Date.parse(tenant.tokenExpiresAt) : 0;
  const remainingMs = expMs > 0 ? expMs - now : THIRTY_DAYS_MS;
  const isExpiringWithin30Days = expMs > 0 && remainingMs <= THIRTY_DAYS_MS;

  const lastIssuedOrRefreshedMs =
    Date.parse(tenant.lastTokenRefreshAt || tenant.tokenIssuedAt || '') || 0;
  const tokenAgeMs = lastIssuedOrRefreshedMs > 0 ? now - lastIssuedOrRefreshedMs : THIRTY_DAYS_MS + 1;

  // Minimum 24-hour age requirement (unless the token already has <= 30 days remaining in its 60-day window)
  if (tokenAgeMs < TWENTY_FOUR_HOURS_MS && !isExpiringWithin30Days) {
    return {
      status: 'SKIPPED_TOO_YOUNG_24H',
      message: `Token de @${tenant.username} possui menos de 24 horas de emissão/renovação.`,
      tokenExpiresAt: tenant.tokenExpiresAt,
    };
  }

  // 3. Preventive renewal check: <= 30 days until expiration OR >= 30 days since last issue/refresh
  const isDueForPreventiveRenewal =
    forceIfEligible24h || isExpiringWithin30Days || tokenAgeMs >= THIRTY_DAYS_MS;

  if (!isDueForPreventiveRenewal) {
    return {
      status: 'SKIPPED_NOT_DUE',
      message: `Token de @${tenant.username} está válido (mais de 30 dias restantes para expirar).`,
      tokenExpiresAt: tenant.tokenExpiresAt,
    };
  }

  inFlightTokenRefreshes.add(tenant.id);
  const totalMaxAttempts = Math.max(1, maxRetries);
  let attemptsUsed = 0;

  try {
    const fetchFn = getInstagramFetch();
    const query = new URLSearchParams({
      grant_type: 'ig_refresh_token',
      access_token: currentToken,
    });
    const refreshUrl = `https://graph.instagram.com/refresh_access_token?${query.toString()}`;

    for (let attempt = 1; attempt <= totalMaxAttempts; attempt++) {
      attemptsUsed = attempt;
      try {
        const resp = await fetchFn(refreshUrl, { method: 'GET' });
        const data = await resp.json().catch(() => ({}));

        if (
          resp.ok &&
          data &&
          typeof data.access_token === 'string' &&
          data.access_token.trim() !== ''
        ) {
          const expiresIn =
            typeof data.expires_in === 'number' && data.expires_in > 0
              ? data.expires_in
              : DEFAULT_LONG_LIVED_EXPIRES_IN_SEC;
          const newExpiresAt = new Date(now + expiresIn * 1000).toISOString();

          // Atomic update of encrypted token and validity timestamps
          tenant.encryptedAccessToken = encryptInstagramToken(data.access_token.trim(), secretKey);
          delete tenant.accessToken;
          delete tenant.access_token;
          tenant.tokenType = 'LONG_LIVED';
          tenant.lastTokenRefreshAt = nowIso;
          tenant.tokenIssuedAt = nowIso;
          tenant.tokenExpiresAt = newExpiresAt;
          tenant.connectionStatus = 'CONECTADO';
          tenant.lastConnectionError = null;
          tenant.reconnectionRequiredAt = null;
          tenant.hasValidToken = true;

          onPersist();
          return {
            status: 'REFRESHED',
            message: `Token de longa duração da conta @${tenant.username} renovado com sucesso (tentativa ${attempt}/${totalMaxAttempts}).`,
            tokenExpiresAt: newExpiresAt,
            attemptsUsed: attempt,
          };
        }

        const errCode = data?.error?.code;
        const errMsg =
          data?.error?.message ||
          data?.error_message ||
          `Falha HTTP ${resp.status} ao renovar token no Instagram`;

        if (
          errCode === 190 ||
          resp.status === 401 ||
          String(errMsg).toLowerCase().includes('session has expired') ||
          String(errMsg).toLowerCase().includes('invalid oauth access token')
        ) {
          tenant.connectionStatus = 'RECONEXAO_NECESSARIA';
          tenant.reconnectionRequiredAt = nowIso;
          tenant.lastConnectionError = `Erro 190 da Meta: Sessão expirada ou acesso revogado. Reconecte @${tenant.username}.`;
          tenant.hasValidToken = false;
          onPersist();

          onAdminAlert({
            type: 'RECONEXAO_NECESSARIA',
            tenantId: tenant.id,
            username: tenant.username,
            message: `A conta @${tenant.username} teve o token expirado ou revogado na Meta (Erro 190). Reconexão necessária.`,
          });

          return {
            status: 'REVOKED_RECONNECT_REQUIRED',
            message: `Token de @${tenant.username} revogado/expirado na Meta (Erro 190). Marcado como RECONEXAO_NECESSARIA.`,
            attemptsUsed: attempt,
          };
        }

        // Temporary error: retry with controlled backoff if attempts remain
        if (attempt < totalMaxAttempts && retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        }
      } catch {
        // Network error: retry with controlled backoff if attempts remain
        if (attempt < totalMaxAttempts && retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        }
      }
    }

    // Transient failure after controlled retries: DO NOT overwrite the existing valid token!
    return {
      status: 'TRANSIENT_FAILURE_KEPT_VALID_TOKEN',
      message: `Falha transitória após ${attemptsUsed} tentativa(s) ao renovar token de @${tenant.username}; o token válido atual foi preservado.`,
      tokenExpiresAt: tenant.tokenExpiresAt,
      attemptsUsed,
    };
  } finally {
    inFlightTokenRefreshes.delete(tenant.id);
  }
}

/**
 * Classifies Meta Graph API errors into Auth (190), Transient (retryable), or Permanent.
 */
export function classifyMetaError(httpStatus: number, metaError: any): {
  category: 'AUTH_ERROR_190' | 'TRANSIENT_ERROR' | 'PERMANENT_ERROR';
  code?: number;
  subcode?: number;
  message: string;
} {
  const errObj = metaError?.error || metaError || {};
  const code = typeof errObj.code === 'number' ? errObj.code : undefined;
  const subcode = typeof errObj.error_subcode === 'number' ? errObj.error_subcode : undefined;
  const message = String(
    errObj.error_user_msg ||
      errObj.message ||
      errObj.error_message ||
      `Erro HTTP ${httpStatus} na API do Instagram`
  );
  const msgLower = message.toLowerCase();

  // If Meta returns "Failed to decode", it is a formatting/transport issue, NOT a session expiration.
  // Never mark RECONEXAO_NECESSARIA for "Failed to decode"!
  if (msgLower.includes('failed to decode')) {
    return {
      category: 'PERMANENT_ERROR',
      code: code || 190,
      subcode,
      message: `Erro de decodificação na Meta (${message}). Verifique a integridade do token.`,
    };
  }

  if (
    code === 190 ||
    subcode === 458 ||
    subcode === 459 ||
    subcode === 460 ||
    subcode === 463 ||
    subcode === 467 ||
    msgLower.includes('session has expired') ||
    msgLower.includes('error validating access token') ||
    msgLower.includes('invalid oauth access token')
  ) {
    return { category: 'AUTH_ERROR_190', code: code || 190, subcode, message };
  }

  const isTransientFlag = Boolean(errObj.is_transient);
  const transientCodes = new Set([1, 2, 4, 17, 32, 613, 9007]);
  const transientSubcodes = new Set([2207027]);

  if (
    isTransientFlag ||
    httpStatus >= 500 ||
    httpStatus === 429 ||
    (code !== undefined && transientCodes.has(code)) ||
    (subcode !== undefined && transientSubcodes.has(subcode))
  ) {
    return { category: 'TRANSIENT_ERROR', code, subcode, message };
  }

  return { category: 'PERMANENT_ERROR', code, subcode, message };
}

/**
 * Polls container status on Instagram Graph API:
 * GET https://graph.instagram.com/v21.0/{container_id}?fields=status_code,status
 */
export async function waitForInstagramContainerReady(params: {
  loginMode?: IgLoginMode;
  containerId: string;
  accessToken: string;
  maxAttempts?: number;
  pollIntervalMs?: number;
}): Promise<{
  ready: boolean;
  statusCode: string;
  rawResponse?: any;
  errorMessage?: string;
}> {
  const fetchFn = getInstagramFetch();
  const maxAttempts = params.maxAttempts ?? 6;
  const pollIntervalMs = params.pollIntervalMs ?? 1500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const url = `${igGraphBase(params.loginMode)}/${encodeURIComponent(
      params.containerId
    )}?fields=status_code,status&access_token=${encodeURIComponent(params.accessToken)}`;

    const resp = await fetchFn(url, { method: 'GET' });
    const data = await resp.json().catch(() => ({}));

    if (!resp.ok || data?.error) {
      const errMsg = data?.error?.message || `HTTP ${resp.status} ao consultar status do contêiner`;
      return {
        ready: false,
        statusCode: 'ERROR',
        rawResponse: data,
        errorMessage: errMsg,
      };
    }

    const statusCode = String(data.status_code || 'FINISHED').toUpperCase();
    if (statusCode === 'FINISHED' || statusCode === 'PUBLISHED') {
      return {
        ready: true,
        statusCode,
        rawResponse: data,
      };
    }

    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      return {
        ready: false,
        statusCode,
        rawResponse: data,
        errorMessage: `O processamento do contêiner falhou na Meta com status_code=${statusCode} (${data.status || 'sem detalhes'}).`,
      };
    }

    // status_code === 'IN_PROGRESS'
    if (attempt < maxAttempts && pollIntervalMs > 0) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  return {
    ready: false,
    statusCode: 'IN_PROGRESS',
    errorMessage: 'O contêiner de mídia ainda está em processamento (IN_PROGRESS) na Meta.',
  };
}

/**
 * Reconciles ambiguous media_publish results by checking recent media on the Instagram account
 * before retrying publication, preventing duplicate posts.
 */
export async function reconcileInstagramPublishedMedia(params: {
  loginMode?: IgLoginMode;
  igUserId: string;
  accessToken: string;
  expectedCaption?: string;
  sinceTimestampMs: number;
}): Promise<{
  found: boolean;
  mediaId?: string;
  permalink?: string;
}> {
  const fetchFn = getInstagramFetch();
  try {
    const url = `${igGraphBase(params.loginMode)}/${encodeURIComponent(
      params.igUserId
    )}/media?fields=id,caption,permalink,timestamp&limit=5&access_token=${encodeURIComponent(
      params.accessToken
    )}`;
    const resp = await fetchFn(url, { method: 'GET' });
    if (!resp.ok) return { found: false };
    const data = await resp.json().catch(() => ({}));
    const list: any[] = Array.isArray(data?.data) ? data.data : [];

    const expectedClean = String(params.expectedCaption || '').trim();
    for (const item of list) {
      const itemTimeMs = item.timestamp ? Date.parse(item.timestamp) : 0;
      const isRecent = itemTimeMs >= params.sinceTimestampMs - 120_000;
      const itemCaption = String(item.caption || '').trim();
      if (isRecent && item.id && (!expectedClean || itemCaption === expectedClean)) {
        return {
          found: true,
          mediaId: String(item.id),
          permalink: item.permalink ? String(item.permalink) : undefined,
        };
      }
    }
    return { found: false };
  } catch {
    return { found: false };
  }
}

/**
 * Fetches permalink and metadata of a published Instagram media object:
 * GET https://graph.instagram.com/v21.0/{media_id}?fields=id,permalink,timestamp,media_type
 */
export async function fetchInstagramMediaPermalink(params: {
  loginMode?: IgLoginMode;
  mediaId: string;
  accessToken: string;
}): Promise<{ permalink?: string; timestamp?: string }> {
  const fetchFn = getInstagramFetch();
  try {
    const url = `${igGraphBase(params.loginMode)}/${encodeURIComponent(
      params.mediaId
    )}?fields=id,permalink,timestamp,media_type&access_token=${encodeURIComponent(
      params.accessToken
    )}`;
    const resp = await fetchFn(url, { method: 'GET' });
    if (!resp.ok) return {};
    const data = await resp.json().catch(() => ({}));
    return {
      permalink: data?.permalink ? String(data.permalink) : undefined,
      timestamp: data?.timestamp ? String(data.timestamp) : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Creates a single container (Image, Story, Carousel Child, or Carousel Parent) using
 * Instagram API with Instagram Login:
 * POST https://graph.instagram.com/v21.0/{ig_user_id}/media
 */
async function createInstagramGraphContainer(params: {
  loginMode?: IgLoginMode;
  igUserId: string;
  accessToken: string;
  candidateUrls: string[];
  caption?: string;
  isCarouselItem?: boolean;
  mediaType?: 'STORIES' | 'CAROUSEL';
  childrenIds?: string[];
}): Promise<{
  ok: boolean;
  httpStatus: number;
  containerId?: string;
  usedImageUrl?: string;
  rawMetaResponse: any;
}> {
  const fetchFn = getInstagramFetch();
  const endpoint = `${igGraphBase(params.loginMode)}/${encodeURIComponent(params.igUserId)}/media`;

  // Carousel Parent container
  if (params.mediaType === 'CAROUSEL' && params.childrenIds && params.childrenIds.length > 0) {
    const resp = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        media_type: 'CAROUSEL',
        children: params.childrenIds,
        caption: params.caption || '',
        access_token: params.accessToken.trim(),
      }),
    });
    const data = await resp.json().catch(() => ({}));
    return {
      ok: resp.ok && Boolean(data?.id),
      httpStatus: resp.status,
      containerId: data?.id ? String(data.id) : undefined,
      rawMetaResponse: data,
    };
  }

  let lastData: any = null;
  let lastStatus = 500;

  for (const imageUrl of params.candidateUrls) {
    const payload: Record<string, any> = {
      image_url: imageUrl,
      access_token: params.accessToken.trim(),
    };

    if (params.isCarouselItem) {
      payload.is_carousel_item = true;
    } else if (params.mediaType === 'STORIES') {
      payload.media_type = 'STORIES';
    } else if (params.caption !== undefined) {
      payload.caption = params.caption;
    }

    const resp = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data?.id) {
      return {
        ok: true,
        httpStatus: resp.status,
        containerId: String(data.id),
        usedImageUrl: imageUrl,
        rawMetaResponse: data,
      };
    }

    lastData = data;
    lastStatus = resp.status;

    const classification = classifyMetaError(resp.status, data);
    if (classification.category === 'AUTH_ERROR_190') {
      break;
    }
  }

  return {
    ok: false,
    httpStatus: lastStatus,
    rawMetaResponse: lastData,
  };
}

/**
 * Unified Instagram Graph API publishing flow (Immediate & Scheduled):
 * 1. Validates selected account, scopes, and decrypted long-lived token.
 * 2. Validates media accessibility via prepareMediaFn.
 * 3. Creates container(s) on POST https://graph.instagram.com/v21.0/{ig_user_id}/media.
 * 4. Polls container readiness on GET https://graph.instagram.com/v21.0/{container_id}?fields=status_code.
 * 5. Publishes container on POST https://graph.instagram.com/v21.0/{ig_user_id}/media_publish (with reconciliation on ambiguous failure).
 * 6. Fetches permalink and updates status to PUBLICADO only after Meta confirmation.
 */
export async function executeInstagramGraphPublish(params: {
  post: PostGroup;
  tenant: TenantAccount;
  caption: string;
  secretKey: string;
  pollIntervalMs?: number;
  prepareMediaFn: (
    driveFileId: string,
    item: PostGroup['items'][0]
  ) => Promise<{
    ok: boolean;
    candidateUrls: string[];
    errorMessage?: string;
  }>;
  onMarkAccountReconnect: (tenant: TenantAccount, errorMsg: string) => void;
}): Promise<{
  ok: boolean;
  status: 'PUBLISHED' | 'AUTH_ERROR_190' | 'TRANSIENT_ERROR' | 'PERMANENT_ERROR' | 'MEDIA_ACCESS_ERROR';
  httpStatus: number;
  containerId?: string;
  childContainerIds?: string[];
  instagramMediaId?: string;
  permalink?: string;
  publishedAt?: string;
  errorMessage?: string;
  metaError?: any;
  attemptRecord: PublishAttemptRecord;
}> {
  const loginMode = loginModeForTenant(params.tenant);
  const { post, tenant, caption, secretKey, prepareMediaFn, onMarkAccountReconnect } = params;
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const attemptNumber = (post.publishAttempts || 0) + 1;
  const igUserId = String(tenant.instagramUserId || tenant.id || '').trim();

  // Concurrency guard per post
  if (inFlightPostPublishes.has(post.id)) {
    return {
      ok: false,
      status: 'TRANSIENT_ERROR',
      httpStatus: 409,
      errorMessage: 'Esta publicação já está sendo processada no momento.',
      attemptRecord: {
        attemptNumber,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        accountId: tenant.id,
        igUserId,
        status: 'TRANSIENT_ERROR',
        httpStatus: 409,
        errorMessage: 'Publicação concorrente bloqueada.',
      },
    };
  }

  inFlightPostPublishes.add(post.id);
  try {
    // 0A. Validate that the Instagram account is active/approved (not pending or suspended)
    if (
      tenant.status === 'PENDENTE' ||
      tenant.status === 'AGUARDANDO_APROVACAO' ||
      tenant.status === 'SUSPENDED'
    ) {
      const msg = `A conta @${tenant.username} não está ativa para publicação (status atual: ${tenant.status}).`;
      return {
        ok: false,
        status: 'PERMANENT_ERROR',
        httpStatus: 403,
        errorMessage: msg,
        attemptRecord: {
          attemptNumber,
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          accountId: tenant.id,
          igUserId,
          status: 'PERMANENT_ERROR',
          httpStatus: 403,
          errorMessage: msg,
        },
      };
    }

    // 0B. Validate that the post content is approved (never publish rejected, cancelled, or unapproved content)
    if (
      post.status === 'REPROVADO' ||
      post.status === 'CANCELADO' ||
      post.status === 'PENDENTE_APROVACAO'
    ) {
      const msg = `Conteúdo com status "${post.status}" não está aprovado para publicação.`;
      return {
        ok: false,
        status: 'PERMANENT_ERROR',
        httpStatus: 400,
        errorMessage: msg,
        attemptRecord: {
          attemptNumber,
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          accountId: tenant.id,
          igUserId,
          status: 'PERMANENT_ERROR',
          httpStatus: 400,
          errorMessage: msg,
        },
      };
    }

    // 1. Validate scopes
    const scopeCheck = hasRequiredInstagramScopes(tenant.grantedScopes);
    if (!scopeCheck.valid) {
      tenant.connectionStatus = 'ESCOPOS_INSUFICIENTES';
      const msg = `A conta @${tenant.username} não concedeu as permissões obrigatórias (${scopeCheck.missingScopes.join(
        ', '
      )}). Reconecte o Instagram autorizando todos os escopos.`;
      return {
        ok: false,
        status: 'AUTH_ERROR_190',
        httpStatus: 403,
        errorMessage: msg,
        attemptRecord: {
          attemptNumber,
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          accountId: tenant.id,
          igUserId,
          status: 'AUTH_ERROR_190',
          httpStatus: 403,
          errorMessage: msg,
        },
      };
    }

    // 2. Resolve and validate token from the connected account (NEVER from global .env)
    const accessToken = resolveAccountAccessToken(tenant, secretKey);
    if (!accessToken || accessToken.startsWith(ENCRYPTION_PREFIX) || accessToken.length < 15) {
      const msg = `Falha ao descriptografar o token de acesso da conta @${tenant.username}. A chave de criptografia interna pode ter divergido.`;
      return {
        ok: false,
        status: 'PERMANENT_ERROR',
        httpStatus: 400,
        errorMessage: msg,
        attemptRecord: {
          attemptNumber,
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          accountId: tenant.id,
          igUserId,
          status: 'PERMANENT_ERROR',
          httpStatus: 400,
          errorMessage: msg,
        },
      };
    }

    if (isAccountTokenExpired(tenant, startedAtMs)) {
      const msg = `O token de acesso da conta @${tenant.username} expirou em ${tenant.tokenExpiresAt || 'data anterior'} (Erro 190). Reconecte a conta do Instagram para publicar.`;
      onMarkAccountReconnect(tenant, msg);
      return {
        ok: false,
        status: 'AUTH_ERROR_190',
        httpStatus: 401,
        errorMessage: msg,
        attemptRecord: {
          attemptNumber,
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          accountId: tenant.id,
          igUserId,
          status: 'AUTH_ERROR_190',
          httpStatus: 401,
          metaErrorCode: 190,
          errorMessage: msg,
        },
      };
    }

    if (!igUserId) {
      const msg = `A conta @${tenant.username} não possui um Instagram User ID válido. Reconecte a conta.`;
      onMarkAccountReconnect(tenant, msg);
      return {
        ok: false,
        status: 'AUTH_ERROR_190',
        httpStatus: 400,
        errorMessage: msg,
        attemptRecord: {
          attemptNumber,
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          accountId: tenant.id,
          igUserId: '',
          status: 'AUTH_ERROR_190',
          httpStatus: 400,
          errorMessage: msg,
        },
      };
    }

    // 3. Validate media availability for all items in the post
    const isCarousel = post.categoria === 'Carrossel' && post.items.length > 1;
    const isStory = post.categoria.toLowerCase().includes('story');

    const preparedSlides: Array<{ candidateUrls: string[] }> = [];
    const itemsToPrepare = isCarousel ? post.items : [post.items[0]].filter(Boolean);

    if (itemsToPrepare.length === 0) {
      return {
        ok: false,
        status: 'MEDIA_ACCESS_ERROR',
        httpStatus: 400,
        errorMessage: 'Nenhum arquivo de mídia encontrado na postagem.',
        attemptRecord: {
          attemptNumber,
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          accountId: tenant.id,
          igUserId,
          status: 'PERMANENT_ERROR',
          httpStatus: 400,
          errorMessage: 'Nenhum arquivo de mídia encontrado na postagem.',
        },
      };
    }

    for (const slideItem of itemsToPrepare) {
      const prepared = await prepareMediaFn(slideItem.driveFileId, slideItem);
      if (!prepared.ok || prepared.candidateUrls.length === 0) {
        const msg =
          prepared.errorMessage ||
          `Falha ao acessar ou validar o arquivo de mídia "${slideItem.nome}" (${slideItem.driveFileId}).`;
        return {
          ok: false,
          status: 'MEDIA_ACCESS_ERROR',
          httpStatus: 422,
          errorMessage: msg,
          attemptRecord: {
            attemptNumber,
            startedAt: startedAtIso,
            finishedAt: new Date().toISOString(),
            accountId: tenant.id,
            igUserId,
            status: 'TRANSIENT_ERROR',
            httpStatus: 422,
            errorMessage: msg,
          },
        };
      }
      preparedSlides.push({ candidateUrls: prepared.candidateUrls });
    }

    // 4. Create container(s) on graph.instagram.com
    let parentContainerId = post.instagramContainerId || '';
    const childContainerIds: string[] = Array.isArray(post.childContainerIds)
      ? [...post.childContainerIds]
      : [];
    let lastContainerMetaResp: any = null;

    if (!parentContainerId) {
      if (isCarousel) {
        childContainerIds.length = 0;
        for (let i = 0; i < preparedSlides.length; i++) {
          const childRes = await createInstagramGraphContainer({ loginMode, 
            igUserId,
            accessToken,
            candidateUrls: preparedSlides[i].candidateUrls,
            isCarouselItem: true,
          });
          lastContainerMetaResp = childRes.rawMetaResponse;

          if (!childRes.ok || !childRes.containerId) {
            const classified = classifyMetaError(childRes.httpStatus, childRes.rawMetaResponse);
            const finalErrMsg =
              classified.category === 'AUTH_ERROR_190'
                ? `Erro 190 da Meta (${classified.message}). Reconecte a conta do Instagram para publicar.`
                : `Erro da Meta ao criar item ${i + 1} do carrossel: ${classified.message}`;
            if (classified.category === 'AUTH_ERROR_190') {
              onMarkAccountReconnect(tenant, finalErrMsg);
            }
            return {
              ok: false,
              status: classified.category,
              httpStatus: childRes.httpStatus,
              errorMessage: finalErrMsg,
              metaError: childRes.rawMetaResponse?.error || childRes.rawMetaResponse,
              attemptRecord: {
                attemptNumber,
                startedAt: startedAtIso,
                finishedAt: new Date().toISOString(),
                accountId: tenant.id,
                igUserId,
                status: classified.category,
                httpStatus: childRes.httpStatus,
                metaErrorCode: classified.code,
                metaErrorSubcode: classified.subcode,
                errorMessage: finalErrMsg,
              },
            };
          }

          // Check child container status
          const childReady = await waitForInstagramContainerReady({ loginMode, 
            containerId: childRes.containerId,
            accessToken,
            maxAttempts: 5,
            pollIntervalMs: params.pollIntervalMs ?? 1000,
          });
          if (!childReady.ready) {
            return {
              ok: false,
              status: childReady.statusCode === 'IN_PROGRESS' ? 'TRANSIENT_ERROR' : 'PERMANENT_ERROR',
              httpStatus: 400,
              errorMessage:
                childReady.errorMessage ||
                `Contêiner filho ${childRes.containerId} não ficou pronto (${childReady.statusCode}).`,
              attemptRecord: {
                attemptNumber,
                startedAt: startedAtIso,
                finishedAt: new Date().toISOString(),
                accountId: tenant.id,
                igUserId,
                status: childReady.statusCode === 'IN_PROGRESS' ? 'TRANSIENT_ERROR' : 'PERMANENT_ERROR',
                errorMessage: childReady.errorMessage,
              },
            };
          }

          childContainerIds.push(childRes.containerId);
        }

        const parentRes = await createInstagramGraphContainer({ loginMode, 
          igUserId,
          accessToken,
          candidateUrls: [],
          caption,
          mediaType: 'CAROUSEL',
          childrenIds: childContainerIds,
        });
        lastContainerMetaResp = parentRes.rawMetaResponse;

        if (!parentRes.ok || !parentRes.containerId) {
          const classified = classifyMetaError(parentRes.httpStatus, parentRes.rawMetaResponse);
          const finalErrMsg =
            classified.category === 'AUTH_ERROR_190'
              ? `Erro 190 da Meta (${classified.message}). Reconecte a conta do Instagram para publicar.`
              : `Erro da Meta ao criar contêiner do carrossel: ${classified.message}`;
          if (classified.category === 'AUTH_ERROR_190') {
            onMarkAccountReconnect(tenant, finalErrMsg);
          }
          return {
            ok: false,
            status: classified.category,
            httpStatus: parentRes.httpStatus,
            childContainerIds,
            errorMessage: finalErrMsg,
            metaError: parentRes.rawMetaResponse?.error || parentRes.rawMetaResponse,
            attemptRecord: {
              attemptNumber,
              startedAt: startedAtIso,
              finishedAt: new Date().toISOString(),
              accountId: tenant.id,
              igUserId,
              childContainerIds,
              status: classified.category,
              httpStatus: parentRes.httpStatus,
              metaErrorCode: classified.code,
              metaErrorSubcode: classified.subcode,
              errorMessage: finalErrMsg,
            },
          };
        }

        parentContainerId = parentRes.containerId;
      } else {
        const singleRes = await createInstagramGraphContainer({ loginMode, 
          igUserId,
          accessToken,
          candidateUrls: preparedSlides[0].candidateUrls,
          caption: isStory ? undefined : caption,
          mediaType: isStory ? 'STORIES' : undefined,
        });
        lastContainerMetaResp = singleRes.rawMetaResponse;

        if (!singleRes.ok || !singleRes.containerId) {
          const classified = classifyMetaError(singleRes.httpStatus, singleRes.rawMetaResponse);
          const finalErrMsg =
            classified.category === 'AUTH_ERROR_190'
              ? `Erro 190 da Meta (${classified.message}). Reconecte a conta do Instagram para publicar.`
              : `Erro da Meta ao criar contêiner de mídia: ${classified.message}`;
          if (classified.category === 'AUTH_ERROR_190') {
            onMarkAccountReconnect(tenant, finalErrMsg);
          }
          return {
            ok: false,
            status: classified.category,
            httpStatus: singleRes.httpStatus,
            errorMessage: finalErrMsg,
            metaError: singleRes.rawMetaResponse?.error || singleRes.rawMetaResponse,
            attemptRecord: {
              attemptNumber,
              startedAt: startedAtIso,
              finishedAt: new Date().toISOString(),
              accountId: tenant.id,
              igUserId,
              status: classified.category,
              httpStatus: singleRes.httpStatus,
              metaErrorCode: classified.code,
              metaErrorSubcode: classified.subcode,
              errorMessage: finalErrMsg,
            },
          };
        }

        parentContainerId = singleRes.containerId;
      }
    }

    // 5. Verify container processing status via GET /{container_id}?fields=status_code
    const containerStatus = await waitForInstagramContainerReady({ loginMode, 
      containerId: parentContainerId,
      accessToken,
      maxAttempts: 6,
      pollIntervalMs: params.pollIntervalMs ?? 1200,
    });

    if (!containerStatus.ready) {
      const isStillProcessing = containerStatus.statusCode === 'IN_PROGRESS';
      return {
        ok: false,
        status: isStillProcessing ? 'TRANSIENT_ERROR' : 'PERMANENT_ERROR',
        httpStatus: 400,
        containerId: parentContainerId,
        childContainerIds,
        errorMessage:
          containerStatus.errorMessage ||
          `Contêiner ${parentContainerId} não ficou pronto para publicação (${containerStatus.statusCode}).`,
        metaError: containerStatus.rawResponse,
        attemptRecord: {
          attemptNumber,
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          accountId: tenant.id,
          igUserId,
          containerId: parentContainerId,
          childContainerIds,
          status: isStillProcessing ? 'TRANSIENT_ERROR' : 'PERMANENT_ERROR',
          errorMessage: containerStatus.errorMessage,
        },
      };
    }

    // 6. Publish container via POST https://graph.instagram.com/v21.0/{ig_user_id}/media_publish
    const fetchFn = getInstagramFetch();
    const publishEndpoint = `${igGraphBase(loginMode)}/${encodeURIComponent(igUserId)}/media_publish`;

    let publishedMediaId = '';
    let reconciledPermalink: string | undefined;
    let publishHttpStatus = 500;
    let publishRawData: any = null;
    let wasReconciled = false;

    try {
      const publishResp = await fetchFn(publishEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          creation_id: parentContainerId,
          access_token: accessToken.trim(),
        }),
      });

      publishHttpStatus = publishResp.status;
      publishRawData = await publishResp.json().catch(() => ({}));

      if (publishResp.ok && publishRawData?.id) {
        publishedMediaId = String(publishRawData.id);
      } else if (publishResp.status >= 500 || !publishRawData?.error) {
        // Ambiguous outcome on media_publish: reconcile with Meta before failing or retrying
        const reconciled = await reconcileInstagramPublishedMedia({ loginMode, 
          igUserId,
          accessToken,
          expectedCaption: isStory ? undefined : caption,
          sinceTimestampMs: startedAtMs,
        });
        if (reconciled.found && reconciled.mediaId) {
          publishedMediaId = reconciled.mediaId;
          reconciledPermalink = reconciled.permalink;
          wasReconciled = true;
        }
      }
    } catch (netErr: any) {
      // Network timeout/drop during media_publish: reconcile with Meta to avoid duplicate post
      const reconciled = await reconcileInstagramPublishedMedia({ loginMode, 
        igUserId,
        accessToken,
        expectedCaption: isStory ? undefined : caption,
        sinceTimestampMs: startedAtMs,
      });
      if (reconciled.found && reconciled.mediaId) {
        publishedMediaId = reconciled.mediaId;
        reconciledPermalink = reconciled.permalink;
        wasReconciled = true;
      } else {
        return {
          ok: false,
          status: 'TRANSIENT_ERROR',
          httpStatus: 503,
          containerId: parentContainerId,
          childContainerIds,
          errorMessage: `Falha de comunicação com a Meta durante media_publish: ${
            netErr?.message || 'Erro de rede'
          }`,
          attemptRecord: {
            attemptNumber,
            startedAt: startedAtIso,
            finishedAt: new Date().toISOString(),
            accountId: tenant.id,
            igUserId,
            containerId: parentContainerId,
            childContainerIds,
            status: 'TRANSIENT_ERROR',
            httpStatus: 503,
            errorMessage: netErr?.message || 'Falha de comunicação com a Meta',
          },
        };
      }
    }

    if (!publishedMediaId) {
      const classified = classifyMetaError(publishHttpStatus, publishRawData);
      const finalErrMsg =
        classified.category === 'AUTH_ERROR_190'
          ? `Erro 190 da Meta (${classified.message}). Reconecte a conta do Instagram para publicar.`
          : `Erro da Meta ao publicar mídia (media_publish): ${classified.message}`;
      if (classified.category === 'AUTH_ERROR_190') {
        onMarkAccountReconnect(tenant, finalErrMsg);
      }
      return {
        ok: false,
        status: classified.category,
        httpStatus: publishHttpStatus,
        containerId: parentContainerId,
        childContainerIds,
        errorMessage: finalErrMsg,
        metaError: publishRawData?.error || publishRawData || lastContainerMetaResp,
        attemptRecord: {
          attemptNumber,
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          accountId: tenant.id,
          igUserId,
          containerId: parentContainerId,
          childContainerIds,
          status: classified.category,
          httpStatus: publishHttpStatus,
          metaErrorCode: classified.code,
          metaErrorSubcode: classified.subcode,
          errorMessage: finalErrMsg,
        },
      };
    }

    // 7. Fetch permalink of the confirmed publication
    const mediaDetails = await fetchInstagramMediaPermalink({ loginMode, 
      mediaId: publishedMediaId,
      accessToken,
    });
    const finalPermalink = mediaDetails.permalink || reconciledPermalink;
    const finishedAtIso = new Date().toISOString();

    return {
      ok: true,
      status: 'PUBLISHED',
      httpStatus: 200,
      containerId: parentContainerId,
      childContainerIds,
      instagramMediaId: publishedMediaId,
      permalink: finalPermalink,
      publishedAt: mediaDetails.timestamp || finishedAtIso,
      attemptRecord: {
        attemptNumber,
        startedAt: startedAtIso,
        finishedAt: finishedAtIso,
        accountId: tenant.id,
        igUserId,
        containerId: parentContainerId,
        childContainerIds,
        mediaId: publishedMediaId,
        permalink: finalPermalink,
        status: wasReconciled ? 'RECONCILED_SUCCESS' : 'SUCCESS',
        httpStatus: 200,
      },
    };
  } finally {
    inFlightPostPublishes.delete(post.id);
  }
}
