# cn-credit-card-bill-parser

中文名：中国信用卡账单本地解析器。

这是一个本地运行的 Python 工具，用来把中国信用卡账单整理成统一交易表格。

它的设计原则是：账单只在你的电脑上处理，不上传、不联网解析、不依赖云服务。

## 项目名和目录名

推荐仓库名和本地文件夹名使用：

```text
cn-credit-card-bill-parser
```

这个名字没有空格，适合 GitHub、Windows PowerShell、Debian/Ubuntu/macOS 终端和各种自动化脚本。Python 源码包名仍保留为 `ccparser`，这是程序内部模块名，不影响项目目录名。

## 支持内容

目前已适配或提供基础导入能力：

- 中国银行：文字型 PDF 账单
- 中信银行：邮件账单 `.eml`
- 交通银行：邮件账单 `.eml`
- 工商银行：邮件账单 `.eml`
- 建设银行：邮件账单 `.eml`
- 农业银行：邮件账单 `.eml`
- 历史统一账单：`.xlsx`
- 其他来源：`.html`、`.txt`、`.csv` 的基础文本提取和通用解析兜底

> OCR 不是默认流程。只有 PDF 无法直接提取文字时，才建议本地安装 Tesseract 或 easyocr 作为备选；不要使用任何需要上传文件的 OCR 服务处理真实账单。

## 目录说明

```text
.
├── inbox/          # 把待导入的账单放这里
├── output/         # 导出的 Excel 结果
├── processed/      # 成功处理后的原始文件
├── review_files/   # 处理失败或需要人工检查的原始文件
├── data/           # SQLite 数据库，本地去重和复核用
├── src/ccparser/   # 程序源码
├── tests/          # 基础测试
└── run_parser.ps1  # Windows PowerShell 运行脚本
```

## 安装环境

需要 Python 3.10 或更新版本。推荐 Python 3.12。

### Windows PowerShell

进入项目目录后执行：

```powershell
cd cn-credit-card-bill-parser
python --version
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

如果你的 Windows 使用 `py` 启动器，也可以这样创建虚拟环境：

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

如果 PowerShell 阻止激活脚本，可以只对当前命令绕过：

```powershell
powershell -ExecutionPolicy Bypass -File .\run_parser.ps1
```

### Debian / Ubuntu / macOS

进入项目目录后执行：

```bash
cd cn-credit-card-bill-parser
python3 --version
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Debian/Ubuntu 如果提示缺少 venv：

```bash
sudo apt update
sudo apt install python3-venv
```

## 如何导入账单

1. 把账单文件复制到 `inbox/`。
2. 运行解析器。
3. 到 `output/` 打开结果文件。

支持放入这些文件类型：

```text
.eml .pdf .html .txt .csv .xlsx
```

例如：

```text
inbox/中国银行信用卡账单2026年06月.pdf
inbox/中信银行信用卡电子账单.eml
inbox/交通银行个人信用卡2026年06月电子账单.eml
```

## 如何运行

### Windows PowerShell

推荐直接运行：

```powershell
.\run_parser.ps1
```

也可以手动运行：

```powershell
$env:PYTHONPATH = "src"
.\.venv\Scripts\python.exe -m ccparser.cli
```

### Debian / Ubuntu / macOS

```bash
PYTHONPATH=src .venv/bin/python -m ccparser.cli
```

## 安全运行和防破坏策略

真实账单、导出文件和本地数据库都按敏感数据处理。脚本更新后，尤其是修改解析、去重、导出或数据库逻辑时，不应直接拿正式数据做第一次验证。

当前运行流程已经加入这些保护：

1. 运行前备份：每次正式导入前，会把现有 `output/`、`processed/`、`review_files/` 和 `data/` 中的运行文件复制到 `backups/时间戳/`。如果当前没有旧文件可备份，命令行会提示没有可复制的运行文件。
2. 数据库事务：整次导入在一个数据库事务中执行；单个文件处理还有独立 savepoint。某个文件解析失败时，只回滚该文件已写入的数据库内容，并把它加入复核列表；如果最终导出失败，整次数据库写入会回滚。
3. 临时导出和校验：`unified_transactions.xlsx` 与 `review.xlsx` 会先写入 `output/` 下的临时 staging 目录，并用 `openpyxl` 检查工作表和必需表头。
4. 原子替换输出：只有临时 Excel 文件通过校验后，才替换正式 `output/` 文件。写入或校验失败时，旧输出文件不会被坏文件覆盖。
5. 成功后移动原始文件：原始账单不会在解析过程中立刻移走。只有数据库事务和 Excel 导出都成功后，文件才会移动到 `processed/` 或 `review_files/`。
6. 保持幂等：同一个账单或交易重复运行时，仍依靠文件指纹、账单键和交易 ID 去重，避免重复追加。

推荐的手工习惯仍然是：每次改代码后先运行测试，再用样本文件试跑；确认输出正常后，再把真实账单放入 `inbox/`。

如果发现脚本更新导致输出异常，应先停止继续导入，再从最近一次 `backups/时间戳/` 恢复对应目录中的文件。
## 日志和排错

脚本默认启用本地日志，默认日志级别是 `WARNING`。日志只写在本机，不上传、不联网。

每次运行会写两个日志文件：

```text
logs/parser.log              # 累积日志，方便长期追踪
logs/runs/YYYYMMDD-HHMMSS.log # 单次运行日志，方便定位本次问题
```

正常运行时，命令行会打印本次运行日志路径。发生异常时，控制台会提示日志位置，完整 traceback 会写入日志文件。

默认运行：

```powershell
.\run_parser.ps1
```

需要更详细排错时启用 DEBUG：

```powershell
$env:PYTHONPATH = "src"
.\.venv\Scripts\python.exe -m ccparser.cli --debug
```

也可以显式指定级别：

```powershell
$env:PYTHONPATH = "src"
.\.venv\Scripts\python.exe -m ccparser.cli --log-level INFO
```

日志会记录备份路径、处理到的文件名、解析器名称、数据库事务回滚、导出校验、文件移动和异常堆栈。日志不主动记录原始账单正文，但可能包含文件名、银行名、卡尾号、交易 ID、错误信息等本地敏感线索，因此 `logs/` 已加入 `.gitignore`，不要上传日志文件。
## 输出文件

运行后主要看 `output/`：

```text
output/unified_transactions.xlsx
output/review.xlsx
```

### `output/unified_transactions.xlsx`

正式交易表。

工作表说明：

- `交易明细`：日常查看用，字段更少、更干净，按交易日排序。
- `标准字段`：程序用完整字段，保留审计信息；账期、来源文件、文件指纹、原始文本默认隐藏。
- `导入摘要`：本次导出统计。

`交易明细` 默认显示：

```text
银行、卡尾号、交易日、入账日、说明、交易币种、交易金额、结算币种、结算金额
```

金额列是数字格式，可以直接求和、筛选、做透视表。

### `output/review.xlsx`

需要人工复核的项目，例如：

- 低置信度解析
- 疑似重复交易
- 多来源冲突
- 账单周期冲突
- 无法识别或解析失败的文件

## 处理后的原始文件在哪里

成功导入的原始文件会移动到 `processed/`，并改名为：

```text
银行_卡号后四位_年月.原扩展名
```

例如：

```text
processed/中国银行_6505_202606.pdf
processed/农业银行_0179_202606.eml
```

如果同名文件已经存在，程序会自动追加序号，避免覆盖。

处理失败或需要人工检查的原始文件会移动到 `review_files/`。

## 历史 XLSX 导入

历史表格如果已经整理成统一格式，可以放入 `inbox/` 一次性导入。

建议包含这些列：

```text
银行名称、卡号、交易日期、入账日期、交易详情、交易币种、交易金额、入账币种、入账金额
```

程序会把它当成历史来源导入，并尽量保留同一天、同商户、同金额的多笔真实交易，不会简单因为看起来相同就丢弃。

## 去重逻辑

程序有三层去重：

1. 文件级：同一个文件 SHA256 指纹已处理过，就跳过。
2. 账单级：用银行、卡号后四位、账期生成账单键。
3. 交易级：用银行、卡号、日期、金额、说明等生成交易 ID。

注意：同一天、同商户、同金额的多笔消费可能是真实多笔交易。程序会在同一账单内保留这些重复出现的交易，而不是机械删除。

## 审计与重构路线图

当前项目更接近一个个人本地半自动账单清洗工具：已经具备本地运行、事务回滚、运行备份、去重、复核表和原子导出等基础保护，但距离金融级可审计数据管道还需要继续补强 parser 准入、金额方向判定、导出安全、数据库迁移和数据血缘。

### 高优先级风险

| 编号 | 问题 | 涉及位置 | 风险等级 | 优先级 |
| --- | --- | --- | --- | --- |
| R1 | 通用 parser 可能把提示、广告、说明类文本误识别为正式交易 | `src/ccparser/parsers/generic.py`, `src/ccparser/pipeline.py` | 高 | 立即处理 |
| R2 | Excel 导出未统一转义公式型文本，存在公式注入风险 | `src/ccparser/exporters.py` | 高 | 立即处理 |
| R3 | 金额解析和金额方向判断耦合，描述关键字可能误翻转正负号 | `src/ccparser/normalizers.py`, 各银行 parser | 中高 | 立即处理 |
| R4 | PDF 坐标解析依赖固定行距和表头中心点，模板漂移时可能错列 | `src/ccparser/parsers/boc.py` | 中 | 第二阶段 |
| R5 | SQLite 缺少 schema version 和常用查询索引，大量历史账单下可维护性不足 | `src/ccparser/db.py` | 中 | 第一阶段 |
| R6 | 各银行 parser 依赖硬编码 section 标题，失败后回退 generic 的边界不够安全 | `src/ccparser/parsers/*.py` | 中 | 第二阶段 |
| R7 | parser 构造 `ParsedStatement`、warning、confidence 的样板代码重复 | `src/ccparser/parsers/*.py` | 低到中 | 第一阶段 |
| R8 | 交易血缘字段不足，缺少 parser version、页码、行号、原始片段范围 | `src/ccparser/models.py`, `src/ccparser/db.py` | 中 | 第三阶段 |

### Phase 1：低风险安全补丁

目标是尽快降低误解析和数据污染风险，改动保持小步、可回归验证。

1. 通用 parser 噪声过滤：增加提示、广告、积分、活动、手续费说明、客服提示等 blocklist。
2. 交易证据评分：日期、金额、卡号、币种、交易区 section、列数等共同决定置信度。
3. 低置信交易不进入正式交易表：进入 `review.xlsx`，由人工复核后再决定是否导入。
4. 金额方向解耦：新增 `parse_amount_raw()` 和 `resolve_amount_sign()`，优先使用结构化方向字段，其次 section、原始符号，最后才使用描述关键字。
5. Excel 公式注入防护：导出前转义以 `=`, `+`, `-`, `@` 开头的文本字段。
6. SQLite 常用索引：为交易日期、入账日期、银行、卡尾号、账单键建立索引。
7. parser 公共 build helper：集中处理 `missing_card_last4`、`missing_statement_period`、`no_transactions_found`、confidence 默认值等样板逻辑。

建议先落地的补丁形态：

```python
def escape_excel_formula(value):
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@"):
        return "'" + value
    return value


def should_insert_transaction(transaction):
    return transaction.confidence >= 0.7
```

金额方向建议接口：

```python
def parse_amount_raw(value):
    """只解析金额数值和原始符号，不读取商户描述。"""


def resolve_amount_sign(amount, *, direction_field="", section="", raw_text="", description=""):
    """按结构化方向字段、section、原始符号、描述关键字的优先级决定正负号。"""
```

建议索引：

```sql
CREATE INDEX IF NOT EXISTS idx_statements_period
ON statements(bank, card_last4, statement_start, statement_end);

CREATE INDEX IF NOT EXISTS idx_transactions_dates
ON transactions(transaction_date, posting_date);

CREATE INDEX IF NOT EXISTS idx_transactions_bank_card_date
ON transactions(bank, card_last4, transaction_date);
```

### TODO：未进行的改动

本轮已完成 Phase 1 中的通用 parser 噪声过滤、交易证据评分基础、低置信交易只进 review、Excel 公式注入防护、SQLite 常用索引，以及金额解析解耦的基础接口。以下事项尚未落地：

- 将各银行 parser 逐步迁移到 `parse_amount_raw()` + `resolve_amount_sign()`，减少描述关键字对金额方向的影响。
- 抽取 parser 公共 build helper，集中处理 `ParsedStatement`、warning、confidence 和缺失字段提示。
- 建立真正的 schema migration 执行机制；目前只创建了 `schema_migrations` 表和索引，尚未实现版本化迁移流程。
- 实现容错 section matcher，覆盖空格、全角半角、标点、英文标题和标题别名。
- 将 parser registry 改为 match score 机制，避免专属 parser 失败后无边界回退 generic。
- 改造中国银行 PDF 行聚类和列识别，支持页面比例、动态表头、列边界和长商户 continuation row。
- 建立每家银行的脱敏 fixture 测试集，覆盖标题变化、长商户换行、跨年账期和正负号方向。
- 增加 parser version、source page、line number、raw span 等数据血缘字段。
- 增强 review 工作流，区分低置信、疑似噪声、重复交易、金额方向不确定等复核原因。
- 做 10 万级交易导入、查询、导出和 `EXPLAIN QUERY PLAN` 性能验证。
### Phase 2：结构化重构

目标是提高 parser 长期维护性，减少格式漂移导致的静默错误。

1. section matcher 容错化：统一处理空格、全角半角、标点、英文标题和标题别名。
2. parser registry 改成 match score：每个 parser 返回匹配分数和理由，而不是只靠字符串包含。
3. PDF 行聚类和列识别改造：按页面宽高比例、动态表头、列边界和 continuation row 合并解析。
4. fixture 测试集：每家银行保留脱敏样例，覆盖标题变化、长商户换行、跨年账期、正负号方向。
5. schema migration：新增 `schema_migrations` 表，后续 schema 改动可重复、可追踪。

section matcher 示例方向：

```python
def normalize_section_text(text):
    return normalize_spaces(text).replace(" ", "").replace("　", "")


def section_matches(line, aliases):
    normalized = normalize_section_text(line)
    return any(normalize_section_text(alias) in normalized for alias in aliases)
```

### Phase 3：金融级可审计增强

目标是让系统具备长期审计和复盘能力。

1. parser version：每条 statement 和 transaction 记录解析器版本。
2. source span：记录来源文件、页码、行号、原始片段范围，便于回溯。
3. Decimal 存储规范：数据库继续用文本保存 Decimal 原值，导出和排序时显式转换，避免 float 精度污染。
4. review 工作流增强：低置信、重复、疑似噪声、金额方向不确定分开标记。
5. 性能验证：对 10 万级交易执行导入、查询、导出和 `EXPLAIN QUERY PLAN` 检查。

### 回归测试计划

新增测试应覆盖以下场景：

- 标题格式变化：`交易明细`、`交 易 明 细`、英文标题、全角标点都能进入正确 section。
- 温馨提示含日期金额：不进入正式交易表，只进入 review。
- 商户名含“退款/还款/退货”：正常消费不因商户名关键字被误翻转。
- PDF 长商户名换行：能合并 continuation row，不错配金额列。
- 同日同商户同金额多笔交易：同一账单内保留多笔真实交易。
- Excel 公式注入文本：导出后以文本显示，不作为公式执行。
- 大量交易导出排序：使用索引，导出结果稳定。

## 隐私和 Git 安全

真实账单非常敏感。公开 GitHub 仓库时请务必注意：

- 不要提交 `inbox/`、`processed/`、`output/`、`review_files/`、`data/`。
- 不要提交 `.eml`、`.pdf`、`.xlsx`、`.csv`、`.db`、`.sqlite` 等真实数据文件。
- 本项目 `.gitignore` 已默认忽略这些目录和文件类型。
- 提交前一定检查：

```bash
git status --short
```

如果看到真实账单、导出 Excel、数据库文件被暂存，先取消暂存：

```bash
git restore --staged <文件路径>
```

如果敏感文件已经被 commit，不要只是在下一个 commit 删除。Git 历史里仍然会存在。应当：

- 如果还没公开推送：重写本地历史或重新建仓库。
- 如果已经推送到公开仓库：立即改为私有、删除仓库或重写历史，并视情况更换相关账户信息。

最稳妥的公开发布方式：只发布源码、测试样例和说明文档；不要发布任何真实账单或真实导出结果。

## 清空本地测试数据

如果你想重新导入，可以清空本地运行数据。

Windows PowerShell：

```powershell
.\clean_data.ps1
```

Debian / Ubuntu / macOS 可以手动删除这些目录里的内容，但保留 `.gitkeep`：

```bash
find inbox output processed review_files data -type f ! -name .gitkeep -delete
```

## 运行测试

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

Debian / Ubuntu / macOS：

```bash
.venv/bin/python -m pytest -q
```

## 常见问题

### 为什么处理完的文件不在 `inbox/` 了？

成功处理后会移动到 `processed/`，避免下一次重复导入。

### 为什么有些字段在 Excel 里看不到？

`交易明细` 是给人看的简洁表。完整字段仍在 `标准字段`，但账期、来源文件、文件指纹、原始文本默认隐藏，避免日常查看时干扰。

### 可以直接把整个项目 git push 吗？

可以，但前提是 `git status --short` 里不能出现真实账单、导出结果、数据库文件。`.gitignore` 已经做了保护，但提交前仍然要人工检查。




