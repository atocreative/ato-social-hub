import React, { useMemo, useState } from 'react';
import { Upload } from 'lucide-react';
import type { PostGroup, InstagramPublishPayload } from '../../types/index.ts';
import { filterPosts, type CategoryFilter, type MediaFilter } from '../../utils/postHelpers.ts';
import { api } from '../../services/api.ts';
import { PostCard } from '../PostCard.tsx';
import { ApprovalModal } from '../ApprovalModal.tsx';
import { RejectionModal } from '../RejectionModal.tsx';
import { UploadMediaModal } from '../UploadMediaModal.tsx';
import { MarkPublishedModal } from './MarkPublishedModal.tsx';

type Tab = 'TODOS' | 'PENDENTES' | 'AGENDADOS' | 'PUBLICADOS' | 'NAO_VOU_POSTAR' | 'REPROVADOS';

const TABS: { id: Tab; label: string }[] = [
  { id: 'TODOS', label: 'Todos' },
  { id: 'PENDENTES', label: 'Pendentes' },
  { id: 'AGENDADOS', label: 'Agendados' },
  { id: 'PUBLICADOS', label: 'Publicados' },
  { id: 'NAO_VOU_POSTAR', label: 'Não vou postar' },
  { id: 'REPROVADOS', label: 'Reprovados' },
];

const CATEGORIES: CategoryFilter[] = ['TODOS', 'Post Único', 'Carrossel', 'Story', 'Vídeos'];
const MEDIA: { id: MediaFilter; label: string }[] = [
  { id: 'TODOS', label: 'Todos os formatos' },
  { id: 'IMAGENS', label: 'Imagens' },
  { id: 'VIDEOS', label: 'Vídeos' },
];

interface PostsViewProps {
  posts: PostGroup[];
  /** Pasta do cliente no Drive, usada pelo upload. */
  folderName: string;
  onChanged: () => void;
  onConfirmPublish: (post: PostGroup, payload: InstagramPublishPayload) => Promise<void>;
  onPublishInstagramNow: (post: PostGroup, caption: string, accountId?: string) => Promise<void>;
  onConfirmReject: (
    post: PostGroup,
    feedback: { tags: string[]; motivo: string; pastaClienteId?: string }
  ) => Promise<void>;
  onHide: (post: PostGroup) => Promise<void>;
  onUnhide: (post: PostGroup) => Promise<void>;
}

export const PostsView: React.FC<PostsViewProps> = ({
  posts,
  folderName,
  onChanged,
  onConfirmPublish,
  onPublishInstagramNow,
  onConfirmReject,
  onHide,
  onUnhide,
}) => {
  const [tab, setTab] = useState<Tab>('TODOS');
  const [category, setCategory] = useState<CategoryFilter>('TODOS');
  const [media, setMedia] = useState<MediaFilter>('TODOS');
  const [approving, setApproving] = useState<PostGroup | null>(null);
  const [rejecting, setRejecting] = useState<PostGroup | null>(null);
  const [markingPublished, setMarkingPublished] = useState<PostGroup | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = useMemo(() => {
    const base = filterPosts(posts, tab === 'NAO_VOU_POSTAR' ? 'TODOS' : tab, '', undefined, category, media);
    return tab === 'NAO_VOU_POSTAR' ? base.filter((p) => p.status === 'NAO_VOU_POSTAR') : base;
  }, [posts, tab, category, media]);

  const organize = async (post: PostGroup, target: 'NAO_VOU_POSTAR' | 'PENDENTE') => {
    setError(null);
    try {
      const res = await api.organizePost(post.id, target);
      if (!res.success) throw new Error(res.error || 'Não foi possível alterar o post.');
      onChanged();
    } catch (err: any) {
      setError(err.message || 'Não foi possível alterar o post.');
    }
  };

  const extraActionsFor = (post: PostGroup) => {
    const actions: { label: string; onClick: () => void }[] = [];
    if (post.status !== 'PUBLICADO') {
      actions.push({ label: 'Marcar como publicado', onClick: () => setMarkingPublished(post) });
    }
    if (post.status !== 'NAO_VOU_POSTAR') {
      actions.push({ label: 'Não vou postar', onClick: () => organize(post, 'NAO_VOU_POSTAR') });
    }
    if (post.status === 'PUBLICADO' || post.status === 'NAO_VOU_POSTAR') {
      actions.push({ label: 'Voltar para pendentes', onClick: () => organize(post, 'PENDENTE') });
    }
    return actions;
  };

  const handleHide = async (post: PostGroup) => {
    setError(null);
    try {
      await onHide(post);
    } catch (err: any) {
      setError(err.message || 'Não foi possível apagar o post do painel.');
    }
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Posts</h1>
          <p className="text-sm text-[#8E8E93] mt-1">Aprove, agende, reprove e organize suas publicações.</p>
        </div>
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-sm cursor-pointer"
        >
          <Upload className="w-4 h-4" />
          <span>Enviar mídia</span>
        </button>
      </header>

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-xs border cursor-pointer transition-colors ${
              tab === t.id
                ? 'bg-[#10B981]/10 border-[#10B981]/40 text-[#10B981]'
                : 'border-[#242424] text-[#8E8E93] hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`px-2.5 py-1 rounded-md text-[11px] border cursor-pointer ${
                category === c ? 'border-white/40 text-white' : 'border-[#242424] text-[#8E8E93] hover:text-white'
              }`}
            >
              {c === 'TODOS' ? 'Todos os tipos' : c}
            </button>
          ))}
        </div>
        <select
          aria-label="Formato"
          value={media}
          onChange={(e) => setMedia(e.target.value as MediaFilter)}
          className="bg-[#0A0A0A] border border-[#242424] rounded-md px-2 py-1 text-[11px] text-white outline-none"
        >
          {MEDIA.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="p-3 bg-red-950/30 border border-[#EF4444]/40 rounded-lg text-[#EF4444] text-xs">
          {error}
        </div>
      )}

      {list.length === 0 ? (
        <p className="text-sm text-[#8E8E93] py-12 text-center bg-[#121212] border border-[#242424] rounded-2xl">
          Nenhum post nesta lista.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
          {list.map((p) => (
            <PostCard
              key={p.id}
              post={p}
              variant="clean"
              onApprove={(post) => setApproving(post)}
              onReject={(post) => setRejecting(post)}
              onHide={tab === 'NAO_VOU_POSTAR' ? handleHide : undefined}
              onUnhide={onUnhide}
              extraMenuActions={extraActionsFor(p)}
            />
          ))}
        </div>
      )}

      {approving && (
        <ApprovalModal
          post={approving}
          isOpen={!!approving}
          onClose={() => setApproving(null)}
          onConfirmPublish={onConfirmPublish}
          onPublishInstagramNow={onPublishInstagramNow}
          allowAiCaption={false}
        />
      )}

      {rejecting && (
        <RejectionModal
          post={rejecting}
          isOpen={!!rejecting}
          onClose={() => setRejecting(null)}
          onConfirmReject={onConfirmReject}
        />
      )}

      {markingPublished && (
        <MarkPublishedModal
          post={markingPublished}
          onClose={() => setMarkingPublished(null)}
          onConfirm={async (details) => {
            const res = await api.organizePost(markingPublished.id, 'PUBLICADO', details);
            if (!res.success) throw new Error(res.error || 'Não foi possível marcar como publicado.');
            onChanged();
          }}
        />
      )}

      <UploadMediaModal
        isOpen={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploadSuccess={() => {
          setUploadOpen(false);
          onChanged();
        }}
        folderName={folderName}
      />
    </div>
  );
};
