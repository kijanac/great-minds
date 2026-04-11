#!/usr/bin/env python3
"""Standalone summarization debug server.

No database, no auth. Just R2 browsing + local model inference.

Usage:
    uv run scripts/summarize_server.py

Environment variables (or .env file):
    R2_ENDPOINT_URL        e.g. https://<id>.r2.cloudflarestorage.com
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
    R2_BUCKET              default: great-minds
    CUDA_VISIBLE_DEVICES   default: 0,1
"""

from __future__ import annotations

import os
import queue
import threading
from pathlib import Path

# Must be set before torch import
os.environ.setdefault("CUDA_VISIBLE_DEVICES", os.getenv("CUDA_VISIBLE_DEVICES", "0,1"))

# Load .env if present
_env_path = Path(__file__).parent.parent / ".env"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

import boto3
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

R2_ENDPOINT = os.environ["R2_ENDPOINT_URL"]
R2_KEY_ID = os.environ["R2_ACCESS_KEY_ID"]
R2_SECRET = os.environ["R2_SECRET_ACCESS_KEY"]
R2_BUCKET = os.environ.get("R2_BUCKET", "great-minds")

AVAILABLE_MODELS = {"Qwen/Qwen3-8B": "Qwen/Qwen3-8B"}

# ---------------------------------------------------------------------------
# R2 helpers
# ---------------------------------------------------------------------------

def _r2():
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_KEY_ID,
        aws_secret_access_key=R2_SECRET,
        region_name="auto",
    )


def _list_objects(prefix: str = "") -> list[dict]:
    client = _r2()
    paginator = client.get_paginator("list_objects_v2")
    kwargs: dict = {"Bucket": R2_BUCKET}
    if prefix:
        kwargs["Prefix"] = prefix
    results = []
    for page in paginator.paginate(**kwargs):
        for obj in page.get("Contents", []):
            results.append({"key": obj["Key"], "size": obj["Size"]})
    return results


def _read_object(key: str) -> str:
    client = _r2()
    response = client.get_object(Bucket=R2_BUCKET, Key=key)
    return response["Body"].read().decode("utf-8")


# ---------------------------------------------------------------------------
# Model (lazy-loaded)
# ---------------------------------------------------------------------------

_model_lock = threading.Lock()
_loaded: dict[str, tuple] = {}


def _load_model(model_id: str):
    with _model_lock:
        if model_id not in _loaded:
            from transformers import AutoModelForCausalLM, AutoTokenizer
            print(f"Loading {model_id}…", flush=True)
            tokenizer = AutoTokenizer.from_pretrained(model_id)
            model = AutoModelForCausalLM.from_pretrained(
                model_id, torch_dtype="auto", device_map="auto"
            )
            _loaded[model_id] = (model, tokenizer)
            print(f"Model ready on {model.device}", flush=True)
    return _loaded[model_id]


def _summarize_stream(document: str, context_prompt: str, model_id: str):
    from transformers import TextIteratorStreamer

    model, tokenizer = _load_model(model_id)
    system = context_prompt.strip() or "Summarize the following document concisely."
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": document},
    ]
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer([text], return_tensors="pt").to(model.device)
    streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)
    t = threading.Thread(
        target=model.generate,
        kwargs={**inputs, "max_new_tokens": 2048, "streamer": streamer},
        daemon=True,
    )
    t.start()
    for chunk in streamer:
        yield chunk
    t.join()


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="Summarize Debug Server")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_executor_lock = threading.Semaphore(1)  # serialise GPU calls


@app.get("/")
def index():
    return FileResponse(Path(__file__).parent / "summarize.html")


@app.get("/objects")
def list_objects(prefix: str = Query(default="")):
    return {"objects": _list_objects(prefix)}


@app.get("/object")
def get_object(key: str = Query(...)):
    try:
        return {"key": key, "content": _read_object(key)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/models")
def list_models():
    return {"models": list(AVAILABLE_MODELS)}


class SummarizeRequest(BaseModel):
    key: str
    context_prompt: str = ""
    model_id: str = "Qwen/Qwen3-8B"


@app.post("/summarize")
def summarize(req: SummarizeRequest):
    if req.model_id not in AVAILABLE_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {req.model_id}")
    try:
        content = _read_object(req.key)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read document: {e}")

    q: queue.Queue[str | None] = queue.Queue()

    def _run():
        try:
            for chunk in _summarize_stream(content, req.context_prompt, req.model_id):
                q.put(chunk)
        except Exception as exc:
            q.put(f"\n\n[ERROR: {exc}]")
        finally:
            q.put(None)
            _executor_lock.release()

    _executor_lock.acquire()
    threading.Thread(target=_run, daemon=True).start()

    def _stream():
        while True:
            chunk = q.get()
            if chunk is None:
                break
            yield chunk

    return StreamingResponse(_stream(), media_type="text/plain; charset=utf-8")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765)
