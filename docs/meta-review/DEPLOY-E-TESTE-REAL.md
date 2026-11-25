# Deploy seguro e teste real — ATO Social Hub (Meta App Review)

Nada aqui foi executado em produção. Ordem recomendada, com o que conferir em cada passo.

## 1. Antes do deploy (Railway → Variables)

| Variável | Valor | Observação |
|---|---|---|
| `INSTAGRAM_APP_ID` | `28751089997889323` | já em produção |
| `INSTAGRAM_APP_SECRET` | (existente) | não alterar |
| `INSTAGRAM_REDIRECT_URI` | `https://socialhub.atodev.com.br/api/auth/instagram/callback` | deve estar cadastrada no app Meta |
| `INSTAGRAM_CONFIG_ID` | `1775718873720654` | opcional (já é o padrão do código) |
| `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` | (existentes) | obrigatórios |
| `ADMIN_BOOTSTRAP_PASSWORD` | senha **nova**, 12+ caracteres | ver passo 2 |
| `ADMIN_BOOTSTRAP_PASSWORD_RESET` | `true` **só neste deploy** | remover no deploy seguinte |
| `NODE_ENV` | `production` | desativa a rota `simulate` |

## 2. Rotação da senha do administrador (URGENTE)

Até esta correção, a cada inicialização o admin `admin@atodev.com.br` voltava para a senha `666666`
(guardada como SHA-256 sem sal). A senha estava no código e no histórico do Git. Considere-a comprometida.

1. Defina `ADMIN_BOOTSTRAP_PASSWORD` (nova) e `ADMIN_BOOTSTRAP_PASSWORD_RESET=true`.
2. Faça o deploy e entre com a senha nova.
3. Remova `ADMIN_BOOTSTRAP_PASSWORD_RESET`. A partir daí o app nunca mais redefine a senha.

## 3. Migração (aditiva e reversível)

A migração `008_oauth_state_and_pending_connections` cria 3 tabelas auxiliares (`oauth_states`,
`oauth_used_codes`, `oauth_pending_connections`). Roda sozinha na inicialização.

- Conferir: `npm run db:status`
- Reverter (remove só essas 3 tabelas, nenhum dado de negócio): `npm run db:rollback -- 008_oauth_state_and_pending_connections`

## 4. Empresas que só entravam pelo Instagram

O callback não cria mais sessão. Empresas sem e-mail/senha precisam de um login:

```
npx tsx scripts/tenant-logins.ts list
npx tsx scripts/tenant-logins.ts create --tenant <id> --email <e-mail>
```

`list` é somente leitura. `create` recusa empresas que já têm login com senha e imprime a senha uma única vez.
Use o mesmo `create` para a conta de avaliação do revisor da Meta.

## 5. Antes de gravar — conferir no painel da Meta (não dá para verificar pelo código)

1. App Dashboard → Facebook Login for Business → Configurations → `1775718873720654`:
   listar as permissões. Esperado: `instagram_basic` e `instagram_content_publish`.
   A documentação da Meta diz que a configuração **padrão** também inclui `instagram_manage_messages`
   ("required"), `instagram_manage_comments`, `ads_management`, `ads_read`. Qualquer permissão que o fluxo
   não demonstre em vídeo é motivo de reprovação. Se aparecerem, tente removê-las; se a Meta não permitir
   remover alguma, anote o motivo.
2. URI de redirecionamento válido = a do passo 1.
3. A pessoa que vai autorizar tem função no app (Administrador/Desenvolvedor/Testador) enquanto não houver Advanced Access.
4. Na primeira conexão real, `GET /api/instagram/oauth-diagnostics` (como admin) mostra os eventos com
   `grantedScopes` reais devolvidos pela Meta.

## 6. Teste real (precisa da sua confirmação)

Não será feito sem você informar: **conta Instagram profissional de teste**, **imagem + legenda** e **confirmação
de que pode ser publicada**. Sequência: login (e-mail/senha) → Conectar Instagram → conferir @conta no painel →
escolher conteúdo → conferir legenda → Publicar agora → conferir o `permalink` retornado e o post no perfil.

## 7. Remoção de dados sensíveis do Git (proposta — não executada)

- `.data/pgdata` (1.090 arquivos), `.data/backups`, `.data/media-cache`, `.data/database.json` e
  `.data/last_webhook_payload.json` estão versionados e já foram enviados ao GitLab.
- Não há tokens da Meta nesses arquivos. Há o hash SHA-256 da senha `666666` do admin (no `pgdata`) e dados de
  clientes (pastas/links do Drive).
- Passos: (1) backup local de `.data`; (2) `git rm -r --cached .data` e adicionar `.data/` ao `.gitignore`;
  (3) commit; (4) avisar a equipe (quem fizer pull perde os arquivos locais de `.data` se não tiver backup);
  (5) reescrever histórico com `git filter-repo --path .data --invert-paths` e force-push, só com a equipe avisada;
  (6) a rotação do passo 2 já neutraliza o hash exposto.
- Rotacione também, por precaução, `INSTAGRAM_APP_SECRET`, `META_ACCESS_TOKEN` e `JWT_SECRET` se o repositório
  puder ter sido acessado por terceiros.
