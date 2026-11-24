import { ErrorReason, ModuleL1 } from '../types/models';

export const MODULES_L1: ModuleL1[] = [
  '政治理论',
  '常识判断',
  '言语理解',
  '数量关系',
  '判断推理',
  '资料分析',
];

export const MODULE_THEME: Record<
  ModuleL1,
  { bg: string; text: string; border: string; icon: string }
> = {
  政治理论: { bg: '#FEF2F2', text: '#B91C1C', border: '#FECACA', icon: 'flag-outline' },
  常识判断: { bg: '#FFFBEB', text: '#B45309', border: '#FDE68A', icon: 'bulb-outline' },
  言语理解: { bg: '#ECFDF5', text: '#047857', border: '#A7F3D0', icon: 'book-outline' },
  数量关系: { bg: '#EFF6FF', text: '#1D4ED8', border: '#BFDBFE', icon: 'calculator-outline' },
  判断推理: { bg: '#F5F3FF', text: '#6D28D9', border: '#DDD6FE', icon: 'git-network-outline' },
  资料分析: { bg: '#ECFEFF', text: '#0E7490', border: '#A5F3FC', icon: 'bar-chart-outline' },
};

export const ERROR_REASONS: Array<{
  value: ErrorReason;
  label: string;
  desc: string;
  color: string;
}> = [
  {
    value: '审题掉坑',
    label: '审题掉坑',
    desc: '漏看“不正确/不能推出”、同比环比、累计当月或单位陷阱',
    color: '#DC2626',
  },
  {
    value: '公式方法不熟',
    label: '公式方法不熟',
    desc: '母题秒杀公式（如两期比重/盐水法/特值法）不熟或硬算卡壳',
    color: '#D97706',
  },
  {
    value: '概念成语混淆',
    label: '概念成语混淆',
    desc: '近义成语侧重点不清、政治理论原文关键词偷换未识破',
    color: '#7C3AED',
  },
  {
    value: '图推特征盲区',
    label: '图推特征盲区',
    desc: '未一眼认出日/田变形一笔画、对称轴过点线面等特征图',
    color: '#2563EB',
  },
  {
    value: '纯粗心算错',
    label: '纯粗心算错',
    desc: '式子列对但截位加减除抄错数字或涂错选项',
    color: '#059669',
  },
  {
    value: '耗时过长',
    label: '耗时过长',
    desc: '虽然能算出但耗时超2分钟，缺乏考场秒杀路径',
    color: '#4B5563',
  },
];

/**
 * 公考行测标准三级母题考点树（与 Python 离线打包脚本 build_question_pack.py 严格对齐）
 * AI 解析错题时将强制映射至本树节点，确保本地真题库召回 100% 同构对齐
 */
export const KAOGONG_TAXONOMY: Record<ModuleL1, Record<string, string[]>> = {
  政治理论: {
    创新理论与经济: ['新质生产力与高质量发展', '构建高水平社会主义市场经济体制'],
    重大会议公报: ['进一步全面深化改革与中国式现代化', '重要中央会议精神原文辨析'],
    党建与自我革命: ['党的自我革命与全面从严治党'],
    民主法治与治理: ['全过程人民民主与社会治理'],
    宣传思想文化: ['两个结合与社会主义文化强国'],
    生态文明建设: ['绿色发展与美丽中国建设'],
  },
  常识判断: {
    法律常识: ['宪法行政法与民刑新法'],
    人文历史: ['中国古代史与传统文化常识', '党史与近现代史'],
    科技与生活: ['前沿科技成果与理化生常识'],
    地理国情: ['自然地理与中国国情'],
    经济常识: ['宏观经济政策与金融常识'],
  },
  言语理解: {
    逻辑填空: ['实词与高频成语语境辨析'],
    片段阅读: [
      '中心理解题(转折/因果/必要条件)',
      '细节判断题(防无中生有/偷换概念)',
      '标题选择题',
    ],
    语句表达: [
      '语句衔接(居中/居末搭桥)',
      '语句排序(首尾句/指代捆绑)',
      '接语选择题(尾句核心落脚点)',
    ],
  },
  数量关系: {
    数学运算: [
      '工程问题(特值赋值法)',
      '行程问题(相遇追及/流水行船)',
      '经济利润问题',
      '排列组合与概率问题',
      '容斥原理(两集合/三集合公式)',
      '最值问题(最不利构造/数列构造)',
      '几何问题',
      '年龄问题(代入排除/年龄差不变)',
      '方程与倍数特性综合',
    ],
  },
  判断推理: {
    图形推理: [
      '数量类-笔画数(奇点数)',
      '数量类-点线角面素',
      '属性类-对称性细化(轴方向/轴数量/过点线面)',
      '位置与样式类(平移旋转/黑白运算/求同存异)',
      '空间重构(六面体/立体拼合)',
      '立体视图与截面图',
      '图形推理综合特征',
    ],
    逻辑判断: [
      '削弱论证(拆桥/因果倒置/他因)',
      '加强论证-搭桥与必要前提',
      '加强论证-补充论据',
      '翻译推理与真假分析',
      '组合排列(最大信息/代入排除)',
    ],
    类比推理: ['语义逻辑与语法关系'],
    定义判断: ['单定义与多定义关键要件匹配'],
  },
  资料分析: {
    比重问题: ['两期比重差', '基期比重', '现期比重与部分整体'],
    增长率: [
      '混合增长率(盐水法)',
      '间隔增长率',
      '增长率计算与比较',
      '年均增长率',
    ],
    增长量: [
      '现期增长量计算(415/百化分)',
      '增长量大小比较(大大则大/百化分)',
      '年均增长量',
    ],
    基期与现期: ['基期量计算(截位/假设分配)'],
    平均数与倍数: ['平均数增长率', '现期与基期平均数', '现期与基期倍数'],
    综合分析: ['综合判断正误题'],
  },
};

export function flattenTaxonomyText(): string {
  const lines: string[] = [];
  for (const mod of MODULES_L1) {
    const l2Map = KAOGONG_TAXONOMY[mod];
    for (const [l2, l3List] of Object.entries(l2Map)) {
      lines.push(`- ${mod} > ${l2}: ${l3List.join(' | ')}`);
    }
  }
  return lines.join('\n');
}

export function normalizeModuleL1(raw?: string | null): ModuleL1 {
  const s = (raw || '').trim();
  for (const m of MODULES_L1) {
    if (s.includes(m) || m.includes(s)) {
      if (s.length >= 2) return m;
    }
  }
  if (s.includes('政') || s.includes('时政')) return '政治理论';
  if (s.includes('常')) return '常识判断';
  if (s.includes('言')) return '言语理解';
  if (s.includes('数')) return '数量关系';
  if (s.includes('资')) return '资料分析';
  return '判断推理';
}
