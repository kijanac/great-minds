"""great-minds CLI — Typer + Rich."""

import asyncio
import contextvars
import os
import shutil
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import typer
import uvicorn
from rich.console import Console
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeRemainingColumn,
)
from rich.prompt import Confirm
from rich.table import Table
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from great_minds.app.api.server import create_app
from great_minds.core import pipeline, querier
from great_minds.core.documents.builder import write_document, write_file
from great_minds.core.documents.repository import DocumentRepository
from great_minds.core.documents.service import DocumentService
from great_minds.core.llm import get_async_client
from great_minds.core.paths import VAULT_SUBDIRS, raw_prefix, sidecar_root, vault_dir
from great_minds.core.settings import get_settings
from great_minds.core.storage import LocalStorage
from great_minds.core.storage_factory import make_storage
from great_minds.core.telemetry import (
    emit_wide_event,
    init_wide_event,
    setup_logging,
    wide_event,
)
from great_minds.core.users.repository import UserRepository
from great_minds.core.vaults.config import load_config
from great_minds.core.vaults.repository import VaultRepository
from great_minds.core.vaults.service import VaultService

app = typer.Typer(
    name="great-minds", help="LLM-powered research knowledge base", no_args_is_help=True
)
console = Console()
err_console = Console(stderr=True)
_cli_sm: contextvars.ContextVar = contextvars.ContextVar("cli_sm")


def _sync_data_dir(data_dir: str) -> None:
    os.environ["DATA_DIR"] = data_dir


def _make_storage() -> LocalStorage:
    return LocalStorage(Path.cwd())


@asynccontextmanager
async def _cli_session():
    settings = get_settings()
    engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    sm = async_sessionmaker(engine, expire_on_commit=False)
    token = _cli_sm.set(sm)
    try:
        yield
    finally:
        _cli_sm.reset(token)
        await engine.dispose()


# compile --------------------------------------------------------------------


async def _run_compile(vault_id: uuid.UUID, data_dir: Path) -> dict:
    client = get_async_client()
    init_wide_event("compile", vault_id=str(vault_id))
    try:
        async with _cli_sm.get()() as session:
            vault = await VaultRepository(session).get_by_id(vault_id)
            if vault is None:
                raise ValueError(f"Vault {vault_id} not found")
            ctx = await pipeline.build_context(
                vault_id=vault_id,
                storage=make_storage(vault),
                session=session,
                client=client,
            )
            await pipeline.run(ctx)
            return dict(wide_event.get() or {})
    finally:
        emit_wide_event()


@app.command()
async def compile(  # noqa: A001
    vault_id: uuid.UUID = typer.Argument(help="UUID of the vault to compile"),
    data_dir: Path = typer.Option(Path("/data"), "--data-dir", help="Data directory"),
) -> None:
    """Compile raw texts into wiki articles."""
    _sync_data_dir(str(data_dir))
    setup_logging(service="great-minds")
    async with _cli_session():
        e = await _run_compile(vault_id, data_dir)

    table = Table(
        title="Compile Complete", title_style="bold green", border_style="dim blue"
    )
    table.add_column("Metric", style="cyan", no_wrap=True)
    table.add_column("Value", style="white")
    for metric, value in [
        ("Raw chunks indexed", e.get("raw_chunks_indexed", 0)),
        (
            "Docs extracted",
            f"{e.get('docs_extracted', 0)} ([dim]{e.get('docs_failed', 0)} failed[/dim])",
        ),
        ("Topics validated", e.get("validated_topics", 0)),
        (
            "Articles rendered",
            f"{e.get('render_topics_rendered', 0)} ([dim]{e.get('render_topics_failed', 0)} failed[/dim])",
        ),
        ("Wiki chunks indexed", e.get("render_wiki_chunks_indexed", 0)),
        ("Backlink edges", e.get("verify_backlink_edges", 0)),
        ("Unresolved citations", e.get("verify_unresolved_citations", 0)),
        ("Cost (USD)", f"${float(e.get('cost_usd', 0.0)):.4f}"),
    ]:
        table.add_row(metric, str(value))
    console.print(table)


# query ----------------------------------------------------------------------


async def _stream_answer(source, question, doc_service, model):
    print(f"\n> {question}\n")
    async for event in querier.run_query(source, question, doc_service, model=model):
        kind, data = event["event"], event["data"]
        if kind == "token":
            print(data["text"], end="", flush=True)
        elif kind == "source":
            label = data.get("path") or data.get("query") or ""
            sys.stderr.write(f"\033[2m[· {data['type']}: {label}]\033[0m\n")
        elif kind == "done":
            print()
        elif kind == "error":
            print(f"\nerror: {data['message']}", file=sys.stderr)


@app.command()
async def query(
    question: list[str] | None = typer.Argument(
        None, help="Question text (omit for interactive mode)"
    ),
    model: str | None = typer.Option(
        None, "--model", help="Override the default model"
    ),
    json_logs: bool = typer.Option(
        False, "--json-logs", help="Structured JSON logs to stderr"
    ),
) -> None:
    """Query the knowledge base (interactive if no question given)."""
    setup_logging(service="great-minds", json_output=json_logs)
    source = querier.QuerySource(
        storage=_make_storage(), label="local", vault_id=uuid.UUID(int=0)
    )
    async with _cli_session():
        async with _cli_sm.get()() as session:
            doc_service = DocumentService(DocumentRepository(session))
            if question:
                await _stream_answer(source, " ".join(question), doc_service, model)
                return
            console.print(
                Panel.fit(
                    f"Model: [cyan]{model or 'default'}[/cyan]\n\nType your question, or [bold]quit[/bold] to exit.",
                    title="[bold]great-minds[/bold]",
                    border_style="blue",
                )
            )
            while True:
                try:
                    q = (await asyncio.to_thread(input, "> ")).strip()
                except EOFError, KeyboardInterrupt:
                    console.print()
                    return
                if not q or q.lower() in ("quit", "exit", "q"):
                    return
                await _stream_answer(source, q, doc_service, model)


# ingest ---------------------------------------------------------------------


@app.command()
async def ingest(
    content_type: str = typer.Argument(help="Content type (texts, news, ideas)"),
    path: Path = typer.Argument(help="File or directory of .md files to ingest"),
    dest: str | None = typer.Option(None, "--dest", help="Destination directory"),
    author: str | None = typer.Option(None, "--author", help="Author name"),
    date: str | None = typer.Option(None, "--date", help="Publication date"),
    origin: str | None = typer.Option(
        None, "--origin", help="Publication or organization name"
    ),
    url: str | None = typer.Option(None, "--url", help="Source URL"),
    outlet: str | None = typer.Option(
        None, "--outlet", help="News outlet (for news type)"
    ),
) -> None:
    """Ingest documents into the knowledge base."""
    setup_logging(service="great-minds")
    storage = _make_storage()
    config = await load_config(storage)
    dest = dest or raw_prefix(content_type)
    kwargs = {
        k: v
        for k, v in (
            ("author", author),
            ("date", date),
            ("origin", origin),
            ("url", url),
            ("outlet", outlet),
        )
        if v
    }

    if path.is_file():
        result = await write_file(storage, config, path, content_type, dest, **kwargs)
        console.print(f"[green]✓[/green] [bold]{path}[/bold] → [cyan]{result}[/cyan]")
    elif path.is_dir():
        source_files = sorted(path.rglob("*.md"))
        total = len(source_files)
        existing = set(await storage.glob(f"{dest}/**/*.md"))
        console.print(
            f"Found [bold]{total}[/bold] .md files in [cyan]{path}[/cyan] ([dim]{len(existing)} already ingested[/dim])"
        )
        if not total:
            console.print("[yellow]No .md files found.[/yellow]")
            return

        ingested = skipped = 0
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            TextColumn("•"),
            TimeRemainingColumn(),
            console=console,
        ) as progress:
            task = progress.add_task(
                f"Ingesting [cyan]{content_type}[/cyan] files", total=total
            )
            for filepath in source_files:
                relative = filepath.relative_to(path)
                file_dest = f"{dest}/{relative}"
                if file_dest in existing:
                    skipped += 1
                    progress.advance(task)
                    continue
                await write_document(
                    storage,
                    config,
                    filepath.read_text("utf-8"),
                    content_type,
                    dest=file_dest,
                    **kwargs,
                )
                ingested += 1
                progress.advance(task)

        summary = Table(border_style="dim blue", show_header=False, box=None)
        summary.add_column(style="cyan")
        summary.add_column(style="white")
        summary.add_row("Ingested", f"[bold green]{ingested}[/bold green]")
        summary.add_row("Skipped", f"[dim]{skipped}[/dim]")
        summary.add_row("Total", str(total))
        summary.add_row("Destination", f"[cyan]{dest}/[/cyan]")
        console.print(summary)
    else:
        err_console.print(f"[bold red]Error:[/bold red] path not found: {path}")
        raise typer.Exit(code=1)


# reset ----------------------------------------------------------------------


@app.command()
async def reset(
    vault_id: str = typer.Argument(help="UUID of the vault to reset"),
    data_dir: Path = typer.Option(Path("/data"), "--data-dir", help="Data directory"),
    yes: bool = typer.Option(False, "-y", "--yes", help="Skip confirmation prompt"),
) -> None:
    """Wipe all content for a vault (keeps vault and user accounts)."""
    _sync_data_dir(str(data_dir))
    setup_logging(service="great-minds")
    if get_settings().storage_backend != "local":
        err_console.print(
            "[bold red]Error:[/bold red] reset is local-backend only; R2 vault reset not yet implemented"
        )
        raise typer.Exit(code=1)

    vault_root = vault_dir(data_dir, vault_id)
    if not yes:
        console.print()
        console.print(
            Panel.fit(
                f"[bold]Vault:[/bold] [cyan]{vault_id}[/cyan]\n\nThis will [bold red]DELETE ALL CONTENT[/bold red]:\n"
                "  • Database: documents, search_index, backlinks, tasks, source_proposals\n"
                f"  • Disk: {', '.join(str(vault_root / s) for s in VAULT_SUBDIRS)}",
                title="[bold yellow]⚠ Reset Vault[/bold yellow]",
                border_style="red",
            )
        )
        if not Confirm.ask("Continue?", default=False):
            console.print("[dim]Aborted.[/dim]")
            raise typer.Abort()

    async with _cli_session():
        sm = _cli_sm.get()
        async with sm() as session:
            for table in (
                "search_index",
                "tasks",
                "source_proposals",
                "topics",
                "idea_embeddings",
                "documents",
            ):
                result = await session.execute(
                    text(f"DELETE FROM {table} WHERE vault_id = :bid"),
                    {"bid": vault_id},
                )
                console.print(
                    f"  [dim]deleted {result.rowcount} rows from[/dim] {table}"
                )
            await session.commit()
        for subdir in VAULT_SUBDIRS:
            target = vault_root / subdir
            if target.exists():
                shutil.rmtree(target)
                target.mkdir()
                console.print(f"  [dim]cleared[/dim] {target}")
    console.print(
        f"\n[bold green]✓[/bold green] Reset complete for vault [cyan]{vault_id}[/cyan]"
    )


# delete-vault ---------------------------------------------------------------


@app.command()
async def delete_vault(
    vault_id: str = typer.Argument(help="UUID of the vault to delete"),
    data_dir: Path = typer.Option(Path("/data"), "--data-dir", help="Data directory"),
    yes: bool = typer.Option(False, "-y", "--yes", help="Skip confirmation prompt"),
) -> None:
    """Permanently delete a vault (row + content + sidecar). For content-only clear, use reset."""
    _sync_data_dir(str(data_dir))
    setup_logging(service="great-minds")
    settings = get_settings()
    sidecar = sidecar_root(data_dir, vault_id)

    if not yes:
        console.print()
        storage_detail = (
            f"  • R2:       all keys under vaults/{vault_id}/ in the owner's bucket"
            if settings.storage_backend == "r2"
            else f"  • Disk:     {vault_dir(data_dir, vault_id)}"
        )
        console.print(
            Panel.fit(
                f"[bold]Vault:[/bold] [cyan]{vault_id}[/cyan]\n\n"
                "This will [bold red]PERMANENTLY DELETE[/bold red]:\n"
                "  • Database: the vaults row + all FK-cascaded content\n"
                "              (documents, topics, backlinks, idea_embeddings, tasks, ...)\n"
                f"{storage_detail}\n  • Sidecar:  {sidecar}\n\n"
                "The vault row itself is removed — not just its content.\n"
                "Use [bold]reset[/bold] if you only want to clear content.",
                title="[bold red]⚠ Delete Vault[/bold red]",
                border_style="red",
            )
        )
        if not Confirm.ask("Type 'yes' to continue", default=False):
            console.print("[dim]Aborted.[/dim]")
            raise typer.Abort()

    async with _cli_session():
        sm = _cli_sm.get()
        async with sm() as session:
            vault_service = VaultService(
                VaultRepository(session), UserRepository(session), settings
            )
            deleted = await vault_service.delete_vault(uuid.UUID(vault_id))
            if deleted is None:
                console.print(
                    f"[yellow]Warning:[/yellow] no vault row found with id={vault_id}"
                )
            else:
                console.print(
                    f"  [dim]vault row deleted and storage cleared for[/dim] {vault_id}"
                )
    if sidecar.exists():
        shutil.rmtree(sidecar)
        console.print(f"  [dim]removed compile sidecar[/dim] {sidecar}")
    console.print(
        f"\n[bold green]✓[/bold green] Vault [cyan]{vault_id}[/cyan] fully deleted"
    )


# serve ----------------------------------------------------------------------


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", "--host", help="Bind host"),
    port: int = typer.Option(8000, "--port", help="Bind port"),
    reload: bool = typer.Option(
        False, "--reload", help="Auto-reload on source changes (dev only)"
    ),
) -> None:
    """Start the API server."""
    if reload:
        uvicorn.run(
            "great_minds.app.api.server:create_app",
            factory=True,
            host=host,
            port=port,
            reload=True,
            reload_dirs=["src"],
        )
    else:
        uvicorn.run(create_app(), host=host, port=port)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
