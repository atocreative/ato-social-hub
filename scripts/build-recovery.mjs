// Gera a VERSÃO DE RECUPERAÇÃO: o código antigo de produção + correções mínimas de segurança.
// Não altera o repositório nem faz commit: extrai o commit base para uma pasta e aplica edições verificadas por âncora.
//
//   node scripts/build-recovery.mjs --base <commit|tag> --out <pasta-vazia>
//   node scripts/build-recovery.mjs --apply <worktree-no-commit-base>      (para criar a branch de recuperação)
//   (depois você revisa a pasta, faz o commit numa branch `recovery/...` e usa essa branch SÓ como destino de rollback)
//
// O que corrige no código antigo (e nada além disso):
//   1. Login aceita senhas scrypt (o admin rotacionado consegue entrar; hashes SHA-256 antigos migram no login).
//   2. Nunca grava a senha padrão antiga; o admin só muda por ADMIN_BOOTSTRAP_PASSWORD(+_RESET).
//   3. Respeita SESSIONS_VALID_AFTER (sessões emitidas antes do corte continuam revogadas).
//   4. GET /api/health com prontidão (migrações do próprio código aplicadas e nenhuma senha padrão antiga) para o healthcheck do Railway.
//   5. Fecha as rotas que emitem sessão sem validar identidade: POST /api/auth/instagram/simulate (404),
//      POST /api/auth/instagram legado (410) e GET /api/debug/state (exige admin).
// Limite conhecido: o fluxo OAuth ANTIGO (callback/url) continua o mesmo do código base. É uma ponte de disponibilidade, não o destino final.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const base = arg('base');
const out = arg('out');
const apply = arg('apply');
if ((!base || !out) && !apply) {
  console.error('Uso: node scripts/build-recovery.mjs --base <commit|tag> --out <pasta-vazia>');
  console.error('  ou: node scripts/build-recovery.mjs --apply <worktree-com-o-commit-base-ja-extraido>');
  process.exit(1);
}
const repo = process.cwd();
let outDir;
if (apply) {
  // Modo worktree: aplica sobre uma pasta que já contém o commit base (ex.: git worktree add -b recovery/... <pasta> <tag>).
  outDir = path.resolve(apply);
  if (!fs.existsSync(path.join(outDir, 'server.ts'))) { console.error('A pasta --apply precisa conter o código base (server.ts).'); process.exit(1); }
} else {
  outDir = path.resolve(out);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) { console.error('A pasta de saída precisa estar vazia.'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });
  const tar = path.join(os.tmpdir(), `recovery-${Date.now()}.tar`);
  execFileSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tar, base]);
  execFileSync('tar', ['-xf', path.basename(tar), '-C', outDir.split(path.sep).join('/')], { cwd: os.tmpdir() });
  fs.rmSync(tar);
}

// Edita um arquivo exigindo que cada âncora exista EXATAMENTE uma vez (falha alto se o código base for outro).
// O checkout pode vir com CRLF: edita em LF e preserva o final de linha original.
const CRLF = String.fromCharCode(13, 10);
const LF = String.fromCharCode(10);
function edit(file, steps) {
  const p = path.join(outDir, file);
  let s = fs.readFileSync(p, 'utf8');
  const crlf = s.includes(CRLF);
  s = s.split(CRLF).join(LF);
  for (const [from, to, times = 1] of steps) {
    const count = s.split(from).length - 1;
    if (count !== times) throw new Error(`${file}: âncora esperada ${times}x, encontrada ${count}x:\n${from.slice(0, 120)}`);
    s = s.split(from).join(to);
  }
  fs.writeFileSync(p, crlf ? s.split(LF).join(CRLF) : s);
}

function append(file, text) {
  const p = path.join(outDir, file);
  const cur = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, cur + (cur.includes(CRLF) ? text.split(LF).join(CRLF) : text));
}

// 0. Utilitário de senha (idêntico ao do código novo)
fs.copyFileSync(path.join(repo, 'src/utils/passwordHash.ts'), path.join(outDir, 'src/utils/passwordHash.ts'));

// 1 e 2. Autenticação e admin
edit('src/db/repository.ts', [
  ["import crypto from 'crypto';\n", "import crypto from 'crypto';\nimport { hashPassword, verifyPassword, unusablePasswordHash } from '../utils/passwordHash.ts';\n"],
  [`export async function ensureDefaultAdminUser(): Promise<void> {
  const adminId = 'user_admin_ato';
  const adminEmail = 'admin@atodev.com.br';
  const passwordHash = hashPasswordSha256('666666');

  await dbQuery(
    \`
    INSERT INTO users (id, email, name, password_hash, role, status, permissions, updated_at)
    VALUES ($1, $2, $3, $4, 'ADMIN', 'APROVADO', $5::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      password_hash = EXCLUDED.password_hash,
      role = 'ADMIN',
      status = 'APROVADO',
      updated_at = NOW()
    \`,
    [
      adminId,
      adminEmail,
      'Administrador ATO',
      passwordHash,
      JSON.stringify(['ALL', 'MANAGE_TENANTS', 'APPROVE_POSTS', 'PUBLISH_INSTAGRAM', 'GENERATE_AI']),
    ]
  );
}`, `export async function ensureDefaultAdminUser(): Promise<void> {
  // RECUPERAÇÃO: nunca grava a senha padrão antiga. A senha só muda por rotação explícita.
  const adminId = 'user_admin_ato';
  const adminEmail = String(process.env.ADMIN_BOOTSTRAP_EMAIL || 'admin@atodev.com.br').trim().toLowerCase();
  const envPassword = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '');
  const allowReset = String(process.env.ADMIN_BOOTSTRAP_PASSWORD_RESET || '').toLowerCase() === 'true';
  const newPasswordHash = envPassword.length >= 12 ? hashPassword(envPassword) : null;
  const permissions = JSON.stringify(['ALL', 'MANAGE_TENANTS', 'APPROVE_POSTS', 'PUBLISH_INSTAGRAM', 'GENERATE_AI']);
  const existing = await dbQuery<{ id: string }>('SELECT id FROM users WHERE id = $1 LIMIT 1', [adminId]);
  if (existing.rows.length === 0) {
    await dbQuery(
      \`INSERT INTO users (id, email, name, password_hash, role, status, permissions, updated_at)
       VALUES ($1, $2, $3, $4, 'ADMIN', 'APROVADO', $5::jsonb, NOW()) ON CONFLICT (id) DO NOTHING\`,
      [adminId, adminEmail, 'Administrador ATO', newPasswordHash || unusablePasswordHash(), permissions]
    );
    return;
  }
  if (newPasswordHash && allowReset) {
    await dbQuery(
      \`UPDATE users SET email = $2, password_hash = $3, role = 'ADMIN', status = 'APROVADO', updated_at = NOW() WHERE id = $1\`,
      [adminId, adminEmail, newPasswordHash]
    );
  } else {
    await dbQuery(\`UPDATE users SET role = 'ADMIN', status = 'APROVADO', updated_at = NOW() WHERE id = $1\`, [adminId]);
  }
}`],
  ["  const hash = hashPasswordSha256(password);\n", "", 2],
  [`    if (row.password_hash === hash && row.role === 'ADMIN') {
      await dbQuery('UPDATE users SET last_login_at`, `    const check = verifyPassword(password, row.password_hash);
    if (check.ok && row.role === 'ADMIN') {
      if (check.needsRehash) await dbQuery('UPDATE users SET password_hash = $2 WHERE id = $1', [row.id, hashPassword(password)]);
      await dbQuery('UPDATE users SET last_login_at`],
  [`  if (!row.password_hash || row.password_hash !== hash) {
    return null;
  }
`, `  const check = verifyPassword(password, row.password_hash);
  if (!row.password_hash || !check.ok) {
    return null;
  }
  if (check.needsRehash) await dbQuery('UPDATE users SET password_hash = $2 WHERE id = $1', [row.id, hashPassword(password)]);
`],
  ["const passwordHash = hashPasswordSha256(input.password);", "const passwordHash = hashPassword(input.password);"],
]);

// 4. Prontidão para o healthcheck
edit('src/db/migrations.ts', [
  ["import { dbQuery, withTransaction } from './pool.ts';\n", "import crypto from 'node:crypto';\nimport { dbQuery, withTransaction } from './pool.ts';\n\n// SHA-256 (sem sal) da senha padrão antiga: usado só para detectar que ela ainda existe.\nconst RETIRED_DEFAULT_PASSWORD_SHA256 = crypto.createHash('sha256').update('666666').digest('hex');\n"],
]);
append('src/db/migrations.ts', `
/** Prontidão (healthcheck): banco responde, migrações DESTE código aplicadas, nenhuma senha padrão antiga. Sem dados no retorno. */
export async function checkDeployReadiness(): Promise<{ ready: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  try {
    await dbQuery('SELECT 1');
  } catch {
    return { ready: false, reasons: ['database_unavailable'] };
  }
  const applied = new Set((await getAppliedMigrations()).map((m) => m.version));
  const missing = POSTGRES_MIGRATIONS.filter((m) => !applied.has(m.version)).map((m) => m.version);
  if (missing.length > 0) reasons.push('migrations_pending:' + missing.join(','));
  try {
    const res = await dbQuery<any>('SELECT 1 FROM users WHERE password_hash = $1 LIMIT 1', [RETIRED_DEFAULT_PASSWORD_SHA256]);
    if (res.rows.length > 0) reasons.push('retired_default_password_present');
  } catch {
    reasons.push('users_check_failed');
  }
  return { ready: reasons.length === 0, reasons };
}
`);

// 3, 4 e 5. Servidor
edit('server.ts', [
  ["import { runDatabaseMigrations, getAppliedMigrations } from './src/db/migrations.ts';", "import { runDatabaseMigrations, getAppliedMigrations, checkDeployReadiness } from './src/db/migrations.ts';"],
  ["// 1. Autenticação para Usuários do Painel (JWT para Admin e Tenant)\nexport function requireAuth", `/** SESSIONS_VALID_AFTER (ISO): tokens emitidos antes do corte são recusados. Valor inválido derruba a sessão (falha fechada). */
export function isSessionRevoked(decoded: { iat?: number } | null | undefined, rawCutoff = process.env.SESSIONS_VALID_AFTER): boolean {
  const raw = String(rawCutoff || '').trim();
  if (!raw) return false;
  const cutoffMs = Date.parse(raw);
  if (!Number.isFinite(cutoffMs)) return true;
  const iatMs = Number(decoded?.iat) * 1000;
  if (!Number.isFinite(iatMs)) return true;
  return iatMs < cutoffMs;
}

// 1. Autenticação para Usuários do Painel (JWT para Admin e Tenant)
export function requireAuth`],
  [`    const decoded = jwt.verify(token, JWT_SECRET) as UserProfile;
    req.user = decoded;
    next();`, `    const decoded = jwt.verify(token, JWT_SECRET) as UserProfile;
    if (isSessionRevoked(decoded as any)) {
      return res.status(401).json({ error: 'Sessão encerrada por segurança. Faça login novamente.' });
    }
    req.user = decoded;
    next();`],
  [`      const decoded = jwt.verify(token, JWT_SECRET) as UserProfile;
      req.user = decoded;
      return next();
    } catch {
      // Ignora erro JWT`, `      const decoded = jwt.verify(token, JWT_SECRET) as UserProfile;
      if (!isSessionRevoked(decoded as any)) {
        req.user = decoded;
        return next();
      }
    } catch {
      // Ignora erro JWT`],
  [`      const decoded = jwt.verify(bearer, JWT_SECRET) as UserProfile;
      req.user = decoded;
      return next();`, `      const decoded = jwt.verify(bearer, JWT_SECRET) as UserProfile;
      if (isSessionRevoked(decoded as any)) {
        return res.status(401).json({ error: 'Token de autorização inválido para o agendador.' });
      }
      req.user = decoded;
      return next();`],
  ["// A. Login no ATO Social Hub via E-mail e Senha (suporta ADMIN e clientes TENANT cadastrados)\napp.post('/api/auth/login'", `// RECUPERAÇÃO: registradas ANTES das rotas antigas (a primeira rota que casa vence).
app.get('/api/health', async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const r = await checkDeployReadiness();
    if (r.ready) return res.json({ status: 'ok', database: 'ok' });
    console.error('[Health] Não pronto: ' + r.reasons.join(', '));
    return res.status(503).json({ status: 'degraded', database: r.reasons.includes('database_unavailable') ? 'unavailable' : 'ok', ready: false });
  } catch {
    return res.status(503).json({ status: 'degraded', database: 'unavailable' });
  }
});
// Rotas que emitem sessão sem validar identidade ou expõem estado: fechadas na recuperação.
app.post('/api/auth/instagram/simulate', (_req: Request, res: Response) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.post('/api/auth/instagram', (_req: Request, res: Response) =>
  res.status(410).json({ error: 'Este acesso foi desativado. Entre com e-mail e senha.' })
);
app.get('/api/debug/state', requireAuth, requireAdmin, (_req: Request, _res: Response, next: NextFunction) => next());

// A. Login no ATO Social Hub via E-mail e Senha (suporta ADMIN e clientes TENANT cadastrados)
app.post('/api/auth/login'`],
]);
console.log(`Versão de recuperação gerada em ${outDir}${base ? ` (base ${base})` : ''}. Nada foi commitado nem enviado.`);
