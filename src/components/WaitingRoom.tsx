import React, { useState, useEffect } from 'react';
import { UserProfile } from '../types/index.ts';
import { api, authStorage } from '../services/api.ts';
import { Clock } from 'lucide-react';

interface WaitingRoomProps {
  user: UserProfile;
  onLogout: () => void;
  onStatusApproved: (user: UserProfile) => void;
}

export const WaitingRoom: React.FC<WaitingRoomProps> = ({
  user,
  onLogout,
  onStatusApproved,
}) => {
  const [checking, setChecking] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  const isPlaceholderHandle =
    !user.instagramUsername ||
    user.instagramUsername.startsWith('cadastro_') ||
    user.connectionStatus === 'DESCONECTADO';
  const displayGreeting = isPlaceholderHandle
    ? user.nome || user.email || 'cliente'
    : `@${user.instagramUsername}`;

  // Garante que a conta autenticada esteja sincronizada caso tenha vindo de OAuth
  useEffect(() => {
    const cleanUser = String(user.instagramUsername || '')
      .replace(/^@/, '')
      .trim()
      .toLowerCase();
    const cleanNome = String(user.nome || '').trim().toLowerCase();
    if (cleanUser === 'caiorocha' || cleanNome === 'caio rocha') {
      localStorage.clear();
      sessionStorage.clear();
      authStorage.clearSession();
      onLogout();
      return;
    }
    if (!isPlaceholderHandle) {
      api.syncInstagramSession({ user }).catch(() => {});
    }
  }, [user, onLogout, isPlaceholderHandle]);

  const handleCheckStatus = async () => {
    setChecking(true);
    setFeedbackMessage(null);
    try {
      const res = await api.getMe();
      if (res.user) {
        if (res.user.status === 'APROVADO' && res.user.driveFolderName) {
          if (res.token) {
            authStorage.setSession(res.token, res.user);
          }
          setFeedbackMessage('Conta aprovada. Redirecionando...');
          setTimeout(() => {
            onStatusApproved(res.user);
          }, 800);
        } else {
          setFeedbackMessage('Aprovação ainda pendente. Aguarde o administrador.');
        }
      }
    } catch (err: any) {
      if (err?.message?.includes('401') || err?.message?.includes('Sessão')) {
        localStorage.clear();
        sessionStorage.clear();
        authStorage.clearSession();
        onLogout();
        return;
      }
      setFeedbackMessage('Não foi possível atualizar o status no momento.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A] flex flex-col items-center justify-center p-6 text-[#FFFFFF] font-sans">
      <div className="w-full max-w-[420px]">
        {/* Brand Header */}
        <div className="flex flex-col items-center mb-8">
          <span className="text-2xl font-bold tracking-tight text-white font-mono">
            ATO<span className="text-[#10B981]">.</span>
          </span>
        </div>

        {/* Card */}
        <div className="bg-[#121212] border border-[#242424] rounded-2xl p-7 text-center shadow-xl">
          <div className="w-12 h-12 rounded-xl bg-[#1A1A1A] border border-[#2A2A2A] text-[#F59E0B] flex items-center justify-center mx-auto mb-5">
            <Clock className="w-6 h-6" />
          </div>

          <h1 className="text-xl font-bold text-white mb-2">
            Olá, {displayGreeting}!
          </h1>

          <p className="text-xs text-[#8E8E93] leading-relaxed mb-6">
            {isPlaceholderHandle
              ? 'Seu cadastro no ATO Social Hub foi recebido e está na fila de aprovação administrativa. Assim que o administrador aprovar seu acesso, você poderá visualizar seus conteúdos e conectar sua conta profissional do Instagram.'
              : 'Sua solicitação foi recebida. Aguarde a aprovação de um administrador para liberar as mídias da sua empresa.'}
          </p>

          {feedbackMessage && (
            <div className="mb-5 p-2.5 bg-[#181818] border border-[#2A2A2A] rounded-lg text-xs text-[#8E8E93]">
              {feedbackMessage}
            </div>
          )}

          <div className="space-y-2.5">
            <button
              type="button"
              onClick={handleCheckStatus}
              disabled={checking}
              className="w-full py-2.5 px-4 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-xs rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              {checking ? 'Verificando...' : 'Atualizar status'}
            </button>

            <button
              type="button"
              onClick={() => {
                localStorage.clear();
                sessionStorage.clear();
                authStorage.clearSession();
                onLogout();
              }}
              className="w-full py-2.5 px-4 bg-transparent hover:bg-[#1A1A1A] border border-[#242424] text-[#8E8E93] hover:text-white text-xs font-medium rounded-lg transition-colors cursor-pointer"
            >
              Sair
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
