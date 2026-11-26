// Envio de e-mails transacionais. Provedor: Resend (API HTTPS, sem dependência nova).
// Variáveis: RESEND_API_KEY, MAIL_FROM (ex.: "ATO Social Hub <nao-responda@atodev.com.br>"), APP_URL.
// Em desenvolvimento, MAIL_PROVIDER=console imprime o link no terminal (NUNCA em produção).
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export type MailTransport = (msg: MailMessage) => Promise<void>;

export class MailNotConfiguredError extends Error {
  constructor() {
    super('O envio de e-mails não está configurado.');
    this.name = 'MailNotConfiguredError';
  }
}

let testTransport: MailTransport | null = null;
export function setMailTransportForTests(t: MailTransport | null) {
  testTransport = t;
}

export function mailConfigured(): boolean {
  if (testTransport) return true;
  if (process.env.MAIL_PROVIDER === 'console' && process.env.NODE_ENV !== 'production') return true;
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

export function appBaseUrl(): string {
  return String(process.env.APP_URL || process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
}

export async function sendMail(msg: MailMessage): Promise<void> {
  if (testTransport) return testTransport(msg);
  if (process.env.MAIL_PROVIDER === 'console' && process.env.NODE_ENV !== 'production') {
    console.log(`[Mail:console] Para ${msg.to} — ${msg.subject}\n${msg.text}`);
    return;
  }
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) throw new MailNotConfiguredError();
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
  });
  if (!res.ok) {
    // Nunca registra corpo, destinatário nem chave: só o status.
    throw new Error(`Falha no provedor de e-mail (HTTP ${res.status}).`);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function layout(title: string, intro: string, cta: { label: string; url: string } | null, outro: string): { text: string; html: string } {
  const text = [title, '', intro, cta ? `\n${cta.label}: ${cta.url}\n` : '', outro, '', 'ATO Social Hub'].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
<h2 style="margin:0 0 12px">${esc(title)}</h2>
<p style="line-height:1.5">${esc(intro)}</p>
${cta ? `<p style="margin:24px 0"><a href="${esc(cta.url)}" style="background:#10B981;color:#0A0A0A;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${esc(cta.label)}</a></p><p style="font-size:12px;color:#555;word-break:break-all">Se o botão não funcionar, copie este endereço: ${esc(cta.url)}</p>` : ''}
<p style="line-height:1.5;color:#444;font-size:13px">${esc(outro)}</p>
<p style="color:#888;font-size:12px">ATO Social Hub</p></div>`;
  return { text, html };
}

export const mailTemplates = {
  verifyEmail(to: string, name: string, token: string): MailMessage {
    const url = `${appBaseUrl()}/verificar-email?code=${encodeURIComponent(token)}`;
    const body = layout(
      'Confirme seu e-mail',
      `Olá, ${name}. Para concluir seu cadastro no ATO Social Hub, confirme que este e-mail é seu. O link vale por 24 horas e só pode ser usado uma vez.`,
      { label: 'Confirmar meu e-mail', url },
      'Se você não criou uma conta, ignore esta mensagem: nada será criado.'
    );
    return { to, subject: 'Confirme seu e-mail no ATO Social Hub', ...body };
  },
  alreadyRegistered(to: string): MailMessage {
    const url = `${appBaseUrl()}/`;
    const body = layout(
      'Você já tem uma conta',
      'Alguém tentou criar uma conta no ATO Social Hub com este e-mail, mas ele já está cadastrado. Entre com a sua senha ou, se não lembra dela, use "Esqueci minha senha" na tela de acesso.',
      { label: 'Ir para o ATO Social Hub', url },
      'Se não foi você, nenhuma ação é necessária.'
    );
    return { to, subject: 'Você já tem uma conta no ATO Social Hub', ...body };
  },
  resetPassword(to: string, token: string): MailMessage {
    const url = `${appBaseUrl()}/redefinir-senha?code=${encodeURIComponent(token)}`;
    const body = layout(
      'Redefinir senha',
      'Recebemos um pedido para redefinir a senha da sua conta. O link vale por 1 hora e só pode ser usado uma vez. Ao redefinir, todas as sessões abertas serão encerradas.',
      { label: 'Criar nova senha', url },
      'Se não foi você, ignore esta mensagem: a sua senha continua a mesma.'
    );
    return { to, subject: 'Redefinição de senha do ATO Social Hub', ...body };
  },
  invite(to: string, companyName: string, token: string): MailMessage {
    const url = `${appBaseUrl()}/convite?code=${encodeURIComponent(token)}`;
    const body = layout(
      'Você recebeu um convite',
      `Você foi convidado para acessar o espaço de trabalho "${companyName}" no ATO Social Hub. O convite vale por 7 dias e só pode ser usado uma vez.`,
      { label: 'Aceitar convite', url },
      'Se você não esperava este convite, ignore a mensagem.'
    );
    return { to, subject: `Convite para ${companyName} no ATO Social Hub`, ...body };
  },
};
