import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app, syncStateFromPostgres } from '../../server.ts';
import { dbQuery } from '../db/pool.ts';
import { runDatabaseMigrations } from '../db/migrations.ts';
import { createClientObservationInDb, upsertPostGroupToDb } from '../db/repository.ts';
import { hashPassword } from '../utils/passwordHash.ts';
import { setMailTransportForTests, type MailMessage } from '../services/mailer.ts';

// Varredura de isolamento: quem se cadastra publicamente (sem empresa, ou com um espaço de nome igual ao de um
// cliente existente) nunca vê nem altera dados de clientes existentes e nunca recebe poder administrativo.

let server: http.Server;
let base = '';
const outbox: MailMessage[] = [];
let ipCounter = 10;
const newIp = () => `198.51.100.${ipCounter++}`;

async function call(method: string, path: string, body?: unknown, opts: { token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': newIp() };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    /* sem corpo */
  }
  return { status: r.status, body: json };
}

const STRONG = 'Cadastro-Seguro-2026';
async function signupAndVerify(email: string) {
  expect((await call('POST', '/api/auth/signup', { name: 'Pessoa Teste', email, password: STRONG, acceptTerms: true })).status).toBe(202);
  const mail = [...outbox].reverse().find((m) => m.to === email)!;
  const token = new URL(mail.text.match(/https?:\/\/\S+/)![0]).searchParams.get('code')!;
  const v = await call('POST', '/api/auth/verify-email', { token });
  expect(v.status).toBe(200);
  return v.body as { token: string };
}

const SEGREDO = 'SEGREDO-CLIENTE-EXISTENTE';
const MARCADORES = /tenant_vazamento|company_vazamento|post_vazamento|SEGREDO-CLIENTE|obs_vazamento/;
let adminToken = '';

beforeAll(async () => {
  await runDatabaseMigrations();
  setMailTransportForTests(async (m) => void outbox.push(m));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await dbQuery(`INSERT INTO companies (id,name,drive_folder_name) VALUES ('company_vazamento','Cliente Vazamento SA','Pasta Vazamento')`);
  await dbQuery(`INSERT INTO companies (id,name,drive_folder_name) SELECT 'company_ato_fx','Ato','Ato' WHERE NOT EXISTS (SELECT 1 FROM companies WHERE LOWER(name)='ato')`);
  await dbQuery(
    `INSERT INTO instagram_accounts (id,company_id,username,nome,instagram_user_id,drive_folder_name,status,connection_status,has_valid_token)
     VALUES ('tenant_vazamento','company_vazamento','cliente_vazamento','Cliente Vazamento','1784100000777','Pasta Vazamento','APROVADO','CONECTADO',true)`
  );
  const item = {
    driveFileId: 'file_vazamento', nome: '01.jpg', categoria: 'Post Único', loteNome: 'lote_vazamento',
    viewUrl: 'https://cdn.exemplo.test/a.jpg', thumbnailUrl: 'https://cdn.exemplo.test/a.jpg', dataCriacao: new Date().toISOString(),
    status: 'PENDENTE', tenantId: 'tenant_vazamento', driveFolderName: 'Pasta Vazamento', pastaClienteNome: 'Pasta Vazamento', pastaClienteId: 'folder_vazamento',
  };
  await upsertPostGroupToDb({
    id: 'post_vazamento', nome: 'post_vazamento', loteNome: 'lote_vazamento', categoria: 'Post Único', status: 'PENDENTE',
    tenantId: 'tenant_vazamento', driveFolderName: 'Pasta Vazamento', pastaClienteNome: 'Pasta Vazamento', pastaClienteId: 'folder_vazamento',
    caption: 'legenda original', dataCriacao: new Date().toISOString(), items: [item],
  } as any);
  await createClientObservationInDb({
    id: 'obs_vazamento', companyId: 'company_vazamento', tenantId: 'tenant_vazamento', userId: 'x', authorName: 'x',
    content: SEGREDO, type: 'PONTUAL', isActive: true, syncStatus: 'SYNCED',
  } as any);
  await syncStateFromPostgres(true);
  await dbQuery(
    `INSERT INTO users (id,email,name,password_hash,role,status) VALUES ('usr_admin_varredura','admin-varredura@exemplo.com','Admin','${hashPassword('Senha-Admin-2026')}','ADMIN','APROVADO')`
  );
  adminToken = (await call('POST', '/api/auth/login', { email: 'admin-varredura@exemplo.com', password: 'Senha-Admin-2026' })).body.token;
});

afterAll(async () => {
  setMailTransportForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
});

/** Quem cria a empresa e libera o usuário é o administrador (aprovação). Devolve { status, body: { user, token } } da sessão atualizada. */
async function workspaceFor(session: { token: string; user: { id: string } }, companyName: string) {
  const ap = await call('POST', `/api/admin/users/${session.user.id}/approve`, { newCompanyName: companyName, role: 'OWNER' }, { token: adminToken });
  if (ap.status !== 200) return { status: ap.status, body: ap.body };
  const me = await call('GET', '/api/auth/me', undefined, { token: session.token });
  return { status: me.status === 200 ? 201 : me.status, body: me.body };
}

const LEITURAS = [
  '/api/posts', '/api/tenants', '/api/companies', '/api/observations', '/api/creative-context',
  '/api/drive/folders', '/api/scheduler/status', '/api/system/gas-config', '/api/posts/post_vazamento/captions',
  '/api/debug/state', '/api/admin/integrations/status', '/api/system/db-status',
];

async function varrer(token: string) {
  for (const rota of LEITURAS) {
    const r = await call('GET', rota, undefined, { token });
    const corpo = JSON.stringify(r.body);
    expect(corpo, `GET ${rota} (${r.status}) vazou dados de outro cliente`).not.toMatch(MARCADORES);
    expect(corpo, `GET ${rota} (${r.status}) entregou credencial`).not.toMatch(/tenYearJwt|webhookSecretToken/);
  }
}

describe('Cadastro público não alcança clientes existentes', () => {
  it('usuário confirmado, sem espaço de trabalho: nada de outros clientes e continua sem empresa', async () => {
    const session = await signupAndVerify('sem-espaco@exemplo.com');
    await varrer(session.token);
    await call('GET', '/api/observations', undefined, { token: session.token });
    await call('POST', '/api/observations', { content: 'tentativa' }, { token: session.token });
    await call('GET', '/api/creative-context', undefined, { token: session.token });
    const u = (await dbQuery<any>(`SELECT company_id, instagram_account_id, role FROM users WHERE LOWER(email)='sem-espaco@exemplo.com'`)).rows[0];
    expect(u.company_id).toBeNull(); // nenhuma rota o anexa a uma empresa (nem à "Ato")
    expect(u.instagram_account_id).toBeNull();
    expect(u.role).toBe('TENANT');
    expect((await call('POST', '/api/workspaces', { companyName: 'Meu Espaço Limpo' }, { token: session.token })).status).toBe(403); // sem autoconcessão
  });

  it('espaço novo com nome parecido com o da pasta de um cliente existente não enxerga nem altera nada dele', async () => {
    const session = await signupAndVerify('homonimo@exemplo.com');
    const w = await workspaceFor(session, 'Pasta Vazamento Filial');
    expect(w.status).toBe(201);
    const token = w.body.token;
    const posts = await call('GET', '/api/posts', undefined, { token });
    expect(JSON.stringify(posts.body.posts || [])).not.toMatch(MARCADORES);
    expect(JSON.stringify((await call('GET', '/api/observations', undefined, { token })).body)).not.toMatch(MARCADORES);
    await varrer(token);

    const antes = (await dbQuery<any>(`SELECT status, caption FROM posts WHERE id='post_vazamento'`)).rows[0];
    const tentativas = [
      call('PUT', '/api/posts/post_vazamento/captions', { caption: 'INVADIDO' }, { token }),
      call('POST', '/api/posts/post_vazamento/publish', { action: 'APPROVE', caption: 'INVADIDO' }, { token }),
      call('POST', '/api/posts/post_vazamento/reject', { reason: 'x' }, { token }),
      call('POST', '/api/posts/post_vazamento/hide', {}, { token }),
      call('DELETE', '/api/posts/post_vazamento', undefined, { token }),
    ];
    for (const r of await Promise.all(tentativas)) expect([400, 401, 403, 404]).toContain(r.status);
    const depois = (await dbQuery<any>(`SELECT status, caption FROM posts WHERE id='post_vazamento'`)).rows[0];
    expect(depois).toEqual(antes);
  });

  it('o espaço novo nunca herda nome de pasta de cliente existente nem se junta à empresa "Ato"', async () => {
    for (const [i, nome] of ['Ato', 'Pasta Vazamento', 'cliente vazamento sa'].entries()) {
      const session = await signupAndVerify(`homonimo-${i}@exemplo.com`);
      const w = await workspaceFor(session, nome);
      if (w.status === 409) {
        // Nome de empresa já existente: nenhuma empresa é criada nem vinculada, e o usuário segue aguardando aprovação.
        const me = await call('GET', '/api/auth/me', undefined, { token: session.token });
        expect(me.body.user.accessStatus).toBe('PENDING_APPROVAL');
        continue;
      }
      expect(w.status).toBe(201);
      const row = (await dbQuery<any>(
        `SELECT c.drive_folder_name AS folder, ia.drive_folder_name AS ia_folder
           FROM companies c JOIN instagram_accounts ia ON ia.company_id = c.id WHERE c.id = $1`,
        [w.body.user.companyId]
      )).rows[0];
      const empresas = (await dbQuery<any>(
        `SELECT 1 FROM companies WHERE id <> $1 AND (LOWER(name)=LOWER($2) OR LOWER(drive_folder_name)=LOWER($2))`,
        [w.body.user.companyId, row.folder]
      )).rows;
      expect(empresas).toHaveLength(0);
      const contas = (await dbQuery<any>(
        `SELECT 1 FROM instagram_accounts WHERE id <> $1 AND LOWER(drive_folder_name)=LOWER($2)`,
        [w.body.user.tenantId, row.ia_folder]
      )).rows;
      expect(contas).toHaveLength(0);
      const posts = (await dbQuery<any>(`SELECT 1 FROM posts WHERE LOWER(COALESCE(drive_folder_name,''))=LOWER($1)`, [row.folder]).catch(() => ({ rows: [] }))).rows;
      expect(posts).toHaveLength(0);
    }
  });

  it('nenhuma credencial de administrador é emitida a quem não é administrador global', async () => {
    const session = await signupAndVerify('curioso@exemplo.com');
    const w = await workspaceFor(session, 'Curiosos Ltda');
    for (const token of [session.token, w.body.token]) {
      expect((await call('GET', '/api/system/gas-config', undefined, { token })).status).toBe(403);
      expect((await call('GET', '/api/scheduler/status', undefined, { token })).status).toBe(403);
      expect((await call('GET', '/api/drive/folders', undefined, { token })).status).toBe(403);
      expect((await call('POST', '/api/admin/test-records/reset', {}, { token })).status).toBe(403);
    }
    expect((await call('GET', '/api/system/gas-config', undefined, { token: adminToken })).status).toBe(200); // o admin legítimo mantém o acesso
  });

  it('Atualizar posts (sync-drive) devolve ao cliente só o que é dele', async () => {
    const session = await signupAndVerify('sync@exemplo.com');
    const w = await workspaceFor(session, 'Sync Ltda');
    const r = await call('POST', '/api/posts/sync-drive', { acao: 'SINCRONIZAR_TUDO' }, { token: w.body.token });
    expect(JSON.stringify(r.body)).not.toMatch(MARCADORES);
  });
});
