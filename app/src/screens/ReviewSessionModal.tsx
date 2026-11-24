import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { QuestionView } from '../components/QuestionView';
import { ModuleBadge } from '../components/TagBadge';
import { recordPracticeAttempt, upsertMistake } from '../db/database';
import {
  computeNextSM2State,
  ReviewQuality,
  suggestQualityFromAttempt,
} from '../engine/sm2';
import { MistakeRecord } from '../types/models';

interface Props {
  visible: boolean;
  queue: MistakeRecord[];
  onClose: () => void;
  onFinished: () => void;
}

export function ReviewSessionModal({ visible, queue, onClose, onFinished }: Props) {
  const [index, setIndex] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [attemptResult, setAttemptResult] = useState<{
    selectedAnswer: string;
    isCorrect: boolean;
    timeSpentSec: number;
  } | null>(null);
  const [correctCount, setCorrectCount] = useState(0);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    if (visible) {
      setIndex(0);
      setElapsedSec(0);
      setAttemptResult(null);
      setCorrectCount(0);
      setCompleted(false);
    }
  }, [visible, queue]);

  useEffect(() => {
    if (!visible || completed || attemptResult) return;
    const timer = setInterval(() => {
      setElapsedSec((s) => s + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [visible, completed, attemptResult, index]);

  if (!queue.length) return null;

  const current = queue[index];

  const handleGradeAndNext = async (quality: ReviewQuality) => {
    if (!current) return;
    const spent = attemptResult?.timeSpentSec || Math.max(1, elapsedSec);
    const isCorrect = attemptResult ? attemptResult.isCorrect : quality >= 3;
    if (isCorrect) setCorrectCount((c) => c + 1);

    const nextSm2 = computeNextSM2State(current, quality);
    await upsertMistake({
      ...current,
      ...nextSm2,
      lastTimeSpentSec: spent,
      updatedAt: Date.now(),
    });
    await recordPracticeAttempt({
      id: `pl_rev_${Date.now()}_${index}`,
      targetType: 'mistake',
      targetId: current.id,
      selectedAnswer: attemptResult?.selectedAnswer || current.correctAnswer,
      isCorrect,
      timeSpentSec: spent,
      createdAt: Date.now(),
    });

    if (index + 1 >= queue.length) {
      setCompleted(true);
      onFinished();
    } else {
      setIndex((i) => i + 1);
      setElapsedSec(0);
      setAttemptResult(null);
    }
  };

  const suggestedQ = attemptResult
    ? suggestQualityFromAttempt(attemptResult.isCorrect, attemptResult.timeSpentSec)
    : null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={{ padding: 4 }}>
            <Ionicons name="close" size={24} color="#111827" />
          </Pressable>
          <Text style={styles.headerTitle}>
            {completed ? '今日复盘完成' : `沉浸重刷 (${index + 1} / ${queue.length})`}
          </Text>
          <View style={styles.timerPill}>
            <Ionicons name="time-outline" size={14} color="#4F46E5" />
            <Text style={styles.timerText}>{elapsedSec}s</Text>
          </View>
        </View>

        {completed ? (
          <View style={styles.doneContainer}>
            <Ionicons name="trophy" size={64} color="#F59E0B" />
            <Text style={styles.doneTitle}>本轮错题清零完成！</Text>
            <Text style={styles.doneSub}>
              共重刷 {queue.length} 题 · 本轮一次做对 {correctCount} 题
            </Text>
            <Text style={styles.doneHint}>
              SM-2 遗忘曲线已根据你的作答速度自动编排下次复习日期
            </Text>
            <Pressable style={styles.finishBtn} onPress={onClose}>
              <Text style={styles.finishBtnText}>返回主页</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <ScrollView contentContainerStyle={styles.scrollBody}>
              <View style={styles.metaRow}>
                <ModuleBadge module={current.moduleL1} />
                <Text style={styles.motherText}>{current.motherTypeL3}</Text>
              </View>

              <QuestionView
                key={current.id}
                sourceBadge={
                  current.matchedSourceExam
                    ? `真题 · ${current.matchedSourceExam}`
                    : '实拍错题重刷'
                }
                materialText={current.materialText}
                materialImageUri={current.captureImages.materialImageUri}
                stemText={current.stemText}
                capturedStemImageUri={current.captureImages.stemImageUri}
                isMatchedCleanQuestion={Boolean(current.matchedQid)}
                options={current.options}
                correctAnswer={current.correctAnswer}
                previousWrongAnswer={current.myWrongAnswer}
                fastTips={current.pitfallWarning}
                analysisText={current.aiFastSolution}
                defaultRevealAnswer={false}
                onAttemptComplete={(res) => setAttemptResult(res)}
              />
            </ScrollView>

            {attemptResult ? (
              <View style={styles.gradeBar}>
                <Text style={styles.gradePrompt}>
                  用时 {attemptResult.timeSpentSec}s · 选择掌握程度排定下次复习间隔：
                </Text>
                <View style={styles.gradeButtonsRow}>
                  <Pressable
                    style={[
                      styles.gradeBtn,
                      { backgroundColor: '#FEE2E2' },
                      suggestedQ === 1 && styles.gradeHighlight,
                    ]}
                    onPress={() => handleGradeAndNext(1)}
                  >
                    <Text style={[styles.gradeBtnTitle, { color: '#B91C1C' }]}>重来</Text>
                    <Text style={styles.gradeBtnSub}>明日再刷</Text>
                  </Pressable>

                  <Pressable
                    style={[
                      styles.gradeBtn,
                      { backgroundColor: '#FEF3C7' },
                      suggestedQ === 3 && styles.gradeHighlight,
                    ]}
                    onPress={() => handleGradeAndNext(3)}
                  >
                    <Text style={[styles.gradeBtnTitle, { color: '#92400E' }]}>吃力</Text>
                    <Text style={styles.gradeBtnSub}>短间隔</Text>
                  </Pressable>

                  <Pressable
                    style={[
                      styles.gradeBtn,
                      { backgroundColor: '#E0E7FF' },
                      suggestedQ === 4 && styles.gradeHighlight,
                    ]}
                    onPress={() => handleGradeAndNext(4)}
                  >
                    <Text style={[styles.gradeBtnTitle, { color: '#3730A3' }]}>熟练</Text>
                    <Text style={styles.gradeBtnSub}>标准间隔</Text>
                  </Pressable>

                  <Pressable
                    style={[
                      styles.gradeBtn,
                      { backgroundColor: '#D1FAE5' },
                      suggestedQ === 5 && styles.gradeHighlight,
                    ]}
                    onPress={() => handleGradeAndNext(5)}
                  >
                    <Text style={[styles.gradeBtnTitle, { color: '#065F46' }]}>秒杀</Text>
                    <Text style={styles.gradeBtnSub}>大幅延后</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  timerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 12,
  },
  timerText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#4F46E5',
  },
  scrollBody: {
    padding: 14,
    paddingBottom: 30,
    gap: 10,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  motherText: {
    fontSize: 12.5,
    color: '#4B5563',
    fontWeight: '600',
  },
  gradeBar: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    gap: 8,
  },
  gradePrompt: {
    fontSize: 12,
    color: '#4B5563',
    fontWeight: '600',
  },
  gradeButtonsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  gradeBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 9,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  gradeHighlight: {
    borderColor: '#4F46E5',
  },
  gradeBtnTitle: {
    fontSize: 13.5,
    fontWeight: '800',
  },
  gradeBtnSub: {
    fontSize: 10.5,
    color: '#4B5563',
    marginTop: 1,
  },
  doneContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 10,
  },
  doneTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#111827',
    marginTop: 6,
  },
  doneSub: {
    fontSize: 14.5,
    fontWeight: '600',
    color: '#374151',
  },
  doneHint: {
    fontSize: 12.5,
    color: '#6B7280',
    textAlign: 'center',
  },
  finishBtn: {
    marginTop: 14,
    backgroundColor: '#4F46E5',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 10,
  },
  finishBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});
