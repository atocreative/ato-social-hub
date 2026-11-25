import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test_jwt_secret_admin_reset_0123456789';
process.env.TOKEN_ENCRYPTION_KEY = 'test_token_encryption_key_0123456789abcdef';

import { app, ensurePostgresBootstrapped } from '../../server.ts';
import { dbQuery } from '../db/pool.ts';

const ACTION = 'RESET_SELECTED_TO_PENDING';

describe('Reset administrativo de registros de teste: ação explícita e alcance limitado', () => {
  let server: http.Server;
  let baseUrl = '';
  const sign = (role: 'ADMIN' | 'TENANT') =>
    jwt.sign({ id: role === 'ADMIN' ? 'user_admin_ato' : 'usr_x', role, nome: 'T', email: 't@x.com' }, process.env.JWT_SECRET as string, { expiresIn: '1h' });

  const post = (body: any, token?: string) =>
    fetch(`${baseUrl}/api/admin/test-records/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  const seedPost = (id: string, status: string, mediaId: string | null) =>
    dbQuery(
      `INSERT INTO posts (id, company_id, lote_nome, nome, categoria, status, instagram_media_id, published_at, publish_attempts)
       VALUES ($1, 'co_reset', 'lote', 'nome', 'FEED', $2, $3, $4, 2)`,
      [id, status, mediaId, mediaId ? new Date().toISOString() : null]
    );
  const row = async (id: string) =>
    (await dbQuery<any>(`SELECT status, instagram_media_id, publish_attempts FROM posts WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await ensurePostgresBootstrapped();
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await dbQuery(`INSERT INTO companies (id, name, drive_folder_name) VALUES ('co_reset', 'Empresa Reset', 'pasta_reset') ON CONFLICT DO NOTHING`);
    await seedPost('p_erro', 'ERRO', null);
    await seedPost('p_agendado', 'AGENDADO', null);
    await seedPost('p_publicado', 'POSTADO', '17900000000000001');
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it('exige login de administrador', async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ confirm: true, action: ACTION, scope: 'SELECTED_IDS', selectedIds: ['p_erro'] }, sign('TENANT'))).status).toBe(403);
  });

  it('sem action explícita não faz nada (não existe mais ação padrão)', async () => {
    const r = await post({ confirm: true, scope: 'SELECTED_IDS', selectedIds: ['p_erro'] }, sign('ADMIN'));
    expect(r.status).toBe(400);
    expect((await row('p_erro')).status).toBe('ERRO');
  });

  it('recusa ações antigas/desconhecidas, inclusive ARCHIVE_TESTS', async () => {
    for (const action of ['ARCHIVE_TESTS', 'RESET_ALL_POSTS_TO_UNPUBLISHED', 'qualquer']) {
      const r = await post({ confirm: true, action, scope: 'SELECTED_IDS', selectedIds: ['p_erro'] }, sign('ADMIN'));
      expect(r.status).toBe(400);
    }
    expect((await row('p_erro')).status).toBe('ERRO');
  });

  it('sem scope ou com lista vazia não amplia o alcance para todos os posts', async () => {
    const a = await post({ confirm: true, action: ACTION, selectedIds: ['p_erro'] }, sign('ADMIN'));
    const b = await post({ confirm: true, action: ACTION, scope: 'ALL_CANDIDATES' }, sign('ADMIN'));
    const c = await post({ confirm: true, action: ACTION, scope: 'SELECTED_IDS', selectedIds: [] }, sign('ADMIN'));
    expect([a.status, b.status, c.status]).toEqual([400, 400, 400]);
    expect((await row('p_erro')).status).toBe('ERRO');
    expect((await row('p_agendado')).status).toBe('AGENDADO');
    expect((await row('p_publicado')).status).toBe('POSTADO');
  });

  it('sem confirm:true não executa', async () => {
    const r = await post({ action: ACTION, scope: 'SELECTED_IDS', selectedIds: ['p_erro'] }, sign('ADMIN'));
    expect(r.status).toBe(400);
    expect((await row('p_erro')).status).toBe('ERRO');
  });

  it('com tudo explícito reseta só o selecionado e protege post já publicado no Instagram', async () => {
    const r = await post({ confirm: true, action: ACTION, scope: 'SELECTED_IDS', selectedIds: ['p_erro', 'p_publicado'] }, sign('ADMIN'));
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.affectedCount).toBe(1);
    expect(r.body.skippedPublishedCount).toBe(1);

    expect((await row('p_erro')).status).toBe('PENDENTE');
    expect((await row('p_agendado')).status).toBe('AGENDADO'); // não selecionado: intacto
    const pub = await row('p_publicado');
    expect(pub.status).toBe('POSTADO');
    expect(pub.instagram_media_id).toBe('17900000000000001'); // vínculo com o post real preservado
  });

  it('o reset de postagens não apaga empresas', async () => {
    const r = await dbQuery(`SELECT 1 FROM companies WHERE id = 'co_reset'`);
    expect(r.rows.length).toBe(1);
  });
});
