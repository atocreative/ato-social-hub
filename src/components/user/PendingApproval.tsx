import React, { useCallback, useEffect, useState } from 'react';
import type { AuthResponse } from '../../types/index.ts';
import { api, authStorage } from '../../services/api.ts';

type User = AuthResponse['user'];

// Usuário com cadastro confirmado que ainda não foi aprovado (ou foi rejeitado). Vê o próprio dashboard inicial,
// pode conectar o Instagram e sair. Nenhum dado de empresa existe aqui: o backend nem entrega.

const STATUS_COPY: Record<string, { title: string; text: string }> = {
  PENDING_APPROVAL: {
    title: 'Aguardando aprovação do administrador',
    text: 'Seu e-mail foi confirmado. Assim que o administrador liberar seu acesso e vincular você a uma empresa, Posts, Agenda, Histórico e Mídias aparecem aqui automaticamente.',
  },
  REJECTED: {
    title: 'Cadastro não aprovado',
    text: 'O administrador não liberou este cadastro. Se você acredita que foi um engano, fale com a equipe da ATO.',
  },
};

export const PendingBlock: React.FC<{ status?: string }> = ({ status }) => {
  const copy = STATUS_COPY[status || 'PENDING_APPROVAL'] || STATUS_COPY.PENDING_APPROVAL;
  return (
    <div role="status" className="text-center bg-[#121212] border border-[#242424] rounded-2xl p-8">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#F59E0B]/10 text-[#F59E0B] text-xl" aria-hidden="true">⏳</div>
      <h2 className="text-lg font-semibold text-white">{copy.title}</h2>
      <p className="text-sm text-[#8E8E93] mt-2 leading-relaxed">{copy.text}</p>
    </div>
  );
};

export const PendingDashboard: React.FC<{ user: User; onApproved: (u: User) => void; onSessionLost: () => void }> = ({ user, onApproved, onSessionLost }) => {
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [profile, setProfile] = useState<User>(user);
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(
    async (manual = false) => {
      if (manual) {
        setChecking(true);
        setMsg(null);
      }
      try {
        const res = await api.getMe();
        if (res.token && res.user) authStorage.setSession(res.token, res.user);
        if (res.user?.accessStatus === 'ACTIVE') {
          onApproved(res.user);
          return;
        }
        if (res.user) setProfile(res.user);
        if (manual) setMsg('Ainda aguardando a aprovação do administrador.');
      } catch (err: any) {
        if (err?.status === 401 || err?.code === 'ACCOUNT_SUSPENDED') {
          authStorage.clearSession();
          onSessionLost();
          return;
        }
        if (manual) setMsg(err?.message || 'Não foi possível verificar agora.');
      } finally {
        if (manual) setChecking(false);
      }
    },
    [onApproved, onSessionLost]
  );

  // Verifica ao abrir, ao voltar para a aba, quando o popup do Instagram termina e a cada 30 s enquanto a aba está visível.
  useEffect(() => {
    void refresh();
    const onFocus = () => document.visibilityState === 'visible' && void refresh();
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'INSTAGRAM_AUTH_SUCCESS') void refresh();
    };
    const timer = window.setInterval(onFocus, 30000);
    window.addEventListener('focus', onFocus);
    window.addEventListener('message', onMessage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('message', onMessage);
    };
  }, [refresh]);

  const connectInstagram = async () => {
    setMsg(null);
    setConnecting(true);
    try {
      const { url } = await api.getInstagramAuthUrl();
      if (!url) throw new Error('Não foi possível obter a URL de autorização da Meta.');
      window.open(url, 'InstagramOAuthWindow', 'width=560,height=680,status=no,resizable=yes,scrollbars=yes');
    } catch (err: any) {
      setMsg(err?.message || 'Não foi possível iniciar a conexão.');
    } finally {
      setConnecting(false);
    }
  };

  const ig = profile.personalInstagram;
  return (
    <div className="max-w-2xl space-y-5">
      <PendingBlock status={profile.accessStatus} />
      <section className="bg-[#121212] border border-[#242424] rounded-2xl p-6" aria-label="Seu Instagram">
        <h3 className="text-sm font-semibold text-white">Seu Instagram profissional</h3>
        {ig?.username ? (
          <p className="text-sm text-[#C8C8CC] mt-2">
            Conectado como <strong className="text-white">@{ig.username}</strong>. Essa conexão é sua: ela não dá acesso a nenhuma empresa e não substitui a conta de ninguém.
          </p>
        ) : (
          <p className="text-sm text-[#8E8E93] mt-2">Você pode conectar agora ou depois. A conexão é oficial pela Meta (não pedimos sua senha) e não libera acesso a dados de empresa.</p>
        )}
        <div className="flex flex-wrap items-center gap-3 mt-4">
          <button type="button" onClick={connectInstagram} disabled={connecting || profile.accessStatus === 'REJECTED'}
            className="px-4 py-2 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold rounded-lg text-sm cursor-pointer disabled:opacity-50">
            {ig?.username ? 'Reconectar Instagram' : 'Conectar Instagram'}
          </button>
          <button type="button" onClick={() => void refresh(true)} disabled={checking}
            className="px-4 py-2 bg-[#161616] hover:bg-[#1F1F1F] text-white border border-[#2A2A2A] rounded-lg text-sm cursor-pointer disabled:opacity-50">
            {checking ? 'Verificando…' : 'Verificar aprovação'}
          </button>
        </div>
        {msg && <p role="status" className="text-xs text-[#8E8E93] mt-3">{msg}</p>}
      </section>
    </div>
  );
};
