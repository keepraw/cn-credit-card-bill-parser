import logging

import pytest

from ccparser.logging_utils import configure_logging, parse_log_level


def test_parse_log_level_accepts_known_levels():
    assert parse_log_level("WARNING") == logging.WARNING
    assert parse_log_level("debug") == logging.DEBUG


def test_parse_log_level_rejects_unknown_level():
    with pytest.raises(ValueError, match="Invalid log level"):
        parse_log_level("verbose")


def test_configure_logging_writes_parser_and_run_logs(tmp_path):
    run_log_path = configure_logging(logging.DEBUG, tmp_path)
    logging.getLogger("ccparser.tests").debug("debug marker")

    parser_log_path = tmp_path / "parser.log"
    assert parser_log_path.exists()
    assert run_log_path.exists()
    assert run_log_path.parent == tmp_path / "runs"
    assert "debug marker" in parser_log_path.read_text(encoding="utf-8")
    assert "debug marker" in run_log_path.read_text(encoding="utf-8")
