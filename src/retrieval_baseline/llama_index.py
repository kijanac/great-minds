"""
LlamaIndex retrieval baseline for great-minds document corpus.

Commands:
    index   — load documents from DOCS_DIR and build/save a VectorStoreIndex
    query   — load the saved index and answer questions interactively or once

Recommended workflow for large corpora:
    1. uv run python -m retrieval_baseline.preprocess_docs   # convert PDFs/DOCX once
    2. uv run python -m retrieval_baseline.llama_index index  # uses cache, much faster

Usage:
    uv run python -m retrieval_baseline.llama_index index [OPTIONS]
    uv run python -m retrieval_baseline.llama_index query  "your question here" [OPTIONS]
    uv run python -m retrieval_baseline.llama_index query  [OPTIONS]   # interactive mode

Document types handled automatically:
    Plain text / Markdown  — read directly by SimpleDirectoryReader
    .docx / .doc           — converted via markitdown
    .pdf                   — converted via markitdown
    .pptx / .ppt           — converted via markitdown
    .xlsx / .xls           — converted via markitdown
"""

from __future__ import annotations

import argparse
import os
import sys

# Suppress ONNX Runtime pthread_setaffinity_np warnings in restricted CPU environments
# (containers, cgroups). OMP_NUM_THREADS only controls OpenMP; ONNX Runtime uses its own
# Eigen thread pool. Setting logger severity to FATAL (4) suppresses the [E:] affinity
# messages before any model is loaded. Must happen before llama-index imports onnxruntime.
os.environ.setdefault("OMP_NUM_THREADS", "1")
try:
    import onnxruntime as ort

    ort.set_default_logger_severity(4)
except ImportError:
    pass
import time
from pathlib import Path
from typing import Any, Optional

from tqdm import tqdm

DEFAULT_DOCS_DIR = "/data/scratch-fast/bzl/great-minds-datasets"
DEFAULT_INDEX_DIR = "/data/scratch-fast/bzl/great-minds-datasets/.llama_index"
DEFAULT_FAISS_INDEX_DIR = (
    "/data/scratch-fast/bzl/great-minds-datasets/.llama_index_faiss"
)
DEFAULT_EMBED_PROVIDER = "huggingface"
DEFAULT_OPENAI_EMBED_MODEL = "text-embedding-3-small"
DEFAULT_HF_EMBED_MODEL = "BAAI/bge-small-en-v1.5"
DEFAULT_EMBED_MODEL = DEFAULT_HF_EMBED_MODEL
DEFAULT_LLM_MODEL = "gpt-4o-mini"
DEFAULT_CHUNK_SIZE = 1024
DEFAULT_CHUNK_OVERLAP = 128
DEFAULT_SIMILARITY_TOP_K = 5

# Embedding dimensions for known models — required when creating a new FAISS index.
EMBED_DIMS: dict[str, int] = {
    "BAAI/bge-small-en-v1.5": 384,
    "BAAI/bge-base-en-v1.5": 768,
    "BAAI/bge-large-en-v1.5": 1024,
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
}
DEFAULT_EMBED_DIM = EMBED_DIMS[DEFAULT_HF_EMBED_MODEL]  # 384

# Extensions routed through markitdown instead of SimpleDirectoryReader's defaults.
MARKITDOWN_EXTENSIONS = {".docx", ".doc", ".pdf", ".pptx", ".ppt", ".xlsx", ".xls"}


# ---------------------------------------------------------------------------
# Markitdown reader
# ---------------------------------------------------------------------------


def _cache_path_for(file: Path, cache_dir: Path) -> Path:
    """Stable cache path: <cache_dir>/<stem>_<sha256[:12]>.md"""
    import hashlib

    digest = hashlib.sha256(str(file.resolve()).encode()).hexdigest()[:12]
    return cache_dir / f"{file.stem}_{digest}.md"


class MarkitdownReader:
    """LlamaIndex-compatible file reader that converts rich documents to text via markitdown.

    If cache_dir is set, pre-converted .md files written by preprocess_docs.py are used
    directly, skipping markitdown entirely for already-processed files. The converter is
    initialized lazily so that this object remains picklable.
    """

    def __init__(self, cache_dir: Optional[Path] = None) -> None:
        self._cache_dir = cache_dir

    def load_data(
        self,
        file: Path,
        extra_info: Optional[dict[str, Any]] = None,
    ) -> list:
        from llama_index.core.schema import Document

        text = self._read_cache(file)
        if text is None:
            if not hasattr(self, "_converter"):
                from markitdown import MarkItDown

                self._converter = MarkItDown()
            t0 = time.perf_counter()
            result = self._converter.convert(str(file))
            elapsed = time.perf_counter() - t0
            if elapsed > 2.0:
                print(
                    f"  [slow] {file.name} took {elapsed:.1f}s to convert", flush=True
                )
            text = result.text_content or ""
            self._write_cache(file, text)

        metadata: dict[str, Any] = {"file_path": str(file), "file_name": file.name}
        if extra_info:
            metadata.update(extra_info)
        return [Document(text=text, metadata=metadata)]

    def _read_cache(self, file: Path) -> Optional[str]:
        if self._cache_dir is None:
            return None
        cp = _cache_path_for(file, self._cache_dir)
        if not cp.exists():
            return None
        if cp.stat().st_mtime < file.stat().st_mtime:
            return None  # source file is newer — stale cache
        return cp.read_text(encoding="utf-8")

    def _write_cache(self, file: Path, text: str) -> None:
        if self._cache_dir is None:
            return
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        try:
            _cache_path_for(file, self._cache_dir).write_text(text, encoding="utf-8")
        except OSError as exc:
            print(
                f"  [warn] could not write cache for {file.name}: {exc}",
                file=sys.stderr,
            )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_service_context(
    embed_model: str,
    embed_provider: str,
    llm_model: str,
    chunk_size: int,
    chunk_overlap: int,
):
    """Configure LlamaIndex global Settings and return them."""
    from llama_index.core import Settings as LISettings
    from llama_index.core.node_parser import SentenceSplitter
    from llama_index.llms.openai import OpenAI

    LISettings.llm = OpenAI(model=llm_model)

    if embed_provider == "huggingface":
        import torch
        from llama_index.embeddings.huggingface import HuggingFaceEmbedding

        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Using HuggingFace embedding model: {embed_model} (device={device})")
        LISettings.embed_model = HuggingFaceEmbedding(
            model_name=embed_model, device=device
        )
    else:
        from llama_index.embeddings.openai import OpenAIEmbedding

        print(f"Using OpenAI embedding model: {embed_model}")
        LISettings.embed_model = OpenAIEmbedding(model=embed_model)

    LISettings.node_parser = SentenceSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
    )
    return LISettings


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

FAISS_STORE_FILE = "vector_store.faiss"


def _check_faiss_mismatch(index_dir: Path, want_faiss: bool) -> None:
    """Abort with a clear message if --faiss flag doesn't match the persisted store."""
    has_faiss = (index_dir / FAISS_STORE_FILE).exists()
    if want_faiss and not has_faiss:
        print(
            f"[error] --faiss was set but the existing index at {index_dir} was built without FAISS.\n"
            "Re-run 'index' without --faiss to query it, or delete the index and rebuild with --faiss.",
            file=sys.stderr,
        )
        sys.exit(1)
    if not want_faiss and has_faiss:
        print(
            f"[error] The existing index at {index_dir} was built with --faiss but --faiss was not set.\n"
            "Add --faiss to your command, or delete the index and rebuild without it.",
            file=sys.stderr,
        )
        sys.exit(1)


# ---------------------------------------------------------------------------
# Index command
# ---------------------------------------------------------------------------


def _get_nodes_timed(node_parser, documents: list) -> list:
    """Parse documents into nodes one at a time, printing timing for slow ones.

    Running per-document rather than in one batch makes it obvious which file
    is hanging (very large text, degenerate content, tiktoken cold-start, etc.).
    """
    nodes = []
    for doc in documents:
        fname = doc.metadata.get("file_name", doc.metadata.get("file_path", "?"))
        chars = len(doc.text)
        if chars > 500_000:
            print(f"  Parsing {fname} ({chars:,} chars) … ", end="", flush=True)
            breakpoint()
        t0 = time.perf_counter()
        # try:
        doc_nodes = node_parser.get_nodes_from_documents([doc])
        # except:
        #     breakpoint()
        elapsed = time.perf_counter() - t0
        if elapsed > 2.0:
            print(
                f"  [slow parse] {fname}  {chars:,} chars → {len(doc_nodes)} nodes  ({elapsed:.1f}s)",
                flush=True,
            )
        nodes.extend(doc_nodes)
    return nodes


def cmd_index(args: argparse.Namespace) -> None:
    docs_dir = Path(args.docs_dir)
    index_dir = Path(
        args.index_dir or (DEFAULT_FAISS_INDEX_DIR if args.faiss else DEFAULT_INDEX_DIR)
    )

    if not docs_dir.exists():
        print(f"[error] docs_dir does not exist: {docs_dir}", file=sys.stderr)
        sys.exit(1)

    from llama_index.core import (
        SimpleDirectoryReader,
        VectorStoreIndex,
        load_index_from_storage,
    )
    from llama_index.core.storage import StorageContext

    li_settings = _build_service_context(
        embed_model=args.embed_model,
        embed_provider=args.embed_provider,
        llm_model=args.llm_model,
        chunk_size=args.chunk_size,
        chunk_overlap=args.chunk_overlap,
    )

    cache_dir = Path(args.preprocess_cache) if args.preprocess_cache else None
    if cache_dir and cache_dir.exists():
        print(f"Using preprocess cache: {cache_dir}")
    _md_reader = MarkitdownReader(cache_dir=cache_dir)
    file_extractor = {ext: _md_reader for ext in MARKITDOWN_EXTENSIONS}

    EXCLUDE_SUFFIXES = {".mp3", ".mp4", ".wav", ".m4a", ".ogg", ".flac", ".zip"}
    all_files = sorted(
        f
        for f in docs_dir.rglob("*")
        if f.is_file()
        and not any(part.startswith(".") for part in f.relative_to(docs_dir).parts)
        and f.suffix.lower() not in EXCLUDE_SUFFIXES
    )
    total = len(all_files)
    print(f"Found {total} file(s) to index.")

    index_dir.mkdir(parents=True, exist_ok=True)

    # Resume from existing index if present, otherwise start fresh.
    if (index_dir / "docstore.json").exists():
        _check_faiss_mismatch(index_dir, args.faiss)
        print(f"Resuming existing index at: {index_dir}")
        if args.faiss:
            from llama_index.vector_stores.faiss import FaissVectorStore

            storage_context = StorageContext.from_defaults(
                persist_dir=str(index_dir),
                vector_store=FaissVectorStore.from_persist_dir(str(index_dir)),
            )
        else:
            storage_context = StorageContext.from_defaults(persist_dir=str(index_dir))
        index = load_index_from_storage(storage_context)
        already_indexed = {
            doc.metadata.get("file_path")
            for doc in tqdm(
                index.docstore.docs.values(), desc="Checking existing index", unit="doc"
            )
        }
        all_files = [
            f
            for f in tqdm(all_files, desc="Filtering files", unit="file")
            if str(f) not in already_indexed
        ]
        if not all_files:
            print("All files already indexed. Nothing to do.")
            return
        print(
            f"{len(already_indexed)} file(s) already indexed; {len(all_files)} new file(s) to add."
        )
    else:
        if args.faiss:
            import faiss as _faiss
            from llama_index.vector_stores.faiss import FaissVectorStore

            embed_dim = args.embed_dim or EMBED_DIMS.get(args.embed_model)
            if embed_dim is None:
                print(
                    f"[warn] Unknown embed model {args.embed_model!r}; defaulting to dim={DEFAULT_EMBED_DIM}. "
                    "Use --embed-dim to override.",
                    file=sys.stderr,
                )
                embed_dim = DEFAULT_EMBED_DIM
            storage_context = StorageContext.from_defaults(
                vector_store=FaissVectorStore(faiss_index=_faiss.IndexFlatL2(embed_dim))
            )
        else:
            storage_context = None
        index = None

    total = len(all_files)
    batch_size = args.batch_size
    for batch_start in tqdm(
        range(0, total, batch_size), desc="Indexing batches", unit="batch"
    ):
        batch_files = all_files[batch_start : batch_start + batch_size]
        batch_end = min(batch_start + batch_size, total)
        print(f"  Batch {batch_start + 1}–{batch_end} / {total} …")

        reader = SimpleDirectoryReader(
            input_files=[
                str(f) for f in tqdm(batch_files, desc="Loading files", unit="file")
            ],
            file_extractor=file_extractor,
        )
        try:
            documents = reader.load_data(show_progress=True)
        except Exception as exc:
            print(f"  [warn] batch failed to load: {exc}", file=sys.stderr)
            continue

        if not documents:
            continue

        nodes = _get_nodes_timed(li_settings.node_parser, documents)

        if index is None:
            kwargs = (
                {"storage_context": storage_context}
                if storage_context is not None
                else {}
            )
            index = VectorStoreIndex(nodes, show_progress=True, **kwargs)
        else:
            index.insert_nodes(nodes, show_progress=True)

        index.storage_context.persist(persist_dir=str(index_dir))
        if args.faiss:
            # StorageContext.persist() writes FAISS binary to default__vector_store.json
            # (wrong name). Also write to vector_store.faiss so _check_faiss_mismatch
            # and FaissVectorStore.from_persist_dir() can find it.
            index.storage_context.vector_store.persist(
                str(index_dir / FAISS_STORE_FILE)
            )

    print(f"Index saved to: {index_dir}")


# ---------------------------------------------------------------------------
# Query command
# ---------------------------------------------------------------------------


def cmd_query(args: argparse.Namespace) -> None:
    index_dir = Path(
        args.index_dir or (DEFAULT_FAISS_INDEX_DIR if args.faiss else DEFAULT_INDEX_DIR)
    )

    if not index_dir.exists():
        print(
            f"[error] index_dir does not exist: {index_dir}\n"
            "Run the 'index' command first.",
            file=sys.stderr,
        )
        sys.exit(1)

    _check_faiss_mismatch(index_dir, args.faiss)

    from llama_index.core import load_index_from_storage
    from llama_index.core.storage import StorageContext

    _build_service_context(
        embed_model=args.embed_model,
        embed_provider=args.embed_provider,
        llm_model=args.llm_model,
        chunk_size=args.chunk_size,
        chunk_overlap=args.chunk_overlap,
    )

    if args.faiss:
        from llama_index.vector_stores.faiss import FaissVectorStore

        storage_context = StorageContext.from_defaults(
            persist_dir=str(index_dir),
            vector_store=FaissVectorStore.from_persist_dir(str(index_dir)),
        )
    else:
        storage_context = StorageContext.from_defaults(persist_dir=str(index_dir))
    n_docs = len(storage_context.docstore.docs)
    print(f"Loading index ({n_docs} nodes) from: {index_dir} …")
    t0 = time.perf_counter()
    index = load_index_from_storage(storage_context)
    print(f"Index loaded in {time.perf_counter() - t0:.1f}s")

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
        default=None,
        help=(
            f"Directory where the index is stored "
            f"(default without --faiss: {DEFAULT_INDEX_DIR}, "
            f"default with --faiss: {DEFAULT_FAISS_INDEX_DIR})"
        ),
    )
    parent.add_argument(
        "--embed-provider",
        default=os.environ.get("LLAMA_EMBED_PROVIDER", DEFAULT_EMBED_PROVIDER),
        choices=["openai", "huggingface"],
        help=f"Embedding provider (default: {DEFAULT_EMBED_PROVIDER})",
    )
    parent.add_argument(
        "--embed-model",
        default=os.environ.get("LLAMA_EMBED_MODEL", DEFAULT_EMBED_MODEL),
        help=(
            f"Embedding model name — HuggingFace repo (default: {DEFAULT_HF_EMBED_MODEL}) "
            f"or OpenAI model when --embed-provider=openai (default: {DEFAULT_OPENAI_EMBED_MODEL})"
        ),
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
    parent.add_argument(
        "--faiss",
        action="store_true",
        help="Use a FAISS vector store (binary, faster load) instead of the default JSON store",
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
    p_index.add_argument(
        "--batch-size",
        type=int,
        default=200,
        help="Number of files to load and embed per batch (default: 200)",
    )
    p_index.add_argument(
        "--preprocess-cache",
        default=os.path.join(
            os.environ.get("LLAMA_DOCS_DIR", DEFAULT_DOCS_DIR), ".markitdown_cache"
        ),
        help="Directory of pre-converted .md files produced by preprocess_docs.py (default: <docs-dir>/.markitdown_cache)",
    )
    p_index.add_argument(
        "--embed-dim",
        type=int,
        default=None,
        help=(
            "Embedding vector dimension for the FAISS index. "
            f"Auto-detected from --embed-model for known models (e.g. {DEFAULT_HF_EMBED_MODEL}={DEFAULT_EMBED_DIM}). "
            "Required only when using a custom model not in the built-in lookup."
        ),
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
