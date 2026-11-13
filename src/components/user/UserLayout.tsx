import React from 'react';
import { LayoutDashboard, ListChecks, CalendarDays, History, Sparkles, User, LogOut } from 'lucide-react';
import type { AuthResponse } from '../../types/index.ts';
import type { UserView } from './types.ts';

interface UserLayoutProps {
  user: AuthResponse['user'];
  view: UserView;
  onChangeView: (view: UserView) => void;
  onLogout: () => void;
  children: React.ReactNode;
}

const NAV: { view: UserView; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { view: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { view: 'posts', label: 'Posts', icon: ListChecks },
  { view: 'agenda', label: 'Agenda', icon: CalendarDays },
  { view: 'historico', label: 'Histórico', icon: History },
  { view: 'memoria', label: 'Memória criativa', icon: Sparkles },
  { view: 'conta', label: 'Conta', icon: User },
];

export const UserLayout: React.FC<UserLayoutProps> = ({ user, view, onChangeView, onLogout, children }) => {
  const handle = user.instagramUsername ? `@${user.instagramUsername.replace(/^@/, '')}` : user.nome;

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white font-sans md:flex">
      {/* Sidebar (desktop) */}
      <aside className="hidden md:flex md:flex-col w-60 shrink-0 border-r border-[#1C1C1C] bg-[#0D0D0D] p-5 sticky top-0 h-screen">
        <div className="mb-8">
          <p className="text-[11px] tracking-[0.25em] text-[#8E8E93] uppercase">ATO</p>
          <p className="text-sm font-semibold text-white mt-1 truncate">{handle}</p>
        </div>
        <nav className="flex-1 space-y-1">
          {NAV.map(({ view: v, label, icon: Icon }) => {
            const active = v === view;
            return (
              <button
                key={v}
                type="button"
                onClick={() => onChangeView(v)}
                aria-current={active ? 'page' : undefined}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30'
                    : 'text-[#8E8E93] hover:text-white hover:bg-[#161616] border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
        <button
          type="button"
          onClick={onLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-[#8E8E93] hover:text-white hover:bg-[#161616] cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          <span>Sair</span>
        </button>
      </aside>

      {/* Topo (celular) */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-[#1C1C1C] bg-[#0D0D0D] sticky top-0 z-20">
        <p className="text-sm font-semibold truncate">{handle}</p>
        <button type="button" onClick={onLogout} className="text-xs text-[#8E8E93] cursor-pointer">
          Sair
        </button>
      </header>

      <main className="flex-1 min-w-0 px-4 py-6 md:px-10 md:py-10 pb-24 md:pb-10">{children}</main>

      {/* Barra inferior (celular) */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-[#0D0D0D] border-t border-[#1C1C1C] grid grid-cols-6">
        {NAV.map(({ view: v, label, icon: Icon }) => {
          const active = v === view;
          return (
            <button
              key={v}
              type="button"
              onClick={() => onChangeView(v)}
              className={`flex flex-col items-center gap-1 py-2.5 text-[10px] cursor-pointer ${
                active ? 'text-[#10B981]' : 'text-[#8E8E93]'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span>{label.split(' ')[0]}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};
