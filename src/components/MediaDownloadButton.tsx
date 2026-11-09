import React from 'react';
import { Download } from 'lucide-react';
import { getOriginalDownloadUrl } from '../utils/mediaKind';

interface MediaDownloadButtonProps {
  item?: {
    driveFileId?: string;
    downloadUrl?: string;
    viewUrl?: string;
    nome?: string;
  } | null;
  className?: string;
  compact?: boolean;
}

/**
 * Baixa o arquivo ORIGINAL do Drive (qualidade máxima).
 * Não dispara o clique do card: o evento é parado antes de propagar.
 */
export function MediaDownloadButton({ item, className = '', compact = false }: MediaDownloadButtonProps) {
  const href = getOriginalDownloadUrl(item);
  if (!href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      aria-label={`Baixar ${item?.nome || 'arquivo'} em qualidade original`}
      title="Baixar em qualidade original"
      className={`inline-flex items-center gap-1 rounded-md bg-[#0A0A0A]/85 text-white border border-[#2E2E2E] hover:border-[#10B981] hover:text-[#10B981] transition-colors shadow-sm ${
        compact ? 'p-1.5' : 'px-2 py-1 text-[11px] font-medium'
      } ${className}`}
    >
      <Download className="w-3.5 h-3.5" />
      {!compact && <span>Baixar</span>}
    </a>
  );
}
