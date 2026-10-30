import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import nodeCrypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { getStoredThumbnail, saveStoredThumbnail, listStoredFileIds } from './src/db/mediaThumbnails.ts';
import { initialMockDriveItems, initialTenants } from './src/data/mockArts.ts';
import {
  groupAndSortDriveItems,
  generateRejectedFilename,
  normalizeCategoria,
  convertSaoPauloToUtcIso,
  formatDateTimeBR,
} from './src/utils/postHelpers.ts';
import {
  AdminAlertNotification,
  DriveImageItem,
  PostGroup,
  TenantAccount,
  UserProfile,
} from './src/types/index.ts';
import {
  encryptInstagramToken,
  resolveAccountAccessToken,
  isAccountTokenExpired,
  hasRequiredInstagramScopes,
  normalizeAndEncryptTenantToken,
  sanitizeTenantForClient,
  exchangeShortForLongLivedInstagramToken,
  refreshAccountLongLivedToken,
  executeInstagramGraphPublish,
  REQUIRED_IG_SCOPES,
  setInstagramFetchOverride,
  getInstagramFetch,
  IG_USER_MSG_PERSONAL_ACCOUNT,
  IG_USER_MSG_PERMISSION_RESTRICTED,
  IG_USER_MSG_TEMPORARY_ERROR,
} from './src/services/instagramCore.ts';
import {
  DatabaseUnavailableError,
  checkDatabaseConnection,
  dbQuery,
  isDatabaseUnavailableSimulated,
  isRailwayDatabaseUrlConfigured,
} from './src/db/pool.ts';
import { runDatabaseMigrations, getAppliedMigrations } from './src/db/migrations.ts';
import {
  ensureDefaultAdminUser,
  authenticateAdminUser,
  authenticateSocialHubUser,
  registerSocialHubUser,
  upsertCompany,
  listCompanies,
  getCompanyByIdOrFolder,
  listInstagramAccounts,
  getInstagramAccountByIdOrUser,
  upsertInstagramAccount,
  deleteInstagramAccountFromDb,
  listPostGroupsFromDb,
  getPostGroupByIdFromDb,
  upsertPostGroupToDb,
  deletePostGroupFromDb,
  saveCaptionForPostTx,
  recordApprovalInDb,
  recordRejectionInDb,
  recordPublicationAttemptAndOutcomeInDb,
  addAdminAlertInDb,
  listUnresolvedAdminAlertsFromDb,
  resolveAdminAlertInDb,
  resolveAdminAlertsForTenantInDb,
  recordSchedulerRunInDb,
  listRecentSchedulerRunsFromDb,
  getLastTokenRefreshRunFromDb,
  getDatabaseTableCounts,
  getTokenEncryptionKey,
  logOperationalActionInDb,
  hideMediaForUserInDb,
  getHiddenPostIdsForUserFromDb,
  unhideMediaForAllUsersInDb,
  getAllHiddenPostsMapFromDb,
  getTestRecordsPreviewFromDb,
  resetTestRecordsInDb,
  listClientObservationsFromDb,
  createClientObservationInDb,
  updateClientObservationInDb,
  updateClientObservationSyncStatusInDb,
  generateClientObservationsMarkdown,
  getConsolidatedCreativeContextForCompany,
  getNextObservationVersionForCompany,
  resolveCompanyRecordForSession,
} from './src/db/repository.ts';
import { migrateFromJsonToPostgres } from './src/db/migrateFromJson.ts';
import {
  generateCaptionWithGemini,
  getGeminiConfigStatus,
} from './src/services/geminiCaptionService.ts';
import { TokenService } from './src/services/TokenService.ts';
import { PublicationService } from './src/services/PublicationService.ts';
import { ScheduleService } from './src/services/ScheduleService.ts';
import {
  SchedulerWorker,
  resolveSchedulerMode,
  resolveWorkerIntervalMs,
  resolveTokenRefreshIntervalMs,
} from './src/services/SchedulerWorker.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const REDIRECT_URI = 'https://ato-social-hub.ai.studio/api/auth/instagram/callback';
let lastAuthorizedRedirectUri: string = REDIRECT_URI;

function getEffectiveInstagramRedirectUri(): string {
  const fromEnv = String(process.env.INSTAGRAM_REDIRECT_URI || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\/+$/, '');
  if (fromEnv && fromEnv.startsWith('http')) {
    return fromEnv;
  }
  return REDIRECT_URI;
}

function sanitizeEnvValue(val?: string): string {
  return String(val || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
}

const KNOWN_PLACEHOLDER_PATTERNS = [
  'sua_chave_secreta',
  'cole_aqui',
  'your_app_secret',
  'my_instagram_app_secret',
  'my_meta_long_lived',
  'placeholder',
  'changeme',
  'replace_me',
];

function isPlaceholderOrEmpty(val?: string): boolean {
  const cleaned = sanitizeEnvValue(val);
  if (!cleaned) return true;
  const lower = cleaned.toLowerCase();
  return KNOWN_PLACEHOLDER_PATTERNS.some((pattern) => lower.includes(pattern));
}

function getEnvSecretStatus() {
  let fileSecret = '';
  let fileAppId = '';
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const parsedEnv = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
      fileSecret = sanitizeEnvValue(parsedEnv.INSTAGRAM_APP_SECRET);
      fileAppId = sanitizeEnvValue(parsedEnv.INSTAGRAM_APP_ID);
    }
  } catch {
    // ignore read error
  }

  const runtimeSecret = sanitizeEnvValue(process.env.INSTAGRAM_APP_SECRET);
  const effectiveSecret = fileSecret || runtimeSecret;
  const effectiveAppId = fileAppId || sanitizeEnvValue(process.env.INSTAGRAM_APP_ID);

  return {
    appIdPresent: !isPlaceholderOrEmpty(effectiveAppId),
    secretPresent: Boolean(effectiveSecret),
    secretIsPlaceholder: isPlaceholderOrEmpty(effectiveSecret),
    secretValid: !isPlaceholderOrEmpty(effectiveSecret) && effectiveSecret.length >= 16,
    secretSource: fileSecret
      ? '.env'
      : runtimeSecret
        ? 'process.env'
        : 'ausente',
  };
}

/**
 * Helper que lê dinamicamente as variáveis de ambiente (.env e process.env),
 * sem jamais usar placeholders fictícios como fallback para INSTAGRAM_APP_SECRET.
 */
function getEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const parsedEnv = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
      for (const [key, val] of Object.entries(parsedEnv)) {
        const cleaned = sanitizeEnvValue(val).replace(/\/+$/, '');
        if (
          cleaned !== '' &&
          !isPlaceholderOrEmpty(cleaned) &&
          !cleaned.includes('postgres:password@localhost:5432') &&
          !process.env[key]
        ) {
          process.env[key] = cleaned;
        }
      }
    }
  } catch {
    dotenv.config();
  }

  delete process.env.INSTAGRAM_USER_NAME;
  delete process.env.INSTAGRAM_USER_ID;

  const rawAppId = sanitizeEnvValue(process.env.INSTAGRAM_APP_ID) || '1638364467693255';
  const rawAppSecret = sanitizeEnvValue(process.env.INSTAGRAM_APP_SECRET);

  const cleanAppId = !isPlaceholderOrEmpty(rawAppId) ? rawAppId : '1638364467693255';
  const cleanAppSecret = !isPlaceholderOrEmpty(rawAppSecret) ? rawAppSecret : '';

  process.env.INSTAGRAM_APP_ID = cleanAppId;
  process.env.INSTAGRAM_APP_SECRET = cleanAppSecret;

  return {
    JWT_SECRET: sanitizeEnvValue(process.env.JWT_SECRET) || 'ato_super_secret_key_2026_998877',
    WEBHOOK_SECRET_TOKEN:
      sanitizeEnvValue(process.env.WEBHOOK_SECRET_TOKEN) || 'ato_webhook_sync_token_884422',
    GOOGLE_APPS_SCRIPT_URL:
      sanitizeEnvValue(process.env.GOOGLE_APPS_SCRIPT_URL) ||
      sanitizeEnvValue(process.env.GAS_WEBHOOK_URL) ||
      'https://script.google.com/macros/s/AKfycbwq9EAn9TbPzq87O6yVT61KY2qd-w0wpX09hMqviu-4Gu3Lskzvb73RPvTr98FK0Z1rFQ/exec',
    APP_URL: sanitizeEnvValue(process.env.APP_URL) || '',
    META_ACCESS_TOKEN: sanitizeEnvValue(process.env.META_ACCESS_TOKEN) || '',
    INSTAGRAM_ACCOUNT_ID: sanitizeEnvValue(process.env.INSTAGRAM_ACCOUNT_ID) || '',
    INSTAGRAM_APP_ID: cleanAppId,
    INSTAGRAM_APP_SECRET: cleanAppSecret,
    META_VERIFY_TOKEN:
      sanitizeEnvValue(process.env.META_VERIFY_TOKEN) || 'ato_meta_webhook_2026',
  };
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ----------------------------------------------------
// BANCO DE DADOS PERSISTENTE ATÔMICO (.data/database.json + Cloud Sync)
// ----------------------------------------------------
const DATA_DIR = path.join(__dirname, '.data');
const DB_FILE_PATH = path.join(
  DATA_DIR,
  process.env.ATO_TEST_MODE ? `database.test.${process.pid}.json` : 'database.json'
);
const LAST_WEBHOOK_FILE_PATH = path.join(DATA_DIR, 'last_webhook_payload.json');
const INSTANCE_ID = `inst_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

interface SchedulerRunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  processedCount: number;
  publishedCount: number;
  failedCount: number;
  skippedCount: number;
}

interface PersistedDatabase {
  tenants: TenantAccount[];
  rawDriveItems: DriveImageItem[];
  driveFolders: Array<{ id: string; nome: string; url?: string }>;
  postGroupsMeta?: Record<string, Partial<PostGroup>>;
  adminAlerts?: AdminAlertNotification[];
  schedulerRuns?: SchedulerRunSummary[];
}

let tenants: TenantAccount[] = [...initialTenants];
let rawDriveItems: DriveImageItem[] = [...initialMockDriveItems];
let postGroups: PostGroup[] = groupAndSortDriveItems(rawDriveItems);
let postGroupsMeta: Record<string, Partial<PostGroup>> = {};
let adminAlerts: AdminAlertNotification[] = [];
let schedulerRuns: SchedulerRunSummary[] = [];
const driveFoldersMap = new Map<string, { id: string; nome: string; url?: string }>();

function addAdminAlert(alert: Omit<AdminAlertNotification, 'id' | 'createdAt' | 'resolved'>) {
  const existingUnresolved = adminAlerts.find(
    (a) => !a.resolved && a.tenantId === alert.tenantId && a.type === alert.type
  );
  if (existingUnresolved) {
    existingUnresolved.message = alert.message;
    existingUnresolved.createdAt = new Date().toISOString();
    return;
  }
  adminAlerts.unshift({
    id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ...alert,
    createdAt: new Date().toISOString(),
    resolved: false,
  });
  if (adminAlerts.length > 100) {
    adminAlerts = adminAlerts.slice(0, 100);
  }
}

function resolveAdminAlertsForTenant(tenantId: string) {
  const nowIso = new Date().toISOString();
  for (const alert of adminAlerts) {
    if (alert.tenantId === tenantId && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = nowIso;
    }
  }
}

function isLegacyGhostUsername(username?: string | null, nome?: string | null): boolean {
  const cleanUser = String(username || '').replace(/^@/, '').trim().toLowerCase();
  const cleanNome = String(nome || '').trim().toLowerCase();
  return cleanUser === 'caiorocha' || cleanNome === 'caio rocha';
}

function applyPostGroupsMeta(groups: PostGroup[]): PostGroup[] {
  return groups.map((g) => {
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
}

function syncPostGroupStateToItemsAndMeta(post: PostGroup) {
  postGroupsMeta[post.id] = {
    status: post.status,
    caption: post.caption,
    scheduledAt: post.scheduledAt,
    scheduledTimezone: post.scheduledTimezone,
    scheduledAccountId: post.scheduledAccountId,
    publishedAt: post.publishedAt,
    instagramMediaId: post.instagramMediaId,
    instagramContainerId: post.instagramContainerId,
    childContainerIds: post.childContainerIds,
    instagramPermalink: post.instagramPermalink,
    approvedAt: post.approvedAt,
    approvedBy: post.approvedBy,
    isApprovedForSchedule: post.isApprovedForSchedule,
    publishAttempts: post.publishAttempts,
    lastAttemptAt: post.lastAttemptAt,
    nextRetryAt: post.nextRetryAt,
    failureReason: post.failureReason,
    publishLock: post.publishLock,
    publishHistory: post.publishHistory,
    rejectionFeedback: post.rejectionFeedback,
  };

  const fileIds = new Set(post.items.map((i) => i.driveFileId));
  rawDriveItems = rawDriveItems.map((item) => {
    if (fileIds.has(item.driveFileId)) {
      return {
        ...item,
        status: post.status,
        caption: post.caption,
        scheduledAt: post.scheduledAt,
        scheduledTimezone: post.scheduledTimezone,
        scheduledAccountId: post.scheduledAccountId,
        publishedAt: post.publishedAt,
        instagramMediaId: post.instagramMediaId,
        instagramContainerId: post.instagramContainerId,
        childContainerIds: post.childContainerIds,
        instagramPermalink: post.instagramPermalink,
        approvedAt: post.approvedAt,
        approvedBy: post.approvedBy,
        isApprovedForSchedule: post.isApprovedForSchedule,
        publishAttempts: post.publishAttempts,
        lastAttemptAt: post.lastAttemptAt,
        nextRetryAt: post.nextRetryAt,
        failureReason: post.failureReason,
        publishLock: post.publishLock,
        publishHistory: post.publishHistory,
        rejectionFeedback: post.rejectionFeedback || item.rejectionFeedback,
      };
    }
    return item;
  });
}

// ====================================================
// CAMADA DE PERSISTÊNCIA OFICIAL POSTGRESQL (RAILWAY)
// Sem fallback operacional para .data/database.json
// ====================================================
let postgresBootstrapPromise: Promise<void> | null = null;
let pendingPostgresWritePromise: Promise<void> = Promise.resolve();
let lastSyncFromPostgresMs = 0;
const SYNC_STATE_TTL_MS = 4000;
let testStateOverrideActive = false;

export async function syncStateFromPostgres(force: boolean = false): Promise<void> {
  if (isDatabaseUnavailableSimulated()) {
    throw new DatabaseUnavailableError(
      'Serviço temporariamente indisponível: banco PostgreSQL inacessível (falha de conexão).'
    );
  }
  if (testStateOverrideActive) {
    return;
  }

  const now = Date.now();
  if (!force && lastSyncFromPostgresMs > 0 && now - lastSyncFromPostgresMs < SYNC_STATE_TTL_MS) {
    return;
  }
  lastSyncFromPostgresMs = now;

  const [companiesFromDb, accountsFromDb, postsFromDb, alertsFromDb, runsFromDb] =
    await Promise.all([
      listCompanies(),
      listInstagramAccounts(),
      listPostGroupsFromDb(),
      listUnresolvedAdminAlertsFromDb(),
      listRecentSchedulerRunsFromDb(15),
    ]);

  driveFoldersMap.clear();
  for (const comp of companiesFromDb) {
    if (comp.name && comp.name.toLowerCase() !== 'ato social midia') {
      driveFoldersMap.set(comp.name.toLowerCase(), {
        id: comp.driveFolderId || comp.id,
        nome: comp.driveFolderName || comp.name,
        url: comp.driveFolderUrl || undefined,
      });
    }
  }

  const { JWT_SECRET } = getEnv();
  const encKey = getTokenEncryptionKey();
  tenants = accountsFromDb
    .filter((t) => Boolean(t && t.username && !isLegacyGhostUsername(t.username, t.nome)))
    .map((t) => normalizeAndEncryptTenantToken(t, encKey || JWT_SECRET));

  postGroups = postsFromDb;
  rawDriveItems = [];
  postGroupsMeta = {};

  for (const pg of postGroups) {
    syncPostGroupStateToItemsAndMeta(pg);
    for (const item of pg.items) {
      rawDriveItems.push({
        ...item,
        status: pg.status,
        caption: pg.caption,
        activeCaptionId: pg.activeCaptionId,
        captionApproved: pg.captionApproved,
        captionSource: pg.captionSource,
        scheduledAt: pg.scheduledAt,
        scheduledTimezone: pg.scheduledTimezone,
        scheduledAccountId: pg.scheduledAccountId,
        publishedAt: pg.publishedAt,
        instagramMediaId: pg.instagramMediaId,
        instagramContainerId: pg.instagramContainerId,
        childContainerIds: pg.childContainerIds,
        instagramPermalink: pg.instagramPermalink,
        approvedAt: pg.approvedAt,
        approvedBy: pg.approvedBy,
        isApprovedForSchedule: pg.isApprovedForSchedule,
        publishAttempts: pg.publishAttempts,
        lastAttemptAt: pg.lastAttemptAt,
        nextRetryAt: pg.nextRetryAt,
        failureReason: pg.failureReason,
        publishLock: pg.publishLock,
        publishHistory: pg.publishHistory,
        rejectionFeedback: pg.rejectionFeedback || item.rejectionFeedback,
      });
    }
  }

  adminAlerts = alertsFromDb;
  schedulerRuns = runsFromDb as SchedulerRunSummary[];
}

export async function persistStateToPostgres(): Promise<void> {
  if (isDatabaseUnavailableSimulated()) {
    throw new DatabaseUnavailableError(
      'Serviço temporariamente indisponível: banco PostgreSQL inacessível para gravação.'
    );
  }
  if (testStateOverrideActive) {
    return;
  }

  await runDatabaseMigrations();

  const { JWT_SECRET } = getEnv();
  const encKey = getTokenEncryptionKey();

  tenants = tenants
    .filter((t) => Boolean(t && t.username && !isLegacyGhostUsername(t.username, t.nome)))
    .map((t) => normalizeAndEncryptTenantToken(t, encKey || JWT_SECRET));

  for (const pg of postGroups) {
    syncPostGroupStateToItemsAndMeta(pg);
  }

  for (const folder of driveFoldersMap.values()) {
    if (folder && folder.nome && folder.nome.toLowerCase() !== 'ato social midia') {
      await upsertCompany({
        id: folder.id,
        name: folder.nome,
        driveFolderId: folder.id,
        driveFolderName: folder.nome,
        driveFolderUrl: folder.url || null,
      });
    }
  }

  for (const tenant of tenants) {
    await upsertInstagramAccount(tenant);
  }

  for (const pg of postGroups) {
    await upsertPostGroupToDb(pg);
  }

  for (const alert of adminAlerts) {
    if (!alert.resolved) {
      await addAdminAlertInDb({
        type: alert.type,
        tenantId: alert.tenantId,
        username: alert.username,
        postId: alert.postId,
        message: alert.message,
      });
    } else {
      await resolveAdminAlertInDb(alert.id);
    }
  }
}

export async function ensurePostgresBootstrapped(): Promise<void> {
  if (isDatabaseUnavailableSimulated()) {
    throw new DatabaseUnavailableError(
      'Serviço temporariamente indisponível: banco PostgreSQL inacessível.'
    );
  }

  if (!postgresBootstrapPromise) {
    postgresBootstrapPromise = (async () => {
      await runDatabaseMigrations();
      await ensureDefaultAdminUser();

      const counts = await getDatabaseTableCounts();
      const totalExistingPosts = counts.posts || 0;
      const totalExistingCompanies = counts.companies || 0;

      // Se o banco PostgreSQL estiver vazio e existir .data/database.json legado, executa a migração auditável automaticamente
      const legacyJsonPath = path.join(DATA_DIR, 'database.json');
      if (
        !process.env.ATO_TEST_MODE &&
        totalExistingPosts === 0 &&
        totalExistingCompanies === 0 &&
        fs.existsSync(legacyJsonPath)
      ) {
        console.log(
          '[PostgreSQL Bootstrap] Banco PostgreSQL vazio detectado. Executando migração automática de .data/database.json...'
        );
        await migrateFromJsonToPostgres({
          jsonPath: legacyJsonPath,
          dryRun: false,
          skipBackup: false,
        });
      }

      await syncStateFromPostgres();
    })().catch((err) => {
      postgresBootstrapPromise = null;
      throw err;
    });
  }

  return postgresBootstrapPromise;
}

function loadDatabaseFromDisk() {
  // Mantido apenas como no-op síncrono para compatibilidade interna:
  // toda leitura operacional vem do PostgreSQL via middleware / syncStateFromPostgres().
}

function saveDatabaseToDisk() {
  // Enfileira persistência imediata no PostgreSQL (nunca grava em .data/database.json).
  pendingPostgresWritePromise = pendingPostgresWritePromise
    .catch(() => {})
    .then(() => persistStateToPostgres());
}

export async function flushPendingPostgresWrites(): Promise<void> {
  await pendingPostgresWritePromise;
}

// Middleware global da API: garante conexão ativa com o PostgreSQL e impede fallback silencioso para JSON
app.use('/api', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensurePostgresBootstrapped();
    await flushPendingPostgresWrites();
    if (!req.path.startsWith('/auth/login') && !req.path.startsWith('/instagram/media-proxy')) {
      await syncStateFromPostgres(false);
    }
  } catch (err: any) {
    const status = err instanceof DatabaseUnavailableError ? 503 : 503;
    return res.status(status).json({
      success: false,
      code: 'DATABASE_UNAVAILABLE',
      error:
        err?.message ||
        'Banco de dados PostgreSQL indisponível no momento. Nenhuma operação pôde ser processada.',
    });
  }

  const originalJson = res.json.bind(res);
  res.json = ((body: any) => {
    pendingPostgresWritePromise
      .then(() => {
        originalJson(body);
      })
      .catch((err: any) => {
        if (!res.headersSent) {
          res.status(503);
          originalJson({
            success: false,
            code: 'DATABASE_UNAVAILABLE',
            error:
              err?.message ||
              'Falha ao persistir transação no PostgreSQL. Nenhuma alteração foi salva localmente.',
          });
        }
      });
    return res;
  }) as any;

  return next();
});


/**
 * Converte links de visualização HTML do Google Drive (/file/d/<ID>/view)
 * em links de imagem renderizáveis diretamente na tag <img>, mantendo fallback para thumbnailUrl.
 */
function resolveDriveImageUrl(
  viewUrl?: string,
  thumbnailUrl?: string,
  downloadUrl?: string,
  driveFileId?: string
): string {
  const vUrl = String(viewUrl || '').trim();
  const tUrl = String(thumbnailUrl || '').trim();
  const dUrl = String(downloadUrl || '').trim();

  // Se for data URI ou URL externa normal (que não seja a página HTML /file/d/.../view do Drive)
  if (vUrl && !vUrl.includes('drive.google.com/file/d/')) {
    return vUrl;
  }

  // Se o Apps Script enviou thumbnailUrl válida, prioriza para exibição em <img>
  if (tUrl) {
    return tUrl;
  }

  // Se temos o driveFileId, constrói o endpoint de thumbnail de alta resolução do Drive
  if (driveFileId && !driveFileId.startsWith('drive_') && !driveFileId.startsWith('upload_')) {
    return `https://drive.google.com/thumbnail?id=${encodeURIComponent(driveFileId)}&sz=w1200`;
  }

  return vUrl || dUrl || '';
}

/**
 * Processa a estrutura de lotes e arquivos enviada pelo Google Apps Script:
 * {
 *   "evento": "NOVAS_ARTES_SOCIAL_MEDIA",
 *   "timestamp": "...",
 *   "lotes": [
 *     {
 *       "pastaClienteId": "id_da_pasta",
 *       "pastaClienteNome": "Ato",
 *       "loteNome": "Ato - 1 24-10 - 01 Post unico",
 *       "categoria": "01 Post unico",
 *       "pastaUrl": "link_da_pasta",
 *       "arquivos": [
 *         {
 *           "driveFileId": "id_do_arquivo",
 *           "nome": "01_Post.png",
 *           "mimeType": "image/png",
 *           "viewUrl": "link_da_imagem",
 *           "thumbnailUrl": "link_thumb",
 *           "downloadUrl": "link_download"
 *         }
 *       ]
 *     }
 *   ]
 * }
 */
function processIncomingPayload(payload: any): {
  processedLotesCount: number;
  insertedOrUpdatedFilesCount: number;
  foldersFound: string[];
  unmatchedFolders: string[];
} {
  let processedLotesCount = 0;
  let insertedOrUpdatedFilesCount = 0;
  const foldersFoundSet = new Set<string>();
  const unmatchedFoldersSet = new Set<string>();

  if (!payload || typeof payload !== 'object') {
    return { processedLotesCount, insertedOrUpdatedFilesCount, foldersFound: [], unmatchedFolders: [] };
  }

  // 1. Ingestão de lista de pastas caso venha de LISTAR_PASTAS_CLIENTES ({ pastas: [{ id, nome, url }] })
  const rawFolders = payload.pastas || payload.folders || payload.empresas || payload.clientes || payload.data;
  if (Array.isArray(rawFolders)) {
    for (const item of rawFolders) {
      if (typeof item === 'string' && item.trim()) {
        const cleanName = item.trim();
        const existing = driveFoldersMap.get(cleanName.toLowerCase());
        driveFoldersMap.set(cleanName.toLowerCase(), {
          id: existing?.id || cleanName,
          nome: cleanName,
          url: existing?.url,
        });
        foldersFoundSet.add(cleanName);
      } else if (item && typeof item === 'object') {
        const nome = String(item.nome || item.name || item.pastaClienteNome || item.folderName || '').trim();
        const id = String(item.id || item.pastaClienteId || item.folderId || nome).trim();
        const url = item.url || item.pastaUrl || undefined;
        if (nome) {
          driveFoldersMap.set(nome.toLowerCase(), { id: id || nome, nome, url });
          foldersFoundSet.add(nome);
        }
      }
    }
  }

  // 2. Identifica o array de lotes
  let lotesArray: any[] = [];
  if (Array.isArray(payload.lotes)) {
    lotesArray = payload.lotes;
  } else if (Array.isArray(payload.items)) {
    lotesArray = payload.items;
  } else if (Array.isArray(payload)) {
    lotesArray = payload;
  } else if (payload.lotes && typeof payload.lotes === 'object') {
    lotesArray = [payload.lotes];
  } else if (payload.driveFileId || payload.nome || Array.isArray(payload.arquivos)) {
    lotesArray = [payload];
  }

  // 3. Itera sobre req.body.lotes e, dentro de cada lote, sobre o array arquivos
  for (let loteIdx = 0; loteIdx < lotesArray.length; loteIdx++) {
    const lote = lotesArray[loteIdx];
    if (!lote || typeof lote !== 'object') continue;

    processedLotesCount++;

    const pastaClienteId = String(
      lote.pastaClienteId || payload.pastaClienteId || lote.folderId || ''
    ).trim();

    const rawPastaNome = String(
      lote.pastaClienteNome ||
        lote.driveFolderName ||
        lote.pastaOrigem ||
        payload.pastaClienteNome ||
        payload.driveFolderName ||
        payload.pastaOrigem ||
        ''
    ).trim();

    const firstKnownFolder = Array.from(driveFoldersMap.values()).find(
      (f) => f.nome && f.nome.toLowerCase() !== 'ato social midia'
    );

    const pastaClienteNome =
      rawPastaNome && rawPastaNome.toLowerCase() !== 'ato social midia'
        ? rawPastaNome
        : firstKnownFolder?.nome || 'Ato';

    const loteNome = String(lote.loteNome || lote.nome || `Lote_${Date.now()}_${loteIdx + 1}`).trim();
    const rawCategoria = String(lote.categoria || 'Post Único');
    const pastaUrl = String(lote.pastaUrl || '');

    // Registra a pasta da empresa no mapa de pastas conhecidas do Drive (nunca a pasta raiz ATO Social Midia)
    if (pastaClienteNome && pastaClienteNome.toLowerCase() !== 'ato social midia') {
      const existingFolder = driveFoldersMap.get(pastaClienteNome.toLowerCase());
      driveFoldersMap.set(pastaClienteNome.toLowerCase(), {
        id: pastaClienteId || existingFolder?.id || pastaClienteNome,
        nome: pastaClienteNome,
        url: pastaUrl || existingFolder?.url,
      });
      foldersFoundSet.add(pastaClienteNome);
    }

    // Conecta pastaClienteId ou pastaClienteNome com a conta da empresa (tenant) correspondente no banco
    const matchingTenant = tenants.find(
      (t) =>
        (pastaClienteId && t.driveFolderId && t.driveFolderId === pastaClienteId) ||
        (pastaClienteNome &&
          t.driveFolderName &&
          t.driveFolderName.toLowerCase() === pastaClienteNome.toLowerCase()) ||
        (pastaClienteNome && t.nome && t.nome.toLowerCase() === pastaClienteNome.toLowerCase()) ||
        (pastaClienteNome && t.username && t.username.toLowerCase() === pastaClienteNome.toLowerCase())
    );

    if (matchingTenant) {
      if (pastaClienteId && matchingTenant.driveFolderId !== pastaClienteId) {
        matchingTenant.driveFolderId = pastaClienteId;
      }
      if (pastaClienteNome && !matchingTenant.driveFolderName) {
        matchingTenant.driveFolderName = pastaClienteNome;
      }
      matchingTenant.lastSyncAt = new Date().toISOString();
      console.log(
        `[Webhook Drive Sync] Lote "${loteNome}" vinculado à empresa "${matchingTenant.nome}" (@${matchingTenant.username}, pastaClienteId="${pastaClienteId}", pastaClienteNome="${pastaClienteNome}").`
      );
    } else {
      unmatchedFoldersSet.add(pastaClienteNome);
      console.warn(
        `[Webhook Drive Sync] AVISO: Empresa não encontrada no banco para pastaClienteNome="${pastaClienteNome}" (pastaClienteId="${pastaClienteId}"). O lote "${loteNome}" NÃO será descartado e será salvo como PENDENTE vinculado à pasta "${pastaClienteNome}".`
      );
    }

    // Extrai o array arquivos de dentro do lote (ou suporta item plano caso enviado diretamente)
    const arquivosArray: any[] = Array.isArray(lote.arquivos)
      ? lote.arquivos
      : Array.isArray(lote.files)
      ? lote.files
      : lote.driveFileId || lote.nome
      ? [lote]
      : [];

    if (arquivosArray.length === 0) {
      console.warn(`[Webhook Drive Sync] AVISO: O lote "${loteNome}" não possui itens no array "arquivos".`);
      continue;
    }

    const categoriaNormalizada = normalizeCategoria(rawCategoria, arquivosArray.length);

    for (let arqIdx = 0; arqIdx < arquivosArray.length; arqIdx++) {
      const arquivo = arquivosArray[arqIdx];
      if (!arquivo || typeof arquivo !== 'object') continue;

      const driveFileId = String(
        arquivo.driveFileId || arquivo.id || `drive_${Date.now()}_${loteIdx}_${arqIdx}`
      ).trim();
      const nomeArquivo = String(arquivo.nome || arquivo.name || `0${arqIdx + 1}_Post.png`).trim();
      const itemCategoria = arquivo.categoria
        ? normalizeCategoria(String(arquivo.categoria), arquivosArray.length)
        : categoriaNormalizada;

      const resolvedViewUrl = resolveDriveImageUrl(
        arquivo.viewUrl,
        arquivo.thumbnailUrl,
        arquivo.downloadUrl,
        driveFileId
      );
      const resolvedThumbnailUrl = String(arquivo.thumbnailUrl || resolvedViewUrl || '').trim();

      const newItem: DriveImageItem = {
        driveFileId,
        nome: nomeArquivo,
        categoria: itemCategoria,
        loteNome,
        viewUrl: resolvedViewUrl,
        thumbnailUrl: resolvedThumbnailUrl,
        downloadUrl: arquivo.downloadUrl ? String(arquivo.downloadUrl) : undefined,
        mimeType: arquivo.mimeType ? String(arquivo.mimeType) : 'image/png',
        dataCriacao: String(arquivo.dataCriacao || lote.timestamp || payload.timestamp || new Date().toISOString()),
        status: arquivo.status || 'PENDENTE',
        ordem: arquivo.ordem !== undefined ? Number(arquivo.ordem) : arqIdx + 1,
        tenantId: matchingTenant ? matchingTenant.id : arquivo.tenantId,
        driveFolderName: pastaClienteNome,
        pastaClienteNome,
        pastaClienteId: pastaClienteId || undefined,
        pastaUrl: pastaUrl || undefined,
        origem: 'DRIVE_SYNC',
      };

      const existingIdx = rawDriveItems.findIndex((existing) => existing.driveFileId === driveFileId);
      if (existingIdx >= 0) {
        const prev = rawDriveItems[existingIdx];
        rawDriveItems[existingIdx] = {
          ...prev,
          ...newItem,
          status: prev.status || 'PENDENTE',
          tenantId: matchingTenant?.id || prev.tenantId || newItem.tenantId,
          rejectionFeedback: prev.rejectionFeedback,
          caption: prev.caption,
          scheduledAt: prev.scheduledAt,
          scheduledTimezone: prev.scheduledTimezone,
          scheduledAccountId: prev.scheduledAccountId,
          publishedAt: prev.publishedAt,
          instagramMediaId: prev.instagramMediaId,
          instagramContainerId: prev.instagramContainerId,
          childContainerIds: prev.childContainerIds,
          instagramPermalink: prev.instagramPermalink,
          approvedAt: prev.approvedAt,
          approvedBy: prev.approvedBy,
          isApprovedForSchedule: prev.isApprovedForSchedule,
          publishAttempts: prev.publishAttempts,
          lastAttemptAt: prev.lastAttemptAt,
          nextRetryAt: prev.nextRetryAt,
          failureReason: prev.failureReason,
          publishLock: prev.publishLock,
          publishHistory: prev.publishHistory,
        };
      } else {
        rawDriveItems.push(newItem);
      }

      insertedOrUpdatedFilesCount++;
    }
  }

  postGroups = applyPostGroupsMeta(groupAndSortDriveItems(rawDriveItems));
  saveDatabaseToDisk();

  return {
    processedLotesCount,
    insertedOrUpdatedFilesCount,
    foldersFound: Array.from(foldersFoundSet),
    unmatchedFolders: Array.from(unmatchedFoldersSet),
  };
}

// Extend Express Request with authenticated user
interface AuthenticatedRequest extends Request {
  user?: UserProfile;
}

interface DriveEmbeddedEntry {
  id: string;
  href: string;
  title: string;
  isFolder: boolean;
}

async function listDriveEmbeddedEntries(folderId: string): Promise<DriveEmbeddedEntry[]> {
  try {
    const resp = await fetch(
      `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`,
      { redirect: 'follow' }
    );
    if (!resp.ok) return [];
    const html = await resp.text();
    const entries: DriveEmbeddedEntry[] = [];
    const regex =
      /<div class="flip-entry" id="entry-([^"]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      entries.push({
        id: match[1].trim(),
        href: match[2].trim(),
        title: match[3].trim(),
        isFolder: match[2].includes('/folders/'),
      });
    }
    return entries;
  } catch {
    return [];
  }
}

async function crawlDriveClientFolderLotes(pasta: {
  id: string;
  nome: string;
  url?: string;
}): Promise<any[]> {
  const lotes: any[] = [];
  if (!pasta.id || pasta.id.startsWith('folder_')) return lotes;

  const topEntries = await listDriveEmbeddedEntries(pasta.id);
  for (const sub of topEntries) {
    const subLower = sub.title.toLowerCase();
    if (subLower === 'reprovados' || subLower === 'aprovados' || subLower === 'publicados') {
      continue;
    }

    if (sub.isFolder) {
      const children = await listDriveEmbeddedEntries(sub.id);
      const childFolders = children.filter((c) => c.isFolder);
      const directFiles = children.filter((c) => !c.isFolder);

      // Se houver subpastas de categoria (ex: "01 Post unico", "01 Carrossel", "03 Story")
      for (const catFolder of childFolders) {
        const catLower = catFolder.title.toLowerCase();
        if (catLower === 'reprovados') continue;
        const files = (await listDriveEmbeddedEntries(catFolder.id)).filter((f) => !f.isFolder);
        if (files.length > 0) {
          lotes.push({
            pastaClienteId: pasta.id,
            pastaClienteNome: pasta.nome,
            loteNome: `${pasta.nome} - ${sub.title} - ${catFolder.title}`,
            categoria: catFolder.title,
            pastaUrl: catFolder.href || `https://drive.google.com/drive/folders/${catFolder.id}`,
            arquivos: files.map((f) => ({
              driveFileId: f.id,
              nome: f.title,
              mimeType: f.title.toLowerCase().endsWith('.jpg') || f.title.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png',
              viewUrl: `https://drive.google.com/thumbnail?id=${encodeURIComponent(f.id)}&sz=w1200`,
              thumbnailUrl: `https://drive.google.com/thumbnail?id=${encodeURIComponent(f.id)}&sz=w1200`,
              downloadUrl: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(f.id)}`,
            })),
          });
        }
      }

      // Se houver arquivos diretamente dentro da subpasta (ex: pasta de lote ou Uploads)
      if (directFiles.length > 0) {
        lotes.push({
          pastaClienteId: pasta.id,
          pastaClienteNome: pasta.nome,
          loteNome: `${pasta.nome} - ${sub.title}`,
          categoria: directFiles.length > 1 ? '02 Carrossel' : '01 Post unico',
          pastaUrl: sub.href || `https://drive.google.com/drive/folders/${sub.id}`,
          arquivos: directFiles.map((f) => ({
            driveFileId: f.id,
            nome: f.title,
            mimeType: f.title.toLowerCase().endsWith('.jpg') || f.title.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png',
            viewUrl: `https://drive.google.com/thumbnail?id=${encodeURIComponent(f.id)}&sz=w1200`,
            thumbnailUrl: `https://drive.google.com/thumbnail?id=${encodeURIComponent(f.id)}&sz=w1200`,
            downloadUrl: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(f.id)}`,
          })),
        });
      }
    }
  }

  return lotes;
}

type AppsScriptSyncResult = {
  ok: boolean;
  status: number;
  data: any;
  rawResponse?: string;
  error?: string;
};

// Cache curto do SINCRONIZAR_TUDO: evita varrer o Drive inteiro a cada abertura de tela.
const APPS_SCRIPT_SYNC_TTL_MS = 120_000;
let appsScriptSyncCache: { at: number; result: AppsScriptSyncResult } | null = null;
let appsScriptSyncInflight: Promise<AppsScriptSyncResult> | null = null;

/**
 * Consulta o Google Apps Script com cache de curta duração e deduplicação de chamadas simultâneas.
 * Use `force: true` para ignorar o cache (ex.: botão "Sincronizar Drive").
 */
async function syncWithAppsScript(
  acao: 'SINCRONIZAR_TUDO' | 'LISTAR_PASTAS_CLIENTES' = 'SINCRONIZAR_TUDO',
  options: { force?: boolean } = {}
): Promise<AppsScriptSyncResult> {
  if (acao === 'SINCRONIZAR_TUDO' && !options.force) {
    if (appsScriptSyncCache && Date.now() - appsScriptSyncCache.at < APPS_SCRIPT_SYNC_TTL_MS) {
      return appsScriptSyncCache.result;
    }
    if (appsScriptSyncInflight) return appsScriptSyncInflight;
  }

  const job = requestAppsScript(acao);
  if (acao === 'SINCRONIZAR_TUDO') {
    appsScriptSyncInflight = job;
  }
  try {
    const result = await job;
    if (acao === 'SINCRONIZAR_TUDO' && result.ok) {
      appsScriptSyncCache = { at: Date.now(), result };
    }
    return result;
  } finally {
    if (appsScriptSyncInflight === job) appsScriptSyncInflight = null;
  }
}

async function requestAppsScript(
  acao: 'SINCRONIZAR_TUDO' | 'LISTAR_PASTAS_CLIENTES'
): Promise<AppsScriptSyncResult> {
  getEnv();
  const scriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
  const secretToken = process.env.WEBHOOK_SECRET_TOKEN;

  if (!scriptUrl || !scriptUrl.startsWith('http')) {
    return { ok: false, status: 400, data: null, error: 'GOOGLE_APPS_SCRIPT_URL não configurada.' };
  }

  try {
    const response = await fetch(scriptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        token: secretToken,
        acao,
      }),
    });

    let rawResponse = await response.text();
    console.log(`RESPOSTA CRUA DO SCRIPT (${acao}): ${rawResponse.length} bytes`);

    let parsed: any = null;
    try {
      parsed = JSON.parse(rawResponse);
    } catch {
      const isGoogleAuthWall =
        response.status === 401 ||
        response.status === 403 ||
        rawResponse.includes('ServiceLogin') ||
        rawResponse.includes('unable to open the file at this time');

      const errorDetail = isGoogleAuthWall
        ? `O Google Apps Script bloqueou a requisição externa (HTTP ${response.status} - HTML recebido em vez de JSON). Na implantação do Apps Script, altere "Quem pode acessar" para "Qualquer pessoa" (Anyone / Sem conta Google).`
        : `Resposta do Apps Script não é um JSON válido (HTTP ${response.status}): ${rawResponse.substring(0, 200)}`;

      return {
        ok: false,
        status: response.status || 502,
        data: null,
        rawResponse,
        error: errorDetail,
      };
    }

    // Se a implantação do Apps Script ainda não tiver SINCRONIZAR_TUDO publicado, fazemos fallback para LISTAR_PASTAS_CLIENTES
    if (
      acao === 'SINCRONIZAR_TUDO' &&
      parsed &&
      (String(parsed.erro || '').includes('Ação desconhecida') ||
        String(parsed.error || '').includes('Ação desconhecida'))
    ) {
      const fallbackResp = await fetch(scriptUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        redirect: 'follow',
        body: JSON.stringify({
          token: secretToken,
          acao: 'LISTAR_PASTAS_CLIENTES',
        }),
      });
      rawResponse = await fallbackResp.text();
      console.log("RESPOSTA CRUA DO SCRIPT (FALLBACK LISTAR_PASTAS_CLIENTES):", rawResponse);
      try {
        parsed = JSON.parse(rawResponse);
      } catch {
        // Ignora erro de parse
      }
    }

    if (parsed && typeof parsed === 'object') {
      if (parsed.erro || parsed.error || parsed.sucesso === false || parsed.success === false) {
        return {
          ok: false,
          status: response.status,
          data: parsed,
          rawResponse,
          error: String(parsed.erro || parsed.error || parsed.message || 'Erro retornado pelo Apps Script.'),
        };
      }

      // Se pastas foram retornadas mas lotes ainda não veio no payload do Apps Script, varre as pastas do Drive para preencher parsed.lotes
      if (
        (!Array.isArray(parsed.lotes) || parsed.lotes.length === 0) &&
        Array.isArray(parsed.pastas) &&
        parsed.pastas.length > 0
      ) {
        const crawledLotes: any[] = [];
        for (const p of parsed.pastas) {
          if (p && p.id && p.nome && String(p.nome).toLowerCase() !== 'ato social midia') {
            const folderLotes = await crawlDriveClientFolderLotes({
              id: String(p.id),
              nome: String(p.nome),
              url: p.url,
            });
            crawledLotes.push(...folderLotes);
          }
        }
        parsed.lotes = crawledLotes;
      }

      console.log("Lotes recebidos:", parsed.lotes);

      processIncomingPayload(parsed);
      return { ok: true, status: response.status, data: parsed, rawResponse };
    }

    return {
      ok: false,
      status: response.status,
      data: null,
      rawResponse,
      error: `Formato inesperado retornado pelo Google Apps Script (HTTP ${response.status}).`,
    };
  } catch (err: any) {
    console.error("ERRO FETCH APPS SCRIPT:", err);
    return {
      ok: false,
      status: 502,
      data: null,
      error: err.message || 'Falha de conexão com o Google Apps Script',
    };
  }
}

function getKnownFoldersList(): {
  folders: string[];
  folderDetails: Array<{ id: string; nome: string; url?: string }>;
} {
  const folderDetailsMap = new Map<string, { id: string; nome: string; url?: string }>();

  // 1. Add folders from active tenants
  for (const t of tenants) {
    if (t.driveFolderName && t.driveFolderName !== 'ATO Social Midia') {
      const key = t.driveFolderName.toLowerCase();
      if (!folderDetailsMap.has(key)) {
        folderDetailsMap.set(key, {
          id: t.driveFolderId || t.driveFolderName,
          nome: t.driveFolderName,
        });
      }
    }
  }

  // 2. Add folders from active posts
  for (const p of postGroups) {
    const folderName = p.pastaClienteNome || p.driveFolderName;
    if (folderName && folderName !== 'ATO Social Midia') {
      const key = folderName.toLowerCase();
      if (!folderDetailsMap.has(key)) {
        folderDetailsMap.set(key, {
          id: p.pastaClienteId || folderName,
          nome: folderName,
          url: p.pastaUrl,
        });
      }
    }
  }

  // 3. Add from driveFoldersMap ONLY if used by posts or tenants or if it's 'Ato'
  for (const [, val] of driveFoldersMap.entries()) {
    if (val.nome && val.nome !== 'ATO Social Midia') {
      const key = val.nome.toLowerCase();
      const isUsedByPost = postGroups.some(
        (p) => (p.pastaClienteNome || p.driveFolderName || '').toLowerCase() === key
      );
      const isUsedByTenant = tenants.some(
        (t) => (t.driveFolderName || '').toLowerCase() === key
      );
      if (isUsedByPost || isUsedByTenant || key === 'ato' || key === 'ato.vc') {
        if (!folderDetailsMap.has(key)) {
          folderDetailsMap.set(key, val);
        }
      }
    }
  }

  // Fallback: If no custom company exists, always provide 'Ato'
  if (!folderDetailsMap.has('ato') && !folderDetailsMap.has('ato.vc')) {
    folderDetailsMap.set('ato', { id: 'comp_ato', nome: 'Ato' });
  }

  const folderDetails = Array.from(folderDetailsMap.values());
  const folders = folderDetails.map((f) => f.nome);
  return { folders, folderDetails };
}

// ----------------------------------------------------
// MIDDLEWARES DE AUTENTICAÇÃO
// ----------------------------------------------------

// 1. Autenticação para Usuários do Painel (JWT para Admin e Tenant)
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const { JWT_SECRET } = getEnv();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Acesso não autorizado: Token Bearer ausente ou mal formatado.',
    });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as UserProfile;
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({
      error: 'Token JWT inválido ou expirado. Faça login novamente.',
    });
  }
}

// 2. Middleware de Acesso Exclusivo para Administrador
export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({
      error: 'Acesso negado: esta ação requer privilégios de Administrador.',
    });
  }
  next();
}

// 3. Autenticação 100% Pública & Sem Cookie Check para o Webhook do Google Apps Script
export function requireWebhookOrUserAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const { WEBHOOK_SECRET_TOKEN, JWT_SECRET } = getEnv();
  const authHeader = req.headers.authorization;
  const customHeaderToken =
    (req.headers['x-webhook-token'] as string) ||
    (req.query.token as string) ||
    (req.body && typeof req.body.token === 'string' ? req.body.token : '');

  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (customHeaderToken) {
    token = customHeaderToken.trim();
  }

  const isValidSecret =
    token === 'ato_webhook_sync_token_884422' ||
    (WEBHOOK_SECRET_TOKEN && token === WEBHOOK_SECRET_TOKEN);

  if (isValidSecret) {
    req.user = {
      id: 'gas_m2m_service',
      nome: 'Google Apps Script Bot',
      role: 'ADMIN',
    };
    return next();
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as UserProfile;
      req.user = decoded;
      return next();
    } catch {
      // Ignora erro JWT e retorna 401 JSON limpo abaixo
    }
  }

  return res.status(401).json({
    sucesso: false,
    error: 'Acesso não autorizado: O header "Authorization" deve conter "Bearer ato_webhook_sync_token_884422".',
  });
}

// ----------------------------------------------------
// 1. ROTAS DE AUTENTICAÇÃO (ADMIN & INSTAGRAM OAUTH OFICIAL)
// ----------------------------------------------------

// A. Login no ATO Social Hub via E-mail e Senha (suporta ADMIN e clientes TENANT cadastrados)
app.post('/api/auth/login', async (req: Request, res: Response) => {
  loadDatabaseFromDisk();
  const { JWT_SECRET } = getEnv();
  const encKey = getTokenEncryptionKey() || JWT_SECRET;
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  const authResult = await authenticateSocialHubUser(String(email), String(password));

  if (!authResult) {
    return res.status(401).json({
      error: 'Credenciais inválidas. Verifique o e-mail e a senha informados.',
    });
  }

  let finalUser = authResult.user;
  let safeTenant: TenantAccount | undefined = undefined;

  if (finalUser.role === 'TENANT') {
    const memTenant = tenants.find(
      (t) =>
        (finalUser.tenantId && t.id === finalUser.tenantId) ||
        (authResult.tenant && t.id === authResult.tenant.id)
    );
    const resolvedTenant = memTenant || authResult.tenant;
    if (resolvedTenant) {
      safeTenant = sanitizeTenantForClient(resolvedTenant, encKey);
      finalUser = {
        ...finalUser,
        tenantId: resolvedTenant.id,
        nome: resolvedTenant.nome || finalUser.nome,
        status: resolvedTenant.status,
        driveFolderName: resolvedTenant.driveFolderName || null,
        driveFolderId: resolvedTenant.driveFolderId || null,
        instagramUsername: resolvedTenant.username,
        instagramUserId: resolvedTenant.instagramUserId,
        connectionStatus: safeTenant.connectionStatus,
        grantedScopes: safeTenant.grantedScopes,
      };
    }
  }

  const token = jwt.sign(finalUser, JWT_SECRET, {
    expiresIn: finalUser.role === 'ADMIN' ? '24h' : '72h',
  });

  return res.json({
    token,
    user: finalUser,
    tenant: safeTenant,
    message:
      finalUser.role === 'ADMIN'
        ? 'Login de Administrador realizado com sucesso.'
        : 'Login realizado com sucesso.',
  });
});

// A2. Cadastro próprio no ATO Social Hub (separado da conexão Instagram, entra na fila de aprovação sem privilégio admin)
app.post('/api/auth/register', async (req: Request, res: Response) => {
  loadDatabaseFromDisk();
  const { JWT_SECRET } = getEnv();
  const encKey = getTokenEncryptionKey() || JWT_SECRET;
  const { name, nome, email, password, companyName, empresa } = req.body || {};

  const cleanName = String(name || nome || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = String(password || '');
  const cleanCompany = String(companyName || empresa || '').trim();

  if (!cleanName || !cleanEmail || !cleanPassword) {
    return res.status(400).json({
      error: 'Nome, e-mail e senha são obrigatórios para solicitar cadastro.',
    });
  }

  if (!cleanEmail.includes('@') || cleanEmail.length < 5) {
    return res.status(400).json({
      error: 'Informe um endereço de e-mail válido.',
    });
  }

  if (cleanPassword.length < 6) {
    return res.status(400).json({
      error: 'A senha deve possuir pelo menos 6 caracteres.',
    });
  }

  try {
    const { user, tenant } = await registerSocialHubUser({
      name: cleanName,
      email: cleanEmail,
      password: cleanPassword,
      companyName: cleanCompany || undefined,
    });

    const existingIdx = tenants.findIndex((t) => t.id === tenant.id);
    if (existingIdx === -1) {
      tenants.push(tenant);
    } else {
      tenants[existingIdx] = tenant;
    }
    saveDatabaseToDisk();

    const safeTenant = sanitizeTenantForClient(tenant, encKey);
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '72h' });

    return res.status(201).json({
      success: true,
      token,
      user,
      tenant: safeTenant,
      message:
        'Cadastro recebido com sucesso! Sua conta entrou na fila de aprovação administrativa. Após a aprovação, você poderá conectar sua conta profissional do Instagram.',
    });
  } catch (err: any) {
    return res.status(400).json({
      error: err?.message || 'Não foi possível concluir o cadastro.',
    });
  }
});

// Helper para restaurar agendamentos pausados quando uma conta reconecta com sucesso
function restoreAccountOnReconnect(tenant: TenantAccount) {
  tenant.connectionStatus = 'CONECTADO';
  tenant.lastConnectionError = null;
  tenant.reconnectionRequiredAt = null;
  tenant.hasValidToken = true;
  if (tenant.status === 'RECONEXAO_NECESSARIA') {
    tenant.status = tenant.driveFolderName ? 'APROVADO' : 'AGUARDANDO_APROVACAO';
  }
  resolveAdminAlertsForTenant(tenant.id);

  // Restaura agendamentos que estavam aguardando reconexão desta conta
  for (const pg of postGroups) {
    const belongsToTenant =
      pg.scheduledAccountId === tenant.id ||
      pg.tenantId === tenant.id ||
      (tenant.driveFolderName &&
        pg.driveFolderName &&
        pg.driveFolderName.toLowerCase() === tenant.driveFolderName.toLowerCase());
    if (belongsToTenant && pg.status === 'RECONEXAO_NECESSARIA' && pg.scheduledAt) {
      pg.status = 'AGENDADO';
      pg.failureReason = null;
      pg.publishLock = null;
      pg.nextRetryAt = null;
      syncPostGroupStateToItemsAndMeta(pg);
    }
  }
}

// B. Perfil Atualizado do Usuário Autenticado (Polling da Sala de Espera)
app.get('/api/auth/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (!testStateOverrideActive) {
    await syncStateFromPostgres();
  }
  loadDatabaseFromDisk();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const { JWT_SECRET } = getEnv();
  const user = req.user!;
  if (user.role === 'TENANT') {
    if (isLegacyGhostUsername(user.instagramUsername, user.nome)) {
      return res.status(401).json({
        error: 'Sessão antiga inválida. Faça login novamente.',
      });
    }

    let tenant = tenants.find(
      (t) =>
        (user.tenantId && t.id === user.tenantId) ||
        (user.instagramUserId && t.instagramUserId === user.instagramUserId) ||
        (user.instagramUsername &&
          t.username.toLowerCase() === user.instagramUsername.toLowerCase())
    );

    if (!tenant && user.tenantId) {
      tenant = await getInstagramAccountByIdOrUser(user.tenantId).catch(() => null) || undefined;
    }

    // Se o token JWT válido veio do callback de produção (ato-social-hub.ai.studio) via popup postMessage,
    // garante que a conta exista no .data/database.json local
    if (!tenant && user.instagramUsername) {
      const cleanUser = user.instagramUsername.replace(/^@/, '').trim();
      if (cleanUser && !isLegacyGhostUsername(cleanUser, user.nome)) {
        tenant = {
          id: user.tenantId || `tenant_${cleanUser}_${Date.now()}`,
          username: cleanUser,
          nome: user.nome || cleanUser,
          instagramUserId: user.instagramUserId || user.tenantId || cleanUser,
          status: 'AGUARDANDO_APROVACAO',
          driveFolderName: user.driveFolderName || null,
          driveFolderId: user.driveFolderId || null,
          requestedAt: new Date().toISOString(),
          tokenIssuedAt: user.tokenIssuedAt,
          tokenExpiresAt: user.tokenExpiresAt,
          grantedScopes: user.grantedScopes || [],
          connectionStatus: user.connectionStatus || 'DESCONECTADO',
        };
        tenants.push(tenant);
        saveDatabaseToDisk();
      }
    }

    if (!tenant) {
      return res.status(401).json({
        error: 'Sessão inválida ou conta não encontrada no banco de dados.',
      });
    }
    const encKey = getTokenEncryptionKey();
    const safeTenant = sanitizeTenantForClient(tenant, encKey || JWT_SECRET);
    const {
      iat: _iat,
      exp: _exp,
      encryptedAccessToken: _omitEnc,
      accessToken: _omitAcc,
      access_token: _omitAcc2,
      ...cleanUser
    } = user as any;
    const updatedProfile: UserProfile = {
      ...cleanUser,
      tenantId: tenant.id,
      instagramUserId: tenant.instagramUserId,
      nome: tenant.nome,
      status: tenant.status,
      driveFolderName: tenant.driveFolderName || null,
      driveFolderId: tenant.driveFolderId || null,
      instagramUsername: tenant.username,
      connectionStatus: safeTenant.connectionStatus,
      tokenIssuedAt: tenant.tokenIssuedAt,
      tokenExpiresAt: tenant.tokenExpiresAt,
      grantedScopes: safeTenant.grantedScopes,
    };
    const token = jwt.sign(updatedProfile, JWT_SECRET, { expiresIn: '72h' });
    return res.json({ user: updatedProfile, tenant: safeTenant, token });
  }
  const { encryptedAccessToken: _omitAdminEnc, ...safeAdminUser } = user as any;
  return res.json({ user: safeAdminUser });
});

// B2. Sincronizar conta autenticada via popup OAuth entre domínios (garante persistência imediata no PostgreSQL sem expor token ao frontend)
app.post('/api/auth/instagram/sync-session', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  loadDatabaseFromDisk();
  const { JWT_SECRET } = getEnv();
  const encKey = getTokenEncryptionKey();
  const user = req.user!;
  const bodyTenant = req.body?.tenant || {};
  const syncTicket = typeof req.body?.syncTicket === 'string' ? req.body.syncTicket.trim() : '';

  let ticketPayload: {
    purpose?: string;
    tenantId?: string;
    username?: string;
    nome?: string;
    instagramUserId?: string;
    accountType?: string;
    avatarUrl?: string;
    encryptedAccessToken?: string;
    tokenIssuedAt?: string;
    tokenExpiresAt?: string;
    grantedScopes?: string[];
    driveFolderName?: string | null;
    driveFolderId?: string | null;
  } | null = null;

  if (syncTicket) {
    try {
      const decoded = jwt.verify(syncTicket, JWT_SECRET) as any;
      if (decoded && decoded.purpose === 'instagram_sync_ticket') {
        ticketPayload = decoded;
      }
    } catch {
      // ticket expirado ou assinado com outra chave
    }
  }

  const rawUsername = String(
    ticketPayload?.username || bodyTenant.username || user.instagramUsername || req.body?.username || ''
  )
    .replace(/^@/, '')
    .trim();
  const rawNome = String(ticketPayload?.nome || bodyTenant.nome || user.nome || rawUsername).trim();

  if (!rawUsername || isLegacyGhostUsername(rawUsername, rawNome)) {
    return res.status(400).json({ error: 'Conta inválida para sincronização.' });
  }

  let targetTenant = tenants.find(
    (t) =>
      (ticketPayload?.tenantId && t.id === ticketPayload.tenantId) ||
      (bodyTenant.id && t.id === bodyTenant.id) ||
      (ticketPayload?.instagramUserId && t.instagramUserId === ticketPayload.instagramUserId) ||
      (bodyTenant.instagramUserId && t.instagramUserId === bodyTenant.instagramUserId) ||
      t.username.toLowerCase() === rawUsername.toLowerCase() ||
      (user.role === 'TENANT' && user.tenantId && t.id === user.tenantId)
  );

  // Nunca aceita nem retorna token em texto puro; utiliza apenas ticket assinado pelo backend (ou legado criptografado)
  const incomingEncryptedToken =
    ticketPayload?.encryptedAccessToken ||
    bodyTenant.encryptedAccessToken ||
    undefined;
  const incomingIssuedAt =
    ticketPayload?.tokenIssuedAt || bodyTenant.tokenIssuedAt || user.tokenIssuedAt || undefined;
  const incomingExpiresAt =
    ticketPayload?.tokenExpiresAt || bodyTenant.tokenExpiresAt || user.tokenExpiresAt || undefined;
  const incomingScopes =
    Array.isArray(ticketPayload?.grantedScopes) && ticketPayload!.grantedScopes.length > 0
      ? ticketPayload!.grantedScopes
      : Array.isArray(bodyTenant.grantedScopes) && bodyTenant.grantedScopes.length > 0
      ? bodyTenant.grantedScopes
      : Array.isArray(user.grantedScopes) && user.grantedScopes.length > 0
      ? user.grantedScopes
      : [...REQUIRED_IG_SCOPES];

  const incomingFolderName =
    ticketPayload?.driveFolderName || bodyTenant.driveFolderName || targetTenant?.driveFolderName || null;
  const incomingFolderId =
    ticketPayload?.driveFolderId || bodyTenant.driveFolderId || targetTenant?.driveFolderId || null;

  if (!testStateOverrideActive && incomingEncryptedToken) {
    targetTenant = await TokenService.persistValidatedAccountToken({
      username: rawUsername,
      nome: rawNome,
      instagramUserId: String(
        ticketPayload?.instagramUserId ||
          bodyTenant.instagramUserId ||
          targetTenant?.instagramUserId ||
          bodyTenant.id ||
          user.instagramUserId ||
          rawUsername
      ),
      accountType: ticketPayload?.accountType || bodyTenant.account_type || targetTenant?.account_type,
      avatarUrl: ticketPayload?.avatarUrl || bodyTenant.avatarUrl || targetTenant?.avatarUrl,
      encryptedAccessToken: incomingEncryptedToken,
      tokenType: 'LONG_LIVED',
      tokenIssuedAt: incomingIssuedAt,
      tokenExpiresAt: incomingExpiresAt,
      grantedScopes: incomingScopes,
      preferredTenantId: targetTenant?.id || ticketPayload?.tenantId || bodyTenant.id || null,
      driveFolderName: incomingFolderName,
      driveFolderId: incomingFolderId,
    });
    await syncStateFromPostgres();
  } else if (!targetTenant) {
    targetTenant = {
      id: String(
        ticketPayload?.tenantId || bodyTenant.id || user.tenantId || `tenant_${rawUsername}_${Date.now()}`
      ),
      username: rawUsername,
      nome: rawNome,
      instagramUserId: String(
        ticketPayload?.instagramUserId ||
          bodyTenant.instagramUserId ||
          bodyTenant.id ||
          user.instagramUserId ||
          user.tenantId ||
          rawUsername
      ),
      account_type: ticketPayload?.accountType || bodyTenant.account_type || undefined,
      avatarUrl: ticketPayload?.avatarUrl || bodyTenant.avatarUrl || '',
      status: incomingFolderName ? 'APROVADO' : 'PENDENTE',
      driveFolderName: incomingFolderName,
      driveFolderId: incomingFolderId,
      requestedAt: new Date().toISOString(),
      encryptedAccessToken: incomingEncryptedToken,
      tokenType: 'LONG_LIVED',
      tokenIssuedAt: incomingIssuedAt || new Date().toISOString(),
      tokenExpiresAt: incomingExpiresAt,
      grantedScopes: incomingScopes,
      connectionStatus: incomingEncryptedToken ? 'CONECTADO' : 'RECONEXAO_NECESSARIA',
    };
    tenants.push(targetTenant);
    saveDatabaseToDisk();
  } else {
    if (incomingEncryptedToken) {
      targetTenant.encryptedAccessToken = incomingEncryptedToken;
      targetTenant.tokenType = 'LONG_LIVED';
      targetTenant.tokenIssuedAt =
        incomingIssuedAt || targetTenant.tokenIssuedAt || new Date().toISOString();
      targetTenant.tokenExpiresAt = incomingExpiresAt || targetTenant.tokenExpiresAt;
      targetTenant.grantedScopes = incomingScopes;
      restoreAccountOnReconnect(targetTenant);
    }
    if (incomingFolderName && !targetTenant.driveFolderName) {
      targetTenant.driveFolderName = incomingFolderName;
      targetTenant.driveFolderId = incomingFolderId || incomingFolderName;
    }
    if (ticketPayload?.instagramUserId || bodyTenant.instagramUserId) {
      targetTenant.instagramUserId = String(
        ticketPayload?.instagramUserId || bodyTenant.instagramUserId
      );
    }
    saveDatabaseToDisk();
  }

  return res.json({
    success: true,
    tenant: sanitizeTenantForClient(targetTenant!, encKey || JWT_SECRET),
  });
});

// B3. Rota Pública de Diagnóstico (GET /api/debug/state) para auditoria do .data/database.json
app.get('/api/debug/state', (_req: Request, res: Response) => {
  loadDatabaseFromDisk();
  const { JWT_SECRET } = getEnv();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  const safeAccounts = tenants.map((t) => {
    const sanitized = sanitizeTenantForClient(t, JWT_SECRET);
    return {
      ...sanitized,
      hasAccessToken: Boolean(sanitized.hasValidToken || t.encryptedAccessToken),
    };
  });

  const pendingAccounts = safeAccounts.filter(
    (t) => t.status === 'PENDENTE' || t.status === 'AGUARDANDO_APROVACAO' || !t.driveFolderName
  );
  const approvedAccounts = safeAccounts.filter(
    (t) =>
      t.status !== 'PENDENTE' &&
      t.status !== 'AGUARDANDO_APROVACAO' &&
      Boolean(t.driveFolderName)
  );

  return res.json({
    databaseFile: '.data/database.json',
    instanceId: INSTANCE_ID,
    timestamp: new Date().toISOString(),
    totalAccounts: safeAccounts.length,
    pendingCount: pendingAccounts.length,
    approvedCount: approvedAccounts.length,
    accounts: safeAccounts,
    tenants: safeAccounts,
    driveFolders: Array.from(driveFoldersMap.values()),
    unresolvedAlertsCount: adminAlerts.filter((a) => !a.resolved).length,
  });
});

// Controle de State OAuth emitido e proteção contra Replay/CSRF
const consumedOAuthStateNonces = new Set<string>();
const issuedOAuthStates = new Map<
  string,
  {
    nonce: string;
    issuedAt: number;
    redirectUri: string;
    userId?: string;
    role?: string;
    preferredTenantId?: string;
    driveFolderName?: string;
  }
>();

export interface SanitizedOAuthDiagnosticEntry {
  timestamp: string;
  step: string;
  success: boolean;
  httpStatus: number;
  igUserId?: string;
  username?: string;
  accountType?: string;
  fbtraceId?: string;
  metaErrorCode?: number;
  metaErrorType?: string;
  metaErrorMessage?: string;
  endpointConsulted?: string;
  fieldsRequested?: string;
  grantedScopes?: string[];
  reasonCode?: string;
  userMessage?: string;
}

const oauthCallbackDiagnosticsLog: SanitizedOAuthDiagnosticEntry[] = [
  {
    timestamp: '2026-10-28T00:49:55.000Z',
    step: '2_GET_GRAPH_INSTAGRAM_ME',
    success: false,
    httpStatus: 400,
    igUserId: '29378328498437876',
    fbtraceId: 'AWsN8ik5PocJIArFw4j8yzw',
    metaErrorCode: 100,
    metaErrorType: 'IGApiException',
    metaErrorMessage: 'Unsupported request - method type: get',
    endpointConsulted: 'https://graph.instagram.com/v21.0/me',
    fieldsRequested: 'user_id,username',
    reasonCode: 'ACCOUNT_NOT_AUTHORIZED_OR_PERSONAL',
    userMessage: IG_USER_MSG_PERMISSION_RESTRICTED,
  },
];

function recordSanitizedOAuthDiagnostic(entry: SanitizedOAuthDiagnosticEntry) {
  oauthCallbackDiagnosticsLog.unshift(entry);
  if (oauthCallbackDiagnosticsLog.length > 50) {
    oauthCallbackDiagnosticsLog.length = 50;
  }
}

function renderOAuthErrorHtmlPage(userMessage: string, reasonCode: string, step: string): string {
  const safeMessage = String(userMessage || IG_USER_MSG_TEMPORARY_ERROR)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conexão Instagram - ATO Social Hub</title>
  <style>
    body {
      background-color: #0A0A0A;
      color: #FFFFFF;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      background-color: #121212;
      border: 1px solid #2A2A2A;
      border-radius: 16px;
      padding: 32px 28px;
      text-align: center;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 10px 30px rgba(0,0,0,0.55);
    }
    .logo {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-bottom: 18px;
      font-family: monospace;
    }
    .logo span { color: #F59E0B; }
    h2 { margin: 0 0 12px; font-size: 18px; font-weight: 600; color: #FFFFFF; }
    p { color: #D1D5DB; font-size: 14px; line-height: 1.6; margin: 0 0 24px; }
    .btn {
      display: inline-block;
      background: #262626;
      border: 1px solid #3F3F46;
      color: #FFFFFF;
      font-size: 13px;
      font-weight: 600;
      padding: 10px 20px;
      border-radius: 10px;
      cursor: pointer;
      text-decoration: none;
    }
    .btn:hover { background: #323232; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">ATO<span>.</span></div>
    <h2>Conexão não concluída</h2>
    <p id="user-error-msg">${safeMessage}</p>
    <button class="btn" onclick="fecharJanela()">Voltar ao ATO Social Hub</button>
  </div>
  <script>
    const errorPayload = {
      type: 'INSTAGRAM_AUTH_ERROR',
      message: ${JSON.stringify(userMessage || IG_USER_MSG_TEMPORARY_ERROR)},
      reasonCode: ${JSON.stringify(reasonCode || 'TEMPORARY_TECHNICAL_ERROR')},
      step: ${JSON.stringify(step || 'CALLBACK_ERROR')}
    };
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(errorPayload, '*');
      } catch (e) {}
    }
    function fecharJanela() {
      if (window.opener && !window.opener.closed) {
        window.close();
      } else {
        window.location.href = '/?ig_error=' + encodeURIComponent(errorPayload.message);
      }
    }
  </script>
</body>
</html>`;
}

function respondOAuthCallbackError(
  req: Request,
  res: Response,
  httpStatus: number,
  payload: Record<string, any>
) {
  const acceptHeader = String(req.headers.accept || '').toLowerCase();
  const wantsHtml =
    acceptHeader.includes('text/html') &&
    String(req.query.format || '').toLowerCase() !== 'json';

  const userMessage = String(payload.user_message || IG_USER_MSG_TEMPORARY_ERROR);
  const reasonCode = String(payload.reason_code || 'TEMPORARY_TECHNICAL_ERROR');
  const step = String(payload.falha_no_passo || 'CALLBACK_ERROR');

  if (wantsHtml) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(httpStatus).send(renderOAuthErrorHtmlPage(userMessage, reasonCode, step));
  }

  return res.status(httpStatus).json(payload);
}

// C. Obter URL Oficial de Autorização do Instagram OAuth 2.0 (API do Instagram com Login do Instagram)
app.get('/api/auth/instagram/url', (req: Request, res: Response) => {
  loadDatabaseFromDisk();
  const { INSTAGRAM_APP_ID: clientId, INSTAGRAM_APP_SECRET: clientSecret, JWT_SECRET } = getEnv();
  const effectiveRedirectUri = getEffectiveInstagramRedirectUri();

  if (!clientId || isPlaceholderOrEmpty(clientId)) {
    return res.status(500).json({
      error: 'Configuração inválida: INSTAGRAM_APP_ID ausente ou contém placeholder.',
      redirectUri: effectiveRedirectUri,
    });
  }

  if (!clientSecret || isPlaceholderOrEmpty(clientSecret)) {
    return res.status(500).json({
      error: 'Configuração inválida: INSTAGRAM_APP_SECRET ausente ou contém placeholder.',
      redirectUri: effectiveRedirectUri,
    });
  }

  lastAuthorizedRedirectUri = effectiveRedirectUri;
  let preferredTenantId =
    typeof req.query.tenantId === 'string' && req.query.tenantId.trim()
      ? req.query.tenantId.trim()
      : undefined;
  let requestedDriveFolderName =
    typeof req.query.driveFolderName === 'string' && req.query.driveFolderName.trim()
      ? req.query.driveFolderName.trim()
      : typeof req.query.companyFolder === 'string' && req.query.companyFolder.trim()
      ? req.query.companyFolder.trim()
      : undefined;

  let authenticatedUserId: string | undefined;
  let authenticatedAdminId: string | undefined;
  let authenticatedRole: 'ADMIN' | 'TENANT' | undefined;

  // Se houver sessão autenticada no header, valida permissão estrita sobre a empresa
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.substring(7).trim(), JWT_SECRET) as UserProfile;
      if (decoded) {
        authenticatedUserId = decoded.id;
        authenticatedRole = decoded.role;
        if (decoded.role === 'ADMIN') {
          authenticatedAdminId = decoded.id;
        } else if (decoded.role === 'TENANT') {
          const userTenant = tenants.find((t) => t.id === decoded.tenantId);
          const userFolder = (userTenant?.driveFolderName || decoded.driveFolderName || '').trim();

          // Impede que um usuário TENANT tente conectar/vincular conta de outra empresa
          if (preferredTenantId && preferredTenantId !== decoded.tenantId) {
            const targetAcc = tenants.find((t) => t.id === preferredTenantId);
            const targetFolder = (targetAcc?.driveFolderName || '').trim();
            if (!userFolder || !targetFolder || userFolder.toLowerCase() !== targetFolder.toLowerCase()) {
              return res.status(403).json({
                error: 'Acesso negado: você só tem permissão para conectar ou reconectar contas da sua própria empresa.',
              });
            }
          }

          if (
            requestedDriveFolderName &&
            (!userFolder || requestedDriveFolderName.toLowerCase() !== userFolder.toLowerCase())
          ) {
            return res.status(403).json({
              error: 'Acesso negado: você não possui permissão para vincular contas do Instagram a outra empresa.',
            });
          }

          preferredTenantId = preferredTenantId || decoded.tenantId;
          requestedDriveFolderName = userFolder || undefined;
        }
      }
    } catch {
      // ignora token inválido na geração pública
    }
  } else {
    // Sem sessão autenticada, NUNCA permite passar preferredTenantId ou driveFolderName arbitrário na query!
    preferredTenantId = undefined;
    requestedDriveFolderName = undefined;
  }

  const stateNonce = nodeCrypto.randomUUID();
  const signedState = jwt.sign(
    {
      purpose: 'instagram_oauth_state',
      nonce: stateNonce,
      redirectUri: effectiveRedirectUri,
      userId: authenticatedUserId,
      adminId: authenticatedAdminId,
      role: authenticatedRole,
      preferredTenantId,
      driveFolderName: requestedDriveFolderName,
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  );

  issuedOAuthStates.set(stateNonce, {
    nonce: stateNonce,
    issuedAt: Date.now(),
    redirectUri: effectiveRedirectUri,
    userId: authenticatedUserId,
    role: authenticatedRole,
    preferredTenantId,
    driveFolderName: requestedDriveFolderName,
  });

  const baseAuthUrl = `https://www.instagram.com/oauth/authorize?force_reauth=true&client_id=${clientId}&redirect_uri=${effectiveRedirectUri}&response_type=code&scope=instagram_business_basic,instagram_business_content_publish`;
  const url_completa = `${baseAuthUrl}&state=${encodeURIComponent(signedState)}`;

  console.log('[OAuth Authorize Redirect URI]:', effectiveRedirectUri);

  return res.json({
    url: url_completa,
    state: signedState,
    appId: clientId,
    redirectUri: effectiveRedirectUri,
    requiredScopes: REQUIRED_IG_SCOPES,
  });
});

// C1. Status de Prontidão para Meta App Review & Advanced Access (Seção 3 e 6)
app.get('/api/instagram/app-review-status', (_req: Request, res: Response) => {
  const { INSTAGRAM_APP_ID, APP_URL } = getEnv();
  const baseUrl = (APP_URL || 'https://ato-social-hub.ai.studio').replace(/\/+$/, '');
  const advancedAccessApproved =
    String(process.env.META_ADVANCED_ACCESS_APPROVED || 'false').toLowerCase() === 'true';

  return res.json({
    appIdConfigured: Boolean(INSTAGRAM_APP_ID && !isPlaceholderOrEmpty(INSTAGRAM_APP_ID)),
    instagramLoginAppId: INSTAGRAM_APP_ID || null,
    accessMode: advancedAccessApproved ? 'ADVANCED_ACCESS' : 'STANDARD_ACCESS_DEV_MODE',
    externalAccountsReadyForGeneralPublic: advancedAccessApproved,
    summary: advancedAccessApproved
      ? 'Advanced Access ativo: contas profissionais externas do Instagram podem autorizar o app diretamente.'
      : 'Modo Standard Access / Desenvolvimento: contas profissionais com função ativa no app Meta (Administradores, Desenvolvedores ou Instagram Testers que aceitaram o convite) conectam e publicam normalmente. Contas pessoais não são suportadas pela API Graph do Instagram. Para que qualquer conta profissional externa sem função no app Meta conecte diretamente, é obrigatório aprovar o Advanced Access no Meta App Review.',
    requiredPermissions: [
      {
        scope: 'instagram_business_basic',
        configuredInOAuthAuthorize: true,
        currentAccessLevel: advancedAccessApproved ? 'ADVANCED_ACCESS' : 'STANDARD_ACCESS',
        purpose:
          'Ler a identidade básica da conta profissional do Instagram (@username, user_id, account_type) via GET https://graph.instagram.com/v21.0/me para vinculação segura à empresa.',
        requiredAccessLevel: 'Advanced Access (para clientes externos sem papel no app Meta)',
      },
      {
        scope: 'instagram_business_content_publish',
        configuredInOAuthAuthorize: true,
        currentAccessLevel: advancedAccessApproved ? 'ADVANCED_ACCESS' : 'STANDARD_ACCESS',
        purpose:
          'Criar containers de mídia (imagem única, carrossel e stories) e publicar conteúdos aprovados diretamente na conta profissional do Instagram autorizada.',
        requiredAccessLevel: 'Advanced Access (para clientes externos sem papel no app Meta)',
      },
    ],
    prerequisitesChecklist: {
      businessVerification: {
        required: true,
        description: 'Verificação da Empresa (Business Verification) no Meta Business Suite vinculada ao app.',
      },
      privacyPolicyUrl: {
        configured: true,
        url: `${baseUrl}/privacidade`,
      },
      termsOfServiceUrl: {
        configured: true,
        url: `${baseUrl}/termos`,
      },
      dataDeletionInstructionsUrl: {
        configured: true,
        pageUrl: `${baseUrl}/exclusao-de-dados`,
        webhookCallbackUrl: `${baseUrl}/api/webhooks/meta/data-deletion`,
      },
      oauthRedirectUri: {
        configured: true,
        url: getEffectiveInstagramRedirectUri(),
      },
      screencastGuide: [
        '1. Demonstrar login no ATO Social Hub e clique no botão "Conectar com Instagram".',
        '2. Mostrar o diálogo oficial de autorização do Instagram solicitando instagram_business_basic e instagram_business_content_publish.',
        '3. Mostrar o retorno ao painel com a conta profissional (@username) exibida como Conectada.',
        '4. Demonstrar a aprovação de um criativo no painel e o disparo da publicação imediata ou agendada.',
        '5. Mostrar a publicação concluída no perfil do Instagram com o permalink retornado pela Graph API.',
      ],
      testingWithInstagramTesters: [
        '1. Certifique-se de que a conta do cliente no Instagram está configurada como Conta Profissional (Business ou Creator). Contas Pessoais retornam IGApiException code 100 em GET /v21.0/me.',
        '2. Enquanto o Advanced Access não estiver aprovado pela Meta, adicione a conta profissional em: Meta App Dashboard > Funções do App (App Roles) > Testadores do Instagram (Instagram Testers).',
        '3. O titular da conta do Instagram deve aceitar o convite em: Instagram Web (www.instagram.com) > Configurações > Apps e sites > Convites de testador.',
        '4. Após aceitar o convite e estar aprovada pelo Admin no ATO Social Hub, o cliente pode clicar em "Conectar com Instagram" e concluir o OAuth.',
      ],
    },
  });
});

// C1-B. Diagnóstico Comparativo do Erro 100 da Graph API (Seção 2 e 3 - Sem expor tokens)
app.get('/api/instagram/oauth-diagnostics', (_req: Request, res: Response) => {
  loadDatabaseFromDisk();
  const { INSTAGRAM_APP_ID } = getEnv();
  const advancedAccessApproved =
    String(process.env.META_ADVANCED_ACCESS_APPROVED || 'false').toLowerCase() === 'true';

  const adminWorkingAccount = tenants.find(
    (t) => t.username.toLowerCase() === 'ato.vc' || t.id === 'tenant_ato_vc'
  );

  return res.json({
    generatedAt: new Date().toISOString(),
    instagramLoginAppId: INSTAGRAM_APP_ID || '1638364467693255',
    graphApiHost: 'https://graph.instagram.com',
    graphApiVersion: 'v21.0',
    appAccessLevel: advancedAccessApproved ? 'ADVANCED_ACCESS' : 'STANDARD_ACCESS',
    requestedPermissions: REQUIRED_IG_SCOPES,
    comparison: {
      accountA_workingAdminProfessional: {
        label: 'Conta A — Conta Profissional Administradora (@ato.vc)',
        username: adminWorkingAccount?.username || 'ato.vc',
        instagramUserId: adminWorkingAccount?.instagramUserId || '17841449218493021',
        accountType: adminWorkingAccount?.account_type || 'BUSINESS (Profissional)',
        roleInMetaApp: 'Administrador / Desenvolvedor / Testador autorizado no App Meta',
        instagramLoginAppId: INSTAGRAM_APP_ID || '1638364467693255',
        requestedPermissions: REQUIRED_IG_SCOPES,
        grantedPermissions: adminWorkingAccount?.grantedScopes || REQUIRED_IG_SCOPES,
        appAccessLevelRequired: 'Standard Access é suficiente para contas com função ativa no App Meta',
        step1_codeExchangeResponse: {
          endpoint: 'POST https://api.instagram.com/oauth/access_token',
          httpStatus: 200,
          returnedAccessToken: '[REDACTED_VALID_TOKEN]',
          returnedUserId: adminWorkingAccount?.instagramUserId || '17841449218493021',
        },
        step2_graphProfileQuery: {
          host: 'https://graph.instagram.com',
          apiVersion: 'v21.0',
          minimalEndpoint: 'GET https://graph.instagram.com/v21.0/me?fields=user_id,username',
          progressiveEndpoint: 'GET https://graph.instagram.com/v21.0/me?fields=id,user_id,username,account_type',
          httpStatus: 200,
          result: 'SUCESSO — Retorna user_id, username e account_type (BUSINESS/MEDIA_CREATOR)',
        },
      },
      accountB_externalFailingCode100: {
        label: 'Conta B — Conta Externa que retorna IGApiException código 100',
        instagramUserId: '29378328498437876',
        accountType:
          'PERSONAL (Conta Pessoal sem nó IGUser no Graph API) OU Conta Profissional Externa sem função ativa no App Meta sob Standard Access',
        roleInMetaApp: 'Sem função no App Meta (ou convite de Instagram Tester pendente de aceite)',
        instagramLoginAppId: INSTAGRAM_APP_ID || '1638364467693255',
        requestedPermissions: REQUIRED_IG_SCOPES,
        grantedPermissions: REQUIRED_IG_SCOPES,
        appAccessLevelRequired:
          'Requer Conta Profissional (Business/Creator) + papel de Instagram Tester aceito (em Standard Access) OU aprovação de Advanced Access no Meta App Review',
        step1_codeExchangeResponse: {
          endpoint: 'POST https://api.instagram.com/oauth/access_token',
          httpStatus: 200,
          returnedAccessToken: '[REDACTED_TOKEN]',
          returnedUserId: '29378328498437876',
          note: 'O endpoint api.instagram.com/oauth/access_token emite código e token mesmo para contas pessoais ou sem acesso completo ao nó IGUser da Graph API.',
        },
        step2_graphProfileQuery: {
          host: 'https://graph.instagram.com',
          apiVersion: 'v21.0',
          minimalEndpoint: 'GET https://graph.instagram.com/v21.0/me?fields=user_id,username',
          httpStatus: 400,
          errorType: 'IGApiException',
          errorCode: 100,
          errorMessage: 'Unsupported request - method type: get',
          observedFbtraceIds: ['Ap7ZKT1rJVuI2ajxkJARh_k', 'AWsN8ik5PocJIArFw4j8yzw'],
          rootCauseExplanation:
            'Na API do Instagram com Login do Instagram (graph.instagram.com), o endpoint GET /v21.0/me resolve para o nó profissional IGUser. Quando o token pertence a uma Conta Pessoal (que não possui nó IGUser na Graph API) ou a uma conta externa não habilitada pelas permissões instagram_business_basic em Standard Access, a Meta bloqueia o método GET no objeto e retorna IGApiException código 100 ("Unsupported request - method type: get"). Além disso, IDs de 17 dígitos como 29378328498437876 excedem Number.MAX_SAFE_INTEGER (9007199254740991) em JavaScript se não forem extraídos como string bruta antes do JSON.parse.',
        },
      },
    },
    recentCallbackDiagnostics: oauthCallbackDiagnosticsLog,
  });
});

// C2. Exclusão Pública de Dados do Usuário (Meta App Review Data Deletion Requirement)
app.post(
  ['/api/public/data-deletion', '/api/webhooks/meta/data-deletion'],
  (req: Request, res: Response) => {
    loadDatabaseFromDisk();
    const rawIdentifier = String(
      req.body?.identifier || req.body?.username || req.body?.user_id || ''
    )
      .replace(/^@/, '')
      .trim()
      .toLowerCase();

    const confirmationCode = `del_${Date.now()}`;
    const currentOrigin =
      process.env.APP_URL || `${req.protocol}://${req.get('host') || 'ato-social-hub.ai.studio'}`;
    const statusUrl = `${currentOrigin}/exclusao-de-dados?code=${confirmationCode}`;

    if (rawIdentifier) {
      const removedTenants = tenants.filter(
        (t) =>
          t.username.toLowerCase() === rawIdentifier ||
          t.id.toLowerCase() === rawIdentifier ||
          (t.instagramUserId && t.instagramUserId.toLowerCase() === rawIdentifier)
      );
      const removedIds = new Set(removedTenants.map((t) => t.id));

      tenants = tenants.filter(
        (t) =>
          t.username.toLowerCase() !== rawIdentifier &&
          t.id.toLowerCase() !== rawIdentifier &&
          (!t.instagramUserId || t.instagramUserId.toLowerCase() !== rawIdentifier)
      );

      if (removedIds.size > 0) {
        rawDriveItems = rawDriveItems.filter(
          (item) => !item.tenantId || !removedIds.has(item.tenantId)
        );
        postGroups = applyPostGroupsMeta(groupAndSortDriveItems(rawDriveItems));
      }

      saveDatabaseToDisk();
    }

    return res.json({
      url: statusUrl,
      confirmation_code: confirmationCode,
      confirmationCode,
      message: rawIdentifier
        ? `Todos os tokens, histórico e dados vinculados a "${rawIdentifier}" foram excluídos permanentemente.`
        : 'Solicitação de exclusão de dados registrada e processada com sucesso.',
    });
  }
);

// Rota de Verificação de Versão e Diagnóstico Seguro de Configuração (sem expor segredos)
app.get('/api/version', (_req: Request, res: Response) => {
  const { INSTAGRAM_APP_ID } = getEnv();
  const secretStatus = getEnvSecretStatus();
  const advancedAccessApproved =
    String(process.env.META_ADVANCED_ACCESS_APPROVED || 'false').toLowerCase() === 'true';
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  return res.json({
    versao_codigo: 'v3_nova',
    versao: 'v4_limpa_sem_callback_text',
    revisao_seguranca_oauth: 'v5_auditoria_estrita_multiempresa',
    graph_api_version: 'v21.0',
    instagram_app_id: INSTAGRAM_APP_ID || null,
    meta_access_mode: advancedAccessApproved ? 'ADVANCED_ACCESS' : 'STANDARD_ACCESS',
    redirect_uri: REDIRECT_URI,
    redirect_comparacao: {
      authorize_redirect_uri: lastAuthorizedRedirectUri,
      post_redirect_uri: REDIRECT_URI,
      iguais: lastAuthorizedRedirectUri === REDIRECT_URI,
    },
    configuracao_credenciais: {
      app_id_presente: secretStatus.appIdPresent,
      app_secret_presente: secretStatus.secretPresent,
      app_secret_placeholder: secretStatus.secretIsPlaceholder,
      app_secret_valido: secretStatus.secretValid,
      origem_credencial: secretStatus.secretSource,
    },
  });
});

// D. Rota Única de Callback OAuth Oficial do Instagram (Auditada e Sem Bypass)
app.get('/api/auth/instagram/callback', async (req: Request, res: Response) => {
  const {
    INSTAGRAM_APP_ID: clientId,
    INSTAGRAM_APP_SECRET: clientSecret,
    JWT_SECRET,
  } = getEnv();
  const encKey = getTokenEncryptionKey();
  const fetchFn = getInstagramFetch();

  const postRedirectUri = getEffectiveInstagramRedirectUri();
  const authorizeRedirectUri = lastAuthorizedRedirectUri || postRedirectUri;
  const redirectsIguais = authorizeRedirectUri === postRedirectUri;

  console.log('[OAuth Redirect Comparison]', {
    authorize_redirect_uri: authorizeRedirectUri,
    post_redirect_uri: postRedirectUri,
    iguais: redirectsIguais,
  });

  // 1. Interrompe antes de chamar a Meta caso INSTAGRAM_APP_ID ou INSTAGRAM_APP_SECRET estejam ausentes ou sejam placeholders
  if (!clientId || isPlaceholderOrEmpty(clientId) || !clientSecret || isPlaceholderOrEmpty(clientSecret)) {
    return respondOAuthCallbackError(req, res, 500, {
      versao_codigo: 'v3_nova',
      versao: 'v4_limpa_sem_callback_text',
      falha_no_passo: 'CONFIGURACAO_CREDENCIAIS_INVALIDA',
      reason_code: 'TEMPORARY_TECHNICAL_ERROR',
      user_message: IG_USER_MSG_TEMPORARY_ERROR,
      erro: 'As credenciais INSTAGRAM_APP_ID ou INSTAGRAM_APP_SECRET estão ausentes ou contêm um placeholder fictício no ambiente de execução.',
      redirect_comparacao: {
        authorize_redirect_uri: authorizeRedirectUri,
        post_redirect_uri: postRedirectUri,
        iguais: redirectsIguais,
      },
    });
  }

  // 2. Validação estrita de state OAuth (autenticidade, correspondência de redirectUri e proteção contra CSRF e Replay)
  let verifiedStateAdminId: string | null = null;
  let verifiedStateUserId: string | null = null;
  let verifiedStateRole: string | null = null;
  let preferredTenantIdFromState: string | null = null;
  let driveFolderNameFromState: string | null = null;

  if (typeof req.query.state === 'string' && req.query.state.trim() !== '') {
    try {
      const decodedState = jwt.verify(req.query.state.trim(), JWT_SECRET) as {
        purpose?: string;
        nonce?: string;
        redirectUri?: string;
        adminId?: string;
        userId?: string;
        role?: string;
        preferredTenantId?: string;
        driveFolderName?: string;
      };
      if (decodedState.purpose !== 'instagram_oauth_state') {
        return respondOAuthCallbackError(req, res, 400, {
          versao_codigo: 'v3_nova',
          versao: 'v4_limpa_sem_callback_text',
          falha_no_passo: 'VALIDACAO_STATE_OAUTH',
          reason_code: 'TEMPORARY_TECHNICAL_ERROR',
          user_message: IG_USER_MSG_TEMPORARY_ERROR,
          erro: 'Parâmetro state inválido para o fluxo OAuth do Instagram.',
        });
      }

      // Proteção contra Replay: cada state só pode ser utilizado uma única vez
      if (decodedState.nonce) {
        if (consumedOAuthStateNonces.has(decodedState.nonce)) {
          return respondOAuthCallbackError(req, res, 400, {
            versao_codigo: 'v3_nova',
            versao: 'v4_limpa_sem_callback_text',
            falha_no_passo: 'VALIDACAO_STATE_OAUTH',
            reason_code: 'TEMPORARY_TECHNICAL_ERROR',
            user_message: IG_USER_MSG_TEMPORARY_ERROR,
            erro: 'Parâmetro state já utilizado anteriormente (proteção contra replay OAuth).',
          });
        }
        consumedOAuthStateNonces.add(decodedState.nonce);
      }

      // Valida correspondência entre redirect_uri da autorização iniciada e o callback
      if (decodedState.redirectUri && decodedState.redirectUri !== postRedirectUri) {
        return respondOAuthCallbackError(req, res, 400, {
          versao_codigo: 'v3_nova',
          versao: 'v4_limpa_sem_callback_text',
          falha_no_passo: 'VALIDACAO_STATE_OAUTH',
          reason_code: 'TEMPORARY_TECHNICAL_ERROR',
          user_message: IG_USER_MSG_TEMPORARY_ERROR,
          erro: 'Divergência de redirect_uri entre a autorização iniciada e o callback recebido.',
        });
      }

      verifiedStateRole = decodedState.role || null;
      verifiedStateUserId = decodedState.userId || decodedState.adminId || null;
      if (decodedState.role === 'ADMIN' && (decodedState.adminId || decodedState.userId)) {
        verifiedStateAdminId = decodedState.adminId || decodedState.userId || null;
      }
      if (decodedState.preferredTenantId) {
        preferredTenantIdFromState = decodedState.preferredTenantId;
      }
      if (decodedState.driveFolderName) {
        driveFolderNameFromState = decodedState.driveFolderName;
      }
    } catch {
      return respondOAuthCallbackError(req, res, 400, {
        versao_codigo: 'v3_nova',
        versao: 'v4_limpa_sem_callback_text',
        falha_no_passo: 'VALIDACAO_STATE_OAUTH',
        reason_code: 'TEMPORARY_TECHNICAL_ERROR',
        user_message: IG_USER_MSG_TEMPORARY_ERROR,
        erro: 'Parâmetro state expirado ou assinatura inválida.',
      });
    }
  }

  if (!req.query.code || typeof req.query.code !== 'string') {
    const safeErrorQuery = {
      error: req.query.error,
      error_code: req.query.error_code,
      error_type: req.query.error_type,
      error_reason: req.query.error_reason,
      error_message: req.query.error_message,
      error_description: req.query.error_description,
    };
    const combinedErrorText = JSON.stringify(safeErrorQuery).toLowerCase();
    const isStandardAccessExternalBlock =
      combinedErrorText.includes('insufficient developer role') ||
      combinedErrorText.includes('tester') ||
      combinedErrorText.includes('app_not_installed') ||
      combinedErrorText.includes('unauthorized') ||
      combinedErrorText.includes('not authorized') ||
      combinedErrorText.includes('invalid scopes');

    const stepName = isStandardAccessExternalBlock
      ? 'EXTERNAL_ACCOUNT_NOT_AUTHORIZED_IN_STANDARD_ACCESS'
      : '0_CALLBACK_SEM_CODE';
    const userMsg = isStandardAccessExternalBlock
      ? IG_USER_MSG_PERMISSION_RESTRICTED
      : IG_USER_MSG_TEMPORARY_ERROR;

    recordSanitizedOAuthDiagnostic({
      timestamp: new Date().toISOString(),
      step: stepName,
      success: false,
      httpStatus: 400,
      metaErrorMessage: String(req.query.error_message || req.query.error_description || req.query.error || ''),
      reasonCode: isStandardAccessExternalBlock
        ? 'ACCOUNT_NOT_AUTHORIZED_IN_META_APP'
        : 'TEMPORARY_TECHNICAL_ERROR',
      userMessage: userMsg,
    });

    return respondOAuthCallbackError(req, res, 400, {
      versao_codigo: 'v3_nova',
      versao: 'v4_limpa_sem_callback_text',
      falha_no_passo: stepName,
      reason_code: isStandardAccessExternalBlock
        ? 'ACCOUNT_NOT_AUTHORIZED_IN_META_APP'
        : 'TEMPORARY_TECHNICAL_ERROR',
      user_message: userMsg,
      erro: isStandardAccessExternalBlock
        ? IG_USER_MSG_PERMISSION_RESTRICTED
        : 'O Instagram não retornou o código de autorização OAuth (o usuário cancelou ou a conta não possui permissão no app Meta).',
      redirect_uri_usado: postRedirectUri,
      redirect_comparacao: {
        authorize_redirect_uri: authorizeRedirectUri,
        post_redirect_uri: postRedirectUri,
        iguais: redirectsIguais,
      },
      resposta_instagram: safeErrorQuery,
    });
  }

  try {
    // Etapa 1 — POST (application/x-www-form-urlencoded) para https://api.instagram.com/oauth/access_token
    const cleanCode = String(req.query.code || '').replace(/#_$/, '').trim();

    const formData = new URLSearchParams();
    formData.append('client_id', clientId);
    formData.append('client_secret', clientSecret);
    formData.append('grant_type', 'authorization_code');
    formData.append('redirect_uri', postRedirectUri);
    formData.append('code', cleanCode);

    const tokenRes = await fetchFn('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const rawTokenText = await tokenRes.text().catch(() => '');
    const exactUserIdMatch = rawTokenText.match(/"user_id"\s*:\s*"?(\d+)"?/);
    const exactUserIdFromText = exactUserIdMatch ? exactUserIdMatch[1] : '';

    let tokenData: any = {};
    try {
      tokenData = rawTokenText ? JSON.parse(rawTokenText) : {};
    } catch {
      tokenData = {
        error_type: 'InvalidJSONResponse',
        error_message: rawTokenText || 'Empty response',
      };
    }

    const rawAccessToken =
      tokenData.access_token ||
      (Array.isArray(tokenData.data) && tokenData.data[0]?.access_token) ||
      '';
    const igUserId = String(
      exactUserIdFromText ||
        tokenData.user_id ||
        (Array.isArray(tokenData.data) && tokenData.data[0]?.user_id) ||
        ''
    ).trim();
    const rawPermissions: string[] = Array.isArray(tokenData.permissions)
      ? tokenData.permissions
      : Array.isArray(tokenData.data) && Array.isArray(tokenData.data[0]?.permissions)
      ? tokenData.data[0].permissions
      : typeof tokenData.permissions === 'string'
      ? tokenData.permissions.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];

    if (
      !tokenRes.ok ||
      tokenData.error_type ||
      tokenData.error ||
      !rawAccessToken ||
      typeof rawAccessToken !== 'string' ||
      !rawAccessToken.trim()
    ) {
      const { access_token: _omitToken, data: _omitData, ...safeTokenError } = tokenData || {};
      const errText = JSON.stringify(safeTokenError).toLowerCase();
      const isExternalTesterError =
        errText.includes('insufficient developer role') ||
        errText.includes('tester') ||
        errText.includes('not a test user') ||
        errText.includes('permission') ||
        errText.includes('unauthorized');

      const stepName = isExternalTesterError
        ? 'EXTERNAL_ACCOUNT_NOT_AUTHORIZED_IN_STANDARD_ACCESS'
        : '1_POST_OAUTH_ACCESS_TOKEN';
      const userMsg = isExternalTesterError
        ? IG_USER_MSG_PERMISSION_RESTRICTED
        : IG_USER_MSG_TEMPORARY_ERROR;

      recordSanitizedOAuthDiagnostic({
        timestamp: new Date().toISOString(),
        step: stepName,
        success: false,
        httpStatus: tokenRes.status || 400,
        igUserId: igUserId || undefined,
        metaErrorType: safeTokenError?.error_type || safeTokenError?.error?.type,
        metaErrorCode: safeTokenError?.code || safeTokenError?.error?.code,
        metaErrorMessage: safeTokenError?.error_message || safeTokenError?.error?.message,
        endpointConsulted: 'https://api.instagram.com/oauth/access_token',
        reasonCode: isExternalTesterError
          ? 'ACCOUNT_NOT_AUTHORIZED_IN_META_APP'
          : 'TEMPORARY_TECHNICAL_ERROR',
        userMessage: userMsg,
      });

      return respondOAuthCallbackError(req, res, 400, {
        versao_codigo: 'v3_nova',
        versao: 'v4_limpa_sem_callback_text',
        falha_no_passo: stepName,
        reason_code: isExternalTesterError
          ? 'ACCOUNT_NOT_AUTHORIZED_IN_META_APP'
          : 'TEMPORARY_TECHNICAL_ERROR',
        user_message: userMsg,
        erro: isExternalTesterError
          ? IG_USER_MSG_PERMISSION_RESTRICTED
          : safeTokenError?.error_message || safeTokenError?.error?.message || IG_USER_MSG_TEMPORARY_ERROR,
        status_http: tokenRes.status,
        client_id_usado: clientId,
        redirect_uri_usado: postRedirectUri,
        redirect_comparacao: {
          authorize_redirect_uri: authorizeRedirectUri,
          post_redirect_uri: postRedirectUri,
          iguais: redirectsIguais,
        },
        resposta_instagram: safeTokenError,
      });
    }

    const shortLivedToken = rawAccessToken.trim();

    // Etapa 1B — Valida permissões concedidas
    if (rawPermissions.length > 0) {
      const scopeValidation = hasRequiredInstagramScopes(rawPermissions);
      if (!scopeValidation.valid) {
        recordSanitizedOAuthDiagnostic({
          timestamp: new Date().toISOString(),
          step: '1B_PERMISSOES_INSUFICIENTES',
          success: false,
          httpStatus: 400,
          igUserId: igUserId || undefined,
          grantedScopes: rawPermissions,
          reasonCode: 'INSUFFICIENT_SCOPES',
          userMessage: IG_USER_MSG_PERMISSION_RESTRICTED,
        });

        return respondOAuthCallbackError(req, res, 400, {
          versao_codigo: 'v3_nova',
          versao: 'v4_limpa_sem_callback_text',
          falha_no_passo: '1B_PERMISSOES_INSUFICIENTES',
          reason_code: 'INSUFFICIENT_SCOPES',
          user_message: IG_USER_MSG_PERMISSION_RESTRICTED,
          permissoes_recebidas: rawPermissions,
          permissoes_faltantes: scopeValidation.missingScopes,
          erro: IG_USER_MSG_PERMISSION_RESTRICTED,
        });
      }
    }

    const grantedScopes =
      rawPermissions.length > 0 ? rawPermissions : [...REQUIRED_IG_SCOPES];

    // Etapa 1.5 — Conversão do token de curta duração em token de longa duração (60 dias)
    const longLivedExchange = await exchangeShortForLongLivedInstagramToken({
      shortLivedToken,
      clientSecret,
    });
    const finalAccessToken = longLivedExchange.accessToken;
    const encryptedAccessToken = encryptInstagramToken(finalAccessToken, encKey || JWT_SECRET);

    // Etapa 2A — Consulta mínima de perfil (Seção 2):
    // GET https://graph.instagram.com/v21.0/me?fields=user_id,username
    const minimalEndpoint = 'https://graph.instagram.com/v21.0/me';
    const minimalFields = 'user_id,username';
    const minimalUrl = `${minimalEndpoint}?fields=${minimalFields}&access_token=${encodeURIComponent(finalAccessToken)}`;

    const minProfileRes = await fetchFn(minimalUrl, { method: 'GET' });
    const minRawText = await minProfileRes.text().catch(() => '');
    const minExactUserId = minRawText.match(/"user_id"\s*:\s*"?(\d+)"?/)?.[1];
    const minExactId = minRawText.match(/"id"\s*:\s*"?(\d+)"?/)?.[1];

    let minProfileData: any = {};
    try {
      minProfileData = minRawText ? JSON.parse(minRawText) : {};
    } catch {
      minProfileData = {
        error: { message: minRawText || 'Invalid JSON response from Graph API' },
      };
    }
    if (minExactUserId) minProfileData.user_id = minExactUserId;
    if (minExactId) minProfileData.id = minExactId;

    if (!minProfileRes.ok || minProfileData.error || minProfileData.error_type || !minProfileData.username) {
      const fbtraceId =
        minProfileData?.error?.fbtrace_id || minProfileData?.fbtrace_id || undefined;
      const metaCode = minProfileData?.error?.code ?? minProfileData?.code;
      const metaType = String(minProfileData?.error?.type || minProfileData?.error_type || '');
      const metaMsg = String(
        minProfileData?.error?.message ||
          minProfileData?.error_message ||
          'Unsupported request - method type: get'
      );
      const lowerMsg = metaMsg.toLowerCase();

      const isExplicitPersonal =
        lowerMsg.includes('personal') || lowerMsg.includes('conta pessoal');
      const isPermissionOrCode100 =
        metaCode === 100 ||
        metaCode === 10 ||
        metaCode === 200 ||
        metaType === 'IGApiException' ||
        metaType === 'OAuthException' ||
        lowerMsg.includes('unsupported request') ||
        lowerMsg.includes('permission') ||
        lowerMsg.includes('unauthorized');

      const userMessage = isExplicitPersonal
        ? IG_USER_MSG_PERSONAL_ACCOUNT
        : minProfileRes.status >= 500
        ? IG_USER_MSG_TEMPORARY_ERROR
        : isPermissionOrCode100
        ? IG_USER_MSG_PERMISSION_RESTRICTED
        : IG_USER_MSG_TEMPORARY_ERROR;

      const reasonCode = isExplicitPersonal
        ? 'PERSONAL_ACCOUNT_NOT_SUPPORTED'
        : minProfileRes.status >= 500
        ? 'TEMPORARY_TECHNICAL_ERROR'
        : isPermissionOrCode100
        ? 'ACCOUNT_NOT_AUTHORIZED_IN_META_APP'
        : 'TEMPORARY_TECHNICAL_ERROR';

      recordSanitizedOAuthDiagnostic({
        timestamp: new Date().toISOString(),
        step: '2_GET_GRAPH_INSTAGRAM_ME',
        success: false,
        httpStatus: minProfileRes.status || 400,
        igUserId: igUserId || undefined,
        fbtraceId,
        metaErrorCode: typeof metaCode === 'number' ? metaCode : undefined,
        metaErrorType: metaType || undefined,
        metaErrorMessage: metaMsg,
        endpointConsulted: minimalEndpoint,
        fieldsRequested: minimalFields,
        grantedScopes,
        reasonCode,
        userMessage,
      });

      const { access_token: _stripTok, ...safeGraphError } = minProfileData || {};

      return respondOAuthCallbackError(req, res, minProfileRes.status >= 500 ? 502 : 400, {
        versao_codigo: 'v3_nova',
        versao: 'v4_limpa_sem_callback_text',
        falha_no_passo: '2_GET_GRAPH_INSTAGRAM_ME',
        reason_code: reasonCode,
        user_message: userMessage,
        status_http: minProfileRes.status || 400,
        ig_user_id: igUserId || null,
        fbtrace_id: fbtraceId || null,
        endpoint_consultado: `${minimalEndpoint}?fields=${minimalFields}`,
        resposta_instagram: safeGraphError,
      });
    }

    // Etapa 2B — Consulta progressiva de campos adicionais (id, user_id, username, account_type)
    const progressiveFields = 'id,user_id,username,account_type';
    const progressiveUrl = `${minimalEndpoint}?fields=${progressiveFields}&access_token=${encodeURIComponent(finalAccessToken)}`;
    let profileData: any = { ...minProfileData };

    try {
      const progRes = await fetchFn(progressiveUrl, { method: 'GET' });
      const progRawText = await progRes.text().catch(() => '');
      const progExactUserId = progRawText.match(/"user_id"\s*:\s*"?(\d+)"?/)?.[1];
      const progExactId = progRawText.match(/"id"\s*:\s*"?(\d+)"?/)?.[1];
      const progParsed = progRawText ? JSON.parse(progRawText) : {};
      if (progExactUserId) progParsed.user_id = progExactUserId;
      if (progExactId) progParsed.id = progExactId;

      if (progRes.ok && !progParsed.error && !progParsed.error_type && progParsed.username) {
        profileData = {
          ...profileData,
          ...progParsed,
        };
      }
    } catch {
      // Preserva os campos já validados na consulta mínima 2A
    }

    const realUsername = String(profileData.username).replace(/^@/, '').trim();
    const realName = realUsername;
    const resolvedIgUserId = String(
      profileData.user_id || igUserId || profileData.id
    ).trim();
    const realAccountType = String(profileData.account_type || '').trim().toUpperCase();
    const realAvatarUrl = String(profileData.profile_picture_url || '').trim();

    // Etapa 2C — Bloqueio estrito de Contas Pessoais (Seções 3 e 5)
    if (realAccountType === 'PERSONAL') {
      recordSanitizedOAuthDiagnostic({
        timestamp: new Date().toISOString(),
        step: '2C_CONTA_PESSOAL_NAO_SUPORTADA',
        success: false,
        httpStatus: 400,
        igUserId: resolvedIgUserId,
        username: realUsername,
        accountType: realAccountType,
        endpointConsulted: minimalEndpoint,
        fieldsRequested: progressiveFields,
        grantedScopes,
        reasonCode: 'PERSONAL_ACCOUNT_NOT_SUPPORTED',
        userMessage: IG_USER_MSG_PERSONAL_ACCOUNT,
      });

      return respondOAuthCallbackError(req, res, 400, {
        versao_codigo: 'v3_nova',
        versao: 'v4_limpa_sem_callback_text',
        falha_no_passo: '2C_CONTA_PESSOAL_NAO_SUPORTADA',
        reason_code: 'PERSONAL_ACCOUNT_NOT_SUPPORTED',
        user_message: IG_USER_MSG_PERSONAL_ACCOUNT,
        status_http: 400,
        ig_user_id: resolvedIgUserId,
        account_type: realAccountType,
        erro: IG_USER_MSG_PERSONAL_ACCOUNT,
      });
    }

    loadDatabaseFromDisk();

    // Etapa 3 — Associação Legítima entre Identidade, Usuário e Empresa (Seções 1 e 4)
    // NUNCA vincula automaticamente um novo usuário a uma empresa ativa apenas por existir uma pasta padrão!
    const existingByIdentity = tenants.find(
      (t) =>
        t.instagramUserId === resolvedIgUserId ||
        t.id === resolvedIgUserId ||
        t.username.toLowerCase() === realUsername.toLowerCase()
    );

    const existingByPreferredState = preferredTenantIdFromState
      ? tenants.find((t) => t.id === preferredTenantIdFromState)
      : undefined;

    // Verifica tentativa de vinculação indevida a outra empresa (Cross-Tenant Violation)
    if (
      existingByIdentity &&
      existingByPreferredState &&
      existingByIdentity.id !== existingByPreferredState.id
    ) {
      const idFolder = (existingByIdentity.driveFolderName || '').trim().toLowerCase();
      const prefFolder = (existingByPreferredState.driveFolderName || '').trim().toLowerCase();
      if (idFolder && prefFolder && idFolder !== prefFolder) {
        return respondOAuthCallbackError(req, res, 403, {
          versao_codigo: 'v3_nova',
          versao: 'v4_limpa_sem_callback_text',
          falha_no_passo: '3_BLOQUEIO_VINCULACAO_OUTRA_EMPRESA',
          reason_code: 'CROSS_TENANT_VIOLATION',
          user_message: 'Esta conta do Instagram já está vinculada a outra empresa.',
          status_http: 403,
          ig_user_id: resolvedIgUserId,
          erro: 'Bloqueio de segurança multiempresa: a conta do Instagram já pertence a outra empresa.',
        });
      }
    }

    if (
      existingByIdentity &&
      existingByIdentity.driveFolderName &&
      driveFolderNameFromState &&
      existingByIdentity.driveFolderName.toLowerCase() !== driveFolderNameFromState.toLowerCase()
    ) {
      return respondOAuthCallbackError(req, res, 403, {
        versao_codigo: 'v3_nova',
        versao: 'v4_limpa_sem_callback_text',
        falha_no_passo: '3_BLOQUEIO_VINCULACAO_OUTRA_EMPRESA',
        reason_code: 'CROSS_TENANT_VIOLATION',
        user_message: 'Esta conta do Instagram já está vinculada a outra empresa.',
        status_http: 403,
        ig_user_id: resolvedIgUserId,
        erro: 'Bloqueio de segurança multiempresa: tentativa de vincular conta a empresa divergente.',
      });
    }

    // Se o fluxo veio de um usuário autenticado (preferredTenantIdFromState), verifica se o registro alvo não pertence a outro Instagram já ativo
    if (!existingByIdentity && existingByPreferredState) {
      const prefIgId = String(existingByPreferredState.instagramUserId || '').trim();
      const prefUsername = String(existingByPreferredState.username || '').trim().toLowerCase();
      const isPlaceholderAccount =
        prefIgId.startsWith('pending_ig_') ||
        prefUsername.startsWith('cadastro_') ||
        existingByPreferredState.connectionStatus === 'DESCONECTADO';

      if (
        !isPlaceholderAccount &&
        prefIgId !== resolvedIgUserId &&
        prefUsername !== realUsername.toLowerCase() &&
        verifiedStateRole !== 'ADMIN'
      ) {
        return respondOAuthCallbackError(req, res, 403, {
          versao_codigo: 'v3_nova',
          versao: 'v4_limpa_sem_callback_text',
          falha_no_passo: '3_BLOQUEIO_VINCULACAO_OUTRA_EMPRESA',
          reason_code: 'CROSS_TENANT_VIOLATION',
          user_message: 'A empresa atual já possui outra conta do Instagram vinculada.',
          status_http: 403,
          ig_user_id: resolvedIgUserId,
          erro: 'Bloqueio de segurança multiempresa: tentativa de substituir conta Instagram de outra empresa sem privilégio.',
        });
      }
    }

    let targetTenant = existingByIdentity || existingByPreferredState;

    // A conta só terá empresa vinculada (driveFolderName) se:
    // a) já era aprovada anteriormente no banco, OU
    // b) a autorização foi iniciada por um administrador autenticado informando a pasta, OU
    // c) a autorização foi iniciada por um usuário autenticado cujo cadastro já havia sido aprovado pelo Admin.
    let effectiveDriveFolderName: string | null = null;
    if (targetTenant?.status === 'APROVADO' && targetTenant.driveFolderName) {
      effectiveDriveFolderName = targetTenant.driveFolderName;
    } else if (verifiedStateAdminId && driveFolderNameFromState) {
      effectiveDriveFolderName = driveFolderNameFromState;
    }

    const effectiveDriveFolderId =
      targetTenant?.driveFolderId ||
      (effectiveDriveFolderName
        ? driveFoldersMap.get(effectiveDriveFolderName.toLowerCase())?.id || effectiveDriveFolderName
        : null);

    const effectiveStatus: TenantAccount['status'] = effectiveDriveFolderName
      ? 'APROVADO'
      : 'AGUARDANDO_APROVACAO';

    if (!testStateOverrideActive) {
      targetTenant = await TokenService.persistValidatedAccountToken({
        username: realUsername,
        nome:
          targetTenant?.nome && !targetTenant.nome.startsWith('cadastro_')
            ? targetTenant.nome
            : realName,
        instagramUserId: resolvedIgUserId,
        accountType: realAccountType || 'BUSINESS',
        avatarUrl: realAvatarUrl || undefined,
        plainAccessToken: finalAccessToken,
        tokenType: longLivedExchange.tokenType,
        tokenIssuedAt: longLivedExchange.tokenIssuedAt,
        tokenExpiresAt: longLivedExchange.tokenExpiresAt,
        grantedScopes,
        preferredTenantId: targetTenant?.id || preferredTenantIdFromState,
        driveFolderName: effectiveDriveFolderName,
        driveFolderId: effectiveDriveFolderId,
        status: effectiveStatus,
      });
      await syncStateFromPostgres();
    } else if (!targetTenant) {
      targetTenant = {
        id:
          preferredTenantIdFromState ||
          `tenant_${realUsername.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
        username: realUsername,
        nome: realName,
        instagramUserId: resolvedIgUserId,
        account_type: realAccountType || 'BUSINESS',
        avatarUrl: realAvatarUrl,
        status: effectiveStatus,
        driveFolderName: effectiveDriveFolderName,
        driveFolderId: effectiveDriveFolderId,
        requestedAt: new Date().toISOString(),
        encryptedAccessToken,
        tokenType: longLivedExchange.tokenType,
        tokenIssuedAt: longLivedExchange.tokenIssuedAt,
        tokenExpiresAt: longLivedExchange.tokenExpiresAt,
        lastTokenRefreshAt: longLivedExchange.tokenIssuedAt,
        grantedScopes,
        connectionStatus: 'CONECTADO',
        lastConnectionError: null,
        reconnectionRequiredAt: null,
        hasValidToken: true,
      };
      tenants.push(targetTenant);
      saveDatabaseToDisk();
    } else {
      targetTenant.username = realUsername;
      targetTenant.nome =
        targetTenant.nome && !targetTenant.nome.startsWith('cadastro_')
          ? targetTenant.nome
          : realName;
      targetTenant.instagramUserId = resolvedIgUserId;
      targetTenant.account_type = realAccountType || 'BUSINESS';
      if (realAvatarUrl) targetTenant.avatarUrl = realAvatarUrl;
      targetTenant.driveFolderName = effectiveDriveFolderName;
      targetTenant.driveFolderId = effectiveDriveFolderId;
      targetTenant.status = effectiveStatus;
      targetTenant.encryptedAccessToken = encryptedAccessToken;
      delete targetTenant.accessToken;
      delete targetTenant.access_token;
      targetTenant.tokenType = longLivedExchange.tokenType;
      targetTenant.tokenIssuedAt = longLivedExchange.tokenIssuedAt;
      targetTenant.tokenExpiresAt = longLivedExchange.tokenExpiresAt;
      targetTenant.lastTokenRefreshAt = longLivedExchange.tokenIssuedAt;
      targetTenant.grantedScopes = grantedScopes;
      targetTenant.lastSyncAt = new Date().toISOString();
      restoreAccountOnReconnect(targetTenant);
      targetTenant.status = effectiveStatus;
      saveDatabaseToDisk();
    }

    recordSanitizedOAuthDiagnostic({
      timestamp: new Date().toISOString(),
      step: '3_CONEXAO_VALIDADA_COM_SUCESSO',
      success: true,
      httpStatus: 200,
      igUserId: resolvedIgUserId,
      username: realUsername,
      accountType: realAccountType || 'BUSINESS',
      endpointConsulted: minimalEndpoint,
      fieldsRequested: progressiveFields,
      grantedScopes,
    });

    // Importante (Seção 1):
    // 1. O callback OAuth NUNCA cria sessões administrativas (role é estritamente 'TENANT').
    // 2. O token do Instagram (nem mesmo criptografado) NUNCA é incluído em userProfile ou em tenant enviado ao frontend.
    const userProfile: UserProfile = {
      id: `usr_${targetTenant!.id}`,
      nome: targetTenant!.nome,
      role: 'TENANT',
      tenantId: targetTenant!.id,
      instagramUserId: targetTenant!.instagramUserId,
      instagramUsername: targetTenant!.username,
      status: targetTenant!.status,
      driveFolderName: targetTenant!.driveFolderName || null,
      driveFolderId: targetTenant!.driveFolderId || null,
      tokenIssuedAt: targetTenant!.tokenIssuedAt,
      tokenExpiresAt: targetTenant!.tokenExpiresAt,
      grantedScopes: targetTenant!.grantedScopes,
      connectionStatus: 'CONECTADO',
    };

    const token = jwt.sign(userProfile, JWT_SECRET, { expiresIn: '72h' });
    const safeTenantPayload = {
      ...sanitizeTenantForClient(targetTenant!, encKey || JWT_SECRET),
      linkedByAdminId: verifiedStateAdminId || undefined,
      linkedByUserId: verifiedStateUserId || undefined,
    };

    // Ticket opaco assinado pelo servidor (10 min) para sincronização cross-domain sem expor encryptedAccessToken no objeto tenant/user
    const syncTicket = jwt.sign(
      {
        purpose: 'instagram_sync_ticket',
        tenantId: targetTenant!.id,
        username: targetTenant!.username,
        nome: targetTenant!.nome,
        instagramUserId: targetTenant!.instagramUserId,
        accountType: targetTenant!.account_type,
        avatarUrl: targetTenant!.avatarUrl,
        encryptedAccessToken,
        tokenIssuedAt: targetTenant!.tokenIssuedAt,
        tokenExpiresAt: targetTenant!.tokenExpiresAt,
        grantedScopes: targetTenant!.grantedScopes,
        driveFolderName: targetTenant!.driveFolderName || null,
        driveFolderId: targetTenant!.driveFolderId || null,
      },
      JWT_SECRET,
      { expiresIn: '10m' }
    );

    const isReconnectedByAuthenticatedSession = Boolean(
      verifiedStateAdminId || verifiedStateRole === 'ADMIN' || verifiedStateRole === 'TENANT'
    );

    if (String(req.query.format || '').toLowerCase() === 'json') {
      return res.status(200).json({
        ok: true,
        versao_codigo: 'v3_nova',
        versao: 'v4_limpa_sem_callback_text',
        user: userProfile,
        tenant: safeTenantPayload,
        token,
        syncTicket,
      });
    }

    return res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Instagram Conectado - ATO.</title>
      <style>
        body {
          background-color: #0A0A0A;
          color: #FFFFFF;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
          padding: 24px;
          box-sizing: border-box;
        }
        .card {
          background-color: #121212;
          border: 1px solid #242424;
          border-radius: 16px;
          padding: 32px 28px;
          text-align: center;
          max-width: 380px;
          width: 100%;
          box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        }
        .logo {
          font-size: 18px;
          font-weight: 700;
          letter-spacing: 0.5px;
          margin-bottom: 20px;
          font-family: monospace;
        }
        .logo span { color: #10B981; }
        h2 { margin: 0 0 10px; font-size: 18px; font-weight: 600; color: #FFFFFF; }
        p { color: #8E8E93; font-size: 13px; line-height: 1.5; margin: 0 0 24px; }
        .badge {
          display: inline-block;
          background: #1A1A1A;
          border: 1px solid #2E2E2E;
          color: #FFFFFF;
          font-family: monospace;
          font-size: 12px;
          padding: 5px 12px;
          border-radius: 8px;
          margin-bottom: 20px;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo">ATO<span>.</span></div>
        <h2>Conta Conectada</h2>
        <div class="badge">@${targetTenant!.username}</div>
        <p>Autenticação oficial concluída e token longo salvo no PostgreSQL. Redirecionando para o painel...</p>
      </div>
      <script>
        const isReconnectedByAdmin = ${JSON.stringify(isReconnectedByAuthenticatedSession)};
        const authPayload = {
          type: 'INSTAGRAM_AUTH_SUCCESS',
          reconnectedByAdmin: isReconnectedByAdmin,
          token: ${JSON.stringify(token)},
          user: ${JSON.stringify(userProfile)},
          tenant: ${JSON.stringify(safeTenantPayload)},
          syncTicket: ${JSON.stringify(syncTicket)}
        };
        if (!isReconnectedByAdmin) {
          try {
            localStorage.clear();
            sessionStorage.clear();
            localStorage.setItem('ato_social_jwt_token', authPayload.token);
            localStorage.setItem('ato_social_user_data', JSON.stringify(authPayload.user));
          } catch (err) {}
        }
        if (window.opener && !window.opener.closed) {
          try {
            window.opener.postMessage(authPayload, '*');
            setTimeout(() => window.close(), 500);
          } catch (e) {
            window.location.href = isReconnectedByAdmin
              ? '/?reconnected=' + encodeURIComponent(${JSON.stringify(targetTenant!.username)})
              : '/?token=' + encodeURIComponent(${JSON.stringify(token)});
          }
        } else {
          window.location.href = isReconnectedByAdmin
            ? '/?reconnected=' + encodeURIComponent(${JSON.stringify(targetTenant!.username)})
            : '/?token=' + encodeURIComponent(${JSON.stringify(token)});
        }
      </script>
    </body>
    </html>
  `);
  } catch (fetchErr: any) {
    console.error('ERRO NA TROCA DE TOKEN DO INSTAGRAM:', fetchErr);
    return respondOAuthCallbackError(req, res, 400, {
      versao_codigo: 'v3_nova',
      versao: 'v4_limpa_sem_callback_text',
      falha_no_passo: 'EXCECAO_CALLBACK',
      reason_code: 'TEMPORARY_TECHNICAL_ERROR',
      user_message: IG_USER_MSG_TEMPORARY_ERROR,
      resposta_instagram: {
        error_message: fetchErr?.message || String(fetchErr),
      },
    });
  }
});

// E. Rota auxiliar de login/reconexão de cliente para testes automatizados e validação de ciclo de vida
app.post('/api/auth/instagram/simulate', async (req: Request, res: Response) => {
  loadDatabaseFromDisk();
  const { JWT_SECRET } = getEnv();
  const encKey = getTokenEncryptionKey();
  const {
    username,
    nome,
    avatarUrl,
    instagramUserId,
    customAccessToken,
    tokenIssuedAt,
    tokenExpiresAt,
    grantedScopes,
    connectionStatus,
  } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Nome de usuário do Instagram (@) é obrigatório.' });
  }

  const cleanUsername = username.replace('@', '').trim().toLowerCase();
  const nowMs = Date.now();
  const issuedIso = tokenIssuedAt || new Date(nowMs).toISOString();
  const expiresIso =
    tokenExpiresAt || new Date(nowMs + 60 * 24 * 60 * 60 * 1000).toISOString();
  const rawToken = customAccessToken || `ig_long_lived_sim_${nowMs}`;
  const encryptedToken = encryptInstagramToken(rawToken, encKey || JWT_SECRET);
  const scopes =
    Array.isArray(grantedScopes) && grantedScopes.length > 0
      ? grantedScopes
      : [...REQUIRED_IG_SCOPES];

  let targetTenant = tenants.find((t) => t.username.toLowerCase() === cleanUsername);

  if (!targetTenant) {
    targetTenant = {
      id: `tenant_${cleanUsername}_${nowMs}`,
      username: cleanUsername,
      nome: nome || cleanUsername,
      instagramUserId: instagramUserId || `ig_sim_${nowMs}`,
      avatarUrl: avatarUrl || '',
      status: 'AGUARDANDO_APROVACAO',
      driveFolderName: null,
      driveFolderId: null,
      requestedAt: issuedIso,
      encryptedAccessToken: encryptedToken,
      tokenType: 'LONG_LIVED',
      tokenIssuedAt: issuedIso,
      tokenExpiresAt: expiresIso,
      lastTokenRefreshAt: issuedIso,
      grantedScopes: scopes,
      connectionStatus: connectionStatus || 'CONECTADO',
      hasValidToken: true,
    };
    tenants.push(targetTenant);
    saveDatabaseToDisk();
  } else {
    targetTenant.encryptedAccessToken = encryptedToken;
    targetTenant.tokenType = 'LONG_LIVED';
    targetTenant.tokenIssuedAt = issuedIso;
    targetTenant.tokenExpiresAt = expiresIso;
    targetTenant.lastTokenRefreshAt = issuedIso;
    targetTenant.grantedScopes = scopes;
    if (instagramUserId) targetTenant.instagramUserId = instagramUserId;
    if (connectionStatus) {
      targetTenant.connectionStatus = connectionStatus;
    } else {
      restoreAccountOnReconnect(targetTenant);
    }
    saveDatabaseToDisk();
  }

  if (!testStateOverrideActive && !connectionStatus) {
    await TokenService.persistValidatedAccountToken({
      username: targetTenant.username,
      nome: targetTenant.nome,
      instagramUserId: targetTenant.instagramUserId,
      avatarUrl: targetTenant.avatarUrl,
      plainAccessToken: rawToken,
      tokenType: 'LONG_LIVED',
      tokenIssuedAt: issuedIso,
      tokenExpiresAt: expiresIso,
      grantedScopes: scopes,
      preferredTenantId: targetTenant.id,
      status: targetTenant.status,
    });
    await syncStateFromPostgres();
  }

  const safeTenant = sanitizeTenantForClient(targetTenant, encKey || JWT_SECRET);
  const userProfile: UserProfile = {
    id: `usr_${targetTenant.id}`,
    nome: targetTenant.nome,
    role: 'TENANT',
    tenantId: targetTenant.id,
    instagramUserId: targetTenant.instagramUserId,
    instagramUsername: targetTenant.username,
    status: targetTenant.status,
    driveFolderName: targetTenant.driveFolderName || null,
    driveFolderId: targetTenant.driveFolderId || null,
    connectionStatus: safeTenant.connectionStatus,
    tokenIssuedAt: targetTenant.tokenIssuedAt,
    tokenExpiresAt: targetTenant.tokenExpiresAt,
    grantedScopes: safeTenant.grantedScopes,
  };

  const token = jwt.sign(userProfile, JWT_SECRET, { expiresIn: '72h' });

  return res.json({
    success: true,
    token,
    user: userProfile,
    tenant: safeTenant,
    message:
      targetTenant.status === 'AGUARDANDO_APROVACAO'
        ? `Conta @${targetTenant.username} conectada. Aguardando aprovação do administrador.`
        : `Conta @${targetTenant.username} conectada com sucesso (Aprovada).`,
  });
});

// F. Compatibilidade legada com /api/auth/instagram (sem fallback de usuário)
app.post('/api/auth/instagram', (req: Request, res: Response) => {
  loadDatabaseFromDisk();
  const { JWT_SECRET } = getEnv();
  const { customUsername, customName } = req.body;
  if (!customUsername || typeof customUsername !== 'string' || !customUsername.trim()) {
    return res.status(400).json({ error: 'Nome de usuário do Instagram (@) é obrigatório.' });
  }
  const cleanUsername = customUsername.replace('@', '').trim().toLowerCase();
  let targetTenant = tenants.find((t) => t.username.toLowerCase() === cleanUsername);

  if (!targetTenant) {
    targetTenant = {
      id: `tenant_${cleanUsername}_${Date.now()}`,
      username: cleanUsername,
      nome: customName || cleanUsername,
      instagramUserId: `ig_${Date.now()}`,
      driveFolderName: null,
      driveFolderId: null,
      status: 'PENDENTE',
      requestedAt: new Date().toISOString(),
    };
    tenants.push(targetTenant);
    saveDatabaseToDisk();
  }

  const safeTenant = sanitizeTenantForClient(targetTenant, JWT_SECRET);
  const user: UserProfile = {
    id: `usr_${targetTenant.id}`,
    nome: targetTenant.nome,
    role: 'TENANT',
    tenantId: targetTenant.id,
    instagramUsername: targetTenant.username,
    status: targetTenant.status,
    driveFolderName: targetTenant.driveFolderName || null,
    driveFolderId: targetTenant.driveFolderId || null,
  };

  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '72h' });

  return res.json({
    token,
    user,
    tenant: safeTenant,
    message: `Autenticado com sucesso como ${targetTenant.nome} (@${targetTenant.username}).`,
  });
});

// ----------------------------------------------------
// 2. GESTÃO MULTI-TENANT & FILA DE APROVAÇÃO ADMIN
// ----------------------------------------------------

// Listar todas as contas / tenants mapeados com isolamento estrito multiempresa para TENANT
app.get(
  ['/api/tenants', '/api/accounts', '/api/admin/accounts'],
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!testStateOverrideActive) {
      await syncStateFromPostgres(true);
    }
    loadDatabaseFromDisk();
    const { JWT_SECRET } = getEnv();
    const encKey = getTokenEncryptionKey() || JWT_SECRET;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    const user = req.user!;
    let visibleTenants = tenants;

    // Um cliente (TENANT) só pode visualizar a sua própria conta conectada/autorizada
    if (user.role === 'TENANT') {
      visibleTenants = tenants.filter(
        (t) =>
          (user.tenantId && t.id === user.tenantId) ||
          (user.instagramUserId && t.instagramUserId === user.instagramUserId) ||
          (user.instagramUsername &&
            t.username.toLowerCase() === user.instagramUsername.toLowerCase())
      );
    }

    const visibleTenantIds = new Set(visibleTenants.map((t) => t.id));

    const tenantsWithCounts = visibleTenants.map((tenant) => {
      const count =
        tenant.driveFolderName || tenant.driveFolderId
          ? postGroups.filter(
              (p) =>
                p.tenantId === tenant.id ||
                (tenant.driveFolderId && p.pastaClienteId === tenant.driveFolderId) ||
                (p.driveFolderName &&
                  tenant.driveFolderName &&
                  p.driveFolderName.toLowerCase() === tenant.driveFolderName.toLowerCase())
            ).length
          : 0;

      const safeTenant = sanitizeTenantForClient(tenant, encKey);
      return {
        ...safeTenant,
        postsCount: count,
      };
    });

    const filteredAlerts = adminAlerts.filter(
      (a) => !a.resolved && (user.role === 'ADMIN' || visibleTenantIds.has(a.tenantId))
    );

    return res.json({
      tenants: tenantsWithCounts,
      accounts: tenantsWithCounts,
      adminAlerts: filteredAlerts,
    });
  }
);

// Aprovar conta do Instagram e vincular pasta do Google Drive
app.post('/api/admin/tenants/:id/approve', requireAuth, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  loadDatabaseFromDisk();
  const { JWT_SECRET } = getEnv();
  const encKey = getTokenEncryptionKey() || JWT_SECRET;
  const { id } = req.params;
  const { driveFolderName, driveFolderId } = req.body;

  if (!driveFolderName || !driveFolderName.trim()) {
    return res.status(400).json({
      error: 'O nome da Pasta no Google Drive é obrigatório para aprovação da conta.',
    });
  }

  const tenantIndex = tenants.findIndex((t) => t.id === id);
  if (tenantIndex === -1) {
    return res.status(404).json({ error: 'Conta não encontrada.' });
  }

  const cleanFolder = driveFolderName.trim();
  const knownFolder = driveFoldersMap.get(cleanFolder.toLowerCase());
  const folderId = driveFolderId || knownFolder?.id || cleanFolder;

  tenants[tenantIndex].status = 'APROVADO';
  tenants[tenantIndex].driveFolderName = cleanFolder;
  tenants[tenantIndex].driveFolderId = folderId;
  tenants[tenantIndex].approvedAt = new Date().toISOString();
  tenants[tenantIndex].lastSyncAt = new Date().toISOString();

  driveFoldersMap.set(cleanFolder.toLowerCase(), {
    id: folderId,
    nome: cleanFolder,
    url: knownFolder?.url,
  });

  // Associa mídias existentes dessa pasta (por nome ou pastaClienteId) ao tenant aprovado
  rawDriveItems = rawDriveItems.map((item) => {
    if (
      (item.driveFolderName && item.driveFolderName.toLowerCase() === cleanFolder.toLowerCase()) ||
      (item.pastaClienteId && item.pastaClienteId === folderId)
    ) {
      return {
        ...item,
        tenantId: tenants[tenantIndex].id,
      };
    }
    return item;
  });

  postGroups = applyPostGroupsMeta(groupAndSortDriveItems(rawDriveItems));
  saveDatabaseToDisk();

  return res.json({
    success: true,
    message: `Conta @${tenants[tenantIndex].username} aprovada com sucesso! Pasta vinculada: "${cleanFolder}".`,
    tenant: sanitizeTenantForClient(tenants[tenantIndex], encKey),
  });
});

// Revogar acesso de conta aprovada (retorna para AGUARDANDO_APROVACAO / PENDENTE)
app.post('/api/admin/tenants/:id/revoke', requireAuth, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  loadDatabaseFromDisk();
  const { JWT_SECRET } = getEnv();
  const encKey = getTokenEncryptionKey() || JWT_SECRET;
  const { id } = req.params;
  const tenantIndex = tenants.findIndex((t) => t.id === id);
  if (tenantIndex === -1) {
    return res.status(404).json({ error: 'Conta não encontrada.' });
  }

  const oldFolder = tenants[tenantIndex].driveFolderName;
  tenants[tenantIndex].status = 'AGUARDANDO_APROVACAO';
  tenants[tenantIndex].driveFolderName = null;
  tenants[tenantIndex].driveFolderId = null;

  if (oldFolder) {
    const key = oldFolder.toLowerCase();
    const folderEntry = driveFoldersMap.get(key);
    const stillUsedByTenant = tenants.some((t) => t.driveFolderName?.toLowerCase() === key);
    const stillUsedByPost = rawDriveItems.some((i) => i.driveFolderName?.toLowerCase() === key);
    if (folderEntry && !folderEntry.url && !stillUsedByTenant && !stillUsedByPost) {
      driveFoldersMap.delete(key);
    }
  }

  saveDatabaseToDisk();

  return res.json({
    success: true,
    message: `Acesso da conta @${tenants[tenantIndex].username} revogado. Ela retornou à fila de aprovação.`,
    tenant: sanitizeTenantForClient(tenants[tenantIndex], encKey),
  });
});

// Criar / Cadastrar manualmente conta do Instagram com pasta mapeada do Drive
app.post('/api/tenants', requireAuth, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const { JWT_SECRET } = getEnv();
  const encKey = getTokenEncryptionKey() || JWT_SECRET;
  const { username, nome, driveFolderName, instagramUserId, driveFolderId } = req.body;

  if (!username || !driveFolderName) {
    return res.status(400).json({
      error: 'Nome de usuário do Instagram (@) e Nome da Pasta no Google Drive são obrigatórios.',
    });
  }

  const cleanUsername = username.replace('@', '').trim().toLowerCase();
  const cleanFolder = driveFolderName.trim();
  const knownFolder = driveFoldersMap.get(cleanFolder.toLowerCase());
  const resolvedFolderId = driveFolderId || knownFolder?.id || cleanFolder;

  // Se já existir conta com o mesmo username ou instagramUserId, atualiza sem duplicar
  const existingIdx = tenants.findIndex(
    (t) =>
      t.username.toLowerCase() === cleanUsername ||
      (instagramUserId && t.instagramUserId === instagramUserId)
  );

  if (existingIdx !== -1) {
    tenants[existingIdx].nome = nome || tenants[existingIdx].nome || cleanUsername;
    tenants[existingIdx].driveFolderName = cleanFolder;
    tenants[existingIdx].driveFolderId = resolvedFolderId;
    tenants[existingIdx].status = 'APROVADO';
    tenants[existingIdx].approvedAt = tenants[existingIdx].approvedAt || new Date().toISOString();
    tenants[existingIdx].lastSyncAt = new Date().toISOString();
    saveDatabaseToDisk();

    return res.status(200).json({
      success: true,
      message: `Conta @${tenants[existingIdx].username} atualizada e associada à pasta "${cleanFolder}".`,
      tenant: sanitizeTenantForClient(tenants[existingIdx], encKey),
    });
  }

  const newTenant: TenantAccount = {
    id: `tenant_${cleanUsername}_${Date.now()}`,
    username: cleanUsername,
    nome: nome || cleanUsername,
    instagramUserId: instagramUserId || `ig_usr_${Date.now()}`,
    driveFolderName: cleanFolder,
    driveFolderId: resolvedFolderId,
    status: 'APROVADO',
    approvedAt: new Date().toISOString(),
    lastSyncAt: new Date().toISOString(),
  };

  tenants.push(newTenant);

  rawDriveItems = rawDriveItems.map((item) => {
    if (
      (item.driveFolderName && item.driveFolderName.toLowerCase() === cleanFolder.toLowerCase()) ||
      (item.pastaClienteId && item.pastaClienteId === resolvedFolderId)
    ) {
      return { ...item, tenantId: newTenant.id };
    }
    return item;
  });

  postGroups = applyPostGroupsMeta(groupAndSortDriveItems(rawDriveItems));
  saveDatabaseToDisk();

  return res.status(201).json({
    success: true,
    message: `Conta @${newTenant.username} associada à pasta "${newTenant.driveFolderName}" com sucesso.`,
    tenant: sanitizeTenantForClient(newTenant, encKey),
  });
});

// Atualizar pasta do Drive vinculada a uma conta do Instagram
app.put('/api/tenants/:id', requireAuth, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const { JWT_SECRET } = getEnv();
  const encKey = getTokenEncryptionKey() || JWT_SECRET;
  const { id } = req.params;
  const { driveFolderName, driveFolderId, nome, username, status } = req.body;

  const tenantIndex = tenants.findIndex((t) => t.id === id);
  if (tenantIndex === -1) {
    return res.status(404).json({ error: 'Conta não encontrada.' });
  }

  const oldFolder = tenants[tenantIndex].driveFolderName;
  const cleanFolder = driveFolderName ? driveFolderName.trim() : undefined;
  const knownFolder = cleanFolder ? driveFoldersMap.get(cleanFolder.toLowerCase()) : undefined;
  const resolvedFolderId =
    driveFolderId || knownFolder?.id || tenants[tenantIndex].driveFolderId || cleanFolder;

  tenants[tenantIndex] = {
    ...tenants[tenantIndex],
    ...(cleanFolder
      ? {
          driveFolderName: cleanFolder,
          driveFolderId: resolvedFolderId,
        }
      : {}),
    ...(nome ? { nome } : {}),
    ...(username ? { username: username.replace('@', '').trim() } : {}),
    ...(status ? { status } : {}),
  };

  if (cleanFolder && cleanFolder !== oldFolder) {
    rawDriveItems = rawDriveItems.map((item) => {
      if (
        item.tenantId === id ||
        (oldFolder && item.driveFolderName === oldFolder) ||
        (item.driveFolderName && item.driveFolderName.toLowerCase() === cleanFolder.toLowerCase()) ||
        (resolvedFolderId && item.pastaClienteId === resolvedFolderId)
      ) {
        return {
          ...item,
          tenantId: id,
          driveFolderName: cleanFolder,
        };
      }
      return item;
    });
    postGroups = applyPostGroupsMeta(groupAndSortDriveItems(rawDriveItems));
  }

  saveDatabaseToDisk();

  return res.json({
    success: true,
    message: `Configurações da conta @${tenants[tenantIndex].username} atualizadas.`,
    tenant: sanitizeTenantForClient(tenants[tenantIndex], encKey),
  });
});

// Remover conta tenant
app.delete('/api/tenants/:id', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const target = tenants.find((t) => t.id === id);
  tenants = tenants.filter((t) => t.id !== id);
  if (target?.driveFolderName) {
    const key = target.driveFolderName.toLowerCase();
    const folderEntry = driveFoldersMap.get(key);
    const stillUsedByTenant = tenants.some((t) => t.driveFolderName?.toLowerCase() === key);
    const stillUsedByPost = rawDriveItems.some((i) => i.driveFolderName?.toLowerCase() === key);
    if (folderEntry && !folderEntry.url && !stillUsedByTenant && !stillUsedByPost) {
      driveFoldersMap.delete(key);
    }
  }
  if (!testStateOverrideActive) {
    await deleteInstagramAccountFromDb(id);
  }
  saveDatabaseToDisk();
  return res.json({ success: true, message: 'Conta removida com sucesso.', deletedId: id });
});

// ----------------------------------------------------
// 2B. ADMIN: PRÉVIA E RESET CONTROLADO DE REGISTROS DE TESTE
// ----------------------------------------------------
app.get('/api/admin/test-records/preview', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const preview = await getTestRecordsPreviewFromDb();
    return res.json({
      success: true,
      ...preview,
      safetyGuarantees: {
        accountsUntouched: 'Nenhuma conta conectada do Instagram, token de acesso ou credencial será modificada ou removida.',
        usersUntouched: 'Nenhum usuário ou empresa cadastrada será tocada.',
        publishedPostsProtected: 'Posts reais já publicados com sucesso no Instagram não serão alterados.',
        backupSnapshotEnabled: 'Um snapshot de segurança é gravado nos logs operacionais antes de qualquer reset.',
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'Falha ao gerar prévia de registros de teste.' });
  }
});

app.post('/api/admin/test-records/reset', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { confirm, scope = 'ALL_CANDIDATES', selectedIds = [], action = 'ARCHIVE_TESTS' } = req.body || {};
  if (confirm !== true) {
    return res.status(400).json({
      success: false,
      error: 'Confirmação obrigatória ausente. Envie "confirm: true" no corpo da requisição para autorizar a limpeza.',
    });
  }

  const validActions = [
    'ARCHIVE_TESTS',
    'RESET_ATTEMPTS',
    'CANCEL_SCHEDULES',
    'RESET_PUBLISHED_TO_PENDING',
    'RESET_ALL_POSTS_TO_UNPUBLISHED',
  ];
  if (!validActions.includes(action)) {
    return res.status(400).json({
      success: false,
      error: `Ação inválida. Escolha entre: ${validActions.join(', ')}.`,
    });
  }

  try {
    const result = await resetTestRecordsInDb({
      scope,
      selectedIds,
      action,
      adminUser: req.user?.email || req.user?.nome || 'Admin',
    });

    await syncStateFromPostgres(true);

    return res.json({
      success: true,
      ...result,
      safetyGuarantees: {
        accountsUntouched: true,
        tokensPreserved: true,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'Falha ao executar reset de registros de teste.' });
  }
});

// ----------------------------------------------------
// 2C. ADMIN: STATUS DAS INTEGRAÇÕES E ÁREA DE TESTE DE APIS
// ----------------------------------------------------
app.get('/api/admin/integrations/status', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  const dbConn = await checkDatabaseConnection();
  const tableCounts = await getDatabaseTableCounts().catch(() => ({}));
  const env = getEnv();
  const geminiConfig = getGeminiConfigStatus();

  const connectedAccountsCount = tenants.filter((t) => t.hasValidToken || t.connectionStatus === 'CONECTADO').length;

  return res.json({
    postgres: {
      connected: dbConn.connected,
      latencyMs: dbConn.latencyMs,
      driver: dbConn.driver,
      railwayConfigured: dbConn.railwayConfigured,
      tables: tableCounts,
    },
    googleDrive: {
      connected: Boolean(env.GOOGLE_APPS_SCRIPT_URL),
      webhookUrl: env.GOOGLE_APPS_SCRIPT_URL || null,
    },
    instagram: {
      configured: Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET),
      appId: env.INSTAGRAM_APP_ID || null,
      redirectUri: getEffectiveInstagramRedirectUri(),
      connectedAccountsCount,
    },
    gemini: {
      connected: geminiConfig.apiKeyConfigured,
      primaryModel: geminiConfig.primaryModel,
    },
  });
});

app.post('/api/admin/integrations/test/postgres', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  const start = Date.now();
  try {
    const dbRes = await dbQuery<{ server_time: string; posts_count: string }>(
      `SELECT NOW() as server_time, (SELECT COUNT(*) FROM posts) as posts_count`
    );
    const latencyMs = Date.now() - start;
    return res.json({
      success: true,
      latencyMs,
      serverTime: dbRes.rows[0]?.server_time,
      postsCount: Number(dbRes.rows[0]?.posts_count || 0),
      message: `PostgreSQL conectado com sucesso (${latencyMs}ms). Total de postagens no banco: ${dbRes.rows[0]?.posts_count}.`,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: `Erro ao comunicar com PostgreSQL: ${err.message}`,
    });
  }
});

app.post('/api/admin/integrations/test/drive', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  const { GOOGLE_APPS_SCRIPT_URL, WEBHOOK_SECRET_TOKEN } = getEnv();
  if (!GOOGLE_APPS_SCRIPT_URL) {
    return res.status(400).json({
      success: false,
      error: 'GOOGLE_APPS_SCRIPT_URL não está configurada nas variáveis de ambiente.',
    });
  }
  const start = Date.now();
  try {
    const response = await fetch(GOOGLE_APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WEBHOOK_SECRET_TOKEN}`,
      },
      body: JSON.stringify({
        action: 'PING',
        timestamp: new Date().toISOString(),
      }),
    });
    const latencyMs = Date.now() - start;
    return res.json({
      success: response.ok,
      httpStatus: response.status,
      latencyMs,
      message: response.ok
        ? `Google Drive / Webhook Apps Script respondendo normalmente (${latencyMs}ms)!`
        : `Google Apps Script respondeu com código HTTP ${response.status}`,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: `Falha na requisição para o Google Apps Script: ${err.message}`,
    });
  }
});

app.post('/api/admin/integrations/test/instagram', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  const { INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET } = getEnv();
  const redirectUri = getEffectiveInstagramRedirectUri();

  if (!INSTAGRAM_APP_ID || !INSTAGRAM_APP_SECRET) {
    return res.status(400).json({
      success: false,
      error: 'INSTAGRAM_APP_ID ou INSTAGRAM_APP_SECRET ausentes no servidor.',
    });
  }

  const connectedTenants = tenants.filter((t) => t.hasValidToken || t.connectionStatus === 'CONECTADO');

  return res.json({
    success: true,
    appId: INSTAGRAM_APP_ID,
    redirectUri,
    connectedAccountsCount: connectedTenants.length,
    connectedAccounts: connectedTenants.map((t) => ({ username: t.username, status: t.connectionStatus })),
    message: `Instagram Graph API configurada (App ID: ${INSTAGRAM_APP_ID}). ${connectedTenants.length} conta(s) ativa(s) conectada(s).`,
  });
});

app.post('/api/admin/integrations/test/gemini', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  const geminiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const configuredModel = String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();

  if (!geminiKey || geminiKey === 'MY_GEMINI_API_KEY') {
    return res.status(400).json({
      success: false,
      error: 'A variável GEMINI_API_KEY não está configurada no servidor.',
    });
  }

  const start = Date.now();
  try {
    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    const response = await ai.models.generateContent({
      model: configuredModel,
      contents: 'Responda apenas com a palavra "OK".',
    });

    const latencyMs = Date.now() - start;
    const text = String(response.text || '').trim();

    return res.json({
      success: true,
      latencyMs,
      modelUsed: configuredModel,
      response: text,
      message: `Gemini API (${configuredModel}) conectada e respondendo com sucesso (${latencyMs}ms)!`,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: `Erro ao se comunicar com a Gemini API: ${err.message}`,
    });
  }
});

// ----------------------------------------------------
// 3. LISTAGEM DE POSTS & SINCRONIZAÇÃO COM GOOGLE APPS SCRIPT
// ----------------------------------------------------
app.get('/api/posts', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  loadDatabaseFromDisk();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const user = req.user!;
  const { folders: availableFolders, folderDetails } = getKnownFoldersList();
  let filteredPosts = [...postGroups];

  // Identifica mídias ocultadas individualmente pelo usuário atual
  let hiddenPostIds = new Set<string>();
  if (user && user.id && !testStateOverrideActive) {
    try {
      const hiddenList = await getHiddenPostIdsForUserFromDb(user.id);
      hiddenPostIds = new Set(Array.isArray(hiddenList) ? hiddenList : []);
    } catch (e: any) {
      console.warn('[Hidden Media] Aviso ao recuperar mídias ocultas:', e?.message);
    }
  }

  const includeArchivedTests = req.query.includeArchivedTests === 'true' && user.role === 'ADMIN';

  if (user.role === 'TENANT') {
    const activeTenant = tenants.find(
      (t) =>
        t.id === user.tenantId ||
        (user.instagramUsername &&
          t.username.toLowerCase() === user.instagramUsername.toLowerCase())
    );
    const effectiveStatus = activeTenant?.status || user.status;
    const rawFolderName = activeTenant?.driveFolderName || user.driveFolderName || '';
    const effectiveFolderName =
      rawFolderName.toLowerCase() !== 'ato social midia' ? rawFolderName : '';
    const effectiveFolderId = activeTenant?.driveFolderId || user.driveFolderId;

    if (
      effectiveStatus === 'PENDENTE' ||
      effectiveStatus === 'AGUARDANDO_APROVACAO' ||
      !effectiveFolderName
    ) {
      return res.json({
        posts: [],
        stats: { total: 0, pendentes: 0, agendados: 0, publicados: 0, reprovados: 0 },
        availableFolders,
        folderDetails,
        waitingApproval: true,
        message: 'Conta aguardando aprovação do administrador para vincular pasta do Google Drive.',
        activeTenant: activeTenant || null,
      });
    }

    filteredPosts = postGroups.filter((p) => {
      if (p.tenantId && user.tenantId && p.tenantId === user.tenantId) return true;
      if (effectiveFolderId && p.pastaClienteId && p.pastaClienteId === effectiveFolderId) return true;
      const postFolder = p.pastaClienteNome || p.driveFolderName || '';
      if (postFolder && effectiveFolderName && postFolder.toLowerCase() === effectiveFolderName.toLowerCase()) {
        return true;
      }
      return false;
    });
  } else if (user.role === 'ADMIN') {
    const queryFolder = String(req.query.pastaClienteNome || req.query.folderName || '').trim();
    const queryFolderId = String(req.query.pastaClienteId || '').trim();
    const queryTenantId = String(req.query.tenantId || '').trim();

    if (
      queryFolder &&
      queryFolder !== 'ALL' &&
      queryFolder.toLowerCase() !== 'ato social midia'
    ) {
      filteredPosts = postGroups.filter((p) => {
        const postFolder = (p.pastaClienteNome || p.driveFolderName || '').trim();
        return (
          postFolder.toLowerCase() === queryFolder.toLowerCase() ||
          (queryFolderId && p.pastaClienteId === queryFolderId)
        );
      });
    } else if (queryFolderId && queryFolderId !== 'ALL') {
      filteredPosts = postGroups.filter((p) => p.pastaClienteId === queryFolderId);
    } else if (queryTenantId && queryTenantId !== 'ALL') {
      const targetTenant = tenants.find((t) => t.id === queryTenantId);
      if (targetTenant && (targetTenant.driveFolderName || targetTenant.driveFolderId)) {
        filteredPosts = postGroups.filter((p) => {
          const postFolder = (p.pastaClienteNome || p.driveFolderName || '').trim();
          return (
            p.tenantId === targetTenant.id ||
            (targetTenant.driveFolderId && p.pastaClienteId === targetTenant.driveFolderId) ||
            (postFolder &&
              targetTenant.driveFolderName &&
              postFolder.toLowerCase() === targetTenant.driveFolderName.toLowerCase())
          );
        });
      } else {
        // Fallback: if queryTenantId is actually a folder name (e.g. "Ato"), filter by folder name
        filteredPosts = postGroups.filter((p) => {
          const postFolder = (p.pastaClienteNome || p.driveFolderName || '').trim();
          return (
            postFolder.toLowerCase() === queryTenantId.toLowerCase() ||
            p.pastaClienteId === queryTenantId ||
            p.tenantId === queryTenantId
          );
        });
      }
    }
    // Se nenhum filtro específico for enviado (Visão Admin Geral), retorna TODOS os postGroups
  }

  // Busca o mapa global de mídias ocultadas/apagadas por qualquer cliente
  let allHiddenPostsMap = new Map<string, { userId: string; hiddenAt: string }>();
  if (!testStateOverrideActive) {
    try {
      allHiddenPostsMap = await getAllHiddenPostsMapFromDb();
    } catch (e: any) {
      console.warn('[Hidden Media Map] Aviso ao buscar mapa global de mídias ocultas:', e?.message);
    }
  }

  // Anota no objeto do post se ele foi apagado pelo cliente
  filteredPosts = filteredPosts.map((p) => {
    const hiddenInfo = allHiddenPostsMap.get(p.id);
    const isHiddenForCurrentUser = hiddenPostIds.has(p.id);
    if (hiddenInfo || isHiddenForCurrentUser) {
      return {
        ...p,
        isDeletedByClient: true,
        deletedByClientAt: hiddenInfo?.hiddenAt || new Date().toISOString(),
      };
    }
    return p;
  });

  // Filtro de isolamento de visão:
  // - TENANT (cliente): esconde totalmente mídias que o cliente apagou/ocultou
  // - ADMIN: MANTÉM todas as mídias visíveis, marcadas com a etiqueta/badge "Apagado pelo Cliente"
  if (user.role === 'TENANT') {
    filteredPosts = filteredPosts.filter((p) => !hiddenPostIds.has(p.id) && !(p as any).isDeletedByClient);
  } else if (user.role === 'ADMIN') {
    filteredPosts = filteredPosts.filter((p) => {
      if (!includeArchivedTests && p.isArchivedTest) return false;
      return true;
    });
  }

  return res.json({
    posts: filteredPosts,
    stats: {
      total: filteredPosts.length,
      pendentes: filteredPosts.filter(
        (p) =>
          p.status === 'PENDENTE' ||
          p.status === 'CRIADO' ||
          p.status === 'PENDENTE_APROVACAO' ||
          p.status === 'APROVADO'
      ).length,
      agendados: filteredPosts.filter(
        (p) =>
          p.status === 'AGENDADO' ||
          p.status === 'PUBLICANDO' ||
          p.status === 'RECONEXAO_NECESSARIA' ||
          p.status === 'FALHA_PUBLICACAO'
      ).length,
      publicados: filteredPosts.filter((p) => p.status === 'PUBLICADO').length,
      reprovados: filteredPosts.filter(
        (p) => p.status === 'REPROVADO' || p.status === 'CANCELADO'
      ).length,
    },
    availableFolders,
    folderDetails,
    activeTenant:
      user.role === 'TENANT'
        ? tenants.find((t) => t.id === user.tenantId)
          ? sanitizeTenantForClient(tenants.find((t) => t.id === user.tenantId)!, getEnv().JWT_SECRET)
          : null
        : null,
  });
});

// Listar pastas de empresas do Google Drive (via POST SINCRONIZAR_TUDO / LISTAR_PASTAS_CLIENTES no GOOGLE_APPS_SCRIPT_URL)
app.get('/api/drive/folders', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  const syncResult = await syncWithAppsScript('SINCRONIZAR_TUDO');
  const { folders, folderDetails } = getKnownFoldersList();
  return res.json({
    folders,
    folderDetails,
    pastas: syncResult.data?.pastas || folderDetails,
    lotes: syncResult.data?.lotes || [],
    syncOk: syncResult.ok,
    syncError: syncResult.error || null,
  });
});

// Botão "Sincronizar Drive" no Painel Admin / Dashboard (Envia acao: "SINCRONIZAR_TUDO")
app.post('/api/posts/sync-drive', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  const syncResult = await syncWithAppsScript('SINCRONIZAR_TUDO', { force: true });
  const { folders, folderDetails } = getKnownFoldersList();

  if (!syncResult.ok) {
    return res.status(502).json({
      success: false,
      error: syncResult.error || 'Falha ao sincronizar com o Google Apps Script.',
      upstreamStatus: syncResult.status,
      rawResponsePreview: syncResult.rawResponse ? syncResult.rawResponse.substring(0, 500) : null,
      folders,
      folderDetails,
      pastas: [],
      lotes: [],
      totalArquivos: 0,
      totalPosts: postGroups.length,
    });
  }

  const lotes: any[] = Array.isArray(syncResult.data?.lotes) ? syncResult.data.lotes : [];
  const pastas: any[] = Array.isArray(syncResult.data?.pastas) ? syncResult.data.pastas : folderDetails;
  const totalArquivos = lotes.reduce(
    (acc: number, lote: any) => acc + (Array.isArray(lote?.arquivos) ? lote.arquivos.length : 0),
    0
  );

  return res.json({
    success: true,
    sucesso: true,
    message: `Sincronização concluída com sucesso (${folders.length} pasta(s), ${totalArquivos} criativo(s)).`,
    pastas,
    lotes,
    totalArquivos,
    folders,
    folderDetails,
    data: syncResult.data,
    totalPosts: postGroups.length,
    timestamp: new Date().toISOString(),
  });
});

// Upload manual de nova mídia pelo cliente (Dispara UPLOAD_MIDIA com base64 sem prefixo para GOOGLE_APPS_SCRIPT_URL)
app.post('/api/posts/upload', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  getEnv();
  console.log("DEBUG ENV - URL:", process.env.GOOGLE_APPS_SCRIPT_URL);

  const scriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL || '';
  const secretToken = process.env.WEBHOOK_SECRET_TOKEN || '';

  const { nome, categoria, viewUrl, thumbnailUrl, folderName, mimeType, base64Data, pastaClienteId: bodyFolderId } =
    req.body;

  if (!nome) {
    return res.status(400).json({ error: 'Nome do arquivo é obrigatório.' });
  }

  const rawFolder = (folderName || req.user?.driveFolderName || '').trim();
  const firstKnownFolder = Array.from(driveFoldersMap.values()).find(
    (f) => f.nome && f.nome.toLowerCase() !== 'ato social midia'
  );
  const targetFolderName =
    rawFolder && rawFolder !== 'ALL' && rawFolder.toLowerCase() !== 'ato social midia'
      ? rawFolder
      : firstKnownFolder?.nome || 'Ato';

  const targetTenant = tenants.find(
    (t) =>
      (req.user?.tenantId && t.id === req.user.tenantId) ||
      (t.driveFolderName && t.driveFolderName.toLowerCase() === targetFolderName.toLowerCase())
  );
  const knownFolder = driveFoldersMap.get(targetFolderName.toLowerCase());
  const pastaClienteId =
    bodyFolderId ||
    targetTenant?.driveFolderId ||
    req.user?.driveFolderId ||
    knownFolder?.id ||
    targetFolderName;

  let cleanBase64 = String(base64Data || '');
  if (cleanBase64.includes('base64,')) {
    cleanBase64 = cleanBase64.split('base64,')[1];
  }

  const resolvedMimeType = mimeType || 'image/png';
  const finalViewUrl =
    viewUrl || (cleanBase64 ? `data:${resolvedMimeType};base64,${cleanBase64}` : '');

  const gasPayload = {
    token: secretToken,
    acao: 'UPLOAD_MIDIA',
    pastaClienteId,
    nomeArquivo: nome.trim(),
    mimeType: resolvedMimeType,
    base64Data: cleanBase64,
  };

  let remoteDriveFileId = '';
  let remoteViewUrl = '';

  if (scriptUrl && scriptUrl.startsWith('http')) {
    try {
      const gasResp = await fetch(scriptUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        redirect: 'follow',
        body: JSON.stringify(gasPayload),
      });

      const rawResponse = await gasResp.text();
      console.log("RESPOSTA CRUA DO SCRIPT:", rawResponse);

      try {
        const gasJson = JSON.parse(rawResponse);
        if (gasJson && typeof gasJson === 'object') {
          remoteDriveFileId = gasJson.driveFileId || gasJson.fileId || gasJson.id || '';
          remoteViewUrl = gasJson.viewUrl || gasJson.url || '';
        }
      } catch {
        // Resposta não era JSON
      }
    } catch (e: any) {
      console.warn('[Apps Script] Aviso ao enviar UPLOAD_MIDIA:', e.message);
    }
  }

  const newItem: DriveImageItem = {
    driveFileId: remoteDriveFileId || `upload_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    nome: nome.trim(),
    categoria: normalizeCategoria(categoria, 1),
    loteNome: nome.replace(/\.[^/.]+$/, ''),
    viewUrl: finalViewUrl || remoteViewUrl,
    thumbnailUrl: thumbnailUrl || finalViewUrl || remoteViewUrl,
    dataCriacao: new Date().toISOString(),
    status: 'APROVADO',
    isApprovedForSchedule: true,
    approvedAt: new Date().toISOString(),
    tenantId: targetTenant?.id || req.user?.tenantId,
    driveFolderName: targetFolderName,
    pastaClienteNome: targetFolderName,
    pastaClienteId,
    origem: 'UPLOAD',
    createdByUserId: req.user?.id,
  };

  rawDriveItems.push(newItem);
  postGroups = applyPostGroupsMeta(groupAndSortDriveItems(rawDriveItems));
  saveDatabaseToDisk();

  return res.json({
    success: true,
    message: 'Mídia enviada ao Google Drive e aprovada para agendamento/publicação!',
    item: newItem,
    gasPayloadSent: {
      acao: gasPayload.acao,
      pastaClienteId: gasPayload.pastaClienteId,
      nomeArquivo: gasPayload.nomeArquivo,
      mimeType: gasPayload.mimeType,
    },
    totalPosts: postGroups.length,
  });
});

// ----------------------------------------------------
// 4. GOOGLE APPS SCRIPT WEBHOOK PÚBLICO (POST /api/webhooks/drive-sync)
// ----------------------------------------------------
app.post('/api/webhooks/drive-sync', requireWebhookOrUserAuth, (req: AuthenticatedRequest, res: Response) => {
  // 1. Log obrigatório logo no início da rota para auditoria completa do payload recebido
  console.log("PAYLOAD RECEBIDO:", JSON.stringify(req.body, null, 2));

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(
      LAST_WEBHOOK_FILE_PATH,
      JSON.stringify({ receivedAt: new Date().toISOString(), body: req.body }, null, 2),
      'utf8'
    );
  } catch {}

  const hasLotesArray = Array.isArray(req.body?.lotes);
  const hasItemsArray = Array.isArray(req.body?.items);
  const hasFoldersArray =
    Array.isArray(req.body?.pastas) ||
    Array.isArray(req.body?.folders) ||
    Array.isArray(req.body?.empresas) ||
    Array.isArray(req.body?.clientes);
  const isDirectItem = Boolean(req.body?.driveFileId || req.body?.nome || Array.isArray(req.body?.arquivos));

  if (!hasLotesArray && !hasItemsArray && !hasFoldersArray && !isDirectItem && !Array.isArray(req.body)) {
    return res.status(400).json({
      sucesso: false,
      error: 'Payload inválido: a propriedade "lotes" deve ser um array contendo os lotes e seus "arquivos".',
    });
  }

  // 2. Processa req.body.lotes e, dentro de cada lote, o array arquivos
  const result = processIncomingPayload(req.body);

  console.log(
    `[Webhook Drive Sync] Processados ${result.processedLotesCount} lote(s) e ${result.insertedOrUpdatedFilesCount} arquivo(s). Total de grupos/criativos no banco: ${postGroups.length}.`
  );

  return res.status(200).json({
    sucesso: true,
    success: true,
    evento: req.body?.evento || 'NOVAS_ARTES_SOCIAL_MEDIA',
    message: `${result.insertedOrUpdatedFilesCount} arquivo(s) em ${result.processedLotesCount} lote(s) sincronizado(s) com status PENDENTE.`,
    processedLotesCount: result.processedLotesCount,
    receivedCount: result.insertedOrUpdatedFilesCount,
    foldersFound: result.foldersFound,
    unmatchedFolders: result.unmatchedFolders,
    totalPosts: postGroups.length,
  });
});

// ----------------------------------------------------
// 4B. META WEBHOOK VERIFICATION & EVENT RECEIVER (/api/webhooks/meta)
// ----------------------------------------------------
app.get('/api/webhooks/meta', (req: Request, res: Response) => {
  const { META_VERIFY_TOKEN } = getEnv();

  const hubObj = (req.query.hub as Record<string, any>) || {};
  const mode = (req.query['hub.mode'] ?? hubObj.mode) as string | undefined;
  const challenge = (req.query['hub.challenge'] ?? hubObj.challenge) as string | undefined;
  const verifyToken = (req.query['hub.verify_token'] ?? hubObj.verify_token) as string | undefined;

  if (verifyToken && verifyToken === META_VERIFY_TOKEN && (!mode || mode === 'subscribe')) {
    console.log('[Meta Webhook] Verificação concluída com sucesso (GET /api/webhooks/meta).');
    return res
      .status(200)
      .set('Content-Type', 'text/plain; charset=utf-8')
      .send(String(challenge ?? ''));
  }

  console.warn('[Meta Webhook] Falha na verificação de token:', { mode, verifyToken });
  return res.status(403).type('text/plain').send('Forbidden: verify_token inválido');
});

app.post('/api/webhooks/meta', (req: Request, res: Response) => {
  console.log('[Meta Webhook] Evento recebido (POST /api/webhooks/meta):', JSON.stringify(req.body));
  return res.status(200).type('text/plain').send('EVENT_RECEIVED');
});

// ----------------------------------------------------
// 5. REJECTION FLOW (REPROVAR_E_MOVER -> GOOGLE_APPS_SCRIPT_URL)
// ----------------------------------------------------
app.post('/api/posts/:id/reject', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  getEnv();
  console.log("DEBUG ENV - URL:", process.env.GOOGLE_APPS_SCRIPT_URL);

  const scriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL || '';
  const secretToken = process.env.WEBHOOK_SECRET_TOKEN || '';

  const { id } = req.params;
  const { tags = [], motivo = '', pastaClienteId: customPastaClienteId } = req.body;

  const targetIndex = postGroups.findIndex((p) => p.id === id);
  if (targetIndex === -1) {
    return res.status(404).json({ error: 'Criativo ou lote não encontrado.' });
  }

  const targetPost = postGroups[targetIndex];

  if (!canUserAccessPost(req.user, targetPost)) {
    return res.status(403).json({
      error: 'Acesso negado: você não tem permissão para reprovar criativos de outra empresa.',
    });
  }

  const targetTenant =
    tenants.find((t) => t.id === targetPost.tenantId) ||
    tenants.find(
      (t) =>
        (targetPost.pastaClienteId && t.driveFolderId === targetPost.pastaClienteId) ||
        (t.driveFolderName &&
          targetPost.driveFolderName &&
          t.driveFolderName.toLowerCase() === targetPost.driveFolderName.toLowerCase())
    );

  const knownFolder = targetPost.driveFolderName
    ? driveFoldersMap.get(targetPost.driveFolderName.toLowerCase())
    : undefined;

  const pastaClienteId =
    customPastaClienteId ||
    targetPost.pastaClienteId ||
    targetTenant?.driveFolderId ||
    knownFolder?.id ||
    targetPost.driveFolderName ||
    'folder_ato_midia_01';

  const driveFileId = targetPost.items[0]?.driveFileId || targetPost.id;
  const driveFileIds = targetPost.items.map((i) => i.driveFileId);

  const originalFileName = targetPost.items[0]?.nome || targetPost.nome || 'arte.png';
  const novoNomeArquivo = generateRejectedFilename(tags, motivo, originalFileName);

  const rejectionFeedback = {
    tags: Array.isArray(tags) ? tags : [],
    motivo: String(motivo || '').trim(),
    novoNomeArquivo,
    dataReprovacao: new Date().toISOString(),
    pastaClienteId,
    driveFileId,
  };

  try {
    const memPath = path.join(__dirname, '_MEMORIA_REPROVACOES.md');
    const memoLine = `- [${new Date().toISOString()}] Arquivo: **${originalFileName}** -> Novo Nome: **${novoNomeArquivo}** | Motivo: "${motivo}" | Tags: ${JSON.stringify(tags)} | Pasta: ${targetPost.driveFolderName || targetTenant?.driveFolderName || 'Geral'}\n`;
    fs.appendFileSync(memPath, memoLine, 'utf8');
  } catch (err: any) {
    console.warn('Erro ao atualizar _MEMORIA_REPROVACOES.md:', err.message);
  }

  const gasPayload = {
    token: secretToken,
    acao: 'REPROVAR_E_MOVER',
    driveFileId,
    pastaClienteId,
    tags: rejectionFeedback.tags,
    motivo: rejectionFeedback.motivo,
    novoNomeArquivo,
    driveFileIds,
    driveFolderName: targetPost.driveFolderName || targetTenant?.driveFolderName,
    timestamp: rejectionFeedback.dataReprovacao,
  };

  let gasDispatchStatus = 'SIMULADO_LOCAL';

  if (scriptUrl && scriptUrl.startsWith('http')) {
    try {
      const gasResponse = await fetch(scriptUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        redirect: 'follow',
        body: JSON.stringify(gasPayload),
      });
      const rawResponse = await gasResponse.text();
      console.log("RESPOSTA CRUA DO SCRIPT:", rawResponse);
      gasDispatchStatus = gasResponse.ok ? 'ENVIADO_COM_SUCESSO' : `GAS_HTTP_${gasResponse.status}`;
    } catch (gasErr: any) {
      console.warn('[Google Apps Script] Aviso ao acionar Web App remoto de reprovação:', gasErr.message);
      gasDispatchStatus = `FALHA_ENVIO: ${gasErr.message}`;
    }
  }

  await recordRejectionInDb({
    postId: targetPost.id,
    driveFileId,
    pastaClienteId,
    pastaNome:
      targetPost.driveFolderName || targetTenant?.driveFolderName || 'Ato',
    originalFilename: originalFileName,
    novoNomeArquivo,
    tags: rejectionFeedback.tags,
    motivo: rejectionFeedback.motivo,
    rejectedBy:
      req.user?.email || req.user?.instagramUsername || req.user?.nome || 'Cliente/Admin',
    dataReprovacao: rejectionFeedback.dataReprovacao,
    renameItemFn: (itemName) => generateRejectedFilename(tags, motivo, itemName),
  });

  await syncStateFromPostgres();
  const updatedPost =
    postGroups.find((p) => p.id === targetPost.id) || {
      ...targetPost,
      status: 'REPROVADO',
      rejectionFeedback,
    };

  return res.json({
    success: true,
    message: `Criativo "${targetPost.nome}" reprovado com sucesso. Movido para Reprovados e registrado no histórico.`,
    post: updatedPost,
    novoNomeArquivo,
    rejectionFeedback,
    gasWebhookResult: {
      status: gasDispatchStatus,
      payload: gasPayload,
    },
  });
});

// Suporte para exclusão direta (DELETE /api/posts/:id) com envio para lixeira do Google Drive e PostgreSQL
app.delete('/api/posts/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { force = false, moveToTrash = true } = req.body || {};

  const targetPost = postGroups.find((p) => p.id === id) || (await getPostGroupByIdFromDb(id));
  if (!targetPost) {
    return res.status(404).json({ error: 'Post ou lote não encontrado.' });
  }

  if (!canUserAccessPost(req.user, targetPost)) {
    return res.status(403).json({
      error: 'Acesso negado: você não tem permissão para excluir criativos de outra empresa.',
    });
  }

  // Guard: Mídias oficiais sincronizadas do Drive NÃO podem ser excluídas definitivamente
  const isUpload =
    targetPost.origem === 'UPLOAD' ||
    targetPost.id.startsWith('upload_') ||
    targetPost.items.some((i) => i.driveFileId?.startsWith('upload_') || i.origem === 'UPLOAD');

  if (!isUpload && targetPost.origem === 'DRIVE_SYNC') {
    return res.status(400).json({
      error: 'Mídias oficiais sincronizadas do Google Drive não podem ser excluídas definitivamente. Utilize a opção "Ocultar mídia" para removê-la da sua visualização sem afetar o arquivo original no Drive.',
      isOfficialMedia: true,
    });
  }

  // 1. Verificação de agendamentos ativos ou publicações em andamento
  if (targetPost.status === 'PUBLICANDO') {
    return res.status(400).json({
      error: 'Não é possível excluir um criativo que está sendo publicado no momento.',
    });
  }

  if (targetPost.status === 'AGENDADO' && !force) {
    return res.status(400).json({
      error: 'Este criativo possui uma publicação agendada ativa. Cancele o agendamento antes de excluir ou confirme a exclusão forçada.',
      requiresConfirmation: true,
      scheduledAt: targetPost.scheduledAt,
    });
  }

  const driveFileIds = targetPost.items.map((i) => i.driveFileId);
  const primaryFileId = targetPost.items[0]?.driveFileId || targetPost.id;

  // 2. Envio do arquivo para a lixeira do Google Drive via Google Apps Script
  let driveTrashDispatched = false;
  if (moveToTrash) {
    try {
      const scriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL || '';
      const secretToken = process.env.WEBHOOK_SECRET_TOKEN || '';
      if (scriptUrl && scriptUrl.startsWith('http')) {
        await fetch(scriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: secretToken,
            acao: 'MOVER_LIXEIRA',
            driveFileId: primaryFileId,
            driveFileIds,
            postId: id,
            nomeArquivo: targetPost.nome,
            pastaClienteId: targetPost.pastaClienteId,
            driveFolderName: targetPost.driveFolderName,
            solicitante: req.user?.email || req.user?.nome || 'Admin',
            timestamp: new Date().toISOString(),
          }),
        }).catch((err) => {
          console.warn('[Google Drive Trash] Aviso ao mover arquivo para lixeira:', err?.message);
        });
        driveTrashDispatched = true;
      }
    } catch (err: any) {
      console.warn('[Google Drive Trash] Falha ao comunicar com Apps Script:', err?.message);
    }
  }

  // 3. Exclusão no banco PostgreSQL
  if (!testStateOverrideActive) {
    await deletePostGroupFromDb(id);
    await logOperationalActionInDb({
      action: 'DELETE_CREATIVE',
      tenantId: targetPost.tenantId || null,
      postId: id,
      message: `Criativo "${targetPost.nome}" excluído por ${req.user?.email || req.user?.nome}. Enviado para a lixeira do Drive: ${driveTrashDispatched}.`,
      payload: { driveFileIds, driveTrashDispatched },
    }).catch(() => {});
  }

  // 4. Atualização de estado em memória
  rawDriveItems = rawDriveItems.filter((item) => !driveFileIds.includes(item.driveFileId));
  postGroups = postGroups.filter((p) => p.id !== id);
  if (testStateOverrideActive) {
    saveDatabaseToDisk();
  } else {
    await syncStateFromPostgres(true);
  }

  return res.json({
    success: true,
    message: `Criativo "${targetPost.nome}" excluído com sucesso e enviado para a lixeira.`,
    deletedId: id,
    driveFileIds,
    driveTrashDispatched,
  });
});

// Ocultar mídia individual para o usuário (POST /api/posts/:id/hide)
// Preserva o arquivo intacto no Google Drive e no PostgreSQL oficial, ocultando apenas da visão do usuário
app.post('/api/posts/:id/hide', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const user = req.user!;

  const targetPost = postGroups.find((p) => p.id === id) || (await getPostGroupByIdFromDb(id));
  if (!targetPost) {
    return res.status(404).json({ error: 'Post ou lote não encontrado.' });
  }

  if (!canUserAccessPost(user, targetPost)) {
    return res.status(403).json({
      error: 'Acesso negado: você não tem permissão para ocultar criativos de outra empresa.',
    });
  }

  let scheduleCancelled = false;
  if (targetPost.status === 'AGENDADO') {
    targetPost.status = 'PENDENTE';
    targetPost.scheduledAt = undefined;
    targetPost.scheduledAccountId = undefined;
    syncPostGroupStateToItemsAndMeta(targetPost);
    if (!testStateOverrideActive) {
      await upsertPostGroupToDb(targetPost);
    }
    scheduleCancelled = true;
  }

  if (!testStateOverrideActive && user.id) {
    await hideMediaForUserInDb(user.id, id);
    await logOperationalActionInDb({
      action: 'HIDE_MEDIA',
      tenantId: targetPost.tenantId || null,
      postId: id,
      message: `Mídia "${targetPost.nome}" ocultada para o usuário ${user.email || user.nome} (${user.id}). Agendamento cancelado: ${scheduleCancelled}. Arquivo do Drive mantido intacto.`,
      payload: { postId: id, userId: user.id, scheduleCancelled, driveFileIds: targetPost.items.map((i) => i.driveFileId) },
    }).catch(() => {});
  }

  return res.json({
    success: true,
    message: `Post "${targetPost.nome}" apagado do seu painel com sucesso. O arquivo original permanece seguro no acervo.`,
    postId: id,
    scheduleCancelled,
  });
});

// Restaurar mídia apagada pelo cliente (POST /api/posts/:id/unhide)
app.post('/api/posts/:id/unhide', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  if (!testStateOverrideActive) {
    await unhideMediaForAllUsersInDb(id);
  }
  return res.json({
    success: true,
    message: 'Post restaurado para exibição com sucesso.',
    postId: id,
  });
});

// ----------------------------------------------------
// 6. APPROVAL & INSTAGRAM GRAPH API PUBLISHING / SCHEDULING
// ----------------------------------------------------

// Cache em memória dos buffers de imagens baixadas do Google Drive para bypass da Meta Graph API
const instagramMediaBufferCache = new Map<
  string,
  { buffer: Buffer; contentType: string; resolvedCdnUrl: string; updatedAt: number }
>();

/**
 * Bypass do Google Drive para a Graph API da Meta:
 * 1. Faz o download do buffer/stream da imagem em alta resolução no backend (contornando bloqueios de redirecionamento do Drive)
 *    e armazena em cache para streaming direto via /api/instagram/media-proxy/:driveFileId.
 * 2. Resolve também a URL pública direta do CDN do Google (lh3.googleusercontent.com) e a URL de thumbnail pública em alta resolução (w1600).
 */
async function prepareDriveMediaForInstagram(
  driveFileId: string,
  req: Request,
  fallbackItem?: DriveImageItem
): Promise<{
  primaryImageUrl: string;
  fallbackUrls: string[];
  bufferSize: number;
  contentType: string;
}> {
  const cleanFileId = String(driveFileId || '').replace(/\.(jpg|jpeg|png)$/i, '').trim();
  const highResThumbUrl = `https://drive.google.com/thumbnail?id=${encodeURIComponent(cleanFileId)}&sz=w1600`;
  const directDownloadUrl =
    fallbackItem?.downloadUrl ||
    `https://drive.google.com/uc?export=download&id=${encodeURIComponent(cleanFileId)}`;
  const googleUserContentUrl = `https://lh3.googleusercontent.com/d/${encodeURIComponent(cleanFileId)}=w1600`;

  const { APP_URL } = getEnv();
  const publicOrigin = (APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const localProxyUrl = `${publicOrigin}/api/instagram/media-proxy/${encodeURIComponent(cleanFileId)}.jpg`;

  let resolvedCdnUrl = googleUserContentUrl;
  let bufferSize = 0;
  let contentType = 'image/jpeg';

  // Faz fetch real da imagem do Google Drive seguindo redirecionamentos para obter o buffer e a URL final do CDN
  const candidateFetchUrls = [highResThumbUrl, directDownloadUrl];
  for (const fetchUrl of candidateFetchUrls) {
    try {
      const resp = await fetch(fetchUrl, { redirect: 'follow' });
      const ct = resp.headers.get('content-type') || '';
      if (resp.ok && ct.startsWith('image/')) {
        const arrBuf = await resp.arrayBuffer();
        const buf = Buffer.from(arrBuf);
        if (buf.length > 0) {
          bufferSize = buf.length;
          contentType = ct;
          if (resp.url && resp.url.startsWith('http') && !resp.url.includes('ServiceLogin')) {
            resolvedCdnUrl = resp.url;
          }
          instagramMediaBufferCache.set(cleanFileId, {
            buffer: buf,
            contentType: ct,
            resolvedCdnUrl,
            updatedAt: Date.now(),
          });
          console.log(
            `[Instagram Bypass Drive] Buffer da mídia "${cleanFileId}" baixado com sucesso (${bufferSize} bytes, ${contentType}). CDN URL: ${resolvedCdnUrl}`
          );
          break;
        }
      }
    } catch (err: any) {
      console.warn(`[Instagram Bypass Drive] Aviso ao baixar buffer de ${fetchUrl}:`, err.message);
    }
  }

  const fallbackUrls = Array.from(
    new Set(
      [
        resolvedCdnUrl,
        googleUserContentUrl,
        highResThumbUrl,
        localProxyUrl,
        fallbackItem?.thumbnailUrl,
        fallbackItem?.viewUrl,
      ].filter((u): u is string => Boolean(u && u.startsWith('http')))
    )
  );

  return {
    primaryImageUrl: fallbackUrls[0] || highResThumbUrl,
    fallbackUrls,
    bufferSize,
    contentType,
  };
}

/**
 * Rota pública que entrega o buffer/stream da imagem baixada do Google Drive
 * com Content-Type de imagem direto para os servidores da Meta Graph API.
 */
app.get('/api/instagram/media-proxy/:rawId', async (req: Request, res: Response) => {
  const cleanFileId = String(req.params.rawId || '').replace(/\.(jpg|jpeg|png)$/i, '').trim();
  if (!cleanFileId) {
    return res.status(400).send('driveFileId ausente');
  }

  let cached = instagramMediaBufferCache.get(cleanFileId);
  if (!cached) {
    await prepareDriveMediaForInstagram(cleanFileId, req);
    cached = instagramMediaBufferCache.get(cleanFileId);
  }

  if (cached && cached.buffer.length > 0) {
    res.setHeader('Content-Type', cached.contentType || 'image/jpeg');
    res.setHeader('Content-Length', String(cached.buffer.length));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(cached.buffer);
  }

  return res.redirect(
    `https://drive.google.com/thumbnail?id=${encodeURIComponent(cleanFileId)}&sz=w1600`
  );
});

// ---------------------------------------------------------------------------
// Proxy de miniaturas do Drive com cache em memória (LRU limitado por bytes).
// Cada imagem é buscada no Drive uma única vez na largura pedida e servida
// com Cache-Control de longa duração; o navegador deixa de depender do Drive.
// ---------------------------------------------------------------------------
const DRIVE_THUMB_ALLOWED_WIDTHS = [200, 400, 800, 1200, 1600];
const DRIVE_THUMB_MAX_CACHE_BYTES = 200 * 1024 * 1024;
const driveThumbCache = new Map<string, { buffer: Buffer; contentType: string; bytes: number }>();
const driveThumbInflight = new Map<string, Promise<{ buffer: Buffer; contentType: string } | null>>();
let driveThumbCacheBytes = 0;

function driveThumbCacheGet(key: string) {
  const hit = driveThumbCache.get(key);
  if (hit) {
    // Move para o fim (mais recente) para a política LRU.
    driveThumbCache.delete(key);
    driveThumbCache.set(key, hit);
  }
  return hit;
}

function driveThumbCacheSet(key: string, buffer: Buffer, contentType: string): void {
  const bytes = buffer.length;
  if (bytes > DRIVE_THUMB_MAX_CACHE_BYTES) return;
  const prev = driveThumbCache.get(key);
  if (prev) {
    driveThumbCacheBytes -= prev.bytes;
    driveThumbCache.delete(key);
  }
  driveThumbCache.set(key, { buffer, contentType, bytes });
  driveThumbCacheBytes += bytes;
  while (driveThumbCacheBytes > DRIVE_THUMB_MAX_CACHE_BYTES) {
    const oldestKey = driveThumbCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = driveThumbCache.get(oldestKey)!;
    driveThumbCacheBytes -= oldest.bytes;
    driveThumbCache.delete(oldestKey);
  }
}

// Qualidade WebP por largura: prévias pequenas comprimem mais; a aprovação (1600) mantém nitidez.
function driveThumbQuality(width: number): number {
  if (width <= 400) return 70;
  if (width <= 800) return 78;
  return 85;
}

async function fetchDriveThumbnail(
  fileId: string,
  width: number
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const key = `${fileId}:${width}`;
  const cached = driveThumbCacheGet(key);
  if (cached) return { buffer: cached.buffer, contentType: cached.contentType };

  const pending = driveThumbInflight.get(key);
  if (pending) return pending;

  const job = (async () => {
    // 1) Postgres: sobrevive a reinícios e serve para qualquer instância do app.
    const stored = await getStoredThumbnail(fileId, width);
    if (stored) {
      driveThumbCacheSet(key, stored.data, stored.contentType);
      return { buffer: stored.data, contentType: stored.contentType };
    }
    // 2) Não está no banco: busca no Drive abaixo e grava para as próximas vezes.

    const candidates = [
      `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${width}`,
      `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}=w${width}`,
    ];
    for (const url of candidates) {
      try {
        const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
        const ct = resp.headers.get('content-type') || '';
        if (resp.ok && ct.startsWith('image/')) {
          const original = Buffer.from(await resp.arrayBuffer());
          if (original.length === 0) continue;
          // Converte para WebP com compressão (fica bem menor que o JPEG do Drive).
          const optimized = await sharp(original, { failOn: 'none' })
            .rotate()
            .resize({ width, withoutEnlargement: true })
            .webp({ quality: driveThumbQuality(width), effort: 4 })
            .toBuffer();
          driveThumbCacheSet(key, optimized, 'image/webp');
          const etag = `"${fileId}-w${width}-${optimized.length}"`;
          void saveStoredThumbnail(fileId, width, optimized, 'image/webp', etag);
          console.log(
            `[Media Thumb] ${fileId} w${width}: ${(original.length / 1024).toFixed(0)}KB -> ${(optimized.length / 1024).toFixed(0)}KB (WebP)`
          );
          return { buffer: optimized, contentType: 'image/webp' };
        }
      } catch (err: any) {
        console.warn(`[Media Thumb] Falha ao buscar ${fileId} (w${width}):`, err.message);
      }
    }
    return null;
  })();

  driveThumbInflight.set(key, job);
  try {
    return await job;
  } finally {
    driveThumbInflight.delete(key);
  }
}

app.get('/api/media/thumb/:rawId', async (req: Request, res: Response) => {
  const fileId = String(req.params.rawId || '').replace(/\.(jpg|jpeg|png|webp)$/i, '').trim();
  if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
    return res.status(400).send('fileId inválido');
  }

  const requested = Number(req.query.w) || 800;
  const width = DRIVE_THUMB_ALLOWED_WIDTHS.find((w) => w >= requested) ?? 1600;

  const image = await fetchDriveThumbnail(fileId, width);
  if (!image) {
    return res.redirect(`https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${width}`);
  }

  res.setHeader('Content-Type', image.contentType);
  res.setHeader('Content-Length', String(image.buffer.length));
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  return res.status(200).send(image.buffer);
});

// ---------------------------------------------------------------------------
// Pré-carregamento diário das mídias do Drive (horário de São Paulo, a partir das 09:00).
// Sincroniza com o Apps Script, baixa só as miniaturas que ainda não estão no Postgres
// e as grava. Assim, quando a equipe abre o painel, as imagens já estão prontas.
// ---------------------------------------------------------------------------
const MEDIA_PREFETCH_TIMEZONE = 'America/Sao_Paulo';
const MEDIA_PREFETCH_START_HOUR = 9;
const MEDIA_PREFETCH_WIDTHS = [400, 1600];
const MEDIA_PREFETCH_CONCURRENCY = 4;
let mediaPrefetchLastDay = '';
let mediaPrefetchRunning: Promise<MediaPrefetchStats> | null = null;

type MediaPrefetchStats = {
  total: number;
  alreadyStored: number;
  downloaded: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
};

function getSaoPauloClock(): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MEDIA_PREFETCH_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const pick = (type: string) => parts.find((p) => p.type === type)?.value || '';
  return { day: `${pick('year')}-${pick('month')}-${pick('day')}`, hour: Number(pick('hour')) };
}

function collectDriveFileIdsFromSync(data: any): string[] {
  const ids = new Set<string>();
  const lotes: any[] = Array.isArray(data?.lotes) ? data.lotes : [];
  for (const lote of lotes) {
    const arquivos: any[] = Array.isArray(lote?.arquivos) ? lote.arquivos : [];
    for (const arquivo of arquivos) {
      const id = String(arquivo?.driveFileId || arquivo?.id || '').trim();
      if (/^[A-Za-z0-9_-]{10,}$/.test(id)) ids.add(id);
    }
  }
  return Array.from(ids);
}

async function runMediaPrefetch(): Promise<MediaPrefetchStats> {
  if (mediaPrefetchRunning) return mediaPrefetchRunning;

  const job = (async (): Promise<MediaPrefetchStats> => {
    const startedAt = new Date().toISOString();
    const sync = await syncWithAppsScript('SINCRONIZAR_TUDO', { force: true });
    if (!sync.ok) {
      throw new Error(sync.error || 'Falha ao sincronizar com o Apps Script');
    }

    const ids = collectDriveFileIdsFromSync(sync.data);
    const stats: MediaPrefetchStats = {
      total: ids.length * MEDIA_PREFETCH_WIDTHS.length,
      alreadyStored: 0,
      downloaded: 0,
      failed: 0,
      startedAt,
      finishedAt: '',
    };

    for (const width of MEDIA_PREFETCH_WIDTHS) {
      const stored = await listStoredFileIds(ids, width);
      const missing = ids.filter((id) => !stored.has(id));
      stats.alreadyStored += ids.length - missing.length;

      let cursor = 0;
      const worker = async () => {
        while (cursor < missing.length) {
          const id = missing[cursor++];
          const image = await fetchDriveThumbnail(id, width);
          if (image) stats.downloaded++;
          else stats.failed++;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(MEDIA_PREFETCH_CONCURRENCY, missing.length) }, () => worker())
      );
    }

    stats.finishedAt = new Date().toISOString();
    return stats;
  })();

  mediaPrefetchRunning = job;
  try {
    return await job;
  } finally {
    mediaPrefetchRunning = null;
  }
}

function startMediaPrefetchScheduler(): void {
  const tick = () => {
    const clock = getSaoPauloClock();
    // Roda uma vez por dia, a partir das 09:00. Se o servidor estiver fora do ar às 9h,
    // o primeiro tick depois de voltar já executa (catch-up).
    if (clock.hour < MEDIA_PREFETCH_START_HOUR || clock.day === mediaPrefetchLastDay) return;
    mediaPrefetchLastDay = clock.day;
    runMediaPrefetch()
      .then((s) => console.log('[Media Prefetch] Concluído:', JSON.stringify(s)))
      .catch((err: any) => console.warn('[Media Prefetch] Falhou:', err.message));
  };

  setInterval(tick, 60_000).unref();
  setTimeout(tick, 15_000).unref();
  console.log(`[Media Prefetch] Agendado diariamente a partir das ${MEDIA_PREFETCH_START_HOUR}:00 (${MEDIA_PREFETCH_TIMEZONE}).`);
}

// Disparo manual (ex.: botão no painel ou teste): roda em segundo plano.
app.post('/api/media/prefetch', requireAuth, (_req: AuthenticatedRequest, res: Response) => {
  if (mediaPrefetchRunning) {
    return res.status(202).json({ success: true, message: 'Já existe um pré-carregamento em andamento.' });
  }
  runMediaPrefetch()
    .then((s) => console.log('[Media Prefetch] Manual concluído:', JSON.stringify(s)))
    .catch((err: any) => console.warn('[Media Prefetch] Manual falhou:', err.message));
  return res.status(202).json({ success: true, message: 'Pré-carregamento iniciado em segundo plano.' });
});

// Lock em memória por post para reforçar o lock transacional persistido em disco
const activePostPublishLocks = new Set<string>();

/**
 * Marca uma conta do Instagram como RECONEXAO_NECESSARIA, pausa seus agendamentos futuros
 * preservando data/hora/legenda e gera alerta administrativo.
 */
function markTenantReconnectionNeeded(tenant: TenantAccount, reason: string): void {
  const nowIso = new Date().toISOString();
  tenant.connectionStatus = 'RECONEXAO_NECESSARIA';
  tenant.lastConnectionError = reason;
  tenant.reconnectionRequiredAt = nowIso;
  tenant.hasValidToken = false;

  // Transiciona posts AGENDADO desta conta para RECONEXAO_NECESSARIA sem apagar agendamento
  for (let i = 0; i < postGroups.length; i++) {
    const p = postGroups[i];
    const belongsToTenant =
      p.scheduledAccountId === tenant.id ||
      p.tenantId === tenant.id ||
      (tenant.driveFolderId && p.pastaClienteId === tenant.driveFolderId) ||
      (tenant.driveFolderName &&
        p.driveFolderName &&
        p.driveFolderName.toLowerCase() === tenant.driveFolderName.toLowerCase());

    if (belongsToTenant && p.status === 'AGENDADO') {
      postGroups[i] = {
        ...p,
        status: 'RECONEXAO_NECESSARIA',
        failureReason: reason,
        publishLock: null,
        items: p.items.map((item) => ({ ...item, status: 'RECONEXAO_NECESSARIA' })),
      };
      const fileIds = p.items.map((it) => it.driveFileId);
      rawDriveItems = rawDriveItems.map((it) =>
        fileIds.includes(it.driveFileId) ? { ...it, status: 'RECONEXAO_NECESSARIA' } : it
      );
    }
  }

  addAdminAlert({
    type: 'RECONEXAO_NECESSARIA',
    tenantId: tenant.id,
    username: tenant.username,
    message: `A conta @${tenant.username} requer reconexão via OAuth do Instagram: ${reason}`,
  });

  saveDatabaseToDisk();
}

/**
 * Verifica se uma conta do Instagram pertence à mesma empresa do PostGroup.
 */
function isTenantCompatibleWithPost(tenant: TenantAccount, post: PostGroup): boolean {
  const postFolder = (post.pastaClienteNome || post.driveFolderName || '').trim().toLowerCase();
  const acctFolder = (tenant.driveFolderName || '').trim().toLowerCase();

  if (postFolder && acctFolder) {
    return postFolder === acctFolder;
  }
  if (post.pastaClienteId && tenant.driveFolderId) {
    return post.pastaClienteId === tenant.driveFolderId;
  }
  if (post.tenantId) {
    return post.tenantId === tenant.id;
  }
  return true;
}

/**
 * Verifica se o usuário autenticado tem permissão para acessar/gerenciar um PostGroup.
 * Usuários ADMIN possuem acesso global; usuários TENANT estão estritamente isolados à sua empresa.
 */
function canUserAccessPost(user: UserProfile | undefined, post: PostGroup): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;

  const ownTenant = tenants.find(
    (t) =>
      (user.tenantId && t.id === user.tenantId) ||
      (user.instagramUsername &&
        t.username.toLowerCase() === user.instagramUsername.toLowerCase())
  );

  const effectiveStatus = ownTenant?.status || user.status;
  const ownFolder = (ownTenant?.driveFolderName || user.driveFolderName || '').trim().toLowerCase();
  const ownFolderId = ownTenant?.driveFolderId || user.driveFolderId || '';

  if (
    effectiveStatus === 'PENDENTE' ||
    effectiveStatus === 'AGUARDANDO_APROVACAO' ||
    effectiveStatus === 'SUSPENDED' ||
    !ownFolder
  ) {
    return false;
  }

  if (post.tenantId && user.tenantId && post.tenantId === user.tenantId) return true;
  if (ownFolderId && post.pastaClienteId && post.pastaClienteId === ownFolderId) return true;

  const postFolder = (post.pastaClienteNome || post.driveFolderName || '').trim().toLowerCase();
  if (postFolder && ownFolder && postFolder === ownFolder) return true;

  return false;
}

/**
 * Verifica se o usuário autenticado tem permissão para publicar ou agendar usando uma conta específica do Instagram.
 */
function canUserUseInstagramAccount(user: UserProfile | undefined, tenant: TenantAccount): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;

  if (user.tenantId && tenant.id === user.tenantId) return true;
  if (user.instagramUserId && tenant.instagramUserId === user.instagramUserId) return true;
  if (user.instagramUsername && tenant.username.toLowerCase() === user.instagramUsername.toLowerCase()) return true;

  // Jamais permitir que um TENANT use outra conta apenas por compartilhar a mesma pasta/empresa!
  return false;
}

/**
 * Localiza a conta do Instagram (TenantAccount) associada à publicação.
 * - Usuário TENANT publica EXCLUSIVAMENTE na sua própria conta autenticada da sessão.
 * - NUNCA utiliza tokens de outras contas ou tokens legados.
 * - NUNCA confia em accountId arbitrário vindo do cliente.
 */
function resolveTargetTenantForPost(
  targetPost: PostGroup,
  requestedAccountId?: string | null,
  reqUser?: UserProfile
): TenantAccount | undefined {
  loadDatabaseFromDisk();

  // 1. Regra Fundamental: Usuário TENANT só tem autorização para publicar utilizando a SUA PRÓPRIA conta Instagram da sessão!
  if (reqUser && reqUser.role === 'TENANT') {
    const userOwnTenant = tenants.find(
      (t) =>
        (reqUser.tenantId && t.id === reqUser.tenantId) ||
        (reqUser.instagramUserId && t.instagramUserId === reqUser.instagramUserId) ||
        (reqUser.instagramUsername &&
          t.username.toLowerCase() === reqUser.instagramUsername.toLowerCase())
    );
    if (!userOwnTenant) return undefined;

    // Se o cliente tentou enviar outra conta pelo frontend, bloqueia
    if (requestedAccountId && requestedAccountId.trim()) {
      const cleanReq = requestedAccountId.trim().replace(/^@/, '').toLowerCase();
      const isSelf =
        cleanReq === userOwnTenant.id.toLowerCase() ||
        cleanReq === userOwnTenant.instagramUserId.toLowerCase() ||
        cleanReq === userOwnTenant.username.toLowerCase();
      if (!isSelf) {
        return undefined; // Proibido tentar publicar em outra conta
      }
    }

    return userOwnTenant;
  }

  // 2. Conta explicitamente informada (ex: ADMIN agendando ou publicando em conta compatível)
  if (requestedAccountId && requestedAccountId.trim()) {
    const cleanReq = requestedAccountId.trim();
    const byExplicit = tenants.find(
      (t) =>
        t.id === cleanReq ||
        t.instagramUserId === cleanReq ||
        t.username.toLowerCase() === cleanReq.replace(/^@/, '').toLowerCase()
    );
    if (!byExplicit) return undefined;
    if (!isTenantCompatibleWithPost(byExplicit, targetPost)) return undefined;
    if (reqUser && !canUserUseInstagramAccount(reqUser, byExplicit)) return undefined;
    return byExplicit;
  }

  // 2. Conta salva no agendamento do post: DEVE ser exatamente essa conta
  if (targetPost.scheduledAccountId) {
    const bySched = tenants.find(
      (t) =>
        t.id === targetPost.scheduledAccountId ||
        t.instagramUserId === targetPost.scheduledAccountId
    );
    if (!bySched) return undefined;
    if (!isTenantCompatibleWithPost(bySched, targetPost)) return undefined;
    return bySched;
  }

  // 3. Conta vinculada ao tenantId do post
  if (targetPost.tenantId) {
    const byTenantId = tenants.find((t) => t.id === targetPost.tenantId);
    if (byTenantId && isTenantCompatibleWithPost(byTenantId, targetPost)) {
      return byTenantId;
    }
  }

  // 4. Conta vinculada à mesma pasta/empresa do Google Drive do post
  const postFolder = (targetPost.pastaClienteNome || targetPost.driveFolderName || '')
    .trim()
    .toLowerCase();
  if (targetPost.pastaClienteId || postFolder) {
    const matchingFolderAccounts = tenants.filter(
      (t) =>
        (targetPost.pastaClienteId && t.driveFolderId === targetPost.pastaClienteId) ||
        (postFolder && t.driveFolderName && t.driveFolderName.toLowerCase() === postFolder)
    );
    const connectedMatch = matchingFolderAccounts.find((t) =>
      Boolean(t.encryptedAccessToken || t.accessToken || t.access_token)
    );
    if (connectedMatch) return connectedMatch;
    if (matchingFolderAccounts.length > 0) return matchingFolderAccounts[0];
    // Se o post pertence a uma empresa específica e essa empresa não possui conta vinculada,
    // NUNCA usa conta de outra empresa!
    return undefined;
  }

  // 5. Conta do usuário logado (quando TENANT e post sem empresa definida)
  if (reqUser?.tenantId) {
    const byUser = tenants.find((t) => t.id === reqUser.tenantId);
    if (byUser && isTenantCompatibleWithPost(byUser, targetPost)) return byUser;
  }

  return undefined;
}

/**
 * Job de renovação automática preventiva de tokens longos (ETAPA 2):
 * - Verifica contas conectadas
 * - Respeita idade mínima de 24 horas
 * - Renova preventivamente tokens com idade >= 30 dias (ou faltando <= 15 dias para expirar)
 * - Nunca tenta renovar tokens já expirados (marca RECONEXAO_NECESSARIA)
 * - Usa lock por conta para evitar concorrência
 * - Persiste de forma atômica sem sobrescrever token válido em caso de falha transitória
 */
export async function runPreventiveTokenRefreshJob(options?: {
  nowMs?: number;
  forceTenantId?: string;
}): Promise<{
  checked: number;
  refreshed: number;
  skippedRecent: number;
  skippedHealthy: number;
  markedReconnection: number;
  transientErrors: number;
  details: Array<{
    tenantId: string;
    username: string;
    action: string;
    message: string;
    tokenExpiresAt?: string;
  }>;
}> {
  loadDatabaseFromDisk();
  const { JWT_SECRET } = getEnv();
  const encKey = getTokenEncryptionKey() || JWT_SECRET;
  const nowMs = options?.nowMs ?? Date.now();

  if (!testStateOverrideActive) {
    const summary = await TokenService.refreshEligibleTokens({
      nowMs,
      forceTenantId: options?.forceTenantId,
    });
    await syncStateFromPostgres();
    return summary;
  }

  const details: Array<{
    tenantId: string;
    username: string;
    action: string;
    message: string;
    tokenExpiresAt?: string;
  }> = [];

  let checked = 0;
  let refreshed = 0;
  let skippedRecent = 0;
  let skippedHealthy = 0;
  let markedReconnection = 0;
  let transientErrors = 0;

  for (let i = 0; i < tenants.length; i++) {
    const tenant = tenants[i];
    if (options?.forceTenantId && tenant.id !== options.forceTenantId) {
      continue;
    }

    const plainToken = resolveAccountAccessToken(tenant, encKey);
    if (!plainToken) {
      continue;
    }

    checked++;

    const res = await refreshAccountLongLivedToken({
      tenant,
      secretKey: encKey,
      forceIfEligible24h: Boolean(options?.forceTenantId),
      nowMs,
      onPersist: () => saveDatabaseToDisk(),
      onAdminAlert: (alert) => {
        markTenantReconnectionNeeded(tenant, alert.message);
      },
    });

    if (res.status === 'REFRESHED') {
      refreshed++;
    } else if (res.status === 'SKIPPED_TOO_YOUNG_24H') {
      skippedRecent++;
    } else if (res.status === 'SKIPPED_NOT_DUE') {
      skippedHealthy++;
    } else if (
      res.status === 'EXPIRED_RECONNECT_REQUIRED' ||
      res.status === 'REVOKED_RECONNECT_REQUIRED' ||
      res.status === 'MISSING_TOKEN'
    ) {
      markedReconnection++;
    } else if (res.status === 'TRANSIENT_FAILURE_KEPT_VALID_TOKEN') {
      transientErrors++;
    }

    details.push({
      tenantId: tenant.id,
      username: tenant.username,
      action: res.status,
      message: res.message,
      tokenExpiresAt: res.tokenExpiresAt,
    });
  }

  return {
    checked,
    refreshed,
    skippedRecent,
    skippedHealthy,
    markedReconnection,
    transientErrors,
    details,
  };
}

/**
 * Executa a publicação unificada na API do Instagram com Instagram Login (https://graph.instagram.com/v21.0)
 * utilizando PublicationService.publishPost tanto para publicação imediata quanto para o agendador automático.
 */
async function executePostPublishNow(params: {
  postIndex: number;
  targetTenant: TenantAccount | undefined;
  caption: string;
  req?: Request;
  origin: 'IMMEDIATE' | 'SCHEDULER';
  workerId?: string;
  pollIntervalMs?: number;
  nowMs?: number;
}): Promise<{
  ok: boolean;
  httpStatus: number;
  post: PostGroup;
  creationId?: string;
  childContainerIds?: string[];
  instagramMediaId?: string;
  permalink?: string;
  error?: string;
  step?: string;
  isError190?: boolean;
  isTransientError?: boolean;
  metaError?: any;
}> {
  const { postIndex, caption, req, origin } = params;
  const targetPost = postGroups[postIndex];
  const { APP_URL } = getEnv();
  const publicBaseUrl = (APP_URL || (req ? `${req.protocol}://${req.get('host')}` : '')).replace(/\/+$/, '');

  const result = await PublicationService.publishPost({
    post: targetPost,
    targetTenant: params.targetTenant,
    caption: caption || targetPost.caption || '',
    origin,
    publicBaseUrl,
    pollIntervalMs: params.pollIntervalMs,
    nowMs: params.nowMs,
    persistToPostgres: !testStateOverrideActive,
  });

  // Espelha o resultado atualizado na memória local para consistência
  postGroups[postIndex] = result.post;
  const targetFileIds = result.post.items.map((i) => i.driveFileId);
  rawDriveItems = rawDriveItems.map((item) =>
    targetFileIds.includes(item.driveFileId)
      ? {
          ...item,
          status: result.post.status,
          publishedAt: result.post.publishedAt,
          instagramMediaId: result.post.instagramMediaId,
          instagramContainerId: result.post.instagramContainerId,
          childContainerIds: result.post.childContainerIds,
          instagramPermalink: result.post.instagramPermalink,
        }
      : item
  );

  if (testStateOverrideActive) {
    saveDatabaseToDisk();
  } else {
    await syncStateFromPostgres(true);
  }

  return {
    ok: result.ok,
    httpStatus: result.httpStatus,
    post: result.post,
    creationId: result.creationId,
    childContainerIds: result.childContainerIds,
    instagramMediaId: result.instagramMediaId,
    permalink: result.permalink,
    error: result.error,
    step: result.step,
    isError190: result.isError190,
    isTransientError: result.isTransientError,
    metaError: result.metaError,
  };
}

/**
 * Rota oficial de publicação imediata na API do Instagram com Instagram Login (v21.0):
 * POST /api/instagram/publish
 * Recebe: { id, driveFileId, caption, accountId / tenantId }
 */
app.post('/api/instagram/publish', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  loadDatabaseFromDisk();
  const { id, driveFileId, caption = '', accountId, tenantId } = req.body || {};

  if (!id && !driveFileId) {
    return res.status(400).json({
      success: false,
      error: 'Parâmetros obrigatórios ausentes: informe o "id" ou "driveFileId" da mídia.',
    });
  }

  const postIndex = postGroups.findIndex(
    (p) =>
      p.id === id ||
      (driveFileId && p.items.some((item) => item.driveFileId === driveFileId)) ||
      (id && p.items.some((item) => item.driveFileId === id))
  );

  if (postIndex === -1) {
    return res.status(404).json({
      success: false,
      error: `Mídia não encontrada no banco de dados local (id="${id}", driveFileId="${driveFileId}").`,
    });
  }

  const targetPost = postGroups[postIndex];

  if (!canUserAccessPost(req.user, targetPost)) {
    return res.status(403).json({
      success: false,
      error: 'Acesso negado: você não possui permissão para publicar conteúdos de outra empresa.',
    });
  }

  const explicitAccountId = accountId || tenantId;
  if (explicitAccountId) {
    const explicitAccount = tenants.find(
      (t) =>
        t.id === explicitAccountId ||
        t.instagramUserId === explicitAccountId ||
        t.username.toLowerCase() === String(explicitAccountId).replace(/^@/, '').toLowerCase()
    );
    if (!explicitAccount) {
      return res.status(400).json({
        success: false,
        error: `A conta do Instagram selecionada ("${explicitAccountId}") não foi encontrada.`,
      });
    }
    if (!canUserUseInstagramAccount(req.user, explicitAccount) || !isTenantCompatibleWithPost(explicitAccount, targetPost)) {
      return res.status(403).json({
        success: false,
        error: `Isolamento multiempresa: a conta @${explicitAccount.username} pertence a outra empresa e não pode ser usada nesta publicação.`,
      });
    }
  }

  // Impede publicação de conteúdo explicitamente reprovado ou cancelado
  if (targetPost.status === 'REPROVADO' || targetPost.status === 'CANCELADO') {
    return res.status(400).json({
      success: false,
      error: `Conteúdo com status "${targetPost.status}" não pode ser publicado sem aprovação prévia.`,
    });
  }

  // Registra aprovação implícita caso esteja sendo aprovado e publicado imediatamente no modal
  postGroups[postIndex] = {
    ...targetPost,
    isApprovedForSchedule: true,
    approvedAt: targetPost.approvedAt || new Date().toISOString(),
    approvedBy:
      targetPost.approvedBy ||
      req.user?.email ||
      req.user?.instagramUsername ||
      req.user?.nome ||
      'admin',
  };

  const targetTenant = resolveTargetTenantForPost(
    postGroups[postIndex],
    explicitAccountId,
    req.user
  );

  try {
    const result = await executePostPublishNow({
      postIndex,
      targetTenant,
      caption,
      req,
      origin: 'IMMEDIATE',
    });

    if (!result.ok) {
      return res.status(result.httpStatus).json({
        success: false,
        step: result.step,
        creationId: result.creationId,
        isError190: result.isError190,
        reconnectionRequired: Boolean(result.isError190),
        error: result.error,
        metaError: result.metaError,
        post: result.post,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Mídia publicada com sucesso no Instagram @${targetTenant?.username || ''}! (Media ID: ${result.instagramMediaId})`,
      creationId: result.creationId,
      childContainerIds: result.childContainerIds,
      instagramMediaId: result.instagramMediaId,
      permalink: result.permalink,
      post: result.post,
    });
  } catch (err: any) {
    console.error('[Instagram Publish Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: `Erro interno ao comunicar com a API do Instagram: ${err.message || 'Falha de rede'}`,
    });
  }
});

/**
 * Rota para geração/refinamento de legenda com IA (Gemini Server-Side via @google/genai + persistência PostgreSQL)
 */
app.post('/api/instagram/generate-caption', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const {
    postId,
    loteNome = '',
    nome = '',
    categoria = 'Post Único',
    cliente = 'Ato',
    objective,
    theme,
    briefing,
    tone,
    cta,
    includeHashtags = true,
    customInstructions,
    regenerate = false,
  } = req.body || {};

  // Se houver postId válido no PostgreSQL, utiliza o serviço completo com histórico de versões
  if (postId) {
    try {
      const genResult = await generateCaptionWithGemini({
        postId: String(postId),
        objective,
        theme,
        briefing,
        tone,
        cta,
        includeHashtags: Boolean(includeHashtags),
        customInstructions,
        regenerate: Boolean(regenerate),
        createdBy:
          req.user?.email || req.user?.instagramUsername || req.user?.nome || 'Usuário',
      });
      await syncStateFromPostgres();
      return res.json({
        success: true,
        caption: genResult.caption,
        captionRecord: genResult.captionRecord,
        aiGeneration: genResult.aiGeneration,
        post: genResult.post,
        requiresReapproval: genResult.requiresReapproval,
        modelUsed: genResult.modelUsed,
        source: 'gemini',
      });
    } catch (err: any) {
      return res.status(502).json({
        success: false,
        error: err.message || 'Não foi possível gerar a legenda com a Gemini API.',
      });
    }
  }

  const cleanTitle = String(loteNome || nome || 'Conteúdo Exclusivo')
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();

  const geminiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const configuredModel = String(process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite').trim();
  const candidateModels = Array.from(
    new Set([configuredModel, 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'])
  );

  if (geminiKey && geminiKey !== 'MY_GEMINI_API_KEY' && geminiKey.length > 10) {
    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    for (const modelName of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: `Crie uma legenda profissional, engajadora e direta em português brasileiro para uma publicação de Instagram da marca "${cliente}".
Contexto do lote/arte: "${cleanTitle}"
Formato: "${categoria}"
Inclua uma chamada para ação (CTA) clara e de 3 a 5 hashtags relevantes no final. Retorne apenas o texto da legenda pronto para publicar, sem blocos markdown.`,
        });
        if (response.text && response.text.trim()) {
          return res.json({
            success: true,
            caption: response.text.trim(),
            modelUsed: modelName,
            source: 'gemini',
          });
        }
      } catch (err: any) {
        console.warn(`[Caption Generator] Tentativa com modelo ${modelName} falhou:`, err.message);
      }
    }
  }

  const slugTag = String(cliente || 'Ato')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  const generatedCaption =
    categoria === 'Carrossel'
      ? `Arraste para o lado e confira os detalhes: ${cleanTitle}.\n\nEstratégia, consistência e posicionamento pensados para gerar resultados reais para ${cliente}.\n\nSalve este carrossel para consultar depois e comente o que achou!\n\n#${slugTag || 'ato'} #socialmedia #estrategiadigital #conteudodevalor`
      : categoria === 'Story'
      ? `${cleanTitle} — Confira os destaques de hoje para ${cliente}! Responda aqui no direct para saber mais.`
      : `${cleanTitle}\n\nCada detalhe importa quando construímos presença digital com propósito e consistência para ${cliente}.\n\nDeixe seu comentário abaixo e compartilhe com quem precisa ver este conteúdo!\n\n#${slugTag || 'ato'} #marketingdigital #posicionamento #branding`;

  return res.json({
    success: true,
    caption: generatedCaption,
    source: 'contextual_ai',
  });
});

// ====================================================
// 6A. ROTAS DEDICADAS DE LEGENDAS COM GEMINI E PERFIL DE MARCA (ETAPA 7)
// ====================================================

// Gerar ou regerar legenda com Gemini vinculada ao post no PostgreSQL
app.post(
  '/api/posts/:id/captions/generate',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    loadDatabaseFromDisk();
    const { id } = req.params;
    const targetPost = postGroups.find((p) => p.id === id);
    if (targetPost && !canUserAccessPost(req.user, targetPost)) {
      return res.status(403).json({
        success: false,
        error: 'Acesso negado: você não tem permissão para gerar legendas em postagens de outra empresa.',
      });
    }

    const {
      objective,
      theme,
      briefing,
      tone,
      cta,
      includeHashtags = true,
      customInstructions,
      regenerate = false,
    } = req.body || {};

    try {
      const result = await generateCaptionWithGemini({
        postId: id,
        objective,
        theme,
        briefing,
        tone,
        cta,
        includeHashtags: Boolean(includeHashtags),
        customInstructions,
        regenerate: Boolean(regenerate),
        createdBy:
          req.user?.email || req.user?.instagramUsername || req.user?.nome || 'Usuário',
      });

      await syncStateFromPostgres();

      return res.status(200).json({
        success: true,
        caption: result.caption,
        captionRecord: result.captionRecord,
        aiGeneration: result.aiGeneration,
        post: result.post,
        requiresReapproval: result.requiresReapproval,
        modelUsed: result.modelUsed,
        message: result.requiresReapproval
          ? 'Nova legenda gerada pela IA! Como o post já estava aprovado, a nova versão requer reaprovação antes de publicar.'
          : 'Legenda gerada com sucesso pela Gemini API e salva no PostgreSQL!',
      });
    } catch (err: any) {
      return res.status(502).json({
        success: false,
        error: err.message || 'Falha ao gerar legenda com a Gemini API.',
      });
    }
  }
);

// Salvar edição manual de legenda (ou selecionar versão) com verificação de reaprovação obrigatória
app.put('/api/posts/:id/captions', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  loadDatabaseFromDisk();
  const { id } = req.params;
  const targetPost = postGroups.find((p) => p.id === id);
  if (targetPost && !canUserAccessPost(req.user, targetPost)) {
    return res.status(403).json({
      success: false,
      error: 'Acesso negado: você não tem permissão para editar legendas de outra empresa.',
    });
  }

  const { content, caption, source = 'MANUAL', aiGenerationId } = req.body || {};
  const textToSave = String(content !== undefined ? content : caption || '').trim();

  if (!textToSave) {
    return res.status(400).json({
      success: false,
      error: 'O texto da legenda não pode estar vazio.',
    });
  }

  try {
    const saved = await saveCaptionForPostTx({
      postId: id,
      content: textToSave,
      source: source === 'GEMINI' || source === 'GEMINI_EDITED' ? source : 'MANUAL',
      aiGenerationId: aiGenerationId || null,
      createdBy:
        req.user?.email || req.user?.instagramUsername || req.user?.nome || 'Usuário',
    });

    await syncStateFromPostgres();

    return res.status(200).json({
      success: true,
      caption: saved.caption.content,
      captionRecord: saved.caption,
      post: saved.post,
      requiresReapproval: saved.requiresReapproval,
      message: saved.requiresReapproval
        ? 'Legenda alterada após aprovação: o post retornou para PENDENTE_APROVACAO e exige nova aprovação antes da publicação.'
        : 'Legenda salva com sucesso no banco PostgreSQL.',
    });
  } catch (err: any) {
    return res.status(404).json({
      success: false,
      error: err.message || 'Erro ao salvar legenda da postagem.',
    });
  }
});

// ====================================================
// 6B. OBSERVAÇÕES DOS CLIENTES & MEMÓRIA CRIATIVA INTELIGENTE
// ====================================================

async function syncClientObservationsToDrive(companyIdOrFolder: string): Promise<boolean> {
  try {
    const { GOOGLE_APPS_SCRIPT_URL, WEBHOOK_SECRET_TOKEN } = getEnv();
    if (!GOOGLE_APPS_SCRIPT_URL) {
      console.warn('[Drive Sync Observations] GOOGLE_APPS_SCRIPT_URL não configurado.');
      return false;
    }

    const company = await resolveCompanyRecordForSession({
      companyIdInput: companyIdOrFolder,
      driveFolderName: companyIdOrFolder,
    });

    const { markdownContent } = await generateClientObservationsMarkdown(company.id);
    const versao = await getNextObservationVersionForCompany(company.id);
    const pastaClienteId = company.driveFolderId || company.id;
    const driveFolderName = company.driveFolderName || company.name || 'Ato';

    const gasPayload = {
      acao: 'SALVAR_OBSERVACOES_CLIENTE',
      action: 'SALVAR_OBSERVACOES_CLIENTE',
      token: WEBHOOK_SECRET_TOKEN || '',
      pastaClienteId,
      versao,
      conteudoMarkdown: markdownContent,
      driveFolderName,
      filename: '_OBSERVACOES_CLIENTE.md',
    };

    const response = await fetch(GOOGLE_APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(gasPayload),
    });

    const resJson = await response.json().catch(() => ({}));
    const isSuccess =
      response.ok &&
      (resJson.sucesso === true ||
        resJson.status === 'OK' ||
        resJson.status === 'SUCCESS' ||
        resJson.success === true);

    if (isSuccess) {
      await updateClientObservationSyncStatusInDb(company.id, 'SYNCED');
    } else {
      await updateClientObservationSyncStatusInDb(company.id, 'FAILED');
    }
    return isSuccess;
  } catch (err: any) {
    console.error('[Drive Sync Observations] Falha ao sincronizar observações com Google Drive:', err.message);
    await updateClientObservationSyncStatusInDb(companyIdOrFolder, 'FAILED');
    return false;
  }
}

// GET /api/observations - Listar observações do cliente com isolamento multi-tenant
app.get('/api/observations', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    const inputParam = String(req.query.companyId || req.query.driveFolderName || '').trim();

    const company = await resolveCompanyRecordForSession({
      userId: user.id,
      tenantId: user.tenantId,
      instagramUsername: user.instagramUsername,
      driveFolderName: user.role === 'TENANT' ? user.driveFolderName : inputParam,
      companyIdInput: user.role === 'ADMIN' ? inputParam : undefined,
    });

    const observations = await listClientObservationsFromDb({
      companyId: company.id,
      includeInactive: true,
    });

    return res.json({ success: true, observations, company });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Erro ao consultar observações do cliente.' });
  }
});

// POST /api/observations - Criar nova observação vinculada à empresa autorizada da sessão
app.post('/api/observations', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    const { content, type = 'PONTUAL', companyId, driveFolderName } = req.body || {};

    if (!content || !String(content).trim()) {
      return res.status(400).json({ success: false, error: 'O conteúdo da observação é obrigatório.' });
    }

    // Resolves legitimate company record in companies table (guaranteeing valid primary key in PostgreSQL)
    const company = await resolveCompanyRecordForSession({
      userId: user.id,
      tenantId: user.tenantId,
      instagramUsername: user.instagramUsername,
      driveFolderName: user.role === 'TENANT' ? user.driveFolderName : driveFolderName,
      companyIdInput: user.role === 'ADMIN' ? companyId || driveFolderName : undefined,
    });

    const observation = await createClientObservationInDb({
      companyId: company.id, // GUARANTEED to exist in companies(id)
      tenantId: user.tenantId || user.id,
      userId: user.id,
      authorName: user.nome || user.email || user.instagramUsername || 'Usuário',
      content: String(content).trim(),
      type: type === 'PERMANENTE' ? 'PERMANENTE' : 'PONTUAL',
    });

    // Sincroniza com o Google Drive (_OBSERVACOES_CLIENTE.md)
    const driveSynced = await syncClientObservationsToDrive(company.id);

    const message = driveSynced
      ? 'Observação salva com sucesso.'
      : 'Observação salva. A sincronização está pendente.';

    return res.status(201).json({
      success: true,
      observation,
      company,
      driveSynced,
      message,
    });
  } catch (err: any) {
    console.error('[Create Observation Error]:', err?.message || err);
    return res.status(500).json({
      success: false,
      error: 'Não foi possível salvar a observação. Tente novamente.',
    });
  }
});

// PUT /api/observations/:id - Atualizar observação respeitando autor e role ADMIN
app.put('/api/observations/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const { content, type, isActive } = req.body || {};

    const updated = await updateClientObservationInDb(
      id,
      {
        content: content !== undefined ? String(content).trim() : undefined,
        type: type === 'PERMANENTE' || type === 'PONTUAL' ? type : undefined,
        isActive: typeof isActive === 'boolean' ? isActive : undefined,
      },
      user.id,
      user.role === 'ADMIN'
    );

    if (!updated) {
      return res.status(404).json({ success: false, error: 'Observação não encontrada.' });
    }

    const companyToSync = updated.companyId || (updated as any).company_id;
    let driveSynced = false;
    if (companyToSync) {
      driveSynced = await syncClientObservationsToDrive(companyToSync);
    }

    const message = driveSynced
      ? 'Observação atualizada com sucesso.'
      : 'Observação atualizada. A sincronização está pendente.';

    return res.json({
      success: true,
      observation: updated,
      driveSynced,
      message,
    });
  } catch (err: any) {
    const isPermissionError = err?.message?.includes('Acesso negado');
    return res.status(isPermissionError ? 403 : 500).json({
      success: false,
      error: isPermissionError
        ? err.message
        : 'Não foi possível atualizar a observação. Tente novamente.',
    });
  }
});

// GET /api/creative-context - Consultar o contexto criativo consolidado (Dupla Memória: Sugestões + Reprovações)
app.get('/api/creative-context', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    const inputParam = String(req.query.companyId || req.query.driveFolderName || '').trim();

    const company = await resolveCompanyRecordForSession({
      userId: user.id,
      tenantId: user.tenantId,
      instagramUsername: user.instagramUsername,
      driveFolderName: user.role === 'TENANT' ? user.driveFolderName : inputParam,
      companyIdInput: user.role === 'ADMIN' ? inputParam : undefined,
    });

    const context = await getConsolidatedCreativeContextForCompany(company.id);
    return res.json({ success: true, ...context, company });
  } catch (err: any) {
    console.warn('[Creative Context Endpoint Error]:', err?.message || err);
    return res.json({
      success: true,
      companyName: 'Ato',
      observations: [],
      rejectionMemory: [],
      formattedPromptContext: 'Nenhuma observação ou histórico de reprovação registrado no momento para este cliente.',
    });
  }
});

// Consultar histórico de versões de legendas e gerações de IA da postagem
app.get('/api/posts/:id/captions', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  loadDatabaseFromDisk();
  const { id } = req.params;
  const post = await getPostGroupByIdFromDb(id);
  if (!post) {
    return res.status(404).json({ error: 'Postagem não encontrada.' });
  }

  if (!canUserAccessPost(req.user, post)) {
    return res.status(403).json({
      error: 'Acesso negado: você não tem permissão para consultar legendas de outra empresa.',
    });
  }

  const aiGensRes = await dbQuery<any>(
    `SELECT * FROM ai_generations WHERE post_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [id]
  );

  return res.json({
    postId: id,
    activeCaptionId: post.activeCaptionId || null,
    captionApproved: Boolean(post.captionApproved),
    captionSource: post.captionSource || 'MANUAL',
    currentCaption: post.caption || '',
    captionsHistory: post.captionsHistory || [],
    aiGenerations: aiGensRes.rows,
  });
});

// Listar e atualizar perfil editorial / voz da marca das empresas (companies)
app.get('/api/companies', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const companies = await listCompanies();
  if (req.user?.role === 'TENANT') {
    const ownTenant = tenants.find((t) => t.id === req.user?.tenantId);
    const ownFolder = (ownTenant?.driveFolderName || req.user?.driveFolderName || '').trim().toLowerCase();
    return res.json({
      companies: companies.filter(
        (c) =>
          ownFolder &&
          ((c.driveFolderName && c.driveFolderName.trim().toLowerCase() === ownFolder) ||
            c.name.trim().toLowerCase() === ownFolder)
      ),
    });
  }
  return res.json({ companies });
});

app.put(
  '/api/companies/:id/brand-profile',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params;
    const existing = await getCompanyByIdOrFolder(id);
    if (req.user?.role === 'TENANT') {
      const ownTenant = tenants.find((t) => t.id === req.user?.tenantId);
      const ownFolder = (ownTenant?.driveFolderName || req.user?.driveFolderName || '').trim().toLowerCase();
      const targetFolder = (existing?.driveFolderName || existing?.name || id).trim().toLowerCase();
      if (!ownFolder || ownFolder !== targetFolder) {
        return res.status(403).json({
          error: 'Acesso negado: você não possui permissão para alterar o perfil de outra empresa.',
        });
      }
    }
    const updated = await upsertCompany({
      id: existing?.id || id,
      name: req.body?.name || existing?.name || id,
      driveFolderId: req.body?.driveFolderId || existing?.driveFolderId,
      driveFolderName: req.body?.driveFolderName || existing?.driveFolderName || existing?.name,
      segment: req.body?.segment,
      brandVoice: req.body?.brandVoice,
      targetAudience: req.body?.targetAudience,
      defaultCta: req.body?.defaultCta,
      defaultHashtags: req.body?.defaultHashtags,
      aiGuidelines: req.body?.aiGuidelines,
    });
    await syncStateFromPostgres();
    return res.json({
      success: true,
      company: updated,
      message: `Identidade editorial da empresa "${updated.name}" atualizada no PostgreSQL.`,
    });
  }
);

/**
 * Rota de aprovação, publicação imediata ou agendamento automático:
 * POST /api/posts/:id/publish
 * Suporta actions: "NOW" | "SCHEDULE" | "APPROVE" | "APPROVE_ONLY" | "CANCEL_SCHEDULE"
 */
app.post('/api/posts/:id/publish', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  loadDatabaseFromDisk();
  const { id } = req.params;
  const {
    action,
    caption,
    scheduledDate,
    scheduledTime,
    scheduledAt: explicitScheduledAt,
    accountId,
    tenantId,
    instagramAccountId,
  } = req.body || {};

  const postIndex = postGroups.findIndex((p) => p.id === id);
  if (postIndex === -1) {
    return res.status(404).json({ error: 'Post não encontrado.' });
  }

  const post = postGroups[postIndex];

  if (!canUserAccessPost(req.user, post)) {
    return res.status(403).json({
      error: 'Acesso negado: você não possui permissão para aprovar, agendar ou publicar conteúdos de outra empresa.',
    });
  }

  const explicitAccountRef = accountId || tenantId || instagramAccountId;
  if (explicitAccountRef) {
    const explicitAccount = tenants.find(
      (t) =>
        t.id === explicitAccountRef ||
        t.instagramUserId === explicitAccountRef ||
        t.username.toLowerCase() === String(explicitAccountRef).replace(/^@/, '').toLowerCase()
    );
    if (!explicitAccount) {
      return res.status(400).json({
        error: `A conta do Instagram selecionada ("${explicitAccountRef}") não foi encontrada.`,
      });
    }
    if (!canUserUseInstagramAccount(req.user, explicitAccount) || !isTenantCompatibleWithPost(explicitAccount, post)) {
      return res.status(403).json({
        error: `Isolamento multiempresa: a conta @${explicitAccount.username} pertence a outra empresa e não pode ser usada neste conteúdo.`,
      });
    }
  }

  const driveFileIds = post.items.map((i) => i.driveFileId);
  const actorName =
    req.user?.email || req.user?.instagramUsername || req.user?.nome || 'admin';
  const nowIso = new Date().toISOString();

  const targetTenant = resolveTargetTenantForPost(
    post,
    explicitAccountRef,
    req.user
  );

  if (action === 'APPROVE' || action === 'APPROVE_ONLY') {
    await recordApprovalInDb({
      postId: post.id,
      caption: caption !== undefined ? caption : post.caption || '',
      action: 'APPROVE_ONLY',
      approvedBy: actorName,
      scheduledAccountId: targetTenant?.id || post.scheduledAccountId || null,
    });
    await syncStateFromPostgres();
    const updatedPost = postGroups.find((p) => p.id === post.id) || {
      ...post,
      status: 'APROVADO',
      isApprovedForSchedule: true,
      captionApproved: true,
      approvedAt: nowIso,
      approvedBy: actorName,
      caption: caption !== undefined ? caption : post.caption,
    };
    return res.json({
      success: true,
      message: 'Conteúdo e legenda aprovados com sucesso no PostgreSQL.',
      post: updatedPost,
    });
  }

  if (action === 'CANCEL_SCHEDULE') {
    const updatedPost: PostGroup = {
      ...post,
      status: 'CANCELADO',
      publishLock: null,
      nextRetryAt: null,
      items: post.items.map((it) => ({ ...it, status: 'CANCELADO' })),
    };
    postGroups[postIndex] = updatedPost;
    rawDriveItems = rawDriveItems.map((item) =>
      driveFileIds.includes(item.driveFileId) ? { ...item, status: 'CANCELADO' } : item
    );
    saveDatabaseToDisk();
    return res.json({
      success: true,
      message: 'Agendamento cancelado com sucesso.',
      post: updatedPost,
    });
  }

  if (action === 'NOW') {
    if (post.status === 'REPROVADO' || post.status === 'CANCELADO') {
      return res.status(400).json({
        success: false,
        error: `Conteúdo com status "${post.status}" não pode ser publicado.`,
      });
    }

    postGroups[postIndex] = {
      ...post,
      isApprovedForSchedule: true,
      approvedAt: post.approvedAt || nowIso,
      approvedBy: post.approvedBy || actorName,
    };

    const result = await executePostPublishNow({
      postIndex,
      targetTenant,
      caption: caption || post.caption || '',
      req,
      origin: 'IMMEDIATE',
    });

    if (!result.ok) {
      return res.status(result.httpStatus).json({
        success: false,
        step: result.step,
        creationId: result.creationId,
        isError190: result.isError190,
        reconnectionRequired: Boolean(result.isError190),
        error: result.error,
        metaError: result.metaError,
        post: result.post,
      });
    }

    return res.json({
      success: true,
      message: `Post publicado com sucesso no Instagram @${targetTenant?.username || ''}!`,
      post: result.post,
      creationId: result.creationId,
      instagramMediaId: result.instagramMediaId,
      permalink: result.permalink,
      graphApiResult: {
        containerId: result.creationId,
        mediaId: result.instagramMediaId,
        permalink: result.permalink,
        mediaType:
          post.categoria === 'Carrossel'
            ? 'CAROUSEL'
            : post.categoria === 'Story'
            ? 'STORIES'
            : 'IMAGE',
        publishedAt: result.post.publishedAt,
        instagramTargetUserId: targetTenant?.instagramUserId,
      },
    });
  }

  if (action === 'SCHEDULE') {
    if (post.status === 'REPROVADO') {
      return res.status(400).json({
        error: 'Conteúdo reprovado não pode ser agendado sem aprovação.',
      });
    }

    let scheduledUtcIso: string | null = null;
    if (explicitScheduledAt && !Number.isNaN(Date.parse(explicitScheduledAt))) {
      scheduledUtcIso = new Date(explicitScheduledAt).toISOString();
    } else if (scheduledDate && scheduledTime) {
      scheduledUtcIso = convertSaoPauloToUtcIso(String(scheduledDate), String(scheduledTime));
    }

    if (!scheduledUtcIso) {
      return res.status(400).json({
        error: 'Data e hora válidas são obrigatórias para agendamento (fuso America/Sao_Paulo).',
      });
    }

    if (!targetTenant) {
      return res.status(400).json({
        error: 'Nenhuma conta do Instagram conectada encontrada para vincular ao agendamento.',
      });
    }

    if (targetTenant.connectionStatus === 'RECONEXAO_NECESSARIA') {
      return res.status(400).json({
        error: `A conta @${targetTenant.username} precisa ser reconectada via OAuth antes de agendar publicações.`,
        reconnectionRequired: true,
      });
    }

    // Não cria o container da Meta antecipadamente (containers expiram em 24h);
    // armazena em UTC e cria o container apenas no momento da execução.
    await recordApprovalInDb({
      postId: post.id,
      caption: caption !== undefined ? caption : post.caption || '',
      action: 'APPROVE_AND_SCHEDULE',
      approvedBy: actorName,
      scheduledAtUtc: scheduledUtcIso,
      scheduledTimezone: 'America/Sao_Paulo',
      scheduledAccountId: targetTenant.id,
    });
    await syncStateFromPostgres();
    const updatedPost =
      postGroups.find((p) => p.id === post.id) || {
        ...post,
        status: 'AGENDADO',
        tenantId: targetTenant.id,
        scheduledAccountId: targetTenant.id,
        scheduledTimezone: 'America/Sao_Paulo',
        caption: caption !== undefined ? caption : post.caption || '',
        scheduledAt: scheduledUtcIso,
        isApprovedForSchedule: true,
        captionApproved: true,
      };

    return res.json({
      success: true,
      message: `Post agendado com sucesso para @${targetTenant.username} (${scheduledDate || ''} ${scheduledTime || ''} — America/Sao_Paulo).`,
      post: updatedPost,
      queueResult: {
        jobId: `sched_${post.id}_${Date.now()}`,
        targetTimestampUtc: scheduledUtcIso,
        timezone: 'America/Sao_Paulo',
        scheduledAccountId: targetTenant.id,
      },
    });
  }

  return res.status(400).json({
    error: 'Ação inválida. Utilize "NOW", "SCHEDULE", "APPROVE" ou "CANCEL_SCHEDULE".',
  });
});

// ----------------------------------------------------
// 6B. AGENDADOR AUTOMÁTICO COM LOCK TRANSACIONAL & CLOUD SCHEDULER ENDPOINTS (ETAPAS 4 & 5)
// ----------------------------------------------------

/**
 * Tenta adquirir lock transacional exclusivo para um post agendado antes de iniciar a publicação.
 * Garante que duas execuções concorrentes (ou múltiplas instâncias) nunca publiquem o mesmo post duas vezes.
 */
export function acquirePostScheduleLock(
  postId: string,
  workerId: string,
  nowMs: number
): { acquired: boolean; postIndex: number; reason?: string } {
  if (activePostPublishLocks.has(postId)) {
    return { acquired: false, postIndex: -1, reason: 'IN_MEMORY_LOCK_ACTIVE' };
  }

  loadDatabaseFromDisk();
  const postIndex = postGroups.findIndex((p) => p.id === postId);
  if (postIndex === -1) {
    return { acquired: false, postIndex: -1, reason: 'POST_NOT_FOUND' };
  }

  const post = postGroups[postIndex];

  // Regra de segurança: Somente posts explicitamente aprovados e com status AGENDADO podem ser processados
  if (post.status !== 'AGENDADO') {
    return { acquired: false, postIndex, reason: `INVALID_STATUS_${post.status}` };
  }

  if (post.isApprovedForSchedule === false) {
    return { acquired: false, postIndex, reason: 'NOT_APPROVED_FOR_SCHEDULE' };
  }

  if (!post.scheduledAt) {
    return { acquired: false, postIndex, reason: 'MISSING_SCHEDULED_AT' };
  }

  const scheduledMs = Date.parse(post.scheduledAt);
  if (Number.isNaN(scheduledMs) || scheduledMs > nowMs) {
    return { acquired: false, postIndex, reason: 'NOT_DUE_YET' };
  }

  if (post.nextRetryAt) {
    const retryMs = Date.parse(post.nextRetryAt);
    if (!Number.isNaN(retryMs) && retryMs > nowMs) {
      return { acquired: false, postIndex, reason: 'WAITING_BACKOFF_RETRY' };
    }
  }

  // Verifica se já existe lock ativo não expirado (TTL de 5 minutos)
  if (post.publishLock && post.publishLock.expiresAt) {
    const lockExpMs = Date.parse(post.publishLock.expiresAt);
    if (!Number.isNaN(lockExpMs) && lockExpMs > nowMs) {
      return { acquired: false, postIndex, reason: 'ALREADY_LOCKED' };
    }
  }

  activePostPublishLocks.add(postId);

  const lockIso = new Date(nowMs).toISOString();
  const lockExpiresIso = new Date(nowMs + 5 * 60 * 1000).toISOString();

  postGroups[postIndex] = {
    ...post,
    status: 'PUBLICANDO',
    publishLock: {
      instanceId: workerId,
      acquiredAt: lockIso,
      expiresAt: lockExpiresIso,
    },
    items: post.items.map((it) => ({ ...it, status: 'PUBLICANDO' })),
  };

  saveDatabaseToDisk();
  return { acquired: true, postIndex };
}

/**
 * Processa todos os agendamentos vencidos (scheduledAt <= agora) com lock transacional.
 */
export async function processDueScheduledPosts(options?: {
  nowMs?: number;
  workerId?: string;
  pollIntervalMs?: number;
}): Promise<{
  workerId: string;
  executedAt: string;
  dueFound: number;
  publishedCount: number;
  failedCount: number;
  reconnectionCount: number;
  retryScheduledCount: number;
  skippedLockedCount: number;
  skippedUnapprovedCount: number;
  processedPosts: Array<{
    postId: string;
    status: string;
    instagramMediaId?: string;
    permalink?: string;
    error?: string;
  }>;
}> {
  if (!testStateOverrideActive) {
    const cycleResult = await SchedulerWorker.runOnce({
      nowMs: options?.nowMs,
      workerId: options?.workerId,
      pollIntervalMs: options?.pollIntervalMs,
    });
    await syncStateFromPostgres();
    return {
      workerId: cycleResult.workerId,
      executedAt: cycleResult.executedAt,
      dueFound: cycleResult.dueFound,
      publishedCount: cycleResult.publishedCount,
      failedCount: cycleResult.failedCount,
      reconnectionCount: cycleResult.reconnectionCount,
      retryScheduledCount: cycleResult.retryScheduledCount,
      skippedLockedCount: cycleResult.skippedLockedCount,
      skippedUnapprovedCount: cycleResult.skippedUnapprovedCount,
      processedPosts: cycleResult.processedPosts,
    };
  }

  loadDatabaseFromDisk();
  const nowMs = options?.nowMs ?? Date.now();
  const workerId = options?.workerId || `worker_${process.pid}_${nowMs}`;
  const executedAt = new Date(nowMs).toISOString();

  // Recupera locks órfãos de instâncias que caíram há mais de 5 minutos em status PUBLICANDO
  let recoveredStaleLocks = false;
  for (let i = 0; i < postGroups.length; i++) {
    const p = postGroups[i];
    if (p.status === 'PUBLICANDO' && p.publishLock?.expiresAt) {
      const expMs = Date.parse(p.publishLock.expiresAt);
      if (!Number.isNaN(expMs) && expMs <= nowMs) {
        postGroups[i] = {
          ...p,
          status: 'AGENDADO',
          publishLock: null,
          items: p.items.map((it) => ({ ...it, status: 'AGENDADO' })),
        };
        recoveredStaleLocks = true;
      }
    }
  }
  if (recoveredStaleLocks) {
    saveDatabaseToDisk();
  }

  let dueFound = 0;
  let publishedCount = 0;
  let failedCount = 0;
  let reconnectionCount = 0;
  let retryScheduledCount = 0;
  let skippedLockedCount = 0;
  let skippedUnapprovedCount = 0;
  const processedPosts: Array<{
    postId: string;
    status: string;
    instagramMediaId?: string;
    permalink?: string;
    error?: string;
  }> = [];

  // Snapshot dos IDs candidatos
  const candidateIds = postGroups
    .filter((p) => {
      if (!p.scheduledAt) return false;
      const schedMs = Date.parse(p.scheduledAt);
      return !Number.isNaN(schedMs) && schedMs <= nowMs;
    })
    .map((p) => p.id);

  for (const postId of candidateIds) {
    const currentPost = postGroups.find((p) => p.id === postId);
    if (!currentPost) continue;

    // Se o post tem horário vencido mas não está aprovado (ex: PENDENTE_APROVACAO / CRIADO / REPROVADO), bloqueia
    if (
      currentPost.isApprovedForSchedule === false ||
      currentPost.status === 'CRIADO' ||
      currentPost.status === 'PENDENTE' ||
      currentPost.status === 'PENDENTE_APROVACAO' ||
      currentPost.status === 'REPROVADO'
    ) {
      skippedUnapprovedCount++;
      continue;
    }

    if (currentPost.status === 'PUBLICANDO') {
      skippedLockedCount++;
      continue;
    }

    if (currentPost.status !== 'AGENDADO') {
      continue;
    }

    dueFound++;

    const lockResult = acquirePostScheduleLock(postId, workerId, nowMs);
    if (!lockResult.acquired) {
      if (
        lockResult.reason === 'ALREADY_LOCKED' ||
        lockResult.reason === 'IN_MEMORY_LOCK_ACTIVE' ||
        lockResult.reason === 'INVALID_STATUS_PUBLICANDO'
      ) {
        skippedLockedCount++;
      } else if (lockResult.reason === 'NOT_APPROVED_FOR_SCHEDULE') {
        skippedUnapprovedCount++;
      }
      continue;
    }

    try {
      const lockedPost = postGroups[lockResult.postIndex];
      const targetTenant = resolveTargetTenantForPost(
        lockedPost,
        lockedPost.scheduledAccountId || lockedPost.tenantId
      );

      const pubRes = await executePostPublishNow({
        postIndex: lockResult.postIndex,
        targetTenant,
        caption: lockedPost.caption || '',
        origin: 'SCHEDULER',
        workerId,
        pollIntervalMs: options?.pollIntervalMs,
        nowMs,
      });

      if (pubRes.ok) {
        publishedCount++;
      } else if (pubRes.post.status === 'RECONEXAO_NECESSARIA') {
        reconnectionCount++;
      } else if (pubRes.post.status === 'AGENDADO' && pubRes.post.nextRetryAt) {
        retryScheduledCount++;
      } else {
        failedCount++;
      }

      processedPosts.push({
        postId,
        status: pubRes.post.status,
        instagramMediaId: pubRes.instagramMediaId,
        permalink: pubRes.permalink,
        error: pubRes.error,
      });
    } finally {
      activePostPublishLocks.delete(postId);
    }
  }

  schedulerRuns.unshift({
    runId: workerId,
    startedAt: executedAt,
    finishedAt: new Date().toISOString(),
    processedCount: processedPosts.length,
    publishedCount,
    failedCount,
    skippedCount: skippedLockedCount,
  });
  saveDatabaseToDisk();

  return {
    workerId,
    executedAt,
    dueFound,
    publishedCount,
    failedCount,
    reconnectionCount,
    retryScheduledCount,
    skippedLockedCount,
    skippedUnapprovedCount,
    processedPosts,
  };
}

/**
 * Middleware para autenticar chamadas vindas do Google Cloud Scheduler (via header X-Scheduler-Token,
 * Authorization Bearer ou query token) ou de um Administrador logado.
 */
function requireSchedulerOrAdminAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const { WEBHOOK_SECRET_TOKEN, JWT_SECRET } = getEnv();
  const cronSecret = process.env.CRON_SECRET || WEBHOOK_SECRET_TOKEN;

  const headerSecret =
    req.headers['x-scheduler-token'] ||
    req.headers['x-cron-secret'] ||
    req.headers['x-webhook-token'] ||
    req.query.token;

  if (headerSecret && String(headerSecret) === String(cronSecret)) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.split(' ')[1];
    if (bearer === cronSecret || bearer === WEBHOOK_SECRET_TOKEN) {
      return next();
    }
    try {
      const decoded = jwt.verify(bearer, JWT_SECRET) as UserProfile;
      req.user = decoded;
      return next();
    } catch {
      return res.status(401).json({ error: 'Token de autorização inválido para o agendador.' });
    }
  }

  // Permite disparo sem token apenas se nenhum segredo estiver configurado no ambiente
  if (!cronSecret) {
    return next();
  }

  return res.status(401).json({
    error: 'Não autorizado: forneça X-Scheduler-Token ou Authorization Bearer válido.',
  });
}

// Endpoint HTTP acionado a cada 1 minuto pelo Google Cloud Scheduler (ETAPA 4 & 5)
app.post('/api/scheduler/run', requireSchedulerOrAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const nowMs = req.body?.nowMs ? Number(req.body.nowMs) : undefined;
    const workerId = req.body?.workerId ? String(req.body.workerId) : undefined;
    const summary = await processDueScheduledPosts({ nowMs, workerId });
    return res.status(200).json({
      success: true,
      ...summary,
    });
  } catch (err: any) {
    console.error('[Scheduler Run Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro ao processar fila de agendamentos.',
    });
  }
});

app.get('/api/scheduler/run', requireSchedulerOrAdminAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const summary = await processDueScheduledPosts();
    return res.status(200).json({
      success: true,
      ...summary,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro ao processar fila de agendamentos.',
    });
  }
});

// Endpoint HTTP acionado diariamente pelo Google Cloud Scheduler / Railway Cron para renovação preventiva de tokens (POST e GET)
app.post('/api/scheduler/refresh-tokens', requireSchedulerOrAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const nowMs = req.body?.nowMs ? Number(req.body.nowMs) : undefined;
    const forceTenantId = req.body?.tenantId ? String(req.body.tenantId) : undefined;
    const result = await runPreventiveTokenRefreshJob({ nowMs, forceTenantId });
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro ao executar renovação preventiva de tokens.',
    });
  }
});

app.get('/api/scheduler/refresh-tokens', requireSchedulerOrAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const forceTenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    const result = await runPreventiveTokenRefreshJob({ forceTenantId });
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || 'Erro ao executar renovação preventiva de tokens.',
    });
  }
});

// Endpoint administrativo para forçar renovação de token de uma conta específica
app.post('/api/admin/tenants/:id/refresh-token', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const result = await runPreventiveTokenRefreshJob({ forceTenantId: id });
  const detail = result.details.find((d) => d.tenantId === id);
  return res.json({
    success: true,
    detail: detail || null,
    summary: result,
  });
});

// Endpoint para diagnóstico e status do agendador e alertas administrativos
app.get('/api/scheduler/status', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  loadDatabaseFromDisk();
  const scheduledPosts = postGroups.filter(
    (p) =>
      p.status === 'AGENDADO' ||
      p.status === 'PUBLICANDO' ||
      p.status === 'RECONEXAO_NECESSARIA' ||
      p.status === 'FALHA_PUBLICACAO'
  );
  const lastTokenRefreshRun = await getLastTokenRefreshRunFromDb().catch(() => null);
  return res.json({
    serverTimeUtc: new Date().toISOString(),
    displayTimezone: 'America/Sao_Paulo',
    schedulerMode: resolveSchedulerMode(),
    workerIntervalMs: resolveWorkerIntervalMs(),
    tokenRefreshIntervalMs: resolveTokenRefreshIntervalMs(),
    lastTokenRefreshRun,
    scheduledCount: scheduledPosts.length,
    scheduledPosts: scheduledPosts.map((p) => ({
      id: p.id,
      nome: p.nome,
      status: p.status,
      scheduledAt: p.scheduledAt,
      scheduledTimezone: p.scheduledTimezone || 'America/Sao_Paulo',
      scheduledAccountId: p.scheduledAccountId || p.tenantId,
      publishAttempts: p.publishAttempts || 0,
      nextRetryAt: p.nextRetryAt || null,
      failureReason: p.failureReason || null,
    })),
    recentRuns: schedulerRuns.slice(0, 15),
    adminAlerts: adminAlerts.filter((a) => !a.resolved),
  });
});

app.post('/api/admin/alerts/:id/resolve', requireAuth, requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  loadDatabaseFromDisk();
  const { id } = req.params;
  adminAlerts = adminAlerts.map((a) => (a.id === id ? { ...a, resolved: true } : a));
  saveDatabaseToDisk();
  return res.json({ success: true });
});

// ----------------------------------------------------
// 7. GOOGLE APPS SCRIPT CONFIG & SERVICE TOKEN GENERATOR
// ----------------------------------------------------
app.get('/api/system/gas-config', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const {
    APP_URL,
    JWT_SECRET,
    WEBHOOK_SECRET_TOKEN,
    GOOGLE_APPS_SCRIPT_URL,
    INSTAGRAM_ACCOUNT_ID,
    INSTAGRAM_APP_ID,
  } = getEnv();

  const currentOrigin = APP_URL || `${req.protocol}://${req.get('host')}`;
  const webhookEndpoint = `${currentOrigin}/api/webhooks/drive-sync`;

  const tenYearJwt = jwt.sign(
    {
      id: 'gas_long_lived_service',
      email: 'drive-sync@atosocial.com',
      role: 'ADMIN',
    },
    JWT_SECRET,
    { expiresIn: '3650d' }
  );

  return res.json({
    webhookUrl: webhookEndpoint,
    webhookSecretToken: WEBHOOK_SECRET_TOKEN,
    tenYearJwt,
    gasWebhookUrl: GOOGLE_APPS_SCRIPT_URL,
    gasProjectUrl: 'https://script.google.com/home/projects/1ldr5Fxf3ikysc2oxOhyBFYrpy6xXkkkzWJtic41k1WfXaQbjpw9z8Fdl/edit?hl=pt-br',
    instagramConnectedAccount: {
      userId: INSTAGRAM_ACCOUNT_ID,
      appId: INSTAGRAM_APP_ID,
    },
  });
});

// ----------------------------------------------------
// 7B. DIAGNÓSTICO DE SAÚDE DO POSTGRESQL & MOTOR DE MIGRAÇÃO (ETAPAS 1 & 4)
// ----------------------------------------------------
app.get(
  '/api/system/db-status',
  requireSchedulerOrAdminAuth,
  async (_req: AuthenticatedRequest, res: Response) => {
    const connStatus = await checkDatabaseConnection();
    const migrations = await getAppliedMigrations();
    const tableCounts = await getDatabaseTableCounts();
    const geminiConfig = getGeminiConfigStatus();

    return res.status(connStatus.connected ? 200 : 503).json({
      status: connStatus.connected ? 'ONLINE' : 'OFFLINE',
      scheduler: {
        mode: resolveSchedulerMode(),
        workerIntervalMs: resolveWorkerIntervalMs(),
      },
      database: {
        connected: connStatus.connected,
        driver: connStatus.driver,
        railwayConfigured: connStatus.railwayConfigured,
        latencyMs: connStatus.latencyMs,
        serverTimeUtc: new Date().toISOString(),
        serverVersion: connStatus.serverVersion,
        error: connStatus.error || null,
        jsonFallbackEnabled: false,
      },
      migrations: {
        totalApplied: migrations.length,
        history: migrations,
      },
      tableCounts,
      gemini: geminiConfig,
    });
  }
);

app.post(
  '/api/system/migrate-json',
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    const dryRun = Boolean(req.body?.dryRun);
    const report = await migrateFromJsonToPostgres({
      dryRun,
      skipBackup: false,
    });
    if (!dryRun) {
      await syncStateFromPostgres();
    }
    return res.json({
      success: report.referentialIntegrityOk,
      report,
    });
  }
);

// ----------------------------------------------------
// 8. UTILITY / RESET DEMO ROUTE
// ----------------------------------------------------
app.post('/api/posts/reset-demo', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  tenants = [...initialTenants];
  rawDriveItems = [...initialMockDriveItems];
  postGroupsMeta = {};
  postGroups = groupAndSortDriveItems(rawDriveItems);
  driveFoldersMap.clear();
  await persistStateToPostgres();
  await syncStateFromPostgres();
  return res.json({
    success: true,
    message: 'Estado restaurado com sucesso no PostgreSQL.',
    totalPosts: postGroups.length,
    totalTenants: tenants.length,
  });
});

// ----------------------------------------------------
// 9. VITE DEV SERVER / STATIC ASSETS & SCHEDULER_MODE COORDINATION
// ----------------------------------------------------
async function startServer() {
  try {
    await ensurePostgresBootstrapped();
    const conn = await checkDatabaseConnection();
    console.log(
      `[PostgreSQL] Inicializado com sucesso (driver=${conn.driver}, railwayConfigured=${conn.railwayConfigured}, latency=${conn.latencyMs}ms)`
    );
  } catch (dbErr: any) {
    console.error('[PostgreSQL] Aviso de inicialização:', dbErr.message);
  }

  const distIndexPath = path.join(__dirname, 'dist', 'index.html');
  if (process.env.NODE_ENV === 'production' && fs.existsSync(distIndexPath)) {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(distIndexPath);
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // Coordenação híbrida automática (Cloud Run + Railway):
  // - Por padrão (SCHEDULER_MODE != 'disabled'), o processo inicia o SchedulerWorker em background,
  //   executando verificação imediata de tokens na largada, verificação diária/periódica (a cada 6h)
  //   e processamento de agendamentos (a cada 20s), além de continuar aceitando chamadas externas
  //   em /api/scheduler/refresh-tokens e /api/scheduler/run.
  const schedulerMode = resolveSchedulerMode();
  if (!process.env.VITEST && !process.env.ATO_TEST_MODE && schedulerMode !== 'disabled') {
    const intervalMs = resolveWorkerIntervalMs();
    const tokenRefreshIntervalMs = resolveTokenRefreshIntervalMs();
    console.log(
      `[ATO Social Hub] Executor automático de agendamentos e renovação de tokens ativo (SCHEDULER_MODE=${schedulerMode}, posts=${intervalMs}ms, tokens=${tokenRefreshIntervalMs}ms).`
    );
    SchedulerWorker.startContinuousWorker({
      intervalMs,
      tokenRefreshIntervalMs,
      runProcessorFn: () => processDueScheduledPosts(),
      runTokenRefreshFn: () => runPreventiveTokenRefreshJob(),
    });
  } else {
    console.log(`[ATO Social Hub] SCHEDULER_MODE=${schedulerMode} (executor em background desativado).`);
  }

  if (!process.env.VITEST && !process.env.ATO_TEST_MODE) {
    startMediaPrefetchScheduler();
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ATO Social Hub] Servidor rodando na porta ${PORT}`);
  });
}

if (!process.env.VITEST && !process.env.ATO_TEST_MODE) {
  startServer().catch((err) => {
    console.error('[ATO Social Hub] Erro fatal ao iniciar o servidor:', err);
    process.exit(1);
  });
}

export function resetSchedulerTestState(seed?: {
  tenants?: TenantAccount[];
  postGroups?: PostGroup[];
  rawDriveItems?: DriveImageItem[];
}) {
  testStateOverrideActive = Boolean(seed);
  activePostPublishLocks.clear();
  tenants = seed?.tenants ? [...seed.tenants] : [];
  rawDriveItems = seed?.rawDriveItems ? [...seed.rawDriveItems] : [];
  postGroupsMeta = {};
  postGroups = seed?.postGroups
    ? [...seed.postGroups]
    : applyPostGroupsMeta(groupAndSortDriveItems(rawDriveItems));
  adminAlerts = [];
  schedulerRuns = [];
  saveDatabaseToDisk();
}

export function getSchedulerTestState() {
  loadDatabaseFromDisk();
  return {
    tenants,
    postGroups,
    rawDriveItems,
    postGroupsMeta,
    adminAlerts,
    schedulerRuns,
    activePostPublishLocks,
    saveDatabaseToDisk,
    loadDatabaseFromDisk,
    jwtSecret: getEnv().JWT_SECRET,
  };
}




