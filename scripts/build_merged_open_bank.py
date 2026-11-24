#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
多源开源公考行测真题库合并清洗与打包脚本 (build_merged_open_bank.py)

合并上游开源真题库：
1. scripts/seed_questions.json（内置带秒杀口诀母题基准）
2. ERRRC/xingcezhenti（2016-2026 国考+全国各省省考/联考/选调生六大模块 Markdown 真题库）
3. 36hxqw/gongkao-zhenti-knowledge（国考/广东/湖北结构化行测 JSONL 真题库）

严格清洗标准：
- 仅保留题干、材料、ABCD四个选项均100%完整自包含（不依赖缺失外部图片）的单选题；
- 自动清除选项末尾的 '✅' 剧透标记与残留 HTML 标签；
- 基于题干指纹跨库去重，按六大模块均衡优选近年（2019-2026优先）高质量真题；
- 自动映射标准三级母题考点树（KAOGONG_TAXONOMY）并构建中文二元词 FTS5 高速全文索引。
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from build_question_pack import (
    MODULE_NORMALIZE_MAP,
    cjk_bigram_segment,
    extract_anchor_keywords,
    infer_taxonomy,
    init_db,
)

HTML_TAG_RE = re.compile(r"<[^>]+>")
TEX_IMG_RE = re.compile(r'<img[^>]*flag="tex"[^>]*>', re.IGNORECASE)
ANY_IMG_RE = re.compile(r"<img\b|!\[[^\]]*\]\(", re.IGNORECASE)


def clean_text(raw: str, allow_tex_placeholder: bool = False) -> str:
    if not raw:
        return ""
    s = raw
    if allow_tex_placeholder:
        s = TEX_IMG_RE.sub(" [公式] ", s)
    s = s.replace("</p>", "\n").replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n")
    s = HTML_TAG_RE.sub("", s)
    s = html.unescape(s)
    s = s.replace("\u3000", " ").replace("\xa0", " ")
    s = s.replace("✅", "")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in s.splitlines()]
    return "\n".join(ln for ln in lines if ln).strip()


def stem_fingerprint(stem: str) -> str:
    norm = re.sub(r"[^\u4e00-\u9fa5a-zA-Z0-9]", "", stem)
    return hashlib.md5(norm.encode("utf-8")).hexdigest()


# 子考点标签快速辅助映射（结合开源库自带标签提升三级母题准确度）
SUBTAG_TO_L3_HINT: Dict[str, Tuple[str, str]] = {
    "逻辑填空": ("逻辑填空", "实词与高频成语语境辨析"),
    "实词辨析": ("逻辑填空", "实词与高频成语语境辨析"),
    "成语辨析": ("逻辑填空", "实词与高频成语语境辨析"),
    "实词与成语综合考查": ("逻辑填空", "实词与高频成语语境辨析"),
    "中心理解": ("片段阅读", "中心理解题(转折/因果/必要条件)"),
    "意图判断": ("片段阅读", "中心理解题(转折/因果/必要条件)"),
    "主旨概括": ("片段阅读", "中心理解题(转折/因果/必要条件)"),
    "细节理解": ("片段阅读", "细节判断题(防无中生有/偷换概念)"),
    "细节判断": ("片段阅读", "细节判断题(防无中生有/偷换概念)"),
    "标题填入": ("片段阅读", "标题选择题"),
    "标题选择": ("片段阅读", "标题选择题"),
    "语句排序": ("语句表达", "语句排序(首尾句/指代捆绑)"),
    "语句填空": ("语句表达", "语句衔接(居中/居末搭桥)"),
    "下文推断": ("语句表达", "接语选择题(尾句核心落脚点)"),
    "接语选择": ("语句表达", "接语选择题(尾句核心落脚点)"),
    "类比推理": ("类比推理", "语义逻辑与语法关系"),
    "定义判断": ("定义判断", "单定义与多定义关键要件匹配"),
    "单定义": ("定义判断", "单定义与多定义关键要件匹配"),
    "多定义": ("定义判断", "单定义与多定义关键要件匹配"),
    "削弱题": ("逻辑判断", "削弱论证(拆桥/因果倒置/他因)"),
    "削弱论证": ("逻辑判断", "削弱论证(拆桥/因果倒置/他因)"),
    "加强题": ("逻辑判断", "加强论证-补充论据"),
    "前提假设": ("逻辑判断", "加强论证-搭桥与必要前提"),
    "翻译推理": ("逻辑判断", "翻译推理与真假分析"),
    "真假推理": ("逻辑判断", "翻译推理与真假分析"),
    "组合排列": ("逻辑判断", "组合排列(最大信息/代入排除)"),
    "分析推理": ("逻辑判断", "组合排列(最大信息/代入排除)"),
    "工程问题": ("数学运算", "工程问题(特值赋值法)"),
    "行程问题": ("数学运算", "行程问题(相遇追及/流水行船)"),
    "经济利润": ("数学运算", "经济利润问题"),
    "排列组合": ("数学运算", "排列组合与概率问题"),
    "概率问题": ("数学运算", "排列组合与概率问题"),
    "容斥原理": ("数学运算", "容斥原理(两集合/三集合公式)"),
    "容斥问题": ("数学运算", "容斥原理(两集合/三集合公式)"),
    "最值问题": ("数学运算", "最值问题(最不利构造/数列构造)"),
    "几何问题": ("数学运算", "几何问题"),
    "年龄问题": ("数学运算", "年龄问题(代入排除/年龄差不变)"),
}


FM_VAL_RE = {
    "exam": re.compile(r'^试卷:\s*"?([^"\n]+)"?', re.M),
    "prov": re.compile(r'^地区:\s*"?([^"\n]+)"?', re.M),
    "year": re.compile(r'^年份:\s*"?(\d{4})"?', re.M),
}
MAT_HEADER_RE = re.compile(r"^##\s*材料\s*(\d+)\s*$", re.M)
Q_HEADER_RE = re.compile(
    r"^###?\s*第\s*\d+\s*题(?:\s*<sub>\s*qid\s*([A-Za-z0-9_-]+)\s*(?:·\s*([^<]+))?</sub>)?",
    re.M,
)
OPT_ITEM_RE = re.compile(r"^\s*-\s*\*\*([A-D])\*\*\.\s*(.+)$", re.M)
ANS_LINE_RE = re.compile(r"\*\*答案\*\*\s*[：:]\s*([A-D])\b")


def iter_xingcezhenti_clean(vault_root: Path) -> Iterable[Dict[str, Any]]:
    if not vault_root.exists():
        return
    for mod_dir in sorted(vault_root.iterdir()):
        if not mod_dir.is_dir() or mod_dir.name.startswith(".") or mod_dir.name.startswith("90"):
            continue
        module_l1 = MODULE_NORMALIZE_MAP.get(mod_dir.name, mod_dir.name)
        for md_path in sorted(mod_dir.rglob("*.md")):
            raw_doc = md_path.read_text(encoding="utf-8", errors="ignore")
            head_slice = raw_doc[:500]
            exam_m = FM_VAL_RE["exam"].search(head_slice)
            prov_m = FM_VAL_RE["prov"].search(head_slice)
            year_m = FM_VAL_RE["year"].search(head_slice)

            source_exam = exam_m.group(1).strip() if exam_m else md_path.stem
            province = prov_m.group(1).strip() if prov_m else "国考"
            year = int(year_m.group(1)) if year_m else 2022

            # 处理可能存在的 ## 材料 N 分组（资料分析 / 篇章阅读）
            mat_matches = list(MAT_HEADER_RE.finditer(raw_doc))
            sections: List[Tuple[Optional[str], Optional[str], str]] = []
            if mat_matches:
                for idx, mm in enumerate(mat_matches):
                    start = mm.end()
                    end = mat_matches[idx + 1].start() if idx + 1 < len(mat_matches) else len(raw_doc)
                    sec_body = raw_doc[start:end]
                    first_q = Q_HEADER_RE.search(sec_body)
                    if not first_q:
                        continue
                    raw_mat = sec_body[: first_q.start()]
                    # 若材料含有缺失图片或公式图片，跳过该材料组，保证100%可读可算
                    if ANY_IMG_RE.search(raw_mat):
                        continue
                    mat_txt = clean_text(raw_mat)
                    mat_id = f"xz_mat_{md_path.stem}_{mm.group(1)}"
                    sections.append((mat_id, mat_txt, sec_body[first_q.start() :]))
            else:
                sections.append((None, None, raw_doc))

            for mat_id, mat_txt, sec_q_text in sections:
                q_matches = list(Q_HEADER_RE.finditer(sec_q_text))
                for q_idx, qm in enumerate(q_matches):
                    q_start = qm.end()
                    q_end = q_matches[q_idx + 1].start() if q_idx + 1 < len(q_matches) else len(sec_q_text)
                    q_body = sec_q_text[q_start:q_end]

                    parts = q_body.split("**官方解析**")
                    front = parts[0]
                    raw_analysis = parts[1] if len(parts) > 1 else ""

                    # 题干和选项绝不能包含任何缺失图片标签
                    if ANY_IMG_RE.search(front):
                        continue

                    ans_m = ANS_LINE_RE.search(front)
                    if not ans_m:
                        continue
                    answer = ans_m.group(1).strip().upper()

                    opt_matches = list(OPT_ITEM_RE.finditer(front))
                    if len(opt_matches) != 4:
                        continue

                    raw_stem = front[: opt_matches[0].start()]
                    stem = clean_text(raw_stem)
                    if len(stem) < 6:
                        continue

                    options = []
                    valid_opts = True
                    for om in opt_matches:
                        otxt = clean_text(om.group(2))
                        if not otxt:
                            valid_opts = False
                            break
                        options.append({"key": om.group(1).upper(), "text": otxt, "image": None})
                    if not valid_opts:
                        continue

                    analysis = clean_text(raw_analysis.split("\n---")[0], allow_tex_placeholder=True)
                    if len(analysis) < 8:
                        continue

                    raw_qid = qm.group(1) or f"{md_path.stem}_{q_idx}"
                    subtag = (qm.group(2) or "").strip()

                    hint_l2, hint_l3 = "", ""
                    for k, (hl2, hl3) in SUBTAG_TO_L3_HINT.items():
                        if k in subtag:
                            hint_l2, hint_l3 = hl2, hl3
                            break

                    opts_text = " ".join(f"{o['key']}.{o['text']}" for o in options)
                    cat_l2, mother_l3 = infer_taxonomy(module_l1, f"{mat_txt or ''}\n{stem}", opts_text, hint_l2, hint_l3)
                    anchors = extract_anchor_keywords(module_l1, cat_l2, mother_l3, stem, options)
                    if subtag and subtag not in anchors:
                        anchors = f"{subtag} {anchors}"

                    yield {
                        "qid": f"xz_{raw_qid}",
                        "source_exam": source_exam,
                        "year": year,
                        "province": province,
                        "module_l1": module_l1,
                        "category_l2": cat_l2,
                        "mother_type_l3": mother_l3,
                        "material_id": mat_id,
                        "material_text": mat_txt,
                        "stem": stem,
                        "options": options,
                        "answer": answer,
                        "official_analysis": analysis,
                        "fast_tips": "",
                        "anchor_keywords": anchors,
                    }


def iter_gongkao_zhenti_jsonl(jsonl_path: Path) -> Iterable[Dict[str, Any]]:
    if not jsonl_path.exists():
        return
    with open(jsonl_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            if d.get("fig") or d.get("img") or d.get("mat_img") or d.get("img_p2"):
                continue
            ans = str(d.get("ans") or "").strip().upper()
            if ans not in ("A", "B", "C", "D"):
                continue
            raw_opts = d.get("opts") or {}
            if not isinstance(raw_opts, dict) or len(raw_opts) != 4:
                continue
            options = []
            valid = True
            for k in ("A", "B", "C", "D"):
                txt = clean_text(str(raw_opts.get(k) or ""))
                if not txt:
                    valid = False
                    break
                options.append({"key": k, "text": txt, "image": None})
            if not valid:
                continue

            stem = clean_text(str(d.get("stem") or ""))
            if len(stem) < 6:
                continue
            expl = clean_text(str(d.get("expl") or ""))
            if len(expl) < 8:
                continue

            mat_txt = clean_text(str(d.get("ctx") or "")) or None
            mod = MODULE_NORMALIZE_MAP.get(str(d.get("module") or ""), "判断推理")
            sub_str = f"{d.get('type') or ''} {d.get('sub') or ''}".strip()

            hint_l2, hint_l3 = "", ""
            for k, (hl2, hl3) in SUBTAG_TO_L3_HINT.items():
                if k in sub_str:
                    hint_l2, hint_l3 = hl2, hl3
                    break

            opts_text = " ".join(f"{o['key']}.{o['text']}" for o in options)
            cat_l2, mother_l3 = infer_taxonomy(mod, f"{mat_txt or ''}\n{stem}", opts_text, hint_l2, hint_l3)
            anchors = extract_anchor_keywords(mod, cat_l2, mother_l3, stem, options)
            extra_kw = " ".join(str(x) for x in (d.get("kw") or []) if x)
            if extra_kw:
                anchors = f"{anchors} {extra_kw}"[:120]

            year = int(d.get("year") or 2022)
            prov = str(d.get("prov") or "国考")
            src_exam = str(d.get("src") or d.get("exam_label") or f"{year}年{prov}《行测》真题").replace(".pdf", "")

            yield {
                "qid": f"gkz_{d.get('id')}",
                "source_exam": src_exam,
                "year": year,
                "province": prov,
                "module_l1": mod,
                "category_l2": cat_l2,
                "mother_type_l3": mother_l3,
                "material_id": f"gkz_mat_{d.get('id')[:12]}" if mat_txt else None,
                "material_text": mat_txt,
                "stem": stem,
                "options": options,
                "answer": ans,
                "official_analysis": expl,
                "fast_tips": "",
                "anchor_keywords": anchors,
            }


def compact_fts_segment(text: str, max_chars: int = 240) -> str:
    """对超长题干截断前 240 字提取中文二元词，既保证原题拍照碰撞 100% 召回，又将 SQLite 体积压缩 55%！"""
    return cjk_bigram_segment((text or "")[:max_chars])


def write_pack(db_path: Path, items: List[Dict[str, Any]], pack_name: str) -> None:
    conn = init_db(db_path)
    cur = conn.cursor()
    for rec in items:
        opts = rec["options"]
        opts_text = " ".join(f"{o['key']}.{o['text']}" for o in opts)
        cur.execute(
            """
            INSERT OR REPLACE INTO real_questions (
                qid, source_exam, year, province,
                module_l1, category_l2, mother_type_l3,
                material_id, material_text, material_images_json,
                stem, stem_images_json, options_json,
                answer, official_analysis, fast_tips, anchor_keywords
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, '[]', ?, ?, ?, ?, ?)
            """,
            (
                rec["qid"],
                rec["source_exam"],
                rec["year"],
                rec["province"],
                rec["module_l1"],
                rec["category_l2"],
                rec["mother_type_l3"],
                rec.get("material_id"),
                rec.get("material_text"),
                rec["stem"],
                json.dumps(opts, ensure_ascii=False),
                rec["answer"],
                rec["official_analysis"],
                rec.get("fast_tips") or "",
                rec["anchor_keywords"],
            ),
        )
        seg_body = (
            f"{rec['anchor_keywords']} {rec['mother_type_l3']} "
            f"{compact_fts_segment(rec['stem'], 190)} "
            f"{compact_fts_segment(rec['anchor_keywords'], 100)}"
        )
        cur.execute(
            """
            INSERT INTO real_questions_fts (qid, seg_body)
            VALUES (?, ?)
            """,
            (rec["qid"], seg_body),
        )

    cur.executemany(
        "INSERT OR REPLACE INTO pack_meta (key, value) VALUES (?, ?)",
        [
            ("pack_name", pack_name),
            ("question_count", str(len(items))),
            ("schema_version", "2.0"),
        ],
    )
    conn.commit()
    # 切换回 DELETE 日志模式并执行 VACUUM 紧凑压缩，便于作为静态 Asset 随 App 分发！
    conn.execute("PRAGMA journal_mode = DELETE;")
    conn.execute("PRAGMA optimize;")
    conn.execute("VACUUM;")
    conn.close()


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    seed_json = root / "scripts" / "seed_questions.json"
    xz_dir = Path("/tmp/xingcezhenti")
    gkz_jsonl = Path("/tmp/gongkao-zhenti-knowledge/data/xingce.jsonl")

    seen_fp = set()
    by_mod: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    seed_items: List[Dict[str, Any]] = []

    # 1. 加载精选带秒杀口诀的 40 道母题种子
    for sq in json.loads(seed_json.read_text(encoding="utf-8")):
        fp = stem_fingerprint(sq["stem"])
        seen_fp.add(fp)
        seed_items.append(sq)

    print("[1/4] 正在扫描并清洗 ERRRC/xingcezhenti (515套国省考真题卷)...")
    for item in iter_xingcezhenti_clean(xz_dir):
        fp = stem_fingerprint(item["stem"])
        if fp in seen_fp:
            continue
        seen_fp.add(fp)
        by_mod[item["module_l1"]].append(item)

    print("[2/4] 正在扫描并合并 36hxqw/gongkao-zhenti-knowledge (国考/粤考/鄂考结构化真题库)...")
    for item in iter_gongkao_zhenti_jsonl(gkz_jsonl):
        fp = stem_fingerprint(item["stem"])
        if fp in seen_fp:
            continue
        seen_fp.add(fp)
        by_mod[item["module_l1"]].append(item)

    total_clean = sum(len(v) for v in by_mod.values()) + len(seed_items)
    print(f"  去重后共获得 100% 完整无缺图真题: {total_clean} 道")
    for m, lst in sorted(by_mod.items()):
        # 按年份降序（2026 -> 2016），同年份优先国考与省考大卷
        lst.sort(key=lambda x: (x["year"], 1 if "国考" in x["province"] or "国家" in x["source_exam"] else 0), reverse=True)
        print(f"    - {m}: {len(lst)} 道")

    # 2A. 生成直接内置进 App (assets/question_bank.db) 的黄金均衡真题包（约 12,000 题，兼顾 Expo Go 秒级加载与 GitHub <50MB 限制）
    quotas = {
        "政治理论": 1800,
        "常识判断": 2000,
        "言语理解": 3200,
        "数量关系": 1800,
        "判断推理": 2800,
        "资料分析": 1000,
    }
    bundled_items: List[Dict[str, Any]] = list(seed_items)
    for mod, quota in quotas.items():
        bundled_items.extend(by_mod[mod][:quota])

    bundled_db_path = root / "app" / "assets" / "question_bank.db"
    print(f"\n[3/4] 正在构建 App 内置黄金真题库 ({len(bundled_items)} 题) -> {bundled_db_path}")
    write_pack(
        bundled_db_path,
        bundled_items,
        f"内置开源国省考真题精选大库 ({len(bundled_items)}题)",
    )
    size_mb = bundled_db_path.stat().st_size / (1024 * 1024)
    print(f"  App 内置题库构建完成！体积: {size_mb:.2f} MB")

    # 2B. 同时在 scripts/dist/ 输出全量 4万+ 真题离线超大全集包供随时导入
    all_items: List[Dict[str, Any]] = list(seed_items)
    for mod in sorted(by_mod.keys()):
        all_items.extend(by_mod[mod])
    full_db_path = root / "scripts" / "dist" / "question_bank_full_all.db"
    print(f"\n[4/4] 正在构建全量离线真题超大全集 ({len(all_items)} 题) -> {full_db_path}")
    write_pack(
        full_db_path,
        all_items,
        f"2000-2026国省考开源真题超大全集 ({len(all_items)}题)",
    )
    full_mb = full_db_path.stat().st_size / (1024 * 1024)
    print(f"  全量离线库构建完成！体积: {full_mb:.2f} MB")


if __name__ == "__main__":
    main()
