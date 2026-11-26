import { Router, type Request, type Response, type NextFunction } from 'express';
import type { UserProfile } from '../types/index.ts';
import {
  AccountError,
  acceptInvite,
  createInvite,
  createWorkspace,
  getUserProfile,
  previewInvite,
  requestPasswordReset,
  requestSignup,
  resetPassword,
  verifyEmailAndCreateUser,
} from '../services/accounts.ts';
import { allowAttempt, hashForBucket } from '../services/authTokens.ts';
import { MailNotConfiguredError, mailConfigured } from '../services/mailer.ts';

export interface AccountRouterDeps {
  requireAuth: (req: any, res: Response, next: NextFunction) => any;
  /** Emite a sessão (JWT) a partir do perfil atual e atualiza o estado em memória do servidor. */
  /** Chamado após redefinir a senha, para encerrar as sessões antigas deste processo na hora. */
  onSessionsRevoked?: (userId: string) => void;
  issueSession: (userId: string) => Promise<{ token: string; user: UserProfile; tenant?: unknown } | null>;
}

const ip = (req: Request) => String(req.ip || 'unknown');

async function limit(res: Response, bucket: string, max: number, windowSec: number): Promise<boolean> {
  if (await allowAttempt(bucket, max, windowSec)) return true;
  res.setHeader('Retry-After', String(windowSec));
  res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.', code: 'RATE_LIMITED' });
  return false;
}

function fail(res: Response, err: unknown) {
  if (err instanceof AccountError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof MailNotConfiguredError) {
    console.error('[Conta] Envio de e-mail não configurado.');
    return res.status(503).json({ error: 'O envio de e-mails está indisponível no momento. Tente novamente mais tarde.', code: 'MAIL_UNAVAILABLE' });
  }
  console.error('[Conta] Erro inesperado:', (err as any)?.message || 'desconhecido');
  return res.status(500).json({ error: 'Não foi possível concluir a operação. Tente novamente.', code: 'INTERNAL' });
}

// Mensagem única, igual exista ou não conta com o e-mail (sem enumeração).
const SIGNUP_ACCEPTED = 'Enviamos um e-mail de confirmação. Abra a mensagem e clique no link para ativar sua conta.';
const RESET_ACCEPTED = 'Se existir uma conta com este e-mail, enviaremos as instruções para criar uma nova senha.';

export function createAccountRouter(deps: AccountRouterDeps): Router {
  const r = Router();

  const signup = async (req: Request, res: Response) => {
    try {
      if (!mailConfigured()) throw new MailNotConfiguredError();
      const email = String(req.body?.email ?? '');
      if (!(await limit(res, `signup:ip:${ip(req)}`, 10, 3600))) return;
      if (!(await limit(res, `signup:email:${hashForBucket(email)}`, 3, 3600))) return;
      await requestSignup(req.body || {});
      return res.status(202).json({ success: true, message: SIGNUP_ACCEPTED });
    } catch (err) {
      return fail(res, err);
    }
  };
  r.post('/auth/signup', signup);
  r.post('/auth/register', signup); // caminho antigo agora usa o mesmo fluxo seguro (sem sessão imediata)

  r.post('/auth/verify-email', async (req: Request, res: Response) => {
    try {
      if (!(await limit(res, `verify:ip:${ip(req)}`, 30, 900))) return;
      const { userId } = await verifyEmailAndCreateUser(String(req.body?.token ?? ''));
      const session = await deps.issueSession(userId);
      if (!session) throw new AccountError(500, 'INTERNAL', 'Não foi possível iniciar a sessão.');
      return res.json({ success: true, ...session });
    } catch (err) {
      return fail(res, err);
    }
  });

  r.post('/auth/forgot-password', async (req: Request, res: Response) => {
    try {
      if (!mailConfigured()) throw new MailNotConfiguredError();
      const email = String(req.body?.email ?? '');
      if (!(await limit(res, `forgot:ip:${ip(req)}`, 10, 3600))) return;
      if (!(await limit(res, `forgot:email:${hashForBucket(email)}`, 3, 3600))) return;
      await requestPasswordReset(email);
      return res.status(202).json({ success: true, message: RESET_ACCEPTED });
    } catch (err) {
      return fail(res, err);
    }
  });

  r.post('/auth/reset-password', async (req: Request, res: Response) => {
    try {
      if (!(await limit(res, `reset:ip:${ip(req)}`, 20, 900))) return;
      const { userId } = await resetPassword(String(req.body?.token ?? ''), req.body?.password);
      deps.onSessionsRevoked?.(userId);
      return res.json({ success: true, message: 'Senha atualizada. Entre com a nova senha.' });
    } catch (err) {
      return fail(res, err);
    }
  });

  // Espaço de trabalho: o proprietário é sempre o usuário autenticado; nada vem do corpo da requisição além dos nomes.
  r.post('/workspaces', deps.requireAuth, async (req: any, res: Response) => {
    try {
      await createWorkspace(String(req.user.id), { companyName: req.body?.companyName, workspaceName: req.body?.workspaceName });
      const session = await deps.issueSession(String(req.user.id));
      if (!session) throw new AccountError(500, 'INTERNAL', 'Não foi possível atualizar a sessão.');
      return res.status(201).json({ success: true, ...session });
    } catch (err) {
      return fail(res, err);
    }
  });

  r.post('/invites', deps.requireAuth, async (req: any, res: Response) => {
    try {
      if (!mailConfigured()) throw new MailNotConfiguredError();
      if (!(await limit(res, `invite:user:${req.user.id}`, 20, 3600))) return;
      await createInvite({ id: String(req.user.id), role: req.user.role }, { email: req.body?.email, companyId: req.body?.companyId });
      return res.status(202).json({ success: true, message: 'Convite enviado.' });
    } catch (err) {
      return fail(res, err);
    }
  });

  r.get('/invites/:token', async (req: Request, res: Response) => {
    try {
      if (!(await limit(res, `invite-view:ip:${ip(req)}`, 60, 900))) return;
      const info = await previewInvite(String(req.params.token || ''));
      if (!info) return res.status(404).json({ error: 'Este convite é inválido, expirou ou já foi usado.', code: 'INVALID_TOKEN' });
      return res.json(info);
    } catch (err) {
      return fail(res, err);
    }
  });

  // Aceitar convite: usuário novo informa nome e senha; conta existente precisa estar autenticada com o e-mail convidado.
  r.post('/invites/accept', async (req: any, res: Response, next: NextFunction) => {
    const hasBearer = String(req.headers.authorization || '').startsWith('Bearer ');
    const proceed = async () => {
      try {
        if (!(await limit(res, `invite-accept:ip:${ip(req)}`, 20, 900))) return;
        const { userId } = await acceptInvite({
          token: String(req.body?.token ?? ''),
          name: req.body?.name,
          password: req.body?.password,
          acceptTerms: req.body?.acceptTerms,
          sessionUserId: req.user?.id ?? null,
        });
        const session = await deps.issueSession(userId);
        if (!session) throw new AccountError(500, 'INTERNAL', 'Não foi possível iniciar a sessão.');
        return res.json({ success: true, ...session });
      } catch (err) {
        return fail(res, err);
      }
    };
    if (hasBearer) return deps.requireAuth(req, res, () => void proceed());
    return void proceed();
  });

  r.get('/auth/profile', deps.requireAuth, async (req: any, res: Response) => {
    const p = await getUserProfile(String(req.user.id));
    if (!p) return res.status(404).json({ error: 'Usuário não encontrado.' });
    return res.json(p);
  });

  return r;
}
