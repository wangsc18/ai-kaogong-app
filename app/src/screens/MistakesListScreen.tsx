import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ErrorReasonBadge, MasteryBadge, ModuleBadge } from '../components/TagBadge';
import { listMistakes } from '../db/database';
import { exportPracticePdf } from '../services/pdfExportService';
import { ERROR_REASONS, MODULES_L1 } from '../taxonomy/kaogongTaxonomy';
import { ErrorReason, MistakeRecord, ModuleL1 } from '../types/models';

interface Props {
  refreshTick: number;
  onSelectMistake: (m: MistakeRecord) => void;
  onOpenCapture: () => void;
  onStartFilteredReview: (items: MistakeRecord[]) => void;
}

export function MistakesListScreen({
  refreshTick,
  onSelectMistake,
  onOpenCapture,
  onStartFilteredReview,
}: Props) {
  const [moduleFilter, setModuleFilter] = useState<ModuleL1 | '全部'>('全部');
  const [reasonFilter, setReasonFilter] = useState<ErrorReason | '全部'>('全部');
  const [keyword, setKeyword] = useState('');
  const [mistakes, setMistakes] = useState<MistakeRecord[]>([]);

  // 批量选择导出无答案 PDF 状态
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exportingPdf, setExportingPdf] = useState(false);

  const loadData = useCallback(async () => {
    const rows = await listMistakes({
      moduleL1: moduleFilter,
      errorReason: reasonFilter,
      keyword,
    });
    setMistakes(rows);
  }, [moduleFilter, reasonFilter, keyword]);

  useEffect(() => {
    loadData();
  }, [loadData, refreshTick]);

  const toggleSelectId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExportPdf = (includeSimilarCount: number) => {
    const targetList = mistakes.filter((m) => selectedIds.has(m.id));
    if (!targetList.length) {
      Alert.alert('提示', '请先勾选至少 1 道错题');
      return;
    }
    setExportingPdf(true);
    exportPracticePdf({
      mistakes: targetList,
      includeSimilarCount,
    })
      .catch((err: any) => Alert.alert('PDF 导出失败', err?.message || String(err)))
      .finally(() => setExportingPdf(false));
  };

  return (
    <View style={styles.container}>
      {/* 搜索与工具栏 */}
      <View style={styles.topBar}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={16} color="#9CA3AF" />
          <TextInput
            style={styles.searchInput}
            placeholder="搜题干、成语锚点、母题或笔记..."
            value={keyword}
            onChangeText={setKeyword}
          />
          {keyword ? (
            <Pressable onPress={() => setKeyword('')}>
              <Ionicons name="close-circle" size={16} color="#9CA3AF" />
            </Pressable>
          ) : null}
        </View>

        <Pressable
          style={[styles.pdfModeBtn, selectMode && styles.pdfModeBtnActive]}
          onPress={() => {
            if (!selectMode) {
              setSelectMode(true);
              setSelectedIds(new Set(mistakes.map((m) => m.id)));
            } else {
              setSelectMode(false);
              setSelectedIds(new Set());
            }
          }}
        >
          <Ionicons
            name="print-outline"
            size={16}
            color={selectMode ? '#FFFFFF' : '#4F46E5'}
          />
          <Text style={[styles.pdfModeText, selectMode && { color: '#FFFFFF' }]}>
            {selectMode ? '取消勾选' : '组卷PDF'}
          </Text>
        </Pressable>
      </View>

      {/* 模块横向过滤 */}
      <View style={styles.filterSection}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
          {(['全部', ...MODULES_L1] as const).map((mod) => {
            const active = moduleFilter === mod;
            return (
              <Pressable
                key={mod}
                style={[styles.filterChip, active && styles.filterChipActive]}
                onPress={() => setModuleFilter(mod)}
              >
                <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                  {mod}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.filterRow, { marginTop: 6 }]}>
          <Pressable
            style={[styles.subChip, reasonFilter === '全部' && styles.subChipActive]}
            onPress={() => setReasonFilter('全部')}
          >
            <Text style={[styles.subChipText, reasonFilter === '全部' && styles.subChipTextActive]}>
              全部错因
            </Text>
          </Pressable>
          {ERROR_REASONS.map((r) => {
            const active = reasonFilter === r.value;
            return (
              <Pressable
                key={r.value}
                style={[styles.subChip, active && styles.subChipActive]}
                onPress={() => setReasonFilter(r.value)}
              >
                <Text style={[styles.subChipText, active && styles.subChipTextActive]}>
                  {r.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* 结果统计与一键限时刷当前筛选结果 */}
      {mistakes.length > 0 && !selectMode ? (
        <View style={styles.summaryStrip}>
          <Text style={styles.summaryStripText}>共筛选出 {mistakes.length} 道错题</Text>
          <Pressable onPress={() => onStartFilteredReview(mistakes)}>
            <Text style={styles.summaryAction}>⚡ 沉浸重刷这组错题</Text>
          </Pressable>
        </View>
      ) : null}

      {/* 错题卡片列表 */}
      <ScrollView contentContainerStyle={styles.listBody}>
        {mistakes.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Ionicons name="document-text-outline" size={40} color="#9CA3AF" />
            <Text style={styles.emptyText}>当前筛选条件下暂无错题</Text>
            <Pressable style={styles.addBtn} onPress={onOpenCapture}>
              <Text style={styles.addBtnText}>+ 拍照 / 截图录入错题</Text>
            </Pressable>
          </View>
        ) : (
          mistakes.map((m) => {
            const checked = selectedIds.has(m.id);
            return (
              <Pressable
                key={m.id}
                style={[styles.itemCard, selectMode && checked && styles.itemCardChecked]}
                onPress={() =>
                  selectMode ? toggleSelectId(m.id) : onSelectMistake(m)
                }
              >
                <View style={styles.itemHeader}>
                  {selectMode ? (
                    <Ionicons
                      name={checked ? 'checkbox' : 'square-outline'}
                      size={20}
                      color={checked ? '#4F46E5' : '#9CA3AF'}
                    />
                  ) : null}
                  <ModuleBadge module={m.moduleL1} />
                  <Text style={styles.motherLabel} numberOfLines={1}>
                    {m.motherTypeL3}
                  </Text>
                  <MasteryBadge status={m.masteryStatus} />
                </View>

                <Text style={styles.stemPreview} numberOfLines={3}>
                  {m.stemText}
                </Text>

                <View style={styles.itemFooter}>
                  <ErrorReasonBadge reason={m.errorReason} />
                  <Text style={styles.ansHint}>
                    错选 {m.myWrongAnswer || '-'} → 正解 {m.correctAnswer}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>

      {/* 底部 PDF 导出操作浮动栏 */}
      {selectMode ? (
        <View style={styles.pdfFooterBar}>
          {exportingPdf ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator color="#4F46E5" />
              <Text style={styles.pdfCountText}>正在排版生成无答案刷题卷 PDF...</Text>
            </View>
          ) : (
            <>
              <Text style={styles.pdfCountText}>已选 {selectedIds.size} 道错题</Text>
              <View style={styles.pdfBtnsRow}>
                <Pressable
                  style={styles.pdfSecondaryBtn}
                  onPress={() => handleExportPdf(0)}
                >
                  <Text style={styles.pdfSecondaryText}>仅导错题PDF</Text>
                </Pressable>
                <Pressable
                  style={styles.pdfPrimaryBtn}
                  onPress={() => handleExportPdf(2)}
                >
                  <Text style={styles.pdfPrimaryText}>
                    导「错题+各配2道同类真题」PDF
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 8,
    backgroundColor: '#FFFFFF',
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
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
  pdfModeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#C7D2FE',
    backgroundColor: '#EEF2FF',
  },
  pdfModeBtnActive: {
    backgroundColor: '#4F46E5',
    borderColor: '#4F46E5',
  },
  pdfModeText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#4F46E5',
  },
  filterSection: {
    backgroundColor: '#FFFFFF',
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  filterRow: {
    paddingHorizontal: 14,
    gap: 7,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#F3F4F6',
  },
  filterChipActive: {
    backgroundColor: '#4F46E5',
  },
  filterChipText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: '#4B5563',
  },
  filterChipTextActive: {
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
  summaryStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  summaryStripText: {
    fontSize: 12,
    color: '#6B7280',
  },
  summaryAction: {
    fontSize: 12.5,
    color: '#4F46E5',
    fontWeight: '700',
  },
  listBody: {
    paddingHorizontal: 14,
    paddingTop: 4,
    paddingBottom: 28,
    gap: 10,
  },
  itemCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 13,
    padding: 13,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 8,
  },
  itemCardChecked: {
    borderColor: '#4F46E5',
    backgroundColor: '#F5F7FF',
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  motherLabel: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: '700',
    color: '#0F766E',
  },
  stemPreview: {
    fontSize: 14,
    lineHeight: 20.5,
    color: '#1F2937',
  },
  itemFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  ansHint: {
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '600',
  },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: 56,
    gap: 10,
  },
  emptyText: {
    fontSize: 14,
    color: '#6B7280',
  },
  addBtn: {
    backgroundColor: '#4F46E5',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 4,
  },
  addBtnText: {
    color: '#FFFFFF',
    fontSize: 13.5,
    fontWeight: '700',
  },
  pdfFooterBar: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    gap: 8,
  },
  pdfCountText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#374151',
  },
  pdfBtnsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  pdfSecondaryBtn: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
  },
  pdfSecondaryText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#374151',
  },
  pdfPrimaryBtn: {
    flex: 1,
    backgroundColor: '#4F46E5',
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: 'center',
  },
  pdfPrimaryText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
