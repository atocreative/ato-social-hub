import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { dbQuery } from '../db/pool.ts';
import { runDatabaseMigrations } from '../db/migrations.ts';
import {
  getInstagramAccountByIdOrUser,
  getPostGroupByIdFromDb,
  upsertPostGroupToDb,
} from '../db/repository.ts';
import { setInstagramFetchOverride } from './instagramCore.ts';
import { TokenService } from './TokenService.ts';
import { PublicationService } from './PublicationService.ts';
import { ScheduleService } from './ScheduleService.ts';
import { SchedulerWorker } from './SchedulerWorker.ts';
import { PostGroup } from '../types/index.ts';

const TEST_ACCOUNT_ID = 'tenant_test_worker_e2e';
const TEST_USERNAME = 'ato.worker.e2e';
const TEST_IG_USER_ID = '17841499999888777';
const TEST_POST_IMMEDIATE_ID = 'post_e2e_immediate_01';
const TEST_POST_SCHEDULED_ID = 'post_e2e_scheduled_02';
const TEST_POST_CONCURRENT_ID = 'post_e2e_concurrent_03';
const TEST_POST_EXPIRED_LOCK_ID = 'post_e2e_expired_lock_04';
const TEST_POST_ERR190_ID = 'post_e2e_err190_05';

async function cleanupTestArtifacts() {
  const testPostIds = [
    TEST_POST_IMMEDIATE_ID,
    TEST_POST_SCHEDULED_ID,
    TEST_POST_CONCURRENT_ID,
    TEST_POST_EXPIRED_LOCK_ID,
    TEST_POST_ERR190_ID,
  ];
  const testDriveIds = testPostIds.map((id) => `drive_${id}`);
  await dbQuery(`DELETE FROM posts WHERE id = ANY($1::varchar[])`, [testPostIds]);
  await dbQuery(`DELETE FROM media_assets WHERE drive_file_id = ANY($1::varchar[])`, [
    testDriveIds,
  ]);
  await dbQuery(`DELETE FROM operational_logs WHERE tenant_id = $1`, [TEST_ACCOUNT_ID]);
  await dbQuery(`DELETE FROM users WHERE instagram_account_id = $1`, [TEST_ACCOUNT_ID]);
  await dbQuery(`DELETE FROM instagram_accounts WHERE id = $1 OR username = $2`, [
    TEST_ACCOUNT_ID,
    TEST_USERNAME,
  ]);
}

function buildTestPost(params: {
  id: string;
  status: PostGroup['status'];
  scheduledAt?: string;
}): PostGroup {
  const nowIso = new Date().toISOString();
  return {
    id: params.id,
    loteNome: `Lote E2E ${params.id}`,
    nome: `${params.id}.jpg`,
    dataCriacao: nowIso,
    categoria: 'Post Único',
    status: params.status,
    tenantId: TEST_ACCOUNT_ID,
    scheduledAccountId: TEST_ACCOUNT_ID,
    pastaClienteNome: 'Ato',
    driveFolderName: 'Ato',
    caption: `Legenda oficial validada no PostgreSQL para ${params.id} #ato`,
    captionApproved: true,
    isApprovedForSchedule: true,
    approvedAt: nowIso,
    approvedBy: 'admin@atodev.com.br',
    scheduledAt: params.scheduledAt,
    scheduledTimezone: 'America/Sao_Paulo',
    publishAttempts: 0,
    items: [
      {
        driveFileId: `drive_${params.id}`,
        nome: `${params.id}.jpg`,
        loteNome: `Lote E2E ${params.id}`,
        pastaClienteNome: 'Ato',
        driveFolderName: 'Ato',
        categoria: 'Post Único',
        ordem: 1,
        viewUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1080&q=80',
        thumbnailUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1080&q=80',
        downloadUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1080&q=80',
        mimeType: 'image/jpeg',
        status: params.status,
        dataCriacao: nowIso,
      },
    ],
  };
}

describe('ATO Social Hub — Agendamento Independente de Hospedagem & Tokens no PostgreSQL Railway (Etapas 1 a 9)', () => {
  beforeAll(async () => {
    await runDatabaseMigrations();
    await cleanupTestArtifacts();
  });

  afterEach(() => {
    setInstagramFetchOverride(null);
  });

  afterAll(async () => {
    setInstagramFetchOverride(null);
    await cleanupTestArtifacts();
  });

  it('1. Inspeciona conta real @ato.vc no PostgreSQL Railway sem sobrescrever seus dados', async () => {
    const atoAccount = await getInstagramAccountByIdOrUser('ato.vc');
    expect(atoAccount).not.toBeNull();
    expect(atoAccount?.id).toBe('tenant_ato_vc');
    expect(atoAccount?.username).toBe('ato.vc');
  });

  it('2. Reconexão OAuth e persistência de token longo criptografado (AES-256-GCM) preservando ID primário da conta', async () => {
    // Cria conta inicialmente desconectada (simulando estado RECONEXAO_NECESSARIA como @ato.vc)
    await dbQuery(
      `INSERT INTO instagram_accounts (
         id, username, nome, instagram_user_id, status, connection_status,
         drive_folder_name, encrypted_access_token, has_valid_token
       ) VALUES ($1, $2, $3, $4, 'APROVADO', 'RECONEXAO_NECESSARIA', 'Ato', NULL, FALSE)`,
      [TEST_ACCOUNT_ID, TEST_USERNAME, 'ATO Test E2E', TEST_IG_USER_ID]
    );

    setInstagramFetchOverride(async (input) => {
      const url = String(input);
      if (url.includes('api.instagram.com/oauth/access_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'ig_short_token_e2e_123456',
            user_id: TEST_IG_USER_ID,
            permissions: ['instagram_business_basic', 'instagram_business_content_publish'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('grant_type=ig_exchange_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'IGQVJ_LONG_LIVED_60D_TOKEN_VALIDATED_999888777',
            token_type: 'bearer',
            expires_in: 5184000, // 60 dias
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/v21.0/me')) {
        return new Response(
          JSON.stringify({
            id: TEST_IG_USER_ID,
            user_id: TEST_IG_USER_ID,
            username: TEST_USERNAME,
            account_type: 'BUSINESS',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected URL in OAuth test: ${url}`);
    });

    const reconnected = await TokenService.authorizeAndPersistInstagramAccount({
      code: 'valid_oauth_code_from_meta',
      clientId: '1638364467693255',
      clientSecret: 'real_test_secret_1234567890',
      redirectUri: 'https://socialhub.atodev.com.br/api/auth/instagram/callback',
      preferredTenantId: TEST_ACCOUNT_ID,
    });

    expect(reconnected.ok).toBe(true);
    // Garante que o ID primário original foi preservado e nunca duplicado
    expect(reconnected.tenant?.id).toBe(TEST_ACCOUNT_ID);
    expect(reconnected.tenant?.connectionStatus).toBe('CONECTADO');
    expect(reconnected.tenant?.hasValidToken).toBe(true);
    expect(reconnected.tenant?.encryptedAccessToken).toMatch(/^enc:v1:/);

    // Confirma leitura direta do PostgreSQL Railway
    const fromDb = await getInstagramAccountByIdOrUser(TEST_ACCOUNT_ID);
    expect(fromDb?.id).toBe(TEST_ACCOUNT_ID);
    expect(fromDb?.connectionStatus).toBe('CONECTADO');
    expect(fromDb?.encryptedAccessToken).toMatch(/^enc:v1:/);

    const decrypted = TokenService.decrypt(fromDb!.encryptedAccessToken!);
    expect(decrypted).toBe('IGQVJ_LONG_LIVED_60D_TOKEN_VALIDATED_999888777');
  });

  it('3. Publicação imediata de imagem aprovada via PublicationService persistindo resultado no PostgreSQL', async () => {
    const post = buildTestPost({
      id: TEST_POST_IMMEDIATE_ID,
      status: 'APROVADO',
    });
    await upsertPostGroupToDb(post);

    const targetAccount = await getInstagramAccountByIdOrUser(TEST_ACCOUNT_ID);
    expect(targetAccount).not.toBeNull();

    setInstagramFetchOverride(async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/${TEST_IG_USER_ID}/media`) && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'container_imm_01' }), { status: 200 });
      }
      if (url.includes('/container_imm_01') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ id: 'container_imm_01', status_code: 'FINISHED' }), {
          status: 200,
        });
      }
      if (url.endsWith(`/${TEST_IG_USER_ID}/media_publish`) && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'ig_media_published_imm_01' }), { status: 200 });
      }
      if (url.includes('/ig_media_published_imm_01')) {
        return new Response(
          JSON.stringify({
            id: 'ig_media_published_imm_01',
            permalink: 'https://www.instagram.com/p/ATO_IMM_01/',
            timestamp: new Date().toISOString(),
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected Graph API URL: ${url}`);
    });

    const result = await PublicationService.publishPost({
      post,
      targetTenant: targetAccount!,
      caption: post.caption || '',
      origin: 'IMMEDIATE',
      pollIntervalMs: 5,
      persistToPostgres: true,
    });

    expect(result.ok).toBe(true);
    expect(result.instagramMediaId).toBe('ig_media_published_imm_01');
    expect(result.permalink).toBe('https://www.instagram.com/p/ATO_IMM_01/');

    const savedPost = await getPostGroupByIdFromDb(TEST_POST_IMMEDIATE_ID);
    expect(savedPost?.status).toBe('PUBLICADO');
    expect(savedPost?.instagramMediaId).toBe('ig_media_published_imm_01');
    expect(savedPost?.instagramPermalink).toBe('https://www.instagram.com/p/ATO_IMM_01/');
  });

  it('4, 5, 6 & 7. Agendamento persistido no PostgreSQL e publicado pelo SchedulerWorker independente sem navegador aberto', async () => {
    const dueIso = new Date(Date.now() - 10_000).toISOString(); // Agendamento vencido há 10s
    const scheduledPost = buildTestPost({
      id: TEST_POST_SCHEDULED_ID,
      status: 'AGENDADO',
      scheduledAt: dueIso,
    });
    await upsertPostGroupToDb(scheduledPost);

    // Simula reinício do servidor: lê diretamente do PostgreSQL via SchedulerWorker.runOnce
    setInstagramFetchOverride(async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/${TEST_IG_USER_ID}/media`) && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'container_sched_02' }), { status: 200 });
      }
      if (url.includes('/container_sched_02') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({ id: 'container_sched_02', status_code: 'FINISHED' }),
          { status: 200 }
        );
      }
      if (url.endsWith(`/${TEST_IG_USER_ID}/media_publish`) && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'ig_media_published_sched_02' }), { status: 200 });
      }
      if (url.includes('/ig_media_published_sched_02')) {
        return new Response(
          JSON.stringify({
            id: 'ig_media_published_sched_02',
            permalink: 'https://www.instagram.com/p/ATO_SCHED_02/',
            timestamp: new Date().toISOString(),
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected Graph API URL: ${url}`);
    });

    const cycleRes = await SchedulerWorker.runOnce({
      workerId: 'worker_standalone_test',
      pollIntervalMs: 5,
    });

    const processedThisPost = cycleRes.processedPosts.find(
      (r) => r.postId === TEST_POST_SCHEDULED_ID
    );
    expect(processedThisPost).toBeDefined();
    expect(processedThisPost?.status).toBe('PUBLICADO');
    expect(processedThisPost?.instagramMediaId).toBe('ig_media_published_sched_02');

    const postAfter = await getPostGroupByIdFromDb(TEST_POST_SCHEDULED_ID);
    expect(postAfter?.status).toBe('PUBLICADO');
    expect(postAfter?.instagramMediaId).toBe('ig_media_published_sched_02');
  });

  it('8. Duas execuções simultâneas do worker (FOR UPDATE SKIP LOCKED) nunca publicam o mesmo post duas vezes', async () => {
    const dueIso = new Date(Date.now() - 5_000).toISOString();
    const concurrentPost = buildTestPost({
      id: TEST_POST_CONCURRENT_ID,
      status: 'AGENDADO',
      scheduledAt: dueIso,
    });
    await upsertPostGroupToDb(concurrentPost);

    let mediaPublishCallCount = 0;

    setInstagramFetchOverride(async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/${TEST_IG_USER_ID}/media`) && init?.method === 'POST') {
        await new Promise((r) => setTimeout(r, 40));
        return new Response(JSON.stringify({ id: 'container_conc_03' }), { status: 200 });
      }
      if (url.includes('/container_conc_03') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({ id: 'container_conc_03', status_code: 'FINISHED' }),
          { status: 200 }
        );
      }
      if (url.endsWith(`/${TEST_IG_USER_ID}/media_publish`) && init?.method === 'POST') {
        mediaPublishCallCount++;
        return new Response(JSON.stringify({ id: 'ig_media_published_conc_03' }), { status: 200 });
      }
      if (url.includes('/ig_media_published_conc_03')) {
        return new Response(
          JSON.stringify({
            id: 'ig_media_published_conc_03',
            permalink: 'https://www.instagram.com/p/ATO_CONC_03/',
            timestamp: new Date().toISOString(),
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected Graph API URL: ${url}`);
    });

    // Dispara 2 workers concorrentes simultaneamente contra o PostgreSQL Railway
    const [resWorkerA, resWorkerB] = await Promise.all([
      SchedulerWorker.runOnce({
        workerId: 'worker_A_concurrent',
        pollIntervalMs: 5,
      }),
      SchedulerWorker.runOnce({
        workerId: 'worker_B_concurrent',
        pollIntervalMs: 5,
      }),
    ]);

    const allResultsForPost = [
      ...resWorkerA.processedPosts,
      ...resWorkerB.processedPosts,
    ].filter((r) => r.postId === TEST_POST_CONCURRENT_ID);
    const publishedResults = allResultsForPost.filter((r) => r.status === 'PUBLICADO');

    // Exatamente 1 worker deve ter publicado; o endpoint media_publish só pode ter sido chamado 1 vez!
    expect(publishedResults.length).toBe(1);
    expect(mediaPublishCallCount).toBe(1);

    const postAfter = await getPostGroupByIdFromDb(TEST_POST_CONCURRENT_ID);
    expect(postAfter?.status).toBe('PUBLICADO');
    expect(postAfter?.instagramMediaId).toBe('ig_media_published_conc_03');
  });

  it('9. Renovação preventiva de token elegível (TokenService.refreshEligibleTokens) atualiza token criptografado no PostgreSQL', async () => {
    // Configura o token da conta de teste para expirar em 5 dias (dentro da janela preventiva <= 15 dias)
    const issued45DaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const expiresIn5Days = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

    await dbQuery(
      `UPDATE instagram_accounts
       SET token_issued_at = $2::timestamptz,
           last_token_refresh_at = $2::timestamptz,
           token_expires_at = $3::timestamptz
       WHERE id = $1`,
      [TEST_ACCOUNT_ID, issued45DaysAgo, expiresIn5Days]
    );

    setInstagramFetchOverride(async (input) => {
      const url = String(input);
      if (url.includes('grant_type=ig_refresh_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'IGQVJ_REFRESHED_60D_NEW_TOKEN_555444333',
            token_type: 'bearer',
            expires_in: 5184000,
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL in refresh test: ${url}`);
    });

    const summary = await TokenService.refreshEligibleTokens({
      forceTenantId: TEST_ACCOUNT_ID,
    });

    const detail = summary.details.find((d) => d.tenantId === TEST_ACCOUNT_ID);
    expect(detail?.action).toBe('REFRESHED');

    const updatedAccount = await getInstagramAccountByIdOrUser(TEST_ACCOUNT_ID);
    const decryptedNew = TokenService.decrypt(updatedAccount!.encryptedAccessToken!);
    expect(decryptedNew).toBe('IGQVJ_REFRESHED_60D_NEW_TOKEN_555444333');
  });

  it('10. Comportamento quando token retorna OAuthException code 190: marca RECONEXAO_NECESSARIA sem apagar agendamentos', async () => {
    const dueIso = new Date(Date.now() - 15_000).toISOString();
    const err190Post = buildTestPost({
      id: TEST_POST_ERR190_ID,
      status: 'AGENDADO',
      scheduledAt: dueIso,
    });
    await upsertPostGroupToDb(err190Post);

    setInstagramFetchOverride(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Error validating access token: Session has expired.',
            type: 'OAuthException',
            code: 190,
            fbtrace_id: 'trace_err_190_test',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const cycleRes = await SchedulerWorker.runOnce({
      workerId: 'worker_err190_test',
      pollIntervalMs: 5,
    });

    const itemRes = cycleRes.processedPosts.find((r) => r.postId === TEST_POST_ERR190_ID);
    expect(itemRes?.status).toBe('RECONEXAO_NECESSARIA');

    const accountAfter = await getInstagramAccountByIdOrUser(TEST_ACCOUNT_ID);
    expect(accountAfter?.connectionStatus).toBe('RECONEXAO_NECESSARIA');

    const postAfter = await getPostGroupByIdFromDb(TEST_POST_ERR190_ID);
    expect(postAfter?.status).toBe('RECONEXAO_NECESSARIA');
    // O horário agendado permanece preservado para retomada após reconexão!
    expect(postAfter?.scheduledAt).toBeTruthy();
  });

  it('11. Recuperação de lock abandonado (> 5 min) e publicação de agendamento atrasado após reconexão', async () => {
    // Reconecta a conta primeiro
    await TokenService.persistValidatedAccountToken({
      username: TEST_USERNAME,
      nome: 'ATO Test E2E',
      instagramUserId: TEST_IG_USER_ID,
      plainAccessToken: 'IGQVJ_RECONNECTED_AFTER_190_TOKEN',
      tokenType: 'LONG_LIVED',
      tokenIssuedAt: new Date().toISOString(),
      tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      grantedScopes: ['instagram_business_basic', 'instagram_business_content_publish'],
      preferredTenantId: TEST_ACCOUNT_ID,
    });

    // Verifica que o post TEST_POST_ERR190_ID voltou automaticamente para AGENDADO ao reconectar
    const restoredPost = await getPostGroupByIdFromDb(TEST_POST_ERR190_ID);
    expect(restoredPost?.status).toBe('AGENDADO');

    // Cria também um post travado em PUBLICANDO com lock_expires_at vencido há 10 minutos
    const expiredLockPost = buildTestPost({
      id: TEST_POST_EXPIRED_LOCK_ID,
      status: 'PUBLICANDO',
      scheduledAt: new Date(Date.now() - 600_000).toISOString(),
    });
    expiredLockPost.publishLock = {
      workerId: 'crashed_worker_old',
      lockedAt: new Date(Date.now() - 900_000).toISOString(),
      expiresAt: new Date(Date.now() - 600_000).toISOString(),
    };
    await upsertPostGroupToDb(expiredLockPost);

    setInstagramFetchOverride(async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/${TEST_IG_USER_ID}/media`) && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'container_rec_04' }), { status: 200 });
      }
      if (url.includes('/container_rec_04')) {
        return new Response(JSON.stringify({ id: 'container_rec_04', status_code: 'FINISHED' }), {
          status: 200,
        });
      }
      if (url.endsWith(`/${TEST_IG_USER_ID}/media_publish`) && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'ig_media_rec_04' }), { status: 200 });
      }
      if (url.includes('/ig_media_rec_04')) {
        return new Response(
          JSON.stringify({
            id: 'ig_media_rec_04',
            permalink: 'https://www.instagram.com/p/ATO_REC_04/',
            timestamp: new Date().toISOString(),
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const cycleRes = await SchedulerWorker.runOnce({
      workerId: 'worker_recovery_test',
      pollIntervalMs: 5,
    });

    expect(cycleRes.recoveredStaleLocksCount).toBeGreaterThanOrEqual(1);

    const recoveredPostAfter = await getPostGroupByIdFromDb(TEST_POST_EXPIRED_LOCK_ID);
    expect(recoveredPostAfter?.status).toBe('PUBLICADO');
    expect(recoveredPostAfter?.instagramMediaId).toBe('ig_media_rec_04');

    const err190PostAfter = await getPostGroupByIdFromDb(TEST_POST_ERR190_ID);
    expect(err190PostAfter?.status).toBe('PUBLICADO');
  }, 30000);
});
