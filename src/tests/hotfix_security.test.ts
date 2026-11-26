import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Hotfix de segurança. Cada teste reproduz uma falha que existia na versão publicada e comprova a correção.
// Os valores abaixo são FICTÍCIOS: nada aqui usa o .env nem o banco real (PostgreSQL em memória).
const JWT_SECRET = 'hotfix-test-jwt-secret-0123456789abcdef0123456789';
const WEBHOOK_SECRET = 'hotfix-test-webhook-secret-0123456789';
process.env.JWT_SECRET = JWT_SECRET;
process.env.TOKEN_ENCRYPTION_KEY = 'hotfix-test-token-encryption-key-0123456789';
process.env.WEBHOOK_SECRET_TOKEN = WEBHOOK_SECRET;
process.env.CRON_SECRET = 'hotfix-test-cron-secret-0123456789';
process.env.APP_URL = 'https://hub.test.invalid';
delete process.env.SESSIONS_VALID_AFTER;

let app: any;
let server: http.Server;
let base = '';
let dbQuery: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

const SEGREDO = 'SEGREDO-DO-CLIENTE-B';
const MARCADORES = /tenant_cliente_b|company_cliente_b|post_cliente_b|SEGREDO-DO-CLIENTE-B|obs_cliente_b|Pasta Cliente B/;
const nowSec = () => Math.floor(Date.now() / 1000);

const tokenCliente = (extra: Record<string, unknown> = {}) =>
  jwt.sign({ id: 'usr_cliente_a', nome: 'Cliente A', email: 'a@exemplo.test', role: 'TENANT', tenantId: 'tenant_cliente_a', driveFolderName: 'Pasta Cliente A', ...extra }, JWT_SECRET, { expiresIn: '1h' });
const tokenSemEmpresa = () =>
  jwt.sign({ id: 'usr_sem_empresa', nome: 'Sem Empresa', email: 'sem@exemplo.test', role: 'TENANT' }, JWT_SECRET, { expiresIn: '1h' });
const tokenAdmin = () => jwt.sign({ id: 'usr_admin_hf', nome: 'Admin', email: 'admin@exemplo.test', role: 'ADMIN' }, JWT_SECRET, { expiresIn: '1h' });
// Exatamente o formato que a rota antiga entregava: ADMIN, validade de 3650 dias.
const tokenDezAnos = (iat?: number) =>
  jwt.sign({ id: 'gas_long_lived_service', email: 'drive-sync@atosocial.com', role: 'ADMIN', ...(iat ? { iat } : {}) }, JWT_SECRET, { expiresIn: '3650d' });

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const r = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    /* sem corpo */
  }
  return { status: r.status, body };
}

beforeAll(async () => {
  const srv = await import('../../server.ts');
  app = srv.app;
  ({ dbQuery } = (await import('../db/pool.ts')) as any);
  const repo = await import('../db/repository.ts');
  await srv.ensurePostgresBootstrapped();

  for (const [id, nome, pasta, ig] of [
    ['tenant_cliente_a', 'Cliente A', 'Pasta Cliente A', '17841400000001'],
    ['tenant_cliente_b', 'Cliente B', 'Pasta Cliente B', '17841400000002'],
  ]) {
    await repo.upsertInstagramAccount({
      id, username: id.replace('tenant_', ''), nome, instagramUserId: ig, account_type: 'BUSINESS', driveFolderName: pasta,
      status: 'APROVADO', connectionStatus: 'DESCONECTADO', hasValidToken: false, requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
    } as any);
  }
  await dbQuery(`INSERT INTO companies (id,name,drive_folder_name) VALUES ('company_cliente_b','Cliente B Ltda','Pasta Cliente B') ON CONFLICT DO NOTHING`);
  await dbQuery(`UPDATE instagram_accounts SET company_id='company_cliente_b' WHERE id='tenant_cliente_b'`);
  await dbQuery(`INSERT INTO companies (id,name,drive_folder_name) SELECT 'company_ato_fx','Ato','Ato' WHERE NOT EXISTS (SELECT 1 FROM companies WHERE LOWER(name)='ato')`);
  const item = {
    driveFileId: 'file_cliente_b', nome: '01.jpg', categoria: 'Post Único', loteNome: 'lote_cliente_b', viewUrl: 'https://cdn.exemplo.test/a.jpg',
    thumbnailUrl: 'https://cdn.exemplo.test/a.jpg', dataCriacao: new Date().toISOString(), status: 'PENDENTE', tenantId: 'tenant_cliente_b',
    driveFolderName: 'Pasta Cliente B', pastaClienteNome: 'Pasta Cliente B', pastaClienteId: 'folder_cliente_b',
  };
  await repo.upsertPostGroupToDb({
    id: 'post_cliente_b', nome: 'post_cliente_b', loteNome: 'lote_cliente_b', categoria: 'Post Único', status: 'PENDENTE', tenantId: 'tenant_cliente_b',
    driveFolderName: 'Pasta Cliente B', pastaClienteNome: 'Pasta Cliente B', pastaClienteId: 'folder_cliente_b', caption: 'legenda do cliente B',
    dataCriacao: new Date().toISOString(), items: [item],
  } as any);
  await repo.createClientObservationInDb({
    id: 'obs_cliente_b', companyId: 'company_cliente_b', tenantId: 'tenant_cliente_b', userId: 'x', authorName: 'x', content: SEGREDO,
    type: 'PONTUAL', isActive: true, syncStatus: 'SYNCED',
  } as any);
  await dbQuery(`INSERT INTO users (id,email,name,password_hash,role,status) VALUES ('usr_sem_empresa','sem@exemplo.test','Sem Empresa','x','TENANT','APROVADO')`);
  await srv.syncStateFromPostgres(true);

  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  delete process.env.SESSIONS_VALID_AFTER;
});

describe('1. Nenhuma credencial administrativa chega ao navegador', () => {
  it('cliente (com ou sem empresa) recebe 403 em gas-config; nada de JWT nem segredo na resposta', async () => {
    for (const token of [tokenCliente(), tokenSemEmpresa()]) {
      const r = await call('GET', '/api/system/gas-config', { token });
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toMatch(/tenYearJwt|webhookSecretToken|eyJ/);
    }
    expect((await call('GET', '/api/system/gas-config')).status).toBe(401);
  });

  it('mesmo para o administrador a rota não devolve JWT nem o valor do segredo', async () => {
    const r = await call('GET', '/api/system/gas-config', { token: tokenAdmin() });
    expect(r.status).toBe(200);
    const corpo = JSON.stringify(r.body);
    expect(corpo).not.toContain(WEBHOOK_SECRET);
    expect(corpo).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // nenhum JWT
    expect(r.body.tenYearJwt).toBeUndefined();
    expect(r.body.webhookSecretToken).toBeUndefined();
    expect(r.body.webhookSecretConfigured).toBe(true);
  });
});

describe('2. Cliente não alcança rotas internas', () => {
  it('agendador, status do banco, status do agendador e pastas do Drive exigem ADMIN', async () => {
    for (const token of [tokenCliente(), tokenSemEmpresa()]) {
      for (const [m, p] of [
        ['GET', '/api/scheduler/status'], ['GET', '/api/drive/folders'], ['GET', '/api/system/db-status'],
        ['POST', '/api/scheduler/run'], ['GET', '/api/scheduler/run'], ['POST', '/api/scheduler/refresh-tokens'],
      ] as const) {
        const r = await call(m, p, { token });
        expect([401, 403], `${m} ${p} respondeu ${r.status}`).toContain(r.status);
      }
    }
    expect((await call('GET', '/api/scheduler/status', { token: tokenAdmin() })).status).toBe(200);
    expect((await call('GET', '/api/system/db-status', { token: tokenAdmin() })).status).toBe(200);
  });

  it('webhook do Drive: JWT de cliente é recusado e não grava nada; o segredo do Apps Script e o ADMIN continuam valendo', async () => {
    const payload = { lotes: [{ loteNome: 'lote_invasor', pastaClienteNome: 'Pasta Cliente B', arquivos: [{ driveFileId: 'file_invasor', nome: 'x.jpg' }] }] };
    const r = await call('POST', '/api/webhooks/drive-sync', { token: tokenCliente(), body: payload });
    expect(r.status).toBe(401);
    expect((await dbQuery(`SELECT 1 FROM posts WHERE lote_nome='lote_invasor'`)).rows).toHaveLength(0);
    expect((await call('POST', '/api/webhooks/drive-sync', { token: WEBHOOK_SECRET, body: { lotes: [] } })).status).toBe(200);
    expect((await call('POST', '/api/webhooks/drive-sync', { token: tokenAdmin(), body: { lotes: [] } })).status).toBe(200);
  });

  it('agendador não fica aberto em produção quando não há segredo configurado', async () => {
    const antes = { env: process.env.NODE_ENV, cron: process.env.CRON_SECRET, wh: process.env.WEBHOOK_SECRET_TOKEN };
    process.env.NODE_ENV = 'production';
    delete process.env.CRON_SECRET;
    delete process.env.WEBHOOK_SECRET_TOKEN;
    try {
      expect((await call('GET', '/api/scheduler/run')).status).toBe(401);
    } finally {
      process.env.NODE_ENV = antes.env;
      process.env.CRON_SECRET = antes.cron;
      process.env.WEBHOOK_SECRET_TOKEN = antes.wh;
    }
  });
});

describe('3. Isolamento entre empresas', () => {
  const LEITURAS = ['/api/posts', '/api/tenants', '/api/companies', '/api/observations', '/api/creative-context', '/api/posts/post_cliente_b/captions'];

  it('cliente A não vê pastas, posts, observações nem empresa do cliente B', async () => {
    for (const rota of LEITURAS) {
      const r = await call('GET', rota, { token: tokenCliente() });
      expect(JSON.stringify(r.body), `GET ${rota} (${r.status}) vazou dados do cliente B`).not.toMatch(MARCADORES);
    }
    const posts = await call('GET', '/api/posts', { token: tokenCliente() });
    expect(posts.body.availableFolders).not.toContain('Pasta Cliente B');
    expect(JSON.stringify(posts.body.folderDetails)).not.toContain('Pasta Cliente B');
  });

  it('cliente A não altera o post do cliente B', async () => {
    const antes = (await dbQuery(`SELECT status, caption FROM posts WHERE id='post_cliente_b'`)).rows[0];
    const t = tokenCliente();
    const tentativas = await Promise.all([
      call('PUT', '/api/posts/post_cliente_b/captions', { token: t, body: { caption: 'INVADIDO' } }),
      call('POST', '/api/posts/post_cliente_b/publish', { token: t, body: { action: 'APPROVE', caption: 'INVADIDO' } }),
      call('POST', '/api/posts/post_cliente_b/reject', { token: t, body: { reason: 'x' } }),
      call('POST', '/api/posts/post_cliente_b/hide', { token: t, body: {} }),
      call('DELETE', '/api/posts/post_cliente_b', { token: t }),
    ]);
    for (const r of tentativas) expect([400, 401, 403, 404]).toContain(r.status);
    expect((await dbQuery(`SELECT status, caption FROM posts WHERE id='post_cliente_b'`)).rows[0]).toEqual(antes);
  });

  it('sync-drive devolve ao cliente só a confirmação, também quando o Drive falha', async () => {
    const r = await call('POST', '/api/posts/sync-drive', { token: tokenCliente(), body: { acao: 'SINCRONIZAR_TUDO' } });
    const corpo = JSON.stringify(r.body);
    expect(corpo).not.toMatch(MARCADORES);
    expect(r.body.folders).toBeUndefined();
    expect(r.body.folderDetails).toBeUndefined();
    expect(r.body.lotes).toBeUndefined();
    expect(r.body.rawResponsePreview).toBeUndefined();
  });

  it('o administrador mantém a resposta completa do sync-drive (integração com o Drive preservada)', async () => {
    const r = await call('POST', '/api/posts/sync-drive', { token: tokenAdmin(), body: { acao: 'SINCRONIZAR_TUDO' } });
    expect([200, 502]).toContain(r.status); // 502 aqui porque o Apps Script não está configurado no teste
    expect(Array.isArray(r.body.folders)).toBe(true);
    expect(Array.isArray(r.body.folderDetails)).toBe(true);
    expect(JSON.stringify(r.body.folders)).toContain('Pasta Cliente B');
  });

  it('usuário sem empresa não vê nada e NÃO é associado à empresa Ato nem a qualquer outra', async () => {
    const empresasAntes = (await dbQuery(`SELECT count(*)::int n FROM companies`)).rows[0].n;
    const t = tokenSemEmpresa();
    for (const rota of LEITURAS) {
      const r = await call('GET', rota, { token: t });
      expect(JSON.stringify(r.body), `GET ${rota} vazou dados`).not.toMatch(MARCADORES);
    }
    const posts = await call('GET', '/api/posts', { token: t });
    expect(posts.body.availableFolders ?? []).toEqual([]);
    const criar = await call('POST', '/api/observations', { token: t, body: { content: 'tentativa' } });
    expect([400, 403, 500]).toContain(criar.status);
    const u = (await dbQuery(`SELECT company_id, instagram_account_id FROM users WHERE id='usr_sem_empresa'`)).rows[0];
    expect(u.company_id).toBeNull();
    expect(u.instagram_account_id).toBeNull();
    expect((await dbQuery(`SELECT count(*)::int n FROM companies`)).rows[0].n).toBe(empresasAntes); // nenhuma empresa criada
    expect((await dbQuery(`SELECT 1 FROM client_observations WHERE content='tentativa'`)).rows).toHaveLength(0);
  });

  it('o administrador continua vendo todas as pastas e posts', async () => {
    const r = await call('GET', '/api/posts', { token: tokenAdmin() });
    expect(r.status).toBe(200);
    expect(r.body.posts.some((p: any) => p.id === 'post_cliente_b')).toBe(true);
    expect(r.body.availableFolders).toContain('Pasta Cliente B');
  });
});

describe('4. Revogação por SESSIONS_VALID_AFTER', () => {
  const ROTAS_ADMIN = [
    ['GET', '/api/system/gas-config'], // requireAuth
    ['GET', '/api/system/db-status'], // agendador/administrador
    ['POST', '/api/webhooks/drive-sync'], // webhook/administrador
  ] as const;
  const status = (token: string) => Promise.all(ROTAS_ADMIN.map(([m, p]) => call(m, p, { token, body: m === 'POST' ? { lotes: [] } : undefined }).then((r) => r.status)));

  it('antes do corte, o token antigo de 10 anos funciona; depois do corte é recusado em todas as rotas', async () => {
    const antigo = tokenDezAnos(nowSec() - 30 * 86400);
    expect(await status(antigo)).toEqual([200, 200, 200]);
    process.env.SESSIONS_VALID_AFTER = new Date(Date.now() - 1000).toISOString();
    expect(await status(antigo)).toEqual([401, 401, 401]);
  });

  it('token emitido depois do corte continua válido (login novo funciona)', async () => {
    process.env.SESSIONS_VALID_AFTER = new Date(Date.now() - 60_000).toISOString();
    expect(await status(tokenAdmin())).toEqual([200, 200, 200]);
  });

  it('token sem data de emissão (iat) não prova nada: é recusado quando há corte', async () => {
    const semIat = jwt.sign({ id: 'gas_long_lived_service', role: 'ADMIN' }, JWT_SECRET, { expiresIn: '3650d', noTimestamp: true });
    expect((jwt.decode(semIat) as any).iat).toBeUndefined();
    process.env.SESSIONS_VALID_AFTER = new Date(Date.now() - 1000).toISOString();
    expect(await status(semIat)).toEqual([401, 401, 401]);
  });

  it('valor inválido no corte derruba todas as sessões (falha fechada)', async () => {
    process.env.SESSIONS_VALID_AFTER = 'não-é-uma-data';
    expect(await status(tokenAdmin())).toEqual([401, 401, 401]);
  });

  it('limite conhecido: o segredo estático do webhook NÃO é coberto pelo corte e só deixa de valer ao ser trocado', async () => {
    process.env.SESSIONS_VALID_AFTER = new Date(Date.now() + 60_000).toISOString();
    expect((await call('POST', '/api/webhooks/drive-sync', { token: WEBHOOK_SECRET, body: { lotes: [] } })).status).toBe(200);
    process.env.WEBHOOK_SECRET_TOKEN = 'novo-segredo-rotacionado-0123456789';
    try {
      expect((await call('POST', '/api/webhooks/drive-sync', { token: WEBHOOK_SECRET, body: { lotes: [] } })).status).toBe(401);
    } finally {
      process.env.WEBHOOK_SECRET_TOKEN = WEBHOOK_SECRET;
    }
  });
});
