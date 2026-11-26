# Cadastro público — validação e checklist de publicação

Branch: `feat/saas-onboarding`. Complementa `ONBOARDING-SAAS.md`. Nada foi enviado ao `origin`, publicado, migrado em produção nem teve credencial alterada.

## 1. Estado dos testes (ambiente isolado, valores fictícios)

| Verificação | Resultado |
|---|---|
| `npx vitest run` (12 arquivos) | **114 aprovados, 0 falhas** |
| `npm run test:node` | **23 aprovados, 0 falhas** |
| `vite build` | OK |
| `tsc --noEmit` | 109 erros = baseline do projeto; nenhum em arquivo novo |
| Mesma suíte na combinação `feat/saas-onboarding` + `prep/untrack-data` (sem `.data/` nem `comando.txt` no disco) | 114 e 23 aprovados |

As duas falhas antigas de `saasMultiTenantInstagram` eram a falta de `JWT_SECRET` (e demais variáveis) na worktree. Agora `vitest.config.ts` e `scripts/run-node-tests.mjs` definem valores **fictícios e fixos** (`vitest-only-...`). Nenhum teste lê o `.env` nem usa segredo real, e nada foi copiado do `.env` de produção. Os testes de isolamento multiempresa estão incluídos e passam.

## 2. Revisão de segurança do cadastro público

### Defeitos encontrados e corrigidos

| # | Gravidade | Defeito | Correção |
|---|---|---|---|
| 1 | **Crítica** | `GET /api/system/gas-config` devolvia a **qualquer usuário autenticado** um JWT de **ADMIN válido por 10 anos** (`tenYearJwt`) e o `WEBHOOK_SECRET_TOKEN`. Com cadastro público, qualquer pessoa viraria administradora global em duas chamadas. | Só ADMIN. |
| 2 | Alta | `GET /api/scheduler/status` expunha agendamentos e alertas de todos os clientes. | Só ADMIN. |
| 3 | Alta | `GET /api/drive/folders` e a resposta de `POST /api/posts/sync-drive` entregavam pastas, lotes e arquivos de todos os clientes. | `drive/folders` só ADMIN; `sync-drive` devolve ao cliente apenas a confirmação. |
| 4 | Alta | `GET /api/posts` listava os nomes das pastas de todos os clientes. | Cliente só recebe o nome da própria pasta. |
| 5 | Alta | Cliente sem espaço de trabalho chamando `/api/observations` ou `/api/creative-context` caía no padrão "Ato", era **anexado à empresa Ato** (`UPDATE users SET company_id`) e passava a ver e escrever nas observações dela. | O resolvedor recusa quem não é ADMIN e não tem nenhum identificador. |
| 6 | Alta | Espaço novo com nome igual ao da **pasta do Drive** de um cliente (diferente do nome da empresa) enxergava os posts dele, porque várias rotas antigas casam por nome de pasta. | A pasta do espaço novo é um identificador interno (`workspace_<hex>`), nunca derivado do texto digitado; o nome exibido ganha sufixo se coincidir com empresa, pasta, conta ou post existentes. |
| 7 | Média | Limite por e-mail contornável com maiúsculas e espaços. | Limite usa o e-mail normalizado. |
| 8 | Média | "Esqueci minha senha" respondia mais devagar quando a conta existia (envio do e-mail na requisição): enumeração por tempo. | Envio em segundo plano e piso de 350 ms em todas as respostas públicas (diferença medida < 150 ms nos testes). |

Cada item acima tem teste que **falhava antes da correção** (`public_signup_isolation.test.ts`, `self_service_signup.test.ts`).

### Controles verificados

- **Limites de tentativa** (PostgreSQL, valem para várias instâncias): cadastro 10/h por IP, 3/h por e-mail, 300/h global; recuperação igual; login 40/15 min por IP e 10/15 min por e-mail; confirmação 30/15 min; redefinição 20/15 min; convites 20/h por usuário.
- **Cadastro automatizado**: campo-isca invisível (robô recebe a mesma resposta e nada é criado nem enviado), teto global e confirmação obrigatória por e-mail. **Não há CAPTCHA**: se aparecer abuso real, o próximo passo é Cloudflare Turnstile (exige chave; não foi adicionado por ser funcionalidade nova).
- **Expiração e uso único**: confirmação 24 h, redefinição 1 h, convite 7 d; só o SHA-256 fica no banco; consumo atômico.
- **E-mail duplicado**: mesma resposta e mesmo tempo; a pessoa dona do endereço recebe "você já tem conta".
- **Falha do provedor**: não derruba o cadastro e não revela se a conta existe; o log tem só a causa (`HTTP 4xx`), sem endereço, chave ou link.
- **Sem poder global**: usuário novo é `TENANT`, `workspace_role = OWNER` só da própria empresa; chamadas administrativas retornam 403. Não herda nenhuma empresa por nome, e-mail ou usuário do Instagram.
- **Sem acesso a clientes existentes**: a varredura chama 12 rotas de leitura e 5 de escrita, como usuário sem espaço e como usuário com espaço de mesmo nome que um cliente existente; nenhum dado ou segredo do cliente aparece e o post do cliente permanece idêntico.

### Limites conhecidos

- A sessão continua em JWT no `localStorage`, não em cookie HttpOnly. Uma falha de XSS no futuro exporia a sessão; migrar é uma mudança maior e fora deste escopo.
- Variações do mesmo endereço (`a+1@gmail.com`, `a+2@gmail.com`) são e-mails distintos; elas são contidas pelo limite por IP e pelo teto global, não pelo limite por e-mail.

## 3. Resend

**Configuração (manual):**

1. No Resend, adicione o domínio de envio e publique os registros DNS (SPF e DKIM; recomendado DMARC). Aguarde "Verified".
2. Crie uma chave de API com permissão de envio.
3. No Railway: `RESEND_API_KEY=<chave>`, `MAIL_FROM=ATO Social Hub <nao-responda@SEU-DOMINIO>`, `APP_URL=https://socialhub.atodev.com.br` (já existe). Não use `MAIL_PROVIDER=console` em produção (é ignorado).

**O que o código garante** (`mailer.test.ts`, 7 testes): chave só no cabeçalho `Authorization`; erro, rede e tempo esgotado viram mensagens fixas sem chave, destinatário nem corpo; envio com tempo limite de 10 s; os links dos modelos usam o domínio de `APP_URL`; conteúdo do usuário é escapado.

**Teste real de entrega** (`scripts/mail-delivery-check.ts`), a rodar por você com a chave do Resend:

```powershell
$env:RESEND_API_KEY = "re_..."          # não cole em logs nem em commits
$env:MAIL_FROM      = "ATO Social Hub <nao-responda@SEU-DOMINIO>"
$env:APP_URL        = "https://socialhub.atodev.com.br"
npx tsx scripts/mail-delivery-check.ts --to sua-caixa-real@gmail.com
```

Envia os **3 modelos de produção** (confirmação, recuperação, convite) com códigos descartáveis que não existem no sistema, não toca no banco, não imprime chave nem links e consulta o evento de entrega no Resend por até 90 s. "A API aceitou" **não** é entrega: o script só sai com sucesso se o Resend informar `delivered` para os três, e mesmo assim a validação só termina na conferência humana (caixa de entrada x spam, remetente, domínio do botão, SPF/DKIM/DMARC = PASS em "Mostrar original"). Repita com uma segunda caixa de outro provedor.

**Situação hoje:** o script e o contrato HTTP foram testados; **a entrega real não foi validada**, porque não há chave nem domínio verificado neste ambiente. Uma execução com chave fictícia chegou ao Resend e recebeu `401`, sem enviar nada, o que confirma o tratamento de erro.

## 4. Migração 010 × 008 × 009

Teste `010 convive com 008 (OAuth) e 009 (senha retirada)`:

- ordem final em `schema_migrations`: `008_oauth_state_and_pending_connections` → `009_block_retired_default_password` → `010_self_service_signup`; reaplicar duas vezes não muda nada;
- com a 010 aplicada, as tabelas da 008 existem e o gatilho da 009 continua trocando o hash da senha retirada por `disabled$blocked_retired_default_password`;
- reverter somente a 010 preserva as tabelas da 008, o gatilho da 009 e todos os usuários; reaplicar restaura o estado;
- a 010 só adiciona colunas/tabelas e faz `UPDATE users SET email_verified_at` (não toca `password_hash`, então não aciona o gatilho da 009);
- o portão de readiness (`/api/health`) lista qualquer migração pendente, inclusive a 010, e só libera depois dela.

## 5. Remoção de `.data/` e `comando.txt`

`cc10258` (`prep/untrack-data`) **não** está nesta branch. Foi simulado o merge dele sobre `feat/saas-onboarding`: **sem conflitos**; `git ls-files .data comando.txt` retorna 0; com os arquivos ausentes do disco, vitest (114) e node:test (23) passam. Ordem obrigatória de integração:

1. `prep/untrack-data` (ou o cherry-pick de `cc10258`) entra **antes** do deploy do onboarding, na mesma base que será publicada;
2. depois `feat/saas-onboarding`.

Antes de integrar na pasta principal, copie `.data/` e `comando.txt` para fora do repositório (o merge os apaga do disco local). A senha do Postgres que aparece em `comando.txt` continua no histórico do Git; a rotação coordenada segue pendente e não foi feita.

## 6. Plano de ativação do cadastro público

Princípio: **o código novo vai para produção com o cadastro fechado**. O interruptor `PUBLIC_SIGNUP_ENABLED` (padrão **desligado** em produção) bloqueia `POST /api/auth/signup` (e o alias `/register`) com `403 SIGNUP_DISABLED` e esconde "Criar conta" na tela. Login, recuperação de senha, convites, sessões e todos os usuários existentes não dependem dele.

| Fase | Ação | Critério para avançar |
|---|---|---|
| 0 | Resolver o deploy pendente da recuperação (item 0 do checklist). | Login do admin e dos clientes funcionando em produção. |
| 1 | Deploy com `PUBLIC_SIGNUP_ENABLED` ausente/`false`. Migração 010 roda. | `/api/health` 200; migrações até `010`; login e agendamentos normais; `GET /api/auth/config` → `{"signupEnabled":false}`; "Criar conta" não aparece. |
| 2 | Configurar Resend (domínio verificado, chave, `MAIL_FROM`). | Domínio "Verified". |
| 3 | `mail-delivery-check.ts` para 2 caixas reais. | 3 e-mails `delivered` em cada, na caixa de entrada, SPF/DKIM/DMARC PASS. |
| 4 | Ligar: `PUBLIC_SIGNUP_ENABLED=true` (reinicia o serviço). Cadastrar uma conta de teste real do início ao fim (confirmar, criar espaço, redefinir senha, convidar). | Fluxo completo com e-mail real; nenhuma outra conta afetada. |
| 5 | Observar 24–48 h: taxa de 429, bounces/complaints no Resend, contas criadas. | Sem picos; se houver abuso, desligar a variável e considerar Turnstile. |
| Reversão | `PUBLIC_SIGNUP_ENABLED=false` fecha o cadastro na hora, sem redeploy de código e sem tocar nos dados. Contas já criadas continuam entrando. | |

## 7. Checklist objetivo para publicar o novo onboarding

**0. Antes de tudo (produção atual)**
- [ ] Corrigir `GET /api/system/gas-config` (e `scheduler/status`, `drive/folders`) também no código que está em produção: o defeito 1 existe em `main` e em `recovery/meta-review`. Qualquer cliente logado hoje consegue um JWT de ADMIN de 10 anos. Decisão sua: incluir o mesmo ajuste na recuperação.
- [ ] Depois do deploy corrigido, definir `SESSIONS_VALID_AFTER` com a data/hora do deploy para invalidar tokens emitidos antes; se o Apps Script usa um token de 10 anos já emitido, ele também será recusado e precisará ser gerado de novo por um administrador (via `GET /api/system/gas-config`, que agora exige ADMIN).
- [ ] Deploy da recuperação concluído e estável (login do admin, clientes e agendamentos).

**1. Código**
- [ ] `prep/untrack-data` integrada antes (seção 5); `.data/` e `comando.txt` copiados para fora do repositório.
- [ ] `feat/saas-onboarding` integrada; `npx vitest run` e `npm run test:node` verdes; `vite build` OK.

**2. Provedor de e-mail**
- [ ] Domínio verificado no Resend; chave criada; `RESEND_API_KEY` e `MAIL_FROM` no Railway.
- [ ] `mail-delivery-check.ts` com `delivered` x3, em 2 caixas, e conferência humana (inbox, SPF/DKIM/DMARC).

**3. Banco**
- [ ] Cópia lógica antes da migração (schema `backup_pre_010`); `schema_migrations` terminando em `009`.
- [ ] Após o deploy: terminando em `010`; `SELECT count(*) FROM users` igual ao de antes; nenhum `workspace_role` preenchido para usuários antigos.

**4. Deploy fechado**
- [ ] `PUBLIC_SIGNUP_ENABLED` ausente ou `false`; `APP_URL` correto.
- [ ] `/api/health` 200; `GET /api/auth/config` → `signupEnabled:false`; login do admin e de um cliente; um agendamento existente intacto.

**5. Abertura**
- [ ] `PUBLIC_SIGNUP_ENABLED=true`; conta de teste do início ao fim com e-mail real.
- [ ] `GET /api/system/gas-config` com a conta de teste → 403.
- [ ] Conta de teste não vê nenhum dado de outro cliente.
- [ ] Meta: conectar um Instagram de teste (com função no app) pelo botão "Conectar Instagram"; só então gravar o vídeo do App Review.

**6. Pós-abertura**
- [ ] Acompanhar bounces/complaints, 429 e novas contas por 48 h.
- [ ] Rotações pendentes (senha do Postgres exposta no histórico, `META_VERIFY_TOKEN`, Apps Script) em janela própria, depois de estável.
