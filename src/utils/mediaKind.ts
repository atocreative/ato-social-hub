/**
 * Identifica se um item do Drive é imagem ou vídeo e monta os links de
 * download (arquivo original) e de reprodução (preview do Drive).
 */

export type MediaKind = 'image' | 'video';

const EXTENSAO_VIDEO = /\.(mp4|mov|webm|m4v)$/i;

/** IDs sintéticos gerados pelo backend para uploads e itens sem ID do Drive. */
function isDriveFileId(id?: string): id is string {
  return Boolean(id) && !id!.startsWith('drive_') && !id!.startsWith('upload_');
}

/**
 * Decide se o item é vídeo. Ordem de prioridade:
 * 1. categoria do post "Vídeos" (vem da pasta Vídeos no Drive);
 * 2. extensão do nome (.mp4, .mov, ...), mesmo que o MIME esteja errado;
 * 3. MIME do arquivo.
 */
export function getMediaKind(
  item?: { mimeType?: string; nome?: string } | null,
  categoria?: string | null
): MediaKind {
  if (categoria === 'Vídeos') return 'video';
  if (EXTENSAO_VIDEO.test(item?.nome || '')) return 'video';
  const mime = (item?.mimeType || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  return 'image';
}

/**
 * Link para baixar o arquivo ORIGINAL (qualidade máxima), não a miniatura.
 * Para uploads locais usa a URL salva no item.
 */
export function getOriginalDownloadUrl(item?: {
  driveFileId?: string;
  downloadUrl?: string;
  viewUrl?: string;
  nome?: string;
} | null): string {
  if (!item) return '';
  if (isDriveFileId(item.driveFileId)) {
    // Mesmo domínio do painel: o navegador salva o arquivo em vez de navegar para o Drive.
    const name = encodeURIComponent(item.nome || '');
    return `/api/media/original/${encodeURIComponent(item.driveFileId)}${name ? `?name=${name}` : ''}`;
  }
  return item.downloadUrl || item.viewUrl || '';
}

/** Preview do Drive, usado para reproduzir vídeos do Drive dentro do sistema. */
export function getDrivePreviewUrl(driveFileId?: string): string {
  if (!isDriveFileId(driveFileId)) return '';
  return `https://drive.google.com/file/d/${encodeURIComponent(driveFileId)}/preview`;
}

/** Nome sugerido para o arquivo baixado, preservando a extensão. */
export function getDownloadFileName(item?: { nome?: string } | null): string {
  return (item?.nome || 'midia').replace(/[\\/:*?"<>|]+/g, '_');
}
