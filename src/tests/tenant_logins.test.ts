import { beforeAll, describe, expect, it } from 'vitest';
import { dbQuery } from '../db/pool.ts';
import { runDatabaseMigrations } from '../db/migrations.ts';
import { createTenantLogin, listTenantsWithoutLogin, planTenantLogin } from '../services/tenantLogins.ts';
import { verifyPassword } from '../utils/passwordHash.ts';

const acc = async (id: string, username: string, igId: string) => {
  await dbQuery(
    `INSERT INTO instagram_accounts (id, company_id, username, nome, instagram_user_id, status, connection_status, has_valid_token, granted_scopes)
     VALUES ($1, 'co_tl', $2, $2, $3, 'APROVADO', 'CONECTADO', true, '["instagram_basic","instagram_content_publish"]'::jsonb)`,
    [id, username, igId]
  );
};

const accountRow = async (id: string) =>
  (await dbQuery<any>(`SELECT company_id, instagram_user_id, username, connection_status, has_valid_token FROM instagram_accounts WHERE id=$1`, [id])).rows[0];

describe('Provisionamento de login para empresas que entravam só pelo Instagram', () => {
  beforeAll(async () => {
    await runDatabaseMigrations();
    await dbQuery(`INSERT INTO companies (id, name, drive_folder_name) VALUES ('co_tl','Empresa TL','pasta_tl') ON CONFLICT DO NOTHING`);
    // A: só tinha o usuário automático do Instagram (sem senha) | B: sem usuário nenhum | C: já tem login com senha
    await acc('tl_a', 'tl_conta_a', '17841400000000a01');
    await acc('tl_b', 'tl_conta_b', '17841400000000b02');
    await acc('tl_c', 'tl_conta_c', '17841400000000c03');
    await dbQuery(
      `INSERT INTO users (id, email, name, password_hash, role, status, company_id, instagram_account_id)
       VALUES ('usr_tl_a','tl_conta_a@instagram.ato.hub','A','disabled$x','TENANT','APROVADO','co_tl','tl_a'),
              ('usr_tl_c','c@x.com','C','scrypt$ja$tem','TENANT','APROVADO','co_tl','tl_c')`
    );
    await dbQuery(
      `INSERT INTO users (id, email, name, password_hash, role) VALUES ('usr_email_ocupado','ocupado@x.com','Outro','scrypt$z','TENANT')`
    );
  });

  it('list informa vínculos e não inclui quem já tem login com senha', async () => {
    const rows = await listTenantsWithoutLogin();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('tl_a');
    expect(ids).toContain('tl_b');
    expect(ids).not.toContain('tl_c');
    const a = rows.find((r) => r.id === 'tl_a')!;
    expect(a.companyId).toBe('co_tl');
    expect(a.instagramUserId).toBe('17841400000000a01');
    expect(a.existingUserId).toBe('usr_tl_a');
  });

  it('plan (simulação) descreve a ação e NÃO escreve nada', async () => {
    const before = (await dbQuery<any>(`SELECT count(*)::int n, max(updated_at) m FROM users`)).rows[0];
    const planA = await planTenantLogin({ tenantId: 'tl_a', email: 'a@empresa.com' });
    const planB = await planTenantLogin({ tenantId: 'tl_b', email: 'b@empresa.com' });
    expect(planA.action).toBe('ENABLE_PASSWORD_ON_EXISTING_USER');
    expect(planA.userId).toBe('usr_tl_a');
    expect(planB.action).toBe('INSERT_USER');
    expect(planB.preserved.instagramUserId).toBe('17841400000000b02');
    const after = (await dbQuery<any>(`SELECT count(*)::int n, max(updated_at) m FROM users`)).rows[0];
    expect(after.n).toBe(before.n);
    expect(String(after.m)).toBe(String(before.m));
  });

  it('create habilita a senha no usuário existente preservando ID e vínculos', async () => {
    const accBefore = await accountRow('tl_a');
    const created = await createTenantLogin({ tenantId: 'tl_a', email: 'A@Empresa.com' });
    expect(created.userId).toBe('usr_tl_a');
    expect(created.email).toBe('a@empresa.com');
    const u = (await dbQuery<any>(`SELECT * FROM users WHERE id='usr_tl_a'`)).rows[0];
    expect(u.company_id).toBe('co_tl');
    expect(u.instagram_account_id).toBe('tl_a');
    expect(u.password_hash.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword(created.password, u.password_hash).ok).toBe(true);
    expect(await accountRow('tl_a')).toEqual(accBefore); // conta Instagram e token intactos
  });

  it('create cria usuário novo ligado à empresa e à conta quando não havia usuário', async () => {
    const created = await createTenantLogin({ tenantId: 'tl_b', email: 'b@empresa.com' });
    const u = (await dbQuery<any>(`SELECT * FROM users WHERE id=$1`, [created.userId])).rows[0];
    expect(u.role).toBe('TENANT');
    expect(u.company_id).toBe('co_tl');
    expect(u.instagram_account_id).toBe('tl_b');
    expect(await accountRow('tl_b')).toMatchObject({ instagram_user_id: '17841400000000b02', has_valid_token: true });
  });

  it('recusa empresa que já tem login, e-mail em uso e empresa inexistente (sem alterar nada)', async () => {
    const hashC = (await dbQuery<any>(`SELECT password_hash h FROM users WHERE id='usr_tl_c'`)).rows[0].h;
    await expect(createTenantLogin({ tenantId: 'tl_c', email: 'novo@x.com' })).rejects.toThrow(/já possui um login/);
    await expect(createTenantLogin({ tenantId: 'tl_a', email: 'x@x.com' })).rejects.toThrow(/já possui um login/);
    await expect(planTenantLogin({ tenantId: 'tl_nao_existe', email: 'q@x.com' })).rejects.toThrow(/não encontrada/);
    expect((await dbQuery<any>(`SELECT password_hash h FROM users WHERE id='usr_tl_c'`)).rows[0].h).toBe(hashC);

    await acc('tl_d', 'tl_conta_d', '17841400000000d04');
    await expect(planTenantLogin({ tenantId: 'tl_d', email: 'OCUPADO@x.com' })).rejects.toThrow(/e-mail/);
  });

  it('depois do provisionamento, ninguém mais aparece em list', async () => {
    const ids = (await listTenantsWithoutLogin()).map((r) => r.id);
    expect(ids).not.toContain('tl_a');
    expect(ids).not.toContain('tl_b');
  });
});
