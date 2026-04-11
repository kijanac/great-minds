"""Corpus routes — R2 document browser and local-model summarization."""

from __future__ import annotations

import asyncio
import queue
import threading
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from great_minds.core import r2
from great_minds.core.settings import get_settings
from great_minds.core.summarizer import AVAILABLE_MODELS, summarize_stream

router = APIRouter(prefix="/corpus", tags=["corpus"])

# Single-threaded executor: keeps GPU memory access serialised
_executor = ThreadPoolExecutor(max_workers=1)


def _get_r2_client():
    s = get_settings()
    if not s.r2_endpoint_url or not s.r2_access_key_id or not s.r2_secret_access_key:
        raise HTTPException(status_code=503, detail="R2 credentials not configured")
    return r2.make_client(s.r2_endpoint_url, s.r2_access_key_id, s.r2_secret_access_key)


# ---------------------------------------------------------------------------
# List objects
# ---------------------------------------------------------------------------


@router.get("/objects")
async def list_objects(prefix: str = Query(default="")):
    """List all objects under an optional prefix."""
    client = _get_r2_client()
    s = get_settings()
    loop = asyncio.get_event_loop()
    try:
        objects = await loop.run_in_executor(
            _executor, r2.list_objects, client, s.r2_bucket, prefix
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"objects": objects}


# ---------------------------------------------------------------------------
# Read a single object
# ---------------------------------------------------------------------------


@router.get("/object")
async def get_object(key: str = Query(...)):
    """Return the text content of a single R2 object."""
    client = _get_r2_client()
    s = get_settings()
    loop = asyncio.get_event_loop()
    try:
        content = await loop.run_in_executor(
            _executor, r2.read_object, client, s.r2_bucket, key
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"key": key, "content": content}


# ---------------------------------------------------------------------------
# Summarize a document (streaming)
# ---------------------------------------------------------------------------


class SummarizeRequest(BaseModel):
    key: str
    context_prompt: str = ""
    model_id: str = "Qwen/Qwen3-8B"


@router.post("/summarize")
async def summarize(req: SummarizeRequest):
    """Stream a summarization of an R2 document via a local model."""
    if req.model_id not in AVAILABLE_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {req.model_id}")

    client = _get_r2_client()
    s = get_settings()
    loop = asyncio.get_event_loop()

    try:
        content = await loop.run_in_executor(
            _executor, r2.read_object, client, s.r2_bucket, req.key
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read document: {e}")

    # Bridge sync generator → async generator via a queue
    q: queue.Queue[str | None] = queue.Queue()

    def _run():
        try:
            for chunk in summarize_stream(content, req.context_prompt, req.model_id):
                q.put(chunk)
        except Exception as exc:
            q.put(f"\n\n[ERROR: {exc}]")
        finally:
            q.put(None)

    threading.Thread(target=_run, daemon=True).start()

    async def _stream():
        while True:
            chunk = await loop.run_in_executor(None, q.get)
            if chunk is None:
                break
            yield chunk

    return StreamingResponse(_stream(), media_type="text/plain; charset=utf-8")


# ---------------------------------------------------------------------------
# Available models
# ---------------------------------------------------------------------------


@router.get("/models")
async def list_models():
    return {"models": list(AVAILABLE_MODELS.keys())}
