import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  setInstagramFetchOverride,
  IG_USER_MSG_PERSONAL_ACCOUNT,
  IG_USER_MSG_PERMISSION_RESTRICTED,
  IG_USER_MSG_TEMPORARY_ERROR,
} from '../services/instagramCore.ts';
import { TokenService } from '../services/TokenService.ts';
import { runDatabaseMigrations } from '../db/migrations.ts';
import { ensureDefaultAdminUser, upsertInstagramAccount } from '../db/repository.ts';

const BASE_URL = 'http://localhost:3000';

describe('ATO Social Hub — Auditoria de Segurança OAuth Instagram & Isolamento Multiempresa (10 Cenários Obrigatórios)', () => {
  beforeAll(async () => {
    process.env.ATO_TEST_DB_IN_MEMORY = 'true';
    await runDatabaseMigrations();
    await ensureDefaultAdminUser();
    await upsertInstagramAccount({
      id: 'tenant_ato_vc',
      username: 'ato.vc',
      nome: 'Ato',
      instagramUserId: '17841449218493021',
      account_type: 'BUSINESS',
      driveFolderName: 'Ato',
      status: 'APROVADO',
      connectionStatus: 'CONECTADO',
      hasValidToken: true,
      accessToken: 'ig_seed_admin_token',
      requestedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    setInstagramFetchOverride(null);
  });

  // ============================================================================
  // PARTE A: TESTES REAIS (Verificação de Ambiente, Endpoints, Credenciais e Diagnóstico)
  // ============================================================================
  describe('Classificação 1: Testes Reais (Endpoints Ativos, Configuração Meta e Diagnóstico)', () => {
    it('Deve verificar a versão em execução (/api/version) e configuração das credenciais Meta sem expor segredos', async () => {
      const res = await fetch(`${BASE_URL}/api/version`);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.versao_codigo).toBe('v3_nova');
      expect(data.versao).toBe('v4_limpa_sem_callback_text');
      expect(data.revisao_seguranca_oauth).toBe('v5_auditoria_estrita_multiempresa');
      expect(data.graph_api_version).toBe('v21.0');
      expect(data.configuracao_credenciais.app_id_presente).toBe(true);
      expect(data.configuracao_credenciais.app_secret_valido).toBe(true);
    });

    it('Deve expor o diagnóstico comparativo sanitizado (/api/instagram/oauth-diagnostics) entre Conta A (@ato.vc) e Conta B (Erro 100)', async () => {
      const res = await fetch(`${BASE_URL}/api/instagram/oauth-diagnostics`);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.graphApiHost).toBe('https://graph.instagram.com');
      expect(data.graphApiVersion).toBe('v21.0');
      expect(data.requestedPermissions).toEqual([
        'instagram_business_basic',
        'instagram_business_content_publish',
      ]);
      expect(data.comparison.accountA_workingAdminProfessional.username).toBe('ato.vc');
      expect(data.comparison.accountB_externalFailingCode100.instagramUserId).toBe(
        '29378328498437876'
      );
      expect(data.comparison.accountB_externalFailingCode100.step2_graphProfileQuery.errorCode).toBe(
        100
      );
    });

    it('Deve verificar restrições de Standard vs Advanced Access no endpoint /api/instagram/app-review-status', async () => {
      const res = await fetch(`${BASE_URL}/api/instagram/app-review-status`);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.appIdConfigured).toBe(true);
      const scopes = data.requiredPermissions.map((p: any) => p.scope);
      expect(scopes).toContain('instagram_business_basic');
      expect(scopes).toContain('instagram_business_content_publish');
    });

    it('Deve gerar state OAuth assinado e bloquear reutilização (proteção contra CSRF e Replay)', async () => {
      const urlRes = await fetch(`${BASE_URL}/api/auth/instagram/url`);
      expect(urlRes.status).toBe(200);
      const urlData = await urlRes.json();
      expect(urlData.state).toBeTruthy();

      // Primeira utilização do state (com código inválido falha no Passo 1, consumindo o nonce do state)
      const firstCall = await fetch(
        `${BASE_URL}/api/auth/instagram/callback?code=invalid_oauth_code_2026&state=${encodeURIComponent(
          urlData.state
        )}`
      );
      expect(firstCall.status).toBe(400);
      const firstBody = await firstCall.json();
      expect(firstBody.falha_no_passo).toBe('1_POST_OAUTH_ACCESS_TOKEN');

      // Segunda utilização do MESMO state (Replay attack) deve ser bloqueada imediatamente em VALIDACAO_STATE_OAUTH
      const replayCall = await fetch(
        `${BASE_URL}/api/auth/instagram/callback?code=invalid_oauth_code_2026&state=${encodeURIComponent(
          urlData.state
        )}`
      );
      expect(replayCall.status).toBe(400);
      const replayBody = await replayCall.json();
      expect(replayBody.falha_no_passo).toBe('VALIDACAO_STATE_OAUTH');
    });
  });

  // ============================================================================
  // PARTE B: OS 10 CENÁRIOS OBRIGATÓRIOS (Testes de Integração e Simulação Controlada da Meta)
  // ============================================================================
  describe('Classificação 2: Os 10 Cenários Obrigatórios de Segurança e Fluxo OAuth', () => {
    it('Cenário 1: Conta administradora profissional (@ato.vc) realiza consulta mínima e progressiva com sucesso', async () => {
      const calledUrls: string[] = [];

      setInstagramFetchOverride(async (url: string) => {
        calledUrls.push(url);
        if (url.includes('api.instagram.com/oauth/access_token')) {
          return new Response(
            '{"access_token":"ig_short_admin_ato","user_id":17841449218493021,"permissions":["instagram_business_basic","instagram_business_content_publish"]}',
            { status: 200 }
          );
        }
        if (url.includes('grant_type=ig_exchange_token')) {
          return new Response(
            JSON.stringify({
              access_token: 'ig_long_admin_ato_60d',
              token_type: 'bearer',
              expires_in: 5184000,
            }),
            { status: 200 }
          );
        }
        if (url.includes('/v21.0/me?fields=user_id,username')) {
          return new Response(
            '{"id":"17841449218493021","user_id":"17841449218493021","username":"ato.vc"}',
            { status: 200 }
          );
        }
        if (url.includes('/v21.0/me?fields=id,user_id,username,account_type')) {
          return new Response(
            '{"id":"17841449218493021","user_id":"17841449218493021","username":"ato.vc","account_type":"BUSINESS"}',
            { status: 200 }
          );
        }
        return new Response('{}', { status: 400 });
      });

      const result = await TokenService.authorizeAndPersistInstagramAccount({
        code: 'valid_admin_code',
        clientId: '1638364467693255',
        clientSecret: 'secret_test',
        redirectUri: 'https://ato-social-hub.ai.studio/api/auth/instagram/callback',
      });

      expect(result.ok).toBe(true);
      expect(result.tenant?.username).toBe('ato.vc');
      expect(result.tenant?.connectionStatus).toBe('CONECTADO');
      expect(result.tenant?.hasValidToken).toBe(true);
      expect(result.diagnostics?.minimalQuerySuccess).toBe(true);
      expect(result.diagnostics?.progressiveQuerySuccess).toBe(true);
      expect(calledUrls.some((u) => u.includes('/v21.0/me?fields=user_id,username'))).toBe(true);
      expect(
        calledUrls.some((u) => u.includes('/v21.0/me?fields=id,user_id,username,account_type'))
      ).toBe(true);
    });

    it('Cenário 2: Segunda conta profissional autorizada como testadora na Meta conecta e preserva precisão de 64 bits no user_id', async () => {
      setInstagramFetchOverride(async (url: string) => {
        if (url.includes('api.instagram.com/oauth/access_token')) {
          return new Response(
            '{"access_token":"ig_short_tester_2","user_id":29378328498437876,"permissions":["instagram_business_basic","instagram_business_content_publish"]}',
            { status: 200 }
          );
        }
        if (url.includes('grant_type=ig_exchange_token')) {
          return new Response(
            JSON.stringify({
              access_token: 'ig_long_tester_2_60d',
              token_type: 'bearer',
              expires_in: 5184000,
            }),
            { status: 200 }
          );
        }
        if (url.includes('/v21.0/me?fields=user_id,username')) {
          return new Response(
            '{"user_id":"29378328498437876","username":"parceiro_tester_pro"}',
            { status: 200 }
          );
        }
        if (url.includes('/v21.0/me?fields=id,user_id,username,account_type')) {
          return new Response(
            '{"id":"99887766554433221","user_id":"29378328498437876","username":"parceiro_tester_pro","account_type":"MEDIA_CREATOR"}',
            { status: 200 }
          );
        }
        return new Response('{}', { status: 400 });
      });

      const result = await TokenService.authorizeAndPersistInstagramAccount({
        code: 'valid_tester_code',
        clientId: '1638364467693255',
        clientSecret: 'secret_test',
        redirectUri: 'https://ato-social-hub.ai.studio/api/auth/instagram/callback',
      });

      expect(result.ok).toBe(true);
      expect(result.igUserId).toBe('29378328498437876');
      expect(result.tenant?.instagramUserId).toBe('29378328498437876');
      expect(result.tenant?.username).toBe('parceiro_tester_pro');
      expect(result.tenant?.account_type).toBe('MEDIA_CREATOR');
      // Conta nova não aprovada deve entrar na fila de aprovação e NUNCA vincular automaticamente à empresa Ato!
      expect(result.tenant?.status).toBe('AGUARDANDO_APROVACAO');
      expect(result.tenant?.driveFolderName).toBeNull();
    });

    it('Cenário 3: Conta profissional externa sem função no aplicativo (IGApiException código 100) é bloqueada sem bypass e retorna mensagem adequada', async () => {
      setInstagramFetchOverride(async (url: string) => {
        if (url.includes('api.instagram.com/oauth/access_token')) {
          return new Response(
            '{"access_token":"ig_short_ext_unauth","user_id":29378328498437876}',
            { status: 200 }
          );
        }
        if (url.includes('grant_type=ig_exchange_token')) {
          return new Response(
            JSON.stringify({
              access_token: 'ig_long_ext_unauth',
              token_type: 'bearer',
              expires_in: 5184000,
            }),
            { status: 200 }
          );
        }
        if (url.includes('/v21.0/me')) {
          return new Response(
            JSON.stringify({
              error: {
                message: 'Unsupported request - method type: get',
                type: 'IGApiException',
                code: 100,
                fbtrace_id: 'AWsN8ik5PocJIArFw4j8yzw',
              },
            }),
            { status: 400 }
          );
        }
        return new Response('{}', { status: 400 });
      });

      const result = await TokenService.authorizeAndPersistInstagramAccount({
        code: 'external_unauth_code',
        clientId: '1638364467693255',
        clientSecret: 'secret_test',
        redirectUri: 'https://ato-social-hub.ai.studio/api/auth/instagram/callback',
      });

      expect(result.ok).toBe(false);
      expect(result.step).toBe('2_GET_GRAPH_INSTAGRAM_ME');
      expect(result.httpStatus).toBe(400);
      expect(result.fbtraceId).toBe('AWsN8ik5PocJIArFw4j8yzw');
      expect(result.userMessage).toBe(IG_USER_MSG_PERMISSION_RESTRICTED);
      expect(result.userMessage).toBe(
        'Não foi possível autorizar esta conta do Instagram. A integração ainda precisa de liberação para essa conta.'
      );
      expect(result.tenant).toBeUndefined();
    });

    it('Cenário 4: Conta pessoal (PERSONAL) é recusada com a mensagem exata exigida e não é marcada como conectada', async () => {
      setInstagramFetchOverride(async (url: string) => {
        if (url.includes('api.instagram.com/oauth/access_token')) {
          return new Response(
            '{"access_token":"ig_short_personal","user_id":11223344556677889}',
            { status: 200 }
          );
        }
        if (url.includes('grant_type=ig_exchange_token')) {
          return new Response(
            JSON.stringify({
              access_token: 'ig_long_personal',
              token_type: 'bearer',
              expires_in: 5184000,
            }),
            { status: 200 }
          );
        }
        if (url.includes('/v21.0/me?fields=user_id,username')) {
          return new Response(
            '{"user_id":"11223344556677889","username":"usuario_pessoal_ig"}',
            { status: 200 }
          );
        }
        if (url.includes('/v21.0/me?fields=id,user_id,username,account_type')) {
          return new Response(
            '{"id":"11223344556677889","user_id":"11223344556677889","username":"usuario_pessoal_ig","account_type":"PERSONAL"}',
            { status: 200 }
          );
        }
        return new Response('{}', { status: 400 });
      });

      const result = await TokenService.authorizeAndPersistInstagramAccount({
        code: 'personal_account_code',
        clientId: '1638364467693255',
        clientSecret: 'secret_test',
        redirectUri: 'https://ato-social-hub.ai.studio/api/auth/instagram/callback',
      });

      expect(result.ok).toBe(false);
      expect(result.step).toBe('2C_CONTA_PESSOAL_NAO_SUPORTADA');
      expect(result.reasonCode).toBe('PERSONAL_ACCOUNT_NOT_SUPPORTED');
      expect(result.userMessage).toBe(IG_USER_MSG_PERSONAL_ACCOUNT);
      expect(result.userMessage).toBe(
        'Para conectar e publicar conteúdos, utilize uma conta profissional do Instagram.'
      );
      expect(result.tenant).toBeUndefined();
    });

    it('Cenários 5, 6 e 7: Cadastro de novo usuário sem privilégio administrativo -> Entrada na fila de aprovação -> Aprovação Admin -> Conexão Instagram após aprovação', async () => {
      const uniqueSuffix = Date.now();
      const email = `novo.cliente.${uniqueSuffix}@empresa.com.br`;

      // Cenário 5: Cadastro de novo usuário no Social Hub sem privilégio administrativo
      const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Marina Costa',
          companyName: `Clinica Vida ${uniqueSuffix}`,
          email,
          password: 'senhaSegura123',
        }),
      });
      expect(regRes.status).toBe(201);
      const regData = await regRes.json();

      expect(regData.user.role).toBe('TENANT');
      expect(regData.user.role).not.toBe('ADMIN');
      expect(regData.user.connectionStatus).toBe('DESCONECTADO');
      expect(regData.tenant.hasValidToken).toBe(false);

      // Cenário 6: Entrada na fila de aprovação (status AGUARDANDO_APROVACAO e sem pasta vinculada)
      expect(regData.user.status).toBe('AGUARDANDO_APROVACAO');
      expect(regData.user.driveFolderName).toBeNull();
      expect(regData.tenant.status).toBe('AGUARDANDO_APROVACAO');

      // Login como Admin para aprovar o novo usuário na fila e vincular à sua empresa
      const adminLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@atodev.com.br',
          password: '666666',
        }),
      });
      expect(adminLoginRes.status).toBe(200);
      const adminAuth = await adminLoginRes.json();

      const folderName = `ClinicaVida_${uniqueSuffix}`;
      const approveRes = await fetch(
        `${BASE_URL}/api/admin/tenants/${encodeURIComponent(regData.tenant.id)}/approve`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminAuth.token}`,
          },
          body: JSON.stringify({
            driveFolderName: folderName,
          }),
        }
      );
      expect(approveRes.status).toBe(200);
      const approveData = await approveRes.json();
      expect(approveData.tenant.status).toBe('APROVADO');
      expect(approveData.tenant.driveFolderName).toBe(folderName);
      // Continua desconectado do Instagram até que o cliente autorize o OAuth!
      expect(approveData.tenant.hasValidToken).toBe(false);

      // Sincroniza o registro aprovado no banco de teste em memória para validação direta do TokenService
      await upsertInstagramAccount(approveData.tenant);

      // Cenário 7: Conexão Instagram profissional após aprovação no Social Hub
      const igUsername = `clinicavida_${uniqueSuffix}`;
      const igUserId = `88776655${uniqueSuffix.toString().slice(-8)}`;

      setInstagramFetchOverride(async (url: string) => {
        if (url.includes('api.instagram.com/oauth/access_token')) {
          return new Response(
            `{"access_token":"ig_short_${uniqueSuffix}","user_id":${igUserId},"permissions":["instagram_business_basic","instagram_business_content_publish"]}`,
            { status: 200 }
          );
        }
        if (url.includes('grant_type=ig_exchange_token')) {
          return new Response(
            JSON.stringify({
              access_token: `ig_long_${uniqueSuffix}_60d`,
              token_type: 'bearer',
              expires_in: 5184000,
            }),
            { status: 200 }
          );
        }
        if (url.includes('/v21.0/me?fields=user_id,username')) {
          return new Response(
            `{"user_id":"${igUserId}","username":"${igUsername}"}`,
            { status: 200 }
          );
        }
        if (url.includes('/v21.0/me?fields=id,user_id,username,account_type')) {
          return new Response(
            `{"id":"${igUserId}","user_id":"${igUserId}","username":"${igUsername}","account_type":"BUSINESS"}`,
            { status: 200 }
          );
        }
        return new Response('{}', { status: 400 });
      });

      const connectResult = await TokenService.authorizeAndPersistInstagramAccount({
        code: `code_for_${uniqueSuffix}`,
        clientId: '1638364467693255',
        clientSecret: 'secret_test',
        redirectUri: 'https://ato-social-hub.ai.studio/api/auth/instagram/callback',
        preferredTenantId: regData.tenant.id,
        driveFolderName: folderName,
      });

      expect(connectResult.ok).toBe(true);
      expect(connectResult.tenant?.id).toBe(regData.tenant.id);
      expect(connectResult.tenant?.username).toBe(igUsername);
      expect(connectResult.tenant?.status).toBe('APROVADO');
      expect(connectResult.tenant?.driveFolderName).toBe(folderName);
      expect(connectResult.tenant?.connectionStatus).toBe('CONECTADO');
      expect(connectResult.tenant?.hasValidToken).toBe(true);
    });

    it('Cenário 8: Bloqueio de vinculação indevida a outra empresa (Isolamento Multiempresa)', async () => {
      const uniqueSuffix = Date.now();
      // Cria um usuário TENANT da Empresa B
      const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Usuario Empresa B',
          companyName: `Empresa B ${uniqueSuffix}`,
          email: `empresab.${uniqueSuffix}@teste.com`,
          password: 'senhaSegura123',
        }),
      });
      expect(regRes.status).toBe(201);
      const userB = await regRes.json();

      // 8A. Usuário da Empresa B tenta gerar URL OAuth apontando para a pasta "Ato" (outra empresa) -> Deve retornar 403
      const forbiddenUrlRes = await fetch(
        `${BASE_URL}/api/auth/instagram/url?driveFolderName=Ato`,
        {
          headers: {
            Authorization: `Bearer ${userB.token}`,
          },
        }
      );
      expect(forbiddenUrlRes.status).toBe(403);

      // 8B. Tentativa de vincular a conta @ato.vc (que pertence à empresa "Ato") a outra empresa ("Empresa_Intrusa") via TokenService -> Deve bloquear com CROSS_TENANT_VIOLATION
      setInstagramFetchOverride(async (url: string) => {
        if (url.includes('api.instagram.com/oauth/access_token')) {
          return new Response(
            '{"access_token":"ig_short_ato","user_id":17841449218493021,"permissions":["instagram_business_basic","instagram_business_content_publish"]}',
            { status: 200 }
          );
        }
        if (url.includes('grant_type=ig_exchange_token')) {
          return new Response(
            JSON.stringify({
              access_token: 'ig_long_ato_60d',
              token_type: 'bearer',
              expires_in: 5184000,
            }),
            { status: 200 }
          );
        }
        if (url.includes('/v21.0/me')) {
          return new Response(
            '{"id":"17841449218493021","user_id":"17841449218493021","username":"ato.vc","account_type":"BUSINESS"}',
            { status: 200 }
          );
        }
        return new Response('{}', { status: 400 });
      });

      const crossTenantAttempt = await TokenService.authorizeAndPersistInstagramAccount({
        code: 'code_cross_tenant_attempt',
        clientId: '1638364467693255',
        clientSecret: 'secret_test',
        redirectUri: 'https://ato-social-hub.ai.studio/api/auth/instagram/callback',
        driveFolderName: 'Empresa_Intrusa_Diferente_De_Ato',
      });

      expect(crossTenantAttempt.ok).toBe(false);
      expect(crossTenantAttempt.reasonCode).toBe('CROSS_TENANT_VIOLATION');
      expect(crossTenantAttempt.httpStatus).toBe(403);
    });

    it('Cenário 9: Ausência de sessões administrativas criadas pelo callback OAuth', async () => {
      // Mesmo quando uma conta conecta ou reconecta via OAuth, o perfil emitido pelo callback NUNCA possui role ADMIN
      const simRes = await fetch(`${BASE_URL}/api/auth/instagram/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: `cliente_nao_admin_${Date.now()}`,
          nome: 'Cliente Comum',
        }),
      });
      expect(simRes.status).toBe(200);
      const simData = await simRes.json();

      expect(simData.user.role).toBe('TENANT');
      expect(simData.user.role).not.toBe('ADMIN');
      expect(simData.user.status).toBe('AGUARDANDO_APROVACAO');

      const decodedJwt = jwt.decode(simData.token) as any;
      expect(decodedJwt.role).toBe('TENANT');
      expect(decodedJwt.role).not.toBe('ADMIN');
    });

    it('Cenário 10: Publicação utilizando exclusivamente o token e a conta autorizados da própria empresa (bloqueando uso de token de outra empresa)', async () => {
      const uniqueSuffix = Date.now();
      // Cria usuário da Empresa C sem acesso à Empresa Ato
      const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Cliente Isolado',
          companyName: `Empresa C ${uniqueSuffix}`,
          email: `empresac.${uniqueSuffix}@teste.com`,
          password: 'senhaSegura123',
        }),
      });
      expect(regRes.status).toBe(201);
      const userC = await regRes.json();

      // Tentativa do Usuário C de publicar usando o accountId da empresa Ato ("tenant_ato_vc") deve ser bloqueada
      const publishCrossTenantRes = await fetch(`${BASE_URL}/api/instagram/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userC.token}`,
        },
        body: JSON.stringify({
          id: 'post_inexistente_ou_de_outra_empresa',
          driveFileId: 'file_test',
          caption: 'Tentativa de publicar usando token de outra empresa',
          accountId: 'tenant_ato_vc',
        }),
      });

      expect([403, 404]).toContain(publishCrossTenantRes.status);
    });
  });
});
