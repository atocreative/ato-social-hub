import {
  getLastTokenRefreshRunFromDb,
  recordSchedulerRunInDb,
} from '../db/repository.ts';
import { PublicationService } from './PublicationService.ts';
import { ScheduleService } from './ScheduleService.ts';
import { TokenService, TokenRefreshJobSummary } from './TokenService.ts';

export type SchedulerExecutionMode = 'http' | 'worker' | 'disabled';

export interface SchedulerCycleResult {
  workerId: string;
  mode: SchedulerExecutionMode;
  executedAt: string;
  recoveredStaleLocksCount: number;
  dueFound: number;
  publishedCount: number;
  failedCount: number;
  reconnectionCount: number;
  retryScheduledCount: number;
  skippedLockedCount: number;
  skippedUnapprovedCount: number;
  tokenMaintenance?: TokenRefreshJobSummary | null;
  processedPosts: Array<{
    postId: string;
    status: string;
    instagramMediaId?: string;
    permalink?: string;
    error?: string;
  }>;
}

/**
 * Resolve o modo de operação do agendador a partir de SCHEDULER_MODE.
 * Valores aceitos:
 * - 'worker' (padrão híbrido ativo: executa loop em background no Railway/Cloud Run + aceita chamadas HTTP)
 * - 'http' (acionado via POST/GET /api/scheduler/run e /api/scheduler/refresh-tokens)
 * - 'disabled' (desativa o processamento automático em background)
 */
export function resolveSchedulerMode(explicitMode?: string): SchedulerExecutionMode {
  const raw = String(explicitMode || process.env.SCHEDULER_MODE || 'worker')
    .trim()
    .toLowerCase();
  if (raw === 'http') return 'http';
  if (raw === 'disabled' || raw === 'off' || raw === 'false' || raw === 'none') {
    return 'disabled';
  }
  return 'worker';
}

export function resolveWorkerIntervalMs(): number {
  const parsed = Number(process.env.WORKER_INTERVAL_MS || process.env.SCHEDULER_INTERVAL_MS || 20000);
  if (Number.isNaN(parsed) || parsed < 5000) {
    return 20000; // Padrão: 20 segundos (dentro da faixa recomendada de 15 a 30s)
  }
  return parsed;
}

export function resolveTokenRefreshIntervalMs(): number {
  const parsed = Number(process.env.TOKEN_REFRESH_INTERVAL_MS || 6 * 60 * 60 * 1000); // Verifica a cada 6h (4x ao dia)
  if (Number.isNaN(parsed) || parsed < 60000) {
    return 6 * 60 * 60 * 1000;
  }
  return parsed;
}

/**
 * SchedulerWorker — Orquestrador independente de hospedagem para processamento
 * de publicações agendadas e renovação preventiva diária de tokens no PostgreSQL.
 */
export class SchedulerWorker {
  private static activeLoopTimer: ReturnType<typeof setInterval> | null = null;
  private static activeTokenTimer: ReturnType<typeof setInterval> | null = null;
  private static transientRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static isCycleInProgress = false;
  private static isTokenMaintenanceInProgress = false;
  private static lastTokenMaintenanceMs = 0;
  private static lastTokenMaintenanceHadTransientError = false;

  /**
   * Verifica se a manutenção diária de tokens precisa ser executada (caso a última verificação
   * registrada no PostgreSQL tenha ocorrido há >= 24h, ou há >= 15 min se houve falha transitória).
   * Permite que o endpoint /api/scheduler/run também garanta a verificação diária mesmo em ambientes serverless.
   */
  static async ensureDailyTokenMaintenance(options?: {
    nowMs?: number;
    dailyIntervalMs?: number;
    transientRetryIntervalMs?: number;
  }): Promise<TokenRefreshJobSummary | null> {
    if (SchedulerWorker.isTokenMaintenanceInProgress) {
      return null;
    }

    const nowMs = options?.nowMs ?? Date.now();
    const dailyIntervalMs = options?.dailyIntervalMs ?? 24 * 60 * 60 * 1000; // 24 horas
    const transientRetryIntervalMs = options?.transientRetryIntervalMs ?? 15 * 60 * 1000; // 15 minutos

    let lastRunMs = SchedulerWorker.lastTokenMaintenanceMs;
    let hadTransient = SchedulerWorker.lastTokenMaintenanceHadTransientError;

    if (lastRunMs === 0) {
      const dbLastRun = await getLastTokenRefreshRunFromDb().catch(() => null);
      if (dbLastRun?.executedAt) {
        const parsedMs = Date.parse(dbLastRun.executedAt);
        if (!Number.isNaN(parsedMs)) {
          lastRunMs = parsedMs;
          hadTransient = dbLastRun.transientErrors > 0;
          SchedulerWorker.lastTokenMaintenanceMs = lastRunMs;
          SchedulerWorker.lastTokenMaintenanceHadTransientError = hadTransient;
        }
      }
    }

    const requiredInterval = hadTransient ? transientRetryIntervalMs : dailyIntervalMs;
    if (lastRunMs > 0 && nowMs - lastRunMs < requiredInterval) {
      return null;
    }

    return await SchedulerWorker.runTokenMaintenance({ nowMs });
  }

  /**
   * Executa um ciclo completo de processamento de agendamentos vencidos diretamente no PostgreSQL:
   * 1. Recupera locks expirados (processamentos interrompidos).
   * 2. Busca candidatos vencidos (scheduled_at <= now).
   * 3. Adquire lock transacional por post via FOR UPDATE SKIP LOCKED com lease.
   * 4. Publica via PublicationService e registra resultado atômico no banco.
   * 5. Garante que a verificação diária de validade dos tokens (<= 30 dias) seja executada se vencida.
   * 6. Registra telemetria da execução em operational_logs.
   */
  static async runOnce(options?: {
    nowMs?: number;
    workerId?: string;
    pollIntervalMs?: number;
    publicBaseUrl?: string;
    includeTokenMaintenance?: boolean;
  }): Promise<SchedulerCycleResult> {
    const nowMs = options?.nowMs ?? Date.now();
    const workerId =
      options?.workerId ||
      `worker_${process.pid}_${nowMs}_${Math.random().toString(36).slice(2, 6)}`;
    const executedAt = new Date(nowMs).toISOString();
    const mode = resolveSchedulerMode();

    // Em produção (fora de suítes de teste isoladas) ou quando explicitamente solicitado,
    // verifica automaticamente se a manutenção diária de tokens está vencida
    const shouldCheckTokens =
      options?.includeTokenMaintenance ??
      Boolean(!process.env.VITEST && !process.env.ATO_TEST_MODE);

    let tokenMaintenance: TokenRefreshJobSummary | null = null;
    if (shouldCheckTokens) {
      tokenMaintenance = await SchedulerWorker.ensureDailyTokenMaintenance({ nowMs }).catch(
        (err) => {
          console.error('[SchedulerWorker] Aviso na verificação diária de tokens:', err?.message);
          return null;
        }
      );
    }

    // 1. Recupera locks órfãos/expirados no PostgreSQL
    const recoveredStaleLocksCount = await ScheduleService.recoverStaleLocksInPostgres(nowMs);

    // 2. Identifica candidatos vencidos no PostgreSQL
    const {
      dueCandidateIds,
      skippedUnapprovedCount: initialUnapproved,
      skippedLockedCount: initialLocked,
    } = await ScheduleService.findDueCandidatePostIdsInPostgres(nowMs);

    let dueFound = dueCandidateIds.length;
    let publishedCount = 0;
    let failedCount = 0;
    let reconnectionCount = 0;
    let retryScheduledCount = 0;
    let skippedLockedCount = initialLocked;
    let skippedUnapprovedCount = initialUnapproved;

    const processedPosts: SchedulerCycleResult['processedPosts'] = [];

    for (const postId of dueCandidateIds) {
      const lockRes = await ScheduleService.acquireTransactionalPostLock(postId, workerId, nowMs);
      if (!lockRes.acquired || !lockRes.post) {
        if (
          lockRes.reason === 'ALREADY_LOCKED' ||
          lockRes.reason === 'INVALID_STATUS_PUBLICANDO'
        ) {
          skippedLockedCount++;
        } else if (lockRes.reason === 'NOT_APPROVED_FOR_SCHEDULE') {
          skippedUnapprovedCount++;
        }
        continue;
      }

      const lockedPost = lockRes.post;
      const targetTenant = await PublicationService.resolveAccountForPost(
        lockedPost,
        lockedPost.scheduledAccountId || lockedPost.tenantId
      );

      const pubRes = await PublicationService.publishPost({
        post: lockedPost,
        targetTenant,
        caption: lockedPost.caption || '',
        origin: 'SCHEDULER',
        publicBaseUrl: options?.publicBaseUrl,
        pollIntervalMs: options?.pollIntervalMs,
        nowMs,
        persistToPostgres: true,
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
    }

    const finishedAt = new Date().toISOString();
    await recordSchedulerRunInDb({
      runId: workerId,
      startedAt: executedAt,
      finishedAt,
      processedCount: processedPosts.length,
      publishedCount,
      failedCount,
      skippedCount: skippedLockedCount,
    });

    return {
      workerId,
      mode,
      executedAt,
      recoveredStaleLocksCount,
      dueFound,
      publishedCount,
      failedCount,
      reconnectionCount,
      retryScheduledCount,
      skippedLockedCount,
      skippedUnapprovedCount,
      tokenMaintenance,
      processedPosts,
    };
  }

  /**
   * Executa a rotina de renovação preventiva de tokens no PostgreSQL.
   */
  static async runTokenMaintenance(options?: {
    nowMs?: number;
    forceTenantId?: string;
    maxRetries?: number;
    retryDelayMs?: number;
  }): Promise<TokenRefreshJobSummary> {
    SchedulerWorker.isTokenMaintenanceInProgress = true;
    try {
      const nowMs = options?.nowMs ?? Date.now();
      const summary = await TokenService.refreshEligibleTokens({
        nowMs,
        forceTenantId: options?.forceTenantId,
        maxRetries: options?.maxRetries,
        retryDelayMs: options?.retryDelayMs,
      });
      SchedulerWorker.lastTokenMaintenanceMs = nowMs;
      SchedulerWorker.lastTokenMaintenanceHadTransientError = summary.transientErrors > 0;
      return summary;
    } finally {
      SchedulerWorker.isTokenMaintenanceInProgress = false;
    }
  }

  /**
   * Inicia o loop contínuo do Worker em background (funciona tanto no Cloud Run quanto no Railway).
   * - Verifica imediatamente os tokens na largada e repete periodicamente (a cada 6h / diariamente).
   * - Se ocorrer erro temporário na renovação de algum token, agenda nova tentativa controlada sem perder o token atual.
   */
  static startContinuousWorker(options?: {
    intervalMs?: number;
    tokenRefreshIntervalMs?: number;
    runProcessorFn?: () => Promise<any>;
    runTokenRefreshFn?: () => Promise<TokenRefreshJobSummary | any>;
  }): { stop: () => void; intervalMs: number; tokenRefreshIntervalMs: number } {
    if (SchedulerWorker.activeLoopTimer) {
      clearInterval(SchedulerWorker.activeLoopTimer);
      SchedulerWorker.activeLoopTimer = null;
    }
    if (SchedulerWorker.activeTokenTimer) {
      clearInterval(SchedulerWorker.activeTokenTimer);
      SchedulerWorker.activeTokenTimer = null;
    }
    if (SchedulerWorker.transientRetryTimer) {
      clearTimeout(SchedulerWorker.transientRetryTimer);
      SchedulerWorker.transientRetryTimer = null;
    }

    const intervalMs = options?.intervalMs || resolveWorkerIntervalMs();
    const tokenRefreshIntervalMs = options?.tokenRefreshIntervalMs || resolveTokenRefreshIntervalMs();
    const processor = options?.runProcessorFn || (() => SchedulerWorker.runOnce());
    const tokenMaint = options?.runTokenRefreshFn || (() => SchedulerWorker.runTokenMaintenance());

    const executeSafeCycle = async () => {
      if (SchedulerWorker.isCycleInProgress) {
        return;
      }
      SchedulerWorker.isCycleInProgress = true;
      try {
        await processor();
      } catch (err: any) {
        console.error('[SchedulerWorker] Erro durante ciclo de agendamento:', err?.message || err);
      } finally {
        SchedulerWorker.isCycleInProgress = false;
      }
    };

    const executeSafeTokenMaintenance = async () => {
      try {
        const result = await tokenMaint();
        if (result && typeof result.transientErrors === 'number' && result.transientErrors > 0) {
          // Agenda nova tentativa controlada em 15 minutos caso tenha ocorrido erro temporário
          if (SchedulerWorker.transientRetryTimer) {
            clearTimeout(SchedulerWorker.transientRetryTimer);
          }
          SchedulerWorker.transientRetryTimer = setTimeout(() => {
            executeSafeTokenMaintenance().catch(() => {});
          }, 15 * 60 * 1000);
        }
      } catch (err: any) {
        console.error('[SchedulerWorker] Erro na manutenção preventiva de tokens:', err?.message);
      }
    };

    // Dispara primeiro ciclo de agendamentos e verificação inicial de tokens imediatamente
    executeSafeCycle();
    executeSafeTokenMaintenance();

    SchedulerWorker.activeLoopTimer = setInterval(executeSafeCycle, intervalMs);
    SchedulerWorker.activeTokenTimer = setInterval(
      executeSafeTokenMaintenance,
      tokenRefreshIntervalMs
    );

    return {
      intervalMs,
      tokenRefreshIntervalMs,
      stop: () => {
        if (SchedulerWorker.activeLoopTimer) {
          clearInterval(SchedulerWorker.activeLoopTimer);
          SchedulerWorker.activeLoopTimer = null;
        }
        if (SchedulerWorker.activeTokenTimer) {
          clearInterval(SchedulerWorker.activeTokenTimer);
          SchedulerWorker.activeTokenTimer = null;
        }
        if (SchedulerWorker.transientRetryTimer) {
          clearTimeout(SchedulerWorker.transientRetryTimer);
          SchedulerWorker.transientRetryTimer = null;
        }
      },
    };
  }
}
