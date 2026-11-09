import { dbQuery, withTransaction } from './pool.ts';

export interface MigrationDefinition {
  version: string;
  name: string;
  sql: string;
}

export const POSTGRES_MIGRATIONS: MigrationDefinition[] = [
  {
    version: '001_initial_ato_social_hub_schema',
    name: 'Estrutura relacional completa do ATO Social Hub (Usuários, Empresas, Instagram, Editorial, Agendamento e IA)',
    sql: `
      -- 1. Módulo de Empresas (Companies & Identidade de Marca para IA)
      CREATE TABLE IF NOT EXISTS companies (
        id VARCHAR(128) PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        drive_folder_id VARCHAR(255),
        drive_folder_name VARCHAR(255) NOT NULL,
        drive_folder_url TEXT,
        segment VARCHAR(255),
        brand_voice TEXT,
        target_audience TEXT,
        default_cta TEXT,
        default_hashtags TEXT,
        ai_guidelines TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_companies_drive_folder_id ON companies(drive_folder_id);
      CREATE INDEX IF NOT EXISTS idx_companies_drive_folder_name ON companies(LOWER(drive_folder_name));

      -- 2. Módulo Instagram (InstagramAccounts & Tokens Criptografados)
      CREATE TABLE IF NOT EXISTS instagram_accounts (
        id VARCHAR(128) PRIMARY KEY,
        company_id VARCHAR(128) REFERENCES companies(id) ON DELETE SET NULL,
        username VARCHAR(255) NOT NULL UNIQUE,
        nome VARCHAR(255) NOT NULL,
        instagram_user_id VARCHAR(255) NOT NULL,
        account_type VARCHAR(64),
        avatar_url TEXT,
        drive_folder_name VARCHAR(255),
        drive_folder_id VARCHAR(255),
        status VARCHAR(64) NOT NULL DEFAULT 'PENDENTE',
        encrypted_access_token TEXT,
        token_type VARCHAR(32) DEFAULT 'LONG_LIVED',
        token_issued_at TIMESTAMPTZ,
        token_expires_at TIMESTAMPTZ,
        last_token_refresh_at TIMESTAMPTZ,
        granted_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
        connection_status VARCHAR(64) NOT NULL DEFAULT 'CONECTADO',
        last_connection_error TEXT,
        reconnection_required_at TIMESTAMPTZ,
        has_valid_token BOOLEAN NOT NULL DEFAULT FALSE,
        requested_at TIMESTAMPTZ,
        approved_at TIMESTAMPTZ,
        last_sync_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_ig_accounts_company_id ON instagram_accounts(company_id);
      CREATE INDEX IF NOT EXISTS idx_ig_accounts_ig_user_id ON instagram_accounts(instagram_user_id);
      CREATE INDEX IF NOT EXISTS idx_ig_accounts_status ON instagram_accounts(status);

      -- 3. Módulo de Usuários (Users, Roles e Permissões)
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(128) PRIMARY KEY,
        email VARCHAR(255) UNIQUE,
        name VARCHAR(255) NOT NULL,
        password_hash TEXT,
        role VARCHAR(32) NOT NULL DEFAULT 'TENANT',
        status VARCHAR(64) NOT NULL DEFAULT 'APROVADO',
        company_id VARCHAR(128) REFERENCES companies(id) ON DELETE SET NULL,
        instagram_account_id VARCHAR(128) REFERENCES instagram_accounts(id) ON DELETE SET NULL,
        permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
      CREATE INDEX IF NOT EXISTS idx_users_ig_account ON users(instagram_account_id);

      -- 4. Módulo Editorial: Postagens / Lotes (Posts)
      CREATE TABLE IF NOT EXISTS posts (
        id VARCHAR(255) PRIMARY KEY,
        company_id VARCHAR(128) REFERENCES companies(id) ON DELETE SET NULL,
        instagram_account_id VARCHAR(128) REFERENCES instagram_accounts(id) ON DELETE SET NULL,
        lote_nome VARCHAR(255) NOT NULL,
        nome VARCHAR(255) NOT NULL,
        categoria VARCHAR(64) NOT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'PENDENTE',
        caption TEXT,
        active_caption_id VARCHAR(128),
        caption_approved BOOLEAN NOT NULL DEFAULT FALSE,
        caption_source VARCHAR(32) DEFAULT 'MANUAL',
        drive_folder_name VARCHAR(255),
        pasta_cliente_nome VARCHAR(255),
        pasta_cliente_id VARCHAR(255),
        pasta_url TEXT,
        scheduled_at TIMESTAMPTZ,
        scheduled_timezone VARCHAR(64) DEFAULT 'America/Sao_Paulo',
        scheduled_account_id VARCHAR(128),
        published_at TIMESTAMPTZ,
        instagram_media_id VARCHAR(255),
        instagram_container_id VARCHAR(255),
        child_container_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        instagram_permalink TEXT,
        approved_at TIMESTAMPTZ,
        approved_by VARCHAR(255),
        is_approved_for_schedule BOOLEAN NOT NULL DEFAULT FALSE,
        publish_attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TIMESTAMPTZ,
        next_retry_at TIMESTAMPTZ,
        failure_reason TEXT,
        publish_lock JSONB,
        rejection_feedback JSONB,
        data_criacao TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
      CREATE INDEX IF NOT EXISTS idx_posts_company_id ON posts(company_id);
      CREATE INDEX IF NOT EXISTS idx_posts_ig_account_id ON posts(instagram_account_id);
      CREATE INDEX IF NOT EXISTS idx_posts_scheduled_at ON posts(scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_posts_drive_folder_name ON posts(LOWER(drive_folder_name));

      -- 5. Módulo Editorial: Ativos de Mídia do Google Drive (MediaAssets)
      CREATE TABLE IF NOT EXISTS media_assets (
        drive_file_id VARCHAR(255) PRIMARY KEY,
        company_id VARCHAR(128) REFERENCES companies(id) ON DELETE SET NULL,
        instagram_account_id VARCHAR(128) REFERENCES instagram_accounts(id) ON DELETE SET NULL,
        nome VARCHAR(255) NOT NULL,
        categoria VARCHAR(64) NOT NULL,
        lote_nome VARCHAR(255) NOT NULL,
        view_url TEXT NOT NULL,
        thumbnail_url TEXT NOT NULL,
        download_url TEXT,
        mime_type VARCHAR(128) NOT NULL DEFAULT 'image/png',
        status VARCHAR(64) NOT NULL DEFAULT 'PENDENTE',
        ordem INTEGER NOT NULL DEFAULT 1,
        drive_folder_name VARCHAR(255),
        pasta_cliente_nome VARCHAR(255),
        pasta_cliente_id VARCHAR(255),
        pasta_url TEXT,
        rejection_feedback JSONB,
        data_criacao TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_media_assets_lote ON media_assets(lote_nome);
      CREATE INDEX IF NOT EXISTS idx_media_assets_folder ON media_assets(LOWER(drive_folder_name));

      -- 6. Módulo Editorial: Relação Post <-> Media (PostMedia)
      CREATE TABLE IF NOT EXISTS post_media (
        id VARCHAR(255) PRIMARY KEY,
        post_id VARCHAR(255) NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        drive_file_id VARCHAR(255) NOT NULL REFERENCES media_assets(drive_file_id) ON DELETE CASCADE,
        ordem INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(post_id, drive_file_id)
      );

      CREATE INDEX IF NOT EXISTS idx_post_media_post_id ON post_media(post_id);
      CREATE INDEX IF NOT EXISTS idx_post_media_drive_file_id ON post_media(drive_file_id);

      -- 7. Módulo IA: Histórico de Gerações Gemini (AIGenerations)
      CREATE TABLE IF NOT EXISTS ai_generations (
        id VARCHAR(128) PRIMARY KEY,
        post_id VARCHAR(255) REFERENCES posts(id) ON DELETE SET NULL,
        company_id VARCHAR(128) REFERENCES companies(id) ON DELETE SET NULL,
        model VARCHAR(128) NOT NULL,
        objective TEXT,
        theme TEXT,
        briefing TEXT,
        tone VARCHAR(255),
        cta TEXT,
        include_hashtags BOOLEAN NOT NULL DEFAULT TRUE,
        used_multimodal_image BOOLEAN NOT NULL DEFAULT FALSE,
        generated_text TEXT,
        status VARCHAR(32) NOT NULL DEFAULT 'SUCCESS',
        error_message TEXT,
        latency_ms INTEGER,
        created_by VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_ai_generations_post_id ON ai_generations(post_id);
      CREATE INDEX IF NOT EXISTS idx_ai_generations_company_id ON ai_generations(company_id);

      -- 8. Módulo Editorial: Legendas Versionadas (Captions)
      CREATE TABLE IF NOT EXISTS captions (
        id VARCHAR(128) PRIMARY KEY,
        post_id VARCHAR(255) NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        company_id VARCHAR(128) REFERENCES companies(id) ON DELETE SET NULL,
        version_number INTEGER NOT NULL DEFAULT 1,
        content TEXT NOT NULL,
        source VARCHAR(32) NOT NULL DEFAULT 'MANUAL',
        ai_generation_id VARCHAR(128) REFERENCES ai_generations(id) ON DELETE SET NULL,
        is_selected BOOLEAN NOT NULL DEFAULT TRUE,
        approval_status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
        created_by VARCHAR(255),
        approved_by VARCHAR(255),
        approved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_captions_post_id ON captions(post_id);

      -- 9. Módulo Editorial: Aprovações (Approvals)
      CREATE TABLE IF NOT EXISTS approvals (
        id VARCHAR(128) PRIMARY KEY,
        post_id VARCHAR(255) NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        caption_id VARCHAR(128) REFERENCES captions(id) ON DELETE SET NULL,
        action VARCHAR(64) NOT NULL,
        approved_caption TEXT,
        approved_by VARCHAR(255) NOT NULL,
        approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_post_id ON approvals(post_id);

      -- 10. Módulo Editorial: Reprovações (Rejections)
      CREATE TABLE IF NOT EXISTS rejections (
        id VARCHAR(128) PRIMARY KEY,
        post_id VARCHAR(255) REFERENCES posts(id) ON DELETE SET NULL,
        drive_file_id VARCHAR(255),
        pasta_cliente_id VARCHAR(255),
        pasta_nome VARCHAR(255),
        original_filename VARCHAR(255),
        novo_nome_arquivo VARCHAR(255) NOT NULL,
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        motivo TEXT NOT NULL,
        rejected_by VARCHAR(255),
        data_reprovacao TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_rejections_post_id ON rejections(post_id);
      CREATE INDEX IF NOT EXISTS idx_rejections_data ON rejections(data_reprovacao);

      -- 11. Módulo Editorial: Agendamentos em UTC (Schedules)
      CREATE TABLE IF NOT EXISTS schedules (
        id VARCHAR(128) PRIMARY KEY,
        post_id VARCHAR(255) NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
        instagram_account_id VARCHAR(128) REFERENCES instagram_accounts(id) ON DELETE SET NULL,
        scheduled_at TIMESTAMPTZ NOT NULL,
        scheduled_timezone VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
        status VARCHAR(64) NOT NULL DEFAULT 'AGENDADO',
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ,
        lock_instance_id VARCHAR(128),
        lock_acquired_at TIMESTAMPTZ,
        lock_expires_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(status, scheduled_at);

      -- 12. Módulo Editorial: Tentativas de Publicação (PublicationAttempts)
      CREATE TABLE IF NOT EXISTS publication_attempts (
        id VARCHAR(128) PRIMARY KEY,
        post_id VARCHAR(255) NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        instagram_account_id VARCHAR(128),
        ig_user_id VARCHAR(255),
        attempt_number INTEGER NOT NULL DEFAULT 1,
        origin VARCHAR(32) NOT NULL DEFAULT 'IMMEDIATE',
        container_id VARCHAR(255),
        child_container_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        media_id VARCHAR(255),
        permalink TEXT,
        status VARCHAR(64) NOT NULL,
        http_status INTEGER,
        meta_error_code INTEGER,
        meta_error_subcode INTEGER,
        error_message TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pub_attempts_post_id ON publication_attempts(post_id);

      -- 13. Módulo Editorial: Histórico Consolidado de Publicações (PublicationHistory)
      CREATE TABLE IF NOT EXISTS publication_history (
        id VARCHAR(128) PRIMARY KEY,
        post_id VARCHAR(255) NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        company_id VARCHAR(128) REFERENCES companies(id) ON DELETE SET NULL,
        instagram_account_id VARCHAR(128) REFERENCES instagram_accounts(id) ON DELETE SET NULL,
        ig_user_id VARCHAR(255) NOT NULL,
        container_id VARCHAR(255),
        child_container_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        instagram_media_id VARCHAR(255) NOT NULL,
        permalink TEXT,
        caption TEXT,
        published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_pub_history_post_id ON publication_history(post_id);

      -- 14. Logs Operacionais, Alertas Administrativos e Execuções do Scheduler
      CREATE TABLE IF NOT EXISTS operational_logs (
        id VARCHAR(128) PRIMARY KEY,
        category VARCHAR(64) NOT NULL,
        type VARCHAR(64),
        tenant_id VARCHAR(128),
        username VARCHAR(255),
        post_id VARCHAR(255),
        message TEXT,
        payload JSONB,
        resolved BOOLEAN NOT NULL DEFAULT FALSE,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_operational_logs_category ON operational_logs(category, resolved);
    `,
  },
  {
    version: '002_hidden_media_and_upload_tracking',
    name: 'Ocultação de mídias por usuário e rastreamento rigoroso de mídias enviadas por upload vs drive sync',
    sql: `
      -- Tabela de mídias ocultadas por usuário (preserva o acervo oficial no Drive e DB para os demais)
      CREATE TABLE IF NOT EXISTS user_hidden_media (
        id VARCHAR(128) PRIMARY KEY,
        user_id VARCHAR(128) NOT NULL,
        post_id VARCHAR(255) NOT NULL,
        hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, post_id)
      );

      CREATE INDEX IF NOT EXISTS idx_user_hidden_media_user ON user_hidden_media(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_hidden_media_post ON user_hidden_media(post_id);

      -- Rastreamento de origem oficial (DRIVE_SYNC) vs manual (UPLOAD)
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS origem VARCHAR(64) DEFAULT 'DRIVE_SYNC';
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS created_by_user_id VARCHAR(128);
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_archived_test BOOLEAN NOT NULL DEFAULT FALSE;

      ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS origem VARCHAR(64) DEFAULT 'DRIVE_SYNC';
      ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS created_by_user_id VARCHAR(128);
    `,
  },
  {
    version: '003_client_observations',
    name: 'Tabela de observações e sugestões de clientes para memória criativa e geração de mídias',
    sql: `
      CREATE TABLE IF NOT EXISTS client_observations (
        id VARCHAR(128) PRIMARY KEY,
        company_id VARCHAR(128) REFERENCES companies(id) ON DELETE CASCADE,
        tenant_id VARCHAR(128),
        user_id VARCHAR(128) NOT NULL,
        author_name VARCHAR(255),
        content TEXT NOT NULL,
        type VARCHAR(32) NOT NULL DEFAULT 'PONTUAL',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sync_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
        last_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_client_obs_company ON client_observations(company_id, is_active);
      CREATE INDEX IF NOT EXISTS idx_client_obs_tenant ON client_observations(tenant_id);
    `,
  },
  {
    version: '004_client_observations_v4_sync',
    name: 'Adiciona controle de versão incremental para sincronização V4 das observações do cliente',
    sql: `
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS observation_version INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: '005_media_thumbnails',
    name: 'Cache persistente de miniaturas otimizadas (WebP em BYTEA) das mídias do Drive',
    sql: `
      CREATE TABLE IF NOT EXISTS media_thumbnails (
        file_id TEXT NOT NULL,
        width INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        data BYTEA NOT NULL,
        bytes INTEGER NOT NULL,
        etag TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (file_id, width)
      );
    `,
  },
  {
    version: '006_media_unavailable_flag',
    name: 'Marca mídias cujo arquivo não existe mais no Drive para ocultá-las do sistema',
    sql: `
      ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS indisponivel BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS indisponivel_em TIMESTAMPTZ;
    `,
  },
];

export const ALL_MANAGED_TABLES = [
  'schema_migrations',
  'companies',
  'instagram_accounts',
  'users',
  'posts',
  'media_assets',
  'post_media',
  'ai_generations',
  'captions',
  'approvals',
  'rejections',
  'schedules',
  'publication_attempts',
  'publication_history',
  'operational_logs',
  'user_hidden_media',
  'client_observations',
] as const;

type ColumnDefinition = { table: string; column: string; definition: string };

const TABLE_CONSTRAINT_KEYWORDS = new Set(['primary', 'unique', 'constraint', 'check', 'foreign', 'exclude']);

/**
 * Extrai definições de coluna (tipo + DEFAULT, sem constraints) de CREATE TABLE e de
 * ALTER TABLE ... ADD COLUMN presentes nas migrações. Usado para reconciliar bancos antigos.
 */
export function extractColumnDefinitions(sql: string): ColumnDefinition[] {
  const defs: ColumnDefinition[] = [];

  const pushColumn = (table: string, raw: string) => {
    const text = raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join(' ')
      .trim();
    const m = text.match(/^(\w+)\s+([\s\S]+)$/);
    if (!m || TABLE_CONSTRAINT_KEYWORDS.has(m[1].toLowerCase())) return;
    const definition = m[2]
      .replace(/REFERENCES\s+\w+\s*\([^)]*\)(\s+ON\s+DELETE\s+\w+(\s+\w+)?)?/gi, '')
      .replace(/CHECK\s*\((?:[^()]|\([^()]*\))*\)/gi, '')
      .replace(/\bNOT\s+NULL\b/gi, '')
      .replace(/\bPRIMARY\s+KEY\b/gi, '')
      .replace(/\bUNIQUE\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (definition) defs.push({ table, column: m[1], definition });
  };

  const createRe = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/gi;
  let c: RegExpExecArray | null;
  while ((c = createRe.exec(sql))) {
    const table = c[1];
    let depth = 1;
    let buf = '';
    for (let i = createRe.lastIndex; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth === 0) break;
      if (ch === ',' && depth === 1) {
        pushColumn(table, buf);
        buf = '';
        continue;
      }
      buf += ch;
    }
    pushColumn(table, buf);
  }

  const alterRe = /ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)\s+([^;]+)/gi;
  let a: RegExpExecArray | null;
  while ((a = alterRe.exec(sql))) {
    pushColumn(a[1], `${a[2]} ${a[3]}`);
  }

  return defs;
}

/**
 * Adiciona colunas que existam nas migrações mas faltem em tabelas já criadas (bancos com
 * schema antigo, onde CREATE TABLE IF NOT EXISTS não altera nada). Idempotente e aditivo:
 * nunca remove nem altera colunas existentes.
 */
export async function reconcileLegacyColumns(): Promise<string[]> {
  const tablesRes = await dbQuery<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`
  );
  const existingTables = new Set(tablesRes.rows.map((r) => r.table_name));
  const added: string[] = [];

  for (const migration of POSTGRES_MIGRATIONS) {
    for (const def of extractColumnDefinitions(migration.sql)) {
      if (!existingTables.has(def.table)) continue;
      await dbQuery(
        `ALTER TABLE ${def.table} ADD COLUMN IF NOT EXISTS ${def.column} ${def.definition}`
      );
      added.push(`${def.table}.${def.column}`);
    }
  }
  return added;
}

/**
 * Applies all pending versioned migrations idempotently without dropping existing data.
 */
export async function runDatabaseMigrations(): Promise<{
  applied: string[];
  alreadyApplied: string[];
}> {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(128) PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Autocorreção: bancos locais podem ter uma schema_migrations antiga (sem a coluna "version").
  // CREATE TABLE IF NOT EXISTS não altera tabelas existentes, então reconciliamos o formato aqui.
  await dbQuery(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS version VARCHAR(128)`);
  await dbQuery(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS name TEXT`);
  await dbQuery(
    `ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  );
  await dbQuery(
    `CREATE UNIQUE INDEX IF NOT EXISTS schema_migrations_version_uq ON schema_migrations (version)`
  );

  // Antes das migrações: colunas que faltam em tabelas antigas (ex.: users.role) precisam existir
  // para que índices criados pelas migrações não falhem.
  await reconcileLegacyColumns();

  const existingRes = await dbQuery<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version ASC');
  const existingSet = new Set(existingRes.rows.map((r) => r.version));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of POSTGRES_MIGRATIONS) {
    if (existingSet.has(migration.version)) {
      alreadyApplied.push(migration.version);
      continue;
    }

    await withTransaction(async (tx) => {
      const statements = migration.sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        await tx.query(stmt);
      }
      await tx.query(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, NOW()) ON CONFLICT (version) DO NOTHING',
        [migration.version, migration.name]
      );
    });

    applied.push(migration.version);
  }

  // Depois das migrações: cobre tabelas criadas agora (ex.: 002/005 em bancos antigos).
  await reconcileLegacyColumns();

  return { applied, alreadyApplied };
}

export async function getAppliedMigrations(): Promise<
  Array<{ version: string; name: string; appliedAt: string }>
> {
  try {
    const res = await dbQuery<{ version: string; name: string; applied_at: any }>(
      'SELECT version, name, applied_at FROM schema_migrations ORDER BY applied_at ASC, version ASC'
    );
    return res.rows.map((r) => ({
      version: r.version,
      name: r.name,
      appliedAt:
        r.applied_at instanceof Date ? r.applied_at.toISOString() : String(r.applied_at || ''),
    }));
  } catch {
    return [];
  }
}

