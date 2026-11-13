import React from 'react';
import { ClientObservationsView } from '../ClientObservationsView.tsx';

interface MemoryViewProps {
  companyName?: string;
  companyId?: string;
  driveFolderName?: string;
}

/**
 * Memória criativa em tela própria do usuário. Reutiliza ClientObservationsView sem alterá-lo;
 * a geração de conteúdo por IA continua igual.
 */
export const MemoryView: React.FC<MemoryViewProps> = (props) => {
  return (
    <div className="space-y-6 max-w-4xl">
      <header>
        <h1 className="text-2xl font-bold">Memória criativa</h1>
        <p className="text-sm text-[#8E8E93] mt-1">
          Conte o que você quer ver nas próximas publicações. Suas sugestões entram na criação dos
          próximos conteúdos.
        </p>
      </header>
      <ClientObservationsView {...props} isAdmin={false} />
    </div>
  );
};
