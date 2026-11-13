import { describe, it, expect, afterEach } from 'vitest';
import { reconcileInstagramPublishedMedia, setInstagramFetchOverride } from '../services/instagramCore.ts';

const NOW = Date.now();

function mockMediaList(items: any[]) {
  setInstagramFetchOverride(async () =>
    new Response(JSON.stringify({ data: items }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  );
}

afterEach(() => setInstagramFetchOverride(null));

describe('reconcileInstagramPublishedMedia: não pode casar qualquer mídia recente', () => {
  it('sem legenda esperada não concilia (antes casava com qualquer mídia recente)', async () => {
    mockMediaList([{ id: 'outra_midia', caption: 'Outra legenda', timestamp: new Date(NOW).toISOString() }]);
    const r = await reconcileInstagramPublishedMedia({
      igUserId: '1',
      accessToken: 'tok',
      expectedCaption: '',
      sinceTimestampMs: NOW - 1000,
    });
    expect(r.found).toBe(false);
  });

  it('concilia apenas com legenda igual e recente', async () => {
    mockMediaList([{ id: 'mesma', caption: 'Minha legenda', timestamp: new Date(NOW).toISOString() }]);
    const r = await reconcileInstagramPublishedMedia({
      igUserId: '1',
      accessToken: 'tok',
      expectedCaption: 'Minha legenda',
      sinceTimestampMs: NOW - 1000,
    });
    expect(r).toMatchObject({ found: true, mediaId: 'mesma' });
  });
});
