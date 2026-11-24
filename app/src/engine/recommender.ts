import {
  buildSafeFtsQuery,
  getBankDb,
  getPracticeSummaryMapForRealQuestions,
  queryRealQuestions,
} from '../db/database';
import {
  MistakeRecord,
  ModuleL1,
  RealQuestion,
  RecommendationMode,
  RecommendedRealQuestion,
} from '../types/models';

function extractBigrams(text: string): Set<string> {
  const clean = text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const set = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) {
    set.add(clean.slice(i, i + 2));
  }
  return set;
}

function diceSimilarity(a: string, b: string): number {
  const setA = extractBigrams(a);
  const setB = extractBigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersect = 0;
  for (const bg of setA) {
    if (setB.has(bg)) intersect++;
  }
  return (2 * intersect) / (setA.size + setB.size);
}

/**
 * 智能双轨还原核心：
 * 用多模态识别出的题干去本地 SQLite FTS5 真题库高速碰撞，
 * 若高置信度命中历年真题，直接返回无手写笔迹的干净原题记录与标准答案！
 */
export async function matchOriginalRealQuestion(
  extractedStem: string,
  moduleL1?: ModuleL1
): Promise<{ matched: RealQuestion; similarity: number } | null> {
  const cleanStem = (extractedStem || '').trim();
  if (cleanStem.length < 8) return null;

  const candidates = await queryRealQuestions({
    keyword: cleanStem,
    moduleL1: '全部',
    limit: 12,
  });

  let best: { matched: RealQuestion; similarity: number } | null = null;
  for (const cand of candidates) {
    const sim = diceSimilarity(cleanStem, cand.stem);
    const modBonus = moduleL1 && cand.moduleL1 === moduleL1 ? 0.03 : 0;
    const totalSim = Math.min(1, sim + modBonus);
    if (totalSim >= 0.62 && (!best || totalSim > best.similarity)) {
      best = { matched: cand, similarity: totalSim };
    }
  }
  return best;
}

/**
 * 「三级母题考点树 + 核心锚点词」双维同类真题推荐引擎
 * - mode === 'mother_type'：优先强化同一底层公式/推理模型（适合资料分析、数量、逻辑、图推）
 * - mode === 'anchor_keyword'：优先追击同一高频易混成语、政策原文词或关键概念（适合言语填空、政治理论、常识）
 */
export async function recommendSimilarRealQuestions(
  mistake: Pick<
    MistakeRecord,
    'matchedQid' | 'moduleL1' | 'categoryL2' | 'motherTypeL3' | 'anchorKeywords' | 'stemText'
  >,
  mode: RecommendationMode = 'mother_type',
  limit = 5
): Promise<RecommendedRealQuestion[]> {
  const db = getBankDb();
  const candidateMap = new Map<string, RealQuestion>();

  // 路径 A：同三级母题精确召回
  const motherMatches = await queryRealQuestions({
    moduleL1: mistake.moduleL1,
    motherTypeL3: mistake.motherTypeL3,
    limit: 20,
  });
  for (const q of motherMatches) {
    if (q.qid !== mistake.matchedQid) {
      candidateMap.set(q.qid, q);
    }
  }

  // 路径 B：核心锚点词（成语/政策热词/公式词）FTS5 召回
  const cleanAnchors = (mistake.anchorKeywords || [])
    .map((k) => k.trim())
    .filter((k) => k.length >= 2);

  if (cleanAnchors.length > 0) {
    const ftsQuery = buildSafeFtsQuery(cleanAnchors.join(' '), 12);
    if (ftsQuery) {
      const ftsRows = await db.getAllAsync<any>(
        `SELECT rq.* FROM real_questions_fts fts
         JOIN real_questions rq ON rq.qid = fts.qid
         WHERE real_questions_fts MATCH ? AND rq.module_l1 = ?
         ORDER BY rank LIMIT 20`,
        [ftsQuery, mistake.moduleL1]
      );
      for (const row of ftsRows) {
        const q = {
          qid: String(row.qid),
          sourceExam: String(row.source_exam || ''),
          year: Number(row.year || 2025),
          province: String(row.province || '国考'),
          moduleL1: mistake.moduleL1,
          categoryL2: String(row.category_l2 || ''),
          motherTypeL3: String(row.mother_type_l3 || ''),
          materialId: row.material_id || null,
          materialText: row.material_text || null,
          materialImages: JSON.parse(row.material_images_json || '[]'),
          stem: String(row.stem || ''),
          stemImages: JSON.parse(row.stem_images_json || '[]'),
          options: JSON.parse(row.options_json || '[]'),
          answer: String(row.answer || ''),
          officialAnalysis: String(row.official_analysis || ''),
          fastTips: String(row.fast_tips || ''),
          anchorKeywords: String(row.anchor_keywords || ''),
        } satisfies RealQuestion;
        if (q.qid !== mistake.matchedQid && !candidateMap.has(q.qid)) {
          candidateMap.set(q.qid, q);
        }
      }
    }
  }

  // 路径 C：若候选不足，回退至同一二级题型或一级模块兜底补充
  if (candidateMap.size < limit) {
    const fallbackRows = await queryRealQuestions({
      moduleL1: mistake.moduleL1,
      limit: 15,
    });
    for (const q of fallbackRows) {
      if (q.qid !== mistake.matchedQid && !candidateMap.has(q.qid)) {
        candidateMap.set(q.qid, q);
      }
    }
  }

  const candidates = Array.from(candidateMap.values());
  const practiceSummary = await getPracticeSummaryMapForRealQuestions(
    candidates.map((c) => c.qid)
  );

  // 计算双维加权得分
  const scored: RecommendedRealQuestion[] = candidates.map((q) => {
    const sameMother = q.motherTypeL3 === mistake.motherTypeL3;
    const sameCatL2 = q.categoryL2 === mistake.categoryL2;

    const fullHaystack = `${q.stem} ${q.options.map((o) => o.text).join(' ')} ${q.anchorKeywords}`;
    const hitAnchors = cleanAnchors.filter(
      (kw) => kw !== mistake.motherTypeL3 && kw !== mistake.categoryL2 && fullHaystack.includes(kw)
    );

    const yearScore = Math.max(0, Math.min(15, (q.year - 2018) * 2));
    const pStat = practiceSummary[q.qid] || { count: 0, lastCorrect: null };
    const alreadyMasteredPenalty = pStat.lastCorrect === true ? 35 : 0;

    let score = 0;
    if (mode === 'mother_type') {
      score =
        (sameMother ? 60 : sameCatL2 ? 28 : 10) +
        hitAnchors.length * 18 +
        yearScore -
        alreadyMasteredPenalty;
    } else {
      score =
        hitAnchors.length * 45 +
        (sameMother ? 25 : sameCatL2 ? 15 : 5) +
        yearScore -
        alreadyMasteredPenalty;
    }

    // 排除与题干文本几乎 95% 重合的同一道题翻版
    if (diceSimilarity(mistake.stemText, q.stem) > 0.85) {
      score -= 200;
    }

    const reasonParts: string[] = [];
    if (sameMother) reasonParts.push(`同母题「${q.motherTypeL3}」`);
    else if (sameCatL2) reasonParts.push(`同题型「${q.categoryL2}」`);
    if (hitAnchors.length > 0) {
      reasonParts.push(`命中考点词：${hitAnchors.slice(0, 3).join(' / ')}`);
    }

    return {
      question: q,
      score,
      matchReason: reasonParts.join(' · ') || `${q.moduleL1}经典真题`,
      practicedCount: pStat.count,
      lastCorrect: pStat.lastCorrect,
    };
  });

  return scored
    .filter((item) => item.score > -50)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
