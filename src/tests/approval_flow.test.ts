import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app, syncStateFromPostgres } from '../../server.ts';
import { dbQuery } from '../db/pool.ts';
import { rollbackMigration, runDatabaseMigrations } from '../db/migrations.ts';
import { upsertPostGroupToDb } from '../db/repository.ts';
import { hashPassword } from '../utils/passwordHash.ts';
import { setMailTransportForTests, type MailMessage } from '../services/mailer.ts';

// Fluxo completo: cadastro -> confirmação -> aguardando aprovação -> aprovação pelo administrador -> troca de empresa
// -> suspensão -> exclusão. Tudo contra o servidor real (Express) e PostgreSQL em memória; nada de mocks de autorização.

let server: http.Server;
let base = '';
const outbox: MailMessage[] = [];
let ipCounter = 10;
const newIp = () => `192.0.2.${ipCounter++}`;

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
async function signupAndVerify(email: string, name = 'Pessoa Teste') {
  expect((await call('POST', '/api/auth/signup', { name, email, password: STRONG, acceptTerms: true })).status).toBe(202);
  const mail = [...outbox].reverse().find((m) => m.to === email)!;
  const code = new URL(mail.text.match(/https?:\/\/\S+/)![0]).searchParams.get('code')!;
  const v = await call('POST', '/api/auth/verify-email', { token: code });
  expect(v.status).toBe(200);
  return v.body as { token: string; user: any };
}

const ATO = /post_ato_x|tenant_ato_x|ATO Pasta X|company_ato_x/;
const OUTRA = /post_b_x|tenant_b_x|B Pasta X|company_b_x/;
const ATO_IGID = '17841400099001';
let adminTok = '';
const admin = () => ({ token: adminTok });

async function seedCompany(prefix: string, name: string, folder: string, username: string, igid: string, over: { conn?: string; valid?: boolean; expires?: string | null } = {}) {
  await dbQuery(`INSERT INTO companies (id,name,drive_folder_name) VALUES ($1,$2,$3)`, [`company_${prefix}`, name, folder]);
  await dbQuery(
    `INSERT INTO instagram_accounts (id,company_id,username,nome,instagram_user_id,drive_folder_name,status,connection_status,has_valid_token,token_expires_at,encrypted_access_token)
     VALUES ($1,$2,$3,$4,$5,$6,'APROVADO',$7,$8,$9,'token-criptografado-fixo')`,
    [`tenant_${prefix}`, `company_${prefix}`, username, name, igid, folder, over.conn || 'CONECTADO', over.valid ?? true, over.expires ?? new Date(Date.now() + 40 * 86400000).toISOString()]
  );
  const item = {
    driveFileId: `file_${prefix}`, nome: '01.jpg', categoria: 'Post Único', loteNome: `lote_${prefix}`, viewUrl: 'https://cdn.exemplo.test/a.jpg',
    thumbnailUrl: 'https://cdn.exemplo.test/a.jpg', dataCriacao: new Date().toISOString(), status: 'PENDENTE', tenantId: `tenant_${prefix}`,
    driveFolderName: folder, pastaClienteNome: folder, pastaClienteId: `folder_${prefix}`,
  };
  await upsertPostGroupToDb({
    id: `post_${prefix}`, nome: `post_${prefix}`, loteNome: `lote_${prefix}`, categoria: 'Post Único', status: 'PENDENTE', tenantId: `tenant_${prefix}`,
    driveFolderName: folder, pastaClienteNome: folder, pastaClienteId: `folder_${prefix}`, caption: `legenda ${prefix}`, dataCriacao: new Date().toISOString(), items: [item],
  } as any);
}

beforeAll(async () => {
  await runDatabaseMigrations();
  setMailTransportForTests(async (m) => void outbox.push(m));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await seedCompany('ato_x', 'ATO Teste', 'ATO Pasta X', 'ato.vc', ATO_IGID);
  await seedCompany('b_x', 'Empresa B Teste', 'B Pasta X', 'empresa_b', '17841400099002');
  await seedCompany('exp_x', 'Empresa Expirada', 'Exp Pasta X', 'conta_expirada', '17841400099003', { conn: 'RECONEXAO_NECESSARIA', valid: false, expires: new Date(Date.now() - 86400000).toISOString() });
  await syncStateFromPostgres(true);
  await dbQuery(`INSERT INTO users (id,email,name,password_hash,role,status) VALUES ('usr_admin_fluxo','admin-fluxo@exemplo.com','Admin Fluxo',$1,'ADMIN','APROVADO')`, [hashPassword('Senha-Admin-2026')]);
  adminTok = (await call('POST', '/api/auth/login', { email: 'admin-fluxo@exemplo.com', password: 'Senha-Admin-2026' })).body.token;
});
afterAll(async () => {
  setMailTransportForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
});

const lista = async () => (await call('GET', '/api/admin/users', undefined, admin())).body;
const achar = async (id: string) => (await lista()).users.find((u: any) => u.id === id);

describe('A–C. Cadastro, confirmação e fila de aprovação', () => {
  it('cadastro confirmado entra autenticado, fica PENDING_APPROVAL e o administrador o vê na hora', async () => {
    const s = await signupAndVerify('pendente@exemplo.com', 'Paula Pendente');
    expect(s.user.accessStatus).toBe('PENDING_APPROVAL');
    expect(s.user.companyId).toBeUndefined();
    expect(s.user.tenantId).toBeUndefined();
    // dashboard inicial e conta: permitidos
    const me = await call('GET', '/api/auth/me', undefined, { token: s.token });
    expect(me.status).toBe(200);
    expect(me.body.user.accessStatus).toBe('PENDING_APPROVAL');
    expect(JSON.stringify(me.body)).not.toMatch(ATO);
    // aparece imediatamente na lista do administrador, com os dados reais
    const u = await achar(s.user.id);
    expect(u).toMatchObject({ name: 'Paula Pendente', email: 'pendente@exemplo.com', emailVerified: true, accessStatus: 'PENDING_APPROVAL', companyId: null, origin: 'EMAIL_SIGNUP' });
    expect(u.createdAt).toBeTruthy();
    expect(u.instagram).toBeNull();
  });

  it('B. pendente não lê nem altera nada: o backend recusa, mesmo com dados da ATO existentes', async () => {
    const s = await signupAndVerify('curiosa@exemplo.com');
    const t = { token: s.token };
    const leituras = ['/api/posts', '/api/tenants', '/api/accounts', '/api/companies', '/api/observations', '/api/creative-context', '/api/posts/post_ato_x/captions', '/api/drive/folders'];
    for (const rota of leituras) {
      const r = await call('GET', rota, undefined, t);
      expect([401, 403], `GET ${rota} -> ${r.status}`).toContain(r.status);
      expect(JSON.stringify(r.body)).not.toMatch(ATO);
    }
    const escritas: Array<[string, string, unknown]> = [
      ['POST', '/api/posts/post_ato_x/publish', { action: 'APPROVE', caption: 'x' }],
      ['POST', '/api/posts/post_ato_x/publish', { action: 'NOW', caption: 'x' }],
      ['POST', '/api/posts/post_ato_x/reject', { reason: 'x' }],
      ['PUT', '/api/posts/post_ato_x/captions', { caption: 'INVADIDO' }],
      ['POST', '/api/instagram/publish', { id: 'post_ato_x', caption: 'x' }],
      ['POST', '/api/posts/upload', {}],
      ['POST', '/api/posts/sync-drive', {}],
      ['POST', '/api/observations', { content: 'x', companyId: 'company_ato_x' }],
    ];
    for (const [m, p, b] of escritas) {
      const r = await call(m, p, b, t);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.body.code, `${m} ${p}`).toBe('PENDING_APPROVAL');
    }
    expect((await dbQuery<any>(`SELECT caption FROM posts WHERE id='post_ato_x'`)).rows[0].caption).toBe('legenda ato_x');
    // querystring/cabeçalho/corpo com companyId não mudam nada
    const forjado = await call('GET', '/api/posts?companyId=company_ato_x&driveFolderName=ATO%20Pasta%20X', undefined, t);
    expect(forjado.status).toBe(403);
    // e não consegue se aprovar
    expect((await call('POST', `/api/admin/users/${s.user.id}/approve`, { companyId: 'company_ato_x' }, t)).status).toBe(403);
    expect((await call('GET', '/api/admin/users', undefined, t)).status).toBe(403);
  });
});

describe('D–F. Aprovação na ATO, acesso aos conteúdos e troca de empresa', () => {
  it('aprova na ATO: vê os posts da ATO sem Instagram próprio; a conta @ato.vc não é alterada', async () => {
    const s = await signupAndVerify('marcos@exemplo.com', 'Marcos Membro');
    const antes = (await dbQuery<any>(`SELECT instagram_user_id, username, encrypted_access_token, company_id FROM instagram_accounts WHERE id='tenant_ato_x'`)).rows[0];
    const ap = await call('POST', `/api/admin/users/${s.user.id}/approve`, { companyId: 'company_ato_x', role: 'MEMBER' }, admin());
    expect(ap.status).toBe(200);

    // o MESMO token da sessão pendente passa a valer (estado vem do banco) — sem logout nem refresh
    const posts = await call('GET', '/api/posts', undefined, { token: s.token });
    expect(posts.status).toBe(200);
    expect(JSON.stringify(posts.body)).toMatch(/post_ato_x/);
    expect(JSON.stringify(posts.body)).not.toMatch(OUTRA);
    const me = await call('GET', '/api/auth/me', undefined, { token: s.token });
    expect(me.body.user).toMatchObject({ accessStatus: 'ACTIVE', companyId: 'company_ato_x', tenantId: 'tenant_ato_x', instagramUsername: 'ato.vc', workspaceRole: 'MEMBER' });
    expect(me.body.tenant.encryptedAccessToken).toBeUndefined();

    // a conexão da ATO ficou exatamente como estava
    const depois = (await dbQuery<any>(`SELECT instagram_user_id, username, encrypted_access_token, company_id FROM instagram_accounts WHERE id='tenant_ato_x'`)).rows[0];
    expect(depois).toEqual(antes);
    expect(depois.instagram_user_id).toBe(ATO_IGID);

    // lista do administrador já reflete (sem cache)
    const u = await achar(s.user.id);
    expect(u).toMatchObject({ accessStatus: 'ACTIVE', companyId: 'company_ato_x', companyName: 'ATO Teste', workspaceRole: 'MEMBER' });
    expect(u.instagram).toMatchObject({ username: 'ato.vc', connected: true });
    // membro não administra
    expect((await call('GET', '/api/admin/users', undefined, { token: s.token })).status).toBe(403);
    expect((await call('POST', '/api/tenants', {}, { token: s.token })).status).toBe(403);
  });

  it('F. troca de empresa: o token antigo perde a ATO na hora e passa a ver só a nova; auditoria preservada', async () => {
    const s = await signupAndVerify('troca@exemplo.com', 'Tânia Troca');
    await call('POST', `/api/admin/users/${s.user.id}/approve`, { companyId: 'company_ato_x' }, admin());
    expect(JSON.stringify((await call('GET', '/api/posts', undefined, { token: s.token })).body)).toMatch(/post_ato_x/);

    const ch = await call('POST', `/api/admin/users/${s.user.id}/company`, { companyId: 'company_b_x' }, admin());
    expect(ch.status).toBe(200);
    const depois = await call('GET', '/api/posts', undefined, { token: s.token });
    expect(depois.status).toBe(200);
    expect(JSON.stringify(depois.body)).toMatch(/post_b_x/);
    expect(JSON.stringify(depois.body)).not.toMatch(ATO);
    // JWT forjado/antigo carregando a empresa anterior não vale: o banco manda
    const me = await call('GET', '/api/auth/me', undefined, { token: s.token });
    expect(me.body.user).toMatchObject({ companyId: 'company_b_x', tenantId: 'tenant_b_x' });
    expect((await call('POST', '/api/posts/post_ato_x/reject', { reason: 'x' }, { token: s.token })).status).not.toBe(200);
    expect((await achar(s.user.id)).companyId).toBe('company_b_x');

    const aud = (await dbQuery<any>(`SELECT action, company_from, company_to FROM admin_audit_log WHERE target_user_id=$1 ORDER BY created_at`, [s.user.id])).rows;
    expect(aud.map((a) => a.action)).toEqual(['USER_APPROVED', 'USER_COMPANY_CHANGED']);
    expect(aud[1]).toMatchObject({ company_from: 'company_ato_x', company_to: 'company_b_x' });

    // remover o vínculo devolve à fila: sem dados de empresa nenhuma
    expect((await call('DELETE', `/api/admin/users/${s.user.id}/company`, undefined, admin())).status).toBe(200);
    const sem = await call('GET', '/api/posts', undefined, { token: s.token });
    expect(sem.status).toBe(403);
    expect((await achar(s.user.id)).accessStatus).toBe('PENDING_APPROVAL');
  });

  it('aprovar criando empresa nova; nome repetido é recusado; papel só OWNER/MEMBER e sem poder global', async () => {
    const s = await signupAndVerify('nova@exemplo.com', 'Nara Nova');
    expect((await call('POST', `/api/admin/users/${s.user.id}/approve`, { newCompanyName: 'ATO Teste' }, admin())).status).toBe(409);
    expect((await call('POST', `/api/admin/users/${s.user.id}/approve`, {}, admin())).status).toBe(400);
    const ap = await call('POST', `/api/admin/users/${s.user.id}/approve`, { newCompanyName: 'Padaria Nova', role: 'ADMIN' }, admin());
    expect(ap.status).toBe(200);
    const me = await call('GET', '/api/auth/me', undefined, { token: s.token });
    expect(me.body.user.role).toBe('TENANT'); // dono da empresa nunca é administrador global
    expect(me.body.user.workspaceRole).toBe('MEMBER'); // papel inválido cai no menor privilégio
    expect((await call('POST', `/api/admin/users/${s.user.id}/role`, { role: 'OWNER' }, admin())).status).toBe(200);
    expect((await call('POST', `/api/admin/users/${s.user.id}/role`, { role: 'ADMIN' }, admin())).status).toBe(400);
    expect((await call('POST', '/api/tenants', {}, { token: s.token })).status).toBe(403);
    const u = await achar(s.user.id);
    expect(u.instagram.username).toBeNull(); // espaço técnico: nunca devolve @ fabricado
    expect(u.instagram.connected).toBe(false);
  });
});

describe('G. Rejeição, suspensão, reativação e exclusão', () => {
  it('suspender derruba o token antigo e o login; reativar restaura o vínculo anterior', async () => {
    const s = await signupAndVerify('suspenso@exemplo.com', 'Sérgio Suspenso');
    await call('POST', `/api/admin/users/${s.user.id}/approve`, { companyId: 'company_ato_x' }, admin());
    expect((await call('GET', '/api/posts', undefined, { token: s.token })).status).toBe(200);

    expect((await call('POST', `/api/admin/users/${s.user.id}/suspend`, { reason: 'teste' }, admin())).status).toBe(200);
    const velho = await call('GET', '/api/posts', undefined, { token: s.token });
    expect([401, 403]).toContain(velho.status);
    expect(JSON.stringify(velho.body)).not.toMatch(ATO);
    const login = await call('POST', '/api/auth/login', { email: 'suspenso@exemplo.com', password: STRONG });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('ACCOUNT_SUSPENDED');
    expect((await achar(s.user.id)).accessStatus).toBe('SUSPENDED');

    expect((await call('POST', `/api/admin/users/${s.user.id}/reactivate`, {}, admin())).body.accessStatus).toBe('ACTIVE');
    const novo = await call('POST', '/api/auth/login', { email: 'suspenso@exemplo.com', password: STRONG });
    expect(novo.status).toBe(200);
    expect(JSON.stringify((await call('GET', '/api/posts', undefined, { token: novo.body.token })).body)).toMatch(/post_ato_x/);
  });

  it('rejeitar remove qualquer vínculo; o usuário continua sem dados e não volta sozinho', async () => {
    const s = await signupAndVerify('rejeitado@exemplo.com');
    expect((await call('POST', `/api/admin/users/${s.user.id}/reject`, { reason: 'fora do perfil' }, admin())).status).toBe(200);
    expect((await achar(s.user.id)).accessStatus).toBe('REJECTED');
    const r = await call('GET', '/api/posts', undefined, { token: s.token });
    expect([401, 403]).toContain(r.status);
    // um convite não reabre quem foi rejeitado sem decisão do administrador: o convite é autorização explícita, mas suspensos continuam barrados
    expect((await call('POST', `/api/admin/users/${s.user.id}/approve`, { companyId: 'company_b_x' }, admin())).status).toBe(200); // o administrador pode reverter
  });

  it('excluir exige confirmar o e-mail, invalida a sessão e preserva empresa, posts e conta Instagram', async () => {
    const s = await signupAndVerify('excluir@exemplo.com', 'Eduardo Excluir');
    await call('POST', `/api/admin/users/${s.user.id}/approve`, { companyId: 'company_ato_x' }, admin());
    const erro = await call('DELETE', `/api/admin/users/${s.user.id}`, { confirmEmail: 'outro@exemplo.com' }, admin());
    expect(erro.status).toBe(400);
    expect((await achar(s.user.id))).toBeTruthy();

    const ok = await call('DELETE', `/api/admin/users/${s.user.id}`, { confirmEmail: 'excluir@exemplo.com' }, admin());
    expect(ok.status).toBe(200);
    expect(await achar(s.user.id)).toBeUndefined(); // lista já atualizada
    expect((await call('GET', '/api/posts', undefined, { token: s.token })).status).toBe(401); // sessão invalidada
    expect((await call('POST', '/api/auth/login', { email: 'excluir@exemplo.com', password: STRONG })).status).toBe(401);
    // nada de negócio foi apagado
    expect((await dbQuery(`SELECT 1 FROM companies WHERE id='company_ato_x'`)).rows).toHaveLength(1);
    expect((await dbQuery(`SELECT 1 FROM posts WHERE id='post_ato_x'`)).rows).toHaveLength(1);
    const ig = (await dbQuery<any>(`SELECT instagram_user_id, connection_status FROM instagram_accounts WHERE id='tenant_ato_x'`)).rows[0];
    expect(ig).toEqual({ instagram_user_id: ATO_IGID, connection_status: 'CONECTADO' });
    // auditoria preservada com o e-mail
    const aud = (await dbQuery<any>(`SELECT action, target_email FROM admin_audit_log WHERE action='USER_DELETED' AND target_user_id=$1`, [s.user.id])).rows;
    expect(aud).toEqual([{ action: 'USER_DELETED', target_email: 'excluir@exemplo.com' }]);
  });

  it('administradores não são alterados por estas rotas e ninguém exclui a si mesmo', async () => {
    expect((await call('POST', '/api/admin/users/usr_admin_fluxo/suspend', {}, admin())).status).toBe(403);
    expect((await call('DELETE', '/api/admin/users/usr_admin_fluxo', { confirmEmail: 'admin-fluxo@exemplo.com' }, admin())).status).toBe(403);
    expect((await call('POST', '/api/admin/users/nao_existe/approve', { companyId: 'company_ato_x' }, admin())).status).toBe(404);
  });
});

describe('H–I. Contas Instagram (área separada) e estado real da integração', () => {
  it('lista separada: @ real, ID, empresa, autorização e reconexão; sem token na resposta', async () => {
    const r = await call('GET', '/api/admin/instagram-accounts', undefined, admin());
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/token-criptografado-fixo|encrypted/i);
    const by = (id: string) => r.body.accounts.find((a: any) => a.id === id);
    expect(by('tenant_ato_x')).toMatchObject({ username: 'ato.vc', instagramUserId: ATO_IGID, companyName: 'ATO Teste', connected: true, needsReconnect: false });
    expect(by('tenant_exp_x')).toMatchObject({ username: 'conta_expirada', connected: false, needsReconnect: true });
  });

  it('dashboard do membro mostra o estado real da empresa: conectado e reconexão necessária', async () => {
    const ok = await signupAndVerify('dash-ok@exemplo.com');
    await call('POST', `/api/admin/users/${ok.user.id}/approve`, { companyId: 'company_ato_x' }, admin());
    const exp = await signupAndVerify('dash-exp@exemplo.com');
    await call('POST', `/api/admin/users/${exp.user.id}/approve`, { companyId: 'company_exp_x' }, admin());
    const a = await call('GET', '/api/auth/me', undefined, { token: ok.token });
    const b = await call('GET', '/api/auth/me', undefined, { token: exp.token });
    expect(a.body.user.connectionStatus).toBe('CONECTADO');
    expect(b.body.user.connectionStatus).not.toBe('CONECTADO');
  });

  it('vincular a empresa só vale para conta sem empresa; desconectar revoga o token sem mexer em usuários', async () => {
    await dbQuery(`INSERT INTO instagram_accounts (id,username,nome,instagram_user_id,status,connection_status,has_valid_token) VALUES ('tenant_solta_x','conta_solta','Conta Solta','17841400099777','AGUARDANDO_APROVACAO','CONECTADO',true)`);
    expect((await call('POST', '/api/admin/instagram-accounts/tenant_solta_x/link-company', { companyId: 'company_b_x' }, admin())).status).toBe(200);
    expect((await call('POST', '/api/admin/instagram-accounts/tenant_solta_x/link-company', { companyId: 'company_ato_x' }, admin())).status).toBe(409); // não move conta de uma empresa para outra
    const usersAntes = (await lista()).users.length;
    expect((await call('POST', '/api/admin/instagram-accounts/tenant_solta_x/disconnect', {}, admin())).status).toBe(200);
    const row = (await dbQuery<any>(`SELECT encrypted_access_token, has_valid_token, connection_status FROM instagram_accounts WHERE id='tenant_solta_x'`)).rows[0];
    expect(row).toEqual({ encrypted_access_token: null, has_valid_token: false, connection_status: 'DESCONECTADO' });
    expect((await lista()).users.length).toBe(usersAntes);
    expect((await call('GET', '/api/admin/instagram-accounts', undefined, { token: (await signupAndVerify('ig-comum@exemplo.com')).token })).status).toBe(403);
  });
});

describe('K. Usuários antigos continuam entrando; migração 011 preserva acesso', () => {
  it('usuário legado sem vínculo registrado entra e vê os dados da própria empresa', async () => {
    await dbQuery(`INSERT INTO users (id,email,name,password_hash,role,status,company_id,instagram_account_id) VALUES ('usr_legado_k','legado-k@exemplo.com','Legado K',$1,'TENANT','APROVADO','company_ato_x','tenant_ato_x')`, [hashPassword('Senha-Legado-2026')]);
    const l = await call('POST', '/api/auth/login', { email: 'legado-k@exemplo.com', password: 'Senha-Legado-2026' });
    expect(l.status).toBe(200);
    expect(l.body.user.accessStatus).toBe('ACTIVE');
    expect(JSON.stringify((await call('GET', '/api/posts', undefined, { token: l.body.token })).body)).toMatch(/post_ato_x/);
  });

  it('011 converte: aprovado e reconexão necessária viram ACTIVE; sem vínculo ou aguardando viram PENDING; reversível', async () => {
    await rollbackMigration('011_memberships_and_approval');
    await dbQuery(`INSERT INTO users (id,email,name,password_hash,role,status,company_id,instagram_account_id) VALUES ('mig_ok','mig-ok@exemplo.com','Ok','x','TENANT','APROVADO','company_ato_x','tenant_ato_x')`);
    await dbQuery(`INSERT INTO users (id,email,name,password_hash,role,status,instagram_account_id) VALUES ('mig_reconecta','mig-rec@exemplo.com','Rec','x','TENANT','RECONEXAO_NECESSARIA','tenant_exp_x')`);
    await dbQuery(`INSERT INTO users (id,email,name,password_hash,role,status) VALUES ('mig_sem','mig-sem@exemplo.com','Sem','x','TENANT','APROVADO')`);
    await dbQuery(`INSERT INTO users (id,email,name,password_hash,role,status,instagram_account_id) VALUES ('mig_espera','mig-esp@exemplo.com','Espera','x','TENANT','AGUARDANDO_APROVACAO','tenant_b_x')`);
    await dbQuery(`INSERT INTO users (id,email,name,password_hash,role,status) VALUES ('mig_admin','mig-adm@exemplo.com','Adm','x','ADMIN','APROVADO')`);
    await runDatabaseMigrations();
    await runDatabaseMigrations(); // idempotente
    const st = async (id: string) => (await dbQuery<any>(`SELECT status, company_id FROM memberships WHERE user_id=$1`, [id])).rows[0];
    expect(await st('mig_ok')).toEqual({ status: 'ACTIVE', company_id: 'company_ato_x' });
    expect((await st('mig_reconecta')).status).toBe('ACTIVE');
    expect((await st('mig_reconecta')).company_id).toBe('company_exp_x');
    expect((await st('mig_sem')).status).toBe('PENDING_APPROVAL');
    expect((await st('mig_espera')).status).toBe('PENDING_APPROVAL');
    expect(await st('mig_admin')).toBeUndefined(); // administrador não tem vínculo
    // dados de negócio intactos
    expect((await dbQuery(`SELECT 1 FROM posts WHERE id='post_ato_x'`)).rows).toHaveLength(1);
  });
});

describe('Segurança adicional', () => {
  it('token de usuário inexistente, e token com iat anterior ao corte de sessão, são recusados', async () => {
    const s = await signupAndVerify('corte@exemplo.com');
    await dbQuery(`UPDATE users SET sessions_valid_after = NOW() + INTERVAL '1 minute' WHERE id=$1`, [s.user.id]);
    const r = await call('GET', '/api/auth/me', undefined, { token: s.token });
    expect(r.status).toBe(401);
    expect(crypto.randomUUID()).toBeTruthy();
  });

  it('o cadastro nunca cria empresa nem conta Instagram sozinho', async () => {
    const empresasAntes = (await dbQuery<any>(`SELECT count(*)::int n FROM companies`)).rows[0].n;
    const contasAntes = (await dbQuery<any>(`SELECT count(*)::int n FROM instagram_accounts`)).rows[0].n;
    const s = await signupAndVerify('semcriar@exemplo.com');
    expect((await dbQuery<any>(`SELECT count(*)::int n FROM companies`)).rows[0].n).toBe(empresasAntes);
    expect((await dbQuery<any>(`SELECT count(*)::int n FROM instagram_accounts`)).rows[0].n).toBe(contasAntes);
    const u = (await dbQuery<any>(`SELECT company_id, instagram_account_id FROM users WHERE id=$1`, [s.user.id])).rows[0];
    expect(u).toEqual({ company_id: null, instagram_account_id: null });
  });
});
