import React, { useState } from 'react';
import type { AuthResponse } from '../../types/index.ts';
import { api } from '../../services/api.ts';
import { normalizeUsername } from '../../services/accountDeletion.ts';

interface AccountViewProps {
  user: AuthResponse['user'];
  onAccountDeleted: () => void;
}

export const AccountView: React.FC<AccountViewProps> = ({ user, onAccountDeleted }) => {
  const rawUsername = (user.instagramUsername || '').replace(/^@/, '');
  // Conta sem vínculo: cadastro ainda sem Instagram (nome provisório) ou marcada como desconectada.
  const isLinked =
    Boolean(rawUsername) && !rawUsername.toLowerCase().startsWith('cadastro_') && user.connectionStatus !== 'DESCONECTADO';
  const isHealthy = isLinked && user.connectionStatus === 'CONECTADO';
  const handle = isLinked ? `@${rawUsername}` : user.nome;
  const scopeLabels: Record<string, string> = {
    instagram_basic: 'Ler o perfil básico',
    instagram_content_publish: 'Publicar conteúdo aprovado',
  };
  const shownScopes = (user.grantedScopes || [])
    .map((sc) => sc.replace('instagram_business_', 'instagram_'))
    .filter((sc) => scopeLabels[sc]);
  const [confirmInput, setConfirmInput] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteMsg, setInviteMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [inviting, setInviting] = useState(false);
  const isOwner = user.workspaceRole === 'OWNER';

  const canDelete =
    normalizeUsername(confirmInput) !== '' &&
    normalizeUsername(confirmInput) === normalizeUsername(user.instagramUsername || '');

  const handleReconnect = async () => {
    setError(null);
    setReconnecting(true);
    try {
      const { url } = await api.getInstagramAuthUrl();
      if (!url) throw new Error('Não foi possível obter a URL de autorização da Meta.');
      window.open(url, 'InstagramOAuthWindow', 'width=560,height=680,status=no,resizable=yes,scrollbars=yes');
    } catch (err: any) {
      setError(err.message || 'Não foi possível iniciar a reconexão.');
    } finally {
      setReconnecting(false);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteMsg(null);
    setInviting(true);
    try {
      const res = await api.createInvite(inviteEmail.trim());
      setInviteMsg({ ok: true, text: res.message || 'Convite enviado.' });
      setInviteEmail('');
    } catch (err: any) {
      setInviteMsg({ ok: false, text: err.message || 'Não foi possível enviar o convite.' });
    } finally {
      setInviting(false);
    }
  };

  const handleDelete = async () => {
    if (!canDelete || deleting) return;
    setError(null);
    setDeleting(true);
    try {
      const res = await api.deleteAccount(confirmInput);
      if (!res.success) throw new Error(res.error || 'Não foi possível excluir a conta.');
      onAccountDeleted();
    } catch (err: any) {
      setError(err.message || 'Não foi possível excluir a conta.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <header>
        <h1 className="text-2xl font-bold">Conta</h1>
        <p className="text-sm text-[#8E8E93] mt-1">Conecte e gerencie a conta do Instagram usada nas publicações.</p>
      </header>

      {error && (
        <div className="p-3 bg-red-950/30 border border-[#EF4444]/40 rounded-lg text-[#EF4444] text-xs">
          {error}
        </div>
      )}

      <section className="bg-[#121212] border border-[#242424] rounded-2xl p-6 space-y-4">
        <h2 className="text-base font-semibold">Conexão com o Instagram</h2>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{isLinked ? handle : 'Nenhuma conta conectada'}</p>
            <p
              className={`text-xs mt-1 ${isHealthy ? 'text-[#10B981]' : 'text-[#F59E0B]'}`}
              data-testid="ig-connection-status"
            >
              {!isLinked
                ? 'Conecte sua conta profissional do Instagram para poder publicar.'
                : isHealthy
                ? 'Conta conectada e autorizada'
                : 'Autorização expirada ou revogada. Reconecte para voltar a publicar.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleReconnect}
            disabled={reconnecting}
            className="px-4 py-2 rounded-lg bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] text-sm font-semibold cursor-pointer disabled:opacity-50 shrink-0"
          >
            {reconnecting ? 'Abrindo...' : !isLinked ? 'Conectar Instagram' : isHealthy ? 'Reconectar' : 'Reconectar Instagram'}
          </button>
        </div>
        {isHealthy && shownScopes.length > 0 && (
          <div className="text-xs text-[#8E8E93]">
            <p className="mb-1">Permissões concedidas:</p>
            <ul className="list-disc pl-4 space-y-0.5">
              {shownScopes.map((sc) => (
                <li key={sc}>{scopeLabels[sc]}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-[#8E8E93] leading-relaxed border-t border-[#242424] pt-3">
          Pedimos acesso ao perfil básico para identificar a conta correta e à publicação para
          postar somente o conteúdo que você aprovar. Nenhuma publicação é feita sem a sua confirmação.
        </p>
      </section>

      {isOwner && (
        <section className="bg-[#121212] border border-[#242424] rounded-2xl p-6 space-y-3">
          <h2 className="text-base font-semibold">Convidar pessoas</h2>
          <p className="text-xs text-[#8E8E93] leading-relaxed">
            Quem você convidar acessa somente este espaço de trabalho, com permissão de membro. O convite vale por 7 dias e só pode ser usado uma vez.
          </p>
          <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-2">
            <input
              type="email"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="email@convidado.com"
              aria-label="E-mail da pessoa convidada"
              className="flex-1 bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-sm text-white placeholder-[#4E4E52] outline-none"
            />
            <button type="submit" disabled={inviting} className="px-4 py-2 rounded-lg bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] text-sm font-semibold cursor-pointer disabled:opacity-50">
              {inviting ? 'Enviando...' : 'Enviar convite'}
            </button>
          </form>
          {inviteMsg && (
            <p role="status" className={`text-xs ${inviteMsg.ok ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>{inviteMsg.text}</p>
          )}
        </section>
      )}

      <section className="bg-[#121212] border border-[#EF4444]/30 rounded-2xl p-6 space-y-4">
        <h2 className="text-base font-semibold text-[#EF4444]">Excluir minha conta</h2>
        <p className="text-sm text-[#8E8E93] leading-relaxed">
          Isso apaga seus dados, posts e tokens salvos no ATO Social Hub. Sua conta do Instagram
          não é afetada. Para confirmar, digite seu @username abaixo.
        </p>
        <input
          type="text"
          value={confirmInput}
          onChange={(e) => setConfirmInput(e.target.value)}
          placeholder={handle}
          aria-label="Confirme digitando seu @username"
          className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#EF4444] rounded-lg px-3 py-2 text-sm text-white placeholder-[#4E4E52] outline-none"
        />
        <button
          type="button"
          onClick={handleDelete}
          disabled={!canDelete || deleting}
          className="px-4 py-2 rounded-lg bg-[#EF4444] hover:bg-[#DC2626] text-white text-sm font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {deleting ? 'Excluindo...' : 'Excluir minha conta'}
        </button>
      </section>
    </div>
  );
};
