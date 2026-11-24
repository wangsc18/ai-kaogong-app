import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  getDashboardStats,
  initializeDatabases,
  listMistakes,
  loadStudyPlanState,
} from './src/db/database';
import { CaptureWizardModal } from './src/screens/CaptureWizardModal';
import { HomeScreen } from './src/screens/HomeScreen';
import { MistakeDetailModal } from './src/screens/MistakeDetailModal';
import { MistakesListScreen } from './src/screens/MistakesListScreen';
import { QuestionBankScreen } from './src/screens/QuestionBankScreen';
import { ReviewSessionModal } from './src/screens/ReviewSessionModal';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { StudyPlannerScreen } from './src/screens/StudyPlannerScreen';
import {
  DashboardStats,
  MistakeRecord,
  ModuleL1,
  StudyPlanState,
} from './src/types/models';

type TabKey = 'home' | 'planner' | 'mistakes' | 'bank' | 'settings';

const TAB_TITLES: Record<TabKey, string> = {
  home: '今日复盘工作台',
  planner: '讲义分析与进度规划',
  mistakes: '我的错题本',
  bank: '开源历年真题库',
  settings: 'AI 接口与数据设置',
};

const EMPTY_STATS: DashboardStats = {
  totalMistakes: 0,
  dueTodayCount: 0,
  masteredCount: 0,
  totalRealQuestions: 0,
  activePackName: '正在加载...',
  topWeakMotherTypes: [],
  errorReasonBreakdown: [],
};

function MainApplication() {
  const [bootReady, setBootReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('home');
  const [refreshTick, setRefreshTick] = useState(0);

  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS);
  const [recentMistakes, setRecentMistakes] = useState<MistakeRecord[]>([]);
  const [studyPlan, setStudyPlan] = useState<StudyPlanState | null>(null);
  const [bankPreset, setBankPreset] = useState<{
    moduleL1: ModuleL1;
    motherTypeL3?: string;
    seq: number;
  } | null>(null);

  // 弹窗路由状态
  const [captureVisible, setCaptureVisible] = useState(false);
  const [activeMistake, setActiveMistake] = useState<MistakeRecord | null>(null);
  const [reviewQueue, setReviewQueue] = useState<MistakeRecord[]>([]);
  const [reviewVisible, setReviewVisible] = useState(false);

  const reloadDashboard = useCallback(async () => {
    const [s, recents, plan] = await Promise.all([
      getDashboardStats(),
      listMistakes(),
      loadStudyPlanState(),
    ]);
    setStats(s);
    setRecentMistakes(recents);
    setStudyPlan(plan);
    setRefreshTick((t) => t + 1);
  }, []);

  useEffect(() => {
    initializeDatabases()
      .then(() => reloadDashboard())
      .then(() => setBootReady(true))
      .catch((err: any) => setBootError(err?.message || String(err)));
  }, [reloadDashboard]);

  // 安卓物理返回键与侧滑返回手势友好处理
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (reviewVisible) {
        setReviewVisible(false);
        return true;
      }
      if (activeMistake) {
        setActiveMistake(null);
        return true;
      }
      if (captureVisible) {
        setCaptureVisible(false);
        return true;
      }
      if (activeTab !== 'home') {
        setActiveTab('home');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [activeTab, captureVisible, activeMistake, reviewVisible]);

  const handleStartDueReview = async () => {
    const due = await listMistakes({ dueOnly: true });
    if (!due.length) {
      Alert.alert('提示', '今日暂无到期错题！');
      return;
    }
    setReviewQueue(due);
    setReviewVisible(true);
  };

  const handleStartAllReview = async () => {
    const all = await listMistakes();
    if (!all.length) return;
    const shuffled = [...all].sort(() => Math.random() - 0.5).slice(0, 15);
    setReviewQueue(shuffled);
    setReviewVisible(true);
  };

  if (bootError) {
    return (
      <SafeAreaView style={styles.centerBox}>
        <Text style={styles.errTitle}>本地数据库初始化异常</Text>
        <Text style={styles.errBody}>{bootError}</Text>
      </SafeAreaView>
    );
  }

  if (!bootReady) {
    return (
      <SafeAreaView style={styles.centerBox}>
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text style={styles.bootText}>正在挂载本地双数据库与万题真题索引...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />

      {/* 顶部全局标题与设置快捷入口 */}
      <View style={styles.topHeader}>
        <View style={styles.topHeaderLeft}>
          {activeTab === 'settings' ? (
            <Pressable
              style={styles.backIconBtn}
              onPress={() => setActiveTab('home')}
            >
              <Ionicons name="arrow-back" size={20} color="#111827" />
            </Pressable>
          ) : null}
          <Text style={styles.topHeaderTitle}>{TAB_TITLES[activeTab]}</Text>
        </View>

        <Pressable
          style={[
            styles.settingsPill,
            activeTab === 'settings' && styles.settingsPillActive,
          ]}
          onPress={() =>
            setActiveTab(activeTab === 'settings' ? 'home' : 'settings')
          }
        >
          <Ionicons
            name="settings-outline"
            size={15}
            color={activeTab === 'settings' ? '#FFFFFF' : '#4F46E5'}
          />
          <Text
            style={[
              styles.settingsPillText,
              activeTab === 'settings' && { color: '#FFFFFF' },
            ]}
          >
            设置
          </Text>
        </Pressable>
      </View>

      {/* 主页面内容区 */}
      <View style={{ flex: 1 }}>
        {activeTab === 'home' && (
          <HomeScreen
            stats={stats}
            recentMistakes={recentMistakes}
            studyPlan={studyPlan}
            onOpenCapture={() => setCaptureVisible(true)}
            onStartDueReview={handleStartDueReview}
            onStartAllReview={handleStartAllReview}
            onSelectMistake={(m) => setActiveMistake(m)}
            onNavigateTab={(t) => setActiveTab(t)}
          />
        )}

        {activeTab === 'planner' && (
          <StudyPlannerScreen
            refreshTick={refreshTick}
            onPlanUpdated={reloadDashboard}
            onPracticeChapter={(moduleL1, motherTypeL3) => {
              setBankPreset((prev) => ({
                moduleL1,
                motherTypeL3,
                seq: (prev?.seq || 0) + 1,
              }));
              setActiveTab('bank');
            }}
          />
        )}

        {activeTab === 'mistakes' && (
          <MistakesListScreen
            refreshTick={refreshTick}
            onSelectMistake={(m) => setActiveMistake(m)}
            onOpenCapture={() => setCaptureVisible(true)}
            onStartFilteredReview={(items) => {
              setReviewQueue(items);
              setReviewVisible(true);
            }}
          />
        )}

        {activeTab === 'bank' && (
          <QuestionBankScreen
            refreshTick={refreshTick}
            totalCount={stats.totalRealQuestions}
            activePackName={stats.activePackName}
            presetFilter={bankPreset}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsScreen
            activePackName={stats.activePackName}
            totalRealQuestions={stats.totalRealQuestions}
            onDataChanged={reloadDashboard}
          />
        )}
      </View>

      {/* 底部导航栏：复盘 | 讲义规划 | [拍错题] | 错题本 | 真题库 */}
      <SafeAreaView edges={['bottom']} style={styles.tabBarSafe}>
        <View style={styles.tabBar}>
          <Pressable style={styles.tabItem} onPress={() => setActiveTab('home')}>
            <Ionicons
              name={activeTab === 'home' ? 'home' : 'home-outline'}
              size={21}
              color={activeTab === 'home' ? '#4F46E5' : '#6B7280'}
            />
            <Text style={[styles.tabLabel, activeTab === 'home' && styles.tabLabelActive]}>
              复盘
            </Text>
          </Pressable>

          <Pressable style={styles.tabItem} onPress={() => setActiveTab('planner')}>
            <Ionicons
              name={activeTab === 'planner' ? 'compass' : 'compass-outline'}
              size={21}
              color={activeTab === 'planner' ? '#4F46E5' : '#6B7280'}
            />
            <Text style={[styles.tabLabel, activeTab === 'planner' && styles.tabLabelActive]}>
              讲义规划
            </Text>
          </Pressable>

          {/* 中央拍题快捷圆钮 */}
          <Pressable
            style={styles.fabButton}
            onPress={() => setCaptureVisible(true)}
          >
            <Ionicons name="camera" size={24} color="#FFFFFF" />
          </Pressable>

          <Pressable style={styles.tabItem} onPress={() => setActiveTab('mistakes')}>
            <Ionicons
              name={activeTab === 'mistakes' ? 'book' : 'book-outline'}
              size={21}
              color={activeTab === 'mistakes' ? '#4F46E5' : '#6B7280'}
            />
            <Text style={[styles.tabLabel, activeTab === 'mistakes' && styles.tabLabelActive]}>
              错题本
            </Text>
          </Pressable>

          <Pressable style={styles.tabItem} onPress={() => setActiveTab('bank')}>
            <Ionicons
              name={activeTab === 'bank' ? 'library' : 'library-outline'}
              size={21}
              color={activeTab === 'bank' ? '#4F46E5' : '#6B7280'}
            />
            <Text style={[styles.tabLabel, activeTab === 'bank' && styles.tabLabelActive]}>
              真题库
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>

      {/* 全屏功能弹窗 */}
      <CaptureWizardModal
        visible={captureVisible}
        onClose={() => setCaptureVisible(false)}
        onSaved={async (saved) => {
          setCaptureVisible(false);
          await reloadDashboard();
          setActiveMistake(saved);
        }}
      />

      <MistakeDetailModal
        mistake={activeMistake}
        visible={Boolean(activeMistake)}
        onClose={() => setActiveMistake(null)}
        onUpdated={reloadDashboard}
      />

      <ReviewSessionModal
        visible={reviewVisible}
        queue={reviewQueue}
        onClose={() => setReviewVisible(false)}
        onFinished={reloadDashboard}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MainApplication />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  topHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  backIconBtn: {
    paddingRight: 4,
  },
  topHeaderTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111827',
  },
  settingsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  settingsPillActive: {
    backgroundColor: '#4F46E5',
  },
  settingsPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4F46E5',
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#F3F4F6',
    gap: 12,
  },
  bootText: {
    fontSize: 13.5,
    color: '#4B5563',
    fontWeight: '600',
  },
  errTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#DC2626',
  },
  errBody: {
    fontSize: 13,
    color: '#4B5563',
    textAlign: 'center',
  },
  tabBarSafe: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    height: 58,
    paddingHorizontal: 6,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  tabLabel: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '600',
  },
  tabLabelActive: {
    color: '#4F46E5',
    fontWeight: '700',
  },
  fabButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#4F46E5',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -14,
    shadowColor: '#4F46E5',
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
});
