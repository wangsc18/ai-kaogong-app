import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  cleanupTempPickedUri,
  pickMultipleDocumentsSafe,
} from '../services/localFileReader';
import {
  analyzeBatchMaterialsAndSynthesizePlan,
  negotiateScheduleWithAi,
} from '../ai/studyPlannerAi';
import {
  PdfExtractorHandle,
  PdfExtractorWebView,
} from '../components/PdfExtractorWebView';
import { ModuleBadge } from '../components/TagBadge';
import {
  deleteCourseMaterial,
  getAppPracticeSnapshotForPlanner,
  listCourseMaterials,
  loadAISettings,
  loadStudyPlanState,
  saveStudyPlanState,
  upsertCourseMaterial,
} from '../db/database';
import {
  CourseMaterialDoc,
  DailyTaskItem,
  ModuleL1,
  StudyPlanChapter,
  StudyPlanState,
} from '../types/models';

interface Props {
  refreshTick: number;
  onPlanUpdated?: () => void;
  onPracticeChapter?: (moduleL1: ModuleL1, motherTypeL3?: string) => void;
}

type SubViewKey = 'schedule' | 'curriculum' | 'teacher';

function computeWeightedProgress(chapters: StudyPlanChapter[]): number {
  if (!chapters.length) return 0;
  let totalHours = 0;
  let earnedHours = 0;
  for (const ch of chapters) {
    const h = Math.max(0.5, ch.estimatedHours || 1);
    totalHours += h;
    earnedHours += h * (ch.progressPercent / 100);
  }
  return totalHours > 0 ? Math.min(100, Math.round((earnedHours / totalHours) * 100)) : 0;
}

export function StudyPlannerScreen({
  refreshTick,
  onPlanUpdated,
  onPracticeChapter,
}: Props) {
  const pdfExtractorRef = useRef<PdfExtractorHandle>(null);

  const [subView, setSubView] = useState<SubViewKey>('schedule');
  const [materials, setMaterials] = useState<CourseMaterialDoc[]>([]);
  const [plan, setPlan] = useState<StudyPlanState | null>(null);
  const [busyStatus, setBusyStatus] = useState<string | null>(null);

  // 协商聊天输入与进度编辑状态
  const [chatInput, setChatInput] = useState('');
  const [negotiating, setNegotiating] = useState(false);
  const [editingMatId, setEditingMatId] = useState<string | null>(null);
  const [tempPageStr, setTempPageStr] = useState('');
  const [tempQStr, setTempQStr] = useState('');

  const reloadData = useCallback(async () => {
    const [mats, savedPlan] = await Promise.all([
      listCourseMaterials(),
      loadStudyPlanState(),
    ]);
    setMaterials(mats);
    setPlan(savedPlan);
  }, []);

  useEffect(() => {
    reloadData();
  }, [reloadData, refreshTick]);

  /**
   * 第一步：批量选择并本地提取多份 PDF 讲义 / 刷题集（纯手机本地秒级提取，0 次大模型调用！）
   * 支持在系统文件选择器中长按一次多选多份 PDF，也支持分多次从不同目录继续添加
   */
  const handleAddPdfs = async () => {
    try {
      const pickedAssets = await pickMultipleDocumentsSafe(
        ['application/pdf', '*/*'],
        true
      );
      if (!pickedAssets.length) return;

      if (!pdfExtractorRef.current) {
        throw new Error('PDF 解析引擎正在初始化，请稍候一秒再试');
      }

      const nextList = [...materials];
      let addedCount = 0;

      for (let i = 0; i < pickedAssets.length; i++) {
        const asset = pickedAssets[i];
        const rawName = asset.name || `备考资料_${nextList.length + 1}.pdf`;
        const prefix =
          pickedAssets.length > 1 ? `[${i + 1}/${pickedAssets.length}] ` : '';

        setBusyStatus(`${prefix}正在本地提取《${rawName}》文字与目录...`);
        let extracted;
        try {
          extracted = await pdfExtractorRef.current.extractPdf(asset, (msg) =>
            setBusyStatus(`${prefix}《${rawName}》${msg}`)
          );
        } finally {
          cleanupTempPickedUri(asset.uri);
        }

        const now = Date.now() + i;
        const inferredType = /刷题|题集|套卷|真题|练习|作业/.test(rawName)
          ? 'workbook'
          : 'lecture';

        const existingIdx = nextList.findIndex(
          (m) => m.fileName === rawName && m.totalPages === extracted.totalPages
        );

        const stagedDoc: CourseMaterialDoc = {
          id:
            existingIdx >= 0
              ? nextList[existingIdx].id
              : `mat_${now}_${Math.random().toString(36).slice(2, 6)}`,
          fileName: rawName,
          docType: inferredType,
          moduleScope: '待统一分析',
          totalPages: extracted.totalPages,
          currentPage: existingIdx >= 0 ? nextList[existingIdx].currentPage : 0,
          totalQuestionsEst: 0,
          completedQuestionsEst:
            existingIdx >= 0 ? nextList[existingIdx].completedQuestionsEst : 0,
          outlineDigest: '',
          teacherStyleNotes: '',
          analysisStatus: 'pending',
          rawExtractedPayload: JSON.stringify(extracted),
          createdAt: existingIdx >= 0 ? nextList[existingIdx].createdAt : now,
          updatedAt: now,
        };

        await upsertCourseMaterial(stagedDoc);
        if (existingIdx >= 0) {
          nextList[existingIdx] = stagedDoc;
        } else {
          nextList.push(stagedDoc);
          addedCount += 1;
        }
        setMaterials([...nextList]);
      }

      if (addedCount > 0 && pickedAssets.length > 1) {
        Alert.alert(
          '已批量载入本地资料池 📂',
          `成功导入 ${pickedAssets.length} 份 PDF（尚未消耗大模型 Token）。你还可以继续添加其他 PDF，凑齐后点击页面上的「一键 AI 综合分析」统一生成计划！`
        );
      }
    } catch (err: any) {
      Alert.alert('PDF 本地读取失败', err?.message || String(err));
    } finally {
      setBusyStatus(null);
    }
  };

  /**
   * 第二步：用户凑齐所有讲义与刷题集后，手动触发一次性合并调用大模型分析
   */
  const handleRunUnifiedAiAnalysis = async () => {
    if (!materials.length) {
      Alert.alert('提示', '请先添加至少 1 份 PDF 讲义或刷题集');
      return;
    }
    try {
      const settings = await loadAISettings();
      if (!settings.visionModel.apiKey.trim() && !settings.reasoningModel.apiKey.trim()) {
        Alert.alert(
          '请先配置 API Key',
          '资料已在本地就绪！请点击右上角「设置」填入 DeepSeek 或 OpenAI API Key 后，再点此按钮统一生成计划。'
        );
        return;
      }

      setBusyStatus(
        `正在一次性统合分析全部 ${materials.length} 份 PDF 资料并生成学习计划...`
      );
      const snapshot = await getAppPracticeSnapshotForPlanner();
      const { updatedMaterials, nextPlan } =
        await analyzeBatchMaterialsAndSynthesizePlan({
          materials,
          practiceSnapshot: snapshot,
          existingPlan: plan,
          settings,
          onProgress: (msg) => setBusyStatus(msg),
        });

      for (const um of updatedMaterials) {
        await upsertCourseMaterial(um);
      }
      await saveStudyPlanState(nextPlan);
      setMaterials(updatedMaterials);
      setPlan(nextPlan);
      onPlanUpdated?.();

      Alert.alert(
        '多份 PDF 统一分析完成 ✨',
        `已一次性综合 ${updatedMaterials.length} 份资料，同步生成了整体学习路线、老师做题流派与每日任务安排！`
      );
    } catch (err: any) {
      Alert.alert('AI 综合分析失败', err?.message || String(err));
    } finally {
      setBusyStatus(null);
    }
  };

  /** 根据最新刷题记录与全部资料重新执行 AI 全盘诊断 */
  const handleRefreshMasterPlan = async () => {
    if (!materials.length) return;
    try {
      const settings = await loadAISettings();
      setBusyStatus('正在结合最新刷题数据重新测算学习进度与每日计划...');
      const snapshot = await getAppPracticeSnapshotForPlanner();
      const { updatedMaterials, nextPlan } =
        await analyzeBatchMaterialsAndSynthesizePlan({
          materials,
          practiceSnapshot: snapshot,
          existingPlan: plan,
          settings,
          onProgress: (msg) => setBusyStatus(msg),
        });
      for (const um of updatedMaterials) {
        await upsertCourseMaterial(um);
      }
      await saveStudyPlanState(nextPlan);
      setMaterials(updatedMaterials);
      setPlan(nextPlan);
      onPlanUpdated?.();
    } catch (err: any) {
      Alert.alert('重新诊断失败', err?.message || String(err));
    } finally {
      setBusyStatus(null);
    }
  };

  /** 点击今日任务打卡 */
  const handleToggleDailyTask = async (task: DailyTaskItem) => {
    if (!plan) return;
    const nextCompleted = !task.completed;
    const nextTasks = plan.dailyTasks.map((t) =>
      t.id === task.id ? { ...t, completed: nextCompleted } : t
    );

    // 若任务关联了具体章节且刚刚完成，适度推进该章节进度
    let nextChapters = plan.chapters;
    if (nextCompleted && task.chapterId) {
      nextChapters = plan.chapters.map((c) =>
        c.id === task.chapterId
          ? { ...c, progressPercent: Math.min(100, c.progressPercent + 20) }
          : c
      );
    }

    const updatedPlan: StudyPlanState = {
      ...plan,
      dailyTasks: nextTasks,
      chapters: nextChapters,
      overallProgressPercent:
        nextChapters !== plan.chapters
          ? computeWeightedProgress(nextChapters)
          : plan.overallProgressPercent,
      updatedAt: Date.now(),
    };
    setPlan(updatedPlan);
    await saveStudyPlanState(updatedPlan);
    onPlanUpdated?.();
  };

  /** 点击章节进度胶囊循环切换 0% -> 50% -> 100% */
  const handleCycleChapterProgress = async (ch: StudyPlanChapter) => {
    if (!plan) return;
    const nextPct = ch.progressPercent < 50 ? 50 : ch.progressPercent < 100 ? 100 : 0;
    const nextChapters = plan.chapters.map((c) =>
      c.id === ch.id ? { ...c, progressPercent: nextPct } : c
    );
    const updatedPlan: StudyPlanState = {
      ...plan,
      chapters: nextChapters,
      overallProgressPercent: computeWeightedProgress(nextChapters),
      updatedAt: Date.now(),
    };
    setPlan(updatedPlan);
    await saveStudyPlanState(updatedPlan);
    onPlanUpdated?.();
  };

  /** 手动保存单本 PDF 的当前页码与刷题数进度 */
  const handleSaveMaterialProgress = async (mat: CourseMaterialDoc) => {
    const nextPage = Math.min(
      mat.totalPages,
      Math.max(0, parseInt(tempPageStr || '0', 10) || 0)
    );
    const nextQ = Math.max(0, parseInt(tempQStr || '0', 10) || 0);
    const updatedMat: CourseMaterialDoc = {
      ...mat,
      currentPage: nextPage,
      completedQuestionsEst: mat.totalQuestionsEst > 0 ? Math.min(mat.totalQuestionsEst, nextQ) : nextQ,
      updatedAt: Date.now(),
    };
    await upsertCourseMaterial(updatedMat);
    const nextMats = materials.map((m) => (m.id === mat.id ? updatedMat : m));
    setMaterials(nextMats);
    setEditingMatId(null);
  };

  /** 与 AI 规划师对话汇报进度或协商每日任务 */
  const handleSendNegotiation = async (presetMsg?: string) => {
    const msg = (presetMsg ?? chatInput).trim();
    if (!msg || !plan || negotiating) return;
    setNegotiating(true);
    try {
      const settings = await loadAISettings();
      const snapshot = await getAppPracticeSnapshotForPlanner();
      const res = await negotiateScheduleWithAi({
        userMessage: msg,
        plan,
        materials,
        practiceSnapshot: snapshot,
        settings,
      });

      // 1. 若 AI 返回了单本讲义/刷题集的页码或题数更新，自动落盘！
      let currentMats = [...materials];
      if (Array.isArray(res.materialUpdates) && res.materialUpdates.length > 0) {
        for (const mu of res.materialUpdates) {
          const idx = currentMats.findIndex((m) => m.id === mu.materialId);
          if (idx !== -1) {
            const old = currentMats[idx];
            const updatedM: CourseMaterialDoc = {
              ...old,
              currentPage:
                typeof mu.currentPage === 'number'
                  ? Math.min(old.totalPages, Math.max(0, mu.currentPage))
                  : old.currentPage,
              completedQuestionsEst:
                typeof mu.completedQuestionsEst === 'number'
                  ? Math.max(0, mu.completedQuestionsEst)
                  : old.completedQuestionsEst,
              updatedAt: Date.now(),
            };
            await upsertCourseMaterial(updatedM);
            currentMats[idx] = updatedM;
          }
        }
        setMaterials(currentMats);
      }

      // 2. 若 AI 返回了章节完成度更新，同步更新章节
      let nextChapters = [...plan.chapters];
      if (Array.isArray(res.chapterUpdates) && res.chapterUpdates.length > 0) {
        const upMap = new Map(
          res.chapterUpdates.map((u) => [u.chapterId, u.progressPercent])
        );
        nextChapters = nextChapters.map((c) =>
          upMap.has(c.id)
            ? {
                ...c,
                progressPercent: Math.min(
                  100,
                  Math.max(0, Math.round(Number(upMap.get(c.id) || 0)))
                ),
              }
            : c
        );
      }

      // 3. 若 AI 重新排定了每日任务清单，替换为最新协商结果
      let nextTasks = plan.dailyTasks;
      if (Array.isArray(res.updatedDailyTasks) && res.updatedDailyTasks.length > 0) {
        nextTasks = res.updatedDailyTasks.map((t, i) => ({
          id: `dt_${Date.now()}_${i}`,
          dayLabel: String(t.dayLabel || '今日任务'),
          title: String(t.title || ''),
          targetMinutes: Math.max(10, Number(t.targetMinutes || 40)),
          chapterId: t.chapterId,
          completed: false,
        }));
      }

      const nextOverallPct =
        typeof res.updatedOverallProgressPercent === 'number'
          ? Math.min(100, Math.max(0, Math.round(res.updatedOverallProgressPercent)))
          : nextChapters !== plan.chapters
          ? computeWeightedProgress(nextChapters)
          : plan.overallProgressPercent;

      const now = Date.now();
      const nextPlan: StudyPlanState = {
        ...plan,
        chapters: nextChapters,
        dailyTasks: nextTasks,
        overallProgressPercent: nextOverallPct,
        currentStageDiagnosis:
          res.updatedStageDiagnosis || plan.currentStageDiagnosis,
        remainingSummary: res.updatedRemainingSummary || plan.remainingSummary,
        dailyMinutesBudget:
          typeof res.updatedDailyMinutesBudget === 'number'
            ? res.updatedDailyMinutesBudget
            : plan.dailyMinutesBudget,
        plannerChatHistory: [
          ...plan.plannerChatHistory,
          { role: 'user', content: msg, timestamp: now },
          { role: 'assistant', content: res.reply, timestamp: now + 1 },
        ],
        updatedAt: now,
      };

      await saveStudyPlanState(nextPlan);
      setPlan(nextPlan);
      if (!presetMsg) setChatInput('');
      onPlanUpdated?.();
    } catch (err: any) {
      Alert.alert('协商请求失败', err?.message || String(err));
    } finally {
      setNegotiating(false);
    }
  };

  const handleRemoveMaterial = (mat: CourseMaterialDoc) => {
    Alert.alert('移除资料', `确定移除《${mat.fileName}》吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '移除',
        style: 'destructive',
        onPress: async () => {
          await deleteCourseMaterial(mat.id);
          const next = materials.filter((m) => m.id !== mat.id);
          setMaterials(next);
        },
      },
    ]);
  };

  const pendingCount = materials.filter(
    (m) => m.analysisStatus === 'pending' || !m.outlineDigest
  ).length;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* 隐藏式端侧 PDF.js 解析引擎 */}
      <PdfExtractorWebView ref={pdfExtractorRef} />

      {busyStatus ? (
        <View style={styles.busyOverlayCard}>
          <ActivityIndicator size="large" color="#4F46E5" />
          <Text style={styles.busyTitle}>{busyStatus}</Text>
          <Text style={styles.busySub}>正在处理讲义与刷题集内容，请勿关闭页面</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scrollBody}>
          {/* 顶部进度总览与批量添加入口卡 */}
          <View style={styles.heroCard}>
            <View style={styles.heroHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.heroTitle}>
                  {plan ? plan.planTitle : 'PDF 讲义与刷题集智能规划'}
                </Text>
                <Text style={styles.heroSub}>
                  {materials.length > 0
                    ? `已载入 ${materials.length} 份 PDF${
                        pendingCount > 0 ? `（含 ${pendingCount} 份待统一分析）` : ''
                      } · 每日预算 ${plan?.dailyMinutesBudget || 120} 分钟`
                    : '支持一次多选或分批添加多份讲义与刷题集 PDF，添齐后一键统一调用 AI 分析'}
                </Text>
              </View>

              <Pressable style={styles.uploadSmallBtn} onPress={handleAddPdfs}>
                <Ionicons name="documents-outline" size={16} color="#4F46E5" />
                <Text style={styles.uploadSmallBtnText}>+ 添PDF(可多选)</Text>
              </Pressable>
            </View>

            {plan ? (
              <View style={styles.progressPanel}>
                <View style={styles.progressTopRow}>
                  <Text style={styles.progressLabel}>当前整体学习进度</Text>
                  <Text style={styles.progressPercentBig}>
                    {plan.overallProgressPercent}%
                  </Text>
                </View>
                <View style={styles.progressBarTrack}>
                  <View
                    style={[
                      styles.progressBarFill,
                      { width: `${plan.overallProgressPercent}%` },
                    ]}
                  />
                </View>

                <View style={styles.diagnosisBox}>
                  <Text style={styles.diagnosisLine}>
                    📍 <Text style={{ fontWeight: '700' }}>当前所处阶段：</Text>
                    {plan.currentStageDiagnosis}
                  </Text>
                  <Text style={styles.diagnosisLine}>
                    ⏳ <Text style={{ fontWeight: '700' }}>剩余学习内容：</Text>
                    {plan.remainingSummary}
                  </Text>
                </View>
              </View>
            ) : materials.length === 0 ? (
              <Pressable style={styles.emptyUploadBanner} onPress={handleAddPdfs}>
                <Ionicons name="cloud-upload" size={32} color="#FFFFFF" />
                <Text style={styles.emptyUploadTitle}>
                  点击批量选择老师讲义 & 刷题集 (.pdf)
                </Text>
                <Text style={styles.emptyUploadDesc}>
                  支持长按一次多选多份 PDF，也可分多次从不同文件夹添加；全部选好后再一键调用大模型综合生成计划！
                </Text>
              </Pressable>
            ) : null}
          </View>

          {/* 待统一分析的 PDF 资料池卡片（添加时不调大模型，凑齐后点一次按钮统一分析！） */}
          {materials.length > 0 && (!plan || pendingCount > 0) ? (
            <View style={styles.stagingCard}>
              <View style={styles.cardHeaderRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>
                    📂 待统一分析资料池（共 {materials.length} 份）
                  </Text>
                  <Text style={styles.cardHint}>
                    添加文件仅在手机本地秒级提取文字，不消耗 Token；全部添齐后点下方按钮一次性综合分析
                  </Text>
                </View>
              </View>

              <View style={{ marginTop: 10, gap: 8 }}>
                {materials.map((m) => {
                  const isPending = m.analysisStatus === 'pending' || !m.outlineDigest;
                  return (
                    <View key={m.id} style={styles.stagingItem}>
                      <Ionicons
                        name={m.docType === 'workbook' ? 'create-outline' : 'book-outline'}
                        size={18}
                        color="#4F46E5"
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.stagingFileName} numberOfLines={1}>
                          {m.fileName}
                        </Text>
                        <Text style={styles.stagingMeta}>
                          共 {m.totalPages} 页 ·{' '}
                          {isPending ? '本地提取完成，待统一分析' : `已分析 (${m.moduleScope})`}
                        </Text>
                      </View>
                      <View
                        style={[
                          styles.stagingBadge,
                          isPending ? styles.stagingBadgePending : styles.stagingBadgeDone,
                        ]}
                      >
                        <Text
                          style={[
                            styles.stagingBadgeText,
                            isPending ? { color: '#B45309' } : { color: '#065F46' },
                          ]}
                        >
                          {isPending ? '待分析' : '已就绪'}
                        </Text>
                      </View>
                      <Pressable
                        style={{ padding: 4 }}
                        onPress={() => handleRemoveMaterial(m)}
                      >
                        <Ionicons name="close-circle-outline" size={19} color="#DC2626" />
                      </Pressable>
                    </View>
                  );
                })}
              </View>

              <View style={styles.stagingActionsRow}>
                <Pressable style={styles.stagingAddMoreBtn} onPress={handleAddPdfs}>
                  <Ionicons name="add-circle-outline" size={16} color="#4F46E5" />
                  <Text style={styles.stagingAddMoreText}>继续添加 PDF</Text>
                </Pressable>

                <Pressable
                  style={styles.stagingAnalyzeBtn}
                  onPress={handleRunUnifiedAiAnalysis}
                >
                  <Ionicons name="sparkles" size={16} color="#FFFFFF" />
                  <Text style={styles.stagingAnalyzeText}>
                    {plan
                      ? `合并统一分析 (${materials.length}份)`
                      : `一键 AI 综合分析 (${materials.length}份)`}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {plan ? (
            <>
              {/* 三大核心维度切换栏 */}
              <View style={styles.segBar}>
                <Pressable
                  style={[styles.segTab, subView === 'schedule' && styles.segTabActive]}
                  onPress={() => setSubView('schedule')}
                >
                  <Text
                    style={[
                      styles.segTabText,
                      subView === 'schedule' && styles.segTabTextActive,
                    ]}
                  >
                    📅 每日进度协商
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.segTab, subView === 'curriculum' && styles.segTabActive]}
                  onPress={() => setSubView('curriculum')}
                >
                  <Text
                    style={[
                      styles.segTabText,
                      subView === 'curriculum' && styles.segTabTextActive,
                    ]}
                  >
                    🗺️ 整体计划蓝图
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.segTab, subView === 'teacher' && styles.segTabActive]}
                  onPress={() => setSubView('teacher')}
                >
                  <Text
                    style={[
                      styles.segTabText,
                      subView === 'teacher' && styles.segTabTextActive,
                    ]}
                  >
                    👨‍🏫 老师讲题风格
                  </Text>
                </Pressable>
              </View>

              {/* 子视图 1：每日任务、PDF刷题进度汇报与 AI 协商 */}
              {subView === 'schedule' && (
                <View style={{ gap: 13 }}>
                  {/* 每日具体任务打卡单 */}
                  <View style={styles.card}>
                    <View style={styles.cardHeaderRow}>
                      <Text style={styles.cardTitle}>✅ 每日学习任务安排</Text>
                      <Pressable onPress={handleRefreshMasterPlan}>
                        <Text style={styles.linkAction}>🔄 重新测算进度</Text>
                      </Pressable>
                    </View>

                    {plan.dailyTasks.length === 0 ? (
                      <Text style={styles.mutedText}>暂无待办任务，可在下方跟 AI 商量排期</Text>
                    ) : (
                      <View style={{ marginTop: 10, gap: 8 }}>
                        {plan.dailyTasks.map((t) => (
                          <Pressable
                            key={t.id}
                            style={[
                              styles.taskItem,
                              t.completed && styles.taskItemDone,
                            ]}
                            onPress={() => handleToggleDailyTask(t)}
                          >
                            <Ionicons
                              name={t.completed ? 'checkbox' : 'square-outline'}
                              size={21}
                              color={t.completed ? '#059669' : '#4F46E5'}
                            />
                            <View style={{ flex: 1 }}>
                              <View style={styles.taskMetaRow}>
                                <Text style={styles.taskDayPill}>{t.dayLabel}</Text>
                                <Text style={styles.taskMinText}>
                                  约 {t.targetMinutes} 分钟
                                </Text>
                              </View>
                              <Text
                                style={[
                                  styles.taskTitle,
                                  t.completed && styles.taskTitleDone,
                                ]}
                              >
                                {t.title}
                              </Text>
                            </View>
                          </Pressable>
                        ))}
                      </View>
                    )}
                  </View>

                  {/* 各本 PDF 阅读/刷题页数进度卡 */}
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>📚 讲义与刷题集当前进度定位</Text>
                    <Text style={styles.cardHint}>
                      可点「更新页码」手动记录，也可直接在下方聊天框口头告诉 AI
                    </Text>

                    <View style={{ marginTop: 10, gap: 10 }}>
                      {materials.map((m) => {
                        const isEditing = editingMatId === m.id;
                        const pct = Math.round(
                          (m.currentPage / Math.max(1, m.totalPages)) * 100
                        );
                        return (
                          <View key={m.id} style={styles.matBox}>
                            <View style={styles.matHeader}>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.matName} numberOfLines={1}>
                                  {m.docType === 'workbook' ? '📝' : '📖'} {m.fileName}
                                </Text>
                                <Text style={styles.matSub}>
                                  {m.moduleScope} · 已看第 {m.currentPage}/{m.totalPages} 页 ({pct}%)
                                  {m.totalQuestionsEst > 0
                                    ? ` · 已刷 ${m.completedQuestionsEst}/${m.totalQuestionsEst} 题`
                                    : ''}
                                </Text>
                              </View>
                              <Pressable
                                style={styles.editMiniBtn}
                                onPress={() => {
                                  if (isEditing) {
                                    setEditingMatId(null);
                                  } else {
                                    setEditingMatId(m.id);
                                    setTempPageStr(String(m.currentPage));
                                    setTempQStr(String(m.completedQuestionsEst));
                                  }
                                }}
                              >
                                <Text style={styles.editMiniBtnText}>
                                  {isEditing ? '收起' : '更新页码'}
                                </Text>
                              </Pressable>
                            </View>

                            {isEditing ? (
                              <View style={styles.matEditRow}>
                                <View style={{ flex: 1 }}>
                                  <Text style={styles.smallLabel}>
                                    当前看到第几页 (共{m.totalPages}页)
                                  </Text>
                                  <TextInput
                                    style={styles.smallInput}
                                    keyboardType="number-pad"
                                    value={tempPageStr}
                                    onChangeText={setTempPageStr}
                                  />
                                </View>
                                {m.totalQuestionsEst > 0 ? (
                                  <View style={{ flex: 1 }}>
                                    <Text style={styles.smallLabel}>
                                      已刷题数 (约{m.totalQuestionsEst}题)
                                    </Text>
                                    <TextInput
                                      style={styles.smallInput}
                                      keyboardType="number-pad"
                                      value={tempQStr}
                                      onChangeText={setTempQStr}
                                    />
                                  </View>
                                ) : null}
                                <Pressable
                                  style={styles.saveMiniBtn}
                                  onPress={() => handleSaveMaterialProgress(m)}
                                >
                                  <Text style={styles.saveMiniBtnText}>保存</Text>
                                </Pressable>
                              </View>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                  </View>

                  {/* 与 AI 学伴商量每天任务和进度安排 */}
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>
                      💬 跟 AI 学伴商量每日任务与进度调整
                    </Text>
                    <Text style={styles.cardHint}>
                      直接汇报你刷到哪一页/哪道题、每天能学多久，AI 会实时刷新进度百分比与每日任务！
                    </Text>

                    {/* 快捷协商指令胶囊 */}
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.quickPromptsRow}
                    >
                      {[
                        '按每天90分钟帮我重新安排任务',
                        '结合我目前的错题薄弱项调整明天计划',
                        '帮我算算按当前速度还要几天学完剩余内容',
                      ].map((qp) => (
                        <Pressable
                          key={qp}
                          style={styles.quickChip}
                          onPress={() => setChatInput(qp)}
                        >
                          <Text style={styles.quickChipText}>{qp}</Text>
                        </Pressable>
                      ))}
                    </ScrollView>

                    {plan.plannerChatHistory.length > 0 ? (
                      <View style={styles.chatHistoryBox}>
                        {plan.plannerChatHistory.slice(-10).map((turn, idx) => (
                          <View
                            key={idx}
                            style={[
                              styles.chatBubble,
                              turn.role === 'user'
                                ? styles.chatBubbleUser
                                : styles.chatBubbleAi,
                            ]}
                          >
                            <Text
                              style={[
                                styles.chatBubbleText,
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
                        multiline
                        placeholder="例：我今天讲义看到第42页了，这周每天只能学1小时，怎么安排？"
                        value={chatInput}
                        onChangeText={setChatInput}
                      />
                      <Pressable
                        style={[styles.sendBtn, negotiating && { opacity: 0.6 }]}
                        onPress={() => handleSendNegotiation()}
                        disabled={negotiating}
                      >
                        {negotiating ? (
                          <ActivityIndicator size="small" color="#FFFFFF" />
                        ) : (
                          <Ionicons name="send" size={17} color="#FFFFFF" />
                        )}
                      </Pressable>
                    </View>
                  </View>
                </View>
              )}

              {/* 子视图 2：整体学习内容计划蓝图 */}
              {subView === 'curriculum' && (
                <View style={{ gap: 13 }}>
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>🧭 整体学习内容计划总览</Text>
                    <Text style={styles.bodyParagraph}>{plan.overallAnalysis}</Text>
                  </View>

                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>
                      🗂️ 分阶段章节路线图（点击百分比可快捷打卡）
                    </Text>
                    <View style={{ marginTop: 10, gap: 10 }}>
                      {plan.chapters.map((ch) => (
                        <View key={ch.id} style={styles.chapterCard}>
                          <View style={styles.chapterTopRow}>
                            <ModuleBadge module={ch.moduleL1} />
                            <Text style={styles.stageLabel}>{ch.stageName}</Text>
                            <Pressable
                              style={[
                                styles.pctBadge,
                                ch.progressPercent === 100
                                  ? styles.pctDone
                                  : ch.progressPercent > 0
                                  ? styles.pctHalf
                                  : styles.pctZero,
                              ]}
                              onPress={() => handleCycleChapterProgress(ch)}
                            >
                              <Text
                                style={[
                                  styles.pctBadgeText,
                                  ch.progressPercent === 100
                                    ? { color: '#065F46' }
                                    : ch.progressPercent > 0
                                    ? { color: '#3730A3' }
                                    : { color: '#4B5563' },
                                ]}
                              >
                                {ch.progressPercent}% ✓
                              </Text>
                            </Pressable>
                          </View>

                          <Text style={styles.chapterTitle}>
                            {ch.orderIndex}. {ch.title}
                          </Text>
                          <Text style={styles.chapterRef}>
                            📖 对应范围：{ch.sourceRef || '见讲义对应章节'} · 预估 {ch.estimatedHours}h
                          </Text>
                          {ch.keyTakeaways ? (
                            <Text style={styles.chapterTakeaway}>
                              💡 核心要领：{ch.keyTakeaways}
                            </Text>
                          ) : null}
                          <View style={styles.chapterBottomBar}>
                            <View style={styles.chapterMotherWrap}>
                              {ch.relatedMotherTypes.slice(0, 2).map((mt, idx) => (
                                <Text key={idx} style={styles.chapterMotherChip} numberOfLines={1}>
                                  #{mt}
                                </Text>
                              ))}
                            </View>
                            {onPracticeChapter ? (
                              <Pressable
                                style={styles.practiceChapterBtn}
                                onPress={() =>
                                  onPracticeChapter(ch.moduleL1, ch.relatedMotherTypes[0])
                                }
                              >
                                <Ionicons name="flash" size={12} color="#4F46E5" />
                                <Text style={styles.practiceChapterBtnText}>刷本章真题</Text>
                              </Pressable>
                            ) : null}
                          </View>
                        </View>
                      ))}
                    </View>
                  </View>
                </View>
              )}

              {/* 子视图 3：文件中老师的讲题和做题思路与风格 */}
              {subView === 'teacher' && (
                <View style={{ gap: 13 }}>
                  <View style={styles.card}>
                    <View style={styles.switchRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.cardTitle}>
                          ⚡ 将该老师的做题风格注入「拍错题」解析
                        </Text>
                        <Text style={styles.cardHint}>
                          开启后，日常拍照录入任何新错题时，AI 都会沿用这位老师的术语、口诀和解题步骤为你讲题！
                        </Text>
                      </View>
                      <Switch
                        value={plan.teacherPersona.enableInMistakeSolver}
                        onValueChange={async (val) => {
                          const next: StudyPlanState = {
                            ...plan,
                            teacherPersona: {
                              ...plan.teacherPersona,
                              enableInMistakeSolver: val,
                            },
                            updatedAt: Date.now(),
                          };
                          setPlan(next);
                          await saveStudyPlanState(next);
                        }}
                      />
                    </View>
                  </View>

                  <View style={styles.card}>
                    <View style={styles.personaHeader}>
                      <Ionicons name="school" size={22} color="#4F46E5" />
                      <Text style={styles.personaName}>
                        {plan.teacherPersona.teacherNameOrTag}
                      </Text>
                    </View>

                    <Text style={styles.subHeading}>🎯 核心讲题与做题心法</Text>
                    <Text style={styles.bodyParagraph}>
                      {plan.teacherPersona.corePhilosophy}
                    </Text>

                    {plan.teacherPersona.signatureTechniques.length > 0 ? (
                      <>
                        <Text style={styles.subHeading}>🔥 标志性秒杀技巧与口诀</Text>
                        <View style={styles.techWrap}>
                          {plan.teacherPersona.signatureTechniques.map((tech, i) => (
                            <View key={i} style={styles.techChip}>
                              <Text style={styles.techChipText}>{tech}</Text>
                            </View>
                          ))}
                        </View>
                      </>
                    ) : null}

                    <Text style={styles.subHeading}>📐 考场标准做题步骤流</Text>
                    <Text style={styles.bodyParagraph}>
                      {plan.teacherPersona.solvingStepsTemplate}
                    </Text>

                    {plan.teacherPersona.pitfallHabits ? (
                      <>
                        <Text style={styles.subHeading}>🛡️ 审题排坑习惯</Text>
                        <Text style={styles.bodyParagraph}>
                          {plan.teacherPersona.pitfallHabits}
                        </Text>
                      </>
                    ) : null}
                  </View>

                  {/* 已上传各单份 PDF 的原始解析档案 */}
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>📂 已上传的讲义与刷题集档案</Text>
                    <View style={{ marginTop: 10, gap: 10 }}>
                      {materials.map((m) => (
                        <View key={m.id} style={styles.rawMatCard}>
                          <View style={styles.cardHeaderRow}>
                            <Text style={styles.matName} numberOfLines={1}>
                              {m.fileName}（{m.totalPages}页）
                            </Text>
                            <Pressable onPress={() => handleRemoveMaterial(m)}>
                              <Ionicons name="trash-outline" size={17} color="#DC2626" />
                            </Pressable>
                          </View>
                          <Text style={styles.rawMatDigest}>{m.teacherStyleNotes}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                </View>
              )}
            </>
          ) : null}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  scrollBody: {
    padding: 14,
    paddingBottom: 34,
    gap: 13,
  },
  busyOverlayCard: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 12,
  },
  busyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1F2937',
    textAlign: 'center',
  },
  busySub: {
    fontSize: 12.5,
    color: '#6B7280',
    textAlign: 'center',
  },
  heroCard: {
    backgroundColor: '#1E1B4B',
    borderRadius: 16,
    padding: 15,
    gap: 12,
  },
  heroHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  heroTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  heroSub: {
    fontSize: 11.8,
    color: '#C7D2FE',
    marginTop: 3,
  },
  uploadSmallBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 10,
  },
  uploadSmallBtnText: {
    fontSize: 12.5,
    fontWeight: '800',
    color: '#4F46E5',
  },
  progressPanel: {
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  progressTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  progressLabel: {
    fontSize: 12.5,
    color: '#E0E7FF',
    fontWeight: '600',
  },
  progressPercentBig: {
    fontSize: 22,
    fontWeight: '900',
    color: '#34D399',
  },
  progressBarTrack: {
    height: 9,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#10B981',
    borderRadius: 5,
  },
  diagnosisBox: {
    marginTop: 4,
    gap: 5,
  },
  diagnosisLine: {
    fontSize: 12.5,
    lineHeight: 18.5,
    color: '#F1F5F9',
  },
  emptyUploadBanner: {
    backgroundColor: '#4F46E5',
    borderRadius: 13,
    padding: 18,
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  emptyUploadTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  emptyUploadDesc: {
    fontSize: 12,
    lineHeight: 18,
    color: '#E0E7FF',
    textAlign: 'center',
  },
  stagingCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderColor: '#818CF8',
  },
  stagingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  stagingFileName: {
    fontSize: 13.2,
    fontWeight: '700',
    color: '#1E293B',
  },
  stagingMeta: {
    fontSize: 11.2,
    color: '#64748B',
    marginTop: 1,
  },
  stagingBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  stagingBadgePending: {
    backgroundColor: '#FEF3C7',
  },
  stagingBadgeDone: {
    backgroundColor: '#D1FAE5',
  },
  stagingBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  stagingActionsRow: {
    flexDirection: 'row',
    gap: 9,
    marginTop: 12,
  },
  stagingAddMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#C7D2FE',
    backgroundColor: '#EEF2FF',
  },
  stagingAddMoreText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#4F46E5',
  },
  stagingAnalyzeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#4F46E5',
  },
  stagingAnalyzeText: {
    fontSize: 13.2,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  segBar: {
    flexDirection: 'row',
    backgroundColor: '#E5E7EB',
    borderRadius: 11,
    padding: 3,
  },
  segTab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: 'center',
  },
  segTabActive: {
    backgroundColor: '#FFFFFF',
  },
  segTabText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: '#4B5563',
  },
  segTabTextActive: {
    color: '#4F46E5',
    fontWeight: '800',
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
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#111827',
  },
  cardHint: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 3,
    lineHeight: 17.5,
  },
  linkAction: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#4F46E5',
  },
  mutedText: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 10,
  },
  taskItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 11,
    borderRadius: 10,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  taskItemDone: {
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
  },
  taskMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 3,
  },
  taskDayPill: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4338CA',
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 4,
  },
  taskMinText: {
    fontSize: 11.5,
    color: '#6B7280',
    fontWeight: '600',
  },
  taskTitle: {
    fontSize: 13.8,
    lineHeight: 20,
    color: '#1F2937',
    fontWeight: '500',
  },
  taskTitleDone: {
    textDecorationLine: 'line-through',
    color: '#6B7280',
  },
  matBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    padding: 11,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 8,
  },
  matHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  matName: {
    fontSize: 13.5,
    fontWeight: '700',
    color: '#1E293B',
    flex: 1,
  },
  matSub: {
    fontSize: 11.8,
    color: '#64748B',
    marginTop: 2,
  },
  editMiniBtn: {
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 7,
  },
  editMiniBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4F46E5',
  },
  matEditRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
  },
  smallLabel: {
    fontSize: 11,
    color: '#475569',
    marginBottom: 3,
  },
  smallInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 7,
    paddingHorizontal: 9,
    paddingVertical: 6,
    fontSize: 13,
    color: '#0F172A',
  },
  saveMiniBtn: {
    backgroundColor: '#059669',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 7,
  },
  saveMiniBtnText: {
    color: '#FFFFFF',
    fontSize: 12.5,
    fontWeight: '700',
  },
  quickPromptsRow: {
    gap: 7,
    paddingVertical: 10,
  },
  quickChip: {
    backgroundColor: '#F5F3FF',
    borderWidth: 1,
    borderColor: '#DDD6FE',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
  },
  quickChipText: {
    fontSize: 11.8,
    color: '#6D28D9',
    fontWeight: '600',
  },
  chatHistoryBox: {
    gap: 8,
    marginBottom: 10,
  },
  chatBubble: {
    padding: 10,
    borderRadius: 11,
    maxWidth: '92%',
  },
  chatBubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: '#4F46E5',
  },
  chatBubbleAi: {
    alignSelf: 'flex-start',
    backgroundColor: '#F3F4F6',
  },
  chatBubbleText: {
    fontSize: 13.5,
    lineHeight: 20,
    color: '#1F2937',
  },
  chatInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  chatInput: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
    minHeight: 42,
    maxHeight: 96,
    fontSize: 13.5,
    color: '#111827',
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: '#4F46E5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bodyParagraph: {
    fontSize: 13.8,
    lineHeight: 21.5,
    color: '#1F2937',
    marginTop: 8,
  },
  chapterCard: {
    backgroundColor: '#F9FAFB',
    borderRadius: 11,
    padding: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 5,
  },
  chapterTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  stageLabel: {
    flex: 1,
    fontSize: 11.5,
    fontWeight: '700',
    color: '#6B7280',
  },
  pctBadge: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 8,
  },
  pctZero: {
    backgroundColor: '#E5E7EB',
  },
  pctHalf: {
    backgroundColor: '#E0E7FF',
  },
  pctDone: {
    backgroundColor: '#D1FAE5',
  },
  pctBadgeText: {
    fontSize: 11.5,
    fontWeight: '800',
  },
  chapterTitle: {
    fontSize: 14.5,
    fontWeight: '700',
    color: '#111827',
    marginTop: 2,
  },
  chapterRef: {
    fontSize: 12,
    color: '#0F766E',
    fontWeight: '600',
  },
  chapterTakeaway: {
    fontSize: 12.5,
    color: '#4B5563',
    lineHeight: 18.5,
  },
  chapterBottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 4,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  chapterMotherWrap: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chapterMotherChip: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '600',
  },
  practiceChapterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  practiceChapterBtnText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#4F46E5',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  personaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  personaName: {
    fontSize: 16,
    fontWeight: '800',
    color: '#312E81',
  },
  subHeading: {
    fontSize: 13.5,
    fontWeight: '800',
    color: '#0F766E',
    marginTop: 12,
  },
  techWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 6,
  },
  techChip: {
    backgroundColor: '#EEF2FF',
    borderWidth: 1,
    borderColor: '#C7D2FE',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  techChipText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#3730A3',
  },
  rawMatCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    padding: 11,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 6,
  },
  rawMatDigest: {
    fontSize: 12.5,
    lineHeight: 19,
    color: '#475569',
  },
});
