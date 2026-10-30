import 'dotenv/config';
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_PGDATA_DIR = path.resolve(__dirname, '../../.data/pgdata');

export class DatabaseUnavailableError extends Error {
  public readonly statusCode = 503;
  public readonly code: string;

  constructor(message: string, code = 'DATABASE_UNAVAILABLE') {
    super(message);
    this.name = 'DatabaseUnavailableError';
    this.code = code;
  }
}

export interface DbQueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface DbClientLike {
  query<T = any>(text: string, params?: any[]): Promise<DbQueryResult<T>>;
}

export interface SafeDatabaseConnectionInfo {
  configured: boolean;
  railwayConfigured: boolean;
  connected: boolean;
  driver: 'pg-railway' | 'pglite-local' | 'pglite-test' | 'unconfigured';
  host?: string;
  port?: number;
  database?: string;
  tlsEnabled: boolean;
  rejectUnauthorized: boolean;
  poolMax: number;
  latencyMs?: number;
  serverVersion?: string;
  error?: string;
}

let pgPool: pg.Pool | null = null;
let currentConnectionString = '';
let pgliteInstance: any = null;
let pgliteMode: 'pglite-local' | 'pglite-test' | null = null;
let pgliteInitPromise: Promise<any> | null = null;
let simulatedOutageForTest = false;
let strictRequireRailwayUrl = false;

/**
 * Sanitizes DATABASE_URL without logging or returning credentials.
 */
export function getDatabaseUrlFromEnv(): string {
  const raw = String(process.env.DATABASE_URL || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
  if (
    !raw ||
    raw.includes('<URL_POSTGRESQL_RAILWAY>') ||
    raw.includes('<PASSWORD>') ||
    raw.includes('<HOST>') ||
    raw.includes('YOUR_DATABASE_URL') ||
    raw.includes('COLE_AQUI') ||
    raw.includes('postgres:password@localhost:5432')
  ) {
    return '';
  }
  return raw;
}

/**
 * Extracts non-sensitive metadata from DATABASE_URL (host, port, database, ssl flags).
 * NEVER exposes username, password, or full connection string.
 */
export function parseSafeConnectionMetadata(connStr?: string): {
  configured: boolean;
  host?: string;
  port?: number;
  database?: string;
  tlsEnabled: boolean;
  rejectUnauthorized: boolean;
} {
  const urlStr = connStr ?? getDatabaseUrlFromEnv();
  if (!urlStr) {
    return {
      configured: false,
      tlsEnabled: false,
      rejectUnauthorized: true,
    };
  }

  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname || 'unknown';
    const port = parsed.port ? Number(parsed.port) : 5432;
    const database = (parsed.pathname || '').replace(/^\/+/, '') || 'railway';
    const sslMode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
    const isLocal =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.internal');

    const tlsEnabled =
      sslMode !== 'disable' &&
      (!isLocal ||
        sslMode === 'require' ||
        sslMode === 'verify-ca' ||
        sslMode === 'verify-full' ||
        process.env.DB_SSL === 'true');

    const explicitVerify =
      sslMode === 'verify-full' ||
      sslMode === 'verify-ca' ||
      process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' ||
      Boolean(process.env.DATABASE_CA_CERT);
    const rejectUnauthorized =
      process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false'
        ? false
        : explicitVerify
        ? true
        : !hostname.includes('rlwy.net') && !hostname.includes('railway.app')
        ? true
        : Boolean(process.env.DATABASE_CA_CERT);

    return {
      configured: true,
      host: hostname,
      port,
      database,
      tlsEnabled,
      rejectUnauthorized,
    };
  } catch {
    return {
      configured: true,
      host: 'invalid-url-format',
      tlsEnabled: true,
      rejectUnauthorized: true,
    };
  }
}

/**
 * Builds the pg.Pool configured for Cloud Run concurrency and Railway TLS.
 */
export function getPgPool(): pg.Pool {
  if (simulatedOutageForTest) {
    throw new DatabaseUnavailableError(
      'Banco de dados PostgreSQL temporariamente indisponível (simulação de falha ativa).',
      'DB_SIMULATED_OUTAGE'
    );
  }

  const dbUrl = getDatabaseUrlFromEnv();
  if (!dbUrl) {
    throw new DatabaseUnavailableError(
      'A variável de ambiente DATABASE_URL não está configurada. Configure a conexão do PostgreSQL Railway nos Secrets do ambiente.',
      'DATABASE_URL_MISSING'
    );
  }

  if (pgPool && currentConnectionString === dbUrl) {
    return pgPool;
  }

  if (pgPool) {
    pgPool.end().catch(() => {});
    pgPool = null;
  }

  const meta = parseSafeConnectionMetadata(dbUrl);
  const poolMax = Math.max(2, Math.min(25, Number(process.env.DB_POOL_MAX || 10)));
  const connectionTimeoutMillis = Number(process.env.DB_CONNECT_TIMEOUT_MS || 10_000);
  const idleTimeoutMillis = Number(process.env.DB_IDLE_TIMEOUT_MS || 30_000);

  const sslConfig: pg.PoolConfig['ssl'] = meta.tlsEnabled
    ? {
        rejectUnauthorized: meta.rejectUnauthorized,
        ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT } : {}),
      }
    : false;

  pgPool = new Pool({
    connectionString: dbUrl,
    max: poolMax,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    allowExitOnIdle: false,
    keepAlive: true,
    ssl: sslConfig,
  });

  pgPool.on('error', (err) => {
    console.error('[PostgreSQL Pool] Erro inesperado em cliente ocioso:', err.message);
  });

  currentConnectionString = dbUrl;
  return pgPool;
}

async function getOrInitEmbeddedPostgres(): Promise<any> {
  if (pgliteInstance) return pgliteInstance;
  if (pgliteInitPromise) return await pgliteInitPromise;

  pgliteInitPromise = (async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    if (process.env.ATO_TEST_MODE || process.env.VITEST) {
      const inst = new PGlite();
      await inst.query('SELECT 1');
      pgliteInstance = inst;
      pgliteMode = 'pglite-test';
      return pgliteInstance;
    }

    try {
      if (!fs.existsSync(LOCAL_PGDATA_DIR)) {
        fs.mkdirSync(LOCAL_PGDATA_DIR, { recursive: true });
      }
      const inst = new PGlite(LOCAL_PGDATA_DIR);
      await inst.query('SELECT 1');
      pgliteInstance = inst;
      pgliteMode = 'pglite-local';
      return pgliteInstance;
    } catch (initErr: any) {
      console.warn(
        '[PGlite] Recuperando .data/pgdata após reinicialização abrupta do processo:',
        initErr?.message
      );
      try {
        fs.rmSync(LOCAL_PGDATA_DIR, { recursive: true, force: true });
        fs.mkdirSync(LOCAL_PGDATA_DIR, { recursive: true });
        const freshInst = new PGlite(LOCAL_PGDATA_DIR);
        await freshInst.query('SELECT 1');
        pgliteInstance = freshInst;
        pgliteMode = 'pglite-local';
        return pgliteInstance;
      } catch {
        const memInst = new PGlite();
        await memInst.query('SELECT 1');
        pgliteInstance = memInst;
        pgliteMode = 'pglite-local';
        return pgliteInstance;
      }
    }
  })();

  try {
    return await pgliteInitPromise;
  } finally {
    pgliteInitPromise = null;
  }
}

/**
 * Enables an embedded PGlite PostgreSQL engine explicitly for test suites.
 */
export async function enablePGliteForTesting(instance?: any): Promise<void> {
  if (instance) {
    pgliteInstance = instance;
    pgliteMode = 'pglite-test';
    return;
  }
  const { PGlite } = await import('@electric-sql/pglite');
  pgliteInstance = new PGlite();
  pgliteMode = 'pglite-test';
}

export async function disablePGliteForTesting(): Promise<void> {
  if (pgliteInstance && typeof pgliteInstance.close === 'function') {
    await pgliteInstance.close().catch(() => {});
  }
  pgliteInstance = null;
  pgliteMode = null;
}

export function setSimulatedDatabaseOutageForTest(outage: boolean): void {
  simulatedOutageForTest = outage;
}

export const setSimulateDatabaseUnavailable = setSimulatedDatabaseOutageForTest;

export function isDatabaseUnavailableSimulated(): boolean {
  return simulatedOutageForTest;
}

export function setStrictRequireRailwayUrl(strict: boolean): void {
  strictRequireRailwayUrl = strict;
}

export function isRailwayDatabaseConfigured(): boolean {
  return Boolean(getDatabaseUrlFromEnv());
}

export const isRailwayDatabaseUrlConfigured = isRailwayDatabaseConfigured;

function shouldUseEmbeddedPostgresFallback(): boolean {
  if (strictRequireRailwayUrl || process.env.STRICT_REQUIRE_DATABASE_URL === 'true') {
    return false;
  }
  // If DATABASE_URL is configured, NEVER use embedded fallback—always use Railway pg.Pool!
  if (getDatabaseUrlFromEnv()) {
    return false;
  }
  return true;
}

/**
 * Executes a parameterized SQL query against PostgreSQL Railway (when DATABASE_URL is set)
 * or embedded PostgreSQL 16 engine in local AI Studio preview / test suites.
 * Never falls back to JSON files.
 */
export async function dbQuery<T = any>(
  text: string,
  params: any[] = []
): Promise<DbQueryResult<T>> {
  if (simulatedOutageForTest) {
    throw new DatabaseUnavailableError(
      'Serviço de banco de dados PostgreSQL indisponível no momento. Nenhuma alteração foi gravada.',
      'DB_CONNECTION_FAILED'
    );
  }

  if (!getDatabaseUrlFromEnv() && shouldUseEmbeddedPostgresFallback()) {
    const pgl = await getOrInitEmbeddedPostgres();
    try {
      const res = await pgl.query(text, params);
      return {
        rows: (res.rows || []) as T[],
        rowCount: res.affectedRows ?? (res.rows ? res.rows.length : 0),
      };
    } catch (err: any) {
      throw new Error(`[PostgreSQL Query Error]: ${err.message}`);
    }
  }

  const pool = getPgPool();
  try {
    const res = await pool.query(text, params);
    return {
      rows: res.rows as T[],
      rowCount: res.rowCount,
    };
  } catch (err: any) {
    const isConnErr =
      err.code === 'ECONNREFUSED' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'ENOTFOUND' ||
      err.code === '57P01' ||
      err.code === '08006' ||
      err.code === '08001' ||
      String(err.message || '').toLowerCase().includes('timeout') ||
      String(err.message || '').toLowerCase().includes('connection terminated');

    if (isConnErr) {
      throw new DatabaseUnavailableError(
        `Falha de conexão com o PostgreSQL Railway (${err.code || 'TIMEOUT'}). Operação abortada de forma segura.`,
        err.code || 'DB_CONNECTION_ERROR'
      );
    }
    throw err;
  }
}

/**
 * Runs a callback inside an ACID PostgreSQL transaction (BEGIN -> COMMIT / ROLLBACK).
 */
export async function withTransaction<T>(
  fn: (client: DbClientLike) => Promise<T>
): Promise<T> {
  if (simulatedOutageForTest) {
    throw new DatabaseUnavailableError(
      'Serviço de banco de dados PostgreSQL indisponível no momento. Transação abortada.',
      'DB_CONNECTION_FAILED'
    );
  }

  if (!getDatabaseUrlFromEnv() && shouldUseEmbeddedPostgresFallback()) {
    const pgl = await getOrInitEmbeddedPostgres();
    return await pgl.transaction(async (tx: any) => {
      const clientLike: DbClientLike = {
        query: async <R = any>(text: string, params: any[] = []) => {
          const r = await tx.query(text, params);
          return {
            rows: (r.rows || []) as R[],
            rowCount: r.affectedRows ?? (r.rows ? r.rows.length : 0),
          };
        },
      };
      return await fn(clientLike);
    });
  }

  const pool = getPgPool();
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
  } catch (err: any) {
    throw new DatabaseUnavailableError(
      `Não foi possível obter conexão do pool PostgreSQL Railway (${err.code || err.message}).`,
      'DB_POOL_CONNECT_ERROR'
    );
  }

  try {
    await client.query('BEGIN');
    const clientLike: DbClientLike = {
      query: async <R = any>(text: string, params: any[] = []) => {
        const res = await client!.query(text, params);
        return {
          rows: res.rows as R[],
          rowCount: res.rowCount,
        };
      },
    };
    const result = await fn(clientLike);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback error
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Checks PostgreSQL connectivity on startup and for the protected diagnostic endpoint.
 * Never exposes passwords or full DATABASE_URL.
 */
export async function checkDatabaseConnection(): Promise<SafeDatabaseConnectionInfo> {
  const poolMax = Math.max(2, Math.min(25, Number(process.env.DB_POOL_MAX || 10)));
  const railwayMeta = parseSafeConnectionMetadata();

  if (simulatedOutageForTest) {
    return {
      configured: railwayMeta.configured,
      railwayConfigured: railwayMeta.configured,
      connected: false,
      driver: railwayMeta.configured ? 'pg-railway' : pgliteMode || 'pglite-local',
      tlsEnabled: railwayMeta.tlsEnabled,
      rejectUnauthorized: railwayMeta.rejectUnauthorized,
      poolMax,
      error: 'Falha simulada de conexão com o banco de dados PostgreSQL.',
    };
  }

  if (railwayMeta.configured) {
    const start = Date.now();
    try {
      const pool = getPgPool();
      const res = await pool.query<{ version: string }>('SELECT version() AS version');
      return {
        configured: true,
        railwayConfigured: true,
        connected: true,
        driver: 'pg-railway',
        host: railwayMeta.host,
        port: railwayMeta.port,
        database: railwayMeta.database,
        tlsEnabled: railwayMeta.tlsEnabled,
        rejectUnauthorized: railwayMeta.rejectUnauthorized,
        poolMax,
        latencyMs: Date.now() - start,
        serverVersion: res.rows[0]?.version,
      };
    } catch (err: any) {
      return {
        configured: true,
        railwayConfigured: true,
        connected: false,
        driver: 'pg-railway',
        host: railwayMeta.host,
        port: railwayMeta.port,
        database: railwayMeta.database,
        tlsEnabled: railwayMeta.tlsEnabled,
        rejectUnauthorized: railwayMeta.rejectUnauthorized,
        poolMax,
        latencyMs: Date.now() - start,
        error: err.message || 'Falha ao conectar no PostgreSQL Railway.',
      };
    }
  }

  if (!shouldUseEmbeddedPostgresFallback()) {
    return {
      configured: false,
      railwayConfigured: false,
      connected: false,
      driver: 'unconfigured',
      tlsEnabled: false,
      rejectUnauthorized: true,
      poolMax,
      error: 'Variável DATABASE_URL do PostgreSQL Railway não está configurada nos Secrets do ambiente.',
    };
  }

  const start = Date.now();
  try {
    const pgl = await getOrInitEmbeddedPostgres();
    const r = await pgl.query('SELECT version() AS version');
    return {
      configured: true,
      railwayConfigured: false,
      connected: true,
      driver: pgliteMode || 'pglite-local',
      host: 'local-postgres-engine (.data/pgdata)',
      port: 5432,
      database: 'ato_social_hub',
      tlsEnabled: false,
      rejectUnauthorized: false,
      poolMax,
      latencyMs: Date.now() - start,
      serverVersion: r.rows?.[0]?.version || 'PostgreSQL 16 (Embedded Engine - Aguardando DATABASE_URL Railway)',
    };
  } catch (err: any) {
    return {
      configured: false,
      railwayConfigured: false,
      connected: false,
      driver: 'unconfigured',
      tlsEnabled: false,
      rejectUnauthorized: false,
      poolMax,
      error: err.message,
    };
  }
}

export async function closeDatabasePool(): Promise<void> {
  if (pgPool) {
    await pgPool.end().catch(() => {});
    pgPool = null;
    currentConnectionString = '';
  }
  if (pgliteInstance && typeof pgliteInstance.close === 'function') {
    await pgliteInstance.close().catch(() => {});
    pgliteInstance = null;
    pgliteMode = null;
  }
}

