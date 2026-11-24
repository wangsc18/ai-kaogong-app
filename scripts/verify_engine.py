#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端核心检索、原题碰撞与推荐逻辑自动化验收脚本"""

import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "scripts" / "dist" / "seed_question_bank.db"


def main() -> None:
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "build_question_pack.py"),
            "--mode",
            "json",
            "--input",
            str(ROOT / "scripts" / "seed_questions.json"),
            "--output",
            str(DB_PATH),
        ],
        check=True,
    )

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    # 1. 验证六大模块全覆盖
    mods = {
        r["module_l1"]: r["c"]
        for r in conn.execute(
            "SELECT module_l1, COUNT(*) as c FROM real_questions GROUP BY module_l1"
        ).fetchall()
    }
    print("[Check 1] 六大模块分布:", mods)
    assert set(mods.keys()) == {
        "政治理论",
        "常识判断",
        "言语理解",
        "数量关系",
        "判断推理",
        "资料分析",
    }

    # 2. 验证高频成语锚点 FTS5 召回（相得益彰）
    chengyu_rows = conn.execute(
        """
        SELECT rq.qid, rq.source_exam, rq.anchor_keywords
        FROM real_questions_fts fts
        JOIN real_questions rq ON rq.qid = fts.qid
        WHERE real_questions_fts MATCH '"相得益彰"'
        ORDER BY rank
        """
    ).fetchall()
    print("[Check 2] 成语「相得益彰」召回真题:", [r["qid"] for r in chengyu_rows])
    assert len(chengyu_rows) >= 2

    # 3. 验证带残缺/错字的 OCR 题干在中文二元词 FTS5 中的高速碰撞命中
    ocr_fts_query = '"网上" OR "零售" OR "社会" OR "消费" OR "比重" OR "上年"'
    ocr_rows = conn.execute(
        """
        SELECT rq.qid, rq.answer, rq.mother_type_l3
        FROM real_questions_fts fts
        JOIN real_questions rq ON rq.qid = fts.qid
        WHERE real_questions_fts MATCH ?
        ORDER BY rank LIMIT 3
        """,
        (ocr_fts_query,),
    ).fetchall()
    print(
        "[Check 3] 模拟实拍 OCR 题干碰撞 Top 3:",
        [(r["qid"], r["answer"], r["mother_type_l3"]) for r in ocr_rows],
    )
    assert ocr_rows[0]["qid"] == "seed_zl_001"

    # 4. 验证同三级母题精确召回（因果倒置削弱 / 混合增长率 / 工程问题）
    for mod, l3 in [
        ("资料分析", "混合增长率(盐水法)"),
        ("判断推理", "削弱论证(拆桥/因果倒置/他因)"),
        ("数量关系", "工程问题(特值赋值法)"),
        ("政治理论", "进一步全面深化改革与中国式现代化"),
    ]:
        rows = conn.execute(
            "SELECT qid FROM real_questions WHERE module_l1 = ? AND mother_type_l3 = ?",
            (mod, l3),
        ).fetchall()
        print(f"[Check 4] 母题「{mod} > {l3}」召回数: {len(rows)} -> {[r['qid'] for r in rows]}")
        assert len(rows) >= 2

    conn.close()
    print("\n✅ 全部核心引擎验收测试通过！")


if __name__ == "__main__":
    main()
