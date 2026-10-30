import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptInstagramToken,
  decryptInstagramToken,
  resolveAccountAccessToken,
  exchangeShortForLongLivedInstagramToken,
  refreshAccountLongLivedToken,
  executeInstagramGraphPublish,
  setInstagramFetchOverride,
} from '../services/instagramCore';
import {
  acquirePostScheduleLock,
  processDueScheduledPosts,
  getSchedulerTestState,
  resetSchedulerTestState,
} from '../../server';
import { TenantAccount, PostGroup, DriveImageItem } from '../types';
import { convertSaoPauloToUtcIso, formatUtcToSaoPauloParts } from '../utils/postHelpers';

function createMockTenant(overrides: Partial<TenantAccount> = {}): TenantAccount {
  const { jwtSecret } = getSchedulerTestState();
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
  const rawToken = 'IGQVJ_VALID_LONG_LIVED_TOKEN_ATO_VC';
  return {
    id: 'acc_ato_vc',
    username: 'ato.vc',
    nome: '@ato.vc',
    instagramUserId: '17841400000012345',
    status: 'APROVADO',
    driveFolderName: 'Ato',
    driveFolderId: 'folder_ato_1',
    encryptedAccessToken: encryptInstagramToken(rawToken, jwtSecret),
    tokenType: 'LONG_LIVED',
    tokenIssuedAt: nowIso,
    tokenExpiresAt: expiresIso,
    grantedScopes: ['instagram_business_basic', 'instagram_business_content_publish'],
    connectionStatus: 'CONECTADO',
    hasValidToken: true,
    ...overrides,
  };
}

function createMockDriveItem(overrides: Partial<DriveImageItem> = {}): DriveImageItem {
  const nowIso = new Date().toISOString();
  return {
    driveFileId: 'file_ato_1',
    nome: 'post_1.jpg',
    categoria: 'Post Único',
    loteNome: 'post_1',
    viewUrl: 'https://cdn.atodev.com.br/post-1.jpg',
    thumbnailUrl: 'https://cdn.atodev.com.br/post-1.jpg',
    mimeType: 'image/jpeg',
    dataCriacao: nowIso,
    status: 'APROVADO',
    tenantId: 'acc_ato_vc',
    driveFolderName: 'Ato',
    pastaClienteNome: 'Ato',
    pastaClienteId: 'folder_ato_1',
    isApprovedForSchedule: true,
    approvedAt: nowIso,
    approvedBy: 'ato.vc',
    ...overrides,
  };
}

function createMockPost(overrides: Partial<PostGroup> = {}): PostGroup {
  const nowIso = new Date().toISOString();
  const defaultItem = createMockDriveItem();
  return {
    id: 'group_post_1',
    loteNome: 'post_1',
    categoria: 'Post Único',
    nome: 'Post Oficial ATO Social Hub',
    dataCriacao: nowIso,
    status: 'APROVADO',
    caption: 'Legenda oficial aprovada #atosocialhub',
    approvedAt: nowIso,
    approvedBy: 'ato.vc',
    isApprovedForSchedule: true,
    tenantId: 'acc_ato_vc',
    scheduledAccountId: 'acc_ato_vc',
    driveFolderName: 'Ato',
    pastaClienteNome: 'Ato',
    pastaClienteId: 'folder_ato_1',
    items: [defaultItem],
    ...overrides,
  };
}

test('Cenário 1: Troca de token curto por token longo (60 dias) + criptografia AES-256-GCM em repouso', async () => {
  const { jwtSecret } = getSchedulerTestState();
  setInstagramFetchOverride(async (url) => {
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://graph.instagram.com/access_token');
    assert.equal(u.searchParams.get('grant_type'), 'ig_exchange_token');
    assert.equal(u.searchParams.get('access_token'), 'SHORT_TOKEN_1H');

    return new Response(
      JSON.stringify({
        access_token: 'LONG_TOKEN_60_DAYS_REAL',
        token_type: 'bearer',
        expires_in: 5184000, // 60 dias
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  });

  try {
    const fixedNow = Date.parse('2026-04-01T12:00:00.000Z');
    const result = await exchangeShortForLongLivedInstagramToken({
      shortLivedToken: 'SHORT_TOKEN_1H',
      clientSecret: 'REAL_IG_APP_SECRET',
      nowMs: fixedNow,
    });

    assert.equal(result.ok, true);
    assert.equal(result.tokenType, 'LONG_LIVED');
    assert.equal(result.accessToken, 'LONG_TOKEN_60_DAYS_REAL');
    assert.equal(result.expiresInSeconds, 5184000);
    assert.equal(result.tokenIssuedAt, '2026-04-01T12:00:00.000Z');
    assert.equal(result.tokenExpiresAt, '2026-05-31T12:00:00.000Z');

    const encrypted = encryptInstagramToken(result.accessToken, jwtSecret);
    assert.ok(encrypted.startsWith('enc:v1:'));
    assert.equal(encrypted.includes('LONG_TOKEN_60_DAYS_REAL'), false);
    assert.equal(decryptInstagramToken(encrypted, jwtSecret), 'LONG_TOKEN_60_DAYS_REAL');
  } finally {
    setInstagramFetchOverride(null);
  }
});

test('Cenário 2: Renovação preventiva de token elegível (>= 30 dias) preservando validade', async () => {
  const { jwtSecret } = getSchedulerTestState();
  setInstagramFetchOverride(async (url) => {
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://graph.instagram.com/refresh_access_token');
    assert.equal(u.searchParams.get('grant_type'), 'ig_refresh_token');
    return new Response(
      JSON.stringify({
        access_token: 'RENEWED_LONG_TOKEN_60D',
        token_type: 'bearer',
        expires_in: 5184000,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  });

  try {
    const nowMs = Date.now();
    const issued35DaysAgo = new Date(nowMs - 35 * 24 * 60 * 60 * 1000).toISOString();
    const expiresIn25Days = new Date(nowMs + 25 * 24 * 60 * 60 * 1000).toISOString();

    const tenant = createMockTenant({
      tokenIssuedAt: issued35DaysAgo,
      tokenExpiresAt: expiresIn25Days,
    });

    let persistedCalled = false;
    const res = await refreshAccountLongLivedToken({
      tenant,
      secretKey: jwtSecret,
      nowMs,
      onPersist: () => {
        persistedCalled = true;
      },
      onAdminAlert: () => {},
    });

    assert.equal(res.status, 'REFRESHED');
    assert.equal(persistedCalled, true);
    assert.equal(tenant.connectionStatus, 'CONECTADO');
    assert.ok(tenant.lastTokenRefreshAt);
    assert.equal(resolveAccountAccessToken(tenant, jwtSecret), 'RENEWED_LONG_TOKEN_60D');
  } finally {
    setInstagramFetchOverride(null);
  }
});

test('Cenário 3: Bloqueio de renovação para token já expirado e proteção de token válido em falha transitória', async () => {
  const { jwtSecret } = getSchedulerTestState();
  const nowMs = Date.now();
  const expiredTenant = createMockTenant({
    id: 'acc_expired',
    tokenIssuedAt: new Date(nowMs - 65 * 24 * 60 * 60 * 1000).toISOString(),
    tokenExpiresAt: new Date(nowMs - 5 * 24 * 60 * 60 * 1000).toISOString(),
  });

  let alertTriggered = false;
  const expiredResult = await refreshAccountLongLivedToken({
    tenant: expiredTenant,
    secretKey: jwtSecret,
    nowMs,
    onPersist: () => {},
    onAdminAlert: () => {
      alertTriggered = true;
    },
  });

  assert.equal(expiredResult.status, 'EXPIRED_RECONNECT_REQUIRED');
  assert.equal(expiredTenant.connectionStatus, 'RECONEXAO_NECESSARIA');
  assert.equal(alertTriggered, true);

  // Agora testa falha transitória de rede (HTTP 500): NÃO deve sobrescrever o token válido existente
  setInstagramFetchOverride(async () => {
    return new Response(JSON.stringify({ error: { message: 'Temporary Meta Outage', code: 2 } }), {
      status: 500,
    });
  });

  try {
    const validOldToken = 'VALID_EXISTING_TOKEN_MUST_SURVIVE';
    const eligibleTenant = createMockTenant({
      id: 'acc_transient_refresh',
      encryptedAccessToken: encryptInstagramToken(validOldToken, jwtSecret),
      tokenIssuedAt: new Date(nowMs - 32 * 24 * 60 * 60 * 1000).toISOString(),
      tokenExpiresAt: new Date(nowMs + 28 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const transientRes = await refreshAccountLongLivedToken({
      tenant: eligibleTenant,
      secretKey: jwtSecret,
      nowMs,
      onPersist: () => {},
      onAdminAlert: () => {},
    });

    assert.equal(transientRes.status, 'TRANSIENT_FAILURE_KEPT_VALID_TOKEN');
    assert.equal(eligibleTenant.connectionStatus, 'CONECTADO');
    assert.equal(resolveAccountAccessToken(eligibleTenant, jwtSecret), validOldToken);
  } finally {
    setInstagramFetchOverride(null);
  }
});

test('Cenário 4: Publicação imediata de imagem única via graph.instagram.com/v21.0', async () => {
  const { jwtSecret } = getSchedulerTestState();
  const calledEndpoints: string[] = [];

  setInstagramFetchOverride(async (url, init) => {
    const u = new URL(url);
    calledEndpoints.push(`${init?.method || 'GET'} ${u.origin}${u.pathname}`);
    assert.equal(u.origin, 'https://graph.instagram.com');
    assert.ok(u.pathname.startsWith('/v21.0/'));

    if (u.pathname.endsWith('/media') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: '17895695668004550' }), { status: 200 });
    }
    if (u.pathname === '/v21.0/17895695668004550' && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ status_code: 'FINISHED', status: 'FINISHED' }), { status: 200 });
    }
    if (u.pathname.endsWith('/media_publish') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: '17920000111122223' }), { status: 200 });
    }
    if (u.pathname === '/v21.0/17920000111122223' && (!init?.method || init.method === 'GET')) {
      return new Response(
        JSON.stringify({
          id: '17920000111122223',
          permalink: 'https://www.instagram.com/p/C_ATO_SINGLE/',
          timestamp: '2026-05-10T15:00:00+0000',
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const tenant = createMockTenant();
    const post = createMockPost();

    const result = await executeInstagramGraphPublish({
      post,
      tenant,
      caption: post.caption || '',
      secretKey: jwtSecret,
      pollIntervalMs: 5,
      prepareMediaFn: async (_driveFileId, item) => ({
        ok: true,
        candidateUrls: [item.viewUrl],
      }),
      onMarkAccountReconnect: () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'PUBLISHED');
    assert.equal(result.containerId, '17895695668004550');
    assert.equal(result.instagramMediaId, '17920000111122223');
    assert.equal(result.permalink, 'https://www.instagram.com/p/C_ATO_SINGLE/');
    assert.ok(calledEndpoints.includes('POST https://graph.instagram.com/v21.0/17841400000012345/media'));
    assert.ok(calledEndpoints.includes('GET https://graph.instagram.com/v21.0/17895695668004550'));
    assert.ok(calledEndpoints.includes('POST https://graph.instagram.com/v21.0/17841400000012345/media_publish'));
  } finally {
    setInstagramFetchOverride(null);
  }
});

test('Cenário 5: Publicação imediata de carrossel (múltiplos itens) e vídeo/Reels com polling FINISHED', async () => {
  const { jwtSecret } = getSchedulerTestState();
  let containerSeq = 100;
  let pollCalls = 0;

  setInstagramFetchOverride(async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/media') && init?.method === 'POST') {
      containerSeq++;
      return new Response(JSON.stringify({ id: `container_${containerSeq}` }), { status: 200 });
    }
    if (u.pathname.startsWith('/v21.0/container_') && (!init?.method || init.method === 'GET')) {
      pollCalls++;
      const statusCode = pollCalls === 1 ? 'IN_PROGRESS' : 'FINISHED';
      return new Response(JSON.stringify({ status_code: statusCode, status: statusCode }), { status: 200 });
    }
    if (u.pathname.endsWith('/media_publish') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: `published_media_${containerSeq}` }), { status: 200 });
    }
    if (u.pathname.startsWith('/v21.0/published_media_')) {
      return new Response(
        JSON.stringify({
          id: `published_media_${containerSeq}`,
          permalink: 'https://www.instagram.com/p/C_ATO_MULTI/',
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const tenant = createMockTenant();
    const item1 = createMockDriveItem({
      driveFileId: 'c1',
      nome: '1.jpg',
      categoria: 'Carrossel',
      loteNome: 'lote_carrossel',
      viewUrl: 'https://cdn.atodev.com.br/1.jpg',
      mimeType: 'image/jpeg',
    });
    const item2 = createMockDriveItem({
      driveFileId: 'c2',
      nome: '2.mp4',
      categoria: 'Carrossel',
      loteNome: 'lote_carrossel',
      viewUrl: 'https://cdn.atodev.com.br/2.mp4',
      mimeType: 'video/mp4',
    });
    const carouselPost = createMockPost({
      id: 'post_carousel_1',
      categoria: 'Carrossel',
      items: [item1, item2],
    });

    const carouselRes = await executeInstagramGraphPublish({
      post: carouselPost,
      tenant,
      caption: 'Carrossel ATO',
      secretKey: jwtSecret,
      pollIntervalMs: 5,
      prepareMediaFn: async (_driveFileId, item) => ({
        ok: true,
        candidateUrls: [item.viewUrl],
      }),
      onMarkAccountReconnect: () => {},
    });

    assert.equal(carouselRes.ok, true);
    assert.equal(carouselRes.status, 'PUBLISHED');
    assert.equal(carouselRes.childContainerIds?.length, 2);
    assert.equal(carouselRes.containerId, 'container_103');
    assert.ok(pollCalls >= 2);
  } finally {
    setInstagramFetchOverride(null);
  }
});

test('Cenário 6: Bloqueio de publicação de post não aprovado', async () => {
  const tenant = createMockTenant();
  const unapprovedItem = createMockDriveItem({
    driveFileId: 'unapproved_file_1',
    loteNome: 'lote_unapproved',
    status: 'PENDENTE',
    isApprovedForSchedule: false,
    scheduledAt: new Date(Date.now() - 60_000).toISOString(),
  });

  resetSchedulerTestState({
    tenants: [tenant],
    rawDriveItems: [unapprovedItem],
  });

  const summary = await processDueScheduledPosts({ nowMs: Date.now(), pollIntervalMs: 5 });
  assert.equal(summary.publishedCount, 0);
  assert.equal(summary.skippedUnapprovedCount, 1);

  const state = getSchedulerTestState();
  assert.equal(state.postGroups[0].status, 'PENDENTE');
});

test('Cenário 7: Agendamento em America/Sao_Paulo (-03:00), conversão UTC e disparo automático no horário vencido', async () => {
  // Verifica conversão America/Sao_Paulo -> UTC
  const utcIso = convertSaoPauloToUtcIso('2026-05-15', '18:30');
  assert.equal(utcIso, '2026-05-15T21:30:00.000Z');
  const spParts = formatUtcToSaoPauloParts(utcIso);
  assert.deepEqual(spParts, { date: '2026-05-15', time: '18:30' });

  const tenant = createMockTenant();
  const dueScheduledUtc = new Date(Date.now() - 30_000).toISOString();
  const scheduledItem = createMockDriveItem({
    driveFileId: 'file_due_sp_1',
    loteNome: 'lote_due_sp_1',
    status: 'AGENDADO',
    caption: 'Post agendado em São Paulo',
    scheduledAt: dueScheduledUtc,
    scheduledTimezone: 'America/Sao_Paulo',
    scheduledAccountId: tenant.id,
    isApprovedForSchedule: true,
  });

  resetSchedulerTestState({
    tenants: [tenant],
    rawDriveItems: [scheduledItem],
  });

  setInstagramFetchOverride(async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/media') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'container_sched_sp_1' }), { status: 200 });
    }
    if (u.pathname === '/v21.0/container_sched_sp_1') {
      return new Response(JSON.stringify({ status_code: 'FINISHED', status: 'FINISHED' }), { status: 200 });
    }
    if (u.pathname.endsWith('/media_publish') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'ig_media_sched_sp_1' }), { status: 200 });
    }
    if (u.pathname === '/v21.0/ig_media_sched_sp_1') {
      return new Response(
        JSON.stringify({
          id: 'ig_media_sched_sp_1',
          permalink: 'https://www.instagram.com/p/C_ATO_SCHED_SP/',
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  try {
    const summary = await processDueScheduledPosts({ nowMs: Date.now(), pollIntervalMs: 5 });
    assert.equal(summary.publishedCount, 1);

    const state = getSchedulerTestState();
    const updatedPost = state.postGroups[0];
    assert.equal(updatedPost.status, 'PUBLICADO');
    assert.equal(updatedPost.instagramMediaId, 'ig_media_sched_sp_1');
    assert.equal(updatedPost.instagramPermalink, 'https://www.instagram.com/p/C_ATO_SCHED_SP/');
    assert.ok(updatedPost.publishedAt);
  } finally {
    setInstagramFetchOverride(null);
  }
});

test('Cenário 8: Prevenção de publicação duplicada quando 2 workers executam simultaneamente (lock transacional)', async () => {
  const tenant = createMockTenant();
  const lockItem = createMockDriveItem({
    driveFileId: 'file_lock_1',
    loteNome: 'lote_lock_1',
    status: 'AGENDADO',
    caption: 'Teste de concorrência',
    scheduledAt: new Date(Date.now() - 10_000).toISOString(),
    isApprovedForSchedule: true,
  });

  resetSchedulerTestState({
    tenants: [tenant],
    rawDriveItems: [lockItem],
  });

  const state = getSchedulerTestState();
  const postId = state.postGroups[0].id;
  const nowMs = Date.now();

  // Worker A adquire o lock transacional
  const lockWorkerA = acquirePostScheduleLock(postId, 'worker_A', nowMs);
  assert.equal(lockWorkerA.acquired, true);

  // Worker B tenta adquirir o lock no mesmo instante e é bloqueado
  const lockWorkerB = acquirePostScheduleLock(postId, 'worker_B', nowMs + 100);
  assert.equal(lockWorkerB.acquired, false);
});

test('Cenário 9: Recuperação de erro transitório com backoff exponencial e reconciliação anti-duplicidade', async () => {
  const tenant = createMockTenant();
  const transientItem = createMockDriveItem({
    driveFileId: 'file_tb_1',
    loteNome: 'lote_tb_1',
    status: 'AGENDADO',
    caption: 'Post com erro transitório na primeira tentativa',
    scheduledAt: new Date(Date.now() - 15_000).toISOString(),
    isApprovedForSchedule: true,
  });

  resetSchedulerTestState({
    tenants: [tenant],
    rawDriveItems: [transientItem],
  });

  // Simula erro 503 transitório na Meta na tentativa 1
  setInstagramFetchOverride(async () => {
    return new Response(
      JSON.stringify({
        error: { message: 'Service temporarily unavailable', type: 'IGApiException', code: 2, is_transient: true },
      }),
      { status: 503 }
    );
  });

  try {
    const baseNow = Date.now();
    const firstRun = await processDueScheduledPosts({ nowMs: baseNow, pollIntervalMs: 5 });
    assert.equal(firstRun.retryScheduledCount, 1);

    let state = getSchedulerTestState();
    const postAfterFirst = state.postGroups[0];
    assert.equal(postAfterFirst.status, 'AGENDADO'); // Mantido na fila com nextRetryAt
    assert.equal(postAfterFirst.publishAttempts, 1);
    assert.ok(postAfterFirst.nextRetryAt);
    assert.ok(Date.parse(postAfterFirst.nextRetryAt!) >= baseNow + 110_000);

    // Agora simula resposta ambígua no POST /media_publish mas reconciliação confirmando que a mídia já foi publicada na Meta
    setInstagramFetchOverride(async (url, init) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/media') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'container_reconcile_1' }), { status: 200 });
      }
      if (u.pathname === '/v21.0/container_reconcile_1') {
        return new Response(JSON.stringify({ status_code: 'FINISHED', status: 'FINISHED' }), { status: 200 });
      }
      if (u.pathname.endsWith('/media_publish') && init?.method === 'POST') {
        // Timeout / 502 ambíguo após publicar
        return new Response('Bad Gateway after publish', { status: 502 });
      }
      if (u.pathname.endsWith('/media') && (!init?.method || init.method === 'GET')) {
        // Reconciliação consulta mídias recentes da conta e encontra a postagem recém-publicada
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'reconciled_ig_media_999',
                caption: 'Post com erro transitório na primeira tentativa',
                permalink: 'https://www.instagram.com/p/C_RECONCILED_OK/',
                timestamp: new Date().toISOString(),
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const afterBackoffNow = Date.parse(postAfterFirst.nextRetryAt!) + 1000;
    const secondRun = await processDueScheduledPosts({ nowMs: afterBackoffNow, pollIntervalMs: 5 });
    assert.equal(secondRun.publishedCount, 1);

    state = getSchedulerTestState();
    const postAfterSecond = state.postGroups[0];
    assert.equal(postAfterSecond.status, 'PUBLICADO');
    assert.equal(postAfterSecond.instagramMediaId, 'reconciled_ig_media_999');
    assert.equal(postAfterSecond.instagramPermalink, 'https://www.instagram.com/p/C_RECONCILED_OK/');
  } finally {
    setInstagramFetchOverride(null);
  }
});

test('Cenário 10: Tratamento de erro 190 (OAuthException Session has expired) marcando RECONEXAO_NECESSARIA e preservando agendamentos', async () => {
  const tenant = createMockTenant();
  const originalScheduleIso = new Date(Date.now() - 5_000).toISOString();
  const item190 = createMockDriveItem({
    driveFileId: 'file_err_190',
    loteNome: 'lote_err_190',
    status: 'AGENDADO',
    caption: 'Post que encontra erro 190',
    scheduledAt: originalScheduleIso,
    isApprovedForSchedule: true,
  });

  resetSchedulerTestState({
    tenants: [tenant],
    rawDriveItems: [item190],
  });

  setInstagramFetchOverride(async () => {
    return new Response(
      JSON.stringify({
        error: {
          message: 'Error validating access token: Session has expired on Wednesday, 22-Oct-26 10:00:00 PDT.',
          type: 'OAuthException',
          code: 190,
          error_subcode: 463,
        },
      }),
      { status: 400 }
    );
  });

  try {
    const summary = await processDueScheduledPosts({ nowMs: Date.now(), pollIntervalMs: 5 });
    assert.equal(summary.reconnectionCount, 1);

    const state = getSchedulerTestState();
    const updatedTenant = state.tenants.find((t) => t.id === tenant.id)!;
    // Verifica que a conta foi marcada como RECONEXAO_NECESSARIA
    assert.equal(updatedTenant.connectionStatus, 'RECONEXAO_NECESSARIA');

    // Verifica que o agendamento foi preservado sem perda dos dados e marcado como RECONEXAO_NECESSARIA
    const updatedPost = state.postGroups[0];
    assert.equal(updatedPost.status, 'RECONEXAO_NECESSARIA');
    assert.equal(updatedPost.scheduledAt, originalScheduleIso);
    assert.ok(updatedPost.failureReason?.includes('Reconecte a conta do Instagram'));

    // Verifica que um alerta administrativo foi registrado
    assert.ok(state.adminAlerts.length >= 1);
    assert.equal(state.adminAlerts[0].tenantId, tenant.id);
  } finally {
    setInstagramFetchOverride(null);
  }
});
