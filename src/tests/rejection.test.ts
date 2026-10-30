import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'ato_super_secret_key_2026_998877';
const BASE_URL = 'http://localhost:3000';

test('Rejection Feedback Loop API: POST /api/posts/:id/reject', async () => {
  // 1. Generate valid admin JWT
  const userToken = jwt.sign(
    {
      id: 'admin_test_user',
      nome: 'Administrador ATO',
      role: 'ADMIN',
      driveFolderName: 'Ato',
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // Sync a test item via real webhook using the exact nested lotes -> arquivos structure for company "Ato"
  const syncRes = await fetch(`${BASE_URL}/api/webhooks/drive-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ato_webhook_sync_token_884422`,
    },
    body: JSON.stringify({
      evento: 'NOVAS_ARTES_SOCIAL_MEDIA',
      timestamp: new Date().toISOString(),
      lotes: [
        {
          pastaClienteId: '1CCJ4Fo3hLGSTb1y84P2tckFYW4bQudGF',
          pastaClienteNome: 'Ato',
          loteNome: 'Ato - 1 24-10 - 01 Post unico',
          categoria: '01 Post unico',
          pastaUrl: 'https://drive.google.com/drive/folders/1CCJ4Fo3hLGSTb1y84P2tckFYW4bQudGF',
          arquivos: [
            {
              driveFileId: 'drive_test_item_rejection',
              nome: '01_Post.png',
              mimeType: 'image/png',
              viewUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="black"/></svg>',
              thumbnailUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="black"/></svg>',
              downloadUrl: 'https://drive.google.com/uc?export=download&id=drive_test_item_rejection',
            },
          ],
        },
      ],
    }),
  });
  assert.equal(syncRes.status, 200);

  // 2. Fetch existing posts (Global Admin fallback + availableFolders)
  const getRes = await fetch(`${BASE_URL}/api/posts`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  assert.ok(Array.isArray(getData.posts));
  assert.ok(Array.isArray(getData.availableFolders));
  assert.ok(getData.availableFolders.includes('Ato'), 'availableFolders should include company Ato');
  assert.ok(!getData.availableFolders.includes('ATO Social Midia'), 'availableFolders must never include root folder ATO Social Midia');
  assert.ok(getData.stats);
  assert.ok(typeof getData.stats.reprovados === 'number');

  // Verify company-filtered endpoint (?pastaClienteNome=Ato)
  const filteredRes = await fetch(`${BASE_URL}/api/posts?pastaClienteNome=Ato`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(filteredRes.status, 200);
  const filteredData = await filteredRes.json();
  assert.ok(filteredData.posts.some((p: any) => p.id === 'item_drive_test_item_rejection' && p.pastaClienteNome === 'Ato'));

  // Find the test pending post to reject
  const pendingPost = getData.posts.find((p: any) => p.id === 'item_drive_test_item_rejection');
  assert.ok(pendingPost, 'Should find the synced test pending post to reject');

  // 3. Reject post with tags, motivo, and pastaClienteId
  const rejectionPayload = {
    tags: ['Posição da Logo', 'Cores Fortes/Erradas'],
    motivo: 'Não gostei da posição da logo e as cores estão muito fortes',
    pastaClienteId: '1CCJ4Fo3hLGSTb1y84P2tckFYW4bQudGF',
  };

  const rejectRes = await fetch(`${BASE_URL}/api/posts/${pendingPost.id}/reject`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify(rejectionPayload),
  });

  assert.equal(rejectRes.status, 200);
  const rejectData = await rejectRes.json();

  assert.equal(rejectData.success, true);
  assert.equal(rejectData.post.status, 'REPROVADO');
  assert.ok(rejectData.novoNomeArquivo);
  assert.ok(rejectData.novoNomeArquivo.includes('posicao_da_logo'));
  assert.ok(rejectData.novoNomeArquivo.includes('cores_fortes_erradas'));
  assert.ok(rejectData.rejectionFeedback);
  assert.deepEqual(rejectData.rejectionFeedback.tags, rejectionPayload.tags);
  assert.equal(rejectData.rejectionFeedback.motivo, rejectionPayload.motivo);

  // Verify GAS payload structure matches prompt instructions
  const gasPayload = rejectData.gasWebhookResult?.payload;
  assert.ok(gasPayload);
  assert.equal(gasPayload.acao, 'REPROVAR_E_MOVER');
  assert.equal(gasPayload.token, 'ato_webhook_sync_token_884422');
  assert.equal(gasPayload.pastaClienteId, '1CCJ4Fo3hLGSTb1y84P2tckFYW4bQudGF');
  assert.deepEqual(gasPayload.tags, rejectionPayload.tags);
  assert.equal(gasPayload.motivo, rejectionPayload.motivo);

  // 4. Fetch posts again and verify it is under REPROVADOS and count increased
  const afterRes = await fetch(`${BASE_URL}/api/posts`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  const afterData = await afterRes.json();
  const rejectedPost = afterData.posts.find((p: any) => p.id === pendingPost.id);
  assert.ok(rejectedPost);
  assert.equal(rejectedPost.status, 'REPROVADO');
  assert.ok(rejectedPost.rejectionFeedback);
  assert.equal(rejectedPost.rejectionFeedback.motivo, rejectionPayload.motivo);

  // Clean up only the test post so real synced data remains intact
  await fetch(`${BASE_URL}/api/posts/${pendingPost.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${userToken}` },
  });
});
