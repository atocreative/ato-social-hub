import React from 'react';
import { CategoryFilter, MediaFilter } from '../utils/postHelpers.ts';

export type FilterTab = 'PENDENTES' | 'AGENDADOS' | 'PUBLICADOS' | 'REPROVADOS' | 'TODOS';

interface FilterBarProps {
  activeTab: FilterTab;
  onTabChange: (tab: FilterTab) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectedCategory: CategoryFilter;
  onCategoryChange: (category: CategoryFilter) => void;
  selectedMedia: MediaFilter;
  onMediaChange: (media: MediaFilter) => void;
  stats: {
    total: number;
    pendentes: number;
    agendados: number;
    publicados: number;
    reprovados?: number;
  };
}

export const FilterBar: React.FC<FilterBarProps> = ({
  activeTab,
  onTabChange,
  searchQuery,
  onSearchChange,
  selectedCategory,
  onCategoryChange,
  selectedMedia,
  onMediaChange,
  stats,
}) => {
  const mediaOptions: { key: MediaFilter; label: string }[] = [
    { key: 'TODOS', label: 'Todos' },
    { key: 'IMAGENS', label: 'Imagens' },
    { key: 'VIDEOS', label: 'Vídeos' },
  ];
  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: 'PENDENTES', label: 'Pendentes', count: stats.pendentes },
    { key: 'AGENDADOS', label: 'Agendados', count: stats.agendados },
    { key: 'PUBLICADOS', label: 'Publicados', count: stats.publicados },
    { key: 'REPROVADOS', label: 'Reprovados', count: stats.reprovados || 0 },
    { key: 'TODOS', label: 'Todos', count: stats.total },
  ];

  const categories: { key: CategoryFilter; label: string }[] = [
    { key: 'TODOS', label: 'Todos' },
    { key: 'Post Único', label: 'Post Único' },
    { key: 'Carrossel', label: 'Carrossel' },
    { key: 'Story', label: 'Story' },
    { key: 'Vídeos', label: 'Vídeos' },
  ];

  return (
    <div className="flex flex-col gap-3 py-3">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        {/* Segmented Status Filter Control */}
        <div className="flex items-center gap-1 bg-[#121212] p-1 rounded-lg border border-[#242424] overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => onTabChange(tab.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  isActive
                    ? 'bg-[#1A1A1A] text-white shadow-sm'
                    : 'text-[#8E8E93] hover:text-white'
                }`}
              >
                <span>{tab.label}</span>
                <span className={`text-[11px] font-mono tabular-nums ${isActive ? 'text-[#10B981]' : 'text-[#666666]'}`}>
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Direct Search Input */}
        <div className="w-full sm:w-64">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Buscar criativo..."
            className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-1.5 text-xs text-white placeholder-[#555555] outline-none transition-colors"
          />
        </div>
      </div>

      {/* Tipo de mídia ([Todos] [Imagens] [Vídeos]) */}
      <div className="flex items-center flex-wrap gap-1.5">
        <span className="text-[11px] text-[#8E8E93] mr-1 font-medium">Tipo:</span>
        {mediaOptions.map((opt) => {
          const isSelected = selectedMedia === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onMediaChange(opt.key)}
              aria-pressed={isSelected}
              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-[#10B981]/15 border-[#10B981] text-[#10B981]'
                  : 'bg-[#121212] border-[#242424] text-[#8E8E93] hover:text-white hover:border-[#333333]'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* Category Sub-Filters ([Todos] [Post Único] [Carrossel] [Story]) */}
      <div className="flex items-center flex-wrap gap-1.5">
        <span className="text-[11px] text-[#8E8E93] mr-1 font-medium">Formato:</span>
        {categories.map((cat) => {
          const isSelected = selectedCategory === cat.key;
          return (
            <button
              key={cat.key}
              type="button"
              onClick={() => onCategoryChange(cat.key)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-[#10B981]/15 border-[#10B981] text-[#10B981]'
                  : 'bg-[#121212] border-[#242424] text-[#8E8E93] hover:text-white hover:border-[#333333]'
              }`}
            >
              {cat.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};
