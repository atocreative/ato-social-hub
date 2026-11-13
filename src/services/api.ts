import { AuthResponse, DriveImageItem, PostGroup, InstagramPublishPayload, ClientObservation, CreativeContext } from '../types/index.ts';

const TOKEN_KEY = 'ato_social_jwt_token';
const USER_KEY = 'ato_social_user_data';

export const authStorage = {
  getToken: (): string | null => {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw || raw === 'undefined' || raw === 'null') return null;
    return raw;
  },
  setSession: (token: string, user: AuthResponse['user']) => {
    if (!token || !user || typeof user !== 'object' || !user.role) {
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  getUser: (): AuthResponse['user'] | null => {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw || raw === 'undefined' || raw === 'null') return null;
    try {
      const parsed = JSON.parse(raw) as AuthResponse['user'];
      if (!parsed || typeof parsed !== 'object' || !parsed.role) {
        localStorage.removeItem(USER_KEY);
        return null;
      }
      return parsed;
    } catch {
      localStorage.removeItem(USER_KEY);
      return null;
    }
  },
  clearSession: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem('ato_social_user_profile');
      localStorage.clear();
    } catch {}
    try {
      sessionStorage.clear();
    } catch {}
    try {
      if (typeof document !== 'undefined' && document.cookie) {
        const cookies = document.cookie.split(';');
        for (const cookie of cookies) {
          const eqPos = cookie.indexOf('=');
          const name = (eqPos > -1 ? cookie.slice(0, eqPos) : cookie).trim();
          if (name) {
            document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
          }
        }
      }
    } catch {}
  },
};

async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = authStorage.getToken();
  const headers = new Headers(options.headers || {});

  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(endpoint, {
    ...options,
    headers,
  });

  const rawText = await response.text();
  let data: any = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    if (rawText.trim().startsWith('<')) {
      throw new Error('O servidor está reiniciando ou temporariamente indisponível. Tente novamente em instantes.');
    }
    data = {};
  }

  if (!response.ok) {
    const baseError = data.user_message || data.error || data.message || `Erro HTTP ${response.status}`;
    throw new Error(String(baseError));
  }

  return data as T;
}

export const api = {
  // Auth
  login: async (email: string, password: string): Promise<AuthResponse> => {
    return apiFetch<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  // Cadastro próprio no ATO Social Hub (separado da conexão Instagram)
  register: async (data: {
    name: string;
    email: string;
    password: string;
    companyName?: string;
  }): Promise<AuthResponse & { message?: string }> => {
    return apiFetch<AuthResponse & { message?: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Perfil atualizado do usuário autenticado (Sala de espera polling)
  getMe: async (): Promise<{ user: AuthResponse['user']; tenant?: any; token?: string }> => {
    return apiFetch('/api/auth/me', { method: 'GET' });
  },

  // Sincronizar conta autenticada via popup OAuth no banco PostgreSQL (usando syncTicket assinado pelo servidor)
  syncInstagramSession: async (data: {
    user?: AuthResponse['user'];
    tenant?: any;
    syncTicket?: string;
  }): Promise<{ success: boolean; tenant: any }> => {
    return apiFetch('/api/auth/instagram/sync-session', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Exclusão da própria conta (usuário logado). Exige o @username digitado como confirmação.
  deleteAccount: async (confirmUsername: string): Promise<{ success: boolean; error?: string }> => {
    return apiFetch('/api/account/delete', {
      method: 'POST',
      body: JSON.stringify({ confirmUsername }),
    });
  },

  // Obter URL oficial de autorização do Instagram OAuth 2.0
  getInstagramAuthUrl: async (
    origin?: string,
    tenantId?: string,
    driveFolderName?: string
  ): Promise<{ url: string; state?: string; appId: string; redirectUri: string }> => {
    const params = new URLSearchParams();
    if (origin) params.set('origin', origin);
    if (tenantId) params.set('tenantId', tenantId);
    if (driveFolderName && driveFolderName !== 'ALL') params.set('driveFolderName', driveFolderName);
    const qs = params.toString();
    return apiFetch(`/api/auth/instagram/url${qs ? `?${qs}` : ''}`, { method: 'GET' });
  },

  // Consultar status de prontidão do Meta App Review e Advanced Access
  getInstagramAppReviewStatus: async (): Promise<any> => {
    return apiFetch('/api/instagram/app-review-status', { method: 'GET' });
  },

  // Consultar diagnóstico comparativo sanitizado do OAuth Instagram
  getInstagramOAuthDiagnostics: async (): Promise<any> => {
    return apiFetch('/api/instagram/oauth-diagnostics', { method: 'GET' });
  },

  // Simular novo login OAuth (Modo Teste para qualquer conta)
  simulateInstagramLogin: async (data: {
    username: string;
    nome?: string;
    avatarUrl?: string;
  }): Promise<AuthResponse & { tenant: any; message: string }> => {
    return apiFetch('/api/auth/instagram/simulate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Multi-Tenant & Instagram Auth (Legado)
  loginInstagram: async (params?: {
    tenantId?: string;
    customUsername?: string;
    customName?: string;
  }): Promise<AuthResponse & { tenant: any; instagramMeta: any }> => {
    return apiFetch('/api/auth/instagram', {
      method: 'POST',
      body: JSON.stringify(params || {}),
    });
  },

  // Tenant Accounts Management (Admin)
  getTenants: async (): Promise<{ tenants: any[]; adminAlerts?: any[] }> => {
    return apiFetch('/api/tenants', { method: 'GET' });
  },

  refreshTenantToken: async (
    id: string
  ): Promise<{ success: boolean; detail?: any; summary?: any }> => {
    return apiFetch(`/api/admin/tenants/${id}/refresh-token`, {
      method: 'POST',
    });
  },

  resolveAdminAlert: async (id: string): Promise<{ success: boolean }> => {
    return apiFetch(`/api/admin/alerts/${id}/resolve`, {
      method: 'POST',
    });
  },

  runSchedulerNow: async (): Promise<any> => {
    return apiFetch('/api/scheduler/run', {
      method: 'POST',
    });
  },

  getSchedulerStatus: async (): Promise<any> => {
    return apiFetch('/api/scheduler/status', {
      method: 'GET',
    });
  },

  approveTenant: async (
    id: string,
    data: { driveFolderName: string; driveFolderId?: string }
  ): Promise<{ success: boolean; message: string; tenant: any }> => {
    return apiFetch(`/api/admin/tenants/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  revokeTenant: async (id: string): Promise<{ success: boolean; message: string; tenant: any }> => {
    return apiFetch(`/api/admin/tenants/${id}/revoke`, {
      method: 'POST',
    });
  },

  createTenant: async (data: {
    username: string;
    nome: string;
    driveFolderName: string;
    instagramUserId?: string;
    driveFolderId?: string;
  }): Promise<{ success: boolean; message: string; tenant: any }> => {
    return apiFetch('/api/tenants', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  updateTenant: async (
    id: string,
    data: {
      driveFolderName?: string;
      nome?: string;
      username?: string;
      status?: 'AGUARDANDO_APROVACAO' | 'APROVADO' | 'ACTIVE' | 'SUSPENDED';
    }
  ): Promise<{ success: boolean; message: string; tenant: any }> => {
    return apiFetch(`/api/tenants/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  deleteTenant: async (id: string): Promise<{ success: boolean; message: string; deletedId: string }> => {
    return apiFetch(`/api/tenants/${id}`, { method: 'DELETE' });
  },

  // Posts listing
  getPosts: async (
    filter?: string | { tenantId?: string; pastaClienteNome?: string; pastaClienteId?: string }
  ): Promise<{
    posts: PostGroup[];
    stats: { total: number; pendentes: number; agendados: number; publicados: number; reprovados: number };
    availableFolders?: string[];
    folderDetails?: Array<{ id: string; nome: string; url?: string }>;
    activeTenant?: any;
  }> => {
    const params = new URLSearchParams();
    if (typeof filter === 'string' && filter && filter !== 'ALL') {
      params.set('tenantId', filter);
    } else if (filter && typeof filter === 'object') {
      if (filter.tenantId && filter.tenantId !== 'ALL') params.set('tenantId', filter.tenantId);
      if (filter.pastaClienteNome && filter.pastaClienteNome !== 'ALL') {
        params.set('pastaClienteNome', filter.pastaClienteNome);
      }
      if (filter.pastaClienteId && filter.pastaClienteId !== 'ALL') {
        params.set('pastaClienteId', filter.pastaClienteId);
      }
    }
    const qs = params.toString();
    const url = qs ? `/api/posts?${qs}` : '/api/posts';
    return apiFetch(url, { method: 'GET' });
  },

  // Continuous Feedback Rejection Loop
  rejectPost: async (
    id: string,
    payload: {
      tags: string[];
      motivo: string;
      pastaClienteId?: string;
    }
  ): Promise<{
    success: boolean;
    message: string;
    post: PostGroup;
    novoNomeArquivo: string;
    rejectionFeedback: any;
    gasWebhookResult?: any;
  }> => {
    return apiFetch(`/api/posts/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Exclusão Segura de Criativo (Remove do PostgreSQL, envia arquivos para a lixeira do Drive e audita no log)
  deletePost: async (
    id: string,
    options?: { force?: boolean; moveToTrash?: boolean }
  ): Promise<{
    success: boolean;
    message: string;
    deletedId: string;
    driveMovedToTrash?: boolean;
    filesCount?: number;
  }> => {
    return apiFetch(`/api/posts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({
        force: options?.force ?? false,
        moveToTrash: options?.moveToTrash ?? true,
      }),
    });
  },

  // Ocultar Mídia Oficial (Remove da visualização do usuário sem apagar do Drive nem excluir do banco)
  hidePost: async (
    id: string
  ): Promise<{
    success: boolean;
    message: string;
    postId: string;
    scheduleCancelled?: boolean;
  }> => {
    return apiFetch(`/api/posts/${encodeURIComponent(id)}/hide`, {
      method: 'POST',
    });
  },

  // Prévia de registros de teste para limpeza administrativa
  getTestRecordsPreview: async (): Promise<{
    success: boolean;
    totalPosts: number;
    candidatesCount: number;
    candidates: any[];
    safetyGuarantees: Record<string, string>;
  }> => {
    return apiFetch('/api/admin/test-records/preview', { method: 'GET' });
  },

  // Reset administrativo controlado de registros de teste
  resetTestRecords: async (payload: {
    confirm: boolean;
    action: 'ARCHIVE_TESTS' | 'RESET_ATTEMPTS' | 'CANCEL_SCHEDULES';
    scope?: 'ALL_CANDIDATES' | 'SELECTED_IDS';
    selectedIds?: string[];
  }): Promise<{
    success: boolean;
    message: string;
    affectedCount: number;
    backupSnapshotId: string;
    safetyGuarantees: Record<string, boolean>;
  }> => {
    return apiFetch('/api/admin/test-records/reset', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Approve & Publish Now via Instagram API with Instagram Login (POST /api/instagram/publish)
  publishToInstagram: async (payload: {
    id: string;
    driveFileId: string;
    caption: string;
    accountId?: string;
    tenantId?: string;
  }): Promise<{
    success: boolean;
    message: string;
    creationId: string;
    instagramMediaId: string;
    permalink?: string;
    reconnectionRequired?: boolean;
    post: PostGroup;
    metaResponse?: any;
  }> => {
    return apiFetch('/api/instagram/publish', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Generate or refine caption with AI (Gemini API via backend + PostgreSQL)
  generateInstagramCaption: async (payload: {
    postId?: string;
    loteNome?: string;
    nome?: string;
    categoria?: string;
    cliente?: string;
    objective?: string;
    theme?: string;
    briefing?: string;
    tone?: string;
    cta?: string;
    includeHashtags?: boolean;
    customInstructions?: string;
    regenerate?: boolean;
  }): Promise<{
    success: boolean;
    caption: string;
    source: string;
    modelUsed?: string;
    captionRecord?: any;
    aiGeneration?: any;
    post?: PostGroup;
    requiresReapproval?: boolean;
  }> => {
    return apiFetch('/api/instagram/generate-caption', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Etapa 7: Gerar ou regerar legenda com IA (Gemini API) vinculada à postagem no PostgreSQL
  generatePostCaptionWithGemini: async (
    postId: string,
    payload: {
      objective?: string;
      theme?: string;
      briefing?: string;
      tone?: string;
      cta?: string;
      includeHashtags?: boolean;
      customInstructions?: string;
      regenerate?: boolean;
    }
  ): Promise<{
    success: boolean;
    caption: string;
    captionRecord: any;
    aiGeneration: any;
    post: PostGroup;
    requiresReapproval: boolean;
    modelUsed: string;
    message?: string;
  }> => {
    return apiFetch(`/api/posts/${encodeURIComponent(postId)}/captions/generate`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Etapa 7: Salvar legenda editada no PostgreSQL (exige reaprovação se o post já estava aprovado)
  savePostCaption: async (
    postId: string,
    payload: {
      content: string;
      source?: 'GEMINI' | 'GEMINI_EDITED' | 'MANUAL';
      aiGenerationId?: string | null;
    }
  ): Promise<{
    success: boolean;
    caption: string;
    captionRecord: any;
    post: PostGroup;
    requiresReapproval: boolean;
    message?: string;
  }> => {
    return apiFetch(`/api/posts/${encodeURIComponent(postId)}/captions`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  // Etapa 7: Consultar histórico de versões de legendas da postagem
  getPostCaptionsHistory: async (
    postId: string
  ): Promise<{
    postId: string;
    activeCaptionId: string | null;
    captionApproved: boolean;
    captionSource: string;
    currentCaption: string;
    captionsHistory: any[];
    aiGenerations: any[];
  }> => {
    return apiFetch(`/api/posts/${encodeURIComponent(postId)}/captions`, {
      method: 'GET',
    });
  },

  // Empresas e Identidade Editorial (Voz da Marca)
  getCompanies: async (): Promise<{ companies: any[] }> => {
    return apiFetch('/api/companies', { method: 'GET' });
  },

  updateCompanyBrandProfile: async (
    companyId: string,
    payload: {
      name?: string;
      segment?: string;
      brandVoice?: string;
      targetAudience?: string;
      defaultCta?: string;
      defaultHashtags?: string;
      aiGuidelines?: string;
    }
  ): Promise<{ success: boolean; company: any; message: string }> => {
    return apiFetch(`/api/companies/${encodeURIComponent(companyId)}/brand-profile`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  // Diagnóstico do PostgreSQL e Gemini
  getDbStatus: async (): Promise<any> => {
    return apiFetch('/api/system/db-status', { method: 'GET' });
  },

  // Approve & Publish or Schedule
  publishPost: async (
    id: string,
    payload: InstagramPublishPayload
  ): Promise<{ success: boolean; message: string; post: PostGroup; graphApiResult?: any; queueResult?: any }> => {
    return apiFetch(`/api/posts/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Pastas conhecidas do Google Drive
  getDriveFolders: async (): Promise<{ folders: string[]; folderDetails?: Array<{ id: string; nome: string }> }> => {
    return apiFetch('/api/drive/folders', { method: 'GET' });
  },

  // Sincronizar Agora com o Google Drive (Fluxo de 4 etapas: SINCRONIZAR_TUDO -> Persistência em /api/webhooks/drive-sync -> Cálculo de totalArquivos)
  syncDriveNow: async (): Promise<{
    success: boolean;
    message: string;
    totalPosts: number;
    totalArquivos: number;
    pastas?: any[];
    lotes?: any[];
    folders?: string[];
    folderDetails?: Array<{ id: string; nome: string }>;
  }> => {
    // 1. Ação de Busca: solicita sincronização completa (SINCRONIZAR_TUDO) ao Google Apps Script
    const data = await apiFetch<any>('/api/posts/sync-drive', {
      method: 'POST',
      body: JSON.stringify({ acao: 'SINCRONIZAR_TUDO' }),
    });

    const lotes: any[] = Array.isArray(data?.lotes)
      ? data.lotes
      : Array.isArray(data?.data?.lotes)
      ? data.data.lotes
      : [];
    const pastas: any[] = Array.isArray(data?.pastas)
      ? data.pastas
      : Array.isArray(data?.data?.pastas)
      ? data.data.pastas
      : [];

    console.log('Lotes recebidos:', lotes);

    // 2. Persistência Obrigatória: envia os lotes e pastas para /api/webhooks/drive-sync para garantir gravação em .data/database.json com status PENDENTE
    let webhookPersistResult: any = null;
    if (lotes.length > 0 || pastas.length > 0) {
      webhookPersistResult = await apiFetch<any>('/api/webhooks/drive-sync', {
        method: 'POST',
        body: JSON.stringify({
          evento: 'NOVAS_ARTES_SOCIAL_MEDIA',
          timestamp: new Date().toISOString(),
          pastas,
          lotes,
        }),
      });
    }

    // 4. Cálculo real do Toast: soma exata de arquivos salvos dentro de cada lote
    const totalArquivos = lotes.reduce(
      (acc: number, lote: any) => acc + (Array.isArray(lote?.arquivos) ? lote.arquivos.length : 0),
      0
    );
    const totalPastas =
      pastas.length || (Array.isArray(data?.folders) ? data.folders.length : 0);

    return {
      success: true,
      message: `Sincronização concluída com sucesso (${totalPastas} pasta(s), ${totalArquivos} criativo(s)).`,
      totalPosts: webhookPersistResult?.totalPosts ?? data?.totalPosts ?? totalArquivos,
      totalArquivos,
      pastas,
      lotes,
      folders: data?.folders || [],
      folderDetails: data?.folderDetails || [],
    };
  },

  // Webhook Drive Sync
  syncDriveWebhook: async (
    lotes: Partial<DriveImageItem>[] | any[],
    pastas?: any[]
  ): Promise<{ success: boolean; message: string; receivedCount: number; totalPosts: number }> => {
    return apiFetch('/api/webhooks/drive-sync', {
      method: 'POST',
      body: JSON.stringify({
        evento: 'NOVAS_ARTES_SOCIAL_MEDIA',
        timestamp: new Date().toISOString(),
        pastas,
        lotes,
      }),
    });
  },

  // Upload Manual de Mídia (Pasta Uploads no Drive, status APROVADO)
  uploadMedia: async (data: {
    nome: string;
    categoria: string;
    mimeType: string;
    base64Data: string;
    viewUrl: string;
    thumbnailUrl?: string;
    folderName: string;
  }): Promise<{ success: boolean; message: string; item: DriveImageItem }> => {
    return apiFetch('/api/posts/upload', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Reset Demo
  resetDemo: async (): Promise<{ success: boolean; message: string; totalPosts: number }> => {
    return apiFetch('/api/posts/reset-demo', { method: 'POST' });
  },

  // Apagar (Ocultar) / Restaurar Mídia
  hidePost: async (id: string): Promise<{ success: boolean; message: string; postId: string }> => {
    return apiFetch(`/api/posts/${id}/hide`, { method: 'POST' });
  },

  unhidePost: async (id: string): Promise<{ success: boolean; message: string; postId: string }> => {
    return apiFetch(`/api/posts/${id}/unhide`, { method: 'POST' });
  },

  // Google Apps Script Integration Config & Tokens
  getGasConfig: async (): Promise<{
    webhookUrl: string;
    webhookSecretToken: string;
    tenYearJwt: string;
    gasWebhookUrl: string;
    gasProjectUrl: string;
  }> => {
    return apiFetch('/api/system/gas-config', { method: 'GET' });
  },

  // Client Observations & Creative Memory Context
  getClientObservations: async (
    companyId?: string,
    driveFolderName?: string
  ): Promise<{ observations: ClientObservation[] }> => {
    const params = new URLSearchParams();
    if (companyId) params.set('companyId', companyId);
    if (driveFolderName && driveFolderName !== 'ALL') params.set('driveFolderName', driveFolderName);
    const qs = params.toString();
    return apiFetch(`/api/observations${qs ? `?${qs}` : ''}`, { method: 'GET' });
  },

  createClientObservation: async (data: {
    content: string;
    type?: 'PERMANENTE' | 'PONTUAL';
    companyId?: string;
    driveFolderName?: string;
  }): Promise<{ success: boolean; observation: ClientObservation; message: string }> => {
    return apiFetch('/api/observations', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  updateClientObservation: async (
    id: string,
    data: {
      content?: string;
      type?: 'PERMANENTE' | 'PONTUAL';
      isActive?: boolean;
    }
  ): Promise<{ success: boolean; observation: ClientObservation; message: string }> => {
    return apiFetch(`/api/observations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  getCreativeContext: async (
    companyId?: string,
    driveFolderName?: string
  ): Promise<CreativeContext> => {
    const params = new URLSearchParams();
    if (companyId) params.set('companyId', companyId);
    if (driveFolderName && driveFolderName !== 'ALL') params.set('driveFolderName', driveFolderName);
    const qs = params.toString();
    return apiFetch(`/api/creative-context${qs ? `?${qs}` : ''}`, { method: 'GET' });
  },

  // Integration Status & API Diagnostics
  getIntegrationsStatus: async (): Promise<{
    postgres: { connected: boolean; latencyMs: number; driver: string; railwayConfigured: boolean; tables?: any };
    googleDrive: { connected: boolean; webhookUrl: string | null };
    instagram: { configured: boolean; appId: string | null; redirectUri: string; connectedAccountsCount: number };
    gemini: { connected: boolean; primaryModel: string };
  }> => {
    return apiFetch('/api/admin/integrations/status', { method: 'GET' });
  },

  testPostgresIntegration: async (): Promise<{ success: boolean; message: string; latencyMs: number; postsCount: number }> => {
    return apiFetch('/api/admin/integrations/test/postgres', { method: 'POST' });
  },

  testDriveIntegration: async (): Promise<{ success: boolean; message: string; latencyMs: number; httpStatus: number }> => {
    return apiFetch('/api/admin/integrations/test/drive', { method: 'POST' });
  },

  testInstagramIntegration: async (): Promise<{ success: boolean; message: string; appId: string; connectedAccountsCount: number }> => {
    return apiFetch('/api/admin/integrations/test/instagram', { method: 'POST' });
  },

  testGeminiIntegration: async (): Promise<{ success: boolean; message: string; latencyMs: number; modelUsed: string; response: string }> => {
    return apiFetch('/api/admin/integrations/test/gemini', { method: 'POST' });
  },
};
