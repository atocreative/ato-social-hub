import React, { useState } from 'react';
import { api } from '../services/api.ts';
import { X, RefreshCw } from 'lucide-react';

interface WebhookSimulatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSyncSuccess: () => void;
}

export const WebhookSimulatorModal: React.FC<WebhookSimulatorModalProps> = ({
  isOpen,
  onClose,
  onSyncSuccess,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [responseMessage, setResponseMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSyncDrive = async () => {
    setIsSubmitting(true);
    setError(null);
    setResponseMessage(null);

    try {
      const res = await api.syncDriveNow();
      setResponseMessage(res.message || 'Sincronização com o Google Drive executada com sucesso.');
      onSyncSuccess();
    } catch (err: any) {
      setError(err.message || 'Falha ao sincronizar com o Google Drive.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 font-sans">
      <div className="bg-[#121212] border border-[#242424] rounded-2xl w-full max-w-md flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-[#242424] flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">Sincronização Google Drive</h2>
            <p className="text-xs text-[#8E8E93] mt-0.5">
              Atualize mídias e pastas vinculadas
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[#8E8E93] hover:text-white p-1 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content: Clean single action */}
        <div className="p-6 space-y-5">
          <div className="p-3 bg-[#1A1A1A] border border-[#2E2E2E] rounded-xl text-xs text-[#8E8E93] leading-relaxed space-y-1">
            <div className="text-white font-medium">Informação de Sincronização</div>
            <div>A sincronização com o Google Drive ocorre automaticamente a cada 5 minutos pelo Apps Script.</div>
          </div>

          {responseMessage && (
            <div className="p-3 bg-[#10B981]/10 border border-[#10B981]/30 rounded-lg text-[#10B981] text-xs">
              {responseMessage}
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-950/30 border border-[#EF4444]/40 rounded-lg text-[#EF4444] text-xs">
              {error}
            </div>
          )}

          {/* Clean Primary Button */}
          <button
            type="button"
            onClick={handleSyncDrive}
            disabled={isSubmitting}
            className="w-full py-3 px-4 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-xs rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isSubmitting ? 'animate-spin' : ''}`} />
            <span>{isSubmitting ? 'Sincronizando...' : 'Verificar Atualizações do Drive'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
