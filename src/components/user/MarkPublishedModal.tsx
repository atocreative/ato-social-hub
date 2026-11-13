import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { PostGroup } from '../../types/index.ts';
import { nowSaoPauloLocal, saoPauloLocalToIso } from './format.ts';

const CONTENT_OPTIONS: { value: 'NOTICIA' | 'EMPRESA' | 'CURIOSIDADE' | 'OUTRO'; label: string; hint: string }[] = [
  { value: 'NOTICIA', label: 'Notícia', hint: 'Fato do setor ou da atualidade' },
  { value: 'EMPRESA', label: 'Empresa', hint: 'Sobre a marca, equipe ou entregas' },
  { value: 'CURIOSIDADE', label: 'Curiosidade', hint: 'Conteúdo leve ou educativo' },
  { value: 'OUTRO', label: 'Outro', hint: 'Qualquer outro tipo' },
];

interface MarkPublishedModalProps {
  post: PostGroup;
  onClose: () => void;
  onConfirm: (details: {
    publishedAt: string;
    tipoConteudo: 'NOTICIA' | 'EMPRESA' | 'CURIOSIDADE' | 'OUTRO';
    descricaoConteudo?: string;
  }) => Promise<void>;
}

export const MarkPublishedModal: React.FC<MarkPublishedModalProps> = ({ post, onClose, onConfirm }) => {
  const [when, setWhen] = useState(nowSaoPauloLocal());
  const [tipo, setTipo] = useState<'NOTICIA' | 'EMPRESA' | 'CURIOSIDADE' | 'OUTRO' | ''>(post.tipoConteudo || '');
  const [descricao, setDescricao] = useState(post.descricaoConteudo || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = Boolean(when && tipo);

  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm({
        publishedAt: saoPauloLocalToIso(when),
        tipoConteudo: tipo as 'NOTICIA' | 'EMPRESA' | 'CURIOSIDADE' | 'OUTRO',
        descricaoConteudo: descricao.trim() || undefined,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Marcar como publicado"
        className="w-full max-w-md bg-[#121212] border border-[#242424] rounded-2xl p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Marcar como publicado</h2>
            <p className="text-xs text-[#8E8E93] mt-1 truncate max-w-[300px]">{post.nome}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar" className="text-[#8E8E93] hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </header>

        <div>
          <label htmlFor="published-when" className="block text-xs text-[#8E8E93] mb-1.5">
            Data e hora em que foi publicado (horário de Brasília)
          </label>
          <input
            id="published-when"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-sm text-white outline-none"
          />
        </div>

        <fieldset>
          <legend className="block text-xs text-[#8E8E93] mb-2">Tipo do conteúdo</legend>
          <div className="grid grid-cols-2 gap-2">
            {CONTENT_OPTIONS.map((o) => (
              <label
                key={o.value}
                className={`cursor-pointer rounded-lg border px-3 py-2 text-xs ${
                  tipo === o.value
                    ? 'border-[#10B981] bg-[#10B981]/10 text-white'
                    : 'border-[#242424] text-[#8E8E93] hover:text-white'
                }`}
              >
                <input
                  type="radio"
                  name="tipo-conteudo"
                  value={o.value}
                  checked={tipo === o.value}
                  onChange={() => setTipo(o.value)}
                  className="sr-only"
                />
                <span className="block font-medium">{o.label}</span>
                <span className="block text-[10px] text-[#8E8E93] mt-0.5">{o.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="published-desc" className="block text-xs text-[#8E8E93] mb-1.5">
            Sobre o que é? (opcional)
          </label>
          <input
            id="published-desc"
            type="text"
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            placeholder="Ex: Lançamento do novo serviço"
            className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-sm text-white placeholder-[#4E4E52] outline-none"
          />
        </div>

        {error && <p className="text-xs text-[#EF4444]">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-[#2E2E32] text-sm hover:bg-[#161616] cursor-pointer">
            Cancelar
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSave || saving}
            className="px-4 py-2 rounded-lg bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
};
