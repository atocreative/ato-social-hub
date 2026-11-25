import { defineConfig } from 'vitest/config';

// Somente suítes escritas para o vitest e que rodam isoladas (PostgreSQL em memória, Graph API simulada).
// - Arquivos escritos com node:test rodam por `npm run test:node` (scripts/run-node-tests.mjs).
// - Testes que exigem servidor ativo em localhost:3000 ou dados do banco real NÃO fazem parte da suíte automática.
export default defineConfig({
  test: {
    include: ['src/services/**/*.test.ts', 'src/tests/oauth_unified_security.test.ts', 'src/tests/session_revocation.test.ts', 'src/tests/admin_reset_safety.test.ts', 'src/tests/password_trigger.test.ts', 'src/tests/tenant_logins.test.ts', 'src/tests/review_account.test.ts', 'src/tests/health_readiness.test.ts'],
    testTimeout: 30000,
    hookTimeout: 90000,
  },
});
