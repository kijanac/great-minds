"""LLM HTTP client with rate-limit-aware retries and JSON-parse retries.

Three call layers:

- :func:`api_call` wraps ``client.chat.completions.create`` with retry
  on 429s (larger budget, honors Retry-After) and transient errors
  (short budget, jittered backoff). Auto-injects OpenRouter's
  ``usage={"include": true}`` extension so the response carries USD
  cost. Per-call cost is logged and accumulated into the current wide
  event.
- :func:`api_stream` is the streaming counterpart: yields chunks with
  per-chunk stall detection, accumulates cost from the final usage
  chunk, and emits a completion log event. Single-model — no
  same-model retry (OpenAI's streaming SDK doesn't lend itself to
  mid-stream retry). Cross-model fallback is the caller's job; use
  :func:`models_with_fallback` and :func:`is_retryable` to compose.
- :func:`json_llm_call` wraps :func:`api_call` with a shallow retry
  loop for the case where HTTP returns 200 but the body fails to
  parse as JSON (stray commas, mid-output truncation, markdown
  fencing). Persistent parse failures raise with the raw response in
  the log.
"""


import asyncio
import json
import logging
import random
import re
import time
from collections.abc import AsyncGenerator

from openai import AsyncOpenAI, RateLimitError

from great_minds.core.llm.providers import FALLBACK_MODELS
from great_minds.core.telemetry import accumulate_cost, log_event

log = logging.getLogger(__name__)

RATE_LIMIT_RETRIES = 6
GENERIC_RETRIES = 2
MAX_BACKOFF_SECONDS = 60

_JSON_FENCE_OPEN_RE = re.compile(r"^```(?:json)?\n?")
_JSON_FENCE_CLOSE_RE = re.compile(r"\n?```$")


def _retry_after_seconds(err: RateLimitError) -> float | None:
    resp = getattr(err, "response", None)
    if resp is None:
        return None
    header = resp.headers.get("retry-after") or resp.headers.get("Retry-After")
    if not header:
        return None
    try:
        return float(header)
    except ValueError:
        return None


async def api_call(client: AsyncOpenAI, **kwargs):
    extra_body = dict(kwargs.get("extra_body") or {})
    extra_body.setdefault("usage", {"include": True})
    kwargs["extra_body"] = extra_body

    rl_attempts = 0
    generic_attempts = 0
    model = kwargs["model"]
    call_started = time.monotonic()
    while True:
        try:
            response = await client.chat.completions.create(**kwargs)
            usage = getattr(response, "usage", None)
            cost = getattr(usage, "cost", None) if usage else None
            if cost is not None:
                accumulate_cost(float(cost))
            log_event(
                "llm_call_completed",
                model=model,
                duration_ms=round((time.monotonic() - call_started) * 1000),
                attempts=rl_attempts + generic_attempts + 1,
                input_tokens=getattr(usage, "prompt_tokens", None) if usage else None,
                output_tokens=getattr(usage, "completion_tokens", None)
                if usage
                else None,
                cost_usd=cost,
            )
            return response
        except RateLimitError as e:
            rl_attempts += 1
            if rl_attempts > RATE_LIMIT_RETRIES:
                log_event(
                    "llm_rate_limit_exhausted",
                    level=logging.ERROR,
                    model=model,
                    attempts=rl_attempts,
                    error=str(e)[:500],
                )
                raise
            sleep = _retry_after_seconds(e)
            if sleep is None:
                sleep = min(MAX_BACKOFF_SECONDS, 2**rl_attempts) + random.uniform(0, 1)
            log_event(
                "llm_rate_limited",
                level=logging.WARNING,
                model=model,
                attempt=rl_attempts,
                max_attempts=RATE_LIMIT_RETRIES,
                sleep_seconds=round(sleep, 1),
                error=str(e)[:500],
            )
            await asyncio.sleep(sleep)
        except Exception as e:
            generic_attempts += 1
            if generic_attempts > GENERIC_RETRIES:
                log_event(
                    "llm_call_failed_exhausted",
                    level=logging.ERROR,
                    model=model,
                    attempts=generic_attempts,
                    error_class=type(e).__name__,
                    error=str(e)[:500],
                )
                raise
            log_event(
                "llm_call_retry",
                level=logging.WARNING,
                model=model,
                attempt=generic_attempts,
                max_attempts=GENERIC_RETRIES,
                error_class=type(e).__name__,
                error=str(e)[:500],
            )
            await asyncio.sleep(2**generic_attempts + random.uniform(0, 0.5))


class StreamStalled(Exception):
    """Raised when no streaming chunks arrive within the per-chunk timeout."""


def is_retryable(exc: Exception) -> bool:
    """Whether an LLM-call error is worth retrying with a different model.

    Uses exception types — ``RateLimitError`` from the SDK, plus
    ``StreamStalled`` for streaming-specific stalls. Don't string-match
    error messages; SDK error formatting changes between versions.
    """
    return isinstance(exc, (RateLimitError, StreamStalled))


def models_with_fallback(primary: str) -> list[str]:
    """Primary model first, then provider-configured fallbacks (deduped)."""
    return [primary] + [m for m in FALLBACK_MODELS if m != primary]


async def _iter_with_timeout(async_iter, timeout: float):
    """Wrap an async iterator with a per-item timeout.

    Raises :class:`StreamStalled` if no item arrives within ``timeout``
    seconds. Distinct from total-call timeout — this catches the case
    where a stream opened successfully but stops emitting.
    """
    ait = aiter(async_iter)
    while True:
        try:
            yield await asyncio.wait_for(anext(ait), timeout)
        except StopAsyncIteration:
            return
        except asyncio.TimeoutError:
            raise StreamStalled(f"no chunks received for {timeout}s") from None


async def api_stream(
    client: AsyncOpenAI,
    *,
    chunk_timeout: float = 30.0,
    **kwargs,
) -> AsyncGenerator:
    """Streaming completion with stall detection + cost accumulation.

    Yields ``ChatCompletionChunk`` objects. The final chunk carries
    ``usage`` (when ``stream_options.include_usage`` is set); cost is
    pulled from ``usage.cost`` (OpenRouter extension) and added to the
    current wide event.

    Single-model. No same-model retry: streaming responses can't be
    cleanly retried mid-emit, and the provider's own routing handles
    most transient errors before any chunk is yielded. For cross-model
    fallback, compose at the caller — try each model from
    :func:`models_with_fallback`, falling back on errors classified by
    :func:`is_retryable`.

    Auto-injects OpenRouter's ``usage={"include": true}`` and the
    ``stream_options.include_usage`` flag so the final chunk carries
    cost. Caller's ``extra_body``/``stream_options`` win on collision.
    """
    extra_body = dict(kwargs.get("extra_body") or {})
    extra_body.setdefault("usage", {"include": True})
    kwargs["extra_body"] = extra_body
    kwargs["stream"] = True
    stream_options = dict(kwargs.get("stream_options") or {})
    stream_options.setdefault("include_usage", True)
    kwargs["stream_options"] = stream_options

    model = kwargs["model"]
    call_started = time.monotonic()
    chunks_yielded = 0
    cost: float | None = None

    stream = await client.chat.completions.create(**kwargs)
    try:
        async for chunk in _iter_with_timeout(stream, chunk_timeout):
            usage = getattr(chunk, "usage", None)
            if usage is not None:
                chunk_cost = getattr(usage, "cost", None)
                if chunk_cost is not None:
                    cost = float(chunk_cost)
                    accumulate_cost(cost)
            chunks_yielded += 1
            yield chunk
    finally:
        log_event(
            "llm_stream_completed",
            model=model,
            duration_ms=round((time.monotonic() - call_started) * 1000),
            chunks=chunks_yielded,
            cost_usd=cost,
        )


def extract_content(response) -> str | None:
    choice = response.choices[0] if response.choices else None
    if not choice or not choice.message or not choice.message.content:
        return None
    return choice.message.content.strip()


def _strip_json_fencing(raw: str) -> str:
    raw = _JSON_FENCE_OPEN_RE.sub("", raw)
    raw = _JSON_FENCE_CLOSE_RE.sub("", raw)
    return raw


async def json_llm_call(
    client: AsyncOpenAI,
    *,
    model: str,
    messages: list[dict],
    max_parse_retries: int = 1,
    **kwargs,
) -> dict:
    """``api_call`` + JSON parsing with retry on body malformation.

    HTTP-layer retries (rate limits, transient errors) are handled by
    ``api_call``. This layer adds a shallow retry for 200s where the
    body fails to parse as JSON — stray commas, mid-output truncation,
    occasional markdown fencing. One retry absorbs flakes cheaply;
    persistent parse failures still surface after max_parse_retries,
    with the raw response in the log.

    response_format defaults to json_object; callers can override via
    kwargs to pass a json_schema constraint instead.
    """
    kwargs.setdefault("response_format", {"type": "json_object"})
    total_attempts = max_parse_retries + 1
    for attempt in range(1, total_attempts + 1):
        response = await api_call(
            client, model=model, messages=messages, **kwargs
        )
        raw = extract_content(response) or ""
        try:
            return json.loads(_strip_json_fencing(raw))
        except json.JSONDecodeError as e:
            is_final = attempt == total_attempts
            log_event(
                "json_llm_parse_exhausted"
                if is_final
                else "json_llm_parse_retry",
                level=logging.ERROR if is_final else logging.WARNING,
                model=model,
                attempt=attempt,
                max_attempts=total_attempts,
                error=str(e),
                raw_preview=raw[:500],
            )
            if is_final:
                raise
    # Unreachable — loop always exits via return or raise above.
    raise AssertionError("json_llm_call loop exited without resolution")
