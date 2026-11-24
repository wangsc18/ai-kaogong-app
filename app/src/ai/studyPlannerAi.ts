import {
  callModelEndpoint,
  extractFirstJsonObject,
  ImageInputPayload,
} from './aiClient';
import { PdfExtractionOutput } from '../components/PdfExtractorWebView';
import { extractTextViaFallbackOcr } from '../services/ocrFallbackService';
import { flattenTaxonomyText, normalizeModuleL1 } from '../taxonomy/kaogongTaxonomy';
import {
  AISettings,
  AppPracticeSnapshot,
  CourseMaterialDoc,
  DailyTaskItem,
  MaterialDocType,
  StudyPlanChapter,
  StudyPlanState,
} from '../types/models';

function pickPlanningEndpoint(settings: AISettings) {
  if (settings.splitVisionAndReasoning && settings.reasoningModel.apiKey.trim()) {
    return settings.reasoningModel;
  }
  return settings.visionModel.apiKey.trim()
    ? settings.visionModel
    : settings.reasoningModel;
}

/**
 * 新一代「多 PDF 一次性统一合并分析」引擎：
 * 支持用户先在本地导入多份讲义 + 刷题集 PDF（导入阶段 0 大模型调用），
 * 点击「开始综合分析」时，仅用 **1 次大模型请求** 同时完成：
 * 1) 所有待分析 PDF 的章节目录结构、题量与老师讲题风格提取；
 * 2) 全部讲义与刷题集的跨文档协同路线图（chapters）；
 * 3) 名师做题心法画像（teacherPersona）、总进度百分比测算与每日任务安排！
 */
export async function analyzeBatchMaterialsAndSynthesizePlan(params: {
  materials: CourseMaterialDoc[];
  practiceSnapshot: AppPracticeSnapshot;
  existingPlan: StudyPlanState | null;
  settings: AISettings;
  onProgress?: (msg: string) => void;
}): Promise<{
  updatedMaterials: CourseMaterialDoc[];
  nextPlan: StudyPlanState;
}> {
  const { materials, practiceSnapshot, existingPlan, settings, onProgress } = params;
  if (materials.length === 0) {
    throw new Error('请先至少添加一份 PDF 讲义或刷题集');
  }

  const pendingDocs = materials.filter(
    (m) => m.analysisStatus === 'pending' || (!m.outlineDigest && m.rawExtractedPayload)
  );

  // 若没有新上传待分析的 PDF，仅基于已有摘要重新测算总计划（同样只调 1 次大模型）
  if (pendingDocs.length === 0) {
    onProgress?.('正在结合全部资料摘要与刷题记录生成学习规划...');
    const nextPlan = await synthesizeMasterStudyPlan({
      materials,
      practiceSnapshot,
      existingPlan,
      settings,
    });
    return { updatedMaterials: materials, nextPlan };
  }

  // 1. 预处理待分析资料：若包含纯扫描图片版 PDF，先提取抽样页文字
  const pendingResolvedTexts = new Map<
    string,
    { outlineText: string; bodyText: string }
  >();

  for (let i = 0; i < pendingDocs.length; i++) {
    const doc = pendingDocs[i];
    let parsedRaw: PdfExtractionOutput | null = null;
    try {
      parsedRaw = doc.rawExtractedPayload
        ? (JSON.parse(doc.rawExtractedPayload) as PdfExtractionOutput)
        : null;
    } catch {
      parsedRaw = null;
    }

    let bodyText = parsedRaw?.sampledText || '';
    const outlineText = parsedRaw?.outlineText || '';

    if (parsedRaw?.isScannedPdf && parsedRaw.scannedPageImages?.length) {
      onProgress?.(
        `正在识别扫描版 PDF (${i + 1}/${pendingDocs.length})《${doc.fileName}》页面文字...`
      );
      const imgPayloads: ImageInputPayload[] = parsedRaw.scannedPageImages.map((sp) => ({
        label: '资料材料图',
        base64: sp.base64,
        mimeType: 'image/jpeg',
      }));
      try {
        bodyText = await callModelEndpoint(
          settings.visionModel,
          '请完整准确识别这些公考 PDF 讲义/刷题集页面的目录、标题、例题与老师讲解文字。',
          `文件名：${doc.fileName}（共 ${doc.totalPages} 页），请逐页提取核心文字内容。`,
          imgPayloads
        );
      } catch {
        bodyText = await extractTextViaFallbackOcr(imgPayloads, {
          mode: 'force_ocr',
          localMacOcrUrl: settings.localMacOcrUrl || '',
          ocrSpaceApiKey: settings.ocrSpaceApiKey || 'helloworld',
        });
      }
    }

    pendingResolvedTexts.set(doc.id, { outlineText, bodyText });
  }

  // 2. 按文档数量动态分配单次上下文字符预算（保证多份 PDF 同窗对照且绝不超长）
  const perDocCharBudget = Math.min(
    26000,
    Math.max(5500, Math.floor(44000 / Math.max(1, pendingDocs.length)))
  );

  const endpoint = pickPlanningEndpoint(settings);
  const dailyBudget = existingPlan?.dailyMinutesBudget || 120;

  onProgress?.(
    `AI 正在一次性统合分析全部 ${materials.length} 份 PDF 讲义与刷题集并排定计划...`
  );

  const systemPrompt = `你是一位顶尖的公考私人教务规划师与教研总监。
用户一次性提交了多份公考备考 PDF 资料（包含新上传待解析的原始 PDF 抽样正文，以及可能已解析过的旧资料摘要）。
请你【在同一全局视野下】将讲义与配套刷题集交叉比对，一次性完成单文档建档与整体学习规划：

1. 【各待解析资料建档 (materialAnalyses)】：针对每一份标记为“待解析”的资料，识别其定位（讲义 lecture / 刷题集 workbook / 讲练合一 mixed）、所属模块、预估总题数、章节页码结构摘要（outlineDigest，150~300字）以及体现出的老师讲题思路笔记（teacherStyleNotes，120~250字）。
2. 【整体学习内容计划 (overallAnalysis & chapters)】：梳理所有讲义与刷题集如何前后衔接、讲练配合（例如看完某讲义第几页后立刻刷哪本刷题集的第几页/第几题），拆解出 5~12 个结构化章节（chapters），精确标注 sourceRef 并关联下方标准三级母题考点。
3. 【老师的讲题与做题思路风格 (teacherPersona)】：综合讲义提炼老师的流派标签、核心做题心法、标志性秒杀技巧/口诀、标准解题步骤流与防坑习惯。
4. 【当前进度百分比诊断与每日任务】：结合各资料已读页数、已刷题数及 App 内真实错题轨迹，测算当前总进度百分比（0~100整数）、诊断当前所处阶段与剩余内容，并按每天 ${dailyBudget} 分钟预算生成接下来可执行的每日任务清单（4~7条）。

【App 标准三级母题考点树（供 relatedMotherTypes 关联选择）】
${flattenTaxonomyText()}

请严格且仅输出如下 JSON 对象（不要输出任何额外说明）：
{
  "materialAnalyses": [
    {
      "materialId": "对应待解析资料的 materialId",
      "docType": "lecture|workbook|mixed 之一",
      "moduleScope": "如 资料分析 / 判断推理 / 行测综合",
      "totalQuestionsEst": 0,
      "outlineDigest": "章节/套卷结构与对应页码范围摘要",
      "teacherStyleNotes": "该资料体现的老师讲题思路、秒杀口诀与解题步骤特点"
    }
  ],
  "planTitle": "计划总名称（如：资料+判断讲练一体冲刺计划）",
  "overallAnalysis": "整体学习内容计划全景解读（说明阶段划分及讲义与刷题集如何配合使用）",
  "teacherPersona": {
    "teacherNameOrTag": "识别出的老师姓名或讲题风格标签",
    "corePhilosophy": "一句话核心做题理念与考场思维",
    "signatureTechniques": ["标志性技巧1", "标志性技巧2", "标志性技巧3"],
    "solvingStepsTemplate": "第一步... → 第二步... → 第三步...",
    "pitfallHabits": "老师反复强调的审题防坑习惯"
  },
  "chapters": [
    {
      "id": "ch_1",
      "stageName": "第一阶段：基础方法筑基",
      "title": "章节标题",
      "moduleL1": "资料分析|判断推理|言语理解|数量关系|政治理论|常识判断 之一",
      "relatedMotherTypes": ["标准树中的三级母题名"],
      "sourceRef": "明确对应哪本讲义第几页 + 哪本刷题集第几页/题号",
      "estimatedHours": 3,
      "progressPercent": 0,
      "keyTakeaways": "本章核心解题要领"
    }
  ],
  "overallProgressPercent": 0,
  "currentStageDiagnosis": "智能判断当前学到了哪一步、掌握情况如何",
  "remainingSummary": "清晰列出还剩多少页讲义、多少道刷题集题目、预计还需多少天完成",
  "dailyTasks": [
    {
      "id": "task_1",
      "dayLabel": "今日任务",
      "title": "具体可执行的看讲义页码 + 刷题集页码/题号任务",
      "targetMinutes": 45,
      "chapterId": "ch_1"
    }
  ]
}`;

  const docsPromptBlocks = materials.map((m, idx) => {
    const pendingData = pendingResolvedTexts.get(m.id);
    if (pendingData) {
      return [
        `### 【待解析新资料 ${idx + 1}】materialId="${m.id}" 《${m.fileName}》（共 ${m.totalPages} 页，当前已学第 ${m.currentPage} 页）`,
        pendingData.outlineText ? `【PDF 书签目录树】\n${pendingData.outlineText}` : '',
        `【PDF 抽样页面正文】\n${pendingData.bodyText.slice(0, perDocCharBudget)}`,
      ]
        .filter(Boolean)
        .join('\n');
    }

    return [
      `### 【已建档资料 ${idx + 1}（无需重复输出到 materialAnalyses，但需纳入整体计划）】materialId="${m.id}" 《${m.fileName}》`,
      `- 类型：${m.docType} | 模块：${m.moduleScope} | 进度：第 ${m.currentPage}/${m.totalPages} 页，已刷 ${m.completedQuestionsEst}/${m.totalQuestionsEst} 题`,
      `- 目录结构摘要：${m.outlineDigest}`,
      `- 讲题风格记录：${m.teacherStyleNotes}`,
    ].join('\n');
  });

  const existingChaptersDesc = existingPlan?.chapters?.length
    ? `\n【已有章节完成度记录（供延续参考）】\n` +
      existingPlan.chapters
        .map((c) => `- ${c.title}: 已完成 ${c.progressPercent}%`)
        .join('\n')
    : '';

  const snapshotDesc =
    `【考生在 App 内的真实做题与错题轨迹】\n` +
    `- 累计录入错题：${practiceSnapshot.totalMistakes} 道（已彻底掌握 ${practiceSnapshot.masteredMistakes} 道）\n` +
    `- 累计在 App 内练习真题次数：${practiceSnapshot.totalPracticeAttempts} 次（正确 ${practiceSnapshot.correctPracticeAttempts} 次）\n` +
    (practiceSnapshot.weakMotherTypes.length
      ? `- 高频薄弱母题：${practiceSnapshot.weakMotherTypes.join('、')}`
      : '');

  const raw = await callModelEndpoint(
    endpoint,
    systemPrompt,
    `${docsPromptBlocks.join('\n\n====================\n\n')}\n\n${snapshotDesc}\n${existingChaptersDesc}\n\n【每日可学习时长预算】${dailyBudget} 分钟/天`
  );

  const parsed = extractFirstJsonObject(raw);
  const rawMatAnalyses: any[] = Array.isArray(parsed.materialAnalyses)
    ? parsed.materialAnalyses
    : [];

  const matAnalysisMap = new Map<string, any>();
  for (const ma of rawMatAnalyses) {
    if (ma && ma.materialId) {
      matAnalysisMap.set(String(ma.materialId), ma);
    }
  }

  const now = Date.now();
  const updatedMaterials: CourseMaterialDoc[] = materials.map((m, idx) => {
    if (!pendingResolvedTexts.has(m.id)) {
      return m;
    }
    // 优先按 materialId 精确匹配，若模型漏填 ID 且数量一致则按顺序兜底
    const pendingIdx = pendingDocs.findIndex((p) => p.id === m.id);
    const ma =
      matAnalysisMap.get(m.id) ||
      (rawMatAnalyses.length === pendingDocs.length ? rawMatAnalyses[pendingIdx] : null) ||
      {};

    const rawType = String(ma.docType || '').toLowerCase();
    const inferredType: MaterialDocType =
      rawType === 'workbook' || rawType === 'mixed'
        ? rawType
        : /刷题|题集|套卷|真题|练习|作业/.test(m.fileName)
        ? 'workbook'
        : 'lecture';

    return {
      ...m,
      docType: inferredType,
      moduleScope: String(ma.moduleScope || m.moduleScope || '行测专项').trim(),
      totalQuestionsEst: Math.max(0, Number(ma.totalQuestionsEst ?? m.totalQuestionsEst ?? 0)),
      outlineDigest:
        String(ma.outlineDigest || '').trim() ||
        `《${m.fileName}》共 ${m.totalPages} 页（第 ${idx + 1} 份备考资料）`,
      teacherStyleNotes:
        String(ma.teacherStyleNotes || '').trim() ||
        String(parsed.teacherPersona?.corePhilosophy || '实战方法讲练体系'),
      analysisStatus: 'analyzed',
      rawExtractedPayload: '',
      updatedAt: now,
    };
  });

  const rawChapters: any[] = Array.isArray(parsed.chapters) ? parsed.chapters : [];
  const chapters: StudyPlanChapter[] = rawChapters.map((c, idx) => ({
    id: String(c.id || `ch_${idx + 1}`),
    orderIndex: idx + 1,
    stageName: String(c.stageName || '核心阶段'),
    title: String(c.title || `第 ${idx + 1} 节`),
    moduleL1: normalizeModuleL1(c.moduleL1),
    relatedMotherTypes: Array.isArray(c.relatedMotherTypes)
      ? c.relatedMotherTypes.map(String)
      : [],
    sourceRef: String(c.sourceRef || ''),
    estimatedHours: Math.max(0.5, Number(c.estimatedHours || 2)),
    progressPercent: Math.min(100, Math.max(0, Math.round(Number(c.progressPercent || 0)))),
    keyTakeaways: String(c.keyTakeaways || ''),
  }));

  const rawTasks: any[] = Array.isArray(parsed.dailyTasks) ? parsed.dailyTasks : [];
  const dailyTasks: DailyTaskItem[] = rawTasks.map((t, idx) => ({
    id: String(t.id || `dt_${now}_${idx}`),
    dayLabel: String(t.dayLabel || '今日任务'),
    title: String(t.title || ''),
    targetMinutes: Math.max(10, Number(t.targetMinutes || 40)),
    chapterId: t.chapterId ? String(t.chapterId) : undefined,
    completed: false,
  }));

  const tp = parsed.teacherPersona || {};
  const nextPlan: StudyPlanState = {
    planTitle: String(parsed.planTitle || '我的公考讲练进阶计划'),
    overallAnalysis: String(parsed.overallAnalysis || '').trim(),
    teacherPersona: {
      teacherNameOrTag: String(tp.teacherNameOrTag || '讲义实战流派'),
      corePhilosophy: String(tp.corePhilosophy || ''),
      signatureTechniques: Array.isArray(tp.signatureTechniques)
        ? tp.signatureTechniques.map(String)
        : [],
      solvingStepsTemplate: String(tp.solvingStepsTemplate || ''),
      pitfallHabits: String(tp.pitfallHabits || ''),
      enableInMistakeSolver: existingPlan?.teacherPersona?.enableInMistakeSolver ?? true,
    },
    chapters,
    overallProgressPercent: Math.min(
      100,
      Math.max(0, Math.round(Number(parsed.overallProgressPercent || 0)))
    ),
    currentStageDiagnosis: String(parsed.currentStageDiagnosis || '').trim(),
    remainingSummary: String(parsed.remainingSummary || '').trim(),
    dailyMinutesBudget: dailyBudget,
    dailyTasks,
    plannerChatHistory: existingPlan?.plannerChatHistory || [],
    updatedAt: now,
  };

  return { updatedMaterials, nextPlan };
}

/**
 * 步骤 1（单文件备用接口）：对单个 PDF 进行结构提取
 */
export async function analyzeUploadedPdfMaterial(params: {
  fileName: string;
  extracted: PdfExtractionOutput;
  settings: AISettings;
  onProgress?: (msg: string) => void;
}): Promise<Omit<CourseMaterialDoc, 'id' | 'createdAt' | 'updatedAt'>> {
  const { fileName, extracted, settings, onProgress } = params;
  let bodyText = extracted.sampledText || '';

  // 若是纯扫描图片版 PDF，先走多模态或备用 OCR 读取关键抽样页文字
  if (extracted.isScannedPdf && extracted.scannedPageImages.length > 0) {
    onProgress?.('正在识别扫描版 PDF 关键页面内容...');
    const imgPayloads: ImageInputPayload[] = extracted.scannedPageImages.map((sp) => ({
      label: '资料材料图',
      base64: sp.base64,
      mimeType: 'image/jpeg',
    }));
    try {
      bodyText = await callModelEndpoint(
        settings.visionModel,
        '请完整准确识别这些公考 PDF 讲义/刷题集页面的目录、标题、例题与老师讲解文字。',
        `文件名：${fileName}（共 ${extracted.totalPages} 页），请逐页提取核心文字内容。`,
        imgPayloads
      );
    } catch {
      bodyText = await extractTextViaFallbackOcr(imgPayloads, {
        mode: 'force_ocr',
        localMacOcrUrl: settings.localMacOcrUrl || '',
        ocrSpaceApiKey: settings.ocrSpaceApiKey || 'helloworld',
      });
    }
  }

  onProgress?.('AI 正在剖析 PDF 章节结构与老师的讲题思路风格...');
  const endpoint = pickPlanningEndpoint(settings);

  const systemPrompt = `你是一位资深公考教研总监。用户上传了一份 PDF 格式的公考备考资料（可能是老师的上课讲义、配套刷题集、或讲练合一讲义）。
请仔细阅读提取出的书签大纲与抽样页面正文，完成两项深度提炼：
1. 识别该文件的定位（讲义 lecture / 刷题集 workbook / 讲练合一 mixed）、涵盖的行测模块、总题量预估，以及清晰的【分章/分专题页码与题量目录摘要】；
2. 深度提炼文件中【这位老师的讲题思路、做题套路、标志性口诀/术语与审题风格】（例如：是否强调先看选项截位、415份数法、画圈找对应词、搭桥拆桥力度对比等；若是纯刷题集含解析，提炼解析的推导风格）。

请严格且仅输出如下 JSON 对象：
{
  "docType": "lecture|workbook|mixed 之一",
  "moduleScope": "如 资料分析 / 判断推理 / 言语理解 / 行测综合 等",
  "totalQuestionsEst": 0,
  "outlineDigest": "详细清晰的章节/套卷结构与对应页码范围、每部分核心内容摘要（300~600字）",
  "teacherStyleNotes": "深度总结文件中体现的老师讲题思路、秒杀技巧体系、常用术语口诀与做题步骤习惯（250~500字）"
}`;

  const userPrompt = [
    `【文件名】${fileName}`,
    `【PDF 总页数】${extracted.totalPages} 页`,
    extracted.outlineText ? `【PDF 书签目录树】\n${extracted.outlineText}` : '',
    `【PDF 抽样页面正文内容】\n${bodyText.slice(0, 28000)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const raw = await callModelEndpoint(endpoint, systemPrompt, userPrompt);
  const parsed = extractFirstJsonObject(raw);

  const rawType = String(parsed.docType || 'lecture').toLowerCase();
  const docType: MaterialDocType =
    rawType === 'workbook' || rawType === 'mixed' ? rawType : 'lecture';

  return {
    fileName,
    docType,
    moduleScope: String(parsed.moduleScope || '行测专项').trim(),
    totalPages: extracted.totalPages,
    currentPage: 0,
    totalQuestionsEst: Math.max(0, Number(parsed.totalQuestionsEst || 0)),
    completedQuestionsEst: 0,
    outlineDigest: String(parsed.outlineDigest || '').trim(),
    teacherStyleNotes: String(parsed.teacherStyleNotes || '').trim(),
  };
}

/**
 * 步骤 2：综合所有已上传的讲义 + 刷题集 + 当前刷题进度，生成/刷新三大核心报告：
 * 1) 整体学习内容计划蓝图；
 * 2) 老师的讲题与做题思路风格卡；
 * 3) 当前学习到哪一步（百分比%）、剩余内容测算与每日任务安排。
 */
export async function synthesizeMasterStudyPlan(params: {
  materials: CourseMaterialDoc[];
  practiceSnapshot: AppPracticeSnapshot;
  existingPlan: StudyPlanState | null;
  settings: AISettings;
}): Promise<StudyPlanState> {
  const { materials, practiceSnapshot, existingPlan, settings } = params;
  if (materials.length === 0) {
    throw new Error('请先至少上传一份 PDF 讲义或刷题集');
  }

  const endpoint = pickPlanningEndpoint(settings);
  const dailyBudget = existingPlan?.dailyMinutesBudget || 120;

  const systemPrompt = `你是一位顶尖的公考私人教务规划师与教研专家。
请根据考生上传的全部 PDF 课程讲义与刷题集摘要、当前的阅读/刷题页码进度、以及 App 内的真实做题和错题数据，进行全方位分析并输出结构化方案：

必须高质量完成以下三大核心任务：
1. 【整体学习内容计划】：梳理讲义与刷题集如何科学配合推进，拆解出按先后顺序排列的 5~12 个结构化学习章节（chapters），标明每章对应哪份 PDF 的页码/题号区间，并关联下方的标准三级母题考点。
2. 【老师的讲题与做题思路风格】：凝练出讲义中老师的流派特点、核心做题心法（corePhilosophy）、标志性秒杀技巧/口诀列表（signatureTechniques）、考场标准解题步骤模板（solvingStepsTemplate）以及防坑审题习惯（pitfallHabits）。
3. 【当前进度百分比诊断与每日任务】：结合考生已推进的讲义页数、已刷题数、已勾选章节进度以及 App 内的刷题错题记录，精准计算当前处于整体计划的百分之多少（overallProgressPercent: 0~100整数）、判断目前学到了哪一步（currentStageDiagnosis）、还剩多少章节/页数/题量待学（remainingSummary），并按每天 ${dailyBudget} 分钟预算生成接下来可落地的每日任务清单（dailyTasks，4~7条）。

【App 标准三级母题考点树（供 relatedMotherTypes 关联选择）】
${flattenTaxonomyText()}

请严格且仅输出如下 JSON 对象：
{
  "planTitle": "计划总名称（如：资料分析讲练一体进阶计划）",
  "overallAnalysis": "目前的整体学习内容计划全景解读（分段清晰，说明阶段划分、讲义与刷题集配合策略）",
  "teacherPersona": {
    "teacherNameOrTag": "识别出的老师姓名或讲题风格标签（如：花生十三速算体系 / 实战份数流派）",
    "corePhilosophy": "一句话核心做题理念与考场思维",
    "signatureTechniques": ["标志性技巧1", "标志性技巧2", "标志性技巧3"],
    "solvingStepsTemplate": "第一步... → 第二步... → 第三步...",
    "pitfallHabits": "老师反复强调的审题防坑习惯"
  },
  "chapters": [
    {
      "id": "ch_1",
      "stageName": "第一阶段：基础方法筑基",
      "title": "章节标题",
      "moduleL1": "资料分析|判断推理|言语理解|数量关系|政治理论|常识判断 之一",
      "relatedMotherTypes": ["标准树中的三级母题名"],
      "sourceRef": "对应讲义页码与刷题集页码/题量",
      "estimatedHours": 3,
      "progressPercent": 0,
      "keyTakeaways": "本章核心解题要领"
    }
  ],
  "overallProgressPercent": 0,
  "currentStageDiagnosis": "智能判断当前学到了哪一步、掌握情况如何",
  "remainingSummary": "清晰列出还剩多少页讲义、多少道刷题集题目、预计按每日时长还需多少天完成",
  "dailyTasks": [
    {
      "id": "task_1",
      "dayLabel": "今日任务",
      "title": "具体可执行的听课/看讲义页码/刷题题号/错题复盘任务",
      "targetMinutes": 45,
      "chapterId": "ch_1"
    }
  ]
}`;

  const materialsDesc = materials
    .map(
      (m, i) =>
        `【资料 ${i + 1}：${m.fileName}】\n` +
        `- 类型：${m.docType === 'lecture' ? '老师讲义' : m.docType === 'workbook' ? '配套刷题集' : '讲练合一'} | 模块：${m.moduleScope}\n` +
        `- 当前页码进度：已学到第 ${m.currentPage} / 共 ${m.totalPages} 页 (${Math.round((m.currentPage / Math.max(1, m.totalPages)) * 100)}%)\n` +
        (m.totalQuestionsEst > 0
          ? `- 刷题集题量进度：已刷 ${m.completedQuestionsEst} / 预估共 ${m.totalQuestionsEst} 题\n`
          : '') +
        `- 目录与内容结构：\n${m.outlineDigest}\n` +
        `- 老师讲题思路摘录：\n${m.teacherStyleNotes}`
    )
    .join('\n\n====================\n\n');

  const existingChaptersDesc = existingPlan?.chapters?.length
    ? `\n【已有章节完成度记录（供延续参考）】\n` +
      existingPlan.chapters
        .map((c) => `- ${c.title}: 已完成 ${c.progressPercent}%`)
        .join('\n')
    : '';

  const snapshotDesc =
    `【考生在 App 内的真实做题与错题轨迹】\n` +
    `- 累计录入错题：${practiceSnapshot.totalMistakes} 道（已彻底掌握 ${practiceSnapshot.masteredMistakes} 道）\n` +
    `- 累计在 App 内练习真题次数：${practiceSnapshot.totalPracticeAttempts} 次（正确 ${practiceSnapshot.correctPracticeAttempts} 次）\n` +
    `- 各模块练习统计：${practiceSnapshot.byModule.map((b) => `${b.moduleL1}(练${b.practicedCount}题/正确率${b.accuracyPercent}%/错题${b.mistakeCount}道)`).join('；')}\n` +
    (practiceSnapshot.weakMotherTypes.length
      ? `- 高频薄弱母题：${practiceSnapshot.weakMotherTypes.join('、')}`
      : '');

  const raw = await callModelEndpoint(
    endpoint,
    systemPrompt,
    `${materialsDesc}\n\n${snapshotDesc}\n${existingChaptersDesc}\n\n【考生当前设定的每日可学习时长】${dailyBudget} 分钟/天`
  );

  const parsed = extractFirstJsonObject(raw);
  const rawChapters: any[] = Array.isArray(parsed.chapters) ? parsed.chapters : [];

  const chapters: StudyPlanChapter[] = rawChapters.map((c, idx) => ({
    id: String(c.id || `ch_${idx + 1}`),
    orderIndex: idx + 1,
    stageName: String(c.stageName || '核心阶段'),
    title: String(c.title || `第 ${idx + 1} 节`),
    moduleL1: normalizeModuleL1(c.moduleL1),
    relatedMotherTypes: Array.isArray(c.relatedMotherTypes)
      ? c.relatedMotherTypes.map(String)
      : [],
    sourceRef: String(c.sourceRef || ''),
    estimatedHours: Math.max(0.5, Number(c.estimatedHours || 2)),
    progressPercent: Math.min(100, Math.max(0, Math.round(Number(c.progressPercent || 0)))),
    keyTakeaways: String(c.keyTakeaways || ''),
  }));

  const rawTasks: any[] = Array.isArray(parsed.dailyTasks) ? parsed.dailyTasks : [];
  const dailyTasks: DailyTaskItem[] = rawTasks.map((t, idx) => ({
    id: String(t.id || `dt_${Date.now()}_${idx}`),
    dayLabel: String(t.dayLabel || '今日任务'),
    title: String(t.title || ''),
    targetMinutes: Math.max(10, Number(t.targetMinutes || 40)),
    chapterId: t.chapterId ? String(t.chapterId) : undefined,
    completed: false,
  }));

  const tp = parsed.teacherPersona || {};

  return {
    planTitle: String(parsed.planTitle || '我的公考讲练进阶计划'),
    overallAnalysis: String(parsed.overallAnalysis || '').trim(),
    teacherPersona: {
      teacherNameOrTag: String(tp.teacherNameOrTag || '讲义实战流派'),
      corePhilosophy: String(tp.corePhilosophy || ''),
      signatureTechniques: Array.isArray(tp.signatureTechniques)
        ? tp.signatureTechniques.map(String)
        : [],
      solvingStepsTemplate: String(tp.solvingStepsTemplate || ''),
      pitfallHabits: String(tp.pitfallHabits || ''),
      enableInMistakeSolver: existingPlan?.teacherPersona?.enableInMistakeSolver ?? true,
    },
    chapters,
    overallProgressPercent: Math.min(
      100,
      Math.max(0, Math.round(Number(parsed.overallProgressPercent || 0)))
    ),
    currentStageDiagnosis: String(parsed.currentStageDiagnosis || '').trim(),
    remainingSummary: String(parsed.remainingSummary || '').trim(),
    dailyMinutesBudget: dailyBudget,
    dailyTasks,
    plannerChatHistory: existingPlan?.plannerChatHistory || [],
    updatedAt: Date.now(),
  };
}

/**
 * 步骤 3：与 AI 学伴对话汇报刷题进度、商量每天的任务量与动态重排计划
 */
export interface ScheduleNegotiationResult {
  reply: string;
  updatedOverallProgressPercent?: number | null;
  updatedStageDiagnosis?: string | null;
  updatedRemainingSummary?: string | null;
  updatedDailyMinutesBudget?: number | null;
  materialUpdates?: Array<{
    materialId: string;
    currentPage?: number;
    completedQuestionsEst?: number;
  }>;
  chapterUpdates?: Array<{
    chapterId: string;
    progressPercent: number;
  }>;
  updatedDailyTasks?: Array<{
    dayLabel: string;
    title: string;
    targetMinutes: number;
    chapterId?: string;
  }> | null;
}

export async function negotiateScheduleWithAi(params: {
  userMessage: string;
  plan: StudyPlanState;
  materials: CourseMaterialDoc[];
  practiceSnapshot: AppPracticeSnapshot;
  settings: AISettings;
}): Promise<ScheduleNegotiationResult> {
  const { userMessage, plan, materials, practiceSnapshot, settings } = params;
  const endpoint = pickPlanningEndpoint(settings);

  const systemPrompt = `你是考生的专属公考备考规划师与督学搭子。你完全掌握考生上传的所有讲义与刷题集目录、老师讲题方法体系、当前各章节完成百分比以及 App 内的错题薄弱点。

考生会向你汇报最新刷题/看课进度（例如“我讲义看到第50页了”、“刷题集做完前200题了”），或者和你商量调整每天的时间安排与每日任务（例如“这周加班每天只有1小时”、“两期比重老错明天想加练”）。

请你：
1. 在 reply 中给出清晰、务实、有温度的回应（明确告诉他目前整体推进到了百分之几、处于哪一步、还剩多少内容，以及新的每日任务为什么这么安排）；
2. 若考生汇报了新进度或要求调整每日计划，请同步在 JSON 对应字段输出精确的数据更新，前端会直接实时刷新进度条和任务清单！（若某项无需修改则填 null 或空数组）。

请严格且仅输出如下 JSON 对象：
{
  "reply": "给考生的自然对话回复（条理清晰，直接回应他的进度变化或排期诉求）",
  "updatedOverallProgressPercent": null,
  "updatedStageDiagnosis": null,
  "updatedRemainingSummary": null,
  "updatedDailyMinutesBudget": null,
  "materialUpdates": [
    {"materialId": "资料ID", "currentPage": 50, "completedQuestionsEst": 200}
  ],
  "chapterUpdates": [
    {"chapterId": "ch_1", "progressPercent": 100}
  ],
  "updatedDailyTasks": [
    {"dayLabel": "今日任务", "title": "具体任务描述（精确到讲义页码/刷题集题号）", "targetMinutes": 45, "chapterId": "ch_2"}
  ]
}`;

  const contextText = [
    `【当前学习计划】${plan.planTitle}（当前总进度：${plan.overallProgressPercent}%，每日预算：${plan.dailyMinutesBudget} 分钟）`,
    `【当前阶段诊断】${plan.currentStageDiagnosis}`,
    `【剩余内容概览】${plan.remainingSummary}`,
    `【已上传的 PDF 资料列表（注意 materialId）】\n` +
      materials
        .map(
          (m) =>
            `- materialId="${m.id}" 《${m.fileName}》(${m.docType}): 当前第 ${m.currentPage}/${m.totalPages} 页，已刷 ${m.completedQuestionsEst}/${m.totalQuestionsEst} 题`
        )
        .join('\n'),
    `【各章节蓝图（注意 chapterId）】\n` +
      plan.chapters
        .map(
          (c) =>
            `- chapterId="${c.id}" [${c.stageName}] ${c.title} (${c.sourceRef}) -> 完成度 ${c.progressPercent}%`
        )
        .join('\n'),
    `【当前每日任务清单】\n` +
      plan.dailyTasks
        .map((t) => `- [${t.completed ? '已完成' : '待办'}][${t.dayLabel}] ${t.title} (${t.targetMinutes}分钟)`)
        .join('\n'),
    `【App 刷题与错题实况】累计错题 ${practiceSnapshot.totalMistakes} 道，薄弱母题：${practiceSnapshot.weakMotherTypes.join('、') || '暂无'}`,
    `\n【考生最新发言】\n${userMessage}`,
  ].join('\n\n');

  const raw = await callModelEndpoint(
    endpoint,
    systemPrompt,
    contextText,
    [],
    plan.plannerChatHistory.slice(-8)
  );
  return extractFirstJsonObject(raw) as ScheduleNegotiationResult;
}
