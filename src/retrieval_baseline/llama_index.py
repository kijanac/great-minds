"""
LlamaIndex retrieval baseline for great-minds document corpus.

Commands:
    index   — load documents from DOCS_DIR and build/save a VectorStoreIndex
    query   — load the saved index and answer questions interactively or once

Usage:
    uv run python -m retrieval_baseline.llama_index index [OPTIONS]
    uv run python -m retrieval_baseline.llama_index query  "your question here" [OPTIONS]
    uv run python -m retrieval_baseline.llama_index query  [OPTIONS]   # interactive mode
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

DEFAULT_DOCS_DIR = "/data/scratch-fast/bzl/great-minds-datasets"
DEFAULT_INDEX_DIR = "/data/scratch-fast/bzl/great-minds-datasets/.llama_index"
DEFAULT_EMBED_MODEL = "text-embedding-3-small"
DEFAULT_LLM_MODEL = "gpt-4o-mini"
DEFAULT_CHUNK_SIZE = 1024
DEFAULT_CHUNK_OVERLAP = 128
DEFAULT_SIMILARITY_TOP_K = 5


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_service_context(
    embed_model: str,
    llm_model: str,
    chunk_size: int,
    chunk_overlap: int,
):
    """Return (llm, embed_model, node_parser) after lazy-importing llama_index."""
    from llama_index.core import Settings as LISettings
    from llama_index.core.node_parser import SentenceSplitter
    from llama_index.embeddings.openai import OpenAIEmbedding
    from llama_index.llms.openai import OpenAI

    LISettings.llm = OpenAI(model=llm_model)
    LISettings.embed_model = OpenAIEmbedding(model=embed_model)
    LISettings.node_parser = SentenceSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
    )
    return LISettings


# ---------------------------------------------------------------------------
# Index command
# ---------------------------------------------------------------------------


def cmd_index(args: argparse.Namespace) -> None:
    docs_dir = Path(args.docs_dir)
    index_dir = Path(args.index_dir)

    if not docs_dir.exists():
        print(f"[error] docs_dir does not exist: {docs_dir}", file=sys.stderr)
        sys.exit(1)

    from llama_index.core import SimpleDirectoryReader, VectorStoreIndex
    from llama_index.core.storage import StorageContext

    _build_service_context(
        embed_model=args.embed_model,
        llm_model=args.llm_model,
        chunk_size=args.chunk_size,
        chunk_overlap=args.chunk_overlap,
    )

    print(f"Loading documents from: {docs_dir}")
    reader = SimpleDirectoryReader(
        input_dir=str(docs_dir),
        recursive=True,
        exclude_hidden=True,
    )
    documents = reader.load_data()
    print(f"Loaded {len(documents)} document(s).")

    print("Building VectorStoreIndex …")
    index = VectorStoreIndex.from_documents(documents, show_progress=True)

    index_dir.mkdir(parents=True, exist_ok=True)
    index.storage_context.persist(persist_dir=str(index_dir))
    print(f"Index saved to: {index_dir}")


# ---------------------------------------------------------------------------
# Query command
# ---------------------------------------------------------------------------


def cmd_query(args: argparse.Namespace) -> None:
    index_dir = Path(args.index_dir)

    if not index_dir.exists():
        print(
            f"[error] index_dir does not exist: {index_dir}\n"
            "Run the 'index' command first.",
            file=sys.stderr,
        )
        sys.exit(1)

    from llama_index.core import load_index_from_storage
    from llama_index.core.storage import StorageContext

    _build_service_context(
        embed_model=args.embed_model,
        llm_model=args.llm_model,
        chunk_size=args.chunk_size,
        chunk_overlap=args.chunk_overlap,
    )

    print(f"Loading index from: {index_dir}")
    storage_context = StorageContext.from_defaults(persist_dir=str(index_dir))
    index = load_index_from_storage(storage_context)

    query_engine = index.as_query_engine(
        similarity_top_k=args.top_k,
        response_mode=args.response_mode,
        verbose=args.verbose,
    )

    def _run_query(question: str) -> None:
        response = query_engine.query(question)
        print("\n--- Answer ---")
        print(str(response))
        if args.show_sources:
            print("\n--- Sources ---")
            for i, node in enumerate(response.source_nodes, 1):
                meta = node.metadata
                score = getattr(node, "score", None)
                fname = meta.get("file_name", meta.get("source", "unknown"))
                score_str = f"  (score={score:.4f})" if score is not None else ""
                print(f"[{i}] {fname}{score_str}")
                if args.verbose:
                    print(f"    {node.get_content()[:300].strip()} …")
        print()

    if args.question:
        _run_query(args.question)
    else:
        print("Interactive mode — type 'quit' or press Ctrl-D to exit.\n")
        while True:
            try:
                question = input("Query> ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break
            if not question:
                continue
            if question.lower() in {"quit", "exit", "q"}:
                break
            _run_query(question)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parent = argparse.ArgumentParser(add_help=False)
    parent.add_argument(
        "--index-dir",
        default=os.environ.get("LLAMA_INDEX_DIR", DEFAULT_INDEX_DIR),
        help=f"Directory where the index is stored (default: {DEFAULT_INDEX_DIR})",
    )
    parent.add_argument(
        "--embed-model",
        default=os.environ.get("LLAMA_EMBED_MODEL", DEFAULT_EMBED_MODEL),
        help=f"OpenAI embedding model (default: {DEFAULT_EMBED_MODEL})",
    )
    parent.add_argument(
        "--llm-model",
        default=os.environ.get("LLAMA_LLM_MODEL", DEFAULT_LLM_MODEL),
        help=f"OpenAI LLM model (default: {DEFAULT_LLM_MODEL})",
    )
    parent.add_argument(
        "--chunk-size",
        type=int,
        default=DEFAULT_CHUNK_SIZE,
        help=f"Node chunk size in tokens (default: {DEFAULT_CHUNK_SIZE})",
    )
    parent.add_argument(
        "--chunk-overlap",
        type=int,
        default=DEFAULT_CHUNK_OVERLAP,
        help=f"Node chunk overlap in tokens (default: {DEFAULT_CHUNK_OVERLAP})",
    )

    parser = argparse.ArgumentParser(
        prog="llama_index",
        description="LlamaIndex retrieval baseline",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # --- index ---
    p_index = sub.add_parser("index", parents=[parent], help="Build and save the index")
    p_index.add_argument(
        "--docs-dir",
        default=os.environ.get("LLAMA_DOCS_DIR", DEFAULT_DOCS_DIR),
        help=f"Directory containing source documents (default: {DEFAULT_DOCS_DIR})",
    )

    # --- query ---
    p_query = sub.add_parser("query", parents=[parent], help="Query the saved index")
    p_query.add_argument(
        "question",
        nargs="?",
        default=None,
        help="Question to answer (omit for interactive mode)",
    )
    p_query.add_argument(
        "--top-k",
        type=int,
        default=DEFAULT_SIMILARITY_TOP_K,
        help=f"Number of retrieved nodes (default: {DEFAULT_SIMILARITY_TOP_K})",
    )
    p_query.add_argument(
        "--response-mode",
        default="compact",
        choices=["compact", "refine", "tree_summarize", "simple_summarize", "no_text"],
        help="LlamaIndex response synthesis mode (default: compact)",
    )
    p_query.add_argument(
        "--show-sources",
        action="store_true",
        help="Print source node metadata alongside the answer",
    )
    p_query.add_argument(
        "--verbose",
        action="store_true",
        help="Print extra debug information",
    )

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "index":
        cmd_index(args)
    elif args.command == "query":
        cmd_query(args)


if __name__ == "__main__":
    main()
