import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api.ts';
import { TenantAccount, UserProfile, AdminAlertNotification } from '../types/index.ts';
import {
  Database,
  HardDrive,
  Instagram,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Search,
  CheckSquare,
  Square,
  Activity,
  Layers,
  Settings,
  Trash2,
} from 'lucide-react';

interface AdminTenantsViewProps {
  currentUser: UserProfile;
  onSelectTenantToPreview: (tenant: TenantAccount) => void;
  onOpenWebhookModal: () => void;
  refreshTrigger?: number;
}

export const AdminTenantsView: React.FC<AdminTenantsViewProps> = ({
  onSelectTenantToPreview,
  refreshTrigger = 0,
}) => {
  const [tenants, setTenants] = useState<TenantAccount[]>([]);
  const [adminAlerts, setAdminAlerts] = useState<AdminAlertNotification[]>([]);
  const [availableFolders, setAvailableFolders] = useState<string[]>([]);
  const [folderDetailsMap, setFolderDetailsMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [syncingDrive, setSyncingDrive] = useState(false);
  const [refreshingTokenId, setRefreshingTokenId] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Selected folder per pending tenant: tenantId -> selectedFolderName
  const [pendingFolders, setPendingFolders] = useState<Record<string, string>>({});
  const [approvingId, setApprovingId] = useState<string | null>(null);

  // Edit folder modal state
  const [editingTenant, setEditingTenant] = useState<TenantAccount | null>(null);
  const [editFolderSelect, setEditFolderSelect] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Integration status & testing state
  const [integrationsStatus, setIntegrationsStatus] = useState<any>(null);
  const [testingService, setTestingService] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string; latencyMs?: number }>>({});

  // Reset modal state
  const [isTestResetModalOpen, setIsTestResetModalOpen] = useState(false);
  const [testResetPreview, setTestResetPreview] = useState<any>(null);
  const [loadingTestResetPreview, setLoadingTestResetPreview] = useState(false);
  const [selectedResetIds, setSelectedResetIds] = useState<Set<string>>(new Set());
  const [resetSearch, setResetSearch] = useState('');
  const [executingTestReset, setExecutingTestReset] = useState(false);

  const notify = (type: 'success' | 'error' | 'info', message: string) => {
    setNotification({ type, message });
    setTimeout(() => {
      setNotification((curr) => (curr?.message === message ? null : curr));
    }, 4500);
  };

  const loadIntegrationsStatus = useCallback(async () => {
    try {
      const res = await api.getIntegrationsStatus();
      setIntegrationsStatus(res);
    } catch {
      // ignore
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [tenantsRes, foldersRes] = await Promise.all([
        api.getTenants(),
        api.getDriveFolders(),
      ]);
      setTenants(tenantsRes.tenants);
      setAdminAlerts(Array.isArray(tenantsRes.adminAlerts) ? tenantsRes.adminAlerts : []);
      setAvailableFolders(foldersRes.folders);

      if (foldersRes.folderDetails) {
        const map: Record<string, string> = {};
        for (const item of foldersRes.folderDetails) {
          map[item.nome] = item.id;
        }
        setFolderDetailsMap(map);
      }
      await loadIntegrationsStatus();
    } catch (err: any) {
      notify('error', err.message || 'Erro ao carregar lista de contas e pastas.');
    } finally {
      setLoading(false);
    }
  }, [loadIntegrationsStatus]);

  useEffect(() => {
    loadData();
  }, [refreshTrigger, loadData]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reconnectedUser = params.get('reconnected');
    if (reconnectedUser) {
      window.history.replaceState({}, document.title, window.location.pathname);
      notify(
        'success',
        `Conta @${reconnectedUser.replace(/^@/, '')} reconectada com sucesso! Token longo de 60 dias salvo no PostgreSQL.`
      );
      loadData();
    }

    const handleOAuthMessage = async (event: MessageEvent) => {
      if (!event.data) return;
      if (event.data.type === 'INSTAGRAM_AUTH_ERROR') {
        notify(
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
          const uname =
            event.data.tenant?.username ||
            event.data.user?.instagramUsername ||
            'Instagram';
          notify(
            'success',
            `Conta @${String(uname).replace(/^@/, '')} conectada com sucesso! Token longo de 60 dias criptografado e salvo no PostgreSQL.`
          );
          await loadData();
        } catch (err: any) {
          notify('error', err.message || 'Erro ao sincronizar conexão do Instagram.');
        }
      }
    };

    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [loadData]);

  const handleTestIntegration = async (service: 'postgres' | 'drive' | 'instagram' | 'gemini') => {
    setTestingService(service);
    try {
      let res: any;
      if (service === 'postgres') res = await api.testPostgresIntegration();
      else if (service === 'drive') res = await api.testDriveIntegration();
      else if (service === 'instagram') res = await api.testInstagramIntegration();
      else if (service === 'gemini') res = await api.testGeminiIntegration();

      setTestResults((prev) => ({
        ...prev,
        [service]: {
          success: res.success,
          message: res.message,
          latencyMs: res.latencyMs,
        },
      }));
      notify(res.success ? 'success' : 'error', res.message);
      await loadIntegrationsStatus();
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [service]: {
          success: false,
          message: err.message || 'Falha ao testar serviço',
        },
      }));
      notify('error', err.message || 'Falha ao testar integração.');
    } finally {
      setTestingService(null);
    }
  };

  const [resetModalError, setResetModalError] = useState<string | null>(null);

  const handleOpenTestResetModal = async () => {
    setIsTestResetModalOpen(true);
    setLoadingTestResetPreview(true);
    setResetModalError(null);
    try {
      const res = await api.getTestRecordsPreview();
      setTestResetPreview(res);
      const allCandidateIds = (res.candidates || []).map((c: any) => c.id);
      setSelectedResetIds(new Set(allCandidateIds));
    } catch (err: any) {
      setResetModalError(err.message || 'Erro ao carregar prévia de testes.');
      notify('error', err.message || 'Erro ao carregar prévia de testes.');
    } finally {
      setLoadingTestResetPreview(false);
    }
  };

  const handleExecuteTestReset = async () => {
    if (selectedResetIds.size === 0) {
      notify('error', 'Selecione ao menos uma postagem para resetar.');
      return;
    }
    setExecutingTestReset(true);
    setResetModalError(null);
    try {
      const res = await api.resetTestRecords({
        confirm: true,
        scope: 'SELECTED_IDS',
        selectedIds: Array.from(selectedResetIds),
      });
      if (res && res.success) {
        notify('success', res.message || 'Postagens resetadas com sucesso para o estado Pendente!');
        setIsTestResetModalOpen(false);
        await loadData();
      } else {
        const errMsg = res?.message || 'Falha ao executar reset no banco de dados.';
        setResetModalError(errMsg);
        notify('error', errMsg);
      }
    } catch (err: any) {
      const errMsg = err.message || 'Erro de comunicação ao executar reset de postagens.';
      setResetModalError(errMsg);
      notify('error', errMsg);
    } finally {
      setExecutingTestReset(false);
    }
  };

  const handleToggleResetId = (id: string) => {
    setSelectedResetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const candidatesList = (testResetPreview?.candidates || []) as any[];
  const filteredCandidates = candidatesList.filter((c) => {
    if (!resetSearch.trim()) return true;
    const term = resetSearch.toLowerCase();
    return (
      (c.nome && c.nome.toLowerCase().includes(term)) ||
      (c.loteNome && c.loteNome.toLowerCase().includes(term)) ||
      (c.driveFolderName && c.driveFolderName.toLowerCase().includes(term)) ||
      (c.status && c.status.toLowerCase().includes(term))
    );
  });

  const handleSelectAllFiltered = () => {
    const filteredIds = filteredCandidates.map((c) => c.id);
    const allSelected = filteredIds.every((id) => selectedResetIds.has(id));
    setSelectedResetIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        filteredIds.forEach((id) => next.delete(id));
      } else {
        filteredIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const handleSyncDrive = async () => {
    setSyncingDrive(true);
    notify('info', 'Sincronizando com o Drive...');
    try {
      const syncRes = await api.syncDriveNow();
      const lotes = Array.isArray(syncRes.lotes) ? syncRes.lotes : [];
      const totalArquivos = lotes.reduce(
        (acc: number, lote: any) => acc + (Array.isArray(lote?.arquivos) ? lote.arquivos.length : 0),
        0
      );
      const totalPastas = Array.isArray(syncRes.pastas)
        ? syncRes.pastas.length
        : Array.isArray(syncRes.folders)
        ? syncRes.folders.length
        : 0;

      await loadData();
      notify(
        'success',
        `Sincronização concluída com sucesso (${totalPastas} pasta(s), ${totalArquivos} criativo(s)).`
      );
    } catch (err: any) {
      notify('error', err.message || 'Falha ao sincronizar com o Google Drive.');
    } finally {
      setSyncingDrive(false);
    }
  };

  const handleReconnectInstagram = async (targetTenantId?: string, driveFolderName?: string) => {
    try {
      const authRes = await api.getInstagramAuthUrl(
        window.location.origin,
        typeof targetTenantId === 'string' ? targetTenantId : undefined,
        typeof driveFolderName === 'string' ? driveFolderName : undefined
      );
      if (authRes?.url) {
        const popup = window.open(
          authRes.url,
          'InstagramReconnectAuth',
          'width=600,height=700,left=200,top=100'
        );
        if (!popup) {
          window.location.href = authRes.url;
        } else {
          notify('info', 'Conclua a autorização oficial na janela do Instagram para conectar a conta.');
        }
      }
    } catch (err: any) {
      notify('error', err.message || 'Falha ao obter URL de conexão OAuth.');
    }
  };

  const handleRefreshToken = async (tenant: TenantAccount) => {
    setRefreshingTokenId(tenant.id);
    try {
      const res = await api.refreshTenantToken(tenant.id);
      const msg = res.detail?.message || 'Verificação de renovação preventiva concluída.';
      notify(res.detail?.action === 'REFRESHED' ? 'success' : 'info', msg);
      await loadData();
    } catch (err: any) {
      notify('error', err.message || 'Falha ao renovar token.');
    } finally {
      setRefreshingTokenId(null);
    }
  };

  const handleResolveAlert = async (alertId: string) => {
    try {
      await api.resolveAdminAlert(alertId);
      setAdminAlerts((prev) => prev.filter((a) => a.id !== alertId));
    } catch {}
  };

  const pendingTenants = tenants.filter(
    (t) => t.status === 'PENDENTE' || t.status === 'AGUARDANDO_APROVACAO' || !t.driveFolderName
  );
  const activeTenants = tenants.filter(
    (t) =>
      t.status !== 'PENDENTE' &&
      t.status !== 'AGUARDANDO_APROVACAO' &&
      Boolean(t.driveFolderName)
  );

  const handleApprove = async (tenant: TenantAccount) => {
    const selectedFolder = pendingFolders[tenant.id];
    if (!selectedFolder || !selectedFolder.trim()) {
      notify('error', 'Selecione a empresa antes de aprovar.');
      return;
    }

    setApprovingId(tenant.id);
    try {
      const cleanName = selectedFolder.trim();
      const realFolderId = folderDetailsMap[cleanName] || cleanName;
      const res = await api.approveTenant(tenant.id, {
        driveFolderName: cleanName,
        driveFolderId: realFolderId,
      });
      notify('success', res.message);
      await loadData();
    } catch (err: any) {
      notify('error', err.message || 'Erro ao aprovar conta.');
    } finally {
      setApprovingId(null);
    }
  };

  const handleRevoke = async (tenant: TenantAccount) => {
    try {
      const res = await api.revokeTenant(tenant.id);
      notify('success', res.message);
      await loadData();
    } catch (err: any) {
      notify('error', err.message || 'Erro ao revogar acesso.');
    }
  };

  const handleSaveEditFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTenant || !editFolderSelect) return;

    setIsSaving(true);
    try {
      const res = await api.updateTenant(editingTenant.id, {
        driveFolderName: editFolderSelect,
      });
      notify('success', res.message);
      setEditingTenant(null);
      await loadData();
    } catch (err: any) {
      notify('error', err.message || 'Erro ao atualizar pasta vinculada.');
    } finally {
      setIsSaving(false);
    }
  };

  const isPgOk = integrationsStatus?.postgres?.connected ?? true;
  const isDriveOk = integrationsStatus?.googleDrive?.connected ?? true;
  const isIgOk = integrationsStatus?.instagram?.configured ?? true;
  const isGeminiOk = integrationsStatus?.gemini?.connected ?? true;

  return (
    <div className="space-y-8 font-sans">
      {/* Toast Notification */}
      {notification && (
        <div
          className={`p-3 rounded-lg text-xs flex items-center justify-between border ${
            notification.type === 'success'
              ? 'bg-[#121212] border-[#10B981]/40 text-[#10B981]'
              : notification.type === 'info'
              ? 'bg-[#121212] border-[#2E2E2E] text-white'
              : 'bg-[#121212] border-[#EF4444]/40 text-[#EF4444]'
          }`}
        >
          <span>{notification.message}</span>
          <button
            type="button"
            onClick={() => setNotification(null)}
            className="text-xs opacity-70 hover:opacity-100 cursor-pointer"
          >
            Fechar
          </button>
        </div>
      )}

      {/* Admin Alerts Banner */}
      {adminAlerts.length > 0 && (
        <div className="space-y-2">
          {adminAlerts.map((alert) => (
            <div
              key={alert.id}
              className="p-3.5 bg-amber-950/30 border border-[#F59E0B]/40 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
            >
              <div className="text-[#FDE68A]">
                <span className="font-semibold text-[#F59E0B] mr-2">
                  [{alert.type === 'RECONEXAO_NECESSARIA' ? 'Reconexão OAuth' : 'Alerta'}]
                </span>
                <span>{alert.message}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {alert.type === 'RECONEXAO_NECESSARIA' && (
                  <button
                    type="button"
                    onClick={() => handleReconnectInstagram(alert.tenantId)}
                    className="px-3 py-1 bg-[#F59E0B] hover:bg-[#D97706] text-[#0A0A0A] font-semibold rounded-lg cursor-pointer"
                  >
                    Reconectar
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleResolveAlert(alert.id)}
                  className="px-2.5 py-1 bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E] text-[#8E8E93] hover:text-white rounded-lg cursor-pointer"
                >
                  Dispensar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            Painel de Controle e Integrações
          </h1>
          <p className="text-xs text-[#8E8E93] mt-0.5">
            Sincronização e monitoramento contínuo com o PostgreSQL, Google Drive e Instagram.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => handleReconnectInstagram()}
            className="px-3.5 py-1.5 bg-gradient-to-r from-[#833AB4] via-[#FD1D1D] to-[#F77737] hover:opacity-95 text-white font-semibold text-xs rounded-lg transition-opacity cursor-pointer flex items-center gap-1.5 shadow-md"
          >
            <Instagram className="w-3.5 h-3.5 text-white shrink-0" />
            Conectar Instagram
          </button>
          <button
            type="button"
            onClick={handleSyncDrive}
            disabled={syncingDrive || loading}
            className="px-3.5 py-1.5 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-xs rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
          >
            <HardDrive className="w-3.5 h-3.5" />
            {syncingDrive ? 'Sincronizando...' : 'Sincronizar Drive'}
          </button>
          <button
            type="button"
            onClick={handleOpenTestResetModal}
            className="px-3.5 py-1.5 bg-[#1A1A1A] hover:bg-[#242424] border border-[#F59E0B]/50 text-[#F59E0B] font-semibold text-xs rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Resetar Postagens
          </button>
        </div>
      </div>

      {/* Status Badges Cards for Services */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* PostgreSQL */}
        <div className="bg-[#121212] border border-[#242424] rounded-xl p-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2.5 h-2.5 rounded-full ${isPgOk ? 'bg-[#10B981] animate-pulse' : 'bg-[#EF4444]'}`} />
              <span className="text-xs font-semibold text-white">PostgreSQL</span>
            </div>
            <p className="text-[11px] text-[#8E8E93]">
              {isPgOk ? `Online (${integrationsStatus?.postgres?.latencyMs || 2}ms)` : 'Desconectado'}
            </p>
          </div>
          <Database className={`w-5 h-5 ${isPgOk ? 'text-[#10B981]' : 'text-[#EF4444]'}`} />
        </div>

        {/* Google Drive */}
        <div className="bg-[#121212] border border-[#242424] rounded-xl p-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2.5 h-2.5 rounded-full ${isDriveOk ? 'bg-[#10B981] animate-pulse' : 'bg-[#F59E0B]'}`} />
              <span className="text-xs font-semibold text-white">Google Drive</span>
            </div>
            <p className="text-[11px] text-[#8E8E93]">
              {isDriveOk ? 'Webhook Sincronizado' : 'Não configurado'}
            </p>
          </div>
          <HardDrive className={`w-5 h-5 ${isDriveOk ? 'text-[#10B981]' : 'text-[#F59E0B]'}`} />
        </div>

        {/* Instagram Graph API */}
        <div className="bg-[#121212] border border-[#242424] rounded-xl p-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2.5 h-2.5 rounded-full ${isIgOk ? 'bg-[#10B981] animate-pulse' : 'bg-[#EF4444]'}`} />
              <span className="text-xs font-semibold text-white">Instagram API</span>
            </div>
            <p className="text-[11px] text-[#8E8E93]">
              {isIgOk ? `${integrationsStatus?.instagram?.connectedAccountsCount || activeTenants.length} conta(s) ativas` : 'Credenciais ausentes'}
            </p>
          </div>
          <Instagram className={`w-5 h-5 ${isIgOk ? 'text-[#E1306C]' : 'text-[#EF4444]'}`} />
        </div>

        {/* Gemini AI */}
        <div className="bg-[#121212] border border-[#242424] rounded-xl p-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2.5 h-2.5 rounded-full ${isGeminiOk ? 'bg-[#10B981] animate-pulse' : 'bg-[#EF4444]'}`} />
              <span className="text-xs font-semibold text-white">Gemini AI</span>
            </div>
            <p className="text-[11px] text-[#8E8E93]">
              {isGeminiOk ? `Modelo: ${integrationsStatus?.gemini?.primaryModel || 'gemini-2.5-flash'}` : 'Chave ausente'}
            </p>
          </div>
          <Sparkles className={`w-5 h-5 ${isGeminiOk ? 'text-[#3B82F6]' : 'text-[#EF4444]'}`} />
        </div>
      </div>

      {/* área de teste de integrações / Diagnóstico das APIs */}
      <div className="bg-[#121212] border border-[#242424] rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#10B981]" />
              Área de Teste das Integrações (Diagnóstico da API)
            </h2>
            <p className="text-xs text-[#8E8E93] mt-0.5">
              Clique nos botões abaixo para testar em tempo real a conectividade com os serviços integrados.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Test Postgres */}
          <button
            type="button"
            onClick={() => handleTestIntegration('postgres')}
            disabled={testingService === 'postgres'}
            className="p-3 bg-[#181818] hover:bg-[#222222] border border-[#2E2E2E] rounded-xl flex items-center justify-between transition-colors cursor-pointer text-xs font-medium text-white disabled:opacity-50"
          >
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-[#10B981]" />
              <span>Testar PostgreSQL</span>
            </div>
            {testingService === 'postgres' && <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#10B981]" />}
          </button>

          {/* Test Drive */}
          <button
            type="button"
            onClick={() => handleTestIntegration('drive')}
            disabled={testingService === 'drive'}
            className="p-3 bg-[#181818] hover:bg-[#222222] border border-[#2E2E2E] rounded-xl flex items-center justify-between transition-colors cursor-pointer text-xs font-medium text-white disabled:opacity-50"
          >
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-[#F59E0B]" />
              <span>Testar Google Drive</span>
            </div>
            {testingService === 'drive' && <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#F59E0B]" />}
          </button>

          {/* Test Instagram */}
          <button
            type="button"
            onClick={() => handleTestIntegration('instagram')}
            disabled={testingService === 'instagram'}
            className="p-3 bg-[#181818] hover:bg-[#222222] border border-[#2E2E2E] rounded-xl flex items-center justify-between transition-colors cursor-pointer text-xs font-medium text-white disabled:opacity-50"
          >
            <div className="flex items-center gap-2">
              <Instagram className="w-4 h-4 text-[#E1306C]" />
              <span>Testar Instagram API</span>
            </div>
            {testingService === 'instagram' && <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#E1306C]" />}
          </button>

          {/* Test Gemini */}
          <button
            type="button"
            onClick={() => handleTestIntegration('gemini')}
            disabled={testingService === 'gemini'}
            className="p-3 bg-[#181818] hover:bg-[#222222] border border-[#2E2E2E] rounded-xl flex items-center justify-between transition-colors cursor-pointer text-xs font-medium text-white disabled:opacity-50"
          >
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#3B82F6]" />
              <span>Testar Gemini AI</span>
            </div>
            {testingService === 'gemini' && <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#3B82F6]" />}
          </button>
        </div>

        {/* Live Test Results Console */}
        {Object.keys(testResults).length > 0 && (
          <div className="space-y-2 pt-2 border-t border-[#242424]">
            {Object.entries(testResults).map(([key, result]) => (
              <div
                key={key}
                className={`p-3 rounded-lg border text-xs flex items-center justify-between gap-3 ${
                  result.success
                    ? 'bg-[#064E3B]/20 border-[#10B981]/40 text-[#A7F3D0]'
                    : 'bg-[#2D1515]/40 border-[#EF4444]/40 text-[#FCA5A5]'
                }`}
              >
                <div className="flex items-center gap-2">
                  {result.success ? (
                    <CheckCircle2 className="w-4 h-4 text-[#10B981] shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-[#EF4444] shrink-0" />
                  )}
                  <span className="capitalize font-bold">{key}:</span>
                  <span>{result.message}</span>
                </div>
                {result.latencyMs !== undefined && (
                  <span className="font-mono text-[10px] bg-black/40 px-2 py-0.5 rounded text-white shrink-0">
                    {result.latencyMs}ms
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Indicators Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-[#121212] border border-[#242424] rounded-xl p-4">
          <span className="text-xs text-[#8E8E93] block mb-1">Aguardando Aprovação</span>
          <div className="text-2xl font-bold text-[#F59E0B] font-mono">{pendingTenants.length}</div>
        </div>
        <div className="bg-[#121212] border border-[#242424] rounded-xl p-4">
          <span className="text-xs text-[#8E8E93] block mb-1">Contas Ativas</span>
          <div className="text-2xl font-bold text-white font-mono">{activeTenants.length}</div>
        </div>
        <div className="bg-[#121212] border border-[#242424] rounded-xl p-4">
          <span className="text-xs text-[#8E8E93] block mb-1">Pastas Mapeadas</span>
          <div className="text-2xl font-bold text-white font-mono">{availableFolders.length}</div>
        </div>
      </div>

      {/* Contas Aguardando Aprovação */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Contas Aguardando Aprovação</h2>
          <span className="text-xs font-mono text-[#F59E0B]">{pendingTenants.length} pendente(s)</span>
        </div>

        {pendingTenants.length === 0 ? (
          <div className="bg-[#121212] border border-[#242424] rounded-xl p-8 text-center text-xs text-[#8E8E93]">
            Nenhuma conta na fila de espera no momento.
          </div>
        ) : (
          <div className="bg-[#121212] border border-[#242424] rounded-xl overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#242424] text-[#8E8E93]">
                  <th className="py-3 px-4 font-normal">Conta (@username)</th>
                  <th className="py-3 px-4 font-normal">Status</th>
                  <th className="py-3 px-4 font-normal min-w-[260px]">Pasta do Google Drive a vincular</th>
                  <th className="py-3 px-4 font-normal text-right">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#242424]">
                {pendingTenants.map((tenant) => {
                  const selectedVal = pendingFolders[tenant.id] || '';
                  const isApproving = approvingId === tenant.id;

                  return (
                    <tr key={tenant.id} className="hover:bg-[#161616] transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-white">@{tenant.username}</div>
                        <div className="text-[11px] text-[#8E8E93]">{tenant.nome}</div>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="text-[11px] text-[#F59E0B] border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-2 py-0.5 rounded">
                          Pendente
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        <select
                          value={selectedVal}
                          onChange={(e) =>
                            setPendingFolders((prev) => ({
                              ...prev,
                              [tenant.id]: e.target.value,
                            }))
                          }
                          className="w-full max-w-xs bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-1.5 text-xs text-white outline-none cursor-pointer"
                        >
                          <option value="" disabled>
                            Selecione a empresa...
                          </option>
                          {availableFolders.map((f) => (
                            <option key={f} value={f}>
                              {f}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => handleApprove(tenant)}
                          disabled={isApproving || !selectedVal}
                          className="px-3 py-1.5 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-xs rounded-lg transition-colors cursor-pointer disabled:opacity-40"
                        >
                          {isApproving ? 'Aprovando...' : 'Aprovar'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Contas Aprovadas e Ativas */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Contas Aprovadas / Ativas</h2>
          <span className="text-xs font-mono text-[#10B981]">{activeTenants.length} ativa(s)</span>
        </div>

        {activeTenants.length === 0 ? (
          <div className="bg-[#121212] border border-[#242424] rounded-xl p-8 text-center text-xs text-[#8E8E93]">
            Nenhuma conta aprovada no momento.
          </div>
        ) : (
          <div className="bg-[#121212] border border-[#242424] rounded-xl overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#242424] text-[#8E8E93]">
                  <th className="py-3 px-4 font-normal">Conta (@username)</th>
                  <th className="py-3 px-4 font-normal">Pasta Vinculada</th>
                  <th className="py-3 px-4 font-normal">Conexão Token</th>
                  <th className="py-3 px-4 font-normal text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#242424]">
                {activeTenants.map((tenant) => {
                  const isRefreshing = refreshingTokenId === tenant.id;

                  return (
                    <tr key={tenant.id} className="hover:bg-[#161616] transition-colors">
                      <td className="py-3.5 px-4">
                        <button
                          type="button"
                          onClick={() => onSelectTenantToPreview(tenant)}
                          className="font-semibold text-white hover:text-[#10B981] transition-colors cursor-pointer text-left"
                        >
                          @{tenant.username}
                        </button>
                        <div className="text-[11px] text-[#8E8E93]">{tenant.nome}</div>
                      </td>
                      <td className="py-3.5 px-4 font-mono text-white">
                        {tenant.driveFolderName}
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              tenant.hasValidToken || tenant.connectionStatus === 'CONECTADO'
                                ? 'bg-[#10B981]'
                                : 'bg-[#EF4444]'
                            }`}
                          />
                          <span className="text-xs text-[#D4D4D4]">
                            {tenant.hasValidToken || tenant.connectionStatus === 'CONECTADO'
                              ? 'Ativo (60 dias)'
                              : 'Reconexão Exigida'}
                          </span>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingTenant(tenant);
                              setEditFolderSelect(tenant.driveFolderName || '');
                            }}
                            className="p-1.5 text-[#8E8E93] hover:text-white bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E] rounded-lg cursor-pointer transition-colors"
                            title="Alterar pasta vinculada"
                          >
                            <Settings className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRefreshToken(tenant)}
                            disabled={isRefreshing}
                            className="px-2.5 py-1 bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E] text-[#D4D4D4] text-xs rounded-lg cursor-pointer disabled:opacity-50"
                          >
                            {isRefreshing ? 'Renovando...' : 'Renovar Token'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRevoke(tenant)}
                            className="px-2.5 py-1 bg-[#1A1A1A] hover:bg-[#2D1515] border border-[#2E2E2E] text-[#EF4444] text-xs rounded-lg cursor-pointer transition-colors"
                          >
                            Revogar
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Folder Modal */}
      {editingTenant && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#121212] border border-[#242424] rounded-xl max-w-md w-full p-5 space-y-4 shadow-2xl">
            <h3 className="text-sm font-semibold text-white">
              Alterar pasta do Google Drive para @{editingTenant.username}
            </h3>
            <form onSubmit={handleSaveEditFolder} className="space-y-4">
              <select
                value={editFolderSelect}
                onChange={(e) => setEditFolderSelect(e.target.value)}
                className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-xs text-white outline-none cursor-pointer"
              >
                <option value="" disabled>
                  Selecione a nova pasta...
                </option>
                {availableFolders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingTenant(null)}
                  className="px-3.5 py-2 text-xs text-[#8E8E93] hover:text-white rounded-lg border border-[#262626] cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSaving || !editFolderSelect}
                  className="px-3.5 py-2 text-xs bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold rounded-lg cursor-pointer disabled:opacity-50"
                >
                  {isSaving ? 'Salvando...' : 'Salvar Alteração'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* UNIFIED RESET MODAL WITH INDIVIDUAL & BULK SELECTION */}
      {isTestResetModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !executingTestReset && setIsTestResetModalOpen(false)}
        >
          <div
            className="bg-[#121212] border border-[#242424] rounded-xl max-w-2xl w-full p-6 space-y-4 shadow-2xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b border-[#242424]">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Trash2 className="w-4 h-4 text-[#F59E0B]" />
                  Reset de Postagens para Estado Inicial
                </h3>
                <p className="text-xs text-[#8E8E93] mt-0.5">
                  Retorna as postagens selecionadas para o estado limpo "Pendente", limpando envios, cancelamentos, agendamentos e erros.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsTestResetModalOpen(false)}
                disabled={executingTestReset}
                className="text-[#8E8E93] hover:text-white text-xs cursor-pointer p-1"
              >
                ✕
              </button>
            </div>

            {resetModalError && (
              <div className="p-3 bg-[#2D1515] border border-[#EF4444]/40 rounded-lg flex items-center justify-between text-xs text-[#FCA5A5]">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-[#EF4444] shrink-0" />
                  <span>{resetModalError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setResetModalError(null)}
                  className="text-xs text-[#EF4444] hover:underline"
                >
                  Fechar
                </button>
              </div>
            )}

            {loadingTestResetPreview ? (
              <div className="py-16 text-center text-xs text-[#8E8E93] flex flex-col items-center justify-center gap-2">
                <RefreshCw className="w-5 h-5 animate-spin text-[#10B981]" />
                Carregando lista de postagens do PostgreSQL...
              </div>
            ) : testResetPreview ? (
              <div className="flex-1 overflow-hidden flex flex-col space-y-3 text-xs">
                {/* Search & Bulk Toggle Controls */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 bg-[#0A0A0A] p-2.5 border border-[#1E1E1E] rounded-lg">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-[#71717A]" />
                    <input
                      type="text"
                      value={resetSearch}
                      onChange={(e) => setResetSearch(e.target.value)}
                      placeholder="Filtrar por nome, lote ou status..."
                      className="w-full bg-[#141414] border border-[#262626] focus:border-[#10B981] rounded-md pl-8 pr-3 py-1 text-xs text-white placeholder-[#52525B] outline-none"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleSelectAllFiltered}
                    className="flex items-center gap-1.5 px-3 py-1 bg-[#1A1A1A] hover:bg-[#242424] border border-[#2A2A2A] rounded-md text-xs text-[#A1A1AA] hover:text-white cursor-pointer shrink-0"
                  >
                    {filteredCandidates.every((c) => selectedResetIds.has(c.id)) ? (
                      <>
                        <CheckSquare className="w-3.5 h-3.5 text-[#10B981]" />
                        Desmarcar Todos
                      </>
                    ) : (
                      <>
                        <Square className="w-3.5 h-3.5 text-[#71717A]" />
                        Selecionar Todos ({filteredCandidates.length})
                      </>
                    )}
                  </button>
                </div>

                {/* Candidate Selection List */}
                <div className="flex-1 overflow-y-auto border border-[#242424] rounded-lg divide-y divide-[#1E1E1E] max-h-72">
                  {filteredCandidates.length === 0 ? (
                    <div className="p-8 text-center text-[#71717A]">
                      Nenhuma postagem encontrada com o filtro "{resetSearch}".
                    </div>
                  ) : (
                    filteredCandidates.map((item) => {
                      const isChecked = selectedResetIds.has(item.id);

                      return (
                        <div
                          key={item.id}
                          onClick={() => handleToggleResetId(item.id)}
                          className={`p-3 flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                            isChecked ? 'bg-[#10B981]/10' : 'hover:bg-[#161616]'
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => {}} // handled by row click
                              className="accent-[#10B981] w-4 h-4 cursor-pointer shrink-0"
                            />
                            <div className="min-w-0">
                              <div className="font-semibold text-white truncate max-w-sm">
                                {item.nome || item.loteNome || item.id}
                              </div>
                              <div className="text-[11px] text-[#71717A] flex items-center gap-2">
                                <span>Pasta: {item.driveFolderName || 'Ato'}</span>
                                {item.matchReasons && item.matchReasons.length > 0 && (
                                  <span className="text-[#F59E0B]">
                                    · {item.matchReasons[0]}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="shrink-0 flex items-center gap-2">
                            <span
                              className={`px-2 py-0.5 text-[10px] font-mono font-bold rounded uppercase ${
                                item.status === 'PUBLICADO'
                                  ? 'bg-[#064E3B] text-[#A7F3D0] border border-[#10B981]/30'
                                  : item.status === 'AGENDADO'
                                  ? 'bg-[#1E3A8A] text-[#93C5FD] border border-[#3B82F6]/30'
                                  : item.status === 'REPROVADO' || item.status === 'CANCELADO'
                                  ? 'bg-[#451A1A] text-[#FCA5A5] border border-[#EF4444]/30'
                                  : 'bg-[#1F2937] text-[#D1D5DB] border border-[#374151]'
                              }`}
                            >
                              {item.status}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Footer Count & CTA */}
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-[#8E8E93]">
                    <strong>{selectedResetIds.size}</strong> de {candidatesList.length} postagem(ns) selecionada(s)
                  </span>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsTestResetModalOpen(false)}
                      disabled={executingTestReset}
                      className="px-3.5 py-2 text-xs text-[#8E8E93] hover:text-white rounded-lg border border-[#262626] hover:bg-[#1A1A1A] cursor-pointer disabled:opacity-50"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={handleExecuteTestReset}
                      disabled={executingTestReset || selectedResetIds.size === 0}
                      className="px-4 py-2 text-xs font-semibold bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {executingTestReset ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          Resetando postagens...
                        </>
                      ) : (
                        `Resetar ${selectedResetIds.size} Selecionada(s)`
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
