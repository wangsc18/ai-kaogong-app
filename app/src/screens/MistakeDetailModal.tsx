import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { askFollowUpTutor } from '../ai/aiClient';
import { QuestionView } from '../components/QuestionView';
import { ErrorReasonBadge, MasteryBadge, ModuleBadge } from '../components/TagBadge';
import {
  deleteMistakeById,
  loadAISettings,
  recordPracticeAttempt,
  upsertMistake,
} from '../db/database';
import { recommendSimilarRealQuestions } from '../engine/recommender';
import { computeNextSM2State, suggestQualityFromAttempt } from '../engine/sm2';
import {
  MistakeRecord,
  RecommendationMode,
  RecommendedRealQuestion,
} from '../types/models';

interface Props {
  mistake: MistakeRecord | null;
  visible: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

export function MistakeDetailModal({ mistake, visible, onClose, onUpdated }: Props) {
  const [record, setRecord] = useState<MistakeRecord | null>(mistake);
  const [recMode, setRecMode] = useState<RecommendationMode>('mother_type');
  const [recommendations, setRecommendations] = useState<RecommendedRealQuestion[]>([]);
  const [expandedQid, setExpandedQid] = useState<string | null>(null);
  const [redoMode, setRedoMode] = useState<boolean>(false);

  // 追问私教状态
  const [chatInput, setChatInput] = useState('');
  const [askingTutor, setAskingTutor] = useState(false);

  const loadRecommendations = useCallback(
    async (target: MistakeRecord, mode: RecommendationMode) => {
      const list = await recommendSimilarRealQuestions(target, mode, 5);
      setRecommendations(list);
      if (list.length > 0) {
        setExpandedQid((prev) => prev || list[0].question.qid);
      }
    },
    []
  );

  useEffect(() => {
    setRecord(mistake);
    setRedoMode(false);
    setExpandedQid(null);
    if (mistake) {
      // 言语逻辑填空或政治理论若存在丰富锚点词，依然默认展示母题但随时可切锚点词
      loadRecommendations(mistake, recMode);
    }
  }, [mistake, visible, loadRecommendations, recMode]);

  if (!record) return null;

  const handleModeSwitch = async (nextMode: RecommendationMode) => {
    setRecMode(nextMode);
    await loadRecommendations(record, nextMode);
  };

  const handleMistakeRedoComplete = async (res: {
    selectedAnswer: string;
    isCorrect: boolean;
    timeSpentSec: number;
  }) => {
    const quality = suggestQualityFromAttempt(res.isCorrect, res.timeSpentSec);
    const nextSm2 = computeNextSM2State(record, quality);
    const updated: MistakeRecord = {
      ...record,
      ...nextSm2,
      lastTimeSpentSec: res.timeSpentSec,
      updatedAt: Date.now(),
    };
    await upsertMistake(updated);
    await recordPracticeAttempt({
      id: `pl_${Date.now()}`,
      targetType: 'mistake',
      targetId: record.id,
      selectedAnswer: res.selectedAnswer,
      isCorrect: res.isCorrect,
      timeSpentSec: res.timeSpentSec,
      createdAt: Date.now(),
    });
    setRecord(updated);
    onUpdated();
  };

  const handleSimilarAttemptComplete = async (
    qid: string,
    res: { selectedAnswer: string; isCorrect: boolean; timeSpentSec: number }
  ) => {
    await recordPracticeAttempt({
      id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      targetType: 'real_question',
      targetId: qid,
      sourceMistakeId: record.id,
      selectedAnswer: res.selectedAnswer,
      isCorrect: res.isCorrect,
      timeSpentSec: res.timeSpentSec,
      createdAt: Date.now(),
    });
    await loadRecommendations(record, recMode);
  };

  const handleAskTutor = async () => {
    const q = chatInput.trim();
    if (!q || askingTutor) return;
    setAskingTutor(true);
    try {
      const settings = await loadAISettings();
      const reply = await askFollowUpTutor(record, q, settings);
      const now = Date.now();
      const updated: MistakeRecord = {
        ...record,
        chatHistory: [
          ...record.chatHistory,
          { role: 'user', content: q, timestamp: now },
          { role: 'assistant', content: reply, timestamp: now + 1 },
        ],
        updatedAt: now,
      };
      await upsertMistake(updated);
      setRecord(updated);
      setChatInput('');
      onUpdated();
    } catch (err: any) {
      Alert.alert('AI 答疑提示', err?.message || String(err));
    } finally {
      setAskingTutor(false);
    }
  };

  const handleDelete = () => {
    Alert.alert('确认删除', '确定要从错题本移除这道题吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          await deleteMistakeById(record.id);
          onUpdated();
          onClose();
        },
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          {/* 顶部栏 */}
          <View style={styles.header}>
            <Pressable onPress={onClose} style={styles.iconBtn}>
              <Ionicons name="arrow-back" size={22} color="#111827" />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1}>
              错题复盘与同类真题巩固
            </Text>
            <View style={styles.headerRight}>
              <Pressable
                style={styles.redoToggleBtn}
                onPress={() => setRedoMode((v) => !v)}
              >
                <Text style={styles.redoToggleText}>
                  {redoMode ? '看解析' : '遮挡重做'}
                </Text>
              </Pressable>
              <Pressable onPress={handleDelete} style={styles.iconBtn}>
                <Ionicons name="trash-outline" size={20} color="#DC2626" />
              </Pressable>
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.scrollBody}>
            {/* 标签信息条 */}
            <View style={styles.metaBar}>
              <ModuleBadge module={record.moduleL1} />
              <View style={styles.motherBadge}>
                <Text style={styles.motherBadgeText}>{record.motherTypeL3}</Text>
              </View>
              <ErrorReasonBadge reason={record.errorReason} />
              <MasteryBadge status={record.masteryStatus} />
            </View>

            {record.userNote ? (
              <View style={styles.noteBanner}>
                <Text style={styles.noteBannerText}>📌 我的防坑笔记：{record.userNote}</Text>
              </View>
            ) : null}

            {/* 原错题主体卡片 */}
            <QuestionView
              sourceBadge={
                record.matchedSourceExam
                  ? `✨ 真题还原 · ${record.matchedSourceExam}`
                  : '📷 实拍/截图错题'
              }
              materialText={record.materialText}
              materialImageUri={record.captureImages.materialImageUri}
              stemText={record.stemText}
              capturedStemImageUri={record.captureImages.stemImageUri}
              isMatchedCleanQuestion={Boolean(record.matchedQid)}
              options={record.options}
              correctAnswer={record.correctAnswer}
              previousWrongAnswer={record.myWrongAnswer}
              fastTips={record.pitfallWarning}
              analysisText={record.aiFastSolution}
              defaultRevealAnswer={!redoMode}
              onAttemptComplete={handleMistakeRedoComplete}
            />

            {/* 核心模块：同类历年真题双维推荐与当场练习 */}
            <View style={styles.similarSection}>
              <View style={styles.similarHeader}>
                <View>
                  <Text style={styles.similarTitle}>🎯 趁热打铁 · 推荐类似历年真题</Text>
                  <Text style={styles.similarSubtitle}>
                    当场刷透同一底层模型，把秒杀肌肉记忆刻进脑子
                  </Text>
                </View>
              </View>

              {/* 双维切换器 */}
              <View style={styles.modeSwitchRow}>
                <Pressable
                  style={[
                    styles.modeTab,
                    recMode === 'mother_type' && styles.modeTabActive,
                  ]}
                  onPress={() => handleModeSwitch('mother_type')}
                >
                  <Text
                    style={[
                      styles.modeTabText,
                      recMode === 'mother_type' && styles.modeTabTextActive,
                    ]}
                  >
                    🔥 练同母题模型
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.modeTab,
                    recMode === 'anchor_keyword' && styles.modeTabActive,
                  ]}
                  onPress={() => handleModeSwitch('anchor_keyword')}
                >
                  <Text
                    style={[
                      styles.modeTabText,
                      recMode === 'anchor_keyword' && styles.modeTabTextActive,
                    ]}
                  >
                    🔍 追同成语 / 同考点词
                  </Text>
                </Pressable>
              </View>

              {recommendations.length === 0 ? (
                <Text style={styles.emptyText}>
                  当前题库暂无更多同维度真题，可在「设置」导入全量 6 万道国省考真题包。
                </Text>
              ) : (
                <View style={{ gap: 10 }}>
                  {recommendations.map((rec, idx) => {
                    const isOpen = expandedQid === rec.question.qid;
                    return (
                      <View key={rec.question.qid} style={styles.simItemCard}>
                        <Pressable
                          style={styles.simItemHeader}
                          onPress={() =>
                            setExpandedQid(isOpen ? null : rec.question.qid)
                          }
                        >
                          <View style={{ flex: 1, gap: 3 }}>
                            <View style={styles.simTitleRow}>
                              <Text style={styles.simSeqTag}>变式真题 {idx + 1}</Text>
                              <Text style={styles.simSource} numberOfLines={1}>
                                {rec.question.sourceExam}
                              </Text>
                              {rec.practicedCount > 0 ? (
                                <Text
                                  style={[
                                    styles.practicedBadge,
                                    {
                                      color: rec.lastCorrect ? '#059669' : '#DC2626',
                                    },
                                  ]}
                                >
                                  {rec.lastCorrect ? '✓ 已练对' : '✗ 曾做错'}
                                </Text>
                              ) : null}
                            </View>
                            <Text style={styles.simReason}>{rec.matchReason}</Text>
                            {!isOpen ? (
                              <Text style={styles.simStemPreview} numberOfLines={2}>
                                {rec.question.stem}
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
                          <View style={styles.simExpandedBody}>
                            <QuestionView
                              materialText={rec.question.materialText}
                              stemText={rec.question.stem}
                              options={rec.question.options}
                              correctAnswer={rec.question.answer}
                              fastTips={rec.question.fastTips}
                              analysisText={rec.question.officialAnalysis}
                              defaultRevealAnswer={false}
                              onAttemptComplete={(res) =>
                                handleSimilarAttemptComplete(rec.question.qid, res)
                              }
                            />
                          </View>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>

            {/* AI 私教多轮追问区 */}
            <View style={styles.tutorCard}>
              <Text style={styles.similarTitle}>💬 追问公考 AI 私教</Text>
              <Text style={styles.similarSubtitle}>
                还有某一步速算或干扰项没想通？直接针对本题追问
              </Text>

              {record.chatHistory.length > 0 ? (
                <View style={styles.chatList}>
                  {record.chatHistory.map((turn, i) => (
                    <View
                      key={i}
                      style={[
                        styles.chatBubble,
                        turn.role === 'user' ? styles.userBubble : styles.aiBubble,
                      ]}
                    >
                      <Text
                        style={[
                          styles.chatText,
                          turn.role === 'user' && { color: '#FFFFFF' },
                        ]}
                      >
                        {turn.content}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              <View style={styles.chatInputRow}>
                <TextInput
                  style={styles.chatInput}
                  placeholder="例如：为什么B选项属于偷换概念？"
                  value={chatInput}
                  onChangeText={setChatInput}
                />
                <Pressable
                  style={[styles.sendBtn, askingTutor && { opacity: 0.6 }]}
                  onPress={handleAskTutor}
                  disabled={askingTutor}
                >
                  {askingTutor ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Ionicons name="send" size={16} color="#FFFFFF" />
                  )}
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
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
    flex: 1,
    marginHorizontal: 8,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconBtn: {
    padding: 4,
  },
  redoToggleBtn: {
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 7,
  },
  redoToggleText: {
    fontSize: 12.5,
    color: '#4F46E5',
    fontWeight: '700',
  },
  scrollBody: {
    padding: 14,
    paddingBottom: 40,
    gap: 14,
  },
  metaBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
  },
  motherBadge: {
    backgroundColor: '#F0FDFA',
    borderColor: '#99F6E4',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  motherBadgeText: {
    fontSize: 11.5,
    color: '#0F766E',
    fontWeight: '600',
  },
  noteBanner: {
    backgroundColor: '#FEFCE8',
    borderWidth: 1,
    borderColor: '#FEF08A',
    borderRadius: 10,
    padding: 10,
  },
  noteBannerText: {
    fontSize: 13,
    color: '#854D0E',
    fontWeight: '600',
  },
  similarSection: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 12,
  },
  similarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  similarTitle: {
    fontSize: 15.5,
    fontWeight: '800',
    color: '#111827',
  },
  similarSubtitle: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  modeSwitchRow: {
    flexDirection: 'row',
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    padding: 3,
  },
  modeTab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  modeTabActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  modeTabText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: '#6B7280',
  },
  modeTabTextActive: {
    color: '#4F46E5',
    fontWeight: '700',
  },
  emptyText: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    paddingVertical: 16,
  },
  simItemCard: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 12,
    backgroundColor: '#F9FAFB',
    overflow: 'hidden',
  },
  simItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 8,
  },
  simTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  simSeqTag: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#FFFFFF',
    backgroundColor: '#4F46E5',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  simSource: {
    fontSize: 12,
    color: '#4B5563',
    fontWeight: '600',
    flex: 1,
  },
  practicedBadge: {
    fontSize: 11.5,
    fontWeight: '700',
  },
  simReason: {
    fontSize: 11.5,
    color: '#0F766E',
    fontWeight: '600',
  },
  simStemPreview: {
    fontSize: 13,
    color: '#374151',
    marginTop: 2,
  },
  simExpandedBody: {
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  tutorCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 10,
  },
  chatList: {
    gap: 8,
    marginTop: 4,
  },
  chatBubble: {
    padding: 10,
    borderRadius: 10,
    maxWidth: '90%',
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#4F46E5',
  },
  aiBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#F3F4F6',
  },
  chatText: {
    fontSize: 13.5,
    lineHeight: 20,
    color: '#1F2937',
  },
  chatInputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  chatInput: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13.5,
    color: '#111827',
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#4F46E5',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
