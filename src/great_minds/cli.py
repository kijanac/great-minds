"""CLI entry point for great-minds.

Usage:
    great-minds compile --limit 50
    great-minds query "What is imperialism?"
    great-minds query                            # interactive mode
    great-minds ingest texts corpus/lenin/ --author "V.I. Lenin"
    great-minds lint --deep
    great-minds serve --port 8000
"""

import argparse
import asyncio
import logging
from pathlib import Path

import uvicorn

from .brain import Brain
from .server import create_app
from .storage import LocalStorage
from .telemetry import setup_logging


def _make_brain() -> Brain:
    return Brain(LocalStorage(Path.cwd()))


def cmd_compile(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds")
    brain = _make_brain()
    asyncio.run(brain.compile(limit=args.limit))


def cmd_query(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds", json_output=args.json_logs)
    brain = _make_brain()
    if args.question:
        question = " ".join(args.question)
        print(f"\n> {question}\n")
        answer = brain.query(question, model=args.model)
        print(answer)
    else:
        brain.query_interactive(model=args.model)


def cmd_ingest(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds")
    brain = _make_brain()
    path = Path(args.path)
    dest = args.dest or f"raw/{args.content_type}"

    kwargs = {}
    if args.author:
        kwargs["author"] = args.author
    if args.date:
        kwargs["date"] = args.date
    if args.source:
        kwargs["source"] = args.source
    if args.outlet:
        kwargs["outlet"] = args.outlet

    log = logging.getLogger(__name__)

    if path.is_file():
        result = brain.ingest_file(path, args.content_type, dest, **kwargs)
        log.info("ingested %s → %s", path, result)
    elif path.is_dir():
        processed, skipped = brain.ingest_directory(
            path, args.content_type, dest, **kwargs
        )
        log.info("done — %d files ingested to %s/, %d skipped", processed, dest, skipped)
    else:
        log.error("path not found: %s", path)


def cmd_lint(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds")
    brain = _make_brain()
    brain.lint(deep=args.deep)


def cmd_serve(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds")
    app = create_app(_make_brain())
    uvicorn.run(app, host=args.host, port=args.port)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="great-minds",
        description="LLM-powered research knowledge base",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # compile
    p_compile = subparsers.add_parser("compile", help="Compile raw texts into wiki articles")
    p_compile.add_argument("--limit", type=int, default=None, help="Max documents to compile")
    p_compile.set_defaults(func=cmd_compile)

    # query
    p_query = subparsers.add_parser("query", help="Query the knowledge base")
    p_query.add_argument("question", nargs="*", help="Question (omit for interactive mode)")
    p_query.add_argument("--model", default=None, help="Override the default model")
    p_query.add_argument("--json-logs", action="store_true", help="Structured JSON logs to stderr")
    p_query.set_defaults(func=cmd_query)

    # ingest
    p_ingest = subparsers.add_parser("ingest", help="Ingest documents into the knowledge base")
    p_ingest.add_argument("content_type", help="Content type (texts, news, ideas)")
    p_ingest.add_argument("path", help="File or directory to ingest")
    p_ingest.add_argument("--dest", help="Destination directory (default: raw/<type>/)")
    p_ingest.add_argument("--author", help="Author name")
    p_ingest.add_argument("--date", help="Publication date")
    p_ingest.add_argument("--source", help="Source URL")
    p_ingest.add_argument("--outlet", help="News outlet (for news type)")
    p_ingest.set_defaults(func=cmd_ingest)

    # lint
    p_lint = subparsers.add_parser("lint", help="Lint the knowledge base")
    p_lint.add_argument("--deep", action="store_true", help="Include LLM checks (costs money)")
    p_lint.set_defaults(func=cmd_lint)

    # serve
    p_serve = subparsers.add_parser("serve", help="Start the API server")
    p_serve.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    p_serve.add_argument("--port", type=int, default=8000, help="Bind port (default: 8000)")
    p_serve.set_defaults(func=cmd_serve)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
