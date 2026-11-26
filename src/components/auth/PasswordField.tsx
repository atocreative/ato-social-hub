import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { authInputClass } from './AuthShell.tsx';

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  hint?: string;
  minLength?: number;
}

// Campo de senha com mostrar/ocultar. Com essa opção a confirmação de senha deixa de ser necessária.
export const PasswordField: React.FC<PasswordFieldProps> = ({ id, label, value, onChange, autoComplete, hint, minLength }) => {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          required
          minLength={minLength}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="••••••••••"
          className={`${authInputClass} pr-11`}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 px-3 text-[#8E8E93] hover:text-white cursor-pointer"
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {hint && <p className="mt-1.5 text-[11px] text-[#6B6B70]">{hint}</p>}
    </div>
  );
};
