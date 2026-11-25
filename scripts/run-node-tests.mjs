// Executa as suítes escritas com node:test que são autossuficientes.
// ATO_TEST_MODE=1 força PostgreSQL em memória: nenhum teste toca o banco apontado por DATABASE_URL.
import { spawnSync } from 'node:child_process';

const files = [
  'src/tests/instagram_publishing_scheduling.test.ts',
  'src/utils/postHelpers.test.ts',
  'src/utils/auth.test.ts',
];

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit', env: { ...process.env, ATO_TEST_MODE: '1' } }
);
process.exit(result.status ?? 1);
