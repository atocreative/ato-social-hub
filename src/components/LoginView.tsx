import React, { useState, useEffect } from 'react';
import { api, authStorage } from '../services/api.ts';
import { AuthResponse } from '../types/index.ts';
import { BrandLogo } from './BrandLogo.tsx';

interface LoginViewProps {
  onLoginSuccess: (user: AuthResponse['user']) => void;
  onNavigateLegal?: (path: string) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess, onNavigateLegal }) => {
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  // Standard Email and Password fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [rememberMe, setRememberMe] = useState(true);

  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Listen for popup OAuth messages (Meta / Instagram callback)
  useEffect(() => {
    const handleOAuthMessage = async (event: MessageEvent) => {
      if (!event.data) return;

      if (event.data.type === 'INSTAGRAM_AUTH_ERROR') {
        setOauthLoading(false);
        setErrorMessage(
          event.data.message || 'Não foi possível concluir a conexão. Tente novamente.'
        );
        return;
      }

      if (event.data.type === 'INSTAGRAM_AUTH_SUCCESS') {
        const { token, user, tenant, syncTicket } = event.data;
        if (token && user) {
          localStorage.clear();
          sessionStorage.clear();
          authStorage.clearSession();
          authStorage.setSession(token, user);
          try {
            await api.syncInstagramSession({ user, tenant, syncTicket });
          } catch {
            // Ignora falha transitória de sincronização
          }
          onLoginSuccess(user);
        }
      }
    };

    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [onLoginSuccess]);

  // Check URL query token or ig_error if redirected in same window
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const igError = params.get('ig_error');
    if (igError) {
      setErrorMessage(igError);
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    const urlToken = params.get('token');
    if (urlToken) {
      localStorage.clear();
      sessionStorage.clear();
      authStorage.clearSession();
      localStorage.setItem('ato_social_jwt_token', urlToken);
      api
        .getMe()
        .then((res) => {
          if (res.user) {
            authStorage.setSession(res.token || urlToken, res.user);
            window.history.replaceState({}, document.title, window.location.pathname);
            onLoginSuccess(res.user);
          }
        })
        .catch(() => {
          authStorage.clearSession();
        });
    }
  }, [onLoginSuccess]);

  // 1A. Standard Login Form (Admin or registered Client)
  const handleSubmitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setLoading(true);
    localStorage.clear();
    sessionStorage.clear();
    authStorage.clearSession();

    try {
      const data = await api.login(email.trim(), password);
      if (!data || !data.user || !data.user.role) {
        throw new Error(
          (data as any)?.error ||
            'Resposta inválida do servidor ao realizar login. Tente novamente.'
        );
      }
      authStorage.setSession(data.token, data.user);
      onLoginSuccess(data.user);
    } catch (err: any) {
      setErrorMessage(err.message || 'Credenciais inválidas. Verifique o e-mail e a senha informados.');
    } finally {
      setLoading(false);
    }
  };

  // 1B. Native Registration in ATO Social Hub (Enters Admin Approval Queue without requiring Instagram upfront)
  const handleSubmitRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setLoading(true);
    localStorage.clear();
    sessionStorage.clear();
    authStorage.clearSession();

    try {
      const data = await api.register({
        name: name.trim(),
        email: email.trim(),
        password,
        companyName: companyName.trim() || undefined,
      });
      if (!data || !data.user || !data.user.role) {
        throw new Error('Não foi possível concluir o cadastro. Tente novamente.');
      }
      authStorage.setSession(data.token, data.user);
      onLoginSuccess(data.user);
    } catch (err: any) {
      setErrorMessage(err.message || 'Não foi possível concluir o cadastro.');
    } finally {
      setLoading(false);
    }
  };

  // 2. Official Instagram OAuth Login
  const handleInstagramOAuth = async () => {
    setErrorMessage(null);
    setOauthLoading(true);
    localStorage.clear();
    sessionStorage.clear();
    authStorage.clearSession();

    try {
      const { url: url_completa } = await api.getInstagramAuthUrl();

      if (!url_completa) {
        throw new Error('Não foi possível obter a URL de autenticação da Meta.');
      }

      const width = 560;
      const height = 680;
      const left = window.screen.width / 2 - width / 2;
      const top = window.screen.height / 2 - height / 2;

      const popup = window.open(
        url_completa,
        'InstagramOAuthWindow',
        `width=${width},height=${height},top=${top},left=${left},status=no,resizable=yes,scrollbars=yes`
      );

      if (!popup || popup.closed || typeof popup.closed === 'undefined') {
        window.location.href = url_completa;
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Não foi possível concluir a conexão. Tente novamente.');
    } finally {
      setOauthLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A] flex flex-col items-center justify-center p-6 text-[#FFFFFF] font-sans">
      <div className="w-full max-w-[420px]">
        {/* Brand Logo Header */}
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center gap-2 mb-2">
            <BrandLogo variant="dot" height={44} />
          </div>
          <span className="text-xs text-[#8E8E93]">Portal de Mídias & Aprovação</span>
        </div>

        {/* Single Centered Unified Card */}
        <div className="bg-[#121212] border border-[#242424] rounded-2xl p-6 sm:p-7 shadow-xl">
          {/* Mode Tabs: Entrar vs Solicitar Cadastro */}
          <div className="grid grid-cols-2 gap-1.5 p-1 bg-[#0A0A0A] border border-[#242424] rounded-xl mb-5">
            <button
              type="button"
              onClick={() => {
                setAuthMode('login');
                setErrorMessage(null);
              }}
              className={`py-2 px-3 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                authMode === 'login'
                  ? 'bg-[#1F1F22] text-white border border-[#2E2E32]'
                  : 'text-[#8E8E93] hover:text-white'
              }`}
            >
              Entrar
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMode('register');
                setErrorMessage(null);
              }}
              className={`py-2 px-3 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                authMode === 'register'
                  ? 'bg-[#1F1F22] text-white border border-[#2E2E32]'
                  : 'text-[#8E8E93] hover:text-white'
              }`}
            >
              Solicitar Cadastro
            </button>
          </div>

          {errorMessage && (
            <div className="mb-5 p-3 bg-red-950/30 border border-[#EF4444]/40 rounded-lg text-[#EF4444] text-xs leading-relaxed">
              {errorMessage}
            </div>
          )}

          {authMode === 'login' ? (
            <>
              {/* Email + Password Login Form */}
              <form onSubmit={handleSubmitLogin} className="space-y-4">
                <div>
                  <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="login-email">
                    E-mail
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="seu@email.com"
                    className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-sm text-white placeholder-[#4E4E52] outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="login-password">
                    Senha
                  </label>
                  <input
                    id="login-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-sm text-white placeholder-[#4E4E52] outline-none"
                  />
                </div>

                {/* Manter conectado checkbox */}
                <div className="flex items-center justify-between text-xs text-[#8E8E93] pt-0.5">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(e) => setRememberMe(e.target.checked)}
                      className="w-3.5 h-3.5 rounded bg-[#0A0A0A] border-[#242424] text-[#10B981] focus:ring-0 focus:ring-offset-0 cursor-pointer accent-[#10B981]"
                    />
                    <span>Manter conectado</span>
                  </label>
                </div>

                <button
                  type="submit"
                  disabled={loading || oauthLoading}
                  className="w-full mt-2 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold py-2.5 px-4 rounded-lg text-sm transition-colors cursor-pointer disabled:opacity-50"
                >
                  {loading ? 'Entrando...' : 'Entrar'}
                </button>
              </form>

              {/* Divider */}
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-[#242424]" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-[#121212] px-3 text-[#8E8E93]">ou</span>
                </div>
              </div>

              {/* Official Instagram OAuth Button */}
              <button
                type="button"
                onClick={handleInstagramOAuth}
                disabled={loading || oauthLoading}
                className="w-full py-2.5 px-4 bg-gradient-to-r from-[#833AB4] via-[#FD1D1D] to-[#F77737] hover:opacity-95 text-white font-medium text-sm rounded-lg transition-opacity cursor-pointer flex items-center justify-center gap-2.5 disabled:opacity-50 shadow-md"
              >
                <svg
                  className="w-4 h-4 text-white shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                  <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
                  <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
                </svg>
                <span>{oauthLoading ? 'Conectando...' : 'Conectar com Instagram'}</span>
              </button>
            </>
          ) : (
            <form onSubmit={handleSubmitRegister} className="space-y-3.5">
              <div className="p-3 bg-[#0A0A0A] border border-[#242424] rounded-lg text-xs text-[#8E8E93] leading-relaxed">
                Solicite seu acesso ao <strong className="text-white">ATO Social Hub</strong>. Após a aprovação administrativa da sua empresa, você poderá conectar sua conta profissional do Instagram para agendar e publicar conteúdos.
              </div>

              <div>
                <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="register-name">
                  Seu Nome
                </label>
                <input
                  id="register-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex: Ana Silva"
                  className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-sm text-white placeholder-[#4E4E52] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="register-company">
                  Empresa / Marca
                </label>
                <input
                  id="register-company"
                  type="text"
                  required
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Nome da sua empresa"
                  className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-sm text-white placeholder-[#4E4E52] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="register-email">
                  E-mail Corporativo
                </label>
                <input
                  id="register-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="voce@suaempresa.com.br"
                  className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-sm text-white placeholder-[#4E4E52] outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="register-password">
                  Criar Senha (mín. 6 caracteres)
                </label>
                <input
                  id="register-password"
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-sm text-white placeholder-[#4E4E52] outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full mt-2 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold py-2.5 px-4 rounded-lg text-sm transition-colors cursor-pointer disabled:opacity-50"
              >
                {loading ? 'Enviando solicitação...' : 'Solicitar Cadastro e Entrar na Fila'}
              </button>
            </form>
          )}
        </div>

        {/* Footer Legal Links Required by Meta App Review */}
        <footer className="mt-6 text-center">
          <nav
            aria-label="Links institucionais e privacidade"
            className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-xs text-[#8E8E93]"
          >
            <a
              href="/privacidade"
              onClick={(e) => {
                if (onNavigateLegal) {
                  e.preventDefault();
                  onNavigateLegal('/privacidade');
                }
              }}
              className="hover:text-[#10B981] transition-colors underline-offset-4 hover:underline"
            >
              Política de Privacidade
            </a>
            <span className="text-[#3A3A3C]">·</span>
            <a
              href="/termos"
              onClick={(e) => {
                if (onNavigateLegal) {
                  e.preventDefault();
                  onNavigateLegal('/termos');
                }
              }}
              className="hover:text-[#10B981] transition-colors underline-offset-4 hover:underline"
            >
              Termos de Uso
            </a>
            <span className="text-[#3A3A3C]">·</span>
            <a
              href="/exclusao-de-dados"
              onClick={(e) => {
                if (onNavigateLegal) {
                  e.preventDefault();
                  onNavigateLegal('/exclusao-de-dados');
                }
              }}
              className="hover:text-[#10B981] transition-colors underline-offset-4 hover:underline"
            >
              Exclusão de Dados
            </a>
          </nav>
        </footer>
      </div>
    </div>
  );
};
