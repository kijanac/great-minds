"""Structured logging with correlation IDs and wide event support.

Primary API — log_event():
    from great_minds.telemetry import setup_logging, log_event, correlation_id

    setup_logging(service="gateway")
    correlation_id.set("req-abc123")
    log_event("user_login_succeeded", user_id="u42", method="oauth")

Wide events (accumulate fields across a request, emit once at the end):
    from great_minds.telemetry import init_wide_event, enrich, timed_op, emit_wide_event

    correlation_id.set(f"msg-{msg.id}")
    init_wide_event("inbound_message", user_id="u42")
    enrich(channel="telegram")
    async with timed_op("llm_call"):
        result = await call_llm()
    emit_wide_event()

Wide events are opt-in. If you never call init_wide_event(), the wide event
machinery is completely inert.

Event naming convention:
    snake_case, past tense: payment_completed, tool_execute_failed
    Domain prefix when helpful: auth.login_failed, billing.invoice_created
"""

import contextlib
import contextvars
import json
import logging
import sys
import time
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime


def current_rss_mb() -> float:
    """Current resident-set size in MB, read from /proc/self/status.

    Linux only — returns 0.0 on platforms without /proc (e.g. macOS local
    runs). Used by phase-boundary memory checkpoints to surface peaks
    during compile, so OOM hot spots can be located from logs alone.
    """
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except OSError:
        pass
    return 0.0


# ---------------------------------------------------------------------------
# Context variables — async-safe, zero signature pollution
# ---------------------------------------------------------------------------

correlation_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "correlation_id",
    default="-",
)

wide_event: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "wide_event",
    default=None,
)

_telemetry_fields: contextvars.ContextVar[dict[str, object]] = contextvars.ContextVar(
    "telemetry_fields",
    default={},
)

_event_prefix: contextvars.ContextVar[tuple[str, ...]] = contextvars.ContextVar(
    "event_prefix",
    default=(),
)

# Set by setup_logging(), included in every structured log entry.
_service: str = "app"
_environment: str = "dev"

_wide_event_logger = logging.getLogger("wide_event")

# ---------------------------------------------------------------------------
# Primary API — structured event logging
# ---------------------------------------------------------------------------


def log_event(
    event: str,
    *,
    logger: logging.Logger | None = None,
    level: int = logging.INFO,
    **fields: object,
) -> None:
    """Emit a structured log event. This is the only logging API.

    Args:
        event: Machine-readable event name, snake_case, past tense.
        logger: Logger to emit on. Defaults to the service root logger.
        level: Log level.
        **fields: High-cardinality fields (user_id, duration_ms, etc.)
    """
    log = logger or logging.getLogger(_service)
    event_name = _scoped_event_name(event)
    event_fields = {**_telemetry_fields.get(), **fields}
    log.log(
        level,
        event_name,
        extra={"event_fields": event_fields, "event_name": event_name},
    )


def _scoped_event_name(event: str) -> str:
    prefix = _event_prefix.get()
    if not prefix:
        return event
    dotted_prefix = ".".join(prefix)
    if event == dotted_prefix or event.startswith(f"{dotted_prefix}."):
        return event
    return f"{dotted_prefix}.{event}"


@contextlib.contextmanager
def telemetry_scope(
    event_prefix: str | None = None, **fields: object
) -> Iterator[None]:
    """Bind structured log fields and an optional event-name prefix.

    Context propagates through asyncio tasks via contextvars, matching
    correlation_id/wide_event behavior while avoiding explicit plumbing through
    every phase and helper call.
    """
    field_token = _telemetry_fields.set({**_telemetry_fields.get(), **fields})
    current_prefix = _event_prefix.get()
    prefix_token = _event_prefix.set(
        (*current_prefix, event_prefix) if event_prefix else current_prefix
    )
    try:
        yield
    finally:
        _event_prefix.reset(prefix_token)
        _telemetry_fields.reset(field_token)


# ---------------------------------------------------------------------------
# Wide events — request-scoped accumulation, single emit at end
# ---------------------------------------------------------------------------


def init_wide_event(event_type: str, **fields) -> None:
    """Start a new wide event for the current async context."""
    ctx = {
        "event_type": event_type,
        "ts_start": time.monotonic(),
        "correlation_id": correlation_id.get("-"),
        **fields,
    }
    wide_event.set(ctx)


def enrich(**fields) -> None:
    """Merge fields into the current wide event. No-op if not initialized."""
    ctx = wide_event.get()
    if ctx is not None:
        ctx.update(fields)


def accumulate_cost(cost_usd: float) -> None:
    """Add to the wide event's cumulative cost_usd field. No-op if not initialized.

    Used by api_call to aggregate per-LLM-call cost (from OpenRouter's
    response.usage.cost) into compile-run or query-run totals.
    """
    if cost_usd <= 0:
        return
    ctx = wide_event.get()
    if ctx is None:
        return
    ctx["cost_usd"] = ctx.get("cost_usd", 0.0) + cost_usd


@contextlib.asynccontextmanager
async def timed_op(name: str) -> AsyncIterator[None]:
    """Record ``{name}_ms`` and ``{name}_error`` into the wide event."""
    ctx = wide_event.get()
    start = time.monotonic()
    try:
        yield
    except BaseException as exc:
        if ctx is not None:
            ctx[f"{name}_ms"] = round((time.monotonic() - start) * 1000)
            ctx[f"{name}_error"] = type(exc).__name__
        raise
    else:
        if ctx is not None:
            ctx[f"{name}_ms"] = round((time.monotonic() - start) * 1000)


def emit_wide_event() -> None:
    """Finalize and log the wide event, then clear the contextvar."""
    ctx = wide_event.get()
    if ctx is None:
        return
    ts_start = ctx.pop("ts_start", None)
    if ts_start is not None:
        ctx["total_duration_ms"] = round((time.monotonic() - ts_start) * 1000)
    ctx.setdefault("service", _service)
    ctx.setdefault("environment", _environment)
    _wide_event_logger.info(
        ctx.get("event_type", "unknown"),
        extra={"wide_event_data": ctx},
    )
    wide_event.set(None)


# ---------------------------------------------------------------------------
# Formatters
# ---------------------------------------------------------------------------


class StructuredFormatter(logging.Formatter):
    """Single-line JSON. Only formats log_event() and wide event output."""

    def format(self, record: logging.LogRecord) -> str:
        we_data = getattr(record, "wide_event_data", None)
        if we_data is not None:
            return json.dumps(we_data, sort_keys=True, ensure_ascii=False)

        entry: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "service": _service,
            "environment": _environment,
            "logger": record.name,
            "correlation_id": correlation_id.get("-"),
        }

        event_name = getattr(record, "event_name", None)
        if event_name is not None:
            entry["event"] = event_name
            fields = getattr(record, "event_fields", {})
            entry.update(fields)

        if record.exc_info and record.exc_info[0] is not None:
            entry["exception"] = self.formatException(record.exc_info)

        return json.dumps(entry, sort_keys=True, ensure_ascii=False)


class ReadableFormatter(logging.Formatter):
    """Human-readable with correlation ID. Wide events show timing summary."""

    def format(self, record: logging.LogRecord) -> str:
        we_data = getattr(record, "wide_event_data", None)
        if we_data is not None:
            cid = we_data.get("correlation_id", "-")
            event_type = we_data.get("event_type", "unknown")
            total = we_data.get("total_duration_ms", "?")
            timings = []
            for k, v in we_data.items():
                if k.endswith("_ms") and k != "total_duration_ms":
                    timings.append(f"{k[:-3]}={v}ms")
            timing_str = f" ({', '.join(timings)})" if timings else ""
            return f"[WIDE_EVENT] {event_type} [{cid}] total={total}ms{timing_str}"

        cid = correlation_id.get("-")
        event_name = getattr(record, "event_name", None)
        if event_name is not None:
            fields = getattr(record, "event_fields", {})
            parts = [f"{k}={v}" for k, v in fields.items()]
            field_str = f" {' '.join(parts)}" if parts else ""
            return (
                f"{self.formatTime(record)} [{record.levelname}] "
                f"{record.name} [{cid}]: {event_name}{field_str}"
            )

        return (
            f"{self.formatTime(record)} [{record.levelname}] "
            f"{record.name} [{cid}]: {record.getMessage()}"
        )


# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------


def setup_logging(
    *,
    service: str = "app",
    environment: str = "dev",
    json_output: bool = False,
    level: int = logging.INFO,
) -> None:
    """Configure the root logger. Call once at startup.

    Args:
        service: Service name included in every log entry.
        environment: Runtime environment (dev, staging, prod).
        json_output: True for production JSON, False for dev-readable.
        level: Root log level.
    """
    global _service, _environment
    _service = service
    _environment = environment

    root = logging.getLogger()
    root.setLevel(level)

    for handler in root.handlers[:]:
        root.removeHandler(handler)

    handler = logging.StreamHandler(sys.stderr)
    if json_output:
        handler.setFormatter(StructuredFormatter())
    else:
        handler.setFormatter(ReadableFormatter())
    root.addHandler(handler)
