import { describe, it, expect } from 'vitest';
import { buildMonthGrid } from './agendaGrid.ts';
import type { PostGroup } from '../types/index.ts';

const post = (over: Partial<PostGroup>): PostGroup =>
  ({ id: 'p', loteNome: 'l', categoria: 'Post Único', nome: 'n', dataCriacao: '2026-11-01T00:00:00Z', status: 'AGENDADO', items: [], ...over }) as PostGroup;

describe('buildMonthGrid', () => {
  it('gera 42 células começando no domingo', () => {
    // Dezembro/2026 (month 11, 0-based) começa numa terça: a grade começa no domingo 29/11
    const grid = buildMonthGrid(2026, 11, []);
    expect(grid).toHaveLength(42);
    expect(grid[0].date).toBe('2026-11-29');
    expect(grid[0].inMonth).toBe(false);
  });

  it('agrupa pelo dia no fuso de São Paulo (23:00 de 13/11 não vira 14/11)', () => {
    const posts = [post({ id: 'x', scheduledAt: '2026-11-14T02:00:00Z' })];
    const grid = buildMonthGrid(2026, 10, posts); // novembro/2026
    const cell = grid.find((c) => c.date === '2026-11-13');
    expect(cell?.posts.map((p) => p.id)).toEqual(['x']);
    expect(grid.find((c) => c.date === '2026-11-14')?.posts).toHaveLength(0);
  });

  it('ignora posts com data inválida ou ausente', () => {
    const posts = [post({ id: 'ruim', scheduledAt: 'não-é-data' }), post({ id: 'sem' })];
    const grid = buildMonthGrid(2026, 10, posts);
    expect(grid.every((c) => c.posts.length === 0)).toBe(true);
  });

  it('ordena posts do mesmo dia por horário', () => {
    const posts = [
      post({ id: 'tarde', scheduledAt: '2026-11-13T18:00:00Z' }),
      post({ id: 'manha', scheduledAt: '2026-11-13T12:00:00Z' }),
    ];
    const cell = buildMonthGrid(2026, 10, posts).find((c) => c.date === '2026-11-13');
    expect(cell?.posts.map((p) => p.id)).toEqual(['manha', 'tarde']);
  });
});
