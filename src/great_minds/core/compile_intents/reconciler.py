"""Reconciler: drives compile_intents through the lifecycle.

`reconcile_once` is the unit of work — pure async function with explicit
dependencies, safe to call from anywhere (FastAPI lifespan loop, startup
catch-up, future Absurd self-respawn). Two scans per tick:

  1. Mark satisfied: any dispatched intent whose Absurd task is in a
     terminal state (completed | failed | cancelled).
  2. Dispatch pending: oldest-first, skip brains with an active compile,
     spawn with idempotency_key=intent.id (crash-safe between spawn and
     mark_dispatched).

The host (asyncio loop, lifespan wiring, session/service construction)
lives at the call site, not here. This module exposes only
`reconcile_once`.
"""

from typing import Literal, get_args

from great_minds.core.brains.service import BrainService
from great_minds.core.compile_intents.repository import CompileIntentRepository
from great_minds.core.settings import Settings
from great_minds.core.tasks.service import TaskService
from great_minds.core.telemetry import log_event

TerminalAbsurdState = Literal["completed", "failed", "cancelled"]
_TERMINAL: tuple[str, ...] = get_args(TerminalAbsurdState)


async def reconcile_once(
    intent_repo: CompileIntentRepository,
    task_service: TaskService,
    brain_service: BrainService,
    settings: Settings,
) -> None:
    """One reconciliation pass. Caller commits the session."""
    satisfied = await _mark_satisfied_terminal(intent_repo, task_service)
    dispatched = await _dispatch_pending(
        intent_repo, task_service, brain_service, settings
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
            brain_id=str(intent.brain_id),
            task_id=str(intent.dispatched_task_id),
            terminal_state=snap.state,
        )
    return marked


async def _dispatch_pending(
    intent_repo: CompileIntentRepository,
    task_service: TaskService,
    brain_service: BrainService,
    settings: Settings,
) -> int:
    pending = await intent_repo.list_pending_locked()
    dispatched = 0
    for intent in pending:
        if await task_service.find_active_compile(intent.brain_id) is not None:
            continue
        brain = await brain_service.get_by_id(intent.brain_id)
        task = await task_service.spawn_compile_for_intent(
            intent_id=intent.id,
            brain_id=intent.brain_id,
            data_dir=settings.data_dir,
            label=brain.name,
        )
        await intent_repo.mark_dispatched(intent.id, task.id)
        dispatched += 1
        log_event(
            "intent_dispatched",
            intent_id=str(intent.id),
            brain_id=str(intent.brain_id),
            task_id=str(task.id),
        )
    return dispatched
