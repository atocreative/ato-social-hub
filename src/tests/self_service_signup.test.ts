import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.JWT_SECRET = 'test_jwt_secret_self_service_0123456789abcdef';
process.env.TOKEN_ENCRYPTION_KEY = 'test_token_encryption_key_0123456789abcdef';
process.env.APP_URL = 'https://socialhub.test';
process.env.INSTAGRAM_APP_ID = '28751089997889323';
process.env.INSTAGRAM_APP_SECRET = 'x'.repeat(32);
process.env.INSTAGRAM_REDIRECT_URI = 'https://socialhub.test/api/auth/instagram/callback';

import { app } from '../../server.ts';
import { dbQuery } from '../db/pool.ts';
import { rollbackMigration, runDatabaseMigrations } from '../db/migrations.ts';
import { hashPassword } from '../utils/passwordHash.ts';
import { setMailTransportForTests, type MailMessage } from '../services/mailer.ts';

let server: http.Server;
let base = '';
const outbox: MailMessage[] = [];
let ipCounter = 10;
const newIp = () => `203.0.113.${ipCounter++}`; // cada teste usa um IP próprio: os limites de tentativa não se misturam

async function call(method: string, path: string, body?: unknown, opts: { token?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': opts.ip || newIp() };
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

const tokenFromMail = (m: MailMessage) => new URL(m.text.match(/https?:\/\/\S+/)![0]).searchParams.get('code')!;
const lastMailTo = (to: string) => [...outbox].reverse().find((m) => m.to === to);
const STRONG = 'Cadastro-Seguro-2026';

async function signupAndVerify(email: string, name = 'Maria Souza', password = STRONG) {
  const s = await call('POST', '/api/auth/signup', { name, email, password, acceptTerms: true });
  expect(s.status).toBe(202);
  const token = tokenFromMail(lastMailTo(email)!);
  const v = await call('POST', '/api/auth/verify-email', { token });
  expect(v.status).toBe(200);
  return { token, session: v.body };
}

async function insertLegacy(id: string, email: string, role: 'ADMIN' | 'TENANT', password: string, extra: { companyId?: string; tenantId?: string } = {}) {
  await dbQuery(
    `INSERT INTO users (id,email,name,password_hash,role,status,company_id,instagram_account_id) VALUES ($1,$2,$3,$4,$5,'APROVADO',$6,$7)`,
    [id, email, id, hashPassword(password), role, extra.companyId || null, extra.tenantId || null]
  );
}

beforeAll(async () => {
  await runDatabaseMigrations();
  setMailTransportForTests(async (m) => {
    outbox.push(m);
  });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  setMailTransportForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
});

describe('Cadastro público e verificação de e-mail', () => {
  it('cadastra sem criar usuário nem sessão até o e-mail ser confirmado; token só existe como hash', async () => {
    const r = await call('POST', '/api/auth/signup', { name: 'Ana Lima', email: 'Ana@Exemplo.com ', password: STRONG, acceptTerms: true });
    expect(r.status).toBe(202);
    expect(r.body.token).toBeUndefined();
    expect((await dbQuery(`SELECT 1 FROM users WHERE LOWER(email)='ana@exemplo.com'`)).rows).toHaveLength(0);
    const mail = lastMailTo('ana@exemplo.com')!;
    expect(mail.subject).toMatch(/Confirme/);
    const raw = tokenFromMail(mail);
    expect(raw.length).toBeGreaterThanOrEqual(40);
    const rows = (await dbQuery<any>(`SELECT token_hash, payload FROM auth_tokens WHERE email='ana@exemplo.com'`)).rows;
    expect(rows[0].token_hash).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(raw);
    expect(JSON.stringify(rows[0].payload)).not.toContain(STRONG); // a senha só existe como hash
  });

  it('confirmação cria usuário TENANT sem empresa e sem poder de administrador, e já entra com sessão', async () => {
    const { session } = await signupAndVerify('bia@exemplo.com', 'Bia Costa');
    expect(session.user.role).toBe('TENANT');
    expect(session.user.needsWorkspace).toBe(true);
    expect(session.user.companyId).toBeUndefined();
    const adm = await call('POST', '/api/tenants', {}, { token: session.token });
    expect(adm.status).toBe(403);
    const lista = await call('GET', '/api/tenants', undefined, { token: session.token });
    expect(lista.body.tenants).toEqual([]); // sem espaço de trabalho, não enxerga nenhuma conta
    const row = (await dbQuery<any>(`SELECT role, company_id, email_verified_at, terms_accepted_at FROM users WHERE email='bia@exemplo.com'`)).rows[0];
    expect(row.role).toBe('TENANT');
    expect(row.company_id).toBeNull();
    expect(row.email_verified_at).toBeTruthy();
    expect(row.terms_accepted_at).toBeTruthy();
  });

  it('link reutilizado ou expirado é recusado', async () => {
    const { token } = await signupAndVerify('caio@exemplo.com');
    expect((await call('POST', '/api/auth/verify-email', { token })).status).toBe(400);

    await call('POST', '/api/auth/signup', { name: 'Duda Reis', email: 'duda@exemplo.com', password: STRONG, acceptTerms: true });
    const t2 = tokenFromMail(lastMailTo('duda@exemplo.com')!);
    await dbQuery(`UPDATE auth_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE email='duda@exemplo.com'`);
    expect((await call('POST', '/api/auth/verify-email', { token: t2 })).status).toBe(400);
    expect((await dbQuery(`SELECT 1 FROM users WHERE email='duda@exemplo.com'`)).rows).toHaveLength(0);
    expect((await call('POST', '/api/auth/verify-email', { token: 'inventado' })).status).toBe(400);
  });

  it('e-mail duplicado: resposta idêntica, nenhum usuário novo e aviso por e-mail ao dono (sem enumeração)', async () => {
    await signupAndVerify('eva@exemplo.com');
    const before = (await dbQuery(`SELECT count(*)::int n FROM users`)).rows[0] as any;
    const novo = await call('POST', '/api/auth/signup', { name: 'Outra Pessoa', email: 'novo-email@exemplo.com', password: STRONG, acceptTerms: true });
    const dup = await call('POST', '/api/auth/signup', { name: 'Outra Pessoa', email: 'eva@exemplo.com', password: 'Outra-Senha-2026', acceptTerms: true });
    expect(dup.status).toBe(novo.status);
    expect(dup.body).toEqual(novo.body);
    expect(lastMailTo('eva@exemplo.com')!.subject).toMatch(/já tem uma conta/);
    expect(((await dbQuery(`SELECT count(*)::int n FROM users`)).rows[0] as any).n).toBe(before.n);
    // Quem tentou "reservar" o e-mail não consegue entrar com a senha que escolheu.
    expect((await call('POST', '/api/auth/login', { email: 'eva@exemplo.com', password: 'Outra-Senha-2026' })).status).toBe(401);
  });

  it('valida no backend: senha fraca, termos não aceitos, e-mail inválido', async () => {
    let n = 0;
    const base = { name: 'Fulano Silva', email: 'fulano@exemplo.com', password: STRONG, acceptTerms: true };
    const c = (extra: object) => call('POST', '/api/auth/signup', { ...base, email: `fulano${n++}@exemplo.com`, ...extra });
    expect((await c({ password: '123456' })).body.code).toBe('WEAK_PASSWORD');
    expect((await c({ password: '6666666666' })).body.code).toBe('WEAK_PASSWORD');
    expect((await c({ email: 'fulano@exemplo.com', password: 'fulano-fulano-1' })).body.code).toBe('WEAK_PASSWORD');
    expect((await c({ acceptTerms: false })).body.code).toBe('TERMS_REQUIRED');
    expect((await c({ email: 'sem-arroba' })).body.code).toBe('INVALID_EMAIL');
    expect((await c({ name: ' ' })).body.code).toBe('INVALID_NAME');
    expect((await dbQuery(`SELECT 1 FROM auth_tokens WHERE email LIKE 'fulano%'`)).rows).toHaveLength(0);
  });

  it('limita tentativas de cadastro por IP', async () => {
    const ip = newIp();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await call('POST', '/api/auth/signup', { name: 'Limite Teste', email: `limite${i}@exemplo.com`, password: STRONG, acceptTerms: true }, { ip })).status;
    }
    expect(last).toBe(429);
  });
});

describe('Login', () => {
  it('senha válida entra; inválida e conta inexistente recebem a mesma resposta', async () => {
    await signupAndVerify('gabi@exemplo.com');
    const ok = await call('POST', '/api/auth/login', { email: 'gabi@exemplo.com', password: STRONG });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe('TENANT');
    const wrong = await call('POST', '/api/auth/login', { email: 'gabi@exemplo.com', password: 'senha-errada-123' });
    const ghost = await call('POST', '/api/auth/login', { email: 'ninguem@exemplo.com', password: 'senha-errada-123' });
    expect(wrong.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(wrong.body).toEqual(ghost.body);
  });

  it('limita tentativas de login por e-mail', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call('POST', '/api/auth/login', { email: 'alvo@exemplo.com', password: 'errada-errada-1' })).status;
    expect(last).toBe(429);
  });
});

describe('Recuperação de senha', () => {
  it('resposta idêntica para e-mail inexistente (sem envio); administrador global não usa este caminho', async () => {
    await insertLegacy('adm_reset', 'admin-reset@exemplo.com', 'ADMIN', 'Senha-Admin-2026!');
    await signupAndVerify('hugo@exemplo.com');
    const before = outbox.length;
    const known = await call('POST', '/api/auth/forgot-password', { email: 'hugo@exemplo.com' });
    const unknown = await call('POST', '/api/auth/forgot-password', { email: 'nao-existe@exemplo.com' });
    const admin = await call('POST', '/api/auth/forgot-password', { email: 'admin-reset@exemplo.com' });
    expect(known.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
    expect(admin.body).toEqual(known.body);
    expect(outbox.length).toBe(before + 1);
    expect(lastMailTo('nao-existe@exemplo.com')).toBeUndefined();
    expect(lastMailTo('admin-reset@exemplo.com')).toBeUndefined();
  });

  it('redefine a senha, encerra sessões antigas, não aceita o link de novo e a senha antiga deixa de valer', async () => {
    const { session } = await signupAndVerify('iris@exemplo.com');
    expect((await call('GET', '/api/auth/me', undefined, { token: session.token })).status).toBe(200);

    await call('POST', '/api/auth/forgot-password', { email: 'iris@exemplo.com' });
    const t = tokenFromMail(lastMailTo('iris@exemplo.com')!);
    expect((await call('POST', '/api/auth/reset-password', { token: t, password: '123' })).body.code).toBe('WEAK_PASSWORD');
    // A tentativa fraca não gasta o link.
    await new Promise((r) => setTimeout(r, 1100));
    const reset = await call('POST', '/api/auth/reset-password', { token: t, password: 'Nova-Senha-Forte-77' });
    expect(reset.status).toBe(200);
    expect((await call('POST', '/api/auth/reset-password', { token: t, password: 'Outra-Senha-Forte-88' })).status).toBe(400);

    expect((await call('GET', '/api/auth/me', undefined, { token: session.token })).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { email: 'iris@exemplo.com', password: STRONG })).status).toBe(401);
    const novo = await call('POST', '/api/auth/login', { email: 'iris@exemplo.com', password: 'Nova-Senha-Forte-77' });
    expect(novo.status).toBe(200);
    expect((await call('GET', '/api/auth/me', undefined, { token: novo.body.token })).status).toBe(200);
  });

  it('link de redefinição expirado é recusado', async () => {
    await signupAndVerify('jana@exemplo.com');
    await call('POST', '/api/auth/forgot-password', { email: 'jana@exemplo.com' });
    const t = tokenFromMail(lastMailTo('jana@exemplo.com')!);
    await dbQuery(`UPDATE auth_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE email='jana@exemplo.com' AND purpose='PASSWORD_RESET'`);
    expect((await call('POST', '/api/auth/reset-password', { token: t, password: 'Nova-Senha-Forte-77' })).status).toBe(400);
  });
});

describe('Espaço de trabalho e isolamento entre empresas', () => {
  it('cria empresa exclusiva, usuário vira proprietário só dela e sem acesso administrativo; estado "sem Instagram"', async () => {
    const { session } = await signupAndVerify('kleber@exemplo.com', 'Kleber Dias');
    const w = await call('POST', '/api/workspaces', { companyName: 'Padaria do Kleber' }, { token: session.token });
    expect(w.status).toBe(201);
    expect(w.body.user.workspaceRole).toBe('OWNER');
    expect(w.body.user.role).toBe('TENANT');
    expect(w.body.user.needsWorkspace).toBe(false);
    expect(w.body.user.connectionStatus).toBe('DESCONECTADO');
    expect(String(w.body.user.instagramUsername)).toMatch(/^cadastro_/);
    expect(w.body.user.companyId).toMatch(/^company_[0-9a-f]{16}$/);
    expect(w.body.tenant.encryptedAccessToken).toBeUndefined();
    expect((await call('POST', '/api/tenants', {}, { token: w.body.token })).status).toBe(403);
    const propria = await call('GET', '/api/tenants', undefined, { token: w.body.token });
    expect(propria.body.tenants.map((t: any) => t.id)).toEqual([w.body.user.tenantId]); // só o próprio espaço
    expect((await call('GET', '/api/auth/me', undefined, { token: w.body.token })).status).toBe(200);
    // segunda criação é recusada
    expect((await call('POST', '/api/workspaces', { companyName: 'Outra' }, { token: w.body.token })).status).toBe(409);
  });

  it('nome igual ao de empresa existente não vincula ninguém a ela; cada espaço é separado', async () => {
    await dbQuery(`INSERT INTO companies (id,name,drive_folder_name) VALUES ('company_legada','Loja Central','Loja Central')`);
    await dbQuery(`INSERT INTO instagram_accounts (id,company_id,username,nome,instagram_user_id,status,connection_status,has_valid_token) VALUES ('tenant_legada','company_legada','loja_central','Loja Central','1784100000009','APROVADO','CONECTADO',true)`);
    await insertLegacy('usr_legado', 'dono-legado@exemplo.com', 'TENANT', 'Senha-Legado-2026', { companyId: 'company_legada', tenantId: 'tenant_legada' });

    const a = await signupAndVerify('lia@exemplo.com');
    const wa = await call('POST', '/api/workspaces', { companyName: 'Loja Central' }, { token: a.session.token });
    expect(wa.status).toBe(201);
    expect(wa.body.user.companyId).not.toBe('company_legada');
    expect(wa.body.user.tenantId).not.toBe('tenant_legada');
    const b = await signupAndVerify('mauro@exemplo.com');
    const wb = await call('POST', '/api/workspaces', { companyName: 'Loja Central' }, { token: b.session.token });
    expect(wb.body.user.companyId).not.toBe(wa.body.user.companyId);

    const linked = (await dbQuery<any>(`SELECT count(*)::int n FROM users WHERE company_id='company_legada'`)).rows[0];
    expect(linked.n).toBe(1); // só o dono legado
  });

  it('não é possível passar tenant, empresa ou papel pelo corpo da requisição', async () => {
    const { session } = await signupAndVerify('nina@exemplo.com');
    const w = await call('POST', '/api/workspaces', { companyName: 'Ateliê da Nina', companyId: 'company_legada', tenantId: 'tenant_legada', role: 'ADMIN', workspaceRole: 'OWNER' }, { token: session.token });
    expect(w.status).toBe(201);
    expect(w.body.user.companyId).not.toBe('company_legada');
    expect(w.body.user.role).toBe('TENANT');
  });
});

describe('Convites', () => {
  async function owner(email: string, company: string) {
    const { session } = await signupAndVerify(email);
    const w = await call('POST', '/api/workspaces', { companyName: company }, { token: session.token });
    return { token: w.body.token as string, companyId: w.body.user.companyId as string, userId: w.body.user.id as string };
  }

  it('proprietário convida para o próprio espaço; convidado cria conta e acessa só aquela empresa como membro', async () => {
    const o = await owner('olga@exemplo.com', 'Estúdio da Olga');
    const inv = await call('POST', '/api/invites', { email: 'Pedro@Exemplo.com' }, { token: o.token });
    expect(inv.status).toBe(202);
    const t = tokenFromMail(lastMailTo('pedro@exemplo.com')!);
    const prev = await call('GET', `/api/invites/${t}`);
    expect(prev.body).toMatchObject({ email: 'pedro@exemplo.com', companyName: 'Estúdio da Olga', hasAccount: false });

    expect((await call('POST', '/api/invites/accept', { token: t, name: 'Pedro Alves', password: '123', acceptTerms: true })).body.code).toBe('WEAK_PASSWORD');
    expect((await call('POST', '/api/invites/accept', { token: t, name: 'Pedro Alves', password: STRONG, acceptTerms: false })).body.code).toBe('TERMS_REQUIRED');
    const ok = await call('POST', '/api/invites/accept', { token: t, name: 'Pedro Alves', password: STRONG, acceptTerms: true });
    expect(ok.status).toBe(200);
    expect(ok.body.user.companyId).toBe(o.companyId);
    expect(ok.body.user.workspaceRole).toBe('MEMBER');
    expect(ok.body.user.role).toBe('TENANT');
    // uso único
    expect((await call('POST', '/api/invites/accept', { token: t, name: 'Pedro Alves', password: STRONG, acceptTerms: true })).status).toBe(400);
    expect((await call('GET', `/api/invites/${t}`)).status).toBe(404);
    // membro não convida nem administra
    expect((await call('POST', '/api/invites', { email: 'x@exemplo.com' }, { token: ok.body.token })).status).toBe(403);
    expect((await call('POST', '/api/tenants', {}, { token: ok.body.token })).status).toBe(403);
    const visiveis = await call('GET', '/api/tenants', undefined, { token: ok.body.token });
    expect(visiveis.body.tenants.map((t: any) => t.id)).toEqual([ok.body.user.tenantId]);
    expect(ok.body.user.tenantId).toBe((await dbQuery<any>(`SELECT id FROM instagram_accounts WHERE company_id=$1`, [o.companyId])).rows[0].id);
  });

  it('proprietário não convida para empresa de terceiros; usuário sem espaço não convida', async () => {
    const a = await owner('qiao@exemplo.com', 'Empresa Q');
    const b = await owner('rita@exemplo.com', 'Empresa R');
    expect((await call('POST', '/api/invites', { email: 'v1@exemplo.com', companyId: b.companyId }, { token: a.token })).status).toBe(403);
    const semEspaco = await signupAndVerify('sara@exemplo.com');
    expect((await call('POST', '/api/invites', { email: 'v2@exemplo.com' }, { token: semEspaco.session.token })).status).toBe(403);
    expect((await call('POST', '/api/invites', { email: 'v3@exemplo.com' })).status).toBe(401);
  });

  it('conta existente precisa estar autenticada com o e-mail convidado; quem já tem outra empresa é recusado', async () => {
    const o = await owner('tiago@exemplo.com', 'Empresa T');
    const livre = await signupAndVerify('ursula@exemplo.com');
    await call('POST', '/api/invites', { email: 'ursula@exemplo.com' }, { token: o.token });
    const t = tokenFromMail(lastMailTo('ursula@exemplo.com')!);
    expect((await call('GET', `/api/invites/${t}`)).body.hasAccount).toBe(true);
    expect((await call('POST', '/api/invites/accept', { token: t })).body.code).toBe('LOGIN_REQUIRED');
    const intruso = await signupAndVerify('vera@exemplo.com');
    expect((await call('POST', '/api/invites/accept', { token: t }, { token: intruso.session.token })).body.code).toBe('LOGIN_REQUIRED');
    const ok = await call('POST', '/api/invites/accept', { token: t }, { token: livre.session.token });
    expect(ok.status).toBe(200);
    expect(ok.body.user.companyId).toBe(o.companyId);

    const outro = await owner('wagner@exemplo.com', 'Empresa W');
    await call('POST', '/api/invites', { email: 'wagner@exemplo.com', companyId: o.companyId }, { token: o.token });
    const t2 = tokenFromMail(lastMailTo('wagner@exemplo.com')!);
    const conflito = await call('POST', '/api/invites/accept', { token: t2 }, { token: outro.token });
    expect(conflito.status).toBe(409);
    const stillOwn = (await dbQuery<any>(`SELECT company_id FROM users WHERE id=$1`, [outro.userId])).rows[0];
    expect(stillOwn.company_id).toBe(outro.companyId);
  });

  it('administrador convida para empresa existente; convite expirado é recusado; administrador não pode ser convidado', async () => {
    await insertLegacy('adm_inv', 'admin-inv@exemplo.com', 'ADMIN', 'Senha-Admin-2026!');
    const login = await call('POST', '/api/auth/login', { email: 'admin-inv@exemplo.com', password: 'Senha-Admin-2026!' });
    expect(login.status).toBe(200);
    const o = await owner('xuxa@exemplo.com', 'Empresa X');
    expect((await call('POST', '/api/invites', { email: 'conv-admin@exemplo.com' }, { token: login.body.token })).body.code).toBe('INVALID_COMPANY');
    expect((await call('POST', '/api/invites', { email: 'conv-admin@exemplo.com', companyId: o.companyId }, { token: login.body.token })).status).toBe(202);
    const t = tokenFromMail(lastMailTo('conv-admin@exemplo.com')!);
    await dbQuery(`UPDATE auth_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE email='conv-admin@exemplo.com'`);
    expect((await call('POST', '/api/invites/accept', { token: t, name: 'Conv Admin', password: STRONG, acceptTerms: true })).status).toBe(400);
    expect((await call('POST', '/api/invites', { email: 'admin-inv@exemplo.com', companyId: o.companyId }, { token: login.body.token })).body.code).toBe('INVALID_INVITEE');
  });
});

describe('Compatibilidade com usuários anteriores', () => {
  it('migração 010 preserva usuários existentes: continuam entrando, marcados como verificados e sem papel novo', async () => {
    await rollbackMigration('010_self_service_signup');
    await dbQuery(`INSERT INTO companies (id,name,drive_folder_name) VALUES ('company_old','Empresa Antiga','Empresa Antiga') ON CONFLICT DO NOTHING`);
    await dbQuery(`INSERT INTO instagram_accounts (id,company_id,username,nome,instagram_user_id,status,connection_status,has_valid_token) VALUES ('tenant_old','company_old','antiga_ig','Empresa Antiga','1784100000077','APROVADO','CONECTADO',true) ON CONFLICT DO NOTHING`);
    await dbQuery(`INSERT INTO users (id,email,name,password_hash,role,status,company_id,instagram_account_id) VALUES ('usr_old','antigo@exemplo.com','Antigo',$1,'TENANT','APROVADO','company_old','tenant_old')`, [hashPassword('Senha-Antiga-2026')]);
    await dbQuery(`INSERT INTO users (id,email,name,password_hash,role,status) VALUES ('adm_old','admin-antigo@exemplo.com','Admin',$1,'ADMIN','APROVADO')`, [hashPassword('Senha-Admin-Antiga-2026')]);
    await runDatabaseMigrations();

    const rows = (await dbQuery<any>(`SELECT id, email_verified_at, workspace_role, role FROM users WHERE id IN ('usr_old','adm_old')`)).rows;
    for (const r of rows) {
      expect(r.email_verified_at).toBeTruthy();
      expect(r.workspace_role).toBeNull();
    }
    const u = await call('POST', '/api/auth/login', { email: 'antigo@exemplo.com', password: 'Senha-Antiga-2026' });
    expect(u.status).toBe(200);
    expect(u.body.user.tenantId).toBe('tenant_old');
    expect(u.body.user.needsWorkspace).toBe(false);
    expect(u.body.user.companyId).toBe('company_old');
    const a = await call('POST', '/api/auth/login', { email: 'admin-antigo@exemplo.com', password: 'Senha-Admin-Antiga-2026' });
    expect(a.status).toBe(200);
    expect(a.body.user.role).toBe('ADMIN');
    expect((await call('GET', '/api/tenants', undefined, { token: a.body.token })).status).toBe(200);
  });

  it('010 convive com 008 (OAuth) e 009 (senha retirada): ordem, idempotência e reversão sem efeito sobre elas', async () => {
    const versoes = async () => (await dbQuery<any>(`SELECT version FROM schema_migrations ORDER BY version`)).rows.map((r) => String(r.version));
    const ordem = await versoes();
    expect(ordem.slice(-3)).toEqual(['008_oauth_state_and_pending_connections', '009_block_retired_default_password', '010_self_service_signup']);
    await runDatabaseMigrations();
    await runDatabaseMigrations(); // reaplicar não muda nada
    expect(await versoes()).toEqual(ordem);

    const tabelas008 = ['oauth_states', 'oauth_used_codes', 'oauth_pending_connections'];
    const existe = async (t: string) => Boolean((await dbQuery<any>(`SELECT to_regclass($1) t`, [t])).rows[0].t);
    const gatilho = async () => (await dbQuery<any>(`SELECT 1 FROM pg_trigger WHERE tgname='trg_users_block_retired_default_password'`)).rows.length === 1;
    const tentaSenhaRetirada = async (id: string) => {
      const sha = crypto.createHash('sha256').update('666666').digest('hex');
      await dbQuery(`INSERT INTO users (id,email,name,password_hash,role,status) VALUES ($1,$2,'x',$3,'TENANT','APROVADO')`, [id, `${id}@exemplo.com`, sha]);
      return (await dbQuery<any>(`SELECT password_hash FROM users WHERE id=$1`, [id])).rows[0].password_hash as string;
    };

    for (const t of tabelas008) expect(await existe(t)).toBe(true);
    expect(await gatilho()).toBe(true);
    expect(await tentaSenhaRetirada('usr_compat_a')).toBe('disabled$blocked_retired_default_password'); // a 009 continua valendo com a 010 aplicada

    await rollbackMigration('010_self_service_signup');
    for (const t of tabelas008) expect(await existe(t)).toBe(true); // reverter a 010 não toca na 008
    expect(await gatilho()).toBe(true); // nem na 009
    expect(await tentaSenhaRetirada('usr_compat_b')).toBe('disabled$blocked_retired_default_password');
    await runDatabaseMigrations();
    expect(await versoes()).toEqual(ordem);
  });

  it('migração 010 é reversível sem tocar nos dados de negócio', async () => {
    const before = (await dbQuery<any>(`SELECT count(*)::int n FROM users`)).rows[0].n;
    await rollbackMigration('010_self_service_signup');
    expect((await dbQuery<any>(`SELECT count(*)::int n FROM users`)).rows[0].n).toBe(before);
    expect((await dbQuery<any>(`SELECT to_regclass('auth_tokens') t`)).rows[0].t).toBeNull();
    await runDatabaseMigrations();
    expect((await dbQuery<any>(`SELECT to_regclass('auth_tokens') t`)).rows[0].t).toBeTruthy();
  });
});

describe('Proteção contra cadastros automatizados e enumeração', () => {
  it('campo-isca preenchido: resposta idêntica, mas nada é criado nem enviado', async () => {
    const antes = outbox.length;
    const r = await call('POST', '/api/auth/signup', { name: 'Robô Teste', email: 'robo@exemplo.com', password: STRONG, acceptTerms: true, website: 'http://spam.example' });
    expect(r.status).toBe(202);
    expect(outbox.length).toBe(antes);
    expect((await dbQuery(`SELECT 1 FROM auth_tokens WHERE email='robo@exemplo.com'`)).rows).toHaveLength(0);
  });

  it('o limite por e-mail vale para variações do mesmo endereço (maiúsculas e espaços)', async () => {
    const ip = newIp();
    const variantes = ['varia@exemplo.com', ' VARIA@exemplo.com', 'Varia@Exemplo.com ', 'varia@exemplo.com'];
    const codigos: number[] = [];
    for (const email of variantes) {
      codigos.push((await call('POST', '/api/auth/signup', { name: 'Vera Lima', email, password: STRONG, acceptTerms: true }, { ip })).status);
    }
    expect(codigos).toEqual([202, 202, 202, 429]);
  });

  it('esqueci minha senha leva o mesmo tempo exista ou não a conta', async () => {
    await insertLegacy('usr_tempo', 'tempo@exemplo.com', 'TENANT', 'Senha-Tempo-2026');
    const medir = async (email: string) => {
      const t0 = Date.now();
      const r = await call('POST', '/api/auth/forgot-password', { email });
      return { ms: Date.now() - t0, body: JSON.stringify(r.body), status: r.status };
    };
    const existe = await medir('tempo@exemplo.com');
    const naoExiste = await medir('ninguem-aqui@exemplo.com');
    expect(existe.status).toBe(202);
    expect(naoExiste.body).toBe(existe.body);
    expect(existe.ms).toBeGreaterThanOrEqual(340);
    expect(naoExiste.ms).toBeGreaterThanOrEqual(340);
    expect(Math.abs(existe.ms - naoExiste.ms)).toBeLessThan(150);
  });

  it('falha do provedor de e-mail não derruba o cadastro nem revela se a conta existe', async () => {
    setMailTransportForTests(async () => {
      throw new Error('Falha no provedor de e-mail (HTTP 500).');
    });
    const linhas: string[] = [];
    const orig = console.error;
    console.error = (...a) => void linhas.push(a.join(' '));
    try {
      const r = await call('POST', '/api/auth/signup', { name: 'Falha Prov', email: 'falha-prov@exemplo.com', password: STRONG, acceptTerms: true });
      expect(r.status).toBe(202);
      await new Promise((res) => setTimeout(res, 50));
      const saida = linhas.join('\n');
      expect(saida).toContain('Envio falhou');
      expect(saida).not.toContain('falha-prov@exemplo.com');
    } finally {
      console.error = orig;
      setMailTransportForTests(async (m) => {
        outbox.push(m);
      });
    }
  });
});

describe('Interruptor do cadastro público (produção começa desligado)', () => {
  it('desligado: cadastro recusado e nada criado, mas login, recuperação e usuários existentes seguem normais', async () => {
    await insertLegacy('usr_flag', 'flag@exemplo.com', 'TENANT', 'Senha-Flag-2026');
    const envAntes = { node: process.env.NODE_ENV, flag: process.env.PUBLIC_SIGNUP_ENABLED };
    process.env.NODE_ENV = 'production';
    delete process.env.PUBLIC_SIGNUP_ENABLED;
    try {
      expect((await call('GET', '/api/auth/config')).body).toEqual({ signupEnabled: false });
      const antes = outbox.length;
      const s = await call('POST', '/api/auth/signup', { name: 'Fechado', email: 'fechado@exemplo.com', password: STRONG, acceptTerms: true });
      expect(s.status).toBe(403);
      expect(s.body.code).toBe('SIGNUP_DISABLED');
      expect((await call('POST', '/api/auth/register', { name: 'Fechado', email: 'fechado@exemplo.com', password: STRONG, acceptTerms: true })).status).toBe(403);
      expect(outbox.length).toBe(antes);
      expect((await dbQuery(`SELECT 1 FROM auth_tokens WHERE email='fechado@exemplo.com'`)).rows).toHaveLength(0);
      // quem já existe continua entrando e recuperando a senha
      expect((await call('POST', '/api/auth/login', { email: 'flag@exemplo.com', password: 'Senha-Flag-2026' })).status).toBe(200);
      expect((await call('POST', '/api/auth/forgot-password', { email: 'flag@exemplo.com' })).status).toBe(202);

      process.env.PUBLIC_SIGNUP_ENABLED = 'true';
      expect((await call('GET', '/api/auth/config')).body).toEqual({ signupEnabled: true });
    } finally {
      if (envAntes.node === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = envAntes.node;
      if (envAntes.flag === undefined) delete process.env.PUBLIC_SIGNUP_ENABLED;
      else process.env.PUBLIC_SIGNUP_ENABLED = envAntes.flag;
    }
  });
});

describe('Logs', () => {
  it('nenhum token, senha ou link é impresso nos logs durante os fluxos', async () => {
    const lines: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...a) => void lines.push(a.join(' '));
    console.error = (...a) => void lines.push(a.join(' '));
    console.warn = (...a) => void lines.push(a.join(' '));
    try {
      const senha = 'Senha-Que-Nao-Pode-Vazar-9';
      await call('POST', '/api/auth/signup', { name: 'Log Teste', email: 'log@exemplo.com', password: senha, acceptTerms: true });
      const raw = tokenFromMail(lastMailTo('log@exemplo.com')!);
      await call('POST', '/api/auth/verify-email', { token: raw });
      await call('POST', '/api/auth/forgot-password', { email: 'log@exemplo.com' });
      const out = lines.join('\n');
      expect(out).not.toContain(senha);
      expect(out).not.toContain(raw);
      expect(out).not.toMatch(/verificar-email\?token|redefinir-senha\?token/);
    } finally {
      Object.assign(console, orig);
    }
  });
});
