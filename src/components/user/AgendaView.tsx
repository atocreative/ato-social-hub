import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PostGroup } from '../../types/index.ts';
import { buildMonthGrid } from '../../utils/agendaGrid.ts';
import { formatDateTime, statusLabel, thumbnailOf } from './format.ts';

interface AgendaViewProps {
  posts: PostGroup[];
  now?: Date;
}

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTHS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

export const AgendaView: React.FC<AgendaViewProps> = ({ posts, now }) => {
  const initial = now ?? new Date();
  const [year, setYear] = useState(initial.getFullYear());
  const [month, setMonth] = useState(initial.getMonth());
  const [selected, setSelected] = useState<PostGroup | null>(null);

  const grid = useMemo(() => buildMonthGrid(year, month, posts), [year, month, posts]);

  const shift = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Agenda</h1>
          <p className="text-sm text-[#8E8E93] mt-1">Posts programados por dia.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => shift(-1)} aria-label="Mês anterior" className="p-2 rounded-lg border border-[#242424] hover:bg-[#161616] cursor-pointer">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-semibold min-w-[160px] text-center">
            {MONTHS[month]} {year}
          </span>
          <button type="button" onClick={() => shift(1)} aria-label="Próximo mês" className="p-2 rounded-lg border border-[#242424] hover:bg-[#161616] cursor-pointer">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div className="grid grid-cols-7 gap-px bg-[#1C1C1C] rounded-2xl overflow-hidden border border-[#242424]">
        {WEEKDAYS.map((w) => (
          <div key={w} className="bg-[#0D0D0D] text-[11px] text-[#8E8E93] text-center py-2 uppercase tracking-wide">
            {w}
          </div>
        ))}
        {grid.map((cell) => {
          const day = Number(cell.date.slice(8, 10));
          return (
            <div
              key={cell.date}
              className={`min-h-[84px] md:min-h-[110px] bg-[#121212] p-1.5 md:p-2 ${cell.inMonth ? '' : 'opacity-40'}`}
            >
              <span className="text-xs font-semibold">{day}</span>
              <div className="mt-1 space-y-1">
                {cell.posts.slice(0, 3).map((p) => {
                  const thumb = thumbnailOf(p);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelected(p)}
                      className="w-full flex items-center gap-1.5 text-left rounded-md bg-[#10B981]/10 hover:bg-[#10B981]/20 px-1 py-0.5 cursor-pointer"
                    >
                      {thumb ? (
                        <img src={thumb} alt="" className="w-5 h-5 rounded object-cover shrink-0" />
                      ) : (
                        <span className="w-5 h-5 rounded bg-[#1A1A1A] shrink-0" />
                      )}
                      <span className="text-[10px] truncate">{p.nome}</span>
                    </button>
                  );
                })}
                {cell.posts.length > 3 && (
                  <span className="text-[10px] text-[#8E8E93]">+{cell.posts.length - 3}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <aside className="bg-[#121212] border border-[#242424] rounded-2xl p-5 max-w-md">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold">{selected.nome}</p>
              <p className="text-xs text-[#8E8E93] mt-1">{formatDateTime(selected.scheduledAt)}</p>
            </div>
            <button type="button" onClick={() => setSelected(null)} className="text-xs text-[#8E8E93] hover:text-white cursor-pointer">
              Fechar
            </button>
          </div>
          <p className="text-xs mt-3">
            Status: <span className="text-[#10B981]">{statusLabel(selected.status)}</span>
          </p>
          {selected.caption && (
            <p className="text-xs text-[#8E8E93] mt-3 line-clamp-4 whitespace-pre-line">{selected.caption}</p>
          )}
        </aside>
      )}
    </div>
  );
};
