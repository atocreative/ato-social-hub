import React, { useEffect, useState } from 'react';
import { DriveImageItem } from '../types/index.ts';
import {
  getAspectRatioBadge,
  detectAspectRatioFromDimensions,
  MediaAspectRatio,
} from '../utils/postHelpers.ts';
import { ChevronLeft, ChevronRight, Download, Maximize2 } from 'lucide-react';
import { driveThumbUrl } from '../utils/mediaUrl.ts';
import { MediaDownloadButton } from './MediaDownloadButton.tsx';
import { MediaImage } from './MediaImage.tsx';
import { getOriginalDownloadUrl, getDownloadFileName } from '../utils/mediaKind.ts';

interface CarouselViewerProps {
  items: DriveImageItem[];
  categoria?: string;
  loteNome?: string;
  currentIndex?: number;
  onIndexChange?: (index: number) => void;
  onExpand?: (index: number) => void;
  onRatioDetected?: (ratio: MediaAspectRatio) => void;
}

export const CarouselViewer: React.FC<CarouselViewerProps> = ({
  items,
  categoria = 'Carrossel',
  loteNome = '',
  currentIndex: controlledIndex,
  onIndexChange,
  onExpand,
  onRatioDetected,
}) => {
  const [internalIndex, setInternalIndex] = useState(0);
  const currentIndex = controlledIndex !== undefined ? controlledIndex : internalIndex;

  // Store detected aspect ratio per slide (or batch) from real naturalWidth / naturalHeight
  const [slideDimensions, setSlideDimensions] = useState<
    Record<number, { width: number; height: number; ratio: MediaAspectRatio }>
  >({});
  const [downloadProgress, setDownloadProgress] = useState<{ done: number; total: number } | null>(null);

  // Dispara o download de cada slide em sequência (um clique por arquivo, com pausa entre eles
  // para o navegador não bloquear os downloads extras).
  const handleDownloadAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (downloadProgress || !items?.length) return;
    const targets = items
      .map((item) => ({ href: getOriginalDownloadUrl(item), name: getDownloadFileName(item) }))
      .filter((t) => t.href);
    for (let i = 0; i < targets.length; i++) {
      setDownloadProgress({ done: i, total: targets.length });
      const a = document.createElement('a');
      a.href = targets[i].href;
      a.download = targets[i].name;
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (i < targets.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    setDownloadProgress(null);
  };

  const setIndex = (nextIndex: number) => {
    if (onIndexChange) {
      onIndexChange(nextIndex);
    } else {
      setInternalIndex(nextIndex);
    }
  };

  if (!items || items.length === 0) {
    return (
      <div className="w-full aspect-square bg-[#121212] rounded-lg flex items-center justify-center text-xs text-[#8E8E93] border border-[#242424]">
        Nenhuma imagem disponível
      </div>
    );
  }

  const currentItem = items[currentIndex] || items[0];

  // Pré-carrega o slide anterior e o próximo: a troca de imagem acontece sem espera.
  useEffect(() => {
    if (items.length < 2) return;
    const neighbors = [currentIndex + 1, currentIndex - 1].map(
      (i) => items[(i + items.length) % items.length]
    );
    for (const item of neighbors) {
      const src = driveThumbUrl(item?.driveFileId, 800) || item?.viewUrl || item?.thumbnailUrl;
      if (src) {
        const preload = new Image();
        preload.decoding = 'async';
        preload.src = src;
      }
    }
  }, [currentIndex, items]);
  const currentDim = slideDimensions[currentIndex] || slideDimensions[0];

  const aspectRatioLabel: MediaAspectRatio = currentDim
    ? currentDim.ratio
    : getAspectRatioBadge(categoria, undefined, undefined, `${loteNome} ${currentItem?.nome || ''}`);

  const containerAspectClass =
    aspectRatioLabel === '9:16'
      ? 'aspect-[9/16] max-h-[380px]'
      : aspectRatioLabel === '4:5'
      ? 'aspect-[4/5]'
      : aspectRatioLabel === '16:9'
      ? 'aspect-video'
      : 'aspect-square';

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIndex(currentIndex > 0 ? currentIndex - 1 : items.length - 1);
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIndex(currentIndex < items.length - 1 ? currentIndex + 1 : 0);
  };

  return (
    <div className="w-full flex flex-col select-none">
      {/* Unobstructed Artwork Viewport Scaled to Exact Aspect Ratio (1:1, 4:5, or 9:16) */}
      <div
        onClick={() => onExpand?.(currentIndex)}
        className={`relative w-full ${containerAspectClass} bg-[#121212] rounded-lg border border-[#242424] overflow-hidden flex items-center justify-center group transition-all ${
          onExpand ? 'cursor-zoom-in' : ''
        }`}
      >
        <MediaImage
          key={`${currentIndex}-${currentItem.driveFileId || currentItem.viewUrl || ''}`}
          item={currentItem}
          width={800}
          alt={`Slide ${currentIndex + 1}: ${currentItem.nome}`}
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
              onRatioDetected?.(detected);
            }
          }}
          className="w-full h-full object-cover transition-opacity duration-200"
        />

        {/* Download do slide atual em qualidade original (só este slide, não o carrossel inteiro) */}
        <div className="absolute bottom-2.5 left-2.5 z-10">
          <MediaDownloadButton item={currentItem} compact />
        </div>

        {/* Top Bar: Exact Aspect Ratio Badge (1:1, 4:5, or 9:16) + Slide Name + Discrete Expand Button */}
        <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between gap-2 pointer-events-none">
          <div className="flex items-center gap-1.5">
            <span
              className="px-2 py-0.5 rounded-md bg-[#0A0A0A]/90 backdrop-blur-md border border-[#2E2E2E] text-[11px] font-mono font-semibold text-[#10B981] shadow-sm"
              title={
                currentDim
                  ? `Escala detectada: ${aspectRatioLabel} (${currentDim.width}×${currentDim.height}px)`
                  : `Escala: ${aspectRatioLabel}`
              }
            >
              {aspectRatioLabel}
            </span>
            <span className="px-2 py-0.5 rounded-md bg-[#0A0A0A]/80 backdrop-blur-md border border-[#242424] text-[11px] font-mono text-[#A0A0A5] truncate max-w-[140px]">
              {currentItem.nome}
            </span>
          </div>

          {onExpand && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onExpand(currentIndex);
              }}
              aria-label="Expandir imagem"
              title="Expandir imagem em tamanho real"
              className="pointer-events-auto px-2 py-1 rounded-md bg-[#0A0A0A]/85 hover:bg-[#10B981] text-white hover:text-[#0A0A0A] border border-[#2E2E2E] hover:border-[#10B981] text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer shadow-sm"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Expandir</span>
            </button>
          )}
        </div>
      </div>

      {/* External Carousel Controls Positioned Below the Image Container */}
      <div className="mt-2.5 flex items-center justify-between gap-2 bg-[#121212] border border-[#242424] rounded-lg px-2.5 py-1.5">
        <button
          type="button"
          onClick={handlePrev}
          aria-label="Slide anterior"
          className="px-2.5 py-1 bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E] rounded-md text-xs text-white font-medium flex items-center gap-1 transition-colors cursor-pointer"
        >
          <ChevronLeft className="w-3.5 h-3.5 text-[#10B981]" />
          <span>Anterior</span>
        </button>

        {/* Page Indicators & Slide Counter */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            {items.map((_, idx) => (
              <button
                key={idx}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIndex(idx);
                }}
                className={`h-1.5 rounded-full transition-all cursor-pointer ${
                  idx === currentIndex
                    ? 'w-4 bg-[#10B981]'
                    : 'w-1.5 bg-[#333333] hover:bg-[#555555]'
                }`}
                aria-label={`Ir para slide ${idx + 1}`}
              />
            ))}
          </div>
          <span className="text-[11px] font-mono tabular-nums text-[#8E8E93]">
            {String(currentIndex + 1).padStart(2, '0')}/{String(items.length).padStart(2, '0')}
          </span>
        </div>

        <button
          type="button"
          onClick={handleNext}
          aria-label="Próximo slide"
          className="px-2.5 py-1 bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E] rounded-md text-xs text-white font-medium flex items-center gap-1 transition-colors cursor-pointer"
        >
          <span>Próximo</span>
          <ChevronRight className="w-3.5 h-3.5 text-[#10B981]" />
        </button>
      </div>

      {/* Baixar todos os slides do carrossel em qualidade original */}
      <button
        type="button"
        onClick={handleDownloadAll}
        disabled={downloadProgress !== null}
        aria-label={`Baixar todas as ${items.length} imagens do carrossel`}
        title="Baixar todas as imagens do carrossel em qualidade original"
        className="mt-2 w-full px-3 py-1.5 bg-[#1A1A1A] hover:bg-[#10B981]/15 border border-[#2E2E2E] hover:border-[#10B981] hover:text-[#10B981] disabled:opacity-60 disabled:cursor-wait rounded-lg text-xs text-white font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
      >
        <Download className="w-3.5 h-3.5" />
        <span>
          {downloadProgress
            ? `Baixando ${Math.min(downloadProgress.done + 1, downloadProgress.total)}/${downloadProgress.total}...`
            : `Baixar todas (${items.length})`}
        </span>
      </button>
    </div>
  );
};
