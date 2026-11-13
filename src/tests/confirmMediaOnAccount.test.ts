import { describe, it, expect, afterEach } from 'vitest';
import { confirmMediaOnAccount, setInstagramFetchOverride } from '../services/instagramCore.ts';

function listWith(ids: string[]) {
  setInstagramFetchOverride(async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

afterEach(() => setInstagramFetchOverride(null));

describe('confirmMediaOnAccount', () => {
  it('confirma quando a mídia aparece na lista do perfil', async () => {
    listWith(['111', '999']);
    expect(await confirmMediaOnAccount({ igUserId: '1', accessToken: 'tok', mediaId: '111', attempts: 1, delayMs: 0 })).toBe(true);
  });

  it('não confirma quando a mídia não aparece no perfil', async () => {
    listWith(['999']);
    expect(await confirmMediaOnAccount({ igUserId: '1', accessToken: 'tok', mediaId: '111', attempts: 2, delayMs: 0 })).toBe(false);
  });
});
