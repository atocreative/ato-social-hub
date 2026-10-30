import React, { useState, useMemo } from 'react';
import { PostGroup } from '../types/index.ts';
import { generateRejectedFilename } from '../utils/postHelpers.ts';
import { X } from 'lucide-react';

interface RejectionModalProps {
  post: PostGroup;
  isOpen: boolean;
  onClose: () => void;
  onConfirmReject: (
    post: PostGroup,
    feedback: { tags: string[]; motivo: string; pastaClienteId?: string }
  ) => Promise<void>;
  pastaClienteId?: string;
}

const AVAILABLE_TAGS = [
  'Posição da Logo',
  'Cores Fortes/Erradas',
  'Tipografia/Fonte',
  'Copy Genérica/Ruim',
  'Imagem de Fundo',
  'Erro de Ortografia',
  'Fuga do Padrão Visual',
];

export const RejectionModal: React.FC<RejectionModalProps> = ({
  post,
  isOpen,
  onClose,
  onConfirmReject,
  pastaClienteId,
}) => {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [motivo, setMotivo] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const originalFileName = useMemo(() => {
    return post.items[0]?.nome || `${post.nome}.png`;
  }, [post]);

  const previewFilename = useMemo(() => {
    return generateRejectedFilename(selectedTags, motivo, originalFileName);
  }, [selectedTags, motivo, originalFileName]);

  if (!isOpen) return null;

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const isFormValid = motivo.trim().length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) {
      setError('Por favor, descreva o motivo da reprovação.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await onConfirmReject(post, {
        tags: selectedTags,
        motivo: motivo.trim(),
        pastaClienteId: pastaClienteId || post.items[0]?.tenantId || undefined,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Erro ao processar reprovação.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 font-sans">
      <div className="bg-[#121212] border border-[#242424] rounded-xl w-full max-w-lg shadow-2xl p-6 relative">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#242424]">
          <div>
            <h2 className="text-sm font-semibold text-white">
              Por que você está reprovando esta arte?
            </h2>
            <p className="text-xs text-[#8E8E93]">
              O feedback será registrado e o arquivo será renomeado no Drive
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[#8E8E93] hover:text-white p-1 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="pt-4 space-y-4">
          {error && (
            <div className="p-2.5 bg-red-950/30 border border-[#EF4444]/40 rounded-lg text-[#EF4444] text-xs">
              {error}
            </div>
          )}

          {/* 1. Chips de Diagnóstico Rápido */}
          <div>
            <label className="block text-xs text-[#8E8E93] mb-2">
              Selecione as tags de diagnóstico (opcional):
            </label>
            <div className="flex flex-wrap gap-1.5">
              {AVAILABLE_TAGS.map((tag) => {
                const isSelected = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    className={`px-2.5 py-1 text-xs rounded border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[#1A1A1A] border-[#EF4444] text-[#EF4444]'
                        : 'bg-[#0A0A0A] border-[#242424] text-[#8E8E93] hover:text-white'
                    }`}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Campo de Texto Obrigatório (motivo) */}
          <div>
            <label htmlFor="rejection-motivo" className="block text-xs text-[#8E8E93] mb-1.5">
              Motivo da reprovação <span className="text-[#EF4444]">*</span>
            </label>
            <textarea
              id="rejection-motivo"
              rows={3}
              value={motivo}
              onChange={(e) => {
                setMotivo(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Descreva rapidamente o que não ficou bom (Ex: Não gostei da posição da logo e as cores estão muito fortes)..."
              required
              className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#EF4444] rounded-lg p-3 text-xs text-white placeholder-[#555555] outline-none resize-none leading-relaxed"
            />
          </div>

          {/* 3. Preview do Nome do Arquivo no Drive */}
          <div className="p-3 bg-[#0A0A0A] border border-[#242424] rounded-lg space-y-1">
            <span className="text-[11px] text-[#8E8E93] block">
              Nome do arquivo no Google Drive (snake_case):
            </span>
            <div className="font-mono text-xs text-white break-all select-all">
              {previewFilename}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-[#242424]">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-3.5 py-2 text-xs text-[#8E8E93] hover:text-white cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !isFormValid}
              className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                isFormValid && !isSubmitting
                  ? 'bg-[#EF4444] hover:bg-[#DC2626] text-white'
                  : 'bg-[#1A1A1A] text-[#555555] cursor-not-allowed border border-[#242424]'
              }`}
            >
              {isSubmitting ? 'Reprovando...' : 'Confirmar Reprovação'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
