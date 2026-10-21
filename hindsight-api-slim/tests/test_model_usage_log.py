"""One ``model_usage`` log line per model call (``HINDSIGHT_API_MODEL_USAGE_LOG_ENABLED``).

The line is the record a deployment routes to storage for spend accounting, so it must
carry the call's attribution and tokens as structured fields, and the JSON log format
must put them at the top level of the line.
"""

import json
import logging

import pytest

from hindsight_api import tracing
from hindsight_api.config import JsonFormatter, TextFormatter, clear_config_cache, get_config
from hindsight_api.engine.llm_trace import operation_run
from hindsight_api.engine.llm_wrapper import LLMProvider
from hindsight_api.engine.model_usage_log import MESSAGE, ModelUsageLogRecorder, model_usage_log_recorder


@pytest.fixture
def usage_log(caplog):
    rec = ModelUsageLogRecorder()
    tracing.register_span_recorder(rec)
    caplog.set_level(logging.INFO, logger="hindsight_api.model_usage")
    yield caplog
    tracing.unregister_span_recorder(rec)


def _lines(caplog) -> list[dict]:
    return [r.json_fields for r in caplog.records if r.name == "hindsight_api.model_usage" and r.msg == MESSAGE]


async def test_one_line_per_call_with_its_attribution_and_tokens(usage_log):
    llm = LLMProvider(provider="mock", api_key="", base_url="", model="mock")
    with operation_run("bank-1", "consolidation"):
        await llm.call(messages=[{"role": "user", "content": "hi"}], scope="consolidation")
        await llm.call(messages=[{"role": "user", "content": "again"}], scope="consolidation")

    lines = _lines(usage_log)
    assert len(lines) == 2
    line = lines[0]
    assert (line["bank_id"], line["operation"], line["scope"], line["call_type"], line["provider"]) == (
        "bank-1",
        "consolidation",
        "consolidation",
        "chat",
        "mock",
    )
    assert line["success"] is True and line["error"] is None and line["trace_id"]
    assert lines[0]["trace_id"] == lines[1]["trace_id"], "one operation run, one trace"


def test_a_failed_call(usage_log):
    tracing.get_span_recorder().record_llm_call(
        provider="openai",
        model="m",
        scope="rerank",
        messages=[],
        input_tokens=5,
        output_tokens=0,
        duration=0.25,
        error=TimeoutError("slow"),
        input_count=3,
    )
    [line] = _lines(usage_log)
    assert (line["success"], line["error"], line["call_type"], line["input_count"], line["duration_ms"]) == (
        False,
        "TimeoutError",
        "rerank",
        3,
        250,
    )


def _record(**json_fields) -> logging.LogRecord:
    record = logging.LogRecord("hindsight_api.model_usage", logging.INFO, __file__, 1, MESSAGE, None, None)
    record.json_fields = json_fields
    return record


def test_json_lines_carry_the_fields_at_the_top_level():
    line = json.loads(JsonFormatter().format(_record(bank_id="b", input_tokens=7)))
    assert (line["message"], line["severity"], line["bank_id"], line["input_tokens"]) == ("model_usage", "INFO", "b", 7)


def test_an_allowlist_does_not_drop_them():
    line = json.loads(JsonFormatter(frozenset({"message", "severity"})).format(_record(bank_id="b")))
    assert line == {"message": "model_usage", "severity": "INFO", "bank_id": "b"}


def test_they_cannot_overwrite_the_standard_fields():
    line = json.loads(JsonFormatter().format(_record(severity="DEBUG", message="other")))
    assert (line["severity"], line["message"]) == ("INFO", "model_usage")


def test_text_lines_keep_them_too():
    assert TextFormatter().format(_record(bank_id="b")).endswith('model_usage {"bank_id": "b"}')


def test_off_by_default(monkeypatch):
    monkeypatch.delenv("HINDSIGHT_API_MODEL_USAGE_LOG_ENABLED", raising=False)
    clear_config_cache()
    try:
        assert get_config().model_usage_log_enabled is False
    finally:
        clear_config_cache()
    assert model_usage_log_recorder(False) is None
    assert isinstance(model_usage_log_recorder(True), ModelUsageLogRecorder)


async def test_a_retain_and_a_recall_log_every_model_call_they_make(usage_log, memory):
    """End to end on the real engine: the extraction, the embeddings and the recall's rerank
    each log a line, attributed to the bank and the operation that made it."""
    from datetime import datetime

    import httpx

    from hindsight_api.api import create_app

    bank_id = f"model_usage_log_{datetime.now().timestamp()}"
    app = create_app(memory, initialize_memory=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        await client.put(f"/v1/default/banks/{bank_id}", json={"name": "Usage Bank"})
        retain = await client.post(
            f"/v1/default/banks/{bank_id}/memories", json={"items": [{"content": "Alice likes cats"}]}
        )
        assert retain.status_code == 200
        recall = await client.post(
            f"/v1/default/banks/{bank_id}/memories/recall", json={"query": "What does Alice like?"}
        )
        assert recall.status_code == 200

    lines = [line for line in _lines(usage_log) if line["bank_id"] == bank_id]
    by_scope = {(line["operation"], line["scope"]) for line in lines}
    assert ("retain", "embedding_document") in by_scope
    assert ("recall", "embedding_query") in by_scope
    assert ("recall", "rerank") in by_scope
    assert any(line["operation"] == "retain" and line["call_type"] == "chat" for line in lines)
    assert all(line["success"] for line in lines)
