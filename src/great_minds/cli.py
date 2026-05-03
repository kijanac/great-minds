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
import os
import shutil
import sys
import uuid
from pathlib import Path

import uvicorn
from sqlalchemy import text

from great_minds.app.api.server import create_app
from great_minds.core import pipeline, querier
from great_minds.core.vaults.config import load_config
from great_minds.core.documents.builder import write_document, write_file
from great_minds.core.vaults.repository import VaultRepository
from great_minds.core.vaults.service import VaultService
from great_minds.core.db import session_maker
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.service import DocumentService
from great_minds.core.users.repository import UserRepository
from great_minds.core.llm import get_async_client
from great_minds.core.paths import (
    VAULT_SUBDIRS,
    vault_dir,
    raw_prefix,
    sidecar_root,
)
from great_minds.core.settings import get_settings
from great_minds.core.storage import LocalStorage
from great_minds.core.storage_factory import make_storage
from great_minds.core.telemetry import (
    emit_wide_event,
    init_wide_event,
    setup_logging,
    wide_event,
)


def _sync_data_dir(data_dir: str) -> None:
    """Align DATA_DIR env var with --data-dir CLI flag.

    Settings are read via get_settings() across the codebase; the CLI
    flag must flow through the same channel so both direct Path I/O
    and Storage-factory construction see the same root. Call before
    any code path that touches Settings.
    """
    os.environ["DATA_DIR"] = data_dir
    get_settings.cache_clear()


def _make_storage() -> LocalStorage:
    return LocalStorage(Path.cwd())


async def _run_compile(vault_id: uuid.UUID, data_dir: Path) -> dict:
    client = get_async_client()
    init_wide_event("compile", vault_id=str(vault_id))
    try:
        async with session_maker() as session:
            vault = await VaultRepository(session).get_by_id(vault_id)
            if vault is None:
                raise ValueError(f"Vault {vault_id} not found")
            storage = make_storage(vault)
            ctx = await pipeline.build_context(
                vault_id=vault_id, storage=storage, session=session, client=client
            )
            await pipeline.run(ctx)
            return dict(wide_event.get() or {})
    finally:
        emit_wide_event()


def cmd_compile(args: argparse.Namespace) -> None:
    _sync_data_dir(args.data_dir)
    setup_logging(service="great-minds")
    e = asyncio.run(_run_compile(args.vault_id, Path(args.data_dir)))
    print("compile complete:")
    print(f"  raw chunks indexed:   {e.get('raw_chunks_indexed', 0)}")
    print(
        f"  docs extracted:       {e.get('docs_extracted', 0)} "
        f"({e.get('docs_failed', 0)} failed)"
    )
    print(f"  topics:               {e.get('validated_topics', 0)}")
    print(
        f"  articles rendered:    {e.get('render_topics_rendered', 0)} "
        f"({e.get('render_topics_failed', 0)} failed)"
    )
    print(f"  wiki chunks indexed:  {e.get('render_wiki_chunks_indexed', 0)}")
    print(f"  backlink edges:       {e.get('verify_backlink_edges', 0)}")
    print(f"  unresolved citations: {e.get('verify_unresolved_citations', 0)}")
    print(f"  cost (USD):           ${float(e.get('cost_usd', 0.0)):.4f}")


async def _stream_answer(
    source: querier.QuerySource,
    question: str,
    doc_service: DocumentService,
    model: str | None,
) -> None:
    """Consume run_query's SSE-shaped events and print to stdout.

    Token deltas stream live; source events render as a single dim-mark
    line above the answer text; errors go to stderr.
    """
    print(f"\n> {question}\n")
    async for event in querier.run_query(source, question, doc_service, model=model):
        kind = event["event"]
        data = event["data"]
        if kind == "token":
            print(data["text"], end="", flush=True)
        elif kind == "source":
            label = data.get("path") or data.get("query") or ""
            sys.stderr.write(f"\033[2m[· {data['type']}: {label}]\033[0m\n")
        elif kind == "done":
            print()
        elif kind == "error":
            print(f"\nerror: {data['message']}", file=sys.stderr)
            return


async def _run_query(args: argparse.Namespace) -> None:
    storage = _make_storage()
    source = querier.QuerySource(
        storage=storage, label="local", vault_id=uuid.UUID(int=0)
    )
    async with session_maker() as session:
        doc_service = DocumentService(DocumentRepository(session))
        if args.question:
            await _stream_answer(
                source, " ".join(args.question), doc_service, args.model
            )
            return

        # Interactive REPL — same streaming code path as the API.
        print(
            f"Knowledge Base — Query Interface (model: {args.model or 'default'})"
        )
        print("Type your question, or 'quit' to exit.\n")
        while True:
            try:
                question = (await asyncio.to_thread(input, "> ")).strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return
            if not question or question.lower() in ("quit", "exit", "q"):
                return
            await _stream_answer(source, question, doc_service, args.model)


def cmd_query(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds", json_output=args.json_logs)
    asyncio.run(_run_query(args))


async def _run_ingest(args: argparse.Namespace) -> None:
    storage = _make_storage()
    config = await load_config(storage)
    path = Path(args.path)
    dest = args.dest or raw_prefix(args.content_type)

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
        result = await write_file(
            storage, config, path, args.content_type, dest, **kwargs
        )
        log.info("ingested %s → %s", path, result)
    elif path.is_dir():
        source_files = sorted(path.rglob("*.md"))
        total = len(source_files)
        existing = set(await storage.glob(f"{dest}/**/*.md"))
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
            await write_document(
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


def cmd_ingest(args: argparse.Namespace) -> None:
    setup_logging(service="great-minds")
    asyncio.run(_run_ingest(args))


async def _run_reset(vault_id: str, vault_root: Path) -> None:
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
                text(f"DELETE FROM {table} WHERE vault_id = :bid"),
                {"bid": vault_id},
            )
            log.info("deleted %d rows from %s", result.rowcount, table)
        await session.commit()

    for subdir in VAULT_SUBDIRS:
        target = vault_root / subdir
        if target.exists():
            shutil.rmtree(target)
            target.mkdir()
            log.info("cleared %s", target)

    log.info("reset complete for vault %s", vault_id)


async def _run_delete_vault(vault_id: str, sidecar: Path) -> None:
    log = logging.getLogger(__name__)
    settings = get_settings()
    bid = uuid.UUID(vault_id)

    async with session_maker() as session:
        vault_repo = VaultRepository(session)
        user_repo = UserRepository(session)
        vault_service = VaultService(vault_repo, user_repo, settings)
        deleted = await vault_service.delete_vault(bid)
        if deleted is None:
            log.warning("no vault row found with id=%s", vault_id)
        else:
            log.info("vault row deleted and storage cleared for %s", vault_id)

    if sidecar.exists():
        shutil.rmtree(sidecar)
        log.info("removed compile sidecar %s", sidecar)

    log.info("vault %s fully deleted", vault_id)


def cmd_delete_vault(args: argparse.Namespace) -> None:
    _sync_data_dir(args.data_dir)
    setup_logging(service="great-minds")

    settings = get_settings()
    vault_id = args.vault_id
    data_dir = Path(args.data_dir)
    sidecar = sidecar_root(data_dir, vault_id)

    if not args.yes:
        print(f"This will PERMANENTLY DELETE vault {vault_id}:")
        print("  - Database: the vaults row + all FK-cascaded content")
        print("              (documents, topics, backlinks, idea_embeddings, tasks, ...)")
        if settings.storage_backend == "r2":
            print("  - R2:       all keys under vaults/<id>/ in the owner's bucket")
        else:
            print(f"  - Disk:     {vault_dir(data_dir, vault_id)}")
        print(f"  - Sidecar:  {sidecar}")
        print("\nThe vault row itself is removed — not just its content.")
        print("Use `great-minds reset` if you only want to clear content.")
        confirm = input("\nType 'yes' to continue: ")
        if confirm != "yes":
            print("Aborted.")
            return

    asyncio.run(_run_delete_vault(vault_id, sidecar))


def cmd_reset(args: argparse.Namespace) -> None:
    _sync_data_dir(args.data_dir)
    setup_logging(service="great-minds")

    if get_settings().storage_backend != "local":
        raise SystemExit(
            "reset is local-backend only; R2 vault reset not yet implemented"
        )

    vault_id = args.vault_id
    data_dir = Path(args.data_dir)
    vault_root = vault_dir(data_dir, vault_id)

    if not args.yes:
        print(f"This will delete ALL content for vault {vault_id}:")
        print(
            "  - Database: documents, search_index, backlinks, tasks, source_proposals"
        )
        subdir_display = ", ".join(str(vault_root / s) for s in VAULT_SUBDIRS)
        print(f"  - Disk: {subdir_display}")
        confirm = input("\nType 'yes' to continue: ")
        if confirm != "yes":
            print("Aborted.")
            return

    asyncio.run(_run_reset(vault_id, vault_root))


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
        "vault_id", type=uuid.UUID, help="UUID of the vault to compile"
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
        "reset", help="Wipe all content for a vault (keeps vault and user accounts)"
    )
    p_reset.add_argument("vault_id", help="UUID of the vault to reset")
    p_reset.add_argument(
        "--data-dir", default="/data", help="Data directory (default: /data)"
    )
    p_reset.add_argument(
        "-y", "--yes", action="store_true", help="Skip confirmation prompt"
    )
    p_reset.set_defaults(func=cmd_reset)

    # delete-vault
    p_delete = subparsers.add_parser(
        "delete-vault",
        help="Permanently delete a vault (row + content + sidecar). "
        "For content-only clear, use `reset`.",
    )
    p_delete.add_argument("vault_id", help="UUID of the vault to delete")
    p_delete.add_argument(
        "--data-dir", default="/data", help="Data directory (default: /data)"
    )
    p_delete.add_argument(
        "-y", "--yes", action="store_true", help="Skip confirmation prompt"
    )
    p_delete.set_defaults(func=cmd_delete_vault)

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
