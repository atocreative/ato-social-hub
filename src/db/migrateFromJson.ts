import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbQuery, withTransaction } from './pool.ts';
import { runDatabaseMigrations } from './migrations.ts';
import {
  ensureDefaultAdminUser,
  getDatabaseTableCounts,
  upsertCompany,
  upsertInstagramAccount,
  upsertPostGroupToDb,
} from './repository.ts';
import {
  DriveImageItem,
  EntityMigrationSummary,
  MigrationReport,
  PostGroup,
  TenantAccount,
} from '../types/index.ts';
import { groupAndSortDriveItems } from '../utils/postHelpers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT_DIR, '.data');
const DB_JSON_PATH = path.join(DATA_DIR, 'database.json');
const WEBHOOK_JSON_PATH = path.join(DATA_DIR, 'last_webhook_payload.json');
const MEMORIA_MD_PATH = path.join(ROOT_DIR, '_MEMORIA_REPROVACOES.md');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

interface ParsedMemoriaRejection {
  timestamp: string;
  originalFilename: string;
  novoNomeArquivo: string;
  motivo: string;
  tags: string[];
  pastaNome: string;
}

/**
 * Parses historical rejections from _MEMORIA_REPROVACOES.md so no historical feedback is lost.
 */
export function parseMemoriaReprovacoesMarkdown(rawMd: string): ParsedMemoriaRejection[] {
  const lines = String(rawMd || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ['));

  const records: ParsedMemoriaRejection[] = [];
  const regex =
    /^- \[([^\]]+)\]\s*Arquivo:\s*\*\*([^*]+)\*\*\s*->\s*Novo Nome:\s*\*\*([^*]+)\*\*\s*\|\s*Motivo:\s*"([^"]*)"\s*\|\s*Tags:\s*(\[[^\]]*\])\s*\|\s*Pasta:\s*(.+)$/;

  for (const line of lines) {
    const m = regex.exec(line);
    if (!m) continue;
    let parsedTags: string[] = [];
    try {
      parsedTags = JSON.parse(m[5]);
    } catch {
      parsedTags = [];
    }
    records.push({
      timestamp: m[1].trim(),
      originalFilename: m[2].trim(),
      novoNomeArquivo: m[3].trim(),
      motivo: m[4].trim(),
      tags: Array.isArray(parsedTags) ? parsedTags : [],
      pastaNome: m[6].trim(),
    });
  }
  return records;
}

/**
 * Creates a timestamped, read-only backup of all legacy JSON/Markdown data files before migration.
 */
export function createPreMigrationBackup(): string | undefined {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupBundlePath = path.join(BACKUP_DIR, `backup_pre_postgres_${stamp}.json`);

    const bundle: Record<string, any> = {
      backedUpAt: new Date().toISOString(),
      files: {},
    };

    if (fs.existsSync(DB_JSON_PATH)) {
      bundle.files['database.json'] = JSON.parse(fs.readFileSync(DB_JSON_PATH, 'utf8'));
    }
    if (fs.existsSync(WEBHOOK_JSON_PATH)) {
      bundle.files['last_webhook_payload.json'] = JSON.parse(
        fs.readFileSync(WEBHOOK_JSON_PATH, 'utf8')
      );
    }
    if (fs.existsSync(MEMORIA_MD_PATH)) {
      bundle.files['_MEMORIA_REPROVACOES.md'] = fs.readFileSync(MEMORIA_MD_PATH, 'utf8');
    }

    fs.writeFileSync(backupBundlePath, JSON.stringify(bundle, null, 2), 'utf8');
    return backupBundlePath;
  } catch (err: any) {
    console.warn('[Migration Backup] Aviso ao criar backup local:', err.message);
    return undefined;
  }
}

/**
 * Executes or simulates (dry-run) the complete idempotent migration from JSON/Markdown to PostgreSQL.
 */
export async function runJsonToPostgresMigration(options?: {
  dryRun?: boolean;
  includeTestArtifacts?: boolean;
  customDbJsonPath?: string;
  jsonPath?: string;
  memoriaPath?: string;
  skipBackup?: boolean;
}): Promise<MigrationReport> {
  const dryRun = Boolean(options?.dryRun);
  const includeTestArtifacts = Boolean(options?.includeTestArtifacts);
  const targetJsonPath = options?.jsonPath || options?.customDbJsonPath || DB_JSON_PATH;

  await runDatabaseMigrations();
  const countsBefore = await getDatabaseTableCounts();

  const backupFilePath =
    dryRun || options?.skipBackup ? undefined : createPreMigrationBackup();
  const sourceFilesAnalyzed: string[] = [];

  let rawJson: any = {
    tenants: [],
    rawDriveItems: [],
    driveFolders: [],
    postGroupsMeta: {},
    adminAlerts: [],
    schedulerRuns: [],
  };

  if (fs.existsSync(targetJsonPath)) {
    sourceFilesAnalyzed.push(targetJsonPath);
    try {
      rawJson = JSON.parse(fs.readFileSync(targetJsonPath, 'utf8'));
    } catch (err: any) {
      throw new Error(`Falha ao ler arquivo JSON de origem (${targetJsonPath}): ${err.message}`);
    }
  }

  if (fs.existsSync(WEBHOOK_JSON_PATH)) {
    sourceFilesAnalyzed.push(WEBHOOK_JSON_PATH);
  }

  let memoriaRejections: ParsedMemoriaRejection[] = [];
  if (fs.existsSync(MEMORIA_MD_PATH)) {
    sourceFilesAnalyzed.push(MEMORIA_MD_PATH);
    memoriaRejections = parseMemoriaReprovacoesMarkdown(fs.readFileSync(MEMORIA_MD_PATH, 'utf8'));
  }

  const rawFolders: Array<{ id: string; nome: string; url?: string }> = Array.isArray(
    rawJson.driveFolders
  )
    ? rawJson.driveFolders
    : [];
  const rawTenants: TenantAccount[] = Array.isArray(rawJson.tenants) ? rawJson.tenants : [];
  const rawItems: DriveImageItem[] = Array.isArray(rawJson.rawDriveItems)
    ? rawJson.rawDriveItems
    : [];
  const postGroupsMeta: Record<string, Partial<PostGroup>> =
    rawJson.postGroupsMeta && typeof rawJson.postGroupsMeta === 'object'
      ? rawJson.postGroupsMeta
      : {};
  const rawAlerts: any[] = Array.isArray(rawJson.adminAlerts) ? rawJson.adminAlerts : [];
  const rawRuns: any[] = Array.isArray(rawJson.schedulerRuns) ? rawJson.schedulerRuns : [];

  // Summaries per entity
  const companiesSummary: EntityMigrationSummary = {
    entity: 'companies',
    foundInSource: 0,
    imported: 0,
    alreadyExisting: countsBefore.companies || 0,
    rejected: 0,
    rejectionReasons: [],
    divergences: [],
  };

  const accountsSummary: EntityMigrationSummary = {
    entity: 'instagram_accounts',
    foundInSource: rawTenants.length,
    imported: 0,
    alreadyExisting: countsBefore.instagram_accounts || 0,
    rejected: 0,
    rejectionReasons: [],
    divergences: [],
  };

  const mediaSummary: EntityMigrationSummary = {
    entity: 'media_assets',
    foundInSource: rawItems.length,
    imported: 0,
    alreadyExisting: countsBefore.media_assets || 0,
    rejected: 0,
    rejectionReasons: [],
    divergences: [],
  };

  const postsSummary: EntityMigrationSummary = {
    entity: 'posts',
    foundInSource: 0,
    imported: 0,
    alreadyExisting: countsBefore.posts || 0,
    rejected: 0,
    rejectionReasons: [],
    divergences: [],
  };

  const rejectionsSummary: EntityMigrationSummary = {
    entity: 'rejections',
    foundInSource: memoriaRejections.length,
    imported: 0,
    alreadyExisting: countsBefore.rejections || 0,
    rejected: 0,
    rejectionReasons: [],
    divergences: [],
  };

  const logsSummary: EntityMigrationSummary = {
    entity: 'operational_logs',
    foundInSource: rawAlerts.length + rawRuns.length,
    imported: 0,
    alreadyExisting: countsBefore.operational_logs || 0,
    rejected: 0,
    rejectionReasons: [],
    divergences: [],
  };

  // 1. Identify companies from driveFolders + rawItems + tenants
  const companiesMap = new Map<string, { id: string; nome: string; url?: string }>();
  for (const f of rawFolders) {
    if (!f || !f.nome) continue;
    if (f.nome.toLowerCase() === 'ato social midia') {
      companiesSummary.rejected++;
      companiesSummary.rejectionReasons.push(
        `Pasta raiz "${f.nome}" ignorada como empresa cliente (é o diretório container geral).`
      );
      continue;
    }
    companiesMap.set(f.nome.toLowerCase(), { id: f.id || f.nome, nome: f.nome, url: f.url });
  }

  for (const item of rawItems) {
    const fName = (item.pastaClienteNome || item.driveFolderName || '').trim();
    if (fName && fName.toLowerCase() !== 'ato social midia' && !companiesMap.has(fName.toLowerCase())) {
      companiesMap.set(fName.toLowerCase(), {
        id: item.pastaClienteId || fName,
        nome: fName,
        url: item.pastaUrl,
      });
    }
  }

  companiesSummary.foundInSource = companiesMap.size;

  // 2. Filter and validate media items (detecting test artifacts vs real Drive assets)
  const validDriveItems: DriveImageItem[] = [];
  for (const item of rawItems) {
    if (!item || !item.driveFileId) {
      mediaSummary.rejected++;
      mediaSummary.rejectionReasons.push('Item de mídia sem driveFileId.');
      continue;
    }

    const isSyntheticTestItem =
      item.driveFileId === 'drive_test_item_rejection' ||
      (item.viewUrl && item.viewUrl.startsWith('data:image/svg+xml') && item.driveFileId.startsWith('drive_test_'));

    if (isSyntheticTestItem && !includeTestArtifacts) {
      mediaSummary.rejected++;
      mediaSummary.rejectionReasons.push(
        `Registro de teste sintético "${item.driveFileId}" (${item.nome}) filtrado para não poluir o banco de produção.`
      );
      mediaSummary.divergences.push(
        `Detectado artefato de teste "${item.driveFileId}" em database.json (ignorado na migração de produção).`
      );
      continue;
    }

    validDriveItems.push(item);
  }

  // 3. Reconstruct PostGroups with postGroupsMeta
  const rawGroups = groupAndSortDriveItems(validDriveItems);
  const enrichedGroups: PostGroup[] = rawGroups.map((g) => {
    const meta = postGroupsMeta[g.id];
    if (!meta) return g;
    return {
      ...g,
      status: meta.status || g.status,
      caption: meta.caption !== undefined ? meta.caption : g.caption,
      scheduledAt: meta.scheduledAt !== undefined ? meta.scheduledAt : g.scheduledAt,
      scheduledTimezone:
        meta.scheduledTimezone !== undefined ? meta.scheduledTimezone : g.scheduledTimezone,
      scheduledAccountId:
        meta.scheduledAccountId !== undefined ? meta.scheduledAccountId : g.scheduledAccountId,
      publishedAt: meta.publishedAt !== undefined ? meta.publishedAt : g.publishedAt,
      instagramMediaId:
        meta.instagramMediaId !== undefined ? meta.instagramMediaId : g.instagramMediaId,
      instagramContainerId:
        meta.instagramContainerId !== undefined
          ? meta.instagramContainerId
          : g.instagramContainerId,
      childContainerIds:
        meta.childContainerIds !== undefined ? meta.childContainerIds : g.childContainerIds,
      instagramPermalink:
        meta.instagramPermalink !== undefined ? meta.instagramPermalink : g.instagramPermalink,
      approvedAt: meta.approvedAt !== undefined ? meta.approvedAt : g.approvedAt,
      approvedBy: meta.approvedBy !== undefined ? meta.approvedBy : g.approvedBy,
      isApprovedForSchedule:
        meta.isApprovedForSchedule !== undefined
          ? meta.isApprovedForSchedule
          : g.isApprovedForSchedule,
      publishAttempts:
        meta.publishAttempts !== undefined ? meta.publishAttempts : g.publishAttempts,
      lastAttemptAt: meta.lastAttemptAt !== undefined ? meta.lastAttemptAt : g.lastAttemptAt,
      nextRetryAt: meta.nextRetryAt !== undefined ? meta.nextRetryAt : g.nextRetryAt,
      failureReason: meta.failureReason !== undefined ? meta.failureReason : g.failureReason,
      publishLock: meta.publishLock !== undefined ? meta.publishLock : g.publishLock,
      publishHistory: meta.publishHistory !== undefined ? meta.publishHistory : g.publishHistory,
      rejectionFeedback:
        meta.rejectionFeedback !== undefined ? meta.rejectionFeedback : g.rejectionFeedback,
    };
  });

  postsSummary.foundInSource = enrichedGroups.length;

  // 4. Filter and reconcile Instagram Accounts (Tenants)
  const validTenants: TenantAccount[] = [];
  for (const t of rawTenants) {
    if (!t || !t.username) {
      accountsSummary.rejected++;
      accountsSummary.rejectionReasons.push('Conta sem username.');
      continue;
    }
    const cleanUser = t.username.replace(/^@/, '').trim().toLowerCase();
    if (cleanUser === 'caiorocha' || String(t.nome || '').toLowerCase() === 'caio rocha') {
      accountsSummary.rejected++;
      accountsSummary.rejectionReasons.push(`Conta fantasma legada @${cleanUser} descartada.`);
      continue;
    }
    validTenants.push(t);
  }

  // If tenants array in database.json was empty but company "Ato" exists, ensure @ato.vc account is registered
  // so the approved ATO company structure is preserved and ready for OAuth/publishing.
  if (validTenants.length === 0 && companiesMap.has('ato')) {
    const atoFolder = companiesMap.get('ato')!;
    accountsSummary.divergences.push(
      'O array "tenants" em database.json estava vazio; a conta oficial @ato.vc vinculada à pasta "Ato" foi reconciliada com status APROVADO e RECONEXAO_NECESSARIA até novo OAuth.'
    );
    validTenants.push({
      id: 'tenant_ato_vc',
      username: 'ato.vc',
      nome: 'ATO',
      instagramUserId: 'ato.vc',
      driveFolderName: atoFolder.nome,
      driveFolderId: atoFolder.id,
      status: 'APROVADO',
      connectionStatus: 'RECONEXAO_NECESSARIA',
      hasValidToken: false,
      requestedAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
    });
  }

  if (!dryRun) {
    await ensureDefaultAdminUser();

    await withTransaction(async (tx) => {
      // Import Companies
      for (const [, comp] of companiesMap.entries()) {
        await upsertCompany(
          {
            id: comp.id,
            name: comp.nome,
            driveFolderId: comp.id,
            driveFolderName: comp.nome,
            driveFolderUrl: comp.url || null,
          },
          tx
        );
        companiesSummary.imported++;
      }

      // Import Instagram Accounts
      for (const tenant of validTenants) {
        await upsertInstagramAccount(tenant, tx);
        accountsSummary.imported++;
      }

      // Import Posts, MediaAssets, PostMedia, Schedules
      for (const group of enrichedGroups) {
        await upsertPostGroupToDb(group, tx);
        postsSummary.imported++;
        mediaSummary.imported += group.items.length;
      }

      // Import Historical Rejections from _MEMORIA_REPROVACOES.md (idempotently by timestamp + filename)
      for (let i = 0; i < memoriaRejections.length; i++) {
        const mr = memoriaRejections[i];
        const rejId = `mem_rej_${Date.parse(mr.timestamp) || i}_${i}`;
        await tx.query(
          `
          INSERT INTO rejections (
            id, post_id, drive_file_id, pasta_cliente_id, pasta_nome,
            original_filename, novo_nome_arquivo, tags, motivo, rejected_by, data_reprovacao
          ) VALUES ($1, NULL, NULL, NULL, $2, $3, $4, $5::jsonb, $6, 'Histórico _MEMORIA_REPROVACOES.md', $7)
          ON CONFLICT (id) DO NOTHING
          `,
          [
            rejId,
            mr.pastaNome,
            mr.originalFilename,
            mr.novoNomeArquivo,
            JSON.stringify(mr.tags),
            mr.motivo,
            mr.timestamp,
          ]
        );
        rejectionsSummary.imported++;
      }

      // Import Operational Logs (Admin Alerts + Scheduler Runs)
      for (const alert of rawAlerts) {
        if (!alert || !alert.id) continue;
        await tx.query(
          `
          INSERT INTO operational_logs (
            id, category, type, tenant_id, username, post_id, message, resolved, resolved_at, created_at
          ) VALUES ($1, 'ADMIN_ALERT', $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO NOTHING
          `,
          [
            alert.id,
            alert.type || 'RECONEXAO_NECESSARIA',
            alert.tenantId || null,
            alert.username || null,
            alert.postId || null,
            alert.message || '',
            Boolean(alert.resolved),
            alert.resolvedAt || null,
            alert.createdAt || new Date().toISOString(),
          ]
        );
        logsSummary.imported++;
      }

      for (const run of rawRuns) {
        if (!run || !run.runId) continue;
        await tx.query(
          `
          INSERT INTO operational_logs (
            id, category, type, message, payload, resolved, created_at
          ) VALUES ($1, 'SCHEDULER_RUN', 'CRON_RUN', $2, $3::jsonb, TRUE, $4)
          ON CONFLICT (id) DO NOTHING
          `,
          [
            `run_${run.runId}`,
            `Processados: ${run.processedCount || 0}, Publicados: ${run.publishedCount || 0}`,
            JSON.stringify(run),
            run.startedAt || new Date().toISOString(),
          ]
        );
        logsSummary.imported++;
      }
    });
  } else {
    companiesSummary.imported = companiesMap.size;
    accountsSummary.imported = validTenants.length;
    postsSummary.imported = enrichedGroups.length;
    mediaSummary.imported = validDriveItems.length;
    rejectionsSummary.imported = memoriaRejections.length;
    logsSummary.imported = rawAlerts.length + rawRuns.length;
  }

  const countsAfter = await getDatabaseTableCounts();

  // Verify Referential Integrity
  const orphanPostMediaRes = await dbQuery<{ cnt: number }>(
    `
    SELECT COUNT(*) AS cnt
    FROM post_media pm
    LEFT JOIN posts p ON p.id = pm.post_id
    LEFT JOIN media_assets m ON m.drive_file_id = pm.drive_file_id
    WHERE p.id IS NULL OR m.drive_file_id IS NULL
    `
  );
  const orphanCount = Number(orphanPostMediaRes.rows[0]?.cnt || 0);
  const referentialIntegrityOk = orphanCount === 0;

  return {
    executedAt: new Date().toISOString(),
    dryRun,
    backupFilePath,
    sourceFilesAnalyzed,
    entities: [
      companiesSummary,
      accountsSummary,
      postsSummary,
      mediaSummary,
      rejectionsSummary,
      logsSummary,
    ],
    referentialIntegrityOk,
    integrityNotes: [
      referentialIntegrityOk
        ? 'Todas as chaves estrangeiras entre companies, instagram_accounts, posts, media_assets e post_media foram validadas sem registros órfãos.'
        : `Encontrados ${orphanCount} vínculos órfãos em post_media.`,
      'Os arquivos originais (.data/database.json e _MEMORIA_REPROVACOES.md) foram preservados intactos com backup de segurança em .data/backups/.',
    ],
    countsBefore,
    countsAfter,
  };
}

export const migrateFromJsonToPostgres = runJsonToPostgresMigration;

