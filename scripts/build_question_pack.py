#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
离线公考行测真题数据包构建工具 (build_question_pack.py)

支持将 GitHub 主流开源公考真题仓库一键清洗并转换为本 App 标准的离线 SQLite 数据包 (question_bank.db)：
1. ERRRC/xingcezhenti (Markdown 目录结构：01-政治理论 ~ 06-资料分析 + 90-图片)
2. jangviktor-web/GongkaoNaoku (SQLite kaogong.db 数据库)
3. 通用 JSON / JSONL 格式题库文件

生成的 question_bank.db 内置：
- real_questions 主表（含三级母题考点自动映射 + 成语/政策/公式核心锚点词提取）
- real_questions_fts FTS5 全文检索索引表（支持手机端毫秒级原题碰撞与同类真题双维推荐）

用法示例：
  # 从 ERRRC/xingcezhenti 仓库目录构建
  python3 scripts/build_question_pack.py --mode xingcezhenti --input /path/to/xingcezhenti --output ./question_bank.db --pack-zip ./kaogong_full_pack.zip

  # 从 GongkaoNaoku 的 kaogong.db 构建
  python3 scripts/build_question_pack.py --mode naoku --input /path/to/kaogong.db --output ./question_bank.db

  # 从 JSON/JSONL 构建（或生成演示测试库）
  python3 scripts/build_question_pack.py --mode json --input ./scripts/seed_questions.json --output ./seed_question_bank.db
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import zipfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


# ============================================================================
# 1. 公考行测六大模块与三级母题考点自动映射规则库
# ============================================================================

MODULE_NORMALIZE_MAP = {
    "01-政治理论": "政治理论",
    "政治理论": "政治理论",
    "时政": "政治理论",
    "02-常识判断": "常识判断",
    "常识判断": "常识判断",
    "常识": "常识判断",
    "03-言语理解与表达": "言语理解",
    "言语理解与表达": "言语理解",
    "言语理解": "言语理解",
    "言语": "言语理解",
    "04-数量关系": "数量关系",
    "数量关系": "数量关系",
    "数量": "数量关系",
    "数学运算": "数量关系",
    "05-判断推理": "判断推理",
    "判断推理": "判断推理",
    "判断": "判断推理",
    "06-资料分析": "资料分析",
    "资料分析": "资料分析",
    "资料": "资料分析",
}

# (模块, 正则特征, 二级题型 category_l2, 三级母题考点 mother_type_l3)
TAXONOMY_RULES: List[Tuple[str, re.Pattern[str], str, str]] = [
    # --- 资料分析 ---
    ("资料分析", re.compile(r"占.{0,18}比重.{0,12}(上升|下降|高|低|多|少).{0,8}百分点"), "比重问题", "两期比重差"),
    ("资料分析", re.compile(r"(占.{0,15}比重|占比).{0,10}(上年|基期|前年)"), "比重问题", "基期比重"),
    ("资料分析", re.compile(r"(占.{0,18}比重|占比)"), "比重问题", "现期比重与部分整体"),
    ("资料分析", re.compile(r"(增速|增长率).{0,12}(最快|最高|最大|排序|超过\d+%)"), "增长率", "增长率计算与比较"),
    ("资料分析", re.compile(r"(上半年|全年|累计|合计|进出口总额).{0,20}(增速|增长率)"), "增长率", "混合增长率(盐水法)"),
    ("资料分析", re.compile(r"(隔年|两年平均|比20\d\d年增长.{0,6}%)"), "增长率", "间隔增长率"),
    ("资料分析", re.compile(r"(年均增长率|年均增速)"), "增长率", "年均增长率"),
    ("资料分析", re.compile(r"(同比|比上年).{0,8}(增加|减少|多|少|增长量|增量).{0,10}(最多|最大|最少|排序)"), "增长量", "增长量大小比较(大大则大/百化分)"),
    ("资料分析", re.compile(r"(同比|比上年).{0,8}(增加|减少|增长了约|增量).{0,8}(多少|约)"), "增长量", "现期增长量计算(415/百化分)"),
    ("资料分析", re.compile(r"(年均增加|年均增长量|平均每年增加)"), "增长量", "年均增长量"),
    ("资料分析", re.compile(r"(平均每|人均|户均|均价|单位面积).{0,15}(上升|下降|增长|减少).{0,6}%"), "平均数与倍数", "平均数增长率"),
    ("资料分析", re.compile(r"(平均每|人均|户均|均价|单价)"), "平均数与倍数", "现期与基期平均数"),
    ("资料分析", re.compile(r"是.{0,15}的.{0,6}倍"), "平均数与倍数", "现期与基期倍数"),
    ("资料分析", re.compile(r"(能够从上述资料中推出|不能从上述资料中推出|下列说法正确|下列说法错误)"), "综合分析", "综合判断正误题"),
    ("资料分析", re.compile(r"(上年同期|基期|20\d\d年.{0,8}约为)"), "基期与现期", "基期量计算(截位/假设分配)"),

    # --- 判断推理 ---
    ("判断推理", re.compile(r"(从所给的四个选项中|填入问号处|把下面的六个图形分为两类|左图给定的是纸盒|截面|三视图|立体图形)"), "图形推理", "图形推理综合特征"),
    ("判断推理", re.compile(r"(六面体|折成|展开图|纸盒外表面)"), "图形推理", "空间重构(六面体/立体拼合)"),
    ("判断推理", re.compile(r"(截面|剖面|三视图|俯视图|主视图)"), "图形推理", "立体视图与截面图"),
    ("判断推理", re.compile(r"∶|:|相当于|之于"), "类比推理", "语义逻辑与语法关系"),
    ("判断推理", re.compile(r"(前提|假设|补充哪项|支持上述论证的必要条件)"), "逻辑判断", "加强论证-搭桥与必要前提"),
    ("判断推理", re.compile(r"(支持|加强|佐证)"), "逻辑判断", "加强论证-补充论据"),
    ("判断推理", re.compile(r"(削弱|质疑|反驳)"), "逻辑判断", "削弱论证(拆桥/因果倒置/他因)"),
    ("判断推理", re.compile(r"(只有一句为真|只有一句为假|真话|假话|由此可以推出)"), "逻辑判断", "翻译推理与真假分析"),
    ("判断推理", re.compile(r"(属于|不属于|符合|不符合).{1,12}定义"), "定义判断", "单定义与多定义关键要件匹配"),

    # --- 言语理解 ---
    ("言语理解", re.compile(r"依次填入(画横线|划横线|横线)部分最恰当"), "逻辑填空", "实词与高频成语语境辨析"),
    ("言语理解", re.compile(r"填入(画横线|划横线|横线)部分最恰当的一项(?!.*依次)"), "语句表达", "语句衔接(居中/居末搭桥)"),
    ("言语理解", re.compile(r"(排序最恰当|排列最恰当|①.*②.*③)"), "语句表达", "语句排序(首尾句/指代捆绑)"),
    ("言语理解", re.compile(r"(接下来最可能讲|后文最可能论述)"), "语句表达", "接语选择题(尾句核心落脚点)"),
    ("言语理解", re.compile(r"(最适合做这段文字标题|最佳标题)"), "片段阅读", "标题选择题"),
    ("言语理解", re.compile(r"(与这段文字文意相符|不相符|下列说法正确|理解不准确)"), "片段阅读", "细节判断题(防无中生有/偷换概念)"),
    ("言语理解", re.compile(r"(意在说明|意在强调|主要说明|主旨|这段文字重在)"), "片段阅读", "中心理解题(转折/因果/必要条件)"),

    # --- 数量关系 ---
    ("数量关系", re.compile(r"(甲、乙|单独完成|合作|工程|效率|工期)"), "数学运算", "工程问题(特值赋值法)"),
    ("数量关系", re.compile(r"(速度|相向而行|追及|相遇|顺水|逆水|千米/小时)"), "数学运算", "行程问题(相遇追及/流水行船)"),
    ("数量关系", re.compile(r"(利润|打折|定价|成本|售价|折扣)"), "数学运算", "经济利润问题"),
    ("数量关系", re.compile(r"(概率|至少|不同选法|排列|组合|分给)"), "数学运算", "排列组合与概率问题"),
    ("数量关系", re.compile(r"(都参加|既.{1,6}又|至少参加一项|都不)"), "数学运算", "容斥原理(两集合/三集合公式)"),
    ("数量关系", re.compile(r"(三角形|正方形|圆形|面积|周长|体积|表面积)"), "数学运算", "几何问题"),
    ("数量关系", re.compile(r"(年龄|岁数)"), "数学运算", "年龄问题(代入排除/年龄差不变)"),
    ("数量关系", re.compile(r"(最多|最少|至多|至少.{0,6}才能保证)"), "数学运算", "最值问题(最不利构造/数列构造)"),

    # --- 政治理论 ---
    ("政治理论", re.compile(r"(新质生产力|科技创新|高质量发展|现代化产业体系)"), "创新理论与经济", "新质生产力与高质量发展"),
    ("政治理论", re.compile(r"(二十届三中全会|进一步全面深化改革|中国式现代化)"), "重大会议公报", "进一步全面深化改革与中国式现代化"),
    ("政治理论", re.compile(r"(自我革命|全面从严治党|纪律处分|八项规定|党的领导)"), "党建与自我革命", "党的自我革命与全面从严治党"),
    ("政治理论", re.compile(r"(全过程人民民主|基层治理|法治中国|枫桥经验)"), "民主法治与治理", "全过程人民民主与社会治理"),
    ("政治理论", re.compile(r"(文化自信|两个结合|精神文明|中华文明)"), "宣传思想文化", "两个结合与社会主义文化强国"),
    ("政治理论", re.compile(r"(绿水青山|生态文明|双碳|美丽中国|黄河|长江)"), "生态文明建设", "绿色发展与美丽中国建设"),

    # --- 常识判断 ---
    ("常识判断", re.compile(r"(宪法|民法典|刑法|行政复议|行政处罚|行政诉讼|治安管理|公司法)"), "法律常识", "宪法行政法与民刑新法"),
    ("常识判断", re.compile(r"(古诗|诗词|朝代|历史事件|成语典故|诸子百家|二十四节气)"), "人文历史", "中国古代史与传统文化常识"),
    ("常识判断", re.compile(r"(物理|化学|生物|航天|卫星|量子|电池|医学|急救)"), "科技与生活", "前沿科技成果与理化生常识"),
    ("常识判断", re.compile(r"(地形|气候|河流|山脉|洋流|省份|地理)"), "地理国情", "自然地理与中国国情"),
    ("常识判断", re.compile(r"(宏观调控|财政政策|货币政策|利率|通胀|GDP|汇率)"), "经济常识", "宏观经济政策与金融常识"),
]

DEFAULT_TAXONOMY_BY_MODULE: Dict[str, Tuple[str, str]] = {
    "政治理论": ("重要讲话与会议精神", "政治理论原文精准辨析"),
    "常识判断": ("综合常识", "高频综合常识辨析"),
    "言语理解": ("片段阅读", "中心理解题(转折/因果/必要条件)"),
    "数量关系": ("数学运算", "方程与倍数特性综合"),
    "判断推理": ("逻辑判断", "综合推理与论证"),
    "资料分析": ("基期与现期", "基期量计算(截位/假设分配)"),
}

# 提取四字成语与核心政策锚点词
CHENGYU_PATTERN = re.compile(r"[\u4e00-\u9fa5]{4}")
COMMON_STOP_4CHARS = {
    "这段文字", "最恰当的", "依次填入", "画横线部", "划横线部", "下列说法",
    "不能推出", "可以推出", "由此可知", "上述材料", "上年同期", "同比增长",
    "百分点是", "公务员考", "行政职业", "四个选项", "问号处最", "属于上述",
}
POLICY_HOTWORDS = [
    "新质生产力", "中国式现代化", "进一步全面深化改革", "二十届三中全会", "两个结合",
    "全过程人民民主", "自我革命", "高质量发展", "新发展理念", "全国统一大市场",
    "枫桥经验", "乡村振兴", "粮食安全", "共同富裕", "美丽中国", "总体国家安全观",
    "行政复议", "行政处罚", "民法典", "新发展格局", "数字经济", "人工智能",
]


def infer_taxonomy(module_l1: str, stem: str, options_text: str, existing_l2: str = "", existing_l3: str = "") -> Tuple[str, str]:
    if existing_l2 and existing_l3:
        return existing_l2, existing_l3
    combined = f"{stem}\n{options_text}"
    for rule_mod, pattern, l2, l3 in TAXONOMY_RULES:
        if rule_mod == module_l1 and pattern.search(combined):
            return existing_l2 or l2, existing_l3 or l3
    def_l2, def_l3 = DEFAULT_TAXONOMY_BY_MODULE.get(module_l1, ("综合题型", "综合考点"))
    return existing_l2 or def_l2, existing_l3 or def_l3


def extract_anchor_keywords(module_l1: str, category_l2: str, mother_type_l3: str, stem: str, options: List[Dict[str, Any]]) -> str:
    anchors: List[str] = [mother_type_l3, category_l2]
    options_str = " ".join(str(opt.get("text", "")) for opt in options)
    full_text = f"{stem} {options_str}"

    # 逻辑填空重点提取选项中的四字成语与二字实词
    if category_l2 == "逻辑填空":
        for opt in options:
            txt = str(opt.get("text", ""))
            parts = re.split(r"[\s、，,/|；;]+", txt)
            for p in parts:
                p = p.strip()
                if 2 <= len(p) <= 4 and re.fullmatch(r"[\u4e00-\u9fa5]+", p) and p not in COMMON_STOP_4CHARS:
                    if p not in anchors:
                        anchors.append(p)

    # 政治理论与常识提取核心政策词与法律名
    for hw in POLICY_HOTWORDS:
        if hw in full_text and hw not in anchors:
            anchors.append(hw)

    return " ".join(anchors[:16])


# ============================================================================
# 2. SQLite 离线真题包 Schema 创建与写入
# ============================================================================

SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS pack_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS real_questions (
    qid TEXT PRIMARY KEY,
    source_exam TEXT NOT NULL DEFAULT '',
    year INTEGER NOT NULL DEFAULT 2025,
    province TEXT NOT NULL DEFAULT '国考',
    module_l1 TEXT NOT NULL,
    category_l2 TEXT NOT NULL,
    mother_type_l3 TEXT NOT NULL,
    material_id TEXT,
    material_text TEXT,
    material_images_json TEXT NOT NULL DEFAULT '[]',
    stem TEXT NOT NULL,
    stem_images_json TEXT NOT NULL DEFAULT '[]',
    options_json TEXT NOT NULL DEFAULT '[]',
    answer TEXT NOT NULL DEFAULT '',
    official_analysis TEXT NOT NULL DEFAULT '',
    fast_tips TEXT NOT NULL DEFAULT '',
    anchor_keywords TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_rq_module_l3 ON real_questions(module_l1, mother_type_l3, year DESC);
CREATE INDEX IF NOT EXISTS idx_rq_module_l2 ON real_questions(module_l1, category_l2, year DESC);
CREATE INDEX IF NOT EXISTS idx_rq_year ON real_questions(year DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS real_questions_fts USING fts5(
    qid UNINDEXED,
    seg_body,
    tokenize = 'unicode61',
    detail = 'none'
);
"""


def cjk_bigram_segment(text: str) -> str:
    """将连续中文切分为重叠二元词并保留原始词块，使 SQLite unicode61 FTS5 支持毫秒级中文子串 BM25 召回"""
    tokens: List[str] = []
    for chunk in re.findall(r"[\u4e00-\u9fa5]+|[a-zA-Z0-9]+", text or ""):
        if re.fullmatch(r"[\u4e00-\u9fa5]+", chunk):
            if len(chunk) <= 4:
                tokens.append(chunk)
            if len(chunk) > 2:
                tokens.extend(chunk[i : i + 2] for i in range(len(chunk) - 1))
        else:
            tokens.append(chunk.lower())
    return " ".join(tokens)


def init_db(db_path: Path) -> sqlite3.Connection:
    if db_path.exists():
        db_path.unlink()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.executescript(SCHEMA_SQL)
    return conn


def insert_questions(conn: sqlite3.Connection, records: Iterable[Dict[str, Any]], pack_name: str) -> int:
    count = 0
    cur = conn.cursor()
    for rec in records:
        qid = str(rec.get("qid") or "").strip()
        stem = str(rec.get("stem") or "").strip()
        if not stem and not rec.get("stem_images"):
            continue
        if not qid:
            qid = "q_" + hashlib.md5(f"{rec.get('source_exam','')}_{stem}".encode("utf-8")).hexdigest()[:12]

        raw_mod = str(rec.get("module_l1") or "判断推理").strip()
        module_l1 = MODULE_NORMALIZE_MAP.get(raw_mod, raw_mod)
        options = rec.get("options") or []
        options_text = " ".join(f"{o.get('key','')}.{o.get('text','')}" for o in options)

        category_l2, mother_type_l3 = infer_taxonomy(
            module_l1,
            stem,
            options_text,
            str(rec.get("category_l2") or ""),
            str(rec.get("mother_type_l3") or ""),
        )
        anchor_keywords = str(rec.get("anchor_keywords") or "").strip()
        if not anchor_keywords:
            anchor_keywords = extract_anchor_keywords(module_l1, category_l2, mother_type_l3, stem, options)

        year = int(rec.get("year") or 2025)
        province = str(rec.get("province") or "国考")
        source_exam = str(rec.get("source_exam") or f"{year}年{province}《行测》真题")

        cur.execute(
            """
            INSERT OR REPLACE INTO real_questions (
                qid, source_exam, year, province,
                module_l1, category_l2, mother_type_l3,
                material_id, material_text, material_images_json,
                stem, stem_images_json, options_json,
                answer, official_analysis, fast_tips, anchor_keywords
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                qid,
                source_exam,
                year,
                province,
                module_l1,
                category_l2,
                mother_type_l3,
                rec.get("material_id"),
                rec.get("material_text"),
                json.dumps(rec.get("material_images") or [], ensure_ascii=False),
                stem,
                json.dumps(rec.get("stem_images") or [], ensure_ascii=False),
                json.dumps(options, ensure_ascii=False),
                str(rec.get("answer") or "").strip().upper(),
                str(rec.get("official_analysis") or "").strip(),
                str(rec.get("fast_tips") or "").strip(),
                anchor_keywords,
            ),
        )
        seg_body = f"{anchor_keywords} {mother_type_l3} {cjk_bigram_segment(stem[:200])} {cjk_bigram_segment(anchor_keywords)}"
        cur.execute(
            """
            INSERT INTO real_questions_fts (qid, seg_body)
            VALUES (?, ?)
            """,
            (qid, seg_body),
        )
        count += 1
        if count % 2000 == 0:
            conn.commit()
            print(f"  已处理 {count} 道真题...")

    cur.executemany(
        "INSERT OR REPLACE INTO pack_meta (key, value) VALUES (?, ?)",
        [
            ("pack_name", pack_name),
            ("question_count", str(count)),
            ("schema_version", "1.0"),
        ],
    )
    conn.commit()
    return count


# ============================================================================
# 3. 多数据源适配器：JSON / ERRRC-xingcezhenti / GongkaoNaoku
# ============================================================================

def load_from_json(json_path: Path) -> Iterable[Dict[str, Any]]:
    text = json_path.read_text(encoding="utf-8")
    if json_path.suffix.lower() == ".jsonl":
        for line in text.splitlines():
            line = line.strip()
            if line:
                yield json.loads(line)
    else:
        data = json.loads(text)
        items = data.get("questions", data) if isinstance(data, dict) else data
        for item in items:
            yield item


IMG_MD_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
YEAR_RE = re.compile(r"(20[12]\d)")
OPTION_LINE_RE = re.compile(r"^\s*[-*]?\s*([A-D])[.、．:：\s]\s*(.+)$")
ANSWER_RE = re.compile(r"(?:正确答案|参考答案|【答案】|答案)\s*[：:]\s*([A-D]+)")
QID_RE = re.compile(r"(?:qid|题号|ID)\s*[：:=]\s*([A-Za-z0-9_-]+)", re.IGNORECASE)


def parse_xingcezhenti_vault(vault_dir: Path) -> Iterable[Dict[str, Any]]:
    """解析 ERRRC/xingcezhenti 的六大模块 Markdown 笔记目录"""
    module_dirs = [
        d for d in sorted(vault_dir.iterdir())
        if d.is_dir() and any(d.name.startswith(prefix) for prefix in ("01", "02", "03", "04", "05", "06"))
    ]
    for mod_dir in module_dirs:
        module_l1 = MODULE_NORMALIZE_MAP.get(mod_dir.name, mod_dir.name)
        for md_file in sorted(mod_dir.rglob("*.md")):
            exam_title = md_file.stem
            yr_match = YEAR_RE.search(exam_title)
            year = int(yr_match.group(1)) if yr_match else 2024
            province = "国考" if "国考" in exam_title or "国家" in exam_title else exam_title[:2]

            content = md_file.read_text(encoding="utf-8", errors="ignore")
            blocks = re.split(r"\n(?=##+\s*\d+|(?:\*\*|【)?第?\s*\d+\s*题)", content)
            for idx, block in enumerate(blocks):
                if len(block.strip()) < 20:
                    continue
                ans_m = ANSWER_RE.search(block)
                if not ans_m:
                    continue
                answer = ans_m.group(1).strip()
                qid_m = QID_RE.search(block)
                qid = qid_m.group(1) if qid_m else f"xz_{hashlib.md5(f'{exam_title}_{idx}'.encode()).hexdigest()[:10]}"

                lines = block.strip().splitlines()
                stem_lines: List[str] = []
                options: List[Dict[str, Any]] = []
                analysis_lines: List[str] = []
                in_analysis = False

                for line in lines:
                    if ANSWER_RE.search(line) or "【解析】" in line or line.strip().startswith("解析："):
                        in_analysis = True
                    if in_analysis:
                        analysis_lines.append(line)
                        continue
                    opt_m = OPTION_LINE_RE.match(line)
                    if opt_m:
                        opt_imgs = IMG_MD_RE.findall(opt_m.group(2))
                        clean_opt_txt = IMG_MD_RE.sub("", opt_m.group(2)).strip()
                        options.append({
                            "key": opt_m.group(1),
                            "text": clean_opt_txt,
                            "image": opt_imgs[0] if opt_imgs else None,
                        })
                    else:
                        stem_lines.append(line)

                raw_stem = "\n".join(stem_lines).strip()
                stem_imgs = IMG_MD_RE.findall(raw_stem)
                clean_stem = re.sub(r"^##+\s*", "", IMG_MD_RE.sub("", raw_stem)).strip()

                yield {
                    "qid": qid,
                    "source_exam": exam_title,
                    "year": year,
                    "province": province,
                    "module_l1": module_l1,
                    "stem": clean_stem,
                    "stem_images": stem_imgs,
                    "options": options,
                    "answer": answer,
                    "official_analysis": "\n".join(analysis_lines).strip(),
                }


def parse_naoku_sqlite(naoku_db_path: Path) -> Iterable[Dict[str, Any]]:
    """解析 GongkaoNaoku 的 kaogong.db 数据表"""
    src_conn = sqlite3.connect(str(naoku_db_path))
    src_conn.row_factory = sqlite3.Row
    tables = [r[0] for r in src_conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    target_table = "questions" if "questions" in tables else tables[0]

    for row in src_conn.execute(f"SELECT * FROM {target_table}"):
        d = dict(row)
        qid = str(d.get("qid") or d.get("id") or "")
        stem = str(d.get("stem") or d.get("content") or d.get("question") or "")
        raw_opts = d.get("options") or d.get("options_json") or "[]"
        if isinstance(raw_opts, str):
            try:
                parsed_opts = json.loads(raw_opts)
            except Exception:
                parsed_opts = []
        else:
            parsed_opts = raw_opts

        norm_opts: List[Dict[str, Any]] = []
        if isinstance(parsed_opts, dict):
            for k, v in sorted(parsed_opts.items()):
                norm_opts.append({"key": str(k).upper(), "text": str(v), "image": None})
        elif isinstance(parsed_opts, list):
            for idx, item in enumerate(parsed_opts):
                if isinstance(item, dict):
                    norm_opts.append({
                        "key": str(item.get("key") or chr(65 + idx)),
                        "text": str(item.get("text") or item.get("content") or ""),
                        "image": item.get("image"),
                    })
                else:
                    norm_opts.append({"key": chr(65 + idx), "text": str(item), "image": None})

        yield {
            "qid": qid,
            "source_exam": str(d.get("source") or d.get("paper_name") or "历年公考行测真题"),
            "year": int(d.get("year") or 2024),
            "province": str(d.get("province") or "国考"),
            "module_l1": str(d.get("module") or d.get("category") or "判断推理"),
            "category_l2": str(d.get("sub_category") or ""),
            "mother_type_l3": str(d.get("mother_type") or d.get("question_model") or ""),
            "material_text": d.get("material"),
            "stem": stem,
            "options": norm_opts,
            "answer": str(d.get("answer") or ""),
            "official_analysis": str(d.get("analysis") or d.get("explanation") or ""),
            "fast_tips": str(d.get("fast_method") or d.get("pitfalls") or ""),
        }
    src_conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="构建 AI 考公错题本离线真题 SQLite 数据包")
    parser.add_argument("--mode", choices=["json", "xingcezhenti", "naoku"], required=True, help="输入数据源类型")
    parser.add_argument("--input", required=True, help="输入文件或仓库目录路径")
    parser.add_argument("--output", required=True, help="输出的 SQLite 数据库路径 (.db)")
    parser.add_argument("--pack-name", default="公考行测离线真题库", help="数据包显示名称")
    parser.add_argument("--pack-zip", default="", help="可选：同时打包配图输出为单个 .zip 导入包路径")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_db = Path(args.output).expanduser().resolve()

    if not input_path.exists():
        raise SystemExit(f"输入路径不存在: {input_path}")

    print(f"[1/3] 初始化离线数据库: {output_db}")
    conn = init_db(output_db)

    print(f"[2/3] 解析数据源 ({args.mode}): {input_path}")
    if args.mode == "json":
        records = load_from_json(input_path)
    elif args.mode == "xingcezhenti":
        records = parse_xingcezhenti_vault(input_path)
    else:
        records = parse_naoku_sqlite(input_path)

    total = insert_questions(conn, records, args.pack_name)
    conn.execute("PRAGMA optimize;")
    conn.close()
    print(f"[3/3] 构建完成！共写入 {total} 道结构化行测真题 -> {output_db}")

    if args.pack_zip:
        zip_path = Path(args.pack_zip).expanduser().resolve()
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(str(zip_path), "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.write(str(output_db), arcname="question_bank.db")
            if args.mode == "xingcezhenti":
                img_dir = input_path / "90-图片"
                if img_dir.exists():
                    print("  正在打包 90-图片 目录至离线包...")
                    for img_file in img_dir.rglob("*"):
                        if img_file.is_file():
                            rel = img_file.relative_to(input_path)
                            zf.write(str(img_file), arcname=f"images/{rel}")
        print(f"已生成一体式手机导入包: {zip_path}")


if __name__ == "__main__":
    main()
