"""CLI entry point for great-minds.

Usage:
    great-minds compile --limit 50
    great-minds query "What is imperialism?"
    great-minds query                            # interactive mode
    great-minds ingest texts corpus/lenin/ --author "V.I. Lenin"
    great-minds serve --port 8000
"""

import argparse
import asyncio
import logging
import shutil
import uuid
from pathlib import Path

import uvicorn
from sqlalchemy import text

from great_minds.app.api.server import create_app
from great_minds.core import brain as brain_ops
from great_minds.core import ingester, pipeline, querier
from great_minds.core.db import session_maker
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.llm import get_async_client
from great_minds.core.storage import LocalStorage
from great_minds.core.telemetry import (
    emit_wide_event,
    init_wide_event,
    setup_logging,
)


def _make_storage() -> LocalStorage:
    return LocalStorage(Path.cwd())


async def _run_compile(brain_id: uuid.UUID, data_dir: Path) -> pipeline.CompileResult:
    storage = LocalStorage(data_dir / "brains" / str(brain_id))
    client = get_async_client()
    init_wide_event("compile", brain_id=str(brain_id))
    try:
        async with session_maker() as session:
            ctx = pipeline.build_context(
                brain_id=brain_id, storage=storage, session=session, client=client
            )
            return await pipeline.run(ctx)
    finally:
        emit_wide_event()


def cmd_compile(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds")
    result = asyncio.run(_run_compile(args.brain_id, Path(args.data_dir)))
    print("compile complete:")
    print(f"  raw chunks indexed:   {result.raw_chunks_indexed}")
    print(
        f"  docs extracted:       {result.docs_extracted} "
        f"({result.docs_failed} failed)"
    )
    print(f"  topics:               {result.topics}")
    print(
        f"  articles rendered:    {result.articles_rendered} "
        f"({result.articles_failed} failed)"
    )
    print(f"  wiki chunks indexed:  {result.wiki_chunks_indexed}")
    print(f"  backlink edges:       {result.backlink_edges}")
    print(f"  unresolved citations: {result.unresolved_citations}")
    print(f"  cost (USD):           ${result.cost_usd:.4f}")


async def _run_query(args: argparse.Namespace) -> None:
    storage = _make_storage()
    sources = [
        querier.QuerySource(storage=storage, label="local", brain_id=uuid.UUID(int=0))
    ]
    async with session_maker() as session:
        doc_repo = DocumentRepository(session)
        if args.question:
            question = " ".join(args.question)
            print(f"\n> {question}\n")
            result = await querier.run_query(
                sources, question, doc_repo, model=args.model
            )
            print(result.answer)
        else:
            await querier.run_interactive(sources, doc_repo, model=args.model)


def cmd_query(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds", json_output=args.json_logs)
    asyncio.run(_run_query(args))


def cmd_ingest(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds")
    storage = _make_storage()
    config = brain_ops.load_config(storage)
    path = Path(args.path)
    dest = args.dest or f"raw/{args.content_type}"

    kwargs = {}
    if args.author:
        kwargs["author"] = args.author
    if args.date:
        kwargs["date"] = args.date
    if args.origin:
        kwargs["origin"] = args.origin
    if args.url:
        kwargs["url"] = args.url
    if args.outlet:
        kwargs["outlet"] = args.outlet

    log = logging.getLogger(__name__)

    if path.is_file():
        result = ingester.ingest_file(
            storage, config, path, args.content_type, dest, **kwargs
        )
        log.info("ingested %s → %s", path, result)
    elif path.is_dir():
        source_files = sorted(path.rglob("*.md"))
        total = len(source_files)
        existing = set(storage.glob(f"{dest}/**/*.md"))
        log.info(
            "found %d .md files in %s (%d already ingested)", total, path, len(existing)
        )

        ingested = 0
        skipped = 0
        for i, filepath in enumerate(source_files):
            relative = filepath.relative_to(path)
            file_dest = f"{dest}/{relative}"

            if file_dest in existing:
                skipped += 1
                continue

            content = filepath.read_text(encoding="utf-8")
            ingester.ingest_document(
                storage, config, content, args.content_type, dest=file_dest, **kwargs
            )
            ingested += 1

            if (i + 1) % 100 == 0:
                log.info(
                    "progress: %d/%d (ingested=%d, skipped=%d)",
                    i + 1,
                    total,
                    ingested,
                    skipped,
                )

        log.info(
            "done — %d/%d files ingested to %s/, %d skipped",
            ingested,
            total,
            dest,
            skipped,
        )
    else:
        log.error("path not found: %s", path)


async def _run_reset(brain_id: str, brain_root: Path) -> None:
    log = logging.getLogger(__name__)

    async with session_maker() as session:
        # topic_membership, topic_links, topic_related, backlinks all cascade
        # from topics (they FK topic_id with ON DELETE CASCADE), so deleting
        # topics cleans them up automatically.
        tables = [
            "search_index",
            "tasks",
            "source_proposals",
            "topics",
            "idea_embeddings",
            "documents",
        ]
        for table in tables:
            result = await session.execute(
                text(f"DELETE FROM {table} WHERE brain_id = :bid"),
                {"bid": brain_id},
            )
            log.info("deleted %d rows from %s", result.rowcount, table)
        await session.commit()

    for subdir in ("raw", "wiki"):
        target = brain_root / subdir
        if target.exists():
            shutil.rmtree(target)
            target.mkdir()
            log.info("cleared %s", target)

    log.info("reset complete for brain %s", brain_id)


def cmd_reset(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds")

    brain_id = args.brain_id
    data_dir = Path(args.data_dir)
    brain_root = data_dir / "brains" / brain_id

    if not args.yes:
        print(f"This will delete ALL content for brain {brain_id}:")
        print(
            "  - Database: documents, search_index, backlinks, tasks, source_proposals"
        )
        print(f"  - Disk: {brain_root / 'raw'}, {brain_root / 'wiki'}")
        confirm = input("\nType 'yes' to continue: ")
        if confirm != "yes":
            print("Aborted.")
            return

    asyncio.run(_run_reset(brain_id, brain_root))


def cmd_serve(args: argparse.Namespace) -> None:
    if args.reload:
        uvicorn.run(
            "great_minds.app.api.server:create_app",
            factory=True,
            host=args.host,
            port=args.port,
            reload=True,
            reload_dirs=["src"],
        )
    else:
        uvicorn.run(create_app(), host=args.host, port=args.port)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="great-minds",
        description="LLM-powered research knowledge base",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # compile
    p_compile = subparsers.add_parser(
        "compile", help="Compile raw texts into wiki articles"
    )
    p_compile.add_argument(
        "brain_id", type=uuid.UUID, help="UUID of the brain to compile"
    )
    p_compile.add_argument(
        "--data-dir", default="/data", help="Data directory (default: /data)"
    )
    p_compile.set_defaults(func=cmd_compile)

    # query
    p_query = subparsers.add_parser("query", help="Query the knowledge base")
    p_query.add_argument(
        "question", nargs="*", help="Question (omit for interactive mode)"
    )
    p_query.add_argument("--model", default=None, help="Override the default model")
    p_query.add_argument(
        "--json-logs", action="store_true", help="Structured JSON logs to stderr"
    )
    p_query.set_defaults(func=cmd_query)

    # ingest
    p_ingest = subparsers.add_parser(
        "ingest", help="Ingest documents into the knowledge base"
    )
    p_ingest.add_argument("content_type", help="Content type (texts, news, ideas)")
    p_ingest.add_argument("path", help="File or directory to ingest")
    p_ingest.add_argument("--dest", help="Destination directory (default: raw/<type>/)")
    p_ingest.add_argument("--author", help="Author name")
    p_ingest.add_argument("--date", help="Publication date")
    p_ingest.add_argument("--origin", help="Publication or organization name")
    p_ingest.add_argument("--url", help="Source URL")
    p_ingest.add_argument("--outlet", help="News outlet (for news type)")
    p_ingest.set_defaults(func=cmd_ingest)

    # reset
    p_reset = subparsers.add_parser(
        "reset", help="Wipe all content for a brain (keeps brain and user accounts)"
    )
    p_reset.add_argument("brain_id", help="UUID of the brain to reset")
    p_reset.add_argument(
        "--data-dir", default="/data", help="Data directory (default: /data)"
    )
    p_reset.add_argument(
        "-y", "--yes", action="store_true", help="Skip confirmation prompt"
    )
    p_reset.set_defaults(func=cmd_reset)

    # serve
    p_serve = subparsers.add_parser("serve", help="Start the API server")
    p_serve.add_argument(
        "--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)"
    )
    p_serve.add_argument(
        "--port", type=int, default=8000, help="Bind port (default: 8000)"
    )
    p_serve.add_argument(
        "--reload", action="store_true", help="Auto-reload on source changes (dev only)"
    )
    p_serve.set_defaults(func=cmd_serve)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
