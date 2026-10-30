import 'dotenv/config';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import jwt from 'jsonwebtoken';
import { app, ensurePostgresBootstrapped } from '../../server.ts';
import { dbQuery } from '../db/pool.ts';
import { getInstagramAccountByIdOrUser, upsertPostGroupToDb } from '../db/repository.ts';
import { setInstagramFetchOverride } from './instagramCore.ts';
import { TokenService } from './TokenService.ts';
import { PublicationService } from './PublicationService.ts';
import { ScheduleService } from './ScheduleService.ts';
import { SchedulerWorker } from './SchedulerWorker.ts';

describe('ATO Social Hub — SaaS Multiusuário, Multiempresa e Ciclo Automático OAuth Instagram (Seção 7)', () => {
  const createdAccountIds: string[] = [];
  const createdPostIds: string[] = [];
  let server: http.Server;
  let baseUrl = '';

  async function apiReq(
    path: string,
    options?: { method?: string; token?: string; body?: any }
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options?.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method: options?.method || 'GET',
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  beforeAll(async () => {
    await ensurePostgresBootstrapped();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  afterEach(async () => {
    setInstagramFetchOverride(null);
    for (const postId of createdPostIds.splice(0)) {
      await dbQuery(`DELETE FROM posts WHERE id = $1`, [postId]).catch(() => {});
      await dbQuery(`DELETE FROM media_assets WHERE drive_file_id = $1`, [`file_${postId}`]).catch(() => {});
    }
    for (const accId of createdAccountIds.splice(0)) {
      await dbQuery(`DELETE FROM instagram_accounts WHERE id = $1`, [accId]).catch(() => {});
    }
  });

  it('1 & 2. Conexão de @ato.vc e persistência automática de token longo criptografado no PostgreSQL (sem nunca expor token ao frontend)', async () => {
    setInstagramFetchOverride(async (url, init) => {
      const urlStr = String(url);
      if (urlStr === 'https://api.instagram.com/oauth/access_token' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            access_token: 'IGQ_SHORT_ATO_VC_SAAS_001',
            user_id: '17841400001112220',
            permissions: ['instagram_business_basic', 'instagram_business_content_publish'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (urlStr.includes('https://graph.instagram.com/access_token?grant_type=ig_exchange_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'IGQ_LONG_60D_ATO_VC_SAAS_SECRET_TOKEN_999',
            token_type: 'bearer',
            expires_in: 5184000, // 60 dias
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (urlStr.includes('https://graph.instagram.com/v21.0/me')) {
        return new Response(
          JSON.stringify({
            id: '17841400001112220',
            user_id: '17841400001112220',
            username: 'ato.vc',
            account_type: 'MEDIA_CREATOR',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    });

    const connectResult = await TokenService.authorizeAndPersistInstagramAccount({
      code: 'oauth_code_ato_vc_saas_1',
      clientId: '954242347109139',
      clientSecret: 'test_secret_ato',
      redirectUri: 'https://ato-social-hub.ai.studio/api/auth/instagram/callback',
      preferredTenantId: 'tenant_ato_vc',
      driveFolderName: 'Ato',
    });

    expect(connectResult.ok).toBe(true);
    expect(connectResult.tokenType).toBe('LONG_LIVED');
    expect(connectResult.tenant?.id).toBe('tenant_ato_vc');
    expect(connectResult.tenant?.username).toBe('ato.vc');
    expect(connectResult.tenant?.connectionStatus).toBe('CONECTADO');

    // Verifica persistência criptografada no PostgreSQL
    const dbRow = await dbQuery<any>(
      `SELECT id, username, encrypted_access_token, token_type, token_expires_at, connection_status, drive_folder_name
       FROM instagram_accounts WHERE id = 'tenant_ato_vc'`
    );
    expect(dbRow.rows.length).toBe(1);
    const row = dbRow.rows[0];
    expect(row.encrypted_access_token).toMatch(/^enc:v1:/);
    expect(row.encrypted_access_token).not.toContain('IGQ_LONG_60D_ATO_VC_SAAS_SECRET_TOKEN_999');
    expect(row.token_type).toBe('LONG_LIVED');
    expect(row.connection_status).toBe('CONECTADO');

    // Descriptografia apenas no backend com TOKEN_ENCRYPTION_KEY
    const decrypted = TokenService.decrypt(row.encrypted_access_token);
    expect(decrypted).toBe('IGQ_LONG_60D_ATO_VC_SAAS_SECRET_TOKEN_999');

    // Garante que nenhuma rota de API envia encryptedAccessToken ou accessToken para o frontend
    const jwtSecret = String(process.env.JWT_SECRET || 'ato_super_secret_key_2026_998877').trim();
    const adminToken = jwt.sign(
      { id: 'admin_1', nome: 'Admin ATO', email: 'admin@atodev.com.br', role: 'ADMIN' },
      jwtSecret,
      { expiresIn: '1h' }
    );

    const tenantsRes = await apiReq('/api/tenants', { token: adminToken });
    expect(tenantsRes.status).toBe(200);
    const atoInList = tenantsRes.body.tenants.find((t: any) => t.id === 'tenant_ato_vc');
    expect(atoInList).toBeDefined();
    expect(atoInList.encryptedAccessToken).toBeUndefined();
    expect(atoInList.accessToken).toBeUndefined();
    expect(atoInList.access_token).toBeUndefined();
    expect(atoInList.hasValidToken).toBe(true);
  });

  it('3. Publicação imediata validando conta ativa, permissões, conteúdo aprovado, mídia acessível e token utilizável', async () => {
    const postId = `post_saas_imm_${Date.now()}`;
    createdPostIds.push(postId);

    const rejectedPostObj = {
      id: postId,
      nome: 'Post SaaS Imediato @ato.vc',
      loteNome: 'Lote SaaS Imediato',
      categoria: 'Post Único' as const,
      status: 'REPROVADO' as const,
      tenantId: 'tenant_ato_vc',
      scheduledAccountId: 'tenant_ato_vc',
      driveFolderName: 'Ato',
      pastaClienteNome: 'Ato',
      pastaClienteId: 'folder_ato_01',
      caption: 'Legenda reprovada não deve publicar',
      isApprovedForSchedule: false,
      captionApproved: false,
      dataCriacao: new Date().toISOString(),
      items: [
        {
          driveFileId: `file_${postId}`,
          nome: '01_post.jpg',
          categoria: 'Post Único' as const,
          loteNome: 'Lote SaaS Imediato',
          viewUrl: 'https://cdn.ato.vc/saas_imm.jpg',
          thumbnailUrl: 'https://cdn.ato.vc/saas_imm.jpg',
          dataCriacao: new Date().toISOString(),
          status: 'REPROVADO' as const,
          tenantId: 'tenant_ato_vc',
          driveFolderName: 'Ato',
          pastaClienteNome: 'Ato',
          pastaClienteId: 'folder_ato_01',
        },
      ],
    };

    // 3a. Tentativa de publicar conteúdo REPROVADO deve ser bloqueada antes de chamar a Meta
    await upsertPostGroupToDb(rejectedPostObj);
    const atoAccount = await getInstagramAccountByIdOrUser('tenant_ato_vc');

    const rejectedAttempt = await PublicationService.publishPost({
      post: rejectedPostObj,
      targetTenant: atoAccount || undefined,
      caption: rejectedPostObj.caption,
      origin: 'IMMEDIATE',
      pollIntervalMs: 5,
    });
    expect(rejectedAttempt.ok).toBe(false);
    expect(rejectedAttempt.step).toBe('PERMANENT_ERROR');
    expect(rejectedAttempt.error).toContain('não está aprovado para publicação');

    // 3b. Aprova o conteúdo e executa publicação imediata com sucesso
    const approvedPostObj = {
      ...rejectedPostObj,
      status: 'APROVADO' as const,
      isApprovedForSchedule: true,
      captionApproved: true,
      items: rejectedPostObj.items.map((it) => ({ ...it, status: 'APROVADO' as const })),
    };
    await upsertPostGroupToDb(approvedPostObj);

    setInstagramFetchOverride(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('cdn.ato.vc/saas_imm.jpg')) {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      if (urlStr.endsWith('/media') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'creation_saas_imm_101' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (urlStr.includes('creation_saas_imm_101') && urlStr.includes('status_code')) {
        return new Response(JSON.stringify({ id: 'creation_saas_imm_101', status_code: 'FINISHED' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (urlStr.endsWith('/media_publish') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'ig_media_saas_imm_202' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (urlStr.includes('ig_media_saas_imm_202') && urlStr.includes('permalink')) {
        return new Response(
          JSON.stringify({
            id: 'ig_media_saas_imm_202',
            permalink: 'https://www.instagram.com/p/CSAASIMM202/',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    });

    const pubResult = await PublicationService.publishPost({
      post: approvedPostObj,
      targetTenant: atoAccount || undefined,
      caption: 'Publicação imediata validada no SaaS @ato.vc #ato',
      origin: 'IMMEDIATE',
      pollIntervalMs: 5,
    });

    expect(pubResult.ok).toBe(true);
    expect(pubResult.instagramMediaId).toBe('ig_media_saas_imm_202');
    expect(pubResult.permalink).toBe('https://www.instagram.com/p/CSAASIMM202/');
    expect(pubResult.post.status).toBe('PUBLICADO');
  }, 30000);

  it('4. Reconexão sem duplicação de conta (mesmo Instagram User ID atualiza a conexão existente preservando histórico)', async () => {
    const beforeCountRes = await dbQuery<any>(
      `SELECT COUNT(*)::int AS cnt FROM instagram_accounts WHERE LOWER(username) = 'ato.vc' OR id = 'tenant_ato_vc'`
    );
    expect(beforeCountRes.rows[0].cnt).toBe(1);

    // Reconecta com o mesmo Instagram User ID ('17841400001112220') sem informar preferredTenantId
    const reconnected = await TokenService.persistValidatedAccountToken({
      username: 'ato.vc',
      instagramUserId: '17841400001112220',
      plainAccessToken: 'IGQ_LONG_60D_ATO_VC_RECONNECTED_NO_DUP_888',
      tokenType: 'LONG_LIVED',
      grantedScopes: ['instagram_business_basic', 'instagram_business_content_publish'],
    });

    expect(reconnected.id).toBe('tenant_ato_vc');

    const afterCountRes = await dbQuery<any>(
      `SELECT COUNT(*)::int AS cnt FROM instagram_accounts WHERE LOWER(username) = 'ato.vc' OR instagram_user_id = '17841400001112220'`
    );
    expect(afterCountRes.rows[0].cnt).toBe(1);

    const accountAfter = await getInstagramAccountByIdOrUser('tenant_ato_vc');
    expect(TokenService.resolvePlainToken(accountAfter)).toBe(
      'IGQ_LONG_60D_ATO_VC_RECONNECTED_NO_DUP_888'
    );
  }, 30000);

  it('5. Agendamento automático utilizando o mesmo serviço de publicação', async () => {
    const postId = `post_saas_sched_${Date.now()}`;
    createdPostIds.push(postId);

    const pastIso = new Date(Date.now() - 45 * 1000).toISOString();

    await upsertPostGroupToDb({
      id: postId,
      nome: 'Post SaaS Agendado @ato.vc',
      loteNome: 'Lote SaaS Agendado',
      categoria: 'Post Único',
      status: 'PENDENTE',
      tenantId: 'tenant_ato_vc',
      driveFolderName: 'Ato',
      pastaClienteNome: 'Ato',
      pastaClienteId: 'folder_ato_01',
      caption: 'Post agendado automático no SaaS',
      dataCriacao: new Date().toISOString(),
      items: [
        {
          driveFileId: `file_${postId}`,
          nome: '01_sched.jpg',
          categoria: 'Post Único',
          loteNome: 'Lote SaaS Agendado',
          viewUrl: 'https://cdn.ato.vc/saas_sched.jpg',
          thumbnailUrl: 'https://cdn.ato.vc/saas_sched.jpg',
          dataCriacao: new Date().toISOString(),
          status: 'PENDENTE',
          tenantId: 'tenant_ato_vc',
          driveFolderName: 'Ato',
          pastaClienteNome: 'Ato',
          pastaClienteId: 'folder_ato_01',
        },
      ],
    });

    const schedRes = await ScheduleService.scheduleApprovedPost({
      postId,
      caption: 'Post agendado automático no SaaS #ato',
      scheduledAtUtc: pastIso,
      scheduledAccountId: 'tenant_ato_vc',
      approvedBy: 'admin@atodev.com.br',
    });
    expect(schedRes.ok).toBe(true);

    setInstagramFetchOverride(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('cdn.ato.vc/saas_sched.jpg')) {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      if (urlStr.endsWith('/media') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'creation_saas_sched_301' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (urlStr.includes('creation_saas_sched_301') && urlStr.includes('status_code')) {
        return new Response(JSON.stringify({ id: 'creation_saas_sched_301', status_code: 'FINISHED' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (urlStr.endsWith('/media_publish') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'ig_media_saas_sched_404' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (urlStr.includes('ig_media_saas_sched_404') && urlStr.includes('permalink')) {
        return new Response(
          JSON.stringify({
            id: 'ig_media_saas_sched_404',
            permalink: 'https://www.instagram.com/p/CSAASSCHED404/',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    });

    const tick = await SchedulerWorker.runOnce({
      workerId: 'test_saas_scheduler',
      pollIntervalMs: 5,
    });

    expect(tick.publishedCount).toBeGreaterThanOrEqual(1);

    const postRow = await dbQuery<any>(
      `SELECT status, instagram_media_id FROM posts WHERE id = $1`,
      [postId]
    );
    expect(postRow.rows[0].status).toBe('PUBLICADO');
    expect(postRow.rows[0].instagram_media_id).toBe('ig_media_saas_sched_404');
  }, 30000);

  it('6. Isolamento multiempresa estrito: Empresa B não visualiza nem utiliza contas, tokens, mídias ou agendamentos da Empresa A (@ato.vc)', async () => {
    const companyBAccountId = `tenant_empresa_b_${Date.now()}`;
    createdAccountIds.push(companyBAccountId);

    await TokenService.persistValidatedAccountToken({
      preferredTenantId: companyBAccountId,
      username: 'clinica.prime.b',
      nome: 'Clínica Prime B',
      instagramUserId: `ig_b_${Date.now()}`,
      plainAccessToken: 'IGQ_LONG_60D_EMPRESA_B_TOKEN_777',
      tokenType: 'LONG_LIVED',
      grantedScopes: ['instagram_business_basic', 'instagram_business_content_publish'],
      driveFolderName: 'ClinicaPrime',
      driveFolderId: 'folder_clinica_prime',
      status: 'APROVADO',
    });

    const atoPostId = `post_ato_only_${Date.now()}`;
    const empresaBPostId = `post_empresa_b_only_${Date.now()}`;
    createdPostIds.push(atoPostId, empresaBPostId);

    await upsertPostGroupToDb({
      id: atoPostId,
      nome: 'Criativo Exclusivo ATO',
      loteNome: 'Lote Exclusivo ATO',
      categoria: 'Post Único',
      status: 'APROVADO',
      tenantId: 'tenant_ato_vc',
      scheduledAccountId: 'tenant_ato_vc',
      driveFolderName: 'Ato',
      pastaClienteNome: 'Ato',
      pastaClienteId: 'folder_ato_01',
      caption: 'Conteúdo exclusivo da agência ATO',
      isApprovedForSchedule: true,
      captionApproved: true,
      dataCriacao: new Date().toISOString(),
      items: [
        {
          driveFileId: `file_${atoPostId}`,
          nome: '01_ato.jpg',
          categoria: 'Post Único',
          loteNome: 'Lote Exclusivo ATO',
          viewUrl: 'https://cdn.ato.vc/ato_only.jpg',
          thumbnailUrl: 'https://cdn.ato.vc/ato_only.jpg',
          dataCriacao: new Date().toISOString(),
          status: 'APROVADO',
          tenantId: 'tenant_ato_vc',
          driveFolderName: 'Ato',
          pastaClienteNome: 'Ato',
          pastaClienteId: 'folder_ato_01',
        },
      ],
    });

    await upsertPostGroupToDb({
      id: empresaBPostId,
      nome: 'Criativo Exclusivo ClinicaPrime',
      loteNome: 'Lote Exclusivo ClinicaPrime',
      categoria: 'Post Único',
      status: 'APROVADO',
      tenantId: companyBAccountId,
      scheduledAccountId: companyBAccountId,
      driveFolderName: 'ClinicaPrime',
      pastaClienteNome: 'ClinicaPrime',
      pastaClienteId: 'folder_clinica_prime',
      caption: 'Conteúdo exclusivo da Clínica Prime',
      isApprovedForSchedule: true,
      captionApproved: true,
      dataCriacao: new Date().toISOString(),
      items: [
        {
          driveFileId: `file_${empresaBPostId}`,
          nome: '01_b.jpg',
          categoria: 'Post Único',
          loteNome: 'Lote Exclusivo ClinicaPrime',
          viewUrl: 'https://cdn.ato.vc/b_only.jpg',
          thumbnailUrl: 'https://cdn.ato.vc/b_only.jpg',
          dataCriacao: new Date().toISOString(),
          status: 'APROVADO',
          tenantId: companyBAccountId,
          driveFolderName: 'ClinicaPrime',
          pastaClienteNome: 'ClinicaPrime',
          pastaClienteId: 'folder_clinica_prime',
        },
      ],
    });

    const jwtSecret = String(process.env.JWT_SECRET || 'ato_super_secret_key_2026_998877').trim();
    const tenantBToken = jwt.sign(
      {
        id: `usr_${companyBAccountId}`,
        nome: 'Clínica Prime B',
        role: 'TENANT',
        tenantId: companyBAccountId,
        instagramUsername: 'clinica.prime.b',
        status: 'APROVADO',
        driveFolderName: 'ClinicaPrime',
        driveFolderId: 'folder_clinica_prime',
      },
      jwtSecret,
      { expiresIn: '1h' }
    );

    // 6a. Cliente da Empresa B consultando /api/tenants vê APENAS a conta da Empresa B (nunca vê @ato.vc)
    const bTenantsRes = await apiReq('/api/tenants', { token: tenantBToken });
    expect(bTenantsRes.status).toBe(200);
    expect(bTenantsRes.body.tenants.every((t: any) => t.driveFolderName === 'ClinicaPrime')).toBe(true);
    expect(bTenantsRes.body.tenants.some((t: any) => t.username === 'ato.vc')).toBe(false);

    // 6b. Cliente da Empresa B consultando /api/posts vê APENAS os posts da Empresa B
    const bPostsRes = await apiReq('/api/posts', { token: tenantBToken });
    expect(bPostsRes.status).toBe(200);
    expect(bPostsRes.body.posts.some((p: any) => p.id === atoPostId)).toBe(false);
    expect(bPostsRes.body.posts.some((p: any) => p.id === empresaBPostId)).toBe(true);

    // 6c. Cliente da Empresa B tentando publicar o post da Empresa A recebe 403 Forbidden
    const crossPostPublishRes = await apiReq(`/api/posts/${atoPostId}/publish`, {
      method: 'POST',
      token: tenantBToken,
      body: { action: 'NOW', caption: 'Tentativa indevida' },
    });
    expect(crossPostPublishRes.status).toBe(403);

    // 6d. Cliente da Empresa B tentando usar a conta @ato.vc para publicar o post da Empresa B recebe 403 Forbidden
    const crossAccountPublishRes = await apiReq(`/api/posts/${empresaBPostId}/publish`, {
      method: 'POST',
      token: tenantBToken,
      body: {
        action: 'NOW',
        accountId: 'tenant_ato_vc',
        caption: 'Tentativa de usar token de outra empresa',
      },
    });
    expect(crossAccountPublishRes.status).toBe(403);

    // 6e. PublicationService.resolveAccountForPost jamais faz fallback para @ato.vc quando outra empresa não tem conta ou quando conta incompatível é pedida
    const resolvedWrongCompany = await PublicationService.resolveAccountForPost(
      {
        id: 'post_empresa_c',
        nome: 'Post C',
        loteNome: 'Lote C',
        categoria: 'Post Único',
        status: 'APROVADO',
        driveFolderName: 'EmpresaSemInstagram',
        pastaClienteNome: 'EmpresaSemInstagram',
        dataCriacao: new Date().toISOString(),
        items: [],
      },
      null
    );
    expect(resolvedWrongCompany).toBeUndefined();

    // 6f. Cliente da Empresa B tentando gerar URL OAuth para vincular conta à Empresa A ("Ato") recebe 403 Forbidden
    const crossOAuthUrlRes = await apiReq('/api/auth/instagram/url?driveFolderName=Ato', {
      token: tenantBToken,
    });
    expect(crossOAuthUrlRes.status).toBe(403);
  }, 30000);

  it('7. Renovação preventiva automática (<= 30 dias para expirar, retentativas controladas, múltiplos ciclos e uso do token mais recente na publicação)', async () => {
    const refreshAccId = `tenant_refresh_saas_${Date.now()}`;
    createdAccountIds.push(refreshAccId);

    // 7a. Conta com 29 dias restantes para expirar (<= 30 dias) e emitida há 10 dias
    const tenDaysAgoIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const twentyNineDaysAheadIso = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString();

    const staleInMemorySnapshot = await TokenService.persistValidatedAccountToken({
      preferredTenantId: refreshAccId,
      username: 'marca.renovacao',
      instagramUserId: `ig_ref_${Date.now()}`,
      plainAccessToken: 'IGQ_TOKEN_29_DAYS_LEFT',
      tokenType: 'LONG_LIVED',
      tokenIssuedAt: tenDaysAgoIso,
      tokenExpiresAt: twentyNineDaysAheadIso,
      grantedScopes: ['instagram_business_basic', 'instagram_business_content_publish'],
      driveFolderName: 'MarcaRenovacao',
      status: 'APROVADO',
    });

    await dbQuery(
      `UPDATE instagram_accounts SET last_token_refresh_at = $1 WHERE id = $2`,
      [tenDaysAgoIso, refreshAccId]
    );

    // 7b. Simula 2 erros temporários (HTTP 502 e HTTP 500) seguidos de sucesso na 3ª tentativa controlada
    let refreshAttempts = 0;
    let capturedRefreshUrl = '';
    setInstagramFetchOverride(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('grant_type=ig_refresh_token')) {
        refreshAttempts++;
        capturedRefreshUrl = urlStr;
        if (refreshAttempts < 3) {
          return new Response(JSON.stringify({ error: { message: 'Temporary Meta 502', code: 2 } }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            access_token: 'IGQ_RENEWED_CYCLE_1_TOKEN_60D',
            token_type: 'bearer',
            expires_in: 5184000,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    });

    const summaryCycle1 = await TokenService.refreshEligibleTokens({
      retryDelayMs: 5,
      maxRetries: 3,
    });

    const detailCycle1 = summaryCycle1.details.find((d) => d.tenantId === refreshAccId);
    expect(detailCycle1?.action).toBe('REFRESHED');
    expect(detailCycle1?.attemptsUsed).toBe(3);
    expect(capturedRefreshUrl).toContain(
      'https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=IGQ_TOKEN_29_DAYS_LEFT'
    );

    const accAfterCycle1 = await getInstagramAccountByIdOrUser(refreshAccId);
    expect(TokenService.resolvePlainToken(accAfterCycle1)).toBe('IGQ_RENEWED_CYCLE_1_TOKEN_60D');
    expect(Date.parse(accAfterCycle1!.tokenExpiresAt!)).toBeGreaterThan(
      Date.now() + 58 * 24 * 60 * 60 * 1000
    );

    // 7c. Continuidade ao longo do tempo: avança o relógio em 31 dias (faltando 29 dias para expirar novamente)
    const futureNowMs = Date.now() + 31 * 24 * 60 * 60 * 1000;
    setInstagramFetchOverride(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('grant_type=ig_refresh_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'IGQ_RENEWED_CYCLE_2_TOKEN_60D',
            token_type: 'bearer',
            expires_in: 5184000,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    });

    const summaryCycle2 = await SchedulerWorker.runTokenMaintenance({
      nowMs: futureNowMs,
      retryDelayMs: 5,
    });
    const detailCycle2 = summaryCycle2.details.find((d) => d.tenantId === refreshAccId);
    expect(detailCycle2?.action).toBe('REFRESHED');

    const accAfterCycle2 = await getInstagramAccountByIdOrUser(refreshAccId);
    expect(TokenService.resolvePlainToken(accAfterCycle2)).toBe('IGQ_RENEWED_CYCLE_2_TOKEN_60D');

    // 7d. Publicação utiliza SEMPRE o token válido mais recente armazenado no PostgreSQL
    // mesmo que o chamador passe um objeto targetTenant antigo em memória (staleInMemorySnapshot)
    const postRefreshId = `post_latest_tok_${Date.now()}`;
    createdPostIds.push(postRefreshId);
    const postForLatestToken = {
      id: postRefreshId,
      nome: 'Post Token Recente',
      loteNome: 'Lote Token Recente',
      categoria: 'Post Único' as const,
      status: 'APROVADO' as const,
      isApprovedForSchedule: true,
      captionApproved: true,
      caption: 'Testando uso do token mais recente do banco #ato',
      tenantId: refreshAccId,
      scheduledAccountId: refreshAccId,
      driveFolderName: 'MarcaRenovacao',
      pastaClienteNome: 'MarcaRenovacao',
      dataCriacao: new Date().toISOString(),
      items: [
        {
          driveFileId: `file_lat_tok_${Date.now()}`,
          nome: '01_latest_tok.jpg',
          categoria: 'Post Único' as const,
          loteNome: 'Lote Token Recente',
          viewUrl: 'https://cdn.ato.vc/latest_tok.jpg',
          thumbnailUrl: 'https://cdn.ato.vc/latest_tok.jpg',
          mimeType: 'image/jpeg',
          dataCriacao: new Date().toISOString(),
          status: 'APROVADO' as const,
          ordem: 1,
          tenantId: refreshAccId,
          driveFolderName: 'MarcaRenovacao',
          pastaClienteNome: 'MarcaRenovacao',
        },
      ],
    };
    await upsertPostGroupToDb(postForLatestToken);

    let tokenUsedInPublish = '';
    setInstagramFetchOverride(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('cdn.ato.vc/latest_tok.jpg')) {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      if (urlStr.endsWith('/media') && init?.method === 'POST') {
        const parsedBody = JSON.parse(String(init?.body || '{}'));
        tokenUsedInPublish = parsedBody.access_token || '';
        return new Response(JSON.stringify({ id: 'creation_lat_tok_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (urlStr.includes('creation_lat_tok_1') && urlStr.includes('status_code')) {
        return new Response(JSON.stringify({ id: 'creation_lat_tok_1', status_code: 'FINISHED' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (urlStr.endsWith('/media_publish') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'media_lat_tok_999' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (urlStr.includes('media_lat_tok_999') && urlStr.includes('permalink')) {
        return new Response(
          JSON.stringify({
            id: 'media_lat_tok_999',
            permalink: 'https://www.instagram.com/p/LATEST_TOK_999/',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    });

    const pubOutcome = await PublicationService.publishPost({
      post: postForLatestToken,
      targetTenant: staleInMemorySnapshot, // Passa propositalmente o snapshot antigo (IGQ_TOKEN_29_DAYS_LEFT)
      caption: postForLatestToken.caption,
      origin: 'IMMEDIATE',
      pollIntervalMs: 5,
    });

    expect(pubOutcome.ok).toBe(true);
    // Deve ter usado o token mais recente do banco (IGQ_RENEWED_CYCLE_2_TOKEN_60D), NUNCA o token antigo em memória!
    expect(tokenUsedInPublish).toBe('IGQ_RENEWED_CYCLE_2_TOKEN_60D');
  }, 30000);

  it('8. Tentativa de conexão por conta externa sem função no app Meta (Standard Access) e diagnóstico de App Review', async () => {
    // 8a. Callback quando conta externa não autorizada no modo Standard Access retorna erro da Meta
    const externalCallbackRes = await apiReq(
      '/api/auth/instagram/callback?error=access_denied&error_reason=insufficient_developer_role&error_description=Insufficient+developer+role'
    );
    expect(externalCallbackRes.status).toBe(400);
    expect(externalCallbackRes.body.falha_no_passo).toBe(
      'EXTERNAL_ACCOUNT_NOT_AUTHORIZED_IN_STANDARD_ACCESS'
    );
    expect(externalCallbackRes.body.erro).toContain('Instagram Testers');
    expect(externalCallbackRes.body.erro).toContain('Advanced Access');

    // 8b. Endpoint de prontidão para Meta App Review & Advanced Access
    const reviewStatusRes = await apiReq('/api/instagram/app-review-status');
    expect(reviewStatusRes.status).toBe(200);
    expect(reviewStatusRes.body.accessMode).toBe('STANDARD_ACCESS_DEV_MODE');
    expect(reviewStatusRes.body.externalAccountsReadyForGeneralPublic).toBe(false);
    expect(
      reviewStatusRes.body.requiredPermissions.map((p: any) => p.scope)
    ).toEqual(['instagram_business_basic', 'instagram_business_content_publish']);
  }, 30000);
});
