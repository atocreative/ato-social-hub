/**
 * ATO Social Hub — Google Apps Script (Code.gs) — SCRIPT COMPLETO
 *
 * Cobre todas as ações que o Social Hub envia para GOOGLE_APPS_SCRIPT_URL:
 *   PING                       teste de conexão (Admin > Integrações)
 *   LISTAR_PASTAS_CLIENTES     lista empresas e seus lotes
 *   SINCRONIZAR_TUDO           mesma resposta, usada pelo botão "Sincronizar Drive"
 *   UPLOAD_MIDIA               cliente envia arquivo (base64) para a pasta da empresa
 *   MOVER_LIXEIRA              exclui criativo (vai para a lixeira do Drive)
 *   SALVAR_OBSERVACOES_CLIENTE grava _OBSERVACOES_CLIENTE.md na pasta da empresa
 *   REPROVAR_E_MOVER           reprova conteúdo (renomeia e move para Reprovados)
 *   SOLICITAR_AJUSTE           ajuste pontual (não move arquivos)
 *   REGISTRAR_APROVACAO        aprovação com feedback positivo (não move arquivos)
 *
 * CONFIGURAÇÃO (Configurações do projeto > Propriedades do script):
 *   WEBHOOK_SECRET_TOKEN  obrigatório. Token que o Social Hub envia em todas as chamadas.
 *   ATO_ROOT_FOLDER_ID    opcional. ID da pasta "ATO Social Midia". Se não existir, o script
 *                         procura uma pasta com esse nome no Drive.
 *
 * Implantação: Implantar > Gerenciar implantações > Nova versão. "Quem pode acessar": Qualquer pessoa.
 */

// ==========================================
// CONFIGURAÇÕES
// ==========================================
const ATO_ROOT_FOLDER_NAME = 'ATO Social Midia';
const NOME_PASTA_REPROVADOS = 'Reprovados';
const NOME_PASTA_UPLOADS = 'Uploads';
const PASTAS_RESERVADAS = ['reprovados', 'aprovados', 'publicados'];
const REGEX_VIDEO = /\.(mp4|mov|webm|m4v)$/i;
const REGEX_PASTA_VIDEO = /v[ií]deo/i;

const FB_CONFIG = {
  ARQUIVO_MEMORIA: '_MEMORIA_REPROVACOES.md',
  ARQUIVO_APROVACOES: '_APROVACOES_POSITIVAS.md',
  MAX_ARQUIVOS: 60,
  LOCK_MS: 25000,
  PROP_PREFIX: 'fb_result_',
  PROFUNDIDADE_MAX: 8,
  MAX_UPLOAD_BYTES: 50 * 1024 * 1024,
};

// Ação de feedback -> estado editorial registrado
const FB_ESTADOS = {
  REPROVAR_E_MOVER: 'REPROVADO',       // conteúdo inadequado: registra aprendizado e move para Reprovados
  SOLICITAR_AJUSTE: 'AJUSTE',          // ideia boa, uma parte precisa de correção: não move
  REGISTRAR_APROVACAO: 'APROVADO',     // aceito: registra o que funcionou, não move
};

const FB_CABECALHO_MEMORIA =
  '# Memória de reprovações e ajustes\n' +
  'Registros estruturados (um bloco JSON por feedback). Cada bloco tem `feedbackId` único.\n' +
  'Nenhuma regra permanente é criada automaticamente: o Guia Criativo é consolidado manualmente.\n\n---\n\n';

const FB_CABECALHO_APROVACOES =
  '# Aprovações positivas\n' +
  'Registros do que funcionou visualmente e editorialmente. Use como referência de acerto.\n\n---\n\n';

// ==========================================
// ENTRADA (WEBHOOK)
// ==========================================
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const acao = String(body.acao || body.action || '');

    // Teste de conexão do painel: não expõe dados, só confirma que o script responde.
    if (acao === 'PING' || body.action === 'PING') {
      return jsonOut_({ sucesso: true, status: 'OK', pong: true, timestamp: new Date().toISOString() });
    }

    const tokenEsperado = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET_TOKEN');
    if (!tokenEsperado || body.token !== tokenEsperado) {
      return jsonOut_({ sucesso: false, erro: 'Não autorizado' });
    }

    // Feedback editorial (reprovar, ajustar, aprovar)
    const feedback = handleFeedbackAction_(body);
    if (feedback) return jsonOut_(feedback);

    switch (acao) {
      case 'LISTAR_PASTAS_CLIENTES':
      case 'SINCRONIZAR_TUDO':
        return jsonOut_(sincronizarTudo_());
      case 'UPLOAD_MIDIA':
        return jsonOut_(uploadMidia_(body));
      case 'MOVER_LIXEIRA':
        return jsonOut_(moverParaLixeira_(body));
      case 'SALVAR_OBSERVACOES_CLIENTE':
        return jsonOut_(salvarObservacoesCliente_(body));
      default:
        // O servidor reconhece "Ação desconhecida" para cair no fallback de listagem.
        return jsonOut_({ sucesso: false, erro: 'Ação desconhecida: ' + acao });
    }
  } catch (err) {
    return jsonOut_({ sucesso: false, erro: String(err && err.message ? err.message : err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// TESTES MANUAIS (pelo editor: selecione a função e clique em ▶)
// Não rode as funções auxiliares (encontrarPastaRaizDoCliente, obterOuCriar...) direto:
// elas precisam de argumentos e vão falhar com "reading 'getParents'" / "reading 'getFoldersByName'".
// Estes testes são somente leitura.
// ==========================================

function testarConexao() {
  const resp = doPost({ postData: { contents: JSON.stringify({ acao: 'PING' }) } });
  Logger.log(resp.getContent());
}

function testarSincronizacao() {
  const r = sincronizarTudo_();
  Logger.log('sucesso=' + r.sucesso + ' pastas=' + (r.pastas ? r.pastas.length : 0) + ' lotes=' + (r.lotes ? r.lotes.length : 0));
  if (r.erro) Logger.log('erro=' + r.erro);
}

// ==========================================
// PASTAS E LOTES (SINCRONIZAR_TUDO / LISTAR_PASTAS_CLIENTES)
// ==========================================

function obterPastaRaiz_() {
  const id = PropertiesService.getScriptProperties().getProperty('ATO_ROOT_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const pastas = DriveApp.getFoldersByName(ATO_ROOT_FOLDER_NAME);
  return pastas.hasNext() ? pastas.next() : null;
}

/**
 * Lista empresas (pastas filhas da raiz) e monta os lotes de cada uma.
 * Estrutura: [Empresa] -> [Lote/Data] -> [Categoria] -> arquivos
 */
function sincronizarTudo_() {
  const raiz = obterPastaRaiz_();
  if (!raiz) {
    return { sucesso: false, erro: 'Pasta "' + ATO_ROOT_FOLDER_NAME + '" não encontrada. Configure ATO_ROOT_FOLDER_ID.' };
  }

  const pastas = [];
  const lotes = [];
  iterar_(raiz.getFolders()).forEach((pasta) => {
    const nome = pasta.getName();
    if (nome.toLowerCase() === ATO_ROOT_FOLDER_NAME.toLowerCase()) return;
    pastas.push({ id: pasta.getId(), nome: nome, url: pasta.getUrl() });
    construirLotesDaPasta_(pasta).forEach((lote) => lotes.push(lote));
  });

  return { sucesso: true, status: 'OK', pastas: pastas, lotes: lotes, totalLotes: lotes.length };
}

function construirLotesDaPasta_(pasta) {
  const lotes = [];
  const nomePasta = pasta.getName();
  const pastaInfo = { id: pasta.getId(), nome: nomePasta };

  iterar_(pasta.getFolders()).forEach((sub) => {
    if (PASTAS_RESERVADAS.indexOf(sub.getName().toLowerCase()) !== -1) return;

    // Subpastas de categoria (ex.: "01 Post unico", "02 Carrossel", "Vídeos")
    iterar_(sub.getFolders()).forEach((cat) => {
      if (cat.getName().toLowerCase() === NOME_PASTA_REPROVADOS.toLowerCase()) return;
      const arquivos = iterar_(cat.getFiles());
      if (REGEX_PASTA_VIDEO.test(cat.getName())) {
        arquivos.forEach((v) => lotes.push(loteVideo_(pastaInfo, cat, v)));
        return;
      }
      if (arquivos.length) {
        lotes.push({
          pastaClienteId: pastaInfo.id,
          pastaClienteNome: nomePasta,
          loteNome: nomePasta + ' - ' + sub.getName() + ' - ' + cat.getName(),
          categoria: cat.getName(),
          pastaUrl: cat.getUrl(),
          arquivos: arquivos.map(arquivoDoDrive_),
        });
      }
    });

    // Arquivos soltos dentro da subpasta (lote direto)
    const diretos = iterar_(sub.getFiles());
    diretos.filter((f) => REGEX_VIDEO.test(f.getName())).forEach((v) => {
      lotes.push(loteVideo_(pastaInfo, sub, v));
    });
    const imagens = diretos.filter((f) => !REGEX_VIDEO.test(f.getName()));
    if (imagens.length) {
      lotes.push({
        pastaClienteId: pastaInfo.id,
        pastaClienteNome: nomePasta,
        loteNome: nomePasta + ' - ' + sub.getName(),
        categoria: imagens.length > 1 ? '02 Carrossel' : '01 Post unico',
        pastaUrl: sub.getUrl(),
        arquivos: imagens.map(arquivoDoDrive_),
      });
    }
  });

  return lotes;
}

function loteVideo_(pastaInfo, pastaOrigem, arquivo) {
  return {
    pastaClienteId: pastaInfo.id,
    pastaClienteNome: pastaInfo.nome,
    loteNome: pastaInfo.nome + ' - ' + pastaOrigem.getName() + ' - ' + arquivo.getName(),
    categoria: 'Vídeos',
    pastaUrl: pastaOrigem.getUrl(),
    arquivos: [arquivoDoDrive_(arquivo)],
  };
}

function arquivoDoDrive_(arquivo) {
  const id = arquivo.getId();
  return {
    driveFileId: id,
    nome: arquivo.getName(),
    mimeType: arquivo.getMimeType(),
    viewUrl: 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w1200',
    thumbnailUrl: 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w1200',
    downloadUrl: 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id),
  };
}

// ==========================================
// UPLOAD DO CLIENTE (UPLOAD_MIDIA)
// ==========================================
/**
 * Recebe { pastaClienteId, nomeArquivo, mimeType, base64Data } e grava na subpasta "Uploads"
 * da empresa. Devolve driveFileId e viewUrl para o Social Hub criar o item.
 */
function uploadMidia_(body) {
  const pasta = validarPastaCliente_(body.pastaClienteId);
  const nome = String(body.nomeArquivo || '').trim();
  const mime = String(body.mimeType || 'image/png');
  const base64 = String(body.base64Data || '').replace(/^data:[^;]+;base64,/, '');

  if (!nome) return { sucesso: false, erro: 'Nome do arquivo é obrigatório.' };
  if (!base64) return { sucesso: false, erro: 'Conteúdo do arquivo vazio.' };
  if (base64.length * 0.75 > FB_CONFIG.MAX_UPLOAD_BYTES) {
    return { sucesso: false, erro: 'Arquivo acima do limite de 50 MB.' };
  }

  const bytes = Utilities.base64Decode(base64);
  const blob = Utilities.newBlob(bytes, mime, nome);

  const uploads = obterOuCriarSubpasta_(pasta, NOME_PASTA_UPLOADS);
  const arquivo = uploads.createFile(blob);
  // O Instagram busca a imagem por URL pública; o arquivo precisa ser acessível por link.
  arquivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const id = arquivo.getId();
  const viewUrl = 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w1200';
  return {
    sucesso: true,
    success: true,
    driveFileId: id,
    fileId: id,
    viewUrl: viewUrl,
    url: viewUrl,
    pastaCliente: pasta.getName(),
  };
}

// ==========================================
// EXCLUSÃO PARA A LIXEIRA (MOVER_LIXEIRA)
// ==========================================
/**
 * Move para a lixeira do Drive os arquivos do criativo. Só age em arquivos que estejam
 * dentro da pasta da empresa informada.
 */
function moverParaLixeira_(body) {
  const pasta = validarPastaCliente_(body.pastaClienteId);
  const ids = normalizarLista_(body.driveFileIds && body.driveFileIds.length
    ? body.driveFileIds
    : [body.driveFileId]);
  if (!ids.length) return { sucesso: false, erro: 'Nenhum arquivo informado.' };

  const movidos = [];
  const falhas = [];
  ids.forEach((id) => {
    try {
      const arquivo = DriveApp.getFileById(id);
      assertArquivoNaPasta_(arquivo, pasta);
      arquivo.setTrashed(true);
      movidos.push(id);
    } catch (err) {
      falhas.push({ driveFileId: id, erro: String(err && err.message ? err.message : err) });
    }
  });

  return {
    sucesso: falhas.length === 0,
    movidos: movidos,
    falhas: falhas,
    erro: falhas.length ? 'Alguns arquivos não foram movidos para a lixeira.' : undefined,
  };
}

// ==========================================
// OBSERVAÇÕES DO CLIENTE (SALVAR_OBSERVACOES_CLIENTE)
// ==========================================
function salvarObservacoesCliente_(body) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(FB_CONFIG.LOCK_MS)) {
    return { sucesso: false, erro: 'Outra gravação está em andamento. Tente novamente.' };
  }
  try {
    const pasta = validarPastaCliente_(body.pastaClienteId);
    const nomeArquivo = String(body.filename || '_OBSERVACOES_CLIENTE.md');
    const conteudo = String(body.conteudoMarkdown || '');
    const existentes = pasta.getFilesByName(nomeArquivo);
    if (existentes.hasNext()) {
      existentes.next().setContent(conteudo);
    } else {
      pasta.createFile(nomeArquivo, conteudo, MimeType.PLAIN_TEXT);
    }
    return { sucesso: true, status: 'OK', versao: body.versao || null };
  } catch (err) {
    return { sucesso: false, erro: String(err && err.message ? err.message : err) };
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// FEEDBACK EDITORIAL (reprovar, ajustar, aprovar)
// ==========================================

function handleFeedbackAction_(body) {
  const estado = FB_ESTADOS[body.acao];
  if (!estado) return null;

  const feedbackId = String(body.feedbackId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(feedbackId)) {
    return { sucesso: false, codigo: 'FEEDBACK_ID_INVALIDO', erro: 'feedbackId ausente ou inválido.' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(FB_CONFIG.LOCK_MS)) {
    return { sucesso: false, codigo: 'OCUPADO', erro: 'Outro feedback está sendo gravado. Tente novamente em instantes.' };
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const anterior = props.getProperty(FB_CONFIG.PROP_PREFIX + feedbackId);
    if (anterior) {
      // Requisição duplicada: devolve o resultado original, sem mover nem gravar de novo.
      return Object.assign(JSON.parse(anterior), { duplicado: true });
    }

    const resultado = processarFeedback_(body, estado, feedbackId);
    props.setProperty(FB_CONFIG.PROP_PREFIX + feedbackId, JSON.stringify(resultado));
    return resultado;
  } catch (err) {
    return { sucesso: false, codigo: 'FALHA_DRIVE', erro: String(err && err.message ? err.message : err) };
  } finally {
    lock.releaseLock();
  }
}

function processarFeedback_(body, estado, feedbackId) {
  const afetados = normalizarLista_(body.arquivosAfetados && body.arquivosAfetados.length
    ? body.arquivosAfetados
    : [body.driveFileId]);
  const todos = normalizarLista_(body.arquivosTodos && body.arquivosTodos.length
    ? body.arquivosTodos
    : afetados);

  if (!afetados.length) throw new Error('Nenhum arquivo informado para o feedback.');
  if (afetados.length > FB_CONFIG.MAX_ARQUIVOS) throw new Error('Arquivos demais em um único feedback.');
  if (afetados.some((id) => todos.indexOf(id) === -1)) {
    throw new Error('Arquivo afetado não pertence ao conteúdo informado. Nenhuma alteração foi feita.');
  }

  // 1) Validação completa ANTES de qualquer alteração no Drive.
  const pastaCliente = resolverPastaCliente_(body, afetados[0]);
  const arquivos = afetados.map((id) => {
    const arquivo = DriveApp.getFileById(id);
    assertArquivoNaPasta_(arquivo, pastaCliente);
    return arquivo;
  });

  // 2) Guarda: arte já reprovada em OUTRO feedback não é renomeada de novo (evita a cadeia REP-…REP-…).
  if (estado === 'REPROVADO') {
    const prefixoEste = 'REP-' + feedbackId.substring(0, 24) + '-';
    arquivos.forEach((arquivo) => {
      const nome = arquivo.getName();
      if (nome.indexOf('REP-') === 0 && nome.indexOf(prefixoEste) !== 0) {
        throw new Error('Arquivo "' + nome + '" já foi reprovado em outro feedback. Nada foi alterado.');
      }
    });
  }

  // 3) Nomes finais calculados antes de qualquer alteração.
  const pastaReprovados = estado === 'REPROVADO' ? obterOuCriarPastaReprovadosDoCliente(pastaCliente) : null;
  const registros = arquivos.map((arquivo, i) => {
    const nomeOriginal = arquivo.getName();
    const slide = todos.indexOf(afetados[i]) + 1;
    const novoNome = estado === 'REPROVADO' ? nomeEstavel_(feedbackId, slide, nomeOriginal) : nomeOriginal;
    return { driveFileId: afetados[i], slide: slide, nomeOriginal: nomeOriginal, novoNome: novoNome };
  });

  // 4) Memória ANTES de mover. Se a movimentação falhar, reenviar o mesmo feedbackId completa a
  //    movimentação sem duplicar o registro (dedupe pelo feedbackId dentro do arquivo).
  const detalhes = body.detalhes || {};
  const entrada = {
    feedbackId: feedbackId,
    contentId: body.contentId || null,
    data: new Date().toISOString(),
    empresa: pastaCliente.getName(),
    formato: body.formato || body.categoria || null,
    estado: estado,
    erroCriativo: estado === 'REPROVADO',
    arquivos: registros,
    slidesAfetados: registros.map((r) => r.slide),
    categoria: body.categoria || null,
    tags: normalizarLista_(body.tags || []),
    motivo: String(body.motivo || '').trim(),
    escopo: detalhes.escopo || null,
    problemaPrincipal: detalhes.erroPrincipal || null,
    preservar: String(detalhes.preservar || '').trim(),
    corrigir: String(detalhes.mudar || body.motivo || '').trim(),
    sugestaoCopy: String(detalhes.sugestaoCopy || '').trim(),
    referenciaAprovada: String(detalhes.referenciaAprovada || '').trim(),
  };

  const memoria = estado === 'APROVADO'
    ? gravarRegistro_(pastaCliente, FB_CONFIG.ARQUIVO_APROVACOES, FB_CABECALHO_APROVACOES, entrada, 'APROVAÇÃO')
    : gravarRegistro_(pastaReprovados, FB_CONFIG.ARQUIVO_MEMORIA, FB_CABECALHO_MEMORIA, entrada, estado);

  // 5) Movimentação. Idempotente: nome e pasta já iguais não causam alteração.
  if (estado === 'REPROVADO') {
    arquivos.forEach((arquivo, i) => {
      if (arquivo.getName() !== registros[i].novoNome) arquivo.setName(registros[i].novoNome);
      arquivo.moveTo(pastaReprovados);
    });
  }

  return {
    sucesso: true,
    codigo: 'OK',
    feedbackId: feedbackId,
    estado: estado,
    novoNomeArquivo: registros[0].novoNome,
    arquivos: registros,
    pastaCliente: pastaCliente.getName(),
    pastaReprovadosUrl: pastaReprovados ? pastaReprovados.getUrl() : pastaCliente.getUrl(),
    memoria: { arquivoId: memoria.arquivoId, duplicada: memoria.duplicado, verificada: true },
    duplicado: false,
  };
}

/**
 * Nome estável: não carrega o motivo. Ex.: REP-fb_abc123-s02__carrossel_google.png
 */
function nomeEstavel_(feedbackId, slide, nomeOriginal) {
  const ultimoPonto = nomeOriginal.lastIndexOf('.');
  const ext = ultimoPonto !== -1 ? nomeOriginal.substring(ultimoPonto).toLowerCase() : '';
  const base = ultimoPonto !== -1 ? nomeOriginal.substring(0, ultimoPonto) : nomeOriginal;
  const slug = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 40) || 'arte';
  const slideTxt = ('0' + slide).slice(-2);
  return 'REP-' + feedbackId.substring(0, 24) + '-s' + slideTxt + '__' + slug + ext;
}

/**
 * Grava um bloco JSON no arquivo de memória da pasta.
 * - Usa SOMENTE arquivo de texto puro (text/plain). Um Google Doc com o mesmo nome é ignorado.
 * - Dedupe: se o feedbackId já estiver no arquivo, não grava de novo.
 * - Confirma: relê o arquivo do Drive e só retorna sucesso se o feedbackId estiver lá.
 */
function gravarRegistro_(pasta, nomeArquivo, cabecalho, entrada, titulo) {
  const candidatos = iterar_(pasta.getFilesByName(nomeArquivo)).filter(
    (f) => !f.isTrashed() && f.getMimeType() === MimeType.PLAIN_TEXT
  );
  if (candidatos.length > 1) {
    Logger.log('ATENÇÃO: há ' + candidatos.length + ' arquivos "' + nomeArquivo + '" de texto. Usando o maior.');
  }
  candidatos.sort((a, b) => b.getSize() - a.getSize());
  const arquivo = candidatos[0] || null;
  const atual = arquivo ? arquivo.getBlob().getDataAsString('UTF-8') : cabecalho;

  const marcador = '"feedbackId": "' + entrada.feedbackId + '"';
  if (arquivo && atual.indexOf(marcador) !== -1) {
    return { arquivoId: arquivo.getId(), duplicado: true };
  }

  const bloco =
    '### ' + titulo + ' · ' + entrada.feedbackId + ' · ' + entrada.data + '\n' +
    '```json\n' + JSON.stringify(entrada, null, 2) + '\n```\n\n';

  let alvo = arquivo;
  if (alvo) {
    alvo.setContent(atual + bloco);
  } else {
    alvo = pasta.createFile(nomeArquivo, cabecalho + bloco, MimeType.PLAIN_TEXT);
  }

  // Confirmação: relê do Drive. Sem o feedbackId lá, não há sucesso.
  const lido = DriveApp.getFileById(alvo.getId()).getBlob().getDataAsString('UTF-8');
  if (lido.indexOf(marcador) === -1) {
    throw new Error('A memória de reprovações não confirmou a gravação. Nenhuma movimentação foi feita.');
  }
  return { arquivoId: alvo.getId(), duplicado: false };
}

// ==========================================
// PASTAS DO CLIENTE: VALIDAÇÃO E LOCALIZAÇÃO
// ==========================================

/**
 * Valida que a pasta existe e, quando a raiz "ATO Social Midia" é encontrada,
 * que ela está dentro dela. Isso impede operar em pastas arbitrárias do Drive.
 */
function validarPastaCliente_(pastaClienteId) {
  if (!pastaClienteId) throw new Error('pastaClienteId ausente.');
  const pasta = DriveApp.getFolderById(String(pastaClienteId));
  const raiz = obterPastaRaiz_();
  if (raiz && !estaDentroDe_(pasta, raiz.getId()) && pasta.getId() !== raiz.getId()) {
    throw new Error('Pasta informada não pertence à estrutura ATO Social Midia.');
  }
  return pasta;
}

function resolverPastaCliente_(body, primeiroArquivoId) {
  if (body.pastaClienteId) {
    return validarPastaCliente_(body.pastaClienteId);
  }
  // Compatibilidade com chamadas antigas sem pastaClienteId.
  return encontrarPastaRaizDoCliente(DriveApp.getFileById(primeiroArquivoId));
}

function estaDentroDe_(pasta, idAncestral) {
  let atual = pasta.getParents().hasNext() ? pasta.getParents().next() : null;
  for (let i = 0; atual && i < FB_CONFIG.PROFUNDIDADE_MAX; i++) {
    if (atual.getId() === idAncestral) return true;
    const pais = atual.getParents();
    atual = pais.hasNext() ? pais.next() : null;
  }
  return false;
}

/**
 * Confirma que o arquivo está dentro da pasta do cliente (subindo a árvore de pastas).
 */
function assertArquivoNaPasta_(arquivo, pastaCliente) {
  if (!estaDentroDe_(arquivo, pastaCliente.getId()) && !arquivoDiretoNaPasta_(arquivo, pastaCliente)) {
    throw new Error('Arquivo ' + arquivo.getId() + ' não pertence à pasta do cliente informada. Nenhuma alteração foi feita.');
  }
}

function arquivoDiretoNaPasta_(arquivo, pasta) {
  const pais = arquivo.getParents();
  while (pais.hasNext()) {
    if (pais.next().getId() === pasta.getId()) return true;
  }
  return false;
}

/**
 * Sobe na árvore de pastas do arquivo até encontrar a pasta principal do Cliente.
 * Estrutura esperada: [Pasta do Cliente] -> [Data] -> [Tipo de Mídia] -> imagem.png
 */
function encontrarPastaRaizDoCliente(arquivo) {
  let pastaAtual = arquivo.getParents().hasNext() ? arquivo.getParents().next() : null;
  if (!pastaAtual) throw new Error('Arquivo órfão no Drive.');

  let possivelPai1 = pastaAtual.getParents().hasNext() ? pastaAtual.getParents().next() : null;
  let possivelPai2 = (possivelPai1 && possivelPai1.getParents().hasNext()) ? possivelPai1.getParents().next() : null;

  const regexData = /\d{2}[-_]\d{2}[-_]\d{4}|\d{4}[-_]\d{2}[-_]\d{2}/;
  if (regexData.test(pastaAtual.getName()) && possivelPai1) {
    return possivelPai1;
  }
  if (possivelPai1 && regexData.test(possivelPai1.getName()) && possivelPai2) {
    return possivelPai2;
  }
  return pastaAtual;
}

/**
 * Obtém ou cria a pasta "Reprovados" dentro da pasta do Cliente.
 */
function obterOuCriarPastaReprovadosDoCliente(pastaCliente) {
  return obterOuCriarSubpasta_(pastaCliente, NOME_PASTA_REPROVADOS);
}

function obterOuCriarSubpasta_(pai, nome) {
  const existentes = pai.getFoldersByName(nome);
  if (existentes.hasNext()) return existentes.next();
  return pai.createFolder(nome);
}

// ==========================================
// UTILITÁRIOS
// ==========================================

function iterar_(iterator) {
  const saida = [];
  while (iterator.hasNext()) saida.push(iterator.next());
  return saida;
}

function normalizarLista_(lista) {
  const vistos = {};
  const saida = [];
  (Array.isArray(lista) ? lista : []).forEach((item) => {
    const valor = String(item || '').trim();
    if (valor && !vistos[valor]) {
      vistos[valor] = true;
      saida.push(valor);
    }
  });
  return saida;
}

// ==========================================
// RECUPERAÇÃO DA MEMÓRIA (rodar UMA vez, manualmente, pelo editor)
// Acrescenta à memória válida os feedbacks que estão no banco mas não chegaram ao arquivo.
// Faz cópia de segurança ANTES. Não remove nem altera blocos já existentes.
// ==========================================
// Memória ATIVA (text/plain, pasta Reprovados). O arquivo antigo foi arquivado; não usar o ID antigo.
const MEMORIA_ARQUIVO_ID_VALIDO = '14AS23UFQRwFg7fysGf1U9QRSVzTRIN0K';
const REGISTROS_RECUPERADOS = []; // preencher com os registros reconstruídos do banco

function recuperarMemoriaDoBanco() {
  const arquivo = DriveApp.getFileById(MEMORIA_ARQUIVO_ID_VALIDO);
  if (arquivo.getMimeType() !== MimeType.PLAIN_TEXT) throw new Error('Arquivo alvo não é texto puro. Nada foi alterado.');
  const copia = arquivo.makeCopy('_BACKUP_antes_recuperacao_' + new Date().toISOString());

  let conteudo = arquivo.getBlob().getDataAsString('UTF-8');
  const adicionados = [];
  REGISTROS_RECUPERADOS.forEach((r) => {
    if (conteudo.indexOf('"feedbackId": "' + r.feedbackId + '"') !== -1) return; // já existe: não duplica
    conteudo += '### REPROVADO (recuperado do banco) · ' + r.feedbackId + ' · ' + r.data + '\n' +
      '```json\n' + JSON.stringify(r, null, 2) + '\n```\n\n';
    adicionados.push(r.feedbackId);
  });
  if (adicionados.length) arquivo.setContent(conteudo);

  // Confirmação: relê do Drive.
  const lido = DriveApp.getFileById(MEMORIA_ARQUIVO_ID_VALIDO).getBlob().getDataAsString('UTF-8');
  const faltando = adicionados.filter((id) => lido.indexOf('"feedbackId": "' + id + '"') === -1);
  Logger.log('Backup: ' + copia.getId() + ' | adicionados: ' + adicionados.length + ' | faltando: ' + faltando.length);
  return { backupId: copia.getId(), adicionados: adicionados, faltando: faltando };
}
