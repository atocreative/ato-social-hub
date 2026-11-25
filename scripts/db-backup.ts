/**
 * Backup lógico VERIFICÁVEL das tabelas do ATO Social Hub (nunca toca em tabelas de outros projetos no mesmo banco).
 *
 *   backup          DATABASE_URL=<origem>          npx tsx scripts/db-backup.ts backup [pasta-de-saida]
 *   verify-restore  RESTORE_DATABASE_URL=<vazio>   npx tsx scripts/db-backup.ts verify-restore <pasta-do-backup>
 *
 * - O backup usa transação somente leitura (nenhuma escrita na origem).
 * - verify-restore recusa restaurar no mesmo banco da origem e recusa banco com dados nas tabelas do Social Hub.
 *   O banco de destino precisa ter o schema (rode `npm run db:migrate` apontando para ele antes).
 * - Compara contagem e hash SHA-256 de cada tabela com o manifest. Falha (exit 1) se qualquer um divergir.
 * - Nunca imprime URL, senha ou conteúdo das linhas. O backup contém tokens CIFRADOS e dados de clientes:
 *   guarde fora do Git e com acesso restrito.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import 'dotenv/config';
import { ALL_MANAGED_TABLES } from '../src/db/migrations.ts';

const TABLES = ALL_MANAGED_TABLES.filter((t) => t !== 'schema_migrations');

function connectionOf(url: string) {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  const mode = (u.searchParams.get('sslmode') || process.env.PGSSLMODE || '').toLowerCase();
  const ssl = mode === 'disable' || (local && mode !== 'require') ? false : { rejectUnauthorized: false };
  return { client: new pg.Client({ connectionString: url, ssl }), id: `${u.hostname}:${u.port || '5432'}${u.pathname}` };
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;

async function tableExists(c: pg.Client, t: string) {
  const r = await c.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t]);
  return r.rowCount! > 0;
}

async function readLines(c: pg.Client, t: string): Promise<string[]> {
  const r = await c.query(`SELECT row_to_json(x)::text AS j FROM ${quote(t)} x ORDER BY 1`);
  return r.rows.map((row) => row.j as string);
}

async function backup(outArg?: string) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL ausente.');
  const { client, id } = connectionOf(url);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(outArg || path.join('backups-db', stamp));
  fs.mkdirSync(dir, { recursive: true });

  await client.connect();
  await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
  await client.query(`SET TIME ZONE 'UTC'`);
  const manifest: any = {
    createdAt: new Date().toISOString(),
    source: id.replace(/\/.*$/, '/…'), // sem nome do banco/credenciais no manifest
    tables: {} as Record<string, { rows: number; sha256: string }>,
    migrations: [] as string[],
  };
  if (await tableExists(client, 'schema_migrations')) {
    manifest.migrations = (await client.query(`SELECT version FROM schema_migrations WHERE version IS NOT NULL ORDER BY version`)).rows.map((r) => r.version);
  }
  for (const t of TABLES) {
    if (!(await tableExists(client, t))) {
      manifest.tables[t] = { rows: 0, sha256: sha(''), missing: true };
      continue;
    }
    const lines = await readLines(client, t);
    fs.writeFileSync(path.join(dir, `${t}.ndjson`), lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
    manifest.tables[t] = { rows: lines.length, sha256: sha(lines.join('\n')) };
  }
  await client.query('ROLLBACK');
  await client.end();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const total = Object.values<any>(manifest.tables).reduce((n, t) => n + t.rows, 0);
  console.log(`Backup concluído: ${Object.keys(manifest.tables).length} tabelas, ${total} linhas.`);
  console.log(`Pasta: ${dir}`);
}

async function verifyRestore(dirArg?: string) {
  if (!dirArg) throw new Error('Informe a pasta do backup.');
  const dir = path.resolve(dirArg);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const url = process.env.RESTORE_DATABASE_URL;
  if (!url) throw new Error('RESTORE_DATABASE_URL ausente (banco de destino VAZIO e descartável).');
  const { client, id } = connectionOf(url);
  if (process.env.DATABASE_URL && connectionOf(process.env.DATABASE_URL).id === id) {
    throw new Error('RESTORE_DATABASE_URL aponta para o mesmo banco de DATABASE_URL. Recusado.');
  }
  await client.connect();
  await client.query(`SET TIME ZONE 'UTC'`);

  for (const t of TABLES) {
    if (manifest.tables[t]?.missing) continue;
    if (!(await tableExists(client, t))) throw new Error(`Destino sem a tabela ${t}. Rode db:migrate no destino antes.`);
    const n = Number((await client.query(`SELECT count(*) n FROM ${quote(t)}`)).rows[0].n);
    if (n > 0) throw new Error(`Destino não está vazio (${t} tem ${n} linhas). Recusado.`);
  }

  await client.query('BEGIN');
  await client.query(`SET LOCAL session_replication_role = replica`); // ignora FKs durante a carga (exige superusuário)
  for (const t of TABLES) {
    if (manifest.tables[t]?.missing) continue;
    const file = path.join(dir, `${t}.ndjson`);
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    for (const line of lines) {
      await client.query(`INSERT INTO ${quote(t)} SELECT * FROM json_populate_record(null::${quote(t)}, $1::json)`, [line]);
    }
  }
  await client.query('COMMIT');

  let ok = true;
  for (const t of TABLES) {
    const exp = manifest.tables[t];
    if (!exp || exp.missing) continue;
    const lines = await readLines(client, t);
    const good = lines.length === exp.rows && sha(lines.join('\n')) === exp.sha256;
    if (!good) ok = false;
    console.log(`${good ? 'OK    ' : 'DIVERGE'} ${t.padEnd(28)} linhas=${lines.length}/${exp.rows}`);
  }
  await client.end();
  if (!ok) {
    console.error('\nRESTAURAÇÃO NÃO CONFERE. Não confie neste backup.');
    process.exit(1);
  }
  console.log('\nRestauração verificada: contagem e hash idênticos em todas as tabelas.');
}

const [cmd, arg] = process.argv.slice(2);
(cmd === 'backup' ? backup(arg) : cmd === 'verify-restore' ? verifyRestore(arg) : Promise.reject(new Error('Uso: backup [pasta] | verify-restore <pasta>')))
  .catch((e) => {
    console.error('ERRO:', e.message);
    process.exit(1);
  });
