import { GoogleGenAI, GenerateContentResponse } from '@google/genai';
import {
  CompanyBrandProfile,
  GeminiCaptionGenerateRequest,
  GeminiCaptionGenerateResponse,
  PostGroup,
} from '../types/index.ts';
import { recordAIGenerationInDb, saveCaptionForPostTx } from '../db/repository.ts';

const DEFAULT_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

let customGeminiGeneratorForTest:
  | ((params: { model: string; prompt: string; hasImage: boolean }) => Promise<string>)
  | null = null;

export function setGeminiGeneratorOverrideForTest(
  fn: ((params: { model: string; prompt: string; hasImage: boolean }) => Promise<string>) | null
) {
  customGeminiGeneratorForTest = fn;
}

function getConfiguredGeminiModels(): string[] {
  const envModel = String(process.env.GEMINI_MODEL || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');
  const validEnvModel =
    envModel && !envModel.includes('<MODELO_COMPATIVEL>') ? envModel : '';

  const list = validEnvModel
    ? [validEnvModel, ...DEFAULT_GEMINI_MODELS.filter((m) => m !== validEnvModel)]
    : [...DEFAULT_GEMINI_MODELS];
  return list;
}

/**
 * Attempts to fetch the first media asset image of a PostGroup as base64 for multimodal context.
 */
async function fetchPostImageInlineData(
  post: PostGroup
): Promise<{ mimeType: string; data: string } | null> {
  const firstItem = post.items?.[0];
  if (!firstItem) return null;

  // Check if viewUrl is already a data URI (e.g. uploaded image)
  if (firstItem.viewUrl && firstItem.viewUrl.startsWith('data:image/')) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(firstItem.viewUrl);
    if (match) {
      return { mimeType: match[1], data: match[2] };
    }
  }

  const candidateUrls = [
    firstItem.thumbnailUrl,
    firstItem.viewUrl,
    firstItem.driveFileId && !firstItem.driveFileId.startsWith('drive_')
      ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(firstItem.driveFileId)}&sz=w800`
      : '',
  ].filter((u): u is string => Boolean(u && u.startsWith('http')));

  for (const url of candidateUrls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(url, { redirect: 'follow', signal: controller.signal });
      clearTimeout(timeout);

      const contentType = resp.headers.get('content-type') || '';
      if (resp.ok && contentType.startsWith('image/')) {
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > 0 && buf.length <= 6 * 1024 * 1024) {
          return {
            mimeType: contentType.split(';')[0].trim(),
            data: buf.toString('base64'),
          };
        }
      }
    } catch {
      // ignore image fetch failure and continue with text prompt
    }
  }

  return null;
}

/**
 * Builds the editorial system instruction and user prompt tailored to the client company and post format.
 */
export function buildCaptionPrompt(params: {
  post: PostGroup;
  company?: CompanyBrandProfile | null;
  request: GeminiCaptionGenerateRequest;
  hasMultimodalImage: boolean;
}): { systemInstruction: string; userPrompt: string } {
  const { post, company, request, hasMultimodalImage } = params;

  const brandName =
    request.companyName?.trim() ||
    company?.name ||
    post.pastaClienteNome ||
    post.driveFolderName ||
    'Marca Cliente';

  const isAtoBrand =
    brandName.toLowerCase() === 'ato' || brandName.toLowerCase() === 'ato.vc';

  const segment =
    request.segment?.trim() ||
    company?.segment ||
    (isAtoBrand
      ? 'Agência de posicionamento digital, estratégia de marca e conteúdo'
      : 'Segmento empresarial da marca');

  const tone =
    request.tone?.trim() ||
    company?.brandVoice ||
    (isAtoBrand
      ? 'Estratégico, direto, contemporâneo e confiante, sem jargões vazios'
      : 'Profissional, claro, autêntico e alinhado ao público da marca');

  const objective =
    request.objective?.trim() || 'Gerar engajamento qualificado e fortalecer autoridade da marca';
  const theme = request.theme?.trim() || post.loteNome || post.nome;
  const briefing = request.briefing?.trim() || '';
  const cta =
    request.cta?.trim() ||
    company?.defaultCta ||
    'Convite sutil e natural para interação ou contato';
  const includeHashtags = request.includeHashtags !== false;
  const defaultHashtags = company?.defaultHashtags || '';
  const customGuidelines = company?.aiGuidelines || '';

  const formatDescription =
    post.categoria === 'Carrossel'
      ? `Carrossel com ${post.items.length} slides (estruture a legenda conectando o gancho inicial ao desenvolvimento dos slides e fechamento)`
      : post.categoria === 'Story'
      ? 'Story (texto curto, direto e de leitura rápida para suporte ao Story)'
      : 'Post Único de Feed (gancho forte na primeira linha, desenvolvimento objetivo e fechamento com CTA)';

  const systemInstruction = [
    `Você é um redator estrategista sênior de social media trabalhando exclusivamente no contexto editorial da marca "${brandName}".`,
    `NUNCA aplique o estilo ou assinatura de outra empresa à marca "${brandName}".`,
    `REGRAS OBRIGATÓRIAS DE ESCRITA:`,
    `1. Escreva em português do Brasil natural, fluido, relevante e adaptado especificamente para "${brandName}".`,
    `2. PROIBIDO inventar dados estatísticos, preços, descontos, prêmios, promessas comerciais não comprovadas ou informações ausentes no briefing ou na imagem.`,
    `3. Evite textos genéricos, clichês de inteligência artificial ("No mundo dinâmico de hoje...", "Descubra como..."), frases repetitivas e tom artificial.`,
    `4. Use emojis com extrema moderação (no máximo 1 a 3 emojis se combinarem com o tom da marca; zero se o tom for sóbrio).`,
    includeHashtags
      ? `5. Inclua ao final apenas 3 a 5 hashtags altamente pertinentes ao tema e à marca${defaultHashtags ? ` (considerando: ${defaultHashtags})` : ''}.`
      : `5. NÃO inclua nenhuma hashtag nesta legenda.`,
    `6. Retorne APENAS o texto final da legenda pronta para publicação, sem introduções ("Aqui está a legenda:"), sem opções numeradas e sem cercas de markdown.`,
  ].join('\n');

  const promptLines = [
    `Gere uma legenda para publicação no Instagram com os seguintes parâmetros editoriais:`,
    `- Empresa / Marca: ${brandName}`,
    `- Segmento de atuação: ${segment}`,
    `- Formato da publicação: ${formatDescription}`,
    `- Identificador / Tema do criativo: ${theme}`,
    `- Objetivo da publicação: ${objective}`,
    `- Tom de comunicação da marca: ${tone}`,
    `- Chamada para ação (CTA): ${cta}`,
  ];

  if (briefing) {
    promptLines.push(`- Briefing e informações específicas: ${briefing}`);
  }
  if (customGuidelines) {
    promptLines.push(`- Diretrizes editoriais da marca: ${customGuidelines}`);
  }
  if (hasMultimodalImage) {
    promptLines.push(
      `- Contexto visual: Analise a imagem anexada do criativo (textos na arte, elementos visuais e hierarquia) e alinhe a legenda fielmente ao conteúdo real da peça, sem inventar fatos extras.`
    );
  }
  if (request.regenerateVariation && request.previousCaption) {
    promptLines.push(
      `- Solicitação de nova versão: Gere uma abordagem e estrutura de gancho DIFERENTE da versão anterior abaixo, mantendo fidelidade ao briefing:\n"""\n${request.previousCaption}\n"""`
    );
  }

  return {
    systemInstruction,
    userPrompt: promptLines.join('\n'),
  };
}

/**
 * Generates an Instagram caption using @google/genai, saves the audit record in ai_generations,
 * and persists the editable caption version in captions + posts in PostgreSQL.
 */
export async function generateAndPersistCaptionWithGemini(params: {
  post: PostGroup;
  company?: CompanyBrandProfile | null;
  request: GeminiCaptionGenerateRequest;
  createdBy?: string | null;
}): Promise<GeminiCaptionGenerateResponse> {
  const { post, company, request, createdBy } = params;
  const startMs = Date.now();
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();

  if (!apiKey && !customGeminiGeneratorForTest) {
    throw new Error(
      'A variável GEMINI_API_KEY não está configurada no servidor. Configure a chave nos Secrets do ambiente.'
    );
  }

  const shouldTryImage = request.useMultimodalImage !== false;
  const inlineImage = shouldTryImage ? await fetchPostImageInlineData(post) : null;

  const { systemInstruction, userPrompt } = buildCaptionPrompt({
    post,
    company,
    request,
    hasMultimodalImage: Boolean(inlineImage),
  });

  const candidateModels = getConfiguredGeminiModels();
  const genId = `aigen_${post.id}_${Date.now()}`;

  let generatedText = '';
  let usedModel = candidateModels[0];
  let lastError: any = null;

  if (customGeminiGeneratorForTest) {
    try {
      generatedText = (
        await customGeminiGeneratorForTest({
          model: usedModel,
          prompt: userPrompt,
          hasImage: Boolean(inlineImage),
        })
      ).trim();
    } catch (err: any) {
      lastError = err;
    }
  } else {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    for (const modelName of candidateModels) {
      usedModel = modelName;
      try {
        const contents = inlineImage
          ? {
              parts: [
                {
                  inlineData: {
                    mimeType: inlineImage.mimeType,
                    data: inlineImage.data,
                  },
                },
                { text: userPrompt },
              ],
            }
          : userPrompt;

        const response: GenerateContentResponse = await ai.models.generateContent({
          model: modelName,
          contents,
          config: {
            systemInstruction,
            temperature: request.regenerateVariation ? 0.85 : 0.7,
          },
        });

        const textOut = String(response.text || '').trim();
        if (textOut) {
          generatedText = textOut
            .replace(/^```[a-zA-Z]*\n?/, '')
            .replace(/\n?```$/, '')
            .trim();
          lastError = null;
          break;
        }
      } catch (err: any) {
        lastError = err;
        // Se o modelo atual estiver com pico de demanda (503/429) ou indisponível, tenta o próximo modelo da lista
        continue;
      }
    }
  }

  const latencyMs = Date.now() - startMs;

  if (!generatedText || lastError) {
    const errMsg =
      lastError?.message || 'Não foi possível gerar a legenda com a Gemini API no momento.';
    await recordAIGenerationInDb({
      id: genId,
      postId: post.id,
      companyId: company?.id || post.companyId || null,
      model: usedModel,
      objective: request.objective || null,
      theme: request.theme || post.loteNome,
      briefing: request.briefing || null,
      tone: request.tone || company?.brandVoice || null,
      cta: request.cta || company?.defaultCta || null,
      includeHashtags: request.includeHashtags !== false,
      usedMultimodalImage: Boolean(inlineImage),
      generatedText: null,
      status: 'ERROR',
      errorMessage: errMsg,
      latencyMs,
      createdBy: createdBy || null,
    });
    throw new Error(
      `Falha ao gerar legenda com Gemini (${usedModel}): ${errMsg}. Você pode tentar novamente ou digitar a legenda manualmente.`
    );
  }

  const generationRecord = await recordAIGenerationInDb({
    id: genId,
    postId: post.id,
    companyId: company?.id || post.companyId || null,
    model: usedModel,
    objective: request.objective || null,
    theme: request.theme || post.loteNome,
    briefing: request.briefing || null,
    tone: request.tone || company?.brandVoice || null,
    cta: request.cta || company?.defaultCta || null,
    includeHashtags: request.includeHashtags !== false,
    usedMultimodalImage: Boolean(inlineImage),
    generatedText,
    status: 'SUCCESS',
    errorMessage: null,
    latencyMs,
    createdBy: createdBy || null,
  });

  const saved = await saveCaptionForPostTx({
    postId: post.id,
    content: generatedText,
    source: 'GEMINI_AI',
    aiGenerationId: generationRecord.id,
    createdBy: createdBy || 'Gemini AI',
    approveImmediately: false,
  });

  return {
    success: true,
    caption: saved.caption,
    generation: generationRecord,
    post: saved.post,
    requiresReapproval: saved.requiresReapproval,
    message: saved.requiresReapproval
      ? 'Nova legenda gerada com IA. Como a postagem já estava aprovada, a nova legenda requer aprovação antes de publicar.'
      : 'Legenda gerada com IA e salva no PostgreSQL com sucesso!',
  };
}

export async function generateCaptionWithGemini(params: {
  postId: string;
  objective?: string;
  theme?: string;
  briefing?: string;
  tone?: string;
  cta?: string;
  includeHashtags?: boolean;
  customInstructions?: string;
  regenerate?: boolean;
  createdBy?: string | null;
}): Promise<{
  caption: string;
  captionRecord: any;
  aiGeneration: any;
  post: PostGroup;
  requiresReapproval: boolean;
  modelUsed: string;
}> {
  const { getPostGroupByIdFromDb, getCompanyByIdOrFolder, getConsolidatedCreativeContextForCompany } = await import('../db/repository.ts');
  const post = await getPostGroupByIdFromDb(params.postId);
  if (!post) {
    throw new Error(`Postagem "${params.postId}" não encontrada no PostgreSQL.`);
  }

  const companyKey =
    post.companyId || post.pastaClienteId || post.pastaClienteNome || post.driveFolderName || 'Ato';

  const company = await getCompanyByIdOrFolder(companyKey);

  let creativeContextPrompt = '';
  try {
    const ctx = await getConsolidatedCreativeContextForCompany(companyKey);
    creativeContextPrompt = ctx.formattedPromptContext || '';
  } catch (e: any) {
    console.warn('[Gemini Caption] Aviso ao recuperar contexto criativo:', e?.message);
  }

  const combinedBriefing = [
    params.briefing,
    params.customInstructions,
    creativeContextPrompt,
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await generateAndPersistCaptionWithGemini({
    post,
    company,
    createdBy: params.createdBy || 'Usuário',
    request: {
      postId: post.id,
      companyName: company?.name || post.pastaClienteNome || post.driveFolderName || 'Ato',
      segment: company?.segment || undefined,
      objective: params.objective,
      theme: params.theme || post.loteNome,
      briefing: combinedBriefing || undefined,
      tone: params.tone,
      cta: params.cta,
      includeHashtags: params.includeHashtags !== false,
      regenerateVariation: Boolean(params.regenerate),
      previousCaption: post.caption,
    },
  });

  return {
    caption: res.caption.content,
    captionRecord: res.caption,
    aiGeneration: res.generation,
    post: res.post!,
    requiresReapproval: Boolean(res.requiresReapproval),
    modelUsed: res.generation.model,
  };
}

export function getGeminiConfigStatus(): {
  apiKeyConfigured: boolean;
  configuredModels: string[];
  primaryModel: string;
} {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  const models = getConfiguredGeminiModels();
  return {
    apiKeyConfigured: Boolean(key && key !== 'MY_GEMINI_API_KEY' && key.length > 10),
    configuredModels: models,
    primaryModel: models[0],
  };
}

