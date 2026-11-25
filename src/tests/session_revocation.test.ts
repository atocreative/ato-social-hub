import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test_jwt_secret_session_revocation_0123456789';
process.env.TOKEN_ENCRYPTION_KEY = 'test_token_encryption_key_0123456789abcdef';

import { isSessionRevoked, requireAuth } from '../../server.ts';

const nowSec = () => Math.floor(Date.now() / 1000);

function runRequireAuth(token: string) {
  const req: any = { headers: { authorization: `Bearer ${token}` } };
  let status = 200;
  let body: any = null;
  let nextCalled = false;
  const res: any = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: any) {
      body = payload;
      return this;
    },
  };
  requireAuth(req, res, () => {
    nextCalled = true;
  });
  return { status, body, nextCalled, user: req.user };
}

describe('Revogação de sessões (SESSIONS_VALID_AFTER)', () => {
  it('sem a variável nenhuma sessão é revogada', () => {
    expect(isSessionRevoked({ iat: nowSec() - 99999 }, '')).toBe(false);
    expect(isSessionRevoked({ iat: nowSec() - 99999 }, undefined)).toBe(false);
  });

  it('revoga tokens emitidos antes do corte e mantém os emitidos depois', () => {
    const cutoff = new Date((nowSec() - 3600) * 1000).toISOString();
    expect(isSessionRevoked({ iat: nowSec() - 7200 }, cutoff)).toBe(true);
    expect(isSessionRevoked({ iat: nowSec() - 60 }, cutoff)).toBe(false);
  });

  it('valor inválido ou token sem iat falha fechado', () => {
    expect(isSessionRevoked({ iat: nowSec() }, 'isso-nao-e-data')).toBe(true);
    expect(isSessionRevoked({}, new Date(0).toISOString())).toBe(true);
  });

  it('requireAuth recusa JWT antigo com 401 e aceita JWT novo', () => {
    const secret = process.env.JWT_SECRET as string;
    const oldToken = jwt.sign({ id: 'adm', role: 'ADMIN', iat: nowSec() - 7200 }, secret, { expiresIn: '72h' });
    const freshToken = jwt.sign({ id: 'adm', role: 'ADMIN' }, secret, { expiresIn: '72h' });

    const previous = process.env.SESSIONS_VALID_AFTER;
    try {
      delete process.env.SESSIONS_VALID_AFTER;
      expect(runRequireAuth(oldToken).nextCalled).toBe(true);

      process.env.SESSIONS_VALID_AFTER = new Date((nowSec() - 3600) * 1000).toISOString();
      const denied = runRequireAuth(oldToken);
      expect(denied.nextCalled).toBe(false);
      expect(denied.status).toBe(401);
      expect(runRequireAuth(freshToken).nextCalled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SESSIONS_VALID_AFTER;
      else process.env.SESSIONS_VALID_AFTER = previous;
    }
  });
});
