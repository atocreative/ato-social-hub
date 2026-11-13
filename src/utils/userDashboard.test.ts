import { describe, it, expect } from 'vitest';
import { summarizePosts, upcomingPosts } from './userDashboard.ts';
import type { PostGroup } from '../types/index.ts';

const now = new Date('2026-11-13T12:00:00Z');
const post = (over: Partial<PostGroup>): PostGroup =>
  ({
    id: 'p',
    loteNome: 'lote',
    categoria: 'Post Único',
    nome: 'post',
    dataCriacao: '2026-11-01T00:00:00Z',
    status: 'AGENDADO',
    items: [],
    ...over,
  }) as PostGroup;

describe('summarizePosts', () => {
  it('conta agendados, publicados na semana e com falha', () => {
    const posts = [
      post({ id: 'a', status: 'AGENDADO' }),
      post({ id: 'b', status: 'AGENDADO' }),
      post({ id: 'c', status: 'PUBLICADO', publishedAt: '2026-11-10T10:00:00Z' }),
      post({ id: 'd', status: 'PUBLICADO', publishedAt: '2026-10-20T10:00:00Z' }),
      post({ id: 'e', status: 'FALHA_PUBLICACAO' }),
      post({ id: 'f', status: 'RECONEXAO_NECESSARIA' }),
    ];
    expect(summarizePosts(posts, now)).toEqual({ scheduled: 2, publishedThisWeek: 1, failed: 2 });
  });
});

describe('upcomingPosts', () => {
  it('lista só agendados futuros com data válida, em ordem, até o limite', () => {
    const posts = [
      post({ id: 'tarde', scheduledAt: '2026-11-20T10:00:00Z' }),
      post({ id: 'cedo', scheduledAt: '2026-11-14T10:00:00Z' }),
      post({ id: 'passado', scheduledAt: '2026-11-01T10:00:00Z' }),
      post({ id: 'invalido', scheduledAt: 'não-é-data' }),
      post({ id: 'publicado', status: 'PUBLICADO', scheduledAt: '2026-11-15T10:00:00Z' }),
    ];
    const result = upcomingPosts(posts, now, 10);
    expect(result.map((p) => p.id)).toEqual(['cedo', 'tarde']);
    expect(upcomingPosts(posts, now, 1).map((p) => p.id)).toEqual(['cedo']);
  });
});
