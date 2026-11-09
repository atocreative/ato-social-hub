import React, { useEffect, useState } from 'react';
import { PostGroup } from '../types/index.ts';
import {
  getAspectRatioBadge,
  detectAspectRatioFromDimensions,
  formatDateTimeBR,
  MediaAspectRatio,
} from '../utils/postHelpers.ts';
import { X, ChevronLeft, ChevronRight, Layers, Check, XCircle } from 'lucide-react';
import { getMediaKind, getDrivePreviewUrl } from '../utils/mediaKind.ts';
import { MediaDownloadButton } from './MediaDownloadButton.tsx';
import { MediaImage } from './MediaImage.tsx';

interface MediaLightboxModalProps {
  post: PostGroup;
  initialIndex?: number;
  isOpen: boolean;
  onClose: () => void;
  onApprove?: (post: PostGroup) => void;
  onReject?: (post: PostGroup) => void;
}

export const MediaLightboxModal: React.FC<MediaLightboxModalProps> = ({
  post,
  initialIndex = 0,
  isOpen,
  onClose,
  onApprove,
  onReject,
}) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [slideDimensions, setSlideDimensions] = useState<
    Record<number, { width: number; height: number; ratio: MediaAspectRatio }>
  >({});

  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex, post.id]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft' && post.items.length > 1) {
        setCurrentIndex((prev) => (prev > 0 ? prev - 1 : post.items.length - 1));
      } else if (e.key === 'ArrowRight' && post.items.length > 1) {
        setCurrentIndex((prev) => (prev < post.items.length - 1 ? prev + 1 : 0));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, post.items.length]);

  if (!isOpen) return null;

  const items = post.items || [];
  const currentItem = items[currentIndex] || items[0];
  const isCarousel = items.length > 1 || post.categoria === 'Carrossel';
  const currentDim = slideDimensions[currentIndex] || slideDimensions[0];

  const aspectRatioLabel: MediaAspectRatio = currentDim
    ? currentDim.ratio
    : getAspectRatioBadge(
        post.categoria,
        undefined,
        undefined,
        `${post.loteNome || ''} ${post.nome || ''} ${currentItem?.nome || ''}`
      );

  const clientName =
    post.pastaClienteNome ||
    (post.driveFolderName && post.driveFolderName.toLowerCase() !== 'ato social midia'
      ? post.driveFolderName
      : '');

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : items.length - 1));
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentIndex((prev) => (prev < items.length - 1 ? prev + 1 : 0));
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 md:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Visualização expandida: ${post.loteNome || post.nome}`}
    >
      <div
        className="w-full max-w-5xl bg-[#121212] border border-[#242424] rounded-xl overflow-hidden flex flex-col max-h-[92vh] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-4 py-3 border-b border-[#242424] flex items-center justify-between gap-4 bg-[#121212]">
          <div className="min-w-0 flex-1">
            <div className="flex items-center flex-wrap gap-2 mb-1">
              {clientName && (
                <span className="inline-flex items-center px-2 py-0.5 rounded bg-[#10B981]/15 border border-[#10B981]/40 text-[#10B981] font-mono text-[11px] font-semibold">
                  {clientName}
                </span>
              )}
              <span className="inline-flex items-center px-2 py-0.5 rounded bg-[#1A1A1A] border border-[#2E2E2E] text-[#10B981] font-mono text-[11px] font-semibold">
                {aspectRatioLabel}
                {currentDim && currentDim.width > 0 && (
                  <span className="ml-1.5 text-[#8E8E93] font-normal">
                    ({currentDim.width}×{currentDim.height}px)
                  </span>
                )}
              </span>
              <span className="text-xs text-[#8E8E93]">
                {isCarousel ? `Carrossel (${items.length} slides)` : post.categoria}
              </span>
              <span className="text-xs text-[#555555]">·</span>
              <span className="text-xs text-[#8E8E93] font-mono tabular-nums">
                {formatDateTimeBR(post.dataCriacao)}
              </span>
            </div>
            <h3 className="text-sm font-semibold text-white truncate">
              {post.loteNome || post.nome}
              {currentItem?.nome && (
                <span className="ml-2 text-xs font-mono text-[#8E8E93] font-normal">
                  ({currentItem.nome})
                </span>
              )}
            </h3>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <MediaDownloadButton item={currentItem} />
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar visualização expandida"
            className="p-2 rounded-lg bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E] text-[#8E8E93] hover:text-white transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Full-size Artwork Viewport */}
        <div className="relative flex-1 bg-[#080808] flex items-center justify-center p-4 md:p-6 overflow-auto min-h-[320px]">
          {currentItem && getMediaKind(currentItem, post.categoria) === 'video' ? (
            getDrivePreviewUrl(currentItem.driveFileId) ? (
              <iframe
                src={getDrivePreviewUrl(currentItem.driveFileId)}
                title={currentItem.nome || post.nome}
                allow="autoplay; fullscreen"
                allowFullScreen
                className="w-full max-w-4xl aspect-video rounded-lg border border-[#1E1E1E] bg-black"
              />
            ) : (
              <video
                src={currentItem.viewUrl}
                controls
                playsInline
                className="max-h-[68vh] w-auto max-w-full rounded-lg border border-[#1E1E1E] bg-black"
              />
            )
          ) : currentItem ? (
            <MediaImage
              key={`${currentIndex}-${currentItem.driveFileId || currentItem.viewUrl || ''}`}
              item={currentItem}
              width={1600}
              alt={currentItem.nome || post.nome}
              placeholderClassName="w-[min(90vw,420px)] aspect-square"
              onLoad={(e) => {
                const { naturalWidth, naturalHeight } = e.currentTarget;
                if (naturalWidth > 0 && naturalHeight > 0) {
                  const detected = detectAspectRatioFromDimensions(naturalWidth, naturalHeight);
                  setSlideDimensions((prev) => ({
                    ...prev,
                    [currentIndex]: {
                      width: naturalWidth,
                      height: naturalHeight,
                      ratio: detected,
                    },
                  }));
                }
              }}
              className="max-h-[68vh] w-auto max-w-full object-contain rounded-lg border border-[#1E1E1E]"
            />
          ) : (
            <div className="text-xs text-[#8E8E93]">Nenhuma imagem disponível</div>
          )}
        </div>

        {/* Footer Controls: External Carousel Controls + Quick Approval Actions */}
        <div className="px-4 py-3 border-t border-[#242424] bg-[#121212] flex flex-col sm:flex-row items-center justify-between gap-3">
          {items.length > 1 ? (
            <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-start">
              <button
                type="button"
                onClick={handlePrev}
                className="px-3 py-1.5 bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E] rounded-lg text-xs text-white font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5 text-[#10B981]" />
                <span>Anterior</span>
              </button>

              <div className="flex items-center gap-2 px-2">
                <div className="flex items-center gap-1.5">
                  {items.map((_, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setCurrentIndex(idx)}
                      aria-label={`Ir para slide ${idx + 1}`}
                      className={`h-1.5 rounded-full transition-all cursor-pointer ${
                        idx === currentIndex
                          ? 'w-5 bg-[#10B981]'
                          : 'w-1.5 bg-[#333333] hover:bg-[#555555]'
                      }`}
                    />
                  ))}
                </div>
                <span className="text-xs font-mono tabular-nums text-[#8E8E93] ml-1">
                  {String(currentIndex + 1).padStart(2, '0')}/{String(items.length).padStart(2, '0')}
                </span>
              </div>

              <button
                type="button"
                onClick={handleNext}
                className="px-3 py-1.5 bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E] rounded-lg text-xs text-white font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <span>Próximo</span>
                <ChevronRight className="w-3.5 h-3.5 text-[#10B981]" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-[#8E8E93]">
              <Layers className="w-3.5 h-3.5 text-[#10B981]" />
              <span>
                Visualização em tamanho real · Escala <strong className="text-white font-mono">{aspectRatioLabel}</strong>
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            {onReject && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onReject(post);
                }}
                className="px-3.5 py-2 bg-[#1A1A1A] hover:bg-[#241A1A] border border-[#2A2A2A] text-[#EF4444] text-xs font-medium rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <XCircle className="w-3.5 h-3.5" />
                <span>{post.status === 'REPROVADO' ? 'Ajustar' : 'Reprovar'}</span>
              </button>
            )}
            {onApprove && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onApprove(post);
                }}
                className="px-4 py-2 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-xs rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5" />
                <span>
                  {post.status === 'PENDENTE'
                    ? 'Aprovar'
                    : post.status === 'APROVADO'
                    ? 'Agendar / Publicar'
                    : post.status === 'REPROVADO'
                    ? 'Reaprovar'
                    : 'Reagendar'}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
