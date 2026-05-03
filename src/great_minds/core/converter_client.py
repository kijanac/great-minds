"""Integration layer: main Great Minds app → converter sidecar.

Adds ``ConverterClient`` as a drop-in alongside ``IngestService``.
When the sidecar is available, complex conversions delegate to it.
When it's not (or for simple text), the local path is used.

Usage in ingest_service.py:

    from great_minds.core.converter_client import ConverterClient

    converter = ConverterClient(base_url=settings.converter_sidecar_url)
    ...

    # Replace direct markitdown with:
    result = await converter.convert_url(url, goal="extract article body")

    # Or for uploaded files:
    result = await converter.convert_file(raw_bytes, filename, mimetype)
"""

import base64
import logging
from typing import Any

import httpx

from great_minds.core.documents.schemas import SourceMetadata

log = logging.getLogger(__name__)


class ConverterClient:
    """HTTP client for the converter sidecar.

    Gracefully degrades: if the sidecar is unreachable, falls back to
    the local ``_convert_to_markdown`` / ``_fetch_url`` functions in
    ``ingest_service.py``.

    Usage::

        converter = ConverterClient("http://localhost:8001")

        # Quick path: simple URL
        result = await converter.convert_url("https://example.com/article")

        # Agent path: structured goal
        result = await converter.convert_url(
            "https://marxists.org/archive/lenin/works/1897/",
            goal="collect all articles from 1897, one file per article",
            target="corpus",
        )

        # File upload path
        result = await converter.convert_file(pdf_bytes, "report.pdf", "application/pdf")
    """

    def __init__(self, base_url: str = "http://localhost:8001", timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def convert_url(
        self,
        url: str,
        *,
        goal: str = "",
        target: str = "url",
        recipe_id: str | None = None,
    ) -> "ConverterResult":
        """Convert a URL to markdown. Uses the agent for corpus/crawl
        targets, simple markitdown for single URLs when possible.
        """
        payload: dict[str, Any] = {
            "source": url,
            "target": target,
            "goal": goal,
        }
        if recipe_id:
            payload["recipe_id"] = recipe_id

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(f"{self.base_url}/convert", json=payload)
            if resp.status_code == 502:
                # Sidecar unavailable — caller should fall back
                raise ConverterUnavailable("sidecar returned 502")
            resp.raise_for_status()
            data = resp.json()

        return ConverterResult(
            files=[ConvertedFile(**f) for f in data.get("files", [])],
            status=data.get("status", "complete"),
            recipe_id=data.get("recipe_id"),
            trace=data.get("trace", []),
        )

    async def convert_file(
        self,
        raw_bytes: bytes,
        filename: str,
        mimetype: str = "",
        goal: str = "",
    ) -> "ConverterResult":
        """Convert an uploaded file to markdown via the sidecar."""
        # Simple files (markdown, text) can skip the sidecar
        # and be handled locally — this is for complex formats.
        payload: dict[str, Any] = {
            "source": filename,
            "target": "file",
            "goal": goal or f"convert {filename} to clean markdown",
        }
        # For the sidecar, we'd need a way to pass the file bytes.
        # Options: presigned URL to R2, base64 in JSON (small files only),
        # or a multipart upload endpoint in the sidecar.
        #
        # For now: base64 (sidecar handles the decode).
        if len(raw_bytes) > 10 * 1024 * 1024:  # 10MB
            raise ValueError("file too large for inline conversion; use bulk ingest")

        payload["raw_bytes_b64"] = base64.b64encode(raw_bytes).decode()
        payload["mimetype"] = mimetype
        payload["filename"] = filename

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(f"{self.base_url}/convert", json=payload)
            if resp.status_code == 502:
                raise ConverterUnavailable("sidecar returned 502")
            resp.raise_for_status()
            data = resp.json()

        return ConverterResult(
            files=[ConvertedFile(**f) for f in data.get("files", [])],
            status=data.get("status", "complete"),
            recipe_id=data.get("recipe_id"),
            trace=data.get("trace", []),
        )


class ConverterResult:
    """Mirrors the sidecar's ConvertResponse without the Pydantic
    dependency so the core module stays clean."""

    def __init__(self, files, status, recipe_id=None, trace=None):
        self.files = files
        self.status = status
        self.recipe_id = recipe_id
        self.trace = trace or []


class ConvertedFile:
    def __init__(self, path, content, content_type="texts", metadata=None):
        self.path = path
        self.content = content
        self.content_type = content_type
        self.metadata = metadata or {}

    def to_source_metadata(self) -> SourceMetadata:
        return SourceMetadata(
            content_type=self.content_type,
            source_type="document",
            **(self.metadata),
        )


class ConverterUnavailable(Exception):
    """Raised when the sidecar is unreachable. Callers should fall back
    to local conversion."""
    pass
