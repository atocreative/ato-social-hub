import React, { useState, useEffect } from 'react';
import { PostGroup, InstagramPublishPayload, TenantAccount } from '../types/index.ts';
import { api } from '../services/api.ts';
import { formatUtcToSaoPauloParts } from '../utils/postHelpers.ts';
import { CarouselViewer } from './CarouselViewer.tsx';
import { MediaImage } from './MediaImage.tsx';
import { X, Sparkles, Send, Calendar, AlertCircle, RefreshCw, CheckCircle2, SlidersHorizontal } from 'lucide-react';

interface ApprovalModalProps {
  post: PostGroup;
  isOpen: boolean;
  onClose: () => void;
  onConfirmPublish: (post: PostGroup, payload: InstagramPublishPayload) => Promise<void>;
  onPublishInstagramNow?: (post: PostGroup, caption: string, accountId?: string) => Promise<void>;
  /** Mantido por compatibilidade. A legenda com IA fica sempre disponível. */
  allowAiCaption?: boolean;
}

type WhenMode = 'NOW' | 'SCHEDULE';

function formatDateBr(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return y && m && d ? `${d}/${m}/${y}` : isoDate;
}

export const ApprovalModal: React.FC<ApprovalModalProps> = ({
  post,
  isOpen,
  onClose,
  onConfirmPublish,
  onPublishInstagramNow,
}) => {
  const clientName =
    post.pastaClienteNome ||
    (post.driveFolderName && post.driveFolderName.toLowerCase() !== 'ato social midia'
      ? post.driveFolderName
      : 'Ato');

  const cleanBatchTitle = (post.loteNome || post.nome || '')
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();

  const defaultCaption =
    post.caption ||
    `${cleanBatchTitle}\n\nCada detalhe importa quando construímos presença digital com propósito e consistência para ${clientName}.\n\nDeixe seu comentário abaixo e compartilhe este conteúdo!\n\n#${clientName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')} #socialmedia #estrategiadigital #branding`;

  const [caption, setCaption] = useState(defaultCaption);
  const [hasGeneratedCaption, setHasGeneratedCaption] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ajustes da IA: escondidos por padrão para não poluir a tela
  const [showAdjustments, setShowAdjustments] = useState(false);
  const [objective, setObjective] = useState('Engajamento, autoridade de marca e conversão');
  const [theme, setTheme] = useState(cleanBatchTitle);
  const [tone, setTone] = useState('Estratégico, direto e contemporâneo');
  const [cta, setCta] = useState('Salve este post, comente abaixo e envie para quem precisa ver');
  const [includeHashtags, setIncludeHashtags] = useState(true);

  const [isGeneratingCaption, setIsGeneratingCaption] = useState(false);

  const [accounts, setAccounts] = useState<TenantAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(
    post.scheduledAccountId || post.tenantId || ''
  );

  const [whenMode, setWhenMode] = useState<WhenMode>('SCHEDULE');
  const initialSpParts = formatUtcToSaoPauloParts(post.scheduledAt);
  const [scheduledDate, setScheduledDate] = useState(initialSpParts.date);
  const [scheduledTime, setScheduledTime] = useState(initialSpParts.time);

  const [submittingMode, setSubmittingMode] = useState<WhenMode | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setStatusNotice(null);
    setTheme(cleanBatchTitle);

    const sp = formatUtcToSaoPauloParts(post.scheduledAt);
    setScheduledDate(sp.date);
    setScheduledTime(sp.time);

    const loadCompanyAccounts = () => {
      api
        .getTenants()
        .then((res) => {
          const allList: TenantAccount[] = Array.isArray(res.tenants) ? res.tenants : [];
          // Filtra contas compatíveis com a empresa do post (isolamento multiempresa)
          const companyScoped = allList.filter(
            (t) =>
              t.id === post.scheduledAccountId ||
              t.id === post.tenantId ||
              (t.driveFolderName &&
                clientName &&
                t.driveFolderName.toLowerCase() === clientName.toLowerCase())
          );
          const effectiveList = companyScoped.length > 0 ? companyScoped : allList;
          setAccounts(effectiveList);

          const matched =
            effectiveList.find((t) => t.id === post.scheduledAccountId || t.id === post.tenantId) ||
            effectiveList.find(
              (t) =>
                t.driveFolderName &&
                clientName &&
                t.driveFolderName.toLowerCase() === clientName.toLowerCase()
            ) ||
            effectiveList[0];
          setSelectedAccountId(matched ? matched.id : '');
        })
        .catch(() => {});
    };
    loadCompanyAccounts();

    api
      .getPostCaptionsHistory(post.id)
      .then((histRes) => {
        if (histRes.currentCaption) setCaption(histRes.currentCaption);
      })
      .catch(() => {});

    setCaption(post.caption || defaultCaption);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, post.id, post.caption, post.scheduledAt, post.scheduledAccountId, post.tenantId]);

  if (!isOpen) return null;

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const needsReconnection =
    selectedAccount?.connectionStatus === 'RECONEXAO_NECESSARIA' ||
    post.status === 'RECONEXAO_NECESSARIA' ||
    (!!error && (error.includes('RECONEXAO_NECESSARIA') || error.includes('Reconecte')));

  const handleReconnectInstagram = async () => {
    try {
      const authRes = await api.getInstagramAuthUrl(
        window.location.origin,
        selectedAccountId || undefined,
        clientName
      );
      if (authRes?.url) {
        const popup = window.open(authRes.url, 'InstagramModalReconnect', 'width=600,height=700,left=200,top=100');
        if (!popup) window.location.href = authRes.url;
      }
    } catch (err: any) {
      setError(err.message || 'Erro ao iniciar conexão com o Instagram.');
    }
  };

  const handleGenerateCaption = async () => {
    setIsGeneratingCaption(true);
    setError(null);
    setStatusNotice(null);
    try {
      const res = await api.generatePostCaptionWithGemini(post.id, {
        objective,
        theme,
        briefing: theme,
        tone,
        cta,
        includeHashtags,
        regenerate: hasGeneratedCaption,
      });
      if (res.caption) {
        setCaption(res.caption);
        setHasGeneratedCaption(true);
        setStatusNotice('Legenda criada. Revise antes de publicar.');
      }
    } catch (err: any) {
      setError(err.message || 'Não foi possível gerar a legenda agora. Tente de novo.');
    } finally {
      setIsGeneratingCaption(false);
    }
  };

  const handleSchedule = async () => {
    setError(null);
    if (!scheduledDate || !scheduledTime) {
      setError('Escolha a data e o horário da publicação.');
      return;
    }
    setSubmittingMode('SCHEDULE');
    try {
      await onConfirmPublish(post, {
        action: 'SCHEDULE',
        caption,
        scheduledDate,
        scheduledTime,
        accountId: selectedAccountId || undefined,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Não foi possível agendar. Tente de novo.');
    } finally {
      setSubmittingMode(null);
    }
  };

  const handlePublishNow = async () => {
    setError(null);
    setSubmittingMode('NOW');
    try {
      if (onPublishInstagramNow) {
        await onPublishInstagramNow(post, caption, selectedAccountId || undefined);
      } else {
        await onConfirmPublish(post, { action: 'NOW', caption, accountId: selectedAccountId || undefined });
      }
      onClose();
    } catch (err: any) {
      setError(err.message || 'Não foi possível publicar agora. Tente de novo.');
    } finally {
      setSubmittingMode(null);
    }
  };

  const isBusy = submittingMode !== null || isGeneratingCaption;
  const canSubmit = caption.trim().length > 0 && !isBusy;
  const accountLabel = selectedAccount?.username || post.scheduledAccountId || clientName.toLowerCase();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm font-sans"
      onClick={() => !isBusy && onClose()}
    >
      <div
        className="bg-[#121212] border border-[#242424] rounded-xl w-full max-w-lg max-h-[92vh] flex flex-col shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabeçalho */}
        <div className="px-5 py-4 border-b border-[#242424] flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">Publicar no Instagram</h2>
            <p className="text-xs text-[#8E8E93] mt-0.5">
              Conta: <span className="text-white font-medium">@{accountLabel}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            aria-label="Fechar"
            className="text-[#8E8E93] hover:text-white p-1.5 rounded-lg bg-[#1A1A1A] border border-[#2A2A2A] cursor-pointer disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {error && (
            <div className="p-3 bg-red-950/40 border border-[#EF4444]/50 rounded-lg text-[#F8B4B4] text-xs flex items-start justify-between gap-3">
              <div className="flex items-start gap-2 break-words">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#EF4444]" />
                <span>{error}</span>
              </div>
              {needsReconnection && (
                <button
                  type="button"
                  onClick={handleReconnectInstagram}
                  className="px-3 py-1.5 bg-[#F59E0B] hover:bg-[#D97706] text-[#0A0A0A] font-semibold text-xs rounded-lg shrink-0 cursor-pointer"
                >
                  Reconectar conta
                </button>
              )}
            </div>
          )}

          {statusNotice && !error && (
            <div className="p-2.5 bg-[#10B981]/10 border border-[#10B981]/30 rounded-lg text-[#10B981] text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{statusNotice}</span>
            </div>
          )}

          {/* Prévia */}
          <div className="bg-[#0A0A0A] border border-[#242424] rounded-lg p-3 flex items-center justify-center">
            {post.categoria === 'Carrossel' || post.items.length > 1 ? (
              <div className="w-full max-w-[220px]">
                <CarouselViewer items={post.items} categoria={post.categoria} loteNome={post.loteNome} />
              </div>
            ) : (
              <div
                className={`relative w-full max-w-[220px] ${
                  post.categoria.toLowerCase().includes('story') ? 'aspect-[9/16]' : 'aspect-square'
                } overflow-hidden rounded flex items-center justify-center`}
              >
                <MediaImage item={post.items[0]} width={800} alt={post.nome} className="w-full h-full object-contain" />
              </div>
            )}
          </div>

          {/* Passo 1: legenda */}
          <section className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-white">1. Legenda</h3>
              <button
                type="button"
                onClick={handleGenerateCaption}
                disabled={isBusy}
                className="px-3 py-1.5 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-xs rounded-lg flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {hasGeneratedCaption ? <RefreshCw className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
                <span>
                  {isGeneratingCaption
                    ? 'Criando legenda...'
                    : hasGeneratedCaption
                    ? 'Criar outra com IA'
                    : 'Criar legenda com IA'}
                </span>
              </button>
            </div>

            <textarea
              id="post-caption"
              aria-label="Legenda"
              rows={5}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Escreva a legenda ou crie uma com IA."
              className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg p-3 text-sm text-white placeholder-[#555555] outline-none resize-y leading-relaxed"
            />

            <button
              type="button"
              onClick={() => setShowAdjustments((v) => !v)}
              className="text-xs text-[#8E8E93] hover:text-white flex items-center gap-1.5 cursor-pointer"
            >
              <SlidersHorizontal className="w-3 h-3" />
              <span>{showAdjustments ? 'Esconder ajustes da IA' : 'Ajustar o texto da IA (opcional)'}</span>
            </button>

            {showAdjustments && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-[#0A0A0A] border border-[#242424] rounded-lg">
                <label className="text-[11px] text-[#8E8E93] space-y-1">
                  <span className="block">Assunto</span>
                  <input
                    type="text"
                    value={theme}
                    onChange={(e) => setTheme(e.target.value)}
                    className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                </label>
                <label className="text-[11px] text-[#8E8E93] space-y-1">
                  <span className="block">Objetivo</span>
                  <input
                    type="text"
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                </label>
                <label className="text-[11px] text-[#8E8E93] space-y-1">
                  <span className="block">Jeito de escrever</span>
                  <input
                    type="text"
                    value={tone}
                    onChange={(e) => setTone(e.target.value)}
                    className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                </label>
                <label className="text-[11px] text-[#8E8E93] space-y-1">
                  <span className="block">Pedido para quem lê</span>
                  <input
                    type="text"
                    value={cta}
                    onChange={(e) => setCta(e.target.value)}
                    className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                </label>
                <label className="sm:col-span-2 inline-flex items-center gap-2 text-xs text-[#A0A0A5] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeHashtags}
                    onChange={(e) => setIncludeHashtags(e.target.checked)}
                    className="accent-[#10B981] cursor-pointer"
                  />
                  <span>Incluir hashtags</span>
                </label>
              </div>
            )}
          </section>

          {/* Passo 2: quando publicar */}
          <section className="space-y-2.5">
            <h3 className="text-sm font-semibold text-white">2. Quando publicar</h3>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { value: 'NOW', label: 'Agora', icon: Send },
                  { value: 'SCHEDULE', label: 'Em outro dia e horário', icon: Calendar },
                ] as const
              ).map((opt) => {
                const active = whenMode === opt.value;
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setWhenMode(opt.value)}
                    aria-pressed={active}
                    className={`p-3 rounded-lg border text-left text-xs flex items-center gap-2 cursor-pointer ${
                      active
                        ? 'border-[#10B981] bg-[#10B981]/10 text-white'
                        : 'border-[#242424] bg-[#0A0A0A] text-[#A0A0A5] hover:border-[#333]'
                    }`}
                  >
                    <Icon className={`w-4 h-4 ${active ? 'text-[#10B981]' : ''}`} />
                    <span className="font-medium">{opt.label}</span>
                  </button>
                );
              })}
            </div>

            {whenMode === 'SCHEDULE' && (
              <div className="grid grid-cols-2 gap-3 p-3 bg-[#0A0A0A] border border-[#242424] rounded-lg">
                <label className="text-[11px] text-[#8E8E93] space-y-1">
                  <span className="block">Dia</span>
                  <input
                    type="date"
                    value={scheduledDate}
                    onChange={(e) => setScheduledDate(e.target.value)}
                    className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                </label>
                <label className="text-[11px] text-[#8E8E93] space-y-1">
                  <span className="block">Horário</span>
                  <input
                    type="time"
                    value={scheduledTime}
                    onChange={(e) => setScheduledTime(e.target.value)}
                    className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                </label>
                <p className="col-span-2 text-[11px] text-[#8E8E93]">
                  {scheduledDate && scheduledTime
                    ? `Vai ser publicado em ${formatDateBr(scheduledDate)} às ${scheduledTime} (horário de Brasília).`
                    : 'Escolha o dia e o horário.'}
                </p>
              </div>
            )}
          </section>
        </div>

        {/* Rodapé: uma ação principal */}
        <div className="px-5 py-3.5 border-t border-[#242424] bg-[#121212] flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="px-3.5 py-2 text-xs text-[#8E8E93] hover:text-white rounded-lg cursor-pointer disabled:opacity-50"
          >
            Cancelar
          </button>
          {whenMode === 'SCHEDULE' ? (
            <button
              type="button"
              onClick={handleSchedule}
              disabled={!canSubmit}
              className="px-4 py-2.5 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-sm rounded-lg flex items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <Calendar className="w-4 h-4" />
              <span>{submittingMode === 'SCHEDULE' ? 'Agendando...' : 'Agendar publicação'}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handlePublishNow}
              disabled={!canSubmit}
              className="px-4 py-2.5 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-sm rounded-lg flex items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              <span>{submittingMode === 'NOW' ? 'Publicando...' : 'Publicar agora'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
