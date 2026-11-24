export type ModuleL1 =
  | '政治理论'
  | '常识判断'
  | '言语理解'
  | '数量关系'
  | '判断推理'
  | '资料分析';

export type ErrorReason =
  | '审题掉坑'
  | '公式方法不熟'
  | '概念成语混淆'
  | '图推特征盲区'
  | '纯粗心算错'
  | '耗时过长';

export type MasteryStatus = 'learning' | 'reviewing' | 'mastered';

export interface QuestionOption {
  key: 'A' | 'B' | 'C' | 'D' | string;
  text: string;
  image?: string | null;
}

/** 本地只读真题库标准结构 */
export interface RealQuestion {
  qid: string;
  sourceExam: string;
  year: number;
  province: string;
  moduleL1: ModuleL1;
  categoryL2: string;
  motherTypeL3: string;
  materialId?: string | null;
  materialText?: string | null;
  materialImages: string[];
  stem: string;
  stemImages: string[];
  options: QuestionOption[];
  answer: string;
  officialAnalysis: string;
  fastTips: string;
  anchorKeywords: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface CaptureImagesBundle {
  stemImageUri?: string | null;
  materialImageUri?: string | null;
  answerImageUri?: string | null;
}

/** 个人错题本主记录 */
export interface MistakeRecord {
  id: string;
  /** 若命中本地真题库原题则绑定 qid（智能双轨还原轨道 1） */
  matchedQid?: string | null;
  matchedSourceExam?: string | null;
  captureImages: CaptureImagesBundle;
  moduleL1: ModuleL1;
  categoryL2: string;
  motherTypeL3: string;
  anchorKeywords: string[];
  materialText?: string | null;
  materialImages: string[];
  stemText: string;
  stemImages: string[];
  options: QuestionOption[];
  correctAnswer: string;
  myWrongAnswer: string;
  errorReason: ErrorReason;
  aiFastSolution: string;
  pitfallWarning: string;
  chatHistory: ChatTurn[];
  userNote: string;
  // SM-2 遗忘曲线字段
  repetitions: number;
  easinessFactor: number;
  intervalDays: number;
  nextReviewAt: number;
  lastTimeSpentSec: number;
  masteryStatus: MasteryStatus;
  createdAt: number;
  updatedAt: number;
}

export interface PracticeLog {
  id: string;
  targetType: 'mistake' | 'real_question';
  targetId: string;
  sourceMistakeId?: string | null;
  selectedAnswer: string;
  isCorrect: boolean;
  timeSpentSec: number;
  createdAt: number;
}

export type AIProviderProtocol = 'openai' | 'gemini';

export interface ModelEndpointConfig {
  protocol: AIProviderProtocol;
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

export interface AISettings {
  /** 是否将「多模态识图模型」与「深度推理讲题模型」拆开配置 */
  splitVisionAndReasoning: boolean;
  visionModel: ModelEndpointConfig;
  reasoningModel: ModelEndpointConfig;
  /** 默认启用公考考场秒杀速算方法卡 */
  enableFastMethodCards: boolean;
  /** 备用 OCR 模式：auto（模型不支持识图时自动走OCR转文本再喂给DeepSeek） | force_ocr（始终先走OCR转文本） */
  ocrFallbackMode?: 'auto' | 'force_ocr';
  /** 可选：局域网 Mac Apple Vision OCR 桥接地址 */
  localMacOcrUrl?: string;
  /** 可选：OCR.space 免费 Key（默认内置公共免注册 Key） */
  ocrSpaceApiKey?: string;
}

export interface VisionExtractionResult {
  moduleL1: ModuleL1;
  categoryL2: string;
  motherTypeL3: string;
  materialText: string;
  stemText: string;
  options: QuestionOption[];
  detectedMyWrongAnswer: string;
  detectedCorrectAnswer: string;
  anchorKeywords: string[];
  hasDiagramOrChart: boolean;
}

export interface FastSolutionResult {
  moduleL1: ModuleL1;
  categoryL2: string;
  motherTypeL3: string;
  correctAnswer: string;
  suggestedErrorReason: ErrorReason;
  anchorKeywords: string[];
  pitfallWarning: string;
  aiFastSolution: string;
}

export type RecommendationMode = 'mother_type' | 'anchor_keyword';

export interface RecommendedRealQuestion {
  question: RealQuestion;
  score: number;
  matchReason: string;
  practicedCount: number;
  lastCorrect: boolean | null;
}

export interface DashboardStats {
  totalMistakes: number;
  dueTodayCount: number;
  masteredCount: number;
  totalRealQuestions: number;
  activePackName: string;
  topWeakMotherTypes: Array<{
    moduleL1: ModuleL1;
    motherTypeL3: string;
    count: number;
  }>;
  errorReasonBreakdown: Array<{
    errorReason: ErrorReason;
    count: number;
  }>;
}

// ============================================================================
// PDF 讲义与刷题集深度分析 · 动态进度规划与 AI 学伴模型
// ============================================================================

export type MaterialDocType = 'lecture' | 'workbook' | 'mixed';

export interface CourseMaterialDoc {
  id: string;
  fileName: string;
  docType: MaterialDocType;
  moduleScope: string;
  totalPages: number;
  currentPage: number;
  totalQuestionsEst: number;
  completedQuestionsEst: number;
  outlineDigest: string;
  teacherStyleNotes: string;
  /** pending = 仅完成手机本地提取，等待与其它资料合并调用一次大模型；analyzed = 已完成 AI 分析 */
  analysisStatus?: 'pending' | 'analyzed';
  /** 本地暂存的提取目录与抽样文本 JSON（统一分析完成后自动清空释放空间） */
  rawExtractedPayload?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeacherStylePersona {
  teacherNameOrTag: string;
  corePhilosophy: string;
  signatureTechniques: string[];
  solvingStepsTemplate: string;
  pitfallHabits: string;
  /** 是否将该老师的讲题思路与术语风格同步注入到日常「拍错题」AI 解析中 */
  enableInMistakeSolver: boolean;
}

export interface StudyPlanChapter {
  id: string;
  orderIndex: number;
  stageName: string;
  title: string;
  moduleL1: ModuleL1;
  relatedMotherTypes: string[];
  sourceRef: string;
  estimatedHours: number;
  progressPercent: number;
  keyTakeaways: string;
}

export interface DailyTaskItem {
  id: string;
  dayLabel: string;
  title: string;
  targetMinutes: number;
  chapterId?: string;
  completed: boolean;
}

export interface StudyPlanState {
  planTitle: string;
  /** 1. 目前的整体学习内容计划总览 */
  overallAnalysis: string;
  /** 2. 文件中老师的讲题和做题思路与风格 */
  teacherPersona: TeacherStylePersona;
  /** 结构化章节蓝图与各章完成度 */
  chapters: StudyPlanChapter[];
  /** 3. 智能判断当前学习总进度 (0-100) */
  overallProgressPercent: number;
  /** 当前学到哪一步、还剩多少计划学习内容的智能诊断 */
  currentStageDiagnosis: string;
  remainingSummary: string;
  dailyMinutesBudget: number;
  /** 商量排定的每日具体任务清单 */
  dailyTasks: DailyTaskItem[];
  /** 与 AI 规划师协商进度与每日安排的对话记录 */
  plannerChatHistory: ChatTurn[];
  updatedAt: number;
}

export interface AppPracticeSnapshot {
  totalMistakes: number;
  masteredMistakes: number;
  totalPracticeAttempts: number;
  correctPracticeAttempts: number;
  byModule: Array<{
    moduleL1: ModuleL1;
    mistakeCount: number;
    practicedCount: number;
    accuracyPercent: number;
  }>;
  weakMotherTypes: string[];
}
