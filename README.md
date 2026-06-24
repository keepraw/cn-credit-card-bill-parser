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
