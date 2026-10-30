import React, { useState } from 'react';
import { api } from '../services/api.ts';
import { X, Upload } from 'lucide-react';

interface UploadMediaModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUploadSuccess: () => void;
  folderName: string;
  availableFolders?: string[];
}

export const UploadMediaModal: React.FC<UploadMediaModalProps> = ({
  isOpen,
  onClose,
  onUploadSuccess,
  folderName,
  availableFolders = [],
}) => {
  const initialFolder =
    folderName && folderName !== 'ALL' && folderName.toLowerCase() !== 'ato social midia'
      ? folderName
      : availableFolders[0] || 'Ato';

  const [selectedFolder, setSelectedFolder] = useState<string>(initialFolder);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [categoria, setCategoria] = useState<'Post Único' | 'Carrossel' | 'Story'>('Post Único');
  const [customName, setCustomName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const effectiveFolder =
    selectedFolder && selectedFolder !== 'ALL' && selectedFolder.toLowerCase() !== 'ato social midia'
      ? selectedFolder
      : availableFolders[0] || 'Ato';

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      setFile(selected);
      setCustomName(selected.name);
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreviewUrl(reader.result as string);
      };
      reader.readAsDataURL(selected);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!previewUrl && !file) {
      setError('Selecione um arquivo de imagem.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const fileName = customName.trim() || `ATO_Upload_${Date.now()}.png`;
      let mimeType = 'image/png';
      let base64Data = previewUrl || '';

      if (previewUrl && previewUrl.includes('data:')) {
        const parts = previewUrl.split(';');
        const mimePart = parts[0]; // data:image/png
        if (mimePart && mimePart.includes(':')) {
          mimeType = mimePart.split(':')[1];
        }
        const base64Part = parts[1]; // base64,...
        if (base64Part && base64Part.includes(',')) {
          base64Data = base64Part.split(',')[1];
        }
      }

      await api.uploadMedia({
        nome: fileName,
        categoria,
        mimeType,
        base64Data,
        viewUrl: previewUrl || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=800&auto=format&fit=crop',
        thumbnailUrl: previewUrl || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=800&auto=format&fit=crop',
        folderName: effectiveFolder,
      });
      onUploadSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Erro ao enviar mídia.');
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
            <h2 className="text-sm font-semibold text-white">Enviar Mídia Pronta</h2>
            <p className="text-xs text-[#8E8E93] mt-0.5">
              Empresa: <span className="text-white font-mono">{effectiveFolder}</span>
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

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-red-950/30 border border-[#EF4444]/40 rounded-lg text-[#EF4444] text-xs">
              {error}
            </div>
          )}

          {availableFolders.length > 0 && (
            <div>
              <label className="block text-xs text-[#8E8E93] mb-1.5">Empresa (Pasta no Drive)</label>
              <select
                value={effectiveFolder}
                onChange={(e) => setSelectedFolder(e.target.value)}
                className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-xs text-white outline-none cursor-pointer"
              >
                {availableFolders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs text-[#8E8E93] mb-1.5">Arquivo de Imagem</label>
            <div className="border border-dashed border-[#2E2E2E] hover:border-[#10B981] rounded-xl p-4 text-center cursor-pointer bg-[#0A0A0A] transition-colors relative">
              <input
                type="file"
                accept="image/*"
                required
                onChange={handleFileChange}
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
              />
              {previewUrl ? (
                <div className="flex items-center gap-3">
                  <img src={previewUrl} alt="Preview" className="w-12 h-12 object-cover rounded-lg border border-[#242424]" />
                  <div className="text-left overflow-hidden">
                    <div className="text-xs text-white font-medium truncate">{file?.name}</div>
                    <div className="text-[11px] text-[#8E8E93]">Clique para alterar arquivo</div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-3">
                  <Upload className="w-6 h-6 text-[#8E8E93] mb-1.5" />
                  <span className="text-xs text-white font-medium">Clique para selecionar imagem (.jpg, .png)</span>
                  <span className="text-[11px] text-[#8E8E93] mt-0.5">ou arraste o arquivo aqui</span>
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs text-[#8E8E93] mb-1.5">Nome do Arquivo</label>
            <input
              type="text"
              required
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="ex: arte_campanha_01.png"
              className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-xs text-white placeholder-[#4E4E52] outline-none font-mono"
            />
          </div>

          <div>
            <label className="block text-xs text-[#8E8E93] mb-1.5">Categoria</label>
            <select
              value={categoria}
              onChange={(e) => setCategoria(e.target.value as any)}
              className="w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-xs text-white outline-none cursor-pointer"
            >
              <option value="Post Único">Post Único</option>
              <option value="Carrossel">Carrossel</option>
              <option value="Story">Story</option>
            </select>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2.5 px-4 bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] font-semibold text-xs rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              {isSubmitting ? 'Enviando ao Drive...' : 'Enviar Mídia Pronta (Aprovada)'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
