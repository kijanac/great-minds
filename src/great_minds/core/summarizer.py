"""Local model summarization using HuggingFace transformers.

The model is lazy-loaded on first use. CUDA_VISIBLE_DEVICES must be set
in the environment before torch is imported (i.e. at process startup).
"""

from __future__ import annotations

import queue
import threading
from typing import Iterator

AVAILABLE_MODELS: dict[str, str] = {
    "Qwen/Qwen3-8B": "Qwen/Qwen3-8B",
}

_lock = threading.Lock()
_loaded: dict[str, tuple] = {}  # model_id -> (model, tokenizer)


def _load(model_id: str):
    with _lock:
        if model_id not in _loaded:
            from transformers import AutoModelForCausalLM, AutoTokenizer

            tokenizer = AutoTokenizer.from_pretrained(model_id)
            model = AutoModelForCausalLM.from_pretrained(
                model_id,
                torch_dtype="auto",
                device_map="auto",
            )
            _loaded[model_id] = (model, tokenizer)
    return _loaded[model_id]


def summarize_stream(
    document: str,
    context_prompt: str,
    model_id: str = "Qwen/Qwen3-8B",
    max_new_tokens: int = 2048,
) -> Iterator[str]:
    """Yield text chunks as the model generates a summary.

    Runs generation in a background thread so callers can iterate
    without blocking an asyncio event loop.
    """
    model, tokenizer = _load(model_id)

    system = context_prompt.strip() or "Summarize the following document concisely."
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": document},
    ]
    text = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    inputs = tokenizer([text], return_tensors="pt").to(model.device)

    from transformers import TextIteratorStreamer

    streamer = TextIteratorStreamer(
        tokenizer, skip_prompt=True, skip_special_tokens=True
    )

    gen_kwargs = {**inputs, "max_new_tokens": max_new_tokens, "streamer": streamer}

    # Run generation in a thread; yield from streamer in caller thread
    t = threading.Thread(target=model.generate, kwargs=gen_kwargs, daemon=True)
    t.start()

    for chunk in streamer:
        yield chunk

    t.join()


def summarize_stream_async(
    document: str,
    context_prompt: str,
    model_id: str = "Qwen/Qwen3-8B",
    max_new_tokens: int = 2048,
) -> Iterator[str]:
    """Queue-based bridge for running summarize_stream from an async context.

    Puts chunks into a queue from a background thread; caller drains the queue.
    Use with asyncio.get_event_loop().run_in_executor to pop items.
    """
    q: queue.Queue[str | None] = queue.Queue()

    def _run():
        try:
            for chunk in summarize_stream(document, context_prompt, model_id, max_new_tokens):
                q.put(chunk)
        finally:
            q.put(None)

    threading.Thread(target=_run, daemon=True).start()

    while True:
        item = q.get()
        if item is None:
            break
        yield item
