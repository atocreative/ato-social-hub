# Sequência operacional de implantação — ATO Social Hub (Railway)

Nada aqui foi executado em produção. Sem segredos neste arquivo: substitua `<...>` ao executar.
Complemento: `PLANO-EXPOSICAO-CREDENCIAIS.md` (rotações e Git), `ENTREGA-FINAL.md` (teste real).
Cada afirmação marcada **[provado]** foi executada em PostgreSQL 17 real e descartável (scripts no escopo de testes, nada em produção).

## 0. Rollback (corrigido)

**No primeiro deploy não existe "versão anterior segura".** A tag `pos-deploy-meta-review` é o código novo, não um destino de rollback. A única versão anterior é o código antigo (tag `pre-deploy-meta-review`), que tem as vulnerabilidades originais. Por isso a segurança é construída em três camadas, nesta ordem:

1. **Barreira antes da troca (healthcheck de prontidão).** `GET /api/health` só devolve 200 se: o banco responde, **todas** as migrações do código (incluindo 008 e 009) estão aplicadas e **nenhum usuário** ainda tem a senha padrão antiga. Com o healthcheck configurado, o Railway mantém a versão atual no ar até a nova responder 200. Se a migração falhar ou o admin não tiver sido rotacionado (`ADMIN_BOOTSTRAP_PASSWORD` esquecido), a nova versão fica em 503 e **não substitui** a atual. **[provado]** (3 casos: migração pendente, hash antigo presente, rotacionado).
2. **Gatilho no banco (migração 009).** Impede que qualquer código, inclusive o antigo, regrave o hash de `666666`. **[provado]** subindo o código antigo (commit `ce402bf`) sobre o banco já migrado e rotacionado: o hash do admin ficou intacto, `666666` foi recusado e, voltando ao código novo, a senha rotacionada voltou a funcionar.
3. **Rollback só para versões que já passaram pela barreira.** Tudo que passa pela barreira (1) já tem 009 e admin rotacionado, então qualquer rollback posterior é seguro quanto à senha.

**Limites do rollback para o código ANTIGO puro (não use):** **[provado]** o admin e os logins com senha nova recebem 401 (o código antigo só entende SHA-256) e as sessões anteriores ao deploy voltam a valer (ele ignora `SESSIONS_VALID_AFTER`). Por isso existe a versão de recuperação abaixo.

### 0.1 Versão de recuperação (destino de rollback do PRIMEIRO deploy)

É o código antigo de produção + **só** estas correções (gerada por `scripts/build-recovery.mjs`, cada edição verificada por âncora; falha alto se o código base for outro):
1. login aceita senhas scrypt (admin rotacionado e clientes provisionados entram; hashes SHA-256 migram no login);
2. nunca grava a senha padrão antiga (o admin só muda por `ADMIN_BOOTSTRAP_PASSWORD` + `ADMIN_BOOTSTRAP_PASSWORD_RESET=true`);
3. respeita `SESSIONS_VALID_AFTER` (sessões anteriores ao corte continuam revogadas);
4. `GET /api/health` com prontidão (migrações do próprio código aplicadas e nenhuma senha padrão antiga), para o healthcheck configurado não reprovar o rollback;
5. fecha as rotas que emitem sessão sem validar identidade: `POST /api/auth/instagram/simulate` (404), `POST /api/auth/instagram` legado (410) e `GET /api/debug/state` (exige admin). O código antigo as expunha sem autenticação.

**[provado]** em PostgreSQL 17 real, sobre um banco já migrado (008/009) com admin rotacionado e um cliente provisionado: health 200; hash do admin intacto (inclusive **sem** o gatilho 009: a proteção não depende só do banco); login do admin com a senha rotacionada 200; `666666` recusado; login do cliente provisionado 200; sessão emitida antes do corte → 401; sessão nova → 200; as 3 rotas fechadas; admin ainda com a senha antiga → health 503. Os testes automáticos antigos dão o mesmo resultado no código base e na recuperação (8 falhas e 36 passes em ambos: falhas que já existiam, que dependem de banco/serviços reais).

**Limite conhecido:** o fluxo OAuth ANTIGO (url/callback) continua o do código base. A recuperação é uma ponte de disponibilidade por horas, não o destino final: assim que possível, corrija e avance com o código novo.

**Como criar a branch (você; nada é commitado por mim):**
```
git worktree add -b recovery/meta-review ..to-social-hub-recovery <tag pre-deploy-meta-review | ce402bf>
node scripts/build-recovery.mjs --apply ..to-social-hub-recovery
cd ..to-social-hub-recovery
git diff --stat          # confira: 4 arquivos alterados + src/utils/passwordHash.ts novo
git add -A && git commit -m "Versão de recuperação: login scrypt, sem senha padrão, revogação de sessões, rotas inseguras fechadas"
git tag recovery-meta-review-1
```
Não faça push enquanto não quiser disponibilizá-la; o Railway só precisa dela no momento do rollback (redeploy dessa branch/tag). Confira no painel que o **Healthcheck Path** `/api/health` vale também para ela (ela implementa a rota).

**Variáveis ao usar a recuperação:** mantenha `SESSIONS_VALID_AFTER` definido; `ADMIN_BOOTSTRAP_PASSWORD` + `ADMIN_BOOTSTRAP_PASSWORD_RESET=true` só se precisar redefinir a senha do admin (depois remova a flag). Não altere `JWT_SECRET` nem `TOKEN_ENCRYPTION_KEY`.

**Voltar ao código novo depois da recuperação:** redeploy da tag `pos-deploy-meta-review-N`; as migrações 008/009 já estão aplicadas e o healthcheck de prontidão continua valendo.

## 1. Bloqueadores que dependem de você (antes de qualquer passo)

- [ ] Banco **exclusivo** do Social Hub (host/nome diferentes do Atobot; `SELECT table_name FROM information_schema.tables WHERE table_schema='public'` sem tabelas Prisma em PascalCase: `Company`, `User`, `Conversation`…).
- [ ] `SELECT version FROM schema_migrations ORDER BY version;` termina em `007_rejection_memory_flag`.
- [ ] `TOKEN_ENCRYPTION_KEY` existe no serviço. **Não alterar** `JWT_SECRET` nem `TOKEN_ENCRYPTION_KEY`. Guarde uma cópia da chave fora do Git: um backup restaurado só tem tokens utilizáveis com a mesma chave.
- [ ] Um Postgres **vazio e descartável** para a prova de restauração (novo serviço Postgres no Railway ou instalação local). Nunca o de produção.

## 2. Backup validado ANTES das migrações

1. Backup nativo: Railway → Postgres → Backups → manual; anote data/hora.
2. Backup lógico (somente leitura, transação `REPEATABLE READ`):
   ```
   $env:DATABASE_URL = "<DATABASE_PUBLIC_URL do Social Hub>"
   npm run db:backup -- backups-db/pre-deploy
   Remove-Item Env:DATABASE_URL
   ```
3. **Prova de restauração em banco isolado** (obrigatória; o script recusa destino igual à origem e destino não vazio):
   ```
   $env:DATABASE_URL = "<URL do banco descartável>"; npm run db:migrate
   $env:RESTORE_DATABASE_URL = "<URL do banco descartável>"
   $env:DATABASE_URL = "<DATABASE_PUBLIC_URL>"       # só para o script comparar e recusar origem = destino
   npm run db:verify-restore -- backups-db/pre-deploy
   Remove-Item Env:DATABASE_URL, Env:RESTORE_DATABASE_URL
   ```
   Critério para seguir: `OK` em todas as tabelas (contagem e SHA-256) e "Restauração verificada". Sem isso, **não prossiga**.
4. `backups-db/` está no `.gitignore` (contém dados de clientes e tokens cifrados).

## 3. Preservação de dados e acessos **[provado]**

Banco no estado `007` com dados representativos (admin com a senha antiga, contas com token cifrado, posts publicados e agendados): depois de migrar 008+009, **16 tabelas com contagem e conteúdo (hash) idênticos**. O provisionamento em lote (`tenant-logins.ts`) só altera `users` (acrescenta senha preservando `company_id` e `instagram_account_id`); as outras 15 tabelas ficam idênticas; o admin não é tocado. A rotação do admin é um passo separado, feito pelo boot do código novo.

## 4. Variáveis (Railway) — você altera, eu não

| Variável | Valor | Quando |
|---|---|---|
| `ADMIN_BOOTSTRAP_PASSWORD` | senha nova, 12+ caracteres | antes do deploy |
| `ADMIN_BOOTSTRAP_PASSWORD_RESET` | `true` | só neste deploy; remover no passo 9 |
| `SESSIONS_VALID_AFTER` | ISO do momento do deploy | antes do deploy |
| `NODE_ENV` | `production` | já deve estar |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_REDIRECT_URI`, `INSTAGRAM_CONFIG_ID` | `28751089997889323`, `https://socialhub.atodev.com.br/api/auth/instagram/callback`, `1775718873720654` | conferir |
| Healthcheck Path | `/api/health` (timeout ≥ 300 s para cobrir as migrações) | antes do deploy |

## 5. Sequência de execução

1. Seção 1 (bloqueadores) e seção 2 (backup **e** prova de restauração).
2. *(Recomendado, exige sua autorização por escrever em produção)* **Pré-migração:** `$env:DATABASE_URL="<DATABASE_PUBLIC_URL>"; npm run db:migrate; Remove-Item Env:DATABASE_URL`. Aplica 008/009 com o código antigo ainda no ar (compatível, provado) e ativa o gatilho que impede o reset para `666666` mesmo se o serviço antigo reiniciar. Confira `schema_migrations`.
3. Você faz o commit (seção 6) e as tags: `git tag pre-deploy-meta-review ce402bf` (código atual de produção) e `git tag pos-deploy-meta-review-1` no commit novo. **Antes do push**, crie e confira a versão de recuperação (seção 0.1) para ela existir no momento do deploy.
4. Variáveis e healthcheck (seção 4).
5. Deploy (`git push origin main --tags`). A versão antiga continua atendendo até a nova responder 200 em `/api/health`.
6. Acompanhe os logs. Se o healthcheck falhar, **nada foi trocado**: leia o motivo nos logs (`[Health] Não pronto: ...`), corrija a variável ou a migração e repita. Não faça rollback de código.
7. Verificações **depois** da troca (não impedem a troca; se falharem, avance com correção; rollback só conforme a seção 0):
   ```
   curl https://socialhub.atodev.com.br/api/health                              # {"status":"ok","database":"ok"}
   curl -X POST https://socialhub.atodev.com.br/api/auth/instagram/simulate    # 404
   curl -X POST https://socialhub.atodev.com.br/api/auth/instagram             # 410
   curl https://socialhub.atodev.com.br/api/debug/state                         # 401
   ```
8. Entre como admin com a senha nova; confirme que a antiga (`666666`) **não** entra.
9. Remova `ADMIN_BOOTSTRAP_PASSWORD_RESET`, reinicie (o healthcheck gateia de novo) e entre outra vez.
10. Painel: empresas, contas e agendamentos existentes continuam visíveis.
11. Provisionamento (só depois do passo 9): `tenant-logins.ts list` → `create-batch --dry-run` → `--yes --out-dir <pasta-segura>`; conta de avaliação: `review-account.ts create --email <e-mail> --dry-run` → `--yes --out-dir <pasta-segura>`. Sempre com `$env:DATABASE_URL` definido só na sessão e removido ao final; confira o `Banco:` impresso.
12. Rotação do PostgreSQL (`PLANO-EXPOSICAO-CREDENCIAIS.md`, seção 3) — só com o deploy estável e backup recente.

## 6. Commit (você; eu não faço commit nem push)

Antes de `git add -A`, confira com `git add -A -n` que **não** entram: `.data/`, `backups-db/`, `comando.txt`, `.env*`, `*.csv` de logins, `review-account-*.txt`, `.playwright-mcp/`. Verificação feita nesta etapa: 0 arquivos proibidos e 0 segredos nos arquivos que seriam incluídos (ver `ENTREGA-FINAL.md`).
`.data/` e `comando.txt` **já estão rastreados** no histórico; o commit novo não os altera. Recomendo desversioná-los num commit **separado e anterior**: `git rm -r --cached .data comando.txt` (mantém os arquivos no disco). Seguro para produção: o código só lê `.data/database.json` para importar quando o PostgreSQL está **vazio** (não é o caso) e não depende da pasta.

## 7. Matriz de rollback

| Situação | Ação |
|---|---|
| Healthcheck da nova versão não fica verde | Nada foi trocado. Corrija e refaça o deploy. |
| Bug no código novo depois da troca | Corrigir e redeploy (preferido). Em deploys seguintes: redeploy da tag `pos-deploy-meta-review-N` anterior. |
| Disponibilidade crítica no PRIMEIRO deploy | Redeploy da **versão de recuperação** (`recovery-meta-review-1`, seção 0.1): admin e clientes entram, sessões antigas seguem revogadas, `666666` barrado. Nunca o código antigo puro. |
| Senha do admin esquecida | `ADMIN_BOOTSTRAP_PASSWORD` nova + `ADMIN_BOOTSTRAP_PASSWORD_RESET=true` em um deploy; remover depois. |
| Dados | Restauração: backup nativo do Railway; ou Postgres novo → `db:migrate` → carga verificada (seção 2) → apontar `DATABASE_URL`. |
| Migrações 008/009 | Não reverter para voltar código. Se necessário: `npm run db:rollback -- 009_block_retired_default_password` e `... 008_oauth_state_and_pending_connections` (**[provado]** preserva dados de negócio), mas só com o admin já rotacionado. |
