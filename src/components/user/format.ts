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
  NAO_VOU_POSTAR: 'Não vou postar',
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

/** Agora em São Paulo, no formato de <input type="datetime-local"> (YYYY-MM-DDTHH:mm). */
export function nowSaoPauloLocal(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** Converte um datetime-local de São Paulo para ISO UTC. O Brasil não tem horário de verão desde 2019. */
export function saoPauloLocalToIso(local: string): string {
  return new Date(`${local}:00-03:00`).toISOString();
}

export function thumbnailOf(post: { items?: { thumbnailUrl?: string }[] }): string | null {
  return post.items?.[0]?.thumbnailUrl || null;
}
