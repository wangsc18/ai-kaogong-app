import { METHOD_CARDS_BY_MODULE } from './methodCards';
import { loadStudyPlanState } from '../db/database';
import {
  extractTextViaFallbackOcr,
  OcrFallbackConfig,
} from '../services/ocrFallbackService';
import {
  ERROR_REASONS,
  flattenTaxonomyText,
  KAOGONG_TAXONOMY,
  normalizeModuleL1,
} from '../taxonomy/kaogongTaxonomy';
import {
  AISettings,
  ChatTurn,
  ErrorReason,
  FastSolutionResult,
  MistakeRecord,
  ModelEndpointConfig,
  ModuleL1,
  QuestionOption,
  VisionExtractionResult,
} from '../types/models';

export interface ImageInputPayload {
  label: '题干图' | '资料材料图' | '参考答案/解析图';
  base64: string;
  mimeType?: string;
}

interface ChatMessagePartText {
  type: 'text';
  text: string;
}

interface ChatMessagePartImage {
  type: 'image_url';
  image_url: { url: string };
}

/** 判断模型是否为不支持自定义 temperature 参数的推理模型（如 OpenAI gpt-5/gpt-6/o系列、DeepSeek Pro/Reasoner） */
function shouldOmitTemperature(modelName: string): boolean {
  const m = modelName.trim().toLowerCase();
  return (
    m.startsWith('gpt-5') ||
    m.startsWith('gpt-6') ||
    /^o[1-9]/.test(m) ||
    m.includes('reasoner') ||
    m.includes('v4-pro')
  );
}

/** 判断模型是否为已知仅支持纯文本的模型（需直接走备用 OCR 提取文字后再推理） */
function isKnownTextOnlyModel(modelName: string): boolean {
  const m = modelName.trim().toLowerCase();
  return (
    m === 'deepseek-v4-pro' ||
    m === 'deepseek-chat' ||
    m === 'deepseek-reasoner'
  );
}

export async function callModelEndpoint(
  endpoint: ModelEndpointConfig,
  systemPrompt: string,
  userText: string,
  images: ImageInputPayload[] = [],
  history: ChatTurn[] = []
): Promise<string> {
  const apiKey = endpoint.apiKey.trim();
  if (!apiKey) {
    throw new Error('尚未配置 AI 模型 API Key，请先前往「设置」页填写或使用手动文本模式。');
  }
  const cleanBase = endpoint.baseUrl.trim().replace(/\/+$/, '');
  const modelName = endpoint.modelName.trim();

  if (endpoint.protocol === 'gemini') {
    const url = `${cleanBase}/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const contents: any[] = [];

    for (const h of history) {
      contents.push({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }],
      });
    }

    const currentParts: any[] = [];
    for (const img of images) {
      currentParts.push({ text: `【附件图片：${img.label}】` });
      currentParts.push({
        inline_data: {
          mime_type: img.mimeType || 'image/jpeg',
          data: img.base64,
        },
      });
    }
    currentParts.push({ text: userText });

    contents.push({
      role: 'user',
      parts: currentParts,
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.2 },
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Gemini 接口请求失败 (${resp.status}): ${errBody.slice(0, 220)}`);
    }
    const data = await resp.json();
    const outText =
      data?.candidates?.[0]?.content?.parts
        ?.map((p: any) => p.text || '')
        .join('')
        .trim() || '';
    if (!outText) throw new Error('Gemini 接口返回内容为空');
    return outText;
  }

  // OpenAI / DeepSeek 兼容协议 (/chat/completions)
  const url = cleanBase.endsWith('/chat/completions')
    ? cleanBase
    : `${cleanBase}/chat/completions`;

  const messages: any[] = [{ role: 'system', content: systemPrompt }];
  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }

  if (images.length > 0) {
    const contentParts: Array<ChatMessagePartText | ChatMessagePartImage> = [];
    for (const img of images) {
      contentParts.push({ type: 'text', text: `【${img.label}】` });
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}`,
        },
      });
    }
    contentParts.push({ type: 'text', text: userText });
    messages.push({ role: 'user', content: contentParts });
  } else {
    messages.push({ role: 'user', content: userText });
  }

  const requestPayload: Record<string, any> = {
    model: modelName,
    messages,
  };
  if (!shouldOmitTemperature(modelName)) {
    requestPayload.temperature = 0.2;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestPayload),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`模型接口请求失败 (${resp.status}): ${errBody.slice(0, 240)}`);
  }
  const data = await resp.json();
  const outText = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!outText) throw new Error('模型接口返回内容为空');
  return outText;
}

export function extractFirstJsonObject(raw: string): any {
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = withoutThink.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : withoutThink;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI 未返回合法的 JSON 结构，请重试');
  }
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    const cleaned = slice.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(cleaned);
  }
}

function ensureTaxonomyAlignment(
  rawMod: string,
  rawL2: string,
  rawL3: string
): { moduleL1: ModuleL1; categoryL2: string; motherTypeL3: string } {
  const moduleL1 = normalizeModuleL1(rawMod);
  const modTree = KAOGONG_TAXONOMY[moduleL1];

  for (const [l2, l3List] of Object.entries(modTree)) {
    for (const stdL3 of l3List) {
      if (
        rawL3 === stdL3 ||
        (rawL3 && (stdL3.includes(rawL3) || rawL3.includes(stdL3.split('(')[0])))
      ) {
        return { moduleL1, categoryL2: l2, motherTypeL3: stdL3 };
      }
    }
  }
  for (const [l2, l3List] of Object.entries(modTree)) {
    if (rawL2 && (l2.includes(rawL2) || rawL2.includes(l2))) {
      return { moduleL1, categoryL2: l2, motherTypeL3: l3List[0] };
    }
  }
  const firstL2 = Object.keys(modTree)[0];
  return {
    moduleL1,
    categoryL2: firstL2,
    motherTypeL3: modTree[firstL2][0],
  };
}

function parseExtractionResponse(raw: string): VisionExtractionResult {
  const parsed = extractFirstJsonObject(raw);
  const aligned = ensureTaxonomyAlignment(
    String(parsed.moduleL1 || ''),
    String(parsed.categoryL2 || ''),
    String(parsed.motherTypeL3 || '')
  );

  const rawOpts: any[] = Array.isArray(parsed.options) ? parsed.options : [];
  const options: QuestionOption[] =
    rawOpts.length > 0
      ? rawOpts.map((o, idx) => ({
          key: String(o.key || String.fromCharCode(65 + idx)).toUpperCase(),
          text: String(o.text || ''),
          image: null,
        }))
      : [
          { key: 'A', text: '选项 A' },
          { key: 'B', text: '选项 B' },
          { key: 'C', text: '选项 C' },
          { key: 'D', text: '选项 D' },
        ];

  return {
    ...aligned,
    materialText: String(parsed.materialText || '').trim(),
    stemText: String(parsed.stemText || '').trim(),
    options,
    detectedMyWrongAnswer: String(parsed.detectedMyWrongAnswer || '')
      .trim()
      .toUpperCase()
      .slice(0, 1),
    detectedCorrectAnswer: String(parsed.detectedCorrectAnswer || '')
      .trim()
      .toUpperCase()
      .slice(0, 1),
    anchorKeywords: Array.isArray(parsed.anchorKeywords)
      ? parsed.anchorKeywords.map((x: any) => String(x).trim()).filter(Boolean)
      : [aligned.motherTypeL3],
    hasDiagramOrChart: Boolean(parsed.hasDiagramOrChart),
  };
}

const EXTRACTION_SYSTEM_PROMPT = `你是一位严谨的中国公务员考试（行测）题目结构化与 OCR 纠错专家。
请根据输入内容（图片或经过初步 OCR 提取的卷面文本），自动修正可能存在的形近字 OCR 识别微瑕、忽略手写干扰，精准切分出题干与 A/B/C/D 选项，并映射到下方的标准三级母题考点树中：

【标准三级母题考点树】
${flattenTaxonomyText()}

请严格且仅输出如下 JSON 对象（不要输出任何额外解释文字）：
{
  "moduleL1": "政治理论|常识判断|言语理解|数量关系|判断推理|资料分析 之一",
  "categoryL2": "二级题型名称（从上方树中选择）",
  "motherTypeL3": "三级母题考点名称（必须优先从上方树中精确选择）",
  "materialText": "若包含资料分析统计文字或表格关键数据，整理在此；否则为空字符串",
  "stemText": "完整干净的题干文字",
  "options": [
    {"key": "A", "text": "选项A内容"},
    {"key": "B", "text": "选项B内容"},
    {"key": "C", "text": "选项C内容"},
    {"key": "D", "text": "选项D内容"}
  ],
  "detectedMyWrongAnswer": "若明确显示了用户的错选（如'你的答案：B'），填单个字母A/B/C/D，否则填空字符串",
  "detectedCorrectAnswer": "若包含参考答案（如'正确答案：C'），务必准确提取单个字母A/B/C/D，否则填空字符串",
  "anchorKeywords": ["提取2到5个核心检索锚点词，例如选项中的四字成语、政策专有名词或核心公式词"],
  "hasDiagramOrChart": false
}`;

/**
 * 第一阶段：识图结构化提取
 * - 原生多模态路径：如 deepseek-flash / gpt-5 直接传 Base64 图像理解；
 * - 备用免 Key OCR 降级路径：当开启强制备用 OCR、或使用纯文本模型（如 deepseek-v4-pro）、或接口报错不支持 image_url 时，
 *   自动调用内置备用 OCR（Mac Apple Vision 局域网桥接 / 云端免费中文 OCR）提取原始文字，再交给纯文本模型纠错结构化！
 */
export async function extractQuestionFromImages(
  images: ImageInputPayload[],
  settings: AISettings,
  onProgressHint?: (hint: string) => void
): Promise<VisionExtractionResult> {
  const ocrConfig: OcrFallbackConfig = {
    mode: settings.ocrFallbackMode || 'auto',
    localMacOcrUrl: settings.localMacOcrUrl || '',
    ocrSpaceApiKey: settings.ocrSpaceApiKey || 'helloworld',
  };

  const forceOcr =
    ocrConfig.mode === 'force_ocr' ||
    isKnownTextOnlyModel(settings.visionModel.modelName);

  if (!forceOcr) {
    try {
      const raw = await callModelEndpoint(
        settings.visionModel,
        EXTRACTION_SYSTEM_PROMPT,
        '请识别图片中的公考行测错题并输出标准 JSON。',
        images
      );
      return parseExtractionResponse(raw);
    } catch (visionErr: any) {
      const msg = String(visionErr?.message || '');
      const shouldFallback =
        msg.includes('400') ||
        msg.includes('422') ||
        msg.toLowerCase().includes('image') ||
        msg.toLowerCase().includes('vision') ||
        msg.toLowerCase().includes('multimodal') ||
        msg.toLowerCase().includes('content');
      if (!shouldFallback) {
        throw visionErr;
      }
      // 模型不支持视觉输入，自动无缝切换至备用免Key OCR + 纯文本模型结构化！
    }
  }

  onProgressHint?.('正在通过内置备用 OCR 提取卷面文字并交由 DeepSeek 纠错切分...');
  const rawOcrText = await extractTextViaFallbackOcr(images, ocrConfig);

  const textEndpoint = settings.splitVisionAndReasoning
    ? settings.reasoningModel
    : settings.visionModel;

  const rawJson = await callModelEndpoint(
    textEndpoint,
    EXTRACTION_SYSTEM_PROMPT,
    `以下是试卷图片的 OCR 识别原始文本，请修正可能存在的少量形近错别字，精准切分题干与 A/B/C/D 选项并输出标准 JSON：\n\n${rawOcrText}`,
    []
  );
  return parseExtractionResponse(rawJson);
}

/**
 * 第二阶段：注入对应模块的「实战秒杀方法卡」生成考场速解步骤、防坑警示与错因诊断
 */
export async function generateFastSolution(
  params: {
    moduleL1: ModuleL1;
    categoryL2?: string;
    motherTypeL3?: string;
    materialText?: string | null;
    stemText: string;
    options: QuestionOption[];
    knownCorrectAnswer?: string;
    myWrongAnswer?: string;
    officialAnalysisHint?: string;
    imagesForContext?: ImageInputPayload[];
  },
  settings: AISettings
): Promise<FastSolutionResult> {
  const endpoint = settings.splitVisionAndReasoning
    ? settings.reasoningModel
    : settings.visionModel;

  const methodCard = settings.enableFastMethodCards
    ? METHOD_CARDS_BY_MODULE[params.moduleL1]
    : '请给出清晰准确的公务员行测解析。';

  // 若用户在「讲义规划」中上传了老师讲义并开启了老师风格同步，自动挂载老师专属做题思路！
  let customTeacherBlock = '';
  try {
    const plan = await loadStudyPlanState();
    if (plan?.teacherPersona?.enableInMistakeSolver && plan.teacherPersona.corePhilosophy) {
      const tp = plan.teacherPersona;
      customTeacherBlock = `\n【已挂载考生上传讲义的老师专属讲题风格：${tp.teacherNameOrTag || '讲义名师'}】
- 核心做题心法：${tp.corePhilosophy}
- 标志性技巧/术语：${(tp.signatureTechniques || []).join('、')}
- 标准解题步骤：${tp.solvingStepsTemplate}
请优先贴合该老师的讲题口吻、术语和切入步骤来拆解本题！\n`;
    }
  } catch {
    // ignore
  }

  const validReasons = ERROR_REASONS.map((r) => r.value).join('|');

  const systemPrompt = `你是一位顶尖公考行测实战私教。你的任务是帮考生彻底复盘错题，拒绝冗长低效的教科书硬算，用考场 45 秒内能落地的实战技巧讲透本题！

${methodCard}
${customTeacherBlock}
【标准三级母题考点树】
${flattenTaxonomyText()}

请严格且仅输出如下 JSON 对象：
{
  "moduleL1": "一级模块名",
  "categoryL2": "二级题型名",
  "motherTypeL3": "最精准的三级母题考点名（从标准树中选择）",
  "correctAnswer": "正确选项字母 A/B/C/D（若已知标准答案已提供，必须100%严格服从已知标准答案，严禁擅自更改！）",
  "suggestedErrorReason": "${validReasons} 之一",
  "anchorKeywords": ["3到6个核心考点锚点词（言语必填核心易混成语，政治理论必填政策核心词，资料/判断必填母题模型词）"],
  "pitfallWarning": "一句话犀利点破本题最容易掉进去的命题陷阱或秒杀口诀（40字以内）",
  "aiFastSolution": "使用清晰分段的文本（支持换行和【小标题】）：\\n【第一眼破题信号】...\\n【考场秒杀步骤】...\\n【错项排雷与辨析】..."
}`;

  const optionsFormatted = params.options.map((o) => `${o.key}. ${o.text}`).join('\n');
  const promptLines = [
    `【预设模块】${params.moduleL1}`,
    params.materialText ? `【统计/背景材料】\n${params.materialText}` : '',
    `【题干】\n${params.stemText}`,
    `【选项】\n${optionsFormatted}`,
    params.myWrongAnswer ? `【考生错选】${params.myWrongAnswer}` : '',
    params.knownCorrectAnswer
      ? `【已核实标准答案（必须严格以此为准反向拆解秒杀路径）】${params.knownCorrectAnswer}`
      : '',
    params.officialAnalysisHint ? `【原题参考解析线索】\n${params.officialAnalysisHint}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const canAttachImages =
    !settings.splitVisionAndReasoning &&
    settings.ocrFallbackMode !== 'force_ocr' &&
    !isKnownTextOnlyModel(endpoint.modelName) &&
    Boolean(params.imagesForContext?.length);

  const raw = await callModelEndpoint(
    endpoint,
    systemPrompt,
    promptLines,
    canAttachImages ? params.imagesForContext : []
  );
  const parsed = extractFirstJsonObject(raw);

  const aligned = ensureTaxonomyAlignment(
    String(parsed.moduleL1 || params.moduleL1),
    String(parsed.categoryL2 || params.categoryL2 || ''),
    String(parsed.motherTypeL3 || params.motherTypeL3 || '')
  );

  const validReasonSet = new Set<string>(ERROR_REASONS.map((r) => r.value));
  const suggestedErrorReason: ErrorReason = validReasonSet.has(parsed.suggestedErrorReason)
    ? (parsed.suggestedErrorReason as ErrorReason)
    : '公式方法不熟';

  const finalCorrect = (
    params.knownCorrectAnswer ||
    String(parsed.correctAnswer || 'A')
  )
    .trim()
    .toUpperCase()
    .slice(0, 1);

  return {
    ...aligned,
    correctAnswer: finalCorrect,
    suggestedErrorReason,
    anchorKeywords: Array.isArray(parsed.anchorKeywords)
      ? parsed.anchorKeywords.map((x: any) => String(x).trim()).filter(Boolean)
      : [aligned.motherTypeL3],
    pitfallWarning: String(parsed.pitfallWarning || '').trim(),
    aiFastSolution: String(parsed.aiFastSolution || '').trim(),
  };
}

export async function askFollowUpTutor(
  mistake: MistakeRecord,
  userQuestion: string,
  settings: AISettings
): Promise<string> {
  const endpoint = settings.splitVisionAndReasoning
    ? settings.reasoningModel
    : settings.visionModel;

  const methodCard = METHOD_CARDS_BY_MODULE[mistake.moduleL1];
  const systemPrompt = `你是考生的专属公考行测复盘私教。当前正在针对下方这道错题答疑，请一针见血、通俗简明地解答考生的追问。

${methodCard}

【当前错题上下文】
- 模块与母题：${mistake.moduleL1} > ${mistake.categoryL2} > ${mistake.motherTypeL3}
${mistake.materialText ? `- 材料：${mistake.materialText}\n` : ''}- 题干：${mistake.stemText}
- 选项：${mistake.options.map((o) => `${o.key}.${o.text}`).join(' | ')}
- 正确答案：${mistake.correctAnswer}（考生曾错选：${mistake.myWrongAnswer || '未记录'}）
- 已有秒杀解析：${mistake.aiFastSolution}`;

  return callModelEndpoint(
    endpoint,
    systemPrompt,
    userQuestion,
    [],
    mistake.chatHistory.slice(-8)
  );
}

export async function testEndpointConnectivity(endpoint: ModelEndpointConfig): Promise<string> {
  const reply = await callModelEndpoint(
    endpoint,
    '你是一个连通性测试助手。',
    '请仅回复“连接成功”四个字。'
  );
  return reply.slice(0, 60);
}
