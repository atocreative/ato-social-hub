import React, { useMemo, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import type { PostGroup } from '../../types/index.ts';
import { filterPosts } from '../../utils/postHelpers.ts';
import { api } from '../../services/api.ts';
import type { OrganizeTarget } from '../../services/postOrganize.ts';
import { formatDateTime, statusLabel, thumbnailOf } from './format.ts';

type Tab = 'TODOS' | 'PENDENTES' | 'AGENDADOS' | 'PUBLICADOS' | 'NAO_VOU_POSTAR' | 'REPROVADOS';

const TABS: { id: Tab; label: string }[] = [
  { id: 'TODOS', label: 'Todos' },
  { id: 'PENDENTES', label: 'Pendentes' },
  { id: 'AGENDADOS', label: 'Agendados' },
  { id: 'PUBLICADOS', label: 'Publicados' },
  { id: 'NAO_VOU_POSTAR', label: 'Não vou postar' },
  { id: 'REPROVADOS', label: 'Reprovados' },
];

interface PostsViewProps {
  posts: PostGroup[];
  /** Chamado após organizar um post, para recarregar a lista. */
  onOrganized: () => void;
}

export const PostsView: React.FC<PostsViewProps> = ({ posts, onOrganized }) => {
  const [tab, setTab] = useState<Tab>('TODOS');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useMemo(() => {
    if (tab === 'NAO_VOU_POSTAR') return posts.filter((p) => p.status === 'NAO_VOU_POSTAR');
    return filterPosts(posts, tab);
  }, [posts, tab]);

  const organize = async (post: PostGroup, target: OrganizeTarget) => {
    setOpenMenuId(null);
    setBusyId(post.id);
    setError(null);
    try {
      const res = await api.organizePost(post.id, target);
      if (!res.success) throw new Error(res.error || 'Não foi possível alterar o post.');
      onOrganized();
    } catch (err: any) {
      setError(err.message || 'Não foi possível alterar o post.');
    } finally {
      setBusyId(null);
    }
  };

  const menuActions = (post: PostGroup): { target: OrganizeTarget; label: string }[] => {
    const actions: { target: OrganizeTarget; label: string }[] = [];
    if (post.status !== 'PUBLICADO') actions.push({ target: 'PUBLICADO', label: 'Marcar como publicado' });
    if (post.status !== 'NAO_VOU_POSTAR') actions.push({ target: 'NAO_VOU_POSTAR', label: 'Não vou postar' });
    if (post.status === 'PUBLICADO' || post.status === 'NAO_VOU_POSTAR') {
      actions.push({ target: 'PENDENTE', label: 'Voltar para pendentes' });
    }
    return actions;
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <header>
        <h1 className="text-2xl font-bold">Posts</h1>
        <p className="text-sm text-[#8E8E93] mt-1">Organize suas publicações por etapa.</p>
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
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {list.map((p) => {
            const thumb = thumbnailOf(p);
            const actions = menuActions(p);
            const open = openMenuId === p.id;
            return (
              <li key={p.id} className="relative flex gap-4 bg-[#121212] border border-[#242424] rounded-2xl p-4">
                {thumb ? (
                  <img src={thumb} alt="" className="w-16 h-16 rounded-lg object-cover bg-[#1A1A1A] shrink-0" />
                ) : (
                  <div className="w-16 h-16 rounded-lg bg-[#1A1A1A] shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate pr-8">{p.nome}</p>
                  <p className="text-xs text-[#8E8E93] mt-1">
                    {formatDateTime(p.scheduledAt || p.publishedAt || p.dataCriacao)}
                  </p>
                  <p className="text-[11px] text-[#10B981] mt-2">{statusLabel(p.status)}</p>
                </div>

                <button
                  type="button"
                  aria-label="Opções do post"
                  disabled={busyId === p.id}
                  onClick={() => setOpenMenuId(open ? null : p.id)}
                  className="absolute top-3 right-3 p-1.5 rounded-lg bg-[#1A1A1A] hover:bg-[#242424] border border-[#2A2A2A] text-[#8E8E93] hover:text-white cursor-pointer disabled:opacity-50"
                >
                  <MoreVertical className="w-4 h-4" />
                </button>

                {open && (
                  <div className="absolute right-3 top-12 w-52 bg-[#181818] border border-[#2A2A2A] rounded-lg shadow-2xl py-1 z-30">
                    {actions.map((a) => (
                      <button
                        key={a.target}
                        type="button"
                        onClick={() => organize(p, a.target)}
                        className="w-full px-3 py-2 text-left text-xs text-white hover:bg-[#242424] cursor-pointer"
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
