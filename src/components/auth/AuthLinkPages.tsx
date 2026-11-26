import React, { useEffect, useRef, useState } from 'react';
import { api, authStorage } from '../../services/api.ts';
import type { AuthResponse } from '../../types/index.ts';
import { AuthShell, AuthError, AuthNotice, authCardClass, authInputClass, authPrimaryButton } from './AuthShell.tsx';
import { PasswordField } from './PasswordField.tsx';

export type AuthLinkRoute = '/verificar-email' | '/redefinir-senha' | '/convite';

export function resolveAuthLinkRoute(pathname: string): AuthLinkRoute | null {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return clean === '/verificar-email' || clean === '/redefinir-senha' || clean === '/convite' ? clean : null;
}

interface Props {
  route: AuthLinkRoute;
  onAuthenticated: (user: AuthResponse['user']) => void;
  onNavigate: (path: string) => void;
}

// Lê o código do link uma única vez e já o remove da barra de endereço (não fica em histórico nem em capturas de tela).
function useLinkCode(): string {
  const [code] = useState(() => new URLSearchParams(window.location.search).get('code') || '');
  useEffect(() => {
    if (window.location.search) window.history.replaceState({}, document.title, window.location.pathname);
  }, []);
  return code;
}

export const AuthLinkPage: React.FC<Props> = ({ route, onAuthenticated, onNavigate }) => {
  const code = useLinkCode();
  const legal = (p: string) => onNavigate(p);
  return (
    <AuthShell onNavigateLegal={legal}>
      <div className={authCardClass}>
        {route === '/verificar-email' && <VerifyEmail code={code} onAuthenticated={onAuthenticated} onNavigate={onNavigate} />}
        {route === '/redefinir-senha' && <ResetPassword code={code} onNavigate={onNavigate} />}
        {route === '/convite' && <Invite code={code} onAuthenticated={onAuthenticated} onNavigate={onNavigate} />}
      </div>
    </AuthShell>
  );
};

const BackToLogin: React.FC<{ onNavigate: (p: string) => void; label?: string }> = ({ onNavigate, label = 'Ir para o acesso' }) => (
  <button type="button" onClick={() => onNavigate('/')} className={`${authPrimaryButton} mt-5`}>
    {label}
  </button>
);

const VerifyEmail: React.FC<{ code: string; onAuthenticated: Props['onAuthenticated']; onNavigate: Props['onNavigate'] }> = ({ code, onAuthenticated, onNavigate }) => {
  const [state, setState] = useState<'loading' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // o link é de uso único: nunca chamar duas vezes
    started.current = true;
    if (!code) {
      setState('error');
      setMessage('Este link está incompleto. Abra o link diretamente do e-mail.');
      return;
    }
    api
      .verifyEmail(code)
      .then((res) => {
        authStorage.setSession(res.token, res.user);
        onNavigate('/');
        onAuthenticated(res.user);
      })
      .catch((err: any) => {
        setState('error');
        setMessage(err.message || 'Não foi possível confirmar o e-mail.');
      });
  }, [code, onAuthenticated, onNavigate]);

  if (state === 'loading') {
    return (
      <div role="status">
        <h2 className="text-xl font-semibold">Confirmando seu e-mail...</h2>
        <p className="text-sm text-[#8E8E93] mt-2">Só um instante.</p>
      </div>
    );
  }
  return (
    <>
      <h2 className="text-xl font-semibold">Não foi possível confirmar</h2>
      <div className="mt-3"><AuthError message={message} /></div>
      <p className="text-xs text-[#8E8E93] leading-relaxed">Se você já confirmou, basta entrar com seu e-mail e senha. Caso contrário, faça o cadastro novamente para receber um novo link.</p>
      <BackToLogin onNavigate={onNavigate} />
    </>
  );
};

const ResetPassword: React.FC<{ code: string; onNavigate: Props['onNavigate'] }> = ({ code, onNavigate }) => {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.resetPassword(code, password);
      authStorage.clearSession(); // sessões antigas já foram encerradas no servidor
      setDone(true);
    } catch (err: any) {
      setError(err.message || 'Não foi possível redefinir a senha.');
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <>
        <h2 className="text-xl font-semibold">Senha atualizada</h2>
        <div className="mt-3"><AuthNotice>Pronto! Sua nova senha já vale. Por segurança, todas as sessões abertas foram encerradas.</AuthNotice></div>
        <BackToLogin onNavigate={onNavigate} label="Entrar com a nova senha" />
      </>
    );
  }
  return (
    <>
      <h2 className="text-xl font-semibold">Criar nova senha</h2>
      <p className="text-sm text-[#8E8E93] mt-1 mb-5">Escolha uma senha nova para a sua conta.</p>
      <AuthError message={error} />
      <form onSubmit={submit} className="space-y-4">
        <PasswordField id="reset-password" label="Nova senha" value={password} onChange={setPassword} autoComplete="new-password" minLength={10} hint="Pelo menos 10 caracteres." />
        <button type="submit" disabled={loading || !code} className={authPrimaryButton}>
          {loading ? 'Salvando...' : 'Salvar nova senha'}
        </button>
      </form>
      {!code && <p className="text-xs text-[#EF4444] mt-3">Este link está incompleto. Abra o link diretamente do e-mail.</p>}
    </>
  );
};

const Invite: React.FC<{ code: string; onAuthenticated: Props['onAuthenticated']; onNavigate: Props['onNavigate'] }> = ({ code, onAuthenticated, onNavigate }) => {
  const [info, setInfo] = useState<{ email: string; companyName: string; hasAccount: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) {
      setLoadError('Este convite está incompleto. Abra o link diretamente do e-mail.');
      return;
    }
    api.getInvite(code).then(setInfo).catch((err: any) => setLoadError(err.message || 'Este convite é inválido, expirou ou já foi usado.'));
  }, [code]);

  const finish = (res: AuthResponse) => {
    authStorage.setSession(res.token, res.user);
    onNavigate('/');
    onAuthenticated(res.user);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!info) return;
    setError(null);
    setLoading(true);
    try {
      if (info.hasAccount) {
        // Conta existente: entra com a própria senha e só então aceita (o servidor confere o e-mail convidado).
        authStorage.clearSession();
        const session = await api.login(info.email, password);
        authStorage.setSession(session.token, session.user);
        finish(await api.acceptInvite({ token: code }));
      } else {
        finish(await api.acceptInvite({ token: code, name: name.trim(), password, acceptTerms }));
      }
    } catch (err: any) {
      setError(err.message || 'Não foi possível aceitar o convite.');
    } finally {
      setLoading(false);
    }
  };

  if (loadError) {
    return (
      <>
        <h2 className="text-xl font-semibold">Convite indisponível</h2>
        <div className="mt-3"><AuthError message={loadError} /></div>
        <BackToLogin onNavigate={onNavigate} />
      </>
    );
  }
  if (!info) return <p role="status" className="text-sm text-[#8E8E93]">Carregando convite...</p>;

  return (
    <>
      <h2 className="text-xl font-semibold">Você foi convidado</h2>
      <p className="text-sm text-[#8E8E93] mt-1 mb-5 leading-relaxed">
        Acesse o espaço de trabalho <strong className="text-white">{info.companyName}</strong> com o e-mail <strong className="text-white">{info.email}</strong>. Você verá somente o conteúdo dessa empresa.
      </p>
      <AuthError message={error} />
      <form onSubmit={submit} className="space-y-4">
        {info.hasAccount ? (
          <PasswordField id="invite-password" label="Sua senha atual" value={password} onChange={setPassword} autoComplete="current-password" hint="Já existe uma conta com este e-mail. Entre para aceitar o convite." />
        ) : (
          <>
            <div>
              <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="invite-name">Nome completo</label>
              <input id="invite-name" type="text" required minLength={2} maxLength={120} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={authInputClass} />
            </div>
            <PasswordField id="invite-new-password" label="Crie uma senha" value={password} onChange={setPassword} autoComplete="new-password" minLength={10} hint="Pelo menos 10 caracteres." />
            <label className="flex items-start gap-2 cursor-pointer select-none text-xs text-[#8E8E93] leading-relaxed">
              <input type="checkbox" required checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} className="mt-0.5 w-3.5 h-3.5 rounded accent-[#10B981] cursor-pointer" />
              <span>
                Li e aceito os <a href="/termos" target="_blank" rel="noopener noreferrer" className="text-[#10B981] hover:underline">Termos de Uso</a> e a{' '}
                <a href="/privacidade" target="_blank" rel="noopener noreferrer" className="text-[#10B981] hover:underline">Política de Privacidade</a>.
              </span>
            </label>
          </>
        )}
        <button type="submit" disabled={loading || (!info.hasAccount && !acceptTerms)} className={authPrimaryButton}>
          {loading ? 'Aguarde...' : info.hasAccount ? 'Entrar e aceitar convite' : 'Criar conta e aceitar convite'}
        </button>
      </form>
    </>
  );
};
