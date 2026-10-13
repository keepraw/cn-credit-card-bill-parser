# Keepraw-Ledger

**本地优先的中国信用卡账单解析、核验与归档工具。** 将不同银行的账单整理为结构化交易，帮助你核对账单、检索消费记录，并保留必要的原始凭证。

*A privacy-first, browser-based ledger for parsing, reconciling, reviewing and archiving Chinese credit-card statements. An independent Python CLI is also included.*

- **Web 应用：** React + TypeScript + Vite，使用浏览器 IndexedDB 保存数据，无需账户或项目后端。
- **Python 工具：** 在本机批量解析账单，将结果写入 SQLite 和 Excel；与 Web 端是**两条独立的数据处理路径**，不会自动同步。
- **项目网站：** [ledger.keepraw.com](https://ledger.keepraw.com/)（仓库登记的项目主页）。
- **项目阶段：** 持续开发中的个人工具。解析结果应与银行原始账单核对，不可替代正式账务凭证。

## 功能

Web 端提供消费总览、账单导入、交易检索与 CSV/XLSX 导出、自动账单核验、数据质量检查、人工复核、历史数据导入，以及 JSON / ZIP 备份恢复。金额以**最小货币单位的整数**参与计算；无法识别的文件会明确提示，而不会交给不受约束的通用解析器冒充成功结果。

| 银行 | Web 端支持的账单 |
| --- | --- |
| 中国银行（BOC） | 可提取文字的 PDF 账单 |
| 工商银行（ICBC） | HTML 邮件账单 `.eml` |
| 农业银行（ABC） | HTML 邮件账单 `.eml` |
| 建设银行（CCB） | HTML 邮件账单 `.eml` |
| 交通银行（BOCOM） | HTML 邮件账单 `.eml` |
| 中信银行（CITIC） | HTML 邮件账单 `.eml` |

**注意：** 支持的是已经适配的账单模板，而非上述银行的全部历史格式。图片扫描版 PDF 目前不具备 Web 端 OCR 流程；无法正确解析的文件应保留原件并人工核对。历史 XLSX 导入仅支持已实现适配器的旧版导出格式，不代表支持任意 Excel 表格。

## 快速开始：浏览器应用

1. 访问 [项目网站](https://ledger.keepraw.com/)，或者按下文在本机启动 Web 应用。
2. 首次打开可先使用**演示模式**体验界面。演示数据仅存在于应用内存中，不会写入真实账单数据库。
3. 到「**数据与设置**」关闭演示模式，再进入「**账单导入**」，选择或拖入支持的 `.pdf` / `.eml` 文件。
4. 在「**账单核验**」「**数据质量**」「**人工复核**」查看金额差异、缺失字段和可疑交易，确认无误后再使用统计结果。
5. 定期到「**数据与设置**」导出备份，并在浏览器之外保存副本。

### 本地开发

建议使用 **Node.js 22** 和 npm。命令在项目根目录执行：

```bash
git clone https://github.com/keepraw/keepraw-ledger.git
cd keepraw-ledger/web
npm ci
npm run dev
```

Vite 会显示本地访问地址，通常为 `http://localhost:5173/`。应用是静态前端，开发启动不需要数据库服务器、API Key 或云端账户。

在 `web/` 目录下执行：

```bash
npm run typecheck            # TypeScript 检查
npm run lint                 # ESLint
npm test                     # Vitest 单元/集成测试
npm run build                # 正式构建
npm run verify               # 上述四项依次执行
npx playwright install chromium
npm run test:e2e             # Playwright 浏览器测试
```

GitHub Actions 的 `.github/workflows/web-pages.yml` 在符合触发条件的主分支 Web 代码变更后执行类型检查、Lint、Vitest 和构建，然后部署 GitHub Pages。**Playwright E2E 和 Python pytest 目前不在该工作流中**，需要单独运行。若在非自定义域名的 GitHub Pages 项目路径部署，可通过 `VITE_BASE_PATH` 设置构建资源路径。

## 数据存储、备份与隐私

- Web 数据保存在**当前浏览器、当前站点来源（origin）**的 IndexedDB 中。浏览器扩展、同一浏览器配置文件及本机访问控制仍需由使用者自行管理。不同浏览器、设备、`localhost` 和正式域名之间**不会自动同步**。
- 账单解析在浏览器执行，项目没有专门用于接收账单的后端；但**打开在线网站仍需要下载静态页面和脚本**。不要把“本地解析”理解为从不使用网络或端到端加密。
- **JSON 数据备份**保存账单、交易、导入元数据及设置，**不含原始 PDF/EML 附件**；**完整 ZIP 备份**还尝试保存浏览器可访问的原始账单，并在清单中标注缺失附件。
- 当前备份格式**不包含单独保存的人工复核备注（review notes）**。两类备份均**没有内置加密**，请视为敏感金融文件，妥善保管。恢复操作按主键写入，同一主键的已有记录可能被备份覆盖。
- 清理浏览器站点数据、无痕窗口关闭或浏览器存储配额回收都可能导致数据丢失。建议定期备份，并保留银行原始文件的独立副本。
- **当前版本限制：**「清空真实数据」尚未同步清除所有已保存的原始附件和复核备注。如果目的是彻底移除本地敏感数据，请先备份，再使用「清空全部数据」或清理该站点的浏览器存储。后续版本需要统一数据删除逻辑。

请不要把真实账单、未脱敏日志、本地数据库或导出文件提交到公开 GitHub 仓库。`.gitignore` 已默认忽略常见账单和运行数据，但提交前仍应执行 `git status --short` 人工确认。

## 独立的 Python 命令行工具

仓库还包含 Python 3.10+ 的批量处理流程，适合希望在个人电脑上以**文件夹 → SQLite → Excel**的方式管理账单的用户。Python 端与 Web 端分别实现解析器，支持情况和行为可能不同；不能假定两者输出完全一致。

从仓库根目录安装：

```bash
python -m venv .venv
# macOS / Linux:
source .venv/bin/activate
# Windows PowerShell:
# .\.venv\Scripts\Activate.ps1

python -m pip install -r requirements.txt
```

将待解析账单放到 `inbox/`。Windows PowerShell 使用：

```powershell
.\run_parser.ps1
```

macOS / Linux 使用：

```bash
PYTHONPATH=src python -m ccparser.cli
```

程序会在 `output/` 生成 `unified_transactions.xlsx` 和 `review.xlsx`；成功处理的原件移入 `processed/`，需要复核的文件移入 `review_files/`，运行数据保存在 `data/`。Python 端还提供基础文本/HTML 处理、旧版 XLSX 导入和可选的本地 OCR 依赖；具体能力取决于文件内容及解析器。

维护和排查命令：

```bash
PYTHONPATH=src python -m ccparser.cli --profile  # 只识别格式，不导入交易
PYTHONPATH=src python -m ccparser.cli --debug    # 写入详细本地日志
python -m pytest -q                             # Python 测试
```

生产文件应先备份，再用脱敏样例验证新解析器。Python 工具的历史安全设计、格式研究和回归测试可查阅 `docs/eml-analysis.md`、`tests/` 与 `golden/README.md`。

## 项目结构

```text
web/                   # Web 应用：React + TypeScript + IndexedDB
  src/parsers/          # 各银行 Web 解析器
  src/core/             # 金额、交易身份、去重、核验等业务逻辑
  src/db/               # Dexie / IndexedDB 数据访问
  src/importers/        # 历史 XLSX 适配器
  src/backup/           # JSON 与完整 ZIP 归档
  src/ui/               # 页面、导航与组件
  tests/                # Vitest 测试
  e2e/                  # Playwright 测试
src/ccparser/           # 独立 Python 账单解析器
scripts/                # 黄金样例、迁移核查等维护工具
tests/                  # Python pytest
golden/                 # 六家银行的脱敏跨端对比基准
docs/                   # 技术分析文档
inbox/ output/ data/    # Python 运行时数据目录（内容不入库）
.github/workflows/      # Web CI 与 Pages 部署
```

## 验证与已知限制

项目已具备明确的银行解析器注册、脱敏固定样例、跨端 Golden 对比、前端单元/集成测试、浏览器 E2E 测试和数据迁移审计工具，但并不意味着所有银行模板和边界情况都完成验证。当前仍需重点加强：跨来源重复交易识别、真实数据删除与原始附件的生命周期一致性、批量导入异常路径、备份内容完整性与数据结构校验、第三方 XLSX 依赖安全、Python 端 CI 以及大数据量性能回归。

如需修改解析器，请同时更新对应的脱敏样例和回归测试，并确认**交易数量、正负方向、币种、账期、差额及复核状态**没有意外变化。不要拿真实个人账单直接制作公开测试夹具。

## 许可证

仓库目前未提供明确的 `LICENSE` 文件。源代码公开可见并不等于自动授予复制、修改或再分发许可；如计划接受外部贡献或授权第三方使用，建议补充许可证。
