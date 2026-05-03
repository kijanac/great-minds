"""Converter sidecar — FastAPI app exposing the agentic converter.

Start with:  fastapi dev converter_sidecar/main.py  (or `fastapi dev` if
entrypoint is in pyproject.toml).
"""

import logging
from typing import Annotated

from fastapi import FastAPI, HTTPException
from openai import AsyncOpenAI

from converter_sidecar.agent import run_conversion
from converter_sidecar.schemas import (
    ConvertRequest,
    ConvertResponse,
    RecipeInfo,
    ToolInfo,
)
from converter_sidecar.tools import TOOLS

log = logging.getLogger(__name__)

app = FastAPI(
    title="Converter Sidecar",
    description="Agentic content-to-markdown converter for Great Minds",
    version="0.1.0",
)


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------


def _get_client() -> AsyncOpenAI:
    # In production, read OPENAI_API_KEY / OPENAI_BASE_URL from env.
    # This mirrors whatever the main Great Minds app uses.
    import os

    return AsyncOpenAI(
        api_key=os.environ.get("OPENAI_API_KEY", ""),
        base_url=os.environ.get("OPENAI_BASE_URL", None),
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.post("/convert")
async def convert(request: ConvertRequest) -> ConvertResponse:
    """Convert content to markdown using the agentic pipeline.

    The agent will plan and execute tool calls based on the goal.
    Returns the converted files + a trace of what happened.
    """
    client = _get_client()
    try:
        return await run_conversion(request, client)
    except Exception as e:
        log.exception("conversion failed")
        raise HTTPException(status_code=500, detail=f"Conversion failed: {e}")


@app.get("/tools")
async def list_tools() -> list[ToolInfo]:
    """List available tools and their schemas. Useful for debugging
    and for the main app to know what the sidecar can do.
    """
    return [
        ToolInfo(name=name, description=schema["description"], parameters=schema["parameters"])
        for name, (_, schema) in TOOLS.items()
    ]


@app.get("/recipes")
async def list_recipes() -> list[RecipeInfo]:
    """List known scraping recipes (stub — would load from a recipe store)."""
    return []


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
