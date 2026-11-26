import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appBaseUrl, getMailDeliveryEvent, mailConfigured, mailTemplates, sendMail, sendMailBackground, setMailTransportForTests } from './mailer.ts';

const KEY = 're_chave_ficticia_nao_pode_aparecer_em_log_123456';
const FROM = 'ATO Social Hub <nao-responda@exemplo.test>';
const msg = { to: 'pessoa@exemplo.test', subject: 'Assunto', text: 'texto', html: '<p>html</p>' };

describe('Resend (contrato HTTP, sem rede)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    setMailTransportForTests(null);
    process.env.RESEND_API_KEY = KEY;
    process.env.MAIL_FROM = FROM;
    process.env.APP_URL = 'https://hub.exemplo.test/';
    delete process.env.MAIL_PROVIDER;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('envia para a API do Resend com a chave só no cabeçalho e devolve o id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await sendMail(msg);
    expect(r.id).toBe('msg_123');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: FROM, to: ['pessoa@exemplo.test'], subject: 'Assunto' });
    expect(JSON.stringify(body)).not.toContain(KEY); // a chave nunca vai no corpo
    expect(init.signal).toBeDefined(); // com tempo limite
  });

  it('erro do provedor: só o status na mensagem, sem chave, destinatário nem corpo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'domain not verified for pessoa@exemplo.test' }), { status: 403 })));
    const err = await sendMail(msg).catch((e) => e);
    expect(String(err.message)).toBe('Falha no provedor de e-mail (HTTP 403).');
    expect(String(err.message)).not.toContain(KEY);
    expect(String(err.message)).not.toContain('pessoa@');
  });

  it('falha de rede e tempo esgotado também não vazam dados', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error(`connect ECONNREFUSED Bearer ${KEY}`), { name: 'TypeError' }); }));
    const net = await sendMail(msg).catch((e) => e);
    expect(String(net.message)).toBe('Falha no provedor de e-mail (rede).');
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }));
    const to = await sendMail(msg).catch((e) => e);
    expect(String(to.message)).toBe('Falha no provedor de e-mail (tempo esgotado).');
  });

  it('envio em segundo plano registra só a causa e nunca lança', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 422 })));
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => void lines.push(a.join(' ')));
    sendMailBackground(msg);
    await new Promise((r) => setTimeout(r, 20));
    expect(lines.join('\n')).toContain('HTTP 422');
    expect(lines.join('\n')).not.toContain(KEY);
    expect(lines.join('\n')).not.toContain('pessoa@');
  });

  it('consulta de entrega usa o id e devolve o último evento', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ last_event: 'delivered' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getMailDeliveryEvent('msg_123')).toBe('delivered');
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.resend.com/emails/msg_123');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    expect(await getMailDeliveryEvent('msg_x')).toBeNull();
  });

  it('configuração: sem chave ou remetente não está configurado; console nunca vale em produção', async () => {
    expect(mailConfigured()).toBe(true);
    delete process.env.MAIL_FROM;
    expect(mailConfigured()).toBe(false);
    await expect(sendMail(msg)).rejects.toThrow(/não está configurado/);
    delete process.env.RESEND_API_KEY;
    process.env.MAIL_PROVIDER = 'console';
    process.env.NODE_ENV = 'production';
    expect(mailConfigured()).toBe(false);
  });

  it('os modelos apontam para o domínio do app e escapam o conteúdo vindo do usuário', () => {
    expect(appBaseUrl()).toBe('https://hub.exemplo.test');
    const v = mailTemplates.verifyEmail('a@exemplo.test', '<script>alert(1)</script>', 'tok-1');
    expect(v.text).toContain('https://hub.exemplo.test/verificar-email?code=tok-1');
    expect(v.html).not.toContain('<script>');
    expect(mailTemplates.resetPassword('a@exemplo.test', 'tok-2').text).toContain('https://hub.exemplo.test/redefinir-senha?code=tok-2');
    const i = mailTemplates.invite('a@exemplo.test', 'Empresa "X" <b>', 'tok-3');
    expect(i.text).toContain('https://hub.exemplo.test/convite?code=tok-3');
    expect(i.html).not.toContain('<b>');
  });
});
