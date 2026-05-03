"""Converter tools — each is an async function the agent can call.

Tools return ``ToolResult`` with a structured summary so the agent gets
signal without raw content flooding its context window. Full output is
stored on the side and assembled into ``ConvertedFile`` objects at the end.
"""

import asyncio
import io
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pdfplumber
from markitdown import MarkItDown, StreamInfo


@dataclass
class ToolResult:
    ok: bool
    summary: str
    artifacts: list["Artifact"] = field(default_factory=list)
    raw: Any = None


@dataclass
class Artifact:
    """Intermediate output the agent produced — a file or URL the agent
    discovered that should be fed into a follow-up tool call."""

    kind: str  # "file", "url", "markdown"
    path: str = ""
    url: str = ""
    content: str = ""


# ---------------------------------------------------------------------------
# Tool: markitdown_convert
# ---------------------------------------------------------------------------

_md_converter = MarkItDown()


async def markitdown_convert(*, url: str = "", raw_bytes_b64: str = "", mimetype: str = "", filename: str = "") -> ToolResult:
    """Convert a URL or raw file bytes to markdown via MarkItDown.

    Exactly one of ``url`` or ``raw_bytes_b64`` must be provided. For
    URLs, the tool fetches and converts. For raw bytes, provide the
    base64-encoded content, its mimetype, and filename (for extension
    detection).
    """
    try:
        if url and raw_bytes_b64:
            return ToolResult(ok=False, summary="provide url OR raw_bytes_b64, not both")
        if not url and not raw_bytes_b64:
            return ToolResult(ok=False, summary="provide url or raw_bytes_b64")

        if url:
            async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
                resp = await client.get(url, headers={"User-Agent": "converter-sidecar/0.1"})
                resp.raise_for_status()
            content_type = resp.headers.get("content-type", "text/html")
            ext = _ext_from_content_type(content_type)
            stream = io.BytesIO(resp.content)
        else:
            import base64
            raw = base64.b64decode(raw_bytes_b64)
            ext = Path(filename).suffix if filename else ".bin"
            stream = io.BytesIO(raw)

        result = await asyncio.to_thread(
            _md_converter.convert_stream,
            stream,
            stream_info=StreamInfo(extension=ext, mimetype=mimetype),
        )
        size_kb = len(result.text_content) // 1024
        return ToolResult(
            ok=True,
            summary=f"converted → {size_kb}KB markdown",
            artifacts=[Artifact(kind="markdown", content=result.text_content, url=url)],
        )
    except Exception as e:
        return ToolResult(ok=False, summary=f"markitdown failed: {e}")


# ---------------------------------------------------------------------------
# Tool: crawl4ai_extract
# ---------------------------------------------------------------------------

async def crawl4ai_extract(*, url: str, instruction: str = "", extract_links: bool = True) -> ToolResult:
    """Scrape a JS-rendered page via crawl4ai. Use for modern SPAs,
    pages that require JavaScript execution, or structured extraction.

    ``instruction`` is an optional natural-language instruction for
    structured extraction (e.g. "extract the article title, author, and
    publication date"). ``extract_links`` returns all links on the page
    for follow-up crawling.
    """
    try:
        from crawl4ai import AsyncWebCrawler, CacheMode, CrawlerRunConfig

        config = CrawlerRunConfig(cache_mode=CacheMode.BYPASS)
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(url, config=config)

        if not result.success:
            return ToolResult(ok=False, summary=f"crawl4ai: {result.error_message}")

        md = result.markdown or ""
        links: list[str] = []
        if extract_links and result.links:
            internal = result.links.get("internal", [])
            links = [link["href"] for link in internal if link.get("href")]

        summary_parts = [f"scraped {len(md)} chars markdown"]
        if links:
            summary_parts.append(f"{len(links)} internal links")

        if instruction:
            # Structured extraction pass
            extracted = await result.extract(instruction)
            summary_parts.append(f"extraction: {extracted}")

        return ToolResult(
            ok=True,
            summary=", ".join(summary_parts),
            artifacts=[
                Artifact(kind="markdown", content=md, url=url),
                *[Artifact(kind="url", url=link) for link in links[:25]],
            ],
        )
    except ImportError:
        return ToolResult(ok=False, summary="crawl4ai not installed")
    except Exception as e:
        return ToolResult(ok=False, summary=f"crawl4ai failed: {e}")


# ---------------------------------------------------------------------------
# Tool: pdfplumber_extract
# ---------------------------------------------------------------------------

async def pdfplumber_extract(*, raw_bytes_b64: str) -> ToolResult:
    """Extract text and tables from a PDF using pdfplumber (pure Python,
    no onnxruntime dependency). Handles multi-column layouts.

    Provide the PDF as base64-encoded bytes.
    """
    try:
        import base64
        raw = base64.b64decode(raw_bytes_b64)

        text_parts: list[str] = []
        table_count = 0

        def _extract() -> tuple[str, int]:
            nonlocal table_count
            with pdfplumber.open(io.BytesIO(raw)) as pdf:
                for page in pdf.pages:
                    t = page.extract_text()
                    if t:
                        text_parts.append(t)
                    tables = page.extract_tables()
                    for tbl in tables:
                        if tbl:
                            md_table = _table_to_markdown(tbl)
                            text_parts.append(md_table)
                            table_count += 1
            return "\n\n".join(text_parts), table_count

        text, tc = await asyncio.to_thread(_extract)
        return ToolResult(
            ok=True,
            summary=f"extracted {len(text)} chars, {tc} tables",
            artifacts=[Artifact(kind="markdown", content=text)],
        )
    except Exception as e:
        return ToolResult(ok=False, summary=f"pdfplumber failed: {e}")


# ---------------------------------------------------------------------------
# Tool: ytdlp_transcript
# ---------------------------------------------------------------------------

async def ytdlp_transcript(*, url: str) -> ToolResult:
    """Extract transcript/subtitles from a YouTube video or other
    yt-dlp-supported source. Returns plain text with timestamps.
    """
    try:
        import yt_dlp

        opts = {
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitlesformat": "vtt",
            "skip_download": True,
            "quiet": True,
        }

        def _extract() -> str:
            with tempfile.TemporaryDirectory() as tmpdir:
                opts["outtmpl"] = f"{tmpdir}/%(id)s.%(ext)s"
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=True)
                # Find the subtitle file
                vid_id = info["id"]
                subs_dir = Path(tmpdir)
                for sub in subs_dir.glob(f"*.vtt"):
                    raw_text = sub.read_text()
                    # Strip VTT cues, keep text
                    lines = []
                    for line in raw_text.split("\n"):
                        line = line.strip()
                        if not line or "-->" in line or line == "WEBVTT":
                            continue
                        if line[0].isdigit() and ":" in line:
                            continue  # cue number
                        lines.append(line)
                    return "\n".join(lines)
                return f"[No transcript found. Available: {info.get('subtitles', {})}]"

        text = await asyncio.to_thread(_extract)
        return ToolResult(
            ok=True,
            summary=f"transcript: {len(text)} chars",
            artifacts=[Artifact(kind="markdown", content=text)],
        )
    except Exception as e:
        return ToolResult(ok=False, summary=f"yt-dlp failed: {e}")


# ---------------------------------------------------------------------------
# Tool: write_file
# ---------------------------------------------------------------------------

async def write_file(*, path: str, content: str) -> ToolResult:
    """Save a markdown artifact to a named file in the output bundle.
    The agent calls this at the end to name and organize its output.
    """
    return ToolResult(
        ok=True,
        summary=f"wrote {len(content)} chars → {path}",
        artifacts=[Artifact(kind="markdown", content=content, path=path)],
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ext_from_content_type(ct: str) -> str:
    ct = ct.split(";")[0].strip()
    return {
        "text/html": ".html",
        "application/pdf": ".pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
        "text/csv": ".csv",
        "application/json": ".json",
        "text/xml": ".xml",
        "application/xml": ".xml",
    }.get(ct, ".html")


def _table_to_markdown(table: list[list[str | None]]) -> str:
    if not table:
        return ""
    rows = [[cell or "" for cell in row] for row in table]
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    lines = []
    for i, row in enumerate(rows):
        line = "| " + " | ".join(cell.ljust(w) for w, cell in zip(widths, row)) + " |"
        lines.append(line)
        if i == 0:
            sep = "|" + "|".join("-" * (w + 2) for w in widths) + "|"
            lines.append(sep)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------

# Map tool name → (async_fn, JSON Schema for LLM function calling)
TOOLS: dict[str, tuple[callable, dict]] = {
    "markitdown_convert": (
        markitdown_convert,
        {
            "name": "markitdown_convert",
            "description": "Convert a URL or raw file bytes to markdown. Use for simple single-page or single-file conversion.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to fetch and convert"},
                    "raw_bytes_b64": {"type": "string", "description": "Base64-encoded file bytes"},
                    "mimetype": {"type": "string", "description": "MIME type of the raw bytes"},
                    "filename": {"type": "string", "description": "Original filename (for extension detection)"},
                },
            },
        },
    ),
    "crawl4ai_extract": (
        crawl4ai_extract,
        {
            "name": "crawl4ai_extract",
            "description": "Scrape a JS-rendered page using crawl4ai. Use for modern websites, SPAs, pages that need JS execution, or when you need to extract links for crawling. Returns markdown + internal links.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to scrape"},
                    "instruction": {"type": "string", "description": "Optional: natural language extraction instruction for structured data"},
                    "extract_links": {"type": "boolean", "description": "Whether to extract internal links for crawling"},
                },
                "required": ["url"],
            },
        },
    ),
    "pdfplumber_extract": (
        pdfplumber_extract,
        {
            "name": "pdfplumber_extract",
            "description": "Extract text and tables from a PDF. Use for PDF files that markitdown can't handle well (scanned documents, complex layouts).",
            "parameters": {
                "type": "object",
                "properties": {
                    "raw_bytes_b64": {"type": "string", "description": "Base64-encoded PDF bytes"},
                },
                "required": ["raw_bytes_b64"],
            },
        },
    ),
    "ytdlp_transcript": (
        ytdlp_transcript,
        {
            "name": "ytdlp_transcript",
            "description": "Extract transcript/subtitles from YouTube or other video platforms.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Video URL"},
                },
                "required": ["url"],
            },
        },
    ),
    "write_file": (
        write_file,
        {
            "name": "write_file",
            "description": "Save markdown content to a named output file. Call this for each output file you produce.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path in the output bundle, e.g. 'articles/intro.md'"},
                    "content": {"type": "string", "description": "Markdown content to save"},
                },
                "required": ["path", "content"],
            },
        },
    ),
}
