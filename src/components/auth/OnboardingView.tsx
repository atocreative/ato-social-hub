import React, { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { api } from '../../services/api.ts';
import type { AuthResponse } from '../../types/index.ts';
import { AuthShell, AuthError, authCardClass, authInputClass, authPrimaryButton } from './AuthShell.tsx';

interface OnboardingProps {
  step: 'workspace' | 'connect';
  user: AuthResponse['user'];
  onWorkspaceCreated: (res: AuthResponse) => void;
  onSkip: () => void;
  onLogout: () => void;
  onNavigateLegal?: (path: string) => void;
}

const STEPS = ['Conta', 'Espaço', 'Instagram'];

const Progress: React.FC<{ current: number }> = ({ current }) => (
  <ol aria-label="Etapas do cadastro" className="flex items-center gap-2 mb-6 text-[11px]">
    {STEPS.map((label, i) => {
      const done = i < current;
      const active = i === current;
      return (
        <li key={label} className="flex items-center gap-2 flex-1 min-w-0" aria-current={active ? 'step' : undefined}>
          <span
            className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center font-semibold ${
              done ? 'bg-[#10B981] text-[#0A0A0A]' : active ? 'border border-[#10B981] text-[#10B981]' : 'border border-[#2E2E2E] text-[#6B6B70]'
            }`}
          >
            {done ? <Check size={12} /> : i + 1}
          </span>
          <span className={`truncate ${active ? 'text-white' : 'text-[#6B6B70]'}`}>{label}</span>
        </li>
      );
    })}
  </ol>
);

export const OnboardingView: React.FC<OnboardingProps> = ({ step, user, onWorkspaceCreated, onSkip, onLogout, onNavigateLegal }) => {
  const firstName = (user.nome || '').split(' ')[0];
  const [companyName, setCompanyName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [differentName, setDifferentName] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  // Erro vindo da janela da Meta (ex.: conta sem permissão enquanto o app está em análise).
  useEffect(() => {
    if (step !== 'connect') return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'INSTAGRAM_AUTH_ERROR') {
        setError(event.data.message || 'Não foi possível concluir a conexão. Tente novamente.');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [step]);

  const createWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.createWorkspace({ companyName: companyName.trim(), workspaceName: differentName ? workspaceName.trim() : undefined });
      onWorkspaceCreated(res);
    } catch (err: any) {
      setError(err.message || 'Não foi possível criar o espaço de trabalho. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const connect = async () => {
    setError(null);
    setOpening(true);
    try {
      const { url } = await api.getInstagramAuthUrl();
      if (!url) throw new Error('Não foi possível obter a autorização da Meta. Tente novamente.');
      window.open(url, 'InstagramOAuthWindow', 'width=560,height=680,status=no,resizable=yes,scrollbars=yes');
    } catch (err: any) {
      setError(err.message || 'Não foi possível iniciar a conexão.');
    } finally {
      setOpening(false);
    }
  };

  return (
    <AuthShell onNavigateLegal={onNavigateLegal}>
      <div className={authCardClass}>
        <Progress current={step === 'workspace' ? 1 : 2} />

        {step === 'workspace' && (
          <>
            <h2 className="text-xl font-semibold">{firstName ? `Olá, ${firstName}! ` : ''}Vamos criar seu espaço</h2>
            <p className="text-sm text-[#8E8E93] mt-1 mb-5 leading-relaxed">É onde ficam seus conteúdos. Ele é privado: só você e quem você convidar terão acesso.</p>
            <AuthError message={error} />
            <form onSubmit={createWorkspace} className="space-y-4">
              <div>
                <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="ws-company">Nome da empresa ou marca</label>
                <input id="ws-company" type="text" required minLength={2} maxLength={120} value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Ex.: Padaria Bom Pão" className={authInputClass} />
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-[#8E8E93]">
                <input type="checkbox" checked={differentName} onChange={(e) => setDifferentName(e.target.checked)} className="w-3.5 h-3.5 rounded accent-[#10B981] cursor-pointer" />
                <span>O nome do espaço de trabalho é diferente</span>
              </label>
              {differentName && (
                <div>
                  <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="ws-name">Nome do espaço de trabalho</label>
                  <input id="ws-name" type="text" required maxLength={120} value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} className={authInputClass} />
                </div>
              )}
              <button type="submit" disabled={loading} className={authPrimaryButton}>
                {loading ? 'Criando...' : 'Continuar'}
              </button>
            </form>
          </>
        )}

        {step === 'connect' && (
          <>
            <h2 className="text-xl font-semibold">Conecte seu Instagram</h2>
            <p className="text-sm text-[#8E8E93] mt-1 mb-5 leading-relaxed">
              Conecte uma conta profissional para organizar, agendar e publicar seus conteúdos diretamente pelo ATO Social Hub.
            </p>
            <AuthError message={error} />
            <button type="button" onClick={connect} disabled={opening} className={authPrimaryButton}>
              {opening ? 'Abrindo...' : 'Conectar Instagram'}
            </button>
            <button type="button" onClick={onSkip} className="w-full mt-2 py-2.5 text-sm text-[#C8C8CC] hover:text-white border border-[#242424] hover:border-[#3A3A3C] rounded-lg cursor-pointer transition-colors">
              Fazer isso depois
            </button>
            <ul className="mt-5 space-y-1.5 text-xs text-[#8E8E93] leading-relaxed list-disc pl-4">
              <li>A conexão é feita na janela oficial da Meta. O ATO Social Hub nunca pede a senha do seu Instagram.</li>
              <li>Pedimos acesso ao perfil básico e à publicação, usados só para identificar a conta e publicar o que você aprovar.</li>
              <li>Enquanto o aplicativo está em análise pela Meta, a conta precisa estar autorizada como testadora. Se aparecer um erro de permissão, fale com o suporte.</li>
            </ul>
          </>
        )}

        <div className="mt-6 pt-4 border-t border-[#1C1C1C] text-center">
          <button type="button" onClick={onLogout} className="text-xs text-[#6B6B70] hover:text-white cursor-pointer">
            Sair
          </button>
        </div>
      </div>
    </AuthShell>
  );
};
