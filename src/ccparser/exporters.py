from __future__ import annotations

from pathlib import Path

from .models import ReviewItem


UNIFIED_COLUMNS = [
    "bank",
    "card_last4",
    "statement_start",
    "statement_end",
    "transaction_date",
    "posting_date",
    "description",
    "transaction_currency",
    "transaction_amount",
    "settlement_currency",
    "settlement_amount",
    "source_file_name",
    "source_file_hash",
    "confidence",
    "raw_text",
]


FRIENDLY_COLUMNS = [
    "银行",
    "卡尾号",
    "交易日",
    "入账日",
    "说明",
    "交易币种",
    "交易金额",
    "结算币种",
    "结算金额",
]


REVIEW_COLUMNS = [
    "reason",
    "source_file_name",
    "source_file_hash",
    "bank",
    "card_last4",
    "transaction_id",
    "statement_key",
    "detail",
    "raw_text",
]


STANDARD_HIDDEN_COLUMNS = {
    "statement_start",
    "statement_end",
    "source_file_name",
    "source_file_hash",
    "raw_text",
}


REVIEW_HIDDEN_COLUMNS = {"source_file_hash", "transaction_id", "statement_key", "raw_text"}


def export_outputs(output_dir: Path, transactions: list[dict[str, object]], review_items: list[ReviewItem]) -> None:
    try:
        import pandas as pd
    except ImportError as exc:
        raise RuntimeError("pandas and openpyxl are required to export Excel files. Run: pip install -r requirements.txt") from exc

    output_dir.mkdir(parents=True, exist_ok=True)
    unified_frame = pd.DataFrame(transactions)
    if unified_frame.empty:
        unified_frame = pd.DataFrame(columns=UNIFIED_COLUMNS)
    else:
        unified_frame = unified_frame.reindex(columns=UNIFIED_COLUMNS)
        unified_frame = _coerce_output_types(unified_frame)
        unified_frame = unified_frame.sort_values(
            by=["transaction_date", "posting_date", "bank", "card_last4", "description"],
            kind="stable",
            na_position="last",
        )
    friendly_frame = _friendly_transactions(unified_frame)

    review_frame = pd.DataFrame([item.as_output_row() for item in review_items])
    if review_frame.empty:
        review_frame = pd.DataFrame(columns=REVIEW_COLUMNS)
    else:
        review_frame = review_frame.reindex(columns=REVIEW_COLUMNS)

    summary_frame = pd.DataFrame([
        {"item": "正式交易条数", "value": len(unified_frame)},
        {"item": "复核事项条数", "value": len(review_frame)},
        {"item": "说明", "value": "交易明细为日常查看表；标准字段保留完整审计信息，敏感来源列默认隐藏。"},
    ])

    unified_path = output_dir / "unified_transactions.xlsx"
    with pd.ExcelWriter(unified_path, engine="openpyxl") as writer:
        friendly_frame.to_excel(writer, sheet_name="交易明细", index=False)
        unified_frame.to_excel(writer, sheet_name="标准字段", index=False)
        summary_frame.to_excel(writer, sheet_name="导入摘要", index=False)
        _format_workbook(writer.book)
        _hide_columns_by_header(writer.book["标准字段"], STANDARD_HIDDEN_COLUMNS)

    review_path = output_dir / "review.xlsx"
    with pd.ExcelWriter(review_path, engine="openpyxl") as writer:
        _friendly_review(review_frame).to_excel(writer, sheet_name="复核事项", index=False)
        review_frame.to_excel(writer, sheet_name="标准字段", index=False)
        _format_workbook(writer.book)
        _hide_columns_by_header(writer.book["标准字段"], REVIEW_HIDDEN_COLUMNS)


def _friendly_transactions(frame):
    if frame.empty:
        return frame.assign(**{column: [] for column in FRIENDLY_COLUMNS})[FRIENDLY_COLUMNS]
    return frame.rename(columns={
        "bank": "银行",
        "card_last4": "卡尾号",
        "transaction_date": "交易日",
        "posting_date": "入账日",
        "description": "说明",
        "transaction_currency": "交易币种",
        "transaction_amount": "交易金额",
        "settlement_currency": "结算币种",
        "settlement_amount": "结算金额",
    })[FRIENDLY_COLUMNS]


def _coerce_output_types(frame):
    import pandas as pd

    for column in ["transaction_amount", "settlement_amount", "confidence"]:
        if column in frame.columns:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
    for column in ["statement_start", "statement_end", "transaction_date", "posting_date"]:
        if column in frame.columns:
            frame[column] = pd.to_datetime(frame[column], errors="coerce").dt.date
    return frame


def _friendly_review(frame):
    columns = ["原因", "来源文件", "银行", "卡尾号", "说明", "原始文本"]
    if frame.empty:
        return frame.assign(**{column: [] for column in columns})[columns]
    return frame.rename(columns={
        "reason": "原因",
        "source_file_name": "来源文件",
        "bank": "银行",
        "card_last4": "卡尾号",
        "detail": "说明",
        "raw_text": "原始文本",
    })[columns]


def _format_workbook(workbook) -> None:
    from openpyxl.styles import Alignment, Border, Font, Side

    header_font = Font(bold=True)
    header_border = Border(bottom=Side(style="thin", color="D9D9D9"))
    for sheet in workbook.worksheets:
        sheet.freeze_panes = "A2"
        sheet.sheet_view.showGridLines = False
        sheet.auto_filter.ref = sheet.dimensions
        for cell in sheet[1]:
            cell.font = header_font
            cell.border = header_border
            cell.alignment = Alignment(horizontal="center", vertical="center")
        for row in sheet.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(vertical="top", wrap_text=True)
                if isinstance(cell.value, (float, int)):
                    cell.number_format = "#,##0.00"
        for column_cells in sheet.columns:
            header = str(column_cells[0].value or "")
            values = [str(cell.value or "") for cell in column_cells[:80]]
            width = min(max([len(header), *(len(value) for value in values)] + [10]) + 2, 48)
            if header in {"说明", "description", "detail", "原始文本", "raw_text"}:
                width = 36
            if header in {"source_file_hash", "source_file_name"}:
                width = 24
            sheet.column_dimensions[column_cells[0].column_letter].width = width


def _hide_columns_by_header(sheet, headers: set[str]) -> None:
    for cell in sheet[1]:
        if cell.value in headers:
            sheet.column_dimensions[cell.column_letter].hidden = True
