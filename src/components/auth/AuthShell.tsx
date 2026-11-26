import React from 'react';
import { BrandLogo } from '../BrandLogo.tsx';

// Órbitas (tamanho em px, duração em s, tamanho do planeta, cor, sentido, posição inicial em graus).
const RINGS = [
  { size: 300, dur: 30, planet: 8, color: '#10B981', dir: 1, start: 0 },
  { size: 450, dur: 48, planet: 11, color: '#6EE7B7', dir: -1, start: 130 },
  { size: 610, dur: 70, planet: 6, color: '#FFFFFF', dir: 1, start: 230 },
  { size: 790, dur: 96, planet: 13, color: '#0EA271', dir: -1, start: 50 },
];
// Estrelas em posições fixas (determinístico: sem variação entre renderizações).
const frac = (n: number) => n - Math.floor(n);
const STARS = Array.from({ length: 44 }, (_, i) => ({
  x: Math.round(frac(Math.sin(i * 12.9898) * 43758.5453) * 100),
  y: Math.round(frac(Math.sin(i * 78.233) * 12543.1357) * 100),
  r: 1 + Math.round(frac(Math.sin(i * 39.346) * 9871.331) * 10) / 10 * 1.4,
  o: 0.25 + frac(Math.sin(i * 5.17) * 5113.7) * 0.5,
  d: Math.round(frac(Math.sin(i * 3.31) * 777.7) * 60) / 10,
}));
const ORBIT_CSS = `
@keyframes ato-orbit { to { transform: rotate(360deg); } }
@keyframes ato-float { 0%,100% { transform: translateY(0) rotate(-1.5deg); } 50% { transform: translateY(-14px) rotate(1.5deg); } }
@keyframes ato-twinkle { 0%,100% { opacity: .15; } 50% { opacity: .9; } }
.ato-orbit { animation: ato-orbit linear infinite; }
.ato-float { animation: ato-float 7s ease-in-out infinite; }
.ato-star { animation: ato-twinkle 5s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .ato-orbit, .ato-float, .ato-star { animation: none !important; } }
`;

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
      <aside className="relative isolate overflow-hidden hidden md:flex flex-col justify-between p-12 border-r border-[#1C1C1C] bg-[#0A0A0A]">
        <style>{ORBIT_CSS}</style>
        {/* Fundo "sistema solar": brilho central, estrelas e órbitas nas cores da ATO */}
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_36%,rgba(16,185,129,0.16),rgba(10,10,10,0)_62%)]" />
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-2/5 -z-10 bg-gradient-to-t from-[#0A0A0A] via-[#0A0A0A]/85 to-transparent" />
        {STARS.map((s, i) => (
          <span
            key={i}
            aria-hidden="true"
            className="ato-star absolute -z-10 rounded-full bg-white"
            style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.r, height: s.r, opacity: s.o, animationDelay: `${s.d}s` }}
          />
        ))}
        <BrandLogo variant="dot" height={36} />
        <div className="relative flex-1 flex items-center justify-center min-h-[240px]">
          {RINGS.map((r) => (
            <div
              key={r.size}
              aria-hidden="true"
              className="ato-orbit absolute rounded-full border border-[#10B981]/25"
              style={{
                width: r.size,
                height: r.size,
                animationDuration: `${r.dur}s`,
                animationDirection: r.dir < 0 ? 'reverse' : 'normal',
                animationDelay: `-${(r.start / 360) * r.dur}s`,
              }}
            >
              <span
                className="absolute left-1/2 top-0 rounded-full"
                style={{
                  width: r.planet,
                  height: r.planet,
                  background: r.color,
                  transform: 'translate(-50%, -50%)',
                  boxShadow: `0 0 ${r.planet * 2.2}px ${r.planet / 2}px ${r.color}66`,
                }}
              />
            </div>
          ))}
          <div aria-hidden="true" className="absolute h-[360px] w-[360px] rounded-full bg-[radial-gradient(circle,rgba(16,185,129,0.30),rgba(16,185,129,0.07)_48%,transparent_70%)] blur-xl" />
          <img
            src="/login-instagram-3d.png"
            alt=""
            aria-hidden="true"
            draggable={false}
            className="ato-float relative z-10 h-[min(330px,36vh)] w-auto select-none drop-shadow-[0_28px_40px_rgba(16,185,129,0.28)]"
          />
        </div>
        <div className="relative">
          <p className="text-xs tracking-[0.3em] text-[#8E8E93] uppercase mb-4">Gestão de redes sociais</p>
          <h1 className="text-4xl font-bold leading-tight">
            Seus posts <span className="text-[#10B981]">programados</span>, no lugar certo.
          </h1>
          <p className="mt-4 text-[#8E8E93] max-w-md">
            Organize, aprove e agende as publicações da sua conta profissional do Instagram em um só lugar.
          </p>
        </div>
        <ul className="relative mt-8 space-y-3 text-sm text-[#8E8E93]">
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
