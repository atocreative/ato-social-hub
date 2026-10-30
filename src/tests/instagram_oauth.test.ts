import test from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config({ override: true });

const JWT_SECRET = process.env.JWT_SECRET || 'ato_super_secret_key_2026_998877';
const BASE_URL = 'http://localhost:3000';

test('Instagram OAuth 2.0 & Admin Approval Workflow', async () => {
  // 1. Check Instagram OAuth URL endpoint
  const expectedRedirectUri = 'https://ato-social-hub.ai.studio/api/auth/instagram/callback';
  const urlRes = await fetch(`${BASE_URL}/api/auth/instagram/url`);
  assert.equal(urlRes.status, 200);
  const urlData = await urlRes.json();
  assert.ok(urlData.url);
  assert.equal(urlData.redirectUri, expectedRedirectUri);
  assert.ok(urlData.url.startsWith('https://www.instagram.com/oauth/authorize'));
  assert.ok(urlData.url.includes('force_reauth=true'));
  assert.ok(urlData.url.includes('client_id=1638364467693255'));
  assert.ok(
    urlData.url.includes('redirect_uri=https://ato-social-hub.ai.studio/api/auth/instagram/callback')
  );
  assert.ok(urlData.url.includes('response_type=code'));
  assert.ok(
    urlData.url.includes(
      'scope=instagram_business_basic,instagram_business_content_publish'
    )
  );

  // 1b. Verify GET /api/auth/instagram/callback returns status 400 JSON when code is missing
  const errorCallbackRes = await fetch(
    `${BASE_URL}/api/auth/instagram/callback?error_code=100&error_message=Invalid+Scopes`
  );
  assert.equal(errorCallbackRes.status, 400);
  const errorCallbackData = await errorCallbackRes.json();
  assert.equal(errorCallbackData.versao_codigo, 'v3_nova');
  assert.equal(errorCallbackData.resposta_instagram.error_code, '100');
  assert.equal(errorCallbackData.resposta_instagram.error_message, 'Invalid Scopes');

  // 1c. Verify GET /api/auth/instagram/callback stops immediately and returns v3_nova on invalid code without leaking secret prefix
  const callbackRes = await fetch(
    `${BASE_URL}/api/auth/instagram/callback?code=invalid_oauth_code_2026`
  );
  assert.equal(callbackRes.status, 400);
  const callbackErrorJson = await callbackRes.json();
  assert.equal(callbackErrorJson.versao_codigo, 'v3_nova');
  assert.equal(callbackErrorJson.falha_no_passo, '1_POST_OAUTH_ACCESS_TOKEN');
  assert.equal(callbackErrorJson.client_id_usado, '1638364467693255');
  assert.equal(callbackErrorJson.secret_prefixo, undefined);
  assert.equal(callbackErrorJson.redirect_comparacao?.authorize_redirect_uri, expectedRedirectUri);
  assert.equal(callbackErrorJson.redirect_comparacao?.post_redirect_uri, expectedRedirectUri);
  assert.equal(callbackErrorJson.redirect_comparacao?.iguais, true);
  assert.ok(callbackErrorJson.resposta_instagram);

  // 1c-2. Verify tampered state parameter is rejected
  const badStateRes = await fetch(
    `${BASE_URL}/api/auth/instagram/callback?code=any_code&state=invalid_tampered_state`
  );
  assert.equal(badStateRes.status, 400);
  const badStateJson = await badStateRes.json();
  assert.equal(badStateJson.falha_no_passo, 'VALIDACAO_STATE_OAUTH');

  // 1d. Verify GET /api/debug/state diagnostic route does not leak tokenPreview
  const debugRes = await fetch(`${BASE_URL}/api/debug/state`);
  assert.equal(debugRes.status, 200);
  const debugData = await debugRes.json();
  assert.equal(debugData.databaseFile, '.data/database.json');
  assert.ok(Array.isArray(debugData.accounts));
  for (const acc of debugData.accounts) {
    assert.equal(acc.tokenPreview, undefined);
  }

  // 1e. Verify GET /api/version returns v4_limpa_sem_callback_text and credential/redirect diagnostics
  const versionRes = await fetch(`${BASE_URL}/api/version`);
  assert.equal(versionRes.status, 200);
  const versionData = await versionRes.json();
  assert.equal(versionData.versao, 'v4_limpa_sem_callback_text');
  assert.equal(versionData.redirect_comparacao?.iguais, true);
  assert.equal(versionData.configuracao_credenciais?.app_id_presente, true);
  assert.equal(versionData.configuracao_credenciais?.app_secret_presente, true);
  assert.equal(versionData.configuracao_credenciais?.app_secret_placeholder, false);

  // 2. Simulate new Instagram client login (first login)
  const testUsername = `cliente_test_${Date.now()}`;
  const simulateRes = await fetch(`${BASE_URL}/api/auth/instagram/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: testUsername,
      nome: 'Empresa Teste Alpha',
    }),
  });

  assert.equal(simulateRes.status, 200);
  const simData = await simulateRes.json();
  assert.equal(simData.success, true);
  assert.equal(simData.user.status, 'AGUARDANDO_APROVACAO');
  assert.equal(simData.user.driveFolderName, null);
  assert.ok(simData.token);

  const clientToken = simData.token;
  const tenantId = simData.tenant.id;

  // 3. Verify that pending client cannot see any media on /api/posts
  const postsRes = await fetch(`${BASE_URL}/api/posts`, {
    headers: { Authorization: `Bearer ${clientToken}` },
  });
  assert.equal(postsRes.status, 200);
  const postsData = await postsRes.json();
  assert.equal(postsData.waitingApproval, true);
  assert.equal(postsData.posts.length, 0);

  // 4. Admin logs in with admin@atodev.com.br / 666666 and lists tenants
  const badLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@atosocial.com', password: 'wrong' }),
  });
  assert.equal(badLoginRes.status, 401);

  const adminLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@atodev.com.br', password: '666666' }),
  });
  assert.equal(adminLoginRes.status, 200);
  const adminLoginData = await adminLoginRes.json();
  assert.equal(adminLoginData.user.email, 'admin@atodev.com.br');
  assert.equal(adminLoginData.user.role, 'ADMIN');
  const adminToken = adminLoginData.token;

  const tenantsRes = await fetch(`${BASE_URL}/api/tenants`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(tenantsRes.status, 200);
  const tenantsData = await tenantsRes.json();
  const foundPending = tenantsData.tenants.find((t: any) => t.id === tenantId);
  assert.ok(foundPending, 'Pending tenant should be in tenants list');
  assert.equal(foundPending.status, 'AGUARDANDO_APROVACAO');
  assert.equal(foundPending.driveFolderName, null);

  // 5. Admin approves account and binds Drive folder
  const approveRes = await fetch(`${BASE_URL}/api/admin/tenants/${tenantId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      driveFolderName: 'Cliente Alpha - Posts',
    }),
  });
  assert.equal(approveRes.status, 200);
  const approveData = await approveRes.json();
  assert.equal(approveData.success, true);
  assert.equal(approveData.tenant.status, 'APROVADO');
  assert.equal(approveData.tenant.driveFolderName, 'Cliente Alpha - Posts');

  // 6. Client checks status via /api/auth/me
  const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${clientToken}` },
  });
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.user.status, 'APROVADO');
  assert.equal(meData.user.driveFolderName, 'Cliente Alpha - Posts');

  // 7. Admin revokes account access
  const revokeRes = await fetch(`${BASE_URL}/api/admin/tenants/${tenantId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(revokeRes.status, 200);
  const revokeData = await revokeRes.json();
  assert.equal(revokeData.success, true);
  assert.equal(revokeData.tenant.status, 'AGUARDANDO_APROVACAO');
  assert.equal(revokeData.tenant.driveFolderName, null);

  // Clean up only the test tenant so live state remains intact
  await fetch(`${BASE_URL}/api/tenants/${tenantId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  // 8. Verify Meta Webhook GET challenge verification and POST receiver
  const challengeValue = '1158201444';
  const metaGetRes = await fetch(
    `${BASE_URL}/api/webhooks/meta?hub.mode=subscribe&hub.challenge=${challengeValue}&hub.verify_token=ato_meta_webhook_2026`
  );
  assert.equal(metaGetRes.status, 200);
  assert.ok((metaGetRes.headers.get('content-type') || '').includes('text/plain'));
  const challengeBody = await metaGetRes.text();
  assert.equal(challengeBody, challengeValue);

  const metaInvalidRes = await fetch(
    `${BASE_URL}/api/webhooks/meta?hub.mode=subscribe&hub.challenge=${challengeValue}&hub.verify_token=token_invalido`
  );
  assert.equal(metaInvalidRes.status, 403);

  const metaPostRes = await fetch(`${BASE_URL}/api/webhooks/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'instagram', entry: [] }),
  });
  assert.equal(metaPostRes.status, 200);
});
