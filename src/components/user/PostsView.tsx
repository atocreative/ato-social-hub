import React, { useMemo, useState } from 'react';
import type { PostGroup } from '../../types/index.ts';
import { filterPosts } from '../../utils/postHelpers.ts';
import { formatDateTime, statusLabel, thumbnailOf } from './format.ts';

type Tab = 'TODOS' | 'PENDENTES' | 'AGENDADOS' | 'PUBLICADOS' | 'REPROVADOS';

const TABS: { id: Tab; label: string }[] = [
  { id: 'TODOS', label: 'Todos' },
  { id: 'PENDENTES', label: 'Pendentes' },
  { id: 'AGENDADOS', label: 'Agendados' },
  { id: 'PUBLICADOS', label: 'Publicados' },
  { id: 'REPROVADOS', label: 'Reprovados' },
];

interface PostsViewProps {
  posts: PostGroup[];
}

export const PostsView: React.FC<PostsViewProps> = ({ posts }) => {
  const [tab, setTab] = useState<Tab>('TODOS');
  const list = useMemo(() => filterPosts(posts, tab), [posts, tab]);

  return (
    <div className="space-y-6 max-w-5xl">
      <header>
        <h1 className="text-2xl font-bold">Posts</h1>
        <p className="text-sm text-[#8E8E93] mt-1">Todas as suas publicações, por status.</p>
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

      {list.length === 0 ? (
        <p className="text-sm text-[#8E8E93] py-12 text-center bg-[#121212] border border-[#242424] rounded-2xl">
          Nenhum post nesta lista.
        </p>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {list.map((p) => {
            const thumb = thumbnailOf(p);
            return (
              <li key={p.id} className="flex gap-4 bg-[#121212] border border-[#242424] rounded-2xl p-4">
                {thumb ? (
                  <img src={thumb} alt="" className="w-16 h-16 rounded-lg object-cover bg-[#1A1A1A] shrink-0" />
                ) : (
                  <div className="w-16 h-16 rounded-lg bg-[#1A1A1A] shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{p.nome}</p>
                  <p className="text-xs text-[#8E8E93] mt-1">
                    {formatDateTime(p.scheduledAt || p.publishedAt || p.dataCriacao)}
                  </p>
                  <p className="text-[11px] text-[#10B981] mt-2">{statusLabel(p.status)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
