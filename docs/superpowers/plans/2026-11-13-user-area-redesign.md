# Redesign da área do usuário Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar a nova área do usuário (TENANT, conectado pelo Instagram): login sem cadastro, dashboard com agenda, memória de IA em tela própria e exclusão de conta dentro da área logada, sem alterar o painel do admin.

**Architecture:** Lógica pura (agrupamento de posts, grade do calendário, validação de exclusão) fica em módulos testáveis com Vitest. Componentes React novos ficam em `src/components/user/`. `App.tsx` escolhe entre o layout do admin (inalterado) e o `UserLayout` quando `user.role === 'TENANT'`. A exclusão é uma rota nova no servidor que valida a confirmação e grava um registro de auditoria em arquivo.

**Tech Stack:** React + TypeScript (Vite), Tailwind (classes já em uso), Express (`server.ts`), Vitest para testes unitários.

**Spec:** `docs/superpowers/specs/2026-11-13-user-area-redesign-design.md`

## Global Constraints

- Paleta: fundo `#0A0A0A`, cartões `#121212`, bordas `#242424`, destaque `#10B981`, texto `#FFFFFF`, texto secundário `#8E8E93`.
- Gutter lateral de 16px no celular; sem rolagem horizontal.
- Nenhuma mudança no painel do admin (`user.role === 'ADMIN'`).
- Nenhuma mudança no OAuth, na publicação ou no agendador.
- Exclusão remove dados e tokens do app; nunca remove a conta no Instagram.
- Linha de base de erros de TypeScript (`npx tsc --noEmit -p tsconfig.json`): 111. Nenhuma tarefa pode aumentar esse número.

## Review Focus

1. Usuário sem nenhum post: dashboard e agenda mostram estado vazio, não erro. Esperado: mensagem "Nenhum post programado".
2. Posts com `scheduledAt` ausente ou inválido: não aparecem na agenda nem quebram a grade. Esperado: ficam fora do calendário e aparecem em "Posts".
3. Posts em vários meses: a agenda mostra só o mês selecionado, e a navegação entre meses mantém os dados. Esperado: troca de mês sem recarregar a página.
4. Confirmação de exclusão com maiúsculas, espaços ou `@`: o `@username` é comparado normalizado. Esperado: `@Ato.VC ` confirma a conta `ato.vc`.
5. Página pública `/exclusao-de-dados` sem sessão: não exibe nenhum botão de ação. Esperado: somente texto informativo.

---

### Task 1: Validação e auditoria da exclusão (servidor)

**Files:**
- Create: `src/services/accountDeletion.ts`
- Create: `src/tests/accountDeletion.test.ts`
- Modify: `server.ts` (nova rota `POST /api/account/delete`, perto das rotas de autenticação TENANT)

**Interfaces:**
- Produces:
  - `normalizeUsername(value: string): string` (remove `@`, espaços e põe em minúsculas)
  - `validateDeletionRequest(params: { sessionUsername: string; confirmUsername: string }): { ok: true } | { ok: false; reason: 'MISMATCH' | 'EMPTY' }`
  - `buildDeletionAuditEntry(params: { username: string; tenantId: string; ip: string; at: string }): string` (uma linha JSON terminada em `\n`)

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/tests/accountDeletion.test.ts
import { describe, it, expect } from 'vitest';
import {
  normalizeUsername,
  validateDeletionRequest,
  buildDeletionAuditEntry,
} from '../services/accountDeletion.ts';

describe('normalizeUsername', () => {
  it('remove @, espaços e põe em minúsculas', () => {
    expect(normalizeUsername('  @Ato.VC ')).toBe('ato.vc');
  });
});

describe('validateDeletionRequest', () => {
  it('aceita confirmação igual ao usuário da sessão, ignorando formato', () => {
    expect(validateDeletionRequest({ sessionUsername: 'ato.vc', confirmUsername: '@Ato.VC ' })).toEqual({ ok: true });
  });
  it('rejeita confirmação vazia', () => {
    expect(validateDeletionRequest({ sessionUsername: 'ato.vc', confirmUsername: '   ' })).toEqual({ ok: false, reason: 'EMPTY' });
  });
  it('rejeita confirmação de outra conta', () => {
    expect(validateDeletionRequest({ sessionUsername: 'ato.vc', confirmUsername: 'outra' })).toEqual({ ok: false, reason: 'MISMATCH' });
  });
});

describe('buildDeletionAuditEntry', () => {
  it('gera uma linha JSON com os campos de auditoria', () => {
    const line = buildDeletionAuditEntry({ username: 'ato.vc', tenantId: 't1', ip: '1.2.3.4', at: '2026-11-13T00:00:00.000Z' });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ event: 'ACCOUNT_DELETED', username: 'ato.vc', tenantId: 't1', ip: '1.2.3.4', at: '2026-11-13T00:00:00.000Z' });
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx vitest run src/tests/accountDeletion.test.ts`
Expected: FAIL com "Cannot find module '../services/accountDeletion.ts'".

- [ ] **Step 3: Implementar `src/services/accountDeletion.ts`**

Implementar as três funções da seção Interfaces. `normalizeUsername` usa `replace(/^@/, '')` após `trim()` e `toLowerCase()`. `validateDeletionRequest` retorna `EMPTY` quando a confirmação normalizada é vazia e `MISMATCH` quando difere de `sessionUsername` normalizado.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/tests/accountDeletion.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Adicionar a rota no servidor**

Em `server.ts`, rota `POST /api/account/delete` com `requireAuth`, apenas para `req.user.role === 'TENANT'`:
1. Chama `validateDeletionRequest` com `sessionUsername = req.user.instagramUsername` e `confirmUsername = req.body.confirmUsername`. Se `ok: false`, responde 400 com `{ error: 'Confirmação não confere com a conta.' }`.
2. Acrescenta a linha de `buildDeletionAuditEntry` em `.data/account-deletions.log` (`fs.appendFileSync`, criando o arquivo se não existir), com `ip = req.ip`, `at = new Date().toISOString()`.
3. Remove o tenant do array `tenants`, salva com `saveDatabaseToDisk()` e remove o registro de `instagram_accounts` via `deleteInstagramAccountFromDb(tenantId)` (já existe em `src/db/repository.ts`).
4. Responde `{ success: true }`.

- [ ] **Step 6: Verificar build e erros de tipo**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: 111 (ou menos).

- [ ] **Step 7: Commit**

```bash
git add src/services/accountDeletion.ts src/tests/accountDeletion.test.ts server.ts
git commit -m "feat: exclusão de conta com confirmação e auditoria"
```

---

### Task 2: Cliente da API para exclusão

**Files:**
- Modify: `src/services/api.ts` (método `deleteAccount` no objeto `api`, na linha 92)

**Interfaces:**
- Consumes: rota `POST /api/account/delete` (Task 1).
- Produces: `api.deleteAccount(confirmUsername: string): Promise<{ success: boolean; error?: string }>`

- [ ] **Step 1: Adicionar o método seguindo o padrão dos demais métodos de `api`**

Usar o mesmo helper de requisição autenticada que os outros métodos de `api` já usam. Método `POST`, corpo `{ confirmUsername }`.

- [ ] **Step 2: Verificar tipos**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: 111 (ou menos).

- [ ] **Step 3: Commit**

```bash
git add src/services/api.ts
git commit -m "feat: api.deleteAccount"
```

---

### Task 3: Login sem cadastro

**Files:**
- Modify: `src/components/LoginView.tsx`

**Interfaces:**
- Consumes: `api.getInstagramAuthUrl`, `api.login`, `authStorage` (já existentes). Nenhuma assinatura muda.
- Produces: o mesmo `LoginViewProps` (`onLoginSuccess`, `onNavigateLegal`).

- [ ] **Step 1: Remover a aba e o fluxo de cadastro**

Remover: estado `authMode`, a aba "Solicitar Cadastro", `name`, `companyName`, `handleSubmitRegister` e o formulário de cadastro. Manter `handleInstagramOAuth`, `handleSubmitLogin` e o listener de `INSTAGRAM_AUTH_SUCCESS` intactos.

- [ ] **Step 2: Reorganizar o layout**

Duas colunas acima de `md`: coluna esquerda com a marca (`BrandLogo`), a frase de efeito e três destaques; coluna direita com o card. Abaixo de `md`, o card ocupa a tela com a marca acima. Botão principal "Conectar com Instagram" em destaque. O formulário de e-mail e senha fica dentro de `<details>` com o rótulo "Acesso administrativo".

- [ ] **Step 3: Rodapé**

Manter apenas os links "Política de Privacidade" e "Termos de Uso". Remover o link "Exclusão de Dados".

- [ ] **Step 4: Verificação**

Run: `npm run build`
Expected: "built in" sem erro.
Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: 111 (ou menos).
Manual: abrir a página no navegador, verificar desktop e celular, e confirmar que não existe aba de cadastro.

- [ ] **Step 5: Commit**

```bash
git add src/components/LoginView.tsx
git commit -m "feat: login split-screen sem cadastro"
```

---

### Task 4: Página pública de exclusão só informativa

**Files:**
- Modify: `src/components/PublicLegalPage.tsx` (bloco `route === '/exclusao-de-dados'`, linha ~389)

**Interfaces:**
- Nenhuma assinatura muda.

- [ ] **Step 1: Verificar que não há ação na página**

Run: `grep -n "onClick\|<button\|api\.\|deleteAccount" src/components/PublicLegalPage.tsx`
Expected: nenhuma chamada de exclusão nem botão dentro do bloco `/exclusao-de-dados`. Links de navegação existentes podem permanecer.

- [ ] **Step 2: Atualizar o texto**

No bloco `/exclusao-de-dados`, explicar: quais dados são guardados, como solicitar a exclusão pelo painel (usuário logado, em "Conta") e o prazo de remoção. Incluir o e-mail de contato já usado na página. Não incluir nenhum formulário.

- [ ] **Step 3: Verificação**

Run: `npm run build`
Expected: "built in" sem erro.

- [ ] **Step 4: Commit**

```bash
git add src/components/PublicLegalPage.tsx
git commit -m "docs: página pública de exclusão só informativa"
```

---

### Task 5: Lógica pura do dashboard

**Files:**
- Create: `src/utils/userDashboard.ts`
- Create: `src/utils/userDashboard.test.ts`

**Interfaces:**
- Consumes: `PostGroup`, `PostStatus` de `src/types/index.ts`.
- Produces:
  - `summarizePosts(posts: PostGroup[], now: Date): { scheduled: number; publishedThisWeek: number; failed: number }`
    - `scheduled`: status `AGENDADO`.
    - `publishedThisWeek`: status `PUBLICADO` com `publishedAt` nos últimos 7 dias.
    - `failed`: status `FALHA_PUBLICACAO` ou `RECONEXAO_NECESSARIA`.
  - `upcomingPosts(posts: PostGroup[], now: Date, limit: number): PostGroup[]`
    - Só `AGENDADO` com `scheduledAt` válido e `>= now`, ordenados do mais próximo ao mais distante, até `limit`.

- [ ] **Step 1: Escrever os testes que falham**

Cobrir: contagens por status; post `PUBLICADO` há 10 dias não conta em `publishedThisWeek`; `scheduledAt` inválido (`'não-é-data'`) fica fora de `upcomingPosts`; `upcomingPosts` respeita `limit` e ordem. Usar `now = new Date('2026-11-13T12:00:00Z')`.

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx vitest run src/utils/userDashboard.test.ts`
Expected: FAIL com "Cannot find module".

- [ ] **Step 3: Implementar as duas funções**

Comparar datas com `Date.parse`. Um valor `NaN` é tratado como ausente.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/utils/userDashboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/userDashboard.ts src/utils/userDashboard.test.ts
git commit -m "feat: resumo e próximos posts do dashboard do usuário"
```

---

### Task 6: Lógica pura da grade da agenda

**Files:**
- Create: `src/utils/agendaGrid.ts`
- Create: `src/utils/agendaGrid.test.ts`

**Interfaces:**
- Consumes: `PostGroup` de `src/types/index.ts`.
- Produces:
  - `buildMonthGrid(year: number, month: number, posts: PostGroup[], timezone?: string): { date: string; inMonth: boolean; posts: PostGroup[] }[]`
    - Sempre 42 células (6 semanas), começando no domingo. `date` no formato `YYYY-MM-DD`.
    - `posts` de cada célula são os de `status === 'AGENDADO'` cujo `scheduledAt` cai nesse dia (no fuso `timezone`, padrão `America/Sao_Paulo`), ordenados por horário.
    - Posts com `scheduledAt` ausente ou inválido não aparecem em nenhuma célula.

- [ ] **Step 1: Escrever os testes que falham**

Cobrir: 42 células; primeira célula é um domingo; um post às `2026-11-14T02:00:00Z` (que é 13/11 às 23:00 em São Paulo) cai em 13/11, não em 14/11; post inválido não aparece; posts do mesmo dia ordenados por horário.

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx vitest run src/utils/agendaGrid.test.ts`
Expected: FAIL com "Cannot find module".

- [ ] **Step 3: Implementar**

Converter `scheduledAt` para a data local do fuso com `Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })`, que devolve `YYYY-MM-DD`. Agrupar em um `Map` por essa chave.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/utils/agendaGrid.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/agendaGrid.ts src/utils/agendaGrid.test.ts
git commit -m "feat: grade mensal da agenda com fuso de São Paulo"
```

---

### Task 7: Layout do usuário e navegação

**Files:**
- Create: `src/components/user/UserLayout.tsx`
- Create: `src/components/user/types.ts` (tipo `UserView = 'dashboard' | 'posts' | 'agenda' | 'memoria' | 'conta'`)

**Interfaces:**
- Produces: `UserLayout(props: { user: AuthResponse['user']; view: UserView; onChangeView: (v: UserView) => void; onLogout: () => void; children: React.ReactNode })`
- Comportamento: sidebar fixa acima de `md`; barra inferior fixa abaixo de `md` com os cinco itens; item ativo com `#10B981`; nome `@username` e botão "Sair" no topo da sidebar.

- [ ] **Step 1: Implementar o componente**

Sem lógica de dados. Usar as classes Tailwind já em uso no projeto e a paleta das Global Constraints.

- [ ] **Step 2: Verificação**

Run: `npm run build`
Expected: "built in" sem erro.

- [ ] **Step 3: Commit**

```bash
git add src/components/user/UserLayout.tsx src/components/user/types.ts
git commit -m "feat: layout e navegação da área do usuário"
```

---

### Task 8: Dashboard, Agenda e Posts

**Files:**
- Create: `src/components/user/UserDashboard.tsx`
- Create: `src/components/user/AgendaView.tsx`
- Create: `src/components/user/PostsView.tsx`

**Interfaces:**
- Consumes: `summarizePosts`, `upcomingPosts` (Task 5); `buildMonthGrid` (Task 6); `filterPosts` de `src/utils/postHelpers.ts` (linha 321); `PostGroup` (`src/types/index.ts`).
- Produces:
  - `UserDashboard(props: { posts: PostGroup[]; now?: Date })`
  - `AgendaView(props: { posts: PostGroup[]; now?: Date })` com estado interno do mês exibido e botões de mês anterior/próximo.
  - `PostsView(props: { posts: PostGroup[] })` com filtro por status.

- [ ] **Step 1: `UserDashboard`**

Três cartões de resumo (`summarizePosts`) e lista de `upcomingPosts(posts, now, 6)`. Cada item mostra a miniatura do primeiro `items[0].thumbnailUrl` (ou um bloco vazio se ausente), `nome`, data/hora de `scheduledAt` e status. Estado vazio: "Nenhum post programado".

- [ ] **Step 2: `AgendaView`**

Cabeçalho com mês/ano e setas. Grade de 7 colunas com os cabeçalhos dos dias. Cada célula mostra o dia e até três miniaturas pequenas; se houver mais, "+N". Células fora do mês aparecem atenuadas. Clicar em um post abre o detalhe (reaproveitar o modal de detalhe existente em `App.tsx` se houver, senão exibir `nome` e horário em um painel lateral).

- [ ] **Step 3: `PostsView`**

Filtros por status com `filterPosts` (`src/utils/postHelpers.ts:321`). Lista em cartões com miniatura, nome, status e data.

- [ ] **Step 4: Verificação**

Run: `npm run build`
Expected: "built in" sem erro.
Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: 111 (ou menos).

- [ ] **Step 5: Commit**

```bash
git add src/components/user/UserDashboard.tsx src/components/user/AgendaView.tsx src/components/user/PostsView.tsx
git commit -m "feat: dashboard, agenda e lista de posts do usuário"
```

---

### Task 9: Memória criativa em tela própria

**Files:**
- Create: `src/components/user/MemoryView.tsx`

**Interfaces:**
- Consumes: `ClientObservationsView` (`src/components/ClientObservationsView.tsx`) com as props que ele já recebe.
- Produces: `MemoryView(props: { <mesmas props de ClientObservationsView> })`.

- [ ] **Step 1: Envolver o componente existente**

Renderizar `ClientObservationsView` com o título "Memória criativa" e um parágrafo curto de contexto. Não alterar `ClientObservationsView` nesta tarefa.

- [ ] **Step 2: Verificação**

Run: `npm run build`
Expected: "built in" sem erro.

- [ ] **Step 3: Commit**

```bash
git add src/components/user/MemoryView.tsx
git commit -m "feat: memória criativa em tela própria do usuário"
```

---

### Task 10: Conta e exclusão com confirmação

**Files:**
- Create: `src/components/user/AccountView.tsx`

**Interfaces:**
- Consumes: `api.deleteAccount` (Task 2); `normalizeUsername` de `src/services/accountDeletion.ts` (Task 1), para habilitar o botão antes do envio.
- Produces: `AccountView(props: { user: AuthResponse['user']; onAccountDeleted: () => void })`.

- [ ] **Step 1: Implementar**

Seção "Conta conectada" com `@username`, status do token e botão "Reconectar" (reaproveitar o fluxo `api.getInstagramAuthUrl` de `LoginView`). Seção "Excluir minha conta": texto explicando o que é apagado (dados e tokens do app, não a conta do Instagram), campo para digitar o `@username`, botão habilitado só quando `normalizeUsername(input) === normalizeUsername(user.instagramUsername)`. Ao confirmar, chama `api.deleteAccount(input)`; em sucesso, chama `onAccountDeleted()`; em erro, mostra a mensagem.

- [ ] **Step 2: Verificação**

Run: `npm run build`
Expected: "built in" sem erro.
Manual: digitar um `@username` errado e confirmar que o botão fica desabilitado.

- [ ] **Step 3: Commit**

```bash
git add src/components/user/AccountView.tsx
git commit -m "feat: conta do usuário com exclusão confirmada"
```

---

### Task 11: Ligar a área do usuário no `App.tsx`

**Files:**
- Modify: `src/App.tsx` (renderização do painel, bloco do `TENANT`; seção de memória criativa em torno da linha 692 e link de exclusão em torno da linha 820 do bloco do usuário)

**Interfaces:**
- Consumes: `UserLayout` (Task 7), `UserDashboard`, `AgendaView`, `PostsView` (Task 8), `MemoryView` (Task 9), `AccountView` (Task 10).
- Produces: nada novo exportado.

- [ ] **Step 1: Escolher a área pelo papel**

Quando `user.role === 'TENANT'` (e a conta já passou pela `WaitingRoom`), renderizar `UserLayout` com `view` em estado (`useState<UserView>('dashboard')`) e, conforme `view`, o componente correspondente. Passar `posts` já carregados pelo estado atual do `App`. Quando `user.role === 'ADMIN'`, manter o render atual sem alteração.

- [ ] **Step 2: Remover do bloco do usuário**

Retirar a seção "Memória Criativa Inteligente" e o link "Exclusão de Dados" apenas da visão do usuário. Não remover nada da visão do admin.

- [ ] **Step 3: Verificação**

Run: `npm run build`
Expected: "built in" sem erro.
Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: 111 (ou menos).
Manual: logar como usuário (aba anônima) e percorrer as cinco telas; logar como admin e confirmar que a tela não mudou.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: área do usuário no App, admin inalterado"
```

---

### Task 12: Verificação final

**Files:** nenhum.

- [ ] **Step 1: Testes unitários novos**

Run: `npx vitest run src/tests/accountDeletion.test.ts src/utils/userDashboard.test.ts src/utils/agendaGrid.test.ts`
Expected: PASS em todos.

- [ ] **Step 2: Build e tipos**

Run: `npm run build` e `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: build sem erro; contagem de erros de TypeScript em 111 ou menos.

- [ ] **Step 3: Checklist manual (Review Focus)**

Verificar as cinco linhas de Review Focus no navegador, e ainda: a página pública `/exclusao-de-dados` não tem botão de exclusão; o login não tem aba de cadastro; o admin continua igual.

- [ ] **Step 4: Publicar**

Só depois do checklist: commit final se houver ajustes, e push para `origin main` apenas com aprovação explícita.

---

Plano salvo em `docs/superpowers/plans/2026-11-13-user-area-redesign.md`. Ele ainda não foi commitado.
