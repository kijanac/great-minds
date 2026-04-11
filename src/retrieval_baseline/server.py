"""
Web interface for the LlamaIndex retrieval baseline.

Loads the persisted index once on startup, then serves a browser UI and a
/api/query endpoint.

Usage:
    uv run --env-file .env python -m retrieval_baseline.server \\
        --faiss --embed-model BAAI/bge-base-en-v1.5

    # custom port / host
    uv run --env-file .env python -m retrieval_baseline.server \\
        --faiss --embed-model BAAI/bge-base-en-v1.5 --port 8080 --host 0.0.0.0

Then open http://localhost:8765 in your browser.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

# Apply OMP / onnxruntime suppression before any llama-index imports (same as llama_index.py).
os.environ.setdefault("OMP_NUM_THREADS", "1")
try:
    import onnxruntime as ort
    ort.set_default_logger_severity(4)
except ImportError:
    pass

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from retrieval_baseline.llama_index import (
    DEFAULT_CHUNK_OVERLAP,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_EMBED_MODEL,
    DEFAULT_EMBED_PROVIDER,
    DEFAULT_FAISS_INDEX_DIR,
    DEFAULT_INDEX_DIR,
    DEFAULT_LLM_MODEL,
    DEFAULT_SIMILARITY_TOP_K,
    FAISS_STORE_FILE,
    _build_service_context,
    _check_faiss_mismatch,
)

# ---------------------------------------------------------------------------
# Global app state (index + startup args)
# ---------------------------------------------------------------------------

_state: dict = {}

# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _lifespan(app: FastAPI):
    args: argparse.Namespace = _state["args"]
    index_dir = Path(
        args.index_dir or (DEFAULT_FAISS_INDEX_DIR if args.faiss else DEFAULT_INDEX_DIR)
    )

    if not index_dir.exists():
        raise RuntimeError(
            f"Index directory not found: {index_dir}\n"
            "Run the 'index' command first."
        )

    _check_faiss_mismatch(index_dir, args.faiss)

    _build_service_context(
        embed_model=args.embed_model,
        embed_provider=args.embed_provider,
        llm_model=args.llm_model,
        chunk_size=args.chunk_size,
        chunk_overlap=args.chunk_overlap,
    )

    from llama_index.core import load_index_from_storage
    from llama_index.core.storage import StorageContext

    if args.faiss:
        from llama_index.vector_stores.faiss import FaissVectorStore
        storage_context = StorageContext.from_defaults(
            persist_dir=str(index_dir),
            vector_store=FaissVectorStore.from_persist_dir(str(index_dir)),
        )
    else:
        storage_context = StorageContext.from_defaults(persist_dir=str(index_dir))

    n_nodes = len(storage_context.docstore.docs)
    print(f"Loading index ({n_nodes:,} nodes) from: {index_dir} …")
    t0 = time.perf_counter()
    _state["index"] = load_index_from_storage(storage_context)
    _state["n_nodes"] = n_nodes
    _state["index_dir"] = str(index_dir)
    print(f"Index loaded in {time.perf_counter() - t0:.1f}s — ready at http://{args.host}:{args.port}")

    yield

    _state.clear()


# ---------------------------------------------------------------------------
# Request / response schemas (module-scope avoids FastAPI schema issues)
# ---------------------------------------------------------------------------


class QueryRequest(BaseModel):
    question: str
    top_k: int = DEFAULT_SIMILARITY_TOP_K
    response_mode: str = "compact"
    show_sources: bool = True
    verbose: bool = False


class SourceNode(BaseModel):
    file_name: str
    file_path: str
    score: Optional[float]
    snippet: str


class QueryResponse(BaseModel):
    answer: str
    sources: list[SourceNode]
    elapsed_ms: int


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------


def _create_app(args: argparse.Namespace) -> FastAPI:
    _state["args"] = args
    app = FastAPI(title="Great Minds Search", lifespan=_lifespan)

    # ------------------------------------------------------------------
    # Routes
    # ------------------------------------------------------------------

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    async def ui():
        from fastapi.responses import Response
        return Response(
            content=_HTML_PAGE,
            media_type="text/html",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "index_loaded": "index" in _state,
            "n_nodes": _state.get("n_nodes"),
            "index_dir": _state.get("index_dir"),
        }

    @app.post("/api/query", response_model=QueryResponse)
    async def query(req: QueryRequest):
        if "index" not in _state:
            raise HTTPException(503, "Index not loaded yet")
        if not req.question.strip():
            raise HTTPException(400, "question must not be empty")

        index = _state["index"]

        def _run() -> QueryResponse:
            qe = index.as_query_engine(
                similarity_top_k=req.top_k,
                response_mode=req.response_mode,
                verbose=req.verbose,
            )
            t0 = time.perf_counter()
            response = qe.query(req.question)
            elapsed_ms = int((time.perf_counter() - t0) * 1000)

            snippet_len = 2000 if req.verbose else 500
            sources: list[SourceNode] = []
            if req.show_sources:
                for node in response.source_nodes:
                    meta = node.metadata
                    sources.append(
                        SourceNode(
                            file_name=meta.get("file_name", meta.get("source", "unknown")),
                            file_path=meta.get("file_path", ""),
                            score=getattr(node, "score", None),
                            snippet=node.get_content()[:snippet_len].strip(),
                        )
                    )

            return QueryResponse(
                answer=str(response),
                sources=sources,
                elapsed_ms=elapsed_ms,
            )

        return await asyncio.to_thread(_run)

    return app


# ---------------------------------------------------------------------------
# HTML page (self-contained, no external dependencies)
# ---------------------------------------------------------------------------

_HTML_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Great Minds Search</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #0d0f18;
      --surface:   #161929;
      --surface2:  #1f2235;
      --border:    #2a2e4a;
      --text:      #e2e4f0;
      --muted:     #7b80a0;
      --accent:    #6c8ef5;
      --accent-h:  #8aaafe;
      --err:       #f87171;
      --mono:      'Fira Code', 'Cascadia Code', 'Consolas', monospace;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
    }

    /* ---- header ---- */
    header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 0.85rem 2rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    header h1 { font-size: 1rem; font-weight: 600; letter-spacing: 0.01em; }
    .badge {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--muted);
      font-size: 0.68rem;
      font-family: var(--mono);
      padding: 0.15rem 0.45rem;
    }

    /* ---- main ---- */
    main {
      max-width: 820px;
      margin: 0 auto;
      padding: 2.5rem 1.5rem 4rem;
    }

    /* ---- search box ---- */
    .search-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      transition: border-color 0.18s;
    }
    .search-box:focus-within { border-color: var(--accent); }

    textarea#question {
      background: transparent;
      border: none;
      color: var(--text);
      font-family: inherit;
      font-size: 0.98rem;
      line-height: 1.5;
      min-height: 80px;
      outline: none;
      padding: 1.1rem 1.3rem;
      resize: none;
      width: 100%;
    }
    textarea#question::placeholder { color: var(--muted); }

    .search-footer {
      align-items: center;
      border-top: 1px solid var(--border);
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1rem;
      justify-content: space-between;
      padding: 0.6rem 1rem;
    }

    .opts { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem 1.2rem; }

    .opt {
      align-items: center;
      color: var(--muted);
      display: flex;
      font-size: 0.78rem;
      gap: 0.35rem;
    }
    .opt label { cursor: pointer; white-space: nowrap; }
    .opt select,
    .opt input[type=number] {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      font-size: 0.78rem;
      outline: none;
      padding: 0.18rem 0.4rem;
    }
    .opt input[type=number] { width: 3.8rem; }
    .opt input[type=checkbox] { accent-color: var(--accent); cursor: pointer; }
    .hint { color: var(--muted); font-size: 0.7rem; white-space: nowrap; }

    #submit {
      background: var(--accent);
      border: none;
      border-radius: 6px;
      color: #fff;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.45rem 1.1rem;
      transition: background 0.15s;
      white-space: nowrap;
    }
    #submit:hover:not(:disabled) { background: var(--accent-h); }
    #submit:disabled { background: var(--surface2); color: var(--muted); cursor: not-allowed; }

    /* ---- status messages ---- */
    #loading {
      display: none;
      margin-top: 2rem;
      text-align: center;
      color: var(--muted);
      font-size: 0.875rem;
    }
    .spin {
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      display: inline-block;
      height: 18px;
      width: 18px;
      margin-right: 0.5rem;
      animation: spin 0.65s linear infinite;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    #error-box {
      display: none;
      background: rgba(248,113,113,0.08);
      border: 1px solid rgba(248,113,113,0.3);
      border-radius: 8px;
      color: var(--err);
      font-size: 0.875rem;
      margin-top: 2rem;
      padding: 0.9rem 1.2rem;
    }

    /* ---- results ---- */
    #results { display: none; margin-top: 2rem; }

    .result-meta {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 0.72rem;
      margin-bottom: 1rem;
    }

    .answer-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 1.5rem;
      padding: 1.3rem 1.5rem;
    }
    .card-label {
      color: var(--accent);
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.09em;
      margin-bottom: 0.8rem;
      text-transform: uppercase;
    }
    .answer-text {
      font-size: 0.96rem;
      line-height: 1.75;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .sources-label {
      color: var(--muted);
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.09em;
      margin-bottom: 0.65rem;
      text-transform: uppercase;
    }

    .src-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 0.5rem;
      overflow: hidden;
    }
    .src-head {
      align-items: center;
      cursor: pointer;
      display: flex;
      gap: 0.7rem;
      padding: 0.65rem 1rem;
      user-select: none;
    }
    .src-head:hover { background: var(--surface2); }
    .src-num  { color: var(--muted); font-family: var(--mono); font-size: 0.7rem; min-width: 1.4rem; }
    .src-name { color: var(--text); flex: 1; font-size: 0.83rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .src-score { color: var(--muted); font-family: var(--mono); font-size: 0.7rem; }
    .chevron { color: var(--muted); font-size: 0.65rem; transition: transform 0.18s; }
    .src-card.open .chevron { transform: rotate(90deg); }
    .src-snippet {
      border-top: 1px solid var(--border);
      color: var(--muted);
      display: none;
      font-family: var(--mono);
      font-size: 0.76rem;
      line-height: 1.6;
      padding: 0.75rem 1rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .src-card.open .src-snippet { display: block; }
  </style>
</head>
<body>
  <header>
    <h1>Great Minds</h1>
    <span class="badge">document search</span>
  </header>

  <main>
    <div class="search-box">
      <textarea id="question" placeholder="Ask anything about the documents…" rows="3" autofocus></textarea>
      <div class="search-footer">
        <div class="opts">
          <div class="opt">
            <label for="top_k">Top-K</label>
            <input type="number" id="top_k" min="1" max="20" value="5">
          </div>
          <div class="opt">
            <label for="response_mode">Mode</label>
            <select id="response_mode">
              <option value="compact" selected>compact</option>
              <option value="refine">refine</option>
              <option value="tree_summarize">tree_summarize</option>
              <option value="simple_summarize">simple_summarize</option>
              <option value="no_text">no_text</option>
            </select>
          </div>
          <div class="opt">
            <input type="checkbox" id="show_sources" checked>
            <label for="show_sources">Show sources</label>
          </div>
          <div class="opt">
            <input type="checkbox" id="verbose">
            <label for="verbose">Verbose</label>
          </div>
          <span class="hint">Ctrl+Enter to search</span>
        </div>
        <button id="submit">Search</button>
      </div>
    </div>

    <div id="loading"><span class="spin"></span>Querying…</div>
    <div id="error-box"></div>

    <div id="results">
      <div class="result-meta" id="result-meta"></div>
      <div class="answer-card">
        <div class="card-label">Answer</div>
        <div class="answer-text" id="answer-text"></div>
      </div>
      <div id="sources"></div>
    </div>
  </main>

  <script>
    const qEl      = document.getElementById('question');
    const submitBtn= document.getElementById('submit');
    const loading  = document.getElementById('loading');
    const errBox   = document.getElementById('error-box');
    const results  = document.getElementById('results');
    const answerEl = document.getElementById('answer-text');
    const metaEl   = document.getElementById('result-meta');
    const srcsEl   = document.getElementById('sources');

    qEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
    });
    submitBtn.addEventListener('click', run);

    async function run() {
      const question = qEl.value.trim();
      if (!question) return;

      submitBtn.disabled = true;
      loading.style.display = 'block';
      errBox.style.display  = 'none';
      results.style.display = 'none';

      try {
        const resp = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            top_k:         parseInt(document.getElementById('top_k').value) || 5,
            response_mode: document.getElementById('response_mode').value,
            show_sources:  document.getElementById('show_sources').checked,
            verbose:       document.getElementById('verbose').checked,
          }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => null);
          let msg;
          if (!err) {
            msg = resp.statusText || ('HTTP ' + resp.status);
          } else if (Array.isArray(err.detail)) {
            // Pydantic validation errors: [{loc, msg, type}, ...]
            msg = err.detail.map(e => (e.loc ? e.loc.slice(1).join('.') + ': ' : '') + e.msg).join('\\n');
          } else {
            msg = err.detail || err.message || JSON.stringify(err);
          }
          throw new Error(msg);
        }

        render(await resp.json());
      } catch (e) {
        errBox.textContent = 'Error: ' + e.message;
        errBox.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        loading.style.display = 'none';
      }
    }

    function render(data) {
      answerEl.textContent = data.answer;
      const n = data.sources.length;
      metaEl.textContent = (data.elapsed_ms / 1000).toFixed(1) + 's  ·  '
        + n + ' source' + (n !== 1 ? 's' : '');

      const autoExpand = document.getElementById('verbose').checked;

      srcsEl.innerHTML = '';
      if (n > 0) {
        const lbl = document.createElement('div');
        lbl.className = 'sources-label';
        lbl.textContent = 'Sources';
        srcsEl.appendChild(lbl);

        data.sources.forEach((src, i) => {
          const card = document.createElement('div');
          card.className = 'src-card' + (autoExpand ? ' open' : '');
          card.innerHTML =
            '<div class="src-head">'
              + '<span class="src-num">[' + (i+1) + ']</span>'
              + '<span class="src-name" title="' + esc(src.file_path) + '">' + esc(src.file_name) + '</span>'
              + (src.score != null ? '<span class="src-score">' + src.score.toFixed(4) + '</span>' : '')
              + '<span class="chevron">&#9654;</span>'
            + '</div>'
            + '<div class="src-snippet">' + esc(src.snippet) + '</div>';
          card.querySelector('.src-head').addEventListener('click', () => card.classList.toggle('open'));
          srcsEl.appendChild(card);
        });
      }

      results.style.display = 'block';
    }

    function esc(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
  </script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="retrieval_baseline.server",
        description="Serve the LlamaIndex retrieval baseline as a web UI",
    )
    p.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    p.add_argument("--port", type=int, default=8765, help="Bind port (default: 8765)")
    p.add_argument(
        "--index-dir",
        default=None,
        help=(
            f"Index directory "
            f"(default without --faiss: {DEFAULT_INDEX_DIR}, "
            f"with --faiss: {DEFAULT_FAISS_INDEX_DIR})"
        ),
    )
    p.add_argument(
        "--embed-provider",
        default=os.environ.get("LLAMA_EMBED_PROVIDER", DEFAULT_EMBED_PROVIDER),
        choices=["openai", "huggingface"],
    )
    p.add_argument(
        "--embed-model",
        default=os.environ.get("LLAMA_EMBED_MODEL", DEFAULT_EMBED_MODEL),
    )
    p.add_argument(
        "--llm-model",
        default=os.environ.get("LLAMA_LLM_MODEL", DEFAULT_LLM_MODEL),
    )
    p.add_argument("--chunk-size",    type=int, default=DEFAULT_CHUNK_SIZE)
    p.add_argument("--chunk-overlap", type=int, default=DEFAULT_CHUNK_OVERLAP)
    p.add_argument(
        "--faiss",
        action="store_true",
        help="Load the FAISS-backed index",
    )
    return p


def main() -> None:
    args = _build_parser().parse_args()
    app = _create_app(args)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
