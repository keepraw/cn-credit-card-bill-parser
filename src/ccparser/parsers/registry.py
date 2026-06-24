from __future__ import annotations

from ccparser.models import ParsedStatement, SourceContext

from . import abc, boc, bocom, ccb, citic, generic, icbc, legacy_xlsx


def parse_statement(context: SourceContext) -> ParsedStatement:
    if context.path.suffix.lower() == '.xlsx':
        return legacy_xlsx.parse(context)
    text = context.text
    if "交通银行" in text or "Bank of Communications" in text or "BOCOM" in text:
        return bocom.parse(context)
    if "中国银行" in text or "Bank of China" in text or "BOC" in text:
        return boc.parse(context)
    if "工商银行" in text or "中国工商银行" in text or "ICBC" in text:
        return icbc.parse(context)
    if "农业银行" in text or "中国农业银行" in text or "ABC" in text:
        return abc.parse(context)
    if "中信银行" in text or "CITIC" in text.upper():
        return citic.parse(context)
    if "中国建设银行" in text or "龙卡信用卡" in text:
        return ccb.parse(context)
    return generic.parse_generic(context)


