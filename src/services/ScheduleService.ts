import { dbQuery, withTransaction } from '../db/pool.ts';
import {
  getPostGroupByIdFromDb,
  listPostGroupsFromDb,
  recordApprovalInDb,
} from '../db/repository.ts';
import { PostGroup, PublishLockInfo } from '../types/index.ts';
import { convertSaoPauloToUtcIso } from '../utils/postHelpers.ts';

export const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes lease

function parseJsonSafe<T>(val: any, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val as T;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function toIsoOrUndefined(val: any): string | undefined {
  if (!val) return undefined;
  if (val instanceof Date) return val.toISOString();
  const parsed = Date.parse(String(val));
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/**
 * ScheduleService — Gerenciamento de agendamentos no PostgreSQL independente de hospedagem.
 *
 * Responsabilidades:
 * - Armazenar horários de agendamento em UTC (exibição em America/Sao_Paulo).
 * - Adquirir lock transacional exclusivo no PostgreSQL via FOR UPDATE SKIP LOCKED com lease (TTL).
 * - Recuperar processamentos interrompidos (locks expirados em status PUBLICANDO).
 * - Impedir que múltiplas instâncias (ex: dois workers simultâneos) publiquem o mesmo post.
 */
export class ScheduleService {
  /**
   * Recupera locks abandonados no PostgreSQL quando um worker foi interrompido
   * e o lease (lock_expires_at / publish_lock.expiresAt) já expirou.
   */
  static async recoverStaleLocksInPostgres(nowMs: number = Date.now()): Promise<number> {
    const nowIso = new Date(nowMs).toISOString();

    return await withTransaction(async (tx) => {
      const staleRes = await tx.query<{ id: string; publish_lock: any }>(
        `
        SELECT id, publish_lock
        FROM posts
        WHERE status = 'PUBLICANDO'
        FOR UPDATE SKIP LOCKED
        `
      );

      const expiredIds: string[] = [];
      for (const row of staleRes.rows) {
        const lock = parseJsonSafe<PublishLockInfo | null>(row.publish_lock, null);
        if (!lock || !lock.expiresAt) {
          expiredIds.push(row.id);
          continue;
        }
        const expMs = Date.parse(lock.expiresAt);
        if (Number.isNaN(expMs) || expMs <= nowMs) {
          expiredIds.push(row.id);
        }
      }

      if (expiredIds.length === 0) {
        return 0;
      }

      await tx.query(
        `
        UPDATE posts SET
          status = 'AGENDADO',
          publish_lock = NULL,
          updated_at = $2
        WHERE id = ANY($1::varchar[])
        `,
        [expiredIds, nowIso]
      );

      await tx.query(
        `
        UPDATE schedules SET
          status = 'AGENDADO',
          lock_instance_id = NULL,
          lock_acquired_at = NULL,
          lock_expires_at = NULL,
          updated_at = $2
        WHERE post_id = ANY($1::varchar[])
        `,
        [expiredIds, nowIso]
      );

      await tx.query(
        `
        UPDATE media_assets SET
          status = 'AGENDADO',
          updated_at = $2
        WHERE drive_file_id IN (
          SELECT drive_file_id FROM post_media WHERE post_id = ANY($1::varchar[])
        )
        `,
        [expiredIds, nowIso]
      );

      return expiredIds.length;
    });
  }

  /**
   * Lista IDs candidatos de posts no PostgreSQL cujo horário agendado já venceu (scheduled_at <= now).
   */
  static async findDueCandidatePostIdsInPostgres(nowMs: number = Date.now()): Promise<{
    dueCandidateIds: string[];
    skippedUnapprovedCount: number;
    skippedLockedCount: number;
  }> {
    const nowIso = new Date(nowMs).toISOString();

    const res = await dbQuery<{
      id: string;
      status: string;
      is_approved_for_schedule: boolean;
      scheduled_at: any;
      next_retry_at: any;
      publish_lock: any;
    }>(
      `
      SELECT id, status, is_approved_for_schedule, scheduled_at, next_retry_at, publish_lock
      FROM posts
      WHERE scheduled_at IS NOT NULL
        AND scheduled_at <= $1
      ORDER BY scheduled_at ASC, id ASC
      `,
      [nowIso]
    );

    const dueCandidateIds: string[] = [];
    let skippedUnapprovedCount = 0;
    let skippedLockedCount = 0;

    for (const row of res.rows) {
      if (
        !row.is_approved_for_schedule ||
        row.status === 'CRIADO' ||
        row.status === 'PENDENTE' ||
        row.status === 'PENDENTE_APROVACAO' ||
        row.status === 'REPROVADO'
      ) {
        skippedUnapprovedCount++;
        continue;
      }

      if (row.status === 'PUBLICANDO') {
        skippedLockedCount++;
        continue;
      }

      if (row.status !== 'AGENDADO') {
        continue;
      }

      if (row.next_retry_at) {
        const retryMs = Date.parse(toIsoOrUndefined(row.next_retry_at) || '');
        if (!Number.isNaN(retryMs) && retryMs > nowMs) {
          continue;
        }
      }

      dueCandidateIds.push(row.id);
    }

    return {
      dueCandidateIds,
      skippedUnapprovedCount,
      skippedLockedCount,
    };
  }

  /**
   * Adquire um lock transacional exclusivo no PostgreSQL utilizando `FOR UPDATE SKIP LOCKED`
   * e lease de 5 minutos.
   *
   * Se outra instância/worker já estiver bloqueando a linha na transação ou já tiver
   * adquirido o lease, retorna `{ acquired: false, reason: 'ALREADY_LOCKED' }` imediatamente
   * sem bloquear nem duplicar a publicação.
   */
  static async acquireTransactionalPostLock(
    postId: string,
    workerId: string,
    nowMs: number = Date.now(),
    leaseDurationMs: number = DEFAULT_LEASE_DURATION_MS
  ): Promise<{
    acquired: boolean;
    post?: PostGroup;
    reason?: string;
  }> {
    const outcome = await withTransaction(async (tx) => {
      // FOR UPDATE SKIP LOCKED: se outro worker estiver na transação sobre o mesmo post, pula sem esperar
      const res = await tx.query<any>(
        `SELECT * FROM posts WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [postId]
      );

      if (res.rows.length === 0) {
        // Verifica se não existe ou se estava bloqueado por outra transação concorrente
        const existsRes = await tx.query<{ id: string; status: string }>(
          `SELECT id, status FROM posts WHERE id = $1`,
          [postId]
        );
        if (existsRes.rows.length > 0) {
          return { acquired: false, reason: 'ALREADY_LOCKED' };
        }
        return { acquired: false, reason: 'POST_NOT_FOUND' };
      }

      const p = res.rows[0];

      if (p.status === 'PUBLICANDO') {
        const existingLock = parseJsonSafe<PublishLockInfo | null>(p.publish_lock, null);
        if (existingLock && existingLock.expiresAt) {
          const expMs = Date.parse(existingLock.expiresAt);
          if (!Number.isNaN(expMs) && expMs > nowMs) {
            return { acquired: false, reason: 'ALREADY_LOCKED' };
          }
        }
      } else if (p.status !== 'AGENDADO') {
        return { acquired: false, reason: `INVALID_STATUS_${p.status}` };
      }

      if (!p.is_approved_for_schedule) {
        return { acquired: false, reason: 'NOT_APPROVED_FOR_SCHEDULE' };
      }

      if (!p.scheduled_at) {
        return { acquired: false, reason: 'MISSING_SCHEDULED_AT' };
      }

      const schedMs = Date.parse(toIsoOrUndefined(p.scheduled_at) || '');
      if (Number.isNaN(schedMs) || schedMs > nowMs) {
        return { acquired: false, reason: 'NOT_DUE_YET' };
      }

      if (p.next_retry_at) {
        const retryMs = Date.parse(toIsoOrUndefined(p.next_retry_at) || '');
        if (!Number.isNaN(retryMs) && retryMs > nowMs) {
          return { acquired: false, reason: 'WAITING_BACKOFF_RETRY' };
        }
      }

      const existingLock = parseJsonSafe<PublishLockInfo | null>(p.publish_lock, null);
      if (existingLock && existingLock.expiresAt) {
        const expMs = Date.parse(existingLock.expiresAt);
        if (!Number.isNaN(expMs) && expMs > nowMs) {
          return { acquired: false, reason: 'ALREADY_LOCKED' };
        }
      }

      const lockIso = new Date(nowMs).toISOString();
      const lockExpiresIso = new Date(nowMs + leaseDurationMs).toISOString();
      const lockObj: PublishLockInfo = {
        instanceId: workerId,
        acquiredAt: lockIso,
        expiresAt: lockExpiresIso,
      };

      await tx.query(
        `
        UPDATE posts SET
          status = 'PUBLICANDO',
          publish_lock = $2::jsonb,
          updated_at = NOW()
        WHERE id = $1
        `,
        [postId, JSON.stringify(lockObj)]
      );

      await tx.query(
        `
        UPDATE media_assets SET
          status = 'PUBLICANDO',
          updated_at = NOW()
        WHERE drive_file_id IN (SELECT drive_file_id FROM post_media WHERE post_id = $1)
        `,
        [postId]
      );

      await tx.query(
        `
        INSERT INTO schedules (
          id, post_id, instagram_account_id, scheduled_at, scheduled_timezone,
          status, retry_count, next_retry_at, lock_instance_id, lock_acquired_at, lock_expires_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          'PUBLICANDO', $6, $7, $8, $9, $10, NOW()
        )
        ON CONFLICT (post_id) DO UPDATE SET
          status = 'PUBLICANDO',
          lock_instance_id = EXCLUDED.lock_instance_id,
          lock_acquired_at = EXCLUDED.lock_acquired_at,
          lock_expires_at = EXCLUDED.lock_expires_at,
          updated_at = NOW()
        `,
        [
          `sched_${postId}`,
          postId,
          p.scheduled_account_id || p.instagram_account_id || null,
          p.scheduled_at,
          p.scheduled_timezone || 'America/Sao_Paulo',
          p.publish_attempts || 0,
          p.next_retry_at || null,
          workerId,
          lockIso,
          lockExpiresIso,
        ]
      );

      return { acquired: true };
    });

    if (!outcome.acquired) {
      return outcome;
    }

    const lockedPost = await getPostGroupByIdFromDb(postId);
    return {
      acquired: true,
      post: lockedPost || undefined,
    };
  }

  /**
   * Cria ou atualiza um agendamento aprovado em UTC no PostgreSQL.
   */
  static async scheduleApprovedPost(params: {
    postId: string;
    caption: string;
    approvedBy: string;
    scheduledAccountId: string;
    scheduledAtUtc?: string;
    scheduledDate?: string;
    scheduledTime?: string;
    scheduledTimezone?: string;
  }): Promise<{
    ok: boolean;
    scheduledAtUtc?: string;
    post?: PostGroup;
    errorMessage?: string;
  }> {
    let scheduledUtcIso: string | null = null;
    if (params.scheduledAtUtc && !Number.isNaN(Date.parse(params.scheduledAtUtc))) {
      scheduledUtcIso = new Date(params.scheduledAtUtc).toISOString();
    } else if (params.scheduledDate && params.scheduledTime) {
      scheduledUtcIso = convertSaoPauloToUtcIso(
        String(params.scheduledDate),
        String(params.scheduledTime)
      );
    }

    if (!scheduledUtcIso) {
      return {
        ok: false,
        errorMessage: 'Data e hora válidas são obrigatórias para agendamento (fuso America/Sao_Paulo).',
      };
    }

    await recordApprovalInDb({
      postId: params.postId,
      caption: params.caption,
      action: 'APPROVE_AND_SCHEDULE',
      approvedBy: params.approvedBy,
      scheduledAtUtc: scheduledUtcIso,
      scheduledTimezone: params.scheduledTimezone || 'America/Sao_Paulo',
      scheduledAccountId: params.scheduledAccountId,
    });

    const updatedPost = await getPostGroupByIdFromDb(params.postId);
    return {
      ok: true,
      scheduledAtUtc: scheduledUtcIso,
      post: updatedPost || undefined,
    };
  }

  /**
   * Cancela um agendamento no PostgreSQL.
   */
  static async cancelSchedule(postId: string): Promise<PostGroup | null> {
    await withTransaction(async (tx) => {
      await tx.query(
        `
        UPDATE posts SET
          status = 'CANCELADO',
          publish_lock = NULL,
          next_retry_at = NULL,
          updated_at = NOW()
        WHERE id = $1
        `,
        [postId]
      );

      await tx.query(
        `
        UPDATE media_assets SET
          status = 'CANCELADO',
          updated_at = NOW()
        WHERE drive_file_id IN (SELECT drive_file_id FROM post_media WHERE post_id = $1)
        `,
        [postId]
      );

      await tx.query(
        `
        UPDATE schedules SET
          status = 'CANCELADO',
          lock_instance_id = NULL,
          lock_acquired_at = NULL,
          lock_expires_at = NULL,
          next_retry_at = NULL,
          updated_at = NOW()
        WHERE post_id = $1
        `,
        [postId]
      );
    });

    return await getPostGroupByIdFromDb(postId);
  }

  /**
   * Consulta todos os posts agendados ou em fila de publicação no PostgreSQL.
   */
  static async listScheduledQueueFromPostgres(): Promise<PostGroup[]> {
    const allPosts = await listPostGroupsFromDb();
    return allPosts.filter(
      (p) =>
        p.status === 'AGENDADO' ||
        p.status === 'PUBLICANDO' ||
        p.status === 'RECONEXAO_NECESSARIA' ||
        p.status === 'FALHA_PUBLICACAO'
    );
  }
}
