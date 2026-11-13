import { describe, it, expect } from 'vitest';
import {
  normalizeUsername,
  validateDeletionRequest,
  buildDeletionAuditEntry,
} from '../services/accountDeletion.ts';

describe('normalizeUsername', () => {
  it('remove @, espaços e põe em minúsculas', () => {
    expect(normalizeUsername('  @Ato.VC ')).toBe('ato.vc');
  });
});

describe('validateDeletionRequest', () => {
  it('aceita confirmação igual ao usuário da sessão, ignorando formato', () => {
    expect(validateDeletionRequest({ sessionUsername: 'ato.vc', confirmUsername: '@Ato.VC ' })).toEqual({ ok: true });
  });
  it('rejeita confirmação vazia', () => {
    expect(validateDeletionRequest({ sessionUsername: 'ato.vc', confirmUsername: '   ' })).toEqual({ ok: false, reason: 'EMPTY' });
  });
  it('rejeita confirmação de outra conta', () => {
    expect(validateDeletionRequest({ sessionUsername: 'ato.vc', confirmUsername: 'outra' })).toEqual({ ok: false, reason: 'MISMATCH' });
  });
});

describe('buildDeletionAuditEntry', () => {
  it('gera uma linha JSON com os campos de auditoria', () => {
    const line = buildDeletionAuditEntry({ username: 'ato.vc', tenantId: 't1', ip: '1.2.3.4', at: '2026-11-13T00:00:00.000Z' });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ event: 'ACCOUNT_DELETED', username: 'ato.vc', tenantId: 't1', ip: '1.2.3.4', at: '2026-11-13T00:00:00.000Z' });
  });
});
