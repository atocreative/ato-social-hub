import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api, authStorage } from './services/api.ts';
import { PostGroup, UserProfile, InstagramPublishPayload, TenantAccount } from './types/index.ts';
import { filterPosts, CategoryFilter, MediaFilter, formatDateTimeBR } from './utils/postHelpers.ts';
import { LoginView } from './components/LoginView.tsx';
import { Header } from './components/Header.tsx';
import { AdminTenantsView } from './components/AdminTenantsView.tsx';
import { FilterBar, FilterTab } from './components/FilterBar.tsx';
import { PostCard } from './components/PostCard.tsx';
import { ApprovalModal } from './components/ApprovalModal.tsx';
import { RejectionModal } from './components/RejectionModal.tsx';
import { WebhookSimulatorModal } from './components/WebhookSimulatorModal.tsx';
import { NotificationBanner, NotificationState } from './components/NotificationBanner.tsx';
import { WaitingRoom } from './components/WaitingRoom.tsx';
import { UploadMediaModal } from './components/UploadMediaModal.tsx';
import { PublicLegalPage, LegalRoute } from './components/PublicLegalPage.tsx';
import { ClientObservationsView } from './components/ClientObservationsView.tsx';
import { UserLayout } from './components/user/UserLayout.tsx';
import type { UserView } from './components/user/types.ts';
import { UserDashboard } from './components/user/UserDashboard.tsx';
import { PostsView } from './components/user/PostsView.tsx';
import { AgendaView } from './components/user/AgendaView.tsx';
import { HistoryView } from './components/user/HistoryView.tsx';
import { MemoryView } from './components/user/MemoryView.tsx';
import { AccountView } from './components/user/AccountView.tsx';
import { Trash2, AlertCircle, EyeOff, Instagram } from 'lucide-react';

function resolveLegalRoute(pathname: string): LegalRoute | null {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/privacidade' || clean === '/termos' || clean === '/exclusao-de-dados') {
    return clean;
  }
  return null;
}

export default function App() {
  const [currentPath, setCurrentPath] = useState<string>(() => window.location.pathname);
  const [user, setUser] = useState<UserProfile | null>(() => authStorage.getUser());
  const [posts, setPosts] = useState<PostGroup[]>([]);
  const [availableFolders, setAvailableFolders] = useState<string[]>([]);
  const [folderDetails, setFolderDetails] = useState<Array<{ id: string; nome: string; url?: string }>>([]);
  const [activeTenant, setActiveTenant] = useState<TenantAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncingDrive, setSyncingDrive] = useState(false);
  const [syncRefreshKey, setSyncRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Admin View State: Manage Tenants vs Approval Dashboard
  const [adminView, setAdminView] = useState<'ADMIN_TENANTS' | 'APPROVAL_DASHBOARD'>('ADMIN_TENANTS');
  // Visão da área do usuário (TENANT): dashboard, posts, agenda, memória e conta
  const [userView, setUserView] = useState<UserView>('dashboard');
  const [previewTenant, setPreviewTenant] = useState<TenantAccount | null>(null);

  // Selected Company Context in "Mídias Sincronizadas" ('ALL' = Visão Global Admin, or company name e.g. "Ato")
  const [selectedCompany, setSelectedCompany] = useState<string>('ALL');

  // Filter states
  const [activeTab, setActiveTab] = useState<FilterTab>('PENDENTES');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<CategoryFilter>('TODOS');
  const [selectedMedia, setSelectedMedia] = useState<MediaFilter>('TODOS');

  // Modals state
  const [selectedPostForApproval, setSelectedPostForApproval] = useState<PostGroup | null>(null);
  const [selectedPostForRejection, setSelectedPostForRejection] = useState<PostGroup | null>(null);
  const [postToDelete, setPostToDelete] = useState<PostGroup | null>(null);
  const [isDeletingPost, setIsDeletingPost] = useState(false);
  const [postToHide, setPostToHide] = useState<PostGroup | null>(null);
  const [isHidingPost, setIsHidingPost] = useState(false);
  const [isWebhookModalOpen, setIsWebhookModalOpen] = useState(false);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);

  // Notification state
  const [notification, setNotification] = useState<NotificationState | null>(null);

  const showNotification = (type: NotificationState['type'], message: string) => {
    setNotification({ type, message });
    setTimeout(() => {
      setNotification((curr) => (curr?.message === message ? null : curr));
    }, 4500);
  };

  const loadPosts = useCallback(async () => {
    if (!authStorage.getToken()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getPosts();
      setPosts(data.posts || []);
      if (Array.isArray(data.availableFolders)) {
        setAvailableFolders(
          data.availableFolders.filter((f) => f && f.toLowerCase() !== 'ato social midia')
        );
      }
      if (Array.isArray(data.folderDetails)) {
        setFolderDetails(
          data.folderDetails.filter((f) => f && f.nome && f.nome.toLowerCase() !== 'ato social midia')
        );
      }
      if (data.activeTenant) {
        setActiveTenant(data.activeTenant);
      }
    } catch (err: any) {
      if (err.message?.includes('401') || err.message?.includes('Token')) {
        authStorage.clearSession();
        setUser(null);
      } else {
        setError(err.message || 'Erro ao carregar dados do painel.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const navigateTo = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    setCurrentPath(path);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(window.location.pathname);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      authStorage.clearSession();
      localStorage.setItem('ato_social_jwt_token', urlToken);
      api
        .getMe()
        .then((res) => {
          if (res.user) {
            authStorage.setSession(res.token || urlToken, res.user);
            window.history.replaceState({}, document.title, window.location.pathname);
            setUser(res.user);
          } else {
            authStorage.clearSession();
            setUser(null);
          }
        })
        .catch(() => {
          authStorage.clearSession();
          setUser(null);
        });
      return;
    }

    if (authStorage.getToken()) {
      api
        .getMe()
        .then((res) => {
          if (res.user) {
            authStorage.setSession(res.token || authStorage.getToken()!, res.user);
            setUser(res.user);
          } else {
            authStorage.clearSession();
            setUser(null);
          }
        })
        .catch(() => {
          authStorage.clearSession();
          setUser(null);
        });
    }
  }, []);

  useEffect(() => {
    if (user) {
      loadPosts();
    }
  }, [user, loadPosts]);

  // Quando uma mídia não carrega de nenhuma fonte, o servidor já a marcou como indisponível:
  // recarrega a lista para o post sumir sem precisar atualizar a página.
  useEffect(() => {
    if (!user) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUnavailable = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => loadPosts(), 1500);
    };
    window.addEventListener('ato:media-unavailable', onUnavailable);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('ato:media-unavailable', onUnavailable);
    };
  }, [user, loadPosts]);

  // Listen for OAuth popup completion or error while inside the dashboard
  useEffect(() => {
    if (!user) return;
    const handleDashboardOAuthMessage = async (event: MessageEvent) => {
      if (!event.data) return;
      if (event.data.type === 'INSTAGRAM_AUTH_ERROR') {
        showNotification(
          'error',
          event.data.message || 'Não foi possível concluir a conexão. Tente novamente.'
        );
        return;
      }
      if (event.data.type === 'INSTAGRAM_AUTH_SUCCESS') {
        try {
          if (event.data.user || event.data.tenant || event.data.syncTicket) {
            await api.syncInstagramSession({
              user: event.data.user,
              tenant: event.data.tenant,
              syncTicket: event.data.syncTicket,
            });
          }
          const meRes = await api.getMe();
          if (meRes.user) {
            authStorage.setSession(meRes.token || authStorage.getToken()!, meRes.user);
            setUser(meRes.user);
          }
          await loadPosts();
          const connectedUsername =
            event.data.tenant?.username || event.data.user?.instagramUsername || 'Instagram';
          showNotification(
            'success',
            `Conta @${String(connectedUsername).replace(/^@/, '')} conectada e pronta para publicação!`
          );
        } catch (err: any) {
          showNotification('error', err.message || 'Não foi possível concluir a conexão. Tente novamente.');
        }
      }
    };
    window.addEventListener('message', handleDashboardOAuthMessage);
    return () => window.removeEventListener('message', handleDashboardOAuthMessage);
  }, [user, loadPosts]);

  // Keep selectedCompany in sync when switching between Tenant / Admin Preview / Global View
  useEffect(() => {
    if (!user) return;
    if (user.role === 'TENANT') {
      const tenantFolder =
        activeTenant?.driveFolderName ||
        (user.driveFolderName && user.driveFolderName.toLowerCase() !== 'ato social midia'
          ? user.driveFolderName
          : '');
      if (tenantFolder) {
        setSelectedCompany(tenantFolder);
      }
    } else if (previewTenant && previewTenant.driveFolderName) {
      setSelectedCompany(previewTenant.driveFolderName);
    }
  }, [user, activeTenant, previewTenant]);

  const handleLoginSuccess = (loggedInUser: UserProfile) => {
    if (!loggedInUser || !loggedInUser.role) {
      return;
    }
    setUser(loggedInUser);
    setPreviewTenant(null);
    if (loggedInUser.role === 'ADMIN') {
      setAdminView('ADMIN_TENANTS');
      setSelectedCompany('ALL');
    } else {
      setAdminView('APPROVAL_DASHBOARD');
      const cleanFolder =
        loggedInUser.driveFolderName &&
        loggedInUser.driveFolderName.toLowerCase() !== 'ato social midia'
          ? loggedInUser.driveFolderName
          : '';
      setSelectedCompany(cleanFolder || 'ALL');
    }
    showNotification('success', `Bem-vindo, ${loggedInUser.nome}!`);
  };

  const handleLogout = () => {
    localStorage.clear();
    sessionStorage.clear();
    authStorage.clearSession();
    setUser(null);
    setPreviewTenant(null);
    setSelectedCompany('ALL');
    setPosts([]);
  };

  const handleSelectTenantToPreview = (tenant: TenantAccount) => {
    setPreviewTenant(tenant);
    if (tenant.driveFolderName && tenant.driveFolderName.toLowerCase() !== 'ato social midia') {
      setSelectedCompany(tenant.driveFolderName);
    } else {
      setSelectedCompany('ALL');
    }
    setAdminView('APPROVAL_DASHBOARD');
    showNotification('info', `Visualizando pasta de @${tenant.username} (${tenant.driveFolderName || 'Global'})`);
  };

  const handleReturnToAdminTenants = () => {
    setPreviewTenant(null);
    setSelectedCompany('ALL');
    setAdminView('ADMIN_TENANTS');
  };

  const handleConfirmPublish = async (post: PostGroup, payload: InstagramPublishPayload) => {
    const res = await api.publishPost(post.id, payload);
    showNotification('success', res.message);
    await loadPosts();
  };

  const handlePublishInstagramNow = async (
    post: PostGroup,
    caption: string,
    accountId?: string
  ) => {
    const driveFileId = post.items[0]?.driveFileId || post.id;
    try {
      const res = await api.publishToInstagram({
        id: post.id,
        driveFileId,
        caption,
        accountId,
      });
      await loadPosts();
      showNotification(
        'success',
        res.message || `Publicado com sucesso no Instagram! (ID Meta: ${res.instagramMediaId})`
      );
    } catch (err: any) {
      await loadPosts();
      const errorMsg = err.message || 'Falha ao publicar no Instagram via Graph API.';
      showNotification('error', errorMsg);
      throw err;
    }
  };

  const handleConfirmReject = async (
    post: PostGroup,
    feedback: { tags: string[]; motivo: string; pastaClienteId?: string }
  ) => {
    const res = await api.rejectPost(post.id, feedback);
    showNotification('info', res.message);
    await loadPosts();
  };

  const handleConfirmDelete = async () => {
    if (!postToDelete) return;
    setIsDeletingPost(true);
    try {
      const res = await api.deletePost(postToDelete.id, { force: true, moveToTrash: true });
      setPosts((prev) => prev.filter((p) => p.id !== postToDelete.id));
      showNotification('success', res.message || 'Mídia movida para a lixeira do Drive com sucesso.');
      setPostToDelete(null);
    } catch (err: any) {
      showNotification('error', err.message || 'Erro ao excluir mídia.');
    } finally {
      setIsDeletingPost(false);
    }
  };

  const handleConfirmHide = async () => {
    if (!postToHide) return;
    setIsHidingPost(true);
    try {
      const res = await api.hidePost(postToHide.id);
      showNotification('success', res.message || 'Post apagado do seu painel com sucesso.');
      setPostToHide(null);
      await loadPosts();
    } catch (err: any) {
      showNotification('error', err.message || 'Erro ao apagar post.');
    } finally {
      setIsHidingPost(false);
    }
  };

  const handleUnhidePost = async (post: PostGroup) => {
    try {
      const res = await api.unhidePost(post.id);
      showNotification('success', res.message || `Post "${post.nome}" restaurado com sucesso!`);
      await loadPosts();
    } catch (err: any) {
      showNotification('error', err.message || 'Erro ao restaurar post.');
    }
  };

  // Área do usuário: reprovar continua alimentando a memória (rejectPost) e depois
  // leva o post para "Não vou postar", em vez de ficar só como reprovado.
  const handleUserReject = async (
    post: PostGroup,
    feedback: { tags: string[]; motivo: string; pastaClienteId?: string }
  ) => {
    await handleConfirmReject(post, feedback);
    await api.organizePost(post.id, 'NAO_VOU_POSTAR');
    await loadPosts();
  };

  // Área do usuário: apagar do sistema = ocultar do painel (restaurável). Não apaga no Instagram.
  const handleUserHide = async (post: PostGroup) => {
    const res = await api.hidePost(post.id);
    showNotification('success', res.message || 'Post apagado do seu painel.');
    await loadPosts();
  };

  const handleSyncDriveNow = async () => {
    setSyncingDrive(true);
    showNotification('info', 'Atualizando conteúdos...');
    try {
      const res = await api.syncDriveNow();
      const lotes = Array.isArray(res.lotes) ? res.lotes : [];
      console.log('Lotes recebidos:', lotes);
      const totalArquivos = lotes.reduce(
        (acc: number, lote: any) => acc + (Array.isArray(lote?.arquivos) ? lote.arquivos.length : 0),
        0
      );
      const totalPastas = Array.isArray(res.pastas)
        ? res.pastas.length
        : Array.isArray(res.folders)
        ? res.folders.length
        : 0;

      await loadPosts();
      setSyncRefreshKey((k) => k + 1);
      showNotification(
        'success',
        `Atualização concluída com sucesso (${totalPastas} empresa(s), ${totalArquivos} conteúdo(s)).`
      );
    } catch (err: any) {
      showNotification('error', err.message || 'Falha ao atualizar conteúdos.');
    } finally {
      setSyncingDrive(false);
    }
  };

  const handleResetDemo = async () => {
    try {
      const res = await api.resetDemo();
      showNotification('info', res.message);
      await loadPosts();
    } catch (err: any) {
      showNotification('error', err.message || 'Erro ao sincronizar.');
    }
  };

  // Build unique list of valid client folders (never including the root folder "ATO Social Midia")
  const companyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const f of availableFolders) {
      if (f && f.trim() && f.trim().toLowerCase() !== 'ato social midia') {
        set.add(f.trim());
      }
    }
    for (const p of posts) {
      const folder = (p.pastaClienteNome || p.driveFolderName || '').trim();
      if (folder && folder.toLowerCase() !== 'ato social midia') {
        set.add(folder);
      }
    }
    if (
      previewTenant?.driveFolderName &&
      previewTenant.driveFolderName.toLowerCase() !== 'ato social midia'
    ) {
      set.add(previewTenant.driveFolderName.trim());
    }
    return Array.from(set);
  }, [availableFolders, posts, previewTenant]);

  // Determine the effective company filter
  const effectiveCompanyFilter = useMemo(() => {
    if (!user) return 'ALL';
    if (user.role === 'TENANT') {
      const tenantFolder =
        activeTenant?.driveFolderName ||
        (user.driveFolderName && user.driveFolderName.toLowerCase() !== 'ato social midia'
          ? user.driveFolderName
          : '');
      return tenantFolder || user.tenantId || 'ALL';
    }
    // Admin view: use selectedCompany ('ALL' or specific company name like 'Ato')
    return selectedCompany || 'ALL';
  }, [user, activeTenant, selectedCompany]);

  // All posts belonging to the selected company context (used for stats & tab counters)
  const companyScopedPosts = useMemo(() => {
    return filterPosts(posts, 'TODOS', '', effectiveCompanyFilter);
  }, [posts, effectiveCompanyFilter]);

  const computedStats = useMemo(() => {
    return {
      total: companyScopedPosts.length,
      pendentes: companyScopedPosts.filter((p) => p.status === 'PENDENTE' || p.status === 'APROVADO').length,
      agendados: companyScopedPosts.filter((p) => p.status === 'AGENDADO').length,
      publicados: companyScopedPosts.filter((p) => p.status === 'PUBLICADO').length,
      reprovados: companyScopedPosts.filter((p) => p.status === 'REPROVADO').length,
    };
  }, [companyScopedPosts]);

  // Posts filtered by company context + active status tab + search query + category sub-filter
  const filteredPosts = useMemo(() => {
    return filterPosts(posts, activeTab, searchQuery, effectiveCompanyFilter, selectedCategory, selectedMedia);
  }, [posts, activeTab, searchQuery, effectiveCompanyFilter, selectedCategory, selectedMedia]);

  // Resolve folder ID for the currently selected company
  const selectedCompanyFolderId = useMemo(() => {
    if (effectiveCompanyFilter && effectiveCompanyFilter !== 'ALL') {
      const found = folderDetails.find(
        (f) => f.nome.toLowerCase() === effectiveCompanyFilter.toLowerCase()
      );
      if (found) return found.id;
    }
    return (
      previewTenant?.driveFolderId ||
      activeTenant?.driveFolderId ||
      user?.driveFolderId ||
      undefined
    );
  }, [effectiveCompanyFilter, folderDetails, previewTenant, activeTenant, user]);

  // Public routes required by Meta App Review (accessible without login)
  const legalRoute = resolveLegalRoute(currentPath);
  if (legalRoute) {
    return <PublicLegalPage route={legalRoute} onNavigate={navigateTo} />;
  }

  // If not authenticated, show single centered card Login
  if (!user) {
    return <LoginView onLoginSuccess={handleLoginSuccess} onNavigateLegal={navigateTo} />;
  }

  const effectiveTenantFolderName =
    activeTenant?.driveFolderName ||
    (user.driveFolderName && user.driveFolderName.toLowerCase() !== 'ato social midia'
      ? user.driveFolderName
      : null);

  // If logged in as client and status is PENDENTE / AGUARDANDO_APROVACAO (or no valid client drive folder), lock in WaitingRoom
  if (
    user.role === 'TENANT' &&
    (user.status === 'PENDENTE' ||
      user.status === 'AGUARDANDO_APROVACAO' ||
      !effectiveTenantFolderName)
  ) {
    return (
      <WaitingRoom
        user={user}
        onLogout={handleLogout}
        onStatusApproved={(approvedUser) => {
          setUser(approvedUser);
          loadPosts();
          showNotification('success', `Acesso liberado!`);
        }}
      />
    );
  }

  const isAdmin = user.role === 'ADMIN';
  const showAdminTenants = isAdmin && adminView === 'ADMIN_TENANTS';

  const activeCompanyLabel =
    effectiveCompanyFilter === 'ALL'
      ? 'Todas as Empresas (Visão Global)'
      : effectiveCompanyFilter;

  // Área do usuário (TENANT conectado pelo Instagram). O admin segue no painel abaixo, inalterado.
  if (!isAdmin) {
    return (
      <UserLayout user={user} view={userView} onChangeView={setUserView} onLogout={handleLogout}>
        {userView === 'dashboard' && <UserDashboard posts={posts} />}
        {userView === 'historico' && <HistoryView posts={posts} />}
        {userView === 'posts' && (
          <PostsView
            posts={posts}
            folderName={effectiveTenantFolderName || ''}
            onChanged={loadPosts}
            onConfirmPublish={handleConfirmPublish}
            onPublishInstagramNow={handlePublishInstagramNow}
            onConfirmReject={handleUserReject}
            onHide={handleUserHide}
            onUnhide={handleUnhidePost}
          />
        )}
        {userView === 'agenda' && <AgendaView posts={posts} />}
        {userView === 'memoria' && (
          <MemoryView
            companyName={user.nome}
            driveFolderName={effectiveTenantFolderName || undefined}
          />
        )}
        {userView === 'conta' && <AccountView user={user} onAccountDeleted={handleLogout} />}
      </UserLayout>
    );
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#FFFFFF] flex flex-col font-sans antialiased">
      {/* Header */}
      <Header
        user={user}
        onLogout={handleLogout}
        onOpenWebhookModal={handleSyncDriveNow}
        onResetDemo={handleResetDemo}
        isSyncing={syncingDrive || loading}
        currentView={adminView}
        onNavigateView={(view) => {
          setAdminView(view);
          if (view === 'ADMIN_TENANTS') {
            setPreviewTenant(null);
          } else if (view === 'APPROVAL_DASHBOARD' && !previewTenant) {
            setSelectedCompany('ALL');
          }
        }}
      />

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 md:px-8 py-8">
        {showAdminTenants ? (
          <AdminTenantsView
            currentUser={user}
            onSelectTenantToPreview={handleSelectTenantToPreview}
            onOpenWebhookModal={handleSyncDriveNow}
            refreshTrigger={syncRefreshKey}
          />
        ) : (
          <div>
            {/* Admin Impersonation Notice if previewing a specific tenant */}
            {isAdmin && previewTenant && (
              <div className="mb-6 p-3 bg-[#121212] border border-[#242424] rounded-lg flex items-center justify-between">
                <span className="text-xs text-[#8E8E93]">
                  Visualizando mídias de <strong className="text-white">@{previewTenant.username}</strong> (Empresa:{' '}
                  <span className="text-[#10B981] font-mono">{previewTenant.driveFolderName}</span>)
                </span>
                <button
                  type="button"
                  onClick={handleReturnToAdminTenants}
                  className="text-xs text-[#10B981] hover:underline cursor-pointer"
                >
                  Voltar para Contas
                </button>
              </div>
            )}

            {/* Dashboard Header Title & Company Context Selector */}
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6">
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight">
                  {user.role === 'TENANT'
                    ? `Olá, ${user.nome}`
                    : previewTenant
                    ? `Mídias de @${previewTenant.username}`
                    : `Mídias Sincronizadas`}
                </h1>
                <p className="text-xs text-[#8E8E93] mt-0.5">
                  Empresa selecionada:{' '}
                  <span className="font-mono text-[#10B981] font-medium">{activeCompanyLabel}</span> · Os
                  novos conteúdos são atualizados automaticamente.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 self-start lg:self-auto">
                {/* Company Selector (<select>) for Admin / Multi-company context */}
                {isAdmin && (
                  <div className="flex items-center gap-2 bg-[#121212] border border-[#242424] rounded-lg px-3 py-1.5">
                    <label htmlFor="company-context-select" className="text-xs text-[#8E8E93] whitespace-nowrap">
                      Empresa:
                    </label>
                    <select
                      id="company-context-select"
                      value={selectedCompany}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedCompany(val);
                        if (val === 'ALL') {
                          setPreviewTenant(null);
                        }
                      }}
                      className="bg-[#0A0A0A] border border-[#2E2E2E] focus:border-[#10B981] rounded-md px-2.5 py-1 text-xs text-white font-mono outline-none cursor-pointer"
                    >
                      <option value="ALL">Todas as Empresas (Global)</option>
                      {companyOptions.map((folderName) => (
                        <option key={folderName} value={folderName}>
                          {folderName}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const targetTenantId = previewTenant?.id || activeTenant?.id || user?.tenantId;
                      const targetFolder =
                        effectiveCompanyFilter && effectiveCompanyFilter !== 'ALL'
                          ? effectiveCompanyFilter
                          : activeTenant?.driveFolderName || user?.driveFolderName || undefined;
                      const authRes = await api.getInstagramAuthUrl(
                        window.location.origin,
                        targetTenantId,
                        targetFolder
                      );
                      if (authRes?.url) {
                        const popup = window.open(
                          authRes.url,
                          'InstagramDashboardConnect',
                          'width=600,height=700,left=200,top=100'
                        );
                        if (!popup) {
                          window.location.href = authRes.url;
                        } else {
                          showNotification(
                            'info',
                            'Conclua a autorização oficial na janela do Instagram para vincular a conta.'
                          );
                        }
                      }
                    } catch (err: any) {
                      showNotification('error', err.message || 'Erro ao iniciar conexão com o Instagram.');
                    }
                  }}
                  className="px-3.5 py-2 bg-gradient-to-r from-[#833AB4] via-[#FD1D1D] to-[#F77737] hover:opacity-95 text-white font-medium text-xs rounded-lg transition-opacity cursor-pointer flex items-center gap-1.5 shadow-md"
                >
                  <Instagram className="w-3.5 h-3.5 text-white shrink-0" />
                  <span>Reconectar Instagram</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsUploadModalOpen(true)}
                  className="px-3.5 py-2 bg-[#1A1A1A] hover:bg-[#222222] border border-[#2E2E2E] text-white font-medium text-xs rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
                >
                  <span>+ Enviar Nova Mídia</span>
                </button>
              </div>
            </div>

            {/* Max 3 Essential Indicators (Only clean text and numbers) */}
            <section aria-label="Indicadores" className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
              <div className="bg-[#121212] border border-[#242424] rounded-xl p-4">
                <span className="text-xs text-[#8E8E93] block mb-1">Pendentes / Prontos</span>
                <div className="text-2xl font-bold text-white font-mono tabular-nums">{computedStats.pendentes}</div>
              </div>

              <div className="bg-[#121212] border border-[#242424] rounded-xl p-4">
                <span className="text-xs text-[#8E8E93] block mb-1">Agendados</span>
                <div className="text-2xl font-bold text-white font-mono tabular-nums">{computedStats.agendados}</div>
              </div>

              <div className="bg-[#121212] border border-[#242424] rounded-xl p-4">
                <span className="text-xs text-[#8E8E93] block mb-1">Publicados</span>
                <div className="text-2xl font-bold text-white font-mono tabular-nums">{computedStats.publicados}</div>
              </div>
            </section>

            {/* Seção Sugestões para as Próximas Artes (Memória Criativa Inteligente por Cliente) */}
            {(user.role === 'TENANT' || effectiveCompanyFilter !== 'ALL') && (
              <ClientObservationsView
                companyName={effectiveCompanyFilter !== 'ALL' ? effectiveCompanyFilter : user.driveFolderName || user.nome}
                companyId={selectedCompanyFolderId || (user.role === 'TENANT' ? user.tenantId : undefined)}
                driveFolderName={effectiveCompanyFilter !== 'ALL' ? effectiveCompanyFilter : user.driveFolderName || undefined}
                isAdmin={user.role === 'ADMIN'}
              />
            )}

            {/* Filter Bar with Tabs, Search, and Category Sub-Filters */}
            <FilterBar
              activeTab={activeTab}
              onTabChange={setActiveTab}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              selectedCategory={selectedCategory}
              onCategoryChange={setSelectedCategory}
              selectedMedia={selectedMedia}
              onMediaChange={setSelectedMedia}
              stats={computedStats}
            />

            {/* Error Notification */}
            {error && (
              <div className="my-4 p-3 bg-red-950/30 border border-[#EF4444]/40 rounded-lg text-[#EF4444] text-xs flex items-center justify-between">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={loadPosts}
                  className="underline hover:text-white"
                >
                  Tentar novamente
                </button>
              </div>
            )}

            {/* Posts Grid or Sober Empty State */}
            <section aria-label="Mídias" className="mt-4">
              {loading && posts.length === 0 ? (
                <div className="py-20 text-center text-xs text-[#8E8E93]">
                  Carregando mídias...
                </div>
              ) : filteredPosts.length === 0 ? (
                /* Sober and direct empty state as demanded */
                <div className="bg-[#121212] border border-[#242424] rounded-xl p-12 text-center space-y-2">
                  <p className="text-sm font-medium text-[#8E8E93]">
                    {searchQuery
                      ? `Nenhum resultado para "${searchQuery}".`
                      : selectedCategory !== 'TODOS'
                      ? `Nenhuma mídia na categoria "${selectedCategory}" para este filtro.`
                      : effectiveCompanyFilter === 'ALL'
                      ? 'Nenhuma mídia encontrada com este status no momento.'
                      : `Nenhuma mídia pendente para a empresa "${effectiveCompanyFilter}".`}
                  </p>
                  {selectedCategory !== 'TODOS' && (
                    <button
                      type="button"
                      onClick={() => setSelectedCategory('TODOS')}
                      className="text-xs text-[#10B981] hover:underline cursor-pointer mr-4"
                    >
                      Mostrar todas as categorias
                    </button>
                  )}
                  {isAdmin && effectiveCompanyFilter !== 'ALL' && posts.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCompany('ALL');
                        setPreviewTenant(null);
                      }}
                      className="text-xs text-[#10B981] hover:underline cursor-pointer"
                    >
                      Ver mídias de todas as empresas ({posts.length})
                    </button>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredPosts.map((post) => (
                    <PostCard
                      key={post.id}
                      post={post}
                      onApprove={(p) => setSelectedPostForApproval(p)}
                      onReject={(p) => setSelectedPostForRejection(p)}
                      onDelete={(p) => setPostToDelete(p)}
                      onHide={(p) => setPostToHide(p)}
                      onUnhide={(p) => handleUnhidePost(p)}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[#242424] py-5 px-4 md:px-8 mt-12 text-center text-xs text-[#8E8E93]">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-white">ATO.</span>
            <span>Social Media Approval Hub</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href="/privacidade"
              onClick={(e) => {
                e.preventDefault();
                navigateTo('/privacidade');
              }}
              className="hover:text-white transition-colors"
            >
              Política de Privacidade
            </a>
            <span>·</span>
            <a
              href="/termos"
              onClick={(e) => {
                e.preventDefault();
                navigateTo('/termos');
              }}
              className="hover:text-white transition-colors"
            >
              Termos de Uso
            </a>
            <span>·</span>
            <a
              href="/exclusao-de-dados"
              onClick={(e) => {
                e.preventDefault();
                navigateTo('/exclusao-de-dados');
              }}
              className="hover:text-white transition-colors"
            >
              Exclusão de Dados
            </a>
          </div>
        </div>
      </footer>

      {/* Modals */}
      {selectedPostForApproval && (
        <ApprovalModal
          post={selectedPostForApproval}
          isOpen={!!selectedPostForApproval}
          onClose={() => setSelectedPostForApproval(null)}
          onConfirmPublish={handleConfirmPublish}
          onPublishInstagramNow={handlePublishInstagramNow}
        />
      )}

      {selectedPostForRejection && (
        <RejectionModal
          post={selectedPostForRejection}
          isOpen={!!selectedPostForRejection}
          onClose={() => setSelectedPostForRejection(null)}
          onConfirmReject={handleConfirmReject}
          pastaClienteId={
            selectedPostForRejection.pastaClienteId ||
            selectedCompanyFolderId ||
            (user.role === 'TENANT' ? user.tenantId : undefined)
          }
        />
      )}

      {isWebhookModalOpen && (
        <WebhookSimulatorModal
          isOpen={isWebhookModalOpen}
          onClose={() => setIsWebhookModalOpen(false)}
          onSyncSuccess={async () => {
            await loadPosts();
            setSyncRefreshKey((k) => k + 1);
            showNotification('success', 'Mídias sincronizadas com sucesso.');
          }}
        />
      )}

      {isUploadModalOpen && (
        <UploadMediaModal
          isOpen={isUploadModalOpen}
          onClose={() => setIsUploadModalOpen(false)}
          onUploadSuccess={async () => {
            await loadPosts();
            showNotification('success', 'Mídia enviada ao Google Drive e aprovada para agendamento/publicação!');
          }}
          folderName={
            effectiveCompanyFilter !== 'ALL'
              ? effectiveCompanyFilter
              : companyOptions[0] || 'Ato'
          }
          availableFolders={companyOptions}
        />
      )}

      {/* Exclusão Segura de Criativo (Lixeira do Google Drive + Remoção no DB) */}
      {postToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !isDeletingPost && setPostToDelete(null)}
        >
          <div
            className="bg-[#121212] border border-[#242424] rounded-xl max-w-md w-full p-5 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-red-950/50 border border-[#EF4444]/40 flex items-center justify-center shrink-0 text-[#EF4444]">
                <Trash2 className="w-4 h-4" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-white">Mover criativo para a lixeira?</h3>
                <p className="text-xs text-[#8E8E93] leading-relaxed">
                  Essa ação removerá o arquivo do Google Drive e do sistema.
                </p>
              </div>
            </div>

            {(postToDelete.status === 'AGENDADO' || postToDelete.status === 'PUBLICANDO') && (
              <div className="p-3 bg-amber-950/40 border border-[#F59E0B]/50 rounded-lg text-xs text-[#F59E0B] flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <strong>Atenção:</strong> Este criativo possui agendamento ativo
                  {postToDelete.scheduledAt ? ` para ${formatDateTimeBR(postToDelete.scheduledAt)}` : ''}.
                  A exclusão cancelará a publicação programada.
                </span>
              </div>
            )}

            <div className="pt-2 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setPostToDelete(null)}
                disabled={isDeletingPost}
                className="px-3.5 py-2 text-xs text-[#8E8E93] hover:text-white rounded-lg border border-[#262626] hover:bg-[#1A1A1A] cursor-pointer disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeletingPost}
                className="px-4 py-2 bg-[#EF4444] hover:bg-[#DC2626] text-white font-semibold text-xs rounded-lg cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{isDeletingPost ? 'Excluindo...' : 'Excluir mídia'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal for Apagar Post (Hides for client, keeps for admin with badge) */}
      {postToHide && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 font-sans"
          onClick={() => !isHidingPost && setPostToHide(null)}
        >
          <div
            className="bg-[#121212] border border-[#242424] rounded-xl max-w-md w-full p-5 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-red-950/50 border border-[#EF4444]/40 flex items-center justify-center shrink-0 text-[#EF4444]">
                <Trash2 className="w-4 h-4" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-white">Apagar post do seu painel?</h3>
                <p className="text-xs text-[#8E8E93] leading-relaxed">
                  Este post deixará de ser exibido no seu painel. O arquivo original no Google Drive <strong>permanecerá seguro</strong> no acervo oficial.
                </p>
              </div>
            </div>

            {postToHide.status === 'AGENDADO' && (
              <div className="p-3 bg-amber-950/40 border border-[#F59E0B]/50 rounded-lg text-xs text-[#F59E0B] flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  <strong>Atenção:</strong> Este criativo possui um agendamento ativo. Ao apagar, a publicação programada será cancelada com segurança.
                </span>
              </div>
            )}

            <div className="pt-2 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setPostToHide(null)}
                disabled={isHidingPost}
                className="px-3.5 py-2 text-xs text-[#8E8E93] hover:text-white rounded-lg border border-[#262626] hover:bg-[#1A1A1A] cursor-pointer disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmHide}
                disabled={isHidingPost}
                className="px-4 py-2 bg-[#EF4444] hover:bg-[#DC2626] text-white font-semibold text-xs rounded-lg cursor-pointer disabled:opacity-50 flex items-center gap-1.5 shadow-md"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{isHidingPost ? 'Apagando...' : 'Apagar post'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notification Toast */}
      <NotificationBanner
        notification={notification}
        onDismiss={() => setNotification(null)}
      />
    </div>
  );
}
