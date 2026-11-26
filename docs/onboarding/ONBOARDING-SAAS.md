# ATO Social Hub — Cadastro e onboarding SaaS

Branch: `feat/saas-onboarding` (a partir de `009b4eb`). Nada foi enviado ao `origin`, publicado ou migrado em produção.

## 1. Fluxo

1. **Criar conta** (nome, e-mail, senha, aceite dos Termos e da Política). O servidor **não cria usuário**: guarda o pedido (senha já em scrypt) por 24 h e envia o link de confirmação.
2. **Confirmar e-mail** (`/verificar-email?code=…`). Só então o usuário é criado (`TENANT`, sem empresa, sem poder administrativo) e já entra com sessão.
3. **Espaço de trabalho**: nome da empresa/marca (e, opcionalmente, outro nome para o espaço). Cria empresa + conta de destino provisória e torna o usuário `OWNER` **somente dela**, numa transação.
4. **Conectar Instagram** (ou "Fazer isso depois"). Unified Login oficial; a vinculação continua por Instagram ID, só na empresa do usuário, sem criar sessão pelo callback.
5. **Painel** com 4 estados: sem Instagram (aviso + "Ir para Conta"), conectado (@username), autorização expirada ("Reconectar") e espaço vazio (mensagem, sem conteúdo fictício).

- **Esqueci minha senha**: link de 1 h, uso único; ao redefinir, as sessões antigas do usuário são encerradas.
- **Convites**: o proprietário (ou o admin, por empresa) convida por e-mail; convite de 7 dias, uso único, papel sempre `MEMBER`.

Decisão de segurança: o cadastro só vira usuário depois do clique no e-mail. Assim ninguém "reserva" o e-mail de outra pessoa com uma senha que só ele conhece. Cadastro com e-mail já existente recebe a mesma resposta e um e-mail "você já tem conta" (sem enumeração).

## 2. Telas

`Entrar | Criar conta` (abas, mostrar/ocultar senha, esqueci minha senha), "Confirme seu e-mail", `/verificar-email`, `/redefinir-senha`, `/convite`, onboarding em 2 etapas com indicador de progresso, estado vazio no Dashboard e "Convidar pessoas" em Conta (só `OWNER`). Responsivas (testadas em 1280 px e 390 px). Identidade visual preservada.

## 3. Endpoints

| Método e rota | Função |
|---|---|
| `POST /api/auth/signup` (alias `/api/auth/register`) | pedido de cadastro; sempre 202 com a mesma mensagem |
| `POST /api/auth/verify-email` | consome o link, cria o usuário, devolve sessão |
| `POST /api/auth/forgot-password` | 202 sempre; admin global não usa este caminho |
| `POST /api/auth/reset-password` | nova senha + encerra as sessões do usuário |
| `POST /api/workspaces` | cria o espaço (dono = usuário autenticado; nada de tenant, empresa ou papel vem do corpo) |
| `POST /api/invites`, `GET /api/invites/:token`, `POST /api/invites/accept` | convites |
| `GET /api/auth/profile` | perfil atual |
| `POST /api/auth/login` | **modificado**: limite de tentativas (IP e e-mail) |
| `POST /api/posts/:id/publish`, `POST /api/instagram/publish` | **modificados**: 409 `INSTAGRAM_NOT_CONNECTED` para agendar/publicar sem conta conectada (aprovar continua permitido) |

O antigo `/api/auth/register` criava sessão sem confirmar o e-mail, aceitava senha de 6 caracteres e dependia de aprovação manual; foi substituído.

## 4. Migração `010_self_service_signup` (aditiva e reversível)

`users`: `email_verified_at`, `workspace_role`, `sessions_valid_after`, `terms_accepted_at`. Novas tabelas `auth_tokens` (só o SHA-256 do token) e `auth_rate_limits`. Usuários existentes recebem `email_verified_at` e **continuam com `workspace_role` nulo** (ninguém vira dono nem admin). O `down` remove somente o que a migração criou. Testado: preserva usuários antigos e é reversível sem tocar nos dados de negócio.

## 5. Variáveis de e-mail

`RESEND_API_KEY`, `MAIL_FROM` (domínio verificado no Resend, com SPF e DKIM) e `APP_URL` (já existe; base dos links). Sem elas, cadastro, recuperação e convite respondem 503 e **nada é criado**. `MAIL_PROVIDER=console` só funciona fora de produção.

## 6. Testes

- Novos (`self_service_signup.test.ts`, 21): cadastro, e-mail duplicado sem enumeração, link expirado ou reutilizado, validações, limite de tentativas, login válido e inválido, recuperação (sessões antigas caem), espaço de trabalho, isolamento, convites (permissões, uso único, conflito de empresa), migração 010 preservando usuários antigos e logs sem token nem senha.
- `oauth_unified_security.test.ts` (31): o teste da jornada foi reescrito para o cadastro novo (o antigo exercitava o `/register` inseguro) e foram somados bloqueio de publicação sem Instagram e reconexão.
- Resultado: vitest 94 aprovados; `node:test` 23/23; build OK; `tsc` 109 erros (igual ao baseline, nenhum arquivo novo). Duas falhas em `saasMultiTenantInstagram` ocorrem **igualmente no código base** quando o `.env` não existe na worktree; na pasta principal esse arquivo passou 7/7 antes das mudanças.
- Navegador (PostgreSQL 17 descartável): cadastro → confirmação → espaço → Unified Login aberto com `client_id` e `config_id` corretos → "Fazer isso depois" → painel vazio → sair e entrar (senha errada e certa) → Conta com convites, em desktop e celular.

## 7. Riscos e pendências

- **E-mail real não testado**: só o transporte capturado e o modo console foram exercitados. Falta configurar o Resend e enviar a uma caixa real (entrega, SPF/DKIM, spam).
- **Conexão real com o Instagram**: o diálogo da Meta abre, mas concluir exige uma conta de teste real. Contas externas só conectam se tiverem função no app (Standard Access); a interface já avisa.
- A sessão continua em JWT no `localStorage` com `Authorization: Bearer` (arquitetura existente), por isso não há CSRF de cookie. Migrar para cookie HttpOnly é uma mudança maior, fora deste escopo.
- A revogação por usuário recarrega a cada 30 s (várias instâncias convergem em até 30 s).
- O admin ainda não tem tela de convite (a rota `POST /api/invites` com `companyId` existe).
- `.data/` e `comando.txt` continuam rastreados nesta base; o commit `cc10258` (branch `prep/untrack-data`) resolve e precisa ser combinado a esta branch antes do deploy.

## 8. Procedimento de deploy seguro

1. Resolver antes o deploy pendente (`recovery/meta-review` ou `main` + `prep/untrack-data`); esta branch **não** deve ir junto.
2. Configurar o domínio no Resend e as variáveis `RESEND_API_KEY` e `MAIL_FROM` no Railway; testar o envio a uma caixa real.
3. Cópia lógica (schema `backup_pre_010`, como no plano de deploy) e conferir `schema_migrations` terminando em `009`.
4. Merge desta branch, push, deploy. A `010` roda no boot (ou no pre-deploy); o healthcheck só libera depois que ela estiver aplicada.
5. Verificar: `/api/health` 200; cadastro de uma conta de teste; e-mail recebido; confirmação; espaço; conexão de Instagram de teste.
6. Rollback: redeploy da tag anterior. A `010` é aditiva; o código anterior ignora as colunas e tabelas novas.

## 9. Roteiro atualizado para o App Review

O revisor pode **criar a própria conta** (e confirmar o e-mail) ou usar a conta de avaliação provisionada. Sequência: Criar conta → confirmar e-mail → criar espaço → **Conectar Instagram** (diálogo oficial da Meta, mostrar as permissões) → painel com `@username` → Posts → aprovar → Agendar/Publicar (destino, imagem e legenda; confirmação explícita; resultado só com o ID da mídia). `instagram_manage_messages` continua sem uso, como no guia anterior. Em `REVIEWER-GUIDE-EN.md`, os passos 1–3 passam a descrever o cadastro e a confirmação de e-mail; os demais não mudam. A gravação só deve ser feita depois de o e-mail real funcionar.
