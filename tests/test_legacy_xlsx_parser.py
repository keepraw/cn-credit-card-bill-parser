from pathlib import Path

import pandas as pd

from ccparser.extractors import extract_source
from ccparser.parsers.registry import parse_statement


def test_legacy_xlsx_import_preserves_duplicate_like_rows(tmp_path):
    path = tmp_path / "legacy.xlsx"
    frame = pd.DataFrame([
        {
            "银行名称": "交通银行",
            "卡号": "4705",
            "交易日期": "2020-11-09",
            "入账日期": "2020-11-10",
            "交易详情": "地铁大数据（云闪付后付费）",
            "交易币种": "CNY",
            "交易金额": 2,
            "入账币种": "CNY",
            "入账金额": 2,
        },
        {
            "银行名称": "交通银行",
            "卡号": "4705",
            "交易日期": "2020-11-09",
            "入账日期": "2020-11-10",
            "交易详情": "地铁大数据（云闪付后付费）",
            "交易币种": "CNY",
            "交易金额": 2,
            "入账币种": "CNY",
            "入账金额": 2,
        },
    ])
    frame.to_excel(path, sheet_name="统一账单", index=False)
    source = extract_source(Path(path))
    statement = parse_statement(source)
    assert statement.parser_name == "legacy_xlsx"
    assert len(statement.transactions) == 2
    assert statement.transactions[0].description == statement.transactions[1].description


def test_legacy_xlsx_future_bill_dates_roll_back_one_year():
    from datetime import date

    from ccparser.parsers.legacy_xlsx import parse_legacy_bill_date

    assert parse_legacy_bill_date(date(2026, 12, 15), today=date(2026, 6, 25)).isoformat() == "2025-12-15"
    assert parse_legacy_bill_date(date(2026, 6, 25), today=date(2026, 6, 25)).isoformat() == "2026-06-25"
