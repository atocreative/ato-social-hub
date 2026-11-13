/**
 * Organização de posts pelo usuário. Não publica nem apaga nada no Instagram:
 * só muda a etapa do post dentro do ATO Social Hub.
 */
export type OrganizeTarget = 'PUBLICADO' | 'NAO_VOU_POSTAR' | 'PENDENTE';

export const ORGANIZE_TARGETS: OrganizeTarget[] = ['PUBLICADO', 'NAO_VOU_POSTAR', 'PENDENTE'];

export interface OrganizePatch {
  status: OrganizeTarget;
  publishedAt?: string;
  scheduledAt?: undefined;
  scheduledAccountId?: undefined;
}

export function organizeTransition(
  _current: { status: string; scheduledAt?: string; scheduledAccountId?: string; publishedAt?: string },
  target: OrganizeTarget,
  nowIso: string
): OrganizePatch {
  if (!ORGANIZE_TARGETS.includes(target)) {
    throw new Error(`Etapa inválida: ${String(target)}`);
  }
  return {
    status: target,
    publishedAt: target === 'PUBLICADO' ? nowIso : undefined,
    scheduledAt: undefined,
    scheduledAccountId: undefined,
  };
}
