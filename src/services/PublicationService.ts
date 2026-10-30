import {
  addAdminAlertInDb,
  getInstagramAccountByIdOrUser,
  getPostGroupByIdFromDb,
  getTokenEncryptionKey,
  listInstagramAccounts,
  recordPublicationAttemptAndOutcomeInDb,
} from '../db/repository.ts';
import { DriveImageItem, PostGroup, PostStatus, TenantAccount, UserProfile } from '../types/index.ts';
import { executeInstagramGraphPublish } from './instagramCore.ts';
import { TokenService } from './TokenService.ts';

// Cache em memória dos buffers de imagens baixadas do Google Drive (quando o processo web também serve o media-proxy)
const mediaBufferCache = new Map<
  string,
  { buffer: Buffer; contentType: string; resolvedCdnUrl: string; updatedAt: number }
>();

export interface PreparedDriveMedia {
  ok: boolean;
  primaryImageUrl: string;
  candidateUrls: string[];
  bufferSize: number;
  contentType: string;
  errorMessage?: string;
}

export interface PublishExecutionOutcome {
  ok: boolean;
  httpStatus: number;
  post: PostGroup;
  creationId?: string;
  childContainerIds?: string[];
  instagramMediaId?: string;
  permalink?: string;
  error?: string;
  step?: string;
  isError190?: boolean;
  isTransientError?: boolean;
  metaError?: any;
}

/**
 * PublicationService — Núcleo de publicação na API do Instagram independente de hospedagem.
 *
 * Pode ser executado pelo servidor HTTP (Cloud Run / Railway Web) ou por um Worker separado
 * (Railway Worker / CLI) sem depender de navegador aberto, sistema de arquivos local ou objeto Request.
 */
export class PublicationService {
  static getCachedMediaBuffer(cleanFileId: string) {
    return mediaBufferCache.get(cleanFileId);
  }

  static setCachedMediaBuffer(
    cleanFileId: string,
    data: { buffer: Buffer; contentType: string; resolvedCdnUrl: string; updatedAt: number }
  ) {
    mediaBufferCache.set(cleanFileId, data);
  }

  /**
   * Prepara e valida URLs de mídia do Google Drive para envio à API do Instagram.
   * Resolve a URL direta do CDN do Google (lh3.googleusercontent.com) seguindo redirecionamentos
   * reais sem exigir pastas públicas nem depender de disco local do servidor.
   */
  static async prepareDriveMediaForInstagram(
    driveFileId: string,
    fallbackItem?: DriveImageItem,
    publicBaseUrl?: string
  ): Promise<PreparedDriveMedia> {
    const cleanFileId = String(driveFileId || '')
      .replace(/\.(jpg|jpeg|png)$/i, '')
      .trim();

    if (!cleanFileId) {
      return {
        ok: false,
        primaryImageUrl: '',
        candidateUrls: [],
        bufferSize: 0,
        contentType: 'image/jpeg',
        errorMessage: 'Identificador do arquivo de mídia (driveFileId) ausente.',
      };
    }

    const highResThumbUrl = `https://drive.google.com/thumbnail?id=${encodeURIComponent(
      cleanFileId
    )}&sz=w1600`;
    const directDownloadUrl =
      fallbackItem?.downloadUrl ||
      `https://drive.google.com/uc?export=download&id=${encodeURIComponent(cleanFileId)}`;
    const googleUserContentUrl = `https://lh3.googleusercontent.com/d/${encodeURIComponent(
      cleanFileId
    )}=w1600`;

    const configuredBaseUrl = String(
      publicBaseUrl ||
        process.env.APP_URL ||
        process.env.APP_BASE_URL ||
        'https://ato-social-hub.ai.studio'
    )
      .trim()
      .replace(/\/+$/, '');

    const localProxyUrl = `${configuredBaseUrl}/api/instagram/media-proxy/${encodeURIComponent(
      cleanFileId
    )}.jpg`;

    let resolvedCdnUrl = googleUserContentUrl;
    let bufferSize = 0;
    let contentType = 'image/jpeg';

    const isSyntheticTestFile =
      cleanFileId.startsWith('drive_') || cleanFileId.startsWith('upload_');
    const candidateFetchUrls = isSyntheticTestFile ? [] : [highResThumbUrl, directDownloadUrl];
    for (const fetchUrl of candidateFetchUrls) {
      try {
        const resp = await fetch(fetchUrl, { redirect: 'follow' });
        const ct = resp.headers.get('content-type') || '';
        if (resp.ok && ct.startsWith('image/')) {
          const arrBuf = await resp.arrayBuffer();
          const buf = Buffer.from(arrBuf);
          if (buf.length > 0) {
            bufferSize = buf.length;
            contentType = ct;
            if (resp.url && resp.url.startsWith('http') && !resp.url.includes('ServiceLogin')) {
              resolvedCdnUrl = resp.url;
            }
            mediaBufferCache.set(cleanFileId, {
              buffer: buf,
              contentType: ct,
              resolvedCdnUrl,
              updatedAt: Date.now(),
            });
            break;
          }
        }
      } catch {
        // Ignora erro de rede em URL candidata e tenta a próxima
      }
    }

    const candidateUrls = Array.from(
      new Set(
        [
          resolvedCdnUrl,
          googleUserContentUrl,
          highResThumbUrl,
          localProxyUrl,
          fallbackItem?.thumbnailUrl,
          fallbackItem?.viewUrl,
        ].filter((u): u is string => Boolean(u && u.startsWith('http')))
      )
    );

    return {
      ok: candidateUrls.length > 0,
      primaryImageUrl: candidateUrls[0] || highResThumbUrl,
      candidateUrls,
      bufferSize,
      contentType,
    };
  }

  /**
   * Verifica se uma conta Instagram pertence à mesma empresa/pasta de um post.
   * Impede que uma publicação de uma empresa utilize o token/conta de outra empresa.
   */
  static isAccountCompatibleWithPostCompany(
    account: TenantAccount,
    targetPost: PostGroup
  ): boolean {
    const postFolder = (targetPost.pastaClienteNome || targetPost.driveFolderName || '')
      .trim()
      .toLowerCase();
    const accFolder = (account.driveFolderName || '').trim().toLowerCase();

    if (
      targetPost.companyId &&
      account.companyId &&
      targetPost.companyId !== account.companyId
    ) {
      return false;
    }

    if (
      targetPost.pastaClienteId &&
      account.driveFolderId &&
      targetPost.pastaClienteId !== account.driveFolderId &&
      postFolder &&
      accFolder &&
      postFolder !== accFolder
    ) {
      return false;
    }

    if (
      postFolder &&
      postFolder !== 'ato social midia' &&
      accFolder &&
      accFolder !== 'ato social midia' &&
      postFolder !== accFolder
    ) {
      return false;
    }

    return true;
  }

  /**
   * Localiza a conta Instagram responsável pela publicação a partir do PostgreSQL
   * (ou de uma lista em memória fornecida para testes).
   * - Nunca utiliza tokens fixos do .env.
   * - Nunca publica em conta diferente da selecionada (requestedAccountId ou scheduledAccountId).
   * - Nunca utiliza conta de outra empresa (isolamento multi-tenant estrito).
   */
  static async resolveAccountForPost(
    targetPost: PostGroup,
    requestedAccountId?: string | null,
    reqUser?: UserProfile,
    accountsListOverride?: TenantAccount[]
  ): Promise<TenantAccount | undefined> {
    const accounts = accountsListOverride || (await listInstagramAccounts());

    // 1. Se uma conta foi explicitamente selecionada, DEVE corresponder a ela e pertencer à mesma empresa
    if (requestedAccountId && requestedAccountId.trim()) {
      const cleanReq = requestedAccountId.replace(/^@/, '').trim().toLowerCase();
      const byExplicit = accounts.find(
        (t) =>
          t.id === requestedAccountId ||
          t.instagramUserId === requestedAccountId ||
          t.username.toLowerCase() === cleanReq
      );
      if (!byExplicit) {
        return undefined;
      }
      if (!PublicationService.isAccountCompatibleWithPostCompany(byExplicit, targetPost)) {
        return undefined;
      }
      if (
        reqUser &&
        reqUser.role === 'TENANT' &&
        reqUser.tenantId &&
        byExplicit.id !== reqUser.tenantId
      ) {
        const userFolder = (reqUser.driveFolderName || '').trim().toLowerCase();
        const accFolder = (byExplicit.driveFolderName || '').trim().toLowerCase();
        if (!userFolder || !accFolder || userFolder !== accFolder) {
          return undefined;
        }
      }
      return byExplicit;
    }

    // 2. Se o post possui conta agendada definida, utiliza exclusivamente essa conta
    if (targetPost.scheduledAccountId) {
      const bySched = accounts.find(
        (t) =>
          t.id === targetPost.scheduledAccountId ||
          t.instagramUserId === targetPost.scheduledAccountId
      );
      if (!bySched) {
        return undefined;
      }
      if (!PublicationService.isAccountCompatibleWithPostCompany(bySched, targetPost)) {
        return undefined;
      }
      return bySched;
    }

    // 3. Conta vinculada diretamente ao tenantId do post
    if (targetPost.tenantId) {
      const byTenant = accounts.find((t) => t.id === targetPost.tenantId);
      if (
        byTenant &&
        PublicationService.isAccountCompatibleWithPostCompany(byTenant, targetPost)
      ) {
        return byTenant;
      }
    }

    // 4. Conta vinculada à mesma empresa/pasta do Google Drive do post
    const postFolder = (targetPost.pastaClienteNome || targetPost.driveFolderName || '')
      .trim()
      .toLowerCase();
    if (targetPost.companyId || targetPost.pastaClienteId || (postFolder && postFolder !== 'ato social midia')) {
      const matchingCompanyAccounts = accounts.filter(
        (t) =>
          (targetPost.companyId && t.companyId === targetPost.companyId) ||
          (targetPost.pastaClienteId && t.driveFolderId === targetPost.pastaClienteId) ||
          (postFolder && t.driveFolderName && t.driveFolderName.toLowerCase() === postFolder)
      );
      const connectedMatch = matchingCompanyAccounts.find((t) =>
        Boolean(t.encryptedAccessToken || t.accessToken || t.access_token)
      );
      return connectedMatch || matchingCompanyAccounts[0];
    }

    // 5. Conta do usuário autenticado (quando TENANT)
    if (reqUser?.tenantId) {
      const byUser = accounts.find((t) => t.id === reqUser.tenantId);
      if (byUser && PublicationService.isAccountCompatibleWithPostCompany(byUser, targetPost)) {
        return byUser;
      }
    }

    return undefined;
  }

  /**
   * Executa a publicação de um PostGroup na Meta Graph API (imediata ou via agendador)
   * e persiste todas as transições, tentativas e histórico no PostgreSQL.
   */
  static async publishPost(params: {
    post: PostGroup;
    targetTenant?: TenantAccount;
    caption: string;
    origin: 'IMMEDIATE' | 'SCHEDULER';
    publicBaseUrl?: string;
    pollIntervalMs?: number;
    nowMs?: number;
    persistToPostgres?: boolean;
    onMarkAccountReconnect?: (tenant: TenantAccount, errorMsg: string) => Promise<void> | void;
  }): Promise<PublishExecutionOutcome> {
    const {
      post: targetPost,
      caption,
      origin,
      publicBaseUrl,
      pollIntervalMs,
      persistToPostgres = true,
    } = params;

    const baseNowMs = params.nowMs ?? Date.now();
    const nowIso = new Date(baseNowMs).toISOString();
    const attemptNumber = (targetPost.publishAttempts || 0) + 1;
    const encKey = getTokenEncryptionKey();

    let tenant = params.targetTenant;
    if (persistToPostgres) {
      if (tenant) {
        // Garante que a publicação SEMPRE utilize o token mais recente armazenado no PostgreSQL
        const freshFromDb = await getInstagramAccountByIdOrUser(tenant.id);
        if (freshFromDb) {
          tenant = freshFromDb;
        }
      } else {
        tenant = await PublicationService.resolveAccountForPost(targetPost);
      }
    }

    if (!tenant) {
      const errMsg =
        'Nenhuma conta do Instagram conectada foi encontrada para esta publicação. Conecte a conta via OAuth antes de publicar.';
      const updatedPost: PostGroup = {
        ...targetPost,
        status: 'FALHA_PUBLICACAO',
        caption: caption || targetPost.caption || '',
        publishAttempts: attemptNumber,
        lastAttemptAt: nowIso,
        failureReason: errMsg,
        publishLock: null,
        items: targetPost.items.map((it) => ({ ...it, status: 'FALHA_PUBLICACAO' })),
      };

      return {
        ok: false,
        httpStatus: 400,
        post: updatedPost,
        error: errMsg,
        step: 'TOKEN_VALIDATION',
      };
    }

    // Se o token estiver com 30 dias ou menos para expirar (ou >= 30 dias de idade), faz renovação preventiva antes de publicar
    const issuedAtMs = Date.parse(tenant.lastTokenRefreshAt || tenant.tokenIssuedAt || '');
    const expMs = tenant.tokenExpiresAt ? Date.parse(tenant.tokenExpiresAt) : 0;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    if (
      (expMs > 0 && expMs - baseNowMs <= thirtyDaysMs && expMs > baseNowMs) ||
      (!Number.isNaN(issuedAtMs) && baseNowMs - issuedAtMs >= thirtyDaysMs)
    ) {
      if (persistToPostgres) {
        await TokenService.refreshEligibleTokens({ nowMs: baseNowMs, forceTenantId: tenant.id });
        const reloaded = await getInstagramAccountByIdOrUser(tenant.id);
        if (reloaded) tenant = reloaded;
      }
    }

    let reconnectTriggeredMsg: string | null = null;

    const publishRes = await executeInstagramGraphPublish({
      post: targetPost,
      tenant,
      caption: caption || '',
      secretKey: encKey,
      pollIntervalMs,
      prepareMediaFn: async (driveFileId, item) => {
        const prepared = await PublicationService.prepareDriveMediaForInstagram(
          driveFileId,
          item,
          publicBaseUrl
        );
        return {
          ok: prepared.ok,
          candidateUrls: prepared.candidateUrls,
          errorMessage: prepared.errorMessage,
        };
      },
      onMarkAccountReconnect: (t, msg) => {
        reconnectTriggeredMsg = msg;
        if (params.onMarkAccountReconnect) {
          params.onMarkAccountReconnect(t, msg);
        }
      },
    });

    if (reconnectTriggeredMsg && persistToPostgres && !params.onMarkAccountReconnect) {
      await TokenService.markAccountReconnectionRequired(tenant, reconnectTriggeredMsg);
    }

    const finishedIso = new Date().toISOString();

    if (publishRes.ok && publishRes.instagramMediaId) {
      const updatedItems = targetPost.items.map((item) => ({
        ...item,
        status: 'PUBLICADO' as const,
        publishedAt: publishRes.publishedAt || finishedIso,
        instagramMediaId: publishRes.instagramMediaId,
        instagramContainerId: publishRes.containerId,
        childContainerIds: publishRes.childContainerIds,
        instagramPermalink: publishRes.permalink || undefined,
      }));

      const updatedPost: PostGroup = {
        ...targetPost,
        status: 'PUBLICADO',
        tenantId: tenant.id,
        scheduledAccountId: tenant.id,
        caption: caption || targetPost.caption || '',
        publishedAt: publishRes.publishedAt || finishedIso,
        instagramContainerId: publishRes.containerId,
        childContainerIds: publishRes.childContainerIds,
        instagramMediaId: publishRes.instagramMediaId,
        instagramPermalink: publishRes.permalink || undefined,
        publishAttempts: attemptNumber,
        lastAttemptAt: nowIso,
        nextRetryAt: null,
        failureReason: null,
        publishLock: null,
        publishHistory: [...(targetPost.publishHistory || []), publishRes.attemptRecord],
        items: updatedItems,
      };

      if (persistToPostgres) {
        await recordPublicationAttemptAndOutcomeInDb({
          postId: targetPost.id,
          tenant,
          origin,
          caption: caption || targetPost.caption || '',
          ok: true,
          finalStatus: 'PUBLICADO',
          attemptRecord: publishRes.attemptRecord,
          containerId: publishRes.containerId,
          childContainerIds: publishRes.childContainerIds,
          instagramMediaId: publishRes.instagramMediaId,
          permalink: publishRes.permalink,
          publishedAt: publishRes.publishedAt || finishedIso,
          nextRetryAt: null,
          failureReason: null,
        });
      }

      return {
        ok: true,
        httpStatus: 200,
        post: updatedPost,
        creationId: publishRes.containerId,
        childContainerIds: publishRes.childContainerIds,
        instagramMediaId: publishRes.instagramMediaId,
        permalink: publishRes.permalink,
      };
    }

    // Tratamento de falha (Erro 190 de autenticação vs erro transitório vs erro permanente)
    const errMsg = publishRes.errorMessage || 'Falha ao publicar conteúdo na API do Instagram.';
    const isError190 = publishRes.status === 'AUTH_ERROR_190';
    const isTransientError = publishRes.status === 'TRANSIENT_ERROR';

    if (isError190 && persistToPostgres && !params.onMarkAccountReconnect) {
      await TokenService.markAccountReconnectionRequired(tenant, errMsg);
    }

    const MAX_SCHEDULER_ATTEMPTS = 3;
    const shouldScheduleRetry =
      origin === 'SCHEDULER' &&
      !isError190 &&
      isTransientError &&
      attemptNumber < MAX_SCHEDULER_ATTEMPTS;

    const backoffMs = Math.pow(2, attemptNumber) * 60 * 1000; // 2 min, 4 min...
    const nextRetryIso = shouldScheduleRetry ? new Date(baseNowMs + backoffMs).toISOString() : null;

    const finalStatus: PostStatus = isError190
      ? 'RECONEXAO_NECESSARIA'
      : shouldScheduleRetry
      ? 'AGENDADO'
      : 'FALHA_PUBLICACAO';

    const updatedPost: PostGroup = {
      ...targetPost,
      status: finalStatus,
      caption: caption || targetPost.caption || '',
      instagramContainerId: publishRes.containerId || targetPost.instagramContainerId,
      childContainerIds: publishRes.childContainerIds || targetPost.childContainerIds,
      publishAttempts: attemptNumber,
      lastAttemptAt: nowIso,
      nextRetryAt: nextRetryIso,
      failureReason: errMsg,
      publishLock: null,
      publishHistory: [...(targetPost.publishHistory || []), publishRes.attemptRecord],
      items: targetPost.items.map((it) => ({ ...it, status: finalStatus })),
    };

    if (persistToPostgres) {
      if (finalStatus === 'FALHA_PUBLICACAO') {
        await addAdminAlertInDb({
          type: 'FALHA_PUBLICACAO',
          tenantId: tenant.id,
          username: tenant.username,
          postId: targetPost.id,
          message: `Falha na publicação de "${targetPost.nome}" (@${tenant.username}): ${errMsg}`,
        });
      }

      await recordPublicationAttemptAndOutcomeInDb({
        postId: targetPost.id,
        tenant,
        origin,
        caption: caption || targetPost.caption || '',
        ok: false,
        finalStatus,
        attemptRecord: publishRes.attemptRecord,
        containerId: publishRes.containerId,
        childContainerIds: publishRes.childContainerIds,
        nextRetryAt: nextRetryIso,
        failureReason: errMsg,
      });
    }

    return {
      ok: false,
      httpStatus: 400,
      post: updatedPost,
      creationId: publishRes.containerId,
      childContainerIds: publishRes.childContainerIds,
      error: errMsg,
      step: (publishRes.attemptRecord as any)?.step || publishRes.status,
      isError190,
      isTransientError,
      metaError: publishRes.metaError,
    };
  }
}
