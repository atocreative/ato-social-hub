import React, { useState } from 'react';
import type { AuthResponse } from '../../types/index.ts';
import { api } from '../../services/api.ts';
import { normalizeUsername } from '../../services/accountDeletion.ts';

interface AccountViewProps {
  user: AuthResponse['user'];
  onAccountDeleted: () => void;
}

export const AccountView: React.FC<AccountViewProps> = ({ user, onAccountDeleted }) => {
  const handle = user.instagramUsername ? `@${user.instagramUsername.replace(/^@/, '')}` : user.nome;
  const [confirmInput, setConfirmInput] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

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
        <p className="text-sm text-[#8E8E93] mt-1">Gerencie a conta do Instagram conectada.</p>
      </header>

      {error && (
        <div className="p-3 bg-red-950/30 border border-[#EF4444]/40 rounded-lg text-[#EF4444] text-xs">
          {error}
        </div>
      )}

      <section className="bg-[#121212] border border-[#242424] rounded-2xl p-6 space-y-4">
        <h2 className="text-base font-semibold">Conta conectada</h2>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{handle}</p>
            <p className="text-xs text-[#8E8E93] mt-1">
              Status: {user.connectionStatus === 'CONECTADO' ? 'Conectada' : 'Reconexão necessária'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleReconnect}
            disabled={reconnecting}
            className="px-4 py-2 rounded-lg border border-[#2E2E32] text-sm hover:bg-[#161616] cursor-pointer disabled:opacity-50"
          >
            {reconnecting ? 'Abrindo...' : 'Reconectar'}
          </button>
        </div>
      </section>

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
