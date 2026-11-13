import { describe, it, expect } from 'vitest';
import { organizeTransition } from '../services/postOrganize.ts';

const NOW = '2026-11-13T12:00:00.000Z';

describe('organizeTransition', () => {
  it('marcar como publicado: vai para PUBLICADO, registra data e tira o agendamento', () => {
    const patch = organizeTransition(
      { status: 'AGENDADO', scheduledAt: '2026-11-20T10:00:00Z', scheduledAccountId: 'acc1' },
      'PUBLICADO',
      NOW
    );
    expect(patch).toEqual({
      status: 'PUBLICADO',
      publishedAt: NOW,
      scheduledAt: undefined,
      scheduledAccountId: undefined,
    });
  });

  it('não vou postar: vai para NAO_VOU_POSTAR e tira o agendamento, sem apagar', () => {
    const patch = organizeTransition({ status: 'AGENDADO', scheduledAt: '2026-11-20T10:00:00Z' }, 'NAO_VOU_POSTAR', NOW);
    expect(patch.status).toBe('NAO_VOU_POSTAR');
    expect(patch.scheduledAt).toBeUndefined();
  });

  it('voltar para pendentes: limpa publishedAt, agendamento e IDs da publicação anterior', () => {
    const patch = organizeTransition({ status: 'PUBLICADO', publishedAt: '2026-11-10T10:00:00Z' }, 'PENDENTE', NOW);
    expect(patch).toEqual({
      status: 'PENDENTE',
      publishedAt: undefined,
      scheduledAt: undefined,
      scheduledAccountId: undefined,
      instagramMediaId: undefined,
      instagramContainerId: undefined,
      childContainerIds: [],
      instagramPermalink: undefined,
      publishAttempts: 0,
      lastAttemptAt: undefined,
      nextRetryAt: null,
      failureReason: null,
      publishLock: null,
    });
  });

  it('voltar para pendentes: nunca reaproveita containers da publicação anterior', () => {
    const patch = organizeTransition(
      { status: 'PUBLICADO', instagramMediaId: 'm1', instagramContainerId: 'c1', childContainerIds: ['x'] },
      'PENDENTE',
      NOW
    );
    expect(patch.instagramMediaId).toBeUndefined();
    expect(patch.instagramContainerId).toBeUndefined();
    expect(patch.childContainerIds).toEqual([]);
  });

  it('rejeita alvo desconhecido', () => {
    expect(() => organizeTransition({ status: 'PENDENTE' }, 'APAGAR' as any, NOW)).toThrow();
  });
});
