/**
 * Monta a URL da miniatura servida pelo proxy do próprio servidor (/api/media/thumb).
 * Assim cada imagem é baixada do Google Drive uma só vez e reaproveitada por cache.
 * Retorna null quando não há um driveFileId real (uploads locais, placeholders).
 */
export function driveThumbUrl(driveFileId: string | undefined | null, width: number = 800): string | null {
  const id = String(driveFileId || '').trim();
  if (!id || id.startsWith('drive_') || id.startsWith('upload_')) return null;
  return `/api/media/thumb/${encodeURIComponent(id)}?w=${width}`;
}
