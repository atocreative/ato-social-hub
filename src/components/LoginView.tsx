import React, { useEffect, useState } from 'react';
import { api, authStorage } from '../services/api.ts';
import { AuthResponse } from '../types/index.ts';
import { AuthShell, AuthError, AuthNotice, authCardClass, authInputClass, authPrimaryButton } from './auth/AuthShell.tsx';
import { PasswordField } from './auth/PasswordField.tsx';

interface LoginViewProps {
  onLoginSuccess: (user: AuthResponse['user']) => void;
  onNavigateLegal?: (path: string) => void;
  initialMode?: 'login' | 'signup';
}

type Mode = 'login' | 'signup' | 'forgot' | 'signup-sent' | 'forgot-sent';

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess, onNavigateLegal, initialMode = 'login' }) => {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [trap, setTrap] = useState(''); // campo-isca: pessoas nunca o veem nem preenchem; robôs sim
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // O cadastro público pode estar desligado no servidor: nesse caso só o acesso por login aparece.
  // `null` = ainda consultando: as abas só aparecem depois da resposta, para não "piscar" e sumir.
  const [signupEnabled, setSignupEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    api
      .getAuthConfig()
      .then((c) => {
        const on = Boolean(c && c.signupEnabled === true);
        setSignupEnabled(on);
        if (!on) setMode((m) => (m === 'signup' ? 'login' : m));
      })
      .catch(() => {
        // Servidor sem a rota (versão antiga) ou indisponível: não oferece cadastro.
        setSignupEnabled(false);
        setMode((m) => (m === 'signup' ? 'login' : m));
      });
  }, []);

  // Mensagem de erro vinda de um redirecionamento (ex.: ig_error do retorno da Meta).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const igError = params.get('ig_error');
    if (igError) {
      setErrorMessage(igError);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  const go = (next: Mode) => {
    setMode(next);
    setErrorMessage(null);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setLoading(true);
    localStorage.clear();
    sessionStorage.clear();
    authStorage.clearSession();
    try {
      const data = await api.login(email.trim(), password);
      if (!data || !data.user || !data.user.role) {
        throw new Error((data as any)?.error || 'Resposta inválida do servidor. Tente novamente.');
      }
      authStorage.setSession(data.token, data.user);
      onLoginSuccess(data.user);
    } catch (err: any) {
      setErrorMessage(err.message || 'E-mail ou senha incorretos. Confira os dados e tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setLoading(true);
    try {
      await api.signup({ name: name.trim(), email: email.trim(), password, acceptTerms, website: trap });
      setPassword('');
      go('signup-sent');
    } catch (err: any) {
      setErrorMessage(err.message || 'Não foi possível criar a conta agora. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setLoading(true);
    try {
      await api.forgotPassword(email.trim());
      go('forgot-sent');
    } catch (err: any) {
      setErrorMessage(err.message || 'Não foi possível enviar as instruções agora. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const link = (label: string, next: Mode) => (
    <button type="button" onClick={() => go(next)} className="text-[#10B981] hover:underline underline-offset-4 cursor-pointer">
      {label}
    </button>
  );

  const showTabs = signupEnabled && (mode === 'login' || mode === 'signup');

  return (
    <AuthShell onNavigateLegal={onNavigateLegal}>
      <div className={authCardClass}>
        {showTabs && (
          <div role="tablist" aria-label="Acesso" className="grid grid-cols-2 gap-1 p-1 mb-6 bg-[#0A0A0A] border border-[#242424] rounded-xl">
            {(['login', 'signup'] as const).map((m) => (
              <button
                key={m}
                role="tab"
                type="button"
                aria-selected={mode === m}
                onClick={() => go(m)}
                className={`py-2 text-sm rounded-lg font-medium cursor-pointer transition-colors ${
                  mode === m ? 'bg-[#1C1C1C] text-white' : 'text-[#8E8E93] hover:text-white'
                }`}
              >
                {m === 'login' ? 'Entrar' : 'Criar conta'}
              </button>
            ))}
          </div>
        )}

        {mode === 'login' && (
          <>
            <h2 className="text-xl font-semibold">Bem-vindo de volta</h2>
            <p className="text-sm text-[#8E8E93] mt-1 mb-5">Entre para acompanhar e aprovar suas publicações.</p>
            <AuthError message={errorMessage} />
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="login-email">E-mail</label>
                <input id="login-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="seu@email.com" className={authInputClass} />
              </div>
              <PasswordField id="login-password" label="Senha" value={password} onChange={setPassword} autoComplete="current-password" />
              <div className="flex justify-end -mt-1 text-xs">{link('Esqueci minha senha', 'forgot')}</div>
              <button type="submit" disabled={loading} className={authPrimaryButton}>
                {loading ? 'Entrando...' : 'Entrar'}
              </button>
            </form>
            {signupEnabled && (
              <p className="text-xs text-[#8E8E93] mt-5 text-center">Ainda não tem conta? {link('Criar minha conta', 'signup')}</p>
            )}
          </>
        )}

        {mode === 'signup' && (
          <>
            <h2 className="text-xl font-semibold">Crie sua conta</h2>
            <p className="text-sm text-[#8E8E93] mt-1 mb-5">Leva menos de um minuto. Depois você conecta seu Instagram profissional.</p>
            <AuthError message={errorMessage} />
            <form onSubmit={handleSignup} className="space-y-4">
              <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
                <label htmlFor="signup-website">Não preencha este campo</label>
                <input id="signup-website" name="website" type="text" tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="signup-name">Nome completo</label>
                <input id="signup-name" type="text" required minLength={2} maxLength={120} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Maria Souza" className={authInputClass} />
              </div>
              <div>
                <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="signup-email">E-mail</label>
                <input id="signup-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="seu@email.com" className={authInputClass} />
              </div>
              <PasswordField
                id="signup-password"
                label="Senha"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                minLength={10}
                hint="Pelo menos 10 caracteres. Evite sequências e partes do seu e-mail."
              />
              <label className="flex items-start gap-2 cursor-pointer select-none text-xs text-[#8E8E93] leading-relaxed">
                <input type="checkbox" required checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} className="mt-0.5 w-3.5 h-3.5 rounded accent-[#10B981] cursor-pointer" />
                <span>
                  Li e aceito os{' '}
                  <a href="/termos" target="_blank" rel="noopener noreferrer" className="text-[#10B981] hover:underline">Termos de Uso</a>{' '}
                  e a{' '}
                  <a href="/privacidade" target="_blank" rel="noopener noreferrer" className="text-[#10B981] hover:underline">Política de Privacidade</a>.
                </span>
              </label>
              <button type="submit" disabled={loading || !acceptTerms} className={authPrimaryButton}>
                {loading ? 'Enviando...' : 'Criar minha conta'}
              </button>
            </form>
            <p className="text-xs text-[#8E8E93] mt-5 text-center">Já tem conta? {link('Entrar', 'login')}</p>
          </>
        )}

        {mode === 'signup-sent' && (
          <>
            <h2 className="text-xl font-semibold">Confirme seu e-mail</h2>
            <p className="text-sm text-[#8E8E93] mt-2 leading-relaxed">
              Enviamos um link de confirmação para <strong className="text-white">{email}</strong>. Abra a mensagem e clique no link para ativar sua conta. O link vale por 24 horas.
            </p>
            <p className="text-xs text-[#8E8E93] mt-4 leading-relaxed">Não chegou? Veja a caixa de spam. Se continuar sem receber, {link('tente com outro e-mail', 'signup')}.</p>
            <div className="mt-5 text-xs text-center">{link('Voltar para entrar', 'login')}</div>
          </>
        )}

        {mode === 'forgot' && (
          <>
            <h2 className="text-xl font-semibold">Esqueci minha senha</h2>
            <p className="text-sm text-[#8E8E93] mt-1 mb-5">Informe o e-mail da sua conta e enviaremos as instruções para criar uma nova senha.</p>
            <AuthError message={errorMessage} />
            <form onSubmit={handleForgot} className="space-y-4">
              <div>
                <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="forgot-email">E-mail</label>
                <input id="forgot-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="seu@email.com" className={authInputClass} />
              </div>
              <button type="submit" disabled={loading} className={authPrimaryButton}>
                {loading ? 'Enviando...' : 'Enviar instruções'}
              </button>
            </form>
            <div className="mt-5 text-xs text-center">{link('Voltar para entrar', 'login')}</div>
          </>
        )}

        {mode === 'forgot-sent' && (
          <>
            <h2 className="text-xl font-semibold">Verifique seu e-mail</h2>
            <div className="mt-3">
              <AuthNotice>Se existir uma conta com este e-mail, enviamos as instruções para criar uma nova senha. O link vale por 1 hora.</AuthNotice>
            </div>
            <div className="mt-2 text-xs text-center">{link('Voltar para entrar', 'login')}</div>
          </>
        )}
      </div>
    </AuthShell>
  );
};
