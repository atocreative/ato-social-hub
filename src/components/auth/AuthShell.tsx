import React from 'react';
import { BrandLogo } from '../BrandLogo.tsx';

// Moldura visual das telas públicas (acesso, cadastro, links de e-mail e onboarding).
// Mantém a identidade atual do ATO Social Hub: fundo escuro, verde #10B981 e a coluna da marca no desktop.
export const AuthShell: React.FC<{ children: React.ReactNode; onNavigateLegal?: (path: string) => void; maxWidth?: string }> = ({
  children,
  onNavigateLegal,
  maxWidth = 'max-w-[400px]',
}) => {
  const legal = (path: string, label: string) => (
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
      <aside className="hidden md:flex flex-col justify-between p-12 border-r border-[#1C1C1C] bg-[#0A0A0A]">
        <BrandLogo variant="dot" height={36} />
        <div>
          <p className="text-xs tracking-[0.3em] text-[#8E8E93] uppercase mb-4">Gestão de redes sociais</p>
          <h1 className="text-4xl font-bold leading-tight">
            Seus posts <span className="text-[#10B981]">programados</span>, no lugar certo.
          </h1>
          <p className="mt-4 text-[#8E8E93] max-w-md">
            Organize, aprove e agende as publicações da sua conta profissional do Instagram em um só lugar.
          </p>
        </div>
        <ul className="space-y-3 text-sm text-[#8E8E93]">
          <li>• Seu espaço de trabalho é privado: só você e quem você convidar têm acesso</li>
          <li>• Nada é publicado sem a sua confirmação</li>
          <li>• Conexão oficial com o Instagram, sem pedir a senha dele</li>
        </ul>
      </aside>

      <main className="flex flex-col items-center justify-center p-6 md:p-12 min-h-screen md:min-h-0">
        <div className={`w-full ${maxWidth}`}>
          <div className="md:hidden flex justify-center mb-8">
            <BrandLogo variant="dot" height={36} />
          </div>
          {children}
          <footer className="mt-6 text-center text-xs text-[#8E8E93] flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
            {legal('/privacidade', 'Política de Privacidade')}
            <span className="text-[#3A3A3C]">·</span>
            {legal('/termos', 'Termos de Uso')}
          </footer>
        </div>
      </main>
    </div>
  );
};

export const authCardClass = 'bg-[#121212] border border-[#242424] rounded-2xl p-6 sm:p-7 shadow-xl';
export const authInputClass =
  'w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2.5 text-sm text-white placeholder-[#4E4E52] outline-none';
export const authPrimaryButton =
  'w-full bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold py-2.5 px-4 rounded-lg text-sm transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

export const AuthError: React.FC<{ message: string | null }> = ({ message }) =>
  message ? (
    <div role="alert" className="mb-4 p-3 bg-red-950/30 border border-[#EF4444]/40 rounded-lg text-[#EF4444] text-xs leading-relaxed">
      {message}
    </div>
  ) : null;

export const AuthNotice: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div role="status" className="mb-4 p-3 bg-[#10B981]/10 border border-[#10B981]/30 rounded-lg text-[#6EE7B7] text-xs leading-relaxed">
    {children}
  </div>
);
