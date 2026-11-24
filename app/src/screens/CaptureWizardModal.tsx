import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
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
import {
  extractQuestionFromImages,
  generateFastSolution,
  ImageInputPayload,
} from '../ai/aiClient';
import { ImageConfirmCropModal } from '../components/ImageConfirmCropModal';
import { loadAISettings, upsertMistake } from '../db/database';
import { matchOriginalRealQuestion } from '../engine/recommender';
import {
  CapturedImageAsset,
  pickRawImage,
  RawPickedImage,
} from '../services/captureService';
import {
  ERROR_REASONS,
  KAOGONG_TAXONOMY,
  MODULES_L1,
} from '../taxonomy/kaogongTaxonomy';
import { ErrorReason, MistakeRecord, ModuleL1, QuestionOption } from '../types/models';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSaved: (savedMistake: MistakeRecord) => void;
}

const ANSWER_KEYS = ['A', 'B', 'C', 'D'];

export function CaptureWizardModal({ visible, onClose, onSaved }: Props) {
  const [step, setStep] = useState<'capture' | 'confirm'>('capture');
  const [loadingText, setLoadingText] = useState<string | null>(null);

  // 采集图片状态
  const [stemAsset, setStemAsset] = useState<CapturedImageAsset | null>(null);
  const [materialAsset, setMaterialAsset] = useState<CapturedImageAsset | null>(null);
  const [answerAsset, setAnswerAsset] = useState<CapturedImageAsset | null>(null);
  const [pendingPreview, setPendingPreview] = useState<{
    slot: 'stem' | 'material' | 'answer';
    raw: RawPickedImage;
  } | null>(null);
  const [showManualInput, setShowManualInput] = useState(false);

  // 结构化编辑确认状态
  const [matchedQid, setMatchedQid] = useState<string | null>(null);
  const [matchedSourceExam, setMatchedSourceExam] = useState<string | null>(null);
  const [matchSimilarity, setMatchSimilarity] = useState<number>(0);

  const [moduleL1, setModuleL1] = useState<ModuleL1>('资料分析');
  const [categoryL2, setCategoryL2] = useState<string>('比重问题');
  const [motherTypeL3, setMotherTypeL3] = useState<string>('两期比重差');
  const [materialText, setMaterialText] = useState<string>('');
  const [stemText, setStemText] = useState<string>('');
  const [options, setOptions] = useState<QuestionOption[]>([
    { key: 'A', text: '' },
    { key: 'B', text: '' },
    { key: 'C', text: '' },
    { key: 'D', text: '' },
  ]);
  const [correctAnswer, setCorrectAnswer] = useState<string>('A');
  const [myWrongAnswer, setMyWrongAnswer] = useState<string>('B');
  const [errorReason, setErrorReason] = useState<ErrorReason>('公式方法不熟');
  const [anchorKeywordsText, setAnchorKeywordsText] = useState<string>('');
  const [pitfallWarning, setPitfallWarning] = useState<string>('');
  const [aiFastSolution, setAiFastSolution] = useState<string>('');
  const [userNote, setUserNote] = useState<string>('');

  const resetAll = () => {
    setStep('capture');
    setLoadingText(null);
    setStemAsset(null);
    setMaterialAsset(null);
    setAnswerAsset(null);
    setPendingPreview(null);
    setShowManualInput(false);
    setMatchedQid(null);
    setMatchedSourceExam(null);
    setMatchSimilarity(0);
    setMaterialText('');
    setStemText('');
    setOptions([
      { key: 'A', text: '' },
      { key: 'B', text: '' },
      { key: 'C', text: '' },
      { key: 'D', text: '' },
    ]);
    setCorrectAnswer('A');
    setMyWrongAnswer('B');
    setErrorReason('公式方法不熟');
    setAnchorKeywordsText('');
    setPitfallWarning('');
    setAiFastSolution('');
    setUserNote('');
  };

  const handleClose = () => {
    resetAll();
    onClose();
  };

  const handlePickImage = async (
    slot: 'stem' | 'material' | 'answer',
    source: 'camera' | 'library'
  ) => {
    try {
      const raw = await pickRawImage(source);
      if (!raw) return;
      setPendingPreview({ slot, raw });
    } catch (err: any) {
      Alert.alert('图片获取失败', err?.message || String(err));
    }
  };

  /** 一键载入演示错题（即使暂未配置 API Key 也能立刻体验原题双轨碰撞与同类真题推荐） */
  const handleLoadSampleDemo = (type: 'ziliao' | 'yanyu') => {
    if (type === 'ziliao') {
      setModuleL1('资料分析');
      setCategoryL2('比重问题');
      setMotherTypeL3('两期比重差');
      setMaterialText(
        '2025年，全国社会消费品零售总额48.8万亿元，比上年增长3.5%。全年全国网上零售额15.6万亿元，比上年增长7.2%。'
      );
      setStemText('2025年，全国网上零售额占社会消费品零售总额的比重比上年同期约：');
      setOptions([
        { key: 'A', text: '上升1.1个百分点' },
        { key: 'B', text: '上升3.7个百分点' },
        { key: 'C', text: '下降1.1个百分点' },
        { key: 'D', text: '下降3.7个百分点' },
      ]);
      setCorrectAnswer('A');
      setMyWrongAnswer('B');
    } else {
      setModuleL1('言语理解');
      setCategoryL2('逻辑填空');
      setMotherTypeL3('实词与高频成语语境辨析');
      setMaterialText('');
      setStemText(
        '科技创新与产业升级相辅相成，唯有双向发力才能让二者________，切不可脱离地方产业实际盲目跟风，否则无异于________。'
      );
      setOptions([
        { key: 'A', text: '并行不悖  刻舟求剑' },
        { key: 'B', text: '相得益彰  缘木求鱼' },
        { key: 'C', text: '殊途同归  南辕北辙' },
        { key: 'D', text: '一脉相承  饮鸩止渴' },
      ]);
      setCorrectAnswer('B');
      setMyWrongAnswer('A');
    }
    setShowManualInput(true);
  };

  const handleAnalyzeAndProceed = async () => {
    try {
      const aiSettings = await loadAISettings();
      const hasApiKey = Boolean(aiSettings.visionModel.apiKey.trim());

      let curMod = moduleL1;
      let curL2 = categoryL2;
      let curL3 = motherTypeL3;
      let curMat = materialText;
      let curStem = stemText;
      let curOpts = options;
      let curWrong = myWrongAnswer;
      let curCorrect = '';
      let curAnchors: string[] = [];

      const imagePayloads: ImageInputPayload[] = [];
      if (stemAsset) {
        imagePayloads.push({
          label: '题干图',
          base64: stemAsset.base64,
          mimeType: stemAsset.mimeType,
        });
      }
      if (materialAsset) {
        imagePayloads.push({
          label: '资料材料图',
          base64: materialAsset.base64,
          mimeType: materialAsset.mimeType,
        });
      }
      if (answerAsset) {
        imagePayloads.push({
          label: '参考答案/解析图',
          base64: answerAsset.base64,
          mimeType: answerAsset.mimeType,
        });
      }

      if (imagePayloads.length === 0 && !curStem.trim()) {
        Alert.alert('提示', '请先拍摄/选择错题图片，或展开手动文本输入题干。');
        return;
      }

      // 阶段 1：若有图片且已配置 API Key，执行多模态识图提取
      if (imagePayloads.length > 0) {
        if (!hasApiKey) {
          Alert.alert(
            '未配置 AI 模型 API Key',
            '你尚未在「设置」页填写识图模型 API Key。你可以先补充题干文字走本地真题碰撞模式，或前往设置填写 API Key。'
          );
          setStep('confirm');
          return;
        }
        setLoadingText('正在识别题干、选项与母题特征...');
        const extracted = await extractQuestionFromImages(
          imagePayloads,
          aiSettings,
          (hint) => setLoadingText(hint)
        );
        curMod = extracted.moduleL1;
        curL2 = extracted.categoryL2;
        curL3 = extracted.motherTypeL3;
        curMat = extracted.materialText || curMat;
        curStem = extracted.stemText;
        curOpts = extracted.options;
        if (extracted.detectedMyWrongAnswer) curWrong = extracted.detectedMyWrongAnswer;
        if (extracted.detectedCorrectAnswer) curCorrect = extracted.detectedCorrectAnswer;
        curAnchors = extracted.anchorKeywords;
      }

      // 阶段 2：本地 SQLite FTS5 原题碰撞（智能双轨还原）
      setLoadingText('正在本地真题库中进行毫秒级原题碰撞匹配...');
      const localHit = await matchOriginalRealQuestion(curStem, curMod);
      let officialHint = '';

      if (localHit) {
        const mq = localHit.matched;
        setMatchedQid(mq.qid);
        setMatchedSourceExam(mq.sourceExam);
        setMatchSimilarity(Math.round(localHit.similarity * 100));
        // 轨道 1：自动采用本地库无手写笔迹干净原题与标准答案！
        curMod = mq.moduleL1;
        curL2 = mq.categoryL2;
        curL3 = mq.motherTypeL3;
        curMat = mq.materialText || curMat;
        curStem = mq.stem;
        curOpts = mq.options;
        curCorrect = mq.answer;
        officialHint = `${mq.fastTips}\n${mq.officialAnalysis}`;
        curAnchors = Array.from(
          new Set([...curAnchors, ...mq.anchorKeywords.split(/\s+/).filter(Boolean)])
        );
      } else {
        setMatchedQid(null);
        setMatchedSourceExam(null);
        setMatchSimilarity(0);
      }

      // 阶段 3：生成实战秒杀解析（若已配 API Key 调推理模型，否则使用本地库方法口诀优雅兜底）
      const reasoningEndpoint = aiSettings.splitVisionAndReasoning
        ? aiSettings.reasoningModel
        : aiSettings.visionModel;

      if (reasoningEndpoint.apiKey.trim()) {
        setLoadingText(`正在注入「${curMod}」实战秒杀方法卡拆解错因...`);
        const fastRes = await generateFastSolution(
          {
            moduleL1: curMod,
            categoryL2: curL2,
            motherTypeL3: curL3,
            materialText: curMat,
            stemText: curStem,
            options: curOpts,
            knownCorrectAnswer: curCorrect || undefined,
            myWrongAnswer: curWrong || undefined,
            officialAnalysisHint: officialHint || undefined,
            imagesForContext: imagePayloads,
          },
          aiSettings
        );
        curMod = fastRes.moduleL1;
        curL2 = fastRes.categoryL2;
        curL3 = fastRes.motherTypeL3;
        curCorrect = fastRes.correctAnswer;
        setErrorReason(fastRes.suggestedErrorReason);
        curAnchors = Array.from(new Set([...curAnchors, ...fastRes.anchorKeywords]));
        setPitfallWarning(fastRes.pitfallWarning);
        setAiFastSolution(fastRes.aiFastSolution);
      } else if (localHit) {
        setPitfallWarning(localHit.matched.fastTips);
        setAiFastSolution(localHit.matched.officialAnalysis);
      } else {
        curCorrect = curCorrect || correctAnswer || 'A';
        // 从言语选项自动提取四字成语作为检索锚点
        const optionWords = curOpts
          .map((o) => o.text)
          .join(' ')
          .match(/[\u4e00-\u9fa5]{4}/g);
        if (optionWords) {
          curAnchors = Array.from(new Set([...curAnchors, ...optionWords.slice(0, 6)]));
        }
        setPitfallWarning(`归属母题：${curL3}（配置 AI Key 后可自动生成专属秒杀推演）`);
        setAiFastSolution('当前处于离线免 Key 录题模式，保存后将立即为你本地匹配同类历年真题！');
      }

      setModuleL1(curMod);
      setCategoryL2(curL2);
      setMotherTypeL3(curL3);
      setMaterialText(curMat);
      setStemText(curStem);
      setOptions(curOpts);
      setCorrectAnswer(curCorrect || 'A');
      setMyWrongAnswer(curWrong);
      setAnchorKeywordsText(curAnchors.slice(0, 8).join(' '));
      setLoadingText(null);
      setStep('confirm');
    } catch (err: any) {
      setLoadingText(null);
      Alert.alert('智能解析提示', err?.message || String(err));
    }
  };

  const handleModuleChange = (newMod: ModuleL1) => {
    setModuleL1(newMod);
    const l2Map = KAOGONG_TAXONOMY[newMod];
    const firstL2 = Object.keys(l2Map)[0];
    setCategoryL2(firstL2);
    setMotherTypeL3(l2Map[firstL2][0]);
  };

  const handleSaveMistake = async () => {
    if (!stemText.trim() && !stemAsset) {
      Alert.alert('提示', '题干内容不能为空');
      return;
    }
    const now = Date.now();
    const record: MistakeRecord = {
      id: `mst_${now}_${Math.random().toString(36).slice(2, 7)}`,
      matchedQid,
      matchedSourceExam,
      captureImages: {
        stemImageUri: stemAsset?.localUri || null,
        materialImageUri: materialAsset?.localUri || null,
        answerImageUri: answerAsset?.localUri || null,
      },
      moduleL1,
      categoryL2,
      motherTypeL3,
      anchorKeywords: anchorKeywordsText
        .split(/[\s,，、/]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      materialText: materialText.trim() || null,
      materialImages: [],
      stemText: stemText.trim() || '（图片错题）',
      stemImages: [],
      options,
      correctAnswer: correctAnswer.trim().toUpperCase() || 'A',
      myWrongAnswer: myWrongAnswer.trim().toUpperCase(),
      errorReason,
      aiFastSolution,
      pitfallWarning,
      chatHistory: [],
      userNote: userNote.trim(),
      repetitions: 0,
      easinessFactor: 2.5,
      intervalDays: 1,
      nextReviewAt: now + 24 * 60 * 60 * 1000,
      lastTimeSpentSec: 0,
      masteryStatus: 'learning',
      createdAt: now,
      updatedAt: now,
    };

    await upsertMistake(record);
    resetAll();
    onSaved(record);
  };

  const allMotherTypesForModule = Object.entries(KAOGONG_TAXONOMY[moduleL1]).flatMap(
    ([l2, l3s]) => l3s.map((l3) => ({ l2, l3 }))
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          {pendingPreview ? (
            <ImageConfirmCropModal
              visible={true}
              rawImage={pendingPreview.raw}
              onCancel={() => setPendingPreview(null)}
              onConfirm={(finalAsset) => {
                if (pendingPreview.slot === 'stem') setStemAsset(finalAsset);
                else if (pendingPreview.slot === 'material') setMaterialAsset(finalAsset);
                else if (pendingPreview.slot === 'answer') setAnswerAsset(finalAsset);
                setPendingPreview(null);
              }}
            />
          ) : (
            <>
          {/* 顶部导航栏 */}
          <View style={styles.header}>
            <Pressable
              onPress={() => (step === 'confirm' ? setStep('capture') : handleClose())}
              style={styles.iconBtn}
            >
              <Ionicons
                name={step === 'confirm' ? 'arrow-back' : 'close'}
                size={22}
                color="#1F2937"
              />
            </Pressable>
            <Text style={styles.headerTitle}>
              {step === 'capture' ? '拍照 / 截图导入错题' : '核对还原结果与错因'}
            </Text>
            <View style={{ width: 34 }} />
          </View>

          {loadingText ? (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color="#4F46E5" />
              <Text style={styles.loadingTitle}>{loadingText}</Text>
              <Text style={styles.loadingSub}>本地双轨碰撞 + 考场秒杀方法卡推演中</Text>
            </View>
          ) : step === 'capture' ? (
            <ScrollView contentContainerStyle={styles.scrollBody}>
              {/* 主槽位：题干图 */}
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>1. 拍摄纸质题或导入粉笔等 App 截图</Text>
                <Text style={styles.sectionHint}>
                  拍摄后可自由框选裁剪单道错题；若截图已含标准答案也会自动识别
                </Text>

                {stemAsset ? (
                  <View style={styles.previewBox}>
                    <Image
                      source={{ uri: stemAsset.localUri }}
                      style={styles.previewImg}
                      resizeMode="contain"
                    />
                    <Pressable
                      style={styles.removeImgBtn}
                      onPress={() => setStemAsset(null)}
                    >
                      <Ionicons name="trash-outline" size={16} color="#DC2626" />
                      <Text style={styles.removeImgText}>移除重选</Text>
                    </Pressable>
                  </View>
                ) : (
                  <View style={styles.dualActionRow}>
                    <Pressable
                      style={[styles.bigCaptureBtn, { backgroundColor: '#4F46E5' }]}
                      onPress={() => handlePickImage('stem', 'camera')}
                    >
                      <Ionicons name="camera" size={26} color="#FFFFFF" />
                      <Text style={styles.bigCaptureBtnTitle}>实拍纸质错题</Text>
                      <Text style={styles.bigCaptureBtnSub}>支持框选裁剪</Text>
                    </Pressable>

                    <Pressable
                      style={[styles.bigCaptureBtn, { backgroundColor: '#0F766E' }]}
                      onPress={() => handlePickImage('stem', 'library')}
                    >
                      <Ionicons name="images" size={26} color="#FFFFFF" />
                      <Text style={styles.bigCaptureBtnTitle}>相册导截图</Text>
                      <Text style={styles.bigCaptureBtnSub}>粉笔/PDF截屏</Text>
                    </Pressable>
                  </View>
                )}
              </View>

              {/* 增强槽位：答案解析图 & 资料分析材料图 */}
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>2. 可选增强附图（防图推翻车 / 连体材料）</Text>

                <View style={styles.extraSlotRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.extraSlotTitle}>🎯 附带答案/解析图（推荐图推题使用）</Text>
                    <Text style={styles.extraSlotDesc}>
                      传入标准答案让 AI 专注反向提炼秒杀特征，100%避免算错答案
                    </Text>
                  </View>
                  {answerAsset ? (
                    <Pressable
                      style={styles.slotDoneChip}
                      onPress={() => setAnswerAsset(null)}
                    >
                      <Text style={styles.slotDoneText}>已附答案图 ×</Text>
                    </Pressable>
                  ) : (
                    <View style={styles.miniBtnGroup}>
                      <Pressable
                        style={styles.miniBtn}
                        onPress={() => handlePickImage('answer', 'camera')}
                      >
                        <Ionicons name="camera-outline" size={16} color="#4F46E5" />
                      </Pressable>
                      <Pressable
                        style={styles.miniBtn}
                        onPress={() => handlePickImage('answer', 'library')}
                      >
                        <Ionicons name="image-outline" size={16} color="#4F46E5" />
                      </Pressable>
                    </View>
                  )}
                </View>

                <View style={[styles.extraSlotRow, { borderTopWidth: 1, borderTopColor: '#F3F4F6', paddingTop: 12, marginTop: 12 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.extraSlotTitle}>📊 附带资料分析统计表/材料图</Text>
                    <Text style={styles.extraSlotDesc}>
                      当材料图表与小题不在同一页时，可单独补拍共享材料
                    </Text>
                  </View>
                  {materialAsset ? (
                    <Pressable
                      style={styles.slotDoneChip}
                      onPress={() => setMaterialAsset(null)}
                    >
                      <Text style={styles.slotDoneText}>已附材料图 ×</Text>
                    </Pressable>
                  ) : (
                    <View style={styles.miniBtnGroup}>
                      <Pressable
                        style={styles.miniBtn}
                        onPress={() => handlePickImage('material', 'camera')}
                      >
                        <Ionicons name="camera-outline" size={16} color="#0E7490" />
                      </Pressable>
                      <Pressable
                        style={styles.miniBtn}
                        onPress={() => handlePickImage('material', 'library')}
                      >
                        <Ionicons name="image-outline" size={16} color="#0E7490" />
                      </Pressable>
                    </View>
                  )}
                </View>
              </View>

              {/* 手动粘贴文本 / 免Key一键演示体验 */}
              <View style={styles.card}>
                <Pressable
                  style={styles.manualHeader}
                  onPress={() => setShowManualInput((v) => !v)}
                >
                  <Text style={styles.sectionTitle}>
                    📝 粘贴题目文本 或 一键载入演示错题
                  </Text>
                  <Ionicons
                    name={showManualInput ? 'chevron-up' : 'chevron-down'}
                    size={18}
                    color="#6B7280"
                  />
                </Pressable>

                <View style={styles.demoRow}>
                  <Pressable
                    style={styles.demoChip}
                    onPress={() => handleLoadSampleDemo('ziliao')}
                  >
                    <Text style={styles.demoChipText}>⚡ 体验：资料两期比重错题</Text>
                  </Pressable>
                  <Pressable
                    style={styles.demoChip}
                    onPress={() => handleLoadSampleDemo('yanyu')}
                  >
                    <Text style={styles.demoChipText}>⚡ 体验：言语易混成语错题</Text>
                  </Pressable>
                </View>

                {showManualInput && (
                  <View style={{ marginTop: 10, gap: 8 }}>
                    <TextInput
                      style={[styles.input, { minHeight: 74 }]}
                      multiline
                      placeholder="粘贴或输入错题题干..."
                      value={stemText}
                      onChangeText={setStemText}
                    />
                    {options.map((opt, i) => (
                      <View key={opt.key} style={styles.optInputRow}>
                        <Text style={styles.optInputLabel}>{opt.key}.</Text>
                        <TextInput
                          style={[styles.input, { flex: 1 }]}
                          placeholder={`选项 ${opt.key}`}
                          value={opt.text}
                          onChangeText={(txt) => {
                            const next = [...options];
                            next[i] = { ...next[i], text: txt };
                            setOptions(next);
                          }}
                        />
                      </View>
                    ))}
                  </View>
                )}
              </View>

              <Pressable style={styles.primaryBtn} onPress={handleAnalyzeAndProceed}>
                <Ionicons name="sparkles" size={18} color="#FFFFFF" />
                <Text style={styles.primaryBtnText}>
                  智能识图还原 · 生成秒杀解析并匹配真题
                </Text>
              </Pressable>
            </ScrollView>
          ) : (
            /* Step 2: 核对双轨还原结果与错因 */
            <ScrollView contentContainerStyle={styles.scrollBody}>
              {matchedQid ? (
                <View style={styles.matchedBanner}>
                  <Ionicons name="checkmark-done-circle" size={22} color="#059669" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.matchedBannerTitle}>
                      ✨ 已命中本地真题库（重合度 {matchSimilarity}%）
                    </Text>
                    <Text style={styles.matchedBannerSub}>
                      来源：{matchedSourceExam} · 已自动替换为无手写笔迹干净题干与官方答案
                    </Text>
                  </View>
                </View>
              ) : (
                <View style={styles.unmatchedBanner}>
                  <Ionicons name="layers-outline" size={20} color="#4F46E5" />
                  <Text style={styles.unmatchedBannerText}>
                    未在本地库检索到完全相同原题，已按「实拍原图 + 结构化选项」双模保存
                  </Text>
                </View>
              )}

              {/* 正确答案 & 我的错选 */}
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>答案校准与错因归档</Text>
                <View style={styles.ansPickRow}>
                  <Text style={styles.fieldLabel}>标准答案：</Text>
                  <View style={styles.pillGroup}>
                    {ANSWER_KEYS.map((k) => (
                      <Pressable
                        key={k}
                        style={[
                          styles.ansKeyBtn,
                          correctAnswer === k && styles.ansKeyCorrectActive,
                        ]}
                        onPress={() => setCorrectAnswer(k)}
                      >
                        <Text
                          style={[
                            styles.ansKeyBtnText,
                            correctAnswer === k && { color: '#FFFFFF' },
                          ]}
                        >
                          {k}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                <View style={[styles.ansPickRow, { marginTop: 10 }]}>
                  <Text style={styles.fieldLabel}>我的错选：</Text>
                  <View style={styles.pillGroup}>
                    {ANSWER_KEYS.map((k) => (
                      <Pressable
                        key={k}
                        style={[
                          styles.ansKeyBtn,
                          myWrongAnswer === k && styles.ansKeyWrongActive,
                        ]}
                        onPress={() => setMyWrongAnswer(k)}
                      >
                        <Text
                          style={[
                            styles.ansKeyBtnText,
                            myWrongAnswer === k && { color: '#FFFFFF' },
                          ]}
                        >
                          {k}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                <Text style={[styles.fieldLabel, { marginTop: 14, marginBottom: 6 }]}>
                  错因标签（决定后续专项复盘筛选）：
                </Text>
                <View style={styles.wrapRow}>
                  {ERROR_REASONS.map((r) => {
                    const active = errorReason === r.value;
                    return (
                      <Pressable
                        key={r.value}
                        style={[
                          styles.tagChip,
                          active && { backgroundColor: r.color, borderColor: r.color },
                        ]}
                        onPress={() => setErrorReason(r.value)}
                      >
                        <Text style={[styles.tagChipText, active && { color: '#FFFFFF' }]}>
                          {r.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {/* 模块与三级母题考点校准（直接决定同类真题推荐精准度！） */}
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>
                  所属模块与三级母题（驱动同类真题推荐）
                </Text>
                <View style={[styles.wrapRow, { marginTop: 6 }]}>
                  {MODULES_L1.map((m) => {
                    const active = moduleL1 === m;
                    return (
                      <Pressable
                        key={m}
                        style={[
                          styles.tagChip,
                          active && { backgroundColor: '#4F46E5', borderColor: '#4F46E5' },
                        ]}
                        onPress={() => handleModuleChange(m)}
                      >
                        <Text style={[styles.tagChipText, active && { color: '#FFFFFF' }]}>
                          {m}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <Text style={[styles.fieldLabel, { marginTop: 12, marginBottom: 6 }]}>
                  三级母题模型：
                </Text>
                <View style={styles.wrapRow}>
                  {allMotherTypesForModule.map(({ l2, l3 }) => {
                    const active = motherTypeL3 === l3;
                    return (
                      <Pressable
                        key={l3}
                        style={[
                          styles.tagChip,
                          active && { backgroundColor: '#0F766E', borderColor: '#0F766E' },
                        ]}
                        onPress={() => {
                          setCategoryL2(l2);
                          setMotherTypeL3(l3);
                        }}
                      >
                        <Text style={[styles.tagChipText, active && { color: '#FFFFFF' }]}>
                          {l3}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <Text style={[styles.fieldLabel, { marginTop: 12, marginBottom: 4 }]}>
                  核心检索锚点词（成语 / 政策热词，空格分隔）：
                </Text>
                <TextInput
                  style={styles.input}
                  value={anchorKeywordsText}
                  onChangeText={setAnchorKeywordsText}
                  placeholder="例如：相得益彰 缘木求鱼 或 新质生产力"
                />
              </View>

              {/* 题干与个人心得微调 */}
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>题干内容与一句话复盘心得</Text>
                <TextInput
                  style={[styles.input, { minHeight: 72, marginTop: 6 }]}
                  multiline
                  value={stemText}
                  onChangeText={setStemText}
                />
                {pitfallWarning ? (
                  <View style={styles.tipPreview}>
                    <Text style={styles.tipPreviewText}>⚡ {pitfallWarning}</Text>
                  </View>
                ) : null}
                <TextInput
                  style={[styles.input, { marginTop: 10 }]}
                  placeholder="写一句给自己看的防再错提醒（如：看清回落是加法！）"
                  value={userNote}
                  onChangeText={setUserNote}
                />
              </View>

              <Pressable style={styles.primaryBtn} onPress={handleSaveMistake}>
                <Ionicons name="bookmark" size={18} color="#FFFFFF" />
                <Text style={styles.primaryBtnText}>
                  保存错题并查看推荐的同类历年真题 →
                </Text>
              </Pressable>
            </ScrollView>
          )}
            </>
          )}
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
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  iconBtn: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 16.5,
    fontWeight: '700',
    color: '#111827',
  },
  scrollBody: {
    padding: 14,
    paddingBottom: 40,
    gap: 12,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  sectionTitle: {
    fontSize: 14.5,
    fontWeight: '700',
    color: '#111827',
  },
  sectionHint: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 3,
    marginBottom: 12,
  },
  dualActionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  bigCaptureBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 18,
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 4,
  },
  bigCaptureBtnTitle: {
    fontSize: 14.5,
    fontWeight: '700',
    color: '#FFFFFF',
    marginTop: 2,
  },
  bigCaptureBtnSub: {
    fontSize: 11.5,
    color: 'rgba(255,255,255,0.85)',
  },
  previewBox: {
    alignItems: 'center',
    gap: 8,
  },
  previewImg: {
    width: '100%',
    height: 180,
    borderRadius: 10,
    backgroundColor: '#F9FAFB',
  },
  removeImgBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: '#FEF2F2',
  },
  removeImgText: {
    fontSize: 12,
    color: '#DC2626',
    fontWeight: '600',
  },
  extraSlotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    gap: 10,
  },
  extraSlotTitle: {
    fontSize: 13.5,
    fontWeight: '600',
    color: '#1F2937',
  },
  extraSlotDesc: {
    fontSize: 11.5,
    color: '#6B7280',
    marginTop: 2,
  },
  miniBtnGroup: {
    flexDirection: 'row',
    gap: 8,
  },
  miniBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotDoneChip: {
    backgroundColor: '#D1FAE5',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  slotDoneText: {
    fontSize: 12,
    color: '#065F46',
    fontWeight: '700',
  },
  manualHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  demoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  demoChip: {
    backgroundColor: '#F5F3FF',
    borderWidth: 1,
    borderColor: '#DDD6FE',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  demoChipText: {
    fontSize: 12,
    color: '#6D28D9',
    fontWeight: '600',
  },
  input: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 9,
    paddingHorizontal: 11,
    paddingVertical: 9,
    fontSize: 13.5,
    color: '#111827',
    textAlignVertical: 'top',
  },
  optInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  optInputLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#374151',
    width: 20,
  },
  primaryBtn: {
    backgroundColor: '#4F46E5',
    borderRadius: 12,
    paddingVertical: 15,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  loadingOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    gap: 12,
  },
  loadingTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1F2937',
    textAlign: 'center',
  },
  loadingSub: {
    fontSize: 12.5,
    color: '#6B7280',
  },
  matchedBanner: {
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#6EE7B7',
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  matchedBannerTitle: {
    fontSize: 13.5,
    fontWeight: '700',
    color: '#065F46',
  },
  matchedBannerSub: {
    fontSize: 12,
    color: '#047857',
    marginTop: 2,
  },
  unmatchedBanner: {
    backgroundColor: '#EEF2FF',
    borderWidth: 1,
    borderColor: '#C7D2FE',
    borderRadius: 12,
    padding: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  unmatchedBannerText: {
    flex: 1,
    fontSize: 12.5,
    color: '#3730A3',
  },
  ansPickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  pillGroup: {
    flexDirection: 'row',
    gap: 8,
  },
  ansKeyBtn: {
    width: 38,
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#F9FAFB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ansKeyCorrectActive: {
    backgroundColor: '#059669',
    borderColor: '#059669',
  },
  ansKeyWrongActive: {
    backgroundColor: '#DC2626',
    borderColor: '#DC2626',
  },
  ansKeyBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#374151',
  },
  wrapRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  tagChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#F9FAFB',
  },
  tagChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  tipPreview: {
    marginTop: 8,
    backgroundColor: '#FFFBEB',
    padding: 9,
    borderRadius: 8,
  },
  tipPreviewText: {
    fontSize: 12.5,
    color: '#92400E',
  },
});
