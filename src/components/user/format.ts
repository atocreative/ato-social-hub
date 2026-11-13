import type { PostStatus } from '../../types/index.ts';

export const STATUS_LABEL: Partial<Record<PostStatus, string>> = {
  CRIADO: 'Rascunho',
  PENDENTE: 'Pendente',
  PENDENTE_APROVACAO: 'Aguardando aprovação',
  APROVADO: 'Aprovado',
  AGENDADO: 'Agendado',
  PUBLICANDO: 'Publicando',
  PUBLICADO: 'Publicado',
  FALHA_PUBLICACAO: 'Falhou',
  RECONEXAO_NECESSARIA: 'Reconexão necessária',
  CANCELADO: 'Cancelado',
  REPROVADO: 'Reprovado',
};

export function statusLabel(status: PostStatus): string {
  return STATUS_LABEL[status] || status;
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function thumbnailOf(post: { items?: { thumbnailUrl?: string }[] }): string | null {
  return post.items?.[0]?.thumbnailUrl || null;
}
