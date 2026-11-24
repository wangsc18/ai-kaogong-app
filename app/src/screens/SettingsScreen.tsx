import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
  pickDocumentSafe,
} from '../services/localFileReader';
import { testEndpointConnectivity } from '../ai/aiClient';
import { AI_PROVIDER_PRESETS } from '../ai/methodCards';
import {
  DEFAULT_AI_SETTINGS,
  importExternalQuestionBankDb,
  importJsonQuestionsIntoSeedBank,
  loadAISettings,
  resetToSeedQuestionBank,
  saveAISettings,
} from '../db/database';
import {
  exportFullNotebookBackup,
  importFullNotebookBackup,
} from '../services/backupService';
import { AISettings, ModelEndpointConfig } from '../types/models';

interface Props {
  activePackName: string;
  totalRealQuestions: number;
  onDataChanged: () => void;
}

export function SettingsScreen({
  activePackName,
  totalRealQuestions,
  onDataChanged,
}: Props) {
  const [settings, setSettings] = useState<AISettings>(DEFAULT_AI_SETTINGS);
  const [testingWhich, setTestingWhich] = useState<'vision' | 'reasoning' | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);

  useEffect(() => {
    loadAISettings().then(setSettings);
  }, []);

  const handleSave = async (next: AISettings) => {
    setSettings(next);
    await saveAISettings(next);
  };

  const applyPreset = async (presetId: 'deepseek' | 'openai') => {
    const preset = AI_PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const prevKey = settings.visionModel.apiKey;
    const next: AISettings = {
      ...settings,
      splitVisionAndReasoning: preset.config.splitVisionAndReasoning,
      visionModel: {
        ...preset.config.visionModel,
        apiKey: prevKey,
      },
      reasoningModel: {
        ...preset.config.reasoningModel,
        apiKey: settings.reasoningModel.apiKey || prevKey,
      },
    };
    await handleSave(next);
    Alert.alert('模板已切换', `已切换为「${preset.title}」，填入你的 API Key 即可测试连通性。`);
  };

  const handleTestEndpoint = async (which: 'vision' | 'reasoning') => {
    const ep = which === 'vision' ? settings.visionModel : settings.reasoningModel;
    setTestingWhich(which);
    try {
      const reply = await testEndpointConnectivity(ep);
      Alert.alert('连通成功 ✅', `模型返回：${reply}`);
    } catch (err: any) {
      Alert.alert('连接失败 ❌', err?.message || String(err));
    } finally {
      setTestingWhich(null);
    }
  };

  const handleImportQuestionPack = async () => {
    try {
      const asset = await pickDocumentSafe('*/*');
      if (!asset) return;

      const lowerName = `${asset.name || ''} ${asset.uri || ''}`.toLowerCase();
      setBusyMessage('正在导入离线真题数据包并挂载检索索引...');

      try {
        if (lowerName.includes('.json') || lowerName.includes('.jsonl')) {
          const added = await importJsonQuestionsIntoSeedBank(asset.uri);
          onDataChanged();
          Alert.alert('JSON 真题导入完成', `成功合并写入 ${added} 道结构化真题！`);
        } else {
          const res = await importExternalQuestionBankDb(asset.uri);
          onDataChanged();
          Alert.alert(
            '离线 SQLite 真题库切换成功 ✅',
            `当前激活：${res.packName}\n总题量：${res.count} 道`
          );
        }
      } finally {
        cleanupTempPickedUri(asset.uri);
      }
    } catch (err: any) {
      Alert.alert('导入失败', err?.message || String(err));
    } finally {
      setBusyMessage(null);
    }
  };

  const handleResetBundledBank = () => {
    Alert.alert(
      '切回内置开源大题库',
      '确定切回 App 内置的 1.1 万+ 道开源国省考真题库吗？（你的错题本不受任何影响）',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确定切换',
          onPress: async () => {
            await resetToSeedQuestionBank();
            onDataChanged();
          },
        },
      ]
    );
  };

  const getSuggestedModelsForUrl = (url: string): string[] => {
    if (url.includes('deepseek')) {
      return ['deepseek-flash', 'deepseek-v4-pro'];
    }
    return ['gpt-5', 'gpt-5-mini', 'gpt-6.1-terra', 'gpt-4.1'];
  };

  const renderEndpointEditor = (
    title: string,
    which: 'vision' | 'reasoning',
    ep: ModelEndpointConfig
  ) => {
    const updateField = (patch: Partial<ModelEndpointConfig>) => {
      const updated = { ...ep, ...patch };
      if (which === 'vision') {
        handleSave({
          ...settings,
          visionModel: updated,
          reasoningModel: settings.splitVisionAndReasoning
            ? settings.reasoningModel
            : updated,
        });
      } else {
        handleSave({ ...settings, reasoningModel: updated });
      }
    };

    const quickModels = getSuggestedModelsForUrl(ep.baseUrl);

    return (
      <View style={styles.endpointBox}>
        <Text style={styles.epTitle}>{title}</Text>

        <Text style={styles.label}>接口地址 (Base URL)</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          value={ep.baseUrl}
          onChangeText={(v) => updateField({ baseUrl: v })}
          placeholder="https://api.deepseek.com/v1"
        />

        <Text style={styles.label}>API Key（仅保存在你手机本地 SQLite）</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          secureTextEntry
          value={ep.apiKey}
          onChangeText={(v) => updateField({ apiKey: v })}
          placeholder="sk-..."
        />

        <Text style={styles.label}>模型名称 (Model ID · 可点下方胶囊快速填入)</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          value={ep.modelName}
          onChangeText={(v) => updateField({ modelName: v })}
          placeholder="deepseek-flash"
        />

        <View style={styles.quickModelRow}>
          {quickModels.map((mId) => {
            const active = ep.modelName === mId;
            return (
              <Pressable
                key={mId}
                style={[styles.modelChip, active && styles.modelChipActive]}
                onPress={() => updateField({ modelName: mId })}
              >
                <Text style={[styles.modelChipText, active && { color: '#FFFFFF' }]}>
                  {mId}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable
          style={styles.testBtn}
          onPress={() => handleTestEndpoint(which)}
          disabled={testingWhich !== null}
        >
          {testingWhich === which ? (
            <ActivityIndicator size="small" color="#4F46E5" />
          ) : (
            <Ionicons name="flash-outline" size={15} color="#4F46E5" />
          )}
          <Text style={styles.testBtnText}>测试连通性</Text>
        </Pressable>
      </View>
    );
  };

  const forceOcr = settings.ocrFallbackMode === 'force_ocr';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {busyMessage ? (
        <View style={styles.busyBanner}>
          <ActivityIndicator size="small" color="#4F46E5" />
          <Text style={styles.busyText}>{busyMessage}</Text>
        </View>
      ) : null}

      {/* 精简二选一：DeepSeek 与 OpenAI 官方模板 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🤖 AI 接口快速模板（DeepSeek / OpenAI）</Text>
        <Text style={styles.cardSub}>
          支持单填一个 DeepSeek Key 跑通全流程：deepseek-flash 原生支持识图，纯文本模型自动走备用 OCR
        </Text>
        <View style={{ marginTop: 10, gap: 8 }}>
          {AI_PROVIDER_PRESETS.map((p) => {
            const isCurrent = settings.visionModel.baseUrl.includes(p.id);
            return (
              <Pressable
                key={p.id}
                style={[styles.presetItem, isCurrent && styles.presetItemActive]}
                onPress={() => applyPreset(p.id)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.presetTitle}>{p.title}</Text>
                  <Text style={styles.presetSub}>{p.subtitle}</Text>
                </View>
                <Text style={styles.applyText}>{isCurrent ? '当前使用' : '一键切换'}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* 模型参数与方法卡配置 */}
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchTitle}>拆分「识图模型」与「深度推理讲题模型」</Text>
            <Text style={styles.switchSub}>
              例如用 deepseek-flash 快速识图，再用旗舰 deepseek-v4-pro 深度推演秒杀步骤
            </Text>
          </View>
          <Switch
            value={settings.splitVisionAndReasoning}
            onValueChange={(val) =>
              handleSave({ ...settings, splitVisionAndReasoning: val })
            }
          />
        </View>

        <View style={[styles.switchRow, { marginTop: 12 }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchTitle}>启用公考考场实战秒杀方法卡</Text>
            <Text style={styles.switchSub}>
              强制输出 415 份数法、盐水法、两期比重、图推奇点数等考场速解流派
            </Text>
          </View>
          <Switch
            value={settings.enableFastMethodCards}
            onValueChange={(val) =>
              handleSave({ ...settings, enableFastMethodCards: val })
            }
          />
        </View>

        {renderEndpointEditor(
          settings.splitVisionAndReasoning
            ? '1. 视觉识图模型 (VLM)'
            : '主模型配置（识图 + 秒杀讲题一体）',
          'vision',
          settings.visionModel
        )}

        {settings.splitVisionAndReasoning
          ? renderEndpointEditor(
              '2. 深度推理讲题模型 (LLM)',
              'reasoning',
              settings.reasoningModel
            )
          : null}
      </View>

      {/* 只有纯文本 API Key 时的备用免 Key OCR 引擎卡片 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🔍 备用免 Key OCR 识题兜底引擎</Text>
        <Text style={styles.cardSub}>
          当你使用的模型不支持图片输入时，App 会自动先用备用 OCR 提取中文题面，再交给你的 DeepSeek 模型纠错切分并碰撞本地真题库！
        </Text>

        <View style={[styles.switchRow, { marginTop: 12 }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchTitle}>强制始终使用「备用 OCR 转文本 + 纯文本推理」</Text>
            <Text style={styles.switchSub}>
              关闭时为智能自动降级（原生多模态优先，报错不支持图片时自动切备用 OCR）
            </Text>
          </View>
          <Switch
            value={forceOcr}
            onValueChange={(val) =>
              handleSave({
                ...settings,
                ocrFallbackMode: val ? 'force_ocr' : 'auto',
              })
            }
          />
        </View>

        <Text style={[styles.label, { marginTop: 10 }]}>
          可选：Mac 局域网 Apple Vision 高精度 OCR 地址（留空则走内置云端免费中文 OCR）
        </Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          value={settings.localMacOcrUrl || ''}
          onChangeText={(v) => handleSave({ ...settings, localMacOcrUrl: v })}
          placeholder="例如 http://192.168.1.10:8765/ocr（运行 scripts/local_ocr_server.py）"
        />
      </View>

      {/* 离线真题数据包管理 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>📚 本地开源历年真题库管理</Text>
        <Text style={styles.cardSub}>
          当前激活：{activePackName}（共 {totalRealQuestions} 道真题）
        </Text>
        <Text style={styles.tipBox}>
          💡 App 已直接内置合并自 ERRRC/xingcezhenti 与 gongkao-zhenti-knowledge 的上万道国省考无缺图真题！若需全量 2.1 万+ 题超大全集，可直接导入项目 scripts/dist/question_bank_full_all.db。
        </Text>

        <View style={styles.actionRow}>
          <Pressable style={styles.primaryActionBtn} onPress={handleImportQuestionPack}>
            <Ionicons name="folder-open-outline" size={16} color="#FFFFFF" />
            <Text style={styles.primaryActionText}>导入外部 .db / .json 题库</Text>
          </Pressable>
          <Pressable style={styles.secondaryActionBtn} onPress={handleResetBundledBank}>
            <Text style={styles.secondaryActionText}>恢复内置大库</Text>
          </Pressable>
        </View>
      </View>

      {/* 个人错题本安全备份与恢复 */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🛡️ 错题本全量本地备份与迁移</Text>
        <Text style={styles.cardSub}>
          备份文件内嵌你的全部错题、SM-2 复习进度及实拍图片，换手机零丢失
        </Text>

        <View style={styles.actionRow}>
          <Pressable
            style={[styles.primaryActionBtn, { backgroundColor: '#0F766E' }]}
            onPress={async () => {
              try {
                setBusyMessage('正在打包错题与实拍图片...');
                await exportFullNotebookBackup();
              } catch (err: any) {
                Alert.alert('备份导出失败', err?.message || String(err));
              } finally {
                setBusyMessage(null);
              }
            }}
          >
            <Ionicons name="cloud-upload-outline" size={16} color="#FFFFFF" />
            <Text style={styles.primaryActionText}>导出全量备份包</Text>
          </Pressable>

          <Pressable
            style={styles.secondaryActionBtn}
            onPress={async () => {
              try {
                setBusyMessage('正在恢复错题备份...');
                const res = await importFullNotebookBackup();
                if (res.restoredMistakes > 0) {
                  onDataChanged();
                  Alert.alert(
                    '恢复成功',
                    `已成功恢复 ${res.restoredMistakes} 道错题及实拍图片！`
                  );
                }
              } catch (err: any) {
                Alert.alert('恢复失败', err?.message || String(err));
              } finally {
                setBusyMessage(null);
              }
            }}
          >
            <Text style={styles.secondaryActionText}>从备份恢复</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 14,
    paddingBottom: 36,
    gap: 13,
  },
  busyBanner: {
    backgroundColor: '#EEF2FF',
    borderRadius: 10,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  busyText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#3730A3',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#111827',
  },
  cardSub: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 3,
    lineHeight: 18,
  },
  presetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1.2,
    borderColor: '#E5E7EB',
    gap: 8,
  },
  presetItemActive: {
    borderColor: '#4F46E5',
    backgroundColor: '#F5F7FF',
  },
  presetTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1F2937',
  },
  presetSub: {
    fontSize: 11.5,
    color: '#6B7280',
    marginTop: 3,
    lineHeight: 16.5,
  },
  applyText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#4F46E5',
    paddingHorizontal: 6,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  switchTitle: {
    fontSize: 13.8,
    fontWeight: '700',
    color: '#111827',
  },
  switchSub: {
    fontSize: 11.5,
    color: '#6B7280',
    marginTop: 2,
  },
  endpointBox: {
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    gap: 6,
  },
  epTitle: {
    fontSize: 13.8,
    fontWeight: '800',
    color: '#312E81',
    marginBottom: 2,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
    marginTop: 4,
  },
  input: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 9,
    paddingHorizontal: 11,
    paddingVertical: 8,
    fontSize: 13,
    color: '#111827',
  },
  quickModelRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  modelChip: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  modelChipActive: {
    backgroundColor: '#4F46E5',
    borderColor: '#4F46E5',
  },
  modelChipText: {
    fontSize: 11.5,
    fontWeight: '600',
    color: '#374151',
  },
  testBtn: {
    marginTop: 8,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  testBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#4F46E5',
  },
  tipBox: {
    marginTop: 10,
    backgroundColor: '#F8FAFC',
    padding: 10,
    borderRadius: 8,
    fontSize: 12,
    lineHeight: 18,
    color: '#475569',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  primaryActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#4F46E5',
    paddingVertical: 11,
    borderRadius: 10,
  },
  primaryActionText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  secondaryActionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryActionText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#374151',
  },
});
