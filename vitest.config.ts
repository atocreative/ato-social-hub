import { defineConfig } from 'vitest/config';

// Somente suítes escritas para o vitest e que rodam isoladas (PostgreSQL em memória, Graph API simulada).
// - Arquivos escritos com node:test rodam por `npm run test:node` (scripts/run-node-tests.mjs).
// - Testes que exigem servidor ativo em localhost:3000 ou dados do banco real NÃO fazem parte da suíte automática.
export default defineConfig({
  test: {
    include: ['src/services/**/*.test.ts', 'src/tests/oauth_unified_security.test.ts', 'src/tests/session_revocation.test.ts', 'src/tests/admin_reset_safety.test.ts', 'src/tests/password_trigger.test.ts', 'src/tests/tenant_logins.test.ts', 'src/tests/review_account.test.ts', 'src/tests/health_readiness.test.ts', 'src/tests/self_service_signup.test.ts', 'src/tests/public_signup_isolation.test.ts', 'src/tests/hotfix_security.test.ts', 'src/tests/approval_flow.test.ts'],
    // Ambiente de teste isolado: valores FICTÍCIOS e fixos. Os testes nunca dependem do .env
    // (o dotenv não sobrescreve variáveis já definidas) e nunca usam segredos reais.
    env: {
      JWT_SECRET: 'vitest-only-jwt-secret-0000000000000000000000000000',
      TOKEN_ENCRYPTION_KEY: 'vitest-only-token-encryption-key-00000000000000000',
      INSTAGRAM_APP_ID: '1111111111111111',
      INSTAGRAM_APP_SECRET: 'vitest-only-app-secret',
      INSTAGRAM_REDIRECT_URI: 'https://hub.test.invalid/api/auth/instagram/callback',
      APP_URL: 'https://hub.test.invalid',
      CRON_SECRET: 'vitest-only-cron-secret',
      WEBHOOK_SECRET_TOKEN: 'vitest-only-webhook-secret',
      META_VERIFY_TOKEN: 'vitest-only-verify-token',
    },
    testTimeout: 30000,
    hookTimeout: 90000,
  },
});
