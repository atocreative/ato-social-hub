import dotenv from 'dotenv';
import { checkDatabaseConnection, closeDatabasePool } from './db/pool.ts';
import { runDatabaseMigrations } from './db/migrations.ts';
import { ensureDefaultAdminUser } from './db/repository.ts';
import { resolveWorkerIntervalMs, SchedulerWorker } from './services/SchedulerWorker.ts';

dotenv.config();

async function bootstrapWorkerDatabase() {
  const conn = await checkDatabaseConnection();
  if (!conn.connected) {
    throw new Error(
      `[ATO Worker] Falha ao conectar ao PostgreSQL (${conn.driver}): ${conn.error || 'sem detalhes'}`
    );
  }
  await runDatabaseMigrations();
  await ensureDefaultAdminUser();
  return conn;
}

async function main() {
  const rawCommand = (process.argv[2] || 'start').trim().toLowerCase();

  try {
    const conn = await bootstrapWorkerDatabase();
    console.log(
      `[ATO Worker] Conectado ao PostgreSQL (driver=${conn.driver}, host=${conn.host || 'local'}, latency=${conn.latencyMs}ms)`
    );

    if (rawCommand === 'once' || rawCommand === 'scheduler:once') {
      const summary = await SchedulerWorker.runOnce();
      console.log('[ATO Worker] Execução única de agendamentos concluída:');
      console.log(JSON.stringify(summary, null, 2));
      await closeDatabasePool();
      process.exit(0);
    }

    if (
      rawCommand === 'refresh-tokens' ||
      rawCommand === 'tokens:refresh' ||
      rawCommand === 'tokens'
    ) {
      const summary = await SchedulerWorker.runTokenMaintenance();
      console.log('[ATO Worker] Manutenção preventiva de tokens concluída:');
      console.log(JSON.stringify(summary, null, 2));
      await closeDatabasePool();
      process.exit(0);
    }

    // Modo contínuo (worker:start)
    process.env.SCHEDULER_MODE = 'worker';
    const intervalMs = resolveWorkerIntervalMs();
    console.log(
      `[ATO Worker] Iniciando worker contínuo (SCHEDULER_MODE=worker, intervalo=${intervalMs}ms)...`
    );

    // Executa manutenção preventiva de tokens na largada
    await SchedulerWorker.runTokenMaintenance().catch((err) => {
      console.warn('[ATO Worker] Aviso na verificação inicial de tokens:', err?.message);
    });

    const controller = SchedulerWorker.startContinuousWorker({ intervalMs });

    const shutdown = async (signal: string) => {
      console.log(`[ATO Worker] Sinal ${signal} recebido. Encerrando worker com segurança...`);
      controller.stop();
      await closeDatabasePool();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err: any) {
    console.error('[ATO Worker] Erro fatal:', err?.message || err);
    await closeDatabasePool();
    process.exit(1);
  }
}

main();
