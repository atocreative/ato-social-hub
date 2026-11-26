import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../services/api.ts';
import type { AccessStatus, AdminCompanyRow, AdminInstagramRow, AdminUserRow } from '../services/api.ts';

// Duas áreas distintas: (1) pessoas e empresas (aprovação), (2) contas Instagram (autorização Meta).
// Tudo vem direto do PostgreSQL: nada aqui espera por Google Drive ou Meta. Cada tela mostra carregando, erro real e vazio separadamente
// e recarrega a lista logo após cada operação.

type Tab = 'usuarios' | 'instagram';
type LoadState<T> = { phase: 'loading' | 'ready' | 'error'; data: T | null; error: string | null; ms?: number; at?: Date };

const STATUS_LABEL: Record<AccessStatus, string> = {
  PENDING_APPROVAL: 'Aguardando aprovação',
  ACTIVE: 'Ativo',
  REJECTED: 'Rejeitado',
  SUSPENDED: 'Suspenso',
};
const STATUS_STYLE: Record<AccessStatus, string> = {
  PENDING_APPROVAL: 'bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/30',
  ACTIVE: 'bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30',
  REJECTED: 'bg-[#EF4444]/10 text-[#EF4444] border-[#EF4444]/30',
  SUSPENDED: 'bg-[#8E8E93]/10 text-[#C8C8CC] border-[#8E8E93]/30',
};
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

const Pill: React.FC<{ className: string; children: React.ReactNode }> = ({ className, children }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-medium whitespace-nowrap ${className}`}>{children}</span>
);

const btn = 'px-2.5 py-1.5 rounded-lg text-xs font-medium border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors';
const btnPrimary = `${btn} bg-[#10B981] hover:bg-[#0EA271] text-[#0A0A0A] border-transparent`;
const btnGhost = `${btn} bg-[#161616] hover:bg-[#1F1F1F] text-white border-[#2A2A2A]`;
const btnDanger = `${btn} bg-transparent hover:bg-[#EF4444]/10 text-[#EF4444] border-[#EF4444]/40`;
const field = 'w-full bg-[#0A0A0A] border border-[#242424] focus:border-[#10B981] rounded-lg px-3 py-2 text-sm text-white outline-none';

function useLoader<T>(fetcher: () => Promise<T>) {
  const [state, setState] = useState<LoadState<T>>({ phase: 'loading', data: null, error: null });
  const seq = useRef(0);
  const load = useCallback(
    async (silent = false) => {
      const mine = ++seq.current; // respostas antigas nunca sobrescrevem as novas (corrida entre cargas)
      if (!silent) setState((s) => ({ ...s, phase: s.data ? s.phase : 'loading', error: null }));
      const t0 = performance.now();
      try {
        const data = await fetcher();
        if (mine !== seq.current) return;
        setState({ phase: 'ready', data, error: null, ms: Math.round(performance.now() - t0), at: new Date() });
      } catch (err: any) {
        if (mine !== seq.current) return;
        const msg = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'O servidor demorou demais para responder. Tente atualizar.' : err?.message || 'Não foi possível carregar.';
        setState((s) => ({ phase: 'error', data: s.data, error: msg, at: s.at }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);
  return { state, reload: load };
}

const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => (
  <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
    <div className="w-full max-w-md bg-[#121212] border border-[#242424] rounded-2xl p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-3 mb-4">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <button type="button" onClick={onClose} aria-label="Fechar" className="text-[#8E8E93] hover:text-white cursor-pointer">✕</button>
      </div>
      {children}
    </div>
  </div>
);

type Dialog =
  | { kind: 'approve'; user: AdminUserRow }
  | { kind: 'company'; user: AdminUserRow }
  | { kind: 'delete'; user: AdminUserRow }
  | { kind: 'reject'; user: AdminUserRow }
  | { kind: 'suspend'; user: AdminUserRow }
  | { kind: 'link-ig'; account: AdminInstagramRow }
  | { kind: 'disconnect-ig'; account: AdminInstagramRow }
  | null;

export const AdminUsersView: React.FC = () => {
  const [tab, setTab] = useState<Tab>('usuarios');
  const users = useLoader(() => api.adminListUsers());
  const instagram = useLoader(() => api.adminListInstagram());
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'ALL' | AccessStatus>('ALL');
  const [query, setQuery] = useState('');

  const companies: AdminCompanyRow[] = users.state.data?.companies || [];

  const run = async (fn: () => Promise<{ message?: string }>, after?: () => void) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      setNotice({ ok: true, text: r.message || 'Concluído.' });
      setDialog(null);
      after?.();
      // atualização imediata das duas listas (usuário e conta podem ter mudado)
      await Promise.all([users.reload(true), instagram.reload(true)]);
    } catch (err: any) {
      setNotice({ ok: false, text: err?.message || 'A operação falhou. Nada foi alterado.' });
    } finally {
      setBusy(false);
    }
  };

  const list = useMemo(() => {
    const all = users.state.data?.users || [];
    const q = query.trim().toLowerCase();
    return all.filter((u) => (filter === 'ALL' || u.accessStatus === filter) && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)));
  }, [users.state.data, filter, query]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: 0, PENDING_APPROVAL: 0, ACTIVE: 0, SUSPENDED: 0, REJECTED: 0 };
    for (const u of users.state.data?.users || []) {
      c.ALL++;
      c[u.accessStatus]++;
    }
    return c;
  }, [users.state.data]);

  const stamp = (s: LoadState<unknown>) => (s.at ? `Atualizado às ${s.at.toLocaleTimeString('pt-BR')}${s.ms !== undefined ? ` · ${s.ms} ms` : ''}` : '');

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Usuários, empresas e contas Instagram</h1>
          <p className="text-xs text-[#8E8E93] mt-0.5">Aprovar uma pessoa e autorizar uma conta do Instagram são decisões separadas.</p>
        </div>
        <div role="tablist" className="grid grid-cols-2 gap-1 p-1 bg-[#0A0A0A] border border-[#242424] rounded-xl">
          {(
            [
              ['usuarios', `Usuários e empresas${counts.PENDING_APPROVAL ? ` (${counts.PENDING_APPROVAL})` : ''}`],
              ['instagram', 'Contas Instagram'],
            ] as const
          ).map(([t, label]) => (
            <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg cursor-pointer ${tab === t ? 'bg-[#1C1C1C] text-white' : 'text-[#8E8E93] hover:text-white'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <div role={notice.ok ? 'status' : 'alert'} className={`p-3 rounded-lg border text-xs ${notice.ok ? 'bg-[#10B981]/10 border-[#10B981]/30 text-[#6EE7B7]' : 'bg-red-950/30 border-[#EF4444]/40 text-[#EF4444]'}`}>
          {notice.text}
        </div>
      )}

      {tab === 'usuarios' && (
        <section aria-label="Usuários e empresas" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {(['ALL', 'PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'REJECTED'] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)}
                className={`${btn} ${filter === f ? 'bg-[#1C1C1C] text-white border-[#10B981]/50' : 'bg-transparent text-[#8E8E93] border-[#242424] hover:text-white'}`}>
                {f === 'ALL' ? 'Todos' : STATUS_LABEL[f]} <span className="opacity-70">({counts[f]})</span>
              </button>
            ))}
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar nome ou e-mail" aria-label="Buscar usuário" className={`${field} max-w-[240px] ml-auto`} />
            <button type="button" className={btnGhost} onClick={() => void users.reload()}>Atualizar</button>
          </div>
          <p className="text-[11px] text-[#6B6B70]">{stamp(users.state)}</p>

          {users.state.phase === 'loading' && !users.state.data && <p className="text-sm text-[#8E8E93] py-8 text-center">Carregando usuários…</p>}
          {users.state.phase === 'error' && (
            <div role="alert" className="p-4 rounded-lg border border-[#EF4444]/40 bg-red-950/20 text-sm text-[#EF4444] flex items-center justify-between gap-3">
              <span>{users.state.error}</span>
              <button type="button" className={btnGhost} onClick={() => void users.reload()}>Tentar de novo</button>
            </div>
          )}
          {users.state.data && list.length === 0 && users.state.phase !== 'loading' && (
            <p className="text-sm text-[#8E8E93] py-8 text-center">{(users.state.data.users.length === 0) ? 'Nenhum usuário cadastrado ainda.' : 'Nenhum usuário neste filtro.'}</p>
          )}

          <ul className="space-y-2">
            {list.map((u) => (
              <li key={u.id} className="bg-[#121212] border border-[#242424] rounded-xl p-4">
                <div className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-6">
                  <div className="min-w-0 lg:w-[26%]">
                    <p className="text-sm font-semibold text-white truncate">{u.name}</p>
                    <p className="text-xs text-[#8E8E93] truncate">{u.email}</p>
                    <p className="text-[11px] text-[#6B6B70] mt-0.5">Cadastro: {fmtDate(u.createdAt)}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 lg:w-[22%]">
                    <Pill className={STATUS_STYLE[u.accessStatus]}>{STATUS_LABEL[u.accessStatus]}</Pill>
                    <Pill className={u.emailVerified ? 'bg-[#10B981]/10 text-[#6EE7B7] border-[#10B981]/30' : 'bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/30'}>
                      E-mail {u.emailVerified ? 'confirmado' : 'pendente'}
                    </Pill>
                    {u.origin === 'INSTAGRAM_LEGACY' && (
                      <Pill className="bg-[#3B82F6]/10 text-[#93C5FD] border-[#3B82F6]/30" >Registro técnico de conexão Instagram</Pill>
                    )}
                  </div>
                  <div className="text-xs text-[#C8C8CC] lg:w-[22%] min-w-0">
                    <p className="truncate">Empresa: <strong className="text-white">{u.companyName || '—'}</strong></p>
                    <p>Papel: {u.workspaceRole === 'OWNER' ? 'Proprietário' : u.workspaceRole === 'MEMBER' ? 'Membro' : '—'}</p>
                    <p className="truncate">Instagram: {u.instagram ? (u.instagram.username ? `@${u.instagram.username}${u.instagram.connected ? '' : ' (reconexão necessária)'}` : 'não conectado') : 'não conectado'}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 lg:ml-auto lg:justify-end">
                    {(u.accessStatus === 'PENDING_APPROVAL' || u.accessStatus === 'REJECTED') && (
                      <button type="button" className={btnPrimary} onClick={() => setDialog({ kind: 'approve', user: u })}>Aprovar</button>
                    )}
                    {u.accessStatus === 'PENDING_APPROVAL' && (
                      <button type="button" className={btnDanger} onClick={() => setDialog({ kind: 'reject', user: u })}>Rejeitar</button>
                    )}
                    {u.accessStatus === 'ACTIVE' && (
                      <>
                        <button type="button" className={btnGhost} onClick={() => setDialog({ kind: 'company', user: u })}>Alterar empresa</button>
                        <select aria-label={`Papel de ${u.name}`} value={u.workspaceRole || 'MEMBER'} disabled={busy}
                          onChange={(e) => void run(() => api.adminChangeUserRole(u.id, e.target.value as 'OWNER' | 'MEMBER'))}
                          className={`${btn} bg-[#161616] text-white border-[#2A2A2A]`}>
                          <option value="MEMBER">Membro</option>
                          <option value="OWNER">Proprietário</option>
                        </select>
                        <button type="button" className={btnGhost} disabled={busy} onClick={() => void run(() => api.adminRemoveUserCompany(u.id))}>Remover vínculo</button>
                        <button type="button" className={btnDanger} onClick={() => setDialog({ kind: 'suspend', user: u })}>Suspender</button>
                      </>
                    )}
                    {u.accessStatus === 'SUSPENDED' && (
                      <button type="button" className={btnPrimary} disabled={busy} onClick={() => void run(() => api.adminReactivateUser(u.id))}>Reativar</button>
                    )}
                    <button type="button" className={btnDanger} onClick={() => setDialog({ kind: 'delete', user: u })}>Excluir</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'instagram' && (
        <section aria-label="Contas Instagram" className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-[#6B6B70]">{stamp(instagram.state)}</p>
            <button type="button" className={btnGhost} onClick={() => void instagram.reload()}>Atualizar</button>
          </div>
          {instagram.state.phase === 'loading' && !instagram.state.data && <p className="text-sm text-[#8E8E93] py-8 text-center">Carregando contas…</p>}
          {instagram.state.phase === 'error' && (
            <div role="alert" className="p-4 rounded-lg border border-[#EF4444]/40 bg-red-950/20 text-sm text-[#EF4444] flex items-center justify-between gap-3">
              <span>{instagram.state.error}</span>
              <button type="button" className={btnGhost} onClick={() => void instagram.reload()}>Tentar de novo</button>
            </div>
          )}
          {instagram.state.data && instagram.state.data.accounts.length === 0 && <p className="text-sm text-[#8E8E93] py-8 text-center">Nenhuma conta do Instagram registrada.</p>}
          <ul className="space-y-2">
            {(instagram.state.data?.accounts || []).map((a) => (
              <li key={a.id} className="bg-[#121212] border border-[#242424] rounded-xl p-4 flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-6">
                <div className="min-w-0 lg:w-[26%]">
                  <p className="text-sm font-semibold text-white truncate">{a.username ? `@${a.username}` : 'Instagram não conectado'}</p>
                  <p className="text-[11px] text-[#6B6B70] truncate">{a.instagramUserId ? `ID ${a.instagramUserId}` : 'Espaço da empresa aguardando conexão'}</p>
                </div>
                <div className="flex flex-wrap gap-1.5 lg:w-[22%]">
                  <Pill className={a.placeholder ? 'bg-[#8E8E93]/10 text-[#C8C8CC] border-[#8E8E93]/30' : a.needsReconnect ? 'bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/30' : 'bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30'}>
                    {a.placeholder ? 'Sem conexão' : a.needsReconnect ? 'Reconexão necessária' : 'Token válido'}
                  </Pill>
                  <Pill className="bg-[#161616] text-[#C8C8CC] border-[#2A2A2A]">Autorização: {a.authorizationStatus}</Pill>
                </div>
                <div className="text-xs text-[#C8C8CC] lg:w-[24%] min-w-0">
                  <p className="truncate">Empresa: <strong className="text-white">{a.companyName || 'sem empresa'}</strong></p>
                  <p className="truncate">Conectado por: {a.connectedBy ? a.connectedBy.name || a.connectedBy.email : '—'}</p>
                </div>
                <div className="flex flex-wrap gap-1.5 lg:ml-auto lg:justify-end">
                  {!a.companyId && !a.placeholder && <button type="button" className={btnPrimary} onClick={() => setDialog({ kind: 'link-ig', account: a })}>Vincular à empresa</button>}
                  <button type="button" className={btnGhost} onClick={async () => {
                    try {
                      const r = await api.getInstagramAuthUrl(window.location.origin, a.id);
                      if (r?.url && !window.open(r.url, 'InstagramReconnectAuth', 'width=600,height=700,left=200,top=100')) window.location.href = r.url;
                    } catch (err: any) {
                      setNotice({ ok: false, text: err?.message || 'Não foi possível iniciar a reconexão.' });
                    }
                  }}>{a.placeholder ? 'Conectar' : 'Reconectar'}</button>
                  {!a.placeholder && <button type="button" className={btnDanger} onClick={() => setDialog({ kind: 'disconnect-ig', account: a })}>Desconectar</button>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialog && (dialog.kind === 'approve' || dialog.kind === 'company') && (
        <CompanyDialog mode={dialog.kind} user={dialog.user} companies={companies} busy={busy} onClose={() => setDialog(null)}
          onSubmit={(p) =>
            run(() =>
              dialog.kind === 'approve'
                ? api.adminApproveUser(dialog.user.id, p)
                : api.adminChangeUserCompany(dialog.user.id, p.companyId || '', p.role)
            )
          } />
      )}
      {dialog && (dialog.kind === 'reject' || dialog.kind === 'suspend') && (
        <ReasonDialog title={dialog.kind === 'reject' ? `Rejeitar ${dialog.user.name}?` : `Suspender ${dialog.user.name}?`} confirmLabel={dialog.kind === 'reject' ? 'Rejeitar' : 'Suspender'}
          note={dialog.kind === 'suspend' ? 'As sessões abertas são encerradas na hora. Empresa, posts e Instagram permanecem.' : 'O cadastro fica sem acesso a qualquer empresa.'}
          busy={busy} onClose={() => setDialog(null)}
          onSubmit={(reason) => run(() => (dialog.kind === 'reject' ? api.adminRejectUser(dialog.user.id, reason) : api.adminSuspendUser(dialog.user.id, reason)))} />
      )}
      {dialog && dialog.kind === 'delete' && (
        <DeleteDialog user={dialog.user} busy={busy} onClose={() => setDialog(null)} onSubmit={(email) => run(() => api.adminDeleteUser(dialog.user.id, email))} />
      )}
      {dialog && dialog.kind === 'link-ig' && (
        <Modal title={`Vincular ${dialog.account.username ? '@' + dialog.account.username : 'conta'} a uma empresa`} onClose={() => setDialog(null)}>
          <LinkIg companies={companies} busy={busy} onSubmit={(companyId) => run(() => api.adminLinkInstagram(dialog.account.id, companyId))} />
        </Modal>
      )}
      {dialog && dialog.kind === 'disconnect-ig' && (
        <Modal title={`Desconectar ${dialog.account.username ? '@' + dialog.account.username : 'conta'}?`} onClose={() => setDialog(null)}>
          <p className="text-sm text-[#C8C8CC] mb-4">Revoga a autorização guardada no Social Hub. Nenhum usuário é alterado e a conta no Instagram não é afetada. Agendamentos dessa conta ficam aguardando reconexão.</p>
          <div className="flex justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => setDialog(null)}>Cancelar</button>
            <button type="button" className={btnDanger} disabled={busy} onClick={() => void run(() => api.adminDisconnectInstagram(dialog.account.id))}>Desconectar</button>
          </div>
        </Modal>
      )}
    </div>
  );
};

const CompanyDialog: React.FC<{
  mode: 'approve' | 'company';
  user: AdminUserRow;
  companies: AdminCompanyRow[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (p: { companyId?: string; newCompanyName?: string; role: 'OWNER' | 'MEMBER' }) => void;
}> = ({ mode, user, companies, busy, onClose, onSubmit }) => {
  const [choice, setChoice] = useState<string>(mode === 'company' && user.companyId ? user.companyId : companies[0]?.id || '__new__');
  const [newName, setNewName] = useState('');
  const [role, setRole] = useState<'OWNER' | 'MEMBER'>(user.workspaceRole || 'MEMBER');
  const creating = choice === '__new__';
  const valid = creating ? newName.trim().length >= 2 : Boolean(choice);
  return (
    <Modal title={mode === 'approve' ? `Aprovar ${user.name}` : `Alterar empresa de ${user.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="co-select">Empresa</label>
          <select id="co-select" className={field} value={choice} onChange={(e) => setChoice(e.target.value)}>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.instagramConnected ? ' · Instagram conectado' : ''}</option>
            ))}
            {mode === 'approve' && <option value="__new__">+ Criar nova empresa…</option>}
          </select>
        </div>
        {creating && (
          <div>
            <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="co-new">Nome da nova empresa</label>
            <input id="co-new" className={field} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} placeholder="Ex.: Padaria Central" />
          </div>
        )}
        <div>
          <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="co-role">Papel na empresa</label>
          <select id="co-role" className={field} value={role} onChange={(e) => setRole(e.target.value as 'OWNER' | 'MEMBER')}>
            <option value="MEMBER">Membro</option>
            <option value="OWNER">Proprietário (não é administrador global)</option>
          </select>
        </div>
        <p className="text-[11px] text-[#6B6B70]">
          {mode === 'company'
            ? 'O acesso à empresa anterior termina na próxima requisição do usuário. Nada é apagado.'
            : 'O usuário passa a ver os conteúdos permitidos ao papel, sem precisar conectar o Instagram pessoal. A conta da empresa não é alterada.'}
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
          <button type="button" className={btnPrimary} disabled={busy || !valid}
            onClick={() => onSubmit(creating ? { newCompanyName: newName.trim(), role } : { companyId: choice, role })}>
            {busy ? 'Salvando…' : mode === 'approve' ? 'Aprovar e vincular' : 'Alterar empresa'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

const ReasonDialog: React.FC<{ title: string; confirmLabel: string; note: string; busy: boolean; onClose: () => void; onSubmit: (reason?: string) => void }> = ({ title, confirmLabel, note, busy, onClose, onSubmit }) => {
  const [reason, setReason] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-[#C8C8CC] mb-3">{note}</p>
      <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="reason">Motivo (opcional, fica na auditoria)</label>
      <input id="reason" className={field} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      <div className="flex justify-end gap-2 pt-4">
        <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
        <button type="button" className={btnDanger} disabled={busy} onClick={() => onSubmit(reason.trim() || undefined)}>{confirmLabel}</button>
      </div>
    </Modal>
  );
};

const DeleteDialog: React.FC<{ user: AdminUserRow; busy: boolean; onClose: () => void; onSubmit: (email: string) => void }> = ({ user, busy, onClose, onSubmit }) => {
  const [typed, setTyped] = useState('');
  const ok = typed.trim().toLowerCase() === user.email.toLowerCase();
  return (
    <Modal title={`Excluir ${user.name}?`} onClose={onClose}>
      <p className="text-sm text-[#C8C8CC] mb-2">Remove o usuário, o vínculo e as sessões. <strong className="text-white">Empresa, posts, agendamentos e contas do Instagram são preservados</strong>, e a exclusão fica registrada na auditoria.</p>
      <label className="block text-xs text-[#8E8E93] mb-1.5" htmlFor="del-email">Digite <span className="font-mono text-white">{user.email}</span> para confirmar</label>
      <input id="del-email" className={field} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      <div className="flex justify-end gap-2 pt-4">
        <button type="button" className={btnGhost} onClick={onClose}>Cancelar</button>
        <button type="button" className={btnDanger} disabled={busy || !ok} onClick={() => onSubmit(typed.trim())}>Excluir usuário</button>
      </div>
    </Modal>
  );
};

const LinkIg: React.FC<{ companies: AdminCompanyRow[]; busy: boolean; onSubmit: (companyId: string) => void }> = ({ companies, busy, onSubmit }) => {
  const [companyId, setCompanyId] = useState(companies[0]?.id || '');
  return (
    <div className="space-y-3">
      <select aria-label="Empresa" className={field} value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <p className="text-[11px] text-[#6B6B70]">Só contas sem empresa podem ser vinculadas aqui. Uma conta já vinculada a outra empresa não é movida.</p>
      <div className="flex justify-end">
        <button type="button" className={btnPrimary} disabled={busy || !companyId} onClick={() => onSubmit(companyId)}>Vincular</button>
      </div>
    </div>
  );
};
