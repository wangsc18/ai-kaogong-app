import { MasteryStatus, MistakeRecord } from '../types/models';

export type ReviewQuality = 1 | 3 | 4 | 5;

export interface SM2UpdateResult {
  repetitions: number;
  easinessFactor: number;
  intervalDays: number;
  nextReviewAt: number;
  masteryStatus: MasteryStatus;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 基于公考刷题节奏优化的 SM-2 间隔重复算法
 * @param quality 1=答错重来, 3=做对但耗时久/犹豫, 4=正常熟练做对, 5=一眼秒杀彻底掌握
 */
export function computeNextSM2State(
  current: Pick<MistakeRecord, 'repetitions' | 'easinessFactor' | 'intervalDays'>,
  quality: ReviewQuality,
  nowMs: number = Date.now()
): SM2UpdateResult {
  let { repetitions, easinessFactor, intervalDays } = current;

  if (quality < 3) {
    repetitions = 0;
    intervalDays = 1;
    easinessFactor = Math.max(1.3, easinessFactor - 0.2);
    return {
      repetitions,
      easinessFactor: Number(easinessFactor.toFixed(2)),
      intervalDays,
      // 答错的题 12 小时后（次日清晨）立即进入今日待复习队列
      nextReviewAt: nowMs + Math.round(0.5 * DAY_MS),
      masteryStatus: 'learning',
    };
  }

  // 更新难度因子 EF
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  easinessFactor = Math.max(1.3, Math.min(3.0, easinessFactor + delta));

  if (repetitions === 0) {
    intervalDays = quality === 5 ? 3 : 1;
  } else if (repetitions === 1) {
    intervalDays = quality === 5 ? 7 : 3;
  } else {
    const multiplier = quality === 3 ? easinessFactor * 0.8 : easinessFactor;
    intervalDays = Math.max(intervalDays + 1, Math.round(intervalDays * multiplier));
  }

  repetitions += 1;

  let masteryStatus: MasteryStatus = 'reviewing';
  if (repetitions >= 3 && quality >= 4 && intervalDays >= 10) {
    masteryStatus = 'mastered';
  } else if (repetitions <= 1 && quality === 3) {
    masteryStatus = 'learning';
  }

  return {
    repetitions,
    easinessFactor: Number(easinessFactor.toFixed(2)),
    intervalDays,
    nextReviewAt: nowMs + intervalDays * DAY_MS,
    masteryStatus,
  };
}

/** 根据是否正确及做题用时给出推荐的默认 SM-2 档位 */
export function suggestQualityFromAttempt(isCorrect: boolean, timeSpentSec: number): ReviewQuality {
  if (!isCorrect) return 1;
  if (timeSpentSec <= 35) return 5;
  if (timeSpentSec <= 75) return 4;
  return 3;
}
