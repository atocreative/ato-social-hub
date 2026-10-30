import React, { useState, useEffect, useCallback } from 'react';
import { ClientObservation, CreativeContext } from '../types/index.ts';
import { api } from '../services/api.ts';
import {
  MessageSquarePlus,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  ToggleLeft,
  ToggleRight,
  Edit3,
  Bookmark,
  Calendar,
  Layers,
  FileText,
  RefreshCw,
} from 'lucide-react';

interface ClientObservationsViewProps {
  companyName?: string;
  companyId?: string;
  driveFolderName?: string;
  isAdmin?: boolean;
}

export const ClientObservationsView: React.FC<ClientObservationsViewProps> = ({
  companyName,
  companyId,
  driveFolderName,
  isAdmin = false,
}) => {
  const [observations, setObservations] = useState<ClientObservation[]>([]);
  const [creativeContext, setCreativeContext] = useState<CreativeContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Form State
  const [content, setContent] = useState('');
  const [type, setType] = useState<'PERMANENTE' | 'PONTUAL'>('PONTUAL');
  const [editingId, setEditingId] = useState<string | null>(null);

  const fetchObservations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getClientObservations(companyId, driveFolderName);
      const rawObs = Array.isArray(res.observations) ? res.observations : [];
      const cleanedObs = rawObs.filter((obs) => {
        const author = String(obs.authorName || obs.author_name || '').toLowerCase();
        const text = String(obs.content || '').toLowerCase();
        if (
          author.includes('test script') ||
          text.includes('teste de integração') ||
          text.includes('validação de fk')
        ) {
          return false;
        }
        return true;
      });
      setObservations(cleanedObs);

      try {
        const ctxRes = await api.getCreativeContext(companyId, driveFolderName);
        if (ctxRes) setCreativeContext(ctxRes);
      } catch (ctxErr) {
        console.warn('Aviso ao carregar contexto criativo:', ctxErr);
      }
    } catch (err: any) {
      setError(err.message || 'Erro ao carregar observações do cliente.');
    } finally {
      setLoading(false);
    }
  }, [companyId, driveFolderName]);

  useEffect(() => {
    fetchObservations();
  }, [fetchObservations]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    setSaving(true);
    setError(null);
    setSuccessMsg(null);

    try {
      if (editingId) {
        await api.updateClientObservation(editingId, {
          content: content.trim(),
          type,
        });
        setSuccessMsg('Sugestão atualizada com sucesso!');
        setEditingId(null);
      } else {
        await api.createClientObservation({
          content: content.trim(),
          type,
          companyId,
          driveFolderName,
        });
        setSuccessMsg('Sugestão salva com sucesso!');
      }

      setContent('');
      await fetchObservations();
    } catch (err: any) {
      setError(err.message || 'Não foi possível salvar a sugestão. Tente novamente.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (obs: ClientObservation) => {
    const isCurrentlyActive = Boolean(obs.isActive ?? obs.is_active);
    try {
      setError(null);
      await api.updateClientObservation(obs.id, {
        isActive: !isCurrentlyActive,
      });
      setSuccessMsg(
        !isCurrentlyActive
          ? 'Sugestão ativada com sucesso!'
          : 'Sugestão desativada com sucesso!'
      );
      await fetchObservations();
    } catch (err: any) {
      setError(err.message || 'Erro ao alterar status da sugestão.');
    }
  };

  const handleStartEdit = (obs: ClientObservation) => {
    setEditingId(obs.id);
    setContent(obs.content);
    setType(obs.type);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setContent('');
    setType('PONTUAL');
  };

  const activeCount = observations.filter((o) => Boolean(o.isActive ?? o.is_active)).length;
  const targetLabel = companyName || driveFolderName || 'sua empresa';

  return (
    <div className="bg-[#121212] border border-[#242424] rounded-xl p-6 mb-8 text-white shadow-xl">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-4 border-b border-[#242424]">
        <div>
          <div className="flex items-center gap-2 text-[#10B981] font-semibold text-sm mb-1">
            <Sparkles className="w-4 h-4" />
            <span>Memória Criativa Inteligente</span>
          </div>
          <h2 className="text-xl font-bold tracking-tight text-white">
            Sugestões para as próximas artes
          </h2>
          <p className="text-sm text-[#8E8E93] mt-1">
            Conte o que gostaria de ver nas próximas publicações para {targetLabel}. Suas sugestões
            serão consideradas na criação de novos conteúdos.
          </p>
        </div>

        <button
          onClick={fetchObservations}
          disabled={loading}
          className="self-start md:self-auto flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-[#1A1A1A] hover:bg-[#242424] text-[#A1A1AA] hover:text-white rounded-lg border border-[#2A2A2A] transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>

      {/* Notifications */}
      {error && (
        <div className="mb-4 p-3 bg-[#2D1515] border border-[#EF4444]/40 rounded-lg flex items-center gap-3 text-sm text-[#FCA5A5]">
          <AlertCircle className="w-5 h-5 shrink-0 text-[#EF4444]" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="mb-4 p-3 bg-[#064E3B]/40 border border-[#10B981]/40 rounded-lg flex items-center gap-3 text-sm text-[#A7F3D0]">
          <CheckCircle2 className="w-5 h-5 shrink-0 text-[#10B981]" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Form Section */}
      <form onSubmit={handleSubmit} className="mb-8 bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <label className="text-sm font-medium text-white flex items-center gap-2">
            <MessageSquarePlus className="w-4 h-4 text-[#10B981]" />
            {editingId ? 'Editar Observação' : 'Nova Sugestão / Observação'}
          </label>
          {editingId && (
            <button
              type="button"
              onClick={handleCancelEdit}
              className="text-xs text-[#8E8E93] hover:text-white"
            >
              Cancelar edição
            </button>
          )}
        </div>

        <textarea
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Ex: 'Nas próximas postagens, quero destacar mais depoimentos de clientes e enfatizar nossa entrega em 24h.' ou 'Evitar usar fundo totalmente escuro nas artes do feed.'"
          className="w-full bg-[#141414] border border-[#282828] focus:border-[#10B981] rounded-lg p-3 text-sm text-white placeholder-[#55555C] focus:outline-none transition-colors mb-4 resize-none"
        />

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
          {/* Type Selector */}
          <div className="flex items-center gap-2 bg-[#141414] p-1 border border-[#242424] rounded-lg">
            <button
              type="button"
              onClick={() => setType('PONTUAL')}
              className={`flex-1 sm:flex-none flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                type === 'PONTUAL'
                  ? 'bg-[#10B981] text-black font-semibold'
                  : 'text-[#8E8E93] hover:text-white'
              }`}
            >
              <Calendar className="w-3.5 h-3.5" />
              Sugestão Pontual (Próximos Conteúdos)
            </button>
            <button
              type="button"
              onClick={() => setType('PERMANENTE')}
              className={`flex-1 sm:flex-none flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                type === 'PERMANENTE'
                  ? 'bg-[#3B82F6] text-white font-semibold'
                  : 'text-[#8E8E93] hover:text-white'
              }`}
            >
              <Bookmark className="w-3.5 h-3.5" />
              Regra Permanente da Marca
            </button>
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={saving || !content.trim()}
            className="px-5 py-2 text-xs font-semibold bg-[#10B981] hover:bg-[#059669] text-black rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer shadow-md"
          >
            {saving ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Salvando...
              </>
            ) : editingId ? (
              'Atualizar Observação'
            ) : (
              'Salvar Observação'
            )}
          </button>
        </div>
      </form>

      {/* History List */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Layers className="w-4 h-4 text-[#3B82F6]" />
            Histórico de Observações ({observations.length})
          </h3>
          <span className="text-xs text-[#8E8E93]">
            {activeCount} {activeCount === 1 ? 'ativa no contexto IA' : 'ativas no contexto IA'}
          </span>
        </div>

        {loading ? (
          <div className="py-8 text-center text-sm text-[#71717A]">
            Carregando sugestões do cliente...
          </div>
        ) : observations.length === 0 ? (
          <div className="p-6 bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl text-center text-sm text-[#71717A]">
            Nenhuma observação registrada ainda. Digite sua primeira sugestão acima para orientar a criação das próximas mídias!
          </div>
        ) : (
          <div className="space-y-3">
            {observations.map((obs) => {
              const isActive = Boolean(obs.isActive ?? obs.is_active);
              const authorName = obs.authorName || obs.author_name || 'Usuário';
              const syncStatus = obs.syncStatus || obs.sync_status;

              return (
                <div
                  key={obs.id}
                  className={`p-4 rounded-xl border transition-all ${
                    isActive
                      ? 'bg-[#151515] border-[#2A2A2A]'
                      : 'bg-[#0D0D0D] border-[#1A1A1A] opacity-60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`px-2 py-0.5 text-[10px] font-bold rounded-md uppercase tracking-wider ${
                          obs.type === 'PERMANENTE'
                            ? 'bg-[#1E3A8A] text-[#93C5FD] border border-[#3B82F6]/30'
                            : 'bg-[#064E3B] text-[#A7F3D0] border border-[#10B981]/30'
                        }`}
                      >
                        {obs.type === 'PERMANENTE' ? 'Regra Permanente' : 'Sugestão Pontual'}
                      </span>

                      <span className="text-xs text-[#71717A]">
                        por <strong className="text-[#A1A1AA]">{authorName}</strong>
                      </span>

                      {syncStatus === 'SYNCED' && (
                        <span className="px-1.5 py-0.5 text-[10px] text-[#10B981] bg-[#064E3B]/30 rounded">
                          Sincronizado
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(obs)}
                        title={isActive ? 'Clique para desativar esta sugestão' : 'Clique para ativar esta sugestão'}
                        className={`px-2.5 py-1 rounded-lg border text-xs flex items-center gap-1.5 transition-colors cursor-pointer ${
                          isActive
                            ? 'bg-[#064E3B]/30 border-[#10B981]/40 text-[#10B981] hover:bg-[#064E3B]/50'
                            : 'bg-[#18181B] border-[#27272A] text-[#A1A1AA] hover:text-white hover:border-[#3F3F46]'
                        }`}
                      >
                        {isActive ? (
                          <>
                            <ToggleRight className="w-4 h-4 text-[#10B981]" />
                            <span className="text-[11px] font-medium">Ativa (Desativar)</span>
                          </>
                        ) : (
                          <>
                            <ToggleLeft className="w-4 h-4 text-[#71717A]" />
                            <span className="text-[11px] font-medium">Inativa (Ativar)</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleStartEdit(obs)}
                        className="p-1.5 text-[#71717A] hover:text-white bg-[#1A1A1A] hover:bg-[#242424] border border-[#2A2A2A] rounded-lg transition-colors cursor-pointer"
                        title="Editar"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <p className="text-sm text-[#E4E4E7] whitespace-pre-wrap font-normal leading-relaxed">
                    {obs.content}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Dual Memory Prompt Context Drawer for Admins / Context Preview */}
      {creativeContext && creativeContext.formattedPromptContext && (
        <div className="mt-8 pt-6 border-t border-[#242424]">
          <details className="group">
            <summary className="flex items-center justify-between cursor-pointer text-xs text-[#8E8E93] hover:text-white transition-colors">
              <span className="flex items-center gap-2 font-mono">
                <FileText className="w-3.5 h-3.5 text-[#10B981]" />
                Ver contexto consolidado enviado à IA Gemini (Dupla Memória: Sugestões + Reprovações)
              </span>
              <span className="text-[10px] bg-[#1E1E1E] px-2 py-0.5 rounded">
                Clique para expandir
              </span>
            </summary>
            <div className="mt-3 p-4 bg-[#080808] border border-[#1C1C1C] rounded-lg font-mono text-xs text-[#A1A1AA] whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
              {creativeContext.formattedPromptContext}
            </div>
          </details>
        </div>
      )}
    </div>
  );
};
