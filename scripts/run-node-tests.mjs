// Executa as suítes escritas com node:test que são autossuficientes.
// ATO_TEST_MODE=1 força PostgreSQL em memória: nenhum teste toca o banco apontado por DATABASE_URL.
import { spawnSync } from 'node:child_process';

const files = [
  'src/tests/instagram_publishing_scheduling.test.ts',
  'src/utils/postHelpers.test.ts',
  'src/utils/auth.test.ts',
];

// Ambiente isolado com valores FICTÍCIOS (os mesmos do vitest.config.ts): a suíte não depende do .env
// nem usa segredos reais. O dotenv não sobrescreve variáveis já definidas.
const testEnv = {
  ATO_TEST_MODE: '1',
  JWT_SECRET: 'vitest-only-jwt-secret-0000000000000000000000000000',
  TOKEN_ENCRYPTION_KEY: 'vitest-only-token-encryption-key-00000000000000000',
  INSTAGRAM_APP_ID: '1111111111111111',
  INSTAGRAM_APP_SECRET: 'vitest-only-app-secret',
  INSTAGRAM_REDIRECT_URI: 'https://hub.test.invalid/api/auth/instagram/callback',
  APP_URL: 'https://hub.test.invalid',
  CRON_SECRET: 'vitest-only-cron-secret',
  WEBHOOK_SECRET_TOKEN: 'vitest-only-webhook-secret',
  META_VERIFY_TOKEN: 'vitest-only-verify-token',
};

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit', env: { ...process.env, ...testEnv } }
);
process.exit(result.status ?? 1);
