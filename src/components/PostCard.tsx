import React, { useState, useRef, useEffect } from 'react';
import { PostGroup } from '../types/index.ts';
import { CarouselViewer } from './CarouselViewer.tsx';
import { MediaLightboxModal } from './MediaLightboxModal.tsx';
import { driveThumbUrl } from '../utils/mediaUrl.ts';
import {
  formatDateTimeBR,
  getAspectRatioBadge,
  detectAspectRatioFromDimensions,
  MediaAspectRatio,
} from '../utils/postHelpers.ts';
import { MoreVertical, Eye, EyeOff, Trash2, Maximize2 } from 'lucide-react';

interface PostCardProps {
  post: PostGroup;
  onApprove: (post: PostGroup) => void;
  onReject: (post: PostGroup) => void;
  onDelete?: (post: PostGroup) => void;
  onHide?: (post: PostGroup) => void;
  onUnhide?: (post: PostGroup) => void;
}

export const PostCard: React.FC<PostCardProps> = ({ post, onApprove, onReject, onDelete, onHide, onUnhide }) => {
  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [detectedDimensions, setDetectedDimensions] = useState<{
    width: number;
    height: number;
    ratio: MediaAspectRatio;
  } | null>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    if (isMenuOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isMenuOpen]);

  const isCarousel = post.categoria === 'Carrossel' || post.items.length > 1;
  const isStory = post.categoria.toLowerCase().includes('story');
  const isReprovado = post.status === 'REPROVADO';
  const isPendente = post.status === 'PENDENTE';
  const isAprovado = post.status === 'APROVADO';
  const isUpload =
    post.origem === 'UPLOAD' ||
    post.id.startsWith('upload_') ||
    post.items.some((i) => i.origem === 'UPLOAD' || i.driveFileId?.startsWith('upload_'));

  const firstItem = post.items[0];
  const aspectRatioLabel: MediaAspectRatio = detectedDimensions
    ? detectedDimensions.ratio
    : getAspectRatioBadge(
        post.categoria,
        undefined,
        undefined,
        `${post.loteNome || ''} ${post.nome || ''} ${firstItem?.nome || ''}`
      );

  const singleContainerAspectClass =
    aspectRatioLabel === '9:16'
      ? 'aspect-[9/16] max-h-[380px]'
      : aspectRatioLabel === '4:5'
      ? 'aspect-[4/5]'
      : aspectRatioLabel === '16:9'
      ? 'aspect-video'
      : 'aspect-square';

  const clientName =
    post.pastaClienteNome ||
    (post.driveFolderName && post.driveFolderName.toLowerCase() !== 'ato social midia'
      ? post.driveFolderName
      : 'ATO');

  const handleOpenLightbox = (slideIndex: number = 0) => {
    setCurrentSlideIndex(slideIndex);
    setIsLightboxOpen(true);
  };

  return (
    <>
      <article className={`bg-[#121212] border rounded-xl flex flex-col justify-between overflow-hidden relative transition-all ${post.isDeletedByClient ? 'border-[#EF4444]/40 bg-[#170C0C]' : 'border-[#242424]'}`}>
        {/* Top Card Header */}
        <div className="p-4 border-b border-[#242424] flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center flex-wrap gap-1.5 mb-2 text-xs text-[#8E8E93]">
              <span
                className="inline-flex items-center px-2 py-0.5 rounded-md bg-[#10B981]/15 border border-[#10B981]/40 text-[#10B981] font-mono text-[11px] font-semibold"
                title={`Marca: ${clientName}`}
              >
                {clientName}
              </span>
              <span>
                {isCarousel
                  ? `Carrossel (${post.items.length})`
                  : isStory
                  ? 'Story'
                  : 'Post único'}
              </span>
              <span>·</span>
              <span className="font-mono tabular-nums">{formatDateTimeBR(post.dataCriacao)}</span>

              {post.isDeletedByClient ? (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-red-950/80 border border-[#EF4444]/60 text-[#EF4444] uppercase tracking-wider gap-1 shadow-sm">
                    <Trash2 className="w-3 h-3 text-[#EF4444]" />
                    Apagado pelo Cliente
                  </span>
                </>
              ) : post.status !== 'PENDENTE' && (
                <>
                  <span>·</span>
                  <span
                    className={
                      post.status === 'REPROVADO' ||
                      post.status === 'FALHA_PUBLICACAO' ||
                      post.status === 'CANCELADO'
                        ? 'text-[#EF4444]'
                        : post.status === 'PUBLICADO' || post.status === 'APROVADO'
                        ? 'text-[#10B981]'
                        : post.status === 'RECONEXAO_NECESSARIA'
                        ? 'text-[#F59E0B] font-semibold'
                        : 'text-[#F59E0B]'
                    }
                  >
                    {post.status === 'REPROVADO'
                      ? 'Reprovado'
                      : post.status === 'CANCELADO'
                      ? 'Cancelado'
                      : post.status === 'PUBLICADO'
                      ? 'Publicado'
                      : post.status === 'APROVADO'
                      ? 'Aprovado'
                      : post.status === 'PUBLICANDO'
                      ? 'Publicando...'
                      : post.status === 'RECONEXAO_NECESSARIA'
                      ? 'Reconexão Necessária'
                      : post.status === 'FALHA_PUBLICACAO'
                      ? 'Falha na Publicação'
                      : 'Agendado'}
                  </span>
                </>
              )}
            </div>

            <h3 className="text-sm font-semibold text-white truncate" title={post.loteNome || post.nome}>
              {post.loteNome || post.nome}
            </h3>
          </div>

          {/* 3-dot context menu replacing direct Drive link or lone button */}
          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              onClick={() => setIsMenuOpen((prev) => !prev)}
              aria-label="Opções do criativo"
              title="Mais opções"
              className="p-1.5 rounded-lg bg-[#1A1A1A] hover:bg-[#242424] border border-[#2A2A2A] text-[#8E8E93] hover:text-white transition-colors cursor-pointer"
            >
              <MoreVertical className="w-4 h-4" />
            </button>

            {isMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-44 bg-[#181818] border border-[#2A2A2A] rounded-lg shadow-2xl py-1 z-30">
                <button
                  type="button"
                  onClick={() => {
                    setIsMenuOpen(false);
                    handleOpenLightbox(currentSlideIndex);
                  }}
                  className="w-full px-3 py-2 text-left text-xs text-white hover:bg-[#242424] flex items-center gap-2 cursor-pointer transition-colors"
                >
                  <Eye className="w-3.5 h-3.5 text-[#10B981]" />
                  <span>Visualizar</span>
                </button>

                {post.isDeletedByClient ? (
                  onUnhide && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsMenuOpen(false);
                        onUnhide(post);
                      }}
                      className="w-full px-3 py-2 text-left text-xs text-[#10B981] hover:bg-[#10B981]/10 flex items-center gap-2 cursor-pointer transition-colors border-t border-[#262626]"
                    >
                      <Eye className="w-3.5 h-3.5 text-[#10B981]" />
                      <span>Restaurar post</span>
                    </button>
                  )
                ) : isUpload ? (
                  onDelete && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsMenuOpen(false);
                        onDelete(post);
                      }}
                      className="w-full px-3 py-2 text-left text-xs text-[#EF4444] hover:bg-red-950/30 flex items-center gap-2 cursor-pointer transition-colors border-t border-[#262626]"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-[#EF4444]" />
                      <span>Excluir mídia</span>
                    </button>
                  )
                ) : (
                  onHide && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsMenuOpen(false);
                        onHide(post);
                      }}
                      className="w-full px-3 py-2 text-left text-xs text-[#EF4444] hover:bg-red-950/30 flex items-center gap-2 cursor-pointer transition-colors border-t border-[#262626]"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-[#EF4444]" />
                      <span>Apagar post</span>
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        </div>

        {/* Visual Preview Scaled to Exact Aspect Ratio */}
        <div className="p-4 bg-[#0A0A0A] flex items-center justify-center">
          {isCarousel ? (
            <CarouselViewer
              items={post.items}
              categoria={post.categoria}
              loteNome={post.loteNome}
              currentIndex={currentSlideIndex}
              onIndexChange={setCurrentSlideIndex}
              onExpand={(idx) => handleOpenLightbox(idx)}
              onRatioDetected={(ratio) =>
                setDetectedDimensions((prev) =>
                  prev?.ratio === ratio ? prev : { width: 0, height: 0, ratio }
                )
              }
            />
          ) : (
            <div
              onClick={() => handleOpenLightbox(0)}
              className={`relative w-full ${singleContainerAspectClass} bg-[#121212] border border-[#242424] rounded-lg overflow-hidden flex items-center justify-center cursor-zoom-in group transition-all`}
            >
              <img
                src={driveThumbUrl(firstItem?.driveFileId, 400) || firstItem?.viewUrl || firstItem?.thumbnailUrl}
                alt={post.nome}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                onLoad={(e) => {
                  const { naturalWidth, naturalHeight } = e.currentTarget;
                  if (naturalWidth > 0 && naturalHeight > 0) {
                    const detected = detectAspectRatioFromDimensions(naturalWidth, naturalHeight);
                    setDetectedDimensions({
                      width: naturalWidth,
                      height: naturalHeight,
                      ratio: detected,
                    });
                  }
                }}
                onError={(e) => {
                  const target = e.currentTarget;
                  const item = post.items[0];
                  if (!item) return;
                  const thumbFallback =
                    item.thumbnailUrl && target.src !== item.thumbnailUrl
                      ? item.thumbnailUrl
                      : item.driveFileId
                      ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(item.driveFileId)}&sz=w1200`
                      : '';
                  if (thumbFallback && target.src !== thumbFallback) {
                    target.src = thumbFallback;
                  }
                }}
                className="w-full h-full object-cover"
              />

              {/* Discrete Expand Icon on Hover */}
              <div className="absolute bottom-2.5 right-2.5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                <span className="px-2 py-1 rounded-md bg-[#0A0A0A]/85 text-white border border-[#2E2E2E] text-[11px] font-medium flex items-center gap-1 shadow-sm">
                  <Maximize2 className="w-3 h-3 text-[#10B981]" />
                  <span>Ampliar</span>
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Schedule / Publication / Reconnection Info Bar */}
        {(post.scheduledAt || post.publishedAt || post.failureReason || post.instagramPermalink) && (
          <div className="px-4 py-2.5 bg-[#0E0E0E] border-t border-[#242424] text-[11px] space-y-1">
            {post.scheduledAt && post.status !== 'PUBLICADO' && (
              <div className="flex items-center justify-between text-[#F59E0B] font-mono">
                <span>Agendado (SP): {formatDateTimeBR(post.scheduledAt)}</span>
                {post.publishAttempts ? (
                  <span className="text-[#8E8E93]">Tentativas: {post.publishAttempts}</span>
                ) : null}
              </div>
            )}
            {post.publishedAt && post.status === 'PUBLICADO' && (
              <div className="flex items-center justify-between text-[#10B981] font-mono">
                <span>Publicado: {formatDateTimeBR(post.publishedAt)}</span>
                {post.instagramPermalink && (
                  <a
                    href={post.instagramPermalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-white"
                  >
                    Ver no Instagram
                  </a>
                )}
              </div>
            )}
            {post.failureReason && post.status !== 'PUBLICADO' && (
              <div className="text-[#EF4444] break-words">
                {post.failureReason}
              </div>
            )}
          </div>
        )}

        {/* Rejection Feedback Details if Reprovado */}
        {post.rejectionFeedback && (
          <div className="px-4 py-3 bg-[#161111] border-t border-[#331C1C] text-xs space-y-1.5">
            <div className="text-[11px] text-[#EF4444] font-medium">Feedback de Reprovação</div>
            {post.rejectionFeedback.tags && post.rejectionFeedback.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {post.rejectionFeedback.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-1.5 py-0.5 rounded bg-[#2A1616] text-[#EF4444] text-[10px]"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <div className="text-[11px] text-[#E0D0D0]">
              "{post.rejectionFeedback.motivo}"
            </div>
            {post.rejectionFeedback.novoNomeArquivo && (
              <div className="text-[10px] text-[#8E8E93] font-mono truncate">
                Drive: {post.rejectionFeedback.novoNomeArquivo}
              </div>
            )}
          </div>
        )}

        {/* Caption Preview */}
        {post.caption && (
          <div className="px-4 py-2 bg-[#0E0E0E] border-t border-[#242424] text-xs text-[#8E8E93] truncate">
            {post.caption}
          </div>
        )}

        {/* Action Buttons: Clean & Direct */}
        <div className="p-3 border-t border-[#242424] grid grid-cols-2 gap-2 bg-[#121212]">
          <button
            type="button"
            onClick={() => onReject(post)}
            className="w-full py-2 px-3 bg-[#1A1A1A] hover:bg-[#241A1A] border border-[#2A2A2A] text-[#EF4444] text-xs font-medium rounded-lg transition-colors cursor-pointer"
          >
            {isReprovado ? 'Ajustar' : 'Reprovar'}
          </button>

          <button
            type="button"
            onClick={() => onApprove(post)}
            className="w-full py-2 px-3 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-xs rounded-lg transition-colors cursor-pointer"
          >
            {isPendente
              ? 'Aprovar'
              : isAprovado
              ? 'Agendar / Publicar'
              : isReprovado
              ? 'Reaprovar'
              : post.status === 'RECONEXAO_NECESSARIA' || post.status === 'FALHA_PUBLICACAO'
              ? 'Reconectar / Publicar'
              : 'Reagendar'}
          </button>
        </div>
      </article>

      {/* Lightbox Modal for Expanded Visual Inspection */}
      <MediaLightboxModal
        post={post}
        initialIndex={currentSlideIndex}
        isOpen={isLightboxOpen}
        onClose={() => setIsLightboxOpen(false)}
        onApprove={onApprove}
        onReject={onReject}
      />
    </>
  );
};
