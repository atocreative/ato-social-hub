import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import {
  checkDatabaseConnection,
  dbQuery,
  setSimulateDatabaseUnavailable,
  DatabaseUnavailableError,
} from '../db/pool.ts';
import { runDatabaseMigrations, getAppliedMigrations } from '../db/migrations.ts';
import {
  ensureDefaultAdminUser,
  authenticateAdminUser,
  upsertCompany,
  listCompanies,
  upsertInstagramAccount,
  listInstagramAccounts,
  listPostGroupsFromDb,
  getPostGroupByIdFromDb,
  saveCaptionForPostTx,
  recordApprovalInDb,
  acquirePostScheduleLockInDb,
  recordPublicationAttemptAndOutcomeInDb,
  getDatabaseTableCounts,
  resolveTenantTokenWithFallback,
} from '../db/repository.ts';
import { migrateFromJsonToPostgres } from '../db/migrateFromJson.ts';
import { generateCaptionWithGemini } from '../services/geminiCaptionService.ts';
import { encryptInstagramToken } from '../services/instagramCore.ts';

test('ETAPA 1 & 3 — PostgreSQL Schema, Migrations Idempotentes e Bloqueio de Fallback JSON em Indisponibilidade', async () => {
  const mig1 = await runDatabaseMigrations();
  assert.ok(
    mig1.applied.length + mig1.alreadyApplied.length >= 1,
    'Deve existir pelo menos 1 migration registrada'
  );

  // Reexecutar migrations deve ser 100% idempotente
  const mig2 = await runDatabaseMigrations();
  assert.equal(mig2.applied.length, 0, 'Segunda execução não deve reaplicar migrations já registradas');

  const applied = await getAppliedMigrations();
  assert.equal(applied[0].version, '001_initial_ato_social_hub_schema');

  const conn = await checkDatabaseConnection();
  assert.equal(conn.connected, true, 'Conexão PostgreSQL deve estar ativa');

  // Simular indisponibilidade do PostgreSQL: deve lançar DatabaseUnavailableError (HTTP 503) e NUNCA cair em fallback JSON
  setSimulateDatabaseUnavailable(true);
  try {
    await assert.rejects(
      async () => {
        await dbQuery('SELECT 1');
      },
      (err: any) => {
        assert.ok(err instanceof DatabaseUnavailableError);
        assert.equal(err.statusCode, 503);
        return true;
      }
    );
  } finally {
    setSimulateDatabaseUnavailable(false);
  }
});

test('ETAPA 2 & 4 — Migração Auditável de .data/database.json e _MEMORIA_REPROVACOES.md para PostgreSQL com Backup e Integridade Referencial', async () => {
  const jsonPath = path.resolve(process.cwd(), '.data/database.json');
  const memoriaPath = path.resolve(process.cwd(), '_MEMORIA_REPROVACOES.md');
  assert.ok(fs.existsSync(jsonPath), '.data/database.json original deve ser preservado');
  assert.ok(fs.existsSync(memoriaPath), '_MEMORIA_REPROVACOES.md original deve ser preservado');

  // 1. Dry-run
  const dryRunReport = await migrateFromJsonToPostgres({
    jsonPath,
    memoriaPath,
    dryRun: true,
    skipBackup: true,
  });
  assert.equal(dryRunReport.dryRun, true);
  const mediaSummary = dryRunReport.entities.find((e) => e.entity === 'media_assets');
  assert.ok(mediaSummary, 'Resumo da entidade media_assets deve estar presente');
  assert.equal(
    mediaSummary?.rejected,
    1,
    'Deve descartar exatamente 1 item sintético de teste (drive_test_item_rejection)'
  );
  assert.equal(
    mediaSummary?.foundInSource,
    29,
    'Fontes JSON (database.json + last_webhook_payload.json) possuem 29 itens brutos (28 reais + 1 sintético)'
  );

  // 2. Migração real com criação de backup em .data/backups
  const realReport = await migrateFromJsonToPostgres({
    jsonPath,
    memoriaPath,
    dryRun: false,
    skipBackup: false,
  });

  assert.equal(realReport.referentialIntegrityOk, true, 'Integridade referencial deve ser 100% válida');
  assert.ok(
    realReport.backupFilePath && fs.existsSync(realReport.backupFilePath),
    'Backup pré-migração deve existir em .data/backups/'
  );

  const counts = await getDatabaseTableCounts();
  assert.ok(counts.companies >= 1, 'Empresa Ato deve estar persistida em companies');
  assert.ok(counts.instagram_accounts >= 1, 'Conta @ato.vc deve estar persistida em instagram_accounts');
  assert.equal(counts.media_assets, 28, 'Todos os 28 arquivos reais do Google Drive devem estar em media_assets');
  assert.equal(counts.posts, 16, 'Todos os 16 lotes reais (posts) devem estar em posts');
  assert.equal(counts.post_media, 28, 'Todas as 28 relações post_media devem estar íntegras');
  assert.ok(counts.rejections >= 30, 'Histórico de 30 reprovações de _MEMORIA_REPROVACOES.md deve estar em rejections');
});

test('ETAPA 5 & 6 — Usuários, Empresas (Google Drive) e Contas Instagram (@ato.vc) no PostgreSQL', async () => {
  await ensureDefaultAdminUser();

  const validAdmin = await authenticateAdminUser('admin@atodev.com.br', '666666');
  assert.ok(validAdmin, 'Admin oficial admin@atodev.com.br deve autenticar no PostgreSQL');
  assert.equal(validAdmin?.role, 'ADMIN');

  const invalidAdmin = await authenticateAdminUser('admin@atodev.com.br', 'senha_errada');
  assert.equal(invalidAdmin, null, 'Senha incorreta deve ser recusada');

  const companies = await listCompanies();
  const atoCompany = companies.find((c) => c.name.toLowerCase() === 'ato');
  assert.ok(atoCompany, 'Empresa Ato deve existir no PostgreSQL');
  assert.equal(
    atoCompany?.driveFolderId,
    '1CCJ4Fo3hLGSTb1y84P2tckFYW4bQudGF',
    'Folder ID original do Google Drive da empresa Ato deve estar preservado'
  );

  // Atualiza perfil de marca para IA
  const updatedComp = await upsertCompany({
    id: atoCompany!.id,
    name: 'Ato',
    driveFolderId: atoCompany!.driveFolderId,
    driveFolderName: 'Ato',
    segment: 'Agência de Posicionamento Digital, Branding e Performance',
    brandVoice: 'Estratégico, direto, contemporâneo e focado em autoridade',
    defaultCta: 'Comente abaixo e compartilhe com seu time!',
    defaultHashtags: '#ato #branding #estrategiadigital #socialmedia',
  });
  assert.equal(updatedComp.defaultHashtags, '#ato #branding #estrategiadigital #socialmedia');

  // Testa persistência de token criptografado da conta @ato.vc
  const secretKey =
    process.env.TOKEN_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    'ato_super_secret_key_2026_998877';
  const rawLongToken = 'IGQVJ_REAL_LONG_LIVED_TEST_TOKEN_ATO_VC_2026';
  const savedAcc = await upsertInstagramAccount({
    id: 'tenant_ato_vc',
    companyId: updatedComp.id,
    username: 'ato.vc',
    nome: 'ATO Agência (@ato.vc)',
    instagramUserId: '17841400000099999',
    driveFolderName: 'Ato',
    driveFolderId: updatedComp.driveFolderId,
    status: 'APROVADO',
    encryptedAccessToken: encryptInstagramToken(rawLongToken, secretKey),
    tokenType: 'LONG_LIVED',
    tokenIssuedAt: new Date().toISOString(),
    tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    grantedScopes: ['instagram_business_basic', 'instagram_business_content_publish'],
    connectionStatus: 'CONECTADO',
    hasValidToken: true,
  });

  assert.equal(savedAcc.username, 'ato.vc');
  assert.equal(resolveTenantTokenWithFallback(savedAcc), rawLongToken);
});

test('ETAPA 7 — Integração Gemini API Server-Side: Geração Real, Regeneração, Edição e Regra de Reaprovação Obrigatória', async () => {
  const allPosts = await listPostGroupsFromDb({ driveFolderName: 'Ato' });
  assert.ok(allPosts.length > 0, 'Devem existir posts migrados da pasta Ato');
  const targetPost = allPosts[0];

  // 1. Geração real de legenda via Gemini API (server-side)
  const gen1 = await generateCaptionWithGemini({
    postId: targetPost.id,
    objective: 'Gerar autoridade e engajamento qualificado',
    theme: targetPost.loteNome,
    tone: 'Direto, estratégico e profissional',
    cta: 'Deixe seu comentário sobre este projeto!',
    includeHashtags: true,
    regenerate: false,
    createdBy: 'admin@atodev.com.br',
  });

  assert.ok(gen1.caption.length > 20, 'Legenda gerada pela Gemini API deve ter conteúdo real');
  assert.equal(gen1.captionRecord.source, 'GEMINI_AI');
  assert.equal(gen1.aiGeneration.status, 'SUCCESS');

  // 2. Gerar outra versão (regenerate = true)
  const gen2 = await generateCaptionWithGemini({
    postId: targetPost.id,
    objective: 'Conversão e fortalecimento de marca',
    theme: targetPost.loteNome,
    tone: 'Inspirador e objetivo',
    cta: 'Salve este post para consultar depois!',
    includeHashtags: true,
    regenerate: true,
    createdBy: 'admin@atodev.com.br',
  });

  assert.ok(gen2.caption.length > 20, 'Segunda versão gerada pela Gemini API deve ter conteúdo real');
  assert.ok(
    gen2.captionRecord.versionNumber > gen1.captionRecord.versionNumber,
    'Versão deve ser incrementada na tabela captions'
  );

  // 3. Aprovar o post e a legenda atual
  await recordApprovalInDb({
    postId: targetPost.id,
    caption: gen2.caption,
    action: 'APPROVE_ONLY',
    approvedBy: 'admin@atodev.com.br',
  });

  const approvedPost = await getPostGroupByIdFromDb(targetPost.id);
  assert.equal(approvedPost?.status, 'APROVADO');
  assert.equal(approvedPost?.captionApproved, true);
  assert.equal(approvedPost?.isApprovedForSchedule, true);

  // 4. Editar a legenda APÓS aprovação -> Deve exigir nova aprovação (PENDENTE_APROVACAO / captionApproved = false)
  const editedCaptionText = `${gen2.caption}\n\n[Edição manual pós-aprovação para validação]`;
  const editRes = await saveCaptionForPostTx({
    postId: targetPost.id,
    content: editedCaptionText,
    source: 'EDITED_AI',
    aiGenerationId: gen2.aiGeneration.id,
    createdBy: 'admin@atodev.com.br',
  });

  assert.equal(
    editRes.requiresReapproval,
    true,
    'Alterar legenda após aprovação deve exigir nova aprovação antes da publicação'
  );
  assert.equal(
    editRes.post.status,
    'PENDENTE_APROVACAO',
    'Status do post deve transicionar para PENDENTE_APROVACAO quando legenda aprovada é modificada'
  );
  assert.equal(editRes.post.captionApproved, false);
  assert.equal(editRes.post.isApprovedForSchedule, false);
});

test('ETAPA 9 — Agendamento Transacional e Registro de Publicação no PostgreSQL', async () => {
  const allPosts = await listPostGroupsFromDb({ driveFolderName: 'Ato' });
  const post = allPosts[1] || allPosts[0];
  const accounts = await listInstagramAccounts();
  const atoAccount = accounts.find((a) => a.username === 'ato.vc')!;

  const duePastUtc = new Date(Date.now() - 60_000).toISOString();

  // Aprova e agenda para horário vencido
  await recordApprovalInDb({
    postId: post.id,
    caption: 'Legenda final aprovada para agendamento #ato',
    action: 'APPROVE_AND_SCHEDULE',
    approvedBy: 'admin@atodev.com.br',
    scheduledAtUtc: duePastUtc,
    scheduledTimezone: 'America/Sao_Paulo',
    scheduledAccountId: atoAccount.id,
  });

  // Adquire lock transacional no PostgreSQL
  const nowMs = Date.now();
  const lock1 = await acquirePostScheduleLockInDb(post.id, 'worker_pg_1', nowMs);
  assert.equal(lock1.acquired, true, 'Primeiro worker deve adquirir o lock transacional');
  assert.equal(lock1.post?.status, 'PUBLICANDO');

  // Segundo worker concorrente não pode adquirir o mesmo lock
  const lock2 = await acquirePostScheduleLockInDb(post.id, 'worker_pg_2', nowMs + 100);
  assert.equal(lock2.acquired, false, 'Segundo worker concorrente deve ser bloqueado pelo lock no PostgreSQL');

  // Registra tentativa e publicação concluída em publication_attempts e publication_history
  const publishedAtIso = new Date().toISOString();
  const updated = await recordPublicationAttemptAndOutcomeInDb({
    postId: post.id,
    tenant: atoAccount,
    origin: 'SCHEDULER',
    caption: 'Legenda final aprovada para agendamento #ato',
    ok: true,
    finalStatus: 'PUBLICADO',
    containerId: '17890000111222',
    instagramMediaId: '17890000999888',
    permalink: 'https://www.instagram.com/p/DBPostgreSQLTest/',
    publishedAt: publishedAtIso,
    attemptRecord: {
      attemptNumber: 1,
      startedAt: publishedAtIso,
      finishedAt: publishedAtIso,
      accountId: atoAccount.id,
      igUserId: atoAccount.instagramUserId,
      containerId: '17890000111222',
      mediaId: '17890000999888',
      permalink: 'https://www.instagram.com/p/DBPostgreSQLTest/',
      status: 'SUCCESS',
      httpStatus: 200,
    },
  });

  assert.equal(updated?.status, 'PUBLICADO');
  assert.equal(updated?.instagramMediaId, '17890000999888');

  const counts = await getDatabaseTableCounts();
  assert.ok(counts.publication_attempts >= 1, 'Tentativa de publicação deve estar em publication_attempts');
  assert.ok(counts.publication_history >= 1, 'Histórico de publicação deve estar em publication_history');
});
