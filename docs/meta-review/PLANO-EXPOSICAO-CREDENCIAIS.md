# Arquivos sensíveis versionados e plano de tratamento da exposição

Auditoria feita sem imprimir segredos. Remoto: GitLab (`origin`, 41 commits). Nada foi apagado, commitado ou enviado.

## 1. O que está versionado

| Item | Situação | Gravidade |
|---|---|---|
| `comando.txt` (commit `0b9ddb5`) | `DATABASE_URL` do Railway **com senha** (`postgres-<id>.railway.internal:5432/railway`). O host é interno (rede privada do Railway), mas a senha está no histórico. | **Alta** |
| `.env.example` (commits `9e65e39`, `0b9ddb5`) | Continha valores **reais** de `META_VERIFY_TOKEN`, `GOOGLE_APPS_SCRIPT_URL` e `GAS_WEBHOOK_URL` (URL do Apps Script é uma capability: quem a conhece consegue chamá-la). | **Alta** |
| `src/tests/instagram_oauth.test.ts` | Continha o `META_VERIFY_TOKEN` real. | Média |
| `server.ts` (histórico) | Chegou a conter URL do Apps Script e o token (já removidos do código atual). | Média |
| `.data/pgdata` (1.090 arquivos) | Banco local PGlite: inclui o hash SHA-256 de `666666` do admin e dados de clientes. Sem tokens Meta. | Média |
| `.data/backups/*.json`, `database.json`, `last_webhook_payload.json` | Dados operacionais (pastas/links do Drive, posts). Sem tokens Meta nem senhas (verificado). | Média/baixa |
| `.data/media-cache` | Miniaturas de mídia de clientes. | Baixa |
| `.env` | **Nunca** esteve no histórico (ignorado). | OK |
| Padrões de token Meta (`EAA…`, `IGAA…`), chave Google (`AIza…`), chave privada | **Nenhum** em todo o histórico. | OK |

## 2. Já corrigido na árvore de trabalho (ainda não commitado)

- `.env.example`: os três valores reais viraram placeholders.
- `src/tests/instagram_oauth.test.ts`: lê `process.env.META_VERIFY_TOKEN`.
- `.gitignore`: `.data/` e `comando.txt` passam a ser ignorados (isso **não** desversiona o que já está rastreado; ver passo B).

## 3. Rotações (a exposição no histórico não se desfaz com reescrita: trate como comprometido)

Ordem sugerida, uma por vez, cada uma com a aplicação conferida depois. Você executa; eu não altero produção.

1. **Senha do admin** — já coberta pelo plano de deploy (rotação + `SESSIONS_VALID_AFTER`).
2. **Senha do Postgres do Social Hub** (de `comando.txt`) — rotação coordenada, **sem interrupção** (procedimento testado em PostgreSQL 17 real: o app segue saudável durante toda a troca, a senha vazada deixa de funcionar, o login do admin continua e `db:migrate` funciona com a credencial nova).
   Pré-condições: deploy estável, backup validado recente (`PLANO-DEPLOY-RAILWAY.md` seção 2), janela de baixo tráfego. Antes de começar, liste **tudo** que usa essa credencial: o serviço do app (`DATABASE_URL`), seu computador (`DATABASE_PUBLIC_URL` nos scripts `db:backup`, `tenant-logins`, `review-account`), qualquer ferramenta de BI/cron externa e qualquer outro serviço do projeto Railway que referencie as variáveis do Postgres. Se o Atobot usar o mesmo banco, **pare**: o banco precisa ser separado antes (bloqueador do deploy).
   Gere duas senhas novas e fortes localmente, sem colar em chat/arquivos: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` (uma para o papel do app, outra para o papel dono).
   - **Passo A — papel novo para o app** (conectado como o dono atual, via `DATABASE_PUBLIC_URL`, `psql` ou a aba Data do Railway):
     ```
     CREATE ROLE socialhub_app LOGIN PASSWORD '<senha-app>';
     GRANT postgres TO socialhub_app;   -- membro do dono: necessário para as migrações (DDL)
     ```
     Teste a conexão desse papel com um `SELECT 1` antes de seguir.
   - **Passo B — apontar o app para o papel novo:** no serviço do app, defina `DATABASE_URL` com o valor literal `postgresql://socialhub_app:<senha-app>@<host-interno>:<porta>/<banco>` (host interno do Postgres do Social Hub, o mesmo do `DATABASE_URL` atual; substitui a referência `${{Postgres.DATABASE_URL}}`). O redeploy só troca a versão quando `/api/health` responder 200 (o app antigo continua atendendo até lá). Confira `GET /api/health` e um login.
   - **Passo C — rotacionar a credencial vazada** (o app já não a usa): conectado como o dono, `ALTER ROLE postgres PASSWORD '<senha-dono>';`
   - **Passo D — verificar:** a URL antiga (a do Git) deve **falhar** ao conectar; `GET /api/health` = ok; login do admin; `npm run db:backup` com a URL nova do dono.
   - **Passo E — alinhar as variáveis do serviço Postgres no Railway** (`POSTGRES_PASSWORD`, `PGPASSWORD` e as URLs derivadas) para a `<senha-dono>`, para que o painel e o `DATABASE_PUBLIC_URL` reflitam a senha real. Atenção: alterar variável do serviço Postgres pode reiniciar o serviço (queda de alguns segundos; o app volta sozinho e o healthcheck marca 503 nesse intervalo). Faça na janela escolhida. Alterar só a variável **não** muda a senha já gravada no banco; o `ALTER ROLE` do passo C é o que rotaciona.
   - **Reversão se algo falhar no passo B:** volte `DATABASE_URL` para a referência anterior (a senha antiga ainda vale até o passo C). Depois do passo C a volta é pela nova senha do dono.
   - Confirme que o Postgres não expõe URL pública desnecessária. O host `postgres-<id>.railway.internal` é rede privada, mas a senha estava no histórico do Git: trate como comprometida.
3. **`META_VERIFY_TOKEN`**: gerar novo valor, atualizar a variável no Railway e **salvar de novo** o callback do webhook no painel da Meta com o novo token (a Meta só compara no momento do cadastro).
4. **Apps Script (`GOOGLE_APPS_SCRIPT_URL`/`GAS_WEBHOOK_URL`)**: implantar uma nova versão como **nova implantação** (novo ID), atualizar as duas variáveis, e desativar a implantação antiga. Se o script não exigir segredo próprio, adicione uma verificação com `WEBHOOK_SECRET_TOKEN`.
5. **`INSTAGRAM_APP_SECRET`, `META_ACCESS_TOKEN`, `WEBHOOK_SECRET_TOKEN`, `CRON_SECRET`**: não aparecem no repositório; prefixos curtos de alguns deles foram impressos por mim, em sessão local, numa verificação anterior. Rotação de precaução, de baixo risco para os três últimos. Para o `INSTAGRAM_APP_SECRET`, trocar no painel da Meta e na variável do Railway no mesmo momento (as trocas de código OAuth em andamento falham por alguns segundos).
6. **`JWT_SECRET` e `TOKEN_ENCRYPTION_KEY`**: não aparecem no repositório. **Não rotacionar** sem plano: com `TOKEN_ENCRYPTION_KEY` ausente o `JWT_SECRET` cifra tokens; e não existe script de re-cifragem. Se for necessário, primeiro peça o script (decifrar com a chave antiga e cifrar com a nova, em transação, com backup verificado).

## 4. Parar de versionar (sem apagar dados operacionais)

**Passo A — backup local** (não vai para o Git): copie `.data/` e `comando.txt` para uma pasta fora do repositório e confira que abre.

**Passo B — desversionar, mantendo os arquivos no disco** (commit normal; reversível):
```
git rm -r --cached .data comando.txt
git commit -m "Remove dados locais e credenciais do versionamento"
```
`.data/` e `comando.txt` já estão no `.gitignore`. Avisar a equipe: quem fizer `git pull` pode ter os arquivos de `.data/` removidos do disco; devem copiar antes.
O deploy no Railway não depende de `.data/` (o app usa o PostgreSQL).

**Passo C — reescrever o histórico (opcional, só com a equipe avisada e depois das rotações):**
```
git clone --mirror <repo> ato-social-hub-mirror.git    # cópia de segurança
git filter-repo --path .data --path comando.txt --invert-paths
git filter-repo --replace-text expressoes.txt            # arquivo fora do repo, com os valores literais -> ***REMOVED***
git push --force --all && git push --force --tags
```
- `expressoes.txt` lista, uma por linha, `valor-literal==>***REMOVED***` para o token de verificação, as URLs do Apps Script e a senha antiga do Postgres. Mantenha-o fora do repositório e apague depois.
- No GitLab: Settings → Repository → Maintenance/Cleanup para expurgar objetos órfãos; MRs, forks e clones locais continuam com o conteúdo antigo. Por isso a rotação (seção 3) é a medida que realmente neutraliza a exposição.
- Todos os colaboradores precisam re-clonar depois do force-push.

## 5. Verificação final (eu repito depois de você executar)

- `git ls-files | grep -E "^\.data/|comando.txt"` sem resultados.
- Busca de padrões de segredo no histórico sem ocorrências dos valores antigos.
- `GET /api/health` e login após cada rotação.
