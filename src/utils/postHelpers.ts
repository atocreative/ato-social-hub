import { DriveImageItem, PostCategory, PostGroup } from '../types/index.ts';
import { getMediaKind } from './mediaKind.ts';

/**
 * Normalizes category strings from Google Drive / Apps Script (e.g. "01 Post unico", "02 Carrossel", "03 Story")
 * into standard PostCategory ('Post Único' | 'Carrossel' | 'Story')
 */
export function normalizeCategoria(raw?: string, filesCount: number = 1): PostCategory {
  if (!raw) {
    return filesCount > 1 ? 'Carrossel' : 'Post Único';
  }
  const normalized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  if (normalized.includes('video')) {
    return 'V\u00eddeos';
  }
  if (normalized.includes('carrossel') || normalized.includes('carrosel')) {
    return 'Carrossel';
  }
  if (normalized.includes('story') || normalized.includes('stories') || normalized.includes('storie')) {
    return 'Story';
  }
  if (normalized.includes('unico') || normalized.includes('post')) {
    return filesCount > 1 ? 'Carrossel' : 'Post Único';
  }
  if (normalized.startsWith('02')) {
    return 'Carrossel';
  }
  if (normalized.startsWith('03')) {
    return 'Story';
  }
  return filesCount > 1 ? 'Carrossel' : 'Post Único';
}

/**
 * Extracts numeric sequence from filename to ensure strict ordering (e.g., '01', 'slide_02', 'item-3')
 */
export function extractSlideNumber(filename: string): number {
  const match = filename.match(/(?:_|-|\s|^)(\d{1,3})(?:_|-|\.|\s|$)/);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  const fallback = filename.match(/\d+/);
  return fallback ? parseInt(fallback[0], 10) : 999;
}

/**
 * Groups and sorts Drive items:
 * - Single posts and stories remain individual groups
 * - Carousels with the same loteNome (and tenant/folder) are grouped and ordered strictly by their slide number
 * - Preserves all scheduling, approval, container, permalink, lock, and history metadata across server restarts
 */
export function groupAndSortDriveItems(items: DriveImageItem[]): PostGroup[] {
  const groupsMap = new Map<string, PostGroup>();

  for (const item of items) {
    const normalizedCat = normalizeCategoria(item.categoria, 1);
    const resolvedFolderName = item.pastaClienteNome || item.driveFolderName;
    if (normalizedCat === 'Carrossel') {
      const groupKey = `carrossel_${resolvedFolderName || item.tenantId || 'global'}_${item.loteNome}`;
      if (!groupsMap.has(groupKey)) {
        groupsMap.set(groupKey, {
          id: groupKey,
          loteNome: item.loteNome,
          categoria: 'Carrossel',
          nome: item.loteNome,
          dataCriacao: item.dataCriacao,
          status: item.status || 'PENDENTE',
          caption: item.caption,
          scheduledAt: item.scheduledAt,
          scheduledTimezone: item.scheduledTimezone,
          scheduledAccountId: item.scheduledAccountId,
          publishedAt: item.publishedAt,
          instagramMediaId: item.instagramMediaId,
          instagramContainerId: item.instagramContainerId,
          childContainerIds: item.childContainerIds,
          instagramPermalink: item.instagramPermalink,
          approvedAt: item.approvedAt,
          approvedBy: item.approvedBy,
          isApprovedForSchedule: item.isApprovedForSchedule,
          publishAttempts: item.publishAttempts,
          lastAttemptAt: item.lastAttemptAt,
          nextRetryAt: item.nextRetryAt,
          failureReason: item.failureReason,
          publishLock: item.publishLock,
          publishHistory: item.publishHistory,
          items: [],
          tenantId: item.tenantId,
          driveFolderName: resolvedFolderName,
          pastaClienteNome: resolvedFolderName,
          pastaClienteId: item.pastaClienteId,
          pastaUrl: item.pastaUrl,
          rejectionFeedback: item.rejectionFeedback,
          origem: item.origem || (item.driveFileId?.startsWith('upload_') ? 'UPLOAD' : 'DRIVE_SYNC'),
          isArchivedTest: Boolean(item.isArchivedTest),
          createdByUserId: item.createdByUserId,
        });
      }
      const group = groupsMap.get(groupKey)!;
      if (item.origem && !group.origem) group.origem = item.origem;
      if (item.isArchivedTest !== undefined && group.isArchivedTest === undefined) group.isArchivedTest = item.isArchivedTest;
      if (item.createdByUserId && !group.createdByUserId) group.createdByUserId = item.createdByUserId;
      if (item.rejectionFeedback && !group.rejectionFeedback) {
        group.rejectionFeedback = item.rejectionFeedback;
      }
      if (item.caption && !group.caption) group.caption = item.caption;
      if (item.scheduledAt && !group.scheduledAt) group.scheduledAt = item.scheduledAt;
      if (item.scheduledTimezone && !group.scheduledTimezone) group.scheduledTimezone = item.scheduledTimezone;
      if (item.scheduledAccountId && !group.scheduledAccountId) group.scheduledAccountId = item.scheduledAccountId;
      if (item.publishedAt && !group.publishedAt) group.publishedAt = item.publishedAt;
      if (item.instagramMediaId && !group.instagramMediaId) group.instagramMediaId = item.instagramMediaId;
      if (item.instagramContainerId && !group.instagramContainerId) group.instagramContainerId = item.instagramContainerId;
      if (item.childContainerIds && !group.childContainerIds) group.childContainerIds = item.childContainerIds;
      if (item.instagramPermalink && !group.instagramPermalink) group.instagramPermalink = item.instagramPermalink;
      if (item.approvedAt && !group.approvedAt) group.approvedAt = item.approvedAt;
      if (item.approvedBy && !group.approvedBy) group.approvedBy = item.approvedBy;
      if (item.isApprovedForSchedule !== undefined && group.isApprovedForSchedule === undefined) {
        group.isApprovedForSchedule = item.isApprovedForSchedule;
      }
      if (item.publishAttempts !== undefined && group.publishAttempts === undefined) {
        group.publishAttempts = item.publishAttempts;
      }
      if (item.lastAttemptAt && !group.lastAttemptAt) group.lastAttemptAt = item.lastAttemptAt;
      if (item.nextRetryAt !== undefined && group.nextRetryAt === undefined) group.nextRetryAt = item.nextRetryAt;
      if (item.failureReason !== undefined && group.failureReason === undefined) group.failureReason = item.failureReason;
      if (item.publishLock !== undefined && group.publishLock === undefined) group.publishLock = item.publishLock;
      if (item.publishHistory && !group.publishHistory) group.publishHistory = item.publishHistory;

      group.items.push({
        ...item,
        categoria: 'Carrossel',
        driveFolderName: resolvedFolderName,
        pastaClienteNome: resolvedFolderName,
        origem: item.origem || (item.driveFileId?.startsWith('upload_') ? 'UPLOAD' : 'DRIVE_SYNC'),
      });
    } else {
      const singleKey = `item_${item.driveFileId}`;
      const resolvedOrigem = item.origem || (item.driveFileId?.startsWith('upload_') ? 'UPLOAD' : 'DRIVE_SYNC');
      groupsMap.set(singleKey, {
        id: singleKey,
        loteNome: item.loteNome || item.nome,
        categoria: normalizedCat,
        nome: item.nome || item.loteNome,
        dataCriacao: item.dataCriacao,
        status: item.status || 'PENDENTE',
        caption: item.caption,
        scheduledAt: item.scheduledAt,
        scheduledTimezone: item.scheduledTimezone,
        scheduledAccountId: item.scheduledAccountId,
        publishedAt: item.publishedAt,
        instagramMediaId: item.instagramMediaId,
        instagramContainerId: item.instagramContainerId,
        childContainerIds: item.childContainerIds,
        instagramPermalink: item.instagramPermalink,
        approvedAt: item.approvedAt,
        approvedBy: item.approvedBy,
        isApprovedForSchedule: item.isApprovedForSchedule,
        publishAttempts: item.publishAttempts,
        lastAttemptAt: item.lastAttemptAt,
        nextRetryAt: item.nextRetryAt,
        failureReason: item.failureReason,
        publishLock: item.publishLock,
        publishHistory: item.publishHistory,
        origem: resolvedOrigem,
        isArchivedTest: Boolean(item.isArchivedTest),
        createdByUserId: item.createdByUserId,
        items: [
          {
            ...item,
            categoria: normalizedCat,
            driveFolderName: resolvedFolderName,
            pastaClienteNome: resolvedFolderName,
            origem: resolvedOrigem,
          },
        ],
        tenantId: item.tenantId,
        driveFolderName: resolvedFolderName,
        pastaClienteNome: resolvedFolderName,
        pastaClienteId: item.pastaClienteId,
        pastaUrl: item.pastaUrl,
        rejectionFeedback: item.rejectionFeedback,
      });
    }
  }

  // Sort carousel items by numeric order
  for (const group of groupsMap.values()) {
    if (group.categoria === 'Carrossel') {
      group.items.sort((a, b) => {
        const orderA = a.ordem !== undefined ? a.ordem : extractSlideNumber(a.nome);
        const orderB = b.ordem !== undefined ? b.ordem : extractSlideNumber(b.nome);
        return orderA - orderB;
      });
    }
  }

  return Array.from(groupsMap.values()).sort(
    (a, b) => new Date(b.dataCriacao).getTime() - new Date(a.dataCriacao).getTime()
  );
}

/**
 * Normalizes text to slug without accents, special chars, in snake_case
 */
export function slugifyText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Generates the renamed file string for Drive when an art is rejected
 * Format example: posicao_da_logo_cores_fortes_nao_gostei_da_logo__01_capa.png
 */
export function generateRejectedFilename(
  tags: string[],
  motivo: string,
  originalFilename: string
): string {
  const lastDot = originalFilename.lastIndexOf('.');
  const baseName = lastDot !== -1 ? originalFilename.substring(0, lastDot) : originalFilename;
  const ext = lastDot !== -1 ? originalFilename.substring(lastDot).toLowerCase() : '.png';

  const tagsSlug = tags.map((t) => slugifyText(t)).filter(Boolean).join('_');
  const motivoSlug = slugifyText(motivo).substring(0, 50).replace(/_+$/, '');
  const originalSlug = slugifyText(baseName);

  const prefixParts = [tagsSlug, motivoSlug].filter(Boolean).join('_');

  if (prefixParts) {
    return `${prefixParts}__${originalSlug || 'arte'}${ext}`;
  }
  return `reprovado__${originalSlug || 'arte'}${ext}`;
}

export type CategoryFilter = 'TODOS' | 'Post Único' | 'Carrossel' | 'Story' | 'Vídeos';
export type MediaFilter = 'TODOS' | 'IMAGENS' | 'VIDEOS';
export type MediaAspectRatio = '1:1' | '4:5' | '9:16' | '16:9';

/**
 * Calculates the exact predefined aspect ratio ('1:1', '4:5', '9:16', or '16:9')
 * from real image pixel dimensions (naturalWidth / naturalHeight).
 */
export function detectAspectRatioFromDimensions(
  width: number,
  height: number
): MediaAspectRatio {
  if (!width || !height || width <= 0 || height <= 0) {
    return '1:1';
  }
  const ratio = width / height;
  if (ratio <= 0.68) {
    return '9:16';
  }
  if (ratio <= 0.9) {
    return '4:5';
  }
  if (ratio <= 1.25) {
    return '1:1';
  }
  return '16:9';
}

/**
 * Returns a strictly defined aspect ratio badge ('1:1', '4:5', or '9:16')
 */
export function getAspectRatioBadge(
  categoria?: string,
  width?: number,
  height?: number,
  textHint?: string
): MediaAspectRatio {
  if (width && height && width > 0 && height > 0) {
    return detectAspectRatioFromDimensions(width, height);
  }

  const combined = `${categoria || ''} ${textHint || ''}`.toLowerCase();

  if (
    combined.includes('story') ||
    combined.includes('stories') ||
    combined.includes('9:16') ||
    combined.includes('9x16') ||
    combined.includes('1080x1920')
  ) {
    return '9:16';
  }

  if (
    combined.includes('4:5') ||
    combined.includes('4x5') ||
    combined.includes('1080x1350') ||
    combined.includes('retrato') ||
    combined.includes('vertical')
  ) {
    return '4:5';
  }

  if (
    combined.includes('16:9') ||
    combined.includes('16x9') ||
    combined.includes('1920x1080') ||
    combined.includes('horizontal')
  ) {
    return '16:9';
  }

  return '1:1';
}

/**
 * Filter posts by company context (pastaClienteNome / pastaClienteId / tenantId), status tab, search term, and media category.
 */
export function filterPosts(
  posts: PostGroup[] | undefined | null,
  tab: 'TODOS' | 'PENDENTES' | 'AGENDADOS' | 'PUBLICADOS' | 'REPROVADOS',
  searchQuery: string = '',
  companyFilter?: string,
  categoryFilter: CategoryFilter = 'TODOS',
  mediaFilter: MediaFilter = 'TODOS'
): PostGroup[] {
  if (!Array.isArray(posts)) {
    return [];
  }
  const query = searchQuery.trim().toLowerCase();
  const normalizedFilter = companyFilter ? companyFilter.trim() : '';
  const isGlobalView =
    !normalizedFilter ||
    normalizedFilter === 'ALL' ||
    normalizedFilter.toLowerCase() === 'ato social midia';

  return posts.filter((post) => {
    if (!isGlobalView) {
      const filterLower = normalizedFilter.toLowerCase();
      const postFolderName = (post.pastaClienteNome || post.driveFolderName || '').trim().toLowerCase();
      const matchByName = Boolean(postFolderName && postFolderName === filterLower);
      const matchByFolderId = Boolean(post.pastaClienteId && post.pastaClienteId === normalizedFilter);
      const matchByTenantId = Boolean(post.tenantId && post.tenantId === normalizedFilter);

      if (!matchByName && !matchByFolderId && !matchByTenantId) {
        return false;
      }
    }

    // Status filter
    if (
      tab === 'PENDENTES' &&
      post.status !== 'CRIADO' &&
      post.status !== 'PENDENTE' &&
      post.status !== 'PENDENTE_APROVACAO' &&
      post.status !== 'APROVADO'
    ) {
      return false;
    }
    if (
      tab === 'AGENDADOS' &&
      post.status !== 'AGENDADO' &&
      post.status !== 'PUBLICANDO' &&
      post.status !== 'FALHA_PUBLICACAO' &&
      post.status !== 'RECONEXAO_NECESSARIA'
    ) {
      return false;
    }
    if (tab === 'PUBLICADOS' && post.status !== 'PUBLICADO') return false;
    if (tab === 'REPROVADOS' && post.status !== 'REPROVADO' && post.status !== 'CANCELADO') return false;

    if (categoryFilter && categoryFilter !== 'TODOS') {
      const normalizedPostCat = normalizeCategoria(post.categoria, post.items?.length || 1);
      if (normalizedPostCat !== categoryFilter) {
        return false;
      }
    }

    if (mediaFilter !== 'TODOS') {
      const kinds = (post.items || []).map((item) => getMediaKind(item, post.categoria));
      const temVideo = kinds.includes('video');
      const temImagem = kinds.includes('image') || kinds.length === 0;
      if (mediaFilter === 'VIDEOS' && !temVideo) return false;
      if (mediaFilter === 'IMAGENS' && !temImagem) return false;
    }

    if (query) {
      const matchName = post.nome.toLowerCase().includes(query);
      const matchLote = post.loteNome.toLowerCase().includes(query);
      const matchCategory = post.categoria.toLowerCase().includes(query);
      const matchClient = (post.pastaClienteNome || post.driveFolderName || '').toLowerCase().includes(query);
      const matchCaption = post.caption?.toLowerCase().includes(query);
      const matchMotivo = post.rejectionFeedback?.motivo?.toLowerCase().includes(query);
      const matchTags = post.rejectionFeedback?.tags?.some((t) => t.toLowerCase().includes(query));
      return (
        matchName ||
        matchLote ||
        matchCategory ||
        matchClient ||
        Boolean(matchCaption) ||
        Boolean(matchMotivo) ||
        Boolean(matchTags)
      );
    }

    return true;
  });
}

/**
 * Build Instagram Graph API container payloads according to Meta specifications
 */
export function buildInstagramGraphPayload(post: PostGroup, caption: string) {
  if (post.categoria === 'Story') {
    return {
      endpoint: '/me/media',
      payload: {
        media_type: 'STORIES',
        image_url: post.items[0]?.viewUrl,
      },
    };
  }

  if (post.categoria === 'Carrossel') {
    const childContainers = post.items.map((item, index) => ({
      step: `child_container_${index + 1}`,
      endpoint: '/me/media',
      payload: {
        image_url: item.viewUrl,
        is_carousel_item: true,
      },
    }));

    return {
      type: 'CAROUSEL',
      childContainers,
      carouselRoot: {
        endpoint: '/me/media',
        payload: {
          media_type: 'CAROUSEL',
          caption,
          children: childContainers.map((_, i) => `item_container_id_${i + 1}`),
        },
      },
      publishStep: {
        endpoint: '/me/media_publish',
        payload: {
          creation_id: 'carousel_root_container_id',
        },
      },
    };
  }

  // Single post
  return {
    endpoint: '/me/media',
    payload: {
      image_url: post.items[0]?.viewUrl,
      caption,
    },
    publishStep: {
      endpoint: '/me/media_publish',
      payload: {
        creation_id: 'image_container_id',
      },
    },
  };
}

/**
 * Converts a date (YYYY-MM-DD) and time (HH:mm or HH:mm:ss) interpreted in America/Sao_Paulo (UTC-03:00)
 * into a strict UTC ISO-8601 instant (e.g. 2026-10-26T13:00:00.000Z).
 */
export function convertSaoPauloToUtcIso(scheduledDate: string, scheduledTime: string): string {
  const cleanDate = String(scheduledDate || '').trim();
  const cleanTime = String(scheduledTime || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    throw new Error('Data de agendamento inválida. Use o formato YYYY-MM-DD.');
  }
  const timeParts = cleanTime.split(':');
  if (timeParts.length < 2) {
    throw new Error('Horário de agendamento inválido. Use o formato HH:mm.');
  }
  const hh = String(timeParts[0]).padStart(2, '0');
  const mm = String(timeParts[1]).padStart(2, '0');
  const ss = timeParts[2] ? String(timeParts[2]).padStart(2, '0') : '00';

  // America/Sao_Paulo has fixed UTC-03:00 offset
  const isoWithOffset = `${cleanDate}T${hh}:${mm}:${ss}-03:00`;
  const parsed = new Date(isoWithOffset);
  if (isNaN(parsed.getTime())) {
    throw new Error('Combinação de data e horário inválida para America/Sao_Paulo.');
  }
  return parsed.toISOString();
}

/**
 * Extracts { date: 'YYYY-MM-DD', time: 'HH:mm' } in America/Sao_Paulo from a UTC ISO string
 */
export function formatUtcToSaoPauloParts(utcIso?: string): { date: string; time: string } {
  const target = utcIso ? new Date(utcIso) : new Date(Date.now() + 24 * 3600 * 1000);
  const validDate = isNaN(target.getTime()) ? new Date(Date.now() + 24 * 3600 * 1000) : target;

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(validDate);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hour = getPart('hour') === '24' ? '00' : getPart('hour');
  const minute = getPart('minute');

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
  };
}

/**
 * Format timestamp to Brazilian standard (America/Sao_Paulo) with 24h technical formatting
 */
export function formatDateTimeBR(isoString?: string): string {
  if (!isoString) return '--';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return isoString;

  try {
    const formatter = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return formatter.format(date).replace(',', '');
  } catch {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }
}
