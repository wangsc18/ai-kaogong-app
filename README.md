# 公考朱批录 — 个人版 AI 考公错题复盘与同类真题推荐 App

专为个人备考公务员（国考 / 省考《行测》六大模块）打造的 **纯本地离线优先（Local-First）Android 应用**。无后端服务器依赖、无需商用备案审批，装上即可随时在图书馆、通勤路上拍照录错题、看实战秒杀拆解、当场刷透同类历年真题。

---

## 核心功能亮点

1. **📷 拍照 / 截图智能双轨还原**
   - 兼顾**纸质卷实拍（支持自由框选裁剪）**与**粉笔等刷题 App 截图导入**。
   - 支持**附带答案/解析图同传**（针对图形推理等视觉高难模块，让 AI 严格依据标准答案反向提炼破题特征，100% 杜绝算错误导）及**资料分析共享图表材料关联**。
   - **智能双轨还原**：识别文本自动在本地 SQLite FTS5 全文索引碰撞——若命中本地真题库，**自动替换为无手写笔迹的干净题干与标准答案**（同时保留实拍原图一键切换对照）；若为外部模考题则保存裁剪图与可交互选项。
2. **⚡ 内置公考实战秒杀方法卡（Method Cards）**
   - 吸收 GitHub 头部考公 AI Skill 精髓，按模块动态注入实战速解体系（如资料分析 **415 份数法 / 假设分配 / 盐水法 / 两期比重差**、判断推理**图推奇点数与对称细化 / 因果倒置 / 搭桥**、政治理论**细微偷换词高亮**），并在错题页内置多轮追问私教。
3. **🎯 「三级母题考点树 + 核心锚点词」双维同类真题推荐**
   - 录完错题底部即时弹出 3~5 道历年真题，支持一键切换 **「🔥 练同母题模型」**（固化公式/推理规则）与 **「🔍 追同成语 / 同考点词」**（一网打尽同一个高频易混成语或政策热词的历年考法），当场作答检验。
4. **📖 PDF 老师讲义 & 刷题集深度分析 · 动态进度与 AI 学伴协商**
   - 支持直接上传多份 `.pdf` 格式的**老师讲课讲义**与**配套刷题集**（兼顾电子文字版 PDF 与扫描图片版 PDF 自动识别）：
     - **分析 1（整体学习内容计划）**：自动梳理讲义与刷题集的配合路线，生成分阶段章节蓝图（精确关联页码、题号区间与三级母题考点）。
     - **分析 2（老师的讲题思路与做题风格）**：提炼讲义中老师的做题心法、标志性秒杀口诀与解题步骤，并支持**一键将该老师风格注入日常「拍错题」解析**中！
     - **分析 3（智能进度百分比测算与每日任务商量）**：结合当前阅读/刷题页码、章节打卡及 App 内真实错题轨迹，智能判定当前学到了哪一步（`0%~100%`）、还剩多少计划内容；内置对话窗口随时和 AI 学伴汇报进度、商量调整每天的任务量，**对话后页面进度条与每日任务卡片自动实时同步刷新**。
5. **⏱️ SM-2 遗忘曲线重刷 + 无答案刷题 PDF 导出 + 双库隔离备份**
   - 首页按 SM-2 算法推送「今日待复习错题」，支持遮挡答案计时重做。
   - 错题本支持批量勾选一键生成**「无答案纯净刷题卷（可选每道错题自动配 2 道同类真题）+ 末页答案秒杀速查」PDF**。
   - `question_bank.db`（只读真题底座，**已直接内置合并清洗自开源库的 11,176 道国省考无缺图真题开箱即用**，并在 `scripts/dist/question_bank_full_all.db` 预生成了 21,905 道超大全集包）与 `user_notebook.db`（个人错题及实拍图）物理分离，支持单文件全量备份与跨手机无损恢复。

---

## 快速上手指南

### 方式一：手机扫码秒级真机体验（日常调试推荐）

1. 在你的安卓手机上安装 **Expo Go**（可从应用商店或 GitHub Expo Releases 下载安装），确保手机与 Mac 连接同一 Wi-Fi。
2. 在终端启动开发服务器：
   ```bash
   cd app
   npx expo start
   ```
3. 用安卓手机上的 **Expo Go** 扫描终端出现的二维码即可直接在真机运行（若校园网/隔离网无法直连，可执行 `npx expo start --tunnel`）。
4. **免 Key 体验提示**：打开 App 点「拍错题」，即使暂未配置 AI API Key，也可直接点击页面内的 **「⚡ 体验：资料两期比重错题 / 言语易混成语错题」** 立即体验原题碰撞还原与同类真题双维推荐！

---

### 方式二：零本地环境配置，云端自动打包独立 `.apk` 安装包

本项目已配置好 GitHub Actions 自动编译流水线 [.github/workflows/build-android-apk.yml](.github/workflows/build-android-apk.yml)，Mac 本地无需安装庞大的 Android Studio：

1. 在 GitHub 创建一个**私有仓库（Private Repository）**，将本目录推送上去：
   ```bash
   git init
   git add .
   git commit -m "feat: initial personal ai kaogong app"
   git branch -M main
   git remote add origin <你的私有GitHub仓库地址>
   git push -u origin main
   ```
2. 打开 GitHub 仓库的 **Actions** 标签页，等待 `Build Personal Android APK` 工作流自动执行完成（或手动点击 `Run workflow`）。
3. 在构建详情页底部的 **Artifacts** 中下载 `ai-kaogong-android-apk`，解压即可得到独立运行的 `ai-kaogong-personal.apk` 发送到手机安装。

---

### 方式三：将开源 6 万道国省考行测真题导入手机离线库

App 默认内置了覆盖六大模块的 40 道高频母题种子库。若想解锁全量数万道历年国考/省考真题推荐底座：

1. 在电脑上克隆任一开源公考真题库（如 `ERRRC/xingcezhenti` 或 `jangviktor-web/GongkaoNaoku`）。
2. 运行项目自带的 Python 清洗构建脚本生成离线 SQLite 库（内置中文二元词 FTS5 高速索引与自动三级母题归类）：
   ```bash
   # 从 ERRRC/xingcezhenti 构建
   python3 scripts/build_question_pack.py \
     --mode xingcezhenti \
     --input /path/to/xingcezhenti \
     --output ./scripts/dist/question_bank_full.db \
     --pack-name "2016-2026国省考全量真题库"

   # 或从 GongkaoNaoku 的 kaogong.db 构建
   python3 scripts/build_question_pack.py \
     --mode naoku \
     --input /path/to/kaogong.db \
     --output ./scripts/dist/question_bank_full.db
   ```
3. 将生成的 `question_bank_full.db` 通过微信文件传输助手或数据线传到安卓手机，打开 App 进入 **「设置」→「导入离线 .db / .json 真题包」** 选中该文件即可一键热切换！

---

## 目录说明

- [docs/01-AI考公竞品与GitHub-Skill调研报告.md](docs/01-AI考公竞品与GitHub-Skill调研报告.md)：全网竞品分析与 GitHub 考公 AI Skill 拆解报告
- [docs/02-个人版AI考公错题复盘App架构与设计方案.md](docs/02-个人版AI考公错题复盘App架构与设计方案.md)：完整产品需求、数据库 Schema 与推荐算法设计文档
- `app/`：React Native (Expo + TypeScript) 移动端完整源码
- `scripts/build_question_pack.py`：开源真题库离线 SQLite 转换与母题自动标注工具
- `scripts/verify_engine.py`：数据库 FTS5 中文分词碰撞与同类推荐自动化验收脚本
