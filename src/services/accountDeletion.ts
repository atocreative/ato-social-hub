/**
 * Regras puras da exclusão de conta pelo usuário.
 * A exclusão remove dados e tokens do app; nunca remove a conta no Instagram.
 */

export function normalizeUsername(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .trim()
    .toLowerCase();
}

export type DeletionValidation = { ok: true } | { ok: false; reason: 'MISMATCH' | 'EMPTY' };

export function validateDeletionRequest(params: {
  sessionUsername: string;
  confirmUsername: string;
}): DeletionValidation {
  const confirmed = normalizeUsername(params.confirmUsername);
  if (!confirmed) return { ok: false, reason: 'EMPTY' };
  if (confirmed !== normalizeUsername(params.sessionUsername)) {
    return { ok: false, reason: 'MISMATCH' };
  }
  return { ok: true };
}

export function buildDeletionAuditEntry(params: {
  username: string;
  tenantId: string;
  ip: string;
  at: string;
}): string {
  return (
    JSON.stringify({
      event: 'ACCOUNT_DELETED',
      username: params.username,
      tenantId: params.tenantId,
      ip: params.ip,
      at: params.at,
    }) + '\n'
  );
}
