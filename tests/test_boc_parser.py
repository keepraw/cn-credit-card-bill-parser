from pathlib import Path

from ccparser.models import SourceContext
from ccparser.parsers.boc import _apply_boc_column_sign, _clean_boc_description, parse


def test_boc_pdf_transaction_section_parser():
    text = """
中国银行信用卡账单(2026年06月)
账单信息总览/Account Summary
Payment Due Date Statement Closing Date Current RMB Total Balance Due Current FCY Total Balance Due
2026-06-24 2026-06-04 2,009.20
卡号 本期应还款额New Balance 本期最小还款Minimum Payment due
6259 0737 **** 6505 2009.20 200.00
北大白金信用卡(卡号：6505)
人民币交易明细/RMB Transaction Detailed List
卡号后四位
交易日 银行记账日 Last Four 交易描述 存入 支出
Transaction Date Posting Date Description Deposit Expenditure
Digits
of Card Number
2026-05-07 2026-05-07 6505 CUSTOMER PAYMENT 3000.00
2026-05-07 2026-05-07 6505 BOCNET 5264.69
微信-CHAGEE霸王茶姬C
2026-05-30 2026-05-31 6505 29.20
HN
网银在线-京东商城业务C
2026-06-03 2026-06-04 6505 1980.00
微信支付-京东商城平台商
2026-06-03 2026-06-04 6505 99.87
户CHN
积分奖励计划/Loyalty Plan
"""
    context = SourceContext(
        path=Path("boc.pdf"),
        file_name="boc.pdf",
        file_hash="abc",
        source_type="pdf_text",
        text=text,
    )
    statement = parse(context)
    assert statement.card_last4 == "6505"
    assert statement.statement_start.isoformat() == "2026-05-05"
    assert statement.statement_end.isoformat() == "2026-06-04"
    assert len(statement.transactions) == 5
    assert statement.transactions[0].settlement_amount < 0
    assert statement.transactions[1].settlement_amount < 0
    assert statement.transactions[2].settlement_amount > 0
    assert statement.transactions[2].description == "微信-CHAGEE霸王茶姬"
    assert statement.transactions[2].transaction_currency == "CNY"
    assert statement.transactions[3].description == "网银在线-京东商城业务"
    assert statement.transactions[3].transaction_currency == "CNY"
    assert statement.transactions[4].description == "微信支付-京东商城平台商户"
    assert statement.transactions[4].transaction_currency == "CNY"


def test_boc_deposit_column_is_negative():
    amount_word = {"x0": 422.0, "x1": 452.0}
    assert _apply_boc_column_sign(9569.85, amount_word, 438.0, 531.0, "银联转账（云闪付）") < 0


def test_boc_expenditure_column_is_positive():
    amount_word = {"x0": 520.0, "x1": 542.0}
    assert _apply_boc_column_sign(99.86, amount_word, 438.0, 531.0, "京东商城") > 0


def test_boc_chn_description_marker_removed():
    assert _clean_boc_description("微信CHN") == "微信"
    assert _clean_boc_description("微信-京东商城平台商户C HN") == "微信-京东商城平台商户"
    assert _clean_boc_description("网银在线-京东商城业务C HN") == "网银在线-京东商城业务"
