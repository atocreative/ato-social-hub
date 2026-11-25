import { beforeAll, describe, expect, it } from 'vitest';
import { dbQuery } from '../db/pool.ts';
import { runDatabaseMigrations } from '../db/migrations.ts';
import { createReviewAccount, planReviewAccount, REVIEW_TENANT_ID, REVIEW_USER_ID } from '../services/reviewAccount.ts';
import { verifyPassword } from '../utils/passwordHash.ts';

const count = async (t: string) => Number((await dbQuery<any>(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n);

describe('Conta de avaliação da Meta', () => {
  beforeAll(async () => {
    await runDatabaseMigrations();
    await dbQuery(`INSERT INTO companies (id, name, drive_folder_name) VALUES ('co_real','Cliente Real','pasta_real')`);
    await dbQuery(
      `INSERT INTO instagram_accounts (id, company_id, username, nome, instagram_user_id, status, connection_status, has_valid_token)
       VALUES ('ig_real','co_real','cliente_real','Cliente Real','178414000000999','APROVADO','CONECTADO',true)`
    );
  });

  it('simulação não grava nada', async () => {
    const before = [await count('companies'), await count('instagram_accounts'), await count('users')];
    const plan = await planReviewAccount('revisor@example.com');
    expect(plan.willCreate).toEqual({ company: true, instagramPlaceholder: true, user: true });
    expect([await count('companies'), await count('instagram_accounts'), await count('users')]).toEqual(before);
  });

  it('cria empresa própria, conta SEM Instagram vinculado e usuário TENANT com senha hasheada', async () => {
    const created = await createReviewAccount({ email: 'Revisor@Example.com' });
    expect(created.email).toBe('revisor@example.com');
    expect(created.password.length).toBeGreaterThanOrEqual(12);

    const u = (await dbQuery<any>(`SELECT * FROM users WHERE id=$1`, [REVIEW_USER_ID])).rows[0];
    expect(u.role).toBe('TENANT');
    expect(u.company_id).toBe('company_meta_review');
    expect(u.instagram_account_id).toBe(REVIEW_TENANT_ID);
    expect(u.password_hash).not.toContain(created.password);
    expect(verifyPassword(created.password, u.password_hash).ok).toBe(true);

    const ig = (await dbQuery<any>(`SELECT * FROM instagram_accounts WHERE id=$1`, [REVIEW_TENANT_ID])).rows[0];
    expect(ig.connection_status).toBe('DESCONECTADO');
    expect(ig.has_valid_token).toBe(false);
    expect(ig.encrypted_access_token).toBeNull();
    expect(String(ig.instagram_user_id)).toMatch(/^pending_ig_/);
    expect(ig.status).toBe('APROVADO');
  });

  it('não toca em empresa, conta ou usuário de cliente real', async () => {
    const co = (await dbQuery<any>(`SELECT name FROM companies WHERE id='co_real'`)).rows;
    const ig = (await dbQuery<any>(`SELECT connection_status, has_valid_token, company_id FROM instagram_accounts WHERE id='ig_real'`)).rows[0];
    expect(co[0].name).toBe('Cliente Real');
    expect(ig).toMatchObject({ connection_status: 'CONECTADO', has_valid_token: true, company_id: 'co_real' });
  });

  it('recusa criar de novo e e-mail já usado', async () => {
    await expect(createReviewAccount({ email: 'outro@example.com' })).rejects.toThrow(/Nada foi alterado/);
    await expect(planReviewAccount('revisor@example.com')).rejects.toThrow(/Nada foi alterado/);
  });
});
