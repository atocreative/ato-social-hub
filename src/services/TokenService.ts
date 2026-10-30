import { dbQuery, withTransaction } from '../db/pool.ts';
import {
  addAdminAlertInDb,
  getInstagramAccountByIdOrUser,
  getTokenEncryptionKey,
  listInstagramAccounts,
  recordTokenRefreshRunInDb,
  resolveAdminAlertsForTenantInDb,
  upsertInstagramAccount,
} from '../db/repository.ts';
import { AdminAlertNotification, TenantAccount } from '../types/index.ts';
import {
  decryptInstagramToken,
  encryptInstagramToken,
  exchangeShortForLongLivedInstagramToken,
  getInstagramFetch,
  hasRequiredInstagramScopes,
  IG_USER_MSG_PERMISSION_RESTRICTED,
  IG_USER_MSG_PERSONAL_ACCOUNT,
  IG_USER_MSG_TEMPORARY_ERROR,
  isAccountTokenExpired,
  refreshAccountLongLivedToken,
  REQUIRED_IG_SCOPES,
  resolveAccountAccessToken,
} from './instagramCore.ts';

export interface OAuthConnectResult {
  ok: boolean;
  step?: string;
  reasonCode?:
    | 'PERSONAL_ACCOUNT_NOT_SUPPORTED'
    | 'ACCOUNT_NOT_AUTHORIZED_IN_META_APP'
    | 'INSUFFICIENT_SCOPES'
    | 'CROSS_TENANT_VIOLATION'
    | 'TEMPORARY_TECHNICAL_ERROR';
  userMessage?: string;
  httpStatus: number;
  igUserId?: string;
  fbtraceId?: string;
  accountType?: string;
  tenant?: TenantAccount;
  tokenType?: 'LONG_LIVED' | 'SHORT_LIVED';
  tokenIssuedAt?: string;
  tokenExpiresAt?: string;
  grantedScopes?: string[];
  errorMessage?: string;
  rawError?: any;
  diagnostics?: {
    minimalQueryEndpoint: string;
    minimalQuerySuccess: boolean;
    progressiveQueryEndpoint?: string;
    progressiveQuerySuccess?: boolean;
    oauthUserId?: string;
    graphId?: string;
    graphUserId?: string;
    username?: string;
    accountType?: string;
    fbtraceId?: string;
  };
}

export interface TokenRefreshJobSummary {
  checked: number;
  refreshed: number;
  skippedRecent: number;
  skippedHealthy: number;
  markedReconnection: number;
  transientErrors: number;
  details: Array<{
    tenantId: string;
    username: string;
    action: string;
    message: string;
    tokenExpiresAt?: string;
    attemptsUsed?: number;
  }>;
}

/**
 * TokenService — Gerenciamento centralizado, seguro e independente de hospedagem
 * para tokens OAuth do Instagram persistidos no PostgreSQL (Railway).
 *
 * Responsabilidades:
 * - Criptografar/descriptografar tokens com AES-256-GCM usando TOKEN_ENCRYPTION_KEY.
 * - Trocar código OAuth por token curto e converter para token longo (60 dias) via ig_exchange_token.
 * - Consultar progressivamente a Graph API (/v21.0/me?fields=user_id,username -> id,user_id,username,account_type).
 * - Bloquear contas pessoais (PERSONAL) e erros de permissão (IGApiException code 100) sem criar sessões indevidas.
 * - Atualizar a conta existente no PostgreSQL preservando IDs, relacionamentos e isolamento multiempresa.
 */
export class TokenService {
  static getEncryptionKey(): string {
    return getTokenEncryptionKey();
  }

  static encrypt(plainToken: string): string {
    return encryptInstagramToken(plainToken, TokenService.getEncryptionKey());
  }

  static decrypt(encryptedOrPlainToken: string | undefined | null): string {
    if (!encryptedOrPlainToken) return '';
    const primaryKey = TokenService.getEncryptionKey();
    const dec = decryptInstagramToken(encryptedOrPlainToken, primaryKey);
    if (dec) return dec;

    const fallbackJwt = String(process.env.JWT_SECRET || 'ato_super_secret_key_2026_998877').trim();
    if (fallbackJwt && fallbackJwt !== primaryKey) {
      return decryptInstagramToken(encryptedOrPlainToken, fallbackJwt);
    }
    return '';
  }

  static resolvePlainToken(tenant: TenantAccount | undefined | null): string {
    if (!tenant) return '';
    return resolveAccountAccessToken(tenant, TokenService.getEncryptionKey());
  }

  /**
   * Executa o fluxo completo e auditado de autorização OAuth com a Meta:
   * 1. POST https://api.instagram.com/oauth/access_token (código -> token curto + user_id 64-bit exato)
   * 2. Validação de escopos concedidos (instagram_business_basic, instagram_business_content_publish)
   * 3. GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token (token curto -> token longo 60d)
   * 4A. Consulta mínima de perfil: GET https://graph.instagram.com/v21.0/me?fields=user_id,username
   * 4B. Consulta progressiva: GET https://graph.instagram.com/v21.0/me?fields=id,user_id,username,account_type
   * 4C. Bloqueio de contas pessoais (PERSONAL) e rejeição segura de falhas Graph API (erro 100) sem bypass.
   * 5. Persistência transacional no PostgreSQL respeitando isolamento multiempresa e fila de aprovação.
   */
  static async authorizeAndPersistInstagramAccount(params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    preferredTenantId?: string | null;
    driveFolderName?: string | null;
    driveFolderId?: string | null;
    companyId?: string | null;
    status?: TenantAccount['status'];
  }): Promise<OAuthConnectResult> {
    const fetchFn = getInstagramFetch();
    const cleanCode = String(params.code || '').replace(/#_$/, '').trim();

    if (!cleanCode) {
      return {
        ok: false,
        step: '0_CALLBACK_SEM_CODE',
        reasonCode: 'TEMPORARY_TECHNICAL_ERROR',
        userMessage: IG_USER_MSG_TEMPORARY_ERROR,
        httpStatus: 400,
        errorMessage: 'Código de autorização OAuth ausente.',
      };
    }

    // 1. Troca do código OAuth pelo token curto
    const formData = new URLSearchParams();
    formData.append('client_id', params.clientId);
    formData.append('client_secret', params.clientSecret);
    formData.append('grant_type', 'authorization_code');
    formData.append('redirect_uri', params.redirectUri);
    formData.append('code', cleanCode);

    let tokenRes: Response;
    try {
      tokenRes = await fetchFn('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });
    } catch (netErr: any) {
      return {
        ok: false,
        step: '1_POST_OAUTH_ACCESS_TOKEN',
        reasonCode: 'TEMPORARY_TECHNICAL_ERROR',
        userMessage: IG_USER_MSG_TEMPORARY_ERROR,
        httpStatus: 502,
        errorMessage: netErr?.message || 'Erro de rede ao comunicar com api.instagram.com.',
      };
    }

    const rawTokenText = await tokenRes.text().catch(() => '');
    const exactUserIdMatch = rawTokenText.match(/"user_id"\s*:\s*"?(\d+)"?/);
    const exactUserIdFromText = exactUserIdMatch ? exactUserIdMatch[1] : '';

    let tokenData: any = {};
    try {
      tokenData = rawTokenText ? JSON.parse(rawTokenText) : {};
    } catch {
      tokenData = {
        error_type: 'InvalidJSONResponse',
        error_message: rawTokenText || 'Empty response',
      };
    }

    const rawAccessToken =
      tokenData.access_token ||
      (Array.isArray(tokenData.data) && tokenData.data[0]?.access_token) ||
      '';
    const oauthUserId = String(
      exactUserIdFromText ||
        tokenData.user_id ||
        (Array.isArray(tokenData.data) && tokenData.data[0]?.user_id) ||
        ''
    ).trim();
    const rawPermissions: string[] = Array.isArray(tokenData.permissions)
      ? tokenData.permissions
      : Array.isArray(tokenData.data) && Array.isArray(tokenData.data[0]?.permissions)
      ? tokenData.data[0].permissions
      : typeof tokenData.permissions === 'string'
      ? tokenData.permissions.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];

    if (
      !tokenRes.ok ||
      tokenData.error_type ||
      tokenData.error ||
      !rawAccessToken ||
      typeof rawAccessToken !== 'string' ||
      !rawAccessToken.trim()
    ) {
      const { access_token: _omitToken, data: _omitData, ...safeTokenError } = tokenData || {};
      const errStr = JSON.stringify(safeTokenError).toLowerCase();
      const isRoleOrPermissionBlock =
        errStr.includes('insufficient developer role') ||
        errStr.includes('tester') ||
        errStr.includes('not a test user') ||
        errStr.includes('permission') ||
        errStr.includes('unauthorized');

      return {
        ok: false,
        step: '1_POST_OAUTH_ACCESS_TOKEN',
        reasonCode: isRoleOrPermissionBlock
          ? 'ACCOUNT_NOT_AUTHORIZED_IN_META_APP'
          : 'TEMPORARY_TECHNICAL_ERROR',
        userMessage: isRoleOrPermissionBlock
          ? IG_USER_MSG_PERMISSION_RESTRICTED
          : IG_USER_MSG_TEMPORARY_ERROR,
        httpStatus: tokenRes.status >= 500 ? tokenRes.status : 400,
        igUserId: oauthUserId || undefined,
        errorMessage:
          safeTokenError?.error_message ||
          safeTokenError?.error?.message ||
          'Falha na troca do código OAuth pelo token de curta duração.',
        rawError: safeTokenError,
      };
    }

    const shortLivedToken = rawAccessToken.trim();

    // 2. Verificação de permissões concedidas
    if (rawPermissions.length > 0) {
      const scopeValidation = hasRequiredInstagramScopes(rawPermissions);
      if (!scopeValidation.valid) {
        return {
          ok: false,
          step: '1B_PERMISSOES_INSUFICIENTES',
          reasonCode: 'INSUFFICIENT_SCOPES',
          userMessage: IG_USER_MSG_PERMISSION_RESTRICTED,
          httpStatus: 400,
          igUserId: oauthUserId || undefined,
          grantedScopes: rawPermissions,
          errorMessage: `As permissões obrigatórias (${scopeValidation.missingScopes.join(
            ', '
          )}) não foram concedidas pela conta. Reconecte o Instagram autorizando todos os escopos.`,
          rawError: {
            permissoes_recebidas: rawPermissions,
            permissoes_faltantes: scopeValidation.missingScopes,
          },
        };
      }
    }

    const grantedScopes =
      rawPermissions.length > 0 ? rawPermissions : [...REQUIRED_IG_SCOPES];

    // 3. Conversão para token longo (60 dias) com ig_exchange_token
    const longLivedExchange = await exchangeShortForLongLivedInstagramToken({
      shortLivedToken,
      clientSecret: params.clientSecret,
    });

    const finalAccessToken = longLivedExchange.accessToken;

    // 4A. Consulta mínima de perfil (Seção 2):
    // GET https://graph.instagram.com/v21.0/me?fields=user_id,username
    const minimalEndpoint = 'https://graph.instagram.com/v21.0/me?fields=user_id,username';
    const minimalUrl = `${minimalEndpoint}&access_token=${encodeURIComponent(finalAccessToken)}`;

    let minRes: Response;
    try {
      minRes = await fetchFn(minimalUrl, { method: 'GET' });
    } catch (netErr: any) {
      return {
        ok: false,
        step: '2_GET_GRAPH_INSTAGRAM_ME',
        reasonCode: 'TEMPORARY_TECHNICAL_ERROR',
        userMessage: IG_USER_MSG_TEMPORARY_ERROR,
        httpStatus: 502,
        igUserId: oauthUserId || undefined,
        errorMessage: netErr?.message || 'Erro de conexão ao consultar Graph API.',
      };
    }

    const minRawText = await minRes.text().catch(() => '');
    const minExactUserId = minRawText.match(/"user_id"\s*:\s*"?(\d+)"?/)?.[1];
    const minExactId = minRawText.match(/"id"\s*:\s*"?(\d+)"?/)?.[1];
    let minData: any = {};
    try {
      minData = minRawText ? JSON.parse(minRawText) : {};
    } catch {
      minData = { error: { message: minRawText || 'Invalid JSON response' } };
    }
    if (minExactUserId) minData.user_id = minExactUserId;
    if (minExactId) minData.id = minExactId;

    if (!minRes.ok || minData.error || minData.error_type || !minData.username) {
      const fbtraceId =
        minData?.error?.fbtrace_id || minData?.fbtrace_id || undefined;
      const metaCode = minData?.error?.code ?? minData?.code;
      const metaType = String(minData?.error?.type || minData?.error_type || '');
      const metaMsg = String(
        minData?.error?.message || minData?.error_message || 'Erro ao consultar perfil no Graph API.'
      );
      const lowerMsg = metaMsg.toLowerCase();

      const isPersonalExplicit =
        lowerMsg.includes('personal') || lowerMsg.includes('conta pessoal');
      const isCode100OrPermission =
        metaCode === 100 ||
        metaCode === 10 ||
        metaCode === 200 ||
        metaType === 'IGApiException' ||
        metaType === 'OAuthException' ||
        lowerMsg.includes('unsupported request') ||
        lowerMsg.includes('permission') ||
        lowerMsg.includes('unauthorized');

      const userMessage = isPersonalExplicit
        ? IG_USER_MSG_PERSONAL_ACCOUNT
        : minRes.status >= 500
        ? IG_USER_MSG_TEMPORARY_ERROR
        : isCode100OrPermission
        ? IG_USER_MSG_PERMISSION_RESTRICTED
        : IG_USER_MSG_TEMPORARY_ERROR;

      const reasonCode = isPersonalExplicit
        ? 'PERSONAL_ACCOUNT_NOT_SUPPORTED'
        : minRes.status >= 500
        ? 'TEMPORARY_TECHNICAL_ERROR'
        : isCode100OrPermission
        ? 'ACCOUNT_NOT_AUTHORIZED_IN_META_APP'
        : 'TEMPORARY_TECHNICAL_ERROR';

      return {
        ok: false,
        step: '2_GET_GRAPH_INSTAGRAM_ME',
        reasonCode,
        userMessage,
        httpStatus: minRes.status || 400,
        igUserId: oauthUserId || undefined,
        fbtraceId,
        errorMessage: metaMsg,
        rawError: minData,
        diagnostics: {
          minimalQueryEndpoint: minimalEndpoint,
          minimalQuerySuccess: false,
          oauthUserId: oauthUserId || undefined,
          fbtraceId,
        },
      };
    }

    // 4B. Caso a consulta mínima funcione, testar progressivamente os demais campos (id, user_id, username, account_type)
    const progressiveEndpoint =
      'https://graph.instagram.com/v21.0/me?fields=id,user_id,username,account_type';
    const progressiveUrl = `${progressiveEndpoint}&access_token=${encodeURIComponent(finalAccessToken)}`;

    let profileData: any = { ...minData };
    let progressiveSuccess = false;

    try {
      const progRes = await fetchFn(progressiveUrl, { method: 'GET' });
      const progRawText = await progRes.text().catch(() => '');
      const progExactUserId = progRawText.match(/"user_id"\s*:\s*"?(\d+)"?/)?.[1];
      const progExactId = progRawText.match(/"id"\s*:\s*"?(\d+)"?/)?.[1];
      const progParsed = progRawText ? JSON.parse(progRawText) : {};
      if (progExactUserId) progParsed.user_id = progExactUserId;
      if (progExactId) progParsed.id = progExactId;

      if (progRes.ok && !progParsed.error && !progParsed.error_type && progParsed.username) {
        profileData = {
          ...profileData,
          ...progParsed,
        };
        progressiveSuccess = true;
      }
    } catch {
      // Mantém os dados já validados na consulta mínima caso a segunda consulta falhe por rede
    }

    const realUsername = String(profileData.username).replace(/^@/, '').trim();
    const realIgUserId = String(
      profileData.user_id || oauthUserId || profileData.id
    ).trim();
    const realGraphNodeId = String(profileData.id || realIgUserId).trim();
    const realAccountType = String(profileData.account_type || '').trim().toUpperCase();
    const realAvatarUrl = String(profileData.profile_picture_url || '').trim();

    // 4C. Bloqueio estrito de contas pessoais (PERSONAL)
    if (realAccountType === 'PERSONAL') {
      return {
        ok: false,
        step: '2C_CONTA_PESSOAL_NAO_SUPORTADA',
        reasonCode: 'PERSONAL_ACCOUNT_NOT_SUPPORTED',
        userMessage: IG_USER_MSG_PERSONAL_ACCOUNT,
        httpStatus: 400,
        igUserId: realIgUserId,
        accountType: realAccountType,
        errorMessage: IG_USER_MSG_PERSONAL_ACCOUNT,
        rawError: {
          account_type: realAccountType,
          username: realUsername,
          message: IG_USER_MSG_PERSONAL_ACCOUNT,
        },
        diagnostics: {
          minimalQueryEndpoint: minimalEndpoint,
          minimalQuerySuccess: true,
          progressiveQueryEndpoint: progressiveEndpoint,
          progressiveQuerySuccess: progressiveSuccess,
          oauthUserId: oauthUserId || undefined,
          graphId: realGraphNodeId,
          graphUserId: realIgUserId,
          username: realUsername,
          accountType: realAccountType,
        },
      };
    }

    // 5. Persistência segura no PostgreSQL preservando IDs e isolamento multiempresa
    try {
      const savedTenant = await TokenService.persistValidatedAccountToken({
        username: realUsername,
        instagramUserId: realIgUserId,
        accountType: realAccountType || 'BUSINESS',
        avatarUrl: realAvatarUrl || undefined,
        plainAccessToken: finalAccessToken,
        tokenType: longLivedExchange.tokenType,
        tokenIssuedAt: longLivedExchange.tokenIssuedAt,
        tokenExpiresAt: longLivedExchange.tokenExpiresAt,
        grantedScopes,
        preferredTenantId: params.preferredTenantId,
        driveFolderName: params.driveFolderName,
        driveFolderId: params.driveFolderId,
        companyId: params.companyId,
        status: params.status,
      });

      return {
        ok: true,
        httpStatus: 200,
        igUserId: realIgUserId,
        accountType: realAccountType || 'BUSINESS',
        tenant: savedTenant,
        tokenType: longLivedExchange.tokenType,
        tokenIssuedAt: longLivedExchange.tokenIssuedAt,
        tokenExpiresAt: longLivedExchange.tokenExpiresAt,
        grantedScopes,
        diagnostics: {
          minimalQueryEndpoint: minimalEndpoint,
          minimalQuerySuccess: true,
          progressiveQueryEndpoint: progressiveEndpoint,
          progressiveQuerySuccess: progressiveSuccess,
          oauthUserId: oauthUserId || undefined,
          graphId: realGraphNodeId,
          graphUserId: realIgUserId,
          username: realUsername,
          accountType: realAccountType || 'BUSINESS',
        },
      };
    } catch (persistErr: any) {
      const isCrossTenant = String(persistErr?.message || '').includes('CROSS_TENANT_VIOLATION');
      return {
        ok: false,
        step: isCrossTenant ? '3_BLOQUEIO_VINCULACAO_OUTRA_EMPRESA' : '3_PERSISTENCIA_POSTGRES',
        reasonCode: isCrossTenant ? 'CROSS_TENANT_VIOLATION' : 'TEMPORARY_TECHNICAL_ERROR',
        userMessage: isCrossTenant
          ? 'Esta conta do Instagram já está vinculada a outra empresa.'
          : IG_USER_MSG_TEMPORARY_ERROR,
        httpStatus: isCrossTenant ? 403 : 500,
        igUserId: realIgUserId,
        errorMessage: persistErr?.message || IG_USER_MSG_TEMPORARY_ERROR,
      };
    }
  }

  /**
   * Criptografa o token com AES-256-GCM (TOKEN_ENCRYPTION_KEY) e atualiza ou cria o registro
   * em instagram_accounts no PostgreSQL sem duplicar a conta, preservando IDs, exigindo aprovação
   * administrativa para novas contas e impedindo sequestro entre empresas diferentes.
   */
  static async persistValidatedAccountToken(params: {
    username: string;
    nome?: string;
    instagramUserId: string;
    accountType?: string;
    avatarUrl?: string;
    plainAccessToken?: string;
    encryptedAccessToken?: string;
    tokenType?: 'LONG_LIVED' | 'SHORT_LIVED';
    tokenIssuedAt?: string;
    tokenExpiresAt?: string;
    grantedScopes?: string[];
    preferredTenantId?: string | null;
    driveFolderName?: string | null;
    driveFolderId?: string | null;
    companyId?: string | null;
    status?: TenantAccount['status'];
  }): Promise<TenantAccount> {
    const encKey = TokenService.getEncryptionKey();
    const cleanUsername = params.username.replace(/^@/, '').trim();
    const nowIso = new Date().toISOString();

    const resolvedPlain =
      params.plainAccessToken?.trim() ||
      TokenService.decrypt(params.encryptedAccessToken);

    const encryptedToken = resolvedPlain
      ? encryptInstagramToken(resolvedPlain, encKey)
      : params.encryptedAccessToken || '';

    const scopes =
      Array.isArray(params.grantedScopes) && params.grantedScopes.length > 0
        ? params.grantedScopes
        : [...REQUIRED_IG_SCOPES];

    const scopeCheck = hasRequiredInstagramScopes(scopes);
    const issuedIso = params.tokenIssuedAt || nowIso;
    const expiresIso =
      params.tokenExpiresAt ||
      new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

    return await withTransaction(async (tx) => {
      // 1. Verifica se este instagram_user_id ou username já pertence a uma conta existente
      const byIdentityRes = await tx.query<any>(
        `
        SELECT * FROM instagram_accounts
        WHERE instagram_user_id = $2
           OR LOWER(username) = LOWER($1)
        ORDER BY CASE WHEN instagram_user_id = $2 THEN 0 ELSE 1 END
        LIMIT 1
        `,
        [cleanUsername, params.instagramUserId]
      );
      let existingRow = byIdentityRes.rows[0] || null;

      // 2. Se foi informado um preferredTenantId, valida se não há conflito de empresa
      if (params.preferredTenantId) {
        const byPreferredRes = await tx.query<any>(
          `SELECT * FROM instagram_accounts WHERE id = $1 LIMIT 1`,
          [params.preferredTenantId]
        );
        const preferredRow = byPreferredRes.rows[0] || null;

        if (existingRow && preferredRow && existingRow.id !== preferredRow.id) {
          // A conta Instagram já pertence a outro registro de empresa!
          const existingFolder = String(existingRow.drive_folder_name || '').trim().toLowerCase();
          const preferredFolder = String(preferredRow.drive_folder_name || '').trim().toLowerCase();
          if (existingFolder && preferredFolder && existingFolder !== preferredFolder) {
            throw new Error(
              'CROSS_TENANT_VIOLATION: Esta conta do Instagram já pertence a outra empresa.'
            );
          }
        }

        if (!existingRow && preferredRow) {
          // Só permite vincular a um preferredRow se ele ainda não tiver outra conta Instagram real ativa
          // ou se for o mesmo usuário/empresa reconectando
          const prefIgId = String(preferredRow.instagram_user_id || '').trim();
          const prefUsername = String(preferredRow.username || '').trim().toLowerCase();
          const isUnconnectedPlaceholder =
            prefIgId.startsWith('pending_ig_') ||
            prefUsername.startsWith('cadastro_') ||
            preferredRow.connection_status === 'DESCONECTADO';

          if (
            isUnconnectedPlaceholder ||
            prefIgId === params.instagramUserId ||
            prefUsername === cleanUsername.toLowerCase()
          ) {
            existingRow = preferredRow;
          } else if (
            params.driveFolderName &&
            preferredRow.drive_folder_name &&
            params.driveFolderName.toLowerCase() !== preferredRow.drive_folder_name.toLowerCase()
          ) {
            throw new Error(
              'CROSS_TENANT_VIOLATION: Tentativa de vincular conta a uma empresa diferente da autorizada.'
            );
          }
        }
      }

      // Se a conta Instagram já existe e já está vinculada a uma empresa A, bloqueia tentativa de vinculá-la à empresa B
      if (
        existingRow &&
        existingRow.drive_folder_name &&
        params.driveFolderName &&
        existingRow.drive_folder_name.toLowerCase() !== params.driveFolderName.toLowerCase()
      ) {
        throw new Error(
          'CROSS_TENANT_VIOLATION: Esta conta do Instagram já está vinculada a outra empresa.'
        );
      }

      // Preserva SEMPRE o ID primário existente (ex: tenant_ato_vc) para manter FKs em posts, schedules e users!
      const preservedId =
        existingRow?.id ||
        params.preferredTenantId ||
        `tenant_${cleanUsername.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

      // NUNCA vincula automaticamente uma conta nova a uma empresa sem aprovação!
      const effectiveFolderName =
        existingRow?.drive_folder_name || params.driveFolderName?.trim() || null;
      const effectiveFolderId =
        existingRow?.drive_folder_id ||
        params.driveFolderId?.trim() ||
        effectiveFolderName ||
        null;

      let effectiveCompanyId = existingRow?.company_id || params.companyId || null;
      if (!effectiveCompanyId && effectiveFolderName) {
        const compRes = await tx.query<any>(
          `SELECT id FROM companies WHERE LOWER(drive_folder_name) = LOWER($1) OR LOWER(name) = LOWER($1) LIMIT 1`,
          [effectiveFolderName]
        );
        if (compRes.rows[0]?.id) {
          effectiveCompanyId = compRes.rows[0].id;
        }
      }

      const preservedStatus: TenantAccount['status'] =
        params.status ||
        (existingRow?.status && existingRow.status !== 'RECONEXAO_NECESSARIA'
          ? existingRow.status
          : effectiveFolderName
          ? 'APROVADO'
          : 'AGUARDANDO_APROVACAO');

      const connectionStatus = !encryptedToken
        ? 'RECONEXAO_NECESSARIA'
        : !scopeCheck.valid
        ? 'ESCOPOS_INSUFICIENTES'
        : 'CONECTADO';

      const accountToSave: TenantAccount = {
        id: preservedId,
        companyId: effectiveCompanyId,
        username: cleanUsername,
        nome:
          existingRow?.nome && !String(existingRow.nome).startsWith('cadastro_')
            ? existingRow.nome
            : params.nome || cleanUsername,
        instagramUserId: params.instagramUserId || existingRow?.instagram_user_id || preservedId,
        account_type: params.accountType || existingRow?.account_type || undefined,
        avatarUrl: params.avatarUrl || existingRow?.avatar_url || undefined,
        driveFolderName: effectiveFolderName,
        driveFolderId: effectiveFolderId,
        status: preservedStatus,
        encryptedAccessToken: encryptedToken || undefined,
        tokenType: params.tokenType || 'LONG_LIVED',
        tokenIssuedAt: issuedIso,
        tokenExpiresAt: expiresIso,
        lastTokenRefreshAt: issuedIso,
        grantedScopes: scopes,
        connectionStatus,
        lastConnectionError: connectionStatus === 'CONECTADO' ? null : existingRow?.last_connection_error,
        reconnectionRequiredAt: connectionStatus === 'CONECTADO' ? null : existingRow?.reconnection_required_at,
        hasValidToken: connectionStatus === 'CONECTADO',
        requestedAt: existingRow?.requested_at
          ? new Date(existingRow.requested_at).toISOString()
          : nowIso,
        approvedAt: existingRow?.approved_at
          ? new Date(existingRow.approved_at).toISOString()
          : preservedStatus === 'APROVADO'
          ? nowIso
          : undefined,
        lastSyncAt: nowIso,
      };

      const savedAccount = await upsertInstagramAccount(accountToSave, tx);

      if (connectionStatus === 'CONECTADO') {
        // Resolve alertas administrativos pendentes dessa conta
        await resolveAdminAlertsForTenantInDb(savedAccount.id, tx);

        // Restaura agendamentos que estavam pausados em RECONEXAO_NECESSARIA para esta conta
        await tx.query(
          `
          UPDATE posts SET
            status = 'AGENDADO',
            instagram_account_id = COALESCE(instagram_account_id, $1),
            scheduled_account_id = COALESCE(scheduled_account_id, $1),
            failure_reason = NULL,
            publish_lock = NULL,
            next_retry_at = NULL,
            updated_at = NOW()
          WHERE status = 'RECONEXAO_NECESSARIA'
            AND scheduled_at IS NOT NULL
            AND (
              instagram_account_id = $1
              OR scheduled_account_id = $1
              OR ($2::varchar IS NOT NULL AND LOWER(drive_folder_name) = LOWER($2))
            )
          `,
          [savedAccount.id, savedAccount.driveFolderName || null]
        );

        await tx.query(
          `
          UPDATE schedules SET
            status = 'AGENDADO',
            instagram_account_id = COALESCE(instagram_account_id, $1),
            last_error = NULL,
            next_retry_at = NULL,
            lock_instance_id = NULL,
            lock_acquired_at = NULL,
            lock_expires_at = NULL,
            updated_at = NOW()
          WHERE status = 'RECONEXAO_NECESSARIA'
            AND (
              instagram_account_id = $1
              OR post_id IN (
                SELECT id FROM posts
                WHERE instagram_account_id = $1 OR scheduled_account_id = $1
              )
            )
          `,
          [savedAccount.id]
        );

        await tx.query(
          `
          UPDATE media_assets SET
            status = 'AGENDADO',
            updated_at = NOW()
          WHERE status = 'RECONEXAO_NECESSARIA'
            AND drive_file_id IN (
              SELECT pm.drive_file_id
              FROM post_media pm
              JOIN posts p ON p.id = pm.post_id
              WHERE p.status = 'AGENDADO' AND (p.instagram_account_id = $1 OR p.scheduled_account_id = $1)
            )
          `,
          [savedAccount.id]
        );
      }

      return savedAccount;
    });
  }

  /**
   * Marca uma conta como RECONEXAO_NECESSARIA diretamente no PostgreSQL,
   * pausando seus agendamentos em aberto sem perder data/hora/legenda.
   */
  static async markAccountReconnectionRequired(
    tenantOrId: TenantAccount | string,
    reason: string
  ): Promise<void> {
    const account =
      typeof tenantOrId === 'string'
        ? await getInstagramAccountByIdOrUser(tenantOrId)
        : tenantOrId;
    if (!account) return;

    const nowIso = new Date().toISOString();

    await withTransaction(async (tx) => {
      await tx.query(
        `
        UPDATE instagram_accounts SET
          connection_status = 'RECONEXAO_NECESSARIA',
          has_valid_token = FALSE,
          last_connection_error = $2,
          reconnection_required_at = COALESCE(reconnection_required_at, $3),
          updated_at = NOW()
        WHERE id = $1
        `,
        [account.id, reason, nowIso]
      );

      // Pausa agendamentos futuros/vencidos dessa conta preservando scheduled_at e caption
      await tx.query(
        `
        UPDATE posts SET
          status = 'RECONEXAO_NECESSARIA',
          failure_reason = $2,
          publish_lock = NULL,
          updated_at = NOW()
        WHERE status = 'AGENDADO'
          AND (
            instagram_account_id = $1
            OR scheduled_account_id = $1
            OR ($3::varchar IS NOT NULL AND LOWER(drive_folder_name) = LOWER($3))
          )
        `,
        [account.id, reason, account.driveFolderName || null]
      );

      await tx.query(
        `
        UPDATE schedules SET
          status = 'RECONEXAO_NECESSARIA',
          last_error = $2,
          lock_instance_id = NULL,
          lock_acquired_at = NULL,
          lock_expires_at = NULL,
          updated_at = NOW()
        WHERE status = 'AGENDADO'
          AND (
            instagram_account_id = $1
            OR post_id IN (
              SELECT id FROM posts
              WHERE instagram_account_id = $1 OR scheduled_account_id = $1
            )
          )
        `,
        [account.id, reason]
      );

      await tx.query(
        `
        UPDATE media_assets SET
          status = 'RECONEXAO_NECESSARIA',
          updated_at = NOW()
        WHERE drive_file_id IN (
          SELECT pm.drive_file_id
          FROM post_media pm
          JOIN posts p ON p.id = pm.post_id
          WHERE p.status = 'RECONEXAO_NECESSARIA'
            AND (p.instagram_account_id = $1 OR p.scheduled_account_id = $1)
        )
        `,
        [account.id]
      );

      await addAdminAlertInDb(
        {
          type: 'RECONEXAO_NECESSARIA',
          tenantId: account.id,
          username: account.username,
          message: `A conta @${account.username} requer reconexão via OAuth do Instagram: ${reason}`,
        },
        tx
      );
    });
  }

  /**
   * Valida e retorna a conta e seu token descriptografado diretamente do PostgreSQL.
   * Se o token estiver elegível para renovação preventiva (>= 30 dias ou <= 15 dias para expirar),
   * executa o refresh automaticamente antes da operação.
   */
  static async ensureValidTokenForAccount(
    accountIdentifier: string | TenantAccount,
    nowMs: number = Date.now()
  ): Promise<{
    ok: boolean;
    tenant?: TenantAccount;
    accessToken?: string;
    errorMessage?: string;
    reconnectionRequired?: boolean;
  }> {
    let tenant =
      typeof accountIdentifier === 'string'
        ? await getInstagramAccountByIdOrUser(accountIdentifier)
        : (await getInstagramAccountByIdOrUser(accountIdentifier.id)) || accountIdentifier;

    if (!tenant) {
      return {
        ok: false,
        errorMessage: 'Conta do Instagram não encontrada no PostgreSQL.',
      };
    }

    const encKey = TokenService.getEncryptionKey();
    let plainToken = resolveAccountAccessToken(tenant, encKey);

    if (!plainToken) {
      const msg = `O token de acesso da conta @${tenant.username} está ausente (Erro 190). Clique em "Reconectar Instagram" para autorizar a conta.`;
      await TokenService.markAccountReconnectionRequired(tenant, msg);
      return {
        ok: false,
        tenant,
        errorMessage: msg,
        reconnectionRequired: true,
      };
    }

    if (isAccountTokenExpired(tenant, nowMs)) {
      const msg = `O token de longa duração da conta @${tenant.username} expirou em ${tenant.tokenExpiresAt} (Erro 190). Reconecte a conta do Instagram.`;
      await TokenService.markAccountReconnectionRequired(tenant, msg);
      return {
        ok: false,
        tenant,
        errorMessage: msg,
        reconnectionRequired: true,
      };
    }

    const scopeCheck = hasRequiredInstagramScopes(tenant.grantedScopes);
    if (!scopeCheck.valid) {
      const msg = `A conta @${tenant.username} não concedeu as permissões obrigatórias (${scopeCheck.missingScopes.join(
        ', '
      )}). Reconecte o Instagram autorizando todos os escopos.`;
      return {
        ok: false,
        tenant,
        errorMessage: msg,
        reconnectionRequired: true,
      };
    }

    // Verifica se precisa de renovação preventiva antes de usar (<= 30 dias para expirar ou >= 30 dias desde emissão)
    const issuedAtMs = Date.parse(tenant.lastTokenRefreshAt || tenant.tokenIssuedAt || '');
    const expMs = tenant.tokenExpiresAt ? Date.parse(tenant.tokenExpiresAt) : 0;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    if (
      (!Number.isNaN(issuedAtMs) && nowMs - issuedAtMs >= thirtyDaysMs) ||
      (expMs > 0 && expMs - nowMs <= thirtyDaysMs)
    ) {
      await TokenService.refreshEligibleTokens({ nowMs, forceTenantId: tenant.id });
      const reloaded = await getInstagramAccountByIdOrUser(tenant.id);
      if (reloaded) {
        tenant = reloaded;
        plainToken = resolveAccountAccessToken(tenant, encKey);
      }
    }

    return {
      ok: Boolean(plainToken),
      tenant,
      accessToken: plainToken,
    };
  }

  /**
   * Job de manutenção e renovação preventiva de tokens longos no PostgreSQL:
   * - Consulta todas as contas no PostgreSQL (ou uma conta específica).
   * - Renova quando faltam 30 dias ou menos para expirar (ou >= 30 dias desde emissão).
   * - Usa GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=TOKEN_ATUAL.
   * - Realiza retentativas controladas em falhas temporárias sem perder o token atual.
   * - Bloqueia renovações concorrentes e não tenta renovar tokens já expirados.
   * - Persiste novos tokens criptografados com TOKEN_ENCRYPTION_KEY e nova data de expiração no PostgreSQL.
   */
  static async refreshEligibleTokens(options?: {
    nowMs?: number;
    forceTenantId?: string;
    maxRetries?: number;
    retryDelayMs?: number;
    accountsOverride?: TenantAccount[];
    onPersistAccount?: (tenant: TenantAccount) => Promise<void> | void;
    onReconnectionNeeded?: (tenant: TenantAccount, message: string) => Promise<void> | void;
  }): Promise<TokenRefreshJobSummary> {
    const nowMs = options?.nowMs ?? Date.now();
    const encKey = TokenService.getEncryptionKey();
    const accounts = options?.accountsOverride || (await listInstagramAccounts());

    const details: TokenRefreshJobSummary['details'] = [];
    let checked = 0;
    let refreshed = 0;
    let skippedRecent = 0;
    let skippedHealthy = 0;
    let markedReconnection = 0;
    let transientErrors = 0;

    for (const tenant of accounts) {
      if (options?.forceTenantId && tenant.id !== options.forceTenantId) {
        continue;
      }

      const plainToken = resolveAccountAccessToken(tenant, encKey);
      if (!plainToken) {
        continue;
      }

      checked++;

      let alertTriggered: Omit<AdminAlertNotification, 'id' | 'createdAt' | 'resolved'> | null =
        null;

      const res = await refreshAccountLongLivedToken({
        tenant,
        secretKey: encKey,
        forceIfEligible24h: Boolean(options?.forceTenantId),
        nowMs,
        maxRetries: options?.maxRetries,
        retryDelayMs: options?.retryDelayMs,
        onPersist: () => {},
        onAdminAlert: (alert) => {
          alertTriggered = alert;
        },
      });

      if (res.status === 'REFRESHED') {
        refreshed++;
        if (options?.onPersistAccount) {
          await options.onPersistAccount(tenant);
        } else {
          await upsertInstagramAccount(tenant);
        }
      } else if (res.status === 'SKIPPED_TOO_YOUNG_24H') {
        skippedRecent++;
      } else if (res.status === 'SKIPPED_NOT_DUE') {
        skippedHealthy++;
      } else if (
        res.status === 'EXPIRED_RECONNECT_REQUIRED' ||
        res.status === 'REVOKED_RECONNECT_REQUIRED' ||
        res.status === 'MISSING_TOKEN'
      ) {
        markedReconnection++;
        const reason =
          (alertTriggered as any)?.message ||
          (alertTriggered as any)?.mensagem ||
          res.message ||
          `Token expirado ou revogado para @${tenant.username}.`;
        if (options?.onReconnectionNeeded) {
          await options.onReconnectionNeeded(tenant, reason);
        } else {
          await TokenService.markAccountReconnectionRequired(tenant, reason);
        }
      } else if (res.status === 'TRANSIENT_FAILURE_KEPT_VALID_TOKEN') {
        transientErrors++;
      }

      details.push({
        tenantId: tenant.id,
        username: tenant.username,
        action: res.status,
        message: res.message,
        tokenExpiresAt: res.tokenExpiresAt,
        attemptsUsed: res.attemptsUsed,
      });
    }

    const summary: TokenRefreshJobSummary = {
      checked,
      refreshed,
      skippedRecent,
      skippedHealthy,
      markedReconnection,
      transientErrors,
      details,
    };

    if (!options?.accountsOverride) {
      await recordTokenRefreshRunInDb({
        runId: `${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
        executedAt: new Date(nowMs).toISOString(),
        ...summary,
      }).catch(() => {});
    }

    return summary;
  }
}
