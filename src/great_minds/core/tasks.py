"""Background task management for long-running brain operations.

Uses asyncio.create_task for in-process background execution.
A compile lock prevents concurrent compilations (which would corrupt state).

    from great_minds import Brain, LocalStorage
    from great_minds.tasks import TaskManager

    brain = Brain(LocalStorage("."))
    manager = TaskManager(brain)

    task_id = await manager.compile(limit=50)
    info = manager.get(task_id)
    print(info.status)  # "running" | "completed" | "failed"
"""


import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from collections.abc import Callable

from .brain import Brain

log = logging.getLogger(__name__)


@dataclass
class TaskInfo:
    id: str
    type: str
    status: str = "pending"
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None
    params: dict = field(default_factory=dict)
    result: dict = field(default_factory=dict)


MAX_COMPLETED_TASKS = 100


class TaskManager:
    """Manages background brain operations with status tracking."""

    def __init__(self, brain: Brain, *, on_compile_done: Callable | None = None) -> None:
        self.brain = brain
        self._tasks: dict[str, TaskInfo] = {}
        self._compile_lock = asyncio.Lock()
        self._on_compile_done = on_compile_done

    def _evict_old_tasks(self) -> None:
        completed = [
            t for t in self._tasks.values()
            if t.status in ("completed", "failed")
        ]
        if len(completed) > MAX_COMPLETED_TASKS:
            completed.sort(key=lambda t: t.completed_at or t.created_at)
            for task in completed[:-MAX_COMPLETED_TASKS]:
                del self._tasks[task.id]

    async def compile(self, *, limit: int | None = None) -> str:
        """Start a background compilation. Returns task ID.

        Only one compilation runs at a time — subsequent calls queue behind
        the compile lock.
        """
        self._evict_old_tasks()
        task_id = uuid.uuid4().hex[:8]
        info = TaskInfo(
            id=task_id,
            type="compile",
            params={"limit": limit},
        )
        self._tasks[task_id] = info
        asyncio.create_task(self._run_compile(info, limit=limit))
        log.info("task_created id=%s type=compile limit=%s", task_id, limit)
        return task_id

    async def _run_compile(self, info: TaskInfo, *, limit: int | None) -> None:
        async with self._compile_lock:
            info.status = "running"
            info.started_at = datetime.now(UTC)
            log.info("task_started id=%s type=compile", info.id)
            try:
                result = await self.brain.compile(limit=limit)
                info.status = "completed"
                info.result["articles_written"] = result.articles_written
                info.result["docs_compiled"] = result.docs_compiled
                log.info("task_completed id=%s type=compile", info.id)
                if self._on_compile_done and result.articles_written:
                    try:
                        await self._on_compile_done(self.brain, result)
                    except Exception as e:
                        log.error("on_compile_done hook failed: %s", e)
            except Exception as e:
                info.status = "failed"
                info.error = str(e)
                log.error("task_failed id=%s type=compile error=%s", info.id, e)
            finally:
                info.completed_at = datetime.now(UTC)
                if info.started_at:
                    duration = (info.completed_at - info.started_at).total_seconds()
                    info.result["duration_s"] = round(duration, 1)

    def get(self, task_id: str) -> TaskInfo | None:
        return self._tasks.get(task_id)

    def list(self) -> list[TaskInfo]:
        return sorted(self._tasks.values(), key=lambda t: t.created_at, reverse=True)

    def active(self) -> list[TaskInfo]:
        return [t for t in self._tasks.values() if t.status in ("pending", "running")]
