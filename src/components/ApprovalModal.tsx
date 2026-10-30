import React, { useState, useEffect } from 'react';
import {
  PostGroup,
  InstagramPublishPayload,
  TenantAccount,
  CaptionRecord,
} from '../types/index.ts';
import { api } from '../services/api.ts';
import { formatUtcToSaoPauloParts } from '../utils/postHelpers.ts';
import { CarouselViewer } from './CarouselViewer.tsx';
import { driveThumbUrl } from '../utils/mediaUrl.ts';
import {
  X,
  Sparkles,
  Calendar,
  Send,
  AlertCircle,
  RefreshCw,
  Instagram,
  Save,
  CheckCircle2,
  History,
  SlidersHorizontal,
} from 'lucide-react';

interface ApprovalModalProps {
  post: PostGroup;
  isOpen: boolean;
  onClose: () => void;
  onConfirmPublish: (post: PostGroup, payload: InstagramPublishPayload) => Promise<void>;
  onPublishInstagramNow?: (post: PostGroup, caption: string, accountId?: string) => Promise<void>;
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

  const defaultAiCaption =
    post.caption ||
    `${cleanBatchTitle}\n\nCada detalhe importa quando construímos presença digital com propósito e consistência para ${clientName}.\n\nDeixe seu comentário abaixo e compartilhe este conteúdo!\n\n#${clientName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')} #socialmedia #estrategiadigital #branding`;

  const [caption, setCaption] = useState(defaultAiCaption);
  const [captionSource, setCaptionSource] = useState<
    'GEMINI' | 'GEMINI_AI' | 'GEMINI_EDITED' | 'EDITED_AI' | 'MANUAL'
  >(post.captionSource || 'MANUAL');
  const [lastAiGenerationId, setLastAiGenerationId] = useState<string | null>(null);
  const [captionsHistory, setCaptionsHistory] = useState<CaptionRecord[]>(
    post.captionsHistory || []
  );
  const [requiresReapproval, setRequiresReapproval] = useState<boolean>(
    post.status === 'PENDENTE_APROVACAO'
  );
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  // Contexto para geração de legenda com Gemini (Etapa 7)
  const [showContextControls, setShowContextControls] = useState(true);
  const [objective, setObjective] = useState('Engajamento, autoridade de marca e conversão');
  const [theme, setTheme] = useState(cleanBatchTitle);
  const [tone, setTone] = useState('Estratégico, direto e contemporâneo');
  const [cta, setCta] = useState('Salve este post, comente abaixo e envie para quem precisa ver');
  const [includeHashtags, setIncludeHashtags] = useState(true);

  const [isGeneratingCaption, setIsGeneratingCaption] = useState(false);
  const [isSavingCaption, setIsSavingCaption] = useState(false);

  const [accounts, setAccounts] = useState<TenantAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(
    post.scheduledAccountId || post.tenantId || ''
  );

  const initialSpParts = formatUtcToSaoPauloParts(post.scheduledAt);
  const [scheduledDate, setScheduledDate] = useState(initialSpParts.date);
  const [scheduledTime, setScheduledTime] = useState(initialSpParts.time);

  const [submittingMode, setSubmittingMode] = useState<'NOW' | 'SCHEDULE' | 'APPROVE' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setStatusNotice(null);
    setTheme(cleanBatchTitle);
    setRequiresReapproval(post.status === 'PENDENTE_APROVACAO');

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
          if (matched) {
            setSelectedAccountId(matched.id);
          } else {
            setSelectedAccountId('');
          }
        })
        .catch(() => {});
    };

    loadCompanyAccounts();

    const handleOAuthMessage = async (event: MessageEvent) => {
      if (event.data && event.data.type === 'INSTAGRAM_AUTH_SUCCESS') {
        try {
          await api.syncInstagramSession({
            user: event.data.user,
            tenant: event.data.tenant,
            syncTicket: event.data.syncTicket,
          });
          setError(null);
          setStatusNotice(
            `Conta @${event.data.tenant?.username || 'Instagram'} conectada com sucesso! Token longo salvo no PostgreSQL.`
          );
          loadCompanyAccounts();
        } catch {}
      }
    };

    window.addEventListener('message', handleOAuthMessage);

    api
      .getPostCaptionsHistory(post.id)
      .then((histRes) => {
        if (Array.isArray(histRes.captionsHistory)) {
          setCaptionsHistory(histRes.captionsHistory);
        }
        if (histRes.currentCaption) {
          setCaption(histRes.currentCaption);
        }
      })
      .catch(() => {});

    if (post.caption) {
      setCaption(post.caption);
    } else {
      setCaption(defaultAiCaption);
    }

    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [
    isOpen,
    post.id,
    post.caption,
    post.status,
    post.scheduledAt,
    post.scheduledAccountId,
    post.tenantId,
    cleanBatchTitle,
    clientName,
    defaultAiCaption,
  ]);

  if (!isOpen) return null;

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const needsReconnection =
    selectedAccount?.connectionStatus === 'RECONEXAO_NECESSARIA' ||
    post.status === 'RECONEXAO_NECESSARIA' ||
    (error && error.includes('RECONEXAO_NECESSARIA')) ||
    (error && error.includes('Reconecte'));

  const handleReconnectInstagram = async () => {
    try {
      const authRes = await api.getInstagramAuthUrl(
        window.location.origin,
        selectedAccountId || undefined,
        clientName
      );
      if (authRes?.url) {
        const popup = window.open(
          authRes.url,
          'InstagramModalReconnect',
          'width=600,height=700,left=200,top=100'
        );
        if (!popup) {
          window.location.href = authRes.url;
        }
      }
    } catch (err: any) {
      setError(err.message || 'Erro ao iniciar conexão OAuth com Instagram.');
    }
  };

  const handleGenerateCaption = async (regenerate = false) => {
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
        regenerate,
      });
      if (res.caption) {
        setCaption(res.caption);
        setCaptionSource('GEMINI');
        if (res.aiGeneration?.id) {
          setLastAiGenerationId(res.aiGeneration.id);
        }
        if (res.post?.captionsHistory) {
          setCaptionsHistory(res.post.captionsHistory);
        }
        if (res.requiresReapproval) {
          setRequiresReapproval(true);
        }
        setStatusNotice(
          res.message ||
            `Legenda gerada com Gemini (${res.modelUsed || 'gemini-flash'}) e salva no PostgreSQL!`
        );
      }
    } catch (err: any) {
      setError(err.message || 'Não foi possível gerar a legenda com a Gemini API.');
    } finally {
      setIsGeneratingCaption(false);
    }
  };

  const handleSaveCaption = async () => {
    if (!caption.trim()) {
      setError('A legenda não pode estar vazia para salvar.');
      return;
    }
    setIsSavingCaption(true);
    setError(null);
    setStatusNotice(null);
    try {
      const effectiveSource =
        captionSource === 'GEMINI' || captionSource === 'GEMINI_EDITED'
          ? 'GEMINI_EDITED'
          : 'MANUAL';
      const res = await api.savePostCaption(post.id, {
        content: caption,
        source: effectiveSource,
        aiGenerationId: lastAiGenerationId,
      });
      setCaption(res.caption);
      if (res.post?.captionsHistory) {
        setCaptionsHistory(res.post.captionsHistory);
      }
      if (res.requiresReapproval) {
        setRequiresReapproval(true);
      }
      setStatusNotice(
        res.message || 'Legenda salva no PostgreSQL e vinculada à postagem com sucesso!'
      );
    } catch (err: any) {
      setError(err.message || 'Erro ao salvar legenda no PostgreSQL.');
    } finally {
      setIsSavingCaption(false);
    }
  };

  const handleApproveOnly = async () => {
    setError(null);
    setStatusNotice(null);
    setSubmittingMode('APPROVE');
    try {
      await onConfirmPublish(post, {
        action: 'APPROVE',
        caption,
        accountId: selectedAccountId || undefined,
      });
      setRequiresReapproval(false);
      setStatusNotice('Legenda e postagem aprovadas com sucesso no PostgreSQL!');
    } catch (err: any) {
      setError(err.message || 'Erro ao aprovar legenda e postagem.');
    } finally {
      setSubmittingMode(null);
    }
  };

  const handleSchedule = async () => {
    setError(null);
    if (!scheduledDate || !scheduledTime) {
      setError('Selecione a data e o horário para agendar a publicação.');
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
      setError(err.message || 'Erro ao agendar publicação.');
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
        await onConfirmPublish(post, {
          action: 'NOW',
          caption,
          accountId: selectedAccountId || undefined,
        });
      }
      onClose();
    } catch (err: any) {
      setError(err.message || 'Erro ao publicar no Instagram.');
    } finally {
      setSubmittingMode(null);
    }
  };

  const isBusy = submittingMode !== null || isGeneratingCaption || isSavingCaption;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm font-sans"
      onClick={() => !isBusy && onClose()}
    >
      <div
        className="bg-[#121212] border border-[#242424] rounded-xl w-full max-w-2xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-[#242424] flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="px-2 py-0.5 rounded bg-[#10B981]/15 border border-[#10B981]/40 text-[#10B981] font-mono text-[11px] font-semibold">
                {clientName}
              </span>
              <h2 className="text-sm font-semibold text-white">Publicar no Instagram</h2>
              {requiresReapproval && (
                <span className="px-2 py-0.5 rounded bg-[#F59E0B]/20 border border-[#F59E0B]/50 text-[#F59E0B] text-[10px] font-semibold">
                  Aprovação necessária
                </span>
              )}
            </div>
            <p className="text-xs text-[#8E8E93] truncate">
              Revise sua legenda e escolha quando publicar.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="text-[#8E8E93] hover:text-white p-1.5 rounded-lg bg-[#1A1A1A] border border-[#2A2A2A] cursor-pointer disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="p-3 bg-red-950/40 border border-[#EF4444]/50 rounded-lg text-[#EF4444] text-xs flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="font-semibold">Atenção:</div>
                  <div className="text-[#F8B4B4] break-words">{error}</div>
                </div>
              </div>
              {needsReconnection && (
                <button
                  type="button"
                  onClick={handleReconnectInstagram}
                  className="px-3 py-1.5 bg-[#F59E0B] hover:bg-[#D97706] text-[#0A0A0A] font-semibold text-xs rounded-lg shrink-0 flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Reconectar Instagram</span>
                </button>
              )}
            </div>
          )}

          {statusNotice && (
            <div className="p-2.5 bg-[#10B981]/10 border border-[#10B981]/30 rounded-lg text-[#10B981] text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{statusNotice}</span>
            </div>
          )}

          {/* Account Indicator (Dropdown removed — strictly bound to authenticated account) */}
          <div className="p-3 bg-[#0A0A0A] border border-[#242424] rounded-lg flex items-center justify-between gap-2.5">
            <div className="flex items-center gap-2 text-xs">
              <Instagram className="w-4 h-4 text-[#10B981]" />
              <span className="text-[#8E8E93]">Conta de destino:</span>
              <span className="font-semibold text-white">
                Publicando em @{selectedAccount?.username || post.scheduledAccountId || clientName.toLowerCase()}
              </span>
            </div>
            {selectedAccount?.connectionStatus === 'RECONEXAO_NECESSARIA' && (
              <button
                type="button"
                onClick={handleReconnectInstagram}
                className="px-2.5 py-1.5 bg-[#F59E0B]/20 border border-[#F59E0B]/50 text-[#F59E0B] text-[11px] font-semibold rounded hover:bg-[#F59E0B]/30 cursor-pointer flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Reconectar</span>
              </button>
            )}
          </div>

          {/* Visual Preview */}
          <div className="bg-[#0A0A0A] border border-[#242424] rounded-lg p-3 flex items-center justify-center">
            {post.categoria === 'Carrossel' || post.items.length > 1 ? (
              <div className="w-full max-w-[280px]">
                <CarouselViewer
                  items={post.items}
                  categoria={post.categoria}
                  loteNome={post.loteNome}
                />
              </div>
            ) : (
              <div
                className={`relative w-full ${
                  post.categoria.toLowerCase().includes('story')
                    ? 'aspect-[9/16] max-h-[260px]'
                    : 'aspect-square max-h-[260px]'
                } overflow-hidden rounded flex items-center justify-center`}
              >
                <img
                  src={driveThumbUrl(post.items[0]?.driveFileId, 1600) || post.items[0]?.viewUrl || post.items[0]?.thumbnailUrl}
                  loading="lazy"
                  decoding="async"
                  alt={post.nome}
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    const target = e.currentTarget;
                    const item = post.items[0];
                    if (!item) return;
                    const thumbFallback = item.driveFileId
                      ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(item.driveFileId)}&sz=w1200`
                      : '';
                    if (thumbFallback && target.src !== thumbFallback) {
                      target.src = thumbFallback;
                    }
                  }}
                  className="w-full h-full object-contain"
                />
              </div>
            )}
          </div>

          {/* AI Caption Context & Controls */}
          <div className="bg-[#0A0A0A] border border-[#242424] rounded-lg p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                <Sparkles className="w-3.5 h-3.5 text-[#10B981]" />
                <span>Legenda com IA</span>
              </div>
              <button
                type="button"
                onClick={() => setShowContextControls((prev) => !prev)}
                className="text-[11px] text-[#8E8E93] hover:text-white flex items-center gap-1 cursor-pointer"
              >
                <SlidersHorizontal className="w-3 h-3" />
                <span>{showContextControls ? 'Ocultar ajustes' : 'Personalizar tom e objetivo'}</span>
              </button>
            </div>

            {showContextControls && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 border-t border-[#1E1E1E]">
                <div>
                  <label className="block text-[10px] text-[#8E8E93] mb-1">
                    Objetivo da postagem
                  </label>
                  <input
                    type="text"
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    placeholder="Ex: Engajamento, autoridade, vendas..."
                    className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-[#8E8E93] mb-1">
                    Tema ou briefing
                  </label>
                  <input
                    type="text"
                    value={theme}
                    onChange={(e) => setTheme(e.target.value)}
                    placeholder="Sobre o que trata esta peça..."
                    className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-[#8E8E93] mb-1">
                    Tom de voz da marca
                  </label>
                  <input
                    type="text"
                    value={tone}
                    onChange={(e) => setTone(e.target.value)}
                    placeholder="Ex: Estratégico, próximo, técnico..."
                    className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-[#8E8E93] mb-1">
                    CTA desejado (Chamada para ação)
                  </label>
                  <input
                    type="text"
                    value={cta}
                    onChange={(e) => setCta(e.target.value)}
                    placeholder="Ex: Comente abaixo, fale no link da bio..."
                    className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                </div>
                <div className="sm:col-span-2 flex items-center justify-between pt-1">
                  <label className="inline-flex items-center gap-2 text-xs text-[#A0A0A5] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeHashtags}
                      onChange={(e) => setIncludeHashtags(e.target.checked)}
                      className="accent-[#10B981] rounded cursor-pointer"
                    />
                    <span>Incluir hashtags estratégicas na legenda</span>
                  </label>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleGenerateCaption(false)}
                      disabled={isBusy}
                      className="px-3 py-1.5 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-xs rounded-lg flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>
                        {isGeneratingCaption ? 'Gerando legenda...' : 'Gerar legenda com IA'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleGenerateCaption(true)}
                      disabled={isBusy}
                      className="px-2.5 py-1.5 bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E] text-white font-medium text-xs rounded-lg flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className="w-3 h-3 text-[#10B981]" />
                      <span>Gerar outra versão</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Editable Caption Textarea + Save Button + Version History */}
            <div className="space-y-2 pt-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  className="text-xs font-medium text-white flex items-center gap-1.5"
                  htmlFor="post-caption"
                >
                  <span>Legenda da Publicação (editável)</span>
                </label>

                <div className="flex items-center gap-2">
                  {captionsHistory.length > 0 && (
                    <div className="flex items-center gap-1 text-[11px] text-[#8E8E93]">
                      <History className="w-3 h-3 text-[#10B981]" />
                      <select
                        value=""
                        onChange={(e) => {
                          const ver = captionsHistory.find((c) => c.id === e.target.value);
                          if (ver) {
                            setCaption(ver.content);
                            setCaptionSource(ver.source);
                          }
                        }}
                        className="bg-[#121212] border border-[#242424] rounded px-2 py-0.5 text-[11px] text-[#A0A0A5] outline-none cursor-pointer"
                      >
                        <option value="">
                          Histórico ({captionsHistory.length} vers.)
                        </option>
                        {captionsHistory.map((ver) => (
                          <option key={ver.id} value={ver.id}>
                            v{ver.versionNumber} ({ver.source}) —{' '}
                            {ver.approvalStatus === 'APPROVED' ? 'Aprovada' : 'Rascunho'}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleSaveCaption}
                    disabled={isBusy}
                    className="px-2.5 py-1 bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E] text-[#10B981] font-semibold text-[11px] rounded flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    <Save className="w-3 h-3" />
                    <span>{isSavingCaption ? 'Salvando...' : 'Salvar legenda'}</span>
                  </button>
                </div>
              </div>

              <textarea
                id="post-caption"
                rows={5}
                value={caption}
                onChange={(e) => {
                  setCaption(e.target.value);
                  if (post.status === 'APROVADO' || post.status === 'AGENDADO') {
                    setRequiresReapproval(true);
                  }
                }}
                placeholder="Escreva ou edite a legenda para o Instagram..."
                className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded-lg p-3 text-xs text-white placeholder-[#555555] outline-none resize-y leading-relaxed"
              />
            </div>
          </div>

          {/* Schedule Date & Time (America/Sao_Paulo) */}
          <div className="p-3.5 bg-[#0A0A0A] border border-[#242424] rounded-lg space-y-2.5">
            <div className="flex items-center justify-between text-xs font-medium text-[#A0A0A5]">
              <div className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-[#10B981]" />
                <span>Data e Horário para Agendamento Automático</span>
              </div>
              <span className="text-[11px] font-mono text-[#8E8E93]">
                Fuso: America/Sao_Paulo (BRT -03:00)
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-[#8E8E93] mb-1" htmlFor="schedule-date">
                  Data (São Paulo)
                </label>
                <input
                  id="schedule-date"
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded px-2.5 py-1.5 text-xs text-white font-mono outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[#8E8E93] mb-1" htmlFor="schedule-time">
                  Horário (BRT)
                </label>
                <input
                  id="schedule-time"
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="w-full bg-[#121212] border border-[#242424] focus:border-[#10B981] rounded px-2.5 py-1.5 text-xs text-white font-mono outline-none"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer with Action Buttons: "Aprovar Legenda", "Agendar" and "Publicar Agora" */}
        <div className="p-4 border-b-0 border-t border-[#242424] bg-[#121212] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="px-3.5 py-2 text-xs text-[#8E8E93] hover:text-white rounded-lg border border-transparent hover:border-[#242424] transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancelar
          </button>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
            <button
              type="button"
              onClick={handleApproveOnly}
              disabled={isBusy}
              className="px-3.5 py-2.5 bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E] text-[#10B981] font-semibold text-xs rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{submittingMode === 'APPROVE' ? 'Aprovando...' : 'Aprovar Legenda'}</span>
            </button>

            <button
              type="button"
              onClick={handleSchedule}
              disabled={isBusy}
              className="px-4 py-2.5 bg-[#1A1A1A] hover:bg-[#242424] border border-[#2E2E2E] text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              <Calendar className="w-3.5 h-3.5 text-[#10B981]" />
              <span>{submittingMode === 'SCHEDULE' ? 'Agendando...' : 'Agendar'}</span>
            </button>

            <button
              type="button"
              onClick={handlePublishNow}
              disabled={isBusy}
              className="px-4 py-2.5 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-xs rounded-lg transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              <Send className="w-3.5 h-3.5" />
              <span>
                {submittingMode === 'NOW' ? 'Publicando no Instagram...' : 'Publicar Agora'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
