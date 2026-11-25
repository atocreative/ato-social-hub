import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { dbQuery } from '../db/pool.ts';
import { runDatabaseMigrations, splitSqlStatements } from '../db/migrations.ts';

const RETIRED = crypto.createHash('sha256').update('666666').digest('hex');
const GOOD = 'scrypt$16384$8$1$c2FsdA$aGFzaA';

const hashOf = async (id: string) => (await dbQuery<any>(`SELECT password_hash h FROM users WHERE id=$1`, [id])).rows[0]?.h;

describe('Migração 009: a senha padrão antiga nunca volta a ser gravada', () => {
  beforeAll(async () => {
    await runDatabaseMigrations();
    await dbQuery(
      `INSERT INTO users (id, email, name, password_hash, role) VALUES ('u_trg_admin','trg@x.com','Admin','${GOOD}','ADMIN')
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash`
    );
  });

  it('o splitter respeita blocos $$ ... $$', () => {
    const parts = splitSqlStatements('CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE sql; SELECT 1;');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('RETURN 1;');
  });

  it('o código ANTIGO (INSERT ... ON CONFLICT DO UPDATE com SHA-256 de 666666) não sobrescreve a senha rotacionada', async () => {
    await dbQuery(
      `INSERT INTO users (id, email, name, password_hash, role, status, permissions, updated_at)
       VALUES ('u_trg_admin','trg@x.com','Admin','${RETIRED}','ADMIN','APROVADO','[]'::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, role='ADMIN', updated_at = NOW()`
    );
    expect(await hashOf('u_trg_admin')).toBe(GOOD);
  });

  it('UPDATE direto para a senha antiga é ignorado', async () => {
    await dbQuery(`UPDATE users SET password_hash = '${RETIRED}' WHERE id = 'u_trg_admin'`);
    expect(await hashOf('u_trg_admin')).toBe(GOOD);
  });

  it('usuário novo com a senha antiga nasce sem login habilitado', async () => {
    await dbQuery(`INSERT INTO users (id, email, name, password_hash, role) VALUES ('u_trg_new','new@x.com','Novo','${RETIRED}','TENANT')`);
    expect(String(await hashOf('u_trg_new'))).toMatch(/^disabled\$/);
  });

  it('trocas legítimas de senha e outras atualizações continuam funcionando', async () => {
    await dbQuery(`UPDATE users SET password_hash = 'scrypt$novo' WHERE id = 'u_trg_admin'`);
    expect(await hashOf('u_trg_admin')).toBe('scrypt$novo');
    await dbQuery(`UPDATE users SET name = 'Outro Nome' WHERE id = 'u_trg_admin'`);
    expect(await hashOf('u_trg_admin')).toBe('scrypt$novo');
  });
});
