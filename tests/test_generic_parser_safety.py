from pathlib import Path

from ccparser.models import SourceContext
from ccparser.parsers.generic import parse_generic


def test_generic_parser_ignores_noise_line_with_date_and_amount():
    source = SourceContext(
        path=Path("notice.txt"),
        file_name="notice.txt",
        file_hash="hash",
        source_type="copied_text",
        text="温馨提示：请于2026-06-20前还款1000.00元，如有疑问请联系客服。",
    )

    statement = parse_generic(source, bank="测试银行")

    assert statement.transactions == []
    assert "no_transactions_found" in statement.warnings
