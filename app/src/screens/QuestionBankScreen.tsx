import React, { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { QuestionView } from '../components/QuestionView';
import { ModuleBadge } from '../components/TagBadge';
import { queryRealQuestions, recordPracticeAttempt } from '../db/database';
import { KAOGONG_TAXONOMY, MODULES_L1 } from '../taxonomy/kaogongTaxonomy';
import { ModuleL1, RealQuestion } from '../types/models';

interface Props {
  refreshTick: number;
  totalCount: number;
  activePackName: string;
  presetFilter?: {
    moduleL1: ModuleL1;
    motherTypeL3?: string;
    seq: number;
  } | null;
}

export function QuestionBankScreen({
  refreshTick,
  totalCount,
  activePackName,
  presetFilter,
}: Props) {
  const [moduleFilter, setModuleFilter] = useState<ModuleL1 | '全部'>('全部');
  const [motherFilter, setMotherFilter] = useState<string>('');
  const [keyword, setKeyword] = useState<string>('');
  const [questions, setQuestions] = useState<RealQuestion[]>([]);
  const [expandedQid, setExpandedQid] = useState<string | null>(null);

  useEffect(() => {
    if (!presetFilter) return;
    setModuleFilter(presetFilter.moduleL1);
    const allMothers = Object.values(KAOGONG_TAXONOMY[presetFilter.moduleL1]).flat();
    const rawTarget = (presetFilter.motherTypeL3 || '').trim();
    const matchedL3 = rawTarget
      ? allMothers.find(
          (std) =>
            std === rawTarget ||
            std.includes(rawTarget) ||
            rawTarget.includes(std.split('(')[0])
        ) || ''
      : '';
    setMotherFilter(matchedL3);
    setKeyword(matchedL3 ? '' : rawTarget);
  }, [presetFilter]);

  const loadQuestions = useCallback(async () => {
    const list = await queryRealQuestions({
      moduleL1: moduleFilter,
      motherTypeL3: motherFilter || undefined,
      keyword: keyword || undefined,
      limit: 60,
    });
    setQuestions(list);
  }, [moduleFilter, motherFilter, keyword]);

  useEffect(() => {
    loadQuestions();
  }, [loadQuestions, refreshTick]);

  const availableMothers =
    moduleFilter === '全部'
      ? []
      : Object.values(KAOGONG_TAXONOMY[moduleFilter]).flat();

  return (
    <View style={styles.container}>
      {/* 顶部题库状态与 FTS5 搜索栏 */}
      <View style={styles.headerBox}>
        <View style={styles.packStatusRow}>
          <Text style={styles.packTitle} numberOfLines={1}>
            📦 {activePackName}
          </Text>
          <Text style={styles.packCount}>共 {totalCount} 题</Text>
        </View>

        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color="#9CA3AF" />
          <TextInput
            style={styles.searchInput}
            placeholder="全文秒搜：如 相得益彰 / 两期比重差 / 新质生产力"
            value={keyword}
            onChangeText={setKeyword}
          />
          {keyword ? (
            <Pressable onPress={() => setKeyword('')}>
              <Ionicons name="close-circle" size={16} color="#9CA3AF" />
            </Pressable>
          ) : null}
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {(['全部', ...MODULES_L1] as const).map((m) => {
            const active = moduleFilter === m;
            return (
              <Pressable
                key={m}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => {
                  setModuleFilter(m);
                  setMotherFilter('');
                }}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{m}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {availableMothers.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            <Pressable
              style={[styles.subChip, !motherFilter && styles.subChipActive]}
              onPress={() => setMotherFilter('')}
            >
              <Text style={[styles.subChipText, !motherFilter && styles.subChipTextActive]}>
                全部母题
              </Text>
            </Pressable>
            {availableMothers.map((l3) => {
              const active = motherFilter === l3;
              return (
                <Pressable
                  key={l3}
                  style={[styles.subChip, active && styles.subChipActive]}
                  onPress={() => setMotherFilter(l3)}
                >
                  <Text style={[styles.subChipText, active && styles.subChipTextActive]}>
                    {l3}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
      </View>

      {/* 真题折叠练习列表 */}
      <ScrollView contentContainerStyle={styles.listBody}>
        {questions.map((q) => {
          const isOpen = expandedQid === q.qid;
          return (
            <View key={q.qid} style={styles.qCard}>
              <Pressable
                style={styles.qCardHeader}
                onPress={() => setExpandedQid(isOpen ? null : q.qid)}
              >
                <View style={{ flex: 1, gap: 5 }}>
                  <View style={styles.qMetaRow}>
                    <ModuleBadge module={q.moduleL1} />
                    <Text style={styles.motherText} numberOfLines={1}>
                      {q.motherTypeL3}
                    </Text>
                    <Text style={styles.yearText}>{q.year}·{q.province}</Text>
                  </View>
                  {!isOpen ? (
                    <Text style={styles.stemPreview} numberOfLines={2}>
                      {q.stem}
                    </Text>
                  ) : null}
                </View>
                <Ionicons
                  name={isOpen ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color="#6B7280"
                />
              </Pressable>

              {isOpen ? (
                <View style={styles.expandedWrap}>
                  <QuestionView
                    sourceBadge={q.sourceExam}
                    materialText={q.materialText}
                    stemText={q.stem}
                    options={q.options}
                    correctAnswer={q.answer}
                    fastTips={q.fastTips}
                    analysisText={q.officialAnalysis}
                    defaultRevealAnswer={false}
                    onAttemptComplete={async (res) => {
                      await recordPracticeAttempt({
                        id: `pl_bank_${Date.now()}`,
                        targetType: 'real_question',
                        targetId: q.qid,
                        selectedAnswer: res.selectedAnswer,
                        isCorrect: res.isCorrect,
                        timeSpentSec: res.timeSpentSec,
                        createdAt: Date.now(),
                      });
                    }}
                  />
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  headerBox: {
    backgroundColor: '#FFFFFF',
    paddingTop: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    gap: 8,
  },
  packStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  packTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#374151',
    flex: 1,
  },
  packCount: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4F46E5',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    marginHorizontal: 14,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 38,
    gap: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 13.5,
    color: '#111827',
    paddingVertical: 0,
  },
  chipRow: {
    paddingHorizontal: 14,
    gap: 7,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#F3F4F6',
  },
  chipActive: {
    backgroundColor: '#4F46E5',
  },
  chipText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: '#4B5563',
  },
  chipTextActive: {
    color: '#FFFFFF',
  },
  subChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FAFAFA',
  },
  subChipActive: {
    borderColor: '#0F766E',
    backgroundColor: '#F0FDFA',
  },
  subChipText: {
    fontSize: 11.5,
    color: '#6B7280',
    fontWeight: '600',
  },
  subChipTextActive: {
    color: '#0F766E',
  },
  listBody: {
    padding: 14,
    paddingBottom: 32,
    gap: 10,
  },
  qCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    overflow: 'hidden',
  },
  qCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 13,
    gap: 8,
  },
  qMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  motherText: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: '700',
    color: '#0F766E',
  },
  yearText: {
    fontSize: 11.5,
    color: '#6B7280',
    fontWeight: '600',
  },
  stemPreview: {
    fontSize: 13.8,
    lineHeight: 20,
    color: '#1F2937',
  },
  expandedWrap: {
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
});
