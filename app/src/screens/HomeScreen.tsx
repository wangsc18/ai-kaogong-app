import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ErrorReasonBadge, ModuleBadge } from '../components/TagBadge';
import { DashboardStats, MistakeRecord, StudyPlanState } from '../types/models';

interface Props {
  stats: DashboardStats;
  recentMistakes: MistakeRecord[];
  studyPlan: StudyPlanState | null;
  onOpenCapture: () => void;
  onStartDueReview: () => void;
  onStartAllReview: () => void;
  onSelectMistake: (m: MistakeRecord) => void;
  onNavigateTab: (tab: 'planner' | 'mistakes' | 'bank' | 'settings') => void;
}

export function HomeScreen({
  stats,
  recentMistakes,
  studyPlan,
  onOpenCapture,
  onStartDueReview,
  onStartAllReview,
  onSelectMistake,
  onNavigateTab,
}: Props) {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      {/* 顶部主视觉与核心大入口 */}
      <View style={styles.heroCard}>
        <View style={styles.heroTopRow}>
          <View>
            <Text style={styles.heroTitle}>公考朱批录 · 个人私教</Text>
            <Text style={styles.heroSub}>
              拍照识题双轨还原 · 实战秒杀 · 历年同类真题追击
            </Text>
          </View>
          <Pressable
            style={styles.bankPill}
            onPress={() => onNavigateTab('bank')}
          >
            <Ionicons name="library-outline" size={13} color="#E0E7FF" />
            <Text style={styles.bankPillText}>{stats.totalRealQuestions} 真题</Text>
          </Pressable>
        </View>

        <Pressable style={styles.captureHeroBtn} onPress={onOpenCapture}>
          <View style={styles.captureIconCircle}>
            <Ionicons name="camera" size={24} color="#4F46E5" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.captureHeroTitle}>拍错题 / 导粉笔截图</Text>
            <Text style={styles.captureHeroDesc}>
              自动还原干净原题、拆解秒杀口诀并推荐同类历年真题
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#FFFFFF" />
        </Pressable>

        {/* 四宫格核心数据 */}
        <View style={styles.metricsRow}>
          <View style={styles.metricItem}>
            <Text style={styles.metricValue}>{stats.totalMistakes}</Text>
            <Text style={styles.metricLabel}>累计错题</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metricItem}>
            <Text style={[styles.metricValue, { color: '#FCD34D' }]}>
              {stats.dueTodayCount}
            </Text>
            <Text style={styles.metricLabel}>今日待刷</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metricItem}>
            <Text style={[styles.metricValue, { color: '#6EE7B7' }]}>
              {stats.masteredCount}
            </Text>
            <Text style={styles.metricLabel}>已彻底掌握</Text>
          </View>
        </View>
      </View>

      {/* PDF 讲义与刷题集进度看板快捷入口 */}
      <Pressable
        style={styles.card}
        onPress={() => onNavigateTab('planner')}
      >
        <View style={styles.cardHeaderRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>
              📖 {studyPlan ? studyPlan.planTitle : '上传老师讲义 / 刷题集 PDF'}
            </Text>
            <Text style={styles.cardSub} numberOfLines={2}>
              {studyPlan
                ? `总进度 ${studyPlan.overallProgressPercent}% · 今日剩余 ${studyPlan.dailyTasks.filter((t) => !t.completed).length} 项任务 · 流派：${studyPlan.teacherPersona.teacherNameOrTag}`
                : 'AI 自动拆解整体计划、提取老师做题风格、测算学习百分比并商量每日任务'}
            </Text>
          </View>
          <View style={styles.reviewSecondaryBtn}>
            <Text style={styles.reviewSecondaryBtnText}>
              {studyPlan ? `${studyPlan.overallProgressPercent}% →` : '去上传 →'}
            </Text>
          </View>
        </View>
      </Pressable>

      {/* SM-2 遗忘曲线今日复盘队列卡片 */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>⏱️ SM-2 遗忘曲线 · 今日重刷</Text>
            <Text style={styles.cardSub}>
              {stats.dueTodayCount > 0
                ? `当前有 ${stats.dueTodayCount} 道到期错题等待遮挡答案限时重做`
                : stats.totalMistakes > 0
                ? '今日到期错题已清零！也可随时抽查全部错题巩固手感'
                : '录入第一道错题后，系统将按记忆曲线自动安排重刷计划'}
            </Text>
          </View>
          {stats.dueTodayCount > 0 ? (
            <Pressable style={styles.reviewNowBtn} onPress={onStartDueReview}>
              <Text style={styles.reviewNowBtnText}>立即开刷</Text>
            </Pressable>
          ) : stats.totalMistakes > 0 ? (
            <Pressable style={styles.reviewSecondaryBtn} onPress={onStartAllReview}>
              <Text style={styles.reviewSecondaryBtnText}>随机抽刷</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* 薄弱母题 Top 5 热力榜 */}
      {stats.topWeakMotherTypes.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🎯 高频薄弱母题排行</Text>
          <View style={{ marginTop: 10, gap: 8 }}>
            {stats.topWeakMotherTypes.map((item, idx) => (
              <View key={`${item.moduleL1}_${item.motherTypeL3}`} style={styles.weakRow}>
                <Text style={styles.weakRank}>{idx + 1}</Text>
                <ModuleBadge module={item.moduleL1} />
                <Text style={styles.weakMother} numberOfLines={1}>
                  {item.motherTypeL3}
                </Text>
                <Text style={styles.weakCount}>{item.count} 题</Text>
              </View>
            ))}
          </View>

          {stats.errorReasonBreakdown.length > 0 ? (
            <View style={styles.reasonSummaryBox}>
              <Text style={styles.reasonSummaryLabel}>掉坑错因分布：</Text>
              <View style={styles.reasonTagsWrap}>
                {stats.errorReasonBreakdown.map((r) => (
                  <View key={r.errorReason} style={styles.reasonStatItem}>
                    <ErrorReasonBadge reason={r.errorReason} />
                    <Text style={styles.reasonStatCnt}>×{r.count}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* 最近录入的错题 */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardTitle}>📚 最近录入错题</Text>
          {recentMistakes.length > 0 ? (
            <Pressable onPress={() => onNavigateTab('mistakes')}>
              <Text style={styles.linkText}>查看全部 →</Text>
            </Pressable>
          ) : null}
        </View>

        {recentMistakes.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="sparkles-outline" size={30} color="#9CA3AF" />
            <Text style={styles.emptyTitle}>错题本还是空的</Text>
            <Text style={styles.emptyDesc}>
              点击上方「拍错题」按钮，可以实拍纸质卷，也可以直接点内置演示题体验同类真题推荐闭环！
            </Text>
          </View>
        ) : (
          <View style={{ marginTop: 10, gap: 10 }}>
            {recentMistakes.slice(0, 5).map((m) => (
              <Pressable
                key={m.id}
                style={styles.recentItem}
                onPress={() => onSelectMistake(m)}
              >
                <View style={styles.recentMeta}>
                  <ModuleBadge module={m.moduleL1} />
                  <Text style={styles.recentMother} numberOfLines={1}>
                    {m.motherTypeL3}
                  </Text>
                  <ErrorReasonBadge reason={m.errorReason} />
                </View>
                <Text style={styles.recentStem} numberOfLines={2}>
                  {m.stemText}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 14,
    paddingBottom: 32,
    gap: 13,
  },
  heroCard: {
    backgroundColor: '#312E81',
    borderRadius: 18,
    padding: 16,
    gap: 14,
  },
  heroTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  heroTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  heroSub: {
    fontSize: 12,
    color: '#C7D2FE',
    marginTop: 3,
  },
  bankPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 12,
  },
  bankPillText: {
    fontSize: 11.5,
    color: '#E0E7FF',
    fontWeight: '600',
  },
  captureHeroBtn: {
    backgroundColor: '#4F46E5',
    borderRadius: 14,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  captureIconCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureHeroTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  captureHeroDesc: {
    fontSize: 11.8,
    color: '#E0E7FF',
    marginTop: 2,
  },
  metricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
    borderRadius: 12,
    paddingVertical: 10,
  },
  metricItem: {
    flex: 1,
    alignItems: 'center',
  },
  metricDivider: {
    width: 1,
    height: 24,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  metricValue: {
    fontSize: 19,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  metricLabel: {
    fontSize: 11.5,
    color: '#C7D2FE',
    marginTop: 2,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#111827',
  },
  cardSub: {
    fontSize: 12.5,
    color: '#6B7280',
    marginTop: 4,
    lineHeight: 18,
  },
  reviewNowBtn: {
    backgroundColor: '#DC2626',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
  },
  reviewNowBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  reviewSecondaryBtn: {
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 10,
  },
  reviewSecondaryBtnText: {
    color: '#4F46E5',
    fontSize: 13,
    fontWeight: '700',
  },
  weakRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  weakRank: {
    width: 18,
    fontSize: 13,
    fontWeight: '800',
    color: '#6B7280',
  },
  weakMother: {
    flex: 1,
    fontSize: 13.5,
    color: '#1F2937',
    fontWeight: '600',
  },
  weakCount: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#DC2626',
  },
  reasonSummaryBox: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  reasonSummaryLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
    marginBottom: 6,
  },
  reasonTagsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  reasonStatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  reasonStatCnt: {
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
  },
  linkText: {
    fontSize: 12.5,
    color: '#4F46E5',
    fontWeight: '700',
  },
  emptyBox: {
    alignItems: 'center',
    paddingVertical: 22,
    gap: 6,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4B5563',
  },
  emptyDesc: {
    fontSize: 12.5,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 12,
  },
  recentItem: {
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    padding: 11,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 6,
  },
  recentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  recentMother: {
    flex: 1,
    fontSize: 12,
    color: '#0F766E',
    fontWeight: '700',
  },
  recentStem: {
    fontSize: 13.5,
    color: '#1F2937',
    lineHeight: 20,
  },
});
