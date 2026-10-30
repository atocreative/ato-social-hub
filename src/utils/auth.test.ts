import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'ato_super_secret_key_2026_998877';
const WEBHOOK_SECRET_TOKEN = 'ato_webhook_sync_token_884422';

function validateWebhookToken(token: string) {
  // Scenario 1: Fixed M2M Token
  if (token === WEBHOOK_SECRET_TOKEN) {
    return { valid: true, scenario: 'SCENARIO_1_FIXED_TOKEN', role: 'Service Account' };
  }

  // Scenario 2: Signed JWT
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return { valid: true, scenario: 'SCENARIO_2_JWT', payload: decoded };
  } catch (err: any) {
    return { valid: false, error: err.message };
  }
}

test('Webhook Auth validates Scenario 1 (Fixed M2M Token)', () => {
  const result = validateWebhookToken('ato_webhook_sync_token_884422');
  assert.equal(result.valid, true);
  assert.equal(result.scenario, 'SCENARIO_1_FIXED_TOKEN');
});

test('Webhook Auth validates Scenario 2 (10-Year Signed JWT)', () => {
  const token = jwt.sign(
    { id: 'gas_long_lived_service', email: 'drive-sync@atosocial.com', role: 'Service Account' },
    JWT_SECRET,
    { expiresIn: '3650d' }
  );

  const result = validateWebhookToken(token);
  assert.equal(result.valid, true);
  assert.equal(result.scenario, 'SCENARIO_2_JWT');
});

test('Webhook Auth rejects invalid or malformed tokens', () => {
  const invalidResult = validateWebhookToken('wrong_token_123');
  assert.equal(invalidResult.valid, false);
});
