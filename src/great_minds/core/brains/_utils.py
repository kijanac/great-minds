"""Shared utilities for brain operations (compiler, linter, etc.)."""

import asyncio
import json
import logging
import re
from io import StringIO

from openai import AsyncOpenAI
from ruamel.yaml import YAML

log = logging.getLogger(__name__)

_yaml = YAML()
_yaml.preserve_quotes = True

FRONTMATTER_RE = re.compile(r"^---\n(.+?)\n---\n", re.DOTALL)
MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")
FOOTNOTE_RE = re.compile(r"\[\^(\d+)\]:\s*\[([^\]]*)\]\(([^)]+)\)")

MAX_RETRIES = 2


async def api_call(client: AsyncOpenAI, **kwargs):
    """Wrap API calls with retries for transient failures."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return await client.chat.completions.create(**kwargs)
        except Exception as e:
            if attempt == MAX_RETRIES:
                raise
            log.warning("api call failed (attempt %d/%d): %s", attempt, MAX_RETRIES, e)
            await asyncio.sleep(2**attempt)


def extract_content(response) -> str | None:
    choice = response.choices[0] if response.choices else None
    if not choice or not choice.message or not choice.message.content:
        return None
    return choice.message.content.strip()


def strip_json_fencing(raw: str) -> str:
    raw = re.sub(r"^```(?:json)?\n?", "", raw)
    raw = re.sub(r"\n?```$", "", raw)
    return raw


def parse_frontmatter(content: str) -> tuple[dict, str]:
    match = FRONTMATTER_RE.match(content)
    if not match:
        return {}, content
    fm = _yaml.load(match.group(1))
    body = content[match.end() :]
    return dict(fm) if fm else {}, body


def serialize_frontmatter(fm: dict, body: str) -> str:
    buf = StringIO()
    _yaml.dump(fm, buf)
    return f"---\n{buf.getvalue()}---\n{body}"


def parse_json_response(text: str) -> dict | None:
    """Parse a JSON response from an LLM, stripping fencing."""
    raw = strip_json_fencing(text)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        log.warning("failed to parse LLM JSON: %s", raw[:200])
        return None
