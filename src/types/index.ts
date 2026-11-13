export type PostCategory = 'Post Único' | 'Carrossel' | 'Story' | 'Vídeos';

export type PostStatus =
  | 'CRIADO'
  | 'PENDENTE'
  | 'PENDENTE_APROVACAO'
  | 'APROVADO'
  | 'AGENDADO'
  | 'PUBLICANDO'
  | 'PUBLICADO'
  | 'FALHA_PUBLICACAO'
  | 'RECONEXAO_NECESSARIA'
  | 'CANCELADO'
  | 'REPROVADO'
  | 'NAO_VOU_POSTAR';

export type ConnectionStatus =
  | 'CONECTADO'
  | 'DESCONECTADO'
  | 'RECONEXAO_NECESSARIA'
  | 'ESCOPOS_INSUFICIENTES'
  | 'EXPIRADO';

export interface RejectionFeedback {
  tags: string[];
  motivo: string;
  novoNomeArquivo: string;
  dataReprovacao: string;
  pastaClienteId?: string;
  driveFileId?: string;
}

export interface PublishLockInfo {
  instanceId?: string;
  workerId?: string;
  acquiredAt?: string;
  lockedAt?: string;
  expiresAt: string;
}

export interface PublishAttemptRecord {
  attemptNumber: number;
  startedAt: string;
  finishedAt: string;
  accountId: string;
  igUserId: string;
  containerId?: string;
  childContainerIds?: string[];
  mediaId?: string;
  permalink?: string;
  status: 'SUCCESS' | 'TRANSIENT_ERROR' | 'PERMANENT_ERROR' | 'AUTH_ERROR_190' | 'RECONCILED_SUCCESS';
  httpStatus?: number;
  metaErrorCode?: number;
  metaErrorSubcode?: number;
  errorMessage?: string;
}

export interface CompanyBrandProfile {
  id: string;
  name: string;
  driveFolderId?: string | null;
  driveFolderName: string;
  driveFolderUrl?: string | null;
  segment?: string | null;
  brandVoice?: string | null;
  targetAudience?: string | null;
  defaultCta?: string | null;
  defaultHashtags?: string | null;
  aiGuidelines?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type CaptionSource = 'MANUAL' | 'GEMINI_AI' | 'EDITED_AI' | 'GEMINI' | 'GEMINI_EDITED';
export type CaptionApprovalStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'SUPERSEDED';

export interface CaptionRecord {
  id: string;
  postId: string;
  companyId?: string | null;
  versionNumber: number;
  content: string;
  source: CaptionSource;
  aiGenerationId?: string | null;
  isSelected: boolean;
  approvalStatus: CaptionApprovalStatus;
  createdBy?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  createdAt: string;
}

export interface AIGenerationRecord {
  id: string;
  postId?: string | null;
  companyId?: string | null;
  model: string;
  objective?: string | null;
  theme?: string | null;
  briefing?: string | null;
  tone?: string | null;
  cta?: string | null;
  includeHashtags: boolean;
  usedMultimodalImage: boolean;
  generatedText?: string | null;
  status: 'SUCCESS' | 'ERROR';
  errorMessage?: string | null;
  latencyMs?: number | null;
  createdBy?: string | null;
  createdAt: string;
}

export interface GeminiCaptionGenerateRequest {
  postId: string;
  companyName?: string;
  segment?: string;
  objective?: string;
  theme?: string;
  briefing?: string;
  tone?: string;
  cta?: string;
  includeHashtags?: boolean;
  useMultimodalImage?: boolean;
  regenerateVariation?: boolean;
  previousCaption?: string;
}

export interface GeminiCaptionGenerateResponse {
  success: boolean;
  caption: CaptionRecord;
  generation: AIGenerationRecord;
  post?: PostGroup;
  requiresReapproval?: boolean;
  message?: string;
}

export interface DriveImageItem {
  driveFileId: string;
  nome: string;
  categoria: PostCategory;
  loteNome: string;
  viewUrl: string;
  thumbnailUrl: string;
  downloadUrl?: string;
  mimeType?: string;
  dataCriacao: string;
  status: PostStatus;
  ordem?: number;
  tenantId?: string;
  driveFolderName?: string;
  pastaClienteNome?: string;
  pastaClienteId?: string;
  pastaUrl?: string;
  rejectionFeedback?: RejectionFeedback;
  origem?: 'DRIVE_SYNC' | 'UPLOAD';
  isArchivedTest?: boolean;
  createdByUserId?: string;
}

export interface PostGroup {
  id: string;
  loteNome: string;
  categoria: PostCategory;
  nome: string;
  dataCriacao: string;
  status: PostStatus;
  caption?: string;
  activeCaptionId?: string | null;
  captionApproved?: boolean;
  captionSource?: CaptionSource;
  captionsHistory?: CaptionRecord[];
  scheduledAt?: string;
  scheduledTimezone?: string;
  scheduledAccountId?: string;
  publishedAt?: string;
  instagramMediaId?: string;
  instagramContainerId?: string;
  childContainerIds?: string[];
  instagramPermalink?: string;
  approvedAt?: string;
  approvedBy?: string;
  isApprovedForSchedule?: boolean;
  publishAttempts?: number;
  lastAttemptAt?: string;
  nextRetryAt?: string | null;
  failureReason?: string | null;
  publishLock?: PublishLockInfo | null;
  publishHistory?: PublishAttemptRecord[];
  items: DriveImageItem[];
  tenantId?: string;
  companyId?: string;
  driveFolderName?: string;
  pastaClienteNome?: string;
  pastaClienteId?: string;
  pastaUrl?: string;
  rejectionFeedback?: RejectionFeedback;
  origem?: 'DRIVE_SYNC' | 'UPLOAD';
  isArchivedTest?: boolean;
  createdByUserId?: string;
  isDeletedByClient?: boolean;
  deletedByClientAt?: string;
}

export type TenantStatus =
  | 'PENDENTE'
  | 'AGUARDANDO_APROVACAO'
  | 'APROVADO'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'RECONEXAO_NECESSARIA';

export interface TenantAccount {
  id: string;
  companyId?: string | null;
  username: string;
  nome: string;
  instagramUserId: string;
  account_type?: string;
  driveFolderName?: string | null;
  driveFolderId?: string | null;
  avatarUrl?: string;
  status: TenantStatus;
  postsCount?: number;
  lastSyncAt?: string;
  requestedAt?: string;
  approvedAt?: string;
  // Encrypted token & lifecycle metadata
  encryptedAccessToken?: string;
  tokenType?: string;
  tokenIssuedAt?: string;
  tokenExpiresAt?: string;
  lastTokenRefreshAt?: string;
  grantedScopes?: string[];
  connectionStatus?: ConnectionStatus;
  lastConnectionError?: string | null;
  reconnectionRequiredAt?: string | null;
  hasValidToken?: boolean;
  // Legacy fields (automatically migrated to encryptedAccessToken and stripped)
  accessToken?: string;
  access_token?: string;
}

export interface AdminAlertNotification {
  id: string;
  type: 'RECONEXAO_NECESSARIA' | 'FALHA_PUBLICACAO' | 'RENOVACAO_TOKEN' | 'ESCOPOS_INSUFICIENTES';
  tenantId: string;
  username: string;
  postId?: string;
  message: string;
  createdAt: string;
  resolved: boolean;
  resolvedAt?: string;
}

export interface UserProfile {
  id: string;
  email?: string;
  nome: string;
  role: 'ADMIN' | 'TENANT';
  tenantId?: string;
  companyId?: string;
  instagramUserId?: string;
  instagramUsername?: string;
  status?: TenantStatus;
  driveFolderName?: string | null;
  driveFolderId?: string | null;
  encryptedAccessToken?: string;
  tokenIssuedAt?: string;
  tokenExpiresAt?: string;
  grantedScopes?: string[];
  connectionStatus?: ConnectionStatus;
}

export interface AuthResponse {
  token: string;
  user: UserProfile;
  tenant?: TenantAccount;
}

export interface DriveWebhookPayload {
  lotes: DriveImageItem[];
  pastaOrigem?: string;
  driveFolderName?: string;
}

export interface InstagramPublishPayload {
  action: 'NOW' | 'SCHEDULE' | 'APPROVE' | 'APPROVE_ONLY' | 'CANCEL_SCHEDULE';
  caption: string;
  scheduledDate?: string;
  scheduledTime?: string;
  scheduledTimezone?: string;
  accountId?: string;
  tenantId?: string;
  instagramAccountId?: string;
}

export interface EntityMigrationSummary {
  entity: string;
  foundInSource: number;
  imported: number;
  alreadyExisting: number;
  rejected: number;
  rejectionReasons: string[];
  divergences: string[];
}

export interface MigrationReport {
  executedAt: string;
  dryRun: boolean;
  backupFilePath?: string;
  sourceFilesAnalyzed: string[];
  entities: EntityMigrationSummary[];
  referentialIntegrityOk: boolean;
  integrityNotes: string[];
  countsBefore: Record<string, number>;
  countsAfter: Record<string, number>;
}

export interface ClientObservation {
  id: string;
  companyId: string;
  tenantId?: string | null;
  userId: string;
  authorName?: string | null;
  content: string;
  type: 'PERMANENTE' | 'PONTUAL';
  isActive: boolean;
  syncStatus: 'PENDING' | 'SYNCED' | 'FAILED';
  lastSyncedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreativeContext {
  companyName: string;
  observations: Array<{
    id: string;
    content: string;
    type: 'PERMANENTE' | 'PONTUAL';
    createdAt: string;
  }>;
  rejectionMemory: Array<{
    tags: string[];
    motivo: string;
    dataReprovacao: string;
  }>;
  formattedPromptContext: string;
}
