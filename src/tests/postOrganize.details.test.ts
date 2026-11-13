import { describe, it, expect } from 'vitest';
import { organizeTransition } from '../services/postOrganize.ts';

const NOW = '2026-11-13T12:00:00.000Z';

describe('organizeTransition com detalhes de publicação', () => {
  it('usa a data informada pelo usuário e grava o tipo de conteúdo', () => {
    const patch = organizeTransition({ status: 'AGENDADO' }, 'PUBLICADO', NOW, {
      publishedAt: '2026-11-10T15:30:00.000Z',
      tipoConteudo: 'EMPRESA',
      descricaoConteudo: 'Bastidores do time',
    });
    expect(patch.publishedAt).toBe('2026-11-10T15:30:00.000Z');
    expect(patch.tipoConteudo).toBe('EMPRESA');
    expect(patch.descricaoConteudo).toBe('Bastidores do time');
  });

  it('sem data informada usa agora', () => {
    expect(organizeTransition({ status: 'PENDENTE' }, 'PUBLICADO', NOW).publishedAt).toBe(NOW);
  });

  it('rejeita data inválida e tipo de conteúdo desconhecido', () => {
    expect(() => organizeTransition({ status: 'PENDENTE' }, 'PUBLICADO', NOW, { publishedAt: 'não-é-data' })).toThrow();
    expect(() => organizeTransition({ status: 'PENDENTE' }, 'PUBLICADO', NOW, { tipoConteudo: 'XYZ' as any })).toThrow();
  });
});
