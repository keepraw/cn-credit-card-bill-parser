from decimal import Decimal

from ccparser.normalizers import parse_amount, parse_date


def test_parse_six_digit_date():
    assert parse_date("251218").isoformat() == "2025-12-18"


def test_parse_excel_serial_date():
    assert parse_date(46009).isoformat() == "2025-12-18"


def test_parse_positive_purchase():
    assert parse_amount("￥2,000.00", "消费 京东") == Decimal("2000.00")


def test_parse_repayment_negative():
    assert parse_amount("1000.00", "还款") == Decimal("-1000.00")


def test_parse_refund_negative():
    assert parse_amount("88.00", "退货 商户退款") == Decimal("-88.00")


def test_parse_parentheses_negative():
    assert parse_amount("(2000.00)", "调整") == Decimal("-2000.00")


def test_parse_slash_credit_negative():
    assert parse_amount("2000.00/C", "入账") == Decimal("-2000.00")
