import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { PostGroup } from '../../types/index.ts';
import { buildHistory, contentTypeLabel, mediaTypeLabel } from '../../utils/history.ts';
import { formatDateTime, statusLabel, thumbnailOf } from './format.ts';
import { ImageZoomModal } from './ImageZoomModal.tsx';

interface HistoryViewProps {
  posts: PostGroup[];
}

export const HistoryView: React.FC<HistoryViewProps> = ({ posts }) => {
  const items = useMemo(() => buildHistory(posts), [posts]);
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);

  return (
    <div className="space-y-6 max-w-5xl">
      <header>
        <h1 className="text-2xl font-bold">Histórico</h1>
        <p className="text-sm text-[#8E8E93] mt-1">
          Publicações feitas e agendadas, com data, formato e tipo de conteúdo.
        </p>
      </header>

      {items.length === 0 ? (
        <p className="text-sm text-[#8E8E93] py-12 text-center bg-[#121212] border border-[#242424] rounded-2xl">
          Nenhuma publicação no histórico ainda.
        </p>
      ) : (
        <ul className="divide-y divide-[#1C1C1C] bg-[#121212] border border-[#242424] rounded-2xl overflow-hidden">
          {items.map(({ post, kind, date }) => {
            const thumb = thumbnailOf(post);
            return (
              <li key={post.id} className="flex items-center gap-4 p-4">
                <div className="relative w-16 h-16 shrink-0 group">
                  {thumb ? (
                    <img src={thumb} alt="" className="w-16 h-16 rounded-lg object-cover bg-[#1A1A1A]" />
                  ) : (
                    <div className="w-16 h-16 rounded-lg bg-[#1A1A1A]" />
                  )}
                  {thumb && (
                    <button
                      type="button"
                      aria-label="Ampliar imagem"
                      onClick={() => setZoom({ src: thumb, alt: post.nome })}
                      className="absolute inset-0 rounded-lg bg-black/55 opacity-0 group-hover:opacity-100 focus:opacity-100 flex items-center justify-center transition-opacity cursor-zoom-in"
                    >
                      <Search className="w-5 h-5 text-white" />
                    </button>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{post.nome}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#8E8E93]">
                    <span className="font-mono tabular-nums">
                      {kind === 'PUBLICADO' ? 'Publicado' : 'Agendado'}: {formatDateTime(date)}
                    </span>
                    <span>{mediaTypeLabel(post.categoria)}</span>
                    <span className="text-[#10B981]">{contentTypeLabel(post.tipoConteudo)}</span>
                  </div>
                  {post.descricaoConteudo && (
                    <p className="text-xs text-[#8E8E93] mt-1 truncate">{post.descricaoConteudo}</p>
                  )}
                </div>

                <span className="text-[11px] px-2 py-1 rounded-md border border-[#242424] text-[#8E8E93] whitespace-nowrap">
                  {statusLabel(post.status)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {zoom && <ImageZoomModal src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
    </div>
  );
};
