"""Reconciler: drives compile_intents through the lifecycle.

`reconcile_once` is the unit of work — pure async function with explicit
dependencies, safe to call from anywhere (FastAPI lifespan loop, startup
catch-up, future Absurd self-respawn). Two scans per tick:

  1. Mark satisfied: any dispatched intent whose Absurd task is in a
     terminal state (completed | failed | cancelled).
  2. Dispatch pending: oldest-first, skip vaults with an active compile,
     spawn with idempotency_key=intent.id (crash-safe between spawn and
     mark_dispatched).

The host (asyncio loop, lifespan wiring, session/service construction)
lives at the call site, not here. This module exposes only
`reconcile_once`.
"""

from typing import Literal, get_args

from great_minds.core.vaults.service import VaultService
from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.settings import Settings
from great_minds.core.tasks.service import TaskService
from great_minds.core.telemetry import log_event

TerminalAbsurdState = Literal["completed", "failed", "cancelled"]
_TERMINAL: tuple[str, ...] = get_args(TerminalAbsurdState)


async def reconcile_once(
    intent_repo: CompileIntentRepository,
    task_service: TaskService,
    vault_service: VaultService,
    settings: Settings,
) -> None:
    """One reconciliation pass. Caller commits the session."""
    satisfied = await _mark_satisfied_terminal(intent_repo, task_service)
    dispatched = await _dispatch_pending(
        intent_repo, task_service, vault_service, settings
    )
    log_event(
        "intent_reconciler_tick_completed",
        marked_satisfied=satisfied,
        dispatched=dispatched,
    )


async def _mark_satisfied_terminal(
    intent_repo: CompileIntentRepository,
    task_service: TaskService,
) -> int:
    rows = await intent_repo.list_dispatched_unsatisfied()
    marked = 0
    for intent in rows:
        if intent.dispatched_task_id is None:
            continue
        snap = await task_service.absurd.fetch_task_result(
            str(intent.dispatched_task_id)
        )
        if snap is None or snap.state not in _TERMINAL:
            continue
        await intent_repo.mark_satisfied(intent.id)
        marked += 1
        log_event(
            "intent_satisfied",
            intent_id=str(intent.id),
            vault_id=str(intent.vault_id),
            task_id=str(intent.dispatched_task_id),
            terminal_state=snap.state,
        )
    return marked


async def _dispatch_pending(
    intent_repo: CompileIntentRepository,
    task_service: TaskService,
    vault_service: VaultService,
    settings: Settings,
) -> int:
    pending = await intent_repo.list_pending_locked()
    dispatched = 0
    for intent in pending:
        if await task_service.find_active_compile(intent.vault_id) is not None:
            continue
        vault = await vault_service.get_vault(intent.vault_id)
        task = await task_service.spawn_compile_for_intent(
            intent_id=intent.id,
            vault_id=intent.vault_id,
            data_dir=settings.data_dir,
            label=vault.name,
        )
        await intent_repo.mark_dispatched(intent.id, task.id)
        dispatched += 1
        log_event(
            "intent_dispatched",
            intent_id=str(intent.id),
            vault_id=str(intent.vault_id),
            task_id=str(task.id),
        )
    return dispatched
