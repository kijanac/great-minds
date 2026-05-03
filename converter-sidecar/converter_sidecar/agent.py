"""Agent loop — the orchestrator that plans and executes conversions.

The agent receives a ``ConvertRequest`` and runs a single-pass LLM loop
with tool calling. It:

1. Forms a system prompt from the goal + available tools
2. Calls the LLM with tool_choice="auto"
3. Executes tool calls (summarizing large results for context)
4. Returns assembled ``ConvertResponse``

The loop runs until the LLM emits a final message with no tool calls,
or hits ``max_tool_calls``. There is no multi-turn user interaction —
this is a headless batch agent.
"""

import json
import logging
from uuid import uuid4

from openai import AsyncOpenAI

from converter_sidecar.schemas import (
    ConvertedFile,
    ConvertRequest,
    ConvertResponse,
    ToolCallTrace,
)
from converter_sidecar.tools import TOOLS, Artifact

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a content converter agent. Your job is to convert
content into clean, well-structured markdown files.

You have access to tools for:
- markitdown_convert: simple URL/file → markdown (works for most HTML, DOCX, PPTX)
- crawl4ai_extract: JS-rendered page scraping with link extraction (use for SPAs,
  sites requiring JS, or when you need to discover links to crawl)
- pdfplumber_extract: PDF text/table extraction (use when markitdown fails on PDFs)
- ytdlp_transcript: video transcript extraction
- write_file: save markdown output to a named file

Strategy rules:
1. For a single URL: try markitdown_convert first. If it fails or the result
   is empty/garbled, fall back to crawl4ai_extract.
2. For a corpus/crawl goal: first use crawl4ai_extract to get the page + links.
   Then crawl discovered links (prioritize those matching the goal). Convert
   each page. Use write_file for each output.
3. For PDFs: try markitdown_convert first. If the output is poor (scanned PDF,
   garbled text), use pdfplumber_extract instead.
4. For videos: use ytdlp_transcript.
5. Always end by calling write_file for each output document.
6. Be thorough but efficient — don't crawl irrelevant links.
7. If a tool fails twice, move on. Don't loop on the same failing tool.
"""


async def run_conversion(
    request: ConvertRequest,
    client: AsyncOpenAI,
    model: str = "gpt-4o",
) -> ConvertResponse:
    """Run the agent loop and return a conversion result."""
    trace: list[ToolCallTrace] = []
    artifacts: list[Artifact] = []

    messages: list[dict] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": _build_user_message(request),
        },
    ]

    tool_schemas = [schema for _, schema in TOOLS.values()]

    for iteration in range(request.max_tool_calls):
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            tools=tool_schemas,
            tool_choice="auto",
        )

        choice = response.choices[0]

        if choice.finish_reason == "stop" and not choice.message.tool_calls:
            # Agent is done
            break

        if not choice.message.tool_calls:
            # No tool calls, but not explicitly stopped — add the message
            # and let the next iteration handle it
            messages.append(choice.message.model_dump(exclude_none=True))
            continue

        # Execute tool calls
        messages.append(choice.message.model_dump(exclude_none=True))

        for tc in choice.message.tool_calls:
            name = tc.function.name
            args = json.loads(tc.function.arguments)

            if name not in TOOLS:
                result_summary = f"unknown tool: {name}"
                trace.append(ToolCallTrace(tool=name, args=args, ok=False, summary=result_summary))
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_summary,
                })
                continue

            fn, _ = TOOLS[name]
            try:
                result = await fn(**args)
            except Exception as e:
                result_summary = f"tool error: {e}"
                trace.append(ToolCallTrace(tool=name, args=args, ok=False, summary=result_summary))
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_summary,
                })
                continue

            trace.append(ToolCallTrace(
                tool=name,
                args=args,
                ok=result.ok,
                summary=result.summary,
            ))

            # Feed summary back to LLM (NOT raw content — too large)
            tool_msg: dict = {
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result.summary,
            }
            # Attach first artifact's content snippet as context
            if result.artifacts and result.artifacts[0].content:
                snippet = result.artifacts[0].content[:2000]
                tool_msg["content"] += f"\n\nContent preview ({len(result.artifacts[0].content)} chars total):\n{snippet}"

            messages.append(tool_msg)
            artifacts.extend(result.artifacts)

    else:
        # Hit max_tool_calls
        return ConvertResponse(
            status="partial",
            trace=trace,
            files=_assemble_files(list(_dedup_artifacts(artifacts))),
        )

    return ConvertResponse(
        status="complete",
        trace=trace,
        files=_assemble_files(list(_dedup_artifacts(artifacts))),
    )


def _build_user_message(request: ConvertRequest) -> str:
    parts = [f"Convert this content: {request.source}"]
    parts.append(f"Target type: {request.target.value}")

    if request.goal:
        parts.append(f"Goal: {request.goal}")
    else:
        parts.append("Goal: best-effort markdown conversion")

    if request.recipe_id:
        parts.append(f"Use recipe: {request.recipe_id}")

    return "\n".join(parts)


def _dedup_artifacts(artifacts: list[Artifact]):
    """Dedup artifacts by content hash, keeping first occurrence."""
    seen = set()
    for a in artifacts:
        h = hash(a.content[:100] if a.content else a.url)
        if h not in seen:
            seen.add(h)
            yield a


def _assemble_files(artifacts: list[Artifact]) -> list[ConvertedFile]:
    """Convert artifacts into ConvertedFile objects.

    write_file artifacts keep their path. Other markdown artifacts get
    auto-generated names.
    """
    files: list[ConvertedFile] = []
    unnamed_idx = 0

    for a in artifacts:
        if a.kind != "markdown":
            continue
        if a.path:
            files.append(ConvertedFile(path=a.path, content=a.content))
        else:
            unnamed_idx += 1
            files.append(ConvertedFile(
                path=f"converted/{unnamed_idx:03d}.md",
                content=a.content,
            ))
    return files
