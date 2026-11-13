import type { PostGroup } from '../types/index.ts';

/** Tipo de mídia para o histórico, derivado da categoria (sem IA). */
export function mediaTypeLabel(categoria: string): string {
  const c = (categoria || '').toLowerCase();
  if (c.includes('story')) return 'Story';
  if (c.includes('carrossel')) return 'Carrossel';
  if (c.includes('vídeo') || c.includes('video')) return 'Vídeo';
  return 'Feed';
}

const CONTENT_LABEL: Record<string, string> = {
  NOTICIA: 'Notícia',
  EMPRESA: 'Empresa',
  CURIOSIDADE: 'Curiosidade',
  OUTRO: 'Outro',
};

export function contentTypeLabel(tipo?: string | null): string {
  return (tipo && CONTENT_LABEL[tipo]) || 'Sem classificação';
}

export interface HistoryItem {
  post: PostGroup;
  kind: 'PUBLICADO' | 'AGENDADO';
  /** publishedAt para publicados; scheduledAt para agendados. */
  date: string | undefined;
}

/** Publicados e agendados, do mais recente ao mais antigo (sem data vai para o fim). */
export function buildHistory(posts: PostGroup[]): HistoryItem[] {
  const items: HistoryItem[] = posts
    .filter((p) => p.status === 'PUBLICADO' || p.status === 'AGENDADO')
    .map((p) => ({
      post: p,
      kind: p.status as 'PUBLICADO' | 'AGENDADO',
      date: p.status === 'PUBLICADO' ? p.publishedAt : p.scheduledAt,
    }));
  const ts = (i: HistoryItem) => {
    const t = Date.parse(i.date || '');
    return Number.isNaN(t) ? -Infinity : t;
  };
  return items.sort((a, b) => ts(b) - ts(a));
}
