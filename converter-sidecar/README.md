# Converter Sidecar

Agentic content-to-markdown converter for Great Minds. Runs as a separate
process, pinned to Python 3.12 (avoids `onnxruntime`'s missing 3.14 wheel),
exposing a simple HTTP API.

## Architecture

```
┌─ main app (3.14) ───────────────────────────┐
│                                               │
│  IngestService                                 │
│    │                                          │
│    ├─ quick path: markitdown (no [pdf])       │
│    ├─ fallback: ConverterClient ──────────┐   │
│    │                                      │   │
└────┼──────────────────────────────────────┼───┘
     │                                      │
     │  POST /convert  (localhost:8001)     │
     ▼                                      │
┌─ converter sidecar (3.12 venv) ───────────┼───┐
│                                            │   │
│  Agent loop:                               │   │
│    1. Receive ConvertRequest               │   │
│    2. LLM plans tool sequence              │   │
│    3. Execute tools (markitdown, crawl4ai, │   │
│       pdfplumber, yt-dlp, pandoc)          │   │
│    4. Assemble markdown output             │   │
│    5. Return ConvertResponse               │   │
│                                            │   │
│  Tools are stateless, agent is headless    │   │
│  (no multi-turn user interaction).         │   │
└────────────────────────────────────────────┘───┘
```

## Quick start

```bash
cd converter-sidecar
uv sync
OPENAI_API_KEY=sk-... fastapi dev converter_sidecar/main.py --port 8001
```

## API

### POST /convert

```json
{
  "source": "https://marxists.org/archive/lenin/works/1897/",
  "target": "corpus",
  "goal": "collect all articles from 1897, one markdown file per article",
  "max_tool_calls": 12
}
```

Response:

```json
{
  "id": "uuid",
  "status": "complete",
  "files": [
    {"path": "lenin/1897/01-new-economic-developments.md", "content": "# New Economic Developments\n\n...", "content_type": "texts"},
    {"path": "lenin/1897/02-the-handicraft-census.md", "content": "# The Handicraft Census\n\n...", "content_type": "texts"}
  ],
  "trace": [
    {"tool": "crawl4ai_extract", "args": {"url": "..."}, "ok": true, "summary": "scraped 45123 chars, 47 internal links"},
    {"tool": "markitdown_convert", "args": {"url": "..."}, "ok": true, "summary": "converted → 12KB markdown"},
    {"tool": "write_file", "args": {"path": "..."}, "ok": true, "summary": "wrote 12288 chars → lenin/1897/01-..."}
  ]
}
```

### GET /tools

List available tools and their JSON schemas.

### GET /health

Liveness check.

## Tools

| Tool | When to use | Dependencies |
|---|---|---|
| `markitdown_convert` | Simple HTML/DOCX/PPTX → markdown | `markitdown[all]` |
| `crawl4ai_extract` | JS-rendered pages, link extraction | `crawl4ai` |
| `pdfplumber_extract` | PDFs with complex layouts, tables | `pdfplumber` (pure Python) |
| `ytdlp_transcript` | Video transcripts | `yt-dlp` |

## Agent behavior

The agent runs a single-pass LLM loop:

1. System prompt describes available tools and strategy
2. User message contains the source + goal
3. LLM calls tools (max 12 by default)
4. Tool results are summarized for the LLM (raw content is too large for context)
5. LLM calls `write_file` for each output
6. Response is assembled from write_file artifacts

The agent is **not conversational** — it receives one request and produces one
response. No multi-turn user interaction.

## Recipe store (future)

For domain-specific scraping (marxists.org, arXiv, Substack), the agent can
learn and cache "recipes" — tested tool call sequences that work for a given
domain. Recipes are human-reviewed once, then run automatically.

```
converter_sidecar/recipes/
├── marxists_org.json     # crawl4ai → extract links → markitdown each
├── arxiv_org.json        # markitdown the /abs/ page → resolve PDF link
└── substack_com.json     # crawl4ai (JS-rendered paywall bypass)
```

## Why a separate process?

- **Python version**: `markitdown[all]` → `magika` → `onnxruntime`, which lacks
  a Python 3.14 wheel. The sidecar pins 3.12.
- **Heavy dependencies**: crawl4ai pulls in Playwright. The main app stays lean.
- **Failure isolation**: if the sidecar crashes, the main app still serves
  text/user-suggestion/session-exchange ingest.
- **Independently deployable**: can run on a different machine, scale separately.
