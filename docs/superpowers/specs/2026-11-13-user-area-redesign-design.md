# Redesign da área do usuário (Instagram) — ATO Social Hub

Data: 2026-11-13
Escopo: somente a área do usuário conectado pelo Instagram (TENANT) e o login. O painel do admin não muda neste ciclo.

## 1. Objetivo

- Login limpo, sem cadastro, com entrada principal pelo Instagram.
- Dashboard do usuário com visão organizada dos posts, incluindo agenda visual dos programados.
- Memória criativa (IA) em tela própria, fora do fluxo do dia a dia.
- Exclusão de dados: informação pública, ação só dentro da área logada.
- Visual mais limpo, mantendo a paleta atual (preto, verde `#10B981`).

## 2. Fora de escopo

- Painel do admin (`role === 'ADMIN'`): sem mudanças visuais neste ciclo.
- Mudanças no fluxo OAuth, na publicação e no agendador. São só consumidos.
- Remoção da conta no Instagram. A exclusão remove dados e tokens no app, não a conta da Meta.

## 3. Login (`src/components/LoginView.tsx`)

- Layout em duas colunas no desktop: à esquerda, marca e frase de efeito; à direita, o card de acesso. No celular, o card ocupa a tela e a marca fica acima.
- Ação principal: "Conectar com Instagram" (fluxo existente, sem mudança de lógica).
- Formulário de e-mail e senha continua existindo, mas recolhido sob "Acesso administrativo", para não ser a primeira opção.
- Remover a aba "Solicitar Cadastro" e todo o código de `handleSubmitRegister`, incluindo o uso de `api.register` nessa tela.
- Rodapé: links de Política de Privacidade e Termos (exigidos pela Meta). Remover o link "Exclusão de Dados" do login.

## 4. Dashboard do usuário (novo componente)

Layout com navegação lateral (desktop) e menu inferior (celular).

Navegação: Dashboard, Posts, Agenda, Memória criativa, Conta.

- **Dashboard:** cartões de resumo (agendados, publicados na semana, com falha) e a lista de próximos posts em ordem cronológica, cada um com miniatura, horário e status.
- **Agenda:** calendário mensal com os posts programados por dia. Cada item mostra miniatura e horário. Clicar abre o detalhe do post.
- **Posts:** lista filtrável por status (rascunho, agendado, publicado, falhou), reutilizando a lógica de `postHelpers` já existente.
- **Memória criativa:** tela própria com as observações do cliente (sugestões e regras da marca), usando os componentes e a API de `ClientObservationsView` já existentes, sem mudar o backend.
- **Conta:** dados da conta conectada, status do token, botão de reconectar e a seção de exclusão (seção 5).

Dados: reutilizar os endpoints e estados atuais de posts e agendamentos. Nenhum endpoint novo é necessário para esta fase, salvo se a agenda precisar de um filtro por intervalo de datas. Se precisar, será documentado no plano.

## 5. Exclusão de dados

- Página pública `/exclusao-de-dados` (`PublicLegalPage.tsx`): somente informação. Explica quais dados são guardados, como solicitar a exclusão e o prazo. Sem nenhum botão de ação.
- Dentro de "Conta": opção "Excluir minha conta", com confirmação por digitação do `@username`.
- Efeito da exclusão: remove dados do usuário e tokens do app, e desconecta a conta. Não remove a conta no Instagram.
- Registro de auditoria: o pedido fica registrado com data e usuário, antes da remoção.

## 6. Memória criativa (IA)

- Sai do painel principal e vira a tela "Memória criativa" do menu do usuário.
- Mantém a lógica atual: sugestão pontual, regra permanente, histórico e contexto consolidado enviado à IA.
- Nenhuma mudança na geração de conteúdo.

## 7. Visual

- Paleta: fundo `#0A0A0A`, cartões `#121212`, bordas `#242424`, destaque `#10B981`, texto `#FFFFFF` e secundário `#8E8E93`.
- Cartões com cantos de 12–16px, sombras sutis e espaçamento generoso.
- Tipografia: a fonte já em uso no projeto.
- Responsivo: no celular, sem rolagem horizontal, gutter lateral de 16px.

## 8. Tratamento de erros e estados

- Estados de carregamento e vazio em cada tela (ex.: "Nenhum post agendado").
- Falha ao carregar: mensagem com opção de tentar novamente, sem perder a navegação.
- Conta sem token válido: banner no topo com link para reconectar.

## 9. Testes

- Build sem erro e contagem de erros de TypeScript sem aumento em relação à linha de base (111).
- Teste manual: login pelo Instagram, navegação entre as cinco telas, agenda com posts de vários dias, exclusão com confirmação, página pública sem ações.
- Os testes automatizados atuais de OAuth e publicação já falham antes destas mudanças. Não serão usados como critério de aceite.

## 10. Riscos

- Regressão no fluxo de login: o fluxo de sessão não muda, mas a tela muda. Teste manual obrigatório após o deploy.
- Página pública de exclusão: precisa continuar acessível sem login para a Meta.
- Agenda com muitos posts: paginar ou limitar por mês.
