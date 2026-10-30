import React from 'react';
import { X } from 'lucide-react';

export interface NotificationState {
  type: 'success' | 'error' | 'info';
  message: string;
}

interface NotificationBannerProps {
  notification: NotificationState | null;
  onDismiss: () => void;
}

export const NotificationBanner: React.FC<NotificationBannerProps> = ({
  notification,
  onDismiss,
}) => {
  if (!notification) return null;

  const isSuccess = notification.type === 'success';
  const isError = notification.type === 'error';

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 max-w-sm p-3.5 rounded-lg border shadow-xl flex items-center justify-between gap-3 text-xs font-sans ${
        isSuccess
          ? 'bg-[#121212] border-[#10B981]/50 text-[#10B981]'
          : isError
          ? 'bg-[#121212] border-[#EF4444]/50 text-[#EF4444]'
          : 'bg-[#121212] border-[#242424] text-white'
      }`}
    >
      <div className="flex-1 leading-snug">{notification.message}</div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[#8E8E93] hover:text-white cursor-pointer ml-1"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};
