"""One structured log line per model call, for accounting what the calls cost.

Off by default; ``HINDSIGHT_API_MODEL_USAGE_LOG_ENABLED=true`` turns it on. Every LLM,
embedding, rerank and decision-model call then logs one ``model_usage`` line on the
``hindsight_api.model_usage`` logger, with the bank and operation it ran for and its
tokens.

With ``HINDSIGHT_API_LOG_FORMAT=json`` the fields are top-level keys of the line (beside
``severity``, ``timestamp`` and ``tenant``), so a log pipeline can route these lines to
object storage or a warehouse by ``message == "model_usage"`` and query them as columns.
That is the point of a log line rather than a table: nothing is written to the database
on the call path, and where the lines end up is the deployment's choice.

It is a GenAI span recorder like ``LLMTraceRecorder``, so it sees exactly the calls the
``llm_requests`` trace sees, whether or not that table is written.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import BaseModel

from .llm_trace import current_trace_context, genai_operation_name

logger = logging.getLogger("hindsight_api.model_usage")

MESSAGE = "model_usage"


class ModelUsageEvent(BaseModel):
    """The fields of one ``model_usage`` line."""

    bank_id: str | None
    operation: str | None
    trace_id: str | None
    scope: str
    #: ``chat``, ``embeddings``, ``rerank`` or ``decision`` (``llm_trace.genai_operation_name``).
    call_type: str
    provider: str
    model: str
    served_by: str | None
    success: bool
    error: str | None
    input_tokens: int
    cached_input_tokens: int
    output_tokens: int
    thoughts_tokens: int
    duration_ms: int
    #: Texts or documents sent, for embedding and rerank calls.
    input_count: int | None


class ModelUsageLogRecorder:
    """GenAI span recorder that logs one ``model_usage`` line per model call."""

    def record_llm_call(
        self,
        *,
        provider: str,
        model: str,
        scope: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        duration: float = 0.0,
        error: BaseException | None = None,
        cached_tokens: int = 0,
        thoughts_tokens: int | None = None,
        served_by: str | None = None,
        input_count: int | None = None,
        **_extra: Any,
    ) -> None:
        # Lazy: memory_engine imports this module.
        from .memory_engine import get_current_bank_id

        ctx = current_trace_context()
        # The failing call's exception carries it when the response never parsed.
        served_by = served_by or getattr(error, "served_by", None)
        event = ModelUsageEvent(
            bank_id=(ctx.bank_id if ctx else None) or get_current_bank_id(),
            operation=ctx.operation if ctx else None,
            trace_id=ctx.trace_id if ctx else None,
            scope=scope,
            call_type=genai_operation_name(scope),
            provider=provider,
            model=model or "",
            served_by=served_by if isinstance(served_by, str) else None,
            success=error is None,
            error=type(error).__name__ if error is not None else None,
            input_tokens=input_tokens or 0,
            cached_input_tokens=cached_tokens or 0,
            output_tokens=output_tokens or 0,
            thoughts_tokens=thoughts_tokens or 0,
            duration_ms=int(max(0.0, duration) * 1000),
            input_count=input_count,
        )
        logger.info(MESSAGE, extra={"json_fields": event.model_dump(mode="json")})


def model_usage_log_recorder(enabled: bool) -> ModelUsageLogRecorder | None:
    """The recorder to register, or None when the log is off."""
    return ModelUsageLogRecorder() if enabled else None
