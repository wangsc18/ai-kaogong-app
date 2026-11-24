import { Platform } from 'react-native';
import { requireNativeModule } from 'expo';
import * as SQLite from 'expo-sqlite';
import { Directory, File, Paths } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { SEED_REAL_QUESTIONS } from '../data/seedQuestions';
import { readUriAsBase64, readUriAsText } from '../services/localFileReader';
import { normalizeModuleL1 } from '../taxonomy/kaogongTaxonomy';
import {
  AISettings,
  AppPracticeSnapshot,
  CourseMaterialDoc,
  DashboardStats,
  ErrorReason,
  MasteryStatus,
  MaterialDocType,
  MistakeRecord,
  ModuleL1,
  PracticeLog,
  QuestionOption,
  RealQuestion,
  StudyPlanState,
} from '../types/models';

const USER_DB_NAME = 'user_notebook_v1.db';
const BUNDLED_OPEN_BANK_DB_NAME = 'bundled_open_bank_v2.db';
const FALLBACK_SEED_DB_NAME = 'seed_question_bank_v1.db';

let userDb: SQLite.SQLiteDatabase | null = null;
let bankDb: SQLite.SQLiteDatabase | null = null;
let activeBankDbInfo: { name: string; customDir?: string } = { name: BUNDLED_OPEN_BANK_DB_NAME };

export const DEFAULT_AI_SETTINGS: AISettings = {
  splitVisionAndReasoning: false,
  visionModel: {
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    modelName: 'deepseek-flash',
  },
  reasoningModel: {
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    modelName: 'deepseek-v4-pro',
  },
  enableFastMethodCards: true,
  ocrFallbackMode: 'auto',
  localMacOcrUrl: '',
  ocrSpaceApiKey: 'helloworld',
};

/** 将连续中文拆为重叠二元词(Bigrams)并保留短词，使 SQLite unicode61 FTS5 实现毫秒级中文 BM25 召回 */
export function cjkBigramSegment(text: string): string {
  const tokens: string[] = [];
  const matches = (text || '').match(/[\u4e00-\u9fa5]+|[a-zA-Z0-9]+/g) || [];
  for (const chunk of matches) {
    if (/^[\u4e00-\u9fa5]+$/.test(chunk)) {
      if (chunk.length <= 4) tokens.push(chunk);
      if (chunk.length > 2) {
        for (let i = 0; i < chunk.length - 1; i++) {
          tokens.push(chunk.slice(i, i + 2));
        }
      }
    } else {
      tokens.push(chunk.toLowerCase());
    }
  }
  return tokens.join(' ');
}

/** 过滤 FTS5 特殊语法字符，构造绝对安全的 OR 检索表达式 */
export function buildSafeFtsQuery(rawInput: string, maxTokens = 14): string {
  const segmented = cjkBigramSegment(rawInput);
  if (!segmented) return '';

  const rawParts = segmented.split(/\s+/).filter((t) => t.length >= 2);
  // 优先保留4字成语/专有名词，其次采样均匀分布的2字特征词
  const fourChar = rawParts.filter((t) => t.length >= 3);
  const twoChar = rawParts.filter((t) => t.length === 2);
  const step = Math.max(1, Math.floor(twoChar.length / Math.max(1, maxTokens - fourChar.length)));
  const sampledTwo: string[] = [];
  for (let i = 0; i < twoChar.length && sampledTwo.length < maxTokens; i += step) {
    sampledTwo.push(twoChar[i]);
  }

  const unique = Array.from(new Set([...fourChar, ...sampledTwo])).slice(0, maxTokens);
  return unique.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

const QUESTION_BANK_SCHEMA = `
CREATE TABLE IF NOT EXISTS pack_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS real_questions (
  qid TEXT PRIMARY KEY,
  source_exam TEXT NOT NULL DEFAULT '',
  year INTEGER NOT NULL DEFAULT 2025,
  province TEXT NOT NULL DEFAULT '国考',
  module_l1 TEXT NOT NULL,
  category_l2 TEXT NOT NULL,
  mother_type_l3 TEXT NOT NULL,
  material_id TEXT,
  material_text TEXT,
  material_images_json TEXT NOT NULL DEFAULT '[]',
  stem TEXT NOT NULL,
  stem_images_json TEXT NOT NULL DEFAULT '[]',
  options_json TEXT NOT NULL DEFAULT '[]',
  answer TEXT NOT NULL DEFAULT '',
  official_analysis TEXT NOT NULL DEFAULT '',
  fast_tips TEXT NOT NULL DEFAULT '',
  anchor_keywords TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_rq_module_l3 ON real_questions(module_l1, mother_type_l3, year DESC);
CREATE INDEX IF NOT EXISTS idx_rq_module_l2 ON real_questions(module_l1, category_l2, year DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS real_questions_fts USING fts5(
  qid UNINDEXED,
  seg_body,
  tokenize = 'unicode61',
  detail = 'none'
);
`;

const USER_NOTEBOOK_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mistakes (
  id TEXT PRIMARY KEY,
  matched_qid TEXT,
  matched_source_exam TEXT,
  capture_images_json TEXT NOT NULL DEFAULT '{}',
  module_l1 TEXT NOT NULL,
  category_l2 TEXT NOT NULL,
  mother_type_l3 TEXT NOT NULL,
  anchor_keywords_json TEXT NOT NULL DEFAULT '[]',
  material_text TEXT,
  material_images_json TEXT NOT NULL DEFAULT '[]',
  stem_text TEXT NOT NULL,
  stem_images_json TEXT NOT NULL DEFAULT '[]',
  options_json TEXT NOT NULL DEFAULT '[]',
  correct_answer TEXT NOT NULL DEFAULT '',
  my_wrong_answer TEXT NOT NULL DEFAULT '',
  error_reason TEXT NOT NULL DEFAULT '公式方法不熟',
  ai_fast_solution TEXT NOT NULL DEFAULT '',
  pitfall_warning TEXT NOT NULL DEFAULT '',
  chat_history_json TEXT NOT NULL DEFAULT '[]',
  user_note TEXT NOT NULL DEFAULT '',
  repetitions INTEGER NOT NULL DEFAULT 0,
  easiness_factor REAL NOT NULL DEFAULT 2.5,
  interval_days INTEGER NOT NULL DEFAULT 1,
  next_review_at INTEGER NOT NULL DEFAULT 0,
  last_time_spent_sec INTEGER NOT NULL DEFAULT 0,
  mastery_status TEXT NOT NULL DEFAULT 'learning',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mistakes_review ON mistakes(next_review_at ASC);
CREATE INDEX IF NOT EXISTS idx_mistakes_module ON mistakes(module_l1, mother_type_l3);

CREATE TABLE IF NOT EXISTS practice_logs (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source_mistake_id TEXT,
  selected_answer TEXT NOT NULL,
  is_correct INTEGER NOT NULL,
  time_spent_sec INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plogs_target ON practice_logs(target_type, target_id);

CREATE TABLE IF NOT EXISTS course_materials (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'lecture',
  module_scope TEXT NOT NULL DEFAULT '综合行测',
  total_pages INTEGER NOT NULL DEFAULT 1,
  current_page INTEGER NOT NULL DEFAULT 0,
  total_questions_est INTEGER NOT NULL DEFAULT 0,
  completed_questions_est INTEGER NOT NULL DEFAULT 0,
  outline_digest TEXT NOT NULL DEFAULT '',
  teacher_style_notes TEXT NOT NULL DEFAULT '',
  analysis_status TEXT NOT NULL DEFAULT 'analyzed',
  raw_extracted_payload TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRowToRealQuestion(row: any): RealQuestion {
  return {
    qid: String(row.qid),
    sourceExam: String(row.source_exam || ''),
    year: Number(row.year || 2025),
    province: String(row.province || '国考'),
    moduleL1: normalizeModuleL1(row.module_l1),
    categoryL2: String(row.category_l2 || ''),
    motherTypeL3: String(row.mother_type_l3 || ''),
    materialId: row.material_id || null,
    materialText: row.material_text || null,
    materialImages: safeJsonParse<string[]>(row.material_images_json, []),
    stem: String(row.stem || ''),
    stemImages: safeJsonParse<string[]>(row.stem_images_json, []),
    options: safeJsonParse<QuestionOption[]>(row.options_json, []),
    answer: String(row.answer || ''),
    officialAnalysis: String(row.official_analysis || ''),
    fastTips: String(row.fast_tips || ''),
    anchorKeywords: String(row.anchor_keywords || ''),
  };
}

function mapRowToMistake(row: any): MistakeRecord {
  return {
    id: String(row.id),
    matchedQid: row.matched_qid || null,
    matchedSourceExam: row.matched_source_exam || null,
    captureImages: safeJsonParse(row.capture_images_json, {}),
    moduleL1: normalizeModuleL1(row.module_l1),
    categoryL2: String(row.category_l2 || ''),
    motherTypeL3: String(row.mother_type_l3 || ''),
    anchorKeywords: safeJsonParse<string[]>(row.anchor_keywords_json, []),
    materialText: row.material_text || null,
    materialImages: safeJsonParse<string[]>(row.material_images_json, []),
    stemText: String(row.stem_text || ''),
    stemImages: safeJsonParse<string[]>(row.stem_images_json, []),
    options: safeJsonParse<QuestionOption[]>(row.options_json, []),
    correctAnswer: String(row.correct_answer || ''),
    myWrongAnswer: String(row.my_wrong_answer || ''),
    errorReason: (row.error_reason as ErrorReason) || '公式方法不熟',
    aiFastSolution: String(row.ai_fast_solution || ''),
    pitfallWarning: String(row.pitfall_warning || ''),
    chatHistory: safeJsonParse(row.chat_history_json, []),
    userNote: String(row.user_note || ''),
    repetitions: Number(row.repetitions || 0),
    easinessFactor: Number(row.easiness_factor || 2.5),
    intervalDays: Number(row.interval_days || 1),
    nextReviewAt: Number(row.next_review_at || 0),
    lastTimeSpentSec: Number(row.last_time_spent_sec || 0),
    masteryStatus: (row.mastery_status as MasteryStatus) || 'learning',
    createdAt: Number(row.created_at || Date.now()),
    updatedAt: Number(row.updated_at || Date.now()),
  };
}

/** 初始化双 SQLite 数据库与内置精选种子真题库 */
export async function initializeDatabases(): Promise<void> {
  if (!userDb) {
    userDb = await SQLite.openDatabaseAsync(USER_DB_NAME);
    await userDb.execAsync(USER_NOTEBOOK_SCHEMA);
    // 平滑迁移旧版 course_materials 表，补充多 PDF 批量暂存字段
    const cols = await userDb.getAllAsync<{ name: string }>(
      'PRAGMA table_info(course_materials)'
    );
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('analysis_status')) {
      await userDb.execAsync(
        "ALTER TABLE course_materials ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'analyzed';"
      );
    }
    if (!colNames.has('raw_extracted_payload')) {
      await userDb.execAsync(
        "ALTER TABLE course_materials ADD COLUMN raw_extracted_payload TEXT NOT NULL DEFAULT '';"
      );
    }
  }

  // 检查用户是否切换过外部导入的离线全量真题包
  const savedBankRef = await getSettingValue('active_question_bank_ref');
  if (savedBankRef) {
    const parsed = safeJsonParse<{ name: string; customDir?: string } | null>(savedBankRef, null);
    if (parsed?.name) {
      try {
        const candidateDb = parsed.customDir
          ? await SQLite.openDatabaseAsync(parsed.name, undefined, parsed.customDir)
          : await SQLite.openDatabaseAsync(parsed.name);
        const check = await candidateDb.getFirstAsync<{ cnt: number }>(
          'SELECT COUNT(*) as cnt FROM real_questions'
        );
        if (check && check.cnt > 0) {
          bankDb = candidateDb;
          activeBankDbInfo = parsed;
          return;
        }
        await candidateDb.closeAsync();
      } catch {
        // 回退至默认种子库
      }
    }
  }

  await openAndEnsureSeedBank();
}

async function openAndEnsureSeedBank(): Promise<void> {
  if (Platform.OS !== 'web') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const assetId = require('../../assets/question_bank.db') as number;
      await SQLite.importDatabaseFromAssetAsync(BUNDLED_OPEN_BANK_DB_NAME, {
        assetId,
        forceOverwrite: false,
      });
      const bundledDb = await SQLite.openDatabaseAsync(BUNDLED_OPEN_BANK_DB_NAME);
      const countRow = await bundledDb.getFirstAsync<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM real_questions'
      );
      if (countRow && countRow.cnt >= 100) {
        bankDb = bundledDb;
        activeBankDbInfo = { name: BUNDLED_OPEN_BANK_DB_NAME };
        return;
      }
      await bundledDb.closeAsync();
    } catch (err) {
      console.warn('[DB] 挂载内置大题库资源提示（请确认已重启 npx expo start -c）:', err);
    }
  }

  bankDb = await SQLite.openDatabaseAsync(FALLBACK_SEED_DB_NAME);
  await bankDb.execAsync(QUESTION_BANK_SCHEMA);
  activeBankDbInfo = { name: FALLBACK_SEED_DB_NAME };

  const countRow = await bankDb.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM real_questions'
  );
  if (!countRow || countRow.cnt < SEED_REAL_QUESTIONS.length) {
    await seedBuiltInQuestions(bankDb);
  }
}

async function seedBuiltInQuestions(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync('DELETE FROM real_questions_fts;');
  for (const q of SEED_REAL_QUESTIONS) {
    await db.runAsync(
      `INSERT OR REPLACE INTO real_questions (
        qid, source_exam, year, province,
        module_l1, category_l2, mother_type_l3,
        material_id, material_text, material_images_json,
        stem, stem_images_json, options_json,
        answer, official_analysis, fast_tips, anchor_keywords
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        q.qid,
        q.sourceExam,
        q.year,
        q.province,
        q.moduleL1,
        q.categoryL2,
        q.motherTypeL3,
        q.materialId || null,
        q.materialText || null,
        JSON.stringify(q.materialImages || []),
        q.stem,
        JSON.stringify(q.stemImages || []),
        JSON.stringify(q.options),
        q.answer,
        q.officialAnalysis,
        q.fastTips,
        q.anchorKeywords,
      ]
    );
    const segBody = `${q.anchorKeywords} ${q.motherTypeL3} ${cjkBigramSegment(q.stem.slice(0, 190))} ${cjkBigramSegment(q.anchorKeywords)}`;
    await db.runAsync(
      `INSERT INTO real_questions_fts (qid, seg_body) VALUES (?, ?)`,
      [q.qid, segBody]
    );
  }
  await db.runAsync(
    `INSERT OR REPLACE INTO pack_meta (key, value) VALUES ('pack_name', ?), ('question_count', ?)`,
    ['内置精选母题库', String(SEED_REAL_QUESTIONS.length)]
  );
}

export function getUserDb(): SQLite.SQLiteDatabase {
  if (!userDb) throw new Error('User database is not initialized yet.');
  return userDb;
}

export function getBankDb(): SQLite.SQLiteDatabase {
  if (!bankDb) throw new Error('Question bank database is not initialized yet.');
  return bankDb;
}

// ============================================================================
// 配置读写 (AI Settings & App Config)
// ============================================================================

export async function getSettingValue(key: string): Promise<string | null> {
  const db = getUserDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?',
    [key]
  );
  return row ? row.value : null;
}

export async function setSettingValue(key: string, value: string): Promise<void> {
  const db = getUserDb();
  await db.runAsync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, value]);
}

export async function loadAISettings(): Promise<AISettings> {
  const raw = await getSettingValue('ai_settings_v2');
  const parsed = safeJsonParse<Partial<AISettings> | null>(raw, null);
  if (!parsed) return DEFAULT_AI_SETTINGS;
  return {
    splitVisionAndReasoning: parsed.splitVisionAndReasoning ?? false,
    visionModel: { ...DEFAULT_AI_SETTINGS.visionModel, ...(parsed.visionModel || {}) },
    reasoningModel: { ...DEFAULT_AI_SETTINGS.reasoningModel, ...(parsed.reasoningModel || {}) },
    enableFastMethodCards: parsed.enableFastMethodCards ?? true,
    ocrFallbackMode: parsed.ocrFallbackMode ?? 'auto',
    localMacOcrUrl: parsed.localMacOcrUrl ?? '',
    ocrSpaceApiKey: parsed.ocrSpaceApiKey ?? 'helloworld',
  };
}

export async function saveAISettings(settings: AISettings): Promise<void> {
  await setSettingValue('ai_settings_v2', JSON.stringify(settings));
}

// ============================================================================
// 外部离线真题包导入 (.db 或 .json) 与切换
// ============================================================================

export async function importExternalQuestionBankDb(
  pickedSource: File | string
): Promise<{
  packName: string;
  count: number;
}> {
  const packsDir = new Directory(Paths.document, 'packs');
  packsDir.create({ idempotent: true });

  const fileName = `bank_${Date.now()}.db`;
  const dstFile = new File(packsDir, fileName);
  const srcUri = typeof pickedSource === 'string' ? pickedSource : pickedSource.uri;

  // 三重兼容复制策略：完美兼容 Android SAF content://、Expo Go 沙盒目录及外部管理器路径
  let copied = false;
  if (typeof pickedSource !== 'string') {
    try {
      await pickedSource.copy(dstFile, { overwrite: true });
      copied = dstFile.exists && dstFile.size > 0;
    } catch {
      copied = false;
    }
  }

  if (!copied) {
    try {
      await LegacyFileSystem.copyAsync({
        from: srcUri,
        to: dstFile.uri,
      });
      copied = dstFile.exists && dstFile.size > 0;
    } catch {
      copied = false;
    }
  }

  if (!copied && srcUri.startsWith('file://')) {
    const ExpoSQLiteNative = requireNativeModule('ExpoSQLite');
    const rawDestPath = dstFile.uri.replace(/^file:\/\//, '');
    await ExpoSQLiteNative.importAssetDatabaseAsync(rawDestPath, srcUri, true);
    copied = true;
  }

  if (!copied) {
    try {
      const b64 = await readUriAsBase64(srcUri);
      await LegacyFileSystem.writeAsStringAsync(dstFile.uri, b64, {
        encoding: LegacyFileSystem.EncodingType.Base64,
      });
      copied = dstFile.exists && dstFile.size > 0;
    } catch {
      copied = false;
    }
  }

  if (!copied) {
    throw new Error('无法读取所选题库文件，请尝试将 .db 文件放入手机「下载 (Download)」目录后再选');
  }

  const dirPath = packsDir.uri.replace(/^file:\/\//, '').replace(/\/$/, '');
  const importedDb = await SQLite.openDatabaseAsync(fileName, undefined, dirPath);

  const countRow = await importedDb.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM real_questions'
  );
  if (!countRow || countRow.cnt === 0) {
    await importedDb.closeAsync();
    if (dstFile.exists) dstFile.delete();
    throw new Error('所选 SQLite 数据库中未找到有效的 real_questions 真题记录');
  }

  const metaRow = await importedDb.getFirstAsync<{ value: string }>(
    "SELECT value FROM pack_meta WHERE key = 'pack_name'"
  );
  const packName = metaRow?.value || `外部导入真题库 (${countRow.cnt}题)`;

  if (bankDb && activeBankDbInfo.name !== fileName) {
    await bankDb.closeAsync();
  }
  bankDb = importedDb;
  activeBankDbInfo = { name: fileName, customDir: dirPath };
  await setSettingValue('active_question_bank_ref', JSON.stringify(activeBankDbInfo));

  return { packName, count: countRow.cnt };
}

export async function importJsonQuestionsIntoSeedBank(
  pickedSource: File | string
): Promise<number> {
  const srcUri = typeof pickedSource === 'string' ? pickedSource : pickedSource.uri;
  const text = await readUriAsText(srcUri);
  const parsed = JSON.parse(text);
  const items: any[] = Array.isArray(parsed) ? parsed : parsed.questions || [];
  if (!items.length) {
    throw new Error('JSON 文件中没有检测到题目数组');
  }

  if (
    activeBankDbInfo.name !== BUNDLED_OPEN_BANK_DB_NAME &&
    activeBankDbInfo.name !== FALLBACK_SEED_DB_NAME
  ) {
    if (bankDb) await bankDb.closeAsync();
    await openAndEnsureSeedBank();
  }
  const db = getBankDb();
  let added = 0;

  for (const item of items) {
    const qid = String(item.qid || `imp_${Date.now()}_${added}`);
    const stem = String(item.stem || '').trim();
    if (!stem) continue;
    const options: QuestionOption[] = item.options || [];
    const mod = normalizeModuleL1(item.module_l1 || item.moduleL1);
    const l2 = String(item.category_l2 || item.categoryL2 || '综合题型');
    const l3 = String(item.mother_type_l3 || item.motherTypeL3 || '综合考点');
    const anchors = String(item.anchor_keywords || item.anchorKeywords || `${l3} ${l2}`);

    await db.runAsync(
      `INSERT OR REPLACE INTO real_questions (
        qid, source_exam, year, province, module_l1, category_l2, mother_type_l3,
        material_text, stem, options_json, answer, official_analysis, fast_tips, anchor_keywords
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        qid,
        String(item.source_exam || item.sourceExam || '导入真题'),
        Number(item.year || 2025),
        String(item.province || '国考'),
        mod,
        l2,
        l3,
        item.material_text || item.materialText || null,
        stem,
        JSON.stringify(options),
        String(item.answer || '').toUpperCase(),
        String(item.official_analysis || item.officialAnalysis || ''),
        String(item.fast_tips || item.fastTips || ''),
        anchors,
      ]
    );
    await db.runAsync('DELETE FROM real_questions_fts WHERE qid = ?', [qid]);
    const segBody = `${anchors} ${l3} ${cjkBigramSegment(stem.slice(0, 190))} ${cjkBigramSegment(anchors)}`;
    await db.runAsync(
      `INSERT INTO real_questions_fts (qid, seg_body) VALUES (?, ?)`,
      [qid, segBody]
    );
    added += 1;
  }

  const totalRow = await db.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM real_questions'
  );
  await db.runAsync(
    `INSERT OR REPLACE INTO pack_meta (key, value) VALUES ('pack_name', ?), ('question_count', ?)`,
    [`本地合并真题库 (${totalRow?.cnt || added}题)`, String(totalRow?.cnt || added)]
  );
  await setSettingValue('active_question_bank_ref', '');
  return added;
}

export async function resetToSeedQuestionBank(): Promise<void> {
  if (bankDb) {
    await bankDb.closeAsync();
    bankDb = null;
  }
  await setSettingValue('active_question_bank_ref', '');
  await openAndEnsureSeedBank();
}

// ============================================================================
// 真题库查询 API
// ============================================================================

export async function getRealQuestionById(qid: string): Promise<RealQuestion | null> {
  const db = getBankDb();
  const row = await db.getFirstAsync<any>('SELECT * FROM real_questions WHERE qid = ?', [qid]);
  return row ? mapRowToRealQuestion(row) : null;
}

export async function queryRealQuestions(params: {
  moduleL1?: ModuleL1 | '全部';
  motherTypeL3?: string;
  keyword?: string;
  limit?: number;
}): Promise<RealQuestion[]> {
  const db = getBankDb();
  const limit = params.limit || 50;

  if (params.keyword && params.keyword.trim()) {
    const ftsExpr = buildSafeFtsQuery(params.keyword);
    if (ftsExpr) {
      const sql =
        params.moduleL1 && params.moduleL1 !== '全部'
          ? `SELECT rq.* FROM real_questions_fts fts
             JOIN real_questions rq ON rq.qid = fts.qid
             WHERE real_questions_fts MATCH ? AND rq.module_l1 = ?
             ORDER BY rank LIMIT ?`
          : `SELECT rq.* FROM real_questions_fts fts
             JOIN real_questions rq ON rq.qid = fts.qid
             WHERE real_questions_fts MATCH ?
             ORDER BY rank LIMIT ?`;
      const args =
        params.moduleL1 && params.moduleL1 !== '全部'
          ? [ftsExpr, params.moduleL1, limit]
          : [ftsExpr, limit];
      const rows = await db.getAllAsync<any>(sql, args);
      if (rows.length > 0) return rows.map(mapRowToRealQuestion);
    }
  }

  const clauses: string[] = [];
  const bind: any[] = [];
  if (params.moduleL1 && params.moduleL1 !== '全部') {
    clauses.push('module_l1 = ?');
    bind.push(params.moduleL1);
  }
  if (params.motherTypeL3) {
    clauses.push('mother_type_l3 = ?');
    bind.push(params.motherTypeL3);
  }
  if (params.keyword && params.keyword.trim()) {
    clauses.push('(stem LIKE ? OR anchor_keywords LIKE ?)');
    const kw = `%${params.keyword.trim()}%`;
    bind.push(kw, kw);
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.getAllAsync<any>(
    `SELECT * FROM real_questions ${whereSql} ORDER BY year DESC, qid ASC LIMIT ?`,
    [...bind, limit]
  );
  return rows.map(mapRowToRealQuestion);
}

// ============================================================================
// 错题本增删改查与练习流水 API
// ============================================================================

export async function upsertMistake(record: MistakeRecord): Promise<void> {
  const db = getUserDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO mistakes (
      id, matched_qid, matched_source_exam, capture_images_json,
      module_l1, category_l2, mother_type_l3, anchor_keywords_json,
      material_text, material_images_json, stem_text, stem_images_json,
      options_json, correct_answer, my_wrong_answer, error_reason,
      ai_fast_solution, pitfall_warning, chat_history_json, user_note,
      repetitions, easiness_factor, interval_days, next_review_at,
      last_time_spent_sec, mastery_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.matchedQid || null,
      record.matchedSourceExam || null,
      JSON.stringify(record.captureImages || {}),
      record.moduleL1,
      record.categoryL2,
      record.motherTypeL3,
      JSON.stringify(record.anchorKeywords || []),
      record.materialText || null,
      JSON.stringify(record.materialImages || []),
      record.stemText,
      JSON.stringify(record.stemImages || []),
      JSON.stringify(record.options || []),
      record.correctAnswer,
      record.myWrongAnswer,
      record.errorReason,
      record.aiFastSolution,
      record.pitfallWarning,
      JSON.stringify(record.chatHistory || []),
      record.userNote,
      record.repetitions,
      record.easinessFactor,
      record.intervalDays,
      record.nextReviewAt,
      record.lastTimeSpentSec,
      record.masteryStatus,
      record.createdAt,
      record.updatedAt,
    ]
  );
}

export async function deleteMistakeById(id: string): Promise<void> {
  const db = getUserDb();
  await db.runAsync('DELETE FROM mistakes WHERE id = ?', [id]);
}

export async function getMistakeById(id: string): Promise<MistakeRecord | null> {
  const db = getUserDb();
  const row = await db.getFirstAsync<any>('SELECT * FROM mistakes WHERE id = ?', [id]);
  return row ? mapRowToMistake(row) : null;
}

export async function listMistakes(filters?: {
  moduleL1?: ModuleL1 | '全部';
  errorReason?: ErrorReason | '全部';
  masteryStatus?: MasteryStatus | '全部';
  keyword?: string;
  dueOnly?: boolean;
}): Promise<MistakeRecord[]> {
  const db = getUserDb();
  const clauses: string[] = [];
  const bind: any[] = [];

  if (filters?.moduleL1 && filters.moduleL1 !== '全部') {
    clauses.push('module_l1 = ?');
    bind.push(filters.moduleL1);
  }
  if (filters?.errorReason && filters.errorReason !== '全部') {
    clauses.push('error_reason = ?');
    bind.push(filters.errorReason);
  }
  if (filters?.masteryStatus && filters.masteryStatus !== '全部') {
    clauses.push('mastery_status = ?');
    bind.push(filters.masteryStatus);
  }
  if (filters?.dueOnly) {
    clauses.push('next_review_at <= ? AND mastery_status != ?');
    bind.push(Date.now(), 'mastered');
  }
  if (filters?.keyword && filters.keyword.trim()) {
    clauses.push(
      '(stem_text LIKE ? OR mother_type_l3 LIKE ? OR anchor_keywords_json LIKE ? OR user_note LIKE ?)'
    );
    const kw = `%${filters.keyword.trim()}%`;
    bind.push(kw, kw, kw, kw);
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderSql = filters?.dueOnly ? 'ORDER BY next_review_at ASC' : 'ORDER BY created_at DESC';
  const rows = await db.getAllAsync<any>(`SELECT * FROM mistakes ${whereSql} ${orderSql}`, bind);
  return rows.map(mapRowToMistake);
}

export async function recordPracticeAttempt(log: PracticeLog): Promise<void> {
  const db = getUserDb();
  await db.runAsync(
    `INSERT INTO practice_logs (
      id, target_type, target_id, source_mistake_id,
      selected_answer, is_correct, time_spent_sec, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      log.id,
      log.targetType,
      log.targetId,
      log.sourceMistakeId || null,
      log.selectedAnswer,
      log.isCorrect ? 1 : 0,
      log.timeSpentSec,
      log.createdAt,
    ]
  );
}

export async function getPracticeSummaryMapForRealQuestions(
  qids: string[]
): Promise<Record<string, { count: number; lastCorrect: boolean | null }>> {
  if (!qids.length) return {};
  const db = getUserDb();
  const placeholders = qids.map(() => '?').join(',');
  const rows = await db.getAllAsync<any>(
    `SELECT target_id, is_correct, created_at
     FROM practice_logs
     WHERE target_type = 'real_question' AND target_id IN (${placeholders})
     ORDER BY created_at ASC`,
    qids
  );
  const map: Record<string, { count: number; lastCorrect: boolean | null }> = {};
  for (const r of rows) {
    const id = String(r.target_id);
    const prev = map[id] || { count: 0, lastCorrect: null };
    map[id] = {
      count: prev.count + 1,
      lastCorrect: Boolean(r.is_correct),
    };
  }
  return map;
}

// ============================================================================
// 首页复盘统计看板 API
// ============================================================================

export async function getDashboardStats(): Promise<DashboardStats> {
  const uDb = getUserDb();
  const bDb = getBankDb();
  const now = Date.now();

  const totalMistakesRow = await uDb.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM mistakes'
  );
  const dueRow = await uDb.getFirstAsync<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM mistakes WHERE next_review_at <= ? AND mastery_status != 'mastered'",
    [now]
  );
  const masteredRow = await uDb.getFirstAsync<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM mistakes WHERE mastery_status = 'mastered'"
  );
  const realCountRow = await bDb.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM real_questions'
  );
  const packMetaRow = await bDb.getFirstAsync<{ value: string }>(
    "SELECT value FROM pack_meta WHERE key = 'pack_name'"
  );

  const weakRows = await uDb.getAllAsync<any>(
    `SELECT module_l1, mother_type_l3, COUNT(*) as cnt
     FROM mistakes
     GROUP BY module_l1, mother_type_l3
     ORDER BY cnt DESC
     LIMIT 5`
  );

  const reasonRows = await uDb.getAllAsync<any>(
    `SELECT error_reason, COUNT(*) as cnt
     FROM mistakes
     GROUP BY error_reason
     ORDER BY cnt DESC`
  );

  return {
    totalMistakes: totalMistakesRow?.cnt || 0,
    dueTodayCount: dueRow?.cnt || 0,
    masteredCount: masteredRow?.cnt || 0,
    totalRealQuestions: realCountRow?.cnt || 0,
    activePackName: packMetaRow?.value || '内置精选母题库',
    topWeakMotherTypes: weakRows.map((r) => ({
      moduleL1: normalizeModuleL1(r.module_l1),
      motherTypeL3: String(r.mother_type_l3),
      count: Number(r.cnt),
    })),
    errorReasonBreakdown: reasonRows.map((r) => ({
      errorReason: (r.error_reason as ErrorReason) || '公式方法不熟',
      count: Number(r.cnt),
    })),
  };
}

// ============================================================================
// PDF 课程讲义 / 刷题集与 AI 动态学习规划存储 API
// ============================================================================

function mapRowToCourseMaterial(row: any): CourseMaterialDoc {
  return {
    id: String(row.id),
    fileName: String(row.file_name || ''),
    docType: (row.doc_type as MaterialDocType) || 'lecture',
    moduleScope: String(row.module_scope || '综合行测'),
    totalPages: Number(row.total_pages || 1),
    currentPage: Number(row.current_page || 0),
    totalQuestionsEst: Number(row.total_questions_est || 0),
    completedQuestionsEst: Number(row.completed_questions_est || 0),
    outlineDigest: String(row.outline_digest || ''),
    teacherStyleNotes: String(row.teacher_style_notes || ''),
    analysisStatus: row.analysis_status === 'pending' ? 'pending' : 'analyzed',
    rawExtractedPayload: String(row.raw_extracted_payload || ''),
    createdAt: Number(row.created_at || Date.now()),
    updatedAt: Number(row.updated_at || Date.now()),
  };
}

export async function listCourseMaterials(): Promise<CourseMaterialDoc[]> {
  const db = getUserDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM course_materials ORDER BY created_at ASC'
  );
  return rows.map(mapRowToCourseMaterial);
}

export async function upsertCourseMaterial(doc: CourseMaterialDoc): Promise<void> {
  const db = getUserDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO course_materials (
      id, file_name, doc_type, module_scope,
      total_pages, current_page, total_questions_est, completed_questions_est,
      outline_digest, teacher_style_notes, analysis_status, raw_extracted_payload,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      doc.id,
      doc.fileName,
      doc.docType,
      doc.moduleScope,
      doc.totalPages,
      doc.currentPage,
      doc.totalQuestionsEst,
      doc.completedQuestionsEst,
      doc.outlineDigest,
      doc.teacherStyleNotes,
      doc.analysisStatus || 'analyzed',
      doc.rawExtractedPayload || '',
      doc.createdAt,
      doc.updatedAt,
    ]
  );
}

export async function deleteCourseMaterial(id: string): Promise<void> {
  const db = getUserDb();
  await db.runAsync('DELETE FROM course_materials WHERE id = ?', [id]);
}

export async function loadStudyPlanState(): Promise<StudyPlanState | null> {
  const raw = await getSettingValue('study_plan_state_v1');
  return safeJsonParse<StudyPlanState | null>(raw, null);
}

export async function saveStudyPlanState(state: StudyPlanState): Promise<void> {
  await setSettingValue('study_plan_state_v1', JSON.stringify(state));
}

export async function getAppPracticeSnapshotForPlanner(): Promise<AppPracticeSnapshot> {
  const uDb = getUserDb();
  const bDb = getBankDb();

  const totalM = await uDb.getFirstAsync<{ cnt: number }>('SELECT COUNT(*) as cnt FROM mistakes');
  const mastM = await uDb.getFirstAsync<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM mistakes WHERE mastery_status = 'mastered'"
  );
  const totalP = await uDb.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM practice_logs'
  );
  const corrP = await uDb.getFirstAsync<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM practice_logs WHERE is_correct = 1'
  );

  const mistakeByModRows = await uDb.getAllAsync<any>(
    'SELECT module_l1, COUNT(*) as cnt FROM mistakes GROUP BY module_l1'
  );
  const mistakeMap: Record<string, number> = {};
  for (const r of mistakeByModRows) {
    mistakeMap[normalizeModuleL1(r.module_l1)] = Number(r.cnt);
  }

  // 统计真题作答各模块表现
  const realLogs = await uDb.getAllAsync<any>(
    "SELECT target_id, is_correct FROM practice_logs WHERE target_type = 'real_question'"
  );
  const modPractice: Record<string, { total: number; correct: number }> = {};
  if (realLogs.length > 0) {
    const uniqueIds = Array.from(new Set(realLogs.map((l) => String(l.target_id)))).slice(0, 400);
    const placeholders = uniqueIds.map(() => '?').join(',');
    const qMods = await bDb.getAllAsync<any>(
      `SELECT qid, module_l1 FROM real_questions WHERE qid IN (${placeholders})`,
      uniqueIds
    );
    const qidToMod: Record<string, ModuleL1> = {};
    for (const qm of qMods) {
      qidToMod[String(qm.qid)] = normalizeModuleL1(qm.module_l1);
    }
    for (const rl of realLogs) {
      const m = qidToMod[String(rl.target_id)];
      if (!m) continue;
      if (!modPractice[m]) modPractice[m] = { total: 0, correct: 0 };
      modPractice[m].total += 1;
      if (rl.is_correct) modPractice[m].correct += 1;
    }
  }

  const allMods: ModuleL1[] = [
    '政治理论',
    '常识判断',
    '言语理解',
    '数量关系',
    '判断推理',
    '资料分析',
  ];

  const weakRows = await uDb.getAllAsync<any>(
    `SELECT module_l1, mother_type_l3, COUNT(*) as cnt
     FROM mistakes
     GROUP BY module_l1, mother_type_l3
     ORDER BY cnt DESC LIMIT 6`
  );

  return {
    totalMistakes: totalM?.cnt || 0,
    masteredMistakes: mastM?.cnt || 0,
    totalPracticeAttempts: totalP?.cnt || 0,
    correctPracticeAttempts: corrP?.cnt || 0,
    byModule: allMods.map((m) => {
      const p = modPractice[m] || { total: 0, correct: 0 };
      return {
        moduleL1: m,
        mistakeCount: mistakeMap[m] || 0,
        practicedCount: p.total,
        accuracyPercent: p.total > 0 ? Math.round((p.correct / p.total) * 100) : 0,
      };
    }),
    weakMotherTypes: weakRows.map(
      (r) => `${r.module_l1}-${r.mother_type_l3}(错${r.cnt}题)`
    ),
  };
}
