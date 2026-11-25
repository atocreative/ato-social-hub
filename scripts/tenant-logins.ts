// Provisiona login (e-mail/senha) para empresas que antes entravam só pelo Instagram.
//
//   npx tsx scripts/tenant-logins.ts list [--csv]
//       Somente leitura. Mostra as empresas sem login e os vínculos que serão preservados.
//       Com --csv imprime o modelo (tenant_id,username,email) para preencher o e-mail de cada empresa.
//
//   npx tsx scripts/tenant-logins.ts create --tenant <id> --email <e-mail> [--name "Nome"] --dry-run
//   npx tsx scripts/tenant-logins.ts create --tenant <id> --email <e-mail> [--name "Nome"] --yes
//       --dry-run simula (nenhuma escrita). Sem --dry-run, a escrita só acontece com --yes.
//
//   npx tsx scripts/tenant-logins.ts create-batch --file logins.csv --dry-run
//   npx tsx scripts/tenant-logins.ts create-batch --file logins.csv --yes
//       CSV com cabeçalho tenant_id,email. Em lote as senhas NÃO vão para o terminal: são gravadas em
//       backups-db/logins-<data>.csv (ignorado pelo Git, permissão restrita); use --out-dir <pasta> para outro local. Entregue cada senha por canal seguro.
//
// Regras: nunca altera empresa que já tem login com senha, nunca reutiliza e-mail existente, nunca mexe em
// company_id, instagram_account_id ou na conta Instagram. Usa DATABASE_URL do ambiente: confira o banco impresso.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { checkDatabaseConnection } from '../src/db/pool.ts';
import { createTenantLogin, listTenantsWithoutLogin, planTenantLogin } from '../src/services/tenantLogins.ts';

dotenv.config({ quiet: true } as any);

const has = (name: string) => process.argv.includes(`--${name}`);
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseCsv(file: string): Array<{ tenant_id: string; email: string }> {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines.shift()?.split(',').map((h) => h.trim().toLowerCase()) || [];
  const ti = header.indexOf('tenant_id');
  const ei = header.indexOf('email');
  if (ti < 0 || ei < 0) throw new Error('O CSV precisa do cabeçalho tenant_id,email.');
  return lines
    .map((l) => l.split(',').map((c) => c.trim()))
    .map((c) => ({ tenant_id: c[ti] || '', email: c[ei] || '' }))
    .filter((r) => r.tenant_id || r.email);
}

async function main() {
  const command = process.argv[2];
  const conn = await checkDatabaseConnection();
  if (!conn.connected) {
    console.error('Banco indisponível:', conn.error);
    process.exit(1);
  }
  console.log(`Banco: ${conn.driver} @ ${conn.host}/${conn.database}`);

  if (command === 'list') {
    const rows = await listTenantsWithoutLogin();
    if (has('csv')) {
      console.log('tenant_id,username,email');
      for (const r of rows) console.log(`${r.id},${r.username},`);
      process.exit(0);
    }
    console.log(`${rows.length} empresa(s) sem login (e-mail/senha):`);
    for (const r of rows) {
      console.log(
        `- ${r.id} | @${r.username} | status ${r.status} | ${r.connectionStatus} | token ${r.hasValidToken ? 'válido' : 'ausente'} | empresa ${r.companyId ?? '-'} | IG ${r.instagramUserId ?? '-'} | pasta ${r.driveFolderName ?? '-'} | usuário existente ${r.existingUserId ?? 'nenhum'}`
      );
    }
    process.exit(0);
  }

  if (command === 'create') {
    const tenant = arg('tenant');
    const email = arg('email');
    if (!tenant || !email) {
      console.error('Informe --tenant <id> e --email <e-mail>.');
      process.exit(1);
    }
    const plan = await planTenantLogin({ tenantId: tenant, email, name: arg('name') });
    console.log('Plano:', JSON.stringify(plan, null, 2));
    if (has('dry-run')) {
      console.log('Simulação: nenhuma escrita foi feita.');
      process.exit(0);
    }
    if (!has('yes')) {
      console.error('Nada foi gravado. Revise o plano e repita com --yes para confirmar (ou --dry-run para só simular).');
      process.exit(1);
    }
    const created = await createTenantLogin({ tenantId: tenant, email, name: arg('name') });
    console.log('Login criado. Guarde a senha agora; ela não será exibida novamente:');
    console.log(`  e-mail: ${created.email}`);
    console.log(`  senha:  ${created.password}`);
    process.exit(0);
  }

  if (command === 'create-batch') {
    const file = arg('file');
    if (!file) {
      console.error('Informe --file <logins.csv>.');
      process.exit(1);
    }
    const rows = parseCsv(file);
    const dry = has('dry-run');
    if (!dry && !has('yes')) {
      console.error('Nada foi gravado. Rode primeiro com --dry-run e, se estiver correto, repita com --yes.');
      process.exit(1);
    }
    const seen = new Set<string>();
    const outLines = ['tenant_id,email,senha'];
    let ok = 0;
    let failed = 0;
    for (const r of rows) {
      const key = r.email.toLowerCase();
      try {
        if (seen.has(key)) throw new Error('e-mail repetido no CSV.');
        seen.add(key);
        const plan = await planTenantLogin({ tenantId: r.tenant_id, email: r.email });
        if (dry) {
          console.log(`SIMULAÇÃO OK  ${r.tenant_id} → ${plan.email} (${plan.action}, vínculos preservados)`);
        } else {
          const created = await createTenantLogin({ tenantId: r.tenant_id, email: r.email });
          outLines.push(`${r.tenant_id},${created.email},${created.password}`);
          console.log(`CRIADO        ${r.tenant_id} → ${created.email}`);
        }
        ok++;
      } catch (e: any) {
        failed++;
        console.log(`RECUSADO      ${r.tenant_id || '(sem id)'} → ${e.message}`);
      }
    }
    if (!dry && outLines.length > 1) {
      const dir = path.resolve(arg('out-dir') || 'backups-db');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `logins-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
      fs.writeFileSync(out, outLines.join('\n') + '\n', { mode: 0o600 });
      console.log(`\nSenhas gravadas em ${out} (fora do Git). Entregue por canal seguro e apague o arquivo depois.`);
    }
    console.log(`\n${dry ? 'Simulação' : 'Execução'}: ${ok} ok, ${failed} recusado(s).`);
    process.exit(failed > 0 && !dry ? 2 : 0);
  }

  console.error('Comandos: list [--csv] | create --tenant <id> --email <e-mail> (--dry-run | --yes) | create-batch --file <csv> (--dry-run | --yes)');
  process.exit(1);
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
