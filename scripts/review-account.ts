// Cria a conta de avaliação para o revisor da Meta (empresa própria, sem Instagram vinculado, sem dados de clientes).
//
//   npx tsx scripts/review-account.ts create --email <e-mail> --dry-run
//   npx tsx scripts/review-account.ts create --email <e-mail> --yes [--out-dir <pasta>]
//
// Só INSERE registros próprios. Sem --yes nada é gravado. A senha vai para um arquivo (permissão restrita), nunca para o terminal.
// Usa DATABASE_URL do ambiente: confira o "Banco:" impresso antes de usar --yes.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { checkDatabaseConnection } from '../src/db/pool.ts';
import { createReviewAccount, planReviewAccount } from '../src/services/reviewAccount.ts';

dotenv.config({ quiet: true } as any);

const has = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const conn = await checkDatabaseConnection();
  if (!conn.connected) {
    console.error('Banco indisponível:', conn.error);
    process.exit(1);
  }
  console.log(`Banco: ${conn.driver} @ ${conn.host}/${conn.database}`);
  if (process.argv[2] !== 'create' || !arg('email')) {
    console.error('Uso: create --email <e-mail> (--dry-run | --yes) [--out-dir <pasta>]');
    process.exit(1);
  }
  const plan = await planReviewAccount(arg('email')!);
  console.log('Plano:', JSON.stringify(plan, null, 2));
  if (has('dry-run')) {
    console.log('Simulação: nenhuma escrita foi feita.');
    process.exit(0);
  }
  if (!has('yes')) {
    console.error('Nada foi gravado. Repita com --yes para confirmar (ou --dry-run).');
    process.exit(1);
  }
  const created = await createReviewAccount({ email: arg('email')! });
  const dir = path.resolve(arg('out-dir') || 'backups-db');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `review-account-${Date.now()}.txt`);
  fs.writeFileSync(out, `email: ${created.email}\nsenha: ${created.password}\n`, { mode: 0o600 });
  console.log(`Conta de avaliação criada. Credenciais gravadas em ${out} (fora do Git). Entregue por canal seguro e apague o arquivo.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Erro:', e.message);
  process.exit(1);
});
