import { describe, it, expect } from 'vitest';
import { mediaTypeLabel, contentTypeLabel, buildHistory } from './history.ts';
import type { PostGroup } from '../types/index.ts';

const post = (over: Partial<PostGroup>): PostGroup =>
  ({ id: 'p', loteNome: 'l', categoria: 'Post Único', nome: 'n', dataCriacao: '2026-11-01T00:00:00Z', status: 'PUBLICADO', items: [], ...over }) as PostGroup;

describe('mediaTypeLabel', () => {
  it('classifica pela categoria: Feed, Carrossel, Story ou Vídeo', () => {
    expect(mediaTypeLabel('Post Único')).toBe('Feed');
    expect(mediaTypeLabel('Carrossel')).toBe('Carrossel');
    expect(mediaTypeLabel('Story')).toBe('Story');
    expect(mediaTypeLabel('Vídeos')).toBe('Vídeo');
  });
});

describe('contentTypeLabel', () => {
  it('traduz o tipo de conteúdo e aceita ausência', () => {
    expect(contentTypeLabel('NOTICIA')).toBe('Notícia');
    expect(contentTypeLabel('EMPRESA')).toBe('Empresa');
    expect(contentTypeLabel(undefined)).toBe('Sem classificação');
  });
});

describe('buildHistory', () => {
  it('lista publicados e agendados, do mais recente ao mais antigo, usando a data certa', () => {
    const items = buildHistory([
      post({ id: 'pub', status: 'PUBLICADO', publishedAt: '2026-11-05T10:00:00Z' }),
      post({ id: 'ag', status: 'AGENDADO', scheduledAt: '2026-11-20T10:00:00Z' }),
      post({ id: 'pend', status: 'PENDENTE' }),
      post({ id: 'semdata', status: 'PUBLICADO' }),
    ]);
    expect(items.map((i) => i.post.id)).toEqual(['ag', 'pub', 'semdata']);
    expect(items[0].kind).toBe('AGENDADO');
    expect(items[1].date).toBe('2026-11-05T10:00:00Z');
  });
});
