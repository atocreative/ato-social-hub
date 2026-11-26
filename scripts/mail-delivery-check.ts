/**
 * Teste REAL de entrega de e-mail (Resend) com os modelos de produção:
 * confirmação de cadastro, recuperação de senha e convite.
 *
 * Uso (PowerShell):
 *   $env:RESEND_API_KEY = "re_..."; $env:MAIL_FROM = "ATO Social Hub <nao-responda@SEU-DOMINIO>"
 *   $env:APP_URL = "https://socialhub.atodev.com.br"
 *   npx tsx scripts/mail-delivery-check.ts --to sua-caixa-real@exemplo.com
 *
 * Garantias:
 *  - Não usa banco de dados e não cria conta, token válido nem convite: os links levam um código descartável
 *    que não existe no sistema (abrir o link só mostra "link inválido").
 *  - Nunca imprime a chave de API nem os links.
 *  - "Aceito pela API" NÃO conta como entrega. O script consulta o evento de entrega do Resend e, no fim,
 *    lembra que a conferência final é humana: abrir a caixa de entrada.
 */
import crypto from 'node:crypto';
import { appBaseUrl, getMailDeliveryEvent, mailTemplates, sendMail, type MailMessage } from '../src/services/mailer.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const to = String(arg('--to') || '').trim().toLowerCase();
const problems: string[] = [];
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) problems.push('informe a caixa real com --to seu@email.com');
if (!process.env.RESEND_API_KEY) problems.push('defina RESEND_API_KEY');
if (!process.env.MAIL_FROM || !/<[^>]+@[^>]+>|^[^\s@]+@[^\s@]+$/.test(process.env.MAIL_FROM)) problems.push('defina MAIL_FROM (ex.: "ATO Social Hub <nao-responda@seu-dominio>")');
if (!appBaseUrl().startsWith('https://')) problems.push('defina APP_URL com https:// (é o endereço que vai nos links)');
if (process.env.MAIL_PROVIDER === 'console') problems.push('MAIL_PROVIDER=console não envia e-mail de verdade; remova-o');
if (problems.length) {
  console.error('Não foi possível iniciar o teste:\n - ' + problems.join('\n - '));
  process.exit(2);
}

const descartavel = () => `ENTREGA-TESTE-${crypto.randomBytes(12).toString('base64url')}`;
const casos: Array<{ nome: string; msg: MailMessage }> = [
  { nome: 'Confirmação de cadastro', msg: mailTemplates.verifyEmail(to, 'Teste de Entrega', descartavel()) },
  { nome: 'Recuperação de senha', msg: mailTemplates.resetPassword(to, descartavel()) },
  { nome: 'Convite de usuário', msg: mailTemplates.invite(to, 'Empresa de Teste', descartavel()) },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FINAIS = new Set(['delivered', 'bounced', 'complained', 'failed', 'suppressed']);

async function main() {
  const envios: Array<{ nome: string; id?: string; erro?: string; evento?: string | null }> = [];
  for (const c of casos) {
    try {
      const r = await sendMail(c.msg);
      envios.push({ nome: c.nome, id: r.id });
    } catch (e: any) {
      envios.push({ nome: c.nome, erro: String(e?.message || 'erro') });
    }
  }

  const limite = Date.now() + 90_000;
  while (Date.now() < limite && envios.some((e) => e.id && !FINAIS.has(String(e.evento)))) {
    await sleep(5000);
    for (const e of envios) {
      if (e.id && !FINAIS.has(String(e.evento))) e.evento = await getMailDeliveryEvent(e.id);
    }
  }

  console.log(`\nResultado para ${to.replace(/^(.).*(@.*)$/, '$1***$2')}:`);
  for (const e of envios) {
    const estado = e.erro ? `ERRO — ${e.erro}` : `${e.evento || 'sem evento ainda'}${e.id ? ` (id ${e.id})` : ''}`;
    console.log(` - ${e.nome}: ${estado}`);
  }
  const todosEntregues = envios.every((e) => e.evento === 'delivered');
  console.log(
    todosEntregues
      ? '\nO provedor confirma a entrega dos 3 e-mails.'
      : '\nA entrega NÃO está confirmada para todos. Verifique o domínio no painel do Resend (SPF/DKIM = Verified) e o remetente.'
  );
  console.log(
    [
      '\nConferência humana obrigatória (a validação só termina aqui):',
      ' 1. Os 3 e-mails estão na CAIXA DE ENTRADA, não em spam/promoções?',
      ' 2. O remetente aparece como o esperado e o botão aponta para o domínio do app?',
      ' 3. Em "Mostrar original" (Gmail), SPF, DKIM e DMARC aparecem como PASS?',
      ' 4. Repita com uma segunda caixa de outro provedor (ex.: Outlook) para comparar.',
    ].join('\n')
  );
  process.exit(todosEntregues ? 0 : 1);
}

main().catch(() => {
  console.error('Falha inesperada no teste de entrega (detalhes omitidos para não expor dados).');
  process.exit(1);
});
