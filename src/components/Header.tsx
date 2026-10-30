import React from 'react';
import { UserProfile } from '../types/index.ts';

interface HeaderProps {
  user: UserProfile;
  onLogout: () => void;
  onOpenWebhookModal: () => void;
  onResetDemo: () => void;
  isSyncing?: boolean;
  currentView?: 'ADMIN_TENANTS' | 'APPROVAL_DASHBOARD';
  onNavigateView?: (view: 'ADMIN_TENANTS' | 'APPROVAL_DASHBOARD') => void;
  previewingTenantUsername?: string;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  onLogout,
  onOpenWebhookModal,
  isSyncing,
  currentView = 'APPROVAL_DASHBOARD',
  onNavigateView,
}) => {
  const isAdmin = user.role === 'ADMIN';

  return (
    <header className="sticky top-0 z-30 bg-[#121212] border-b border-[#242424] px-4 md:px-8 py-3">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        {/* Brand */}
        <div className="flex items-center gap-4">
          <span className="text-lg font-bold tracking-tight text-white font-mono">
            ATO<span className="text-[#10B981]">.</span>
          </span>

          {/* Navigation for Admin */}
          {isAdmin && onNavigateView && (
            <nav className="flex items-center gap-1 bg-[#0A0A0A] border border-[#242424] rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => onNavigateView('ADMIN_TENANTS')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                  currentView === 'ADMIN_TENANTS'
                    ? 'bg-[#121212] text-white shadow-sm'
                    : 'text-[#8E8E93] hover:text-white'
                }`}
              >
                Contas
              </button>
              <button
                type="button"
                onClick={() => onNavigateView('APPROVAL_DASHBOARD')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                  currentView === 'APPROVAL_DASHBOARD'
                    ? 'bg-[#121212] text-white shadow-sm'
                    : 'text-[#8E8E93] hover:text-white'
                }`}
              >
                Mídias Sincronizadas
              </button>
            </nav>
          )}

          {/* Label for Client */}
          {!isAdmin && user.instagramUsername && (
            <span className="text-xs text-[#8E8E93] font-mono">
              @{user.instagramUsername}
            </span>
          )}
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onOpenWebhookModal}
            className="px-3.5 py-1.5 text-xs font-medium text-white bg-[#1A1A1A] hover:bg-[#222222] border border-[#2A2A2A] rounded-lg transition-colors cursor-pointer"
          >
            {isSyncing ? 'Atualizando...' : 'Atualizar Posts'}
          </button>

          <span className="text-xs text-[#8E8E93] hidden sm:inline">
            {isAdmin ? 'Admin' : user.nome}
          </span>

          <button
            type="button"
            onClick={onLogout}
            className="text-xs text-[#8E8E93] hover:text-[#EF4444] transition-colors cursor-pointer px-2 py-1"
          >
            Sair
          </button>
        </div>
      </div>
    </header>
  );
};
