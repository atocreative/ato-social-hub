import React, { useState, useMemo } from 'react';
import { PostGroup, RejectionDetails } from '../types/index.ts';
import { generateRejectedFilename } from '../utils/postHelpers.ts';
import { X } from 'lucide-react';

interface RejectionModalProps {
  post: PostGroup;
  isOpen: boolean;
  onClose: () => void;
  onConfirmReject: (
    post: PostGroup,
    feedback: {
      tags: string[];
      motivo: string;
      pastaClienteId?: string;
      detalhes: RejectionDetails;
    }
  ) => Promise<void>;
  pastaClienteId?: string;
}

const LOCAL_OPTIONS = [
  'Conteúdo inteiro',
  'Somente capa ou slide específico',
  'Copy, legenda ou CTA',
  'Arquivo ou falha técnica',
];

const ERRO_OPTIONS = [
  'Fugiu do padrão visual',
  'Copy ou CTA desconectado',
  'Repetiu uma arte ou assunto',
  'Pauta fora do posicionamento',
  'Erro técnico ou de geração',
];

const SECONDARY_TAGS = [
  'CTA desalinhado',
  'Imagem repetida',
  'Papel rasgado excessivo',
  'Borda lateral indevida',
  'Hierarquia tipográfica',
  'Erro em slide',
];

const TEXTAREA_CLASS =
  'w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#EF4444] rounded-lg p-3 text-xs text-white placeholder-[#555555] outline-none resize-none leading-relaxed';

const chipClass = (selected: boolean) =>
  `px-2.5 py-1 text-xs rounded border transition-colors cursor-pointer text-left ${
    selected
      ? 'bg-[#1A1A1A] border-[#EF4444] text-[#EF4444]'
      : 'bg-[#0A0A0A] border-[#242424] text-[#8E8E93] hover:text-white'
  }`;

export const RejectionModal: React.FC<RejectionModalProps> = ({
  post,
  isOpen,
  onClose,
  onConfirmReject,
  pastaClienteId,
}) => {
  const [localProblema, setLocalProblema] = useState<string>('');
  const [erroPrincipal, setErroPrincipal] = useState<string>('');
  const [secondaryTags, setSecondaryTags] = useState<string[]>([]);
  const [preservar, setPreservar] = useState('');
  const [mudar, setMudar] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const originalFileName = useMemo(() => {
    return post.items[0]?.nome || `${post.nome}.png`;
  }, [post]);

  // Tags persistidas: problema principal + erro principal + tags secundárias
  const combinedTags = useMemo(
    () => [localProblema, erroPrincipal, ...secondaryTags].filter(Boolean),
    [localProblema, erroPrincipal, secondaryTags]
  );

  const previewFilename = useMemo(() => {
    return generateRejectedFilename(combinedTags, mudar, originalFileName);
  }, [combinedTags, mudar, originalFileName]);

  if (!isOpen) return null;

  const toggleSecondary = (tag: string) => {
    setSecondaryTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const isFormValid =
    Boolean(localProblema) && Boolean(erroPrincipal) && mudar.trim().length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) {
      setError('Preencha onde está o problema, o principal erro e o que deve mudar.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await onConfirmReject(post, {
        tags: combinedTags,
        motivo: mudar.trim(),
        pastaClienteId: pastaClienteId || post.items[0]?.tenantId || undefined,
        detalhes: {
          localProblema,
          erroPrincipal,
          preservar: preservar.trim(),
          mudar: mudar.trim(),
        },
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
      <div className="bg-[#121212] border border-[#242424] rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl p-6 relative">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#242424]">
          <div>
            <h2 className="text-sm font-semibold text-white">Novo formulário de feedback</h2>
            <p className="text-xs text-[#8E8E93]">
              Registre uma orientação de correção. O arquivo será renomeado no Drive.
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

        <form onSubmit={handleSubmit} className="pt-4 space-y-5">
          {error && (
            <div className="p-2.5 bg-red-950/30 border border-[#EF4444]/40 rounded-lg text-[#EF4444] text-xs">
              {error}
            </div>
          )}

          {/* 1. Onde está o problema? */}
          <fieldset>
            <legend className="block text-xs text-white mb-2">
              1. Onde está o problema? <span className="text-[#EF4444]">*</span>
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {LOCAL_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  aria-pressed={localProblema === opt}
                  onClick={() => setLocalProblema(opt)}
                  className={chipClass(localProblema === opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          </fieldset>

          {/* 2. Qual é o principal erro? */}
          <fieldset>
            <legend className="block text-xs text-white mb-2">
              2. Qual é o principal erro? <span className="text-[#EF4444]">*</span>
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {ERRO_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  aria-pressed={erroPrincipal === opt}
                  onClick={() => setErroPrincipal(opt)}
                  className={chipClass(erroPrincipal === opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          </fieldset>

          {/* Tags secundárias (opcionais) */}
          <fieldset>
            <legend className="block text-xs text-[#8E8E93] mb-2">
              Tags secundárias <span>(opcional)</span>
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {SECONDARY_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={secondaryTags.includes(tag)}
                  onClick={() => toggleSecondary(tag)}
                  className={chipClass(secondaryTags.includes(tag))}
                >
                  {tag}
                </button>
              ))}
            </div>
          </fieldset>

          {/* 3. O que deve ser preservado? */}
          <div>
            <label htmlFor="rejection-preservar" className="block text-xs text-white mb-1.5">
              3. O que deve ser preservado? <span className="text-[#8E8E93]">(opcional)</span>
            </label>
            <textarea
              id="rejection-preservar"
              rows={2}
              value={preservar}
              onChange={(e) => setPreservar(e.target.value)}
              placeholder="Ex: Manter a paleta, a tipografia e a estrutura de leitura da capa"
              className={TEXTAREA_CLASS}
            />
          </div>

          {/* 4. O que deve mudar? */}
          <div>
            <label htmlFor="rejection-mudar" className="block text-xs text-white mb-1.5">
              4. O que deve mudar? <span className="text-[#EF4444]">*</span>
            </label>
            <textarea
              id="rejection-mudar"
              rows={3}
              value={mudar}
              onChange={(e) => {
                setMudar(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Ex: Refazer a capa destacando somente as palavras principais com papel rasgado; demais linhas limpas"
              className={TEXTAREA_CLASS}
            />
          </div>

          {/* Preview do Nome do Arquivo no Drive */}
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
              className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors ${
                isFormValid && !isSubmitting
                  ? 'bg-[#EF4444] hover:bg-[#DC2626] text-white cursor-pointer'
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
