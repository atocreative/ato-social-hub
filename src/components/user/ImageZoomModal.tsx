import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface ImageZoomModalProps {
  src: string;
  alt: string;
  onClose: () => void;
}

/** Abre a imagem ampliada. Fecha com Esc ou clicando fora. */
export const ImageZoomModal: React.FC<ImageZoomModalProps> = ({ src, alt, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4" onClick={onClose}>
      <button
        type="button"
        onClick={onClose}
        aria-label="Fechar imagem"
        className="absolute top-4 right-4 p-2 rounded-lg bg-[#121212] border border-[#242424] text-white cursor-pointer"
      >
        <X className="w-4 h-4" />
      </button>
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[95vw] object-contain rounded-lg"
      />
    </div>
  );
};
