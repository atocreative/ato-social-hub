import React, { useState } from 'react';
import { Shield, FileText, Trash2, ArrowLeft, CheckCircle2, Mail } from 'lucide-react';

export type LegalRoute = '/privacidade' | '/termos' | '/exclusao-de-dados';

interface PublicLegalPageProps {
  route: LegalRoute;
  onNavigate: (path: string) => void;
}

export const PublicLegalPage: React.FC<PublicLegalPageProps> = ({ route, onNavigate }) => {
  const [deletionIdentifier, setDeletionIdentifier] = useState('');
  const [deletionStatus, setDeletionStatus] = useState<{
    type: 'success' | 'info' | 'error';
    message: string;
    confirmationCode?: string;
  } | null>(null);
  const [submittingDeletion, setSubmittingDeletion] = useState(false);

  const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>, path: string) => {
    e.preventDefault();
    onNavigate(path);
  };

  const handleRequestDeletion = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = deletionIdentifier.trim().replace(/^@/, '');
    if (!clean) return;

    setSubmittingDeletion(true);
    setDeletionStatus(null);
    try {
      const resp = await fetch('/api/public/data-deletion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: clean }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        setDeletionStatus({
          type: 'success',
          message:
            data.message ||
            `Solicitação concluída. Todos os tokens, histórico e vínculos da conta @${clean} foram removidos do banco de dados.`,
          confirmationCode: data.confirmationCode,
        });
        setDeletionIdentifier('');
      } else {
        setDeletionStatus({
          type: 'error',
          message: data.error || 'Não foi possível processar a solicitação no momento.',
        });
      }
    } catch {
      setDeletionStatus({
        type: 'error',
        message: 'Erro de conexão ao processar a exclusão.',
      });
    } finally {
      setSubmittingDeletion(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#FFFFFF] flex flex-col font-sans antialiased">
      {/* Top Header */}
      <header className="border-b border-[#242424] bg-[#0E0E0E]">
        <div className="max-w-4xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <a
              href="/"
              onClick={(e) => handleLinkClick(e, '/')}
              className="text-xl font-bold tracking-tight text-white font-mono hover:opacity-90 transition-opacity"
            >
              ATO<span className="text-[#10B981]">.</span>
            </a>
            <span className="text-xs text-[#8E8E93] border-l border-[#242424] pl-3">
              ATO Social Hub · Central Legal & Conformidade Meta
            </span>
          </div>

          <a
            href="/"
            onClick={(e) => handleLinkClick(e, '/')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#161616] hover:bg-[#1F1F1F] border border-[#2A2A2A] text-xs font-medium text-white transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5 text-[#10B981]" />
            <span>Voltar ao Login</span>
          </a>
        </div>
      </header>

      {/* Navigation Tabs between Public Legal Pages */}
      <div className="border-b border-[#1E1E1E] bg-[#0A0A0A]">
        <div className="max-w-4xl mx-auto px-6 flex flex-wrap gap-2 py-3">
          <a
            href="/privacidade"
            onClick={(e) => handleLinkClick(e, '/privacidade')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors ${
              route === '/privacidade'
                ? 'bg-[#10B981] text-[#0A0A0A] font-semibold'
                : 'bg-[#121212] text-[#8E8E93] hover:text-white border border-[#242424]'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            <span>Política de Privacidade</span>
          </a>

          <a
            href="/termos"
            onClick={(e) => handleLinkClick(e, '/termos')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors ${
              route === '/termos'
                ? 'bg-[#10B981] text-[#0A0A0A] font-semibold'
                : 'bg-[#121212] text-[#8E8E93] hover:text-white border border-[#242424]'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Termos de Uso</span>
          </a>

          <a
            href="/exclusao-de-dados"
            onClick={(e) => handleLinkClick(e, '/exclusao-de-dados')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors ${
              route === '/exclusao-de-dados'
                ? 'bg-[#10B981] text-[#0A0A0A] font-semibold'
                : 'bg-[#121212] text-[#8E8E93] hover:text-white border border-[#242424]'
            }`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Exclusão de Dados</span>
          </a>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-10">
        {route === '/privacidade' && (
          <article className="bg-[#121212] border border-[#242424] rounded-2xl p-6 sm:p-8 space-y-6 shadow-xl">
            <div className="border-b border-[#242424] pb-5">
              <span className="text-xs font-mono uppercase tracking-wider text-[#10B981]">
                Documento Público Oficial · Meta App Review
              </span>
              <h1 className="text-2xl font-bold text-white mt-1">
                Política de Privacidade — ATO Social Hub
              </h1>
              <p className="text-xs text-[#8E8E93] mt-1">
                Última atualização: 25 de outubro de 2026 · Vigência imediata
              </p>
            </div>

            <section className="space-y-3 text-sm text-[#D1D1D6] leading-relaxed">
              <h2 className="text-base font-semibold text-white">1. Introdução e Escopo</h2>
              <p>
                O <strong>ATO Social Hub</strong> valoriza a privacidade, a transparência e a segurança dos dados
                de seus usuários e clientes corporativos. Esta Política de Privacidade descreve de forma clara
                quais dados coletamos através da integração oficial com a API do Instagram (Meta Platforms, Inc.),
                como utilizamos e protegemos essas informações, e como você pode exercer seus direitos de acesso,
                revogação e exclusão total a qualquer momento.
              </p>
            </section>

            <section className="space-y-3 text-sm text-[#D1D1D6] leading-relaxed">
              <h2 className="text-base font-semibold text-white">
                2. Dados Coletados via API do Instagram
              </h2>
              <p>
                Ao se autenticar voluntariamente através do fluxo oficial OAuth 2.0 do Instagram
                (&ldquo;Continuar com o Instagram&rdquo;), o ATO Social Hub solicita apenas os escopos estritamente
                necessários (<code className="font-mono text-xs text-[#10B981]">instagram_business_basic</code> e{' '}
                <code className="font-mono text-xs text-[#10B981]">instagram_business_content_publish</code>) e
                coleta exclusivamente os seguintes dados da sua conta profissional do Instagram:
              </p>
              <ul className="list-disc pl-5 space-y-2 text-[#C7C7CC]">
                <li>
                  <strong>ID da Conta do Instagram (<code className="font-mono text-xs">id</code> / <code className="font-mono text-xs">user_id</code>):</strong>{' '}
                  identificador numérico único fornecido pela Meta para vincular sua conta empresarial ao seu
                  espaço de trabalho no portal.
                </li>
                <li>
                  <strong>Nome de Usuário (<code className="font-mono text-xs">@username</code>):</strong> utilizado
                  para identificação visual da conta conectada no painel de aprovação e nas publicações.
                </li>
                <li>
                  <strong>Nome de Exibição (<code className="font-mono text-xs">name</code>) e Tipo de Conta (<code className="font-mono text-xs">account_type</code>):</strong>{' '}
                  utilizados para personalizar o cabeçalho do cliente e validar a compatibilidade com recursos de
                  publicação Business/Creator.
                </li>
                <li>
                  <strong>Foto de Perfil (<code className="font-mono text-xs">profile_picture_url</code>):</strong>{' '}
                  exibida exclusivamente na interface do painel para identificar a conta autenticada.
                </li>
                <li>
                  <strong>Token de Acesso OAuth e Permissão de Publicação de Mídia:</strong> credencial segura
                  emitida pela Meta para permitir a publicação de posts únicos, carrosséis e stories expressamente
                  aprovados pelo usuário.
                </li>
              </ul>
            </section>

            <section className="space-y-3 text-sm text-[#D1D1D6] leading-relaxed">
              <h2 className="text-base font-semibold text-white">3. Finalidade e Uso dos Dados</h2>
              <p>
                Os dados coletados via API do Instagram são utilizados <strong>exclusivamente</strong> para:
              </p>
              <ul className="list-disc pl-5 space-y-2 text-[#C7C7CC]">
                <li>
                  Autenticar o usuário de forma segura e vincular sua conta do Instagram aos criativos e pastas de
                  mídia correspondentes no ATO Social Hub;
                </li>
                <li>
                  Permitir a visualização, revisão, aprovação ou reprovação de conteúdos (imagens, vídeos,
                  carrosséis e legendas) antes da publicação;
                </li>
                <li>
                  Realizar a publicação imediata ou agendada no Instagram de mídias que tenham sido
                  <strong> expressamente aprovadas e autorizadas pelo próprio usuário</strong> dentro da plataforma.
                </li>
              </ul>
              <p>
                O ATO Social Hub <strong>jamais publica qualquer conteúdo sem a ação explícita do usuário</strong>{' '}
                no botão de aprovação/publicação.
              </p>
            </section>

            <section className="space-y-3 text-sm text-[#D1D1D6] leading-relaxed">
              <h2 className="text-base font-semibold text-white">
                4. Compartilhamento de Dados e Proibição de Venda a Terceiros
              </h2>
              <div className="p-4 rounded-xl bg-[#0A0A0A] border border-[#242424] text-xs text-[#E5E5EA] leading-relaxed">
                <strong>Compromisso de Não Comercialização:</strong> Nós <strong>NÃO vendemos, alugamos,
                comercializamos nem compartilhamos</strong> seus dados pessoais, tokens de acesso ou informações da
                sua conta do Instagram com terceiros, anunciantes ou corretores de dados sob nenhuma circunstância.
              </div>
              <p>
                A transmissão de dados ocorre unicamente entre o servidor seguro do ATO Social Hub e os endpoints
                oficiais da API do Instagram (<code className="font-mono text-xs">api.instagram.com</code> e{' '}
                <code className="font-mono text-xs">graph.instagram.com</code>) para executar as ações solicitadas
                pelo titular da conta.
              </p>
            </section>

            <section className="space-y-3 text-sm text-[#D1D1D6] leading-relaxed">
              <h2 className="text-base font-semibold text-white">
                5. Armazenamento, Segurança e Retenção
              </h2>
              <p>
                Os tokens de acesso e metadados básicos da conta são armazenados de forma isolada por cliente
                (arquitetura multi-tenant) e mantidos apenas enquanto a conta permanecer ativa na plataforma. Caso
                o usuário revogue o acesso ou solicite a exclusão de dados (disponível em{' '}
                <a
                  href="/exclusao-de-dados"
                  onClick={(e) => handleLinkClick(e, '/exclusao-de-dados')}
                  className="text-[#10B981] hover:underline"
                >
                  /exclusao-de-dados
                </a>
                ), todos os tokens e registros vinculados são removidos imediatamente.
              </p>
            </section>

            <section className="space-y-3 text-sm text-[#D1D1D6] leading-relaxed">
              <h2 className="text-base font-semibold text-white">
                6. Contato do Encarregado de Dados (DPO) e Suporte
              </h2>
              <p>
                Para dúvidas sobre esta Política de Privacidade, solicitações de titularidade ou suporte técnico
                relacionado à proteção de dados no ATO Social Hub, entre em contato diretamente com nosso
                Encarregado de Proteção de Dados (DPO) / Suporte ATO:
              </p>
              <div className="p-4 rounded-xl bg-[#0A0A0A] border border-[#242424] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Mail className="w-4 h-4 text-[#10B981]" />
                  <span className="text-xs font-mono text-white">xgamer1699@gmail.com</span>
                </div>
                <span className="text-xs text-[#8E8E93]">
                  Suporte ATO Social Hub · Atendimento em até 24h úteis
                </span>
              </div>
            </section>
          </article>
        )}

        {route === '/termos' && (
          <article className="bg-[#121212] border border-[#242424] rounded-2xl p-6 sm:p-8 space-y-6 shadow-xl">
            <div className="border-b border-[#242424] pb-5">
              <span className="text-xs font-mono uppercase tracking-wider text-[#10B981]">
                Documento Público Oficial · Meta App Review
              </span>
              <h1 className="text-2xl font-bold text-white mt-1">
                Termos de Uso e Serviço — ATO Social Hub
              </h1>
              <p className="text-xs text-[#8E8E93] mt-1">
                Última atualização: 25 de outubro de 2026 · Condições Gerais da Plataforma
              </p>
            </div>

            <section className="space-y-3 text-sm text-[#D1D1D6] leading-relaxed">
              <h2 className="text-base font-semibold text-white">1. Aceitação dos Termos</h2>
              <p>
                Ao acessar e utilizar o <strong>ATO Social Hub</strong>, você concorda integralmente com estes
                Termos de Uso. O ATO Social Hub é uma plataforma corporativa de gestão, revisão, aprovação de
                criativos e publicação automatizada em contas profissionais do Instagram mediante autorização OAuth
                do titular da conta.
              </p>
            </section>

            <section className="space-y-3 text-sm text-[#D1D1D6] leading-relaxed">
              <h2 className="text-base font-semibold text-white">2. Regras de Uso da Plataforma</h2>
              <ul className="list-disc pl-5 space-y-2 text-[#C7C7CC]">
                <li>
                  Para utilizar os recursos de publicação direta no Instagram, o usuário deve possuir uma conta
                  Instagram Business ou Creator válida e autenticá-la através do login oficial do Instagram;
                </li>
                <li>
                  Cada conta cliente autenticada possui acesso restrito exclusivamente às mídias e pastas vinculadas
                  à sua respectiva empresa após validação administrativa;
                </li>
                <li>
                  É proibido utilizar a plataforma para envio de spam, automações não autorizadas, violação de
                  direitos autorais de terceiros ou qualquer atividade ilícita.
                </li>
              </ul>
            </section>

            <section className="space-y-3 text-sm text-[#D1D1D6] leading-relaxed">
              <h2 className="text-base font-semibold text-white">
                3. Responsabilidades do Usuário sobre Conteúdos Aprovados e Publicados
              </h2>
              <p>
                O usuário detém controle total sobre a revisão e aprovação final de cada criativo (imagem única,
                carrossel ou story) e de sua respectiva legenda antes do envio para o Instagram:
              </p>
              <ul className="list-disc pl-5 space-y-2 text-[#C7C7CC]">
                <li>
                  O usuário é integralmente responsável pela legalidade, veracidade, direitos de imagem, direitos
                  autorais e adequação de todos os textos, fotos e vídeos que aprovar e publicar em seu perfil do
                  Instagram através do ATO Social Hub;
                </li>
                <li>
                  A publicação na Graph API do Instagram ocorre somente mediante acionamento expresso pelo usuário
                  autenticado ou conforme agendamento confirmado por ele no painel.
                </li>
              </ul>
            </section>

            <section className="space-y-3 text-sm text-[#D1D1D6] leading-relaxed">
              <h2 className="text-base font-semibold text-white">
                4. Conformidade com as Diretrizes da Meta Platforms
              </h2>
              <p>
                O uso do ATO Social Hub está sujeito e opera em estrita conformidade com as políticas oficiais da
                Meta Platforms, Inc., incluindo:
              </p>
              <ul className="list-disc pl-5 space-y-2 text-[#C7C7CC]">
                <li>Termos de Uso do Instagram e Diretrizes da Comunidade do Instagram;</li>
                <li>Termos da Plataforma da Meta e Políticas do Desenvolvedor da Meta;</li>
                <li>
                  Respeito aos limites de taxa (rate limits) e uso exclusivo dos escopos autorizados pelo usuário
                  durante o fluxo OAuth (<code className="font-mono text-xs text-[#10B981]">instagram_business_basic</code> e{' '}
                  <code className="font-mono text-xs text-[#10B981]">instagram_business_content_publish</code>).
                </li>
              </ul>
            </section>

            <section className="space-y-3 text-sm text-[#D1D1D6] leading-relaxed">
              <h2 className="text-base font-semibold text-white">
                5. Rescisão, Revogação de Acesso e Suporte
              </h2>
              <p>
                O usuário pode encerrar o uso da plataforma e revogar as permissões concedidas ao aplicativo a
                qualquer momento, conforme detalhado na página pública de{' '}
                <a
                  href="/exclusao-de-dados"
                  onClick={(e) => handleLinkClick(e, '/exclusao-de-dados')}
                  className="text-[#10B981] hover:underline"
                >
                  Instruções de Exclusão de Dados
                </a>
                . Para suporte ou esclarecimentos contratuais, contate{' '}
                <span className="font-mono text-xs text-white">xgamer1699@gmail.com</span>.
              </p>
            </section>
          </article>
        )}

        {route === '/exclusao-de-dados' && (
          <article className="bg-[#121212] border border-[#242424] rounded-2xl p-6 sm:p-8 space-y-6 shadow-xl">
            <div className="border-b border-[#242424] pb-5">
              <span className="text-xs font-mono uppercase tracking-wider text-[#10B981]">
                Exigência Oficial da Meta · User Data Deletion Instructions
              </span>
              <h1 className="text-2xl font-bold text-white mt-1">
                Instruções de Exclusão de Dados do Usuário — ATO Social Hub
              </h1>
              <p className="text-xs text-[#8E8E93] mt-1">
                Procedimento público passo a passo para revogação de acesso e exclusão imediata de dados
              </p>
            </div>

            <section className="space-y-3 text-sm text-[#D1D1D6] leading-relaxed">
              <p>
                Em conformidade com as diretrizes da <strong>Meta Platforms, Inc.</strong>, o{' '}
                <strong>ATO Social Hub</strong> garante a todos os usuários o controle integral sobre seus dados
                vinculados ao Instagram, oferecendo três formas diretas e gratuitas para revogar permissões e
                excluir imediatamente todos os tokens de acesso, histórico de conta e mídias armazenadas em nosso
                banco de dados.
              </p>
            </section>

            {/* Passo 1: Revogar pelo próprio Instagram */}
            <section className="p-5 rounded-xl bg-[#0A0A0A] border border-[#242424] space-y-3">
              <h2 className="text-base font-semibold text-white">
                Opção 1: Revogar o Acesso Diretamente pelo Aplicativo ou Site do Instagram
              </h2>
              <p className="text-xs text-[#8E8E93]">
                Você pode desconectar o aplicativo ATO Social Hub a qualquer momento nas configurações da sua conta
                do Instagram seguindo o passo a passo abaixo:
              </p>
              <ol className="list-decimal pl-5 space-y-2 text-sm text-[#D1D1D6]">
                <li>Acesse sua conta no aplicativo ou site oficial do <strong>Instagram</strong>;</li>
                <li>
                  Vá em <strong>Configurações e atividade</strong> (ou <strong>Configurações</strong> no menu do seu
                  perfil);
                </li>
                <li>
                  Acesse <strong>Segurança</strong> (ou <strong> Permissões do site</strong>) &gt;{' '}
                  <strong>Apps e sites</strong>;
                </li>
                <li>
                  Na aba de aplicativos ativos, localize <strong>ATO Social Hub</strong>;
                </li>
                <li>
                  Clique em <strong>Remover</strong> e confirme a revogação de acesso.
                </li>
              </ol>
            </section>

            {/* Passo 2: Exclusão Imediata no Painel / Formulário Automático */}
            <section className="p-5 rounded-xl bg-[#0A0A0A] border border-[#242424] space-y-4">
              <div>
                <h2 className="text-base font-semibold text-white">
                  Opção 2: Exclusão Total Imediata pelo Painel ou Formulário Direto
                </h2>
                <p className="text-xs text-[#8E8E93] mt-1">
                  No painel do ATO Social Hub, você pode utilizar o botão de exclusão da conta ou informar seu{' '}
                  <code className="font-mono text-[#10B981]">@username</code> ou ID do Instagram abaixo para apagar
                  imediatamente seus tokens OAuth, cadastro e histórico do nosso banco de dados:
                </p>
              </div>

              <form onSubmit={handleRequestDeletion} className="flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  required
                  value={deletionIdentifier}
                  onChange={(e) => setDeletionIdentifier(e.target.value)}
                  placeholder="Digite seu @username ou ID da conta do Instagram"
                  className="flex-1 bg-[#121212] border border-[#2A2A2A] focus:border-[#10B981] rounded-lg px-3.5 py-2.5 text-xs text-white placeholder-[#5E5E62] outline-none"
                />
                <button
                  type="submit"
                  disabled={submittingDeletion}
                  className="px-4 py-2.5 bg-[#EF4444] hover:bg-[#DC2626] text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
                >
                  {submittingDeletion ? 'Excluindo Dados...' : 'Excluir Meus Dados Agora'}
                </button>
              </form>

              {deletionStatus && (
                <div
                  className={`p-3.5 rounded-lg border text-xs flex items-start gap-2.5 ${
                    deletionStatus.type === 'success'
                      ? 'bg-[#10B981]/10 border-[#10B981]/40 text-[#10B981]'
                      : 'bg-red-950/30 border-[#EF4444]/40 text-[#EF4444]'
                  }`}
                >
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p>{deletionStatus.message}</p>
                    {deletionStatus.confirmationCode && (
                      <p className="font-mono text-[11px] text-white">
                        Código de Confirmação de Exclusão: {deletionStatus.confirmationCode}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </section>

            {/* Passo 3: Solicitação via E-mail */}
            <section className="p-5 rounded-xl bg-[#0A0A0A] border border-[#242424] space-y-3">
              <h2 className="text-base font-semibold text-white">
                Opção 3: Solicitação Direta por E-mail ao Encarregado de Dados
              </h2>
              <p className="text-sm text-[#D1D1D6] leading-relaxed">
                Caso prefira, você também pode solicitar a exclusão total imediata de seus tokens, histórico e
                mídias enviando um e-mail para nosso canal de privacidade e suporte:
              </p>
              <div className="p-3.5 rounded-lg bg-[#121212] border border-[#2A2A2A] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-[#10B981]" />
                  <span className="text-xs font-mono text-white">xgamer1699@gmail.com</span>
                </div>
                <span className="text-xs text-[#8E8E93]">
                  Assunto sugerido: &ldquo;Exclusão de Dados - @seu_usuario&rdquo;
                </span>
              </div>
              <p className="text-xs text-[#8E8E93]">
                Ao receber a solicitação, removemos integralmente qualquer token OAuth, identificador de conta,
                histórico de aprovação e arquivos associados ao seu perfil em até 24 horas úteis.
              </p>
            </section>
          </article>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[#242424] py-6 px-6 text-xs text-[#8E8E93]">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <span className="font-mono text-white font-semibold">ATO.</span> · ATO Social Hub
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <a
              href="/privacidade"
              onClick={(e) => handleLinkClick(e, '/privacidade')}
              className="hover:text-white transition-colors"
            >
              Política de Privacidade
            </a>
            <span>·</span>
            <a
              href="/termos"
              onClick={(e) => handleLinkClick(e, '/termos')}
              className="hover:text-white transition-colors"
            >
              Termos de Uso
            </a>
            <span>·</span>
            <a
              href="/exclusao-de-dados"
              onClick={(e) => handleLinkClick(e, '/exclusao-de-dados')}
              className="hover:text-white transition-colors"
            >
              Exclusão de Dados
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
};
