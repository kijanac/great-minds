"""CLI entry point for great-minds.

Usage:
    great-minds compile --limit 50
    great-minds query "What is imperialism?"
    great-minds query                            # interactive mode
    great-minds ingest texts corpus/lenin/ --author "V.I. Lenin"
    great-minds lint --deep --fix
    great-minds serve --port 8000
"""

import argparse
import asyncio
import logging
import shutil
import uuid
from functools import partial
from pathlib import Path

import uvicorn
from sqlalchemy import text

from great_minds.app.api.server import create_app
from great_minds.core import brain as brain_ops
from great_minds.core import querier
from great_minds.core import compiler, ingester, linter
from great_minds.core.db import session_maker
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.storage import LocalStorage
from great_minds.core.telemetry import setup_logging


def _make_storage() -> LocalStorage:
    return LocalStorage(Path.cwd())


def cmd_compile(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds")
    storage = _make_storage()
    asyncio.run(
        compiler.run(storage, partial(brain_ops.load_prompt, storage), limit=args.limit)
    )


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
            answer = await querier.run_query(
                sources, question, doc_repo, model=args.model
            )
            print(answer)
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


def cmd_lint(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds")
    storage = _make_storage()
    log = logging.getLogger(__name__)
    result = asyncio.run(linter.run_lint(storage, deep=args.deep, fix=args.fix))
    if result.fixes_applied:
        log.info("applied %d fixes:", len(result.fixes_applied))
        for f in result.fixes_applied:
            log.info("  %s — %s", f.file, f.description)
    log.info("%d issues remaining", result.remaining_issues)
    if result.research_suggestions:
        log.info("")
        log.info("research suggestions:")
        for s in result.research_suggestions:
            log.info(
                "  '%s' is mentioned %d times but has no wiki article",
                s.tag,
                s.usage_count,
            )


async def _run_reset(brain_id: str, brain_root: Path) -> None:
    log = logging.getLogger(__name__)

    async with session_maker() as session:
        tables = [
            "search_index",
            "backlinks",
            "tasks",
            "source_proposals",
            "document_tags",
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
    setup_logging(service="great-minds")
    app = create_app()
    uvicorn.run(app, host=args.host, port=args.port)


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
        "--limit", type=int, default=None, help="Max documents to compile"
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

    # lint
    p_lint = subparsers.add_parser("lint", help="Lint the knowledge base")
    p_lint.add_argument(
        "--deep", action="store_true", help="Include LLM checks (costs money)"
    )
    p_lint.add_argument("--fix", action="store_true", help="Auto-fix resolvable issues")
    p_lint.set_defaults(func=cmd_lint)

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
    p_serve.set_defaults(func=cmd_serve)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
