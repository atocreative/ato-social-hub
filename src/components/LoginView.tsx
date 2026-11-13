import React, { useState, useEffect } from 'react';
import { api, authStorage } from '../services/api.ts';
import { AuthResponse } from '../types/index.ts';
import { BrandLogo } from './BrandLogo.tsx';

interface LoginViewProps {
  onLoginSuccess: (user: AuthResponse['user']) => void;
  onNavigateLegal?: (path: string) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess, onNavigateLegal }) => {
  // Acesso administrativo (e-mail e senha)
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);

  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Retorno do popup OAuth do Instagram
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
        const { token: messageToken, user, tenant, syncTicket } = event.data;
        // O callback NÃO envia o token na mensagem: a popup grava a sessão no localStorage
        // do mesmo domínio. Lemos esse valor ANTES de limpar o storage.
        let token: string | null = messageToken || null;
        if (!token) {
          try {
            token = localStorage.getItem('ato_social_jwt_token');
          } catch {
            token = null;
          }
        }
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

  // Erro vindo de redirect (ig_error) ou token na URL
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

  // Acesso administrativo
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
      setErrorMessage(
        err.message || 'Credenciais inválidas. Verifique o e-mail e a senha informados.'
      );
    } finally {
      setLoading(false);
    }
  };

  // Entrada principal: conta profissional do Instagram
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

  const legalLink = (path: string, label: string) => (
    <a
      href={path}
      onClick={(e) => {
        if (onNavigateLegal) {
          e.preventDefault();
          onNavigateLegal(path);
        }
      }}
      className="hover:text-[#10B981] transition-colors underline-offset-4 hover:underline"
    >
      {label}
    </a>
  );

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white font-sans md:grid md:grid-cols-2">
      {/* Coluna da marca (somente desktop) */}
      <aside className="hidden md:flex flex-col justify-between p-12 border-r border-[#1C1C1C] bg-[#0A0A0A]">
        <BrandLogo variant="dot" height={36} />
        <div>
          <p className="text-xs tracking-[0.3em] text-[#8E8E93] uppercase mb-4">
            Gestão de redes sociais
          </p>
          <h1 className="text-4xl font-bold leading-tight">
            Seus posts <span className="text-[#10B981]">programados</span>, no lugar certo.
          </h1>
          <p className="mt-4 text-[#8E8E93] max-w-md">
            Organize, agende e acompanhe as publicações da sua conta profissional do Instagram.
          </p>
        </div>
        <ul className="space-y-3 text-sm text-[#8E8E93]">
          <li>• Agenda visual dos posts programados</li>
          <li>• Status de publicação em tempo real</li>
          <li>• Memória criativa para as próximas artes</li>
        </ul>
      </aside>

      {/* Card de acesso */}
      <main className="flex flex-col items-center justify-center p-6 md:p-12 min-h-screen md:min-h-0">
        <div className="w-full max-w-[380px]">
          <div className="md:hidden flex justify-center mb-8">
            <BrandLogo variant="dot" height={36} />
          </div>

          <div className="bg-[#121212] border border-[#242424] rounded-2xl p-7 shadow-xl">
            <h2 className="text-xl font-semibold">Entrar</h2>
            <p className="text-sm text-[#8E8E93] mt-1 mb-6">
              Use sua conta profissional do Instagram.
            </p>

            {errorMessage && (
              <div className="mb-5 p-3 bg-red-950/30 border border-[#EF4444]/40 rounded-lg text-[#EF4444] text-xs leading-relaxed">
                {errorMessage}
              </div>
            )}

            <button
              type="button"
              onClick={handleInstagramOAuth}
              disabled={loading || oauthLoading}
              className="w-full py-3 px-4 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-sm rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-2.5 disabled:opacity-50"
            >
              <svg
                className="w-4 h-4 shrink-0"
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

            <p className="text-xs text-[#8E8E93] mt-4 leading-relaxed">
              Ao conectar, você autoriza o ATO Social Hub a ler o perfil básico e publicar
              conteúdos aprovados na sua conta.
            </p>

            <details className="mt-6 border-t border-[#242424] pt-4">
              <summary className="text-xs text-[#8E8E93] cursor-pointer hover:text-white select-none">
                Acesso administrativo
              </summary>
              <form onSubmit={handleSubmitLogin} className="space-y-4 mt-4">
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

                <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-[#8E8E93]">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-3.5 h-3.5 rounded bg-[#0A0A0A] border-[#242424] accent-[#10B981] cursor-pointer"
                  />
                  <span>Manter conectado</span>
                </label>

                <button
                  type="submit"
                  disabled={loading || oauthLoading}
                  className="w-full bg-[#1F1F22] hover:bg-[#2A2A2E] border border-[#2E2E32] text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors cursor-pointer disabled:opacity-50"
                >
                  {loading ? 'Entrando...' : 'Entrar'}
                </button>
              </form>
            </details>
          </div>

          <footer className="mt-6 text-center text-xs text-[#8E8E93] flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
            {legalLink('/privacidade', 'Política de Privacidade')}
            <span className="text-[#3A3A3C]">·</span>
            {legalLink('/termos', 'Termos de Uso')}
          </footer>
        </div>
      </main>
    </div>
  );
};
