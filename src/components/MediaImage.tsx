import React, { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { driveThumbUrl } from '../utils/mediaUrl.ts';

// Ids já reportados nesta sessão: evita recarregar a lista em loop para a mesma mídia.
const reportedUnavailable = new Set<string>();

interface MediaImageItem {
  driveFileId?: string;
  viewUrl?: string;
  thumbnailUrl?: string;
  nome?: string;
}

interface MediaImageProps {
  item?: MediaImageItem | null;
  /** Largura pedida ao proxy de miniaturas (ex.: 400, 800, 1600). */
  width: number;
  alt: string;
  className?: string;
  placeholderClassName?: string;
  onLoad?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
}

/**
 * Imagem de mídia com cadeia de fallback: proxy do servidor -> URL salva no item -> miniatura do Drive.
 * Se nenhuma fonte carregar, mostra um placeholder com o nome do arquivo em vez de sumir com a mídia.
 */
export const MediaImage: React.FC<MediaImageProps> = ({
  item,
  width,
  alt,
  className = '',
  placeholderClassName = 'w-full h-full min-h-[220px]',
  onLoad,
}) => {
  const driveFileId = item?.driveFileId;
  const sources = Array.from(
    new Set(
      [
        driveThumbUrl(driveFileId, width),
        item?.viewUrl,
        item?.thumbnailUrl,
        driveFileId && !driveFileId.startsWith('drive_') && !driveFileId.startsWith('upload_')
          ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(driveFileId)}&sz=w${width}`
          : null,
      ].filter((s): s is string => Boolean(s))
    )
  );

  const [sourceIndex, setSourceIndex] = useState(0);
  const exhausted = sourceIndex >= sources.length;

  // Recomeça a cadeia de fallback quando o item (ou o tamanho) muda.
  useEffect(() => {
    setSourceIndex(0);
  }, [driveFileId, width, item?.viewUrl, item?.thumbnailUrl]);

  // Avisa a aplicação (uma vez por arquivo) para recarregar a lista: o servidor oculta mídias quebradas.
  useEffect(() => {
    if (!exhausted || !driveFileId || reportedUnavailable.has(driveFileId)) return;
    reportedUnavailable.add(driveFileId);
    window.dispatchEvent(new CustomEvent('ato:media-unavailable', { detail: driveFileId }));
  }, [exhausted, driveFileId]);

  if (exhausted) {
    return (
      <div
        role="img"
        aria-label={`${alt} (imagem indisponível)`}
        className={`${placeholderClassName} ${className} flex flex-col items-center justify-center gap-2 bg-[#0E0E0E] border border-dashed border-[#2E2E2E] rounded-lg p-4 text-center`}
      >
        <ImageOff className="w-6 h-6 text-[#F59E0B]" />
        <span className="text-[11px] font-semibold text-[#F59E0B]">Imagem indisponível</span>
        {item?.nome && (
          <span className="text-[10px] font-mono text-[#8E8E93] break-all line-clamp-2">{item.nome}</span>
        )}
      </div>
    );
  }

  return (
    <img
      src={sources[sourceIndex]}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      onError={() => setSourceIndex((i) => i + 1)}
      className={className}
    />
  );
};
