/**
 * Organização de posts pelo usuário. Não publica nem apaga nada no Instagram:
 * só muda a etapa do post dentro do ATO Social Hub.
 */
export type OrganizeTarget = 'PUBLICADO' | 'NAO_VOU_POSTAR' | 'PENDENTE';
export const ORGANIZE_TARGETS: OrganizeTarget[] = ['PUBLICADO', 'NAO_VOU_POSTAR', 'PENDENTE'];

export const CONTENT_TYPES = ['NOTICIA', 'EMPRESA', 'CURIOSIDADE', 'OUTRO'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export interface OrganizeDetails {
  /** Data em que o post foi de fato publicado (ISO). Sem valor, usa a data de agora. */
  publishedAt?: string;
  tipoConteudo?: ContentType;
  descricaoConteudo?: string;
}

export interface OrganizePatch {
  status: OrganizeTarget;
  publishedAt?: string;
  scheduledAt?: undefined;
  scheduledAccountId?: undefined;
  tipoConteudo?: ContentType;
  descricaoConteudo?: string;
  // Estado de publicação da Meta. Ao sair de "publicado", ele precisa ser apagado,
  // senão um novo agendamento reaproveita containers/ID antigos e gera falso positivo.
  instagramMediaId?: undefined;
  instagramContainerId?: undefined;
  childContainerIds?: [];
  instagramPermalink?: undefined;
  publishAttempts?: 0;
  lastAttemptAt?: undefined;
  nextRetryAt?: null;
  failureReason?: null;
  publishLock?: null;
}

export function organizeTransition(
  _current: {
    status: string;
    scheduledAt?: string;
    scheduledAccountId?: string;
    publishedAt?: string;
    instagramMediaId?: string;
    instagramContainerId?: string;
    childContainerIds?: string[];
  },
  target: OrganizeTarget,
  nowIso: string,
  details: OrganizeDetails = {}
): OrganizePatch {
  if (!ORGANIZE_TARGETS.includes(target)) {
    throw new Error(`Etapa inválida: ${String(target)}`);
  }
  if (details.tipoConteudo !== undefined && !CONTENT_TYPES.includes(details.tipoConteudo)) {
    throw new Error(`Tipo de conteúdo inválido: ${String(details.tipoConteudo)}`);
  }
  let publishedAt: string | undefined;
  if (target === 'PUBLICADO') {
    if (details.publishedAt) {
      const ms = Date.parse(details.publishedAt);
      if (Number.isNaN(ms)) throw new Error('Data de publicação inválida.');
      publishedAt = new Date(ms).toISOString();
    } else {
      publishedAt = nowIso;
    }
  }
  const base: OrganizePatch = {
    status: target,
    publishedAt,
    scheduledAt: undefined,
    scheduledAccountId: undefined,
    tipoConteudo: details.tipoConteudo,
    descricaoConteudo: details.descricaoConteudo?.trim() || undefined,
  };
  if (target === 'PUBLICADO') return base;
  // Voltou para pendente ou "não vou postar": zera tudo que veio de uma publicação anterior.
  return {
    ...base,
    instagramMediaId: undefined,
    instagramContainerId: undefined,
    childContainerIds: [],
    instagramPermalink: undefined,
    publishAttempts: 0,
    lastAttemptAt: undefined,
    nextRetryAt: null,
    failureReason: null,
    publishLock: null,
  };
}
