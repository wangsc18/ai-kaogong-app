import React, { useEffect, useRef, useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { QuestionOption } from '../types/models';

export interface QuestionViewProps {
  sourceBadge?: string;
  materialText?: string | null;
  materialImageUri?: string | null;
  stemText: string;
  /** 若为未命中原题库的实拍图，或用户手动切到看实拍原图 */
  capturedStemImageUri?: string | null;
  isMatchedCleanQuestion?: boolean;
  options: QuestionOption[];
  correctAnswer: string;
  previousWrongAnswer?: string;
  fastTips?: string;
  analysisText?: string;
  /** 是否默认直接展开答案解析（错题浏览模式 vs 遮挡刷题模式） */
  defaultRevealAnswer?: boolean;
  onAttemptComplete?: (result: {
    selectedAnswer: string;
    isCorrect: boolean;
    timeSpentSec: number;
  }) => void;
}

export function QuestionView({
  sourceBadge,
  materialText,
  materialImageUri,
  stemText,
  capturedStemImageUri,
  isMatchedCleanQuestion,
  options,
  correctAnswer,
  previousWrongAnswer,
  fastTips,
  analysisText,
  defaultRevealAnswer = false,
  onAttemptComplete,
}: QuestionViewProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<boolean>(defaultRevealAnswer);
  const [showCapturedPhoto, setShowCapturedPhoto] = useState<boolean>(
    Boolean(capturedStemImageUri && !isMatchedCleanQuestion)
  );
  const [expandMaterial, setExpandMaterial] = useState<boolean>(true);
  const startTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    setSelected(null);
    setRevealed(defaultRevealAnswer);
    setShowCapturedPhoto(Boolean(capturedStemImageUri && !isMatchedCleanQuestion));
    startTimeRef.current = Date.now();
  }, [stemText, correctAnswer, defaultRevealAnswer, capturedStemImageUri, isMatchedCleanQuestion]);

  const handleSelectOption = (key: string) => {
    if (revealed) return;
    const elapsedSec = Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000));
    setSelected(key);
    setRevealed(true);
    const isCorrect = key.toUpperCase() === (correctAnswer || '').trim().toUpperCase();
    onAttemptComplete?.({
      selectedAnswer: key,
      isCorrect,
      timeSpentSec: elapsedSec,
    });
  };

  return (
    <View style={styles.container}>
      {/* 顶部来源与双轨视图切换 */}
      {(sourceBadge || (isMatchedCleanQuestion && capturedStemImageUri)) && (
        <View style={styles.topRow}>
          {sourceBadge ? (
            <View style={styles.sourcePill}>
              <Text style={styles.sourceText} numberOfLines={1}>
                {sourceBadge}
              </Text>
            </View>
          ) : (
            <View />
          )}

          {isMatchedCleanQuestion && capturedStemImageUri ? (
            <Pressable
              style={styles.switchTrackBtn}
              onPress={() => setShowCapturedPhoto((v) => !v)}
            >
              <Ionicons
                name={showCapturedPhoto ? 'document-text-outline' : 'image-outline'}
                size={13}
                color="#4338CA"
              />
              <Text style={styles.switchTrackText}>
                {showCapturedPhoto ? '切回无笔迹原题' : '对照我的实拍图'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {/* 共享统计材料区（资料分析） */}
      {(materialText || materialImageUri) && (
        <View style={styles.materialCard}>
          <Pressable
            style={styles.materialHeader}
            onPress={() => setExpandMaterial((v) => !v)}
          >
            <Text style={styles.materialHeaderTitle}>📊 统计材料与图表（点击折叠/展开）</Text>
            <Ionicons
              name={expandMaterial ? 'chevron-up' : 'chevron-down'}
              size={16}
              color="#4B5563"
            />
          </Pressable>
          {expandMaterial && (
            <View style={styles.materialBody}>
              {materialImageUri ? (
                <Image
                  source={{ uri: materialImageUri }}
                  style={styles.capturedImage}
                  resizeMode="contain"
                />
              ) : null}
              {materialText ? <Text style={styles.materialText}>{materialText}</Text> : null}
            </View>
          )}
        </View>
      )}

      {/* 实拍裁剪图展示（模考题默认展示，命中真题时可手动切换对照） */}
      {showCapturedPhoto && capturedStemImageUri ? (
        <View style={styles.photoBox}>
          <Image
            source={{ uri: capturedStemImageUri }}
            style={styles.capturedImage}
            resizeMode="contain"
          />
        </View>
      ) : null}

      {/* 题干 */}
      <Text style={styles.stemText}>{stemText}</Text>

      {/* 可交互 A/B/C/D 选项列表 */}
      <View style={styles.optionsWrap}>
        {options.map((opt) => {
          const optKey = opt.key.toUpperCase();
          const normCorrect = (correctAnswer || '').trim().toUpperCase();
          const isCorrectOpt = optKey === normCorrect;
          const isSelectedOpt = selected === optKey;

          let cardStyle = styles.optDefault;
          let keyCircleStyle = styles.keyCircleDefault;
          let keyTextStyle = styles.keyTextDefault;

          if (revealed) {
            if (isCorrectOpt) {
              cardStyle = styles.optCorrect;
              keyCircleStyle = styles.keyCircleCorrect;
              keyTextStyle = styles.keyTextActive;
            } else if (isSelectedOpt) {
              cardStyle = styles.optWrong;
              keyCircleStyle = styles.keyCircleWrong;
              keyTextStyle = styles.keyTextActive;
            }
          }

          return (
            <Pressable
              key={optKey}
              style={[styles.optBase, cardStyle]}
              onPress={() => handleSelectOption(optKey)}
            >
              <View style={[styles.keyCircleBase, keyCircleStyle]}>
                <Text style={keyTextStyle}>{optKey}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.optText}>{opt.text}</Text>
                {revealed && previousWrongAnswer === optKey && !isCorrectOpt ? (
                  <Text style={styles.prevWrongHint}>曾错选此项</Text>
                ) : null}
              </View>
              {revealed && isCorrectOpt ? (
                <Ionicons name="checkmark-circle" size={20} color="#059669" />
              ) : null}
              {revealed && isSelectedOpt && !isCorrectOpt ? (
                <Ionicons name="close-circle" size={20} color="#DC2626" />
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {/* 手动揭晓/遮挡答案开关 */}
      {!revealed ? (
        <Pressable style={styles.revealBtn} onPress={() => setRevealed(true)}>
          <Ionicons name="eye-outline" size={16} color="#4F46E5" />
          <Text style={styles.revealBtnText}>先不选，直接展开秒杀解析</Text>
        </Pressable>
      ) : (
        <View style={styles.analysisCard}>
          <View style={styles.ansSummaryRow}>
            <Text style={styles.ansSummaryText}>
              标准答案：<Text style={styles.ansGreen}>{correctAnswer || '?'}</Text>
            </Text>
            {selected ? (
              <Text
                style={[
                  styles.attemptTag,
                  selected === correctAnswer ? styles.attemptRight : styles.attemptWrong,
                ]}
              >
                本次作答：{selected}（{selected === correctAnswer ? '正确' : '答错'}）
              </Text>
            ) : previousWrongAnswer ? (
              <Text style={[styles.attemptTag, styles.attemptWrong]}>
                原错选：{previousWrongAnswer}
              </Text>
            ) : null}
          </View>

          {fastTips ? (
            <View style={styles.fastTipBanner}>
              <Text style={styles.fastTipTitle}>⚡ 考场秒杀 / 防坑口诀</Text>
              <Text style={styles.fastTipBody}>{fastTips}</Text>
            </View>
          ) : null}

          {analysisText ? (
            <View style={styles.detailBox}>
              <Text style={styles.detailTitle}>实战拆解步骤</Text>
              <Text style={styles.detailBody}>{analysisText}</Text>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 15,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    gap: 8,
  },
  sourcePill: {
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 6,
    flexShrink: 1,
  },
  sourceText: {
    fontSize: 11.5,
    color: '#4338CA',
    fontWeight: '600',
  },
  switchTrackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#C7D2FE',
    backgroundColor: '#F5F7FF',
  },
  switchTrackText: {
    fontSize: 11.5,
    color: '#4338CA',
    fontWeight: '600',
  },
  materialCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 12,
    overflow: 'hidden',
  },
  materialHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: '#F1F5F9',
  },
  materialHeaderTitle: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#334155',
  },
  materialBody: {
    padding: 12,
  },
  materialText: {
    fontSize: 13.5,
    lineHeight: 21,
    color: '#334155',
  },
  photoBox: {
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    padding: 6,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  capturedImage: {
    width: '100%',
    height: 190,
    borderRadius: 6,
  },
  stemText: {
    fontSize: 15.5,
    lineHeight: 24,
    color: '#111827',
    fontWeight: '500',
    marginBottom: 14,
  },
  optionsWrap: {
    gap: 9,
  },
  optBase: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1.2,
    gap: 10,
  },
  optDefault: {
    backgroundColor: '#F9FAFB',
    borderColor: '#E5E7EB',
  },
  optCorrect: {
    backgroundColor: '#ECFDF5',
    borderColor: '#10B981',
  },
  optWrong: {
    backgroundColor: '#FEF2F2',
    borderColor: '#EF4444',
  },
  keyCircleBase: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyCircleDefault: {
    backgroundColor: '#E5E7EB',
  },
  keyCircleCorrect: {
    backgroundColor: '#059669',
  },
  keyCircleWrong: {
    backgroundColor: '#DC2626',
  },
  keyTextDefault: {
    fontSize: 13,
    fontWeight: '700',
    color: '#374151',
  },
  keyTextActive: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  optText: {
    fontSize: 14.5,
    lineHeight: 21,
    color: '#1F2937',
  },
  prevWrongHint: {
    fontSize: 11,
    color: '#DC2626',
    marginTop: 2,
    fontWeight: '600',
  },
  revealBtn: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: '#EEF2FF',
  },
  revealBtnText: {
    fontSize: 13,
    color: '#4F46E5',
    fontWeight: '600',
  },
  analysisCard: {
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    gap: 10,
  },
  ansSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  ansSummaryText: {
    fontSize: 14.5,
    fontWeight: '700',
    color: '#111827',
  },
  ansGreen: {
    color: '#059669',
    fontSize: 16.5,
    fontWeight: '800',
  },
  attemptTag: {
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  attemptRight: {
    backgroundColor: '#D1FAE5',
    color: '#065F46',
  },
  attemptWrong: {
    backgroundColor: '#FEE2E2',
    color: '#B91C1C',
  },
  fastTipBanner: {
    backgroundColor: '#FFFBEB',
    borderRadius: 10,
    padding: 11,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  fastTipTitle: {
    fontSize: 12.5,
    fontWeight: '800',
    color: '#92400E',
    marginBottom: 4,
  },
  fastTipBody: {
    fontSize: 13.5,
    lineHeight: 20,
    color: '#78350F',
  },
  detailBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    padding: 11,
  },
  detailTitle: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 4,
  },
  detailBody: {
    fontSize: 13.8,
    lineHeight: 21.5,
    color: '#1E293B',
  },
});
