import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import jwt from 'jsonwebtoken';

// Ambiente determinístico ANTES de importar o servidor (nenhum segredo real é usado).
const APP_ID = '28751089997889323';
process.env.JWT_SECRET = 'test_jwt_secret_oauth_unified_0123456789';
process.env.TOKEN_ENCRYPTION_KEY = 'test_token_encryption_key_0123456789abcdef';
process.env.INSTAGRAM_APP_ID = APP_ID;
process.env.INSTAGRAM_APP_SECRET = 'test_app_secret_for_unit_tests_only_123456';
process.env.INSTAGRAM_REDIRECT_URI = 'https://socialhub.test/api/auth/instagram/callback';
process.env.APP_URL = 'https://socialhub.test';

import { app, ensurePostgresBootstrapped, syncStateFromPostgres } from '../../server.ts';
import { dbQuery } from '../db/pool.ts';
import { setInstagramFetchOverride } from '../services/instagramCore.ts';
import { upsertInstagramAccount, getInstagramAccountByIdOrUser, upsertPostGroupToDb } from '../db/repository.ts';
import { TokenService } from '../services/TokenService.ts';
import { setMailTransportForTests, type MailMessage } from '../services/mailer.ts';

type FakeGraph = {
  accounts: Array<{ id: string; username: string; account_type?: string }>;
  scopes: string[] | null; // null => debug_token não lista escopos
  publishProbeOk: boolean;
  tokenAppId: string;
  tokenValid: boolean;
};

let graph: FakeGraph;
const graphCalls: string[] = [];

function installFakeGraph() {
  setInstagramFetchOverride((async (input: any) => {
    const url = String(input);
    graphCalls.push(url.replace(/access_token=[^&]+/g, 'access_token=<x>'));
    const json = (status: number, body: any) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      }) as any;

    if (url.includes('/oauth/access_token')) {
      return json(200, { access_token: 'FAKE_UNIFIED_TOKEN', token_type: 'bearer', expires_in: 5184000 });
    }
    if (url.includes('/debug_token')) {
      return json(200, {
        data: {
          app_id: graph.tokenAppId,
          is_valid: graph.tokenValid,
          ...(graph.scopes ? { scopes: graph.scopes } : {}),
        },
      });
    }
    if (url.includes('/me/assigned_instagram_accounts')) {
      return json(200, { data: graph.accounts.map((a) => ({ id: a.id, username: a.username })) });
    }
    if (url.includes('/content_publishing_limit')) {
      return graph.publishProbeOk
        ? json(200, { data: [{ quota_usage: 0 }] })
        : json(400, { error: { message: 'permission', code: 10 } });
    }
    const m = url.match(/\/v27\.0\/(\d+)\?fields=/);
    if (m) {
      const acc = graph.accounts.find((a) => a.id === m[1]);
      return acc
        ? json(200, { id: acc.id, username: acc.username, account_type: acc.account_type || 'BUSINESS' })
        : json(400, { error: { message: 'unknown', code: 100 } });
    }
    return json(404, { error: { message: 'unexpected url in test' } });
  }) as any);
}

describe('Unified Login — segurança de autenticação, vínculo por ID e isolamento entre empresas', () => {
  let server: http.Server;
  let baseUrl = '';
  const JWT = process.env.JWT_SECRET!;

  const tenantUser = (tenantId: string) =>
    jwt.sign({ id: `usr_${tenantId}`, nome: tenantId, role: 'TENANT', tenantId } as any, JWT, { expiresIn: '1h' });
  const adminUser = () => jwt.sign({ id: 'admin_test', nome: 'Admin', role: 'ADMIN' } as any, JWT, { expiresIn: '1h' });

  async function req(path: string, opts: { method?: string; token?: string; cookie?: string; body?: any; form?: Record<string, string> } = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.cookie) headers.Cookie = opts.cookie;
    let body: any;
    if (opts.body) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    } else if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.form).toString();
    }
    const res = await fetch(`${baseUrl}${path}`, { method: opts.method || 'GET', headers, body, redirect: 'manual' });
    const text = await res.text();
    let parsed: any = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { _html: text };
    }
    return { status: res.status, body: parsed, raw: text, setCookie: res.headers.get('set-cookie') || '' };
  }

  /** Inicia o fluxo como um usuário autenticado e devolve state + cookie de vínculo do navegador. */
  async function startFlow(token: string, query = '') {
    const r = await req(`/api/auth/instagram/url${query}`, { token });
    expect(r.status).toBe(200);
    const url = new URL(r.body.url);
    const state = url.searchParams.get('state')!;
    const cookie = r.setCookie.split(';')[0];
    return { state, cookie, url, body: r.body };
  }

  const callback = (state: string, cookie: string, code = `code_${Math.random().toString(36).slice(2)}`) =>
    req(`/api/auth/instagram/callback?state=${encodeURIComponent(state)}&code=${code}&format=json`, { cookie });

  async function seedTenant(id: string, over: Record<string, any> = {}) {
    await upsertInstagramAccount({
      id,
      username: over.username || `cadastro_${id}`,
      nome: over.nome || id,
      instagramUserId: over.instagramUserId || `pending_ig_${id}`,
      account_type: 'BUSINESS',
      driveFolderName: over.driveFolderName ?? `Pasta ${id}`,
      status: over.status || 'APROVADO',
      connectionStatus: over.connectionStatus || 'DESCONECTADO',
      hasValidToken: Boolean(over.hasValidToken),
      requestedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
      ...over.extra,
    } as any);
  }

  beforeAll(async () => {
    await ensurePostgresBootstrapped();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    setInstagramFetchOverride(null);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    graphCalls.length = 0;
  });

  let seq = 0;
  const resetGraph = (over: Partial<FakeGraph> = {}) => {
    seq += 1;
    graph = {
      accounts: [{ id: `178414100000${String(seq).padStart(5, '0')}`, username: `conta_demo_${seq}` }],
      scopes: ['instagram_basic', 'instagram_content_publish'],
      publishProbeOk: true,
      tokenAppId: APP_ID,
      tokenValid: true,
      ...over,
    };
    installFakeGraph();
  };

  // ------------------------------------------------------------------
  // Rotas que emitiam sessão sem validar identidade
  // ------------------------------------------------------------------
  describe('Rotas de bypass de autenticação', () => {
    it('POST /api/auth/instagram (legada) não emite mais sessão', async () => {
      const r = await req('/api/auth/instagram', { method: 'POST', body: { customUsername: 'qualquer_cliente' } });
      expect(r.status).toBe(410);
      expect(r.body.token).toBeUndefined();
    });

    it('POST /api/auth/instagram/simulate não existe em produção', async () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const r = await req('/api/auth/instagram/simulate', { method: 'POST', body: { username: 'alvo' } });
        expect(r.status).toBe(404);
        expect(r.body.token).toBeUndefined();
      } finally {
        process.env.NODE_ENV = prev;
      }
    });

    it('/api/debug/state e /oauth-diagnostics exigem ADMIN autenticado', async () => {
      expect((await req('/api/debug/state')).status).toBe(401);
      expect((await req('/api/instagram/oauth-diagnostics')).status).toBe(401);
      await seedTenant('tenant_diag');
      expect((await req('/api/debug/state', { token: tenantUser('tenant_diag') })).status).toBe(403);
      expect((await req('/api/debug/state', { token: adminUser() })).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------
  // Início do fluxo: autenticação separada da autorização do Instagram
  // ------------------------------------------------------------------
  describe('Início do fluxo OAuth', () => {
    it('exige login no Social Hub antes de pedir autorização do Instagram', async () => {
      const r = await req('/api/auth/instagram/url');
      expect(r.status).toBe(401);
    });

    it('usa o app 28751089997889323, Unified Login (config_id) e os escopos do Unified Login', async () => {
      resetGraph();
      await seedTenant('tenant_url');
      const { url, body } = await startFlow(tenantUser('tenant_url'));
      expect(url.origin + url.pathname).toBe('https://www.facebook.com/dialog/oauth');
      expect(url.searchParams.get('client_id')).toBe(APP_ID);
      expect(url.searchParams.get('config_id')).toBe('1775718873720654');
      expect(url.searchParams.get('scope')).toBeNull();
      expect(body.requiredScopes).toEqual(['instagram_basic', 'instagram_content_publish']);
      expect(JSON.stringify(body)).not.toContain('instagram_business_');
    });

    it('registra o state no PostgreSQL com expiração e vínculo ao navegador (cookie HttpOnly)', async () => {
      resetGraph();
      await seedTenant('tenant_state');
      const { state, cookie } = await startFlow(tenantUser('tenant_state'));
      const nonce = (jwt.decode(state) as any).nonce;
      const row = await dbQuery(`SELECT user_id, role, tenant_id, consumed_at, expires_at > NOW() AS valido FROM oauth_states WHERE nonce=$1`, [nonce]);
      expect(row.rows[0].tenant_id).toBe('tenant_state');
      expect(row.rows[0].consumed_at).toBeNull();
      expect(row.rows[0].valido).toBe(true);
      expect(cookie.startsWith('ig_oauth_bind=')).toBe(true);
    });

    it('usuário TENANT não consegue iniciar conexão para outra empresa', async () => {
      resetGraph();
      await seedTenant('tenant_a');
      await seedTenant('tenant_b');
      const r = await req('/api/auth/instagram/url?tenantId=tenant_b', { token: tenantUser('tenant_a') });
      expect(r.status).toBe(403);
    });
  });

  // ------------------------------------------------------------------
  // Callback
  // ------------------------------------------------------------------
  describe('Callback OAuth', () => {
    it('sem state, com state forjado ou sem cookie do navegador: recusa e não chama a Meta', async () => {
      resetGraph();
      await seedTenant('tenant_cb1');
      const noState = await req('/api/auth/instagram/callback?code=abc&format=json');
      expect(noState.status).toBe(400);
      const forged = await req(`/api/auth/instagram/callback?state=${jwt.sign({ purpose: 'instagram_oauth_state', nonce: 'x' }, 'outra_chave')}&code=abc&format=json`);
      expect(forged.status).toBe(400);
      const { state } = await startFlow(tenantUser('tenant_cb1'));
      const noCookie = await callback(state, '');
      expect(noCookie.status).toBe(400);
      expect(graphCalls.some((u) => u.includes('/oauth/access_token'))).toBe(false);
    });

    it('state é de uso único, inclusive entre instâncias (consumo atômico no PostgreSQL)', async () => {
      resetGraph();
      await seedTenant('tenant_cb2');
      const { state, cookie } = await startFlow(tenantUser('tenant_cb2'));
      const first = await callback(state, cookie);
      expect(first.status).toBe(200);
      const replay = await callback(state, cookie);
      expect(replay.status).toBe(400);
    });

    it('state expirado é recusado', async () => {
      resetGraph();
      await seedTenant('tenant_cb3');
      const { state, cookie } = await startFlow(tenantUser('tenant_cb3'));
      const nonce = (jwt.decode(state) as any).nonce;
      await dbQuery(`UPDATE oauth_states SET expires_at = NOW() - INTERVAL '1 minute' WHERE nonce=$1`, [nonce]);
      const r = await callback(state, cookie);
      expect(r.status).toBe(400);
    });

    it('código de autorização não pode ser reutilizado', async () => {
      resetGraph();
      await seedTenant('tenant_cb4');
      const f1 = await startFlow(tenantUser('tenant_cb4'));
      expect((await callback(f1.state, f1.cookie, 'codigo_fixo_1')).status).toBe(200);
      const f2 = await startFlow(tenantUser('tenant_cb4'));
      expect((await callback(f2.state, f2.cookie, 'codigo_fixo_1')).status).toBe(400);
    });

    it('conexão válida: vincula pelo Instagram ID à empresa autenticada, SEM criar sessão e SEM expor token', async () => {
      resetGraph();
      await seedTenant('tenant_ok');
      const { state, cookie } = await startFlow(tenantUser('tenant_ok'));
      const r = await callback(state, cookie);
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      // Não há sessão nem token em nenhum lugar da resposta.
      expect(r.body.token).toBeUndefined();
      expect(r.body.user).toBeUndefined();
      expect(r.body.syncTicket).toBeUndefined();
      expect(r.raw).not.toContain('FAKE_UNIFIED_TOKEN');
      expect(r.raw).not.toContain('encryptedAccessToken');
      // Persistência: token criptografado só no banco, ligado à empresa de quem iniciou o fluxo.
      const acc = await getInstagramAccountByIdOrUser('tenant_ok');
      expect(acc?.instagramUserId).toBe(graph.accounts[0].id);
      expect(acc?.username).toBe(graph.accounts[0].username);
      expect(acc?.connectionStatus).toBe('CONECTADO');
      expect(acc?.grantedScopes).toEqual(['instagram_basic', 'instagram_content_publish']);
      expect(acc?.encryptedAccessToken).toBeTruthy();
      expect(acc?.encryptedAccessToken).not.toContain('FAKE_UNIFIED_TOKEN');
      expect(TokenService.decrypt(acc?.encryptedAccessToken)).toBe('FAKE_UNIFIED_TOKEN');
    });

    it('token emitido para OUTRO app é recusado', async () => {
      resetGraph({ tokenAppId: '999999999999' });
      await seedTenant('tenant_app');
      const { state, cookie } = await startFlow(tenantUser('tenant_app'));
      const r = await callback(state, cookie);
      expect(r.status).toBe(400);
      expect((await getInstagramAccountByIdOrUser('tenant_app'))?.connectionStatus).not.toBe('CONECTADO');
    });

    it('permissões incompletas (sem instagram_content_publish) bloqueiam a conexão', async () => {
      resetGraph({ scopes: ['instagram_basic'] });
      await seedTenant('tenant_scope');
      const { state, cookie } = await startFlow(tenantUser('tenant_scope'));
      const r = await callback(state, cookie);
      expect(r.status).toBe(400);
      expect(r.body.reason_code).toBe('INSUFFICIENT_SCOPES');
      expect(r.body.permissoes_faltantes).toContain('instagram_content_publish');
    });

    it('sem lista de escopos na Meta, a permissão de publicação é provada por sonda; sem prova, nada é inventado', async () => {
      resetGraph({ scopes: null, publishProbeOk: false });
      await seedTenant('tenant_probe');
      const f = await startFlow(tenantUser('tenant_probe'));
      const denied = await callback(f.state, f.cookie);
      expect(denied.status).toBe(400);
      expect(denied.body.reason_code).toBe('INSUFFICIENT_SCOPES');

      resetGraph({ scopes: null, publishProbeOk: true });
      const f2 = await startFlow(tenantUser('tenant_probe'));
      expect((await callback(f2.state, f2.cookie)).status).toBe(200);
    });

    it('aceita nomes antigos de escopo já gravados como equivalentes (contas existentes preservadas)', async () => {
      const { hasRequiredInstagramScopes } = await import('../services/instagramCore.ts');
      expect(hasRequiredInstagramScopes(['instagram_business_basic', 'instagram_business_content_publish']).valid).toBe(true);
      expect(hasRequiredInstagramScopes(['instagram_business_basic']).valid).toBe(false);
    });

    it('conta pessoal é bloqueada', async () => {
      resetGraph({ accounts: [{ id: '17841400000000009', username: 'pessoal', account_type: 'PERSONAL' }] });
      await seedTenant('tenant_pessoal');
      const { state, cookie } = await startFlow(tenantUser('tenant_pessoal'));
      const r = await callback(state, cookie);
      expect(r.status).toBe(400);
      expect(r.body.reason_code).toBe('PERSONAL_ACCOUNT_NOT_SUPPORTED');
    });
  });

  // ------------------------------------------------------------------
  // Isolamento entre empresas
  // ------------------------------------------------------------------
  describe('Isolamento entre empresas', () => {
    it('Instagram ID já vinculado à empresa B não pode ser vinculado pelo usuário da empresa A', async () => {
      resetGraph({ accounts: [{ id: '17841400000000002', username: 'conta_da_b' }] });
      await seedTenant('tenant_emp_beta', {
        username: 'conta_da_b',
        instagramUserId: '17841400000000002',
        driveFolderName: 'Empresa B',
        connectionStatus: 'CONECTADO',
        hasValidToken: true,
      });
      await seedTenant('tenant_emp_alfa', { driveFolderName: 'Empresa A' });
      const { state, cookie } = await startFlow(tenantUser('tenant_emp_alfa'));
      const r = await callback(state, cookie);
      expect(r.status).toBe(403);
      expect(r.body.reason_code).toBe('CROSS_TENANT_VIOLATION');
      const a = await getInstagramAccountByIdOrUser('tenant_emp_alfa');
      expect(a?.instagramUserId).not.toBe('17841400000000002');
      const b = await getInstagramAccountByIdOrUser('tenant_emp_beta');
      expect(b?.instagramUserId).toBe('17841400000000002');
    });

    it('username igual com Instagram ID diferente NÃO sobrescreve nem adota o registro de outra empresa', async () => {
      resetGraph({ accounts: [{ id: '17841400000000099', username: 'mesmo_arroba' }] });
      await seedTenant('tenant_dono', {
        username: 'mesmo_arroba',
        instagramUserId: '17841400000000003',
        driveFolderName: 'Dono',
        connectionStatus: 'CONECTADO',
        hasValidToken: true,
      });
      await seedTenant('tenant_intruso', { driveFolderName: 'Intruso' });
      const { state, cookie } = await startFlow(tenantUser('tenant_intruso'));
      const r = await callback(state, cookie);
      expect([403, 409]).toContain(r.status);
      const dono = await getInstagramAccountByIdOrUser('tenant_dono');
      expect(dono?.instagramUserId).toBe('17841400000000003');
    });

    it('empresa que já tem outra conta real não é trocada por usuário comum', async () => {
      resetGraph({ accounts: [{ id: '17841400000000005', username: 'segunda_conta' }] });
      await seedTenant('tenant_ja_tem', {
        username: 'primeira_conta',
        instagramUserId: '17841400000000004',
        connectionStatus: 'CONECTADO',
        hasValidToken: true,
      });
      const { state, cookie } = await startFlow(tenantUser('tenant_ja_tem'));
      const r = await callback(state, cookie);
      expect(r.status).toBe(403);
      expect((await getInstagramAccountByIdOrUser('tenant_ja_tem'))?.instagramUserId).toBe('17841400000000004');
    });

    it('sync-session ignora tenant/token/username enviados pelo navegador', async () => {
      await seedTenant('tenant_sync_a', { username: 'sync_a', instagramUserId: '17841400000000010' });
      await seedTenant('tenant_sync_b', { username: 'sync_b', instagramUserId: '17841400000000011' });
      const r = await req('/api/auth/instagram/sync-session', {
        method: 'POST',
        token: tenantUser('tenant_sync_a'),
        body: {
          tenant: { id: 'tenant_sync_b', username: 'sync_b', instagramUserId: '17841400000000011', encryptedAccessToken: 'enc:v1:invasor' },
        },
      });
      expect(r.status).toBe(200);
      expect(r.body.tenant.id).toBe('tenant_sync_a');
      const b = await getInstagramAccountByIdOrUser('tenant_sync_b');
      expect(b?.encryptedAccessToken || '').not.toContain('invasor');
    });
  });

  // ------------------------------------------------------------------
  // Várias contas autorizadas
  // ------------------------------------------------------------------
  describe('Seleção entre várias contas autorizadas', () => {
    it('não escolhe a primeira conta automaticamente; só aceita contas realmente autorizadas e uso único', async () => {
      resetGraph({
        accounts: [
          { id: '17841400000000021', username: 'primeira' },
          { id: '17841400000000022', username: 'segunda' },
        ],
      });
      await seedTenant('tenant_multi');
      const { state, cookie } = await startFlow(tenantUser('tenant_multi'));
      const r = await req(`/api/auth/instagram/callback?state=${encodeURIComponent(state)}&code=cod_multi`, { cookie });
      expect(r.status).toBe(200);
      expect(r.raw).toContain('@primeira');
      expect(r.raw).toContain('@segunda');
      // Nada foi vinculado ainda.
      expect((await getInstagramAccountByIdOrUser('tenant_multi'))?.connectionStatus).not.toBe('CONECTADO');

      const pendingId = r.raw.match(/name="pendingId" value="([^"]+)"/)![1];
      const secret = r.raw.match(/name="secret" value="([^"]+)"/)![1];

      // Conta que NÃO estava entre as autorizadas.
      const bad = await req('/api/auth/instagram/select', {
        method: 'POST',
        form: { pendingId, secret, accountId: '17841499999999999' },
      });
      expect(bad.status).toBe(400);
      // Segredo errado.
      const wrongSecret = await req('/api/auth/instagram/select', {
        method: 'POST',
        form: { pendingId, secret: 'x'.repeat(64), accountId: '17841400000000022' },
      });
      expect(wrongSecret.status).toBe(400);

      // A tentativa inválida não consome a seleção; a válida funciona uma única vez.
      const ok = await req('/api/auth/instagram/select', {
        method: 'POST',
        form: { pendingId, secret, accountId: '17841400000000022' },
      });
      expect(ok.status).toBe(200);
      const acc = await getInstagramAccountByIdOrUser('tenant_multi');
      expect(acc?.instagramUserId).toBe('17841400000000022');
      expect(acc?.username).toBe('segunda');

      const again = await req('/api/auth/instagram/select', {
        method: 'POST',
        form: { pendingId, secret, accountId: '17841400000000021' },
      });
      expect(again.status).toBe(400);
    });
  });

  // ------------------------------------------------------------------
  // Jornada completa: cadastro -> aprovação -> login (e-mail/senha) -> conexão do Instagram
  // ------------------------------------------------------------------
  describe('Jornada do cliente: autenticação no Social Hub separada da autorização do Instagram', () => {
    it('cadastro com e-mail confirmado e espaço de trabalho; a conexão do Instagram só ocorre depois, na empresa do próprio usuário', async () => {
      // O antigo /api/auth/register criava sessão sem confirmar o e-mail e dependia de aprovação manual.
      // O cadastro público agora confirma o e-mail e cria o espaço de trabalho; o que o teste garante continua igual:
      // autenticar no Social Hub é uma etapa e autorizar o Instagram é outra, sempre dentro da empresa do usuário.
      resetGraph();
      const suffix = Date.now();
      const email = `cliente.${suffix}@empresa.com.br`;
      const mails: MailMessage[] = [];
      setMailTransportForTests(async (m) => void mails.push(m));
      try {
        const reg = await req('/api/auth/signup', {
          method: 'POST',
          body: { name: 'Marina Costa', email, password: 'Senha-Segura-123', acceptTerms: true },
        });
        expect(reg.status).toBe(202);
        expect(reg.body.token).toBeUndefined();
        const link = mails.find((m) => m.to === email)!.text.match(/https?:\/\/\S+/)![0];
        const verified = await req('/api/auth/verify-email', { method: 'POST', body: { token: new URL(link).searchParams.get('code') } });
        expect(verified.status).toBe(200);
        const ws = await req('/api/workspaces', { method: 'POST', token: verified.body.token, body: { companyName: `Clinica ${suffix}` } });
        expect(ws.status).toBe(201);
        expect(ws.body.user.connectionStatus).toBe('DESCONECTADO');
        const tenantId = ws.body.user.tenantId;

        // Login por e-mail e senha (senha errada é recusada).
        const bad = await req('/api/auth/login', { method: 'POST', body: { email, password: 'senhaErrada' } });
        expect(bad.status).toBe(401);
        const login = await req('/api/auth/login', { method: 'POST', body: { email, password: 'Senha-Segura-123' } });
        expect(login.status).toBe(200);
        expect(login.body.user.tenantId).toBe(tenantId);

        // Só agora autoriza o Instagram, com a sessão do Social Hub.
        const { state, cookie } = await startFlow(login.body.token);
        const cb = await callback(state, cookie);
        expect(cb.status).toBe(200);
        expect(cb.body.token).toBeUndefined();
        const acc = await getInstagramAccountByIdOrUser(tenantId);
        expect(acc?.connectionStatus).toBe('CONECTADO');
        expect(acc?.companyId).toBe(ws.body.user.companyId);
        expect(acc?.instagramUserId).toBe(graph.accounts[0].id);
      } finally {
        setMailTransportForTests(null);
      }
    }, 30000);

    it('espaço de trabalho sem Instagram: pode revisar e aprovar, mas agendar e publicar são bloqueados no servidor', async () => {
      resetGraph();
      await seedTenant('tenant_sem_ig', { driveFolderName: 'Sem IG', username: 'cadastro_sem_ig', instagramUserId: 'pending_ig_sem_ig' });
      const mk = (id: string) => ({
        id, nome: id, loteNome: `lote_${id}`, categoria: 'Post Único' as const, status: 'PENDENTE' as const,
        tenantId: 'tenant_sem_ig', driveFolderName: 'Sem IG', pastaClienteNome: 'Sem IG', pastaClienteId: 'folder_sem_ig',
        caption: 'legenda', dataCriacao: new Date().toISOString(),
        items: [{ driveFileId: `file_${id}`, nome: '01.jpg', categoria: 'Post Único' as const, loteNome: `lote_${id}`, viewUrl: 'https://cdn.exemplo.test/a.jpg', thumbnailUrl: 'https://cdn.exemplo.test/a.jpg', dataCriacao: new Date().toISOString(), status: 'PENDENTE' as const, tenantId: 'tenant_sem_ig', driveFolderName: 'Sem IG', pastaClienteNome: 'Sem IG', pastaClienteId: 'folder_sem_ig' }],
      });
      await upsertPostGroupToDb(mk('post_sem_ig') as any);
      await syncStateFromPostgres(true);
      const token = tenantUser('tenant_sem_ig');
      const future = new Date(Date.now() + 86400000).toISOString();

      expect((await req('/api/posts/post_sem_ig/publish', { method: 'POST', token, body: { action: 'APPROVE', caption: 'ok' } })).status).toBe(200);
      const now = await req('/api/posts/post_sem_ig/publish', { method: 'POST', token, body: { action: 'NOW', caption: 'ok' } });
      expect(now.status).toBe(409);
      expect(now.body.code).toBe('INSTAGRAM_NOT_CONNECTED');
      const sched = await req('/api/posts/post_sem_ig/publish', { method: 'POST', token, body: { action: 'SCHEDULE', scheduledAt: future } });
      expect(sched.status).toBe(409);
      const direct = await req('/api/instagram/publish', { method: 'POST', token, body: { id: 'post_sem_ig', caption: 'x' } });
      expect(direct.status).toBe(409);
      expect(direct.body.code).toBe('INSTAGRAM_NOT_CONNECTED');
      expect(graphCalls.some((u) => u.includes('/media'))).toBe(false);
    }, 30000);

    it('reconexão: conta com autorização expirada volta a CONECTADO pelo mesmo fluxo e continua vinculada à mesma empresa', async () => {
      resetGraph();
      await seedTenant('tenant_reconecta', {
        driveFolderName: 'Reconecta', username: 'conta_real', instagramUserId: graph.accounts[0].id,
        connectionStatus: 'RECONEXAO_NECESSARIA', status: 'RECONEXAO_NECESSARIA',
      });
      const token = tenantUser('tenant_reconecta');
      const { state, cookie } = await startFlow(token);
      const cb = await callback(state, cookie);
      expect(cb.status).toBe(200);
      expect(cb.body.token).toBeUndefined();
      const acc = await getInstagramAccountByIdOrUser('tenant_reconecta');
      expect(acc?.connectionStatus).toBe('CONECTADO');
      expect(acc?.id).toBe('tenant_reconecta');
      expect(acc?.driveFolderName).toBe('Reconecta');
    }, 30000);

    it('o callback nunca gera sessão: nem JWT, nem cookie de sessão, nem HTML com token', async () => {
      resetGraph();
      await seedTenant('tenant_nosession');
      const { state, cookie } = await startFlow(tenantUser('tenant_nosession'));
      const r = await req(`/api/auth/instagram/callback?state=${encodeURIComponent(state)}&code=c_${Date.now()}`, { cookie });
      expect(r.status).toBe(200);
      expect(r.raw).not.toContain('ato_social_jwt_token');
      expect(r.raw).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
      expect(r.setCookie).not.toMatch(/session|jwt|token/i);
    });
  });

  describe('Senhas e administrador', () => {
    it('hashes antigos (SHA-256) continuam válidos e são regravados em scrypt no primeiro login', async () => {
      const { legacySha256, verifyPassword } = await import('../utils/passwordHash.ts');
      const legacy = legacySha256('senhaAntiga123');
      expect(verifyPassword('senhaAntiga123', legacy)).toEqual({ ok: true, needsRehash: true });
      expect(verifyPassword('outra', legacy).ok).toBe(false);

      const email = `legado.${Date.now()}@empresa.com.br`;
      await dbQuery(
        `INSERT INTO users (id, email, name, password_hash, role, status, updated_at) VALUES ($1,$2,'Legado',$3,'TENANT','APROVADO',NOW())`,
        [`usr_legado_${Date.now()}`, email, legacy]
      );
      const login = await req('/api/auth/login', { method: 'POST', body: { email, password: 'senhaAntiga123' } });
      expect(login.status).toBe(200);
      const row = await dbQuery(`SELECT password_hash FROM users WHERE LOWER(email)=$1`, [email]);
      expect(String(row.rows[0].password_hash).startsWith('scrypt$')).toBe(true);
    });

    it('reiniciar o app NÃO redefine a senha do administrador nem cria senha padrão fora de testes', async () => {
      const { ensureDefaultAdminUser } = await import('../db/repository.ts');
      const savedPw = process.env.ADMIN_BOOTSTRAP_PASSWORD;
      try {
        // Simula produção SEM mexer em VITEST (que mantém os testes isolados do banco real):
        // desliga apenas os padrões de teste e a senha de bootstrap.
        delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
        const asProduction = { allowTestDefaults: false };
        await dbQuery(`UPDATE users SET password_hash = 'scrypt$custom$marcador' WHERE id = 'user_admin_ato'`);
        await ensureDefaultAdminUser(asProduction);
        const kept = await dbQuery(`SELECT password_hash FROM users WHERE id = 'user_admin_ato'`);
        expect(kept.rows[0].password_hash).toBe('scrypt$custom$marcador');

        // Admin inexistente + produção sem senha => conta sem login habilitado (nunca "666666").
        await dbQuery(`DELETE FROM users WHERE id = 'user_admin_ato'`);
        await ensureDefaultAdminUser(asProduction);
        const created = await dbQuery(`SELECT password_hash FROM users WHERE id = 'user_admin_ato'`);
        expect(String(created.rows[0].password_hash).startsWith('disabled$')).toBe(true);
        const loginTry = await req('/api/auth/login', {
          method: 'POST',
          body: { email: 'admin@atodev.com.br', password: '666666' },
        });
        expect(loginTry.status).toBe(401);
      } finally {
        if (savedPw !== undefined) process.env.ADMIN_BOOTSTRAP_PASSWORD = savedPw;
        await ensureDefaultAdminUser();
      }
    });
  });

  describe('Publicação entre empresas', () => {
    it('usuário da empresa A não publica conteúdo da empresa B nem usa a conta Instagram da empresa B', async () => {
      resetGraph();
      await seedTenant('tenant_pub_a', { driveFolderName: 'Pub A', username: 'pub_a', instagramUserId: '17841400000100001', connectionStatus: 'CONECTADO', hasValidToken: true });
      await seedTenant('tenant_pub_b', { driveFolderName: 'Pub B', username: 'pub_b', instagramUserId: '17841400000100002', connectionStatus: 'CONECTADO', hasValidToken: true });
      const mkPost = (id: string, tenantId: string, folder: string) => ({
        id,
        nome: id,
        loteNome: `lote_${id}`,
        categoria: 'Post Único' as const,
        status: 'APROVADO' as const,
        tenantId,
        scheduledAccountId: tenantId,
        driveFolderName: folder,
        pastaClienteNome: folder,
        pastaClienteId: `folder_${tenantId}`,
        caption: 'legenda',
        isApprovedForSchedule: true,
        captionApproved: true,
        dataCriacao: new Date().toISOString(),
        items: [
          {
            driveFileId: `file_${id}`,
            nome: '01.jpg',
            categoria: 'Post Único' as const,
            loteNome: `lote_${id}`,
            viewUrl: 'https://cdn.exemplo.test/a.jpg',
            thumbnailUrl: 'https://cdn.exemplo.test/a.jpg',
            dataCriacao: new Date().toISOString(),
            status: 'APROVADO' as const,
            tenantId,
            driveFolderName: folder,
            pastaClienteNome: folder,
            pastaClienteId: `folder_${tenantId}`,
          },
        ],
      });
      await upsertPostGroupToDb(mkPost('post_pub_a', 'tenant_pub_a', 'Pub A') as any);
      await upsertPostGroupToDb(mkPost('post_pub_b', 'tenant_pub_b', 'Pub B') as any);
      await syncStateFromPostgres(true);
      const tokenA = tenantUser('tenant_pub_a');

      // 1) Conteúdo de outra empresa.
      const otherPost = await req('/api/instagram/publish', { method: 'POST', token: tokenA, body: { id: 'post_pub_b', caption: 'x' } });
      expect(otherPost.status).toBe(403);
      // 2) Conteúdo próprio, mas escolhendo a conta Instagram de outra empresa.
      const otherAccount = await req('/api/instagram/publish', {
        method: 'POST',
        token: tokenA,
        body: { id: 'post_pub_a', accountId: 'tenant_pub_b', caption: 'x' },
      });
      expect(otherAccount.status).toBe(403);
      // 3) Nenhuma chamada de publicação chegou à Meta.
      expect(graphCalls.some((u) => u.includes('/media'))).toBe(false);
    });
  });

  describe('Provisionamento de login para empresas existentes', () => {
    it('lista empresas sem login e cria login sem alterar usuários existentes', async () => {
      const { listTenantsWithoutLogin, createTenantLogin } = await import('../services/tenantLogins.ts');
      await seedTenant('tenant_so_instagram', { username: 'so_instagram', instagramUserId: '17841400000200001', connectionStatus: 'CONECTADO', hasValidToken: true });
      const before = await listTenantsWithoutLogin();
      expect(before.map((t) => t.id)).toContain('tenant_so_instagram');

      const created = await createTenantLogin({ tenantId: 'tenant_so_instagram', email: `so.instagram.${Date.now()}@empresa.com.br` });
      expect(created.password.length).toBeGreaterThanOrEqual(20);
      const stored = await dbQuery(`SELECT password_hash FROM users WHERE id = $1`, [created.userId]);
      expect(String(stored.rows[0].password_hash).startsWith('scrypt$')).toBe(true);
      expect(String(stored.rows[0].password_hash)).not.toContain(created.password);

      // O login criado funciona e leva à empresa certa.
      const login = await req('/api/auth/login', { method: 'POST', body: { email: created.email, password: created.password } });
      expect(login.status).toBe(200);
      expect(login.body.user.tenantId).toBe('tenant_so_instagram');

      // Segunda tentativa não altera nada.
      await expect(createTenantLogin({ tenantId: 'tenant_so_instagram', email: 'outro@empresa.com.br' })).rejects.toThrow(/já possui um login com senha/);
      expect((await listTenantsWithoutLogin()).map((t) => t.id)).not.toContain('tenant_so_instagram');
    }, 30000);
  });

  it('o estado do app é sincronizado sem erro após os fluxos', async () => {
    await expect(syncStateFromPostgres(true)).resolves.toBeUndefined();
  });
});
