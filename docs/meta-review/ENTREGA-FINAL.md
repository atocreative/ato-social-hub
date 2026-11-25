# ATO Social Hub — Entrega final de prontidão

Nada aqui foi executado em produção. Não há segredos neste arquivo; substitua `<...>` ao executar.
Detalhes: `PLANO-DEPLOY-RAILWAY.md` (ordem, backup, rollback), `PLANO-EXPOSICAO-CREDENCIAIS.md` (rotações), `DEPLOY-E-TESTE-REAL.md`, `REVIEWER-GUIDE-EN.md` (material da Meta).

## A. O que já está pronto

- **Segurança do login/OAuth:** state em PostgreSQL com cookie de amarração, código de uso único, vínculo por Instagram ID, bloqueio entre empresas, callback sem sessão. Sem bypass.
- **Login:** e-mail e senha como acesso principal; conexão do Instagram separada, em **Conta → Conectar Instagram** (e no painel admin).
- **Interface:** "Conectar" (sem vínculo) × "Reconectar Instagram" (inválida); `@username` e permissões reais; modal com conta de destino, imagem, legenda e **confirmação explícita**; resultado só com retorno válido da API; "Ver no Instagram" só com permalink real; erro nunca vira sucesso; conta provisória aparece como "Conta de avaliação".
- **Isolamento:** usuário de avaliação só vê a própria empresa. Testado (10 verificações via API, PostgreSQL 17 real): lista de posts, contas, publicar/agendar post alheio, OAuth para outra empresa, rotas de admin e upload com pasta alheia. Corrigidos nesta etapa: upload de `TENANT` ignorava o isolamento (podia indicar pasta de outra empresa) e dois `console.log` imprimiam a URL do Apps Script.
- **Conta de avaliação:** `scripts/review-account.ts` (`--dry-run`/`--yes`; senha em arquivo, não no terminal; só insere; recusa duplicado). Cria empresa "Meta Review Demo", conta sem Instagram e usuário TENANT.
- **Reset de testes:** exige ação, escopo e IDs explícitos; nunca reseta post já publicado.
- **Banco/deploy:** migrações 008 e 009 (reversíveis; 009 impede o código antigo de restaurar a senha `666666`), backup lógico verificável, `SESSIONS_VALID_AFTER`, `GET /api/health`, bootstrap da senha do admin.
- **Verificação:** vitest 70/70, node:test 23/23, build OK, tsc 109 (igual ao baseline, nenhum novo).
- **Compatibilidade com o token do Unified Login:** o servidor valida o token na Meta (`debug_token`: app, validade, permissões reais), exige `instagram_basic` + `instagram_content_publish`, aceita permissões extras (`instagram_manage_messages` não quebra nada) e usa `graph.facebook.com` para publicar. O rótulo interno `UNIFIED_BISU` não condiciona lógica alguma.

## B. O que efetivamente impede o deploy

1. **Banco do Railway:** confirmar que é exclusivo do Social Hub (separado do Atobot, sem tabelas Prisma em PascalCase) e que `schema_migrations` termina em `007`. Ainda não recebi o resultado.
2. **Backup verificável** feito e conferido antes do deploy (seção C.2).
3. **Seu commit + tags** (`pre-deploy-meta-review` no código atual de produção, `pos-deploy-meta-review` no novo). Hoje tudo está só na árvore de trabalho.

Não bloqueiam o deploy, mas bloqueiam a **submissão**: teste real concluído (E), mídia de demonstração disponível (E, passo 5) e gravação.

Dependem de teste real (não é possível verificar localmente): o que o `debug_token` devolve (tipo e escopos) para esse token; `me/assigned_instagram_accounts`; criação de container e `media_publish` em `graph.facebook.com/v27.0`; busca do permalink; comportamento de expiração/renovação do token.

## C. Ações manuais no Railway (você)

1. Conferir banco (B.1) e que `TOKEN_ENCRYPTION_KEY` existe. **Não alterar** `JWT_SECRET` nem `TOKEN_ENCRYPTION_KEY`.
2. Backup: backup manual no serviço Postgres (anote hora) **e** `npm run db:backup` (PLANO-DEPLOY seção 2).
3. Variáveis: `ADMIN_BOOTSTRAP_PASSWORD` (12+ caracteres), `ADMIN_BOOTSTRAP_PASSWORD_RESET=true`, `SESSIONS_VALID_AFTER=<ISO do momento do deploy>`. Conferir `INSTAGRAM_APP_ID`, `INSTAGRAM_REDIRECT_URI` (`https://socialhub.atodev.com.br/api/auth/instagram/callback`), `INSTAGRAM_CONFIG_ID=1775718873720654`, `NODE_ENV=production`.
4. Healthcheck path: `/api/health`.
5. Depois do deploy estável: remover `ADMIN_BOOTSTRAP_PASSWORD_RESET`; rotacionar senha do Postgres (exposta em `comando.txt` no Git), `META_VERIFY_TOKEN` (e salvar de novo o webhook na Meta) e Apps Script (nova implantação). Rotações de precaução: `INSTAGRAM_APP_SECRET`, `WEBHOOK_SECRET_TOKEN`, `CRON_SECRET`.
6. Decidir `git rm -r --cached .data comando.txt` e a reescrita opcional do histórico (PLANO-EXPOSICAO seção 4).

## D. Comandos de implantação, na ordem

```
# 1. Tags (você)
git tag pre-deploy-meta-review <commit-atual-em-producao>
git add -A && git commit -m "Correções de segurança e experiência para a Meta"   # revise o diff antes
git tag pos-deploy-meta-review

# 2. Backup (PowerShell; URL pública do Postgres do Social Hub)
$env:DATABASE_URL = "<DATABASE_PUBLIC_URL>"
npm run db:backup -- backups-db/pre-deploy
Remove-Item Env:DATABASE_URL

# 3. Variáveis no Railway (C.3) e healthcheck (C.4)

# 4. Deploy (push). No boot rodam as migrações 008 e 009.
git push origin main --tags

# 5. Verificação (sem credenciais)
curl https://socialhub.atodev.com.br/api/health                       # {"status":"ok","database":"ok"}
curl -X POST https://socialhub.atodev.com.br/api/auth/instagram/simulate   # 404
curl -X POST https://socialhub.atodev.com.br/api/auth/instagram            # 410
curl https://socialhub.atodev.com.br/api/debug/state                        # 401

# 6. Você entra como admin com a senha nova; confirma que a antiga não entra.
#    Remova ADMIN_BOOTSTRAP_PASSWORD_RESET, reinicie, entre de novo.

# 7. Conta de avaliação (só depois do passo 6)
$env:DATABASE_URL = "<DATABASE_PUBLIC_URL>"
npx tsx scripts/review-account.ts create --email <email-do-revisor> --dry-run
npx tsx scripts/review-account.ts create --email <email-do-revisor> --yes --out-dir <pasta-segura>
Remove-Item Env:DATABASE_URL

# 8. Logins das empresas que entravam só pelo Instagram
npx tsx scripts/tenant-logins.ts list  →  create-batch --dry-run  →  --yes   (PLANO-DEPLOY seção 6)
```
Rollback: redeploy da tag `pos-deploy-meta-review` anterior; nunca `pre-deploy-meta-review`. A migração 009 mantém a senha antiga bloqueada mesmo com código antigo (PLANO-DEPLOY seções 0 e 7).

## E. Roteiro exato do primeiro teste real

Pré-requisitos: deploy feito (D), conta Instagram **profissional** de teste com função no app Meta, uma imagem JPEG/PNG de demonstração. **Nada é publicado antes do passo 8.**

1. Entre como revisor (e-mail e senha da conta de avaliação). Aparece o aviso "Conecte sua conta profissional do Instagram".
2. **Conta → Conectar Instagram.** No diálogo da Meta, escolha a conta de teste. Confirme que as permissões exibidas são as do config.
3. Volte a **Conta**: deve mostrar `@username` real, "Conta conectada e autorizada" e as permissões concedidas. Se aparecer erro, copie a mensagem (sem tokens) e pare.
4. Confirmação técnica (admin): `GET /api/instagram/oauth-diagnostics` e os logs do boot. Conferir: Instagram ID da conta, escopos concedidos incluem `instagram_basic` e `instagram_content_publish`, token válido. Registre o que o `debug_token` reportou (tipo e escopos).
5. **Mídia de demonstração** (sem simular nada; o Instagram precisa buscar a imagem por URL pública, então ela deve estar no Drive):
   - *Opção A:* admin → **Enviar nova mídia**, escolhendo a empresa "Meta Review Demo" (envia pelo Apps Script ao Drive).
   - *Opção B:* no Drive, crie a pasta de cliente "Meta Review Demo" dentro da pasta raiz mapeada, coloque a imagem, compartilhe com "qualquer pessoa com o link" e clique **Atualizar posts**.
   - Pré-checagem sem publicar: abra `https://socialhub.atodev.com.br/api/instagram/media-proxy/<driveFileId>.jpg`; precisa devolver a imagem (`image/jpeg`). Se redirecionar para o Drive, a mídia não está acessível: corrija antes de seguir.
6. Em **Posts**, abra o post → **Aprovar** → **Agendar / Publicar**. No modal confira: conta de destino (`@username`), imagem e legenda.
7. Marque **Agora**. Não clique em publicar ainda.
8. **Sua autorização escrita**, neste formato: "Autorizo publicar a imagem `<arquivo>` com a legenda `<texto>` na conta `@<username>`." Só então: marque "Revisei... e confirmo" e clique **Publicar agora**.
9. Registre: ID da mídia retornado e, se houver, o permalink. Clique "Ver no Instagram" e confirme no app/site do Instagram que a postagem existe, na conta certa. Confira **Histórico**: status PUBLICADO e a conta correta.
10. Se falhar: o modal mostra a mensagem (sem segredos) e o post não vira PUBLICADO. Não repita sem me enviar o erro.

## F. O que depende do seu consentimento

- Deploy, commit, push e tags; todas as alterações de variáveis e rotações em produção.
- Provisionamento da conta de avaliação e dos logins (`--yes`) no banco real.
- A publicação real (passo E.8), com conta, imagem, legenda e destino explícitos.
- A reescrita do histórico do Git e o `git rm --cached`.
- Conectar qualquer conta Instagram real no ambiente de produção.
- Qual imagem de demonstração usar (não vou fabricar conteúdo).
