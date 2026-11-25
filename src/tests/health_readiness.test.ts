import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { dbQuery } from '../db/pool.ts';
import { checkDeployReadiness, rollbackMigration, runDatabaseMigrations } from '../db/migrations.ts';

const RETIRED = crypto.createHash('sha256').update('666666').digest('hex');

describe('Prontidão para o healthcheck', () => {
  beforeAll(async () => {
    await runDatabaseMigrations();
  });

  it('banco migrado e sem senha padrão → pronto', async () => {
    expect(await checkDeployReadiness()).toEqual({ ready: true, reasons: [] });
  });

  it('migração pendente → não pronto (a versão anterior continua no ar)', async () => {
    await rollbackMigration('009_block_retired_default_password');
    const r = await checkDeployReadiness();
    expect(r.ready).toBe(false);
    expect(r.reasons.join()).toContain('migrations_pending:009_block_retired_default_password');
  });

  it('admin ainda com a senha padrão aposentada → não pronto', async () => {
    // Sem o gatilho (009 revertida) o hash antigo pode existir, como no banco de produção atual.
    await dbQuery(`INSERT INTO users (id,email,name,password_hash,role) VALUES ('u_old','old@x.com','Old',$1,'ADMIN')`, [RETIRED]);
    await runDatabaseMigrations();
    const r = await checkDeployReadiness();
    expect(r.ready).toBe(false);
    expect(r.reasons).toContain('retired_default_password_present');
    // Depois da rotação fica pronto.
    await dbQuery(`UPDATE users SET password_hash='scrypt$rotacionado' WHERE id='u_old'`);
    expect((await checkDeployReadiness()).ready).toBe(true);
  });
});
