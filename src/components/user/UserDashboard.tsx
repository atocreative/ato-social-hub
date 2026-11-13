import React, { useMemo } from 'react';
import type { PostGroup } from '../../types/index.ts';
import { summarizePosts, upcomingPosts } from '../../utils/userDashboard.ts';
import { formatDateTime, statusLabel, thumbnailOf } from './format.ts';

interface UserDashboardProps {
  posts: PostGroup[];
  now?: Date;
}

export const UserDashboard: React.FC<UserDashboardProps> = ({ posts, now }) => {
  const today = useMemo(() => now ?? new Date(), [now]);
  const summary = useMemo(() => summarizePosts(posts, today), [posts, today]);
  const next = useMemo(() => upcomingPosts(posts, today, 6), [posts, today]);

  const cards = [
    { label: 'Agendados', value: summary.scheduled, tone: 'text-[#10B981]' },
    { label: 'Publicados na semana', value: summary.publishedThisWeek, tone: 'text-white' },
    { label: 'Com falha', value: summary.failed, tone: 'text-[#EF4444]' },
  ];

  return (
    <div className="space-y-8 max-w-5xl">
      <header>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm text-[#8E8E93] mt-1">Visão geral das suas publicações.</p>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {cards.map((c) => (
          <div key={c.label} className="bg-[#121212] border border-[#242424] rounded-2xl p-5">
            <p className="text-xs text-[#8E8E93]">{c.label}</p>
            <p className={`text-3xl font-bold mt-2 ${c.tone}`}>{c.value}</p>
          </div>
        ))}
      </section>

      <section className="bg-[#121212] border border-[#242424] rounded-2xl p-5">
        <h2 className="text-base font-semibold mb-4">Próximas publicações</h2>
        {next.length === 0 ? (
          <p className="text-sm text-[#8E8E93] py-8 text-center">Nenhum post programado.</p>
        ) : (
          <ul className="divide-y divide-[#1C1C1C]">
            {next.map((p) => {
              const thumb = thumbnailOf(p);
              return (
                <li key={p.id} className="flex items-center gap-4 py-3">
                  {thumb ? (
                    <img src={thumb} alt="" className="w-12 h-12 rounded-lg object-cover bg-[#1A1A1A]" />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-[#1A1A1A]" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{p.nome}</p>
                    <p className="text-xs text-[#8E8E93]">{formatDateTime(p.scheduledAt)}</p>
                  </div>
                  <span className="text-[11px] px-2 py-1 rounded-md border border-[#10B981]/30 text-[#10B981] whitespace-nowrap">
                    {statusLabel(p.status)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};
