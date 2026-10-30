import dotenv from 'dotenv';
import { checkDatabaseConnection } from './pool.ts';
import { runDatabaseMigrations } from './migrations.ts';
import { getDatabaseTableCounts } from './repository.ts';
import { runJsonToPostgresMigration } from './migrateFromJson.ts';

dotenv.config();

async function main() {
  const command = process.argv[2] || 'status';
  const isDryRun = process.argv.includes('--dry-run');

  console.log(`[ATO Social Hub DB CLI] Comando: ${command} ${isDryRun ? '(DRY-RUN)' : ''}`);
  const conn = await checkDatabaseConnection();

  if (!conn.connected) {
    console.error('[ATO Social Hub DB CLI] Banco PostgreSQL indisponível:', {
      configured: conn.configured,
      driver: conn.driver,
      host: conn.host,
      error: conn.error,
    });
    process.exit(1);
  }

  console.log('[ATO Social Hub DB CLI] Conectado ao PostgreSQL:', {
    driver: conn.driver,
    host: conn.host,
    database: conn.database,
    tlsEnabled: conn.tlsEnabled,
    latencyMs: conn.latencyMs,
  });

  if (command === 'migrate') {
    const res = await runDatabaseMigrations();
    console.log('[ATO Social Hub DB CLI] Resultado das migrations:', res);
    const counts = await getDatabaseTableCounts();
    console.log('[ATO Social Hub DB CLI] Contagem de registros por tabela:', counts);
    process.exit(0);
  }

  if (command === 'import') {
    const report = await runJsonToPostgresMigration({ dryRun: isDryRun });
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  // status
  await runDatabaseMigrations();
  const counts = await getDatabaseTableCounts();
  console.log(
    JSON.stringify(
      {
        connection: conn,
        tableCounts: counts,
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[ATO Social Hub DB CLI] Erro fatal:', err.message);
  process.exit(1);
});
